-- custom/plugins/lazy.lua
--
-- See the kickstart.nvim README for more information

---@type LazySpec
---See [Lazy Plugin Spec](https://github.com/folke/lazy.nvim#-plugin-spec)
local plugins = {
  -- A wrapper around Neovim's native LSP formatting.
  --
  -- It does:
  -- 1. Asynchronous or synchronous formatting on save
  -- 2. Sequential formatting with all attached LSP server
  -- 3. Add commands for disabling formatting (globally or per filetype)
  -- 4. Make it easier to send format options to the LSP
  -- 5. Allow you to exclude specific LSP servers from formatting.
  --
  -- It does not:
  -- - Provide any formatting by itself. You still need to use an LSP server
  { 'lukas-reineke/lsp-format.nvim', opts = {} },

  {
    'ThePrimeagen/harpoon',
    dependencies = { 'nvim-lua/plenary.nvim', 'nvim-telescope/telescope.nvim' }
  },

  {
    'm4xshen/smartcolumn.nvim',
    opts = {
      colorcolumn = "80",
    }
  },

  {
    'saecki/crates.nvim',
    ft = { "rust", "toml" },
    dependencies = { 'nvim-lua/plenary.nvim' },
    config = function()
      require('crates').setup()
    end
  },

  { 'mhartington/formatter.nvim' },

  -- Used for the `:Toc` command in markdown
  { 'jonschlinkert/markdown-toc' },

  --- This import is for [MunifTanjim/prettier.nvim](https://github.com/MunifTanjim/prettier.nvim)
  --- Currently, 'prettierd' is installed with Mason.
  {
    'MunifTanjim/prettier.nvim',
    config = function()
      local prettier = require("prettier")
      prettier.setup({
        bin = 'prettierd', -- prettier or prettierd
        filetypes = {
          "css",
          "graphql",
          "html",
          "javascript",
          "javascriptreact",
          "less",
          "scss",
          "typescript",
          "typescriptreact",
          "yaml",
        },
      })
    end
  },

  -- Corresponds to lua/core/fmt-conform.lua
  -- https://github.com/stevearc/conform.nvim
  {
    'stevearc/conform.nvim',
    opts = {},
  },

  -- just and justfile support
  { 'NoahTheDuke/vim-just' },

  -- https://neovimcraft.com/plugin/NvChad/nvim-colorizer.lua
  -- TODO https://youtu.be/_NiWhZeR-MY?t=223
  {
    "NvChad/nvim-colorizer.lua",
    opts = {
      user_default_options = {
        tailwind = true,
      }
    }
  },

  -- Adds file-wise icons in search and other places
  { "nvim-tree/nvim-web-devicons" },

  {
    "akinsho/toggleterm.nvim",
    -- version = "*",
    opts = {
      -- direction can be: vertical | horizontal | tab | float
      direction = "float",
      open_mapping = [[<C-\>]],
    }
  },

  -- Provides the awesome status bar using "winbar".
  -- See: https://github.com/fgheng/winbar.nvim
  {
    'fgheng/winbar.nvim',
    opts = {
      enabled = true,
      show_file_path = true,
      show_symbols = true,
    }
  },

  -- https://github.com/xiyaowong/transparent.nvim
  -- :TransparentEnable
  -- :TransparentDisable
  -- :TransparentToggle
  { "xiyaowong/transparent.nvim" },

  {
    "nvim-neo-tree/neo-tree.nvim",
    branch = "v3.x",
    dependencies = {
      "nvim-lua/plenary.nvim",
      "nvim-tree/nvim-web-devicons", -- not strictly required, but recommended
      "MunifTanjim/nui.nvim",
    },
    config = function()
      vim.api.nvim_create_user_command('EE', function()
        vim.cmd('Neotree')
      end, { desc = 'Explore with the Neotr[EE] command.' })
    end,
  },

  -- https://github.com/prichrd/netrw.nvim
  -- Adds a layer of ✨bling✨ and config to your favorite file explorer.
  {
    'prichrd/netrw.nvim',
    opts = {
      use_devicons = true,
      icons = {
        symlink = "",
        directory = "",
        file = ""
      },
    },
  }

}
return plugins
