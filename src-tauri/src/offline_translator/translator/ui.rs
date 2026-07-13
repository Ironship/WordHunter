use serde_json::Value;

use crate::response;
use crate::router;

use super::models::status;

fn popup_theme(value: Option<&str>) -> &'static str {
    match value {
        Some("dark") => "dark",
        Some("auto") => "auto",
        None => "auto",
        _ => "light",
    }
}

fn popup_family(value: Option<&str>) -> &'static str {
    match value {
        Some("familiar") => "familiar",
        Some("alternative-familiar") => "alternative-familiar",
        _ => "classic",
    }
}

/// Public popup HTML endpoint — renders the translator popup template with
/// language options and i18n labels.
pub fn popup_html(query: &str, template: &[u8]) -> Result<Vec<u8>, String> {
    let params = response::parse_query(query);
    let text = params.get("text").cloned().unwrap_or_default();
    let from_code = params.get("from").cloned().unwrap_or_default();
    let to_code = params
        .get("to")
        .cloned()
        .unwrap_or_else(|| "pl".to_string());
    let theme = popup_theme(params.get("theme").map(String::as_str));
    let family = popup_family(params.get("family").map(String::as_str));
    let locale = params
        .get("locale")
        .cloned()
        .unwrap_or_else(|| "pl".to_string());

    let current_status = status();
    let models = current_status
        .get("models")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut from_langs = vec![
        "en".to_string(),
        "pl".to_string(),
        "de".to_string(),
        "es".to_string(),
        "fr".to_string(),
        "it".to_string(),
        "uk".to_string(),
        "ru".to_string(),
        "ja".to_string(),
        "zh".to_string(),
    ];
    let mut to_langs = from_langs.clone();
    if !models.is_empty() {
        from_langs.clear();
        to_langs.clear();
        for model in models {
            if let Some(from) = model.get("from").and_then(Value::as_str)
                && !from_langs.iter().any(|item| item == from)
            {
                from_langs.push(from.to_string());
            }
            if let Some(to) = model.get("to").and_then(Value::as_str)
                && !to_langs.iter().any(|item| item == to)
            {
                to_langs.push(to.to_string());
            }
        }
        from_langs.sort();
        to_langs.sort();
    }

    let labels = translator_labels(&locale);
    let from_options = select_options(&from_langs, &from_code, &labels);
    let to_options = select_options(&to_langs, &to_code, &labels);
    let mut html = String::from_utf8(template.to_vec()).map_err(|e| e.to_string())?;

    let replacements = [
        ("{{theme}}", escape_attr(theme)),
        ("{{color_theme}}", escape_attr(family)),
        ("{{locale}}", escape_attr(&locale)),
        (
            "{{title}}",
            escape_html(
                labels
                    .get("title")
                    .unwrap_or(&"Offline Translator".to_string()),
            ),
        ),
        ("{{base_url}}", String::new()),
        ("{{from_code}}", escape_attr(&from_code)),
        ("{{to_code}}", escape_attr(&to_code)),
        ("{{from_options}}", from_options),
        ("{{to_options}}", to_options),
        (
            "{{from_label}}",
            escape_attr(labels.get("from").unwrap_or(&"Source language".to_string())),
        ),
        (
            "{{to_label}}",
            escape_attr(labels.get("to").unwrap_or(&"Target language".to_string())),
        ),
        (
            "{{source_label}}",
            escape_html(
                labels
                    .get("sourceLabel")
                    .unwrap_or(&"Source text".to_string()),
            ),
        ),
        (
            "{{placeholder}}",
            escape_attr(
                labels
                    .get("placeholder")
                    .unwrap_or(&"Enter text...".to_string()),
            ),
        ),
        (
            "{{target_placeholder}}",
            escape_attr(
                labels
                    .get("targetPlaceholder")
                    .unwrap_or(&"Translation appears here...".to_string()),
            ),
        ),
        ("{{text}}", escape_html(&text)),
        (
            "{{target_label}}",
            escape_html(
                labels
                    .get("targetLabel")
                    .unwrap_or(&"Translation".to_string()),
            ),
        ),
        (
            "{{footer}}",
            escape_html(
                labels
                    .get("footer")
                    .unwrap_or(&"Powered locally by the offline translator".to_string()),
            ),
        ),
        (
            "{{copy_btn}}",
            escape_html(labels.get("copyBtn").unwrap_or(&"Copy".to_string())),
        ),
        (
            "{{copied}}",
            escape_html(labels.get("copied").unwrap_or(&"Copied!".to_string())),
        ),
    ];
    for (needle, value) in replacements {
        html = html.replace(needle, &value);
    }

    Ok(html.into_bytes())
}

