mod app;

use std::path::PathBuf;
use std::process::ExitCode;

use app::{
    arrange, notify_failure, resolve_target, CliTarget, Direction, HerdrError,
};
use clap::{Parser, Subcommand};

#[derive(Debug, Parser)]
#[command(name = "herdr-tmux", about = "tmux-style layout commands for Herdr")]
struct Cli {
    /// Override HERDR_SOCKET_PATH (primarily for development and tests).
    #[arg(long, global = true)]
    socket_path: Option<PathBuf>,
    /// Override Herdr's current tab ID.
    #[arg(long, global = true)]
    tab_id: Option<String>,
    /// Override Herdr's current pane ID.
    #[arg(long, global = true)]
    pane_id: Option<String>,
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    Layout {
        #[command(subcommand)]
        layout: Layout,
    },
}

#[derive(Debug, Subcommand)]
enum Layout {
    EvenVertical,
    EvenHorizontal,
}

impl From<Layout> for Direction {
    fn from(value: Layout) -> Self {
        match value {
            Layout::EvenVertical => Self::Down,
            Layout::EvenHorizontal => Self::Right,
        }
    }
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    let target = match resolve_target(CliTarget {
        socket_path: cli.socket_path,
        tab_id: cli.tab_id,
        pane_id: cli.pane_id,
    }) {
        Ok(target) => target,
        Err(error) => return fail(None, error),
    };
    let direction = match cli.command {
        Command::Layout { layout } => layout.into(),
    };
    match arrange(&target, direction) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => fail(Some(&target), error),
    }
}

fn fail(target: Option<&app::Target>, error: HerdrError) -> ExitCode {
    if let Some(target) = target {
        notify_failure(target, &error);
    }
    eprintln!("herdr-tmux: {error}");
    ExitCode::FAILURE
}
