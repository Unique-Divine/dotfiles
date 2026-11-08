//! Index behavior against real SQLite files and a real directory store.
use super::{
    Cache, Query, check_known, describe, log, output, reconcile, retag, search,
    similar_tags, slug_of,
    store::{DirStore, Store},
    tag_counts,
};
use crate::fs::{
    commands::{backlinks, source_label, tag_list},
    listing::Record,
    naming::resolve_key,
};
use std::path::Path;
use tempfile::TempDir;

const ORIGIN: &str = "https://uniquedivine.com";

/// A bucket listing record with a fixed size and PNG type.
fn record(key: &str) -> Record {
    Record {
        key: key.into(),
        url: format!("{ORIGIN}/f/{key}"),
        size: 10,
        content_type: "image/png".into(),
    }
}

/// One shared store and a cache per simulated machine.
fn machines(temp: &TempDir) -> (DirStore, Cache, Cache) {
    (
        DirStore {
            root: temp.path().join("remote"),
        },
        Cache {
            dir: temp.path().join("machine-a"),
        },
        Cache {
            dir: temp.path().join("machine-b"),
        },
    )
}

/// Keys from three layouts, used by most tests.
fn seed(store: &DirStore, cache: &Cache) {
    let records = [
        "26-11/261108-fee-chart.png",
        "26/sai-economics/postmortem/261030-loss-curve.png",
        "26/10-14-twitter.svg",
    ]
    .map(record);
    let report = cache.write(store, |tx| reconcile(tx, &records)).unwrap();
    assert_eq!(report.added, 3);
}

#[test]
fn reconcile_adds_deletes_and_restores() {
    let temp = TempDir::new().unwrap();
    let (store, cache, _) = machines(&temp);
    seed(&store, &cache);
    let fewer = [record("26-11/261108-fee-chart.png")];
    let report = cache.write(&store, |tx| reconcile(tx, &fewer)).unwrap();
    assert_eq!((report.added, report.deleted, report.restored), (0, 2, 0));
    let read = cache.read(&store).unwrap();
    assert_eq!(search(&read, &Query::default()).unwrap().len(), 1);
    let deleted = search(
        &read,
        &Query {
            deleted: true,
            ..Query::default()
        },
    )
    .unwrap();
    assert_eq!(deleted.len(), 3);
    drop(read);
    let back = [
        record("26-11/261108-fee-chart.png"),
        record("26/10-14-twitter.svg"),
    ];
    let report = cache.write(&store, |tx| reconcile(tx, &back)).unwrap();
    assert_eq!(report.restored, 1);
}

#[test]
fn tags_descriptions_and_search() {
    let temp = TempDir::new().unwrap();
    let (store, cache, _) = machines(&temp);
    seed(&store, &cache);
    let markdown = "Fee **split** after the\n[Nov 1 reset](https://x.test).";
    cache
        .write(&store, |tx| {
            retag(
                tx,
                "26-11/261108-fee-chart.png",
                &tag_list(&["sai,fees".into()]),
                &[],
            )?;
            retag(
                tx,
                "26/sai-economics/postmortem/261030-loss-curve.png",
                &["sai".into(), "postmortem".into()],
                &[],
            )?;
            describe(tx, "26-11/261108-fee-chart.png", markdown)
        })
        .unwrap();
    let read = cache.read(&store).unwrap();
    let find = |text: &str, tags: &[&str], date: Option<&str>| {
        search(
            &read,
            &Query {
                text: text.into(),
                tags: tags.iter().map(|t| t.to_string()).collect(),
                date: date.map(str::to_owned),
                deleted: false,
            },
        )
        .unwrap()
        .into_iter()
        .map(|e| e.key)
        .collect::<Vec<_>>()
    };
    assert_eq!(find("", &["sai"], None).len(), 2);
    assert_eq!(find("", &["sai", "postmortem"], None).len(), 1);
    assert_eq!(find("reset", &[], None), ["26-11/261108-fee-chart.png"]);
    // Trigram matching finds substrings of slugs and tags.
    assert_eq!(find("curv", &[], None).len(), 1);
    assert_eq!(find("postmor", &[], None).len(), 1);
    // Words shorter than three characters use substring checks.
    assert_eq!(find("fe", &[], None), ["26-11/261108-fee-chart.png"]);
    assert_eq!(find("", &[], Some("2611")).len(), 1);
    assert_eq!(find("", &[], Some("2610")).len(), 2);
    assert!(find("absent", &[], None).is_empty());

    let entry = search(
        &read,
        &Query {
            text: "reset".into(),
            ..Query::default()
        },
    )
    .unwrap();
    assert_eq!(entry[0].description, markdown);
    let json: serde_json::Value =
        serde_json::from_str(&output(&entry, "json", ORIGIN).unwrap()).unwrap();
    assert_eq!(json["files"][0]["description"], markdown);
    assert_eq!(json["files"][0]["tags"], serde_json::json!(["fees", "sai"]));
    let toon = output(&entry, "toon", ORIGIN).unwrap();
    assert!(toon.contains("\\n[Nov 1 reset]"), "{toon}");
    assert_eq!(
        tag_counts(&read).unwrap(),
        [
            ("sai".into(), 2),
            ("fees".into(), 1),
            ("postmortem".into(), 1)
        ]
    );
    drop(read);

    cache
        .write(&store, |tx| {
            retag(tx, "26-11/261108-fee-chart.png", &[], &["sai".into()])
        })
        .unwrap();
    let read = cache.read(&store).unwrap();
    assert_eq!(find_tags(&read, "sai"), 1);
    let actions = log(&read, 50)
        .unwrap()
        .into_iter()
        .map(|c| c.action)
        .collect::<Vec<_>>();
    assert_eq!(actions[0], "untag");
    assert!(actions.contains(&"describe".to_string()));
    assert_eq!(actions.iter().filter(|a| *a == "add").count(), 3);
}

