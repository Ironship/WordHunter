use std::collections::{BTreeMap, BTreeSet};
use std::io::{Read, Seek, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{Value, json};
use zip::{ZipArchive, ZipWriter, write::SimpleFileOptions};

use super::{Store, books, durable, media_assets, record_files};

const FORMAT: &str = "wordhunter-transfer";
const SCHEMA_VERSION: u64 = 1;
const MAX_ENTRIES: usize = 100_000;
// Per-entry YAML cap. Large enough for whole-book OCR text records (the
// biggest real book bodies are tens of MB), while serde_yaml_ng bounds alias
// expansion with its own "repetition limit", so a bigger input cannot turn
// into a memory bomb on import.
const MAX_YAML_BYTES: u64 = 64 * 1024 * 1024;
const MAX_BOOK_YAML_BYTES: u64 = 4 * 1024 * 1024;
const MAX_ASSET_BYTES: u64 = 512 * 1024 * 1024;
pub(crate) const MAX_TOTAL_BYTES: u64 = 2 * 1024 * 1024 * 1024;
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
    /// Set for the automatic backup made before a clear, with its export
    /// time: importing it must undo that clear.
    clear_backup: Option<(ClearBackup, u128)>,
}

/// Manifest `purpose` of the backup the app makes before clearing data.
pub(crate) const BACKUP_BEFORE_CLEAR: &str = "backup-before-clear";
/// The clear runs as soon as its backup is saved; changes later than this
/// after the backup are the user's own and are kept.
const CLEAR_RESTORE_WINDOW_MS: u128 = 60 * 60 * 1000;

/// The backup made before "Clear words" (`words`), "Clear library"
/// (`library`) or "Clear everything" (`all`) of one learning language.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ClearBackup {
    clear: String,
    language: String,
}

impl ClearBackup {
    /// Reads `purpose`, `clear` and `clearLanguage` from an export request or
    /// a package manifest.
    pub(crate) fn parse(value: &Value) -> Option<Self> {
        if value.get("purpose").and_then(Value::as_str) != Some(BACKUP_BEFORE_CLEAR) {
            return None;
        }
        let clear = value.get("clear").and_then(Value::as_str)?;
        let language = value
            .get("clearLanguage")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let valid = match clear {
            "words" | "library" => !language.is_empty(),
            "all" => true,
            _ => false,
        };
        valid.then(|| Self {
            clear: clear.to_string(),
            language: language.to_string(),
        })
    }

    /// Whether the clear deleted this record (`backup` is its copy in the backup).
    fn deleted(&self, key: &str, backup: &record_files::SyncRecord) -> bool {
        let in_language = |prefix: &str| {
            key.strip_prefix(prefix)
                .and_then(|rest| rest.split_once(':'))
                .is_some_and(|(language, _)| language == self.language)
        };
        match self.clear.as_str() {
            "words" => in_language("vocab:"),
            "library" => {
                in_language("book:")
                    || key.starts_with("hidden:")
                    || (key.starts_with("text:")
                        && backup
                            .data
                            .get("lang")
                            .and_then(Value::as_str)
                            .is_none_or(|language| language == self.language))
            }
            _ => true,
        }
    }

    /// Whether the clear edited this record in place instead of deleting it.
    fn edited(&self, key: &str) -> bool {
        match self.clear.as_str() {
            "library" => {
                matches!(key, "pref:readerBookmarks" | "pref:lastReadTextIds")
                    || key.strip_prefix("profile:") == Some(self.language.as_str())
            }
            // After the wipe the app saves its default settings and profile
            // again; those stand in for the ones the wipe deleted.
            "all" => key.starts_with("pref:") || key.starts_with("profile:"),
            _ => false,
        }
    }
}

