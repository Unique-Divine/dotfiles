# Vendored Herdr source

This directory vendors Herdr v0.9.3 at upstream commit
`7b116c05bfda646af39d2524c54e70c751f57ee8` from
<https://github.com/herdrdev/herdr>. It is part of the dotfiles repository,
not a Git submodule.

The previous snapshot came from fork commit
`5f6e4b222d32225e5c77a190064c61ff9549e6a0`, based on upstream commit
`6c6ddcd49384d6ea9f0ee2e63bf7b2643dfd5bcf`.

## Local changes

- The keybinding range `prefix+0..8` selects tabs starting at zero. Generated
  labels in the tab bar, mobile UI, navigator, keybinding help, and tab-creation
  dialogs use that display base. Tab names beginning with one ASCII digit use
  their current position as the prefix and keep the remaining text exactly.
  Closing or moving tabs updates these labels, including names such as
  `3-nibi-web`. Stored custom names and stable public API IDs stay unchanged.
  API labels use one-based positions; the client applies its configured base.
  Multi-digit prefixes such as `2026-notes` stay unchanged, as do names
  beginning with whitespace, a sign, or non-ASCII digits. The client snapshot
  retains original custom names so each client can apply its display base.
- Codex managed starts and restores pass `--no-daemon` so session hooks use
  the launching pane's environment. The Zsh wrapper covers manual launches
  inside Herdr. The shared daemon can otherwise report another pane's session.
- The local `justfile` omits upstream installer and release-workflow tests,
  whose packaging and CI files are excluded. The manifest-check tests use the
  exact v0.9.3 published Grok manifest saved as a test fixture.
- The SIGWINCH integration test checks the platform's startup color query;
  WSL deliberately omits ANSI palette queries.
- The local `CLAUDE.md` convention is retained.

The tree keeps the Rust application, workspace crates, tests, embedded assets,
API schema, draft documentation, maintenance tools, and vendored terminal
libraries. It excludes the Astro website, release CI, distribution installers,
non-Windows packaging, Nix files, preview and published website docs, and the
plugin-worker app.
The embedded Windows installer and release metadata remain under `distribution/`
because the application and its tests compile them into the binary. The local
`rustfmt.toml` keeps upstream formatting instead of inheriting dotfiles settings.
Building v0.9.3 requires Zig 0.16.0.

## Updating

Clone upstream separately. Compare its desired tag, the recorded upstream
commit, and this tree with a three-way merge. Port local behavior to renamed
modules rather than restoring old modules. Keep the exclusions above, and run
`just ci`, `just docs-contract-test`, and the local restart smoke test before
installing with `just herdr-install` from the dotfiles root. Do not run
`herdr update`, which installs an upstream binary without the local changes.

Run tests outside inherited Herdr caller context, particularly
`HERDR_STARTUP_CWD`, which otherwise creates an unexpected initial workspace
in upstream integration tests. For example:

```bash
env -u HERDR_ENV -u HERDR_SOCKET_PATH -u HERDR_CLIENT_SOCKET_PATH \
  -u HERDR_SESSION -u HERDR_STARTUP_CWD -u HERDR_PANE_ID \
  -u HERDR_TAB_ID -u HERDR_WORKSPACE_ID NEXTEST_TEST_THREADS=4 just ci
```

## Fork releases

The fork package is version 0.9.6; the recorded upstream base stays v0.9.3.
Dotfiles owns release builds and downloads.
See [Herdr releases](../herdr-release/README.md) for commands and checks.
Windows packaging metadata and license notices are retained for release ZIPs.
