#!/usr/bin/env bash
set -Eeuo pipefail

mode="${1:---check}"
native_bin="$HOME/.local/bin/claude"
native_versions="$HOME/.local/share/claude/versions"
# Installer: https://code.claude.com/docs/en/setup
install_url="${CLAUDE_INSTALL_URL:-https://claude.ai/install.sh}"

native_ok() {
  [[ -x "$native_bin" ]] || return 1
  local resolved
  resolved="$(readlink -f -- "$native_bin")"
  [[ "$resolved" == "$native_versions/"* ]] || return 1
  "$native_bin" --version >/dev/null 2>&1
}

case "$mode" in
  --run)
    if ! native_ok; then
      if [[ -e "$native_bin" || -L "$native_bin" ]] && \
        [[ "$(readlink -m -- "$native_bin")" != "$native_versions/"* ]]; then
        echo "Unexpected Claude installation at $native_bin; inspect it before running just claude-install." >&2
        exit 1
      fi
      curl -fsSL "$install_url" | bash
      if ! native_ok; then
        echo "Native Claude installation failed verification: $native_bin" >&2
        exit 1
      fi
    fi
    ;;
  --check) ;;
  *) echo "Usage: bash claude/native.sh [--check|--run]" >&2; exit 2 ;;
esac

if ! native_ok; then
  echo "Native Claude is missing or broken (repair: just claude-install)." >&2
  exit 1
fi

selected="$(command -v claude || true)"
if [[ -z "$selected" ]] || \
  [[ "$(readlink -f -- "$selected")" != "$(readlink -f -- "$native_bin")" ]]; then
  echo "Claude resolves to ${selected:-nothing}, expected $native_bin. Check PATH and remove obsolete npm Claude links." >&2
  exit 1
fi
