//! Regression fixtures for the former Python CLI, without credentials or uploads.
use super::{backend, config::Settings, listing, naming, publish};
use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    fs,
    io::{Read, Write},
    net::TcpListener,
    path::{Path, PathBuf},
    thread,
    time::Duration,
};
use tempfile::TempDir;

/// A fixed UTC instant keeps naming and month-boundary assertions repeatable.
fn now() -> DateTime<Utc> {
    "2026-10-14T12:00:00Z".parse().unwrap()
}

/// Real files exercise canonicalization and metadata instead of mocked paths.
fn fixture(root: &TempDir, name: &str) -> PathBuf {
    let path = root.path().join(name);
    fs::write(&path, b"image").unwrap();
    path
}

/// Generated screenshot dates must win over today's date and omit capture time.
#[test]
fn screenshot_date_and_markdown_url() {
    let temp = TempDir::new().unwrap();
    let file = fixture(&temp, "20261012-104530.png");
    let plan = naming::plan(
        &file,
        "trade-modal",
        None,
        "https://uniquedivine.com",
        now(),
    )
    .unwrap();
    assert_eq!(plan.key, "26/261012-trade-modal.png");
    assert_eq!(
        publish::output(&plan, true),
        "<img src=\"https://uniquedivine.com/f/26/261012-trade-modal.png\" alt=\"trade modal\" />"
    );
}

/// Explicit dates and preview origins support reproducing published evidence.
#[test]
fn explicit_date_and_preview_origin() {
    let temp = TempDir::new().unwrap();
    let file = fixture(&temp, "image.png");
    let plan = naming::plan(
        &file,
        "report",
        Some("2026-09-01"),
        "https://preview.example",
        now(),
    )
    .unwrap();
    assert_eq!(plan.key, "26/260901-report.png");
    assert_eq!(plan.url, "https://preview.example/f/26/260901-report.png");
}

/// Reject malformed names/dates/origins before any credential lookup can run.
#[test]
fn invalid_inputs() {
    let temp = TempDir::new().unwrap();
    let file = fixture(&temp, "image.png");
    for slug in [
        "",
        "../secret",
        "bad space",
        "Bad",
        "bad--slug",
        &"x".repeat(81),
        "report.",
        "report..pdf",
        "report.p/ng",
        "report.p\\ng",
        "/ui/icon",
        "ui//icon",
        "ui/",
        "ui/../icon",
        "UI/icon",
        "ui\\icon",
        "ui/./icon",
    ] {
        assert!(
            naming::plan(&file, slug, None, "https://example.com", now())
                .is_err(),
            "{slug}"
        );
    }
    for date in ["2026-02-30", "26-10-12", "2026-1-1", "0000-01-01"] {
        assert!(
            naming::plan(&file, "ok", Some(date), "https://example.com", now())
                .is_err()
        );
    }
    for origin in [
        "http://example.com",
        "https://example.com/f",
        "https://user@example.com",
        "https://example.com?x=1",
    ] {
        assert!(naming::plan(&file, "ok", None, origin, now()).is_err());
    }
    assert!(
        naming::plan(temp.path(), "ok", None, "https://example.com", now())
            .is_err()
    );
}

/// The service accepts exactly 256 MiB; sparse files avoid large allocations.
#[test]
fn size_boundary() {
    let temp = TempDir::new().unwrap();
    let file = fixture(&temp, "image.png");
    let opened = fs::OpenOptions::new().write(true).open(&file).unwrap();
    opened.set_len(naming::MAX_BYTES).unwrap();
    assert!(
        naming::plan(&file, "large", None, "https://example.com", now()).is_ok()
    );
    opened.set_len(naming::MAX_BYTES + 1).unwrap();
    assert!(
        naming::plan(&file, "large", None, "https://example.com", now())
            .is_err()
    );
}

/// Destination extensions override source names, including compound suffixes.
#[test]
fn explicit_extension_overrides_source() {
    let temp = TempDir::new().unwrap();
    let file = fixture(&temp, "20261012-104530.png");
    for (slug, suffix) in [
        ("trade-modal.webp", "trade-modal.webp"),
        ("trade-modal.PNG", "trade-modal.png"),
        ("source.tar.gz", "source.tar.gz"),
    ] {
        assert_eq!(
            naming::plan(&file, slug, None, "https://example.com", now())
                .unwrap()
                .key,
            format!("26/261012-{suffix}")
        );
    }
    let plan =
        naming::plan(&file, "report.pdf", None, "https://example.com", now())
            .unwrap();
    assert_eq!(
        publish::output(&plan, true),
        "[report](https://example.com/f/26/261012-report.pdf)"
    );
    let svg =
        naming::plan(&file, "icon.svg", None, "https://example.com", now())
            .unwrap();
    assert!(publish::output(&svg, true).starts_with("[icon]"));
}

