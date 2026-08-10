# Use this justfile by
# (1) installing with "cargo install just"
# (2) running the "just" command.

# Displays available recipes by running `just -l`.
setup:
  #!/usr/bin/env bash
  just -l

test:
  bun test

alias t := test

# Apply shell bootstrap, portable Codex config, and managed AI skills.
sync:
  #!/usr/bin/env bash
  set -Eeuo pipefail
  source zsh/bashlib.sh
  main_bash_setup
  bun run codex/config.ts --run
  bun run skillsSync.ts --run

# Check required tools and drift without changing dotfile-managed state.
health:
  #!/usr/bin/env bash
  set -Eeuo pipefail
  source zsh/bashlib.sh

  failed=0
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

  if [[ -z "${REPO:-}" ]]; then
    log_error "REPO is not set; run just sync first or source zsh/zshenv"
    failed=1
  elif ! bun run skillsSync.ts --health; then
    failed=1
  fi

  exit "$failed"

# Run the portable Codex config CLI. For options, run `just codex`.
codex *ARGS:
  bun run codex/config.ts {{ARGS}}

# Install baseline Ubuntu/WSL shell dependencies.
i-bash:
  sudo apt install -y build-essential ripgrep gh libclang-dev wslu \
    ca-certificates gnupg curl trash-cli clang-format sqlite3

# Install shell dependencies needed by CI tests.
i-bash-ci:
  sudo apt install -y build-essential ripgrep gh

# Synchronize runtime skills (~/.cursor/skills) with public/private backups and Codex
skills-sync *ARGS:
  bun run skillsSync.ts {{ARGS}}
