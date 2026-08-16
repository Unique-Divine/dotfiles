-- core/specs/fmt.lua
--
-- Prettier via mhartington/formatter.nvim. Install prettier / prettierd
-- with Mason. https://github.com/mhartington/formatter.nvim

--- @param lang string Language name (e.g. "javascript", "typescript").
--- @return table Prettier formatter table for that language.
local function get_prettier_formatter(lang)
  return {
    require('formatter.filetypes.' .. lang).prettier
  }
end

local languages = {
  'typescript',
  'typescriptreact',
  'javascript',
  'javascriptreact',
  'toml',
  'yaml',
  'vue',
  'graphql',
}

local function plugin_config()
  local formatters_by_language = {}
  for _, lang in ipairs(languages) do
    formatters_by_language[lang] = get_prettier_formatter(lang)
  end

  formatters_by_language['*'] = {}

  require('formatter').setup {
    logging = true,
    filetype = formatters_by_language,
  }

  vim.api.nvim_create_autocmd({ 'BufWritePost' }, {
    command = 'FormatWriteLock',
  })
end

--- @type LazyPluginSpec
local plugin_spec = {
  'mhartington/formatter.nvim',
  config = plugin_config,
}

return plugin_spec
