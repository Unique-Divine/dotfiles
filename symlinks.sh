#!/usr/bin/env bash
#
# symlinks.sh - Create symlinks from the dotfiles configuration to appropriate
# locations in the users "$HOME" directory.
#
# Dependencies:
#   - $DOTFILES: Path to the dotfiles repository root.
#   - zsh/managed-links.tsv: Source and destination mappings to reconcile.

if [[ -z "${DOTFILES:-}" ]]; then
  echo "ERROR: \$DOTFILES is not set. Run this script through just sync." >&2
  exit 1
fi

manifest_path="$DOTFILES/zsh/managed-links.tsv"
if [[ ! -r "$manifest_path" ]]; then
  echo "ERROR: managed-links manifest is not readable: $manifest_path" >&2
  exit 1
fi

# Create a symbolic link from a canonical dotfiles entry to its runtime path.
# Arguments:
#   - `src`: Canonical file or directory in the dotfiles repository.
#   - `dst`: Path through which programs discover `src`.
# A symbolic-link `src` is skipped to avoid chained links. Otherwise, `ln -sf`
# replaces an existing destination without prompting. If `dst` is a directory,
# the link is created inside it with the basename of `src`.
# Usage: _symlink <source_path> <destination_path>
_symlink() {
  local src="$1"
  local dst="$2"

  if [[ -L "$src" ]]; then
    return 0
  fi

  ln -sf "$src" "$dst"
}

while IFS=$'\t' read -r source_relative destination_relative; do
  [[ -z "$source_relative" || "$source_relative" == \#* ]] && continue

  source_path="$DOTFILES/$source_relative"
  destination_path="$HOME/$destination_relative"
  mkdir -p "$(dirname "$destination_path")"
  _symlink "$source_path" "$destination_path"
done < "$manifest_path"

# Deprecated in favor of skills, as skills are always visible by the Cursor-CLI
# (Command "agent" or "cursor-agent"), while commands are not.
# 
# ```bash
# windows_cursor="/mnt/c/Users/realu/.cursor"
# mkdir -p "$windows_cursor/commands"
# cp "$DOTFILES/cursor/commands"/* "$windows_cursor/commands/"
# 
# mkdir -p ~/.cursor/commands
# cp "$DOTFILES/cursor/commands"/* "$windows_cursor/commands/"
# ```
