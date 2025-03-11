# Development Guidelines

## Commands
- **Test:** `just test` or `bun test` 
- **Test single file:** `bun test path/to/test.ts`
- **Formatter:** Use VSCode/Neovim built-in formatter
- **Typecheck:** `tsc --noEmit`

## Code Style
### TypeScript
- 2 space indentation
- camelCase for variables/functions, PascalCase for classes/interfaces
- Explicit typing with interfaces and type annotations
- Group imports: external first, then internal
- Use async/await with .nothrow() for error handling

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