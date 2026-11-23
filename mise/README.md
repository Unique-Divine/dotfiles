# mise: pinned CLI tools

`config.toml` pins CLI tools that install from upstream release binaries, and
`mise.lock` records each version's download URL and checksum for
linux-arm64, linux-x64 and macos-arm64. `just sync` links this directory to
`~/.config/mise` and runs `just mise-install`.

`just mise-install` installs a pinned mise to `~/.local/bin/mise` if it is
missing, then runs `mise install --locked`. Tools run through
`~/.local/share/mise/shims`, which `zsh/zshenv` puts first on PATH, so
agents and non-interactive shells see the same binaries as an interactive
shell. bash and sh never read `zshenv`, and long-running agents keep the PATH
they started with, so `bun mise/links.ts --run` also links each active shim into
`~/.local/bin`, which almost every PATH includes. It never replaces a real
file there. Both linking and health checks use `mise bin-paths --json` to
identify commands provided by the active configuration. The shared shims
directory can also contain commands from installed but inactive tools, such
as Node or uv. Those commands do not become managed just because their shims
exist. Existing standalone binaries and dotfiles links remain intact.
Previously managed links for inactive commands are removed, while the mise
installations and shims remain available for project-specific use. Discovery
errors stop linking before it changes any files.

`just health` fails when a pinned tool is missing, at the wrong
version, or shadowed by another copy on PATH.

## Bun only, no Node

These dotfiles install no Node.js or npm. Bun runs JavaScript, installs
packages, and owns the global JavaScript tools in `bun/global/package.json`,
including Neovim's JavaScript language servers. `bin/node` runs Bun, `bin/npx`
runs `bunx`, and `bin/npm` exits 1 with the Bun equivalent of the command.
Registry commands that need real npm run it through Bun:
`bunx npm@12.2.0 publish`.

Do not install Node with mise. mise creates `npm`, `npx`, and `corepack`
shims for an installed Node even when it is inactive, and those shims fail
because nothing later on PATH provides them. `bun mise/dead-shims.ts --check`,
part of `just health`, reports such shims. Fix one with
`mise uninstall <tool>@<version> && mise reshim`.

## Add or bump a tool

```bash
mise use -g ripgrep@15.2.0      # edits config.toml in this directory
mise lock --platform linux-arm64,linux-x64,macos-arm64
just mise-install
```

Check the backend first with `mise tool <name>`. Prefer `aqua:` backends,
which verify checksums; avoid `asdf:` plugins, which run shell scripts.

## Mori

Jiyuu publishes the `mori` CLI in releases tagged `mori/v*`. Keep the MCP
server key `mori-graph` in Codex and Claude. From a trusted directory, run
`mise which mori` and use the printed path in each MCP registration and
Claude hook. A mise shim can fail to start in a project with an untrusted
`mise.toml`.

The 0.14.2 rollout uses `~/.cache/mori-0142/cache` and
`~/.cache/mori-0142/runtime`. Set `CBM_CACHE_DIR` and `CBM_RUNTIME_DIR`
to those paths for CLI queries against the same graph. After checking MCP,
hooks, and watcher links, create `~/.cache/mori-0142/accepted` to enable
scheduled indexing against those directories. Reindexing uses each client's
saved targets. If `index_status` reports `stale`, rerun the link command
with the client's saved targets.

For future upgrades, bump the version, refresh the four platform locks for
Mori, and run `just mise-install`. Update the absolute executable path in
the MCP registrations and hooks.

### Recover an Existing Mori Setup

From the dotfiles checkout, with its mise configuration linked, install the
locked prebuilt Mori release and reconcile existing MCP registrations.

```bash
mise install --locked github:Unique-Divine/jiyuu
mori_bin="$(mise which mori)"
"$mori_bin" --version
just mcp-sync --run
```

Repeating these commands reuses the installed release. The MCP sync fills
missing client entries from an existing registration and preserves differences
between configured clients. It leaves existing hook commands, hook trust, and
the graph cache in place. To check projects from an older registration, use
its executable, cache, and runtime together. For a client already on 0.14.2,
use the installed binary and the 0.14.2 state paths.

```bash
CBM_CACHE_DIR="$HOME/.cache/mori-0142/cache" \
  CBM_RUNTIME_DIR="$HOME/.cache/mori-0142/runtime" \
  "$mori_bin" cli list_projects --format json
```

On a fresh machine, register `mori-graph` in one client before running MCP sync.
Add hooks and approve them in each client that requires trust. Create the
first project indexes and any cross-repository links against the selected
cache.

Run `just mori-recovery-smoke` to check the interruption point after the
release installs and before registering a client. The probe downloads the
locked archive into a temporary home, reruns recovery before registration,
then checks two runs with an existing graph, hooks, and trust entries.
It uses Python 3.11+, mise, and the installed Bun and Claude CLI. Run
`bun install --frozen-lockfile` in the dotfiles checkout first.

[Release installation and rollback](https://github.com/Unique-Divine/jiyuu/blob/main/mori/README.md#install)

## Fresh machine

`just` itself comes from mise, so bootstrap before running `just sync`:

```bash
cd "$DOTFILES"
curl -fsSL https://mise.run | MISE_VERSION=v2026.11.5 sh
mkdir -p ~/.config && ln -sfn "$PWD/mise" ~/.config/mise   # just sync manages this link later
~/.local/bin/mise install --locked
```

mise downloads from GitHub. It uses the `gh` login for API requests when one
exists; without it, anonymous requests are limited to 60 per hour.
