-- Read-only Mason checker used by `just health`: the lock matches the
-- installed receipts, and each installer Mason needs runs from Neovim.
local source = debug.getinfo(1, 'S').source:sub(2)
local nvim_dir = vim.fn.fnamemodify(source, ':p:h')
package.path = nvim_dir .. '/lua/?.lua;' .. package.path

local mason_root = vim.env.MASON_ROOT
  or vim.env.MASON
  or (vim.fn.stdpath('data') .. '/mason')

local mason_lock = require('core.mason-lock')
local ok = mason_lock.check {
  lock_path = vim.env.MASON_LOCK_PATH or (nvim_dir .. '/mason.lock'),
  mason_root = vim.env.MASON_ROOT,
}

for _, problem in ipairs(require('core.mason-installers').problems(mason_root)) do
  vim.api.nvim_err_writeln('mason: ' .. problem)
  ok = false
end

vim.cmd('cquit ' .. (ok and '0' or '1'))
