# MCP servers

The `[mcp_servers]` table in `$HOME/.codex/config.toml` is the single source
of truth for MCP servers. `just sync` exports it to the Cursor CLI and Claude
Code. Add or edit a server in Codex, by hand or with `codex mcp add`, then run
`just sync`.

```
                  mcp/ingest.ts --from claude|cursor   (opt-in)
                        │
                        ▼
$HOME/.codex/config.toml [mcp_servers]
  ├── cursor/mcp.ts ──▶ $HOME/.cursor/mcp.json (Cursor CLI)
  └── claude/mcp.ts ──▶ $HOME/.claude.json (user scope)
```

`codex/config.ts` manages only the portable Codex defaults. It never changes
`mcp_servers`.

## Entry shapes

A **stdio** server (one with `command`) becomes a launcher entry:

```json
{
  "type": "stdio",
  "command": "/home/me/.bun/bin/bun",
  "args": [
    "/path/to/dotfiles/claude/mcp-launch.ts",
    "--source", "/home/me/.codex/config.toml",
    "notion-mcp"
  ]
}
```

The entry has no `env`. When a tool starts the server, `mcp-launch.ts` reads
that server's `command`, `args`, `env`, and `cwd` from the Codex file and
passes `env` only to the child process. Tokens stay in one file. Edit a token
in `config.toml` and the next session uses it with no resync.

Cursor entries are the same without `"type"`.

A **url** server is copied as is. Codex `http_headers` becomes `headers`, and
Claude entries get `"type": "http"`. A url server that uses
`bearer_token_env_var` or `env_http_headers` is skipped, because the JSON
configs have no equivalent that keeps the secret out of the file. Each tool
runs its own OAuth login for url servers that need it.

A server with `enabled = false` is treated as absent.

## Sync rules

- A Codex server is added to the target, or replaces a same-named entry.
  Replacing an entry this sync did not create is reported as
  `~ replace <name> (unmanaged ... entry)`.
- An entry this sync owns is removed when its server leaves the Codex
  config. Launcher entries are always owned. A url entry is owned when file
  `$XDG_STATE_HOME/dotfiles/mcp-managed.json` (default
  `$HOME/.local/state/dotfiles/mcp-managed.json`) lists its name for that
  target.
- Entries this sync does not own are left alone.
- A Codex server that cannot be mapped is reported with `! skip` and keeps any
  existing copy.

Output lists server names only, never env or header values.

Claude writes go through `claude mcp add-json --scope user` and
`claude mcp remove`, because Claude Code rewrites `$HOME/.claude.json` while
it runs. `cursor/mcp.ts` edits `$HOME/.cursor/mcp.json` directly with an
atomic, mode 0600 replacement, and keeps other top-level keys. Before it
replaces an entry it does not own, it saves the old file as
`mcp.json.before-dotfiles-<ms>`, which can hold tokens.

## Ingest servers added elsewhere

A server added with `claude mcp add` or by hand in the Cursor file stays in
that tool. To make it a Codex server and export it everywhere, run:

```bash
bun run mcp/ingest.ts --from claude --dry-run   # preview
just mcp-ingest                                 # Claude → Codex → all tools
just mcp-ingest cursor                          # Cursor → Codex → all tools
```

Ingest skips launcher entries, which already come from Codex, and SSE
servers, which Codex cannot run. It adds a server only when Codex has no
server of that name. A same-named server with a different definition is
reported as `! clash`; `--force` replaces its `command`, `args`, `env`, `cwd`,
`url`, and `http_headers` and keeps other Codex fields such as
`startup_timeout_sec`. The Codex file is rewritten with mode 0600, and output
lists key paths, never values.

After the export, Claude's ingested stdio entry becomes a launcher entry, so
its env leaves `$HOME/.claude.json`. Url servers that use OAuth need a login
in Codex once, with `codex mcp login <name>`.

## Commands

`just sync` runs `cursor/mcp.ts --run`, then `claude/mcp.ts --run` when the
`claude` CLI is installed. `just health` runs both with `--check`.

```bash
bun run cursor/mcp.ts --dry-run
bun run cursor/mcp.ts --run
bun run claude/mcp.ts --check
bun run claude/mcp.ts --print   # generated entries, no stdio env
```

Both scripts take `--run`, `--dry-run`, `--check`, and `--print`, plus
`--mcp-source <config.toml>`, `--state <path>`, and `--claude-config` or
`--cursor-config` for tests or other profiles. Entries hold absolute paths to
this checkout and to `bun`. After moving the checkout, run `just sync` to
rewrite them.
