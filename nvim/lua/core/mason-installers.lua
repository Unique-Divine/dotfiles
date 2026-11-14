--- Check that the tools Mason installs packages with run from Neovim's PATH.
---
--- mason.lock checks receipts, which pass even when Mason cannot reinstall
--- or update anything. This reads each receipt's package URL type
--- (pkg:npm, pkg:golang, ...) and runs the matching installer's version
--- command. https://github.com/Unique-Divine/dotfiles/issues/128

local M = {}

--- Version command per package URL type. Types not listed (github, generic)
--- download release assets and need no installer on PATH.
M.installer_commands = {
  npm = { 'npm', '--version' },
  golang = { 'go', 'version' },
  cargo = { 'cargo', '--version' },
  pypi = { 'python3', '--version' },
  gem = { 'gem', '--version' },
  composer = { 'composer', '--version' },
}

--- @param source_id string like "pkg:npm/prettier@3.9.6"
--- @return string|nil
function M.purl_type(source_id)
  return source_id:match('^pkg:([%w_-]+)/')
end

--- Map package names to the installer commands their sources need.
--- @param sources table<string, string> package name -> receipt source id
--- @return table<string, string[]> purl type -> sorted package names
function M.needed_installers(sources)
  local needed = {}
  for name, source_id in pairs(sources) do
    local kind = M.purl_type(source_id)
    if kind and M.installer_commands[kind] then
      needed[kind] = needed[kind] or {}
      table.insert(needed[kind], name)
    end
  end
  for _, names in pairs(needed) do
    table.sort(names)
  end
  return needed
end

--- @param root string Mason install root
--- @return table<string, string> package name -> receipt source id
function M.read_sources(root)
  local sources = {}
  local package_dir = root .. '/packages'
  for name, kind in vim.fs.dir(package_dir) do
    local receipt = package_dir .. '/' .. name .. '/mason-receipt.json'
    if kind == 'directory' and vim.fn.filereadable(receipt) == 1 then
      local ok, data = pcall(vim.json.decode,
        table.concat(vim.fn.readfile(receipt), '\n'))
      local source = ok and type(data) == 'table'
        and (data.source or data.primary_source)
      if source and type(source.id) == 'string' then
        sources[name] = source.id
      end
    end
  end
  return sources
end

--- Run each needed installer; return one problem line per failure.
--- @param root string Mason install root
--- @return string[]
function M.problems(root)
  local problems = {}
  local needed = M.needed_installers(M.read_sources(root))
  local kinds = vim.tbl_keys(needed)
  table.sort(kinds)
  for _, kind in ipairs(kinds) do
    local cmd = M.installer_commands[kind]
    local ok, result = pcall(function()
      return vim.system(cmd, { text = true }):wait(15000)
    end)
    if not ok or result.code ~= 0 then
      local detail = ok and vim.trim(result.stderr or '') or tostring(result)
      detail = vim.split(detail, '\n', { plain = true })[1] or ''
      problems[#problems + 1] = ('`%s` fails from Neovim (%s), so Mason '
        .. 'cannot install or update: %s'):format(
        table.concat(cmd, ' '), detail, table.concat(needed[kind], ', '))
    end
  end
  return problems
end

return M
