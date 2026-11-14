--- Language servers installed as Bun global packages.
---
--- Bun owns JavaScript packages (bun/global/package.json); Mason owns native
--- binaries (mason.lock). mason-lspconfig only enables servers Mason
--- installed, so this module enables the Bun-owned ones. Their commands
--- resolve on PATH through ~/.bun/bin, the same copies every shell runs.
--- https://github.com/Unique-Divine/dotfiles/issues/128

local M = {}

--- nvim-lspconfig names for servers in bun/global/package.json. Not here:
--- solidity_ls_nomicfoundation, which crashes under Bun (process.binding
--- "tcp_wrap" is not implemented).
M.servers = {
  'astro',
  'bashls',
  'graphql',
  'jsonls',
  'tailwindcss',
  'ts_ls',
  'vue_ls',
}

--- Bun's global node_modules, linked to dotfiles bun/global by `just bun-sync`.
--- @param env? { BUN_INSTALL?: string, BUN_INSTALL_GLOBAL_DIR?: string, HOME?: string }
--- @return string
function M.node_modules(env)
  env = env or vim.env
  local global_dir = env.BUN_INSTALL_GLOBAL_DIR
    or ((env.BUN_INSTALL or (env.HOME .. '/.bun')) .. '/install/global')
  return global_dir .. '/node_modules'
end

--- Pick the project's TypeScript lib, else the Bun global one.
--- @param project_tsdk string result of util.get_typescript_server_path
--- @param node_modules string
--- @return string
function M.tsdk(project_tsdk, node_modules)
  if project_tsdk ~= '' then
    return project_tsdk
  end
  return node_modules .. '/typescript/lib'
end

function M.setup()
  local node_modules = M.node_modules()

  -- Mason's astro override pointed tsdk at its vendored TypeScript. Fall
  -- back to the Bun global TypeScript (pinned <= 6.x; 7.x has no tsdk).
  vim.lsp.config('astro', {
    before_init = function(_, config)
      local util = require('lspconfig.util')
      config.init_options = config.init_options or {}
      config.init_options.typescript = config.init_options.typescript or {}
      config.init_options.typescript.tsdk =
        M.tsdk(util.get_typescript_server_path(config.root_dir), node_modules)
    end,
  })

  -- vue_ls handles templates and styles; ts_ls handles <script> through
  -- @vue/typescript-plugin. https://github.com/vuejs/language-tools/wiki/Neovim
  vim.lsp.config('ts_ls', {
    init_options = {
      plugins = {
        {
          name = '@vue/typescript-plugin',
          location = node_modules .. '/@vue/language-server',
          languages = { 'vue' },
        },
      },
    },
    filetypes = {
      'javascript', 'javascriptreact', 'typescript', 'typescriptreact', 'vue',
    },
  })

  vim.lsp.enable(M.servers)
end

return M
