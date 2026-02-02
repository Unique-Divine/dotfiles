#!/usr/bin/env bash
# This script becomes the `ud` CLI when `symlinks.sh` links:
#   $DOTFILES/zsh/ud/ud.sh -> ~/.local/bin/ud

shopt -s expand_aliases

source "$DOTFILES/zsh/zshenv"

_ud_help() {
  local help_text
  help_text=$(cat <<EOF
NAME:
   ud - CLI for convenient bash execution

USAGE:
   ud [global options] command [command options] [arguments...]

COMMANDS:
   go             Golang-specific commands
   quick, q, cfg  Core configuration commands and common jumps to editors
   rs             Rust-specific commands
   nibi           Nibiru-specific commands
   md             Markdown commands
   docker         Docker Desktop commands for WSL
   help, h        Shows a list of commands or help for one command

GLOBAL OPTIONS:
   --help, -h     Show help
EOF
)
  echo "$help_text"
}

# Function: _ud_run - Echo a command string and execute it by default. 
# If `--cmd` is present in the remaining arguments, only print the command
# without executing it.
_ud_run() {
  local base_cmd="$1"; shift
  if [[ " $* " =~ " --cmd " ]]; then
    echo "$base_cmd"
  else
    echo "$base_cmd"
    eval "$base_cmd"
  fi
}

# Command: "ud go"
_ud_go() {
  local sub="${1:-help}"
  case "$sub" in
    test-short|ts)
      _ud_run "go test ./... -short 2>&1 | grep -Ev 'no test|no statement'" "$@" ;;
    test-int|ti)
      _ud_run "go test ./... -run Integration 2>&1 | grep -Ev 'no test|no statement'" "$@" ;;
    test|t)
      _ud_run "go test ./... 2>&1 | grep -Ev 'no test|no statement'" "$@" ;;
    lint)
      _ud_run "golangci-lint run --allow-parallel-runners --fix" "$@" ;;
    cover-short|cs)
      _ud_go_cover "go test ./... -short -cover -coverprofile='temp.out' 2>&1 | grep -Ev 'no test|no statement'" ;;
    cover|c)
      _ud_go_cover "go test ./... -cover -coverprofile='temp.out' 2>&1 | grep -v 'no test' | grep -v 'no statement'" ;;
    help|-h|--help|"")
      local help_text
      help_text=$(cat <<EOF
USAGE:
   ud go [command] [--cmd]

COMMANDS:
   test-short, ts     Run Golang unit tests
   test-int, ti       Run Golang integration tests
   test, t            Run Golang tests
   lint               Run golangci-lint
   cover-short, cs    Run short tests and view coverage
   cover, c           Run full tests and view coverage

FLAGS:
   --cmd              Print the underlying command
   --help, -h         Show help for the this command
EOF
)
      echo "$help_text"
      ;;
    *)
      echo "Unknown go subcommand: $sub"
      _ud_go help
      return 1
      ;;
  esac
}

_ud_go_cover() {
  local test_cmd="$1"
  echo "$test_cmd"
  eval "$test_cmd"
  go tool cover -html="temp.out" -o coverage.html
  open coverage.html || explorer.exe coverage.html 2>/dev/null || echo "Coverage report generated."
}

# ------------ Subcommand: ud quick 

# Command: "ud quick"
_ud_quick() {
  source "$DOTFILES/zsh/bashlib.sh"
  source "$DOTFILES/zsh/aliases.sh"
  source "$DOTFILES/zsh/quick.sh"

  local sub="${1:-help}"
  case "$sub" in
    cfg_nvim)
      _ud_run "cfg_nvim" "$@" ;;
    cfg_tmux)
      _ud_run "cfg_tmux" "$@" ;;
    dotf)
      _ud_run "dotf" "$@" ;;
    music)
      _ud_run "music" "$@" ;;
    myrc)
      _ud_run "myrc" "$@" ;;
    notes)
      _ud_run "notes" "$@" ;;
    out)
      _ud_run "nvim $HOME/ki/out.txt" "$@" ;;
    skills)
      _ud_run "skills" "$@" ;;
    todos)
      _ud_run "todos" "$@" ;;
    help|-h|--help|"")
      local help_text
      help_text=$(cat <<EOF
USAGE:
   ud quick [command]

DESCRIPTION:
   Quick jumps to open Neovim (nvim) to different working directories.
   In the below commands, "edit" means "open nvim with a certain working directory".

COMMANDS:
   cfg_nvim     Edit nvim (Neovim) config
   cfg_tmux     Edit tmux config
   dotf         Edit your dotfiles
   music        Opens the Windows file explorer to your music files
   myrc         Edit your zshrc config
   notes        Edit your notes workspace
   out          Edit temporary file at \$HOME/ki/out.txt
   skills       Open AI agent skills directory in Neovim
   todos        Edit your notes workspace with your text-based TODO-list open

FLAGS:
   --help, -h         Show help for this command
EOF
)
      echo "$help_text"
      ;;
    *)
      echo "Unknown quick subcommand: $sub"
      _ud_quick help
      return 1
      ;;
  esac
}

