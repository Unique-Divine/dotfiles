-- core/vim.lua: Setting options for `vim.opt` and `vim.o`.
-- See `:help vim.o`

-- Cursor contrast in the terminal:
--
-- An empty `guicursor` setting leaves the cursor shape and colors to Windows
-- Terminal. Its block cursor normally reverses the foreground and background
-- of the cell below it. That makes syntax text easy to read, but a cursor on
-- dark indentation guides can turn into an almost-black block.
vim.opt.guicursor = ""

-- Use this fixed light-blue block only while the cursor is in leading spaces or
-- tabs. It covers the usual indent-guide failure case without replacing the
-- terminal's nicer reverse-video cursor over code.
vim.api.nvim_set_hl(0, "WhitespaceCursor", {
  bg = "#89b4fa",
  fg = "#1e1e2e",
})

-- Indentation guide contrast:
--
-- `indent-blankline.nvim` draws ordinary `┊` guides with the
-- `IndentBlanklineChar` highlight group. The previous color, `#21283b`, was
-- too close to the editor background. Reversing that cell made the terminal
-- cursor hard to see.
--
-- `#2f3a55` keeps ordinary guides muted while leaving enough contrast for the
-- reverse-video cursor. `#59688f` is lighter so the guide for the current
-- syntactic context is easy to distinguish. Adjust these colors together if
-- guides become too prominent or the cursor becomes hard to find again.
--
-- `nocombine` prevents Neovim from blending a guide color with syntax colors
-- below it. The guide then keeps the color defined here.
local function set_indent_guide_highlights()
  vim.api.nvim_set_hl(0, "IndentBlanklineChar", {
    fg = "#2f3a55",
    nocombine = true,
  })
  vim.api.nvim_set_hl(0, "IndentBlanklineSpaceChar", {
    fg = "#2f3a55",
    nocombine = true,
  })
  vim.api.nvim_set_hl(0, "IndentBlanklineContextChar", {
    fg = "#59688f",
    nocombine = true,
  })
end

set_indent_guide_highlights()

-- A colorscheme can reset highlight groups after this file loads. Reapply the
-- guide colors whenever a colorscheme changes.
vim.api.nvim_create_autocmd("ColorScheme", {
  callback = set_indent_guide_highlights,
})

local default_cursor = "a:block"
local indentation_cursor = "a:block-WhitespaceCursor"

local function update_cursor_style()
  -- `col` is zero-based. It is inside the leading indentation when it falls
  -- before the first non-whitespace byte in the line.
  local _, col = unpack(vim.api.nvim_win_get_cursor(0))
  local line = vim.api.nvim_get_current_line()
  local indent = line:match("^[ \t]*") or ""
  local cursor_style = col < #indent and indentation_cursor or default_cursor

  if vim.o.guicursor ~= cursor_style then
    vim.opt.guicursor = cursor_style
  end
end

vim.api.nvim_create_autocmd(
  { "CursorMoved", "CursorMovedI", "InsertEnter", "InsertLeave" },
  { callback = update_cursor_style }
)

update_cursor_style()

vim.opt.tabstop = 4
vim.opt.softtabstop = 2
vim.opt.shiftwidth = 2
vim.opt.expandtab = true

-- Store a directory to keep a massive history of undos
vim.opt.undodir = os.getenv("HOME") .. "/.vim/undodir"
-- Save undo history
vim.opt.undofile = true

-- Set highlight on search
vim.opt.hlsearch = true
-- Incrementally highlight terms when search
vim.opt.incsearch = true

-- Make line numbers default
vim.wo.number = true

-- Enable mouse mode
vim.o.mouse = 'a'

-- Sync clipboard between OS and Neovim.
--  Remove this option if you want your OS clipboard to remain independent.
--  See `:help 'clipboard'`
vim.o.clipboard = 'unnamed,unnamedplus'
vim.g.clipboard = {
  name = "WSL persistent clipboard",
  copy = {
    ["+"] = "pbcopy",
    ["*"] = "pbcopy",
  },
  paste = {
    ["+"] = "pbpaste",
    ["*"] = "pbpaste",
  },
}

vim.api.nvim_create_user_command('WY', function(opts)
  -- Yank text into the '+' register: if a range was provided, yank that range;
  -- otherwise, yank the current line.
  if opts.range > 0 then
    vim.cmd(string.format('%d,%dyank +', opts.line1, opts.line2))
  else
    vim.cmd('normal! "+y')
  end

  -- Get the yanked text from the '+' register.
  local text = vim.fn.getreg('+')

  -- pbcopy sends UTF-8 text; the bridge handles Windows' UTF-16 clipboard.
  vim.fn.system('pbcopy', text)

  print("Yanked text copied to the Windows clipboard.")
end, {
  desc = "[W]indows [Y]ank through the persistent clipboard bridge",
  force = true,
  range = true,
})

