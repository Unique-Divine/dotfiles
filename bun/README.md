# Managed Bun Tools

The global package manifest and lockfile live in `global/`. Command
`just bun-sync` installs the locked packages, exposes their executables, and
links Bun's global package directory to this directory. Command `just sync`
runs the same operation. Generated `node_modules` stays out of Git.

Sync and `just bun-health` act on `$DOTFILES/bun`, the checkout that
`symlinks.sh` also links from, whichever checkout runs them. From another
checkout, such as a PR worktree, `just bun-sync` refuses to run, because the
global tools would follow a directory that `git worktree remove` deletes. Pass
`--allow-other-checkout` to `bun --no-install bun/sync.ts --run` to sync
`$DOTFILES` from there anyway. `just bun-add`, `just bun-drop`,
`just bun-lock`, and `just bun-activate-mdtoc` edit the manifest of the
checkout they run in.

The first migration preserves the previous global installation in a sibling
directory named `global.before-dotfiles-<timestamp>`. It installs and checks
the replacement before switching the directory link. A failed switch restores
the previous directory and executable links.

## Change the Tool List

Add or remove tools with these recipes from dotfiles:

```sh
just bun-add package-name@1.2.3
just bun-drop package-name
git diff -- bun/global/package.json bun/global/bun.lock
just bun-sync
just bun-health
```

`just bun-add` checks that the exact release exists on the registry, pins it
in `global/package.json`, and refreshes `global/bun.lock`. `just bun-drop`
removes a package and refreshes the lock. If the lock refresh fails, both
recipes restore both files.

Never run `bun add -g` or `bun remove -g`, and agents must never run them.
Bun's global directory is this tracked directory, so those commands write
into Git: `bun add -g` records a range such as `^2.21.2`, or the absolute path
of a local tarball, and `just sync` then fails. To try a package without
adopting it, install it under a throwaway `BUN_INSTALL="$(mktemp -d)"`.

Every dependency in `global/package.json` must be an exact version. Sync,
health, `just bun-lock`, and the tests reject ranges, tags, and `file:`,
`link:`, absolute, relative, and tarball paths. `just bun-policy` runs that
check offline against the committed files, and CI runs it too.

Each problem names the package and one command to fix it:

```text
@nibiruchain/nibiru: "^2.21.2" is not an exact version; run just bun-add @nibiruchain/nibiru@2.21.2
@uniquedivine/tg-sai: "/home/me/uniquedivine-tg-sai-0.3.2.tgz" is a path on this machine, not a registry release; run git checkout -- bun/global
fixture-helper: package.json has 2.0.0, bun.lock has 1.0.0; run just bun-add fixture-helper@2.0.0
```

Sync uses the committed lock without updating dependency versions. After a
hand edit of the manifest, run `just bun-lock`. Removing a package removes its
previously managed executable links during sync. An executable replaced by a
user-managed file or unrelated link is preserved.

## Install and Repair

```sh
just bun-sync
just bun-health
```

Healthy sync uses local inspection and does not query npm. Repairs install
from the lock and may need network access when packages are absent from Bun's
cache. Health never installs packages or starts MCP servers. It checks root
package versions, locked transitive versions and required dependencies,
executable files and links, command resolution on `PATH`, and registered
`ud` plugins. For `ud-mdtoc`, it also checks plugin metadata and actual
Markdown output with runtime package auto-install disabled.

An executable earlier on `PATH` can override a valid Bun installation. Health
reports the resolved path and expected Bun binary directory. Sync refuses to
overwrite unrelated executables or plugin links.

The manager follows `BUN_INSTALL`, `BUN_INSTALL_GLOBAL_DIR`, and
`BUN_INSTALL_BIN`. It reads global directory settings from the global
`.bunfig.toml`, including the XDG configuration location, and uses
`XDG_DATA_HOME` for `ud` plugin registration. Bun's global configuration rules
are documented in [Bun's configuration reference](https://bun.sh/docs/runtime/bunfig).

## MCP Servers From Jiyuu

Bun sync no longer links `mcp-discord` to a Jiyuu checkout. The Discord,
Slack, and Telegram MCP servers run as pinned registry releases through
`bunx` and `uvx`; see [Jiyuu Pins](../mcp/README.md#jiyuu-pins). Sync leaves an
existing `mcp-discord` link from an earlier sync in place and stops managing
it.

## Update `ud-mdtoc` After Publication

The manifest pins the published `ud-mdtoc` release. After publishing another
version from `jiyuu/mdtoc` with its validated `just publish` recipe, run these
commands with that version:

```sh
cd "$DOTFILES"
just bun-activate-mdtoc 0.1.0
just bun-sync
just bun-health
ud-mdtoc --version
ud plugin info mdtoc
```

Activation verifies the exact npm release and its executable declaration before
changing the manifest and refreshing the lock. Sync installs `ud-mdtoc` and
registers `ud mdtoc` through the normal XDG plugin directory. Neovim's `:Toc`
and `:TocCopy` use the installed executable.

## Adoption Exceptions

The initial manifest retains installed registry versions, including
`@uniquedivine/tg-sai@0.0.5`. Moving its old local tarball reference to the same
published version avoids an unrelated upgrade. Other tools can be removed
from the manifest later.

Claude Code uses its native installation. Its obsolete npm dependency is
excluded. Only the known old npm Claude executable link is removed; an
unexpected competing command causes a diagnostic. Fresh-machine native
installation is handled by `just claude-install`.

The existing Yarn global manifest is unchanged. Independently linked commands
absent from Bun's package manifest remain outside this managed list. During
migration, links that traverse the previous global directory are retargeted to
their existing local source or retained package backup so they keep working.
Keep that backup until those tools have been deliberately adopted or removed.

## Tests

```sh
bun test ./bun/sync.test.ts
bun test ./claude/native.test.ts ./tests/mdtoc.test.ts
```

The tests serve packed fixture packages from a local npm registry and use
temporary global installations with their own Bun cache. They don't change the workstation's live global installation.

The Neovim test runs when `nvim` and `ud-mdtoc` are installed. To test an
isolated package installation instead, set `MDTOC_TEST_COMMAND` to its
`ud-mdtoc` executable path.
