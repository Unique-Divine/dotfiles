# Herdr fork releases

Run these commands from the dotfiles root. Fork version 0.9.4 is based on
upstream v0.9.3.

## Install or download

```bash
just herdr-install                     # Build and install source
just herdr-install --ver source        # Explicit source installation
just herdr-install --get 0.9.4         # Cache a runnable release; print its path
just herdr-install --ver 0.9.4         # Install a verified release
```

Release commands accept `0.9.4`, `v0.9.4`, or `herdr-ud/v0.9.4`. They require
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
commit the change, and tag that commit:

```bash
git tag -a herdr-ud/v0.9.4 -m "Herdr UD 0.9.4"
git push origin herdr-ud/v0.9.4
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

## Verify tooling

```bash
bun test herdr-release
bun run herdr-release/publish.ts validate herdr-ud/v0.9.4
just test
bunx github-actionlint .github/workflows/herdr-release.yml
```

Tests use generated files, a local HTTP server, and temporary destinations.
They do not publish releases or replace your installed Herdr. The tagged
workflow verifies platform builds and Windows signatures.
