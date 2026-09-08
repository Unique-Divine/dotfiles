use std::ffi::OsString;
use std::path::PathBuf;

use clap::{Args, Parser, Subcommand};

#[derive(Debug, Parser)]
#[command(
    name = "ud",
    version,
    about = "Run Unique's common development and workstation commands",
    disable_help_subcommand = true
)]
pub struct Cli {
    #[command(subcommand)]
    pub command: Option<Command>,
}

#[derive(Debug, Subcommand)]
pub enum Command {
    /// Run common Go workflows.
    Go(Nested<GoCommand>),
    /// Run common Rust and Cargo workflows.
    Rs(Nested<RustCommand>),
    /// Open or inspect Markdown files.
    Md(Nested<MarkdownCommand>),
    /// Manage Nibiru CLI configuration and local processes.
    Nibi(Nested<NibiCommand>),
    /// Manage Docker Desktop and containers under WSL.
    Docker(Nested<DockerCommand>),
    /// Diagnose local workstation tools.
    Health(Nested<HealthCommand>),
    /// Inspect executable ud plugins.
    Plugin(Nested<PluginCommand>),
    /// Run personal editing, navigation, and workstation shortcuts.
    #[command(alias = "q", alias = "cfg")]
    Quick(Nested<QuickCommand>),
    /// Show help for ud or one command path.
    #[command(alias = "h")]
    Help(HelpArgs),
    #[command(external_subcommand)]
    External(Vec<OsString>),
}

#[derive(Debug, Args)]
pub struct Nested<T: Subcommand> {
    #[command(subcommand)]
    pub command: Option<T>,
}

#[derive(Debug, Args)]
pub struct HelpArgs {
    /// Command path whose help should be displayed.
    pub command: Vec<String>,
}

#[derive(Debug, Args)]
pub struct CommandPreview {
    /// Print the underlying command without running it.
    #[arg(long)]
    pub cmd: bool,
}

#[derive(Debug, Subcommand)]
pub enum GoCommand {
    /// Run short Go tests.
    #[command(name = "test-short", alias = "ts")]
    TestShort(CommandPreview),
    /// Run Go integration tests.
    #[command(name = "test-int", alias = "ti")]
    TestIntegration(CommandPreview),
    /// Run all Go tests.
    #[command(alias = "t")]
    Test(CommandPreview),
    /// Run golangci-lint and apply fixes.
    Lint(CommandPreview),
    /// Run short tests and open an HTML coverage report.
    #[command(name = "cover-short", alias = "cs")]
    CoverShort(CommandPreview),
    /// Run all tests and open an HTML coverage report.
    #[command(alias = "c")]
    Cover(CommandPreview),
}

#[derive(Debug, Subcommand)]
pub enum RustCommand {
    /// Run tests for the current package when one is declared.
    #[command(name = "test-short", alias = "ts")]
    TestShort(CommandPreview),
    /// Run all Cargo tests.
    #[command(alias = "t")]
    Test(CommandPreview),
    /// Copy the shared rustfmt configuration and format the workspace.
    Fmt(CommandPreview),
    /// Build, lint, and format the workspace.
    Tidy(CommandPreview),
    /// Run Clippy and apply fixes.
    #[command(alias = "clippy")]
    Lint(CommandPreview),
    /// Run Clippy without changing files.
    #[command(name = "clippy-check")]
    ClippyCheck(CommandPreview),
}

#[derive(Debug, Subcommand)]
pub enum MarkdownCommand {
    /// Print installation details for the Markdown previewer.
    Show,
}

#[derive(Debug, Subcommand)]
pub enum NibiCommand {
    /// Set nibid to a known network.
    Cfg(Nested<NibiNetwork>),
    /// Print common Nibiru addresses from the environment.
    Addrs,
    /// Install the pinned nibid release.
    #[command(name = "get-nibid", alias = "gn")]
    GetNibid,
    /// Stop running nibid processes.
    Stop,
    /// Manage local Nibiru test keys.
    Keys(Nested<NibiKeysCommand>),
}

#[derive(Debug, Subcommand, Clone, Copy)]
pub enum NibiNetwork {
    /// Local Nibiru network.
    Local,
    /// Nibiru mainnet.
    Prod,
    /// Nibiru testnet.
    Test,
    /// Nibiru devnet.
    Dev,
}

#[derive(Debug, Subcommand)]
pub enum NibiKeysCommand {
    /// Recover a local test key from a mnemonic.
    #[command(
        name = "add-mnem",
        after_help = "The mnemonic is passed as a command argument and may be saved in shell history. This command uses the test keyring backend."
    )]
    AddMnemonic {
        /// Name for the local key.
        #[arg(long)]
        name: String,
        /// Mnemonic used to recover the local key.
        #[arg(long)]
        mnem: String,
    },
}

impl NibiKeysCommand {
    pub fn into_parts(self) -> (String, String) {
        match self {
            Self::AddMnemonic { name, mnem } => (name, mnem),
        }
    }
}

#[derive(Debug, Subcommand)]
pub enum DockerCommand {
    /// Stop containers and remove volumes for running Compose projects.
    #[command(name = "kill-all")]
    KillAll,
    /// Start Docker Desktop when it is not ready.
    Start,
    /// Stop Docker Desktop.
    Stop,
}

#[derive(Debug, Subcommand)]
pub enum HealthCommand {
    /// Diagnose gpg-agent and optionally restart it.
    Gpg {
        /// Restart gpg-agent and refresh its terminal binding.
        #[arg(long)]
        fix: bool,
    },
}

#[derive(Debug, Subcommand)]
pub enum PluginCommand {
    /// List built-in commands and installed plugins.
    List,
    /// Print validated metadata for one plugin.
    Info {
        /// Plugin command name without the ud- prefix.
        name: String,
    },
    /// Validate all plugins and discovery conflicts.
    Doctor,
}

#[derive(Debug, Subcommand)]
pub enum QuickCommand {
    /// Edit the dotfiles repository.
    Dotf(CommandPreview),
    /// Print the public IP and best-effort region.
    Ip,
    /// Open the personal music directory in Windows Explorer.
    Music(CommandPreview),
    /// Edit the notes workspace.
    Notes(CommandPreview),
    /// Edit ~/ki/out.txt.
    Out(CommandPreview),
    /// Create or replace a symbolic link.
    Symlink {
        /// Existing file or directory that the link points to.
        src: PathBuf,
        /// Path at which to create the link.
        dst: PathBuf,
    },
    /// Open the installed agent skills directory.
    Skills(CommandPreview),
    /// Edit the text TODO list.
    Todos(CommandPreview),
}
