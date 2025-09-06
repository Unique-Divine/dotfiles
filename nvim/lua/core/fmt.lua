--- core/fmt.lua: Formatter since null-ls is archived
--- This largely works in conjunction with 'prettier', which is installed via
--- the 'williamboman/mason.nvim' plugin.
---
--- Note that formatter comes from this plugin.
--- https://github.com/mhartington/formatter.nvim
local formatter = require('formatter')
local _util = require('formatter.util')

--- @param lang string: The language name (e.g., "javascript", "typescript").
--- @return table: A table containing the prettier formatter for the given language.
--- Get the prettier formatter for a given language.
local function getPrettierFormatter(lang)
  return {
    require("formatter.filetypes." .. lang).prettier
  }
end

--- Languages that will get prettier formatting.
local languages = {
  "typescript",
  "typescriptreact",
  "javascript",
  "javascriptreact",
  "toml",
  "yaml",
  "vue",
  "graphql",
}

-- Populate formatters for each language.
local formatters_by_language = {}
for _, lang in ipairs(languages) do
  formatters_by_language[lang] = getPrettierFormatter(lang)
end

--- formatterOpt: For plugin, 'mhartington/formatter.nvim'
local formatterOpt = {
  logging = true,
  -- [Available file types](https://github.com/mhartington/formatter.nvim/tree/master/lua/formatter/filetypes)
  -- [Per-formatter defaults](https://github.com/mhartington/formatter.nvim/tree/master/lua/formatter/defaults)
  filetype = formatters_by_language
}

formatterOpt.filetype["*"] = {
  -- For example:
  -- require("formatter.filetypes.any").remove_trailing_whitespace
}

formatter.setup(formatterOpt)

-- formatter-format-after-save
-- Format and write after save asynchronously:
vim.api.nvim_create_autocmd({ "BufWritePost" },
  { command = "FormatWriteLock" }
)

-- 2025-06-13: I did an exploration on how formatter.nvim
-- (https://github.com/mhartington/formatter.nvim) works to understand what
-- arguments prettier gets and why it doesn't respect repospecific prettier configs.
-- I didn't fix the issue, but the deep dive was quite enlightening.
--
-- vim.api.nvim_create_autocmd({ "BufWritePost" }, {
--   callback = function()
--     print("UD-DEBUG: I RAN!!")
--     local ft = vim.bo.filetype
--     local formatters = require("formatter.config").values.filetype[ft]
--     if formatters then
--       for _, fmt in ipairs(formatters) do
--         if type(fmt) == "function" then
--           local result = fmt()
--           print("Formatter config for " .. ft .. ":")
--           print(vim.inspect(result))
--         end
--       end
--     else
--       print("No formatter configured for filetype: " .. ft)
--     end
--   end,
-- })

--[[
Before/after format hooks
`FormatterPre`
`FormatterPost`
```vim
  augroup FormatAutogroup
    autocmd!
    autocmd User FormatterPre lua print "This will print before formatting"
    autocmd User FormatterPost lua print "This will print after formatting"
  augroup END
```
]]
--
return {}
