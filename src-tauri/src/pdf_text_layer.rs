use pdf_extract::{MediaBox, OutputDev, OutputError, PlainTextOutput, Transform};
use serde::Serialize;

const TEXT_LAYER_BOUNDS_VERSION: &str = "text-glyph-v2";

pub(crate) fn extract_overlay_pages(
    data: &[u8],
    max_pages: usize,
    max_chars: Option<usize>,
) -> Result<(Vec<OverlayPage>, usize, bool), String> {
    let mut document = pdf_extract::Document::load_mem(data).map_err(|error| error.to_string())?;
    if document.is_encrypted() {
        document.decrypt("").map_err(|error| error.to_string())?;
    }
    expand_cid_width_ranges(&mut document);
    let page_numbers = document.get_pages().keys().copied().collect::<Vec<_>>();
    let page_count = page_numbers.len();
    let limit = if max_pages == 0 {
        page_count
    } else {
        max_pages.min(page_count)
    };
    let selected_pages = page_numbers.iter().copied().take(limit).collect::<Vec<_>>();
    let plain_text_by_page = extract_plain_text_pages(&document, &selected_pages)?;
    let mut output = PositionedTextOutput::new(plain_text_by_page, max_chars);
    for page_num in selected_pages {
        pdf_extract::output_doc_page(&document, &mut output, page_num)
            .map_err(|error| format!("Could not read PDF page {page_num}: {error}"))?;
    }
    Ok((output.pages, page_count, limit < page_count))
}

/// Whether a PDF's text layer is enough to import it without OCR: it has
/// text, and at least half of its pages have some. Covers, blank versos and
/// full-page illustrations have no text layer in ordinary text PDFs, so a
/// single empty page must not make the whole book count as a scan.
pub(crate) fn text_layer_is_usable(pages: &[OverlayPage]) -> bool {
    let has_text =
        |page: &OverlayPage| page.text.chars().filter(|ch| ch.is_alphanumeric()).count() >= 3;
    let text_pages = pages.iter().filter(|page| has_text(page)).count();
    text_pages > 0 && text_pages * 2 >= pages.len()
}

/// pdf-extract 0.12 misreads the range form of a CID font's /W array
/// (`first last width`): it takes all three values from `first`, so every glyph
/// in such a range falls back to the default width /DW. Browsers' "Save as
/// PDF" writes ranges and positions each glyph itself, so the too-narrow
/// glyphs leave gaps that read as spaces: "Kapitel" came out as "Kap itel".
/// Rewrite ranges into the list form (`first [width ...]`), which pdf-extract
/// reads correctly.
fn expand_cid_width_ranges(document: &mut pdf_extract::Document) {
    use pdf_extract::{Object, ObjectId};

    // Where a font's /W array lives: in the font itself, or in an object
    // that several fonts may share (expanded once).
    #[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
    enum Widths {
        InFont(ObjectId),
        Shared(ObjectId),
    }
    let mut targets = document
        .objects
        .iter()
        .filter_map(|(id, object)| {
            let font = object.as_dict().ok()?;
            let subtype = font.get(b"Subtype").ok()?.as_name().ok()?;
            if !matches!(subtype, b"CIDFontType0" | b"CIDFontType2") {
                return None;
            }
            Some(match font.get(b"W").ok()? {
                Object::Reference(target) => Widths::Shared(*target),
                _ => Widths::InFont(*id),
            })
        })
        .collect::<Vec<_>>();
    targets.sort();
    targets.dedup();

    // A few embedded fonts need far fewer widths than this; the budget for
    // the whole file keeps a crafted PDF with thousands of fonts from
    // exhausting memory.
    let mut budget = 4 * 0x1_0000;
    for target in targets {
        let widths = match target {
            Widths::InFont(id) => document
                .objects
                .get(&id)
                .and_then(|font| font.as_dict().ok())
                .and_then(|font| font.get(b"W").ok())
                .and_then(|widths| widths.as_array().ok()),
            Widths::Shared(id) => document
                .objects
                .get(&id)
                .and_then(|widths| widths.as_array().ok()),
        };
        let Some(expanded) = widths.and_then(|widths| expand_width_ranges(widths, &mut budget))
        else {
            continue;
        };
        match target {
            Widths::InFont(id) => {
                if let Some(Object::Dictionary(font)) = document.objects.get_mut(&id) {
                    font.set("W", Object::Array(expanded));
                }
            }
            Widths::Shared(id) => {
                document.objects.insert(id, Object::Array(expanded));
            }
        }
    }
}

