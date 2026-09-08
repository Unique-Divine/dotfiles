#!/usr/bin/env bash
# Print a stable fingerprint for source files used by the installed ud binary.

set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
files=(
  "$repo_root/Cargo.toml"
  "$repo_root/Cargo.lock"
  "$repo_root/ud/Cargo.toml"
  "$repo_root/zsh/ud/shell.sh"
)
while IFS= read -r -d '' source_file; do
  files+=("$source_file")
done < <(find "$repo_root/ud/src" -type f -print0 | sort -z)

sha256sum "${files[@]}" | sha256sum | cut -d' ' -f1
