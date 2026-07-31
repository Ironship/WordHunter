use std::collections::{BTreeMap, BTreeSet};
use std::io::{Read, Seek, Write};
use std::path::{Path, PathBuf};

use serde_json::{Value, json};
use zip::{ZipArchive, ZipWriter, write::SimpleFileOptions};

use super::{Store, books, durable, media_assets, record_files};

const FORMAT: &str = "wordhunter-transfer";
const SCHEMA_VERSION: u64 = 1;
const MAX_ENTRIES: usize = 100_000;
const MAX_YAML_BYTES: u64 = 8 * 1024 * 1024;
const MAX_BOOK_YAML_BYTES: u64 = 4 * 1024 * 1024;
const MAX_ASSET_BYTES: u64 = 512 * 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_PATH_COMPONENTS: usize = 32;
const MAX_ASSET_TREE_DEPTH: usize = 16;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ExportScope {
    All,
    Vocabulary,
}

impl ExportScope {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "all" => Ok(Self::All),
            "vocabulary" => Ok(Self::Vocabulary),
            _ => Err("export scope must be 'all' or 'vocabulary'".to_string()),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::All => "all",
            Self::Vocabulary => "vocabulary",
        }
    }
}

#[derive(Default)]
struct ImportPlan {
    records: BTreeMap<String, record_files::SyncRecord>,
    asset_files: Vec<(String, PathBuf)>,
    staging: PathBuf,
}

struct FileBackup {
    target: PathBuf,
    saved: Option<PathBuf>,
}

impl Drop for ImportPlan {
    fn drop(&mut self) {
        if !self.staging.as_os_str().is_empty() {
            let _ = std::fs::remove_dir_all(&self.staging);
        }
    }
}

impl Store {
    pub fn export_transfer(&self, target: &Path, scope: ExportScope) -> Result<Value, String> {
        let _guard = self.lock_writes()?;
        self.recover_pending_save()?;
        let root = self.dir();
        let records = record_files::load_records(&root)?;
        let file = std::fs::File::create(target)
            .map_err(|e| format!("could not create export {}: {e}", target.display()))?;
        let mut zip = ZipWriter::new(file);
        let options = SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated)
            .unix_permissions(0o600);
        write_yaml(
            &mut zip,
            "manifest.yaml",
            &json!({
                "format": FORMAT,
                "schemaVersion": SCHEMA_VERSION,
                "appVersion": crate::APP_VERSION,
                "exportedAt": record_files::now_millis().to_string(),
                "scope": scope.as_str(),
            }),
            options,
        )?;

        let mut books: BTreeMap<String, Vec<Value>> = BTreeMap::new();
        let mut books_with_assets = BTreeSet::new();
        let mut exported_records = 0usize;
        for record in records.values() {
            if scope == ExportScope::Vocabulary && record.kind != "vocab" {
                continue;
            }
            let value = record_files::record_value(record);
            if record.kind == "vocab" {
                write_yaml(
                    &mut zip,
                    &format!("words/{}.yaml", record_files::stable_hash(&record.key)),
                    &value,
                    options,
                )?;
                exported_records += 1;
            } else if scope == ExportScope::All {
                if let Some(book_id) = record_book_id(record) {
                    if record.kind == "text" && record.deleted_at.is_none() {
                        books_with_assets.insert(book_id.clone());
                    }
                    books.entry(book_id).or_default().push(value);
                } else {
                    write_yaml(
                        &mut zip,
                        &format!("records/{}.yaml", record_files::stable_hash(&record.key)),
                        &value,
                        options,
                    )?;
                    exported_records += 1;
                }
            }
        }

