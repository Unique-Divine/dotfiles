use std::fs;
use std::path::{Path, PathBuf};

use tempfile::TempDir;

use super::just::{
    check_text, collect, glob_regex, is_justfile_name, recipe_name,
};
use super::{Finding, Palette, Severity, format_finding, summary};

fn check(text: &str) -> Vec<(usize, Severity, &'static str)> {
    check_text(Path::new("justfile"), text)
        .into_iter()
        .map(|f| (f.line, f.severity, f.code))
        .collect()
}

#[test]
fn multi_line_doc_comment_is_an_error_at_its_first_line() {
    let text = "# Build it\n# (and more detail)\nbuild:\n  cargo build\n";
    assert_eq!(check(text), vec![(1, Severity::Error, "doc-comment-lines")]);
    let findings = check_text(Path::new("justfile"), text);
    assert!(findings[0].message.contains("recipe \"build\" has 2"));
}

#[test]
fn one_line_doc_comment_is_clean() {
    assert!(check("# Build it\nbuild:\n  cargo build\n").is_empty());
}

#[test]
fn blank_line_separates_section_headers_from_the_doc() {
    let text = "# ── Section ──\n# notes\n\n# Build it\nbuild:\n  x\n";
    assert!(check(text).is_empty());
}

#[test]
fn attributes_between_comment_and_recipe() {
    let text = "# One\n# Two\n[group('dev')]\nrun:\n  x\n";
    assert_eq!(check(text), vec![(1, Severity::Error, "doc-comment-lines")]);
    assert!(check("# Run it\n[group('dev')]\nrun:\n  x\n").is_empty());
}

#[test]
fn undocumented_public_recipe_is_info_at_the_recipe() {
    assert_eq!(
        check("set shell := [\"bash\", \"-c\"]\n\ntest:\n  x\n"),
        vec![(3, Severity::Info, "missing-doc")]
    );
}

#[test]
fn private_and_doc_attribute_recipes_need_no_comment() {
    assert!(check("[private]\nhelper:\n  x\n").is_empty());
    assert!(check("[no-cd, private]\nhelper:\n  x\n").is_empty());
    assert!(check("_helper:\n  x\n").is_empty());
    assert!(check("[doc('Build it')]\nbuild:\n  x\n").is_empty());
}

#[test]
fn body_comments_and_shebangs_are_ignored() {
    let text = "# Test it\ntest:\n  #!/usr/bin/env bash\n  # step one\n  \
                # step two\n  echo ok\n";
    assert!(check(text).is_empty());
    assert!(check("#!/usr/bin/env just\n# Build\nbuild:\n  x\n").is_empty());
}

#[test]
fn non_recipe_lines_are_not_recipes() {
    for line in [
        "x := \"a:b\"",
        "x:=1",
        "export X := \"1\"",
        "alias b := build",
        "set dotenv-load",
        "import 'other.just'",
        "import? 'maybe.just'",
        "mod tools",
    ] {
        assert_eq!(recipe_name(line), None, "{line}");
    }
}

#[test]
fn recipe_headers_with_parameters_and_dependencies() {
    assert_eq!(recipe_name("build:"), Some("build"));
    assert_eq!(recipe_name("@quiet:"), Some("quiet"));
    assert_eq!(recipe_name("cbm-install *ARGS:"), Some("cbm-install"));
    assert_eq!(recipe_name("run port=\"8080:80\": build"), Some("run"));
    assert_eq!(
        recipe_name("deploy env='prod': (build env)"),
        Some("deploy")
    );
}

#[test]
fn justfile_names() {
    for name in ["justfile", "Justfile", ".justfile", "rust.just"] {
        assert!(is_justfile_name(name), "{name}");
    }
    for name in ["justfile.md", "Makefile", "just"] {
        assert!(!is_justfile_name(name), "{name}");
    }
}

#[test]
fn globs_match_within_and_across_directories() {
    let re = glob_regex("nibi/**/*.just");
    assert!(re.is_match("nibi/a.just"));
    assert!(re.is_match("nibi/x/y/a.just"));
    assert!(!re.is_match("other/a.just"));
    assert!(glob_regex("*/justfile").is_match("cook/justfile"));
    assert!(!glob_regex("*/justfile").is_match("a/b/justfile"));
    assert!(glob_regex("[jJ]ustfile").is_match("Justfile"));
}

#[test]
fn format_and_summary_without_color() {
    let palette = Palette { color: false };
    let finding = Finding {
        path: PathBuf::from("./a/justfile"),
        line: 3,
        severity: Severity::Error,
        code: "doc-comment-lines",
        message: "m".into(),
    };
    assert_eq!(
        format_finding(&finding, &palette),
        "a/justfile:3: error[doc-comment-lines]: m"
    );
    assert_eq!(
        summary(2, &[finding], "justfile", &palette),
        "2 justfiles, 1 error, 0 info"
    );
    assert_eq!(summary(1, &[], "justfile", &palette), "💚 clean 1 justfile");
}

#[test]
fn collect_walks_directories_and_skips_dependencies() {
    let dir = TempDir::new().unwrap();
    let root = dir.path();
    for path in [
        "justfile",
        "sub/tools.just",
        "node_modules/x/justfile",
        "target/justfile",
        "sub/notes.md",
    ] {
        let path = root.join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, "").unwrap();
    }
    let files = collect(&[root.to_owned()]).unwrap();
    assert_eq!(
        files,
        vec![root.join("justfile"), root.join("sub/tools.just")]
    );
}

#[test]
fn collect_follows_file_links_but_not_directory_links() {
    let dir = TempDir::new().unwrap();
    let root = dir.path();
    fs::create_dir_all(root.join("skills/justfile")).unwrap();
    fs::write(root.join("real.just"), "").unwrap();
    std::os::unix::fs::symlink(
        root.join("skills/justfile"),
        root.join("justfile"),
    )
    .unwrap();
    std::os::unix::fs::symlink(root.join("real.just"), root.join("linked.just"))
        .unwrap();
    let files = collect(&[root.to_owned()]).unwrap();
    assert_eq!(
        files,
        vec![root.join("linked.just"), root.join("real.just")]
    );
}

#[test]
fn collect_reports_bad_input() {
    let dir = TempDir::new().unwrap();
    let missing = dir.path().join("missing");
    assert!(collect(&[missing]).unwrap_err().contains("no such file"));
    assert!(
        collect(&[dir.path().to_owned()])
            .unwrap_err()
            .contains("no justfiles found")
    );
    let glob = dir.path().join("*.just");
    assert!(
        collect(&[glob])
            .unwrap_err()
            .contains("glob matched no files")
    );
}
