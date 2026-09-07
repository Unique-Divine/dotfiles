# Vendored Herdr source

This is a source snapshot of Herdr for local customization. It is no longer a Git submodule.

The snapshot came from `git@github.com:herdrdev/herdr.git` at commit `5f6e4b222d32225e5c77a190064c61ff9549e6a0` on the former local branch `ud/tmux`, based on upstream commit `6c6ddcd49384d6ea9f0ee2e63bf7b2643dfd5bcf`.

The directory excludes the Astro website, release CI, packaging, Nix files, preview and published website docs, and the plugin-worker app. It keeps the Rust application, tests, embedded assets, API schema, and vendored terminal dependencies needed by the local build.

To take upstream changes later, clone Herdr separately, compare the desired files with this tree, and port the selected changes deliberately. Do not reintroduce a submodule here.