fn within_clear_window(time: u128, exported_at: u128) -> bool {
    time >= exported_at && time - exported_at <= CLEAR_RESTORE_WINDOW_MS
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
    pub fn export_transfer(
        &self,
        target: &Path,
        scope: ExportScope,
        clear_backup: Option<&ClearBackup>,
        progress: Option<&ExportProgress>,
    ) -> Result<Value, String> {
        // Keep the write lock only for the quick snapshot phase (record listing and
        // pending-save recovery). Building the ZIP reads asset files and can take
        // minutes for large libraries — holding the lock that long would block all
        // saves, snapshots, and imports app-wide.
        let records = {
            let _guard = self.lock_writes()?;
            self.recover_pending_save()?;
            record_files::load_records(&self.dir())?
        };
        if let Some(progress) = progress {
            progress.set_phase("words");
            let live = || {
                records
                    .values()
                    .filter(|record| record.deleted_at.is_none())
            };
            progress.set_totals(
                live().filter(|record| record.kind == "vocab").count(),
                live()
                    .filter(|record| record.kind != "vocab" && record_book_id(record).is_none())
                    .count(),
                live()
                    .filter(|record| record_book_id(record).is_some())
                    .count(),
                0,
            );
        }
        let file = std::fs::File::create(target)
            .map_err(|e| format!("could not create export {}: {e}", target.display()))?;
        let mut zip = ZipWriter::new(file);
        let options = SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated)
            .unix_permissions(0o600);
        let mut counters = ExportCounters::default();
        let mut manifest = json!({
            "format": FORMAT,
            "schemaVersion": SCHEMA_VERSION,
            "appVersion": crate::APP_VERSION,
            "exportedAt": record_files::now_millis().to_string(),
            "scope": scope.as_str(),
        });
        if let Some(clear_backup) = clear_backup {
            manifest["purpose"] = json!(BACKUP_BEFORE_CLEAR);
            manifest["clear"] = json!(clear_backup.clear);
            manifest["clearLanguage"] = json!(clear_backup.language);
        }
        write_yaml_counted(&mut zip, "manifest.yaml", &manifest, options, &mut counters)?;
        if let Some(progress) = progress {
            progress.set_phase("words");
        }

        let mut books: BTreeMap<String, Vec<Value>> = BTreeMap::new();
        let mut books_with_assets = BTreeSet::new();
        for record in records.values() {
            if scope == ExportScope::Vocabulary && record.kind != "vocab" {
                continue;
            }
            // A package is a copy of what exists: deletions stay on this
            // device, so importing it never deletes anything elsewhere.
            if is_device_secret(record) || record.deleted_at.is_some() {
                continue;
            }
            let value = record_files::record_value(record);
            if record.kind == "vocab" {
                write_yaml_counted(
                    &mut zip,
                    &format!("words/{}.yaml", record_files::stable_hash(&record.key)),
                    &value,
                    options,
                    &mut counters,
                )?;
                counters.records += 1;
                if let Some(progress) = progress {
                    progress.add_word();
                }
            } else if scope == ExportScope::All {
                if let Some(book_id) = record_book_id(record) {
                    if record.kind == "text" && record.deleted_at.is_none() {
                        books_with_assets.insert(book_id.clone());
                    }
                    books.entry(book_id).or_default().push(value);
                } else {
                    write_yaml_counted(
                        &mut zip,
                        &format!("records/{}.yaml", record_files::stable_hash(&record.key)),
                        &value,
                        options,
                        &mut counters,
                    )?;
                    counters.records += 1;
                    if let Some(progress) = progress {
                        progress.add_record();
                    }
                }
            }
        }

        if scope == ExportScope::All {
            if let Some(progress) = progress {
                progress.set_phase("books");
                // One total over every book, so the images percentage keeps
                // moving from the first book's images to the last one's.
                let total_assets = books_with_assets
                    .iter()
                    .filter_map(|book_id| crate::paths::sanitize_id(book_id).ok())
                    .map(|safe_id| {
                        count_asset_files(&self.dir().join("books").join(safe_id).join("images"))
                    })
                    .sum();
                progress.set_total_assets(total_assets);
            }
            for (book_id, book_records) in &books {
                for (name, value) in book_yaml_entries(book_id, book_records, MAX_BOOK_YAML_BYTES)?
                {
                    write_yaml_counted(&mut zip, &name, &value, options, &mut counters)?;
                }
                counters.records += book_records.len();
                let safe_id = crate::paths::sanitize_id(book_id)?;
                if books_with_assets.contains(book_id) {
                    let images = self.dir().join("books").join(&safe_id).join("images");
                    if let Some(progress) = progress {
                        progress.set_phase("images");
                    }
                    write_asset_tree_counted(
                        &mut zip,
                        &images,
                        &format!("books/{safe_id}/images"),
                        options,
                        0,
                        &mut counters,
                        progress,
                    )?;
                }
                if let Some(progress) = progress {
                    progress.add_book();
                }
            }
        }
        if let Some(progress) = progress {
            progress.set_phase("finalizing");
        }
        zip.finish()
            .map_err(|e| format!("could not finish export {}: {e}", target.display()))?
            .sync_all()
            .map_err(|e| format!("could not sync export {}: {e}", target.display()))?;
        durable::sync_parent(target)?;
        Ok(json!({
            "records": counters.records,
            "books": books.len(),
            "assets": counters.assets,
            "scope": scope.as_str(),
            "bytes": counters.bytes,
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
        let now = record_files::now_millis();
        let mut edited_by_clear = Vec::new();
        // A device with no words or books yet (fresh install, onboarding
        // done) takes the package's settings, although it saved its own
        // defaults later than the package was made. Not when restoring the
        // backup a clear made: the clear itself can leave the device empty.
        let fresh_target = plan.clear_backup.is_none()
            && !current.values().any(|record| {
                record.deleted_at.is_none()
                    && matches!(record.kind.as_str(), "vocab" | "text" | "book")
            });
        let new_books = books_brought_by(&root, &current, &plan)?;
        let package_books = plan
            .records
            .values()
            .filter(|record| record.deleted_at.is_none())
            .filter_map(record_book_id)
            .collect::<BTreeSet<_>>();
        let device_books = current
            .values()
            .filter(|record| record.deleted_at.is_none())
            .filter_map(record_book_id)
            .collect::<BTreeSet<_>>();
        for (key, mut incoming) in std::mem::take(&mut plan.records) {
            // Packages from before 1.1.2 may carry API keys and deletions;
            // keep this device's own keys, and delete nothing here.
            if is_device_secret(&incoming) || incoming.deleted_at.is_some() {
                skipped += 1;
                continue;
            }
            let saved = current.get(&key);
            // The clear that followed the backup deleted these records, so its
            // tombstones are newer than the backup; restoring the backup is
            // the user taking the clear back. The restored record is stamped
            // now so it also wins over the deletion on other devices.
            let cleared_after_backup =
                plan.clear_backup
                    .as_ref()
                    .is_some_and(|(clear, exported_at)| {
                        incoming.deleted_at.is_none()
                            && clear.deleted(&key, &incoming)
                            && saved
                                .and_then(|saved| saved.deleted_at)
                                .is_some_and(|deleted_at| {
                                    within_clear_window(deleted_at, *exported_at)
                                })
                    });
            let saved_is_newer = saved.is_some_and(|saved| {
                record_files::record_time(saved) >= record_files::record_time(&incoming)
            });
            let edited_by_the_clear = saved_is_newer
                && plan
                    .clear_backup
                    .as_ref()
                    .is_some_and(|(clear, exported_at)| {
                        clear.edited(&key)
                            && saved.is_some_and(|saved| {
                                saved.deleted_at.is_none()
                                    && within_clear_window(saved.updated_at, *exported_at)
                            })
                    });
            if cleared_after_backup {
                restore_over(&mut incoming, saved, &self.device_id, now);
            } else if edited_by_the_clear {
                edited_by_clear.push((key, incoming));
                continue;
            } else if let Some(data) = saved.and_then(|saved| {
                // A backup made before a clear gives back only what the clear
                // changed (above); later edits of these lists stay.
                merged_on_import(
                    saved,
                    &incoming,
                    fresh_target,
                    plan.clear_backup.is_none(),
                    &new_books,
                    &package_books,
                    &device_books,
                )
            }) {
                incoming.data = data;
                restore_over(&mut incoming, saved, &self.device_id, now);
            } else if saved_is_newer {
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
        // "Clear library" also edits bookmarks, the last read book and the
        // archive list in place; give back what it removed from them for the
        // books that are back and for built-in books. After "Clear
        // everything" the backup's settings replace the defaults saved since.
        let books = |live_only: bool| {
            current
                .iter()
                .filter(|(key, _)| !accepted.contains_key(*key))
                .map(|(_, record)| record)
                .chain(accepted.values())
                .filter(|record| !live_only || record.deleted_at.is_none())
                .filter_map(|record| record_key_book_id(&record.key))
                .collect::<BTreeSet<_>>()
        };
        let (live_books, user_books) = (books(true), books(false));
        let wiped = plan
            .clear_backup
            .as_ref()
            .is_some_and(|(clear, _)| clear.clear == "all");
        for (key, mut incoming) in edited_by_clear {
            let saved = current.get(&key);
            let data = if wiped {
                Some(incoming.data.clone())
            } else {
                saved.and_then(|saved| {
                    restore_cleared_entries(saved, &incoming, &live_books, &user_books)
                })
            };
            match data {
                Some(data) => {
                    incoming.data = data;
                    restore_over(&mut incoming, saved, &self.device_id, now);
                    accepted.insert(key, incoming);
                }
                None => skipped += 1,
            }
        }
        // A PDF book whose page images are neither in the package nor here
        // is left out; the rest of the package still comes in.
        let incomplete = texts_missing_pdf_images(&root, &accepted, &plan.asset_files)?;
        for key in &incomplete {
            if let Some(record) = accepted.remove(key)
                && let Some(book_id) = record_book_id(&record)
            {
                accepted_books.remove(&crate::paths::sanitize_id(&book_id)?);
            }
            skipped += 1;
        }

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
            self.invalidate_records_cache();
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
            "incompleteBooks": incomplete.len(),
            "assets": asset_copies.len(),
            "snapshot": self.snapshot_unacknowledged(),
        }))
    }
}

/// Keys of PDF text records with a page image that is neither in the package
/// nor already on this device.
fn texts_missing_pdf_images(
    root: &Path,
    records: &BTreeMap<String, record_files::SyncRecord>,
    assets: &[(String, PathBuf)],
) -> Result<BTreeSet<String>, String> {
    let paths = assets
        .iter()
        .map(|(path, _)| path.as_str())
        .collect::<BTreeSet<_>>();
    let mut incomplete = BTreeSet::new();
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
            if !paths.contains(expected.as_str())
                && !media_assets::safe_join(root, &expected)?.is_file()
            {
                incomplete.insert(record.key.clone());
                break;
            }
        }
    }
    Ok(incomplete)
}

