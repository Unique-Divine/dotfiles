--- core/lsp.lua
---
--- Language Server Protocol (LSP)
--- See: https://microsoft.github.io/language-server-protocol/
---
--- - [ ] TODO : Set up debugger (nvim-dap) with keymaps
---     Guide: https://youtu.be/mh_EJhH49Ms?t=539

---@type fun(client: table, bufnr: number)
---@param client table: LSP client table
---@param bufnr number: Buffer number
--- on_attach: This function runs when a language server protocol (LSP) connects
--- to a particular buffer.
--- - It sets up key mappings specific to LSP features.
--- - It's defined as a local function and passed into the lspconfig toward the
---   bottom of the file.
local on_attach = function(client, bufnr)
  --- NOTE: Remember that lua is a real programming language, and as such it is possible
  --- to define small helper and utility functions so you don't have to repeat yourself
  --- many times.
  ---
  --- In this case, we create a function that lets us more easily define mappings specific
  --- for LSP related items. It sets the mode, buffer and description for us each time.
  ---@param keys string Keymap definition statement. Ex.: '<leader>rn', 'gd', '<C-k>'.
  ---@param func function|string Function to be called after the keymap is used, or a command
  ---@param desc string Description of what the command does.
  local nmap = function(keys, func, desc)
    if desc then
      desc = 'LSP: ' .. desc
    end
    ---@type table|nil
    local opts = { buffer = bufnr, desc = desc }
    vim.keymap.set('n', keys, func, opts)
  end

  nmap('<leader>rn', vim.lsp.buf.rename, '[R]e[n]ame')
  nmap('<leader>ca', vim.lsp.buf.code_action, '[C]ode [A]ctions')

  nmap('gd', vim.lsp.buf.definition, '[G]oto [D]efinition')
  nmap('gT', vim.lsp.buf.type_definition, '[G]oto [T]ype definition')
  nmap('gr', require('telescope.builtin').lsp_references, '[G]oto [R]eferences')
  nmap('gI', vim.lsp.buf.implementation, '[G]oto [I]mplementation')

  -- Diagnostic keymaps
  nmap('<leader>df', vim.diagnostic.goto_next, '[D]iagnotic [F]orward')
  nmap('<leader>dF', vim.diagnostic.goto_next, '[D]iagnotic un-[F]orward')
  nmap('<leader>dl', require('telescope.builtin').diagnostics, '[D]iagnostics [L]ist')
  --  nmap('<leader>dl', ':Telescope diagnostics<cr>', '[D]iagnostics [L]ist')
  --  Here, `<cr>` refers to Enter. You can also refer to the ":" with `<cmd>` instead.

  nmap('<leader>ds', require('telescope.builtin').lsp_document_symbols, '[D]ocument [S]ymbols')
  nmap('<leader>ws', require('telescope.builtin').lsp_dynamic_workspace_symbols, '[W]orkspace [S]ymbols')

  -- See `:help K` for why this keymap
  nmap('K', vim.lsp.buf.hover, 'Hover Documentation')
  nmap('<A-k>', vim.lsp.buf.signature_help, 'Signature Documentation')

  -- Lesser used LSP functionality
  nmap('gD', vim.lsp.buf.declaration, '[G]oto [D]eclaration')
  nmap('<leader>wa', vim.lsp.buf.add_workspace_folder, '[W]orkspace [A]dd Folder')
  nmap('<leader>wr', vim.lsp.buf.remove_workspace_folder, '[W]orkspace [R]emove Folder')
  nmap('<leader>wl', function()
    print(vim.inspect(vim.lsp.buf.list_workspace_folders()))
  end, '[W]orkspace [L]ist Folders')

  -- Create a command `:Format` local to the LSP buffer
  vim.api.nvim_buf_create_user_command(bufnr, 'Format', function(_)
    vim.lsp.buf.format()
  end, { desc = 'Format current buffer with LSP' })
end
-- Enable the following language servers
-- Feel free to add/remove any LSPs that you want here. They will automatically be installed.
--
--  ### Available LSP servers
--
--  Add any additional override configuration in the following tables. They
--  will be passed to the `settings` field of the server config. You must look
--  up that documentation yourself.
--
--  See: https://github.com/mason-org/mason-lspconfig.nvim#available-lsp-servers
local lsp_servers_mason = {
  -- clangd = {},
  gopls = {},
  astro = {},
  -- pyright = {},
  -- rust_analyzer = {}, -- ⚠️ Do not manage "rust-analyzer" with mason. Use
  -- the cargo installation to make sure the LSP matches the real environment.

  lua_ls = {
    Lua = {
      workspace = { checkThirdParty = false },
      telemetry = { enable = false },
      diagnostics = {
        disable = { "unused-local" },
      },
    },
  },
}

-- nvim-cmp supports additional completion capabilities, so broadcast that to servers
local capabilities = vim.lsp.protocol.make_client_capabilities()
capabilities = require('cmp_nvim_lsp').default_capabilities(capabilities)

-- mason-lspconfig 2.x: use vim.lsp.config (Neovim 0.11+) and automatic_enable; setup_handlers was removed.
-- https://github.com/mason-org/mason-lspconfig.nvim
vim.lsp.config('*', {
  capabilities = capabilities,
  on_attach = on_attach,
})

vim.lsp.config('gopls', {
  cmd_env = {
    GOFLAGS = "-tags=pebbledb", -- 2025-11-07: For Nibiru Go codebase
  },
})

vim.lsp.config('lua_ls', {
  settings = lsp_servers_mason.lua_ls,
})

local mason_lspconfig = require 'mason-lspconfig'

mason_lspconfig.setup {
  ensure_installed = vim.tbl_keys(lsp_servers_mason),
  -- Installed servers are enabled via vim.lsp.enable() except these (rust is handled by rustaceanvim below).
  automatic_enable = {
    exclude = { "rust_analyzer" },
  },
}

--[[
`:Toc` command: Generates a table of contents (TOC) for a markdown file using
the 'github.com/Unique-Divine/jiyuu/mdtoc' tool.

Replaces the "jonschlinkert/markdown-toc" tool installed with Mason, as that
one's it's not actively maintained.
]]
vim.api.nvim_create_user_command('Toc', function()
  vim.cmd('!bun run "$HOME/ki/boku/jiyuu/mdtoc/src/cli.ts" % --bullets="-" --maxdepth=3 --no-firsth1 | clip.exe')
  -- The "%" means the current file when you run this vim.cmd. This CLI tool
  -- takes exactly one argument and is configured with flags.
  print('markdown-toc: successfully yanked headers for table of contents')
end, {
  desc = "Generate a markdown table of contents (TOC), copying the contents the clipboard",
})

-- Rust: rustaceanvim replaces simrat39/rust-tools (archived; used deprecated lspconfig.rust_analyzer.setup).
-- Pickers: install telescope.nvim or fzf; rustaceanvim uses :RustLsp runnables / testables / …
-- Inlay hints: Neovim 0.10+ built-in; see :help lsp-inlayhint
-- https://github.com/mrcjkb/rustaceanvim
vim.g.rustaceanvim = {
  server = {
    on_attach = on_attach,
    default_settings = {
      ['rust-analyzer'] = {
        check = {
          command = 'clippy',
        },
      },
    },
  },
}
