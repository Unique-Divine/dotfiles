# Release herdr-tmux

The Cargo crate and Herdr plugin share a version. The crate name on crates.io
is `herdr-tmux`, and the plugin ID is `unique-divine.herdr-tmux`.

## Prepare

1. Set the same version in `Cargo.toml` and `herdr-plugin.toml`, update the
   `Cargo.lock` entry for `herdr-tmux`, and update the changelog and
   installation examples.
2. Run `just release-check` from this directory on committed changes. Use
   `cargo package --list --locked` to confirm the package includes the
   plugin manifest, source, license, docs, lockfile, and fixtures.
3. In the PR, wait for the **CI result** check. The **tmux-release-build** job
   builds native binaries for all four targets, validates their versions,
   and uploads the assembled bundle for inspection.

## Publish to GitHub

After merging, check that `origin/main` includes the intended release
commit. Tag that commit and push the annotated tag when authorized to
publish.

```bash
git tag -a herdr-tmux/v0.2.0 <merged-commit> -m "herdr-tmux 0.2.0"
git push origin herdr-tmux/v0.2.0
```

The tag rebuilds the archives in the [release workflow](../.github/workflows/herdr-tmux-release.yml).
The workflow requires the tagged commit to be on `main` and the tag,
crate, and plugin versions to match. It signs build provenance for the
archives and records the source commit in the release notes. It checks
the live tag immediately before creating the draft and again after
comparing the uploaded asset digests, just before publication. The
release does not replace the repository's latest release for other tools.

A release contains four `herdr-tmux-vX.Y.Z-<target>.tar.gz` archives, each with
one executable named `herdr-tmux`, and a `SHA256SUMS` file.

- Linux x86-64 and ARM64 use targets `x86_64-unknown-linux-musl` and
  `aarch64-unknown-linux-musl`.
- macOS Intel and Apple Silicon use targets `x86_64-apple-darwin` and
  `aarch64-apple-darwin`.

If publication fails after upload, rerun the failed job to reuse its
release bundle. The job resumes a draft only when its tag, source note,
asset names, and digests all match the bundle. If an interrupted upload
leaves a partial draft, review and remove only that draft before rerunning.
The workflow never overwrites existing assets. Publish a new version to
change published assets.

## Verify the Published Release

Follow the [prebuilt installation instructions](README.md#prebuilt-release)
in a clean directory. Verify the checksum and GitHub attestation, then
verify the extracted binary's version.
To check the exact commit in the release notes as well, pass its full SHA
to the attestation verification command's `--source-digest` option.

Use a fresh named Herdr session with an isolated configuration and data
directory. Plugin registration is shared by sessions that use the same
configuration. Run `herdr-tmux plugin register` and check
`herdr plugin list --json`. The generated manifest should point at the
installed binary and have no build command.

In the test session, create two panes and report test agents with
`herdr pane report-agent`. Invoke the plugin actions with
`herdr plugin action invoke unique-divine.herdr-tmux.<id>`. Test digit
and Enter selection, Escape cancellation, and both layout directions. Run
layouts sequentially. Stop and delete the test session after verification.

## Publish the Cargo Crate

Cargo publication is separate from the GitHub release workflow. To publish
when authorized, check the version and owner with
`cargo info herdr-tmux` and `cargo owner --list herdr-tmux`. Configure a
crates.io publishing credential, then run `cargo publish --locked` from the
tagged source. A successful dry run checks the package without validating
publishing credentials. Verify the pinned Cargo installation afterward.

For Herdr marketplace discovery, the manifest must be on the default branch
and the repository must have the `herdr-plugin` topic.