/// Ids of the books this package brings to this device: live in the
/// package, missing here or deleted before the package's copy was saved, and
/// complete (a PDF book without its page images is left out).
fn books_brought_by(
    root: &Path,
    current: &BTreeMap<String, record_files::SyncRecord>,
    plan: &ImportPlan,
) -> Result<BTreeSet<String>, String> {
    let brought = plan
        .records
        .iter()
        .filter(|(key, incoming)| {
            matches!(incoming.kind.as_str(), "text" | "book")
                && incoming.deleted_at.is_none()
                && current.get(*key).is_none_or(|saved| {
                    saved.deleted_at.is_some()
                        && record_files::record_time(saved) < record_files::record_time(incoming)
                })
        })
        .map(|(key, record)| (key.clone(), record.clone()))
        .collect::<BTreeMap<_, _>>();
    let incomplete = texts_missing_pdf_images(root, &brought, &plan.asset_files)?;
    Ok(brought
        .iter()
        .filter(|(key, _)| !incomplete.contains(*key))
        .filter_map(|(_, record)| record_book_id(record))
        .collect())
}

/// Import data for records that are merged instead of replaced. Without a
/// common ancestor a missing entry can mean either side removed it, so the
/// newer record wins and keeps the other side's reading positions, last
/// read book and archive entries only for books the newer side can't have
/// removed them from: the books this import brings (`new_books`) when this
/// device's record is newer, and this device's own books the package
/// doesn't have (`device_books`, `package_books`) when the package's is.
/// Built-in books are on both sides, so the newer side decides for them. Review days are facts and
/// always add up. On a device without words or books yet the package's
/// settings win, and the device keeps its own reading positions and lists
/// alongside them. `merge_lists` is false for the backup a clear made,
/// which restores exactly what the clear changed elsewhere. `None` leaves
/// the usual newest-wins.
fn merged_on_import(
    saved: &record_files::SyncRecord,
    incoming: &record_files::SyncRecord,
    fresh_target: bool,
    merge_lists: bool,
    new_books: &BTreeSet<String>,
    package_books: &BTreeSet<String>,
    device_books: &BTreeSet<String>,
) -> Option<Value> {
    if saved.deleted_at.is_some() || incoming.deleted_at.is_some() {
        return None;
    }
    let saved_is_newer = record_files::record_time(saved) >= record_files::record_time(incoming);
    let default_winner = if saved_is_newer { saved } else { incoming };
    let is_settings = saved.key.starts_with("pref:") || saved.key.starts_with("profile:");
    let fresh = fresh_target && is_settings;
    if !fresh && !merge_lists {
        return None;
    }
    let (newer, older) = if fresh || !saved_is_newer {
        (incoming, saved)
    } else {
        (saved, incoming)
    };
    // Which of the older side's books to keep: all of them for the fresh
    // device's own; else the package's entries for the books it brings, or
    // this device's entries for the books the package doesn't have.
    let keep = |id: &str| {
        fresh
            || if saved_is_newer {
                new_books.contains(id)
            } else {
                device_books.contains(id) && !package_books.contains(id)
            }
    };
    let mut merged = newer.clone();
    match saved.key.as_str() {
        "pref:readerBookmarks" => {
            let mut kept = older.clone();
            kept.data = Value::Object(
                older
                    .data
                    .as_object()?
                    .iter()
                    .filter(|(id, _)| keep(id))
                    .map(|(id, bookmarks)| (id.clone(), bookmarks.clone()))
                    .collect(),
            );
            if !record_files::merge_reader_bookmark_data(&mut merged, &kept, None, true) {
                return None;
            }
        }
        "pref:lastReadTextIds" => {
            let target = merged.data.as_object_mut()?;
            for (language, id) in older.data.as_object()? {
                if id.as_str().is_some_and(keep) {
                    target.entry(language.clone()).or_insert_with(|| id.clone());
                }
            }
        }
        key if key.starts_with("profile:") => {
            record_files::merge_review_days(&mut merged, older);
            for field in ["archivedBookIds", "hiddenBuiltInBooks"] {
                // Hiding a built-in book is not about a book the import brings.
                if field == "hiddenBuiltInBooks" && !fresh {
                    continue;
                }
                let Some(older_ids) = older.data.get(field).and_then(Value::as_array) else {
                    continue;
                };
                let Some(ids) = merged
                    .data
                    .as_object_mut()?
                    .entry(field)
                    .or_insert_with(|| Value::Array(Vec::new()))
                    .as_array_mut()
                else {
                    continue;
                };
                for id in older_ids {
                    if id.as_str().is_some_and(keep) && !ids.contains(id) {
                        ids.push(id.clone());
                    }
                }
            }
        }
        _ if fresh => {}
        _ => return None,
    }
    // Only a result that differs from what would win anyway needs a stamp.
    (merged.data != default_winner.data).then_some(merged.data)
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

#[cfg(test)]
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

#[derive(Default)]
struct ExportCounters {
    entries: usize,
    records: usize,
    assets: usize,
    bytes: u64,
}

/// Shared progress state for a running package export. The desktop HTTP
/// handler publishes it so the frontend can poll a stage-based progress bar
/// instead of leaving users staring at a frozen button while the ZIP is built.
#[derive(Clone, Default)]
pub struct ExportProgress {
    inner: Arc<std::sync::Mutex<ExportProgressInner>>,
}

#[derive(Default)]
struct ExportProgressInner {
    phase: &'static str,
    done_words: usize,
    total_words: usize,
    done_records: usize,
    total_records: usize,
    done_books: usize,
    total_books: usize,
    done_assets: usize,
    total_assets: usize,
    error: Option<String>,
    summary: Option<Value>,
}

impl ExportProgress {
    pub fn new() -> Self {
        Self::default()
    }

    fn set_phase(&self, phase: &'static str) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.phase = phase;
        }
    }

    fn set_totals(&self, words: usize, records: usize, books: usize, assets: usize) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.total_words = words;
            inner.total_records = records;
            inner.total_books = books;
            inner.total_assets = assets;
        }
    }

    fn set_total_assets(&self, assets: usize) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.total_assets = assets;
        }
    }

    fn add_word(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.done_words += 1;
        }
    }

    fn add_record(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.done_records += 1;
        }
    }

    fn add_book(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.done_books += 1;
        }
    }

    fn add_asset(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.done_assets += 1;
        }
    }

    pub fn set_error(&self, error: String) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.phase = "error";
            inner.error = Some(error);
        }
    }

    pub fn set_done(&self, summary: Value) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.phase = "done";
            inner.summary = Some(summary);
        }
    }

    /// Stage-weighted percentage: preparing 0–2, words 2–25, records 25–35,
    /// books 35–45, images 45–95, finalizing 95, done 100.
    pub fn snapshot(&self) -> Value {
        let (phase, percent, steps, error, summary) = if let Ok(inner) = self.inner.lock() {
            let percent = match inner.phase {
                "preparing" => 0u8,
                "words" => 2 + scaled_percent(inner.done_words, inner.total_words, 23),
                "records" => 25 + scaled_percent(inner.done_records, inner.total_records, 10),
                "books" => 35 + scaled_percent(inner.done_books, inner.total_books, 10),
                "images" => 45 + scaled_percent(inner.done_assets, inner.total_assets, 50),
                "finalizing" => 95,
                "done" => 100,
                _ => 0,
            };
            (
                inner.phase.to_string(),
                percent,
                inner.done_words + inner.done_records + inner.done_books + inner.done_assets,
                inner.error.clone(),
                inner.summary.clone(),
            )
        } else {
            ("preparing".to_string(), 0u8, 0, None, None)
        };
        let mut value = json!({
            "phase": phase,
            "percent": percent,
            // Items written so far: moves even while the percentage doesn't.
            "steps": steps,
            "done": phase == "done" || error.is_some(),
        });
        if let Some(error) = error {
            value["error"] = Value::String(error);
        }
        if let Some(summary) = summary {
            value["summary"] = summary;
        }
        value
    }
}

