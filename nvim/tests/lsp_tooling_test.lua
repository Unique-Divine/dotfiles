-- Run: nvim --headless -u NONE -l nvim/tests/lsp_tooling_test.lua
local source = debug.getinfo(1, 'S').source:sub(2)
local nvim_dir = vim.fn.fnamemodify(source, ':p:h:h')
package.path = nvim_dir .. '/lua/?.lua;' .. package.path

local lsp_restart = require('core.lsp-restart')
local installers = require('core.mason-installers')
local bun_lsp = require('core.bun-lsp')

local failures = 0
local function check(name, ok)
  if not ok then
    failures = failures + 1
    io.stderr:write('FAIL ' .. name .. '\n')
  end
end

-- should_restart: crash restarts, clean exit and repeat crash do not.
local window = 60000
check('clean exit', not lsp_restart.should_restart(nil, 0, 0, 1000, window))
check('first crash', lsp_restart.should_restart(nil, 134, 0, 1000, window))
check('signal', lsp_restart.should_restart(nil, 0, 6, 1000, window))
check('repeat crash', not lsp_restart.should_restart(1000, 1, 0, 30000, window))
check('later crash', lsp_restart.should_restart(1000, 1, 0, 61000, window))

-- needed_installers groups packages by installer and skips release assets.
check('purl type', installers.purl_type('pkg:npm/prettier@3.9.6') == 'npm')
check('purl scoped', installers.purl_type('pkg:npm/%40vue/x@1') == 'npm')
check('needed', vim.deep_equal(installers.needed_installers({
  prettier = 'pkg:npm/prettier@3.9.6',
  gopls = 'pkg:golang/golang.org/x/tools/gopls@v0.23.0',
  bash = 'pkg:npm/bash-language-server@5.6.0',
  marksman = 'pkg:github/artempyanykh/marksman@2026-02-08',
}), { npm = { 'bash', 'prettier' }, golang = { 'gopls' } }))

-- bun-lsp resolves Bun's global node_modules and prefers project TypeScript.
check('bun default', bun_lsp.node_modules({ HOME = '/h' })
  == '/h/.bun/install/global/node_modules')
check('bun install', bun_lsp.node_modules({ HOME = '/h', BUN_INSTALL = '/b' })
  == '/b/install/global/node_modules')
check('bun global dir', bun_lsp.node_modules({
  HOME = '/h', BUN_INSTALL_GLOBAL_DIR = '/g',
}) == '/g/node_modules')
check('tsdk project', bun_lsp.tsdk('/p/node_modules/typescript/lib', '/g')
  == '/p/node_modules/typescript/lib')
check('tsdk global', bun_lsp.tsdk('', '/g') == '/g/typescript/lib')

if failures > 0 then
  vim.cmd('cquit 1')
end
print('lsp tooling tests passed')
vim.cmd('cquit 0')