        let mut exported_assets = 0usize;
        if scope == ExportScope::All {
            for (book_id, book_records) in &books {
                for (name, value) in book_yaml_entries(book_id, book_records, MAX_BOOK_YAML_BYTES)?
                {
                    write_yaml(&mut zip, &name, &value, options)?;
                }
                exported_records += book_records.len();
                let safe_id = crate::paths::sanitize_id(book_id)?;
                if books_with_assets.contains(book_id) {
                    let images = root.join("books").join(&safe_id).join("images");
                    exported_assets += write_asset_tree(
                        &mut zip,
                        &images,
                        &format!("books/{safe_id}/images"),
                        options,
                        0,
                    )?;
                }
            }
        }
        zip.finish()
            .map_err(|e| format!("could not finish export {}: {e}", target.display()))?
            .sync_all()
            .map_err(|e| format!("could not sync export {}: {e}", target.display()))?;
        durable::sync_parent(target)?;
        Ok(json!({
            "records": exported_records,
            "books": books.len(),
            "assets": exported_assets,
            "scope": scope.as_str(),
        }))
    }

    pub fn import_transfer(&self, source: &Path) -> Result<Value, String> {
        let mut plan = build_import_plan(source, &self.dir())?;
        let _guard = self.lock_writes()?;
        self.recover_pending_save()?;
        let root = self.dir();
        let current = record_files::load_records(&root)?;
        let mut accepted = BTreeMap::new();
        let mut accepted_books = BTreeSet::new();
        let mut skipped = 0usize;
        for (key, incoming) in std::mem::take(&mut plan.records) {
            if current.get(&key).is_some_and(|saved| {
                record_files::record_time(saved) >= record_files::record_time(&incoming)
            }) {
                skipped += 1;
                continue;
            }
            if incoming.kind == "text"
                && incoming.deleted_at.is_none()
                && let Some(book_id) = record_book_id(&incoming)
            {
                accepted_books.insert(crate::paths::sanitize_id(&book_id)?);
            }
            accepted.insert(key, incoming);
        }
        validate_incoming_pdf_assets(&accepted, &plan.asset_files)?;

        let mut asset_copies = Vec::new();
        let mut copied_books = BTreeSet::new();
        for (relative, staged) in &plan.asset_files {
            let Some(book_id) = asset_book_id(relative) else {
                return Err("archive contains an invalid book asset path".to_string());
            };
            if !accepted_books.contains(book_id) {
                continue;
            }
            let target = media_assets::safe_join(&root, relative)?;
            asset_copies.push((staged.clone(), target));
            copied_books.insert(book_id.to_string());
        }

        let mut targets = asset_copies
            .iter()
            .map(|(_, target)| target.clone())
            .chain(
                accepted
                    .values()
                    .map(|record| record_files::record_path(&root, record)),
            )
            .collect::<BTreeSet<_>>();
        if !copied_books.is_empty() {
            targets.insert(media_assets::manifest_path(&root));
        }
        let backups = backup_targets(&plan.staging, targets)?;
        let apply = (|| {
            for (staged, target) in &asset_copies {
                durable::copy_file_atomic(staged, target, false)?;
            }
            for record in accepted
                .values()
                .filter(|record| record.kind == "text" && record.deleted_at.is_none())
            {
                let book_id = record_book_id(record)
                    .ok_or_else(|| "text record has no book id".to_string())?;
                let book_id = crate::paths::sanitize_id(&book_id)?;
                books::validate_pdf_page_assets(&root, &book_id, &record.data)?;
            }
            record_files::write_records(&root, &accepted)?;
            for book_id in &copied_books {
                media_assets::finalize_imported_book_assets(&root, book_id, self.device_id())?;
            }
            Ok::<(), String>(())
        })();
        if let Err(error) = apply {
            return match restore_targets(&backups) {
                Ok(()) => Err(error),
                Err(rollback) => Err(format!("{error}; import rollback failed: {rollback}")),
            };
        }
        let staging = std::mem::take(&mut plan.staging);
        if !staging.as_os_str().is_empty() {
            let _ = std::fs::remove_dir_all(staging);
        }
        let imported = accepted.len();
        drop(_guard);
        Ok(json!({
            "imported": imported,
            "skipped": skipped,
            "assets": asset_copies.len(),
            "snapshot": self.snapshot_unacknowledged(),
        }))
    }
}

fn validate_incoming_pdf_assets(
    records: &BTreeMap<String, record_files::SyncRecord>,
    assets: &[(String, PathBuf)],
) -> Result<(), String> {
    let paths = assets
        .iter()
        .map(|(path, _)| path.as_str())
        .collect::<BTreeSet<_>>();
    for record in records
        .values()
        .filter(|record| record.kind == "text" && record.deleted_at.is_none())
    {
        let Some(pages) = record.data.get("pdfOcrPages").and_then(Value::as_array) else {
            continue;
        };
        let book_id =
            record_book_id(record).ok_or_else(|| "PDF text record has no book id".to_string())?;
        let book_id = crate::paths::sanitize_id(&book_id)?;
        for page in pages {
            let Some(image_name) = page.get("imageName").and_then(Value::as_str) else {
                continue;
            };
            let image_name = crate::paths::sanitize_id(image_name)?;
            let expected = format!("books/{book_id}/images/{image_name}");
            if !paths.contains(expected.as_str()) {
                return Err(format!(
                    "WordHunter package is missing PDF image: {expected}"
                ));
            }
        }
    }
    Ok(())
}

