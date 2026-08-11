# Use this justfile by
# (1) installing with "cargo install just"
# (2) running the "just" command.

# Displays available recipes by running `just -l`.
setup:
  #!/usr/bin/env bash
  just -l

test:
  cargo test --workspace
  bun test

alias t := test

# Benchmark WSL clipboard copy, paste, backends, and round-trip latency.
clipboard-bench *ARGS:
  bun run zsh/clipboard.bench.ts {{ARGS}}

# Build the release WSL clipboard bridge without installing it.
clipboard-build:
  cargo build --release --package wsl-clipboard

# Install the release WSL clipboard bridge at ~/.local/bin/wsl-clipboard.
clipboard-install:
  #!/usr/bin/env bash
  set -Eeuo pipefail
  cargo install --path clipboard --locked --root "$HOME/.local"

# Run the WSL clipboard bridge from the source workspace.
clipboard *ARGS:
  cargo run --package wsl-clipboard -- {{ARGS}}

# Benchmark the compiled bridge beside the explicitly named legacy commands.
clipboard-rust-bench *ARGS:
  #!/usr/bin/env bash
  set -Eeuo pipefail
  cargo build --package wsl-clipboard
  WSL_CLIPBOARD_BIN="$PWD/target/debug/wsl-clipboard" \
    bun run zsh/clipboard.bench.ts {{ARGS}}

# Apply shell bootstrap, portable Codex config, and managed AI skills.
sync:
  #!/usr/bin/env bash
  set -Eeuo pipefail
  source zsh/bashlib.sh
  main_bash_setup
  if is_wsl >/dev/null; then
    just clipboard-install
  fi
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
