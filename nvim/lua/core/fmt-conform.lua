--- Lightweight formatter to replace null-ls
--- Formatters: https://github.com/stevearc/conform.nvim
--- https://github.com/stevearc/conform.nvim
local export = {}

local conform = require("conform")

local conformCfg = {
  formatters_by_ft = {
    lua = { "stylua" },
    -- A sequence of formatters will run them sequentially
    python = { "black", "isort" },

    javascript = {
      -- sub-field that's a sequence will only run the first available.
      -- The ideal case below is to run 'prettierd', 'eslint_d'.
      { "prettierd", "prettier" }, "eslint_d" },
    bash = { "beautysh" },

    rust = { "rustfmt", lsp_format = "fallback" },
  },
  format_on_save = {
    timeout_ms = 300,
    lsp_fallback = true,
  },

  -- Set the log level. Use `:ConformInfo` to see the location of the log file.
  log_level = vim.log.levels.ERROR,

  -- Conform will notify you when a formatter errors
  notify_on_error = true,
}
conform.setup(conformCfg)

-- Format on save: Manual implementation
-- This is built-into the config on the `format_on_save` field.
-- vim.api.nvim_create_autocmd("BufWritePre", {
--     pattern = "*",
--     callback = function(args)
--         require("conform").format({ bufnr = args.buf })
--     end,
-- })


return export
