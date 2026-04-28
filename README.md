# Dotfiles - Unique Divine

My personal development environment configuration optimized for Ubuntu 24.04 and
WSL, designed to provide a consistent and easily reproducible experience across
machines.

<h2>Table of Contents</h2>

- [What's Included](#whats-included)
- [Quick Setup](#quick-setup)
- [Symlink Philosophy](#symlink-philosophy)
- [Features](#features)
  - [WSL Clipboard Integration](#wsl-clipboard-integration)
  - [Neovim Configuration](#neovim-configuration)
  - [Terminal Environment](#terminal-environment)
- [Requirements](#requirements)
- [Testing](#testing)

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
cargo install bat tree-sitter-cli

# Create symbolic links for configurations
source zsh/zshenv # internally runs $DOTFILES/symlinks.sh

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

The `symlinks.sh` script handles creating all necessary symbolic links to connect the configurations in this repo to their expected locations in your home directory and `.config` folder.

## Features

### WSL Clipboard Integration
- Custom `pbcopy` and `pbpaste` commands that work with Windows clipboard
- Neovim configured to use system clipboard across WSL/Windows boundary
- Automatically removes Windows line endings when pasting

### Neovim Configuration
- Light/dark theme toggle (Catppuccin/OneDark)
- Treesitter with support for modern languages including Astro
- LSP with auto-installation of language servers
- Harpoon, Telescope, and other navigation enhancements

### Terminal Environment
- Tmux with Dracula theme and plugin manager
- Zsh configured for Node.js, Rust, Go, and Python development
- Bun JavaScript/TypeScript runtime integration
- `tree-sitter-cli` support for Neovim parser installation on the `main` branch

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

```bash
# Run all tests
just test
# or
bun test

# Test clipboard functionality
bun test zsh/clipboard.test.ts
```
