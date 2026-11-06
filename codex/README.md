# Codex Config

`config.ts` maintains portable defaults for the Codex CLI. It writes the
runtime file at `$HOME/.codex/config.toml` while preserving local state.

Its `mcp_servers` table is the MCP source for every tool. `config.ts` never
changes it; `just sync` exports it to Claude Code. See
[`mcp/README.md`](../mcp/README.md).

## Managed settings

The TypeScript `dotfileConfig` object owns general preferences: personality,
model, reasoning effort, approval policy, sandbox mode, and
`tui.vim_mode_default`. Edit that object to change the backed-up defaults.

Project-specific trust, TUI onboarding state, authentication, history, caches,
databases, and logs are intentionally not backed up here. MCP servers are
local data in the runtime file, not part of `dotfileConfig`.

See the [Codex config reference](https://developers.openai.com/codex/config-reference).

## Output

The runtime file holds MCP tokens. Drift reports from `--dry-run`, `--check`,
and `--run` list changed key paths, such as `~ tui.vim_mode_default`, and
never values. `--print` writes the full generated file, secrets included.

## Usage

```bash
# Show help
bun run codex/config.ts

# Preview or check drift
bun run codex/config.ts --dry-run
bun run codex/config.ts --check

# Apply portable defaults
bun run codex/config.ts --run
```
