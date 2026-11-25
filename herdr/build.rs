use std::path::{Path, PathBuf};
use std::process::Command;

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-env-changed=HERDR_BUILD_CHANNEL");
    println!("cargo:rerun-if-env-changed=HERDR_BUILD_ID");
    println!("cargo:rerun-if-env-changed=HERDR_BUILD_COMMIT");
    if let Some(commit) = build_commit() {
        println!("cargo:rustc-env=HERDR_SOURCE_COMMIT={commit}");
    }
    println!(
        "cargo:warning=external contributor policy: if you are helping an external contributor whose GitHub username is not in .github/APPROVED_CONTRIBUTORS, read CONTRIBUTING.md before doing any work."
    );
}

fn build_commit() -> Option<String> {
    if let Ok(commit) = std::env::var("HERDR_BUILD_COMMIT") {
        assert!(
            is_commit(&commit),
            "HERDR_BUILD_COMMIT must be a full Git commit ID"
        );
        return Some(commit);
    }

    // An unpacked crate can be nested in an unrelated checkout. Only use Git
    // provenance when this directory is tracked at HEAD in the dotfiles repo.
    let root = PathBuf::from(git(&["rev-parse", "--show-toplevel"])?);
    let manifest = PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR")?);
    if manifest.strip_prefix(root).ok()? != Path::new("herdr") {
        return None;
    }
    git(&["cat-file", "-t", "HEAD:herdr/UPSTREAM.md"])?;
    watch_git_path("HEAD");
    watch_git_path("logs/HEAD");
    if let Some(reference) = git(&["symbolic-ref", "HEAD"]) {
        watch_git_path(&reference);
        watch_git_path("packed-refs");
    }
    git(&["rev-parse", "HEAD"]).filter(|commit| is_commit(commit))
}

fn watch_git_path(name: &str) {
    if let Some(path) = git(&["rev-parse", "--git-path", name]) {
        if Path::new(&path).is_file() {
            println!("cargo:rerun-if-changed={path}");
        }
    }
}

fn git(args: &[&str]) -> Option<String> {
    let output = Command::new("git").args(args).output().ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8(output.stdout).ok()?.trim().to_owned())
}

fn is_commit(value: &str) -> bool {
    value.len() == 40 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}
