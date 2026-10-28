# Claude Code Config

This directory manages the parts of Claude Code config that should match on
every machine. `just sync` applies them and `just health` fails on drift.
Background: [#67](https://github.com/Unique-Divine/dotfiles/issues/67).

## Global instructions

File `CLAUDE.md` is linked to `$HOME/.claude/CLAUDE.md` by
`zsh/managed-links.txt`, so Claude Code loads it in every project. It says
that the Bash tool runs commands in zsh, so commands must use zsh syntax, and
that `rg` is preferred over `grep`. It also says to typecheck TypeScript with
`bun check`, not `tsc`. Keep it short, because it loads into every
session.

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

Claude Code runs its classic renderer, which prints to the normal terminal
screen, so tmux and Herdr copy mode can scroll chat history. The
`"fullscreen"` renderer draws on the alternate screen, so earlier output never
reaches scrollback and copy mode shows only the current screen. This matches
`tui.alternate_screen = "never"` for Codex in `codex/config.ts`. Background:
[#70](https://github.com/Unique-Divine/dotfiles/issues/70).

- `zsh/zshenv` exports `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1`, the primary
  switch, which overrides `tui`. Herdr restores type `claude --resume <id>` into
  a fresh zsh, so restored panes get it too.
- Key `tui` is pinned to `"default"` as a backup for launches that skip zsh.

To test, resume a chat as a copy in a new pane, then scroll in copy mode:

```bash
CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1 claude --resume <session-id> --fork-session
```

Don't sync a renderer change under running sessions. A live switch from
fullscreen blanks the pane. Run `/tui default` in each session, or quit and
resume.

Sync adds each rule in `managedAllowRules`, currently `Bash(rg:*)`, to
`permissions.allow`. It doesn't own `permissions`: rules added through
`/permissions` or prompts, along with `deny`, `ask`, and `defaultMode`, stay.
Removing a rule from `managedAllowRules` doesn't remove it from the runtime
file.

The diff shows only owned keys and `permissions`, so unmanaged values such as
an `env` block never print.

```bash
bun run claude/settings.ts --dry-run
bun run claude/settings.ts --run
bun run claude/settings.ts --check
```

## Portable preferences and onboarding

`just sync` enforces these fields in `$HOME/.claude.json` on every machine:

```json
{
  "editorMode": "vim",
  "showExpandedTodos": true,
  "hasCompletedOnboarding": true
}
```

The source of truth is `state.ts`. Other fields, including MCP definitions,
authentication, account identity, and project trust, are preserved. Login
remains a separate step on each machine. These are internal Claude fields;
the onboarding marker was verified with Claude Code 2.1.310 on Homebox.

`just health` checks the fields without writing. Repair refuses to change
state while Claude processes are running under your user, because Claude can
rewrite this file. An already-current file needs no write and does not block
sync. Changes use a private backup and an atomic replacement. Output shows only
the three managed fields.

```bash
just claude state --check
just claude state --dry-run
just claude state --run
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
