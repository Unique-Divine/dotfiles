# Development Guidelines

## Commands
- **Test:** `just test` or `bun test` 
- **Test single file:** `bun test path/to/test.ts`
- **Run TS files directly:** `bun run file.ts`
- **Formatter:** Use VSCode/Neovim built-in formatter
- **Typecheck:** `bun check`
- **Install packages:** `bun install package-name`

## Maintainer Prefs
- Prefer writing the dotfiles dir as the commit prefix. For example, write
"codex: Commit body" rather than "chore(codex): Commit body". I hate "chore".
- Put anything that acts like a command in a small program under `bin/`,
listed in `zsh/managed-links.txt`, not in a zsh function or alias. PATH reaches
bash, agents, and subprocesses that Go, Python, or Bun start; zsh startup
files do not. Write it in zero-dependency Bun TypeScript or Python, or Bash for
a few lines of glue. `bin/node`, `bin/npm`, and `bin/npx` are examples.

## Code Style
### TypeScript
- 2 space indentation
- camelCase for variables/functions, PascalCase for classes/interfaces
- Explicit typing with interfaces and type annotations
- Group imports: external first, then internal
- Use try/catch blocks for error handling with async/await
- Use @uniquedivine/bash for shell commands instead of Bun's $
- Prefer functional, testable patterns with pure functions
- Use clear interface definitions for data structures
- Always export functions that should be testable
- Write tests in separate .test.ts files using bun:test
- Create test data programmatically rather than using mocks

### Lua (Neovim)
- 2 space indentation
- `local` function definitions
- Document with `--` comments or `--[[...]]` blocks
- Group related functionality with blank lines

### Shell
- 2 space indentation
- `#!/usr/bin/env bash` shebang
- snake_case for variables/functions
- Quote variables with double quotes
- Function comments explaining purpose and usage

### General
- 80-81 character line width
- Spaces, not tabs
- Prefer explicit over implicit
- Test all non-trivial functionality

## Prompting Guidelines
- Prefer functioning code over explanations
- Focus on testability and maintainability in generated code
- For complex file changes, prefer small iterative edits rather than full rewrites
- Always implement proper error handling
- When dealing with TypeScript, use native Bun features for running/testing
- Do not mock dependencies for testing - use real data structures
- For shell commands, use @uniquedivine/bash package and handle errors with try/catch
- When adding new capabilities, create modular, testable functions

Use native `bun check` for TypeScript type checking; retain compilers for emitted output and framework-specific validation.
