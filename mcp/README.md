# MCP Servers

Default sync takes the union of local Codex, Claude Code, and Cursor MCP
servers by name. Add a server in any of them, then run `ud boku sync` or the
MCP-only command below. Existing definitions stay in place, even when they
differ. Codex stores definitions needed by generated launchers, but does not
win configuration disagreements during default sync.

```bash
just mcp-sync --dry-run       # preview
just mcp-sync --run           # union, without other machine setup
just mcp-sync --check         # used by just health
just mcp-sync --from claude --run  # explicitly prefer Claude settings
just mcp-sync --from codex --run   # explicitly prefer Codex settings
just mcp-sync --from cursor --run  # explicitly prefer Cursor settings
```

## Union and Directional Sync

- A name missing from another platform is added when its definition can be
  represented there. Equivalent settings are a no-op.
- Existing names with different settings are preserved. Sync and health print
  advisory warnings with platform names and differing field names, never
  values. Warnings alone do not fail health. Missing propagatable servers do.
- When a name differs and a third platform lacks it, fill the missing entry
  from Codex first, then Claude, then Cursor. This order never replaces an
  existing entry during default sync.
- `--from` chooses the source for overlapping names and corrects other
  platforms. Destination-only names remain and participate in the union.
- `just mcp-ingest` and `just mcp-ingest cursor` are compatibility commands for
  directional reconciliation. Unlike the old recipe, selecting the source
  authorizes replacements without an additional `--force`.
- Default sync never deletes servers. Removing an independent definition from
  only one platform restores it from another. Remove it everywhere to keep it
  gone. A dangling generated launcher has no settings to restore, so sync
  warns and preserves it.
- Disabled Codex entries stay disabled. SSE, interpolation, and platform-only
  auth fields are preserved and reported when they cannot be mapped.
- Only local user configurations participate. Claude-hosted connectors,
  project entries, and OAuth sessions are not imported.

The old `mcp/ingest.ts` remains available as a low-level, one-source importer
with its existing clash and `--force` behavior. The standalone
`claude/mcp.ts` and `cursor/mcp.ts` exporters also retain their older one-way
behavior, including managed deletions. Normal sync and health use the union
coordinator instead.

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

A Codex server with `enabled = false` remains disabled and is not propagated.

## Writes, Logs, and Credentials

`just sync` records the MCP step in the existing run log. `just mcp-sync`
also records its own run and captures the credential-free plan as an artifact.
A preview writes logs but does not change MCP configurations.

Claude writes use `claude mcp add-json --scope user` and `claude mcp remove`.
Cursor and Codex writes are atomic, private files. Directional replacements
save private backups before discarding independent definitions. Backups may
contain credentials and are not committed or automatically deleted.

All inputs are checked before applying the plan. Target changes during the
run stop further writes. Cross-platform application is not transactional;
a failure can leave completed additions in place. Fix the reported cause and
rerun. Claude replacements attempt to restore the old entry if adding fails.

The `add-json` payload can appear in the process list while Claude runs. CLI
errors from that operation omit stderr to avoid echoing credentials.

For isolated inspection, the coordinator accepts `--codex-config`,
`--claude-config`, and `--cursor-config`. Claude writes require its actual
user config; use `CLAUDE_CONFIG_DIR` for an isolated profile. To test from a
worktree without creating launcher references to that temporary checkout,
pass `--launcher-path` pointing to the stable `claude/mcp-launch.ts`.

This synchronizes local runtime settings. It does not store credentials in
the dotfiles Git repository. Do not use the standalone exporters' `--print`
option with credentials, because it includes HTTP header values.
