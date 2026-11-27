local M = {}
local package_dir = vim.env.WSL_CROSS_HUB_PACKAGEDIR
local root = vim.fs.joinpath(vim.env.LOCALAPPDATA or '', 'WslCrossHub')
local settings_path = vim.fs.joinpath(root, 'desktop-settings.json')
local powershell = vim.fs.joinpath(vim.env.SystemRoot or 'C:/Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
local labels = {
  ['windows-ssh'] = 'Windows SSH',
  ['windows-herdr'] = 'Windows Herdr',
  ['ubuntu-herdr'] = 'Ubuntu Herdr',
  ['windows-neovim'] = 'Windows Neovim',
  ['ubuntu-neovim'] = 'Ubuntu Neovim',
}
local runners = { codex = 'Codex', claude = 'Claude', managed = 'Dotfiles installer', off = 'Off' }
local effects = {
  ['windows-ssh'] = 'Run the installed recovery task. It can start OpenSSH and Tailscale.',
  ['windows-herdr'] = 'Start the saved Windows Herdr session.',
  ['ubuntu-herdr'] = 'Start the saved Ubuntu Herdr server.',
  ['windows-neovim'] = 'Install the pinned Windows Neovim ZIP and apply the staged dotfiles config.',
  ['ubuntu-neovim'] = 'Install Neovim with the mise lock and restore the managed dotfiles config link.',
}
local state = { buffers = {}, rows = {}, report = {}, note = '', auto = 'off' }
local hints = vim.api.nvim_create_namespace('cross-hub-hints')

local function text(value)
  local value_type = type(value)
  return (value_type == 'string' or value_type == 'number') and tostring(value):gsub('%c', ' ') or ''
end

local function pending(job)
  return type(job) == 'table' and (job.state == 'queued' or job.state == 'accepted' or job.state == 'running')
end

local function visible(view)
  return state.win and vim.api.nvim_win_is_valid(state.win)
    and vim.api.nvim_win_get_buf(state.win) == state.buffers[view]
end

local function read_settings()
  local ok, lines = pcall(vim.fn.readfile, settings_path)
  local decoded, settings = false, nil
  if ok then
    decoded, settings = pcall(vim.json.decode, table.concat(lines, '\n'))
  end
  if decoded and type(settings) == 'table' then
    local value = settings.autoInvestigate
    return (value == 'codex' or value == 'claude') and value or 'off'
  end
  return 'off'
end

local function command(argv, on_exit)
  local ok, failure = pcall(vim.system, argv, { text = true, timeout = 35000 }, vim.schedule_wrap(on_exit))
  if not ok then
    vim.schedule(function() on_exit({ code = 1, stderr = tostring(failure) }) end)
  end
end

local function request(operation, arguments, on_result)
  local argv = { powershell, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', vim.fs.joinpath(package_dir, 'status.ps1'), '-Operation', operation }
  vim.list_extend(argv, arguments)
  command(argv, function(result)
    local ok, output = pcall(vim.json.decode, result.stdout or '')
    if result.code ~= 0 or not ok or type(output) ~= 'table' then
      local error_message = vim.trim(result.stderr or '')
      on_result(nil, error_message == '' and 'Windows status helper returned no data.'
        or text(error_message):sub(1, 400))
      return
    end
    on_result(output)
  end)
end

local render, show, refresh, load_log, set_auto, submit

local function add(rows, id, title, hint, action)
  rows[#rows + 1] = { id = id, title = title, hint = hint, action = action }
end

local function row_hint(rows, line)
  local row = rows[line]
  if not row then
    return ''
  end
  return row.action and ('Enter · ' .. row.hint) or row.hint or ''
end

M.row_hint = row_hint

local function update_hint()
  if not state.win or not vim.api.nvim_win_is_valid(state.win) then
    return
  end
  if vim.api.nvim_get_current_win() ~= state.win or vim.api.nvim_win_get_buf(state.win) ~= state.buffers[state.view] then
    return
  end
  local line = vim.api.nvim_win_get_cursor(state.win)[1]
  local guidance = row_hint(state.rows[state.view] or {}, line)
  local buffer = state.buffers[state.view]
  vim.api.nvim_buf_clear_namespace(buffer, hints, 0, -1)
  if guidance ~= '' then
    vim.api.nvim_buf_set_extmark(buffer, hints, line - 1, 0, {
      virt_text = { { '  ' .. guidance, 'Comment' } },
      virt_text_pos = 'eol',
    })
  end
  local status = state.view == 'doctor' and 'Doctor' or state.view == 'confirm' and 'Confirm' or 'WSL Cross Hub'
  local bar = ' ' .. status .. '  ' .. guidance
  vim.wo[state.win].statusline = bar:gsub('%%', '%%%%') .. ' %= / search · n/N matches · F1 keys '
end

local function buffer_for(view)
  if state.buffers[view] and vim.api.nvim_buf_is_valid(state.buffers[view]) then
    return state.buffers[view]
  end
  local buffer = vim.api.nvim_create_buf(false, true)
  state.buffers[view] = buffer
  vim.api.nvim_buf_set_name(buffer, 'cross-hub://' .. view)
  vim.bo[buffer].buftype = 'nofile'
  vim.bo[buffer].bufhidden = 'hide'
  vim.bo[buffer].swapfile = false
  vim.bo[buffer].modifiable = false
  vim.bo[buffer].readonly = true
  vim.keymap.set('n', '<CR>', function()
    local row = (state.rows[view] or {})[vim.api.nvim_win_get_cursor(0)[1]]
    if row and row.action then
      row.action()
    end
  end, { buffer = buffer, desc = 'Run selected WSL Cross Hub action' })
  vim.keymap.set('n', '<Esc>', function()
    if view == 'doctor' or view == 'logs' then
      vim.cmd('quit')
    else
      show('doctor')
    end
  end, { buffer = buffer, desc = 'Back or close WSL Cross Hub' })
  vim.keymap.set('n', '<F5>', function()
    if view == 'doctor' then
      refresh(false)
    elseif view == 'journal' or view == 'logs' then
      load_log(view)
    end
  end, { buffer = buffer, desc = 'Refresh current screen' })
  -- Keep ? as native backward search. F1 shows WSL Cross Hub mappings.
  vim.keymap.set('n', '<F1>', function()
    vim.notify('Enter opens the selected row. F5 refreshes. Esc goes back or closes. / and ? search. n/N move to matches.')
  end, { buffer = buffer, desc = 'WSL Cross Hub keys' })
  vim.api.nvim_create_autocmd({ 'CursorMoved', 'BufEnter' }, { buffer = buffer, callback = update_hint })
  return buffer
end

local function set_rows(rows)
  local view = state.view
  local buffer = buffer_for(view)
  local previous = state.rows[view] or {}
  local current = vim.api.nvim_win_get_cursor(state.win)
  local selected = previous[current[1]] and previous[current[1]].id
  local line = math.min(current[1], #rows)
  if state.focus then
    selected = state.focus
    state.focus = nil
  end
  local lines = {}
  for index, row in ipairs(rows) do
    lines[index] = text(row.title)
    if row.id and row.id == selected then
      line = index
    end
  end
  state.rows[view] = rows
  if not vim.deep_equal(lines, vim.api.nvim_buf_get_lines(buffer, 0, -1, false)) then
    vim.bo[buffer].readonly = false
    vim.bo[buffer].modifiable = true
    vim.api.nvim_buf_set_lines(buffer, 0, -1, false, lines)
    vim.bo[buffer].modifiable = false
    vim.bo[buffer].modified = false
    vim.bo[buffer].readonly = true
  end
  pcall(vim.api.nvim_win_set_cursor, state.win, { math.max(1, line), current[2] })
  update_hint()
end

local function selected_check()
  for _, group in ipairs({ state.report.checks or {}, state.report.editors or {} }) do
    for _, check in ipairs(group) do
      if check.id == state.check then
        return check
      end
    end
  end
end

local function editor_check(check)
  return check and check.expectedVersion ~= nil
end

local function selected_runner(check)
  if editor_check(check) then
    return 'managed'
  end
  local available = check and check.runners or {}
  return vim.tbl_contains(available, state.runner or '') and state.runner or available[1]
end

local function choose(title, entries, selected, on_choice)
  state.picker = { title = title, entries = entries, selected = selected, on_choice = on_choice }
  show('picker', selected)
end

local function confirmation(mode, check, runner)
  state.confirm = { mode = mode, check = check, runner = runner }
  show('confirm', 'cancel')
end

local function doctor_rows()
  local rows = {}
  add(rows, nil, 'WSL Cross Hub Doctor')
  if state.note ~= '' then
    add(rows, nil, state.note)
  end
  add(rows, nil, '')
  for _, group in ipairs({ state.report.checks or {}, state.report.editors or {} }) do
    for _, check in ipairs(group) do
      local label = labels[check.id] or check.id
      local selected = state.check == check.id and '> ' or '  '
      local suffix = ' · ' .. check.state
      if editor_check(check) then
        suffix = suffix .. ' · ' .. (text(check.version) ~= '' and text(check.version) or 'version unavailable')
          .. ' / ' .. check.expectedVersion .. (check.configMatches and ' · config matches' or ' · config unverified')
      end
      add(rows, check.id, selected .. label .. suffix, 'Select ' .. label, function()
        state.check = check.id
        render()
      end)
      add(rows, nil, '    ' .. text(check.detail))
    end
  end
  if not state.report.checks then
    add(rows, nil, 'Waiting for Doctor checks.')
  end
  add(rows, nil, '')
  local check = selected_check()
  local runner = selected_runner(check)
  local managed = editor_check(check)
  local runner_options = check and check.runners or {}
  add(rows, 'runner', 'Runner · ' .. (runners[runner or ''] or 'unavailable'),
    managed and 'This check uses the dotfiles installer'
      or #runner_options == 0 and 'No signed-in runner is available' or 'Choose a runner',
    #runner_options > 0 and function()
      choose('Choose runner', runner_options, runner, function(value)
        state.runner = value
        show('doctor', 'runner')
      end)
    end or nil)
  add(rows, 'refresh', 'Check now', 'Refresh the Doctor checks', function() refresh(false) end)
  local busy = state.submitting or pending(state.report.latestJob)
  local reason = busy and 'A Doctor job is running'
    or not check and 'Select a check'
    or check.state == 'healthy' and 'The selected check is healthy'
    or not runner and 'No signed-in runner is available'
    or nil
  local investigate_reason = managed and 'Use Cure to apply the dotfiles pin' or reason
  add(rows, 'investigate', 'Investigate', investigate_reason or 'Review and confirm investigation',
    not investigate_reason and function() confirmation('investigate', check, runner) end or nil)
  local cure_reason = reason or (managed and not check.canCure and 'See the check detail for prerequisites')
    or (check.state ~= 'failed' and 'Cure requires a failed check') or nil
  add(rows, 'cure', 'Cure', cure_reason or 'Review and confirm the recovery action',
    not cure_reason and function() confirmation('cure', check, runner) end or nil)
  add(rows, 'auto', 'Auto-investigate · ' .. runners[state.auto], 'Choose automatic investigation setting', function()
    choose('Auto-investigate', { 'off', 'codex', 'claude' }, state.auto, set_auto)
  end)
  local job = type(state.report.latestJob) == 'table' and state.report.latestJob or nil
  add(rows, 'journal', 'Open journal', job and 'Read the latest Doctor job journal' or 'No Doctor job recorded',
    job and function()
      state.job_id = job.job_id
      show('journal')
      load_log('journal')
    end or nil)
  if job then
    add(rows, nil, '')
    add(rows, nil, 'Latest job · ' .. text(job.state) .. ' · ' .. text(job.job_id))
    if type(job.result) == 'table' then
      add(rows, nil, text(job.result.outcome) .. ' · ' .. text(job.result.detail or job.result.error))
    end
  end
  return rows
end

render = function()
  if not state.win or not vim.api.nvim_win_is_valid(state.win) or vim.fn.getcmdtype() ~= '' then
    return
  end
  if vim.api.nvim_win_get_buf(state.win) ~= state.buffers[state.view] then
    return
  end
  local rows = {}
  if state.view == 'doctor' then
    rows = doctor_rows()
  elseif state.view == 'picker' then
    local picker = state.picker
    add(rows, nil, picker.title)
    add(rows, nil, '')
    for _, item in ipairs(picker.entries) do
      add(rows, item, runners[item], 'Select ' .. runners[item], function() picker.on_choice(item) end)
    end
  elseif state.view == 'confirm' then
    local selected = state.confirm
    local check = labels[selected.check.id] or selected.check.id
    local action = selected.mode == 'cure' and 'Cure' or 'Investigate'
    add(rows, nil, action .. ' · ' .. check .. ' · ' .. runners[selected.runner])
    add(rows, nil, selected.mode == 'cure' and effects[selected.check.id] or 'Run a read-only agent investigation.')
    add(rows, nil, '')
    add(rows, 'cancel', 'Cancel', 'Return to Doctor', function() show('doctor', selected.mode) end)
    add(rows, 'submit', action, 'Submit ' .. action:lower(), function() submit(selected) end)
  else
    local title = state.view == 'journal' and 'Doctor journal · ' .. text(state.job_id) or 'WSL Cross Hub logs'
    add(rows, nil, title)
    add(rows, nil, '')
    for _, line in ipairs(state.log_lines or { 'Loading…' }) do
      add(rows, nil, line)
    end
  end
  set_rows(rows)
end

show = function(view, focus)
  state.view, state.focus = view, focus
  state.win = vim.api.nvim_get_current_win()
  vim.api.nvim_win_set_buf(state.win, buffer_for(view))
  vim.wo[state.win].cursorline = true
  vim.wo[state.win].wrap = false
  render()
end

set_auto = function(value)
  local tray = vim.fs.joinpath(package_dir, 'wsl-cross-hub-desktop.exe')
  show('doctor', 'auto')
  command({ tray, '--doctor-auto-' .. value }, function(result)
    if result.code == 0 then
      vim.defer_fn(function()
        state.auto = read_settings()
        state.note = state.auto == value and '' or 'The tray could not save Auto-investigate.'
        if state.view == 'doctor' then render() end
      end, 250)
    else
      state.note = 'The tray could not save Auto-investigate.'
      if state.view == 'doctor' then render() end
    end
  end)
end

local function job_arguments(mode, check, runner)
  return { '-Mode', mode, '-CheckId', check, '-Runner', runner }
end

submit = function(selection)
  if state.submitting then
    return
  end
  state.submitting = true
  state.note = 'Submitting Doctor job…'
  show('doctor', selection.mode)
  request('doctor-job', job_arguments(selection.mode, selection.check.id, selection.runner), function(job, error_message)
    state.submitting = false
    state.note = error_message or ''
    if job then state.report.latestJob = job end
    if state.view == 'doctor' then render() end
  end)
end

local function auto_observe(index)
  local checks = state.report.checks or {}
  local check = checks[index]
  if state.view ~= 'doctor' or not visible('doctor') or state.auto == 'off'
    or not check or state.submitting or pending(state.report.latestJob) then
    return
  end
  request('doctor-job', job_arguments('auto', check.id, state.auto), function(job, error_message)
    if job and job.job_id then
      state.report.latestJob = job
      if state.view == 'doctor' then render() end
    elseif error_message then
      state.note = error_message
      if state.view == 'doctor' then render() end
    else
      auto_observe(index + 1)
    end
  end)
end

refresh = function(periodic)
  if state.refreshing then
    return
  end
  state.refreshing = true
  request('doctor', {}, function(report, error_message)
    state.refreshing = false
    state.note = error_message or ''
    state.auto = read_settings()
    if report then
      local known = state.report.latestJob
      state.report = report
      if (state.submitting or pending(known)) and not report.latestJob then
        state.report.latestJob = known
      end
      if not selected_check() then
        local checks = report.checks or {}
        local choice = vim.iter(checks):find(function(check) return check.state == 'failed' end) or checks[1]
        if not state.check and choice then state.focus = choice.id end
        state.check = choice and choice.id
      end
    end
    if state.view == 'doctor' then
      render()
      if periodic and report then auto_observe(1) end
    end
  end)
end

load_log = function(view)
  state.log_lines = nil
  render()
  local operation = view == 'journal' and 'doctor-logs' or 'diagnostic-logs'
  local arguments = view == 'journal' and { '-JobId', state.job_id } or {}
  request(operation, arguments, function(report, error_message)
    if state.view == view then
      state.log_lines = report and report.lines or { error_message }
      render()
    end
  end)
end

function M.start(view)
  if view ~= 'doctor' and view ~= 'logs' then
    error('Unknown WSL Cross Hub view: ' .. tostring(view))
  end
  -- Preserve native search in the user's config, with feedback in this editor instance.
  vim.o.hlsearch = true
  vim.o.incsearch = true
  vim.api.nvim_create_autocmd('CmdlineLeave', { callback = function()
    vim.schedule(render)
  end })
  show(view)
  if view == 'doctor' then
    refresh(true)
    local ticks = 0
    local polling = false
    local timer = assert(vim.uv.new_timer())
    timer:start(2000, 2000, vim.schedule_wrap(function()
      ticks = ticks + 1
      if ticks == 30 then
        ticks = 0
        if state.view == 'doctor' and visible('doctor') then refresh(true) end
      end
      local job = state.report.latestJob
      if pending(job) and not polling then
        polling = true
        request('job', { '-JobId', job.job_id }, function(current, error_message)
          polling = false
          if state.report.latestJob and state.report.latestJob.job_id == job.job_id then
            if current then
              state.report.latestJob = current
              if not pending(current) then refresh(false) end
            else
              state.note = error_message
            end
            if state.view == 'doctor' then render() end
          end
        end)
      end
    end))
    vim.api.nvim_create_autocmd('VimLeavePre', { once = true, callback = function() timer:close() end })
  else
    load_log('logs')
  end
  if vim.env.WSL_CROSS_HUB_READY then
    vim.o.titlestring = vim.env.WSL_CROSS_HUB_TITLE or 'WSL Cross Hub'
    vim.o.title = true
    assert(vim.fn.writefile({ tostring(vim.uv.os_getpid()) }, vim.env.WSL_CROSS_HUB_READY) == 0)
  end
end

if package_dir and vim.env.WSL_CROSS_HUB_VIEW then
  M.start(vim.env.WSL_CROSS_HUB_VIEW)
end

return M
