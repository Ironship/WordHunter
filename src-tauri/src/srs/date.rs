use time::{format_description::well_known::Rfc3339, Duration as TimeDuration, OffsetDateTime};

pub fn today_iso(date: OffsetDateTime) -> String {
    format!(
        "{:04}-{:02}-{:02}",
        date.year(),
        u8::from(date.month()),
        date.day()
    )
}

pub fn add_days_iso_from(days: i64, from: OffsetDateTime) -> String {
    let next = from + TimeDuration::days(days.max(0));
    today_iso(next)
}

pub fn is_due(next_date: Option<&str>, today: &str) -> bool {
    match next_date {
        None | Some("") => true,
        Some(value) => value <= today,
    }
}

pub(crate) fn add_days_iso(today: &str, days: i64) -> String {
    let Ok(date) = time::Date::parse(
        today,
        &time::macros::format_description!("[year]-[month]-[day]"),
    ) else {
        return today.to_string();
    };
    let next = date + TimeDuration::days(days.max(0));
    format!(
        "{:04}-{:02}-{:02}",
        next.year(),
        u8::from(next.month()),
        next.day()
    )
}

pub(crate) fn today_from_iso(now_iso: &str) -> String {
    OffsetDateTime::parse(now_iso, &Rfc3339)
        .ok()
        .map(|dt| {
            let date = dt.date();
            format!(
                "{:04}-{:02}-{:02}",
                date.year(),
                u8::from(date.month()),
                date.day()
            )
        })
        .unwrap_or_else(|| "1970-01-01".to_string())
}

pub(crate) fn elapsed_days_since(last_reviewed_at: Option<&str>, now_iso: &str) -> i64 {
    let Some(last_reviewed_at) = last_reviewed_at else {
        return 0;
    };
    let Ok(last) = OffsetDateTime::parse(last_reviewed_at, &Rfc3339) else {
        return 0;
    };
    let Ok(now) = OffsetDateTime::parse(now_iso, &Rfc3339) else {
        return 0;
    };
    ((now.unix_timestamp() - last.unix_timestamp()) as f64 / 86_400.0)
        .round()
        .max(0.0) as i64
}
