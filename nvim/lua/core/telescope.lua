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

-- See `:help telescope.builtin`
vim.keymap.set('n', '<leader>?', require('telescope.builtin').oldfiles, { desc = '[?] Find recently opened files' })
vim.keymap.set('n', '<leader><space>', require('telescope.builtin').buffers, { desc = '[ ] Find existing buffers' })
vim.keymap.set('n', '<leader>/', function()
  -- You can pass additional configuration to telescope to change theme, layout, etc.
  require('telescope.builtin').current_buffer_fuzzy_find(require('telescope.themes').get_dropdown {
    winblend = 10,
    previewer = false,
  })
end, { desc = '[/] Fuzzily search in current buffer' })

vim.keymap.set('n', '<leader>sf', function()
  require('telescope.builtin').find_files({
    layout_strategy = 'vertical', prompt_prefix = "🔍 " })
end, { desc = '[S]earch [F]iles (without hidden)' })
vim.keymap.set('n', '<leader>sF', ':Telescope find_files hidden=true<cr>', { desc = '[S]earch [F]iles' })
vim.keymap.set('n', '<leader>gf', require('telescope.builtin').git_files, { desc = 'Search [G]it [F]iles' })

-- Set <C-p> to use require('telescope.builtin').find_files to mimic the VS Code
-- behavior.
vim.api.nvim_set_keymap('n', '<C-p>', '', {})
vim.keymap.set('n', '<C-p>', function()
  require('telescope.builtin').find_files({
    layout_strategy = 'vertical', prompt_prefix = "🔍 " })
end, { desc = '[S]earch [F]iles (without hidden)' })
vim.keymap.set('n', '<leader><C-g>', require('telescope.builtin').live_grep, { desc = '[G] is for grep' })


vim.keymap.set('n', '<leader>sh', require('telescope.builtin').help_tags, { desc = '[S]earch [H]elp' })
vim.keymap.set('n', '<leader>sw', require('telescope.builtin').grep_string, { desc = '[S]earch current [W]ord' })
vim.keymap.set(
  'n', '<leader>sg', function()
    require('telescope.builtin').live_grep({
      layout_strategy = 'vertical', prompt_prefix = "🔍 " })
  end, { desc = '[S]earch by [G]rep' })
vim.keymap.set('n', '<leader>sd', require('telescope.builtin').diagnostics, { desc = '[S]earch [D]iagnostics' })

-- [[ Custom setup ]]
vim.api.nvim_set_keymap('n', '<A-h>', ':lua vim.diagnostic.open_float()<CR>', { silent = true })
-- vim.keymap.set('n', '<A-h>', ':lua vim.diagnostic.open_float()<CR>', { silent = true })

return mod
