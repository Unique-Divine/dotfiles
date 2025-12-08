-- Gives you a permanent fat cursor
vim.opt.guicursor = ""
vim.opt.tabstop = 4
vim.opt.softtabstop = 2
vim.opt.shiftwidth = 2
vim.opt.expandtab = true

-- Store a directory to keep a massive history of undos
vim.opt.undodir = os.getenv("HOME") .. "/.vim/undodir"
vim.opt.undofile = true

-- Keep terms highlighted when searching
vim.opt.hlsearch = true
-- Incrementally highlight terms when search
vim.opt.incsearch = true

-- vim.opt.termguicolors = true
vim.opt.scrolloff = 8

-- Unbind <C-b> for tmux (terminal multiplexer).
vim.keymap.set("n", "<C-b>", function() end)

-- greatest remap ever
vim.keymap.set("x", "<leader>p", "\"_dP")

-- Line wrap for long lines was making j -> gj and k -> gk. I did not like that
-- and instead want the default vim behavior where j and k always move one line.
-- These lines make sure that `j` and `k` work normally.
vim.keymap.set("n", "j", "j", { noremap = true })
vim.keymap.set("n", "k", "k", { noremap = true })


-- textdwith option
-- In vim, the `textwidth` option, or `tw` for short, controls the maximum width of text that is allowed in a line. When you use the `gq` command to format text, it will wrap lines to ensure they do not exceed the `textwidth` setting.
local textwidth = 81
vim.opt.colorcolumn = tostring(textwidth + 1)
vim.opt.textwidth = textwidth
-- [2024-08-14]: I observed that the textwidth setting was being respected but
-- wasn't set to the proper global value in Rust files.
-- Using `:set textwidth?` allowed me to inspect the value in different buffers.
-- Opening nvim shows the value we expect, but the value changes in *.rs files.
--
-- This "autocmd" is a workaround that overrides the vim.opt in a local scope
-- (vim.opt_local), forcing Rust files to have the proper textwidth setting..
vim.api.nvim_create_autocmd("FileType", {
  pattern = "rust",
  callback = function()
    vim.opt_local.textwidth = textwidth
  end,
})

-- The `formatoptions` settings in Vim controls how and when automatic text
-- formatting (like line wrapping) occurs. Each letter in the value of
-- `formatoptions` represents a specific behavior.
-- - `:help formatoptions`: for full docs
-- - `:help fo-table`: to see all available options in detail.
--
-- For example, the `t` option is for auto-wrapping text using `textwidth`.
-- When `t` is present, it automatically wraps text lines to fit within the width
-- specificed by `vim.opt.textwidth` as you type.
--
-- By disabling `t` here, the text won't automatically wrap as you type, however
-- you can still wrap manually using `gq`.
-- ```lua
-- vim.cmd [[set formatoptions-=t]]
-- ```

-- `buffer=true` ensures that the keymap defined in the statement will only be
-- active within the current buffer, providing localized behavior rather than
-- affecting global keymaps.

-- netrw is the default Vim explorer. It's what comes up when you use
-- commands like: ":Ex", ":e .", ":Explore", and ":E".
vim.cmd([[
  autocmd FileType netrw silent! nmap <buffer> <A-h> <F1>
]])

-- To change the default tree list mode in `netrw`, set the `g:netrw_liststyle` variable.
-- The possible values for `g:netrw_liststyle` are:
--
-- 0: Thin (one file/dir per line without any additional information, the default).
-- 1: Thin, with tree listing.
-- 2: Long (detailed listing with one file/dir per line).
-- 3: Wide (multiple files/dirs per line).
-- 4: Tree (like the "thin" tree but with file sizes and dates).
-- 5: Changes to the next style each time netrw is started.
-- vim.g.netrw_liststyle = 3

-- We're using the `:syntax keyword` command to add keywords to the a syntax
-- group like `UniqueDivineTODO`.
--
-- The `highlight link` block ensures that the syntax group will be highlighted
-- with the built-in `Todo` group, which typically represents tasks and to-dos.
vim.cmd([[
  " highlight Todo ctermbg=cyan ctermfg=black guibg="#4795a9" guifg=black
  syntax match UniqueDivineTODO /\v(TODO|FIXME|NOTE|Q:)/
  highlight UniqueDivineTODO ctermbg=cyan ctermfg=black guibg=cyan guifg=black
  highlight link UniqueDivineTODO ToolbarButton
  highlight link Todo UniqueDivineTODO
]])

vim.cmd([[
  syntax match UniqueDivineTODO /\v(TODO|FIXME|NOTE|Q:)/
  highlight UniqueDivineTODO guibg=cyan ctermbg=cyan

  syn match customPattern "car[0-9]\+"
  hi customPattern guifg=cyan ctermbg=cyan
  " highlight UniqueDivineTODO TODO FIXME NOTE
]])

-- highlight link [target-group] [source-group]
-- `[target-group]`: Syntax highlighting group you want to apply properties to.
-- `[source-group]`: Syntax highlighting group it will inherit/link from.
-- TODO

-- This forces `:E` to map to `:Explore` even if another plugin has already
-- overwritten that command.
vim.cmd([[
  command! E Explore
]])

return {}
