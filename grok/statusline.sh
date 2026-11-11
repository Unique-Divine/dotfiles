#!/usr/bin/env bash
# Grok status line. Reads the session JSON on stdin and prints one line:
#   <path> <branch> <model> <context>
# The path shortens $HOME to "~". Colors match the onedark lualine setup in
# claude/statusline.sh. Grok does not send the editor mode, so this line has
# no mode chip.
#
# Usage: echo '{"workspace":{"current_dir":"/tmp"}}' | bash statusline.sh
set -euo pipefail

input=$(cat)
cwd=$(jq -r '.workspace.current_dir // .cwd // empty' <<<"$input")
branch=$(jq -r '.workspace.branch // empty' <<<"$input")
model=$(jq -r '.model.display_name // .model.id // empty' <<<"$input")
context=$(jq -r '.context_window.used_percentage // empty' <<<"$input")

# short_path replaces a leading $HOME with "~".
short_path() {
  case "$1" in
    "$HOME") printf '~' ;;
    "$HOME"/*) printf '~%s' "${1#"$HOME"}" ;;
    *) printf '%s' "$1" ;;
  esac
}

out=""
if [ -n "$cwd" ]; then
  out+=$(printf '\033[38;2;97;175;239m%s\033[0m' "$(short_path "$cwd")")
fi
if [ -n "$branch" ]; then
  out+=$(printf '  \033[38;2;198;120;221m\xee\x82\xa0 %s\033[0m' "$branch")
fi
if [ -n "$model" ]; then
  out+=$(printf '  \033[38;2;152;195;121m%s\033[0m' "$model")
fi
if [ -n "$context" ]; then
  out+=$(printf '  \033[38;2;229;192;123m%.0f%%\033[0m' "$context")
fi

printf '%s' "$out"
