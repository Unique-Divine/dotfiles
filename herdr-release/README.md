# Herdr fork releases

Run these commands from the dotfiles root. Fork version 0.9.7 is based on
upstream v0.9.3.

Version 0.9.7 makes rename suggestions match the displayed tab number in both
keyboard and context-menu dialogs. Saving an unchanged suggestion preserves
the stored name. See [issue #72](https://github.com/Unique-Divine/dotfiles/issues/72).

Version 0.9.6 renumbers tab names beginning with one ASCII digit when tabs
close or move. It preserves suffixes and stable tab IDs. Multi-digit prefixes
such as `2026-notes` stay unchanged.

Version 0.9.5 fixes zero-based name suggestions in the keyboard and context-menu
tab-creation dialogs. See [issue #57](https://github.com/Unique-Divine/dotfiles/issues/57).

## Install or download

```bash
just herdr-install                     # Build and install source
just herdr-install --ver source        # Explicit source installation
just herdr-install --get 0.9.7         # Cache a runnable release; print its path
just herdr-install --ver 0.9.7         # Install a verified release
```

Release commands accept `0.9.7`, `v0.9.7`, or `herdr-ud/v0.9.7`. They require
Bun and dependencies from `bun install`. Configured GitHub CLI authentication
is used when available. Public releases also support downloads without login.
Private repository access requires GitHub CLI and `gh auth login`. Cargo and
Zig are unnecessary for downloads.
Source installation requires Cargo and Zig 0.16.0. Set environment variable
`ZIG` to its executable if discovery cannot find that version.
No arguments selects source installation, including calls from `just sync`.

Downloads support Linux, WSL, and macOS on x86_64 and ARM64. Cached releases
live in `${XDG_CACHE_HOME:-$HOME/.cache}/herdr-ud/VERSION/ASSET/`.
Each entry contains the executable, metadata, and checksum manifest.
Repeated downloads check hashes before reuse; damaged entries are downloaded
again. Delete a version directory to reclaim disk space.

Installation checks the executable version and atomically replaces
`~/.local/bin/herdr`. Failed checks leave the installed binary intact.
Put `~/.local/bin` early in `PATH`. Existing sessions keep their loaded binary;
these commands do not restart them.

Command `herdr update` still installs upstream releases. Use the versioned
installation command for fork updates. Redirecting the updater is separate work.

## Publish a release

Update the Herdr package version in `herdr/Cargo.toml` and `herdr/Cargo.lock`,
commit the change, and open a release PR. After merging it, wait for the merged
`main` checks, then tag that merged commit from an up-to-date `main` checkout:

```bash
git tag -a herdr-ud/v0.9.7 -m "Herdr UD 0.9.7"
git push origin herdr-ud/v0.9.7
```

Workflow `Herdr UD release` requires matching tag and Cargo versions. It builds
the tagged source using pinned Rust and Zig versions, then publishes four Unix
binaries and a Windows x86_64 ZIP with the pinned ConPTY runtime and notices.
These local install commands do not support native Windows.

Assets include `checksums.txt`, `release-metadata.json`, and `build-info.md`
with the version, tag, source commit, upstream base, targets, and hashes.
Publication uses a draft after all build and packaging checks pass. Reruns can
finish a draft, but cannot overwrite published assets. These releases do not
become the dotfiles repository's general latest release.

## Verify a release candidate before merge

PRs and main pushes use `.github/filters.yml` to select affected components.
Herdr Rust, vendored code, embedded assets, packaging inputs, and the native
build workflow trigger all five native platforms. Shared Bun dependencies,
documentation scripts, and release scripts run script checks without compiling
Herdr. Ordinary documentation changes skip native compilation. Changes to the
root CI orchestrator or shared filters verify every component.

Native builds use the exact PR head or pushed commit and run the same packaging
and executable smoke tests used for tag releases. The preparation job adds
checksums and source metadata to a combined artifact named
`herdr-ud-VERSION-COMMIT`. Download it from the workflow run's Artifacts section.
The native Unix asset may need `chmod +x` after extraction.

Use **Run workflow** on CI to force all component checks, including all five
native builds and preparation, for a selected branch. Manual runs never publish.

The publish check passes with a no-op on PRs, branch pushes, and manual runs.
Step-level conditions allow actual publication only for a `herdr-ud/*` tag push
in this repository after successful preparation. Publication downloads the
prepared bundle and checks uploaded hashes before making the release public.
Tag releases rebuild from the tagged commit and omit unrelated component checks.

To prepare a local directory containing all five built packages without calling
GitHub, run these commands from the source checkout:

```bash
bun run herdr-release/publish.ts validate
bun run herdr-release/publish.ts prepare herdr-ud/v0.9.7 release-assets
```

The first command prints the validated Cargo version. The second writes
checksums, release metadata, and build information using the checkout's commit.
It fails if the version does not match or any expected package is missing.

## Verify tooling

```bash
bun test herdr-release
bun run herdr-release/publish.ts validate herdr-ud/v0.9.7
just test
bunx github-actionlint .github/workflows/ci.yml
```

Tests use generated files, a local HTTP server, and temporary destinations.
They do not publish releases or replace your installed Herdr. The tagged
workflow verifies platform builds and Windows signatures.
