# Codex Config

`config.ts` maintains portable defaults for the Codex CLI. It writes the
runtime file at `$HOME/.codex/config.toml` while preserving local state.

When `$HOME/.cursor/mcp.json` exists, its `mcpServers` entries are imported
into Codex's `mcp_servers` table. A Cursor server replaces a same-named Codex
server; Codex-only servers remain local. The source path can be overridden for
automation and tests with `--mcp-source <path>`.

## Managed settings

The TypeScript `dotfileConfig` object owns general preferences: personality,
model, reasoning effort, trust level, approval policy, sandbox mode, and
`tui.vim_mode_default`. Edit that object to change the backed-up defaults.

Project-specific trust, TUI onboarding state, authentication, history, caches,
databases, and logs are intentionally not backed up here. MCP servers are
local except for same-named entries managed through Cursor's MCP config.

See the [Codex config reference](https://developers.openai.com/codex/config-reference).

## Usage

```bash
# Show help
bun run codex/config.ts

# Preview or check drift
bun run codex/config.ts --dry-run
bun run codex/config.ts --check

# Apply portable defaults
bun run codex/config.ts --run

# Use a non-default Cursor MCP source
bun run codex/config.ts --run --mcp-source /path/to/mcp.json
```
