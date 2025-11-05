--[[
Kickstart.nvim is *not* a distribution.

Kickstart.nvim is a template for your own configuration.
The goal is that you can read every line of code, top-to-bottom, and understand
what your configuration is doing.

Once you've done that, you should start exploring, configuring and tinkering to
explore Neovim!

Lua Guides: If you don't know anything about Lua, I recommend taking some
time to read through a guide.

 - https://learnxinyminutes.com/docs/lua/
 - And then you can explore or search through `:help lua-guide`

Neovim Verison: [0.10.4](https://github.com/neovim/neovim/releases/tag/v0.10.4)
Neovim Version Date: 2025-03-13

--]]

-- Set <space> as the leader key
-- See `:help mapleader`
-- NOTE: Must happen before plugins are required. Others, the wrong leader key
-- will be set in the configuration.
vim.g.mapleader = ' '
vim.g.maplocalleader = ' '

-- Update package search path to include project root
package.path = package.path .. ';./?.lua'

-- Install package manager
--    https://github.com/folke/lazy.nvim
--    `:help lazy.nvim.txt` for more info
local lazypath = vim.fn.stdpath 'data' .. '/lazy/lazy.nvim'
if not vim.loop.fs_stat(lazypath) then
  vim.fn.system {
    'git',
    'clone',
    '--filter=blob:none',
    'https://github.com/folke/lazy.nvim.git',
    '--branch=stable', -- latest stable release
    lazypath,
  }
end
vim.opt.rtp:prepend(lazypath)

-- NOTE: Here is where you install your plugins.
--  You can configure plugins using the `config` key.
--
vim.cmd('highlight Comment guifg=#89b9e7')
--
--  You can also configure plugins after the setup call,
--    as they will be available in your neovim runtime.

-- Toggles theme between "light" | "dark"
vim.o.background = "light"

---@type LazySpec
---See [Lazy Plugin Spec](https://github.com/folke/lazy.nvim#-plugin-spec)
local lazyPlugins = {
  -- NOTE: First, some plugins that don't require any configuration

  -- Git related plugins
  'tpope/vim-fugitive',
  'tpope/vim-rhubarb',

  -- For easy commenting
  'tpope/vim-commentary',

  -- Detect tabstop and shiftwidth automatically
  'tpope/vim-sleuth',

  -- NOTE: This is where your plugins related to LSP can be installed.
  --  The configuration is done below. Search for lspconfig to find it below.
  {
    -- LSP Configuration & Plugins
    'neovim/nvim-lspconfig',
    dependencies = {
      -- Automatically install LSPs to stdpath for neovim
      {
        'williamboman/mason.nvim',
        config = true,
        -- docs on "ensure_installed": https://github.com/williamboman/mason-lspconfig.nvim
        opts = { ensure_installed = { "prettier" } }
      },
      'williamboman/mason-lspconfig.nvim',

      -- Useful status updates for LSP
      -- NOTE: `opts = {}` is the same as calling `require('fidget').setup({})`
      { 'j-hui/fidget.nvim',             tag = "legacy", opts = {} },

      -- Additional lua configuration, makes nvim stuff amazing!
      'folke/neodev.nvim',
      'simrat39/rust-tools.nvim',
      { 'simrat39/symbols-outline.nvim', opts = {} },
    },
    -- Why add opts to 'nvim-lspconfig'?
    -- If we share dotfiles or setup a new computer, we'll automatically have
    -- certain language servers without you needing to go into Mason.
    opts = {
      servers = {
        tailwindcss = {},
      }
    },
  },

  -- Debugger
  {
    -- "dap" is short for debugging adapter protocol.
    -- [TJ DeVries - simple neovim debugging setup (in 10 minutes)](https://youtu.be/lyNfnI-B640)
    "mfussenegger/nvim-dap",
    dependencies = {
      "leoluz/nvim-dap-go", -- Golang debugging utilities
      "rcarriga/nvim-dap-ui",
      "theHamsta/nvim-dap-virtual-text",
      "nvim-neotest/nvim-nio",
      "williamboman/mason.nvim",
    },
  },

  {
    -- Autocompletion
    'hrsh7th/nvim-cmp',
    dependencies = {
      'hrsh7th/cmp-nvim-lsp',
      { 'L3MON4D3/LuaSnip', version = "v2.*", build = "make install_jsregexp" },
      'saadparwaiz1/cmp_luasnip',
      'rafamadriz/friendly-snippets' },
  },

  -- Useful plugin to show you pending keybinds.
  { 'folke/which-key.nvim',          opts = {} },
  {
    -- Adds git releated signs to the gutter, as well as utilities for managing changes
    'lewis6991/gitsigns.nvim',
    opts = {
      -- See `:help gitsigns.txt`
      signs = {
        add = { text = '+' },
        change = { text = '~' },
        delete = { text = '_' },
        topdelete = { text = '‾' },
        changedelete = { text = '~' },
      },
      on_attach = function(bufnr)
        local gitsigns = require('gitsigns')
        vim.keymap.set('n', '[c', gitsigns.nav_hunk('prev'),
          { buffer = bufnr, desc = 'Go to Previous Hunk' })
        vim.keymap.set('n', ']c', gitsigns.nav_hunk('next'),
          { buffer = bufnr, desc = 'Go to Next Hunk' })
        vim.keymap.set('n', '<leader>ph', require('gitsigns').preview_hunk, { buffer = bufnr, desc = '[P]review [H]unk' })
      end,
    },
  },

  -- THEME ------------------------------------------------------------
  -- To switch between light and dark, comment out one of the either light or
  -- dark. If you leave both uncommented, the one with highe "priority" will be
  -- the theme.

  --[[ THEME / LIGHT ]] --
  {
    -- Repo: https://github.com/catppuccin/nvim
    "catppuccin/nvim",
    name = "catppuccin",
    priority = 420,
    config = function()
      -- Early return if the background is not set to "light"
      if vim.o.background ~= "light" then
        return
      end

      vim.cmd.colorscheme "catppuccin"
      -- colorscheme can be: catppuccin-latte, catppuccin-frappe, catpuccin-macchiato,
      -- catpuccin-mocha
      local theme = require("catppuccin")
      theme.setup({
        flavour = "latte", -- options: latte, frappe, macchiato, mocha
        transparent_background = true,
      })
    end
  },

  --[[ THEME / DARK ]] --
  {
    -- Theme inspired by Atom
    -- Repo: https://github.com/navarasu/onedark.nvim
    'navarasu/onedark.nvim',
    priority = 1000,
    config = function()
      vim.cmd.colorscheme 'onedark'
      local theme_onedark = require('onedark')
      theme_onedark.setup {
        style             = 'deep', -- Theme colors. Choose between:
        -- [dark, darket, cool, deep, warm, warmer, light]
        transparent       = false,  -- Show/hide background
        -- toggle theme style --
        toggle_style_key  = "<leader>ts",
        -- toggle_style_list: List of styles to toggle between
        toggle_style_list = { 'dark', 'darker', 'cool', 'deep', 'warm', 'warmer', 'light' },

        -- Change code style ---
        -- Options are [italic, bold, underline, none]
        -- You can configure multiple style with comma separated, For e.g., keywords = 'italic,bold'
        code_style        = {
          comments = 'none',
          keywords = 'none',
          functions = 'none',
          strings = 'none',
          variables = 'none'
        },
        -- Colors
        -- See https://github.com/navarasu/onedark.nvim?tab=readme-ov-file#customization
        -- for more info on custom colors.
        colors            = {
          neo_blue_light = "#04d9d9",
          neo_blue = "#17a0bf",
          neo_pink_light = "#f2bdd6",
          neo_pink = "#f29ac4",
          midnight_blue = "#101720",
          -- yellow = "#04d9d9",
          yellow = "#FDDEA8",
          purple = "#f29ac4",
          orange = "#FF9B3F",
          green = "#3DD164",
          blue = "#17a0bf",
          cyan = "#04d9d9",
        },
        highlights        = {
          -- ["@function.builtin"] = { fg = "$neo_blue" },
          -- ["@function"] = { fg = "$neo_blue" },
          -- ["@string"] = { fg = "$neo_blue" },
          -- ["@keyword"] = { fg = "$neo_blue" },
        },
      }

      -- Early return if the background is not set to "dark"
      -- The reason we call `require('onedark').setup` without loading when the
      -- theme is light is because the "nvim-lualine/lualine.nvim" plugin depends
      -- on "onedark" and shows a warning if it does not exist.
      if vim.o.background ~= "dark" then
        return
      end
      theme_onedark.load() -- officially load the theme
    end,
  },

  {
    -- Set lualine as statusline
    'nvim-lualine/lualine.nvim',
    -- See `:help lualine.txt`
    config = function()
      --- ModeAbbreviation: Provides shorter names for the Vim mode. By default, you
      --- caps labels like "NORMAL", "INSERT", and "V-BLOCK".
      local modeAbbreviation = function()
        local modes_abbrev = {
          ['n'] = '普通', -- NORMAL
          ['i'] = '入れる', -- INSERT
        }
        local current_mode = vim.api.nvim_get_mode().mode
        return modes_abbrev[current_mode] or current_mode
      end
      require('lualine').setup({
        options = {
          icons_enabled = true,
          theme = 'onedark', -- OR: 'onedark'
          -- component_separators = '|',
          -- component_separators = { left = '', right = ''},
          section_separators = { left = '', right = '' },
          component_separators = { left = '《', right = '》' },
        },

        -- Lualine has sections identified by letter.
        -- +-------------------------------------------------+
        -- | A | B | C                             X | Y | Z |
        -- +-------------------------------------------------+
        sections = {
          -- lualine_a = { 'mode' },
          lualine_a = { modeAbbreviation },
          lualine_b = { 'branch' },
          lualine_c = { {
            'filename',
            file_status = true, -- displays file status
            path = 0            -- 0 means just filename
          } },
          lualine_x = {
            { 'diagnostics', sources = { 'nvim_diagnostic' } },
          },
          lualine_y = { function()
            -- vim.fn.expand corresponds to `:echo expand("%:p:h")`. Here,`%p`
            -- is similar to `:pwd`, outputting the path to the working dir.
            local home_path = vim.fn.expand("$HOME")
            local currDir = vim.fn.expand("%:p:h")
            return currDir:gsub("^" .. home_path, "~") -- shorten $HOME to "~"
          end, 'filetype' },
        }
      })
    end,
  },

  {
    -- Add indentation guides even on blank lines
    'lukas-reineke/indent-blankline.nvim',
    version = "v2.*",
    -- Enable `lukas-reineke/indent-blankline.nvim`
    -- See `:help indent_blankline.txt`
    opts = {
      char = '┊',
      show_trailing_blankline_indent = false,
    },
  },

  -- "gc" to comment visual regions/lines
  -- See: https://github.com/numToStr/Comment.nvim#pre-hook
  -- Setup is in the "lua/core/comment.lua" file.
  { 'numToStr/Comment.nvim',         opts = {} },

  -- Fuzzy Finder (files, lsp, etc)
  { 'nvim-telescope/telescope.nvim', branch = '0.1.x', dependencies = { 'nvim-lua/plenary.nvim' } },

  -- Fuzzy Finder Algorithm which requires local dependencies to be built.
  -- Only load if `make` is available. Make sure you have the system
  -- requirements installed.
  {
    'nvim-telescope/telescope-fzf-native.nvim',
    -- NOTE: If you are having trouble with this installation,
    --       refer to the README for telescope-fzf-native for more instructions.
    build = 'make',
    cond = function()
      return vim.fn.executable 'make' == 1
    end,
  },

  {
    -- Highlight, edit, and navigate code
    -- Setup is in the "lua/core/treesitter.lua" file.
    --
    -- Commands I had to run to get things working:
    -- ```nvim
    -- :TSInstall astro
    -- ```
    'nvim-treesitter/nvim-treesitter',
    dependencies = {
      -- Extra module for nvim-treesitter
      -- https://github.com/nvim-treesitter/nvim-treesitter/wiki/Extra-modules-and-plugins
      'nvim-treesitter/nvim-treesitter-textobjects',

      -- Sets the `commentstring` based on tree-sitter queries
      'JoosepAlviste/nvim-ts-context-commentstring',
      -- 'windwp/nvim-ts-autotag', -- TODO Set this up.
    },
    build = ':TSUpdate',
  },

  -- NOTE: Next Step on Your Neovim Journey: Add/Configure additional "plugins" for kickstart
  --       These are some example plugins that I've included in the kickstart repository.
  --       Uncomment any of the lines below to enable them.
  require 'kickstart.plugins.autoformat',
  require 'kickstart.plugins.debug',

  -- NOTE: The import below automatically adds your own plugins, configuration, etc from `lua/core/auto/*.lua`
  -- You can use this folder to prevent any conflicts with this init.lua if you're interested in keeping
  -- up-to-date with whatever is in the kickstart repo.k
  --
  -- For additional information see:
  -- https://github.com/folke/lazy.nvim#-structuring-your-plugins
  { import = 'core.auto' },
}
--- @type LazyConfig
local lazyConfig = {}
require('lazy').setup(lazyPlugins, lazyConfig)

-- [[ Setting options ]]
-- See `:help vim.o`

-- Set highlight on search
vim.o.hlsearch = false

-- Make line numbers default
vim.wo.number = true

-- Enable mouse mode
vim.o.mouse = 'a'

-- Sync clipboard between OS and Neovim.
--  Remove this option if you want your OS clipboard to remain independent.
--  See `:help 'clipboard'`
vim.o.clipboard = 'unnamed,unnamedplus'
vim.g.clipboard = {
  name = "WSL (MacOS-like)",
  copy = {
    ["+"] = "pbcopy",
    ["*"] = "pbcopy",
  },
  paste = {
    ["+"] = "pbpaste",
    ["*"] = "pbcopy",
  },
}

vim.api.nvim_create_user_command('WY', function(opts)
  -- Yank text into the '+' register: if a range was provided, yank that range;
  -- otherwise, yank the current line.
  if opts.range > 0 then
    vim.cmd(string.format('%d,%dyank +', opts.line1, opts.line2))
  else
    vim.cmd('normal! "+y')
  end

  -- Get the yanked text from the '+' register.
  local text = vim.fn.getreg('+')

  -- Convert the text from UTF-8 to UTF-16LE and pipe it to pbcopy.
  vim.fn.system('iconv -f UTF-8 -t UTF-16LE | pbcopy', text)

  print("Yanked text copied to Windows clipboard (UTF-16LE).")
end, { range = true, desc = "[W]indows [Y]ank, changing encoding from UTF8 to UTF-16LE on copy" })


-- Enable break indent
vim.o.breakindent = true

-- Save undo history
vim.o.undofile = true

-- Case insensitive searching UNLESS /C or capital in search
vim.o.ignorecase = true
vim.o.smartcase = true

-- Keep signcolumn on by default
vim.wo.signcolumn = 'yes'

-- Decrease update time
vim.o.updatetime = 250
vim.o.timeout = true
vim.o.timeoutlen = 300

-- Set completeopt to have a better completion experience
vim.o.completeopt = 'menuone,noselect'

-- NOTE: You should make sure your terminal supports this
vim.o.termguicolors = true

-- [[ Basic Keymaps ]]

-- Keymaps for better default experience
-- See `:help vim.keymap.set()`
vim.keymap.set({ 'n', 'v' }, '<Space>', '<Nop>', { silent = true })

-- Remap for dealing with word wrap
vim.keymap.set('n', 'k', "v:count == 0 ? 'gk' : 'k'", { expr = true, silent = true })
vim.keymap.set('n', 'j', "v:count == 0 ? 'gj' : 'j'", { expr = true, silent = true })

-- [[ Highlight on yank ]]
-- See `:help vim.highlight.on_yank()`
local highlight_group = vim.api.nvim_create_augroup('YankHighlight', { clear = true })
vim.api.nvim_create_autocmd('TextYankPost', {
  callback = function()
    vim.highlight.on_yank()
  end,
  group = highlight_group,
  pattern = '*',
})

-- [[ Telescope ]] Fuzzy find and search. See `:help telescope`
require('core/telescope')

-- [[ Treesitter ]] See `:help nvim-treesitter`
require('core/treesitter')

-- Diagnostic keymaps
vim.keymap.set('n', '[d', vim.diagnostic.goto_prev, { desc = 'Go to previous diagnostic message' })
vim.keymap.set('n', ']d', vim.diagnostic.goto_next, { desc = 'Go to next diagnostic message' })
vim.keymap.set('n', '<leader>e', vim.diagnostic.open_float, { desc = 'Open floating diagnostic message' })
vim.keymap.set('n', '<leader>q', vim.diagnostic.setloclist, { desc = 'Open diagnostics list' })

--- LSP settings.
require('core/lsp')

require('core/editors')

-- nvim-cmp setup
require('core/cmp')
require('core/fmt')
-- require('core/fmt-conform')

require('core/debugger')

require('core/comment')
require('core/harpoon')

-- Vim settings
require('core/vim')
