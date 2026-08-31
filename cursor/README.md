# Cursor CLI Config

File `cli-config.ts` is the source of truth for portable Cursor CLI
preferences. Command `just sync` merges those values into
`$HOME/.cursor/cli-config.json`. Command `just health` runs `--check` and
fails if the runtime file would change.

## Docs

- [Cursor CLI configuration](https://cursor.com/docs/cli/reference/configuration.md)
- [Cursor CLI terminal setup](https://cursor.com/docs/cli/reference/terminal-setup.md)
- [Cursor CLI slash commands](https://cursor.com/docs/cli/reference/slash-commands.md)

## Model

Object `dotfileConfig` in file `cli-config.ts` owns `permissions`, `editor`,
`approvalMode`, `sandbox`, `network`, and `attribution`. Field
`editor.vimMode` is `true`. Both attribution flags are `false`, so commits
and pull requests created through Cursor do not add agent attribution.

The runtime file can also hold Cursor-managed fields such as `authInfo`,
`privacyCache`, `serverConfigCache`, `model`, `selectedModel`,
`modelParameters`, and prompt or cache counters. The merge keeps those
values and does not copy them into `dotfileConfig`.

Do not symlink the runtime JSON. It holds tokens.

## Usage

`just sync` runs `bun run cursor/cli-config.ts --run`. `just health` runs
`--check`. The script compares generated JSON with the current runtime file
and writes only when the content differs.

Show help:

```bash
bun run cursor/cli-config.ts
```

Preview changes:

```bash
bun run cursor/cli-config.ts --dry-run
```

Apply changes:

```bash
bun run cursor/cli-config.ts --run
```

Check for drift without writing:

```bash
bun run cursor/cli-config.ts --check
```

Print the generated runtime config:

```bash
bun run cursor/cli-config.ts --print
```
