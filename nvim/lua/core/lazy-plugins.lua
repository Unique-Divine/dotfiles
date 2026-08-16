-- core/lazy-plugins.lua
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

  require("core/harpoon"),

  -- {
  --   'm4xshen/smartcolumn.nvim',
  --   -- Default config: https://github.com/m4xshen/smartcolumn.nvim
  --   opts = {
  --     colorcolumn = "80",
  --     disable_filetypes = {},
  --   }
  -- },

  {
    'saecki/crates.nvim',
    tag = "stable",
    -- ft = { "rust", "toml" },
    dependencies = { 'nvim-lua/plenary.nvim' },
    config = function()
      require('crates').setup({})
    end
  },

  -- https://github.com/nvim-neotest/nvim-nio
  { "nvim-neotest/nvim-nio" },

  -- Prettier formatting: use mhartington/formatter.nvim (core/specs/fmt.lua)
  -- and/or
  -- stevearc/conform.nvim with Mason’s `prettier` / `prettierd` — not
  -- MunifTanjim/prettier.nvim (triggers deprecated vim.validate on Nvim 0.12+).

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
      -- Register the update autocmd below so Oil buffers can be skipped without
      -- clearing the winbar that oil.nvim owns.
      enabled = false,
      show_file_path = true,
      show_symbols = true,
      exclude_filetype = {
        'help',
        'startify',
        'dashboard',
        'packer',
        'neogitstatus',
        'NvimTree',
        'Trouble',
        'alpha',
        'lir',
        'Outline',
        'spectre_panel',
        'toggleterm',
        'qf',
      },
    },
    config = function(_, opts)
      require('winbar').setup(opts)

      local winbar_events = {
        'DirChanged',
        'CursorMoved',
        'BufWinEnter',
        'BufFilePost',
        'InsertEnter',
        'BufWritePost',
      }
      vim.api.nvim_create_autocmd(winbar_events, {
        desc = 'Update winbar outside Oil buffers',
        callback = function()
          if vim.bo.filetype ~= 'oil' then
            require('winbar.winbar').show_winbar()
          end
        end,
      })
    end,
  },

  -- https://github.com/xiyaowong/transparent.nvim
  -- :TransparentEnable
  -- :TransparentDisable
  -- :TransparentToggle
  -- { "xiyaowong/transparent.nvim" },

  {
    "folke/todo-comments.nvim",
    dependencies = { "nvim-lua/plenary.nvim" },
    opts = {
      hightlight = { pattern = [[*(KEYWORDS)\s*]] }
    },
  },

  -- DISABLED neo-tree
  -- {
  --   "nvim-neo-tree/neo-tree.nvim",
  --   branch = "v3.x",
  --   dependencies = {
  --     "nvim-lua/plenary.nvim",
  --     "nvim-tree/nvim-web-devicons", -- not strictly required, but recommended
  --     "MunifTanjim/nui.nvim",
  --   },
  --   config = function()
  --     vim.api.nvim_create_user_command('NE', function()
  --       vim.cmd('Neotree')
  --     end, { desc = 'Explore with the [N]eotr[E]e command.' })
  --   end,
  -- },

  -- File explorer that lets you edit your filesystem like a normal Neovim buffer.
  {
    'stevearc/oil.nvim',
    config = function()
      -- Show CWD in the winbar. In Neovim, the winbar is a status line displayed
      -- at the top of each window.
      -- Here, we declare a global function, `get_oil_winbar`, to retrieve the
      -- current working directory
      function _G.get_oil_winbar()
        local bufnr = vim.api.nvim_win_get_buf(vim.g.statusline_winid)
        local dir = require("oil").get_current_dir(bufnr)
        if dir then
          return vim.fn.fnamemodify(dir, ":~")
        else
          -- If there is no current directory (e.g. over ssh), just show the buffer name
          return vim.api.nvim_buf_get_name(0)
        end
      end

      local oil = require("oil")
      ---@module 'oil'
      ---@type oil.SetupOpts
      local opts = {
        columns = { "icon", },
        delete_to_trash = true,
        view_options = {
          show_hidden = true,
        },
        -- Open directory buffers from BufEnter below. This avoids Oil's WinNew
        -- parent-window race when Neovim starts with a directory argument.
        default_file_explorer = false,
        -- Keymaps in oil buffer. Can be any value that `vim.keymap.set` accepts OR a table of keymap
        -- options with a `callback` (e.g. { callback = function() ... end, desc = "", mode = "n" })
        -- Additionally, if it is a string that matches "actions.<name>",
        -- it will use the mapping at require("oil.actions").<name>
        -- Set to `false` to remove a keymap
        -- See :help oil-actions for a list of all available actions
        keymaps = {
          ["g?"] = { "actions.show_help", mode = "n" },
          ["<CR>"] = "actions.select",
          ["<C-s>"] = { "actions.select", opts = { vertical = true } },
          ["<C-h>"] = false, -- disabled
          ["<C-t>"] = { "actions.select", opts = { tab = true } },
          ["<C-p>"] = { "actions.select", opts = { horizontal = true } },
          ["<C-c>"] = { "actions.close", mode = "n" },
          ["<C-l>"] = "actions.refresh",
          ["-"] = { "actions.parent", mode = "n" },
          ["_"] = { "actions.open_cwd", mode = "n" },
          ["`"] = { "actions.cd", mode = "n" },
          ["g~"] = { "actions.cd", opts = { scope = "tab" }, mode = "n" },
          ["gs"] = { "actions.change_sort", mode = "n" },
          ["gx"] = "actions.open_external",
          ["g."] = { "actions.toggle_hidden", mode = "n" },
          ["g\\"] = { "actions.toggle_trash", mode = "n" },
          -- Default keymaps I replaced:
          -- ["<C-h>"] = { "actions.select", opts = { horizontal = true } },
          -- ["<C-p>"] = "actions.preview",
        },
        win_options = {
          winbar = "%!v:lua.get_oil_winbar()",
        }
      }
      oil.setup(opts)

      vim.keymap.set("n", "-", "<CMD>Oil<CR>", { desc = "Open parent directory with :Oil" })
      vim.keymap.set("n", "<space>-", oil.toggle_float)

      vim.api.nvim_create_autocmd("BufEnter", {
        desc = "Open directory buffers with Oil after the window exists",
        callback = function()
          if vim.bo.filetype == "oil" then
            return
          end

          local path = vim.api.nvim_buf_get_name(0)
          if path == "" or vim.fn.isdirectory(path) ~= 1 then
            return
          end

          vim.schedule(function()
            oil.open(path)
          end)
        end,
      })
    end,
    -- Optional dependencies
    dependencies = { "nvim-tree/nvim-web-devicons" },
    -- Use based on preference for dev icons.
    -- dependencies = { { "nvim-mini/mini.icons", opts = {} } },
    -- Lazy loading is not recommended because it is very tricky to make it work correctly in all situations.
    lazy = false,
  },

  -- https://github.com/prichrd/netrw.nvim
  -- Adds a layer of ✨bling✨ and config to your favorite file explorer.
  -- INFO: Disabled in favor of oil.nvim as default explorer
  -- {
  --   'prichrd/netrw.nvim',
  --   opts = {
  --     use_devicons = true,
  --     icons = {
  --       symlink = "",
  --       directory = "",
  --       file = ""
  --     },
  --   },
  -- },

  -- https://github.com/sindrets/diffview.nvim
  { 'sindrets/diffview.nvim' },

  {
    "christoomey/vim-tmux-navigator",
    cmd = {
      "TmuxNavigateLeft",
      "TmuxNavigateDown",
      "TmuxNavigateUp",
      "TmuxNavigateRight",
      "TmuxNavigatePrevious",
    },
    keys = {
      { "<C-h>",  "<cmd><C-U>TmuxNavigateLeft<cr>" },
      { "<C-w>k", "<cmd><C-U>TmuxNavigateDown<cr>" }, { "<C-w>k", "<cmd><C-U>TmuxNavigateUp<cr>" },
      { "<C-l>",  "<cmd><C-U>TmuxNavigateRight<cr>" },
      { "<C-\\>", "<cmd><C-U>TmuxNavigatePrevious<cr>" },
    },
  }

}
return plugins