/// Bangkok's calendar, rather than host timezone, handles extensionless files.
#[test]
fn bangkok_date_and_extensionless_file() {
    let temp = TempDir::new().unwrap();
    let file = fixture(&temp, "report");
    let instant = "2026-12-31T17:00:00Z".parse().unwrap();
    assert_eq!(
        naming::plan(&file, "report", None, "https://example.com", instant)
            .unwrap()
            .key,
        "27/270101-report"
    );
}

/// Semantic directories remain inside the automatic year and receive no
/// date prefix.
#[test]
fn nested_names_and_year_boundary() {
    let temp = TempDir::new().unwrap();
    let file = fixture(&temp, "image.png");
    assert_eq!(
        naming::plan(
            &file,
            "ui/social/twitter.svg",
            Some("2027-01-01"),
            "https://example.com",
            now()
        )
        .unwrap()
        .key,
        "27/ui/social/270101-twitter.svg"
    );
    assert!(
        naming::plan(
            &file,
            &format!("{}/icon", "a/".repeat(600)),
            None,
            "https://example.com",
            now()
        )
        .is_err()
    );
}

/// Current config overrides legacy keys individually; environment has final
/// priority.
#[test]
fn configuration_precedence_and_legacy_fallback() {
    let temp = TempDir::new().unwrap();
    fs::create_dir_all(temp.path().join("pub")).unwrap();
    fs::write(
        temp.path().join("pub/config.json"),
        r#"{"base_url":"https://legacy.example","bucket":"legacy"}"#,
    )
    .unwrap();
    assert_eq!(
        Settings::from_sources(temp.path(), |_| None)
            .unwrap()
            .base_url,
        "https://legacy.example"
    );
    fs::create_dir_all(temp.path().join("ud/fs")).unwrap();
    fs::write(
        temp.path().join("ud/fs/config.json"),
        r#"{"base_url":"https://current.example"}"#,
    )
    .unwrap();
    let config = Settings::from_sources(temp.path(), |_| None).unwrap();
    assert_eq!(config.base_url, "https://current.example");
    assert_eq!(config.bucket, "legacy");
    let config = Settings::from_sources(temp.path(), |key| match key {
        "UD_FS_BASE_URL" => Some("https://new-env.example".into()),
        "PUB_BASE_URL" => Some("https://old-env.example".into()),
        _ => None,
    })
    .unwrap();
    assert_eq!(config.base_url, "https://new-env.example");
    assert_eq!(
        Settings::from_sources(temp.path(), |key| (key == "PUB_BASE_URL")
            .then(|| "https://old-env.example".into()))
        .unwrap()
        .base_url,
        "https://old-env.example"
    );
    fs::write(temp.path().join("ud/fs/config.json"), "[]").unwrap();
    assert!(Settings::from_sources(temp.path(), |_| None).is_err());
}

/// Prefixes are recursive boundaries, not wildcards or traversal expressions.
#[test]
fn directory_selection() {
    assert_eq!(
        listing::selection("26/ui/", None, false, now())
            .unwrap()
            .prefix,
        "26/ui/"
    );
    for directory in [
        "/", "/26", "../26", "26//ui", "26/ui//", "26/../ui", "26/%2f",
        "26\\ui", "26/*",
    ] {
        assert!(
            listing::selection(directory, None, false, now()).is_err(),
            "{directory}"
        );
    }
}

