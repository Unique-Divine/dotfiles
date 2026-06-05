# Cursor CLI Config

This directory stores the dotfile config for the Cursor CLI. The source of
truth is `cli-config.ts`; the generated runtime config is
`$HOME/.cursor/cli-config.json`.

## Docs

- [Cursor CLI configuration](https://cursor.com/docs/cli/reference/configuration.md)
- [Cursor CLI terminal setup](https://cursor.com/docs/cli/reference/terminal-setup.md)
- [Cursor CLI slash commands](https://cursor.com/docs/cli/reference/slash-commands.md)

## Model

`cli-config.ts` owns stable user preferences such as `permissions`, `editor`,
`approvalMode`, `sandbox`, `network`, and display-related settings.

The runtime config can also contain Cursor-managed fields such as `authInfo`,
`privacyCache`, `serverConfigCache`, `model`, `selectedModel`,
`modelParameters`, and prompt/cache counters. Those fields are preserved when the
runtime config is rewritten, but they are not copied into the dotfile config.

This keeps the dotfiles portable while allowing Cursor to keep local auth,
model-picker state, and cache values in the runtime config.

## Usage

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

Shell startup runs the script with `--run --quiet`, so normal terminals do not
get extra output. The script compares the generated JSON with the current
runtime config and only writes when the content differs.