vim.api.nvim_create_user_command("Wfix", function()
  vim.cmd("write")
  local file = vim.api.nvim_buf_get_name(0)
  if file == "" then
    vim.notify("No file name for current buffer (use :w <path> first).", vim.log.levels.WARN)
    return
  end
  vim.system({ "winfixtext", file })
  print(("Ran: winfixtext %s"):format(file))
end, {
  desc = "Write and run `winfixtext` on the current file",
  force = true,
})


-- Enable break indent
vim.o.breakindent = true

-- Case insensitive searching UNLESS /C or capital in search
vim.o.ignorecase = true
vim.o.smartcase = true

-- Keep signcolumn on by default
vim.wo.signcolumn = 'yes'

-- Decrease update time
vim.o.updatetime = 250
vim.o.timeout = true
vim.o.timeoutlen = 300

-- Set completeopt to have a better completion experience
vim.o.completeopt = 'menuone,noselect'

-- NOTE: You should make sure your terminal supports `vim.o.termguicolors`.
vim.o.termguicolors = true

-- [[ Basic Keymaps ]]

-- Keymaps for better default experience
-- See `:help vim.keymap.set()`
vim.keymap.set({ 'n', 'v' }, '<Space>', '<Nop>', { silent = true })

-- Keep <Esc> available to terminal applications; double Escape enters
-- terminal-normal mode, where Neovim receives navigation and command keys.
vim.keymap.set('t', '<Esc><Esc>', [[<C-\><C-n>]])

-- Re-read the current file when it changed outside Neovim, if it is unmodified.
-- This also lets the LSP observe the refreshed buffer contents.
vim.keymap.set('n', '<leader>r', '<Cmd>checktime<CR>',
  { desc = '[R]efresh file from disk' })

-- [[ Highlight on yank ]]
-- See `:help vim.highlight.on_yank()`
local highlight_group = vim.api.nvim_create_augroup('YankHighlight', { clear = true })
vim.api.nvim_create_autocmd('TextYankPost', {
  callback = function()
    vim.highlight.on_yank()
  end,
  group = highlight_group,
  pattern = '*',
})

-- vim.opt.termguicolors = true
vim.opt.scrolloff = 8

-- Unbind <C-b> for tmux (terminal multiplexer).
vim.keymap.set("n", "<C-b>", function() end)

-- greatest remap ever
vim.keymap.set("x", "<leader>p", "\"_dP")

-- Line wrap for long lines was making j -> gj and k -> gk. I did not like that
-- Remap for dealing with word wrap
-- vim.keymap.set('n', 'k', "v:count == 0 ? 'gk' : 'k'", { expr = true, silent = true })
-- vim.keymap.set('n', 'j', "v:count == 0 ? 'gj' : 'j'", { expr = true, silent = true })

-- Instead, I want the default vim behavior where j and k always move one line.
-- These lines make sure that `j` and `k` work normally.
vim.keymap.set("n", "j", "j", { noremap = true })
vim.keymap.set("n", "k", "k", { noremap = true })


-- textdwith option
-- In vim, the `textwidth` option, or `tw` for short, controls the maximum width
-- of text that is allowed in a line. When you use the `gq` command to format
-- text, it will wrap lines to ensure they do not exceed the `textwidth` setting.
local textwidth = 81
vim.opt.colorcolumn = tostring(textwidth + 1)
vim.opt.textwidth = textwidth
-- Clear previous FileType handlers before recreating them when this file reloads.
local core_filetype_group =
  vim.api.nvim_create_augroup("CoreVimFileTypes", { clear = true })