fn scaled_percent(done: usize, total: usize, span: u8) -> u8 {
    if total == 0 {
        return span;
    }
    let value = (u64::from(span) * done.min(total) as u64) / total as u64;
    value.min(u64::from(span)) as u8
}

impl ExportCounters {
    fn add_entry(&mut self, name: &str, size: u64) -> Result<(), String> {
        self.entries += 1;
        if self.entries > MAX_ENTRIES {
            return Err(
                "export exceeds the 100,000 entry limit of the WordHunter import format"
                    .to_string(),
            );
        }
        self.bytes = self
            .bytes
            .checked_add(size)
            .ok_or_else(|| "export size overflow".to_string())?;
        if self.bytes > MAX_TOTAL_BYTES {
            return Err(
                "export exceeds the 2 GB total size limit of the WordHunter import format"
                    .to_string(),
            );
        }
        if size > MAX_YAML_BYTES && name.ends_with(".yaml") {
            return Err(format!(
                "{name} exceeds the {mb} MB YAML limit of the WordHunter import format",
                mb = MAX_YAML_BYTES / (1024 * 1024)
            ));
        }
        Ok(())
    }
}

fn write_yaml_counted<W: Write + Seek>(
    zip: &mut ZipWriter<W>,
    name: &str,
    value: &Value,
    options: SimpleFileOptions,
    counters: &mut ExportCounters,
) -> Result<(), String> {
    let yaml = serde_yaml::to_string(value).map_err(|e| e.to_string())?;
    counters.add_entry(name, yaml.len() as u64)?;
    zip.start_file(name, options).map_err(|e| e.to_string())?;
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
            format!(
                "books/{safe_id}/records/{}.yaml",
                record_files::stable_hash(key)
            ),
            record.clone(),
        ));
    }
    Ok(entries)
}

fn write_asset_tree_counted<W: Write + Seek>(
    zip: &mut ZipWriter<W>,
    dir: &Path,
    archive_dir: &str,
    options: SimpleFileOptions,
    depth: usize,
    counters: &mut ExportCounters,
    progress: Option<&ExportProgress>,
) -> Result<usize, String> {
    if depth > MAX_ASSET_TREE_DEPTH {
        return Err(format!("book asset tree is too deep below {archive_dir}"));
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
            count += write_asset_tree_counted(
                zip,
                &entry.path(),
                &format!("{archive_dir}/{name}"),
                options,
                depth + 1,
                counters,
                progress,
            )?;
        } else if file_type.is_file() {
            let size = entry.metadata().map_err(|e| e.to_string())?.len();
            if size > MAX_ASSET_BYTES {
                return Err(format!(
                    "book asset exceeds the 512 MB limit of the WordHunter import format: {archive_dir}/{name}"
                ));
            }
            let archive_name = format!("{archive_dir}/{name}");
            counters.add_entry(&archive_name, size)?;
            // Page scans and covers are compressed already; deflating them
            // again only makes large exports slow.
            let already_compressed = std::path::Path::new(&name)
                .extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| {
                    matches!(
                        extension.to_ascii_lowercase().as_str(),
                        "png" | "jpg" | "jpeg" | "webp" | "gif"
                    )
                });
            let file_options = if already_compressed {
                options.compression_method(zip::CompressionMethod::Stored)
            } else {
                options
            };
            zip.start_file(archive_name, file_options)
                .map_err(|e| e.to_string())?;
            let mut file = std::fs::File::open(entry.path()).map_err(|e| e.to_string())?;
            std::io::copy(&mut file, zip).map_err(|e| e.to_string())?;
            counters.assets += 1;
            if let Some(progress) = progress {
                progress.add_asset();
            }
            count += 1;
        }
    }
    Ok(count)
}

/// Fast pre-pass that counts files below `dir` so the export progress bar can
/// show a proportional percentage during the asset phase.
fn count_asset_files(dir: &Path) -> usize {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    let mut total = 0;
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_dir() {
            total += count_asset_files(&entry.path());
        } else if file_type.is_file() {
            total += 1;
        }
    }
    total
}

