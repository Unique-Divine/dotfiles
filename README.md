# Dotfiles - Unique Divine

My personal development environment configuration optimized for Ubuntu 24.04 and
WSL, designed to provide a consistent and easily reproducible experience across
machines.

<h2>Table of Contents</h2>

- [What's Included](#whats-included)
- [Quick Setup](#quick-setup)
- [Symlink Philosophy](#symlink-philosophy)
- [Features](#features)
  - [Sync and health checks](#sync-and-health-checks)
  - [AI agent skills](#ai-agent-skills)
  - [Neovim Configuration](#neovim-configuration)
  - [Terminal Environment: tmux, zsh, bun](#terminal-environment-tmux-zsh-bun)
  - [Herdr configuration](#herdr-configuration)
  - [Codex config](#codex-config)
  - [WSL Clipboard Integration](#wsl-clipboard-integration)
- [Requirements](#requirements)
- [Testing](#testing)
- [Benchmark log](benchmarks.md)

## What's Included

- **Neovim**: Lua configuration with LSP, treesitter, and WSL clipboard integration
- **Tmux**: Terminal multiplexer with Vim-style navigation and session persistence
- **Zsh**: Shell configuration with Oh-My-Zsh, aliases, and developer tooling setup
- **Bash**: Utility scripts, color-coded logging, and environment detection
- **WSL Integration**: Seamless clipboard sharing between Ubuntu and Windows

## Quick Setup

```bash
# Clone the repository
git clone https://github.com/Unique-Divine/dotfiles.git
cd dotfiles

# Install system packages used by the shell and Neovim.
# - build-essential: Used in almost everything
# - gh: GitHub CLI
# - libclang-dev: Needed so `cargo install tree-sitter-cli` can build.
# - tree-sitter-cli: Required by `nvim-treesitter` on the `main` branch.
# - wslu: Provides `wslview` (Example: gh pr view --web). This fixes the error,
#   > exec: "xdg-open,x-www-browser,www-browser,wslview": executable file not found in $PATH

sudo apt install build-essential ripgrep gh libclang-dev wslu

# This might be different for you. The command comes from here:
# https://rustup.rs/
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
cargo install just
cargo install bat tree-sitter-cli sd

# Homebrew/Linuxbrew must be on PATH, then install formulas from Brewfile.
just i-brew

# Create and repair symbolic links for configurations.
# just sync also installs the Zinit checkout.
just sync

# Install development tools
bun install
just setup
```

After installing `nvim`, restore Neovim plugins from the lazy.nvim lockfile:

```bash
nvim --headless "+Lazy! restore" +qa
```

## Symlink Philosophy

This dotfiles repo uses symbolic links to maintain a single source of truth for all configurations. The advantages of this approach include:

- **Version control**: Track changes to your configurations over time
- **Portability**: Quickly set up identical environments across machines
- **Centralization**: Modify configs in one place and have changes propagate
- **Safety**: Original system files aren't modified, only linked to
- **Maintenance**: Updates to the repo instantly apply to all linked machines

[`zsh/managed-links.tsv`](zsh/managed-links.tsv) is the source of truth for
managed symbolic links. `just sync` runs `symlinks.sh` to create or repair each
mapping; `just health` validates the same mappings without writing state.

## Features

### Sync and health checks

`just sync` runs the established shell bootstrap, applies portable Codex
defaults, and synchronizes managed AI skills. `just health` does not write: it
checks required commands and reports Codex or skills-sync drift with a nonzero
exit status.

### AI agent skills

Public skills are distributed from Unique-Divine/jiyuu under `jiyuu/ai-skills`
and omit `metadata.private`. Private skills are real directories in
`boku/priv-skills` and require `metadata.private: true`. Team skills can also
live canonically under a source repository's `ai-skills/` directory.
`just skills-sync --run` makes `priv-skills` a flat union by linking each
configured public or repository-owned skill into it, then links both
`$HOME/.cursor/skills` and `$HOME/.agents/skills` to that union. Repository-owned sources also expose a
relative `.agents/skills` discovery link for teammates. Edit a skill through
either agent or its canonical repository path: the same file changes
immediately. Sync rejects duplicate names and unexpected link targets. The
first conversion from legacy copied runtime directories requires
`just skills-sync --run --migrate`; it refuses directories whose skills do not
match the canonical union.

See the [Codex skills documentation](https://developers.openai.com/codex/concepts/customization#skills).

### Neovim Configuration

- Light/dark theme toggle (Catppuccin/OneDark)
- Treesitter with support for modern languages including Astro
- LSP with auto-installation of language servers
- Harpoon, Telescope, and other navigation enhancements

### Terminal Environment: tmux, zsh, bun

- Tmux with Dracula theme and plugin manager
- Zsh configured for Node.js, Rust, Go, and Python development
- Bun JavaScript/TypeScript runtime integration
- `tree-sitter-cli` support for Neovim parser installation on the `main` branch

### Herdr configuration

[`herdr/config.toml`](herdr/config.toml) is the managed configuration source.
`symlinks.sh` links only this file to `~/.config/herdr/config.toml`; Herdr's
sessions and logs remain runtime-owned and are never linked or versioned.
Like the existing dotfiles links, sync replaces the runtime config with this
managed source. Backup/preservation or force-mode policies are deferred.

The checked-in file is the complete annotated baseline generated by Herdr
0.8.0. Its options are commented except for upstream's explicit
`pane_history = false` default, so it preserves built-in behavior until an
option is deliberately changed. Refresh it only when deliberately adopting a
new Herdr baseline:

```bash
herdr --default-config
```

The upstream source is available as the pinned `lib-herdr` submodule for local
documentation and implementation inspection. Initialize it after cloning
dotfiles with `git submodule update --init --recursive`.

### Codex config

[`codex/config.ts`](codex/config.ts) maintains portable defaults in
`$HOME/.codex/config.toml` while preserving local project and onboarding
state. When present, `$HOME/.cursor/mcp.json` supplies same-named MCP servers;
other Codex MCP servers remain local. Run `bun run codex/config.ts` for its
usage and options.

### WSL Clipboard Integration

- A persistent Rust bridge that keeps one PowerShell clipboard process warm
- `pbcopy`, `pbpaste`, `wsl-pbcopy`, and `wsl-pbpaste` are symlinks to the one
  installed bridge binary; it dispatches by the command name
- Lossless UTF-8 text across the WSL/Windows boundary, including emoji and
  non-BMP Unicode; PowerShell performs the internal UTF-16 conversion
- `just sync` installs `~/.local/bin/wsl-clipboard` on WSL; its daemon starts
  only on the first copy or paste request
- `legacy-pbcopy` and `legacy-pbpaste` retain the old one-shot commands for
  diagnostics and performance comparison

## Requirements

- Ubuntu 24.04 (or compatible) on WSL2
- Neovim v10.0.4+ (ARM64 AppImage included)
- Zsh with Oh-My-Zsh
- Tmux
- Bun and Node.js
- Cargo/Rust tools
- Just command runner (`cargo install just`)
- `libclang-dev` for building `tree-sitter-cli`
- `lua5.1` and `luarocks` for Lazy/LuaRocks health checks
- `tree-sitter-cli` (`cargo install tree-sitter-cli`)

## Testing

See the [benchmark log](benchmarks.md) for reverse-chronological performance
results across the shell, Neovim, and WSL clipboard setup.

```bash
# Run all tests
just test
# or
bun test

# Test clipboard functionality
bun test zsh/clipboard.test.ts
```
