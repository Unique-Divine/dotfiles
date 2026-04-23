-- core/treesitter.lua
--
-- nvim-treesitter `main` is a rewrite for Neovim 0.12+:
-- - parsers are installed via `require('nvim-treesitter').install`
-- - highlighting is started with `vim.treesitter.start()`
-- - indentation is enabled by setting `indentexpr`
-- - textobjects are configured by the standalone textobjects plugin

local parsers = {
  'c',
  'cpp',
  'css',
  'go',
  'gomod',
  'gosum',
  'gowork',
  'graphql',
  'html',
  'javascript',
  'json',
  'lua',
  'markdown',
  'markdown_inline',
  'python',
  'rust',
  'scss',
  'tsx',
  'typescript',
  'vim',
  'vimdoc',
  'vue',
}

local indent_languages = {
  c = true,
  cpp = true,
  css = true,
  go = true,
  graphql = true,
  html = true,
  javascript = true,
  json = true,
  lua = true,
  markdown = true,
  python = true,
  rust = true,
  scss = true,
  tsx = true,
  typescript = true,
  vim = true,
  vimdoc = true,
  vue = true,
}

local nvim_treesitter = require('nvim-treesitter')
local ts_move = require('nvim-treesitter-textobjects.move')
local ts_select = require('nvim-treesitter-textobjects.select')
local ts_swap = require('nvim-treesitter-textobjects.swap')
local ts_select_builtin = require('vim.treesitter._select')

nvim_treesitter.setup {
  install_dir = vim.fn.stdpath('data') .. '/site',
}

local installed = nvim_treesitter.get_installed()
local missing = vim.tbl_filter(function(lang)
  return not vim.list_contains(installed, lang)
end, parsers)

if #missing > 0 then
  nvim_treesitter.install(missing)
end

require('nvim-treesitter-textobjects').setup {
  select = {
    lookahead = true,
  },
  move = {
    set_jumps = true,
  },
}

local function map(modes, lhs, rhs, desc)
  vim.keymap.set(modes, lhs, rhs, { desc = desc })
end

-- Incremental selection moved from nvim-treesitter to Neovim core in 0.12.
-- Neovim help refers to the built-in defaults as:
--   - `v_an`: in Visual mode, press `a` then `n` to expand to the parent node
--   - `v_in`: in Visual mode, press `i` then `n` to shrink to the child node
--   - `v_]n`: in Visual mode, press `]` then `n` for the next sibling node
--   - `v_[n`: in Visual mode, press `[` then `n` for the previous sibling node
-- These are powerful because they let you navigate the syntax tree by
-- structure instead of by lines or words:
--   - parent: grow outward to the containing expression / statement / block
--   - child: shrink inward to a more specific nested node
--   - next sibling: move sideways to the next peer at the same tree depth
--   - previous sibling: move sideways to the previous peer at the same depth
-- Example: if the cursor is on one argument in `foo(bar, baz, qux)`, the
-- sibling motions can move selection across `bar` -> `baz` -> `qux` without
-- leaving the argument list.
-- The `v_` prefix is help notation only; it means "this mapping applies in
-- Visual mode". See `:help treesitter`, `:help v_an`, and `:help v_in`.
--
-- Restore the pre-0.12 muscle memory:
--   - `<C-Space>` starts/grows the selection
--   - `<M-Space>` shrinks the selection
map({ 'n', 'x' }, '<C-Space>', function()
  ts_select_builtin.select_parent(vim.v.count1)
end, 'Incremental selection expand')

map({ 'n', 'x' }, '<M-Space>', function()
  ts_select_builtin.select_child(vim.v.count1)
end, 'Incremental selection shrink')

map({ 'x', 'o' }, 'aa', function()
  ts_select.select_textobject('@parameter.outer', 'textobjects')
end, 'Select around parameter')

map({ 'x', 'o' }, 'ia', function()
  ts_select.select_textobject('@parameter.inner', 'textobjects')
end, 'Select inside parameter')

map({ 'x', 'o' }, 'af', function()
  ts_select.select_textobject('@function.outer', 'textobjects')
end, 'Select around function')

map({ 'x', 'o' }, 'if', function()
  ts_select.select_textobject('@function.inner', 'textobjects')
end, 'Select inside function')

map({ 'x', 'o' }, 'ac', function()
  ts_select.select_textobject('@class.outer', 'textobjects')
end, 'Select around class')

map({ 'x', 'o' }, 'ic', function()
  ts_select.select_textobject('@class.inner', 'textobjects')
end, 'Select inside class')

map({ 'n', 'x', 'o' }, ']m', function()
  ts_move.goto_next_start('@function.outer', 'textobjects')
end, 'Go to next function start')

map({ 'n', 'x', 'o' }, ']]', function()
  ts_move.goto_next_start('@class.outer', 'textobjects')
end, 'Go to next class start')

map({ 'n', 'x', 'o' }, ']M', function()
  ts_move.goto_next_end('@function.outer', 'textobjects')
end, 'Go to next function end')

map({ 'n', 'x', 'o' }, '][', function()
  ts_move.goto_next_end('@class.outer', 'textobjects')
end, 'Go to next class end')

map({ 'n', 'x', 'o' }, '[m', function()
  ts_move.goto_previous_start('@function.outer', 'textobjects')
end, 'Go to previous function start')

map({ 'n', 'x', 'o' }, '[[', function()
  ts_move.goto_previous_start('@class.outer', 'textobjects')
end, 'Go to previous class start')

map({ 'n', 'x', 'o' }, '[M', function()
  ts_move.goto_previous_end('@function.outer', 'textobjects')
end, 'Go to previous function end')

map({ 'n', 'x', 'o' }, '[]', function()
  ts_move.goto_previous_end('@class.outer', 'textobjects')
end, 'Go to previous class end')

map('n', '<leader>A', function()
  ts_swap.swap_previous('@parameter.inner')
end, 'Swap with previous parameter')

-- Neovim 0.12 ships built-in treesitter incremental selection in core Neovim,
-- so the removed `nvim-treesitter` incremental_selection module is replaced by
-- the mappings above instead of recreated wholesale.
local function setup_buffer(bufnr)
  if not vim.api.nvim_buf_is_loaded(bufnr) then
    return
  end

  if vim.bo[bufnr].buftype ~= '' then
    return
  end

  local ok = pcall(vim.treesitter.start, bufnr)
  if not ok then
    return
  end

  local filetype = vim.bo[bufnr].filetype
  local lang = vim.treesitter.language.get_lang(filetype) or filetype
  if indent_languages[lang] then
    vim.bo[bufnr].indentexpr = "v:lua.require'nvim-treesitter'.indentexpr()"
  end
end

local group = vim.api.nvim_create_augroup('UserTreesitter', { clear = true })

vim.api.nvim_create_autocmd('FileType', {
  group = group,
  callback = function(args)
    setup_buffer(args.buf)
  end,
})

for _, bufnr in ipairs(vim.api.nvim_list_bufs()) do
  setup_buffer(bufnr)
end

-- Setup this plugin directly and let Comment.nvim trigger it via pre_hook.
require('ts_context_commentstring').setup {
  enable_autocmd = false,
  config = {
    typescript = { __default = '// %s', __multiline = '/* %s */' },
    -- JavaScript can embed JSX without an injected language tree, so specific
    -- node names still need explicit comment styles.
    javascript = {
      __default = '// %s',
      jsx_element = '{/* %s */}',
      jsx_fragment = '{/* %s */}',
      jsx_attribute = '// %s',
      comment = '// %s',
    },
  },
}