/// Output contracts exclude provider keys except when paths are explicitly
/// requested.
#[test]
fn listing_metadata_and_formats() {
    let metadata = json!({"name":"26/ui/261013-twitter.svg","size":"54","contentType":"application/octet-stream","generation":"123"});
    let record = listing::normalize(&metadata, "https://uniquedivine.com")
        .unwrap()
        .unwrap();
    let url = "https://uniquedivine.com/f/26/ui/261013-twitter.svg";
    assert_eq!(
        listing::output(std::slice::from_ref(&record), "toon").unwrap(),
        format!(
            "files[1]{{url,size,contentType}}:\n  \"{url}\",54,application/octet-stream"
        )
    );
    let ordered =
        listing::output(std::slice::from_ref(&record), "json").unwrap();
    assert!(
        ordered.find("\"url\"").unwrap() < ordered.find("\"size\"").unwrap()
    );
    assert!(
        ordered.find("\"size\"").unwrap()
            < ordered.find("\"contentType\"").unwrap()
    );
    let result: Value = serde_json::from_str(
        &listing::output(std::slice::from_ref(&record), "json").unwrap(),
    )
    .unwrap();
    assert_eq!(
        result,
        json!({"files":[{"url":url,"size":54,"contentType":"application/octet-stream"}]})
    );
    assert_eq!(
        listing::output(std::slice::from_ref(&record), "urls").unwrap(),
        url
    );
    assert_eq!(
        listing::output(&[record], "paths").unwrap(),
        "26/ui/261013-twitter.svg"
    );
    assert_eq!(listing::output(&[], "toon").unwrap(), "files: []");
    assert_eq!(
        serde_json::from_str::<Value>(&listing::output(&[], "json").unwrap())
            .unwrap(),
        json!({"files":[]})
    );
    assert_eq!(listing::output(&[], "urls").unwrap(), "");
    assert!(
        listing::normalize(
            &json!({"name":"26/ui/","size":"0"}),
            "https://example.com"
        )
        .unwrap()
        .is_none()
    );
    for size in [json!(true), json!("invalid"), json!(-1)] {
        assert!(
            listing::normalize(
                &json!({"name":"file","size":size}),
                "https://example.com"
            )
            .is_err()
        );
    }
    let record = listing::normalize(
        &json!({"name":"file","size":"0"}),
        "https://example.com",
    )
    .unwrap()
    .unwrap();
    assert_eq!(record.content_type, "application/octet-stream");
}

/// Selectors use two-digit years and reject impossible calendar days.
#[test]
fn time_filters() {
    for (value, expected) in [
        ("26", "26"),
        ("2609", "2609"),
        ("26-09", "2609"),
        ("261014", "261014"),
        ("26-10-14", "261014"),
        ("24-02-29", "240229"),
    ] {
        assert_eq!(listing::time_filter(value).unwrap(), expected);
    }
    for value in [
        "",
        "2",
        "2026-10-14",
        "26-1",
        "2613",
        "2600",
        "26-02-29",
        "261032",
        "26/09",
        "26--09",
        " 26",
    ] {
        assert!(listing::time_filter(value).is_err(), "{value}");
    }
}

/// Older published links retain their encoded dates without consulting mtime.
#[test]
fn publication_dates_across_layouts() {
    for key in [
        "26/ui/social/261014-twitter.svg",
        "26/10-14-twitter.svg",
        "26-10-14-twitter.svg",
    ] {
        assert_eq!(listing::publication_date(key).as_deref(), Some("261014"));
    }
    for key in [
        "26/ui/twitter.svg",
        "27/ui/261014-icon.svg",
        "26/260229-bad.png",
        "26/02-30-bad.png",
        "notes.pdf",
    ] {
        assert!(listing::publication_date(key).is_none());
    }
}

/// Month rollover and undated objects distinguish implicit and unfiltered
/// scopes.
#[test]
fn listing_scope_and_bangkok_boundaries() {
    for (instant, month) in [
        ("2026-12-31T17:00:00Z", "2701"),
        ("2026-09-30T16:59:59Z", "2609"),
        ("2026-09-30T17:00:00Z", "2610"),
    ] {
        let scope =
            listing::selection("", None, false, instant.parse().unwrap())
                .unwrap();
        assert!(scope.implicit);
        assert_eq!(scope.date.as_deref(), Some(month));
    }
    assert!(
        listing::selection("26/ui", None, false, now())
            .unwrap()
            .date
            .is_none()
    );
    assert!(
        listing::selection("", None, true, now())
            .unwrap()
            .date
            .is_none()
    );
    assert!(listing::selection("", Some("26"), true, now()).is_err());
    let keys = [
        "26/ui/260901-a.png",
        "26/ui/261014-b.png",
        "26/09-01-c.png",
        "26-09-01-d.png",
        "26/ui/undated.png",
        "26/uix/260901-e.png",
    ];
    let records = keys
        .iter()
        .map(|key| {
            listing::normalize(
                &json!({"name":key,"size":"0"}),
                "https://example.com",
            )
            .unwrap()
            .unwrap()
        })
        .collect::<Vec<_>>();
    for (dir, time, all, expected) in [
        ("26/ui/", Some("2609"), false, 1),
        ("", Some("2609"), false, 4),
        ("", None, true, 6),
        ("26/ui/", None, false, 3),
    ] {
        assert_eq!(
            listing::filter(
                records.clone(),
                &listing::selection(dir, time, all, now()).unwrap()
            )
            .len(),
            expected
        );
    }
}

