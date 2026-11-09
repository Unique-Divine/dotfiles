#!/usr/bin/env bash
set -Eeuo pipefail

: "${REPO:?REPO must point to the directory containing boku}"

boku_dir="$REPO/boku"
jiyuu_dir="$boku_dir/jiyuu"
dotfiles_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

# Log this step to the Boku run log; it does nothing if the writer is off.
# shellcheck source=../runlog/runlog.sh
source "$dotfiles_dir/runlog/runlog.sh" || true
if ! declare -F runlog_start >/dev/null; then
  runlog_start() { :; }
  runlog_event() { :; }
  runlog_step() { shift; "$@"; }
  runlog_end() { :; }
fi
runlog_start sync-jiyuu
trap 'runlog_end $?' EXIT

fail() {
  echo "sync-jiyuu: $*" >&2
  runlog_event error code=sync-jiyuu-failed msg="$*"
  exit 1
}

if ! git -C "$boku_dir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  fail "Boku checkout is unavailable at $boku_dir"
fi

if [[ ! -e "$jiyuu_dir/.git" ]]; then
  runlog_step submodule-sync git -C "$boku_dir" submodule sync -- jiyuu
  runlog_step submodule-update \
    git -C "$boku_dir" submodule update --init --recursive -- jiyuu
fi

if [[ ! -e "$jiyuu_dir/.git" ]] || ! git -C "$jiyuu_dir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  fail "Jiyuu is not a Git checkout at $jiyuu_dir"
fi

# Merge origin/main into whatever branch Jiyuu is on. Uncommitted work,
# conflicts, and stray detached commits are left alone with a warning so the
# rest of the sync still runs; gh-rev then builds from the current checkout.
merge_status=0
(cd "$jiyuu_dir" && runlog_step git_mf "$dotfiles_dir/bin/git_mf" main) \
  || merge_status=$?
case "$merge_status" in
  0) ;;
  2|3|4|5)
    echo "sync-jiyuu: left Jiyuu as it is (see above); continuing" >&2
    runlog_event warn code=jiyuu-left-as-is msg="git_mf exited $merge_status"
    ;;
  *) fail "merging origin/main into Jiyuu failed (exit $merge_status)" ;;
esac

if [[ ! -f "$jiyuu_dir/gh-rev/Cargo.toml" ]]; then
  fail "Jiyuu does not contain gh-rev/Cargo.toml"
fi