#[cfg(test)]
fn write_asset_tree<W: Write + Seek>(
    zip: &mut ZipWriter<W>,
    dir: &Path,
    archive_dir: &str,
    options: SimpleFileOptions,
    depth: usize,
) -> Result<usize, String> {
    let mut counters = ExportCounters::default();
    write_asset_tree_counted(zip, dir, archive_dir, options, depth, &mut counters, None)
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
        clear_backup: None,
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
            let exported_at = value
                .get("exportedAt")
                .and_then(Value::as_str)
                .and_then(|millis| millis.parse().ok());
            plan.clear_backup = ClearBackup::parse(&value).zip(exported_at);
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

/// API keys (DeepL, AI explanations) belong to the device they were entered
/// on. Transfer packages get shared and kept as backups, so the keys must not
/// travel in them in plain text.
fn is_device_secret(record: &record_files::SyncRecord) -> bool {
    record.kind == "pref"
        && record
            .key
            .strip_prefix("pref:")
            .is_some_and(|name| name.to_ascii_lowercase().ends_with("apikey"))
}

/// Makes a restored record win over `saved` by time and causally, so the
/// restore also reaches other devices that already synced the clear.
fn restore_over(
    incoming: &mut record_files::SyncRecord,
    saved: Option<&record_files::SyncRecord>,
    device_id: &str,
    now: u128,
) {
    if let Some(saved) = saved {
        for (device, counter) in &saved.causal {
            let entry = incoming.causal.entry(device.clone()).or_insert(0);
            *entry = (*entry).max(*counter);
        }
    }
    incoming.updated_at = now;
    incoming.device_id = device_id.to_string();
    record_files::bump_causal(&mut incoming.causal, device_id, now);
}

/// For records "Clear library" edits instead of deleting: the saved data plus
/// the backup's entries that the saved record lacks, for user books that are
/// back (`live_books`) and, in the last read and archive lists, built-in
/// books (ids that are not in `user_books`). `None` when nothing is missing.
/// Later edits of the saved record are kept.
fn restore_cleared_entries(
    saved: &record_files::SyncRecord,
    incoming: &record_files::SyncRecord,
    live_books: &BTreeSet<String>,
    user_books: &BTreeSet<String>,
) -> Option<Value> {
    if saved.deleted_at.is_some() {
        return None;
    }
    // A user book that is back, or a built-in book (which is never a record).
    let is_live = |id: &Value| {
        id.as_str()
            .is_some_and(|id| live_books.contains(id) || !user_books.contains(id))
    };
    let mut data = saved.data.clone();
    let target = data.as_object_mut()?;
    let mut changed = false;
    match saved.key.as_str() {
        // Bookmarks are keyed by book id, the last read book by language.
        "pref:readerBookmarks" | "pref:lastReadTextIds" => {
            let by_book = saved.key == "pref:readerBookmarks";
            for (key, value) in incoming.data.as_object()? {
                let book = if by_book {
                    live_books.contains(key)
                } else {
                    is_live(value)
                };
                if book && !target.contains_key(key) {
                    target.insert(key.clone(), value.clone());
                    changed = true;
                }
            }
        }
        // Profiles list archived books and hidden built-in books.
        _ => {
            if let Some(backup) = incoming
                .data
                .get("archivedBookIds")
                .and_then(Value::as_array)
                && let Some(archived) = target
                    .entry("archivedBookIds")
                    .or_insert_with(|| Value::Array(Vec::new()))
                    .as_array_mut()
            {
                for id in backup.iter().filter(|id| is_live(id)) {
                    if !archived.contains(id) {
                        archived.push(id.clone());
                        changed = true;
                    }
                }
            }
            // The clear shows every built-in book again; a list the user has
            // started again since is theirs.
            let hidden_is_empty = target
                .get("hiddenBuiltInBooks")
                .and_then(Value::as_array)
                .is_none_or(Vec::is_empty);
            if let Some(backup) = incoming.data.get("hiddenBuiltInBooks")
                && backup.as_array().is_some_and(|ids| !ids.is_empty())
                && hidden_is_empty
            {
                target.insert("hiddenBuiltInBooks".to_string(), backup.clone());
                changed = true;
            }
        }
    }
    changed.then_some(data)
}

/// The id of the user book or text a record key belongs to, whatever its kind.
fn record_key_book_id(key: &str) -> Option<String> {
    key.strip_prefix("text:")
        .or_else(|| {
            key.strip_prefix("book:")
                .and_then(|rest| rest.split_once(':').map(|(_, id)| id))
        })
        .map(str::to_string)
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
            base_page: Mutex::default(),
            records_cache: Mutex::new(None),
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
        source
            .export_transfer(&archive, ExportScope::All, None, None)
            .unwrap();
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
    fn backup_before_clear_restores_what_the_clear_deleted() {
        let dir = tempfile::tempdir().unwrap();
        let packages = tempfile::tempdir().unwrap();
        let store = store(dir.path(), "pc");
        let records = record_files::payload_to_records(
            &json!({"vocab": {
                "de": {"vocab": {"Haus": {"word": "Haus", "translation": "house"}}},
                "fr": {"vocab": {"maison": {"word": "maison", "translation": "house"}}},
            }}),
            "pc",
            100,
        );
        record_files::write_records(dir.path(), &records).unwrap();
        let regular = packages.path().join("regular.zip");
        let backup = packages.path().join("backup.zip");
        store
            .export_transfer(&regular, ExportScope::All, None, None)
            .unwrap();
        let clear_words = ClearBackup {
            clear: "words".to_string(),
            language: "de".to_string(),
        };
        store
            .export_transfer(&backup, ExportScope::All, Some(&clear_words), None)
            .unwrap();

        // "Clear words" of German, and the user deleting a French word right
        // after: tombstones newer than both packages.
        let cleared = record_files::load_records(dir.path())
            .unwrap()
            .into_iter()
            .filter(|(key, _)| key.starts_with("vocab:"))
            .map(|(key, record)| {
                let tombstone = record_files::tombstone_with_base(
                    &key,
                    "pc",
                    record_files::now_millis(),
                    Some(&record.causal),
                );
                (key, tombstone)
            })
            .collect::<BTreeMap<_, _>>();
        record_files::write_records(dir.path(), &cleared).unwrap();
        store.invalidate_records_cache();

        // An ordinary package keeps the deletion.
        store.import_transfer(&regular).unwrap();
        let after_regular = record_files::load_records(dir.path()).unwrap();
        assert!(after_regular["vocab:de:haus"].deleted_at.is_some());

        // The backup made before the clear takes it back.
        let summary = store.import_transfer(&backup).unwrap();
        assert!(summary["imported"].as_u64().unwrap_or(0) >= 1, "{summary}");
        let restored = record_files::load_records(dir.path()).unwrap();
        let haus = &restored["vocab:de:haus"];
        assert!(haus.deleted_at.is_none());
        assert_eq!(haus.data["translation"], "house");
        assert!(haus.updated_at > cleared["vocab:de:haus"].updated_at);
        // The clear covered German words only.
        assert!(restored["vocab:fr:maison"].deleted_at.is_some());
    }

    #[test]
    fn backup_before_clear_library_brings_back_pdf_images_and_bookmarks() {
        let dir = tempfile::tempdir().unwrap();
        let packages = tempfile::tempdir().unwrap();
        let store = store(dir.path(), "pc");
        let records = record_files::payload_to_records(
            &json!({
                "vocab": {"de": {
                    "vocab": {},
                    "archivedBookIds": ["book-1", "gb-archived", "book-2"],
                    "hiddenBuiltInBooks": ["gb-1"],
                }},
                "texts": [
                    {"id": "book-1", "title": "PDF", "pdfOcrPages": [{"imageName": "page.png"}]},
                    {"id": "book-2", "title": "Deleted later"},
                ],
                "prefs": {
                    "readerBookmarks": {"book-1": [{"page": 3}], "book-2": [{"page": 1}]},
                    "lastReadTextIds": {"de": "book-1"},
                },
            }),
            "pc",
            100,
        );
        record_files::write_records(dir.path(), &records).unwrap();
        store
            .save_book_image_bytes("book-1", "page.png", b"page image")
            .unwrap();
        let backup = packages.path().join("backup.zip");
        let clear_library = ClearBackup {
            clear: "library".to_string(),
            language: "de".to_string(),
        };
        store
            .export_transfer(&backup, ExportScope::All, Some(&clear_library), None)
            .unwrap();

        // "Clear library" deletes the books and edits the lists in place.
        store.delete_text("book-1").unwrap();
        let later = record_files::now_millis() + 2 * CLEAR_RESTORE_WINDOW_MS;
        let mut edited = record_files::payload_to_records(
            &json!({
                "vocab": {"de": {"vocab": {}, "archivedBookIds": [], "hiddenBuiltInBooks": []}},
                "prefs": {"readerBookmarks": {}, "lastReadTextIds": {}},
            }),
            "pc",
            record_files::now_millis(),
        );
        // A book the user deletes on their own well after the clear.
        edited.insert(
            "text:book-2".to_string(),
            record_files::tombstone_with_base("text:book-2", "pc", later, None),
        );
        record_files::write_records(dir.path(), &edited).unwrap();
        store.invalidate_records_cache();
        assert!(!dir.path().join("books/book-1/images/page.png").exists());

        store.import_transfer(&backup).unwrap();
        let restored = record_files::load_records(dir.path()).unwrap();
        assert!(restored["text:book-1"].deleted_at.is_none());
        assert!(restored["text:book-2"].deleted_at.is_some());
        assert_eq!(
            std::fs::read(dir.path().join("books/book-1/images/page.png")).unwrap(),
            b"page image"
        );
        let manifest: Value = serde_yaml::from_slice(
            &std::fs::read(media_assets::manifest_path(dir.path())).unwrap(),
        )
        .unwrap();
        assert!(manifest["assets"]["books/book-1/images/page.png"]["deletedAt"].is_null());
        assert_eq!(
            restored["pref:readerBookmarks"].data,
            json!({"book-1": [{"page": 3}]})
        );
        assert_eq!(
            restored["pref:lastReadTextIds"].data,
            json!({"de": "book-1"})
        );
        // Built-in books ("gb-archived") come back too; the book deleted
        // later does not.
        assert_eq!(
            restored["profile:de"].data["archivedBookIds"],
            json!(["book-1", "gb-archived"])
        );
        assert_eq!(
            restored["profile:de"].data["hiddenBuiltInBooks"],
            json!(["gb-1"])
        );
    }

    #[test]
    fn backup_before_clear_keeps_list_edits_made_well_after_the_clear() {
        let dir = tempfile::tempdir().unwrap();
        let packages = tempfile::tempdir().unwrap();
        let store = store(dir.path(), "pc");
        let records = record_files::payload_to_records(
            &json!({
                "vocab": {"de": {"vocab": {}, "archivedBookIds": ["book-1"], "hiddenBuiltInBooks": ["gb-1"]}},
                "texts": [{"id": "book-1", "title": "Kept", "lang": "de"}],
                "prefs": {"readerBookmarks": {"book-1": [{"page": 3}]}},
            }),
            "pc",
            100,
        );
        record_files::write_records(dir.path(), &records).unwrap();
        let backup = packages.path().join("backup.zip");
        let clear_library = ClearBackup {
            clear: "library".to_string(),
            language: "de".to_string(),
        };
        store
            .export_transfer(&backup, ExportScope::All, Some(&clear_library), None)
            .unwrap();

        // Hours later the user unarchives the book, shows the built-in book
        // again and removes the bookmark.
        let later = record_files::now_millis() + 2 * CLEAR_RESTORE_WINDOW_MS;
        let edited = record_files::payload_to_records(
            &json!({
                "vocab": {"de": {"vocab": {}, "archivedBookIds": [], "hiddenBuiltInBooks": []}},
                "prefs": {"readerBookmarks": {}},
            }),
            "pc",
            later,
        );
        record_files::write_records(dir.path(), &edited).unwrap();
        store.invalidate_records_cache();

        store.import_transfer(&backup).unwrap();
        let restored = record_files::load_records(dir.path()).unwrap();
        assert_eq!(restored["pref:readerBookmarks"].data, json!({}));
        assert_eq!(restored["profile:de"].data["archivedBookIds"], json!([]));
        assert_eq!(restored["profile:de"].data["hiddenBuiltInBooks"], json!([]));
    }

    #[test]
    fn backup_before_clear_everything_restores_settings_saved_over_by_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let packages = tempfile::tempdir().unwrap();
        let store = store(dir.path(), "pc");
        let records = record_files::payload_to_records(
            &json!({
                "vocab": {"de": {"vocab": {"Haus": {"word": "Haus"}}, "archivedBookIds": ["gb-2"]}},
                "prefs": {"theme": "dark", "locale": "pl", "lastReadTextIds": {"de": "gb-2"}},
            }),
            "pc",
            100,
        );
        record_files::write_records(dir.path(), &records).unwrap();
        let backup = packages.path().join("backup.zip");
        let wipe = ClearBackup {
            clear: "all".to_string(),
            language: "de".to_string(),
        };
        store
            .export_transfer(&backup, ExportScope::All, Some(&wipe), None)
            .unwrap();

        // The wipe deletes everything, then the app saves its defaults.
        let wiped = record_files::load_records(dir.path())
            .unwrap()
            .into_iter()
            .map(|(key, record)| {
                let now = record_files::now_millis();
                let tombstone =
                    record_files::tombstone_with_base(&key, "pc", now, Some(&record.causal));
                (key, tombstone)
            })
            .collect::<BTreeMap<_, _>>();
        record_files::write_records(dir.path(), &wiped).unwrap();
        let defaults = record_files::payload_to_records(
            &json!({
                "vocab": {"de": {"vocab": {}, "archivedBookIds": []}},
                "prefs": {"theme": "light", "locale": "en", "lastReadTextIds": {}},
            }),
            "pc",
            record_files::now_millis() + 1,
        );
        record_files::write_records(dir.path(), &defaults).unwrap();
        store.invalidate_records_cache();

        store.import_transfer(&backup).unwrap();
        let restored = record_files::load_records(dir.path()).unwrap();
        assert!(restored["vocab:de:haus"].deleted_at.is_none());
        assert_eq!(restored["pref:theme"].data, "dark");
        assert_eq!(restored["pref:locale"].data, "pl");
        assert_eq!(restored["pref:lastReadTextIds"].data, json!({"de": "gb-2"}));
        assert_eq!(
            restored["profile:de"].data["archivedBookIds"],
            json!(["gb-2"])
        );
    }

    #[test]
    fn only_the_backup_app_makes_before_a_clear_restores() {
        assert_eq!(
            ClearBackup::parse(
                &json!({"purpose": BACKUP_BEFORE_CLEAR, "clear": "words", "clearLanguage": "de"})
            ),
            Some(ClearBackup {
                clear: "words".to_string(),
                language: "de".to_string()
            })
        );
        assert!(
            ClearBackup::parse(&json!({"purpose": BACKUP_BEFORE_CLEAR, "clear": "all"})).is_some()
        );
        assert!(
            ClearBackup::parse(&json!({"purpose": BACKUP_BEFORE_CLEAR, "clear": "words"}))
                .is_none()
        );
        assert!(
            ClearBackup::parse(
                &json!({"purpose": BACKUP_BEFORE_CLEAR, "clear": "vocab", "clearLanguage": "de"})
            )
            .is_none()
        );
        assert!(ClearBackup::parse(&json!({"purpose": "other", "clear": "all"})).is_none());
        assert!(ClearBackup::parse(&json!({"clear": "all"})).is_none());
    }

    #[test]
    fn packages_carry_no_deletions() {
        let source_dir = tempfile::tempdir().unwrap();
        let target_dir = tempfile::tempdir().unwrap();
        let source = store(source_dir.path(), "phone");
        let target = store(target_dir.path(), "pc");
        let words = record_files::payload_to_records(
            &json!({"vocab": {"de": {"vocab": {"Haus": {"word": "Haus"}, "Baum": {"word": "Baum"}}}}}),
            "pc",
            100,
        );
        record_files::write_records(target_dir.path(), &words).unwrap();
        // The phone cleared "Baum" after the two devices shared their words.
        let mut phone = words.clone();
        phone.insert(
            "vocab:de:baum".to_string(),
            record_files::tombstone_with_base("vocab:de:baum", "phone", 200, None),
        );
        record_files::write_records(source_dir.path(), &phone).unwrap();

        let archive = source_dir.path().join("words.zip");
        source
            .export_transfer(&archive, ExportScope::All, None, None)
            .unwrap();
        let mut zip = zip::ZipArchive::new(std::fs::File::open(&archive).unwrap()).unwrap();
        let names = (0..zip.len())
            .map(|index| zip.by_index(index).unwrap().name().to_string())
            .collect::<Vec<_>>();
        let baum = format!("words/{}.yaml", record_files::stable_hash("vocab:de:baum"));
        assert!(!names.contains(&baum), "{names:?}");

        target.import_transfer(&archive).unwrap();
        let after = record_files::load_records(target_dir.path()).unwrap();
        assert!(after["vocab:de:baum"].deleted_at.is_none());

        // A package from 1.1.1 still has the tombstone: it deletes nothing.
        let old = source_dir.path().join("old.zip");
        let mut zip = ZipWriter::new(std::fs::File::create(&old).unwrap());
        let options = SimpleFileOptions::default();
        write_yaml(
            &mut zip,
            "manifest.yaml",
            &json!({"format": FORMAT, "schemaVersion": SCHEMA_VERSION, "appVersion": "1.1.1", "exportedAt": "1", "scope": "vocabulary"}),
            options,
        )
        .unwrap();
        write_yaml(
            &mut zip,
            &baum,
            &record_files::record_value(&phone["vocab:de:baum"]),
            options,
        )
        .unwrap();
        zip.finish().unwrap();
        target.import_transfer(&old).unwrap();
        let after = record_files::load_records(target_dir.path()).unwrap();
        assert!(after["vocab:de:baum"].deleted_at.is_none());
    }

    #[test]
    fn a_fresh_device_takes_the_package_settings_and_bookmarks_merge() {
        let source_dir = tempfile::tempdir().unwrap();
        let fresh_dir = tempfile::tempdir().unwrap();
        let used_dir = tempfile::tempdir().unwrap();
        let source = store(source_dir.path(), "pc");
        let package = record_files::payload_to_records(
            &json!({
                "vocab": {"de": {
                    "vocab": {"Haus": {"word": "Haus"}},
                    "archivedBookIds": ["a", "gb-1"],
                    "hiddenBuiltInBooks": ["gb-2"],
                }},
                "texts": [{"id": "a", "title": "A", "text": "Text"}],
                "prefs": {"theme": "dark", "readerBookmarks": {
                    "a": [{"id": "1", "page": 3}],
                    "gb-1": [{"id": "4", "page": 1}],
                }},
            }),
            "pc",
            100,
        );
        record_files::write_records(source_dir.path(), &package).unwrap();
        let archive = source_dir.path().join("all.zip");
        source
            .export_transfer(&archive, ExportScope::All, None, None)
            .unwrap();

        // The new phone saved its defaults after the export, and read a
        // built-in book before any word was saved.
        let fresh = store(fresh_dir.path(), "phone");
        let defaults = record_files::payload_to_records(
            &json!({
                "vocab": {"de": {"vocab": {}, "archivedBookIds": [], "hiddenBuiltInBooks": ["gb-3"]}},
                "prefs": {"theme": "light", "readerBookmarks": {"gb-3": [{"id": "3", "page": 2}]}},
            }),
            "phone",
            200,
        );
        record_files::write_records(fresh_dir.path(), &defaults).unwrap();
        fresh.import_transfer(&archive).unwrap();
        let after = record_files::load_records(fresh_dir.path()).unwrap();
        assert_eq!(after["pref:theme"].data, "dark");
        assert_eq!(
            after["pref:readerBookmarks"].data,
            json!({
                "a": [{"id": "1", "page": 3}],
                "gb-1": [{"id": "4", "page": 1}],
                "gb-3": [{"id": "3", "page": 2}],
            })
        );
        assert_eq!(
            after["profile:de"].data["archivedBookIds"],
            json!(["a", "gb-1"])
        );
        assert_eq!(
            after["profile:de"].data["hiddenBuiltInBooks"],
            json!(["gb-2", "gb-3"])
        );

        // A device in use keeps its newer settings and lists, and gains the
        // package's bookmarks and archive entries only for the book the
        // package brings. Its own removals (gb-1 unarchived, its bookmark
        // deleted, gb-2 shown again) stay.
        let used = store(used_dir.path(), "tablet");
        let own = record_files::payload_to_records(
            &json!({
                "vocab": {"de": {"vocab": {"Baum": {"word": "Baum"}}, "archivedBookIds": ["b"], "hiddenBuiltInBooks": []}},
                "prefs": {"theme": "sepia", "readerBookmarks": {"b": [{"id": "2", "page": 9}]}},
            }),
            "tablet",
            300,
        );
        record_files::write_records(used_dir.path(), &own).unwrap();
        used.import_transfer(&archive).unwrap();
        let after = record_files::load_records(used_dir.path()).unwrap();
        assert_eq!(after["pref:theme"].data, "sepia");
        assert_eq!(
            after["pref:readerBookmarks"].data,
            json!({"a": [{"id": "1", "page": 3}], "b": [{"id": "2", "page": 9}]})
        );
        assert_eq!(
            after["profile:de"].data["archivedBookIds"],
            json!(["b", "a"])
        );
        assert_eq!(after["profile:de"].data["hiddenBuiltInBooks"], json!([]));

        // Importing the same package again brings no book, so nothing of
        // its lists comes back after the tablet removes it.
        let mut edited = record_files::load_records(used_dir.path()).unwrap();
        let bookmarks = edited.get_mut("pref:readerBookmarks").unwrap();
        bookmarks.data = json!({"b": [{"id": "2", "page": 9}]});
        bookmarks.updated_at = 400;
        record_files::write_records(used_dir.path(), &edited).unwrap();
        used.import_transfer(&archive).unwrap();
        let after = record_files::load_records(used_dir.path()).unwrap();
        assert_eq!(
            after["pref:readerBookmarks"].data,
            json!({"b": [{"id": "2", "page": 9}]})
        );
    }

    #[test]
    fn a_newer_package_keeps_this_devices_lists_for_books_it_does_not_have() {
        let source_dir = tempfile::tempdir().unwrap();
        let target_dir = tempfile::tempdir().unwrap();
        let tablet = store(target_dir.path(), "tablet");
        let own = record_files::payload_to_records(
            &json!({
                "vocab": {"de": {"vocab": {"Baum": {"word": "Baum"}}, "archivedBookIds": ["b", "c"]}},
                "texts": [
                    {"id": "b", "title": "B", "text": "Text"},
                    {"id": "c", "title": "C", "text": "Text"},
                ],
                "prefs": {"readerBookmarks": {
                    "b": [{"id": "1", "page": 2}],
                    "c": [{"id": "2", "page": 4}],
                    "gb-9": [{"id": "5", "page": 7}],
                }},
            }),
            "tablet",
            100,
        );
        record_files::write_records(target_dir.path(), &own).unwrap();

        // The PC has book c too, and removed its bookmark and archive entry
        // later than the tablet last changed its lists; built-in book gb-9
        // is on both devices, so the PC's newer list decides for it too.
        let source = store(source_dir.path(), "pc");
        let package = record_files::payload_to_records(
            &json!({
                "vocab": {"de": {"vocab": {"Haus": {"word": "Haus"}}, "archivedBookIds": ["a"]}},
                "texts": [
                    {"id": "a", "title": "A", "text": "Text"},
                    {"id": "c", "title": "C", "text": "Text"},
                ],
                "prefs": {"readerBookmarks": {"a": [{"id": "3", "page": 1}]}},
            }),
            "pc",
            300,
        );
        record_files::write_records(source_dir.path(), &package).unwrap();
        let archive = source_dir.path().join("all.zip");
        source
            .export_transfer(&archive, ExportScope::All, None, None)
            .unwrap();

        tablet.import_transfer(&archive).unwrap();
        let after = record_files::load_records(target_dir.path()).unwrap();
        assert_eq!(
            after["pref:readerBookmarks"].data,
            json!({"a": [{"id": "3", "page": 1}], "b": [{"id": "1", "page": 2}]})
        );
        assert_eq!(
            after["profile:de"].data["archivedBookIds"],
            json!(["a", "b"])
        );
    }

    #[test]
    fn export_progress_keeps_moving_through_every_books_images() {
        let progress = ExportProgress::new();
        progress.set_totals(0, 0, 2, 0);
        progress.set_total_assets(5);
        progress.set_phase("images");
        let mut seen = Vec::new();
        for _ in 0..5 {
            progress.add_asset();
            let snapshot = progress.snapshot();
            seen.push((snapshot["percent"].clone(), snapshot["steps"].clone()));
        }
        assert_eq!(
            seen,
            [(55, 1), (65, 2), (75, 3), (85, 4), (95, 5)]
                .map(|(percent, steps)| (json!(percent), json!(steps)))
        );
    }

    #[test]
    fn restoring_a_clear_backup_on_an_emptied_device_keeps_later_settings() {
        let dir = tempfile::tempdir().unwrap();
        let target = store(dir.path(), "phone");
        let before = record_files::payload_to_records(
            &json!({
                "vocab": {"de": {"vocab": {"Haus": {"word": "Haus"}}}},
                "prefs": {"theme": "dark", "readerBookmarks": {"gb-1": [{"id": "1", "page": 3}]}},
            }),
            "phone",
            100,
        );
        record_files::write_records(dir.path(), &before).unwrap();
        let backup = dir.path().join("backup.zip");
        target
            .export_transfer(
                &backup,
                ExportScope::All,
                Some(
                    &ClearBackup::parse(
                        &json!({"purpose": BACKUP_BEFORE_CLEAR, "clear": "words", "clearLanguage": "de"}),
                    )
                    .unwrap(),
                ),
                None,
            )
            .unwrap();
        // "Clear words" empties the device; later the user changes the
        // theme and moves a bookmark without saving any word.
        let mut records = record_files::load_records(dir.path()).unwrap();
        let now = record_files::now_millis();
        let word = records.get_mut("vocab:de:haus").unwrap();
        word.deleted_at = Some(now);
        word.updated_at = now;
        let theme = records.get_mut("pref:theme").unwrap();
        theme.data = json!("light");
        theme.updated_at = now;
        let bookmarks = records.get_mut("pref:readerBookmarks").unwrap();
        bookmarks.data = json!({"gb-1": [{"id": "1", "page": 8}]});
        bookmarks.updated_at = now;
        record_files::write_records(dir.path(), &records).unwrap();

        target.import_transfer(&backup).unwrap();
        let after = record_files::load_records(dir.path()).unwrap();
        assert!(after["vocab:de:haus"].deleted_at.is_none());
        assert_eq!(after["pref:theme"].data, "light");
        assert_eq!(
            after["pref:readerBookmarks"].data,
            json!({"gb-1": [{"id": "1", "page": 8}]})
        );
    }

    #[test]
    fn a_pdf_book_without_its_page_images_does_not_stop_the_import() {
        let dir = tempfile::tempdir().unwrap();
        let target = store(dir.path(), "phone");
        let records = record_files::payload_to_records(
            &json!({
                "vocab": {"de": {"vocab": {"Haus": {"word": "Haus"}}}},
                "texts": [{"id": "book-1", "title": "PDF", "pdfOcrPages": [{"imageName": "gone.png"}]}],
            }),
            "pc",
            200,
        );
        let archive = dir.path().join("partial.zip");
        let mut zip = ZipWriter::new(std::fs::File::create(&archive).unwrap());
        let options = SimpleFileOptions::default();
        write_yaml(
            &mut zip,
            "manifest.yaml",
            &json!({"format": FORMAT, "schemaVersion": SCHEMA_VERSION, "appVersion": "1.1.1", "exportedAt": "1", "scope": "all"}),
            options,
        )
        .unwrap();
        for record in records.values() {
            let name = match record_book_id(record) {
                Some(book_id) => format!("books/{book_id}/book.yaml"),
                None => format!("words/{}.yaml", record_files::stable_hash(&record.key)),
            };
            let value = if name.ends_with("book.yaml") {
                json!({"records": [record_files::record_value(record)]})
            } else {
                record_files::record_value(record)
            };
            write_yaml(&mut zip, &name, &value, options).unwrap();
        }
        zip.finish().unwrap();

        let summary = target.import_transfer(&archive).unwrap();
        let after = record_files::load_records(dir.path()).unwrap();
        assert!(after["vocab:de:haus"].deleted_at.is_none(), "{summary}");
        assert!(!after.contains_key("text:book-1"));
        assert_eq!(summary["incompleteBooks"], 1);
    }

    #[test]
    fn packages_leave_api_keys_on_the_device() {
        let source_dir = tempfile::tempdir().unwrap();
        let target_dir = tempfile::tempdir().unwrap();
        let source = store(source_dir.path(), "pc");
        let target = store(target_dir.path(), "phone");
        let source_records = record_files::payload_to_records(
            &json!({"prefs": {"deeplApiKey": "pc-deepl:fx", "aiExplanationApiKey": "sk-pc", "theme": "familiar"}}),
            "pc",
            200,
        );
        record_files::write_records(source_dir.path(), &source_records).unwrap();
        let target_records = record_files::payload_to_records(
            &json!({"prefs": {"deeplApiKey": "phone-deepl:fx"}}),
            "phone",
            100,
        );
        record_files::write_records(target_dir.path(), &target_records).unwrap();

        let archive = source_dir.path().join("transfer.zip");
        source
            .export_transfer(&archive, ExportScope::All, None, None)
            .unwrap();
        let mut entries = zip::ZipArchive::new(std::fs::File::open(&archive).unwrap()).unwrap();
        for index in 0..entries.len() {
            let mut entry = entries.by_index(index).unwrap();
            let mut contents = String::new();
            std::io::Read::read_to_string(&mut entry, &mut contents).unwrap();
            assert!(
                !contents.contains("pc-deepl") && !contents.contains("sk-pc"),
                "{}",
                entry.name()
            );
        }

        target.import_transfer(&archive).unwrap();
        let records = record_files::load_records(target_dir.path()).unwrap();
        assert_eq!(records["pref:deeplApiKey"].data, "phone-deepl:fx");
        assert!(!records.contains_key("pref:aiExplanationApiKey"));
        assert_eq!(records["pref:theme"].data, "familiar");
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

        let huge = vec![json!({ "key": "text:book-1", "data": "x".repeat(65 * 1024 * 1024) })];
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
        let nested = (0..20).fold(images.clone(), |path, _| path.join("d"));
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
