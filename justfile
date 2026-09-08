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

# Run the Rust ud CLI from this checkout.
ud *ARGS:
  cargo run --package ud -- {{ARGS}}

# Build the Rust ud CLI without installing it.
ud-build:
  cargo build --release --package ud

# Install the Rust ud CLI at ~/.local/bin/ud and record its source fingerprint.
ud-install:
  #!/usr/bin/env bash
  set -Eeuo pipefail
  ud_bin="$HOME/.local/bin/ud"
  legacy_ud="$PWD/zsh/ud/ud.sh"

  if [[ -L "$ud_bin" ]]; then
    installed_target="$(readlink -m -- "$ud_bin")"
    legacy_target="$(readlink -m -- "$legacy_ud")"
    if [[ "$installed_target" == "$legacy_target" ]]; then
      unlink "$ud_bin"
    else
      echo "Refusing to replace unexpected ud symlink: $ud_bin" >&2
      exit 1
    fi
  elif [[ -e "$ud_bin" ]]; then
    if [[ ! -f "$ud_bin" || ! -x "$ud_bin" ]] || \
      ! "$ud_bin" --version 2>/dev/null | rg -q '^ud [0-9]'; then
      echo "Refusing to replace unexpected ud executable: $ud_bin" >&2
      exit 1
    fi
  fi

  cargo install --path ud --locked --root "$HOME/.local" --force
  ud_state_dir="${XDG_STATE_HOME:-$HOME/.local/state}/ud"
  install -d -m 700 "$ud_state_dir"
  ud_stamp_tmp="$(mktemp "$ud_state_dir/.install.XXXXXX")"
  bash ud/source-hash.sh > "$ud_stamp_tmp"
  chmod 600 "$ud_stamp_tmp"
  mv -f "$ud_stamp_tmp" "$ud_state_dir/install.sha256"

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
  cargo install --path clipboard --locked --root "$HOME/.local" --force
  for command_name in pbcopy pbpaste wsl-pbcopy wsl-pbpaste; do
    ln -sfn wsl-clipboard "$HOME/.local/bin/$command_name"
  done

# Install the gh-rev local review-ledger CLI at ~/.local/bin/gh-rev.
gh-rev-install:
  #!/usr/bin/env bash
  set -Eeuo pipefail
  : "${REPO:?REPO must point to the directory containing boku}"
  gh_rev_dir="$REPO/boku/jiyuu/gh-rev"
  if [[ ! -f "$gh_rev_dir/Cargo.toml" ]]; then
    echo "gh-rev source is unavailable at $gh_rev_dir; run just sync from a Boku checkout." >&2
    exit 1
  fi
  cargo install --path "$gh_rev_dir" --locked --root "$HOME/.local"
  "$HOME/.local/bin/gh-rev" --help >/dev/null

# Build and install the vendored Herdr binary at ~/.local/bin/herdr.
herdr-install:
  #!/usr/bin/env bash
  set -Eeuo pipefail
  if ! command -v cargo >/dev/null 2>&1; then
    echo "cargo is required to build vendored Herdr" >&2
    exit 1
  fi
  herdr_zig="$(command -v zig || true)"
  if [[ -z "$herdr_zig" && -x /home/linuxbrew/.linuxbrew/opt/zig@0.15/bin/zig ]]; then
    herdr_zig="/home/linuxbrew/.linuxbrew/opt/zig@0.15/bin/zig"
  fi
  if [[ -z "$herdr_zig" ]]; then
    echo "zig is required to build vendored Herdr; run just i-brew" >&2
    exit 1
  fi
  ZIG="$herdr_zig" cargo install --path lib-herdr --locked --root "$HOME/.local" --force

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
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL/bin:$HOME/.local/bin:$PATH"
  i_bash_stamp="${XDG_CACHE_HOME:-$HOME/.cache}/dotfiles/i-bash.stamp"
  i_bash_max_age_seconds=$((24 * 60 * 60))
  if [[ ! -f "$i_bash_stamp" ]]; then
    just i-bash
  else
    i_bash_last_run="$(stat --format='%Y' "$i_bash_stamp")"
    if (( $(date +%s) - i_bash_last_run >= i_bash_max_age_seconds )); then
      just i-bash
    fi
  fi
  if ! command -v bun >/dev/null 2>&1; then
    (
      export SHELL=/bin/sh
      curl -fsSL https://bun.com/install | bash
    )
  fi
  if ! command -v codex >/dev/null 2>&1; then
    curl -fsSL https://chatgpt.com/codex/install.sh | \
      CODEX_NON_INTERACTIVE=1 sh
  fi
  just i-jiyuu
  bun install
  source zsh/bashlib.sh
  main_bash_setup
  source symlinks.sh
  just ud-install
  if ! command -v herdr >/dev/null 2>&1; then
    just herdr-install
  fi
  if ! command -v herdr-tmux >/dev/null 2>&1; then
    just --justfile herdr-tmux/justfile install
  fi
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

