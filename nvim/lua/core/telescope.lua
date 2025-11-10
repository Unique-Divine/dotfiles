--- lua/core/telescope.lua
---
--- Handles the config for "telescope", which is used to fuzzy find, search,
--- filter, find, and pick things in Neovim.
---
--- See `:help telescope` and `:help telescope.setup()`
local mod = {}

-- [[ Configure Telescope ]]
-- See `:help telescope` and `:help telescope.setup()`
require('telescope').setup {
  defaults = {
    mappings = {
      i = {
        ['<C-u>'] = false,
        ['<C-d>'] = false,
      },
    },
  },
  -- pickers.find_files.follow adds support for symlinks in search.
  pickers = {
    find_files = {
      follow = true,
    },
  },
  -- extensions = {
  --   -- nvim-telescope/telescope-file-browser
  --   -- https://github.com/nvim-telescope/telescope-file-browser.nvim#setup-and-configuration
  --   file_browser = {
  --     -- theme = "ivy",
  --     hijack_netrw = true,
  --   },
  -- },
}

-- Enable telescope fzf native, if installed
pcall(require('telescope').load_extension, 'fzf')

local telescope = require('telescope.builtin')

-- See `:help telescope.builtin`
vim.keymap.set('n', '<leader>?', telescope.oldfiles,
  { desc = '[?] Find recently opened files' })
vim.keymap.set('n', '<leader><space>', telescope.buffers,
  { desc = '[ ] Find existing buffers' })

local function current_buffer_fuzzy_find()
  -- You can pass additional configuration to telescope to change theme, layout, etc.
  telescope.current_buffer_fuzzy_find(require('telescope.themes').get_dropdown {
    winblend = 10,
    previewer = false,
  })
end

vim.keymap.set('n', '<leader>/', current_buffer_fuzzy_find,
  { desc = '[/] Fuzzily search in current buffer' })
vim.keymap.set('n', '<leader>sb', current_buffer_fuzzy_find,
  { desc = '[/] Fuzzily [s]earch in current [b]uffer' })

--[[
Search for files (respecting .gitignore)
Docs on all available opts for find_files.
```
:help telescope.builtin.find_files()
```
]]
local function find_files_main()
  telescope.find_files({
    layout_strategy = 'vertical',
    prompt_prefix = "🔍 ",
    --- hidden boolean: determines whether to show hidden files or not (default: false)
    hidden = false,
    ---no_ignore boolean: show files ignored by .gitignore, .ignore, etc. (default: false)
    no_ignore = false,
  })
end
vim.keymap.set('n', '<leader>sf', find_files_main,
  { desc = '[S]earch [F]iles (main)' })
vim.keymap.set('n', '<leader>sF', ':Telescope find_files hidden=true no_ignore=true <cr>',
  { desc = '[S]earch [F]iles (verbose, no_ignore=true)' })

-- Set <C-p> to use telescope.find_files to mimic the VS Code
-- behavior.
vim.api.nvim_set_keymap('n', '<C-p>', '', {})
vim.keymap.set('n', '<C-p>', find_files_main,
  { desc = '[S]earch [F]iles (main)' })

vim.keymap.set('n', '<leader><C-g>', telescope.live_grep, { desc = '[G] is for grep' })

vim.keymap.set('n', '<leader>ss', telescope.lsp_document_symbols,
  { desc = '[S]earch [s]ymbols' })
vim.keymap.set('n', '<leader>sh', telescope.help_tags, { desc = '[S]earch [H]elp' })
vim.keymap.set('n', '<leader>sw', telescope.grep_string, { desc = '[S]earch current [W]ord' })
vim.keymap.set(
  'n', '<leader>sg', function()
    telescope.live_grep({
      layout_strategy = 'vertical', prompt_prefix = "🔍 " })
  end, { desc = '[S]earch by [G]rep' })
vim.keymap.set('n', '<leader>sd', telescope.diagnostics, { desc = '[S]earch [D]iagnostics' })

-- [[ Custom setup ]]
vim.api.nvim_set_keymap('n', '<A-h>', ':lua vim.diagnostic.open_float()<CR>', { silent = true })
-- vim.keymap.set('n', '<A-h>', ':lua vim.diagnostic.open_float()<CR>', { silent = true })

return mod