/// The list form of a /W array, or None when it has no ranges to expand, is
/// malformed, or needs more widths than `budget` has left (in these cases it
/// is left for pdf-extract as it was). The widths added are taken off `budget`.
fn expand_width_ranges(
    widths: &[pdf_extract::Object],
    budget: &mut usize,
) -> Option<Vec<pdf_extract::Object>> {
    use pdf_extract::Object;

    let code = |object: &Object| match object {
        Object::Integer(value) => Some(*value),
        Object::Real(value) => Some(*value as i64),
        _ => None,
    };
    // CIDs are 16-bit, so a valid font never lists more widths than this.
    const MAX_WIDTHS: usize = 0x1_0000;
    let limit = MAX_WIDTHS.min(*budget);
    let mut expanded = Vec::with_capacity(widths.len());
    let mut expanded_widths = 0usize;
    let mut has_ranges = false;
    let mut index = 0;
    while index < widths.len() {
        let first = code(&widths[index])?;
        match widths.get(index + 1)? {
            list @ Object::Array(_) => {
                expanded.extend([Object::Integer(first), list.clone()]);
                index += 2;
            }
            last => {
                let span = code(last)?.checked_sub(first)?;
                let width = widths.get(index + 2)?;
                code(width)?;
                let count = usize::try_from(span).ok()?.checked_add(1)?;
                expanded_widths = expanded_widths.checked_add(count)?;
                if expanded_widths > limit {
                    return None;
                }
                expanded.extend([
                    Object::Integer(first),
                    Object::Array(vec![width.clone(); count]),
                ]);
                has_ranges = true;
                index += 3;
            }
        }
    }
    if has_ranges {
        *budget -= expanded_widths;
    }
    has_ranges.then_some(expanded)
}

