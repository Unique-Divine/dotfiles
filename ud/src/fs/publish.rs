//! Publishing reserves stdout for verified success and treats copying as optional.
use anyhow::{Context, Result, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use chrono::Utc;
use md5::{Digest, Md5};
use std::{
    fs::File,
    io::{Read, Write},
    path::PathBuf,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

use super::{
    backend::Gcs,
    cli::PublishArgs,
    config::Settings,
    naming::{self, Plan},
};

/// Escape all HTML attribute delimiters, including apostrophes as Python did.
fn html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#x27;")
}

/// Render the destination type, without pretending an extension converts bytes.
pub(super) fn output(plan: &Plan, markdown: bool) -> String {
    if !markdown {
        plan.url.clone()
    } else if naming::is_image(&plan.key) {
        format!(
            "<img src=\"{}\" alt=\"{}\" />",
            html(&plan.url),
            html(&plan.label)
        )
    } else {
        format!("[{}]({})", plan.label, plan.url)
    }
}

/// Stream the file to avoid allocating the full 256 MiB upload allowance.
pub(super) fn checksum(file: &std::path::Path) -> Result<String> {
    let mut source = File::open(file)?;
    let mut digest = Md5::new();
    let mut buffer = [0; 64 * 1024];
    loop {
        let count = source.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok(STANDARD.encode(digest.finalize()))
}

/// Locate only explicit clipboard programs on PATH; missing support is
/// harmless.
fn clipboard_program() -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for name in ["clip.exe", "pbcopy"] {
        for directory in std::env::split_paths(&path) {
            let candidate = directory.join(name);
            use std::os::unix::fs::PermissionsExt;
            if candidate.metadata().is_ok_and(|m| {
                m.is_file() && m.permissions().mode() & 0o111 != 0
            }) {
                return Some(candidate);
            }
        }
    }
    None
}

/// Reap a failing or timed-out clipboard process without changing upload
/// success.
pub(super) fn copy(
    program: &std::path::Path,
    text: &str,
    timeout: Duration,
) -> Result<()> {
    let mut child = Command::new(program)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    let write = child
        .stdin
        .take()
        .context("clipboard stdin missing")?
        .write_all(text.as_bytes());
    if let Err(error) = write {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error.into());
    }
    let start = Instant::now();
    loop {
        if let Some(status) = child.try_wait()? {
            ensure!(status.success(), "Clipboard command failed");
            return Ok(());
        }
        if start.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            anyhow::bail!("Clipboard command timed out");
        }
        thread::sleep(Duration::from_millis(10));
    }
}

/// Dry runs stop before client creation, authentication, checksumming or
/// upload.
pub(super) fn run(args: &PublishArgs, config: &Settings) -> Result<()> {
    let plan = naming::plan(
        &args.file,
        &args.slug,
        args.date.as_deref(),
        &config.base_url,
        Utc::now(),
    )?;
    let text = output(&plan, args.md);
    if args.dry_run {
        println!("{text}");
        return Ok(());
    }
    let backend = Gcs::new(config)?;
    backend.upload(&plan.file, &plan.key, &checksum(&plan.file)?)?;
    backend.verify(&plan.url, plan.file.metadata()?.len()).with_context(|| {
        format!("Uploaded {}, but public verification failed. The object remains in storage", plan.key)
    })?;
    println!("{text}");
    std::io::stdout().flush()?;
    if !args.no_clipboard
        && let Some(program) = clipboard_program()
        && copy(&program, &text, Duration::from_secs(5)).is_err()
    {
        eprintln!(
            "Published successfully; clipboard copy failed. Use the output above."
        );
    }
    Ok(())
}
