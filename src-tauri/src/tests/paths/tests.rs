use super::sanitize_id;

#[test]
fn sanitizes_ids_to_file_names() {
    assert_eq!(sanitize_id("book-1").unwrap(), "book-1");
    assert_eq!(sanitize_id("../book-1").unwrap(), "book-1");
    assert!(sanitize_id("..").is_err());
}
