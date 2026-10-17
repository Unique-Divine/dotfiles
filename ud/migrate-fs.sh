#!/usr/bin/env bash
# Remove only retired publisher links owned by this checkout after ud installs.
set -Eeuo pipefail

fs_repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fs_plugin="${XDG_DATA_HOME:-$HOME/.local/share}/ud/plugins/ud-fs"
fs_legacy_pub="$HOME/.local/bin/pub"
fs_mode="${1:---check}"
if [[ "$fs_mode" != --check && "$fs_mode" != --apply ]]; then
  printf 'Usage: %s [--check|--apply]\n' "$0" >&2
  exit 2
fi
if [[ -e "$fs_plugin" || -L "$fs_plugin" ]]; then
  if [[ ! -L "$fs_plugin" || "$(readlink -m -- "$fs_plugin")" != "$fs_repo_root/bin/ud-fs" ]]; then
    printf 'Refusing to remove an unrelated ud-fs plugin: %s\n' "$fs_plugin" >&2
    exit 1
  fi
  if [[ "$fs_mode" == --apply ]]; then
    unlink "$fs_plugin"
  fi
fi
if [[ "$fs_mode" == --apply && -L "$fs_legacy_pub" && "$(readlink -m -- "$fs_legacy_pub")" == "$fs_repo_root/bin/pub" ]]; then
  unlink "$fs_legacy_pub"
fi