-- [2024-08-14]: I observed that the textwidth setting was being respected but
-- wasn't set to the proper global value in Rust files.
-- Using `:set textwidth?` allowed me to inspect the value in different buffers.
-- Opening nvim shows the value we expect, but the value changes in *.rs files.
--
-- This "autocmd" is a workaround that overrides the vim.opt in a local scope
-- (vim.opt_local), forcing Rust files to have the proper textwidth setting..
vim.api.nvim_create_autocmd("FileType", {
  group = core_filetype_group,
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
-- vim.cmd([[
--   autocmd FileType netrw silent! nmap <buffer> <A-h> <F1>
-- ]])
vim.api.nvim_create_autocmd("FileType", {
  group = core_filetype_group,
  pattern = "netrw",
  callback = function(ev)
    vim.keymap.set("n", "<A-h>", "<F1>", { buffer = ev.buf, silent = true })
  end,
})

vim.g.netrw_sort_by = "name"
vim.g.netrw_sort_direction = "reverse"
vim.g.netrw_sort_sequence =
[[\(\.bak\|\~\|\.o\|\.h\|\.info\|\.swp\|\.obj\)[*@]\=$,*]]

-- For reference, this is the default sorting sequence
-- [\/]$,*,\(\.bak\|\~\|\.o\|\.h\|\.info\|\.swp\|\.obj\)[*@]\=$

-- Oil replaces netrw's `:Explore` command and keeps `:E` as a shorthand.
local function open_oil(opts)
  local path = opts.args ~= "" and opts.args or nil
  require("oil").open(path)
end

local oil_command_opts = {
  force = true,
  nargs = "?",
  complete = "dir",
}
vim.api.nvim_create_user_command("Explore", open_oil, oil_command_opts)
vim.api.nvim_create_user_command("E", open_oil, oil_command_opts)

-- To change the default tree list mode in `netrw`, set the `g:netrw_liststyle` variable.
-- The possible values for `g:netrw_liststyle` are:
--
-- 0: Thin (one file/dir per line without any additional information, the default).
-- 1: Thin, with tree listing.
-- 2: Long (detailed listing with one file/dir per line).
-- 3: Wide (multiple files/dirs per line).
-- 4: Tree (like the "thin" tree but with file sizes and dates).
-- 5: Changes to the next style each time netrw is started.
--
vim.g.netrw_liststyle = 0

local function highlights_todo()
  -- Highlight TODO markers using matchadd() so it works even when Treesitter
  -- is providing the main syntax highlighting.
  local aug = vim.api.nvim_create_augroup("UD_TokenHighlights", { clear = true })

  local function apply_hl()
    vim.api.nvim_set_hl(0, "UniqueDivineTODO", { fg = "black", bg = "cyan" })
  end

  -- 1) Define highlight groups (re-apply after colorscheme changes)
  vim.api.nvim_create_autocmd("ColorScheme", { group = aug, callback = apply_hl })
  -- 2) Apply immediately (in case a colorscheme is already loaded)
  apply_hl()

  -- 3) Add matches per-buffer
  vim.api.nvim_create_autocmd({ "BufEnter", "WinEnter" }, {
    group = aug,
    callback = function()
      -- Avoid stacking duplicates if this autocmd fires multiple times
      if vim.w.ud_todo_match_id then pcall(vim.fn.matchdelete, vim.w.ud_todo_match_id) end


      -- Match TODO-like tokens
      vim.w.ud_todo_match_id = vim.fn.matchadd("UniqueDivineTODO", [[\v<TODO>]])
    end,
  })
end

local function highlights_question_answer()
  -- Question and answer token highlighting that works with Treesitter
  -- (no `:syntax` vim script needed)

  local aug = vim.api.nvim_create_augroup("UD_QA_Highlights", { clear = true })

  -- Pick your two colors here.
  -- Tip: keep fg readable, bg subtle if you don't want a neon block.
  local function apply_hl()
    vim.api.nvim_set_hl(0, "UDQuestion", { fg = "white", bg = "teal" })
    vim.api.nvim_set_hl(0, "UDAnswer", { fg = "black", bg = "yellow" })
  end

  -- Re-apply highlight groups after any colorscheme loads
  vim.api.nvim_create_autocmd("ColorScheme", {
    group = aug,
    callback = apply_hl,
  })

  apply_hl()

  -- Add per-buffer matches (and avoid duplicates)
  vim.api.nvim_create_autocmd({ "BufEnter", "WinEnter" }, {
    group = aug,
    callback = function()
      -- Optional: only do this in markdown
      if vim.bo.filetype ~= "markdown" then
        return
      end

      -- Delete old matches for THIS WINDOW
      if vim.w.ud_q_match_id then pcall(vim.fn.matchdelete, vim.w.ud_q_match_id) end
      if vim.w.ud_a_match_id then pcall(vim.fn.matchdelete, vim.w.ud_a_match_id) end

      -- Regex markers: "Q:" and "A:".
      vim.w.ud_q_match_id = vim.fn.matchadd("UDQuestion", [[\VQ:]])
      vim.w.ud_a_match_id = vim.fn.matchadd("UDAnswer", [[\VA:]])
    end,
  })
end

highlights_todo()
highlights_question_answer()


-- Vim script `highlight` notes:
-- highlight link [target-group] [source-group]
-- `[target-group]`: Syntax highlighting group you want to apply properties to.
-- `[source-group]`: Syntax highlighting group it will inherit/link from.

vim.api.nvim_create_user_command("PrintWinbar", function()
  local winbar = vim.wo.winbar

  print(vim.inspect({
    raw = winbar,
    rendered = vim.api.nvim_eval_statusline(winbar, {
      winid = vim.api.nvim_get_current_win(),
      use_winbar = true,
    }).str,
  }))
end, { force = true })

return {}