# ------------ Subcommand: ud rs

# Command: "ud rs"
_ud_rs() {
  local sub="${1:-help}"
  case "$sub" in
    test-short|ts)
      local crate
      crate=$(grep -e "^name = " Cargo.toml | cut -d= -f2- | tr -d '"[:space:]')
      if [[ -n "$crate" ]]; then
        cmd="RUST_BACKTRACE=1 cargo test --package \"$crate\""
      else
        cmd="RUST_BACKTRACE=1 cargo test"
      fi
      _ud_rs_run "$cmd" "${@:2}"
      ;;

    test|t)
      _ud_rs_run "cargo test" "${@:2}"
      ;;

    fmt)
      _ud_rs_run "cp \"\$KOJIN_PATH/dotfiles/rustfmt.toml\" . && cargo fmt --all" "${@:2}"
      ;;

    tidy)
      local cmd="cargo b && ud rs lint && ud rs fmt"
      _ud_rs_run "$cmd" "${@:2}"
      ;;

    lint|clippy)
      _ud_rs_run "cargo clippy --fix --allow-dirty --allow-staged" "${@:2}"
      ;;

    clippy-check)
      _ud_rs_run "cargo clippy" "${@:2}"
      ;;

    help|-h|--help|"")
      local help_text
      help_text=$(cat <<EOF
USAGE:
   ud rs [command] [--cmd]

DESCRIPTION:
   Rust-specific commands for common Cargo, rustup, and rustc workflows.

COMMANDS:
   test-short, ts      Run tests for the current package
   test, t             Run all tests
   fmt                 Format using rustfmt
   tidy                Build, lint, and format in sequence
   lint, clippy        Run linter with fixes
   clippy-check        Run linter in check-only mode

FLAGS:
   --cmd              Print the underlying command
   --help, -h         Show help for the this command
EOF
)
      echo "$help_text"
      ;;
    *)
      echo "Unknown rs subcommand: $sub"
      _ud_rs help
      return 1
      ;;
  esac
}

_ud_rs_run() {
  local base_cmd="$1"; shift
  if [[ " $* " =~ " --cmd " ]]; then
    echo "$base_cmd"
  else
    echo "$base_cmd"
    eval "$base_cmd"
  fi
}

# ------------ Subcommand: ud md

# Command: "ud md"
_ud_md() {
  local sub="${1:-help}"
  case "$sub" in
    show)
      echo "Use command: markdown-preview"
      echo 'Install with: bun install -g @mryhryki/markdown-preview'
      ;;

    help|-h|--help|"")
      local help_text
      help_text=$(cat <<EOF
USAGE:
   ud md [command]

DESCRIPTION:
   Markdown utilities for previewing or formatting markdown files.

COMMANDS:
   show     Show markdown preview in browser (requires markdown-preview)

NOTES:
   To install the preview tool: bun install -g @mryhryki/markdown-preview

FLAGS:
   --help, -h         Show help for the this command
EOF
)
      echo "$help_text"
      ;;

    *)
      echo "Unknown md subcommand: $sub"
      _ud_md help
      return 1
      ;;
  esac
}

# ------------ Subcommand: ud nibi

RPC_NIBI_LOCAL="http://localhost:26657"
RPC_NIBI_TEST="https://rpc.archive.testnet-2.nibiru.fi:443"  # load balanced between nodes
RPC_NIBI_PROD="https://rpc.archive.nibiru.fi:443"
RPC_NIBI_DEV="https://rpc.devnet-3.nibiru.fi:443"
# RPC_NIBI_TEST="https://rpc.testnet-2.nibiru.fi:443"  # load balanced between nodes
# RPC_NIBI_PROD="https://rpc.nibiru.fi:443"
# ITN_RPC="https://rpc-1.itn-1.nibiru.fi:443"   # individual node

