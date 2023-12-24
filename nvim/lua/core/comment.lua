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

--[[
Since Nov 18, 2023, usage of "JoosepAlviste/nvim-ts-context-commentstring" as
an nvim-treesitter module has been deprecated. The plugin is set up automatically
now.

Q: Why use it?  A: For proper commenting inside of jsx and tsx (React) blocks.

- Plugin: https://github.com/JoosepAlviste/nvim-ts-context-commentstring/issues/82
- Migation Guide: https://github.com/JoosepAlviste/nvim-ts-context-commentstring/issues/82#issuecomment-1817659634
]]
--

--[[
Vue support: https://github.com/numToStr/Comment.nvim/discussions/259

According to the maintainer, numToStr, Vue support should work automatically
if tree-sitter-vue is installed.

In order to install `tree-sitter-vue`, you must add "vue" as an ensured
language in the treesitter config. Making this change didn't fix it for me but
definitely changed something about how my LSP parsed `.vue` files.

The `template` tags were parsed, but the `script` ones were not.

To get the `script` blocks to work, I had to make another adjustment for
treesitter. I had to add more languages to "ensure_installed":

```lua
ensure_installed = {
  'c', 'cpp', 'go', 'lua', 'python', 'rust', 'tsx',
  'typescript', 'vimdoc', 'vim', 'vue', 'html', 'css', 'scss', 'javascript'
},
```

To get mine to work, I needed to add 'javascript', 'css', 'html', 'vue', 'scss',
and 'typescript'.

]]
--

comment.setup(config)
