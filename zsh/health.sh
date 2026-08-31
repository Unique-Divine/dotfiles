#!/usr/bin/env bash
set -Eeuo pipefail
source zsh/bashlib.sh

failed=0
manifest_path="$PWD/zsh/managed-links.tsv"

bash_files=(
  symlinks.sh
  zsh/zshenv
  zsh/bashlib.sh
  zsh/aliases.sh
  zsh/quick.sh
  zsh/health.sh
  zsh/zinit-install.sh
  zsh/ud/ud.sh
)

zsh_files=(
  zsh/zshrc.zsh
  zsh/zinit.sh
  zsh/goenv-init.zsh
  zsh/docker-init.zsh
  zsh/completions.zsh
)

for file in "${bash_files[@]}"; do
  if ! bash -n "$file"; then
    failed=1
  fi
done

for file in "${zsh_files[@]}"; do
  if ! zsh -n "$file"; then
    failed=1
  fi
done

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

if [[ ! -r "$manifest_path" ]]; then
  log_error "managed-links manifest is not readable: $manifest_path"
  failed=1
else
  while IFS=$'\t' read -r source_relative destination_relative; do
    [[ -z "$source_relative" || "$source_relative" == \#* ]] && continue

    if ! check_managed_link \
      "$PWD/$source_relative" "$HOME/$destination_relative"; then
      failed=1
    fi
  done < "$manifest_path"
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

if ! bun run cursor/cli-config.ts --check; then
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

zinit_home="${ZINIT_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/zinit/zinit.git}"
if [[ ! -f "$zinit_home/zinit.zsh" ]]; then
  log_error "zinit is not installed; run: just sync"
  failed=1
fi

if [[ -z "${REPO:-}" ]]; then
  log_error "REPO is not set; run just sync first or source zsh/zshenv"
  failed=1
elif ! bun run skillsSync.ts --health; then
  failed=1
fi

exit "$failed"
