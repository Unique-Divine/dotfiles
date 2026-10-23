# Claude Code Config

This directory manages the parts of Claude Code config that should match on
every machine. `just sync` applies them and `just health` fails on drift.
Background: [#67](https://github.com/Unique-Divine/dotfiles/issues/67).

## Settings

File `settings.ts` owns top-level keys in `$HOME/.claude/settings.json` and
keeps every other key, including values that `/config`, `/model`, and
permission prompts write. Claude Code writes this file, so do not symlink it.

Object `dotfileSettings` sets `attribution` to hide the `Co-Authored-By`
commit trailer, the "Generated with Claude Code" PR footer, and the
claude.ai session link. Sync also removes the deprecated
`includeCoAuthoredBy` key. See the
[settings reference](https://code.claude.com/docs/en/settings-reference.md).

Object `dotfileSettings` also sets `statusLine` to run script
`statusline.sh` from this checkout. The script mirrors the lualine setup in
`nvim/init.lua`. It shows the vim mode as 普通 (NORMAL) or 入れる (INSERT) on
onedark colors, the working directory with `$HOME` shortened to `~`, and the
git branch. The entry holds an absolute path, so run `just sync` after moving
the checkout. See the
[status line docs](https://code.claude.com/docs/en/statusline.md).

```bash
echo '{"workspace":{"current_dir":"'"$PWD"'"},"vim":{"mode":"INSERT"}}' \
  | bash claude/statusline.sh
```

The diff shows owned keys only, so unmanaged values such as an `env` block
never print.

```bash
bun run claude/settings.ts --dry-run
bun run claude/settings.ts --run
bun run claude/settings.ts --check
```

## MCP servers

File `$HOME/.cursor/mcp.json` is the MCP source for Cursor, Codex, and
Claude Code. `codex/config.ts` copies its servers into Codex. File `mcp.ts`
registers each stdio server in Claude's user scope with an entry like this:

```json
{
  "type": "stdio",
  "command": "/home/me/.bun/bin/bun",
  "args": [
    "/path/to/dotfiles/claude/mcp-launch.ts",
    "--source", "/home/me/.cursor/mcp.json",
    "notion-mcp"
  ]
}
```

The entry has no `env`. When Claude Code starts the server, `mcp-launch.ts`
reads that server's definition from the Cursor file and passes its `env` only
to the child process. Tokens stay in one file, and no secret value lands in
`$HOME/.claude.json` or in this script's output. Edit a token in
`$HOME/.cursor/mcp.json` and the next Claude session uses it with no resync.

Sync rules:

- A Cursor stdio server is added, or replaces a same-named Claude entry.
- A launcher entry whose server left the Cursor file is removed.
- Claude-only servers that do not run `claude/mcp-launch.ts` are left alone.
- Remote (`url`) servers are skipped, because their `headers` usually hold
  credentials. Add them with `claude mcp add`.

Writes go through `claude mcp add-json --scope user` and `claude mcp remove`,
because Claude Code rewrites `$HOME/.claude.json` while it runs. Output lists
server names only.

```bash
bun run claude/mcp.ts --dry-run
bun run claude/mcp.ts --run
bun run claude/mcp.ts --check
bun run claude/mcp.ts --print   # generated entries, no env
```

Entries hold absolute paths to this checkout and to `bun`. After moving the
checkout, run `just sync` to rewrite them.
