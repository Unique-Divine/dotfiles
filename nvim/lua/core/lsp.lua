--- core/lsp.lua
---
--- Language Server Protocol (LSP)
--- See: https://microsoft.github.io/language-server-protocol/
---
--- Eager Lazy spec. require() of this file only builds the spec; Lazy calls
--- plugin_config when nvim-lspconfig loads.

---@type fun(client: table, bufnr: number)
---@param client table: LSP client table
---@param bufnr number: Buffer number
--- on_attach: runs when an LSP client connects to a buffer.
local on_attach = function(client, bufnr)
  ---@param keys string Keymap definition. Ex.: '<leader>rn', 'gd'.
  ---@param func function|string Function or command after the keymap.
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
  nmap('gr', require('telescope.builtin').lsp_references,
    '[G]oto [R]eferences')
  nmap('gI', vim.lsp.buf.implementation, '[G]oto [I]mplementation')

  -- Diagnostic keymaps
  nmap('<leader>df', vim.diagnostic.goto_next, '[D]iagnotic [F]orward')
  nmap('<leader>dF', vim.diagnostic.goto_next, '[D]iagnotic un-[F]orward')
  nmap('<leader>dl', require('telescope.builtin').diagnostics,
    '[D]iagnostics [L]ist')

  nmap('<leader>ds', require('telescope.builtin').lsp_document_symbols,
    '[D]ocument [S]ymbols')
  nmap('<leader>ws',
    require('telescope.builtin').lsp_dynamic_workspace_symbols,
    '[W]orkspace [S]ymbols')

  nmap('K', vim.lsp.buf.hover, 'Hover Documentation')
  nmap('<A-k>', vim.lsp.buf.signature_help, 'Signature Documentation')

  nmap('gD', vim.lsp.buf.declaration, '[G]oto [D]eclaration')
  nmap('<leader>wa', vim.lsp.buf.add_workspace_folder,
    '[W]orkspace [A]dd Folder')
  nmap('<leader>wr', vim.lsp.buf.remove_workspace_folder,
    '[W]orkspace [R]emove Folder')
  nmap('<leader>wl', function()
    print(vim.inspect(vim.lsp.buf.list_workspace_folders()))
  end, '[W]orkspace [L]ist Folders')

  vim.api.nvim_buf_create_user_command(bufnr, 'Format', function(_)
    vim.lsp.buf.format()
  end, { desc = 'Format current buffer with LSP' })

  if client:supports_method('textDocument/inlayHint', bufnr) then
    vim.lsp.inlay_hint.enable(true, { bufnr = bufnr })
  end
end

-- Set before rustaceanvim loads. rustaceanvim reads this global at load.
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

