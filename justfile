# Use this justfile by
# (1) installing just with mise (see mise/README.md for a fresh machine)
# (2) running the "just" command.

# Keep doc comments inside linewise recipes out of the shell and the output.
set ignore-comments

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

# Run the Rust, Bun, and Neovim test suites.
test: test-rust test-bun test-nvim

# Run the Rust workspace tests with the locked dependencies.
test-rust:
  cargo test --workspace --locked

# Run the Bun test suites.
test-bun:
  bun test \
    --path-ignore-patterns "**/herdr/scripts/release-workflows.test.ts" \
    --path-ignore-patterns "**/bun/sources/**"

# Neovim Lua unit tests; no plugins load.
test-nvim:
  nvim --headless -u NONE -l nvim/tests/lsp_tooling_test.lua

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

# Install or repair Codex, Claude Code, Cursor, and Grok Herdr hooks.
herdr-integrations:
  bun run herdr-cfg/integrations.ts --run
  bun run grok/herdr.ts --run

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

# Apply shell, Cargo, agent CLI configs, and managed AI skills.
sync:
  #!/usr/bin/env bash
  # Covers the shell bootstrap, global Cargo config, portable Codex, Cursor
  # CLI, Claude Code, and Grok config, and the managed AI skills.
  set -Eeuo pipefail
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL/bin:$HOME/.local/bin:$PATH"
  # Each step goes to the Boku run log (ud boku runs show last --tree).
  source runlog/runlog.sh || true
  if ! declare -F runlog_start >/dev/null; then
    runlog_start() { :; }
    runlog_event() { :; }
    runlog_step() { shift; "$@"; }
    runlog_end() { :; }
  fi
  if ! declare -F runlog_trap_signals >/dev/null; then
    runlog_trap_signals() {
      trap 'exit 129' HUP
      trap 'exit 130' INT
      trap 'exit 143' TERM
    }
  fi
  runlog_start sync
  trap 'runlog_end $?' EXIT
  runlog_trap_signals
  i_bash_stamp="${XDG_CACHE_HOME:-$HOME/.cache}/dotfiles/i-bash.stamp"
  i_bash_max_age_seconds=$((24 * 60 * 60))
  if [[ ! -f "$i_bash_stamp" ]] || (( $(date +%s) \
    - $(stat --format='%Y' "$i_bash_stamp") >= i_bash_max_age_seconds )); then
    runlog_step i-bash just i-bash
  else
    runlog_event step name=i-bash msg=skipped
  fi
  if ! command -v bun >/dev/null 2>&1; then
    (
      export SHELL=/bin/sh
      curl -fsSL https://bun.com/install | bash
    )
    runlog_event step name=bun-bootstrap msg=done
  fi
  runlog_step codex-install just codex-install
  runlog_step bun-install bun install
  # Functions and sourced files run unwrapped: wrapping them in runlog_step
  # would turn off set -e inside them and change variable scope.
  source zsh/bashlib.sh
  main_bash_setup
  runlog_event step name=main-bash-setup msg=done
  source symlinks.sh
  runlog_event step name=symlinks msg=done
  runlog_step mise-install just mise-install
  # Jiyuu provides gh-rev and the public skills that later steps install.
  runlog_step i-jiyuu just i-jiyuu
  runlog_step bun-sync just bun-sync
  runlog_step claude-install just claude-install
  runlog_step grok-install just grok-install
  runlog_step ud-install just ud-install
  if ! command -v herdr >/dev/null 2>&1; then
    runlog_step herdr-install just herdr-install
  else
    runlog_event step name=herdr-install msg=skipped
  fi
  if ! command -v herdr-tmux >/dev/null 2>&1; then
    runlog_step herdr-tmux-install \
      just --justfile herdr-tmux/justfile install
  else
    runlog_event step name=herdr-tmux-install msg=skipped
  fi
  runlog_step herdr-tmux-plugin-link \
    just --justfile herdr-tmux/justfile plugin-link
  runlog_step i-zinit just i-zinit
  runlog_step gh-rev-install just gh-rev-install
  if is_wsl >/dev/null; then
    runlog_step clipboard-install just clipboard-install
    runlog_step win-sync just win-sync
    if command -v powershell.exe >/dev/null && command -v wslpath >/dev/null; then
      runlog_step sharex-sync just sharex-sync
    else
      runlog_event step name=sharex-sync msg=skipped
    fi
  else
    runlog_event step name=clipboard-install msg=skipped
  fi
  runlog_step codex-config bun run codex/config.ts --run
  runlog_step grok-config bun run grok/config.ts --run
  runlog_step cursor-cli-config bun run cursor/cli-config.ts --run
  runlog_step mcp-sync just mcp-sync --run
  runlog_step claude-config bun run claude/config.ts --run
  runlog_step herdr-integrations just herdr-integrations
  runlog_step skills-sync bun run skillsSync.ts --run
  runlog_step email-sync just email-sync
  # The MCP server refreshes only the active session's repo; this keeps the
  # other code graphs and their cross-repo links current. It takes minutes,
  # so it starts in the background (just cbm-status) and never fails sync.
  runlog_step cbm-reindex just cbm-reindex --background || true
  # Pruning old runs must never fail the sync.
  runlog_step prune bun run runlog/cli.ts prune || true

