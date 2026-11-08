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

/// Describe what `--replace` finds at the target, for stderr only.
pub(super) fn target_note(key: &str, existing: Option<u64>) -> String {
    match existing {
        Some(size) => format!(
            "Target exists: {key} ({size} bytes); --replace overwrites it."
        ),
        None => format!(
            "Target does not exist: {key}; --replace publishes it as new."
        ),
    }
}

/// Highest `-N` suffix tried before publishing gives up on a name.
pub(super) const MAX_NUMBER: u32 = 9;

/// Create the first free name among `slug`, `slug-2` … `slug-9`. Every
/// attempt carries the absent-object precondition, so nothing is overwritten.
/// Only after a refusal does a metadata read decide whether the name was
/// taken; if that read fails, the original upload error is reported.
fn upload_numbered(
    backend: &Gcs,
    plan: &Plan,
    digest: &str,
    origin: &str,
) -> Result<Plan> {
    for number in 1..=MAX_NUMBER {
        let candidate = plan.numbered(number, origin)?;
        match backend.upload(&candidate.file, &candidate.key, digest, false) {
            Ok(()) => {
                if number > 1 {
                    eprintln!(
                        "{} exists; published as {}",
                        plan.key, candidate.key
                    );
                }
                return Ok(candidate);
            }
            Err(error) => {
                if !matches!(backend.existing_size(&candidate.key), Ok(Some(_)))
                {
                    return Err(error);
                }
            }
        }
    }
    anyhow::bail!(
        "{} and its -2 to -{MAX_NUMBER} alternatives exist; choose another slug",
        plan.key
    )
}

/// Dry runs stop before checksumming or upload; only `--replace` signs in
/// to check the target.
pub(super) fn run(args: &PublishArgs, config: &Settings) -> Result<()> {
    let plan = naming::plan(
        &args.file,
        &args.slug,
        args.date.as_deref(),
        &config.base_url,
        Utc::now(),
    )?;
    let text = output(&plan, args.md);
    if args.dry_run && !args.replace {
        println!("{text}");
        return Ok(());
    }
    let backend = Gcs::new(config)?;
    let existing = if args.replace {
        let existing = backend.existing_size(&plan.key)?;
        eprintln!("{}", target_note(&plan.key, existing));
        existing
    } else {
        None
    };
    if args.dry_run {
        println!("{text}");
        return Ok(());
    }
    let digest = checksum(&plan.file)?;
    let plan = if args.replace {
        backend.upload(&plan.file, &plan.key, &digest, true)?;
        plan
    } else {
        upload_numbered(&backend, &plan, &digest, &config.base_url)?
    };
    let text = output(&plan, args.md);
    if existing.is_some() {
        backend.purge_cdn(&plan.key).with_context(|| {
            format!("Replaced {}, but the CDN purge failed. Cached copies expire within five minutes", plan.key)
        })?;
        backend.verify_digest(&plan.url, &digest).with_context(|| {
            format!("Replaced {}, but the public URL does not serve the new bytes yet", plan.key)
        })?;
    } else {
        backend.verify(&plan.url, plan.file.metadata()?.len()).with_context(|| {
            format!("Uploaded {}, but public verification failed. The object remains in storage", plan.key)
        })?;
    }
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
