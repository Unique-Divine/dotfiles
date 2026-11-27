#!/usr/bin/env bash
# shellcheck disable=SC2016
# Preserve PowerShell variables inside the command text.
set -Eeuo pipefail

case "$#:${1-}" in
  0:) action='& $hub' ;;
  1:--setup-preview) action='& $hub -Setup' ;;
  *)
    printf 'Usage: %s [--setup-preview]\n' "${0##*/}" >&2
    exit 2
    ;;
esac

if ! powershell=$(type -P powershell.exe); then
  powershell=/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe
fi
if [[ ! -x "$powershell" ]]; then
  printf 'WSL Cross Hub: Windows PowerShell is unavailable on PATH and in System32.\n' >&2
  exit 127
fi

command='
$ErrorActionPreference = "Stop"
[Console]::WriteLine("WSL_CROSS_HUB_READY")
$hub = Join-Path $env:USERPROFILE "dotfiles\windows\wsl-cross-hub\wsl-cross-hub.ps1"
if (!(Test-Path -LiteralPath $hub -PathType Leaf)) {
    [Console]::Error.WriteLine("WSL Cross Hub is missing at $hub. Run just win-sync from dotfiles.")
    exit 66
}
'
command+=$'\n'"$action"$'\n''exit $LASTEXITCODE'

status=0
output=$("$powershell" -NoProfile -NonInteractive -ExecutionPolicy Bypass \
  -Command "$command" </dev/null) || status=$?
header=${output%%$'\n'*}
if [[ ${header%$'\r'} != WSL_CROSS_HUB_READY ]]; then
  printf 'WSL Cross Hub: Windows PowerShell did not start through WSL interop.\n' >&2
  if [[ -n "$output" ]]; then printf '%s\n' "$output" >&2; fi
  if (( status == 0 )); then exit 1; fi
  exit "$status"
fi
if [[ "$output" == *$'\n'* ]]; then
  printf '%s\n' "${output#*$'\n'}"
fi
exit "$status"
