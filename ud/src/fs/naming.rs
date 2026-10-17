//! Pure naming rules shared by publishing and storage metadata validation.
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail, ensure};
use chrono::{DateTime, Datelike, NaiveDate, Utc};
use chrono_tz::Asia::Bangkok;
use regex::Regex;
use reqwest::Url;

/// Upload cap accepted by the public file service, inclusive at 256 MiB.
pub(super) const MAX_BYTES: u64 = 256 * 1024 * 1024;

/// A validated upload destination; constructing it never authenticates or
/// writes.
#[derive(Debug)]
pub(super) struct Plan {
    /// Canonical local file validated before cloud access.
    pub file: PathBuf,
    /// Safe bucket-relative destination, including publication date.
    pub key: String,
    /// Public URL printed only by a dry run or verified successful upload.
    pub url: String,
    /// Extension-free basename used in HTML alt text and Markdown link labels.
    pub label: String,
}

/// Match a whole value; patterns are developer constants, never user input.
pub(super) fn matches(pattern: &str, value: &str) -> bool {
    Regex::new(pattern)
        .expect("valid static pattern")
        .is_match(value)
}

/// Public serving accepts only simple path components, excluding traversal.
pub(super) fn safe_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 1024
        && key.split('/').all(|part| {
            !part.contains("..")
                && matches(r"^[a-zA-Z0-9][a-zA-Z0-9._-]*$", part)
        })
}

/// Restrict serving origins before appending the fixed `/f/` route.
pub(super) fn public_url(key: &str, origin: &str) -> Result<String> {
    // URL parsers normalize dot segments. Validate the original spelling too,
    // otherwise /a/.. would become an apparent origin and bypass this contract.
    let (_, authority) = origin
        .split_once("://")
        .context("Base URL must be an HTTPS origin")?;
    ensure!(
        authority
            .split_once('/')
            .is_none_or(|(_, path)| path.is_empty())
            && !origin.contains('\\'),
        "Base URL must be an HTTPS origin"
    );
    let url = Url::parse(origin).context("Base URL must be an HTTPS origin")?;
    ensure!(
        url.scheme() == "https"
            && url.host_str().is_some()
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none()
            && url.path() == "/",
        "Base URL must be an HTTPS origin"
    );
    Ok(format!("{}/f/{key}", origin.trim_end_matches('/')))
}

/// Require a real calendar date and the documented zero-padded spelling.
fn explicit_date(value: &str) -> Result<NaiveDate> {
    ensure!(
        matches(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$", value),
        "Date must use YYYY-MM-DD"
    );
    ensure!(!value.starts_with("0000"), "Date year must be at least one");
    Ok(NaiveDate::parse_from_str(value, "%Y-%m-%d")?)
}

/// Validate semantic directories separately from the extension-bearing leaf.
fn destination_name(file: &Path, slug: &str) -> Result<(String, String)> {
    let mut parts = slug.split('/').collect::<Vec<_>>();
    let leaf = parts.pop().unwrap_or("");
    for part in &parts {
        ensure!(
            part.len() <= 80 && matches(r"^[a-z0-9]+(?:-[a-z0-9]+)*$", part),
            "Directories must use lowercase names, digits, and single hyphens"
        );
    }
    let (name, suffix) = match leaf.split_once('.') {
        Some((name, extension)) => {
            (name, format!(".{}", extension.to_lowercase()))
        }
        None => (
            leaf,
            file.extension()
                .map(|v| format!(".{}", v.to_string_lossy().to_lowercase()))
                .unwrap_or_default(),
        ),
    };
    ensure!(
        name.len() <= 80 && matches(r"^[a-z0-9]+(?:-[a-z0-9]+)*$", name),
        "Slug must contain lowercase letters, digits, and single hyphens, up to 80 characters"
    );
    ensure!(
        suffix.is_empty() || matches(r"^(?:\.[a-z0-9]+)+$", &suffix),
        "Unsupported file extension"
    );
    parts.push(name);
    Ok((parts.join("/"), suffix))
}

/// Resolve date precedence without consulting the machine's local timezone.
/// An explicit date wins, followed by a pbpaste-img name, then Bangkok today.
pub(super) fn plan(
    file: &Path,
    slug: &str,
    date: Option<&str>,
    origin: &str,
    now: DateTime<Utc>,
) -> Result<Plan> {
    let file = file.canonicalize().context("Input file does not exist")?;
    let metadata = file.metadata()?;
    ensure!(metadata.is_file(), "Input must be a regular file");
    ensure!(metadata.len() <= MAX_BYTES, "File exceeds 256 MiB");
    let (name, suffix) = destination_name(&file, slug)?;
    let stem = file.file_stem().unwrap_or_default().to_string_lossy();
    let day = if let Some(date) = date {
        explicit_date(date)?
    } else if matches(r"^[0-9]{8}-[0-9]{6}$", &stem) {
        NaiveDate::parse_from_str(&stem[..8], "%Y%m%d")?
    } else {
        now.with_timezone(&Bangkok).date_naive()
    };
    ensure!(day.year() >= 1, "Date year must be at least one");
    let (parent, leaf) = name.rsplit_once('/').unwrap_or(("", &name));
    let directory = if parent.is_empty() {
        String::new()
    } else {
        format!("{parent}/")
    };
    let key = format!(
        "{}/{directory}{}-{leaf}{suffix}",
        day.format("%y"),
        day.format("%y%m%d")
    );
    if key.len() > 1024 {
        bail!("Destination path exceeds 1024 characters");
    }
    let url = public_url(&key, origin)?;
    Ok(Plan {
        file,
        key,
        url,
        label: leaf.replace('-', " "),
    })
}

/// Destination extension controls headers; SVG and unknown types download.
pub(super) fn inline_type(key: &str) -> Option<&'static str> {
    match Path::new(key).extension()?.to_str()? {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "avif" => Some("image/avif"),
        "pdf" => Some("application/pdf"),
        _ => None,
    }
}

/// PDF may render inline but only raster images receive an HTML image tag.
pub(super) fn is_image(key: &str) -> bool {
    inline_type(key).is_some_and(|mime| mime.starts_with("image/"))
}
