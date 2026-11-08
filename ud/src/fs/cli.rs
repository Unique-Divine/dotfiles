//! Clap command tree integrated into the built-in `ud` router.
use anyhow::Result;
use chrono::Utc;
use clap::{Args, Subcommand};
use std::path::PathBuf;

use super::{backend::Gcs, commands, config::Settings, listing, publish};

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
    /// Publish a named local file at /f/YY-MM/YYMMDD-name.ext.
    Publish(PublishArgs),
    /// List the current Bangkok month, or all dates under a directory.
    Ls(ListArgs),
    /// Search the index by text, tags, and date.
    Search(SearchArgs),
    /// Add or remove tags on files (keys or /f/ URLs).
    Tag(TagArgs),
    /// Set a file's Markdown description; TEXT "-" reads stdin.
    Desc(DescArgs),
    /// List tags with their live file counts.
    Tags(TagsArgs),
    /// Show recent index changes.
    Log(LogArgs),
    /// List documents under the backlink roots that link each file.
    Refs(RefsArgs),
    /// Delete files by key, URL, or tag; previews unless --yes.
    Rm(RmArgs),
    /// Maintain the index itself.
    Index(IndexArgs),
}

#[derive(Debug, Args)]
pub(crate) struct RefsArgs {
    /// Object keys or public /f/ URLs.
    #[arg(required = true)]
    pub targets: Vec<String>,
    /// Print structured JSON.
    #[arg(long)]
    pub json: bool,
}

/// Deletion always previews files, their tags, and their backlinks first.
#[derive(Debug, Args)]
pub(crate) struct RmArgs {
    /// Object keys or public /f/ URLs.
    #[arg(required_unless_present = "tag")]
    pub targets: Vec<String>,
    /// Delete every live file carrying all of these tags.
    #[arg(long)]
    pub tag: Vec<String>,
    /// Delete instead of previewing.
    #[arg(long)]
    pub yes: bool,
}

/// Full-text search over slug, description, source, and tags.
#[derive(Debug, Args)]
pub(crate) struct SearchArgs {
    /// Words that must all appear; omit to filter by tag or date only.
    pub query: Vec<String>,
    /// Require a tag; repeat or separate with commas.
    #[arg(long)]
    pub tag: Vec<String>,
    /// Publication date: YY, YYMM, YY-MM, YYMMDD, or YY-MM-DD.
    #[arg(long)]
    pub time: Option<String>,
    /// Include deleted files.
    #[arg(long)]
    pub deleted: bool,
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

/// Tag changes apply to every target in one index write.
#[derive(Debug, Args)]
pub(crate) struct TagArgs {
    /// Object keys or public /f/ URLs.
    #[arg(required = true)]
    pub targets: Vec<String>,
    /// Tags to add; repeat or separate with commas.
    #[arg(long)]
    pub add: Vec<String>,
    /// Tags to remove; repeat or separate with commas.
    #[arg(long)]
    pub rm: Vec<String>,
    /// Allow tags the index has never seen.
    #[arg(long)]
    pub new_tag: bool,
}

/// Descriptions are Markdown, stored verbatim.
#[derive(Debug, Args)]
pub(crate) struct DescArgs {
    /// Object key or public /f/ URL.
    pub target: String,
    /// Markdown text, or "-" to read stdin.
    pub text: String,
}

#[derive(Debug, Args)]
pub(crate) struct TagsArgs {
    /// Print structured JSON.
    #[arg(long)]
    pub json: bool,
}

#[derive(Debug, Args)]
pub(crate) struct LogArgs {
    /// Number of changes to show.
    #[arg(long, default_value_t = 20)]
    pub limit: usize,
    /// Print structured JSON.
    #[arg(long)]
    pub json: bool,
}

#[derive(Debug, Args)]
pub(crate) struct IndexArgs {
    #[command(subcommand)]
    pub command: IndexCommand,
}

#[derive(Debug, Subcommand)]
pub(crate) enum IndexCommand {
    /// Add bucket objects the index lacks and mark vanished ones deleted.
    Sync,
}

/// Upload arguments shared by validation and actual publication.
#[derive(Debug, Args)]
pub(crate) struct PublishArgs {
    /// Local regular file, at most 256 MiB.
    pub file: PathBuf,
    /// Flat name with an optional extension; folders are rejected.
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
    /// Validate and print without uploading; with --replace, sign in to
    /// report whether the target exists.
    #[arg(long)]
    pub dry_run: bool,
    /// Overwrite an existing object at the same URL and purge the CDN.
    #[arg(long)]
    pub replace: bool,
    /// Tags for grouping and search; repeat or separate with commas.
    #[arg(long)]
    pub tag: Vec<String>,
    /// Allow tags the index has never seen.
    #[arg(long)]
    pub new_tag: bool,
    /// Markdown description stored with the file.
    #[arg(long)]
    pub desc: Option<String>,
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
        FsCommand::Search(args) => commands::search(&args, &config),
        FsCommand::Tag(args) => commands::tag(&args, &config),
        FsCommand::Desc(args) => commands::desc(&args, &config),
        FsCommand::Tags(args) => commands::tags(&args, &config),
        FsCommand::Log(args) => commands::log(&args, &config),
        FsCommand::Refs(args) => commands::refs(&args, &config),
        FsCommand::Rm(args) => commands::rm(&args, &config),
        FsCommand::Index(args) => match args.command {
            IndexCommand::Sync => commands::sync(&config),
        },
    }
}