/// Load translated labels for the translator UI from i18n files, falling back
/// to Polish defaults.
pub(crate) fn translator_labels(locale: &str) -> std::collections::HashMap<String, String> {
    let mut labels = std::collections::HashMap::from([
        ("title".to_string(), "Offline Translator".to_string()),
        ("sourceLabel".to_string(), "Tekst zrodlowy".to_string()),
        ("targetLabel".to_string(), "Tlumaczenie".to_string()),
        (
            "placeholder".to_string(),
            "Wpisz slowo lub cale zdanie...".to_string(),
        ),
        (
            "targetPlaceholder".to_string(),
            "Tlumaczenie pojawi sie tutaj...".to_string(),
        ),
        (
            "footer".to_string(),
            "Zasilane lokalnie przez translator offline".to_string(),
        ),
        ("copyBtn".to_string(), "Kopiuj tlumaczenie".to_string()),
        ("copied".to_string(), "Skopiowano!".to_string()),
    ]);
    let safe_locale = if ["pl", "en", "de", "es", "fr", "it", "uk", "ru", "ja"].contains(&locale) {
        locale
    } else {
        "en"
    };
    let path = format!("i18n/{safe_locale}.json");
    if let Some(file) = router::WEB_ASSETS.get_file(&path)
        && let Ok(value) = serde_json::from_slice::<Value>(file.contents())
    {
        if let Some(translator) = value.get("translator").and_then(Value::as_object) {
            for (key, value) in translator {
                if let Some(text) = value.as_str() {
                    labels.insert(key.clone(), text.to_string());
                }
            }
        }
        if let Some(languages) = value.get("languages").and_then(Value::as_object) {
            for (key, value) in languages {
                if let Some(text) = value.as_str() {
                    labels.insert(format!("language.{key}"), text.to_string());
                }
            }
        }
    }
    labels
}

/// Build an HTML `<option>` list from language codes, marking the selected one.
fn select_options(
    langs: &[String],
    selected: &str,
    labels: &std::collections::HashMap<String, String>,
) -> String {
    langs
        .iter()
        .map(|lang| {
            let label = labels
                .get(&format!("language.{lang}"))
                .cloned()
                .unwrap_or_else(|| lang.to_uppercase());
            format!(
                r#"<option value="{value}" {selected_attr}>{label}</option>"#,
                value = escape_attr(lang),
                selected_attr = if lang == selected { "selected" } else { "" },
                label = escape_html(&label)
            )
        })
        .collect::<Vec<_>>()
        .join("")
}

/// HTML-escape a text value.
fn escape_html(value: &str) -> String {
    html_escape::encode_text(value).to_string()
}

/// HTML-escape an attribute value.
fn escape_attr(value: &str) -> String {
    html_escape::encode_double_quoted_attribute(value).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn select_options_uses_localized_language_labels() {
        let labels =
            std::collections::HashMap::from([("language.pl".to_string(), "Polski".to_string())]);
        let html = select_options(&["pl".to_string()], "pl", &labels);

        assert!(html.contains(">Polski</option>"));
        assert!(html.contains("selected"));
    }

    #[test]
    fn popup_theme_parameters_are_bounded() {
        assert_eq!(popup_theme(Some("dark")), "dark");
        assert_eq!(popup_theme(Some("auto")), "auto");
        assert_eq!(popup_theme(None), "auto");
        assert_eq!(popup_theme(Some("untrusted")), "light");
        assert_eq!(popup_family(Some("familiar")), "familiar");
        assert_eq!(
            popup_family(Some("alternative-familiar")),
            "alternative-familiar"
        );
        assert_eq!(popup_family(Some("untrusted")), "classic");
    }
}
