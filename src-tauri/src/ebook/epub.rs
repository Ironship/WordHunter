use base64::Engine;
use std::collections::HashMap;
use std::io::{Cursor, Read};

use percent_encoding::percent_decode_str;
use serde_json::{Value, json};
use zip::ZipArchive;

use super::text::{clean_imported_ebook_text, decode_epub_text, strip_xhtml_to_text};

#[derive(Clone, Debug)]
struct EpubItem {
    id: String,
    href: String,
    media_type: String,
    properties: String,
}

pub(crate) fn parse_epub(data: &[u8], fallback_title: &str) -> Result<Value, String> {
    let mut archive = ZipArchive::new(Cursor::new(data)).map_err(|e| e.to_string())?;
    const MAX_ENTRIES: usize = 500;
    const MAX_TOTAL_SIZE: u64 = 50_000_000;
    const MAX_FILE_SIZE: u64 = 10_000_000;

    if archive.len() > MAX_ENTRIES {
        return Err(format!(
            "EPUB contains too many entries (max {MAX_ENTRIES})"
        ));
    }
    let total_size = (0..archive.len()).try_fold(0u64, |acc, index| {
        let file = archive.by_index(index).map_err(|e| e.to_string())?;
        if file.size() > MAX_FILE_SIZE {
            return Err(format!("File {} exceeds max size (10 MB)", file.name()));
        }
        Ok(acc.saturating_add(file.size()))
    })?;
    if total_size > MAX_TOTAL_SIZE {
        return Err("EPUB uncompressed size too large (max 50 MB)".to_string());
    }

    let container = read_zip_text(&mut archive, "META-INF/container.xml", MAX_FILE_SIZE)?;
    let container_doc = roxmltree::Document::parse(&container).map_err(|e| e.to_string())?;
    let rootfile = container_doc
        .descendants()
        .find(|node| node.has_tag_name("rootfile"))
        .and_then(|node| node.attribute("full-path"))
        .filter(|path| !path.trim().is_empty())
        .ok_or_else(|| "EPUB does not contain a rootfile entry".to_string())?
        .to_string();
    let rootfile = epub_href("", &rootfile)
        .ok_or_else(|| "EPUB rootfile path escapes the archive root".to_string())?;

    let opf = read_zip_text(&mut archive, &rootfile, MAX_FILE_SIZE)?;
    let opf_doc = roxmltree::Document::parse(&opf).map_err(|e| e.to_string())?;
    let opf_dir = zip_parent_dir(&rootfile);
    let title = find_xml_text(&opf_doc, "title").unwrap_or_else(|| fallback_title.to_string());
    let author = find_xml_text(&opf_doc, "creator").unwrap_or_default();
    let cover_id = find_cover_id(&opf_doc);

    let mut manifest: HashMap<String, EpubItem> = HashMap::new();
    let mut spine = Vec::new();
    for node in opf_doc.descendants().filter(|node| node.is_element()) {
        if node.has_tag_name("item") {
            if let (Some(id), Some(href)) = (node.attribute("id"), node.attribute("href")) {
                manifest.insert(
                    id.to_string(),
                    EpubItem {
                        id: id.to_string(),
                        href: href.to_string(),
                        media_type: node.attribute("media-type").unwrap_or("").to_string(),
                        properties: node.attribute("properties").unwrap_or("").to_string(),
                    },
                );
            }
        } else if node.has_tag_name("itemref")
            && let Some(idref) = node.attribute("idref")
        {
            spine.push(idref.to_string());
        }
    }

    let mut text_parts = Vec::new();
    for idref in spine {
        let Some(item) = manifest.get(&idref) else {
            continue;
        };
        let href_lower = item.href.to_ascii_lowercase();
        if !item.media_type.contains("html")
            && !href_lower.ends_with(".html")
            && !href_lower.ends_with(".htm")
            && !href_lower.ends_with(".xhtml")
        {
            continue;
        }
        let Some(path) = epub_href(&opf_dir, &item.href) else {
            continue;
        };
        if let Ok(markup) = read_zip_text(&mut archive, &path, MAX_FILE_SIZE) {
            let text = strip_xhtml_to_text(&markup);
            if !text.is_empty() {
                text_parts.push(text);
            }
        }
    }

    if text_parts.is_empty() {
        text_parts = read_epub_html_fallback(&mut archive, MAX_FILE_SIZE)?;
    }

    let cover_data_url =
        cover_data_url(&mut archive, &manifest, cover_id.as_deref(), &opf_dir).unwrap_or_default();
    let text = clean_imported_ebook_text(&text_parts.join("\n\n"));
    if text.is_empty() {
        return Err("No readable text found in EPUB".to_string());
    }

    Ok(json!({
        "title": title,
        "author": author,
        "text": text,
        "coverDataUrl": cover_data_url
    }))
}

