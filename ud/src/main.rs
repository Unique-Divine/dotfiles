mod cli;
mod commands;
mod plugin;
mod process;

use std::env;
use std::ffi::OsString;
use std::process::exit;

use anyhow::{Context, Result, anyhow};
use clap::{CommandFactory, FromArgMatches};

use crate::cli::{Cli, Command};

fn main() {
    let code = match run() {
        Ok(code) => code,
        Err(error) => {
            eprintln!("Error: {error:#}");
            1
        }
    };
    exit(code);
}

fn run() -> Result<i32> {
    let mut args = env::args_os().collect::<Vec<_>>();
    normalize_legacy_help(&mut args);
    let include_plugins = wants_root_help(&args);
    let mut clap_command = command_with_plugins(include_plugins);
    let matches = clap_command.clone().get_matches_from(args);
    let cli =
        Cli::from_arg_matches(&matches).context("failed to parse ud command")?;

    match cli.command {
        None => {
            print_help(&mut clap_command)?;
            Ok(0)
        }
        Some(Command::Help(help)) => {
            print_help_path(&mut clap_command, &help.command)?;
            Ok(0)
        }
        Some(Command::Go(args)) => match args.command {
            Some(command) => commands::run_go(command),
            None => print_nested_help(clap_command, &["go"]),
        },
        Some(Command::Rs(args)) => match args.command {
            Some(command) => commands::run_rust(command),
            None => print_nested_help(clap_command, &["rs"]),
        },
        Some(Command::Md(args)) => match args.command {
            Some(command) => Ok(commands::run_markdown(command)),
            None => print_nested_help(clap_command, &["md"]),
        },
        Some(Command::Nibi(args)) => match args.command {
            Some(crate::cli::NibiCommand::Cfg(cfg)) if cfg.command.is_none() => {
                print_nested_help(clap_command, &["nibi", "cfg"])
            }
            Some(crate::cli::NibiCommand::Keys(keys))
                if keys.command.is_none() =>
            {
                print_nested_help(clap_command, &["nibi", "keys"])
            }
            Some(command) => commands::run_nibi(command),
            None => print_nested_help(clap_command, &["nibi"]),
        },
        Some(Command::Docker(args)) => match args.command {
            Some(command) => commands::run_docker(command),
            None => print_nested_help(clap_command, &["docker"]),
        },
        Some(Command::Health(args)) => match args.command {
            Some(command) => commands::run_health(command),
            None => print_nested_help(clap_command, &["health"]),
        },
        Some(Command::Plugin(args)) => match args.command {
            Some(crate::cli::PluginCommand::List) => {
                plugin::list()?;
                Ok(0)
            }
            Some(crate::cli::PluginCommand::Info { name }) => {
                plugin::info(&name)?;
                Ok(0)
            }
            Some(crate::cli::PluginCommand::Doctor) => {
                plugin::doctor()?;
                Ok(0)
            }
            None => print_nested_help(clap_command, &["plugin"]),
        },
        Some(Command::Quick(args)) => match args.command {
            Some(command) => commands::run_quick(command),
            None => print_nested_help(clap_command, &["quick"]),
        },
        Some(Command::External(args)) => dispatch_external(args),
    }
}

fn command_with_plugins(include_plugins: bool) -> clap::Command {
    let mut command = Cli::command();
    if include_plugins {
        let plugin_help = plugin::help_text();
        if !plugin_help.is_empty() {
            command = command.after_help(plugin_help);
        }
    }
    command
}

fn wants_root_help(args: &[OsString]) -> bool {
    match args.get(1).and_then(|arg| arg.to_str()) {
        None | Some("-h" | "--help") => true,
        Some("help" | "h") => args.len() == 2,
        _ => false,
    }
}

fn normalize_legacy_help(args: &mut [OsString]) {
    if args.len() <= 2 {
        return;
    }
    let path = args[1..args.len() - 1]
        .iter()
        .filter_map(|arg| arg.to_str())
        .collect::<Vec<_>>();
    let supports_help_word = matches!(
        path.as_slice(),
        ["go"]
            | ["rs"]
            | ["md"]
            | ["nibi"]
            | ["docker"]
            | ["health"]
            | ["plugin"]
            | ["quick"]
            | ["q"]
            | ["cfg"]
            | ["health", "gpg"]
            | ["nibi", "cfg"]
            | ["nibi", "keys"]
            | ["nibi", "keys", "add-mnem"]
    );
    if supports_help_word
        && args.last().and_then(|arg| arg.to_str()) == Some("help")
    {
        let last = args.len() - 1;
        args[last] = OsString::from("--help");
    }
}

fn print_help(command: &mut clap::Command) -> Result<()> {
    command.print_help()?;
    println!();
    Ok(())
}

fn print_help_path(command: &mut clap::Command, path: &[String]) -> Result<()> {
    let refs = path.iter().map(String::as_str).collect::<Vec<_>>();
    print_help_for_path(command, &refs)
}

fn print_nested_help(mut command: clap::Command, path: &[&str]) -> Result<i32> {
    print_help_for_path(&mut command, path)?;
    Ok(0)
}

fn print_help_for_path(
    command: &mut clap::Command,
    path: &[&str],
) -> Result<()> {
    let mut current = command;
    for segment in path {
        current = current.find_subcommand_mut(segment).ok_or_else(|| {
            anyhow!("unknown help command: {}", path.join(" "))
        })?;
    }
    print_help(current)
}

fn dispatch_external(mut args: Vec<OsString>) -> Result<i32> {
    let name = args
        .first()
        .cloned()
        .context("missing external command name")?;
    args.remove(0);
    plugin::dispatch(&name, &args)
}
