# Neovim Configuration

Personal Neovim configuration by Unique Divine. This configuration is built on
lazy.nvim and provides a modern, modular setup for software development.

## Version Information

- **Neovim Version:** [0.10.4](https://github.com/neovim/neovim/releases/tag/v0.10.4)
- **Release Date:** 2025-03-13
- **Package Manager:** [lazy.nvim](https://github.com/folke/lazy.nvim)

## Structure

```
nvim/
├── init.lua              # Main entry point
├── lua/
│   └── core/            # Core configuration modules
│       ├── cmp.lua              # Autocompletion (nvim-cmp)
│       ├── comment.lua          # Comment toggling
│       ├── debug-kickstart.lua  # Debug adapter setup
│       ├── debugger.lua         # Debugger configuration
│       ├── editors.lua          # Editor-specific settings
│       ├── fmt.lua              # Code formatting
│       ├── fmt-conform.lua      # Alternative formatter config
│       ├── harpoon.lua          # File navigation
│       ├── lazy-plugins.lua     # Additional lazy plugins
│       ├── lsp.lua              # LSP configuration
│       ├── lsp-nvim-autoformat.lua  # Auto-formatting
│       ├── snippets.lua         # Code snippets
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

1. **Neovim 0.10.4+**
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

   # Arch
   pacman -S ripgrep
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
