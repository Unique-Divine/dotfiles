# Neovim Configuration

Personal Neovim configuration by Unique Divine. This configuration is built on
lazy.nvim and provides a modern, modular setup for software development.

## Contents

<!-- toc -->
- [Structure](#structure)
- [Key Features](#key-features)
  - [Core Functionality](#core-functionality)
  - [Themes](#themes)
  - [Plugins](#plugins)
- [Installation](#installation)
  - [Prerequisites](#prerequisites)
  - [Setup](#setup)
- [Key Mappings](#key-mappings)
  - [General](#general)
  - [Telescope (Fuzzy Finder)](#telescope-fuzzy-finder)
  - [LSP](#lsp)
  - [Git](#git)
- [Configuration](#configuration)
  - [Adding Plugins](#adding-plugins)
  - [Customizing Settings](#customizing-settings)
  - [Mason packages](#mason-packages)
- [Learning Resources](#learning-resources)
- [Notes](#notes)
<!-- tocstop -->

## Structure

**Neovim Verison:** [0.12.2](https://github.com/neovim/neovim/releases/tag/v0.12.2)

```
nvim/
├── init.lua              # Main entry point
├── mason-health.lua      # Read-only Mason lock health check
├── mason.lock            # Pinned Mason package versions
├── lua/
│   └── core/            # Core configuration modules
│       ├── debug-dap.lua        # DAP plugin spec and setup
│       ├── fmt-conform.lua      # Alternative formatter config
│       ├── harpoon.lua          # File navigation
│       ├── lazy-plugins.lua     # Additional lazy plugins
│       ├── lsp.lua              # LSP plugin spec and setup
│       ├── mason-lock.lua        # Mason lock refresh and restore commands
│       ├── snippets.lua         # Code snippets
│       ├── specs/               # Lazy specs: cmp, fmt, comment
│       ├── telescope.lua        # Fuzzy finder
│       ├── treesitter.lua       # Syntax highlighting
│       └── vim.lua              # Vim options and keymaps
└── kickstart.md         # Original kickstart.nvim README (archived)
```

## Key Features

### Core Functionality
- **LSP Support:** Full Language Server Protocol support with mason.nvim for
  automatic LSP installation
- **Autocompletion:** nvim-cmp with LuaSnip for snippet support
- **Debugging:** nvim-dap with Go debugging utilities
- **Fuzzy Finding:** Telescope for files, buffers, and live grep
- **Syntax Highlighting:** Tree-sitter for accurate syntax highlighting
- **Git Integration:** Gitsigns for inline git blame and hunk navigation

### Themes
Two themes are configured with easy toggling:

**Light Mode** (default when `vim.o.background = "light"`):
- [Catppuccin Latte](https://github.com/catppuccin/nvim) with transparent
  background

**Dark Mode** (default when `vim.o.background = "dark"`):
- [OneDark](https://github.com/navarasu/onedark.nvim) with custom colors
- Toggle styles with `<leader>ts`
- Styles: dark, darker, cool, deep, warm, warmer, light

To switch themes, change line 58 in `init.lua`:
```lua
vim.o.background = "light"  -- or "dark"
```

### Plugins

Core plugins installed via lazy.nvim:

- **Git:** vim-fugitive, vim-rhubarb, gitsigns.nvim
- **LSP:** nvim-lspconfig, mason.nvim, mason-lspconfig.nvim, fidget.nvim,
  neodev.nvim
- **Rust:** rust-tools.nvim, symbols-outline.nvim
- **Completion:** nvim-cmp, cmp-nvim-lsp, LuaSnip, friendly-snippets
- **Debug:** nvim-dap, nvim-dap-go, nvim-dap-ui, nvim-dap-virtual-text
- **UI:** which-key.nvim, lualine.nvim, indent-blankline.nvim
- **Editor:** vim-commentary, Comment.nvim, vim-sleuth
- **Search:** telescope.nvim, telescope-fzf-native.nvim
- **Syntax:** nvim-treesitter, nvim-treesitter-textobjects,
  nvim-ts-context-commentstring

## Installation

### Prerequisites

1. **[Neovim 0.12.2+](https://github.com/neovim/neovim/releases/tag/stable)**
   ```bash
   nvim --version
   ```

2. **Git**

3. **Build tools** (for telescope-fzf-native):
   - Linux: `make`, `gcc`
   - macOS: Xcode Command Line Tools
   - Windows: CMake, Microsoft C++ Build Tools

4. **Ripgrep** (for Telescope live grep):
   ```bash
   # macOS
   brew install ripgrep

   # Ubuntu/Debian
   apt install ripgrep
   ```

### Setup

If using this dotfiles repo structure:

1. Clone the dotfiles repo (if not already done)
2. Create a symlink to the nvim config:
   ```bash
   ln -s /path/to/dotfiles/nvim ~/.config/nvim
   ```

3. Start Neovim:
   ```bash
   nvim
   ```

4. lazy.nvim will automatically install all plugins on first run

5. Wait for installations to complete, then restart Neovim

## Key Mappings

Leader key: `<Space>`

### General
- `<leader>ts` - Toggle theme style (OneDark styles)

### Telescope (Fuzzy Finder)
See `lua/core/telescope.lua` for complete mappings

### LSP
See `lua/core/lsp.lua` for complete mappings

### Git
- `]c` - Next hunk
- `<leader>ph` - Preview hunk

## Configuration

### Adding Plugins

Add plugins to the `lazyPlugins` table in `init.lua`:

```lua
local lazyPlugins = {
  -- Your new plugin
  {
    'author/plugin-name',
    config = function()
      require('plugin-name').setup {}
    end
  },
  -- ... existing plugins
}
```

### Customizing Settings

- **Vim options:** Edit `lua/core/vim.lua`
- **LSP settings:** Edit `lua/core/lsp.lua`
- **Keymaps:** Distributed across relevant config files
- **Theme colors:** Edit theme config in `init.lua` (lines 184-245)

### Mason packages

This configuration adds two commands around Mason's installed packages. The
file `mason.lock` stores one `package@version` entry per installed package. It
is a snapshot of the tools used by this Neovim configuration, not a list of
LSP servers configured in `lua/core/lsp.lua`.

Use the `:MasonLock` command after installing, upgrading, or removing a Mason
package:

```vim
:MasonLock
```

The command reads the installed packages from Mason, records their exact
versions, sorts the entries, and rewrites `mason.lock`. It skips packages that
Mason no longer recognizes, so review the command's warnings and the Git diff
before committing the updated lock file.

Use the `:MasonRestore` command to install packages that are listed in
`mason.lock` but missing from the local Mason directory:

```vim
:MasonRestore
```

The command refreshes the Mason registry and requests each missing package at
the version recorded in the lock file. It reports installed version mismatches
without replacing those packages. It also leaves packages that are absent
from the lock file installed.

From the dotfiles repository, run the headless wrapper when setting up another
machine:

```bash
just nvim-mason-restore
```

The `just nvim-mason-restore` command starts Neovim with the normal
configuration, runs `:MasonRestore`, waits for headless installs to finish,
and exits with a failure status if the restore cannot match the lock file.

The `just health` command performs a read-only check against `mason.lock`. It
reports missing packages and version mismatches as errors, and reports extra
installed packages as warnings. The check loads only `mason-health.lua`, so it
does not trigger the configuration's automatic
LSP installation while checking the lock file.

A typical setup or update looks like this:

1. Install or update packages through Mason
1. Run :MasonLock and review nvim/mason.lock
1. Commit the lock file, then run just nvim-mason-restore on another machine
1. Run just health to check the installed versions


## Learning Resources

If you're new to Lua or Neovim:

- [Lua Basics](https://learnxinyminutes.com/docs/lua/)
- `:help lua-guide` - Neovim's Lua integration guide
- `:help` - Neovim's built-in help system

## Notes

- This configuration started from
  [kickstart.nvim](https://github.com/nvim-lua/kickstart.nvim) and has been
  customized
- The original kickstart README is preserved in `kickstart.md`
- Configuration is modular - each feature is in its own file under `lua/core/`
- Mason will auto-install configured LSPs on first run
