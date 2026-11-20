//! `ud lint just`: recipe doc comments in justfiles.
//!
//! `just --list` shows only the one `#` line directly above a recipe, so a
//! multi-line doc comment truncates the recipe's help. Public recipes with
//! no doc comment list with no description at all.

use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use regex::Regex;

use super::{Finding, Palette, Severity, format_finding, summary};

/// Directories never searched for justfiles.
const SKIP_DIRS: &[&str] = &[".git", "node_modules", "target", "vendor"];

/// Lines that start with these words are not recipes.
const KEYWORDS: &[&str] =
    &["alias", "set", "import", "mod", "export", "unexport"];

pub(crate) fn is_justfile_name(name: &str) -> bool {
    matches!(name, "justfile" | "Justfile" | ".justfile")
        || name.ends_with(".just")
}

/// The recipe name when `line` is a column-0 recipe header.
pub(crate) fn recipe_name(line: &str) -> Option<&str> {
    let body = line.strip_prefix('@').unwrap_or(line);
    let end = body
        .char_indices()
        .find(|&(i, c)| {
            !(c.is_ascii_alphanumeric() || c == '_' || (c == '-' && i > 0))
        })
        .map_or(body.len(), |(i, _)| i);
    let name = &body[..end];
    let first = name.chars().next()?;
    if !(first.is_ascii_alphabetic() || first == '_') {
        return None;
    }
    let rest = &body[end..];
    if KEYWORDS.contains(&name)
        && (rest.starts_with(' ') || rest.starts_with('?'))
    {
        return None;
    }
    header_colon(rest).map(|_| name)
}

/// Index of the colon ending a recipe header, skipping quoted text and the
/// `:=` of an assignment.
fn header_colon(rest: &str) -> Option<usize> {
    let bytes = rest.as_bytes();
    let mut quote: Option<u8> = None;
    for (i, &b) in bytes.iter().enumerate() {
        match quote {
            Some(q) if b == q => quote = None,
            Some(_) => {}
            None if b == b'"' || b == b'\'' || b == b'`' => quote = Some(b),
            None if b == b':' => {
                return (bytes.get(i + 1) != Some(&b'=')).then_some(i);
            }
            None if b == b'=' && i == 0 => return None,
            None => {}
        }
    }
    None
}

fn attr_names_private(attr: &str) -> bool {
    attr.trim_start_matches('[')
        .trim_end_matches(']')
        .split(',')
        .any(|part| part.trim() == "private")
}

/// Findings for one justfile's text.
pub(crate) fn check_text(path: &Path, text: &str) -> Vec<Finding> {
    let mut findings = Vec::new();
    // 0-based indexes of the comment block and attributes above a line.
    let mut comments: Vec<usize> = Vec::new();
    let mut attrs: Vec<&str> = Vec::new();
    for (index, line) in text.lines().enumerate() {
        let line = line.trim_end();
        if line.is_empty()
            || line.starts_with(' ')
            || line.starts_with('\t')
            || line.starts_with("#!")
        {
            comments.clear();
            attrs.clear();
            continue;
        }
        if line.starts_with('#') {
            comments.push(index);
            continue;
        }
        if line.starts_with('[') {
            attrs.push(line);
            continue;
        }
        if let Some(name) = recipe_name(line) {
            if comments.len() >= 2 {
                findings.push(Finding {
                    path: path.to_owned(),
                    line: comments[0] + 1,
                    severity: Severity::Error,
                    code: "doc-comment-lines",
                    message: format!(
                        "recipe \"{name}\" has {} comment lines above it; \
                         just --list shows only the last. Join them into \
                         one line.",
                        comments.len()
                    ),
                });
            }
            let documented =
                !comments.is_empty() || attrs.iter().any(|a| a.contains("doc("));
            let private = name.starts_with('_')
                || attrs.iter().any(|a| attr_names_private(a));
            if !documented && !private {
                findings.push(Finding {
                    path: path.to_owned(),
                    line: index + 1,
                    severity: Severity::Info,
                    code: "missing-doc",
                    message: format!(
                        "public recipe \"{name}\" has no doc comment; \
                         just --list shows no description"
                    ),
                });
            }
        }
        comments.clear();
        attrs.clear();
    }
    findings
}

/// Translate a shell glob into an anchored regex: `**/` spans directories,
/// `*` and `?` stay within one path segment.
pub(crate) fn glob_regex(glob: &str) -> Regex {
    let mut out = String::from("^");
    let chars: Vec<char> = glob.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        match c {
            '*' if chars.get(i + 1) == Some(&'*') => {
                if chars.get(i + 2) == Some(&'/') {
                    out.push_str("(?:.*/)?");
                    i += 3;
                } else {
                    out.push_str(".*");
                    i += 2;
                }
                continue;
            }
            '*' => out.push_str("[^/]*"),
            '?' => out.push_str("[^/]"),
            '[' => match chars[i..].iter().position(|&c| c == ']') {
                Some(len) => {
                    let class: String = chars[i + 1..i + len].iter().collect();
                    let class = class
                        .strip_prefix('!')
                        .map_or(class.clone(), |rest| format!("^{rest}"));
                    out.push('[');
                    out.push_str(&class);
                    out.push(']');
                    i += len + 1;
                    continue;
                }
                None => out.push_str("\\["),
            },
            _ => out.push_str(&regex::escape(&c.to_string())),
        }
        i += 1;
    }
    out.push('$');
    Regex::new(&out).expect("glob regex is valid")
}