/// Ambiguous TOON strings and every control character must round-trip
/// unchanged.
#[test]
fn toon_string_quoting_and_control_escapes() {
    for value in [
        "plain",
        "image/png",
        "26/ui/icon.png",
        "internal spaces",
        "café",
    ] {
        assert_eq!(listing::toon_string(value), value);
    }
    for value in [
        "",
        "42",
        "05",
        "false",
        "https://example.com",
        "x,y",
        "[x]",
        "-name",
        "#name",
        " leading",
        "trailing ",
        "a\"b",
        "a\\b",
        "a\nb",
        "a\tb",
        "a\u{1}b",
        "a\u{8}b",
        "a\u{c}b",
    ] {
        assert_eq!(
            serde_json::from_str::<String>(&listing::toon_string(value))
                .unwrap(),
            value
        );
    }
    assert_eq!(listing::toon_string("a\u{8}b"), "\"a\\u0008b\"");
    assert_eq!(listing::toon_string("a\u{c}b"), "\"a\\u000cb\"");
}

/// Multiple pages are sorted/deduplicated and malformed cursors cannot loop
/// forever.
#[test]
fn pagination_validation_and_completion() {
    let mut pages = VecDeque::from([
        json!({"items":[{"name":"z","size":"1"}],"nextPageToken":"next"}),
        json!({"items":[{"name":"a","size":"2"},{"name":"z","size":"3"},{"name":"folder/","size":"0"}]}),
    ]);
    let records = backend::collect_pages("https://example.com", |cursor| {
        assert_eq!(cursor, if pages.len() == 2 { None } else { Some("next") });
        Ok(pages.pop_front().unwrap())
    })
    .unwrap();
    assert_eq!(
        records.iter().map(|r| r.key.as_str()).collect::<Vec<_>>(),
        ["a", "z"]
    );
    assert_eq!(records[1].size, 3);
    for page in [
        json!({"items":{}}),
        json!({"nextPageToken":3}),
        json!({"nextPageToken":"again"}),
        json!([]),
    ] {
        assert!(
            backend::collect_pages("https://example.com", |_| Ok(page.clone()))
                .is_err()
        );
    }
}

/// Public verification retries HTTP errors and rejects a successful status
/// with wrong size.
#[test]
fn public_verification_uses_status_and_length() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/file", listener.local_addr().unwrap());
    let worker = thread::spawn(move || {
        for (status, size) in [(404, 0), (200, 99), (200, 5), (200, 6)] {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buffer = [0; 4096];
            let n = stream.read(&mut buffer).unwrap();
            assert!(
                String::from_utf8_lossy(&buffer[..n]).starts_with("HEAD /file ")
            );
            write!(stream,"HTTP/1.1 {status} Status\r\nContent-Length: {size}\r\nConnection: close\r\n\r\n").unwrap();
        }
    });
    let client = reqwest::blocking::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(2))
        .build()
        .unwrap();
    let mut pauses = Vec::new();
    backend::verify(&client, &url, 5, 3, |n| pauses.push(n)).unwrap();
    assert_eq!(pauses, [0, 1]);
    assert!(
        backend::verify(&client, &url, 5, 1, |_| panic!(
            "final failure must not sleep"
        ))
        .is_err()
    );
    worker.join().unwrap();
}

/// Literal upload argv must carry overwrite and integrity preconditions for
/// every type.
#[test]
fn upload_preconditions_and_checksum() {
    let temp = TempDir::new().unwrap();
    let file = fixture(&temp, "data");
    let config = Settings::from_sources(temp.path(), |_| None).unwrap();
    assert_eq!(
        publish::checksum(&file).unwrap(),
        "eIBaIhqYjnnvP0LXxb/UGA=="
    );
    let command = backend::upload_command(
        "gcloud",
        &config,
        &file,
        "26/image.png",
        "hash",
    );
    let args = command
        .get_args()
        .map(|a| a.to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    assert!(args.contains(&"--if-generation-match=0".into()));
    assert!(args.contains(&"--content-md5=hash".into()));
    assert!(args.contains(&"--content-type=image/png".into()));
    assert!(
        args.iter()
            .any(|a| a.starts_with("--content-disposition=inline;"))
    );
}

/// Copy errors and deadlines are recoverable; successful upload output is
/// independent.
#[test]
fn clipboard_failure_and_timeout() {
    assert!(
        publish::copy(Path::new("/bin/false"), "url", Duration::from_secs(1))
            .is_err()
    );
    assert!(
        publish::copy(Path::new("/bin/cat"), "url", Duration::from_secs(1))
            .is_ok()
    );
    let temp = TempDir::new().unwrap();
    let program = temp.path().join("clipboard");
    fs::write(&program, "#!/bin/sh\nexec sleep 5\n").unwrap();
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(&program, fs::Permissions::from_mode(0o755)).unwrap();
    assert!(publish::copy(&program, "url", Duration::from_millis(20)).is_err());
}