# Install a pinned mise if missing, then the CLI tools in mise/mise.lock.
mise-install:
  #!/usr/bin/env bash
  # The lock pins gh, ripgrep, just, nvim, gmailctl, and others; see
  # mise/README.md.
  set -Eeuo pipefail
  mise_bin="$HOME/.local/bin/mise"
  if [[ ! -x "$mise_bin" ]]; then
    curl -fsSL https://mise.run | MISE_VERSION=v2026.11.5 sh
  fi
  "$mise_bin" install --locked
  # Link shims into ~/.local/bin for bash, sh, and agents with an older PATH.
  bun mise/links.ts --run

# Render private gmailctl configs from Boku TypeScript into ~/.config.
email-sync:
  #!/usr/bin/env bash
  # Configs missing from the private Boku checkout are skipped, not errors.
  set -Eeuo pipefail
  email_private="${BOKU:-$HOME/boku}/priv-skills/ud/email"
  email_build() {
    local src="$email_private/$1"
    [[ -f "$src" ]] || return 0
    bun run email/gmailctl.ts "$src" "$HOME/.config/$2/config.jsonnet"
  }
  email_build gmailctl-nibi.ts gmailctl
  email_build gmailctl-ud.ts gmailctl-ud

# Run the persistent Gmail JSONL archive transport.
gmail-bridge:
  bun run email/gmail-bridge.ts

# Test email filters, mailbox sync, and the Gmail bridge without live writes.
email-test:
  bun test email/

