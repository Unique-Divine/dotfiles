--[[
Neovim configuration of Unique Divine. You should be able to read every line of
code from this dotfiles repo and understand what the configuration is doing.

I hope this serves as a guideline or inspiration for folks interested in
exploring and beginning to use Neovim.

### Version Information
Neovim Verison: [0.12.2](https://github.com/neovim/neovim/releases/tag/v0.12.2)
Neovim Version Date: 2025-04-23

Neovim Verison: [0.10.4](https://github.com/neovim/neovim/releases/tag/v0.10.4)
Neovim Version Date: 2025-03-13

Lua Guides: If you don't know anything about Lua, I recommend taking some time
to read through a short guide. The concepts from other programming languages
carry over.
 - [Lua basics](https://learnxinyminutes.com/docs/lua/)
 - And then you can explore or search through `:help lua-guide`. This is
 important to understand the particulars on how lua, nvim, and vim connect to
 each other in the editing experience.
--]]

-- Oil is the directory explorer. Disable netrw before plugins and startup
-- arguments are processed so it cannot replace Oil's directory buffers.
vim.g.loaded_netrw = 1
vim.g.loaded_netrwPlugin = 1

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
if not (vim.uv or vim.loop).fs_stat(lazypath) then
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

-- ---------------------------------------------
-- PLUGINS: Start
-- NOTE: Here is where you install your plugins.
--  You can configure plugins using the `config` key.

vim.cmd('highlight Comment guifg=#89b9e7')
--
--  You can also configure plugins after the setup call,
--    as they will be available in your neovim runtime.

-- Toggles theme between "light" | "dark" with `vim.o.background`.
-- Defaults to "dark" unless env var "NVIM_BG" says otherwise.
do
  local bg = vim.env.NVIM_BG or "dark"
  ---@type table<string, boolean>
  local bg_themes = {
    light = true,
    dark = true,
  }
  if not bg_themes[bg] then
    bg = "dark"
  end

  vim.o.background = bg
end

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
  { 'folke/which-key.nvim',  opts = {} },
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
        vim.keymap.set('n', ']c', function()
          gitsigns.nav_hunk('next')
        end, { buffer = bufnr, desc = 'Go to Next Hunk' })
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
  { 'numToStr/Comment.nvim', opts = {} },

  -- Fuzzy Finder (files, lsp, etc)
  -- Pin to a tagged release (not bare master). v0.2.2 is the newest tag;
  -- GitHub Releases "Latest" is currently v0.2.1.
  --
  -- Do not `require('core/telescope')` in this table or before lazy.setup().
  -- That runs immediately, while telescope.nvim is not on rtp yet.
  -- `config` runs after Lazy loads the plugin (cmd / keys / first require).
  {
    'nvim-telescope/telescope.nvim',
    tag = 'v0.2.2',
    dependencies = {
      'nvim-lua/plenary.nvim',
      {
        'nvim-telescope/telescope-fzf-native.nvim',
        build = 'make',
        cond = function()
          return vim.fn.executable 'make' == 1
        end,
      },
    },
    cmd = 'Telescope',
    keys = {
      { '<leader>?',       desc = '[?] Find recently opened files' },
      { '<leader><space>', desc = '[ ] Find existing buffers' },
      { '<leader>/',       desc = '[/] Fuzzily search in current buffer' },
      { '<leader>sb',      desc = '[S]earch in current [b]uffer' },
      { '<leader>sf',      desc = '[S]earch [F]iles (main)' },
      { '<leader>sF',      desc = '[S]earch [F]iles (verbose)' },
      { '<C-p>',           desc = 'Search files' },
      { '<leader><C-g>',   desc = '[G] is for grep' },
      { '<leader>ss',      desc = '[S]earch [s]ymbols' },
      { '<leader>sh',      desc = '[S]earch [H]elp' },
      { '<leader>sw',      desc = '[S]earch current [W]ord' },
      { '<leader>sg',      desc = '[S]earch by [G]rep' },
      { '<leader>sd',      desc = '[S]earch [D]iagnostics' },
    },
    config = function()
      require('core/telescope')
    end,
  },

  -- nvim-treesitter `main` (Neovim 0.12+). Spec + setup in core/treesitter.lua.
  require 'core/treesitter',

  -- NOTE: Next Step on Your Neovim Journey: Add/Configure additional "plugins"
  -- for kickstart. These are some example plugins that I've included in the
  -- kickstart repository.
  require 'core/debug-dap',

  require 'core/lazy-plugins',

  require 'core/lsp',

  -- Each lua/core/specs/*.lua file must return a Lazy plugin spec.
  { import = 'core.specs' },
}
--- @type LazyConfig
local lazyConfig = {}
-- If 'loadplugins' is off, lazy.setup() returns before defining :Lazy (see folke/lazy.nvim
-- lua/lazy/init.lua). That happens with `nvim --noplugin` or :set noloadplugins.
vim.o.loadplugins = true
require('lazy').setup(lazyPlugins, lazyConfig)


-- nvim-cmp setup
require('core/cmp')
require('core/fmt')
-- require('core/fmt-conform')

require('core/comment')
-- require('core/harpoon') -- disable

-- Vim settings. This should be last so that plugins don't take control of the
-- Vim options unexpectedly.
require('core/vim')
