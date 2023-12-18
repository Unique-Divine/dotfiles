-- core/harpoon.lua
--
-- See [Primeagen demonstration](https://youtu.be/FrMRyXtiJkc)


--- A shorthand function that lets us more easily define keymaps. It sets
--- normal mode and a description on each call.
---@param keys string Keymap definition statement. Ex.: '<leader>rn', 'gd', '<C-k>'.
---@param func function|string Function to be called after the keymap is used, or a command
---@param desc string Description of what the command does.
local vim_map_n = function(keys, func, desc)
  if desc then
    desc = 'LSP: ' .. desc
  end

  ---@type table|nil
  local opts = { desc = desc } -- Other fields: buffer

  vim.keymap.set('n', keys, func, opts)
end


-- Adds a file to the harpoon mark list.
vim.api.nvim_set_keymap('n', '<leader>a', '', {})
vim_map_n('<leader>a', require("harpoon.mark").add_file, '[A]dd file to harpoon')

-- You can go up and down the list, enter, delete, or reorder.
-- Both `q` and `<ESC>` exit and save the menu.
vim.api.nvim_set_keymap('n', '<C-e>', '', {})
vim_map_n('<C-e>', require("harpoon.ui").toggle_quick_menu, 'Toggle quick m[E]nu for harpoon')

vim.api.nvim_set_keymap('n', '<C-n>', '', {})
vim_map_n('<C-n>', require("harpoon.ui").nav_next, 'harpoon [N]ext')
-- vim.api.nvim_set_keymap('n', '<C-t>', '', {})
-- vim_map_n('<C-t>', require("harpoon.ui").nav_prev, 'harpoon [T]ime before')

-- vim_map_n('<C-h>', require("harpoon.ui").toggle_quick_menu, 'Toggle quick m[E]nu for harpoon')

-- nmap('gd', vim.lsp.buf.definition, '[G]oto [D]efinition')
