#!/usr/bin/env bash
set -Eeuo pipefail

: "${REPO:?REPO must point to the directory containing boku}"

boku_dir="$REPO/boku"
jiyuu_dir="$boku_dir/jiyuu"

fail() {
  echo "sync-jiyuu: $*" >&2
  exit 1
}

if ! git -C "$boku_dir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  fail "Boku checkout is unavailable at $boku_dir"
fi

if [[ ! -e "$jiyuu_dir/.git" ]]; then
  git -C "$boku_dir" submodule sync -- jiyuu
  git -C "$boku_dir" submodule update --init --recursive -- jiyuu
fi

if [[ ! -e "$jiyuu_dir/.git" ]] || ! git -C "$jiyuu_dir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  fail "Jiyuu is not a Git checkout at $jiyuu_dir"
fi

if [[ -n "$(git -C "$jiyuu_dir" status --porcelain)" ]]; then
  fail "Jiyuu has local changes; commit, stash, or remove them before running just sync"
fi

git -C "$jiyuu_dir" fetch --prune origin \
  '+refs/heads/main:refs/remotes/origin/main'
git -C "$jiyuu_dir" checkout --detach origin/main

if [[ ! -f "$jiyuu_dir/gh-rev/Cargo.toml" ]]; then
  fail "Jiyuu origin/main does not contain gh-rev/Cargo.toml"
fi