# Typecheck the email tooling with native Bun.
email-check:
  bun check email/*.ts

# Archive target inbox mail already archived in the source Gmail account.
mail-state-sync *ARGS:
  # Dry run unless --run is given.
  bun run email/mail-state-sync.ts {{ARGS}}

# Copy windows/ to %USERPROFILE%\.files\windows (WSL only).
win-sync:
  #!/usr/bin/env bash
  # The copy keeps the Windows tools working while WSL is down.
  set -Eeuo pipefail
  bun run windows/sharex/managed-hotkeys.ts --write
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

# Build audio-capture on Windows into %LOCALAPPDATA%\Programs\audio-capture.
audio-capture-build: win-sync
  cd /mnt/c && cmd.exe /c '%USERPROFILE%\.files\windows\audio-capture\build.cmd'

# Install audio-capture: build, Start Menu shortcut, Start with Windows.
audio-capture-install: win-sync
  cd /mnt/c && cmd.exe /c '%USERPROFILE%\.files\windows\audio-capture\install.cmd --no-pause'

# Remove audio-capture's shortcuts and exe; keeps %USERPROFILE%\.audio-capture.
audio-capture-uninstall: win-sync
  cd /mnt/c && cmd.exe /c '%USERPROFILE%\.files\windows\audio-capture\uninstall.cmd --no-pause'

# Start audio-capture, or send ARGS (--toggle, --stop, --quit) to it.
audio-capture-run *ARGS:
  cd /mnt/c && powershell.exe -NoProfile -Command "Start-Process \"\$env:LOCALAPPDATA\Programs\audio-capture\audio-capture.exe\" {{ if ARGS == "" { "" } else { "-ArgumentList '" + ARGS + "'" } }}" > /dev/null 2>&1 < /dev/null

# Run the audio-capture unit tests against the built exe.
audio-capture-test:
  cd /mnt/c && "$(wslpath -u "$(cmd.exe /c 'echo %LOCALAPPDATA%' 2>/dev/null | tr -d '\r')")/Programs/audio-capture/audio-capture.exe" --self-test

# Generate the ShareX hotkey JSON used by Windows.
sharex-generate:
  bun run windows/sharex/managed-hotkeys.ts --write

# Reconcile managed ShareX hotkeys on the Windows host.
sharex-sync *ARGS: sharex-generate
  powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$(wslpath -w windows/sharex/Sync-ShareX.ps1)" {{ARGS}}

# Read the Boku run log (same as `ud boku runs`; see `just runs --help`).
[positional-arguments]
runs *ARGS:
  # Arguments pass through quoted, never re-parsed.
  bun run runlog/cli.ts "$@"

# Check required tools and drift without changing dotfile-managed state.
health:
  bash zsh/health.sh

# Check domain registration (RDAP) and DNS; exit 1 on any FAIL finding.
domain-health *ARGS:
  # Default domains: uniquedivine.com dsn-braids.com. Add --json for machine
  # output.
  bun run domain/health.ts {{ARGS}}

# Show where RAM goes, grouped by process kind and the app that started it.
mem-health *ARGS:
  # Read-only. Groups cover language servers, agent sessions, and MCP and dev
  # servers. Add --json or --min-mb N.
  bun run mem/health.ts {{ARGS}}

# Restore the locked global Bun packages and their command and plugin links.
bun-sync:
  bun --no-install bun/sync.ts --run

# Inspect managed Bun packages and links without changing the installation.
bun-health:
  bun --no-install bun/sync.ts --check

# Refresh the global Bun lockfile after editing bun/global/package.json.
bun-lock:
  bun --no-install bun/sync.ts --lock

# Pin an exact registry release globally and refresh the lock (use this, never `bun add -g`).
bun-add SPEC:
  bun --no-install bun/sync.ts --add {{quote(SPEC)}}

# Remove a package from the global manifest and refresh the lock.
bun-drop NAME:
  bun --no-install bun/sync.ts --drop {{quote(NAME)}}

# Check offline that the global manifest uses exact pins matching its lock.
bun-policy:
  bun --no-install bun/sync.ts --policy

# Pin a published ud-mdtoc release in the managed global manifest.
bun-activate-mdtoc VERSION="0.1.0":
  bun --no-install bun/sync.ts --activate-mdtoc {{quote(VERSION)}}

# Install or verify the native Claude CLI and its command resolution.
claude-install:
  bash claude/native.sh --run

# Check the native Claude installation without installing or updating it.
claude-health:
  bash claude/native.sh --check

# Install the standalone Codex CLI when it's missing, then verify it runs.
codex-install:
  bash codex/native.sh --run

# Install the Grok CLI when it's missing, then verify it runs.
grok-install:
  bash grok/native.sh --run

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

# Reindex the Codebase Memory graphs and relink them (--plan prints only).
cbm-reindex *ARGS:
  @bun run cbm/reindex.ts --run {{ARGS}}

# Build Codebase Memory from the fork's ud/main and install it (--run applies; --rollback restores).
cbm-install *ARGS:
  @bun run cbm/install.ts {{ARGS}}

# Print the last cbm-reindex run's result, or that one is running.
cbm-status:
  @bun run cbm/reindex.ts --status

# Preview or apply the MCP union (--from picks direction; --export/--import move Codex servers).
mcp-sync *ARGS:
  #!/usr/bin/env bash
  set -Eeuo pipefail
  # The export payload carries credentials: keep it out of the run log and
  # its artifacts, and keep stdout to the payload alone.
  for arg in {{ARGS}}; do
    if [[ "$arg" == --export ]]; then exec bun run mcp/sync.ts {{ARGS}}; fi
  done
  source runlog/runlog.sh
  runlog_start mcp-sync {{ARGS}}
  trap 'runlog_end $?' EXIT
  runlog_trap_signals
  output="$(mktemp)"
  trap 'exit_status=$?; rm -f "$output"; runlog_end "$exit_status"' EXIT
  status=0
  runlog_step mcp-sync bun run mcp/sync.ts {{ARGS}} >"$output" 2>&1 || status=$?
  cat "$output"
  while IFS= read -r line; do
    if [[ "$line" == '! warning '* ]]; then
      runlog_event warn code=mcp-config msg="${line#'! warning '}"
    fi
  done < "$output"
  runlog_artifact mcp-plan "$output"
  exit "$status"

# Reconcile from Claude or Cursor, including differing names, then propagate.
mcp-ingest FROM="claude" *ARGS="":
  just mcp-sync --from "{{FROM}}" --run {{ARGS}}

# Manage Claude configuration or MCPs, e.g. just claude config --check.
claude TOOL *ARGS:
  bun run claude/{{TOOL}}.ts {{ARGS}}

# Run the portable Codex config CLI. For options, run `just codex`.
codex *ARGS:
  bun run codex/config.ts {{ARGS}}

# Run the portable Grok config CLI. For options, run `just grok`.
grok *ARGS:
  bun run grok/config.ts {{ARGS}}

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
  brew bundle --file Brewfile

# Install baseline Ubuntu/WSL shell dependencies.
i-bash:
  #!/usr/bin/env bash
  set -Eeuo pipefail
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL/bin:$HOME/.local/bin:$PATH"
  # System packages only; CLI tools such as gh, ripgrep, fzf and jq come from
  # mise (just mise-install).
  # Ask for sudo only when a package is missing, so a set-up machine syncs
  # without a password prompt (and over SSH without a terminal).
  apt_packages=(build-essential wslu openssh-server ca-certificates gnupg \
    curl trash-cli clang-format sqlite3 pass unzip)
  missing=()
  for pkg in "${apt_packages[@]}"; do
    # db:Status-Status is "installed" whatever the selection (install,
    # hold), so a held package doesn't count as missing.
    if [[ "$(dpkg-query -W -f='${db:Status-Status}' "$pkg" 2>/dev/null)" \
      != installed ]]; then
      missing+=("$pkg")
    fi
  done
  if (( ${#missing[@]} > 0 )); then
    echo "i-bash: installing ${missing[*]}"
    sudo apt install -y "${missing[@]}"
  fi
  if ! command -v tailscale >/dev/null 2>&1; then
    curl -fsSL https://tailscale.com/install.sh | sh
  fi
  if ! command -v bun >/dev/null 2>&1; then
    (
      export SHELL=/bin/sh
      curl -fsSL https://bun.com/install | bash
    )
  fi
  bash codex/native.sh --run
  i_bash_cache_dir="${XDG_CACHE_HOME:-$HOME/.cache}/dotfiles"
  mkdir -p "$i_bash_cache_dir"
  touch "$i_bash_cache_dir/i-bash.stamp"

# Install shell dependencies needed by CI tests.
i-bash-ci:
  sudo apt install -y build-essential ripgrep gh zsh

# Repair or check the Cursor, Codex, and Claude Code skill links.
skills-sync *ARGS:
  # The links point at the skill directories tracked in the repositories.
  @bun run skillsSync.ts {{ARGS}}

# Check TypeScript scripts
typecheck:
  bun check
