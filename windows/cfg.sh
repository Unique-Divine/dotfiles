#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

run_ps1() {
  powershell.exe \
    -NoProfile \
    -ExecutionPolicy Bypass \
    -File "$(wslpath -w "$1")"
}

run_ps1 "$script_dir/explorer.ps1"
