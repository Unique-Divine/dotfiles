# Releasing herdr-tmux

The Cargo crate and Herdr plugin share a version. The crate is published on
crates.io as `herdr-tmux`; owner `Unique-Divine` owns the existing 0.0.1 release.
The plugin ID is `unique-divine.herdr-tmux`.

## Prepare

1. Set the same version in `Cargo.toml` and `herdr-plugin.toml`, regenerate the
   lockfile, and update the changelog and installation examples.
2. Run `just release-check` from this directory on committed changes. Linux and
   macOS CI must pass before release. The manifest version test catches drift.
3. Check the package file list with `cargo package --list --locked`. It must
   include the plugin manifest, source, license, docs, lockfile, and fixtures.
4. Confirm ownership with `cargo owner --list herdr-tmux`. Configure a publishing
   credential for that owner through `cargo login` or your credential provider.
   A successful dry run does not prove that publishing credentials are valid.

## Live plugin smoke check

Use a fresh named session, not a production workspace. Start it with
`herdr --session <test-name> server` and attach a client to that session.
Build with `just build` and link this directory with `herdr plugin link`.
Plugin registration is shared across sessions, so do not replace someone else's
installation. Inspect `herdr plugin list --json` before changing registration.

Create two test panes. Report test agents with `pane report-agent`, then invoke
the four actions with `herdr plugin action invoke unique-divine.herdr-tmux.<id>`.
Verify agent and pane selection, Escape cancellation, and both layout directions.
Run layouts sequentially; concurrent layout requests intentionally fail busy.
Check action results with `herdr plugin log list --plugin unique-divine.herdr-tmux`.
Stop and delete only the named session created for the test.

For the Cargo route, install the packaged crate into a temporary Cargo root,
then run `plugin register` using a temporary `XDG_DATA_HOME`. Confirm registration
works twice and refuses to replace an existing registration at another root.
Unlink the temporary registration before deleting its files.

## Publish

After reviewing the branch and green CI, merge it and create the release tag:

```bash
git tag -a herdr-tmux/v0.1.0 -m "herdr-tmux 0.1.0"
git push origin herdr-tmux/v0.1.0
cargo publish --locked
```

Run these commands only as part of an explicitly authorized release. Each Cargo
version is immutable; fix a published release by incrementing the version.
After publication, verify Cargo installation and the pinned GitHub plugin
installation in fresh directories. The manifest's build command must complete
without changing the manifest.

Add topic `herdr-plugin` to the public GitHub repository for marketplace
discovery. The manifest must be on the default branch. Cargo publication alone
does not list a plugin in Herdr's marketplace.
