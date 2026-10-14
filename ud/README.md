# ud

`ud` is a personal command router for development and workstation tasks. The
public command tree is written in Rust. Clap generates command and subcommand
help from the Rust definitions.

```bash
ud --help
ud go --help
ud nibi keys add-mnem --help
```

Run the checkout without installing it:

```bash
just ud --help
```

Generate Zsh completions from the same Clap command tree:

```bash
ud completions zsh
```

Install or refresh `~/.local/bin/ud`:

```bash
just ud-install
```

`just sync` also installs the current binary. `just health` checks that the
installed binary matches the current source fingerprint and that the generated
Zsh completion is present. `just sync` writes the completion function to
`${XDG_DATA_HOME:-$HOME/.local/share}/zsh/site-functions/_ud`.

## Shell operations

Rust owns argument parsing, validation, help, plugin discovery, and ordinary
process execution. File `zsh/ud/shell.sh` retains operations that depend on the
personal shell setup or WSL:

- personal shortcuts from `zsh/quick.sh`
- Docker Desktop and Docker Compose operations
- local Nibiru mnemonic import
- the pinned `nibid` installer pipeline

The shell file is internal. Run these operations through `ud`, which validates
the command before invoking the helper.

## Executable plugins

A plugin is an executable named `ud-<command>`. It may be a native binary or a
script with a valid shebang. The dispatcher searches
`${XDG_DATA_HOME:-$HOME/.local/share}/ud/plugins`, followed by the directories
in `UD_PLUGIN_PATH`. It does not search the current directory or general
`PATH`.

```bash
ud plugin list
ud plugin info evm
ud plugin doctor
ud evm --help
ud fs --help
```

Each plugin implements `--plugin-info` and prints JSON with `apiVersion`,
`name`, and `description`. API version 1 is the current contract. Rust validates
and caches this metadata without requiring `jq`.

### Public files

Install the plugin with `just fs-install`. Commands `just ud-install` and
`just sync` also install it. Run `just fs-test` to check publishing, listing
formats, naming, configuration, and real `ud` dispatch without cloud writes.

```bash
ud fs publish ./screenshot.png ui/trade-modal --md
ud fs publish ./capture trade-modal.png --date 2026-10-13 --dry-run
ud fs ls
ud fs ls --all
ud fs ls --time 26-09
ud fs ls 26/ui/ --urls | fzf
ud fs ls 26 --json
```

Publishing uploads through `gcloud` and returns a public URL. Names can include
semantic directories: `ui/trade-modal.png` becomes
`26/ui/261013-trade-modal.png` for October 13, 2026. The date comes from
`pbpaste-img` filenames or the Bangkok publication date; `--date` overrides it.
An explicit extension overrides the source extension without converting the
file. Flag `--md` emits an HTML image tag for supported raster images or a
Markdown link for other files, including SVG. Successful output is copied to
the clipboard when supported; `--no-clipboard` disables that step.

Bare `ls` selects the current Bangkok calendar month; `--all` includes the
whole collection. A positional directory recursively includes all dates beneath
it, with an optional trailing slash. Flag `--time` narrows the selection. Each call fetches fresh GCS metadata through
the
existing Google login and follows all pages before emitting output. It sorts
by key and defaults to TOON with `url`, `size`, and `contentType`.
Use mutually exclusive `--json`, `--urls`, or `--paths` for other formats.
Listing does not download file contents. Local caching and tab completion
remain follow-ups. Bare `ud fs` shows help; use `publish` explicitly to upload.

Time selectors accept `26` for 2026, `2609` or `26-09` for September,
and `261014` or `26-10-14` for October 14. Two-digit years mean 2000–2099.
Flag `--time` cannot be combined with `--all`. Filters use filename publication
dates, including older flat and `YY/MM-DD-*` layouts, rather than modification
times. Undated files appear only in unfiltered directory or `--all` listings.
The filter changes output size; listing still fetches all metadata under the
selected directory or root. Publishing name validation is unchanged.

Settings live in `~/.config/ud/fs/config.json`, respecting `XDG_CONFIG_HOME`.
Variables `UD_FS_BASE_URL` and `UD_FS_BUCKET` override settings; the previous
`pub` config and `PUB_*` variables remain fallbacks. The standalone managed
`pub` command is removed during installation. The
[operations guide](/home/realu/ki/gh-io-ud/docs/file-hosting.md) describes storage,
deployment, and recovery.

## Local health checks

```bash
ud health gpg
ud health gpg --fix
```

The GPG command delegates to `bin/gpg-agent-doctor`. Diagnosis does not read the
password store. The explicit `--fix` flag restarts the agent and clears cached
passphrases.

## Symbolic links

Command `ud q symlink <src> <dst>` creates the destination parent and then
creates or replaces the symbolic link. Relative source paths remain relative
to the destination link.

```bash
ud q symlink ../ai-skills .agents/skills
```
