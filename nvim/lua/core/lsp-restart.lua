--- Restart an LSP server once after it crashes.
---
--- vim.lsp.enable starts a server when a buffer's filetype matches, but does
--- not restart one that exits. A single slow startup (marksman timing out
--- while indexing a large repo) otherwise leaves the session without that
--- server. A second crash within `window_ms` leaves it stopped.
--- https://github.com/Unique-Divine/dotfiles/issues/128

local M = {}

M.window_ms = 60 * 1000

--- Decide whether to restart a server that just exited.
--- @param last_restart_ms integer|nil when this server was last restarted
--- @param code integer process exit code
--- @param signal integer signal that ended the process, or 0
--- @param now_ms integer
--- @param window_ms integer
--- @return boolean
function M.should_restart(last_restart_ms, code, signal, now_ms, window_ms)
  if code == 0 and signal == 0 then
    return false
  end
  return last_restart_ms == nil or now_ms - last_restart_ms >= window_ms
end

--- @type table<string, integer>
local last_restart = {}

--- on_exit callback for vim.lsp.config('*', { on_exit = ... }).
--- @param code integer
--- @param signal integer
--- @param client_id integer
function M.on_exit(code, signal, client_id)
  local client = vim.lsp.get_client_by_id(client_id)
  local name = client and client.name
  if vim.v.exiting ~= vim.NIL then
    return
  end
  if not name or not vim.lsp.is_enabled(name) then
    return
  end

  local now = vim.uv.now()
  local restart =
    M.should_restart(last_restart[name], code, signal, now, M.window_ms)
  if not restart then
    if code ~= 0 or signal ~= 0 then
      vim.schedule(function()
        vim.notify(('%s exited again (code %d, signal %d); not restarting.')
          :format(name, code, signal), vim.log.levels.WARN)
      end)
    end
    return
  end

  last_restart[name] = now
  vim.defer_fn(function()
    vim.notify(('%s exited (code %d, signal %d); restarting.')
      :format(name, code, signal), vim.log.levels.WARN)
    -- Re-enabling runs the FileType autocmd for loaded buffers.
    vim.lsp.enable(name)
  end, 1000)
end

return M
