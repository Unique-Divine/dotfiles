-- lua/core/snippets.lua
-- This configuration file

local luasnip = require('luasnip')

-- You can pass `{ paths = "./my-snippets/" }` to load from "vscode-like"
-- packages that expose snippets in json files.
-- See https://github.com/rafamadriz/friendly-snippets for examples.
require('luasnip.loaders.from_vscode').lazy_load({ paths = "./core/code-snippets", "lua/core/code-snippets" })
-- paths starts from the path of the neovim config.

--- @class SnippetContext First argument of `new_snippet`
--- @field trig string The trigger text for the snippet.
--- @field name? string A name to identify the snippet.
--- @field dscr? string A description of the snippet.
--- @field wordTrig? boolean If true, expands only when the trigger matches a whole word.
--- @field regTrig? boolean If the trigger should be a Lua pattern.
--- @field trigEngine? function|string Custom or predefined engine for matching triggers.
--- @field docstring string Textual representation of the snippet.
--- @field hidden? boolean If true, the snippet won't show in completions.
--- @field priority? number Priority for the snippet to be matched.
--- @field snippetType? string Either 'snippet' or 'autosnippet'.
--- @field condition? fun() A function that determines if the snippet should expand.
--- @field show_condition? fun() A function for completion engines to determine if the snippet should show.
--- @field filetype? string Filetype for the snippet.


---@type fun(context:SnippetContext|string, nodes:table, opts:table|nil)
---@param context SnippetContext|string Either a table with the SnippetContext
--- or the trigger string as a shorthand for the `trig` key.
---@param nodes table A list of nodes that make up the body of the snippet.
---@param opts table|nil Additional options for the snippet.
---@return table: The constructed snippet object.
--- s: Defines a new snippet.
--- The `nodes` should be a list of snippet nodes to construct the snippet's content.
--- The `opts` table can have keys like `callbacks`, `child_ext_opts`, and `merge_child_ext_opts`.
local function new_snippet(context, nodes, opts)
  return luasnip.snippet(context, nodes, opts)
end

local sn = luasnip.snippet_node
local isn = luasnip.indent_snippet_node
--- t: [t]ext node. Just static text.
-- Passing a table input ([]string) to `t` makes multi-line text.
local t = luasnip.text_node
--- i: [i]nsert node. Insert nodes contain editable text and can be jumpted to
--- and from, such as in the case of placeholders and tabstops.
local i = luasnip.insert_node
local f = luasnip.function_node
local c = luasnip.choice_node
local d = luasnip.dynamic_node
local r = luasnip.restore_node
local events = require("luasnip.util.events")
local ai = require("luasnip.nodes.absolute_indexer")
local extras = require("luasnip.extras")
local l = extras.lambda
local rep = extras.rep
local p = extras.partial
local m = extras.match
local n = extras.nonempty
local dl = extras.dynamic_lambda
local fmt = require("luasnip.extras.fmt").fmt
local fmta = require("luasnip.extras.fmt").fmta
local conds = require("luasnip.extras.expand_conditions")
local postfix = require("luasnip.extras.postfix").postfix
local types = require("luasnip.util.types")
local parse = require("luasnip.util.parser").parse_snippet
local ms = luasnip.multi_snippet
local k = require("luasnip.nodes.key_indexer").new_key

luasnip.add_snippets("all", {
  --
  -- snippets: JS, TS, jsx, tsx
  --
  new_snippet("ternary", {
    -- equivalent to "${1:cond} ? ${2:then} : ${3:else}"
    i(1, "cond"), t(" ? "), i(2, "then"), t(" : "), i(3, "else")
  }),

  new_snippet({ trig = "jsd", docstring = "[JSD]ocs shortcut" }, {
    -- equivalent to "${1:cond} ? ${2:then} : ${3:else}"
    t("/** "), i(1, "TODO: doc"), t(" */")
  }),

  new_snippet({ trig = "cl", docstring = "[c]onsole [l]og shorthand with DEBUG" }, {
    -- equivalent to "console.debug(\"DEBUG ${1:foo}:\", ${1:foo})"
    t("console.debug(\"DEBUG %o: \", "), i(1, "[foo]"),
    t(")"),
  }),

  new_snippet({ trig = "gh-dt", docstring = "[g]it[hub] [d]e[t]ails collapsible menu" }, {
    -- GitHub details collapsile menu
    t({ "<details>",
      "<summary>[Display Text]</summary>",
      "",
      "### Markdown Content (yes, the blank lines are needed)",
      "",
      "</details>",
    }),
  }),


  new_snippet({ trig = "afn", docstring = "JS [a]rrow [fn]" }, {
    -- == "() => {${1}}"
    t("() => {"), i(1, "{fn}"), t("}"),
  }),

  new_snippet({ trig = "aafn", docstring = "JS [a]sync [a]rrow [fn]" }, {
    -- == "() => {${1}}"
    t("async () => {"), i(1, "{fn}"), t("}"),
  }),

  new_snippet({ trig = "jscwt", docstring = "[JS] [c]onstant [w]ith [t]ype" }, {
    -- == "const ${1:name}: ${3:type} = ${2:val}"
    t("const "), i(1, "{name}"), t(": "), i(3, "{type}"), t(" = "), i(2, "{val}")
  }),

  new_snippet({ trig = "todoc", docstring = "[TODO] [c]omment" }, {
    -- equivalent to "${1:cond} ? ${2:then} : ${3:else}"
    t("TODO: UD-DEBUG: ")
  }),

  --
  -- snippets: Rust, rs
  --
  new_snippet({ trig = "rsfn", docstring = "[R]u[s]t [fn]" }, {
    -- pub fn {1:func_name}() => {2:Type} {
    --   // [todo comment] {3:text}
    --   todo!()
    -- }
    t("pub fn "), i(1, "{func_name}"), t("() => "), i(2, "{Type}"),
    t({ " { ", "    /// TODO: " }), i(3, "{text}"), t({ "", "todo!() }" }),
  }),


  -- "body": ["/** ${1:TODO doc} */"],
  -- "description": "Shortcut for quickly adding JSDocs"
})


-- Luasnip config
-- luasnip.config
luasnip.setup()

return luasnip
