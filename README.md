# Dotfiles - Unique Divine

My personal development environment configuration optimized for Ubuntu 24.04 and
WSL, designed to provide a consistent and easily reproducible experience across
machines.

<h2>Table of Contents</h2>

<!-- toc -->
- [What's Included](#whats-included)
- [Quick Setup](#quick-setup)
- [Symlink Philosophy](#symlink-philosophy)
- [Features](#features)
  - [Sync and health checks](#sync-and-health-checks)
  - [AI agent skills](#ai-agent-skills)
  - [Neovim Configuration](#neovim-configuration)
  - [Terminal Environment: tmux, zsh, bun](#terminal-environment-tmux-zsh-bun)
  - [Herdr configuration](#herdr-configuration)
  - [Codex config](#codex-config)
  - [Claude Code config](#claude-code-config)
  - [WSL Clipboard Integration](#wsl-clipboard-integration)
- [Requirements](#requirements)
- [Benchmarks and Testing](#benchmarks-and-testing)
<!-- tocstop -->

## What's Included

- **Neovim**: Lua configuration with LSP, treesitter, and WSL clipboard integration
- **Tmux**: Terminal multiplexer with Vim-style navigation and session persistence
- **Zsh**: Shell configuration with Oh-My-Zsh, aliases, and developer tooling setup
- **Bash**: Utility scripts, color-coded logging, and environment detection
- **WSL Integration**: Seamless clipboard sharing between Ubuntu and Windows

## Benchmarks and Testing


| Mode | Mean | Median | P95 |
| --- | ---: | ---: | ---: |
| Synchronous startup | 493.65 ms | 474.46 ms | 639.55 ms |
| Prompt ready | 841.24 ms | 756.90 ms | 1138.75 ms |


See the [benchmark log](benchmarks.md) for reverse-chronological performance
results across the shell, Neovim, and WSL clipboard setup.

```bash
# Run all tests
just test
# or
bun test

# Test clipboard functionality
bun test zsh/clipboard.test.ts
```


The [root CI workflow](.github/workflows/ci.yml) detects changes once using
[shared path filters](.github/filters.yml) for four components:

| Component | Checks |
| --- | --- |
| Bun and shell scripts | `just typecheck`, `just test-bun` |
| Root Cargo workspace | `just test-rust`, Clippy |
| Herdr native inputs | Five platform builds, smoke tests, release preparation |
| herdr-tmux package | Linux and macOS format, tests, Clippy, package checks |

`just test` runs both local test suites. The routing summary explains which
components run. `CI result` requires every selected job to pass and accepts
intentional skips. The publish check passes without setup or publication on
non-release events, using step-level conditions.

Manual CI runs force all component checks without publishing. PRs and main
pushes use changed paths; pushes to `ud/herdr-tmux` check only affected plugin
inputs. Herdr tag pushes run the release pipeline. Changes to the orchestrator
or shared filters verify every component. See [Herdr release verification](herdr-release/README.md#verify-a-release-candidate-before-merge)
for native build and publishing rules.


## Quick Setup

```bash
# Clone the Boku workspace and its required submodules.
git clone --recurse-submodules git@github.com:Unique-Divine/boku.git "$HOME/ki/boku"
cd "$HOME/ki/boku/dotfiles"

# Install system packages used by the shell.
# - build-essential: Used in almost everything
# - wslu: Provides `wslview` (Example: gh pr view --web). This fixes the error,
#   > exec: "xdg-open,x-www-browser,www-browser,wslview": executable file not found in $PATH
sudo apt install build-essential wslu

# Install mise and the CLI tools pinned in mise/mise.lock: gh, ripgrep, jq,
# just, bat, sd, tree-sitter (for nvim-treesitter's `main` branch), buf,
# lychee, gmailctl, fzf, eza and Neovim. See mise/README.md.
curl -fsSL https://mise.run | MISE_VERSION=v2026.11.5 sh
mkdir -p ~/.config && ln -sfn "$PWD/mise" ~/.config/mise
~/.local/bin/mise install --locked

# Rust toolchain for the dotfiles' own crates. The command comes from
# https://rustup.rs/
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Homebrew/Linuxbrew must be on PATH, then install formulas from Brewfile.
just i-brew

# Install development tools
bun install

# Create and repair configuration links. Command `just sync` merges Jiyuu's
# `origin/main` into its current branch before building `gh-rev`.
just sync
just list
```

- [ ] Make the `kubectl` installation reproducible in dotfiles.
  - Managed path is `brew "kubectl"` in `Brewfile`, installed by `just i-brew`.
    Homebrew alias for `kubernetes-cli` stable 1.37.0. Verified
    `kubectl version --client` reports `v1.37.0`.
  - Previous host binary was a direct Kubernetes release download at
    `~/.local/bin/kubectl` (`v1.35.7` Linux ARM64 from
    `https://dl.k8s.io/release/v1.35.7/bin/linux/arm64/kubectl`). That
    file was removed so it no longer shadows Homebrew on PATH.
  - [x] Evaluate `brew install kubectl` as the managed direct-binary install
    path.
  - [ ] Pin or document client-version compatibility with the GKE control
    plane.

After installing `nvim`, restore Neovim plugins from the lazy.nvim lockfile:

```bash
nvim --headless "+Lazy! restore" +qa

# Restore external Neovim tools from nvim/mason.lock.
just nvim-mason-restore
```


## Symlink Philosophy

This dotfiles repo uses symbolic links to maintain a single source of truth for all configurations. The advantages of this approach include:

- **Version control**: Track changes to your configurations over time
- **Portability**: Quickly set up identical environments across machines
- **Centralization**: Modify configs in one place and have changes propagate
- **Safety**: Original system files aren't modified, only linked to
- **Maintenance**: Updates to the repo instantly apply to all linked machines

[`zsh/managed-links.txt`](zsh/managed-links.txt) is the source of truth for
managed symbolic links. Each mapping is `source destination`, separated by
one ordinary space. Paths cannot contain whitespace; blank lines and lines
starting with `#` are ignored. `just sync` runs `symlinks.sh` to create or
repair each mapping; `just health` validates the same mappings without
writing state.

## Features

### Sync and health checks

`just sync` runs the established shell bootstrap, applies portable Codex
and Cursor CLI defaults, and synchronizes managed AI skills. It also links
[`zsh/cargo-config.toml`](zsh/cargo-config.toml) to `~/.cargo/config.toml`,
which builds Rust dev and test profiles with `debug = "line-tables-only"`:
backtraces keep file and line numbers, but debugger variable info is
dropped to keep `target/` small. `just health`
does not write: it checks required commands, Mason packages, and Codex,
Cursor CLI, or skills-sync drift with a nonzero exit status. Mason package
installation remains an explicit action.

Global Bun CLI packages are declared in
[`bun/global/package.json`](bun/global/package.json), with transitive versions
recorded in its lockfile. Command `just sync` restores the installation and
command links before updating Jiyuu. Command `just bun-health` checks it without
installing packages. See [Bun tool management](bun/README.md) for migration,
package changes, and publishing the Markdown TOC tool.

Claude Code uses its native installation. Commands `just sync` and
`just claude-install` install it when missing, while `just claude-health` checks
that the shell selects the native executable. The native installer manages
Claude updates independently of the Bun package lock.

Codex works the same way: `just sync` and `just codex-install` install the
standalone CLI with OpenAI's installer when it's missing
([`codex/native.sh`](codex/native.sh)).

`just sync` also merges `origin/main` into whatever branch Jiyuu is on, using
[`git_mf main`](bin/git_mf). Uncommitted changes, a conflict, or a
`main` that has diverged from `origin` leave Jiyuu untouched with a warning, and
the rest of the sync still runs.

### Merging From main

`git_mf main` brings the current branch up to date with `origin/main`: a
fast-forward on `main`, and a merge commit on any other branch. Any other
target works the same way. When the merge needs judgment, it stops without
changing anything. `git_mf main --agent` then hands the merge to `claude -p`,
or `codex exec` when Claude is missing, with the instructions in
[`git_mf.prompt.md`](bin/git_mf.prompt.md). Those instructions
also work when pasted into any agent chat.

Each run prints its plan (`git_mf: plan: ...`) and every command that changes
the repository (`RUN ...`). `git_mf main --dry-run` prints them without running
anything; only remote-tracking refs are fetched. It predicts conflicts with
`git merge-tree`, git's own merge engine, so the conflicted files it names are
the ones a real merge would hit. It can't predict hooks, which only run during
a real merge. `git_mf --help` lists the exit codes, and
[`git_mf.test.ts`](bin/git_mf.test.ts) checks each scenario's dry run against
its real run.

### AI agent skills

Public skills are distributed from Unique-Divine/jiyuu under `jiyuu/ai-skills`
and omit `metadata.private`. Private skills are real directories in
`boku/priv-skills` and require `metadata.private: true`.
`just skills-sync --run` makes `priv-skills` a flat union by linking public
skills into it, then links both `$HOME/.cursor/skills` and
`$HOME/.agents/skills` to that union. Claude Code keeps its own `synced/`
tree in `$HOME/.claude/skills`, so that directory stays real and sync links
each union skill into it as `$HOME/.claude/skills/<skill-name>`. Sync removes
stale links into the union and leaves other entries alone.

A private skill can set `metadata.gh-repo: Owner/repository` to export a copy
into a private team checkout. Sync uses `$REPO/<repository>` by default, or
the relative path in `metadata.repo-dir`, and writes the copy under
`ai-skills/<skill-name>`. It also maintains relative link
`.agents/skills -> ../ai-skills` for teammates. Sync creates a missing
repository copy but never overwrites an existing one, so the team copy can
diverge from the private skill. Divergence prints one JSONL warning on stderr
(event `team_skill_export_diverged`, with `changed`, `onlySource`, and
`onlyRepo` paths) and does not fail health checks. A missing copy in an
existing checkout fails health checks until `--run` creates it. Missing team
checkouts are skipped and do not fail health checks.

Sync rejects duplicate names and unexpected link targets. The first
conversion from legacy copied runtime directories requires
`just skills-sync --run --migrate`; it refuses directories whose skills do not
match the canonical union.

See the [Codex skills documentation](https://developers.openai.com/codex/concepts/customization#skills).

### Neovim Configuration

- Light/dark theme toggle (Catppuccin/OneDark)
- Treesitter with support for modern languages including Astro
- LSP with auto-installation of language servers
- Harpoon, Telescope, and other navigation enhancements

### Terminal Environment: tmux, zsh, bun

- Tmux with Dracula theme and plugin manager
- Zsh configured for Node.js, Rust, Go, and Python development
- Bun JavaScript/TypeScript runtime integration
- `tree-sitter-cli` support for Neovim parser installation on the `main` branch

### Herdr configuration

[`herdr-cfg/config.toml`](herdr-cfg/config.toml) is the managed configuration source.
`symlinks.sh` links only this file to `~/.config/herdr/config.toml`; Herdr's
sessions and logs remain runtime-owned and are never linked or versioned.
Like the existing dotfiles links, sync replaces the runtime config with this
managed source. Backup/preservation or force-mode policies are deferred.

The checked-in configuration starts from Herdr 0.8.0's annotated defaults and
is validated against the vendored v0.9.4 fork. It enables saved pane history
and conversation restoration, and preserves the local keybindings and layout
commands. Print the installed binary's defaults with command:

```bash
herdr --default-config
```

Directory [`herdr`](herdr) contains the vendored v0.9.4 fork source and local
changes. It has its own Cargo workspace and lockfile. Build and install it
with command `just herdr-install`; no Herdr submodule initialization is needed.
See [Herdr releases](herdr-release/README.md) for downloads and release tags.
See file [`herdr/UPSTREAM.md`](herdr/UPSTREAM.md) for provenance and upgrade
instructions, and file [`herdr-cfg/README.md`](herdr-cfg/README.md) for the
managed configuration and Codex scrolling settings.

### Codex config

[`codex/config.ts`](codex/config.ts) maintains portable defaults in
`$HOME/.codex/config.toml` while preserving local project and onboarding
state. Its `mcp_servers` table is the MCP source that [`mcp/`](mcp/README.md)
exports to the other tools. Run `bun run codex/config.ts` for its usage and
options.

### Claude Code config

Directory [`claude`](claude/README.md) manages Claude Code settings and MCP
servers. [`claude/config.ts`](claude/config.ts) merges owned keys, such as
empty commit and PR `attribution`, into `$HOME/.claude/settings.json`, and
adds the `rg` allow rule. [`claude/CLAUDE.md`](claude/CLAUDE.md) is linked to
`$HOME/.claude/CLAUDE.md` as global instructions.
[`claude/mcp.ts`](claude/mcp.ts) registers each Codex MCP server in Claude's
user scope. Stdio servers run through a launcher, so their secrets stay in
`$HOME/.codex/config.toml`.

### WSL Clipboard Integration

- A persistent Rust bridge that keeps one PowerShell clipboard process warm
- `pbcopy`, `pbpaste`, `wsl-pbcopy`, and `wsl-pbpaste` are symlinks to the one
  installed bridge binary; it dispatches by the command name
- Lossless UTF-8 text across the WSL/Windows boundary, including emoji and
  non-BMP Unicode; PowerShell performs the internal UTF-16 conversion
- `just sync` installs `~/.local/bin/wsl-clipboard` on WSL; its daemon starts
  only on the first copy or paste request
- `legacy-pbcopy` and `legacy-pbpaste` retain the old one-shot commands for
  diagnostics and performance comparison

#### xclip replacement

Linux tools that copy with `xclip` write to the X11 clipboard, which does not
reach Windows on WSL. `bin/xclip` replaces `xclip` with a Bun program
(`bin/xclip.ts`, linked as `bin/xclip`) that implements the xclip 0.13 command
line on top of `pbcopy` and `pbpaste`. Because `dotfiles/bin` comes before
`/usr/bin` on `PATH`, every program that runs `xclip` gets this one. The real
xclip doesn't need to be installed.

Known callers:

- **tuicr** copies reviews with `xclip -selection clipboard`, but only when
  `XDG_SESSION_TYPE=x11`. The `tuicr` alias in `zsh/aliases.sh` sets it.
  Without it, tuicr uses its built-in X11 clipboard, which doesn't reach
  Windows.
- **herdr** reads the clipboard with `xclip -selection clipboard -out` when
  you paste into its own text boxes, such as copy-mode search. Copying from
  herdr on WSL uses OSC 52, not `xclip`.

Behavior:

| Feature | Support |
|---|---|
| `-i`/`-in` (default) and `-o`/`-out` | Copy stdin or files; paste to stdout |
| `-selection` | All selections map to the one Windows clipboard |
| `-r`/`-rmlastnl`, `-f`/`-filter` | Same as xclip |
| `-t`/`-target` | Text targets only; `-o -t TARGETS` lists them |
| `-l`, `-d`, `-noutf8`, `-quiet`, `-silent` | Accepted and ignored |
| `-verbose`, `-help`, `-version` | Commentary, help, and version on stderr |
| Option abbreviations | Unique prefixes, as in xclip (`-sel`, `-verb`) |
| Image targets (`image/png`) | Rejected with exit code 1 |

Arguments that are not options are treated as input files, as in xclip, so an
unknown option fails with `xclip: -bogus: No such file or directory`. Run
`bun test bin/xclip.test.ts` to check the behavior. The tests record xclip
0.13's behavior and use stand-in clipboard commands, except for one round trip
through the real Windows clipboard.

#### Remote or SSH WSL

The clipboard daemon needs a PowerShell process that can reach the logged-in
Windows desktop clipboard. An ordinary interactive WSL terminal starts the
daemon lazily. An SSH-hosted WSL process can start PowerShell without receiving
desktop clipboard access.

Use command `wsl-clipboard health` to verify the running daemon. It reports
the daemon, clipboard, runtime, and Windows task state without reading or
writing clipboard contents. Command `wsl-clipboard health --quiet` emits no
normal output and exits nonzero when the daemon cannot use the clipboard.

When an SSH-hosted session reports an unavailable clipboard, keep the Windows
user logged in and run:

```bash
wsl-clipboard windows-task install
wsl-clipboard health
```

The command registers `wsl-clipboard-interactive-daemon` for that Windows user
at logon and starts it immediately. The task starts the daemon in the active
WSL distro with the same runtime directory, so SSH clients can use the daemon's
PowerShell process. Use command `wsl-clipboard windows-task status` to inspect
it, or command `wsl-clipboard windows-task remove` to stop and unregister it.

The task is never installed automatically. A logged-out Windows user has no
desktop clipboard for the task to access.

## Requirements

- Ubuntu 24.04 (or compatible) on WSL2
- [Neovim setup and version requirements](nvim/README.md)
- Zsh with Oh-My-Zsh
- Tmux
- Bun and Node.js
- Cargo/Rust tools
- [mise](mise/README.md) for pinned CLI tools, including `just`, Neovim and
  `tree-sitter`
- `lua5.1` and `luarocks` for Lazy/LuaRocks health checks
