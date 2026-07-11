use std::io::{Cursor, Write};

use base64::Engine;
use serde_json::json;
use zip::{ZipWriter, write::SimpleFileOptions};

use super::{epub_href, import, strip_xhtml_to_text};

#[test]
fn normalizes_epub_hrefs() {
    assert_eq!(
        epub_href("OPS", "chapters/../chapter1.xhtml#x"),
        Some("OPS/chapter1.xhtml".to_string())
    );
    assert_eq!(epub_href("OPS", "../../outside.xhtml"), None);
    assert_eq!(epub_href("", "/outside.xhtml"), None);
}

#[test]
fn strips_basic_xhtml() {
    assert_eq!(strip_xhtml_to_text("<p>Hello<br>world</p>"), "Hello\nworld");
}

#[test]
fn preserves_epub_heading_and_paragraph_boundaries() {
    assert_eq!(
        strip_xhtml_to_text("<h1>Chapter One</h1><p>First paragraph.</p><p>Second paragraph.</p>"),
        "Chapter One\nFirst paragraph.\nSecond paragraph."
    );
    assert_eq!(
        strip_xhtml_to_text("\n  <p>First <em>inline</em> line</p>\r\n  <p>Second&nbsp;line</p>"),
        "First inline line\nSecond line"
    );
}

#[test]
fn imports_minimal_epub_metadata_spine_order_and_cover() {
    let epub = make_zip(&[
        ("mimetype", b"application/epub+zip"),
        ("META-INF/container.xml", CONTAINER.as_bytes()),
        ("OPS/content.opf", OPF.as_bytes()),
        (
            "OPS/first.xhtml",
            b"<html><body><p>First chapter.</p></body></html>",
        ),
        (
            "OPS/second.xhtml",
            b"<html><body><p>Second chapter.</p></body></html>",
        ),
        ("OPS/images/cover.png", &[1, 2, 3, 4]),
    ]);

    let result = import(json!({
        "filename": "fallback-name.epub",
        "data": format!(
            "data:application/epub+zip;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(epub)
        )
    }))
    .expect("minimal EPUB should import");

    assert_eq!(result["title"], "Fixture Book");
    assert_eq!(result["author"], "Fixture Author");
    assert_eq!(result["text"], "Second chapter.\n\nFirst chapter.");
    assert_eq!(result["coverDataUrl"], "data:image/png;base64,AQIDBA==");
}

#[test]
fn rejects_missing_malformed_and_rootless_container() {
    let cases = [
        (
            make_zip(&[("mimetype", b"application/epub+zip")]),
            "not found",
        ),
        (
            make_zip(&[("META-INF/container.xml", b"<container>")]),
            "never closed",
        ),
        (
            make_zip(&[(
                "META-INF/container.xml",
                b"<?xml version=\"1.0\"?><container><rootfiles/></container>",
            )]),
            "rootfile",
        ),
        (
            make_zip(&[("META-INF/container.xml", CONTAINER.as_bytes())]),
            "not found",
        ),
    ];

    for (epub, expected) in cases {
        let error = import_epub(epub).expect_err("invalid container should fail");
        assert!(
            error.to_ascii_lowercase().contains(expected),
            "expected {expected:?} in {error:?}"
        );
    }
}

#[test]
fn rejects_rootfile_paths_that_escape_the_archive() {
    let epub = make_zip(&[
        (
            "META-INF/container.xml",
            br#"<container><rootfiles><rootfile full-path="../content.opf"/></rootfiles></container>"#,
        ),
        ("../content.opf", OPF.as_bytes()),
    ]);

    let error = import_epub(epub).expect_err("traversing rootfile should fail");
    assert!(error.contains("escapes the archive root"), "{error}");
}

#[test]
fn rejects_epubs_over_the_entry_limit() {
    let names = (0..501)
        .map(|index| format!("entry-{index}.txt"))
        .collect::<Vec<_>>();
    let entries = names
        .iter()
        .map(|name| (name.as_str(), &b""[..]))
        .collect::<Vec<_>>();

    let error = import_epub(make_zip(&entries)).expect_err("entry limit should be enforced");
    assert!(error.contains("too many entries"), "{error}");
}

fn import_epub(epub: Vec<u8>) -> Result<serde_json::Value, String> {
    import(json!({
        "filename": "fixture.epub",
        "data": base64::engine::general_purpose::STANDARD.encode(epub)
    }))
}

fn make_zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
    for (name, bytes) in entries {
        writer
            .start_file(*name, SimpleFileOptions::default())
            .expect("fixture entry should start");
        writer.write_all(bytes).expect("fixture entry should write");
    }
    writer
        .finish()
        .expect("fixture ZIP should finish")
        .into_inner()
}

const CONTAINER: &str = r#"<?xml version="1.0"?>
<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">
  <rootfiles>
    <rootfile full-path="OPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>"#;

const OPF: &str = r#"<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Fixture Book</dc:title>
    <dc:creator>Fixture Author</dc:creator>
  </metadata>
  <manifest>
    <item id="first" href="first.xhtml" media-type="application/xhtml+xml"/>
    <item id="second" href="second.xhtml" media-type="application/xhtml+xml"/>
    <item id="cover" href="images/cover.png" media-type="image/png" properties="cover-image"/>
  </manifest>
  <spine>
    <itemref idref="second"/>
    <itemref idref="first"/>
  </spine>
</package>"#;
