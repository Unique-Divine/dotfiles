# Grok Config

`config.ts` maintains portable defaults for the Grok CLI. It writes
`$HOME/.grok/config.toml` and `$HOME/.grok/pager.toml` while preserving local
state. `GROK_HOME` overrides the directory when it is set.

The Codex `[mcp_servers]` table remains the MCP source for every tool. This
script never writes that table. Grok loads the Cursor and Claude exports
through its default compatibility scans. See [`mcp/README.md`](../mcp/README.md).

## Managed settings

The TypeScript `dotfileConfig` object owns prompt Vim (`keys.vim = "all"`),
`ui.permission_mode = "auto"`, and the status line command. `dotfilePager`
owns `terminal.alt_screen = "never"`, so Tmux and Herdr copy mode can scroll
earlier output. `/vim-mode` can only store `off` or `nav`. The next sync puts
`all` back.

Authentication, sessions, marketplace flags, the privacy acknowledgement, and
MCP servers are local data. Do not symlink either runtime file. Grok follows a
symlink on `config.toml` and would write machine state into this repo.

`statusline.sh` prints the working directory, git branch, model, and context
percent. Grok does not send the editor mode, so the line has no mode chip.
The command path is absolute. Run `just sync` after moving the checkout.

Restart Grok after a pager change. Output that was drawn on the alternate
screen is not copied into the normal scrollback.

## Output

The runtime files can hold MCP tokens if a server was added by hand. Drift
reports from `--dry-run`, `--check`, and `--run` list changed key paths, such
as `~ keys.vim`, and never values. `--print` writes the full generated files,
secrets included.

## Usage

```bash
# Show help
bun run grok/config.ts

# Preview or check drift
bun run grok/config.ts --dry-run
bun run grok/config.ts --check

# Apply portable defaults
bun run grok/config.ts --run
```
