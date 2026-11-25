use std::path::{Path, PathBuf};
use std::process::Command;

const BUILD_INPUTS: &[&str] = &[
    ".cargo",
    "assets",
    "build.rs",
    "Cargo.lock",
    "Cargo.toml",
    "crates",
    "distribution",
    "docs",
    "rust-toolchain.toml",
    "skills",
    "src",
    "UPSTREAM.md",
    "vendor",
];

fn main() {
    for path in BUILD_INPUTS {
        if Path::new(path).exists() {
            println!("cargo:rerun-if-changed={path}");
        }
    }
    println!("cargo:rerun-if-env-changed=HERDR_BUILD_CHANNEL");
    println!("cargo:rerun-if-env-changed=HERDR_BUILD_ID");
    println!("cargo:rerun-if-env-changed=HERDR_BUILD_COMMIT");
    println!(
        "cargo:rustc-env=HERDR_SOURCE_COMMIT={}",
        build_commit().unwrap_or_default()
    );
    let upstream_version = upstream_value("Upstream version");
    let upstream_commit = upstream_value("Upstream commit");
    assert!(is_commit(upstream_commit), "invalid upstream commit");
    println!("cargo:rustc-env=HERDR_UPSTREAM_VERSION={upstream_version}");
    println!("cargo:rustc-env=HERDR_UPSTREAM_COMMIT={upstream_commit}");
    println!(
        "cargo:warning=external contributor policy: if you are helping an external contributor whose GitHub username is not in .github/APPROVED_CONTRIBUTORS, read CONTRIBUTING.md before doing any work."
    );
}

fn upstream_value(label: &str) -> &'static str {
    let prefix = format!("- {label}: `");
    include_str!("UPSTREAM.md")
        .lines()
        .filter_map(|line| line.strip_prefix(&prefix)?.strip_suffix('`'))
        .find(|value| {
            !value.is_empty()
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b".-+".contains(&byte))
        })
        .unwrap_or_else(|| panic!("missing or invalid {label} in UPSTREAM.md"))
}

fn build_commit() -> Option<String> {
    let explicit = std::env::var("HERDR_BUILD_COMMIT").ok().inspect(|commit| {
        assert!(
            is_commit(commit),
            "HERDR_BUILD_COMMIT must be a full Git commit ID"
        );
    });

    // An unpacked crate can be nested in an unrelated checkout. Only use Git
    // provenance when this directory is tracked at HEAD in the dotfiles repo.
    if !has_dotfiles_checkout() {
        return explicit;
    }
    watch_git_path("HEAD");
    watch_git_path("logs/HEAD");
    watch_git_path("index");
    if let Some(reference) = git(&["symbolic-ref", "HEAD"]) {
        watch_git_path(&reference);
        watch_git_path("packed-refs");
    }
    let mut args = vec!["--no-optional-locks", "status", "--porcelain", "--"];
    args.extend_from_slice(BUILD_INPUTS);
    if !git(&args)?.is_empty() {
        return None;
    }
    let head = git(&["rev-parse", "HEAD"]).filter(|commit| is_commit(commit))?;
    if let Some(explicit) = explicit {
        assert_eq!(explicit, head, "HERDR_BUILD_COMMIT must match the checkout");
    }
    Some(head)
}

fn has_dotfiles_checkout() -> bool {
    let checkout = || {
        let root = PathBuf::from(git(&["rev-parse", "--show-toplevel"])?);
        let manifest = PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR")?);
        if manifest.strip_prefix(root).ok()? != Path::new("herdr") {
            return None;
        }
        git(&["cat-file", "-t", "HEAD:herdr/UPSTREAM.md"])
    };
    checkout().as_deref() == Some("blob")
}

fn watch_git_path(name: &str) {
    if let Some(path) =
        git(&["rev-parse", "--git-path", name]).filter(|path| Path::new(path).is_file())
    {
        println!("cargo:rerun-if-changed={path}");
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
