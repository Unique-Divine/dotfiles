#!/usr/bin/env bash
# Internal shell operations for the Rust ud CLI. This file is not a public
# command parser. Rust validates the command and passes one fixed operation.

set -u

ud_shell_quick() {
  local sub="$1"
  if [[ -z "${DOTFILES:-}" ]]; then
    echo "DOTFILES is not set; source zsh/zshenv" >&2
    return 1
  fi

  # shellcheck disable=SC1090
  source "$DOTFILES/zsh/bashlib.sh"
  # shellcheck disable=SC1090
  source "$DOTFILES/zsh/quick.sh"

  case "$sub" in
    dotf|music|notes|skills|todos)
      "$sub"
      ;;
    out)
      nvim "$HOME/ki/out.txt"
      ;;
    *)
      printf 'Unknown ud quick shell operation: %s\n' "$sub" >&2
      return 1
      ;;
  esac
}

ud_shell_nibi_keys_add_mnem() {
  local name=""
  local mnemonic=""

  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      --name)
        name="${2:-}"
        shift 2
        ;;
      --mnem)
        mnemonic="${2:-}"
        shift 2
        ;;
      *)
        printf 'Unknown mnemonic helper argument: %s\n' "$1" >&2
        return 1
        ;;
    esac
  done

  if [[ -z "$name" || -z "$mnemonic" ]]; then
    echo "Mnemonic helper requires --name and --mnem." >&2
    return 1
  fi

  local -a pipeline_status
  printf '%s\n' "$mnemonic" | \
    nibid keys add "$name" --recover --keyring-backend=test
  pipeline_status=("${PIPESTATUS[@]}")
  return "${pipeline_status[1]}"
}

UD_DOCKER_DESKTOP_EXE="/mnt/c/Program Files/Docker/Docker/Docker Desktop.exe"
UD_DOCKER_DESKTOP_WIN_PATH="C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe"

ud_shell_docker_is_ready() {
  command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1
}

ud_shell_docker_desktop_running() {
  command -v tasklist.exe >/dev/null 2>&1 || return 1
  tasklist.exe 2>/dev/null | tr -d "\r" | grep -Fq "Docker Desktop.exe"
}

ud_shell_docker_start() {
  if ud_shell_docker_is_ready; then
    echo "Docker is already running."
    return 0
  fi

  if ud_shell_docker_desktop_running; then
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
  "$UD_DOCKER_DESKTOP_EXE" >/dev/null 2>&1 &
  disown 2>/dev/null || true
  echo "Docker Desktop launch requested."
  echo "After startup, run 'docker' to verify it is ready."
}

ud_shell_docker_stop() {
  if ! command -v taskkill.exe >/dev/null 2>&1; then
    echo "taskkill.exe is not available. Are you running from WSL?"
    return 1
  fi

  if ! ud_shell_docker_desktop_running; then
    echo "Docker Desktop is not running."
    return 0
  fi

  echo "Stopping Docker Desktop..."
  taskkill.exe /IM "Docker Desktop.exe" /T /F
}

ud_shell_docker_kill_all() {
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
    echo "Tearing down running docker compose apps with docker compose down -v..."
    while IFS='|' read -r project_name project_workdir project_configs; do
      [[ -z "$project_name" ]] && continue
      echo "Docker compose app: $project_name"

      local compose_args=()
      if [[ -n "$project_workdir" ]]; then
        compose_args+=(--project-directory "$project_workdir")
      fi
      local cfg
      local -a cfg_list
      IFS=',' read -r -a cfg_list <<< "$project_configs"
      for cfg in "${cfg_list[@]}"; do
        [[ -n "$cfg" ]] && compose_args+=(-f "$cfg")
      done
      docker compose "${compose_args[@]}" down -v || \
        echo "Failed to fully tear down project: $project_name"
    done <<< "$compose_entries"
  else
    echo "No running docker compose apps found."
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

case "${1:-}" in
  quick)
    [[ "$#" -eq 2 ]] || {
      echo "quick shell operation requires one command" >&2
      exit 1
    }
    ud_shell_quick "$2"
    ;;
  docker)
    case "${2:-}" in
      start) ud_shell_docker_start ;;
      stop) ud_shell_docker_stop ;;
      kill-all) ud_shell_docker_kill_all ;;
      *)
        printf 'Unknown ud docker shell operation: %s\n' "${2:-}" >&2
        exit 1
        ;;
    esac
    ;;
  nibi-keys-add-mnem)
    shift
    ud_shell_nibi_keys_add_mnem "$@"
    ;;
  nibi-get-nibid)
    curl -s 'https://get.nibiru.fi/@v2.9.0!' | bash
    ;;
  *)
    printf 'Unknown ud shell operation: %s\n' "${1:-}" >&2
    exit 1
    ;;
esac
