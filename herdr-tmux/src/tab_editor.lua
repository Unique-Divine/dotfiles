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

local workspaces = vim.json.decode(tab_order())
local original, rows, id_by_row, header_by_row = {}, {}, {}, {}
local focused, tab_count = 1, 0
local function quantity(count, noun)
    return count .. " " .. noun .. (count == 1 and "" or "s")
end
for _, workspace in ipairs(workspaces) do
    local label = workspace.label:gsub("%c", " ")
    local header = " " .. label .. "\t" .. workspace.workspace_id
    local group = { workspace_id = workspace.workspace_id, tab_ids = {} }
    original[#original + 1] = group
    rows[#rows + 1] = header
    header_by_row[header] = workspace.workspace_id
    local label_width = 0
    for _, tab in ipairs(workspace.tabs) do
        label_width = math.max(label_width, math.min(24, vim.fn.strdisplaywidth(tab.label)))
    end
    for _, tab in ipairs(workspace.tabs) do
        local name = tab.label:gsub("%c", " ")
        local padding = string.rep(" ", math.max(0, label_width - vim.fn.strdisplaywidth(name)))
        local status = tab.agent_count > 0 and tab.status_icon .. " " .. tab.agent_status or ""
        local agents = tab.agent_count > 0 and "  " .. quantity(tab.agent_count, "agent") or ""
        local row = string.format("%s %s%s  %-10s  %s%s\t%s",
            tab.focused and "◆" or " ", name, padding, status,
            quantity(tab.pane_count, "pane"), agents, tab.tab_id)
        group.tab_ids[#group.tab_ids + 1] = tab.tab_id
        rows[#rows + 1] = row
        id_by_row[row] = tab.tab_id
        tab_count = tab_count + 1
        if tab.focused or tab.tab_id == vim.env.HERDR_TMUX_TAB then
            focused = #rows
        end
    end
end

if vim.env.HERDR_TMUX_NORD == "1" then
    vim.o.termguicolors = true
    local panel = "#2e3440"
    local text = "#eceff4"
    local muted = "#a0aabd"
    local accent = "#88c0d0"
    local highlights = {
        Normal = { fg = text, bg = panel },
        LineNr = { fg = muted, bg = panel },
        CursorLine = { fg = panel, bg = accent, bold = true },
        CursorLineNr = { link = "CursorLine" },
        Visual = { fg = text, bg = "#43505d" },
        WinBar = { fg = muted, bg = panel },
        StatusLine = { fg = muted, bg = panel },
        ModeMsg = { fg = accent, bg = panel },
        HerdrWorkspace = { fg = text, bold = true, bg = "#3b4252" },
        HerdrStatusCyan = { fg = accent, bold = true },
        HerdrStatusBlocked = { fg = "#ebcb8b", bold = true },
        HerdrActiveTab = { fg = accent, bold = true },
    }
    for name, highlight in pairs(highlights) do
        vim.api.nvim_set_hl(0, name, highlight)
    end
else
    vim.api.nvim_set_hl(0, "HerdrWorkspace", { link = "Title" })
    vim.api.nvim_set_hl(0, "HerdrStatusCyan", { link = "Special" })
    vim.api.nvim_set_hl(0, "HerdrStatusBlocked", { link = "WarningMsg" })
    vim.api.nvim_set_hl(0, "HerdrActiveTab", { link = "Special" })
end

local buffer = vim.api.nvim_get_current_buf()
vim.api.nvim_buf_set_name(buffer, "herdr://tabs")
vim.bo.buftype = "acwrite"
vim.bo.bufhidden = "wipe"
vim.bo.swapfile = false
vim.wo.wrap = false
vim.wo.cursorline = true
vim.wo.conceallevel = 2
vim.wo.concealcursor = "nvic"
vim.opt.fillchars:append({ eob = " " })
vim.wo.winbar = " / search tabs%=%<" .. quantity(tab_count, "tab") .. " "
vim.o.laststatus = 2
vim.o.ruler = false
vim.wo.statusline = " J/K move  ·  V select  ·  :w apply  ·  :q! cancel%<%=%m "
vim.cmd([[syntax match HerdrWorkspace /^ \S[^\t]*/]])
vim.cmd([[syntax match HerdrStatusCyan /  \zs\%(\. idle\|✓ done\|? unknown\)\ze\s\+\d\+ panes\?/]])
vim.cmd([[syntax match HerdrStatusBlocked /  \zs! blocked\ze\s\+\d\+ panes\?/]])
vim.cmd([[syntax match HerdrRowID /\t[^\t]*$/ conceal]])
vim.cmd([[syntax match HerdrActiveTab /^◆/]])
vim.api.nvim_buf_set_lines(buffer, 0, -1, false, rows)
vim.api.nvim_win_set_cursor(0, { focused, 0 })
vim.bo.modified = false

vim.api.nvim_create_autocmd("BufWriteCmd", {
    buffer = buffer,
    callback = function()
        local desired, seen = {}, {}
        local group
        local total = 0
        for index, row in ipairs(vim.api.nvim_buf_get_lines(buffer, 0, -1, false)) do
            local workspace = header_by_row[row]
            if workspace then
                local expected = original[#desired + 1]
                if not expected or expected.workspace_id ~= workspace then
                    error("Keep the workspace headings in their original order.", 0)
                end
                group = { workspace_id = workspace, tab_ids = {} }
                desired[#desired + 1] = group
            else
                local id = id_by_row[row]
                if not group or not id or seen[id] then
                    error("Invalid row " .. index .. ". Keep each complete tab row under a workspace heading.", 0)
                end
                seen[id] = true
                group.tab_ids[#group.tab_ids + 1] = id
                total = total + 1
            end
        end
        if #desired ~= #original or total ~= tab_count then
            error("Keep all workspace headings and tab rows.", 0)
        end
        for _, workspace in ipairs(desired) do
            if #workspace.tab_ids == 0 then
                error("Keep at least one tab in each workspace.", 0)
            end
        end
        local saved = vim.json.decode(tab_order({ original = original, desired = desired }))
        original = saved.order
        for row, id in pairs(id_by_row) do
            id_by_row[row] = saved.tab_id_changes[id] or id
        end
        vim.bo[buffer].modified = false
        vim.api.nvim_echo({ { "Tab order applied", "MoreMsg" } }, false, {})
    end,
})

local function move_rows(first, last, step)
    if first + step < 2 or last + step > vim.api.nvim_buf_line_count(buffer) then
        return false
    end
    for _, row in ipairs(vim.api.nvim_buf_get_lines(buffer, first - 1, last, false)) do
        if not id_by_row[row] then
            return false
        end
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
