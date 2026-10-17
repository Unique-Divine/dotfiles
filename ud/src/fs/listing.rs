//! Publication-date selection and stable output independent of storage access.
use anyhow::{Result, ensure};
use chrono::{DateTime, NaiveDate, Utc};
use chrono_tz::Asia::Bangkok;
use serde::Serialize;
use serde_json::Value;

use super::naming::{matches, public_url, safe_key};

/// A storage record; internal key is used for sorting, filtering and `--paths`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub(super) struct Record {
    #[serde(skip_serializing)]
    pub key: String,
    pub url: String,
    pub size: u64,
    #[serde(rename = "contentType")]
    pub content_type: String,
}

/// Storage prefix and optional publication-date prefix; neither uses mtime.
#[derive(Debug, PartialEq)]
pub(super) struct Selection {
    pub prefix: String,
    pub date: Option<String>,
    /// Whether to explain the implicit current-month restriction on stderr.
    pub implicit: bool,
}

/// Normalize two-digit-year selectors, validating missing month/day as one.
pub(super) fn time_filter(value: &str) -> Result<String> {
    ensure!(
        matches(
            r"^(?:[0-9]{2}|[0-9]{4}|[0-9]{6}|[0-9]{2}-[0-9]{2}(?:-[0-9]{2})?)$",
            value
        ),
        "Time must use YY, YYMM, YY-MM, YYMMDD, or YY-MM-DD"
    );
    let compact = value.replace('-', "");
    let year = 2000 + compact[..2].parse::<i32>()?;
    let month = if compact.len() >= 4 {
        compact[2..4].parse()?
    } else {
        1
    };
    let day = if compact.len() == 6 {
        compact[4..6].parse()?
    } else {
        1
    };
    ensure!(
        NaiveDate::from_ymd_opt(year, month, day).is_some(),
        "Invalid publication date"
    );
    Ok(compact)
}

/// Recognize current and two historical layouts, rejecting inconsistent years.
pub(super) fn publication_date(key: &str) -> Option<String> {
    let parts = key.split('/').collect::<Vec<_>>();
    let leaf = parts.last()?;
    let value = if parts.len() >= 2
        && matches(r"^[0-9]{6}-.+$", leaf)
        && parts[0] == &leaf[..2]
    {
        leaf[..6].to_owned()
    } else if parts.len() == 2
        && matches(r"^[0-9]{2}$", parts[0])
        && matches(r"^[0-9]{2}-[0-9]{2}-.+$", leaf)
    {
        format!("{}{}", parts[0], leaf[..5].replace('-', ""))
    } else if parts.len() == 1
        && matches(r"^[0-9]{2}-[0-9]{2}-[0-9]{2}-.+$", leaf)
    {
        leaf[..8].replace('-', "")
    } else {
        return None;
    };
    time_filter(&value).ok()
}

/// Directory listings include all dates by default; a bare listing uses
/// Bangkok's month.
pub(super) fn selection(
    directory: &str,
    time: Option<&str>,
    all: bool,
    now: DateTime<Utc>,
) -> Result<Selection> {
    ensure!(
        !(all && time.is_some()),
        "--all and --time cannot be combined"
    );
    let prefix = if directory.is_empty() {
        String::new()
    } else {
        let path = directory.strip_suffix('/').unwrap_or(directory);
        ensure!(safe_key(path), "Directory must be a safe relative path");
        format!("{path}/")
    };
    let implicit = directory.is_empty() && time.is_none() && !all;
    let date = match time {
        Some(time) => Some(time_filter(time)?),
        None if implicit => {
            Some(now.with_timezone(&Bangkok).format("%y%m").to_string())
        }
        None => None,
    };
    Ok(Selection {
        prefix,
        date,
        implicit,
    })
}

/// Filter only after all pages arrive, preserving the backend's sorted order.
pub(super) fn filter(records: Vec<Record>, scope: &Selection) -> Vec<Record> {
    records
        .into_iter()
        .filter(|record| {
            record.key.starts_with(&scope.prefix)
                && scope.date.as_ref().is_none_or(|date| {
                    publication_date(&record.key)
                        .is_some_and(|value| value.starts_with(date))
                })
        })
        .collect()
}

/// Validate provider metadata without exposing generation IDs or bucket names.
pub(super) fn normalize(value: &Value, origin: &str) -> Result<Option<Record>> {
    let Some(key) = value
        .get("name")
        .and_then(Value::as_str)
        .filter(|key| safe_key(key))
    else {
        return Ok(None);
    };
    let size = match value.get("size") {
        Some(Value::String(v)) if matches(r"^[0-9]+$", v) => v.parse()?,
        Some(Value::Number(v)) => v.as_u64().ok_or_else(|| {
            anyhow::anyhow!("Storage returned invalid file size metadata")
        })?,
        _ => anyhow::bail!("Storage returned invalid file size metadata"),
    };
    let content_type = match value.get("contentType") {
        None | Some(Value::Null) => "application/octet-stream",
        Some(Value::String(v)) if v.is_empty() => "application/octet-stream",
        Some(Value::String(v)) => v,
        _ => anyhow::bail!("Storage returned invalid content type metadata"),
    };
    Ok(Some(Record {
        key: key.into(),
        url: public_url(key, origin)?,
        size,
        content_type: content_type.into(),
    }))
}

/// TOON 4.4 quotes ambiguous scalars and uses JSON-compatible control escapes.
pub(super) fn toon_string(value: &str) -> String {
    let quote = value.is_empty()
        || value.trim_matches([' ', '\t']) != value
        || ["true", "false", "null"].contains(&value)
        || matches(r"(?i)^[+-]?[0-9]+(?:\.[0-9]+)?(?:e[+-]?[0-9]+)?$", value)
        || value.contains([':', '"', '\\', '[', ']', '{', '}', ','])
        || value.chars().any(|ch| ch < ' ')
        || value.starts_with(['-', '#']);
    if !quote {
        return value.into();
    }
    let mut result = String::from("\"");
    for ch in value.chars() {
        match ch {
            '\\' => result.push_str("\\\\"),
            '"' => result.push_str("\\\""),
            '\n' => result.push_str("\\n"),
            '\r' => result.push_str("\\r"),
            '\t' => result.push_str("\\t"),
            ch if ch < ' ' => result.push_str(&format!("\\u{:04x}", ch as u32)),
            ch => result.push(ch),
        }
    }
    result.push('"');
    result
}

/// Emit only public metadata, reserving internal keys for explicit path output.
pub(super) fn output(records: &[Record], format: &str) -> Result<String> {
    Ok(match format {
        "json" => {
            /// Serialize records directly to retain the
            /// documented column order.
            #[derive(Serialize)]
            struct Files<'a> {
                files: &'a [Record],
            }
            serde_json::to_string_pretty(&Files { files: records })?
        }
        "urls" | "paths" => records
            .iter()
            .map(|r| {
                if format == "urls" {
                    r.url.as_str()
                } else {
                    r.key.as_str()
                }
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ if records.is_empty() => "files: []".into(),
        _ => {
            let mut lines = vec![format!(
                "files[{}]{{url,size,contentType}}:",
                records.len()
            )];
            lines.extend(records.iter().map(|r| {
                format!(
                    "  {},{},{}",
                    toon_string(&r.url),
                    r.size,
                    toon_string(&r.content_type)
                )
            }));
            lines.join("\n")
        }
    })
}
