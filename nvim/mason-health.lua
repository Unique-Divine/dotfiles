-- Read-only Mason lock checker used by `just health`.
local source = debug.getinfo(1, 'S').source:sub(2)
local nvim_dir = vim.fn.fnamemodify(source, ':p:h')
package.path = nvim_dir .. '/lua/?.lua;' .. package.path

local mason_lock = require('core.mason-lock')
local ok = mason_lock.check {
  lock_path = vim.env.MASON_LOCK_PATH or (nvim_dir .. '/mason.lock'),
  mason_root = vim.env.MASON_ROOT,
}

vim.cmd('cquit ' .. (ok and '0' or '1'))
