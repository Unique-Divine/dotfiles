# Claude Code configuration

This directory manages the parts of Claude Code config that should match on
every machine. `just sync` applies them and `just health` fails on drift.
Background: [#67](https://github.com/Unique-Divine/dotfiles/issues/67).

Script `config.ts` is the single entry point for both
`$HOME/.claude/settings.json` and `$HOME/.claude.json`. It preflights both files
before writing, and checks or repairs the managed configuration in one call:

```bash
just claude config --check
just claude config --dry-run
just claude config --run
```

With `CLAUDE_CONFIG_DIR` set to a nonempty path, settings, global state, MCP
configuration reads, and Herdr hooks use that directory. Settings live at
`settings.json` and global state at `.claude.json` inside it. An unset or empty
override keeps the default paths above; other profiles are left alone.

## Global instructions

File `CLAUDE.md` is linked to `$HOME/.claude/CLAUDE.md` by
`zsh/managed-links.txt`, so Claude Code loads it in every project. It says
that the Bash tool runs commands in zsh, so commands must use zsh syntax, and
that `rg` is preferred over `grep`. It also says to typecheck TypeScript with
`bun check`, not `tsc`. Keep it short, because it loads into every
session.

## Settings

File `config.ts` owns top-level keys in `$HOME/.claude/settings.json` and
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

Sync adds each rule in `managedAllowRules` to `permissions.allow`:
`Bash(rg:*)`, plus `mcp__superhuman-mail__unsubscribe` and
`mcp__superhuman-mail__trash_thread` for inbox cleanup. Other Superhuman tools,
such as `send_draft`, still prompt. It doesn't own `permissions`: rules added through
`/permissions` or prompts, along with `deny`, `ask`, and `defaultMode`, stay.
Removing a rule from `managedAllowRules` doesn't remove it from the runtime
file.

The diff shows only owned keys and `permissions`, so unmanaged values such as
an `env` block never print.

## Portable preferences and onboarding

`just sync` enforces these fields in `$HOME/.claude.json` on every machine:

```json
{
  "editorMode": "vim",
  "showExpandedTodos": true,
  "hasCompletedOnboarding": true
}
```

The source of truth is `config.ts`. Other fields, including MCP definitions,
authentication, account identity, and project trust, are preserved. Login
remains a separate step on each machine. These are internal Claude fields;
the onboarding marker was verified with Claude Code 2.1.310 on Homebox.

`just health` checks the fields without writing. Repair refuses to change
state while Claude processes are running under your user, because Claude can
rewrite this file. An already-current file needs no write and does not block
sync. Changes use a private backup and an atomic replacement. The state diff
shows only the three managed fields.

## MCP servers

File `mcp.ts` registers the MCP servers from `$HOME/.codex/config.toml` in
Claude's user scope. Stdio servers run through `mcp-launch.ts`, so their env
stays in the Codex file. See [`mcp/README.md`](../mcp/README.md) for the flow,
entry shapes, and sync rules.
