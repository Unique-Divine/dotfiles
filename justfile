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

# Benchmark Zsh synchronous startup or first input-ready prompt with `--mode`.
bench-zsh *ARGS:
  bun run zsh/bench-zsh.ts {{ARGS}}

# Build the release WSL clipboard bridge without installing it.
clipboard-build:
  cargo build --release --package wsl-clipboard

# Install the release WSL clipboard bridge at ~/.local/bin/wsl-clipboard.
clipboard-install:
  #!/usr/bin/env bash
  set -Eeuo pipefail
  cargo install --path clipboard --locked --root "$HOME/.local"
  for command_name in pbcopy pbpaste wsl-pbcopy wsl-pbpaste; do
    ln -sfn wsl-clipboard "$HOME/.local/bin/$command_name"
  done

# Install the gh-rev local review-ledger CLI at ~/.local/bin/gh-rev.
gh-rev-install:
  #!/usr/bin/env bash
  set -Eeuo pipefail
  cargo install --path "$REPO/boku/jiyuu/gh-rev" --locked --root "$HOME/.local"
  "$HOME/.local/bin/gh-rev" --help >/dev/null

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

# Apply shell bootstrap, portable Codex and Cursor CLI config, and managed AI skills.
sync:
  #!/usr/bin/env bash
  set -Eeuo pipefail
  source zsh/bashlib.sh
  main_bash_setup
  source symlinks.sh
  just i-zinit
  just gh-rev-install
  if is_wsl >/dev/null; then
    just clipboard-install
  fi
  bun run codex/config.ts --run
  bun run cursor/cli-config.ts --run
  bun run skillsSync.ts --run

# Check required tools and drift without changing dotfile-managed state.
health:
  bash zsh/health.sh

# Run the portable Codex config CLI. For options, run `just codex`.
codex *ARGS:
  bun run codex/config.ts {{ARGS}}

# Clone Zinit into XDG data if the checkout is missing.
[private]
i-zinit:
  bash zsh/zinit-install.sh

# Install Homebrew packages from the checked-in Brewfile.
i-brew:
  brew bundle --file Brewfile

# Install baseline Ubuntu/WSL shell dependencies.
i-bash:
  sudo apt install -y build-essential ripgrep gh libclang-dev wslu \
    ca-certificates gnupg curl trash-cli clang-format sqlite3 fzf \
    pass

# Install shell dependencies needed by CI tests.
i-bash-ci:
  sudo apt install -y build-essential ripgrep gh zsh

# Repair or check the repository-backed Cursor and Codex skill links.
skills-sync *ARGS:
  bun run skillsSync.ts {{ARGS}}