# Command: "ud nibi cfg"
_ud_nibi_cfg() {
  local sub="${1:-help}"
  echo "Usage: ud nibi cfg [local | prod | test | dev]"
  echo "Sets the Nibiru CLI config to one of the Nibiru blockchain networks."
  case "$sub" in
    help|-h|--help|"")
      local help_text
      help_text=$(cat <<EOF
USAGE:
   ud nibi cfg [network]

DESCRIPTION:
   Set Nibiru CLI config to a specific network.

COMMANDS:
   local       Local network (localnet)
   prod        Mainnet (cataclysm-1)
   test        Test network (testnet)
   dev         Development network (devnet)

FLAGS:
   --help, -h         Show help for the this command
EOF
)
      echo "$help_text"
      ;;
    local)
      local rpc_url="$RPC_NIBI_LOCAL"
      local chain_id="nibiru-localnet-0"
      nibid config node $rpc_url
      nibid config chain-id "$chain_id"
      nibid config broadcast-mode sync
      nibid config
      export RPC="$rpc_url"
      ;;
    prod)
      local rpc_url="$RPC_NIBI_PROD"
      nibid config node "$rpc_url"
      nibid config chain-id cataclysm-1
      nibid config broadcast-mode sync
      nibid config
      export RPC="$rpc_url"
      ;;
    test)
      local rpc_url="$RPC_NIBI_TEST"
      local chain_id="nibiru-testnet-2"
      nibid config node $rpc_url
      nibid config chain-id "$chain_id"
      nibid config broadcast-mode sync
      nibid config
      export RPC="$rpc_url"
      ;;
    dev)
      local rpc_url="$RPC_NIBI_DEV"
      nibid config node $rpc_url
      nibid config chain-id nibiru-devnet-3
      nibid config broadcast-mode sync
      nibid config
      export RPC="$rpc_url"
      ;;
    *)
      echo "Unknown cfg subcommand: $sub"
      _ud_nibi_cfg help
      return 1
      ;;
  esac
}


# Command: "ud nibi"
_ud_nibi() {
  local sub="${1:-help}"
  case "$sub" in
    cfg)
      _ud_nibi_cfg "${@:2}"
      ;;

    addrs)
      echo "$ADDR_VAL ADDR_VAL"
      echo "$ADDR_UD ADDR_UD"
      echo "$ADDR_DELPHI ADDR_DELPHI"
      echo "$FAUCET_WEB FAUCET_WEB"
      echo "$FAUCET_DISCORD FAUCET_DISCORD"
      ;;

    get-nibid|gn)
      local cmd='curl -s https://get.nibiru.fi/@v2.9.0! | bash'
      echo "$cmd"
      eval "$cmd"
      ;;

    help|-h|--help|"")
      local help_text
      help_text=$(cat <<EOF
USAGE:
   ud nibi [command]

DESCRIPTION:
   Nibiru-specific tools and config commands.

COMMANDS:
   cfg               Set CLI config to target a network
   addrs             Show common Nibiru addresses used in testing
   get-nibid, gn     Install nibid binary (via curl)

FLAGS:
   --help, -h         Show help for the this command
EOF
)
      echo "$help_text"
      ;;

    *)
      echo "Unknown nibi subcommand: $sub"
      _ud_nibi help
      return 1
      ;;
  esac
}

# ------------ Subcommand: ud docker

UD_DOCKER_DESKTOP_EXE="/mnt/c/Program Files/Docker/Docker/Docker Desktop.exe"
UD_DOCKER_DESKTOP_WIN_PATH="C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe"

# Function: _ud_docker_is_ready
# Purpose: Return success when Docker CLI exists and daemon responds.
_ud_docker_is_ready() {
  if ! command -v docker >/dev/null 2>&1; then
    return 1
  fi

  docker info >/dev/null 2>&1
}

# Function: _ud_docker_desktop_running
# Purpose: Detect whether Docker Desktop.exe is running on Windows.
_ud_docker_desktop_running() {
  if ! command -v tasklist.exe >/dev/null 2>&1; then
    return 1
  fi

  tasklist.exe 2>/dev/null | tr -d "\r" | grep -Fq "Docker Desktop.exe"
}

# Function: _ud_docker_launch_desktop
# Purpose: Start Docker Desktop from its WSL-mounted executable path.
_ud_docker_launch_desktop() {
  if [[ -x "$UD_DOCKER_DESKTOP_EXE" ]]; then
    echo "Launching executable:"
    echo "  $UD_DOCKER_DESKTOP_EXE"
    echo "  $UD_DOCKER_DESKTOP_WIN_PATH (Windows path)"
    "$UD_DOCKER_DESKTOP_EXE" >/dev/null 2>&1 &
    disown 2>/dev/null || true
    return 0
  fi

  return 1
}

