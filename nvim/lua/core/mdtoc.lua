local M = {}

local function report(message)
  vim.notify('ud-mdtoc: ' .. message, vim.log.levels.ERROR)
end

local function generate(input, inplace)
  local executable = vim.fn.exepath('ud-mdtoc')
  if executable == '' then
    report('command is missing; run just bun-sync from dotfiles')
    return nil
  end

  local args = {
    executable, input, '--bullets=-', '--maxdepth=3', '--no-firsth1',
  }
  if inplace then
    table.insert(args, '-i')
  end

  local options = { text = true }
  if input == '-' then
    options.stdin = table.concat(
      vim.api.nvim_buf_get_lines(0, 0, -1, false), '\n'
    ) .. '\n'
  end
  local ok, result = pcall(function()
    return vim.system(args, options):wait(15000)
  end)
  if not ok then
    report(tostring(result))
    return nil
  end
  if result.code ~= 0 then
    local detail = vim.trim(result.stderr or '')
    report(detail ~= '' and detail or ('command exited ' .. result.code))
    return nil
  end
  return result
end

function M.setup()
  vim.api.nvim_create_user_command('Toc', function()
    local file = vim.fn.expand('%:p')
    if file == '' then
      report('save the buffer first')
      return
    end
    local written, err = pcall(vim.cmd, 'write')
    if not written then
      report(tostring(err))
      return
    end
    if generate(file, true) then
      vim.cmd('edit!')
      vim.notify('ud-mdtoc: updated TOC in place')
    end
  end, { desc = 'Update Markdown TOC at <!-- toc --> marker' })

  vim.api.nvim_create_user_command('TocCopy', function()
    local result = generate('-', false)
    if not result then
      return
    end
    local copied, err = pcall(vim.fn.setreg, '+', result.stdout)
    if copied then
      vim.notify('ud-mdtoc: copied TOC to clipboard')
    else
      report('clipboard failed: ' .. tostring(err))
    end
  end, { desc = 'Copy Markdown TOC from the current buffer' })
end

return M
