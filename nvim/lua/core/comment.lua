-- core/comment.lua
--
-- "gc" to comment visual regions/lines
-- "gcc" to comment current line
--
-- Plugin repo: https://github.com/numToStr/Comment.nvim
-- Installed in the init.lua.
--
local comment = require("Comment")

---@type CommentConfig?
local config = {
  -- See: https://github.com/numToStr/Comment.nvim#pre-hook
  pre_hook = require('ts_context_commentstring.integrations.comment_nvim').create_pre_hook(),
}

comment.setup(config)
