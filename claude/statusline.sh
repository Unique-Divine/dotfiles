#!/usr/bin/env bash
# Claude Code status line, styled after the lualine setup in nvim/init.lua.
#
# Reads the session JSON that Claude Code passes on stdin and prints one line:
#   <mode> <path> <branch>
# The vim mode uses the same Japanese labels as lualine (普通 = NORMAL,
# 入れる = INSERT) on onedark colors. The path shortens $HOME to "~". The git
# branch is omitted outside a repository.
#
# Usage: echo '{"workspace":{"current_dir":"/tmp"}}' | bash statusline.sh

input=$(cat)
cwd=$(jq -r '.workspace.current_dir // .cwd // empty' <<<"$input")
mode=$(jq -r '.vim.mode // empty' <<<"$input")

# mode_label maps a Claude Code vim mode to the lualine label.
mode_label() {
  case "$1" in
    NORMAL) echo "普通" ;;
    INSERT) echo "入れる" ;;
    *) echo "$1" ;;
  esac
}

# mode_bg prints the onedark background color for a vim mode as "R;G;B".
mode_bg() {
  case "$1" in
    NORMAL) echo "152;195;121" ;; # green
    INSERT) echo "97;175;239" ;;  # blue
    *) echo "198;120;221" ;;      # purple
  esac
}

# short_path replaces a leading $HOME with "~".
short_path() {
  case "$1" in
    "$HOME") echo "~" ;;
    "$HOME"/*) echo "~${1#"$HOME"}" ;;
    *) echo "$1" ;;
  esac
}

out=""
if [ -n "$mode" ]; then
  out+=$(printf '\033[1;38;2;40;44;52;48;2;%sm %s \033[0m ' \
    "$(mode_bg "$mode")" "$(mode_label "$mode")")
fi

if [ -n "$cwd" ]; then
  out+=$(printf '\033[38;2;97;175;239m%s\033[0m' "$(short_path "$cwd")")
  branch=$(git -C "$cwd" --no-optional-locks branch --show-current 2>/dev/null)
  if [ -z "$branch" ]; then
    branch=$(git -C "$cwd" --no-optional-locks rev-parse --short HEAD 2>/dev/null)
  fi
  if [ -n "$branch" ]; then
    out+=$(printf '  \033[38;2;198;120;221m\xee\x82\xa0 %s\033[0m' "$branch")
  fi
fi

printf '%s' "$out"