fn backup_targets(staging: &Path, targets: BTreeSet<PathBuf>) -> Result<Vec<FileBackup>, String> {
    let rollback = staging.join("rollback");
    std::fs::create_dir_all(&rollback).map_err(|e| e.to_string())?;
    targets
        .into_iter()
        .enumerate()
        .map(|(index, target)| {
            let saved = if target.exists() {
                let metadata = std::fs::symlink_metadata(&target).map_err(|e| e.to_string())?;
                if !metadata.is_file() || metadata.file_type().is_symlink() {
                    return Err(format!(
                        "import target is not a regular file: {}",
                        target.display()
                    ));
                }
                let saved = rollback.join(index.to_string());
                durable::copy_file_atomic(&target, &saved, false)?;
                Some(saved)
            } else {
                None
            };
            Ok(FileBackup { target, saved })
        })
        .collect()
}

fn restore_targets(backups: &[FileBackup]) -> Result<(), String> {
    let mut errors = Vec::new();
    for backup in backups.iter().rev() {
        let result = match &backup.saved {
            Some(saved) => durable::copy_file_atomic(saved, &backup.target, false),
            None => durable::remove_file_if_exists(&backup.target),
        };
        if let Err(error) = result {
            errors.push(error);
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

fn write_yaml<W: Write + Seek>(
    zip: &mut ZipWriter<W>,
    name: &str,
    value: &Value,
    options: SimpleFileOptions,
) -> Result<(), String> {
    zip.start_file(name, options).map_err(|e| e.to_string())?;
    let yaml = serde_yaml::to_string(value).map_err(|e| e.to_string())?;
    zip.write_all(yaml.as_bytes()).map_err(|e| e.to_string())
}

fn book_yaml_entries(
    book_id: &str,
    records: &[Value],
    max_book_yaml: u64,
) -> Result<Vec<(String, Value)>, String> {
    let safe_id = crate::paths::sanitize_id(book_id)?;
    let book_value = json!({
        "schemaVersion": SCHEMA_VERSION,
        "bookId": book_id,
        "records": records,
    });
    if serde_yaml::to_string(&book_value)
        .map(|yaml| yaml.len() as u64 <= max_book_yaml)
        .unwrap_or(true)
    {
        return Ok(vec![(format!("books/{safe_id}/book.yaml"), book_value)]);
    }
    let mut entries = Vec::new();
    for record in records {
        let yaml = serde_yaml::to_string(record).map_err(|e| e.to_string())?;
        if yaml.len() as u64 > MAX_YAML_BYTES {
            return Err(format!(
                "book {book_id} has a record too large to transfer ({} bytes)",
                yaml.len()
            ));
        }
        let key = record
            .get("key")
            .and_then(Value::as_str)
            .unwrap_or_default();
        entries.push((
            format!("books/{safe_id}/records/{}.yaml", record_files::stable_hash(key)),
            record.clone(),
        ));
    }
    Ok(entries)
}

fn write_asset_tree<W: Write + Seek>(
    zip: &mut ZipWriter<W>,
    dir: &Path,
    archive_dir: &str,
    options: SimpleFileOptions,
    depth: usize,
) -> Result<usize, String> {
    if depth > MAX_ASSET_TREE_DEPTH {
        return Err(format!(
            "book asset tree is too deep below {archive_dir}"
        ));
    }
    if !dir.exists() {
        return Ok(0);
    }
    let mut count = 0;
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        if file_type.is_symlink() {
            return Err(format!(
                "book asset cannot be a symlink: {}",
                entry.path().display()
            ));
        }
        let name = entry
            .file_name()
            .to_str()
            .ok_or_else(|| "book asset name is not UTF-8".to_string())?
            .to_string();
        if file_type.is_dir() {
            count += write_asset_tree(
                zip,
                &entry.path(),
                &format!("{archive_dir}/{name}"),
                options,
                depth + 1,
            )?;
        } else if file_type.is_file() {
            zip.start_file(format!("{archive_dir}/{name}"), options)
                .map_err(|e| e.to_string())?;
            let mut file = std::fs::File::open(entry.path()).map_err(|e| e.to_string())?;
            std::io::copy(&mut file, zip).map_err(|e| e.to_string())?;
            count += 1;
        }
    }
    Ok(count)
}

fn build_import_plan(source: &Path, data_root: &Path) -> Result<ImportPlan, String> {
    let file = std::fs::File::open(source)
        .map_err(|e| format!("could not open import {}: {e}", source.display()))?;
    let mut zip = ZipArchive::new(file).map_err(|e| format!("invalid WordHunter package: {e}"))?;
    if zip.is_empty() || zip.len() > MAX_ENTRIES {
        return Err("WordHunter package has an invalid number of files".to_string());
    }
    let staging = data_root.join(format!(".transfer-import-{}", record_files::now_millis()));
    std::fs::create_dir(&staging).map_err(|e| format!("could not create import staging: {e}"))?;
    let mut plan = ImportPlan {
        records: BTreeMap::new(),
        asset_files: Vec::new(),
        staging,
    };
    let mut manifest_seen = false;
    let mut seen_entries = BTreeSet::new();
    let mut total = 0u64;
    for index in 0..zip.len() {
        let mut entry = zip.by_index(index).map_err(|e| e.to_string())?;
        if entry.is_dir() {
            continue;
        }
        if entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err("WordHunter package cannot contain symlinks".to_string());
        }
        let name = validated_archive_name(entry.name())?;
        if !seen_entries.insert(name.clone()) {
            return Err(format!("duplicate file in WordHunter package: {name}"));
        }
        let size = entry.size();
        total = total
            .checked_add(size)
            .ok_or_else(|| "package is too large".to_string())?;
        if total > MAX_TOTAL_BYTES {
            return Err("WordHunter package is too large".to_string());
        }
        if name == "manifest.yaml" {
            let value = read_yaml(&mut entry, MAX_YAML_BYTES)?;
            if value.get("format").and_then(Value::as_str) != Some(FORMAT)
                || value.get("schemaVersion").and_then(Value::as_u64) != Some(SCHEMA_VERSION)
            {
                return Err("unsupported WordHunter package format".to_string());
            }
            manifest_seen = true;
        } else if is_record_yaml(&name) {
            let value = read_yaml(&mut entry, MAX_YAML_BYTES)?;
            if name.ends_with("/book.yaml") {
                let records = value
                    .get("records")
                    .and_then(Value::as_array)
                    .ok_or_else(|| format!("{name} has no records"))?;
                for record in records {
                    add_import_record(&mut plan.records, record.clone())?;
                }
            } else {
                add_import_record(&mut plan.records, value)?;
            }
        } else if name.contains("/images/") && name.starts_with("books/") {
            if size > MAX_ASSET_BYTES {
                return Err(format!("book asset is too large: {name}"));
            }
            let target = media_assets::safe_join(&plan.staging, &name)?;
            let parent = target
                .parent()
                .ok_or_else(|| "invalid asset path".to_string())?;
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            let mut output = std::fs::File::create(&target).map_err(|e| e.to_string())?;
            std::io::copy(&mut entry, &mut output).map_err(|e| e.to_string())?;
            output.sync_all().map_err(|e| e.to_string())?;
            plan.asset_files.push((name, target));
        } else {
            return Err(format!("unexpected file in WordHunter package: {name}"));
        }
    }
    if !manifest_seen {
        return Err("WordHunter package is missing manifest.yaml".to_string());
    }
    Ok(plan)
}

fn read_yaml(reader: &mut impl Read, max_bytes: u64) -> Result<Value, String> {
    let mut bytes = Vec::new();
    reader
        .take(max_bytes + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > max_bytes {
        return Err("YAML entry is too large".to_string());
    }
    serde_yaml::from_slice(&bytes).map_err(|e| format!("invalid YAML: {e}"))
}

fn add_import_record(
    records: &mut BTreeMap<String, record_files::SyncRecord>,
    value: Value,
) -> Result<(), String> {
    let record = record_files::parse_record(&value)?;
    match records.get(&record.key) {
        Some(saved) if record_files::record_time(saved) >= record_files::record_time(&record) => {}
        _ => {
            records.insert(record.key.clone(), record);
        }
    }
    Ok(())
}

fn validated_archive_name(name: &str) -> Result<String, String> {
    let path = Path::new(name);
    if name.contains('\\') || path.is_absolute() {
        return Err("archive path is invalid".to_string());
    }
    let mut parts = Vec::new();
    for component in path.components() {
        match component {
            std::path::Component::Normal(part) => parts.push(
                part.to_str()
                    .ok_or_else(|| "archive path is not UTF-8".to_string())?
                    .to_string(),
            ),
            _ => return Err("archive path is invalid".to_string()),
        }
    }
    if parts.is_empty() {
        return Err("archive path is empty".to_string());
    }
    if parts.len() > MAX_PATH_COMPONENTS {
        return Err("archive path has too many components".to_string());
    }
    Ok(parts.join("/"))
}

fn is_record_yaml(name: &str) -> bool {
    name.ends_with(".yaml")
        && (name.starts_with("words/")
            || name.starts_with("records/")
            || (name.starts_with("books/")
                && (name.ends_with("/book.yaml") || name.contains("/records/"))))
}

fn record_book_id(record: &record_files::SyncRecord) -> Option<String> {
    match record.kind.as_str() {
        "text" => record.key.strip_prefix("text:").map(str::to_string),
        "book" => record.key.rsplit_once(':').map(|(_, id)| id.to_string()),
        _ => None,
    }
}

fn asset_book_id(path: &str) -> Option<&str> {
    let mut parts = path.split('/');
    (parts.next() == Some("books"))
        .then(|| parts.next())
        .flatten()
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use serde_json::json;

    use super::*;
    use crate::store::{StoreInner, record_files};

    fn store(root: &Path, device_id: &str) -> Store {
        std::fs::create_dir_all(root.join("books")).unwrap();
        Store {
            inner: Mutex::new(StoreInner {
                dir: root.to_path_buf(),
                books_dir: root.join("books"),
            }),
            write_lock: Mutex::new(()),
            base_records: Mutex::new(BTreeMap::new()),
            device_id: device_id.to_string(),
            startup_instant: std::time::Instant::now(),
        }
    }

    #[test]
    fn package_roundtrip_keeps_newest_words_and_book_images() {
        let source_dir = tempfile::tempdir().unwrap();
        let target_dir = tempfile::tempdir().unwrap();
        let source = store(source_dir.path(), "pc");
        let target = store(target_dir.path(), "phone");
        let source_records = record_files::payload_to_records(
            &json!({
                "vocab": {"de": {"vocab": {"Haus": {"word": "Haus", "translation": "house"}}}},
                "texts": [{"id": "book-1", "title": "PDF", "pdfOcrPages": [{"imageName": "page.png"}]}],
            }),
            "pc",
            200,
        );
        record_files::write_records(source_dir.path(), &source_records).unwrap();
        source
            .save_book_image_bytes("book-1", "page.png", b"page image")
            .unwrap();
        let older = record_files::payload_to_records(
            &json!({"vocab": {"de": {"vocab": {"Haus": {"word": "Haus", "translation": "building"}}}}}),
            "phone",
            100,
        );
        record_files::write_records(target_dir.path(), &older).unwrap();

        let archive = source_dir.path().join("transfer.zip");
        source.export_transfer(&archive, ExportScope::All).unwrap();
        let result = target.import_transfer(&archive).unwrap();
        assert_eq!(result["assets"], 1);
        let records = record_files::load_records(target_dir.path()).unwrap();
        assert_eq!(records["vocab:de:haus"].data["translation"], "house");
        assert_eq!(
            std::fs::read(target_dir.path().join("books/book-1/images/page.png")).unwrap(),
            b"page image"
        );

        let newer_dir = tempfile::tempdir().unwrap();
        let newer = store(newer_dir.path(), "newer-phone");
        let newer_records = record_files::payload_to_records(
            &json!({
                "texts": [{"id": "book-1", "title": "Newer PDF", "pdfOcrPages": [{"imageName": "page.png"}]}]
            }),
            "newer-phone",
            300,
        );
        record_files::write_records(newer_dir.path(), &newer_records).unwrap();
        newer
            .save_book_image_bytes("book-1", "page.png", b"newer local image")
            .unwrap();
        let result = newer.import_transfer(&archive).unwrap();
        assert_eq!(result["assets"], 0);
        assert_eq!(
            std::fs::read(newer_dir.path().join("books/book-1/images/page.png")).unwrap(),
            b"newer local image"
        );
    }

    #[test]
    fn archive_paths_cannot_escape_staging() {
        assert!(validated_archive_name("../outside").is_err());
        assert!(validated_archive_name("books\\outside").is_err());
        assert_eq!(
            validated_archive_name("words/one.yaml").unwrap(),
            "words/one.yaml"
        );
        assert!(validated_archive_name(&format!("{}x.yaml", "a/".repeat(40))).is_err());
    }

    #[test]
    fn oversized_book_yaml_splits_into_per_record_entries() {
        let long = "x".repeat(500);
        let records = vec![
            json!({ "key": "text:book-1", "data": long }),
            json!({ "key": "book:de:book-1", "data": "b" }),
        ];
        let entries = book_yaml_entries("book-1", &records, 64).unwrap();
        assert_eq!(entries.len(), 2);
        assert!(
            entries
                .iter()
                .all(|(name, _)| name.starts_with("books/book-1/records/"))
        );
        for (_, value) in &entries {
            assert!(serde_yaml::to_string(value).unwrap().len() as u64 <= MAX_YAML_BYTES);
        }
        let small = book_yaml_entries("book-1", &records, 1024 * 1024).unwrap();
        assert_eq!(small.len(), 1);
        assert!(small[0].0.ends_with("/book.yaml"));

        let huge = vec![json!({ "key": "text:book-1", "data": "x".repeat(9 * 1024 * 1024) })];
        assert!(book_yaml_entries("book-1", &huge, 64).is_err());
    }

    #[test]
    fn split_book_package_imports_all_records_and_assets() {
        let dir = tempfile::tempdir().unwrap();
        let target = store(dir.path(), "phone");
        let records = record_files::payload_to_records(
            &json!({
                "vocab": {"de": {"vocab": {}}},
                "texts": [{
                    "id": "book-1",
                    "title": "Big PDF",
                    "pdfOcrPages": [{"imageName": "page.png"}]
                }],
            }),
            "pc",
            200,
        );
        let book_records = records
            .values()
            .filter(|record| record_book_id(record).is_some())
            .map(record_files::record_value)
            .collect::<Vec<_>>();

        let archive = dir.path().join("split.zip");
        let file = std::fs::File::create(&archive).unwrap();
        let mut zip = ZipWriter::new(file);
        let options = SimpleFileOptions::default();
        write_yaml(
            &mut zip,
            "manifest.yaml",
            &json!({
                "format": FORMAT,
                "schemaVersion": SCHEMA_VERSION,
                "appVersion": "1.0.9-rc.7",
                "exportedAt": "1",
                "scope": "all",
            }),
            options,
        )
        .unwrap();
        for (name, value) in book_yaml_entries("book-1", &book_records, 1).unwrap() {
            write_yaml(&mut zip, &name, &value, options).unwrap();
        }
        zip.start_file("books/book-1/images/page.png", options)
            .unwrap();
        zip.write_all(b"page image").unwrap();
        zip.finish().unwrap();

        let result = target.import_transfer(&archive).unwrap();
        assert_eq!(result["imported"], 1);
        assert_eq!(result["assets"], 1);
        let loaded = record_files::load_records(dir.path()).unwrap();
        assert_eq!(loaded["text:book-1"].data["title"], "Big PDF");
        assert_eq!(
            std::fs::read(dir.path().join("books/book-1/images/page.png")).unwrap(),
            b"page image"
        );
    }

    #[test]
    fn asset_tree_depth_is_limited() {
        let dir = tempfile::tempdir().unwrap();
        let images = dir.path().join("books/b1/images");
        let nested = (0..20)
            .fold(images.clone(), |path, _| path.join("d"));
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(nested.join("file.png"), b"x").unwrap();
        let file = std::fs::File::create(dir.path().join("out.zip")).unwrap();
        let mut zip = ZipWriter::new(file);
        let result = write_asset_tree(
            &mut zip,
            &images,
            "books/b1/images",
            SimpleFileOptions::default(),
            0,
        );
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("too deep"));
    }

    #[test]
    fn file_backups_restore_changed_and_new_targets() {
        let dir = tempfile::tempdir().unwrap();
        let staging = dir.path().join("staging");
        let existing = dir.path().join("existing.yaml");
        let new = dir.path().join("new.yaml");
        std::fs::create_dir(&staging).unwrap();
        std::fs::write(&existing, "old").unwrap();
        let backups =
            backup_targets(&staging, BTreeSet::from([existing.clone(), new.clone()])).unwrap();
        std::fs::write(&existing, "changed").unwrap();
        std::fs::write(&new, "created").unwrap();

        restore_targets(&backups).unwrap();

        assert_eq!(std::fs::read_to_string(existing).unwrap(), "old");
        assert!(!new.exists());
    }
}
