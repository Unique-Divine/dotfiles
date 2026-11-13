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

## Add or bump a tool

```bash
mise use -g ripgrep@15.2.0      # edits config.toml in this directory
mise lock --platform linux-arm64,linux-x64,macos-arm64
just mise-install
```

Check the backend first with `mise tool <name>`. Prefer `aqua:` backends,
which verify checksums; avoid `asdf:` plugins, which run shell scripts.

## Fresh machine

`just` itself comes from mise, so bootstrap before running `just sync`:

```bash
cd ~/ki/boku/dotfiles
curl -fsSL https://mise.run | MISE_VERSION=v2026.11.5 sh
mkdir -p ~/.config && ln -sfn "$PWD/mise" ~/.config/mise   # just sync manages this link later
~/.local/bin/mise install --locked
```

mise downloads from GitHub. It uses the `gh` login for API requests when one
exists; without it, anonymous requests are limited to 60 per hour.
