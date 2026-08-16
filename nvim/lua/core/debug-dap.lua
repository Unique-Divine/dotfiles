-- Lazy spec for nvim-dap. Loaded on debug keys/commands only.
--
-- Do not call setup_dap() from init.lua. That loads DAP on every start.
-- mason-nvim-dap is omitted on purpose: its default handlers load every
-- adapter config (~177ms in the startup log).
--
-- "dap" is short for debugging adapter protocol.
-- [TJ DeVries - simple neovim debugging setup](https://youtu.be/lyNfnI-B640)

-- Defining this above the spec is fine. require() of this file only
-- creates the function; Lazy calls it later when a cmd/key loads DAP.
local function setup_dap()
  local dap = require('dap')
  local ui = require('dapui')

  require('dapui').setup()
  require('dap-go').setup()

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

  vim.keymap.set('n', '<leader>b', dap.toggle_breakpoint,
    { desc = '[d]ebugger [b]reakpoint' }
  )
  vim.keymap.set('n', '<leader>drc', dap.run_to_cursor,
    { desc = '[d]ebugger [r]un to [c]ursor' }
  )

  -- Evaluate var under cursor
  vim.keymap.set('n', '<leader>?', function()
    require('dapui').eval(nil, { enter = true })
  end)

  vim.keymap.set('n', '<leader>dc', dap.continue)
  vim.keymap.set('n', '<F1>', dap.step_into)
  vim.keymap.set('n', '<F2>', dap.step_over)
  vim.keymap.set('n', '<F8>', dap.step_out)
  vim.keymap.set('n', '<F9>', dap.step_back)
  vim.keymap.set('n', '<F10>', dap.restart)

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

  vim.keymap.set('n', '<leader>dt', ui.toggle, {})
end

return {
  'mfussenegger/nvim-dap',
  dependencies = {
    'rcarriga/nvim-dap-ui',
    'theHamsta/nvim-dap-virtual-text',
    'nvim-neotest/nvim-nio',
    'leoluz/nvim-dap-go',
  },
  cmd = {
    'DapContinue',
    'DapToggleBreakpoint',
    'DapToggleRepl',
    'DapStepInto',
    'DapStepOver',
    'DapStepOut',
    'DapTerminate',
  },
  keys = {
    { '<leader>b', desc = '[d]ebugger [b]reakpoint' },
    { '<leader>drc', desc = '[d]ebugger [r]un to [c]ursor' },
    { '<leader>dc', desc = 'Debug continue' },
    { '<leader>dt', desc = 'Debug UI toggle' },
    { '<F1>', desc = 'DAP step into' },
    { '<F2>', desc = 'DAP step over' },
    { '<F8>', desc = 'DAP step out' },
    { '<F9>', desc = 'DAP step back' },
    { '<F10>', desc = 'DAP restart' },
  },
  config = setup_dap,
}
