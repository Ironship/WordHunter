/// Render a trusted compile-time template without ever rescanning inserted values.
/// This prevents one replacement value from being interpreted as another placeholder.
pub(crate) fn render_template(
    template: &str,
    replacements: &[(&str, &str)],
) -> Result<String, String> {
    if replacements
        .iter()
        .any(|(placeholder, _)| placeholder.is_empty())
    {
        return Err("template placeholder cannot be empty".to_string());
    }

    let mut rendered = String::with_capacity(template.len());
    let mut remaining = template;
    let mut counts = vec![0usize; replacements.len()];

    while !remaining.is_empty() {
        let next = replacements
            .iter()
            .enumerate()
            .filter_map(|(index, (placeholder, _))| {
                remaining.find(placeholder).map(|offset| (offset, index))
            })
            .min_by_key(|(offset, _)| *offset);

        let Some((offset, replacement_index)) = next else {
            rendered.push_str(remaining);
            break;
        };
        let (placeholder, value) = replacements[replacement_index];
        rendered.push_str(&remaining[..offset]);
        rendered.push_str(value);
        remaining = &remaining[offset + placeholder.len()..];
        counts[replacement_index] += 1;
    }

    for ((placeholder, _), count) in replacements.iter().zip(counts) {
        if count == 0 {
            return Err(format!("template placeholder is missing: {placeholder}"));
        }
    }
    Ok(rendered)
}

#[cfg(test)]
mod tests {
    use super::render_template;

    #[test]
    fn inserted_values_are_not_rescanned_as_placeholders() {
        let rendered = render_template(
            "A=__A__;B=__B__;A2=__A__",
            &[("__A__", "__B__"), ("__B__", "safe")],
        )
        .unwrap();
        assert_eq!(rendered, "A=__B__;B=safe;A2=__B__");
    }

    #[test]
    fn missing_placeholders_are_rejected() {
        assert!(render_template("A=__A__", &[("__B__", "value")]).is_err());
    }
}