/// Count live files carrying `tag`.
fn find_tags(read: &rusqlite::Connection, tag: &str) -> usize {
    search(
        read,
        &Query {
            tags: vec![tag.into()],
            ..Query::default()
        },
    )
    .unwrap()
    .len()
}

#[test]
fn unknown_tags_need_new_tag_and_suggest_lookalikes() {
    let temp = TempDir::new().unwrap();
    let (store, cache, _) = machines(&temp);
    seed(&store, &cache);
    cache
        .write(&store, |tx| {
            retag(tx, "26/10-14-twitter.svg", &["postmortem".into()], &[])
        })
        .unwrap();
    let read = cache.read(&store).unwrap();
    let error = check_known(&read, &["post-mortem".into()], false)
        .unwrap_err()
        .to_string();
    assert!(error.contains("--new-tag"), "{error}");
    assert!(error.contains("existing: postmortem"), "{error}");
    assert!(check_known(&read, &["post-mortem".into()], true).is_ok());
    assert!(check_known(&read, &["postmortem".into()], false).is_ok());
    assert!(check_known(&read, &["Bad Tag".into()], true).is_err());
    assert_eq!(
        similar_tags(
            "sai-econ",
            &["sai".into(), "sai-economics".into(), "ui".into()]
        ),
        ["sai", "sai-economics"]
    );
}

#[test]
fn tagging_requires_an_indexed_file() {
    let temp = TempDir::new().unwrap();
    let (store, cache, _) = machines(&temp);
    seed(&store, &cache);
    let error = cache
        .write(&store, |tx| {
            retag(tx, "26-11/261108-missing.png", &["x".into()], &[])
        })
        .unwrap_err()
        .to_string();
    assert!(error.contains("index sync"), "{error}");
    // The failed write left the remote copy untouched.
    assert_eq!(store.generation().unwrap(), Some(1));
}

#[test]
fn concurrent_writers_both_land() {
    let temp = TempDir::new().unwrap();
    let (store, machine_a, machine_b) = machines(&temp);
    seed(&store, &machine_a);
    machine_b.read(&store).unwrap();
    let mut attempts = 0;
    machine_b
        .write(&store, |tx| {
            attempts += 1;
            if attempts == 1 {
                // Machine A writes after B started, so B's upload is refused.
                machine_a
                    .write(&store, |tx| {
                        retag(
                            tx,
                            "26/10-14-twitter.svg",
                            &["from-a".into()],
                            &[],
                        )
                    })
                    .unwrap();
            }
            retag(tx, "26-11/261108-fee-chart.png", &["from-b".into()], &[])
        })
        .unwrap();
    assert_eq!(attempts, 2);
    for machine in [&machine_a, &machine_b] {
        let read = machine.read(&store).unwrap();
        assert_eq!(find_tags(&read, "from-a"), 1);
        assert_eq!(find_tags(&read, "from-b"), 1);
    }
}

#[test]
fn keys_urls_slugs_and_sources() {
    for (value, key) in [
        ("26-11/261108-a.png", "26-11/261108-a.png"),
        (
            "https://uniquedivine.com/f/26-11/261108-a.png",
            "26-11/261108-a.png",
        ),
        (
            "https://uniquedivine-site.web.app/f/26/ui/a.png?x=1#y",
            "26/ui/a.png",
        ),
    ] {
        assert_eq!(resolve_key(value, ORIGIN).unwrap(), key);
    }
    for value in ["../a.png", "http://evil.test/f/a.png/../b", "", "a//b"] {
        assert!(resolve_key(value, ORIGIN).is_err(), "{value}");
    }
    assert_eq!(slug_of("26-11/261108-fee-chart.tar.gz"), "fee-chart");
    assert_eq!(slug_of("26/10-14-twitter.svg"), "twitter");
    assert_eq!(slug_of("26-10-14-twitter.svg"), "twitter");
    assert_eq!(slug_of("notes.pdf"), "notes");
    let home = Path::new("/home/u");
    assert_eq!(
        source_label(Path::new("/home/u/ki/boku/epics/x"), Some(home)),
        "boku/epics/x"
    );
    assert_eq!(source_label(Path::new("/home/u/tmp"), Some(home)), "~/tmp");
    assert_eq!(source_label(Path::new("/srv/a"), Some(home)), "/srv/a");
}

#[test]
fn backlinks_find_documents_per_key() {
    let temp = TempDir::new().unwrap();
    let docs = temp.path().join("docs");
    std::fs::create_dir_all(docs.join("epic")).unwrap();
    std::fs::write(
        docs.join("epic/README.md"),
        "<img src=\"https://uniquedivine.com/f/26-11/261108-a.png\" />\n\
         [b](https://uniquedivine.com/f/26/ui/b.svg) and again \
         https://uniquedivine.com/f/26-11/261108-a.png\n",
    )
    .unwrap();
    std::fs::write(docs.join("other.md"), "/f/26/ui/b.svg\n").unwrap();
    let keys =
        ["26-11/261108-a.png", "26/ui/b.svg", "26/unused.png"].map(String::from);
    let found =
        backlinks(&keys, &[docs.clone(), temp.path().join("absent")]).unwrap();
    let readme = docs.join("epic/README.md").display().to_string();
    let other = docs.join("other.md").display().to_string();
    assert_eq!(found["26-11/261108-a.png"], std::slice::from_ref(&readme));
    let mut b = found["26/ui/b.svg"].clone();
    b.sort();
    let mut expected = vec![readme, other];
    expected.sort();
    assert_eq!(b, expected);
    assert!(found["26/unused.png"].is_empty());
}
