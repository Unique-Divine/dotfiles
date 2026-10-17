//! Clap command tree integrated into the built-in `ud` router.
use anyhow::Result;
use chrono::Utc;
use clap::{Args, Subcommand};
use std::path::PathBuf;

use super::{backend::Gcs, config::Settings, listing, publish};

/// Explicit subcommands prevent accidental publishing of a positional filename.
#[derive(Debug, Args)]
#[command(after_help = "Publish with: ud fs publish FILE NAME")]
pub(crate) struct FsArgs {
    #[command(subcommand)]
    pub command: Option<FsCommand>,
}

/// File operations; listing reads metadata and publishing is always explicit.
#[derive(Debug, Subcommand)]
pub(crate) enum FsCommand {
    /// Publish a named local file at /f/YY/DIRS/YYMMDD-name.ext.
    Publish(PublishArgs),
    /// List the current Bangkok month, or all dates under a directory.
    Ls(ListArgs),
}

/// Upload arguments shared by validation and actual publication.
#[derive(Debug, Args)]
pub(crate) struct PublishArgs {
    /// Local regular file, at most 256 MiB.
    pub file: PathBuf,
    /// Name with optional semantic directories and extension.
    pub slug: String,
    /// Override date using YYYY-MM-DD.
    #[arg(long)]
    pub date: Option<String>,
    /// Print/copy an HTML img tag or Markdown file link.
    #[arg(long)]
    pub md: bool,
    /// Print output without copying it to the clipboard.
    #[arg(long)]
    pub no_clipboard: bool,
    /// Validate and print without uploading or signing in.
    #[arg(long)]
    pub dry_run: bool,
}

/// Mutually exclusive filters and formats fail during parsing, before login.
#[derive(Debug, Args)]
pub(crate) struct ListArgs {
    /// Safe relative directory to list recursively.
    #[arg(default_value = "")]
    pub directory: String,
    /// Include every date, including undated files.
    #[arg(long, conflicts_with = "time")]
    pub all: bool,
    /// Publication date: YY, YYMM, YY-MM, YYMMDD, or YY-MM-DD.
    #[arg(long)]
    pub time: Option<String>,
    /// Print structured JSON.
    #[arg(long, group = "format")]
    pub json: bool,
    /// Print one public URL per line.
    #[arg(long, group = "format")]
    pub urls: bool,
    /// Print one object path per line.
    #[arg(long, group = "format")]
    pub paths: bool,
}

/// Validate local input before any backend can obtain credentials or
/// transfer data.
pub(crate) fn run(args: FsArgs) -> Result<()> {
    let config = Settings::load()?;
    match args.command.expect("router handles bare fs help") {
        FsCommand::Publish(args) => publish::run(&args, &config),
        FsCommand::Ls(args) => {
            let scope = listing::selection(
                &args.directory,
                args.time.as_deref(),
                args.all,
                Utc::now(),
            )?;
            if scope.implicit {
                let date = scope.date.as_ref().expect("implicit month");
                eprintln!(
                    "Showing publication month {}-{}; use --all for the full collection.",
                    &date[..2],
                    &date[2..]
                );
            }
            let records =
                listing::filter(Gcs::new(&config)?.list(&scope.prefix)?, &scope);
            let format = if args.json {
                "json"
            } else if args.urls {
                "urls"
            } else if args.paths {
                "paths"
            } else {
                "toon"
            };
            let output = listing::output(&records, format)?;
            if !output.is_empty() {
                println!("{output}");
            }
            Ok(())
        }
    }
}
