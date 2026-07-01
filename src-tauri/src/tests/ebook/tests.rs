use super::{epub_href, strip_xhtml_to_text};

#[test]
fn normalizes_epub_hrefs() {
    assert_eq!(
        epub_href("OPS", "chapters/../chapter1.xhtml#x"),
        "OPS/chapter1.xhtml"
    );
}

#[test]
fn strips_basic_xhtml() {
    assert_eq!(strip_xhtml_to_text("<p>Hello<br>world</p>"), "Hello world");
}
