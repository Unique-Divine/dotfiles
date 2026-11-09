# Use this justfile by
# (1) installing with "cargo install just"
# (2) running the "just" command.

# Displays available recipes when running `just` or `just list`.
[private]
list:
  #!/usr/bin/env bash
  just --list

# Install ud, including its built-in public-file commands.
fs-install: ud-install

# Test file publishing and listing without cloud writes.
fs-test:
  cargo test --package ud --bin ud fs::
  cargo test --package ud --test ud_cli fs_

test: test-rust test-bun

test-rust:
  cargo test --workspace --locked

test-bun:
  bun test \
    --path-ignore-patterns "**/herdr/scripts/release-workflows.test.ts" \
    --path-ignore-patterns "**/bun/sources/**"

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
  bash ud/migrate-fs.sh --check

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

  cargo install --path ud --bin ud --locked --root "$HOME/.local" --force
  bash ud/migrate-fs.sh --apply
  ud_completion_dir="${XDG_DATA_HOME:-$HOME/.local/share}/zsh/site-functions"
  install -d -m 700 "$ud_completion_dir"
  ud_completion_tmp="$(mktemp "$ud_completion_dir/.ud.XXXXXX")"
  "$ud_bin" completions zsh > "$ud_completion_tmp"
  chmod 600 "$ud_completion_tmp"
  mv -f "$ud_completion_tmp" "$ud_completion_dir/_ud"
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

# Install source or a release with --ver VERSION; cache with --get VERSION.
herdr-install *ARGS:
  bun run herdr-release/install.ts {{ARGS}}

# Install or repair required Codex, Claude Code, and Cursor Herdr hooks.
herdr-integrations:
  bun run herdr-cfg/integrations.ts --run

# Preview one agent per tab in the current workspace; use --run to move.
[positional-arguments]
herdr-flatten *ARGS:
  bun run herdr-cfg/flatten.ts "$@"

# Build and install the vendored Herdr binary from source.
[private]
herdr-install-source:
  #!/usr/bin/env bash
  set -Eeuo pipefail
  if ! command -v cargo >/dev/null 2>&1; then
    echo "cargo is required to build vendored Herdr" >&2
    exit 1
  fi
  herdr_zig="${ZIG:-}"
  if [[ -z "$herdr_zig" ]]; then
    herdr_machine="$(uname -m)"
    for herdr_candidate in \
      "$HOME/.local/share/zig/zig-${herdr_machine}-linux-0.16.0/zig" \
      /home/linuxbrew/.linuxbrew/opt/zig/bin/zig \
      /opt/homebrew/opt/zig/bin/zig \
      /usr/local/opt/zig/bin/zig \
      "$(command -v zig || true)"; do
      if [[ -x "$herdr_candidate" ]] && \
        [[ "$("$herdr_candidate" version)" == 0.16.0 ]]; then
        herdr_zig="$herdr_candidate"
        break
      fi
    done
  fi
  if [[ -z "$herdr_zig" ]] || [[ "$("$herdr_zig" version)" != 0.16.0 ]]; then
    echo "Zig 0.16.0 is required; run brew install zig@0.16 or set ZIG" >&2
    exit 1
  fi
  ZIG="$herdr_zig" cargo install --path herdr --locked --root "$HOME/.local" --force

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

# Apply shell bootstrap, portable Codex, Cursor CLI, and Claude Code config, and
# managed AI skills for Cursor, Codex, and Claude Code.
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
  bun install
  source zsh/bashlib.sh
  main_bash_setup
  source symlinks.sh
  just bun-sync
  just claude-install
  just i-jiyuu
  just ud-install
  if ! command -v herdr >/dev/null 2>&1; then
    just herdr-install
  fi
  if ! command -v herdr-tmux >/dev/null 2>&1; then
    just --justfile herdr-tmux/justfile install
  fi
  just --justfile herdr-tmux/justfile plugin-link
  just i-zinit
  just gh-rev-install
  if is_wsl >/dev/null; then
    just clipboard-install
    just win-sync
  fi
  bun run codex/config.ts --run
  bun run cursor/cli-config.ts --run
  bun run cursor/mcp.ts --run
  bun run claude/config.ts --run
  just herdr-integrations
  if command -v claude >/dev/null 2>&1; then
    bun run claude/mcp.ts --run
  fi
  bun run skillsSync.ts --run

# Copy windows/ to %USERPROFILE%\.files\windows so the Windows tools work
# while WSL is down. WSL only.
win-sync:
  #!/usr/bin/env bash
  set -Eeuo pipefail
  for tool in cmd.exe wslpath rsync; do
    if ! command -v "$tool" >/dev/null 2>&1; then
      echo "win-sync: $tool is unavailable; skipping" >&2
      exit 0
    fi
  done
  win_home="$(cmd.exe /c 'echo %USERPROFILE%' 2>/dev/null | tr -d '\r' || true)"
  if [[ -z "$win_home" || "$win_home" == "%USERPROFILE%" ]]; then
    echo "win-sync: could not read %USERPROFILE%; skipping" >&2
    exit 0
  fi
  dest="$(wslpath -u "$win_home")/.files/windows"
  mkdir -p "$dest"
  rsync -rt --delete --exclude '*.test.ts' windows/ "$dest/"
  echo "synced windows/ -> $win_home\\.files\\windows"

# Check required tools and drift without changing dotfile-managed state.
health:
  bash zsh/health.sh

# Check domain registration (RDAP) and DNS; exits 1 on any FAIL finding.
# Default: uniquedivine.com dsn-braids.com. Add --json for machine output.
domain-health *ARGS:
  bun run domain/health.ts {{ARGS}}

# Restore the locked global Bun packages and their command and plugin links.
bun-sync:
  bun --no-install bun/sync.ts --run

# Inspect managed Bun packages and links without changing the installation.
bun-health:
  bun --no-install bun/sync.ts --check

# Refresh the global Bun lockfile after editing bun/global/package.json.
bun-lock:
  bun --no-install bun/sync.ts --lock

# Pin a published ud-mdtoc release in the managed global manifest.
bun-activate-mdtoc VERSION="0.1.0":
  bun --no-install bun/sync.ts --activate-mdtoc {{quote(VERSION)}}

# Install or verify the native Claude CLI and its command resolution.
claude-install:
  bash claude/native.sh --run

# Check the native Claude installation without installing or updating it.
claude-health:
  bash claude/native.sh --check

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

# Copy MCP servers only Claude (default) or Cursor has into Codex, then export
# them to every tool. Preview with: bun run mcp/ingest.ts --from claude --dry-run
mcp-ingest FROM="claude" *ARGS="":
  #!/usr/bin/env bash
  set -Eeuo pipefail
  bun run mcp/ingest.ts --from "{{FROM}}" --run {{ARGS}}
  bun run cursor/mcp.ts --run
  if command -v claude >/dev/null 2>&1; then
    bun run claude/mcp.ts --run
  fi

# Manage Claude configuration or MCPs, e.g. just claude config --check.
claude TOOL *ARGS:
  bun run claude/{{TOOL}}.ts {{ARGS}}

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
    pass unzip jq
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

# Repair or check the repository-backed Cursor, Codex, and Claude Code skill
# links.
skills-sync *ARGS:
  bun run skillsSync.ts {{ARGS}}

# Check TypeScript scripts
typecheck:
  bun check
