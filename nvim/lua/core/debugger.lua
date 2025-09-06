--- core/debugger.lua
---
--- "dap" is short for debugging adapter protocol.
--- [TJ DeVries - simple neovim debugging setup (in 10 minutes)](https://youtu.be/lyNfnI-B640)

local dap = require("dap")
local ui = require("dapui")

require("dapui").setup()
require("dap-go").setup()

-- Handled by nvim-dap-go. Included as documentation
--
-- dap.adapters.go = {
--   type  = "server",
--   port  = "${port}",
--   executable = {
--     command = "dlv",
--     args = { "dap", "-l", "127.0.0.1:${port}" },
--   },
-- }

vim.keymap.set('n', "<leader>b", dap.toggle_breakpoint,
  { desc = '[d]ebugger [b]reakpoint' }
)
vim.keymap.set('n', "<leader>drc", dap.run_to_cursor,
  { desc = '[d]ebugger [r]un to [c]ursor' }
)

-- Evaluate var under cursor
vim.keymap.set("n", "<leader>?", function()
  require("dapui").eval(nil, { enter = true })
end)

vim.keymap.set("n", "<leader>dc", dap.continue)
vim.keymap.set("n", "<F1>", dap.step_into)
vim.keymap.set("n", "<F2>", dap.step_over)
vim.keymap.set("n", "<F8>", dap.step_out)
vim.keymap.set("n", "<F9>", dap.step_back)
vim.keymap.set("n", "<F10>", dap.restart)

dap.listeners.before.attach.dapui_config = function()
  ui.open()
end
dap.listeners.before.launch.dapui_config = function()
  ui.open()
end
dap.listeners.before.event_terminated.dapui_config = function()
  ui.close()
end
dap.listeners.before.event_exited.dapui_config = function()
  ui.close()
end

vim.keymap.set("n", "<leader>dt", ui.toggle, {})
