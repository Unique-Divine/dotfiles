# Dotfiles - Unique Divine

My personal development environment configuration optimized for Ubuntu 24.04 and
WSL, designed to provide a consistent and easily reproducible experience across
machines.

<h2>Table of Contents</h2>

<!-- toc -->
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
- [Benchmarks and Testing](#benchmarks-and-testing)
<!-- tocstop -->

## What's Included

- **Neovim**: Lua configuration with LSP, treesitter, and WSL clipboard integration
- **Tmux**: Terminal multiplexer with Vim-style navigation and session persistence
- **Zsh**: Shell configuration with Oh-My-Zsh, aliases, and developer tooling setup
- **Bash**: Utility scripts, color-coded logging, and environment detection
- **WSL Integration**: Seamless clipboard sharing between Ubuntu and Windows

## Benchmarks and Testing


| Mode | Mean | Median | P95 |
| --- | ---: | ---: | ---: |
| Synchronous startup | 493.65 ms | 474.46 ms | 639.55 ms |
| Prompt ready | 841.24 ms | 756.90 ms | 1138.75 ms |


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

# Install development tools
bun install

# Create and repair symbolic links for configurations.
# just sync also installs the Zinit checkout.
just sync
just setup
```

- [ ] Make the `kubectl` installation reproducible in dotfiles.
  - Managed path is `brew "kubectl"` in `Brewfile`, installed by `just i-brew`.
    Homebrew alias for `kubernetes-cli` stable 1.37.0. Verified
    `kubectl version --client` reports `v1.37.0`.
  - Previous host binary was a direct Kubernetes release download at
    `~/.local/bin/kubectl` (`v1.35.7` Linux ARM64 from
    `https://dl.k8s.io/release/v1.35.7/bin/linux/arm64/kubectl`). That
    file was removed so it no longer shadows Homebrew on PATH.
  - [x] Evaluate `brew install kubectl` as the managed direct-binary install
    path.
  - [ ] Pin or document client-version compatibility with the GKE control
    plane.

After installing `nvim`, restore Neovim plugins from the lazy.nvim lockfile:

```bash
nvim --headless "+Lazy! restore" +qa

# Restore external Neovim tools from nvim/mason.lock.
just nvim-mason-restore
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
and Cursor CLI defaults, and synchronizes managed AI skills. `just health`
does not write: it checks required commands, Mason packages, and Codex,
Cursor CLI, or skills-sync drift with a nonzero exit status. Mason package
installation remains an explicit action.

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
- [Neovim setup and version requirements](nvim/README.md)
- Zsh with Oh-My-Zsh
- Tmux
- Bun and Node.js
- Cargo/Rust tools
- Just command runner (`cargo install just`)
- `libclang-dev` for building `tree-sitter-cli`
- `lua5.1` and `luarocks` for Lazy/LuaRocks health checks
- `tree-sitter-cli` (`cargo install tree-sitter-cli`)
