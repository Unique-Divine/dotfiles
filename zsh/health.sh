#!/usr/bin/env bash
set -Eeuo pipefail
source zsh/bashlib.sh

failed=0

# Verify a runtime path resolves to its dotfiles-managed source without
# changing either path. Repair any drift with `just sync`.
check_managed_link() {
  local source_path="$1"
  local runtime_path="$2"

  if [[ ! -L "$runtime_path" ]]; then
    log_error "managed link is missing: $runtime_path (repair: just sync)"
    return 1
  fi

  if [[ "$(readlink -f -- "$runtime_path")" != \
    "$(readlink -f -- "$source_path")" ]]; then
    log_error "managed link points to the wrong target: $runtime_path (repair: just sync)"
    return 1
  fi
}

check_view_link() {
  local nvim_path view_path
  if ! nvim_path="$(command -v nvim)"; then
    log_error "nvim is not installed; cannot validate view link"
    return 1
  fi
  if ! view_path="$(command -v view)"; then
    log_error "view is not installed; repair with: just sync"
    return 1
  fi
  if [[ "$(readlink -f -- "$view_path")" != \
    "$(readlink -f -- "$nvim_path")" ]]; then
    log_error "view does not resolve to nvim (repair: just sync)"
    return 1
  fi
}

for link_spec in \
  "zsh/zshenv:$HOME/.zshenv" \
  "zsh/zshrc:$HOME/.zshrc" \
  "rustfmt.toml:$HOME/rustfmt.toml" \
  "tmux/tmux.conf:$HOME/.tmux.conf" \
  "nvim:$HOME/.config/nvim" \
  "herdr/config.toml:$HOME/.config/herdr/config.toml" \
  ".config/yarn/global/package.json:$HOME/.config/yarn/global/package.json" \
  "zsh/ud/ud.sh:$HOME/.local/bin/ud"; do
  source_path="${link_spec%%:*}"
  runtime_path="${link_spec#*:}"
  if ! check_managed_link "$PWD/$source_path" "$runtime_path"; then
    failed=1
  fi
done

if ! check_view_link; then
  failed=1
fi

for tool in bun just codex rsync; do
  if ! which_ok "$tool"; then
    failed=1
  fi
done

if ! which_ok bun; then
  exit 1
fi

if ! bun run codex/config.ts --check; then
  failed=1
fi

if which_ok herdr; then
  herdr_config="$PWD/herdr/config.toml"
  runtime_herdr_config="$HOME/.config/herdr/config.toml"

  if ! HERDR_CONFIG_PATH="$herdr_config" herdr config check; then
    failed=1
  fi

  if [[ ! -L "$runtime_herdr_config" ]] || \
    [[ "$(readlink -f -- "$runtime_herdr_config" 2>/dev/null || true)" != \
       "$(readlink -f -- "$herdr_config")" ]]; then
    log_error "Herdr config link is missing or points outside dotfiles: $runtime_herdr_config"
    failed=1
  fi
fi

if ! which_ok herdr-tmux; then
  log_error "herdr-tmux is not installed; run: cd $PWD/herdr-tmux && just install"
  failed=1
fi

if is_wsl >/dev/null && [[ ! -x "$HOME/.local/bin/wsl-clipboard" ]]; then
  log_error "wsl-clipboard is not installed; run: just clipboard-install"
  failed=1
fi

if [[ -z "${REPO:-}" ]]; then
  log_error "REPO is not set; run just sync first or source zsh/zshenv"
  failed=1
elif ! bun run skillsSync.ts --health; then
  failed=1
fi

exit "$failed"

