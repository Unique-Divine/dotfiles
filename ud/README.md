# ud

`ud` is a personal command router for development and workstation tasks. The
public command tree is written in Rust. Clap generates command and subcommand
help from the Rust definitions.

```bash
ud --help
ud go --help
ud nibi keys add-mnem --help
```

Run the checkout without installing it:

```bash
just ud --help
```

Install or refresh `~/.local/bin/ud`:

```bash
just ud-install
```

`just sync` also installs the current binary. `just health` checks that the
installed binary matches the current source fingerprint.

## Shell operations

Rust owns argument parsing, validation, help, plugin discovery, and ordinary
process execution. File `zsh/ud/shell.sh` retains operations that depend on the
personal shell setup or WSL:

- personal shortcuts from `zsh/quick.sh`
- Docker Desktop and Docker Compose operations
- local Nibiru mnemonic import
- the pinned `nibid` installer pipeline

The shell file is internal. Run these operations through `ud`, which validates
the command before invoking the helper.

## Executable plugins

A plugin is an executable named `ud-<command>`. It may be a native binary or a
script with a valid shebang. The dispatcher searches
`${XDG_DATA_HOME:-$HOME/.local/share}/ud/plugins`, followed by the directories
in `UD_PLUGIN_PATH`. It does not search the current directory or general
`PATH`.

```bash
ud plugin list
ud plugin info evm
ud plugin doctor
ud evm --help
```

Each plugin implements `--plugin-info` and prints JSON with `apiVersion`,
`name`, and `description`. API version 1 is the current contract. Rust validates
and caches this metadata without requiring `jq`.

## Local health checks

```bash
ud health gpg
ud health gpg --fix
```

The GPG command delegates to `bin/gpg-agent-doctor`. Diagnosis does not read the
password store. The explicit `--fix` flag restarts the agent and clears cached
passphrases.

## Symbolic links

Command `ud q symlink <src> <dst>` creates the destination parent and then
creates or replaces the symbolic link. Relative source paths remain relative
to the destination link.

```bash
ud q symlink ../ai-skills .agents/skills
```
