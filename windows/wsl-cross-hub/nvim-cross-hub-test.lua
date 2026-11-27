vim.env.WSL_CROSS_HUB_PACKAGEDIR = vim.fn.getcwd()
vim.env.WSL_CROSS_HUB_VIEW = nil
local requests = {}
vim.system = function(argv, _, callback)
  local operation = argv[9]
  requests[#requests + 1] = { operation = operation, argv = argv }
  local report = {
    checks = {
      { id = 'windows-ssh', state = 'failed', detail = 'Service absent', runners = { 'codex', 'claude' } },
    },
    editors = {
      { id = 'ubuntu-neovim', state = 'failed', detail = 'Missing config', expectedVersion = '0.12.6', canCure = true },
    },
    latestJob = { job_id = 'earlier', state = 'completed', result = { outcome = 'healthy' } },
  }
  local reply = operation == 'doctor' and report
    or operation == 'doctor-logs' and { lines = { 'journal fixture' } }
    or { job_id = 'submitted', state = 'accepted' }
  vim.schedule(function()
    callback({ code = 0, stdout = vim.json.encode(reply), stderr = '' })
  end)
end
local doctor = dofile('windows/wsl-cross-hub/nvim-cross-hub.lua')
doctor.start('doctor')

local function find(pattern, exact)
  for line, content in ipairs(vim.api.nvim_buf_get_lines(0, 0, -1, false)) do
    if (exact and content == pattern) or (not exact and content:find(pattern, 1, true)) then
      return line
    end
  end
end

local function key(name)
  vim.api.nvim_feedkeys(vim.keycode(name), 'mx', false)
end

local function enter(label, exact)
  local line = assert(find(label, exact), label)
  vim.api.nvim_win_set_cursor(0, { line, 0 })
  key('<CR>')
end

assert(vim.wait(500, function() return find('Service absent') ~= nil end))
assert(not vim.bo.modifiable)
assert(vim.fn.maparg('/', 'n') == '' and vim.fn.maparg('n', 'n') == '')
assert(vim.fn.maparg('<C-u>', 'n') == '')
enter('Ubuntu Neovim')
assert(find('Runner · Dotfiles installer'))
enter('Cure', true)
assert(vim.api.nvim_win_get_cursor(0)[1] == find('Cancel'))
key('<CR>')
assert(#requests == 1)
enter('Open journal')
assert(vim.wait(500, function() return find('journal fixture') ~= nil end))
key('<Esc>')
enter('Cure', true)
enter('Cure', true)
assert(vim.wait(500, function() return #requests == 3 end))
assert(requests[3].operation == 'doctor-job')
assert(table.concat(requests[3].argv, ' '):find('-Mode cure -CheckId ubuntu-neovim -Runner managed', 1, true))
