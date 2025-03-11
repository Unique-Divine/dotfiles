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
--  See: https://github.com/williamboman/mason-lspconfig.nvim#available-lsp-servers
local servers = {
  -- clangd = {},
  gopls = {},
  astro = {},
  -- pyright = {},
  rust_analyzer = {},
  tsserver = {},

  lua_ls = {
    Lua = {
      workspace = { checkThirdParty = false },
      telemetry = { enable = false },
    },
  },
}

-- Setup neovim lua configuration
require('neodev').setup()

-- nvim-cmp supports additional completion capabilities, so broadcast that to servers
local capabilities = vim.lsp.protocol.make_client_capabilities()
capabilities = require('cmp_nvim_lsp').default_capabilities(capabilities)

-- Ensure the servers above are installed
local mason_lspconfig = require 'mason-lspconfig'

mason_lspconfig.setup {
  ensure_installed = vim.tbl_keys(servers),
}

mason_lspconfig.setup_handlers {
  function(server_name)
    require('lspconfig')[server_name].setup {
      capabilities = capabilities,
      on_attach = on_attach,
      settings = servers[server_name],
    }
  end,
}

-- Uses the 'markdown-toc' binary installed with Mason on the current file.
vim.api.nvim_create_user_command('TocMd', function()
  vim.cmd('!markdown-toc % --bullets="-" --max-depth=2 --no-firsth1 | clip.exe')
  print('markdown-toc: successfully yanked headers for table of contents')
end, {})

-- Rust
-- rust-tools will configure and enable certain LSP features for us.
-- See https://github.com/simrat39/rust-tools.nvim#configuration

local function setup_rust_tools()
  local opts = {
    tools = {
      runnables = {
        use_telescope = true,
      },

      -- inlay_hints: These apply to the default RustSetInlayHints command
      inlay_hints = {
        -- auto: auto set inlay hints (type hints)
        auto = true,
        show_parameter_hints = true,
        parameter_hints_prefix = "← ", -- default: "<- "
        other_hints_prefix = "➤ ", -- default: "=> "
      },
    },

    -- all the opts to send to nvim-lspconfig
    -- these override the defaults set by rust-tools.nvim
    -- see https://github.com/neovim/nvim-lspconfig/blob/v0.1.6/doc/server_configurations.md
    server = {
      -- on_attach is a callback called when the language server attachs to the buffer
      on_attach = on_attach,
      settings = {
        -- to enable rust-analyzer settings visit:
        -- https://github.com/rust-analyzer/rust-analyzer/blob/master/docs/user/generated_config.adoc
        ["rust-analyzer"] = {
          -- enable clippy on save
          checkOnSave = {
            command = "clippy",
          },
        },
      },
    },
  }

  require("rust-tools").setup(opts)
end

setup_rust_tools()