# Restore missing Neovim tools from nvim/mason.lock.
nvim-mason-restore:
  #!/usr/bin/env bash
  set -Eeuo pipefail
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [[ ! -s "$NVM_DIR/nvm.sh" ]]; then
    printf 'NVM is not installed at %s\n' "$NVM_DIR/nvm.sh" >&2
    exit 1
  fi
  source "$NVM_DIR/nvm.sh"
  nvm install --lts=krypton
  nvm alias default lts/krypton
  nvm use --silent lts/krypton
  if ! command -v go >/dev/null 2>&1; then
    printf 'Go is not installed or is missing from PATH\n' >&2
    exit 1
  fi
  go_root="$(env -u GOROOT go env GOROOT)"
  if [[ ! -d "$go_root" ]]; then
    printf 'Go installation root is missing: %s\n' "$go_root" >&2
    exit 1
  fi
  export GOROOT="$go_root"
  nvim --headless "+MasonRestore" +qa

# Run the portable Codex config CLI. For options, run `just codex`.
codex *ARGS:
  bun run codex/config.ts {{ARGS}}

# Clone Zinit into XDG data if the checkout is missing.
[private]
i-zinit:
  bash zsh/zinit-install.sh

# Initialize Jiyuu and refresh it to the latest published main branch.
[private]
i-jiyuu:
  bash zsh/sync-jiyuu.sh

# Install Homebrew packages from the checked-in Brewfile.
i-brew:
  brew trust --tap bufbuild/buf
  brew bundle --file Brewfile

# Install baseline Ubuntu/WSL shell dependencies.
i-bash:
  #!/usr/bin/env bash
  set -Eeuo pipefail
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL/bin:$HOME/.local/bin:$PATH"
  sudo apt install -y build-essential ripgrep gh libclang-dev wslu openssh-server \
    ca-certificates gnupg curl trash-cli clang-format sqlite3 fzf \
    pass unzip
  if ! command -v tailscale >/dev/null 2>&1; then
    curl -fsSL https://tailscale.com/install.sh | sh
  fi
  if ! command -v bun >/dev/null 2>&1; then
    (
      export SHELL=/bin/sh
      curl -fsSL https://bun.com/install | bash
    )
  fi
  if ! command -v codex >/dev/null 2>&1; then
    curl -fsSL https://chatgpt.com/codex/install.sh | \
      CODEX_NON_INTERACTIVE=1 sh
  fi
  i_bash_cache_dir="${XDG_CACHE_HOME:-$HOME/.cache}/dotfiles"
  mkdir -p "$i_bash_cache_dir"
  touch "$i_bash_cache_dir/i-bash.stamp"

# Install shell dependencies needed by CI tests.
i-bash-ci:
  sudo apt install -y build-essential ripgrep gh zsh

# Repair or check the repository-backed Cursor and Codex skill links.
skills-sync *ARGS:
  bun run skillsSync.ts {{ARGS}}
