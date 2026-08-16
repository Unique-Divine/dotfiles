-- core/specs/comment.lua
--
-- gc / gcc / gco / gcO. JSX/TSX commentstring comes from
-- nvim-ts-context-commentstring (set up by the treesitter spec).
-- https://github.com/numToStr/Comment.nvim

local function plugin_config()
  local ts_comment_hook =
    require('ts_context_commentstring.integrations.comment_nvim')
      .create_pre_hook()

  ---@type CommentConfig?
  require('Comment').setup {
    pre_hook = function(ctx)
      local commentstring = ts_comment_hook(ctx)
      -- Fallback when the filetype commentstring exists but the
      -- matching treesitter parser is not installed.
      return commentstring or vim.bo.commentstring
    end,
  }
end

--- @type LazyPluginSpec
local plugin_spec = {
  'numToStr/Comment.nvim',
  config = plugin_config,
}

return plugin_spec
