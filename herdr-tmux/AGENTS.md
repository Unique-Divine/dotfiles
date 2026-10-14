# herdr-tmux working guide

Use the published GitHub plugin for daily use to exercise the same installation
route as external users. Keep this directory as the development checkout.
Do not switch the live registration unless the user requests it.

## Registration and bindings

Plugin `unique-divine.herdr-tmux` provides four actions: `even-vertical`,
`even-horizontal`, `focus-pane`, and `focus-agent`. The managed bindings in
`../herdr-cfg/config.toml` invoke these plugin action IDs, so they work with
either a published installation or a local link without changes.

Only one installation can own this plugin ID in a given Herdr configuration.
Inspect `herdr plugin list --json` before switching. Remove the existing
registration explicitly, using `plugin unlink` for a local link or
`plugin uninstall` for a GitHub installation.

Both installation routes build from source and require Rust and Cargo.
Plugin installation requires Herdr 0.9.5 or later and supports Linux and macOS.

## Use the published plugin

To switch from a local link to release 0.1.0:

```sh
herdr plugin unlink unique-divine.herdr-tmux
herdr plugin install Unique-Divine/dotfiles/herdr-tmux --ref herdr-tmux/v0.1.0
```

Herdr downloads a managed checkout, builds it with locked dependencies, and
registers its actions. Changes in this development checkout do not affect that
installation. Update the pinned ref when intentionally adopting another
release. Release tags use the convention `herdr-tmux/vX.Y.Z`.

## Use the local checkout

To switch from a GitHub installation to local development:

```sh
herdr plugin uninstall unique-divine.herdr-tmux
cd "$DOTFILES/herdr-tmux"
just plugin-link
```

Run recipes from this directory. Recipe `plugin-link` builds the release binary
at `target/release/herdr-tmux` and links this source directory into Herdr.
It does not install the standalone CLI into `PATH`. Command `herdr plugin link`
alone does not build the binary.

After Rust changes, run `just build`. After manifest changes, run
`just plugin-link` to rebuild and refresh registration. Return to the published
installation with the commands above when development testing is finished.

Recipe `just install` separately installs the standalone CLI under
`~/.local/bin`; the local plugin uses the binary in this checkout instead.
Command `herdr-tmux plugin register` is for Cargo installations and generates
a manifest pointing to the installed executable. It refuses to replace a
registration belonging to another installation.

## Verification

Use the nearest `justfile`: `just test`, `just lint`, and `just build`.
Before release, run `just release-check` on committed changes. See
`RELEASING.md` for publication and smoke-check instructions.

For simultaneous published and development testing, use an isolated Herdr
configuration and a fresh named test session. Registrations are shared across
sessions using the same configuration, so a separate session alone does not
protect the daily installation. Preserve the live registration and remove
test registrations and sessions after verification.

Before inspecting or controlling a live Herdr session, verify `HERDR_ENV=1`
and consult the Herdr skill. Use test panes for popup selection, cancellation,
and layout checks.

Issues #59 and #60 track user configuration and configurable styling.
Issue #24 remains open for broader plugin distribution requirements,
including prebuilt installation.