fn is_glob(arg: &str) -> bool {
    arg.contains(['*', '?', '['])
}

/// Every file under `dir`, skipping [`SKIP_DIRS`]; `filter` picks names.
fn walk(dir: &Path, filter: &dyn Fn(&str) -> bool, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut entries: Vec<_> = entries.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        let path = entry.path();
        if kind.is_dir() {
            if !SKIP_DIRS.contains(&name.as_str()) {
                walk(&path, filter, out);
            }
        } else if filter(&name) && path.is_file() {
            // is_file follows symlinks: a link to a file counts, a link to a
            // directory (boku's `priv-skills/justfile` skill) does not.
            out.push(path);
        }
    }
}

/// Drop files git ignores, asking each file's own repository.
fn drop_ignored(files: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut by_dir: BTreeMap<PathBuf, Vec<PathBuf>> = BTreeMap::new();
    for file in files {
        let dir = file.parent().map_or_else(
            || PathBuf::from("."),
            |p| {
                if p.as_os_str().is_empty() {
                    PathBuf::from(".")
                } else {
                    p.to_owned()
                }
            },
        );
        by_dir.entry(dir).or_default().push(file);
    }
    let mut kept = Vec::new();
    for (dir, files) in by_dir {
        let ignored = git_ignored(&dir, &files);
        kept.extend(files.into_iter().filter(|f| {
            let name = f.file_name().unwrap_or_default();
            !ignored.iter().any(|i| i.as_os_str() == name)
        }));
    }
    kept
}

/// Names under `dir` that `git check-ignore` reports; empty outside git.
fn git_ignored(dir: &Path, files: &[PathBuf]) -> Vec<PathBuf> {
    let Ok(mut child) = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(["check-ignore", "--stdin"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    else {
        return Vec::new();
    };
    if let Some(mut stdin) = child.stdin.take() {
        for file in files {
            if let Some(name) = file.file_name() {
                let _ = writeln!(stdin, "{}", name.to_string_lossy());
            }
        }
    }
    match child.wait_with_output() {
        Ok(out) if out.status.code() == Some(0) => {
            String::from_utf8_lossy(&out.stdout)
                .lines()
                .map(PathBuf::from)
                .collect()
        }
        _ => Vec::new(),
    }
}

/// Resolve arguments to justfiles. Errors name the argument that matched
/// nothing.
pub(crate) fn collect(args: &[PathBuf]) -> Result<Vec<PathBuf>, String> {
    let args: Vec<PathBuf> = if args.is_empty() {
        vec![PathBuf::from(".")]
    } else {
        args.to_vec()
    };
    let mut files = Vec::new();
    for arg in &args {
        let text = arg.to_string_lossy();
        if arg.is_file() {
            files.push(arg.clone());
        } else if arg.is_dir() {
            let mut found = Vec::new();
            walk(arg, &is_justfile_name, &mut found);
            files.extend(drop_ignored(found));
        } else if is_glob(&text) {
            let base: PathBuf = arg
                .components()
                .take_while(|c| !is_glob(&c.as_os_str().to_string_lossy()))
                .collect();
            let base = if base.as_os_str().is_empty() {
                PathBuf::from(".")
            } else {
                base
            };
            let pattern = glob_regex(text.strip_prefix("./").unwrap_or(&text));
            let mut found = Vec::new();
            walk(&base, &|_| true, &mut found);
            let matched: Vec<PathBuf> = found
                .into_iter()
                .filter(|p| {
                    let shown = p.to_string_lossy();
                    pattern.is_match(shown.strip_prefix("./").unwrap_or(&shown))
                })
                .collect();
            if matched.is_empty() {
                return Err(format!("glob matched no files: {text}"));
            }
            files.extend(matched);
        } else {
            return Err(format!("no such file or directory: {text}"));
        }
    }
    files.sort();
    files.dedup();
    if files.is_empty() {
        let shown: Vec<_> = args
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        return Err(format!("no justfiles found under {}", shown.join(", ")));
    }
    Ok(files)
}

/// Lint `args` and print findings; returns the exit code.
pub(crate) fn run(args: &[PathBuf], hide_info: bool, palette: &Palette) -> i32 {
    let files = match collect(args) {
        Ok(files) => files,
        Err(message) => {
            eprintln!("ud lint just: {message}");
            return 2;
        }
    };
    let mut findings = Vec::new();
    for file in &files {
        match fs::read_to_string(file) {
            Ok(text) => findings.extend(check_text(file, &text)),
            Err(error) => {
                eprintln!("ud lint just: {}: {error}", file.display());
                return 2;
            }
        }
    }
    for finding in &findings {
        if hide_info && finding.severity == Severity::Info {
            continue;
        }
        println!("{}", format_finding(finding, palette));
    }
    println!("{}", summary(files.len(), &findings, "justfile", palette));
    i32::from(findings.iter().any(|f| f.severity == Severity::Error))
}
