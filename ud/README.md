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
- local Nibiru mnemonic import, which reads the mnemonic on stdin
- the published `nibiru` installer through Bun

The shell file is internal. Run these operations through `ud`, which validates
the command before invoking the helper.

Pipe the mnemonic in with `--stdin`. `ud` passes it to the helper and on to
`nibiru keys add --recover` on stdin, never as a command argument.

```bash
pass show path/to/mnemonic | ud nibi keys add-mnem --name alice --stdin
```

## Executable plugins

Plugins let private or independently maintained commands keep their own
source and installation lifecycle. Built-in commands such as `fs` ship with
`ud` and need no plugin discovery.

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
```

Each plugin implements `--plugin-info` and prints JSON with `apiVersion`,
`name`, and `description`. API version 1 is the current contract. Rust validates
and caches this metadata without requiring `jq`.

## Public Files

Public-file commands are built into the Rust `ud` binary. Install or refresh
with `just ud-install`; `just sync` does the same. The compatibility recipe
`just fs-install` also installs `ud`. No separate plugin or Python runtime is
needed. Installation removes the old publisher symlink only when it belongs
to this checkout, and refuses an unrelated `ud-fs` plugin.

Run `just fs-test` to check publishing, the index, listing formats, naming,
configuration, and compiled CLI behavior without cloud writes.

```bash
ud fs publish ./chart.png fee-split --tag sai,fees --desc "Fee **split** after the reset" --md
ud fs publish ./capture trade-modal.png --date 2026-10-13 --dry-run
ud fs search fee --tag sai --time 26-11
ud fs search --tag fee-review-nov --urls | fzf
ud fs tag https://uniquedivine.com/f/26-11/261108-fee-split.png --add postmortem
ud fs desc 26-11/261108-fee-split.png - < notes.md
ud fs tags
ud fs log
ud fs refs 26-11/261108-fee-split.png
ud fs rm --tag fee-review-nov          # preview
ud fs rm --tag fee-review-nov --yes    # delete
ud fs ls --time 26-09
```

### Paths

Publishing uploads through `gcloud` and returns a public URL at
`YY-MM/YYMMDD-name.ext`: `trade-modal.png` published on November 8, 2026
becomes `26-11/261108-trade-modal.png`. Names can't contain folders; group
files with tags instead. The date comes from `pbpaste-img` filenames or the
Bangkok publication date; `--date` overrides it. An explicit extension
overrides the source extension without converting the file. Flag `--md` emits
an HTML image tag for supported raster images or a Markdown link for other
files, including SVG. Successful output is copied to the clipboard when
supported; `--no-clipboard` disables that step.

If the name exists, publishing tries `name-2` through `name-9` and reports the
name it used on stderr. Every attempt uploads with an absent-object
precondition, so nothing is overwritten. Flag `--replace` overwrites the object
at the same URL instead, purges the Firebase Hosting CDN with a release of a
clone of the live version, and verifies that the public URL serves the new
MD5. With `--dry-run`, `--replace` signs in and reports whether the target
exists.

Older `26/…`, `YY/MM-DD-*`, and flat keys stay where they are and keep serving.

### Index

Tags, descriptions, and search use a SQLite database, `fs.db`, in the private
versioned bucket `ud-fs-meta-876932632137`. It can't live in the public
bucket because the file server serves any key there. Reads download it to
`~/.cache/ud/fs/fs-<generation>.db` when its GCS generation changes; a copy
without a SQLite header is downloaded again. Writes work on a temp copy and
upload with an `ifGenerationMatch` precondition. If another machine wrote
first, the command reloads and retries up to six times with jittered backoff.
A write that changes nothing uploads nothing. Triggers write every add, tag, untag,
describe, delete, and restore to a change log that `ud fs log` prints.

- `publish --tag a,b --desc TEXT` records the file as soon as the upload
  lands, before the public check, and a retry with the same bytes reuses that
  name instead of numbering a duplicate. Unknown tags fail before upload and
  list similar existing tags; pass `--new-tag` to create one. `--dry-run`
  never signs in, so it skips the tag and collision checks. If the index write
  fails, the upload still counts (exit 0) and stderr prints the commands that
  finish it. Publishing over a deleted key starts with no tags or
  description.
- Descriptions are Markdown strings up to 16 KiB, stored and returned
  verbatim. JSON output keeps them unchanged; TOON escapes newlines.
  `desc KEY -` reads stdin and drops only its final newline.
- `tag`, `desc`, `refs`, and `rm` accept object keys, `/f/KEY` paths, or
  `http(s)` `/f/` URLs from any origin.
- `tags` lists every tag with its live file count; `tags --prune` removes tags
  that no live file carries.
- `search` matches every word against the slug, description, source directory,
  and tags with an FTS5 trigram index, so parts of words match. Words of one or
  two characters fall back to substring checks. Results rank by BM25 when there
  is text, otherwise newest first. `--tag` (all must match), `--time`, and
  `--deleted` filter; output formats match `ls` plus `tags` and `description`.
- `refs` runs `rg` over text files under `~/ki` for each `/f/KEY` path. Set
  `ref_roots` in `config.json` or colon-separated `UD_FS_REF_ROOTS` to change
  the roots.
- `rm KEY…` or `rm --tag T` (not both) previews each file with its tags and
  backlinks; keys must be live in the index.
  Only `--yes` deletes, then marks the rows deleted. CDN copies can serve for
  five minutes; soft delete allows `gcloud storage restore` for seven days.
- `index sync` adds bucket objects the index lacks and marks vanished ones
  deleted. Keys changed after its listing started (minus two minutes for
  clock skew) are left alone, so a concurrent publish or `rm` wins. Run it
  after uploading outside `ud fs`.

Topic tags (`sai`, `postmortem`) and group tags (`fee-review-nov`) use the same
table. A group tag marks files that may be deleted together.

### Listing

Bare `ls` selects the current Bangkok calendar month; `--all` includes the
whole collection. A positional directory such as `26-11/` recursively includes
all dates beneath it, with an optional trailing slash. Flag `--time` narrows
the selection. `ls` reads the public bucket directly, not the index. Each call
fetches fresh GCS metadata through the existing Google login and follows all
pages before emitting output. It sorts by key and defaults to TOON with `url`,
`size`, and `contentType`. Use mutually exclusive `--json`, `--urls`, or
`--paths` for other formats. Listing does not download file contents. Bare
`ud fs` shows help; use `publish` explicitly to upload.

Time selectors accept `26` for 2026, `2609` or `26-09` for September,
and `261014` or `26-10-14` for October 14. Two-digit years mean 2000–2099.
Flag `--time` cannot be combined with `--all`. Filters use filename
publication dates across the `YY-MM/`, `YY/`, `YY/MM-DD-*`, and flat layouts,
rather than modification times. Undated files appear only in unfiltered
directory or `--all` listings.

### Settings

Settings live in `~/.config/ud/fs/config.json`, respecting `XDG_CONFIG_HOME`.
Variables `UD_FS_BASE_URL`, `UD_FS_BUCKET`, `UD_FS_META_BUCKET`, and
`UD_FS_REF_ROOTS` override settings; the previous `pub` config and `PUB_*`
variables remain fallbacks. `UD_FS_INDEX_DIR` replaces the meta bucket with a
local directory, which tests use. The
[operations guide](/home/realu/ki/gh-io-ud/docs/file-hosting.md) describes
storage, deployment, and recovery.

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

## Rust tests

CLI integration tests live beside the entry point in `src/main_test.rs`.
Cargo registers this file explicitly as the `ud_cli` test target, so it still
runs the compiled executable and is included in `cargo test --workspace`.
File-command unit tests live in neighboring `fs/fs_test.rs` under `#[cfg(test)]`.
Test comments explain the compatibility rule or failure each fixture protects.
