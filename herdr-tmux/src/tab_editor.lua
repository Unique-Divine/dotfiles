local function tab_order(edit)
    local command = {
        vim.env.HERDR_TMUX_BIN,
        "--socket-path", vim.env.HERDR_TMUX_SOCKET,
        "--tab-id", vim.env.HERDR_TMUX_TAB,
        "--pane-id", vim.env.HERDR_TMUX_PANE,
        "tab-order",
    }
    if edit then
        table.insert(command, "--apply")
    end
    local result = vim.system(command, {
        text = true,
        stdin = edit and vim.json.encode(edit) or nil,
    }):wait()
    if result.code ~= 0 then
        error(vim.trim(result.stderr or ""), 0)
    end
    return result.stdout
end

local tabs = vim.json.decode(tab_order())
local original, rows, id_by_row = {}, {}, {}
local focused = 1
for index, tab in ipairs(tabs) do
    local label = tab.label:gsub("%c", " ")
    local row = string.format("%s  %s  %s", tab.focused and "*" or " ", tab.tab_id, label)
    original[index] = tab.tab_id
    rows[index] = row
    id_by_row[row] = tab.tab_id
    if tab.focused then
        focused = index
    end
end

local buffer = vim.api.nvim_get_current_buf()
vim.api.nvim_buf_set_name(buffer, "herdr://tabs")
vim.bo.buftype = "acwrite"
vim.bo.bufhidden = "wipe"
vim.bo.swapfile = false
vim.wo.wrap = false
vim.wo.cursorline = true
vim.wo.number = true
vim.wo.numberwidth = 4
if vim.env.HERDR_TMUX_TAB_BASE == "0" then
    vim.wo.statuscolumn = "%=%{v:lnum-1} "
end
vim.opt.fillchars:append({ eob = " " })
vim.wo.winbar = "  / search%=" .. #tabs .. (#tabs == 1 and " tab  " or " tabs  ")
vim.o.laststatus = 2
vim.wo.statusline = "  V select  ·  J/K move  ·  :w apply  ·  :q! cancel%=%m  "
vim.api.nvim_set_hl(0, "HerdrTabId", { ctermfg = 8, fg = "#808080" })
vim.api.nvim_set_hl(0, "HerdrActiveTab", { ctermfg = 14, fg = "#56b6c2", bold = true })
vim.fn.matchadd("HerdrTabId", [[^.\s\+\zsw\d\+:t\d\+\ze\s]])
vim.fn.matchadd("HerdrActiveTab", [[^\*]])
vim.api.nvim_buf_set_lines(buffer, 0, -1, false, rows)
vim.api.nvim_win_set_cursor(0, { focused, 0 })
vim.bo.modified = false

vim.api.nvim_create_autocmd("BufWriteCmd", {
    buffer = buffer,
    callback = function()
        local desired = {}
        local seen = {}
        for index, row in ipairs(vim.api.nvim_buf_get_lines(buffer, 0, -1, false)) do
            local id = id_by_row[row]
            if not id then
                error("Row " .. index .. " was edited. Move whole rows and keep their contents.", 0)
            end
            if seen[id] then
                error("Row " .. index .. " duplicates tab " .. id .. ".", 0)
            end
            seen[id] = true
            desired[index] = id
        end
        if #desired ~= #original then
            error("Keep all " .. #original .. " tab rows.", 0)
        end
        tab_order({ original = original, desired = desired })
        original = desired
        vim.bo[buffer].modified = false
        vim.api.nvim_echo({ { "Tab order applied", "MoreMsg" } }, false, {})
    end,
})

local function move_rows(first, last, step)
    if first + step < 1 or last + step > vim.api.nvim_buf_line_count(buffer) then
        return false
    end
    local destination = step < 0 and first - 2 or last + 1
    vim.cmd(string.format("%d,%dmove %d", first, last, destination))
    return true
end

for key, step in pairs({ J = 1, K = -1 }) do
    vim.keymap.set("n", key, function()
        local cursor = vim.api.nvim_win_get_cursor(0)
        if move_rows(cursor[1], cursor[1], step) then
            vim.api.nvim_win_set_cursor(0, { cursor[1] + step, cursor[2] })
        end
    end, { buffer = buffer })

    vim.keymap.set("x", key, function()
        local anchor, cursor = vim.fn.line("v"), vim.fn.line(".")
        local first, last = math.min(anchor, cursor), math.max(anchor, cursor)
        vim.cmd.normal({ args = { vim.keycode("<Esc>") }, bang = true })
        local offset = move_rows(first, last, step) and step or 0
        vim.api.nvim_win_set_cursor(0, { anchor + offset, 0 })
        vim.cmd.normal({ args = { "V" }, bang = true })
        vim.api.nvim_win_set_cursor(0, { cursor + offset, 0 })
    end, { buffer = buffer })
end
