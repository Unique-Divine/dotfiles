-- core/specs/cmp.lua
--
-- Eager Lazy spec for nvim-cmp. Snippet definitions stay in core/snippets.lua.

local function plugin_config()
  local cmp = require('cmp')
  local luasnip = require('core/snippets')

  local has_words_before = function()
    if vim.api.nvim_buf_get_option(0, 'buftype') == 'prompt' then
      return false
    end
    local line, col = unpack(vim.api.nvim_win_get_cursor(0))
    return col ~= 0
      and vim.api.nvim_buf_get_text(
        0, line - 1, 0, line - 1, col, {}
      )[1]:match('^%s*$') == nil
  end

  ---@type cmp.Setup
  cmp.setup {
    ---@type cmp.SnippetConfig
    snippet = {
      expand = function(args)
        luasnip.lsp_expand(args.body)
      end,
    },

    mapping = cmp.mapping.preset.insert {
      ['<C-n>'] = cmp.mapping.select_next_item(),
      ['<C-p>'] = cmp.mapping.select_prev_item(),
      ['<C-d>'] = cmp.mapping.scroll_docs(-4),
      ['<C-f>'] = cmp.mapping.scroll_docs(4),
      ['<C-Space>'] = cmp.mapping.complete {},
      ['<CR>'] = cmp.mapping.confirm {
        behavior = cmp.ConfirmBehavior.Replace,
        select = true,
      },
      ['<Tab>'] = cmp.mapping(function(fallback)
        if cmp.visible() and has_words_before() then
          cmp.select_next_item({
            behavior = cmp.SelectBehavior.Select,
          })
        elseif luasnip.expand_or_locally_jumpable() then
          luasnip.expand_or_jump()
        else
          fallback()
        end
      end, { 'i', 's' }),
      ['<S-Tab>'] = cmp.mapping(function(fallback)
        if cmp.visible() then
          cmp.select_prev_item()
        elseif luasnip.locally_jumpable(-1) then
          luasnip.jump(-1)
        else
          fallback()
        end
      end, { 'i', 's' }),
    },

    sources = {
      { name = 'lazydev', group_index = 0 },
      { name = 'nvim_lsp' },
      { name = 'luasnip' },
      { name = 'crates' },
      { name = 'path' },
    },
  }
end

--- @type LazyPluginSpec
local plugin_spec = {
  'hrsh7th/nvim-cmp',
  -- Completion and snippets run only in insert mode. First InsertEnter may
  -- hitch once while nvim-cmp, LuaSnip, and friendly-snippets load.
  event = 'InsertEnter',
  dependencies = {
    'hrsh7th/cmp-nvim-lsp',
    { 'L3MON4D3/LuaSnip', version = 'v2.*', build = 'make install_jsregexp' },
    'saadparwaiz1/cmp_luasnip',
    'rafamadriz/friendly-snippets',
  },
  config = plugin_config,
}

return plugin_spec
