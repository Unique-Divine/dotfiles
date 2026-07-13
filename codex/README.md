# Codex Config

`config.ts` maintains portable defaults for the Codex CLI. It writes the
runtime file at `$HOME/.codex/config.toml` while preserving local state.

## Managed settings

The TypeScript `dotfileConfig` object owns general preferences: personality,
model, reasoning effort, trust level, approval policy, sandbox mode, and
`tui.vim_mode_default`. Edit that object to change the backed-up defaults.

Project-specific trust, MCP servers, TUI onboarding state, authentication,
history, caches, databases, and logs are intentionally not backed up here.

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
```
