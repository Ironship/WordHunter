use super::*;

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
fn vtt_skips_youtube_metadata_style_separator_and_zero_width_chars() {
    let raw = concat!(
        "Kind: captions\n",
        "Language: de\n",
        "Style:\n",
        "::cue(c.colorFEFEFE) { color: rgb(254,254,254);\n",
        "}\n",
        "##\n",
        "\u{200b}\u{200b} Khashchi\u{200b}\n",
        "\u{200b}— Hallo\u{200b}\n",
    );
    assert_eq!(parse_vtt(raw), "Khashchi\n— Hallo");
}

#[test]
fn vtt_allows_short_timestamp_format() {
    let raw = "WEBVTT\n\n1\n00:01.000 --> 00:02.000\nHi\n";
    assert_eq!(parse_vtt(raw), "Hi");
}
