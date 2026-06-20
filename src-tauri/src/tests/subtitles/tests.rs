use super::*;

#[test]
fn srt_strips_sequence_numbers_and_timestamps() {
    let raw = "1\n00:00:01,000 --> 00:00:02,000\nHello world\n\n2\n00:00:03,000 --> 00:00:04,500\nGoodbye world\n";
    assert_eq!(parse_srt(raw), "Hello world\nGoodbye world");
}

#[test]
fn srt_uses_dot_timestamp_format() {
    let raw = "1\n00:00:01.000 --> 00:00:02.000\nHello\n";
    assert_eq!(parse_srt(raw), "Hello");
}

#[test]
fn srt_strips_ass_overrides_html_and_brackets() {
    let raw = "1\n00:00:01,000 --> 00:00:02,000\n{\\b1}Hello <i>world</i> [music]\n";
    assert_eq!(parse_srt(raw), "Hello world");
}

#[test]
fn srt_breaks_ass_line_breaks_into_spaces() {
    let raw = "1\n00:00:01,000 --> 00:00:02,000\nLine1\\NLine2\n";
    assert_eq!(parse_srt(raw), "Line1 Line2");
}

#[test]
fn srt_collapses_consecutive_duplicate_lines() {
    let raw = "1\n00:00:01,000 --> 00:00:02,000\nHi\nHi\n";
    assert_eq!(parse_srt(raw), "Hi");
}

#[test]
fn srt_strips_bom() {
    let raw = "\u{feff}1\n00:00:01,000 --> 00:00:02,000\nHi\n";
    assert_eq!(parse_srt(raw), "Hi");
}

#[test]
fn vtt_strips_header_and_note_blocks() {
    let raw = "WEBVTT\n\nNOTE this is a note\nspanning multiple\n\n1\n00:00:01.000 --> 00:00:02.000\nHello\n";
    assert_eq!(parse_vtt(raw), "Hello");
}

#[test]
fn vtt_skips_style_and_region_blocks() {
    let raw = "WEBVTT\n\nSTYLE\n::cue { color: red }\n\n1\n00:00:01.000 --> 00:00:02.000\nHi\n";
    assert_eq!(parse_vtt(raw), "Hi");
}

#[test]
fn vtt_allows_short_timestamp_format() {
    let raw = "WEBVTT\n\n1\n00:01.000 --> 00:02.000\nHi\n";
    assert_eq!(parse_vtt(raw), "Hi");
}

#[test]
fn ass_extracts_text_column() {
    let raw = "[Script Info]\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Hello {\\b1}world{\\b0}\nDialogue: 0,0:00:03.00,0:00:04.00,Default,,0,0,0,,Second line\n\n[Fonts]\n";
    assert_eq!(parse_ass(raw), "Hello world\nSecond line");
}

#[test]
fn ass_respects_custom_text_column_index() {
    let raw = "[Events]\nFormat: Marked, Start, End, Text\nDialogue: 0,0:00:01.00,0:00:02.00,First text\nDialogue: 0,0:00:03.00,0:00:04.00,Second text\n";
    assert_eq!(parse_ass(raw), "First text\nSecond text");
}

#[test]
fn ass_handles_commas_in_text() {
    let raw = "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Hello, world!\n";
    assert_eq!(parse_ass(raw), "Hello, world!");
}

#[test]
fn parse_dispatches_by_extension() {
    let srt = "1\n00:00:01,000 --> 00:00:02,000\nHi\n";
    let vtt = "WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\nHi\n";
    let ass = "[Events]\nFormat: Marked, Start, End, Text\nDialogue: 0,0:00:01.00,0:00:02.00,Hi\n";
    assert_eq!(parse_imported_text_file("x.SRT", srt), "Hi");
    assert_eq!(parse_imported_text_file("x.vtt", vtt), "Hi");
    assert_eq!(parse_imported_text_file("x.ass", ass), "Hi");
    assert_eq!(parse_imported_text_file("x.ssa", ass), "Hi");
}

#[test]
fn parse_unknown_extension_passes_through() {
    assert_eq!(parse_imported_text_file("x.txt", "  hello  "), "hello");
    assert_eq!(parse_imported_text_file("x", "raw"), "raw");
}

#[test]
fn title_strips_known_extensions() {
    assert_eq!(title_from_imported_file_name("Movie.SRT"), "Movie");
    assert_eq!(title_from_imported_file_name("foo.bar.vtt"), "foo.bar");
    assert_eq!(title_from_imported_file_name("Epub.EPUB"), "Epub");
    assert_eq!(title_from_imported_file_name("noext"), "noext");
}

#[test]
fn handle_dispatches_parse() {
    let result = handle(json!({
        "op": "parse",
        "name": "x.srt",
        "text": "1\n00:00:01,000 --> 00:00:02,000\nHi\n"
    }))
    .unwrap();
    assert_eq!(result["text"], "Hi");
}

#[test]
fn handle_dispatches_title() {
    let result = handle(json!({ "op": "title", "name": "epic.SSA" })).unwrap();
    assert_eq!(result["title"], "epic");
}

#[test]
fn handle_rejects_unknown_op() {
    assert!(handle(json!({ "op": "nope" })).is_err());
}