fn extract_plain_text_pages(
    document: &pdf_extract::Document,
    page_numbers: &[u32],
) -> Result<Vec<String>, String> {
    let mut plain_text_by_page = Vec::with_capacity(page_numbers.len());
    for page_num in page_numbers {
        let mut text = String::new();
        {
            let mut output = PlainTextOutput::new(&mut text);
            pdf_extract::output_doc_page(document, &mut output, *page_num)
                .map_err(|error| format!("Could not read PDF page {page_num}: {error}"))?;
        }
        plain_text_by_page.push(text);
    }
    Ok(plain_text_by_page)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OverlayPage {
    pub(crate) page: u32,
    pub(crate) image_name: String,
    width: f32,
    height: f32,
    pub(crate) text: String,
    bounds_version: &'static str,
    lines: Vec<OverlayLine>,
    words: Vec<OverlayWord>,
}

#[derive(Clone, Debug, Serialize)]
struct OverlayWord {
    text: String,
    x: f32,
    y: f32,
    width: f32,
    height: f32,
    confidence: f32,
}

#[derive(Debug, Serialize)]
struct OverlayLine {
    text: String,
    x: f32,
    y: f32,
    width: f32,
    height: f32,
    confidence: f32,
}

#[derive(Default)]
struct PositionedTextOutput {
    pages: Vec<OverlayPage>,
    current: Option<WorkingPage>,
    plain_text_by_page: Vec<String>,
    max_chars: Option<usize>,
    total_chars: usize,
}

impl PositionedTextOutput {
    fn new(plain_text_by_page: Vec<String>, max_chars: Option<usize>) -> Self {
        Self {
            pages: Vec::new(),
            current: None,
            plain_text_by_page,
            max_chars,
            total_chars: 0,
        }
    }

    fn plain_text_for_page(&self, page_num: u32) -> &str {
        page_num
            .checked_sub(1)
            .and_then(|index| self.plain_text_by_page.get(index as usize))
            .map(String::as_str)
            .unwrap_or("")
    }
}

struct WorkingPage {
    page_num: u32,
    width: f32,
    height: f32,
    chars: Vec<CharBox>,
    flip_ctm: Transform,
}

#[derive(Clone)]
struct CharBox {
    text: String,
    bounds: Bounds,
}

#[derive(Clone, Copy, Debug)]
struct Bounds {
    left: f32,
    top: f32,
    right: f32,
    bottom: f32,
}

impl Bounds {
    fn union(self, other: Self) -> Self {
        Self {
            left: self.left.min(other.left),
            top: self.top.min(other.top),
            right: self.right.max(other.right),
            bottom: self.bottom.max(other.bottom),
        }
    }

    fn width(self) -> f32 {
        (self.right - self.left).max(1.0)
    }

    fn height(self) -> f32 {
        (self.bottom - self.top).max(1.0)
    }
}

impl OutputDev for PositionedTextOutput {
    fn begin_page(
        &mut self,
        page_num: u32,
        media_box: &MediaBox,
        _art_box: Option<(f64, f64, f64, f64)>,
    ) -> Result<(), OutputError> {
        let width = (media_box.urx - media_box.llx).max(1.0) as f32;
        let height = (media_box.ury - media_box.lly).max(1.0) as f32;
        self.current = Some(WorkingPage {
            page_num,
            width,
            height,
            chars: Vec::new(),
            flip_ctm: Transform::row_major(1.0, 0.0, 0.0, -1.0, 0.0, height as f64),
        });
        Ok(())
    }

    fn end_page(&mut self) -> Result<(), OutputError> {
        let Some(page) = self.current.take() else {
            return Ok(());
        };
        let plain_text = self.plain_text_for_page(page.page_num);
        let words = split_words_using_plain_text(
            merge_words_using_plain_text(
                words_from_chars(&page.chars, page.width, page.height),
                plain_text,
            ),
            plain_text,
        );
        let lines = lines_from_words(&words);
        let text = clean_plain_page_text(plain_text).unwrap_or_else(|| {
            lines
                .iter()
                .map(|line| line.text.as_str())
                .collect::<Vec<_>>()
                .join("\n")
        });
        self.pages.push(OverlayPage {
            page: page.page_num,
            image_name: format!("pdf-page-{:04}.png", page.page_num),
            width: page.width,
            height: page.height,
            text,
            bounds_version: TEXT_LAYER_BOUNDS_VERSION,
            lines,
            words,
        });
        Ok(())
    }

    fn output_character(
        &mut self,
        trm: &Transform,
        width: f64,
        _spacing: f64,
        font_size: f64,
        text: &str,
    ) -> Result<(), OutputError> {
        if self.current.is_none() {
            return Ok(());
        }
        let char_count = text.chars().count();
        if self
            .max_chars
            .is_some_and(|max_chars| self.total_chars.saturating_add(char_count) > max_chars)
        {
            return Err(OutputError::IoError(std::io::Error::other(
                "PDF text layer is too large",
            )));
        }
        self.total_chars += char_count;
        let page = self.current.as_mut().unwrap();
        let position = trm.post_transform(&page.flip_ctm);
        let font_height = transformed_font_size(trm, font_size).max(1.0) as f32;
        let glyph_width = (width * font_height as f64).max(0.5) as f32;
        let x = position.m31 as f32;
        let baseline_y = position.m32 as f32;
        let y_top = baseline_y - font_height * 0.82;
        let y_bottom = baseline_y + font_height * 0.22;
        let bounds = Bounds {
            left: x.clamp(0.0, page.width),
            top: y_top.clamp(0.0, page.height),
            right: (x + glyph_width).clamp(0.0, page.width),
            bottom: y_bottom.clamp(0.0, page.height),
        };
        if bounds.right > bounds.left && bounds.bottom > bounds.top {
            page.chars.push(CharBox {
                text: text.to_string(),
                bounds,
            });
        }
        Ok(())
    }

    fn begin_word(&mut self) -> Result<(), OutputError> {
        Ok(())
    }

    fn end_word(&mut self) -> Result<(), OutputError> {
        Ok(())
    }

    fn end_line(&mut self) -> Result<(), OutputError> {
        Ok(())
    }
}

fn transformed_font_size(transform: &Transform, font_size: f64) -> f64 {
    let sx = (transform.m11.powi(2) + transform.m12.powi(2)).sqrt();
    let sy = (transform.m21.powi(2) + transform.m22.powi(2)).sqrt();
    (font_size * ((sx + sy) / 2.0)).abs()
}

fn words_from_chars(chars: &[CharBox], page_width: f32, page_height: f32) -> Vec<OverlayWord> {
    let mut words = Vec::new();
    let mut current = String::new();
    let mut current_bounds: Option<Bounds> = None;
    let mut last_bounds: Option<Bounds> = None;
    let mut pending_space = false;

    for item in chars {
        if item.text.chars().all(char::is_whitespace) {
            if !current.is_empty() {
                pending_space = true;
            }
            continue;
        }

        if let Some(previous) = last_bounds {
            let should_break = if pending_space {
                text_space_is_word_break(&current, previous, &item.text, item.bounds)
            } else {
                text_gap_is_word_break(&current, previous, item.bounds)
            };
            if should_break {
                push_overlay_word(
                    &mut words,
                    &mut current,
                    &mut current_bounds,
                    page_width,
                    page_height,
                );
            }
        }
        pending_space = false;

        current.push_str(&item.text);
        current_bounds = Some(match current_bounds {
            Some(bounds) => bounds.union(item.bounds),
            None => item.bounds,
        });
        last_bounds = Some(item.bounds);
    }

    push_overlay_word(
        &mut words,
        &mut current,
        &mut current_bounds,
        page_width,
        page_height,
    );
    words
}

fn merge_words_using_plain_text(words: Vec<OverlayWord>, plain_text: &str) -> Vec<OverlayWord> {
    let lookup_text = normalize_pdf_text_for_lookup(plain_text);
    if lookup_text.is_empty() || words.len() < 2 {
        return words;
    }

    let mut merged: Vec<OverlayWord> = Vec::with_capacity(words.len());
    for word in words {
        if let Some(previous) = merged.last_mut() {
            let previous_bounds = word_bounds(previous);
            let word_bounds = word_bounds(&word);
            if word_bounds_same_line(previous_bounds, word_bounds)
                && should_merge_words_from_plain_text(
                    &previous.text,
                    &word.text,
                    previous_bounds,
                    word_bounds,
                    &lookup_text,
                )
            {
                merge_overlay_words(previous, &word);
                continue;
            }
        }
        merged.push(word);
    }
    merged
}

fn split_words_using_plain_text(words: Vec<OverlayWord>, plain_text: &str) -> Vec<OverlayWord> {
    let plain_tokens = plain_tokens_for_alignment(plain_text);
    if plain_tokens.is_empty() || words.is_empty() {
        return words;
    }

    let mut cursor = 0usize;
    let mut split = Vec::with_capacity(words.len());
    for word in words {
        if let Some((start, parts)) = match_word_to_plain_tokens(&word.text, &plain_tokens, cursor)
        {
            cursor = start + parts.len();
            split.extend(split_overlay_word_by_plain_parts(word, &parts));
        } else {
            split.push(word);
        }
    }
    split
}

#[derive(Clone, Debug)]
struct PlainToken {
    text: String,
    key: String,
}

const PLAIN_TOKEN_SCAN_WINDOW: usize = 64;
const PLAIN_TOKEN_JOIN_LIMIT: usize = 128;

fn plain_tokens_for_alignment(plain_text: &str) -> Vec<PlainToken> {
    plain_text
        .split_whitespace()
        .filter_map(|text| {
            let key = alignment_key(text);
            (!key.is_empty()).then(|| PlainToken {
                text: text.to_string(),
                key,
            })
        })
        .collect()
}

fn match_word_to_plain_tokens(
    word: &str,
    tokens: &[PlainToken],
    cursor: usize,
) -> Option<(usize, Vec<String>)> {
    let word_key = alignment_key(word);
    if word_key.is_empty() {
        return None;
    }
    let end = tokens
        .len()
        .min(cursor.saturating_add(PLAIN_TOKEN_SCAN_WINDOW));
    for start in cursor..end {
        if let Some(parts) = match_word_at_plain_token(&word_key, tokens, start) {
            return Some((start, parts));
        }
    }
    None
}

fn match_word_at_plain_token(
    word_key: &str,
    tokens: &[PlainToken],
    start: usize,
) -> Option<Vec<String>> {
    let mut joined = String::new();
    let mut parts = Vec::new();
    let end = tokens
        .len()
        .min(start.saturating_add(PLAIN_TOKEN_JOIN_LIMIT));
    for token in &tokens[start..end] {
        joined.push_str(&token.key);
        parts.push(token.text.clone());
        if joined == word_key {
            return Some(parts);
        }
        if !word_key.starts_with(&joined) {
            return None;
        }
    }
    None
}

fn split_overlay_word_by_plain_parts(word: OverlayWord, parts: &[String]) -> Vec<OverlayWord> {
    if parts.len() <= 1 {
        return vec![word];
    }
    let weights = parts
        .iter()
        .map(|part| alignment_key(part).chars().count().max(1) as f32)
        .collect::<Vec<_>>();
    let total_weight: f32 = weights.iter().sum();
    if total_weight <= 0.0 {
        return vec![word];
    }

    let mut output = Vec::with_capacity(parts.len());
    let mut x = word.x;
    let right = word.x + word.width;
    for (index, part) in parts.iter().enumerate() {
        let width = if index + 1 == parts.len() {
            (right - x).max(1.0)
        } else {
            (word.width * (weights[index] / total_weight)).max(1.0)
        };
        output.push(OverlayWord {
            text: part.clone(),
            x,
            y: word.y,
            width,
            height: word.height,
            confidence: word.confidence,
        });
        x += width;
    }
    output
}

fn alignment_key(text: &str) -> String {
    text.chars()
        .filter(|ch| !matches!(ch, '\u{00ad}' | '\u{200b}') && ch.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn should_merge_words_from_plain_text(
    left: &str,
    right: &str,
    previous: Bounds,
    next: Bounds,
    lookup_text: &str,
) -> bool {
    let left = left.trim();
    let right = right.trim();
    if left.is_empty() || right.is_empty() || !word_text_can_merge(left, right) {
        return false;
    }
    if !plain_text_word_fragment_can_merge(left, right, pdf_fragment_gap(previous, next)) {
        return false;
    }

    let joined = format!("{left}{right}");
    let spaced = format!("{left} {right}");
    // A single UPPERCASE initial followed by a lowercase fragment is the
    // classic justified-text line-break artifact ("W" + "eltmeisterschafts
    // status"): the plain text keeps the space, but the pair is one word.
    // Real two-word pairs ("a lot") start lowercase and stay split.
    let capital_initial_fragment = left.chars().count() == 1
        && left.chars().next().is_some_and(char::is_uppercase)
        && starts_with_lowercase(right);
    if capital_initial_fragment && lookup_text.contains(&spaced) {
        return true;
    }
    lookup_text.contains(&joined) && !lookup_text.contains(&spaced)
}

fn plain_text_word_fragment_can_merge(left: &str, right: &str, fragment_gap: bool) -> bool {
    if text_ends_with_joining_hyphen(left) {
        return true;
    }
    if !fragment_gap {
        return false;
    }

    let left_len = alphanumeric_len(left);
    let right_len = alphanumeric_len(right);
    let short_left_fragment = left_len <= 2 && right_len >= 3 && starts_with_lowercase(right);
    let short_right_fragment = right_len <= 2 && left_len >= 3 && ends_with_lowercase(left);
    short_left_fragment || short_right_fragment
}

fn pdf_fragment_gap(previous: Bounds, next: Bounds) -> bool {
    horizontal_gap(previous, next) <= previous.height().min(next.height()).clamp(1.0, 48.0) * 0.35
}

fn text_ends_with_joining_hyphen(text: &str) -> bool {
    text.chars()
        .last()
        .is_some_and(|ch| matches!(ch, '-' | '\u{2010}' | '\u{2011}'))
}

fn alphanumeric_len(text: &str) -> usize {
    text.chars().filter(|ch| ch.is_alphanumeric()).count()
}

fn starts_with_lowercase(text: &str) -> bool {
    text.chars().next().is_some_and(char::is_lowercase)
}

fn ends_with_lowercase(text: &str) -> bool {
    text.chars().last().is_some_and(char::is_lowercase)
}

fn merge_overlay_words(left: &mut OverlayWord, right: &OverlayWord) {
    let bounds = word_bounds(left).union(word_bounds(right));
    left.text.push_str(&right.text);
    left.x = bounds.left;
    left.y = bounds.top;
    left.width = bounds.width();
    left.height = bounds.height();
    left.confidence = left.confidence.min(right.confidence);
}

fn normalize_pdf_text_for_lookup(text: &str) -> String {
    let cleaned = text
        .chars()
        .filter(|ch| !matches!(ch, '\u{00ad}' | '\u{200b}'))
        .collect::<String>();
    cleaned.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn clean_plain_page_text(text: &str) -> Option<String> {
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    let cleaned = normalized
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    (!cleaned.is_empty()).then_some(cleaned)
}

fn word_text_can_merge(left: &str, right: &str) -> bool {
    let Some(left_char) = left.chars().last() else {
        return false;
    };
    let Some(right_char) = right.chars().next() else {
        return false;
    };
    (left_char.is_alphanumeric() || matches!(left_char, '-' | '\u{2010}' | '\u{2011}'))
        && right_char.is_alphanumeric()
}

fn push_overlay_word(
    words: &mut Vec<OverlayWord>,
    current: &mut String,
    current_bounds: &mut Option<Bounds>,
    page_width: f32,
    page_height: f32,
) {
    let text = current.trim().to_string();
    current.clear();
    let Some(bounds) = current_bounds.take() else {
        return;
    };
    if text.is_empty() {
        return;
    }
    let bounds = expand_word_bounds(bounds, page_width, page_height);
    words.push(OverlayWord {
        text,
        x: bounds.left,
        y: bounds.top,
        width: bounds.width(),
        height: bounds.height(),
        confidence: 1.0,
    });
}

fn text_space_is_word_break(
    current: &str,
    previous: Bounds,
    next_text: &str,
    next: Bounds,
) -> bool {
    if bounds_are_on_different_lines(previous, next) {
        return true;
    }
    let gap = horizontal_gap(previous, next);
    if gap <= false_space_gap(previous, next)
        && chars_can_merge_across_pdf_space(current, next_text)
    {
        return false;
    }
    true
}

fn text_gap_is_word_break(current: &str, previous: Bounds, next: Bounds) -> bool {
    if bounds_are_on_different_lines(previous, next) {
        return true;
    }
    let Some(previous_char) = current.chars().last() else {
        return false;
    };
    horizontal_gap(previous, next) > missing_space_gap(previous, next)
        && char_can_join_word(previous_char)
}

fn lines_from_words(words: &[OverlayWord]) -> Vec<OverlayLine> {
    let mut lines = Vec::new();
    let mut current_words: Vec<OverlayWord> = Vec::new();

    for word in words {
        let same_line = current_words
            .last()
            .map(|previous| word_bounds_same_line(word_bounds(previous), word_bounds(word)))
            .unwrap_or(true);
        if !same_line {
            push_overlay_line(&mut lines, &mut current_words);
        }
        current_words.push(word.clone());
    }
    push_overlay_line(&mut lines, &mut current_words);
    lines
}

fn push_overlay_line(lines: &mut Vec<OverlayLine>, current_words: &mut Vec<OverlayWord>) {
    if current_words.is_empty() {
        return;
    }
    let mut bounds = word_bounds(&current_words[0]);
    let text = current_words
        .iter()
        .map(|word| {
            bounds = bounds.union(word_bounds(word));
            word.text.as_str()
        })
        .collect::<Vec<_>>()
        .join(" ");
    lines.push(OverlayLine {
        text,
        x: bounds.left,
        y: bounds.top,
        width: bounds.width(),
        height: bounds.height(),
        confidence: 1.0,
    });
    current_words.clear();
}

fn word_bounds(word: &OverlayWord) -> Bounds {
    Bounds {
        left: word.x,
        top: word.y,
        right: word.x + word.width,
        bottom: word.y + word.height,
    }
}

fn expand_word_bounds(bounds: Bounds, page_width: f32, page_height: f32) -> Bounds {
    let side_room = (bounds.width() * 0.015).clamp(0.25, 2.0);
    Bounds {
        left: (bounds.left - side_room).max(0.0),
        top: bounds.top.max(0.0),
        right: (bounds.right + side_room).min(page_width),
        bottom: bounds.bottom.min(page_height),
    }
}

fn bounds_are_on_different_lines(previous: Bounds, next: Bounds) -> bool {
    let overlap = (previous.bottom.min(next.bottom) - previous.top.max(next.top)).max(0.0);
    let min_height = previous.height().min(next.height()).max(1.0);
    let top_delta = (next.top - previous.top).abs();
    overlap / min_height < 0.45 && top_delta > min_height * 0.55
}

fn word_bounds_same_line(previous: Bounds, next: Bounds) -> bool {
    !bounds_are_on_different_lines(previous, next)
}

fn horizontal_gap(previous: Bounds, next: Bounds) -> f32 {
    (next.left - previous.right).max(0.0)
}

fn false_space_gap(previous: Bounds, next: Bounds) -> f32 {
    previous.height().min(next.height()).clamp(1.0, 48.0) * 0.16
}

fn missing_space_gap(previous: Bounds, next: Bounds) -> f32 {
    previous.height().min(next.height()).clamp(1.0, 48.0) * 0.28
}

fn char_can_join_word(ch: char) -> bool {
    ch.is_alphanumeric() || matches!(ch, '\'' | '-')
}

fn chars_can_merge_across_pdf_space(current: &str, next_text: &str) -> bool {
    let Some(previous_char) = current.chars().last() else {
        return false;
    };
    let Some(next_char) = next_text.chars().next() else {
        return false;
    };
    previous_char.is_alphabetic() && next_char.is_alphabetic()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_layer_merges_short_false_space_after_initial_letter() {
        let words = vec![
            test_word("W", 10.0, 20.0, 8.0, 10.0),
            test_word("eltmeisterschaftsstatus", 21.0, 20.0, 61.0, 10.0),
        ];
        let merged = merge_words_using_plain_text(words, "Rennen ohne Weltmeisterschaftsstatus");

        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].text, "Weltmeisterschaftsstatus");
    }

    #[test]
    fn text_layer_merges_initial_letter_even_when_plain_text_has_the_space() {
        // Justified text layers often keep the space between the line-break
        // fragment and the rest of the word; the 1-char fragment must still
        // merge ("W" + "eltmeisterschaftsstatus").
        let words = vec![
            test_word("W", 10.0, 20.0, 8.0, 10.0),
            test_word("eltmeisterschaftsstatus", 21.0, 20.0, 61.0, 10.0),
        ];
        let merged = merge_words_using_plain_text(words, "Rennen ohne W eltmeisterschaftsstatus");

        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].text, "Weltmeisterschaftsstatus");
    }

    #[test]
    fn text_layer_keeps_real_two_word_pairs_when_plain_text_has_no_space() {
        // "a" + "lot" must NOT merge into "alot" when the plain text has no
        // joined form: the spaced form is the only evidence.
        let words = vec![
            test_word("a", 10.0, 20.0, 6.0, 10.0),
            test_word("lot", 18.0, 20.0, 16.0, 10.0),
        ];
        let merged = merge_words_using_plain_text(words, "a lot of words");

        assert_eq!(merged.len(), 2);
        assert_eq!(merged[0].text, "a");
        assert_eq!(merged[1].text, "lot");
    }

    #[test]
    fn text_layer_keeps_normal_words_when_plain_text_lacks_spaces() {
        let words = vec![
            test_word("mindestens", 10.0, 20.0, 70.0, 10.0),
            test_word("zwei", 84.0, 20.0, 24.0, 10.0),
            test_word("stunden", 112.0, 20.0, 42.0, 10.0),
        ];
        let merged = merge_words_using_plain_text(words, "mindestenszweistunden");

        assert_eq!(merged.len(), 3);
        assert_eq!(merged[0].text, "mindestens");
        assert_eq!(merged[1].text, "zwei");
        assert_eq!(merged[2].text, "stunden");
    }

    #[test]
    fn text_layer_splits_joined_words_using_plain_text() {
        let words = vec![test_word(
            "Konstrukteursweltmeisterschaftwerden",
            10.0,
            20.0,
            160.0,
            10.0,
        )];
        let split = split_words_using_plain_text(
            words,
            "Fahrer- und Konstrukteursweltmeisterschaft werden parallel ermittelt",
        );
        let texts = split
            .iter()
            .map(|word| word.text.as_str())
            .collect::<Vec<_>>();

        assert_eq!(texts, vec!["Konstrukteursweltmeisterschaft", "werden"]);
        assert!(split[0].width < 160.0);
        assert!(split[1].x > split[0].x);
    }

    #[test]
    fn text_layer_keeps_hyphenated_compound_from_plain_text() {
        let words = vec![test_word(
            "Automobil-Weltmeisterschaft",
            10.0,
            20.0,
            120.0,
            10.0,
        )];
        let split = split_words_using_plain_text(
            words,
            "Die Formel-1-Weltmeisterschaft (bis 1980 Automobil-Weltmeisterschaft) wird",
        );

        assert_eq!(split.len(), 1);
        assert_eq!(split[0].text, "Automobil-Weltmeisterschaft");
    }

    #[test]
    fn text_layer_recovers_alignment_after_wide_chart_token() {
        let words = vec![
            test_word("0123456789012345", 10.0, 20.0, 160.0, 10.0),
            test_word("DieReifengehören", 10.0, 40.0, 120.0, 10.0),
        ];
        let split = split_words_using_plain_text(
            words,
            "0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 Die Reifen gehören",
        );
        let texts = split
            .iter()
            .map(|word| word.text.as_str())
            .collect::<Vec<_>>();

        assert_eq!(&texts[texts.len() - 3..], &["Die", "Reifen", "gehören"]);
    }

    #[test]
    fn text_layer_splits_missing_space_on_normal_visual_gap() {
        let previous = Bounds {
            left: 10.0,
            top: 20.0,
            right: 80.0,
            bottom: 30.0,
        };
        let next = Bounds {
            left: 84.0,
            top: 20.0,
            right: 108.0,
            bottom: 30.0,
        };

        assert!(text_gap_is_word_break("mindestens", previous, next));
    }

    #[test]
    fn extraction_supplies_per_page_plain_text_to_the_shared_pipeline() {
        let pdf = minimal_text_pdf("W eltmeisterschaftsstatus");
        let document = pdf_extract::Document::load_mem(&pdf).unwrap();
        let plain_pages = extract_plain_text_pages(&document, &[1]).unwrap();
        let (pages, page_count, truncated) = extract_overlay_pages(&pdf, 0, None).unwrap();

        assert_eq!(plain_pages.len(), 1);
        assert_eq!(plain_pages[0].trim(), "W eltmeisterschaftsstatus");
        assert_eq!(page_count, 1);
        assert!(!truncated);
        assert_eq!(pages.len(), 1);
        assert_eq!(pages[0].text, "W eltmeisterschaftsstatus");
    }

    #[test]
    fn text_layer_with_a_few_empty_pages_is_usable() {
        let page = |text: &str| OverlayPage {
            page: 1,
            image_name: String::new(),
            width: 1.0,
            height: 1.0,
            text: text.to_string(),
            bounds_version: TEXT_LAYER_BOUNDS_VERSION,
            lines: Vec::new(),
            words: Vec::new(),
        };
        // Cover picture and a blank verso around real text pages.
        assert!(text_layer_is_usable(&[
            page(""),
            page("Kapitel eins"),
            page("  "),
            page("Kapitel zwei")
        ]));
        // Mostly scanned pages, or no text at all, still need OCR.
        assert!(!text_layer_is_usable(&[
            page(""),
            page("Kapitel eins"),
            page(""),
            page("")
        ]));
        assert!(!text_layer_is_usable(&[page(""), page("12")]));
        assert!(!text_layer_is_usable(&[]));
    }

    #[test]
    fn cid_width_ranges_become_lists_pdf_extract_can_read() {
        use pdf_extract::Object;

        let mut unlimited = usize::MAX;

        let widths = vec![
            Object::Integer(0),
            Object::Array(vec![Object::Real(777.8)]),
            Object::Integer(76),
            Object::Integer(78),
            Object::Real(277.8),
            Object::Integer(81),
            Object::Array(vec![Object::Integer(556), Object::Integer(500)]),
        ];
        let expanded = expand_width_ranges(&widths, &mut unlimited).unwrap();

        assert_eq!(
            expanded,
            vec![
                Object::Integer(0),
                Object::Array(vec![Object::Real(777.8)]),
                Object::Integer(76),
                Object::Array(vec![Object::Real(277.8); 3]),
                Object::Integer(81),
                Object::Array(vec![Object::Integer(556), Object::Integer(500)]),
            ]
        );
        // Nothing to expand, or malformed: leave the array alone.
        assert_eq!(expand_width_ranges(&widths[..2], &mut unlimited), None);
        assert_eq!(expand_width_ranges(&widths[2..4], &mut unlimited), None);
        let range = |first, last, width| vec![Object::Integer(first), Object::Integer(last), width];
        assert_eq!(
            expand_width_ranges(&range(1, 3, Object::Name(b"x".to_vec())), &mut unlimited),
            None
        );
        assert_eq!(
            expand_width_ranges(
                &range(i64::MIN, i64::MAX, Object::Integer(1)),
                &mut unlimited
            ),
            None
        );
        // Many ranges together may not exceed what 16-bit CIDs can use.
        let many = (0..3)
            .flat_map(|_| range(0, 0x7fff, Object::Integer(500)))
            .collect::<Vec<_>>();
        assert_eq!(expand_width_ranges(&many, &mut unlimited), None);
    }

    #[test]
    fn width_expansion_is_bounded_for_the_whole_document() {
        use pdf_extract::{Dictionary, Document, Object};

        let cid_font = |widths: Object| {
            let mut font = Dictionary::new();
            font.set("Type", Object::Name(b"Font".to_vec()));
            font.set("Subtype", Object::Name(b"CIDFontType2".to_vec()));
            font.set("W", widths);
            Object::Dictionary(font)
        };
        let range = |first: i64, last: i64| {
            Object::Array(vec![
                Object::Integer(first),
                Object::Integer(last),
                Object::Integer(500),
            ])
        };

        // Many fonts sharing one ranged /W array: it is expanded once.
        let mut document = Document::with_version("1.5");
        let shared = document.add_object(range(0, 0xffff));
        let fonts = (0..50)
            .map(|_| document.add_object(cid_font(Object::Reference(shared))))
            .collect::<Vec<_>>();
        expand_cid_width_ranges(&mut document);
        let expanded = document.objects[&shared].as_array().unwrap();
        assert_eq!(expanded.len(), 2);
        assert_eq!(expanded[1].as_array().unwrap().len(), 0x1_0000);
        for font in fonts {
            let font = document.objects[&font].as_dict().unwrap();
            assert_eq!(font.get(b"W").unwrap(), &Object::Reference(shared));
        }

        // Fonts with their own full ranges: only a bounded number is expanded.
        let mut document = Document::with_version("1.5");
        let fonts = (0..20)
            .map(|_| document.add_object(cid_font(range(0, 0xffff))))
            .collect::<Vec<_>>();
        expand_cid_width_ranges(&mut document);
        let expanded = fonts
            .iter()
            .filter(|font| {
                let widths = document.objects[*font]
                    .as_dict()
                    .unwrap()
                    .get(b"W")
                    .unwrap();
                widths.as_array().unwrap().len() == 2
            })
            .count();
        assert_eq!(expanded, 4);
    }

    #[test]
    fn browser_style_cid_pdf_keeps_words_whole() {
        // Chromium's "Save as PDF": an Identity-H font whose widths are given
        // as a range, with every glyph placed by its own text matrix.
        let pdf = per_glyph_cid_pdf("Kapitel Eins", "[1 12 556]");
        let (pages, _, _) = extract_overlay_pages(&pdf, 0, None).unwrap();

        assert_eq!(pages[0].text, "Kapitel Eins");
    }

    fn test_word(text: &str, x: f32, y: f32, width: f32, height: f32) -> OverlayWord {
        OverlayWord {
            text: text.to_string(),
            x,
            y,
            width,
            height,
            confidence: 1.0,
        }
    }

    fn minimal_text_pdf(text: &str) -> Vec<u8> {
        assert!(text.is_ascii() && !text.chars().any(|ch| matches!(ch, '(' | ')' | '\\')));
        let content = format!("BT /F1 18 Tf 72 720 Td ({text}) Tj ET");
        pdf_from_objects(&[
            "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_string(),
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>".to_string(),
            stream_object(&content),
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_string(),
        ])
    }

    /// One page of `text` in a Type0/Identity-H font: glyph n (1-based) is the
    /// nth distinct character, each glyph is positioned with its own text
    /// matrix 556/1000 em after the previous one, and `widths` is the /W array.
    fn per_glyph_cid_pdf(text: &str, widths: &str) -> Vec<u8> {
        let mut glyphs: Vec<char> = Vec::new();
        let mut content = String::from("BT /F1 18 Tf");
        for (index, ch) in text.chars().enumerate() {
            let glyph = match glyphs.iter().position(|known| *known == ch) {
                Some(position) => position + 1,
                None => {
                    glyphs.push(ch);
                    glyphs.len()
                }
            };
            let x = 72.0 + index as f64 * 0.556 * 18.0;
            content.push_str(&format!(" 1 0 0 1 {x:.3} 720 Tm <{glyph:04X}> Tj"));
        }
        content.push_str(" ET");
        let mappings = glyphs
            .iter()
            .enumerate()
            .map(|(index, ch)| format!("<{:04X}> <{:04X}>", index + 1, *ch as u32))
            .collect::<Vec<_>>()
            .join("\n");
        let cmap = format!(
            "/CIDInit /ProcSet findresource begin 12 dict begin begincmap\n/CMapName /Test-UCS def /CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n{} beginbfchar\n{mappings}\nendbfchar\nendcmap CMapName currentdict /CMap defineresource pop end end",
            glyphs.len()
        );
        pdf_from_objects(&[
            "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_string(),
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>".to_string(),
            stream_object(&content),
            "<< /Type /Font /Subtype /Type0 /BaseFont /Test /Encoding /Identity-H /DescendantFonts [6 0 R] /ToUnicode 7 0 R >>".to_string(),
            format!("<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Test /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 8 0 R /DW 250 /W {widths} >>"),
            stream_object(&cmap),
            "<< /Type /FontDescriptor /FontName /Test /Flags 4 /FontBBox [0 -200 1000 800] /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 /StemV 80 >>".to_string(),
        ])
    }

    fn stream_object(content: &str) -> String {
        format!(
            "<< /Length {} >>\nstream\n{content}\nendstream",
            content.len()
        )
    }

    fn pdf_from_objects(objects: &[String]) -> Vec<u8> {
        let mut pdf = b"%PDF-1.4\n".to_vec();
        let mut offsets = Vec::with_capacity(objects.len());
        for (index, object) in objects.iter().enumerate() {
            offsets.push(pdf.len());
            pdf.extend_from_slice(format!("{} 0 obj\n{}\nendobj\n", index + 1, object).as_bytes());
        }
        let xref_offset = pdf.len();
        let mut trailer = format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1);
        for offset in offsets {
            trailer.push_str(&format!("{offset:010} 00000 n \n"));
        }
        trailer.push_str(&format!(
            "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref_offset}\n%%EOF\n",
            objects.len() + 1
        ));
        pdf.extend_from_slice(trailer.as_bytes());
        pdf
    }
}