# Command: "ud docker start"
# Behavior: Start Docker Desktop only when Docker is not already ready.
_ud_docker_start() {
  if _ud_docker_is_ready; then
    echo "Docker is already running."
    return 0
  fi

  if _ud_docker_desktop_running; then
    echo "Docker Desktop is already running. Waiting for Docker engine..."
    return 0
  fi

  if [[ ! -f "$UD_DOCKER_DESKTOP_EXE" ]]; then
    echo "Docker Desktop executable not found:"
    echo "  $UD_DOCKER_DESKTOP_EXE"
    echo "Install Docker Desktop or update the ud docker path."
    return 1
  fi

  echo "Starting Docker Desktop..."
  if _ud_docker_launch_desktop; then
    echo "Docker Desktop launch requested."
    echo "After startup, run 'docker' to verify it is ready."
    return 0
  fi

  echo "Failed to launch Docker Desktop from WSL."
  return 1
}

# Command: "ud docker kill-all"
# Behavior: Tear down running Compose projects with `down -v` and then stop
# any remaining running containers.
_ud_docker_kill_all() {
  if ! command -v docker >/dev/null 2>&1; then
    echo "Docker CLI is not installed or not on PATH."
    return 1
  fi

  if ! docker info >/dev/null 2>&1; then
    echo "Docker daemon is not reachable."
    return 1
  fi

  local compose_entries
  compose_entries=$(
    docker ps \
      --filter label=com.docker.compose.project \
      --format '{{.Label "com.docker.compose.project"}}|{{.Label "com.docker.compose.project.working_dir"}}|{{.Label "com.docker.compose.project.config_files"}}' \
      | awk '!seen[$0]++'
  )

  if [[ -n "$compose_entries" ]]; then
    echo "Tearing down running Docker Compose projects with down -v..."
    while IFS='|' read -r project_name project_workdir project_configs; do
      [[ -z "$project_name" ]] && continue

      echo "Compose project: $project_name"
      local compose_args=()
      if [[ -n "$project_workdir" ]]; then
        compose_args+=(--project-directory "$project_workdir")
      fi

      local cfg
      IFS=',' read -r -a cfg_list <<< "$project_configs"
      for cfg in "${cfg_list[@]}"; do
        [[ -n "$cfg" ]] && compose_args+=(-f "$cfg")
      done

      docker compose "${compose_args[@]}" down -v || {
        echo "Failed to fully tear down project: $project_name"
      }
    done <<< "$compose_entries"
  else
    echo "No running Docker Compose projects found."
  fi

  local running_container_ids
  running_container_ids=$(docker ps --format '{{.ID}}')
  if [[ -n "$running_container_ids" ]]; then
    echo "Stopping remaining running containers..."
    # shellcheck disable=SC2086
    docker stop $running_container_ids
  else
    echo "No remaining running containers found."
  fi

  echo "Done. Docker Desktop remains running, but containers are inactive."
}

# Command: "ud docker"
_ud_docker() {
  local sub="${1:-help}"
  case "$sub" in
    start)
      _ud_docker_start
      ;;
    kill-all)
      _ud_docker_kill_all
      ;;

    help|-h|--help|"")
      local help_text
      help_text=$(cat <<EOF
USAGE:
   ud docker [command]

DESCRIPTION:
   Docker Desktop helpers for WSL environments.

COMMANDS:
   start     Start Docker Desktop if not already running
   kill-all  Stop all running containers and run compose down -v

FLAGS:
   --help, -h         Show help for this command
EOF
)
      echo "$help_text"
      ;;

    *)
      echo "Unknown docker subcommand: $sub"
      _ud_docker help
      return 1
      ;;
  esac
}

# ------------ main entry point

{
  cmd="${1:-help}"
  case "$cmd" in
    go) _ud_go "${@:2}" ;;
    rs) _ud_rs "${@:2}" ;;
    md) _ud_md "${@:2}" ;;
    nibi) _ud_nibi "${@:2}" ;;
    docker) _ud_docker "${@:2}" ;;
    quick|q|cfg) _ud_quick "${@:2}" ;;
    help|-h|--help|"") _ud_help ;;
    *) echo -e "Unknown command: $cmd\n"; _ud_help ;;
  esac
}
