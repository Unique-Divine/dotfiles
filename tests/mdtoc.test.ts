import { afterEach, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const roots: string[] = []
const nvim = Bun.which("nvim")
const command = process.env.MDTOC_TEST_COMMAND || Bun.which("ud-mdtoc")
const integration = nvim && command ? test : test.skip

afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })))
})

integration("Toc and TocCopy use the installed CLI and preserve errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "nvim mdtoc "))
  roots.push(root)
  const bin = join(root, "bin")
  await mkdir(bin)
  await symlink(resolve(command!), join(bin, "ud-mdtoc"))
  const document = join(root, "notes with spaces.md")
  await writeFile(document, "# Title\n\n<!-- toc -->\nold TOC\n<!-- tocstop -->\n\n## One\n### Two\n")
  const script = join(root, "verify.lua")
  await writeFile(script, `
vim.opt.runtimepath:prepend(vim.env.MDTOC_NVIM_ROOT)
local errors = {}
vim.notify = function(message, level)
  if level == vim.log.levels.ERROR then table.insert(errors, message) end
end
local clipboard = ''
vim.g.clipboard = {
  name = 'integration fixture',
  copy = { ['+'] = function(lines) clipboard = table.concat(lines, '\\n') end,
           ['*'] = function() end },
  paste = { ['+'] = function() return { {clipboard}, 'v' } end,
            ['*'] = function() return { {''}, 'v' } end },
}
require('core/mdtoc').setup()
vim.cmd.edit(vim.fn.fnameescape(vim.env.MDTOC_DOCUMENT))
vim.cmd('Toc')
local content = table.concat(vim.api.nvim_buf_get_lines(0, 0, -1, false), '\\n')
assert(content:find('- [One](#one)', 1, true), content)
assert(content:find('  - [Two](#two)', 1, true), content)
assert(not content:find('undefined', 1, true))
vim.api.nvim_buf_set_lines(0, -1, -1, false, {'## Unsaved'})
vim.cmd('TocCopy')
assert(clipboard:find('[Unsaved](#unsaved)', 1, true), clipboard)
assert(#errors == 0, table.concat(errors, '\\n'))
local original_clipboard = clipboard
local command_path = vim.env.MDTOC_BIN .. '/ud-mdtoc'
vim.env.PATH = vim.env.MDTOC_BIN
vim.uv.fs_unlink(command_path)
vim.cmd('TocCopy')
assert(errors[#errors]:find('just bun-sync', 1, true))
assert(clipboard == original_clipboard)
vim.uv.fs_symlink('/bin/false', command_path)
vim.cmd('TocCopy')
assert(errors[#errors]:find('command exited', 1, true))
assert(clipboard == original_clipboard)
local before_error = table.concat(vim.api.nvim_buf_get_lines(0, 0, -1, false), '\\n')
vim.cmd('Toc')
assert(table.concat(vim.api.nvim_buf_get_lines(0, 0, -1, false), '\\n') == before_error)
assert(errors[#errors]:find('command exited', 1, true))
vim.cmd('enew!')
vim.cmd('Toc')
assert(errors[#errors]:find('save the buffer first', 1, true))
vim.cmd('qa!')
`)
  const proc = Bun.spawn([nvim!, "--headless", "-u", "NONE", "-l", script], {
    env: {
      ...process.env, PATH: `${bin}:${process.env.PATH}`,
      MDTOC_NVIM_ROOT: join(import.meta.dir, "..", "nvim"),
      MDTOC_DOCUMENT: document, MDTOC_BIN: bin,
    },
    stdout: "pipe", stderr: "pipe",
  })
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
  expect(code, stderr).toBe(0)
}, 30000)