fn read_epub_html_fallback(
    archive: &mut ZipArchive<Cursor<&[u8]>>,
    max_file_size: u64,
) -> Result<Vec<String>, String> {
    let mut text_parts = Vec::new();
    if archive.len() > 500 {
        return Err("EPUB contains too many files".to_string());
    }

    for index in 0..archive.len() {
        let mut file = archive.by_index(index).map_err(|e| e.to_string())?;
        if epub_href("", file.name()).is_none() {
            continue;
        }
        let name = file.name().to_ascii_lowercase();
        if !(name.ends_with(".html") || name.ends_with(".htm") || name.ends_with(".xhtml")) {
            continue;
        }
        if file.size() > max_file_size {
            continue;
        }
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
        let markup = decode_epub_text(&bytes);
        let text = strip_xhtml_to_text(&markup);
        if !text.trim().is_empty() {
            text_parts.push(text);
        }
    }

    Ok(text_parts)
}

fn read_zip_text(
    archive: &mut ZipArchive<Cursor<&[u8]>>,
    path: &str,
    max_size: u64,
) -> Result<String, String> {
    let mut file = archive.by_name(path).map_err(|e| e.to_string())?;
    if file.size() > max_size {
        return Err(format!("{path} too large"));
    }
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    Ok(decode_epub_text(&bytes))
}

fn read_zip_bytes(
    archive: &mut ZipArchive<Cursor<&[u8]>>,
    path: &str,
    max_size: u64,
) -> Result<Vec<u8>, String> {
    let mut file = archive.by_name(path).map_err(|e| e.to_string())?;
    if file.size() > max_size {
        return Err(format!("{path} too large"));
    }
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    Ok(bytes)
}

fn find_xml_text(doc: &roxmltree::Document<'_>, local_name: &str) -> Option<String> {
    doc.descendants()
        .find(|node| node.has_tag_name(local_name) && node.text().is_some())
        .and_then(|node| node.text())
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(ToString::to_string)
}

fn find_cover_id(doc: &roxmltree::Document<'_>) -> Option<String> {
    doc.descendants()
        .find(|node| {
            node.has_tag_name("meta")
                && node
                    .attribute("name")
                    .is_some_and(|name| name.eq_ignore_ascii_case("cover"))
        })
        .and_then(|node| node.attribute("content"))
        .map(ToString::to_string)
}

fn zip_parent_dir(path: &str) -> String {
    path.rsplit_once('/')
        .map(|(parent, _)| parent.to_string())
        .unwrap_or_default()
}

pub(crate) fn epub_href(base_dir: &str, href: &str) -> Option<String> {
    let href = href.split('#').next().unwrap_or(href);
    let decoded = percent_decode_str(href).decode_utf8_lossy();
    let joined = if base_dir.is_empty() {
        decoded.to_string()
    } else {
        format!("{}/{}", base_dir.trim_end_matches('/'), decoded)
    };
    let normalized = joined.replace('\\', "/");
    if normalized.starts_with('/') {
        return None;
    }
    let mut parts: Vec<String> = Vec::new();
    for part in normalized.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            item => parts.push(item.to_string()),
        }
    }
    (!parts.is_empty()).then(|| parts.join("/"))
}

fn cover_data_url(
    archive: &mut ZipArchive<Cursor<&[u8]>>,
    manifest: &HashMap<String, EpubItem>,
    cover_id: Option<&str>,
    opf_dir: &str,
) -> Result<String, String> {
    let cover = cover_id.and_then(|id| manifest.get(id)).or_else(|| {
        manifest.values().find(|item| {
            item.properties.contains("cover-image")
                || (item.media_type.starts_with("image/")
                    && (item.id.to_ascii_lowercase().contains("cover")
                        || item.href.to_ascii_lowercase().contains("cover")))
        })
    });
    let Some(item) = cover else {
        return Ok(String::new());
    };
    let cover_path = epub_href(opf_dir, &item.href)
        .ok_or_else(|| "EPUB cover path escapes the archive root".to_string())?;
    let bytes = read_zip_bytes(archive, &cover_path, 1_500_000)?;
    let content_type = if item.media_type.starts_with("image/") {
        item.media_type.clone()
    } else {
        mime_guess::from_path(&cover_path)
            .first_or_octet_stream()
            .to_string()
    };
    Ok(format!(
        "data:{content_type};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}