-- Servers mason-lspconfig should install. See:
-- https://github.com/mason-org/mason-lspconfig.nvim#available-lsp-servers
local lsp_servers_mason = {
  -- clangd = {},
  gopls = {},
  astro = {},
  -- pyright = {},
  -- rust_analyzer = {}, -- do not manage rust-analyzer with mason.

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

local function setup_autoformat()
  local format_is_enabled = true
  vim.api.nvim_create_user_command('KickstartFormatToggle', function()
    format_is_enabled = not format_is_enabled
    print('Setting autoformatting to: ' .. tostring(format_is_enabled))
  end, {})

  local _augroups = {}
  local get_augroup = function(client)
    if not _augroups[client.id] then
      local group_name = 'kickstart-lsp-format-' .. client.name
      local id = vim.api.nvim_create_augroup(group_name, { clear = true })
      _augroups[client.id] = id
    end
    return _augroups[client.id]
  end

  vim.api.nvim_create_autocmd('LspAttach', {
    group = vim.api.nvim_create_augroup(
      'kickstart-lsp-attach-format', { clear = true }
    ),
    callback = function(args)
      local client_id = args.data.client_id
      local client = vim.lsp.get_client_by_id(client_id)
      local bufnr = args.buf

      if not client.server_capabilities.documentFormattingProvider then
        return
      end

      -- TypeScript LSP formatting often fights repo-local Prettier.
      if client.name == 'tsserver' or client.name == 'ts_ls' then
        return
      end

      vim.api.nvim_create_autocmd('BufWritePre', {
        group = get_augroup(client),
        buffer = bufnr,
        callback = function()
          if not format_is_enabled then
            return
          end

          vim.lsp.buf.format {
            async = false,
            filter = function(c)
              return c.id == client.id
            end,
          }
        end,
      })
    end,
  })
end

local function plugin_config()
  local capabilities = vim.lsp.protocol.make_client_capabilities()
  capabilities = require('cmp_nvim_lsp').default_capabilities(capabilities)

  -- mason-lspconfig 2.x: vim.lsp.config + automatic_enable.
  -- https://github.com/mason-org/mason-lspconfig.nvim
  vim.lsp.config('*', {
    capabilities = capabilities,
    on_attach = on_attach,
  })

  vim.lsp.config('gopls', {
    cmd_env = {
      GOFLAGS = "-tags=pebbledb", -- 2025-11-07: Nibiru Go codebase
    },
  })

  vim.lsp.config('lua_ls', {
    settings = lsp_servers_mason.lua_ls,
  })

  require('mason-lspconfig').setup {
    ensure_installed = vim.tbl_keys(lsp_servers_mason),
    automatic_enable = {
      exclude = { "rust_analyzer" },
    },
  }

  require('core/mason-lock').setup()

  -- `:Toc` / `:TocCopy`: markdown TOC via jiyuu/mdtoc.
  local mdtoc_cli = '"$HOME/ki/boku/jiyuu/mdtoc/src/cli.ts"'
  local mdtoc_flags = '--bullets="-" --maxdepth=3 --no-firsth1'

  vim.api.nvim_create_user_command('TocCopy', function()
    vim.cmd('!bun run ' .. mdtoc_cli .. ' % ' .. mdtoc_flags .. ' | pbcopy')
    print('markdown-toc: yanked TOC to clipboard')
  end, {
    desc = "Generate markdown TOC and copy to clipboard",
  })

  vim.api.nvim_create_user_command('Toc', function()
    local file = vim.fn.expand('%:p')
    if file == '' then
      print('markdown-toc: save the buffer first')
      return
    end
    vim.cmd('write')
    local cmd = table.concat({
      'bun run',
      mdtoc_cli,
      vim.fn.shellescape(file),
      '-i',
      mdtoc_flags,
    }, ' ')
    vim.fn.system(cmd)
    if vim.v.shell_error == 0 then
      vim.cmd('edit!')
      print('markdown-toc: updated TOC in place')
    else
      print('markdown-toc: failed')
    end
  end, {
    desc = "Insert/update markdown TOC at <!-- toc --> marker",
  })

  setup_autoformat()
end

--- @type LazyPluginSpec
local plugin_spec = {
  'neovim/nvim-lspconfig',
  lazy = false,
  dependencies = {
    {
      'mason-org/mason.nvim',
      config = true,
      opts = { ensure_installed = { "prettier" } },
    },
    'mason-org/mason-lspconfig.nvim',
    { 'j-hui/fidget.nvim', tag = "legacy", opts = {} },
    {
      'folke/lazydev.nvim',
      ft = 'lua',
      opts = {
        library = {
          { path = '${3rd}/luv/library', words = { 'vim%.uv' } },
        },
      },
    },
    { 'mrcjkb/rustaceanvim', version = '^7', ft = { 'rust' } },
    {
      'hedyhli/outline.nvim',
      config = function()
        require('outline').setup({})
      end,
    },
  },
  -- Shared machines get these servers without opening Mason.
  opts = {
    servers = {
      tailwindcss = {},
    },
  },
  config = plugin_config,
}

return plugin_spec
