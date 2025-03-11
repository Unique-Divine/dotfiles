# My Dotfiles

My personal development environment configuration optimized for Ubuntu 24.04 and WSL, designed to provide a consistent experience across machines.

## What's Included

- **Neovim**: Kickstart-based configuration with LSP, treesitter, and WSL clipboard integration
- **Tmux**: Terminal multiplexer with Vim-style navigation and session persistence
- **Zsh**: Shell configuration with Oh-My-Zsh, aliases, and developer tooling setup
- **Bash**: Utility scripts, color-coded logging, and environment detection
- **WSL Integration**: Seamless clipboard sharing between Ubuntu and Windows

## Quick Setup

```bash
# Clone the repository
git clone https://github.com/yourusername/dotfiles.git
cd dotfiles

# Create symbolic links for configurations
./symlinks.sh

# Install development tools
bun install
just setup

# For Neovim plugins
nvim --headless -c 'autocmd User PackerComplete quitall' -c 'PackerSync'
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

## Requirements

- Ubuntu 24.04 (or compatible) on WSL2
- Neovim v10.0.4+ (ARM64 AppImage included)
- Zsh with Oh-My-Zsh
- Tmux
- Bun and Node.js
- Cargo/Rust tools
- Just command runner (`cargo install just`)

## Testing

```bash
# Run all tests
just test
# or
bun test

# Test clipboard functionality
bun test zsh/clipboard.test.ts
```
