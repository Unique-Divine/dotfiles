#!/usr/bin/env bash
#
# symlinks.sh - Create symlinks from the dotfiles configuration to appropriate
# locations in the users "$HOME" directory.
#
# Dependencies:
#   - $DOTFILES: Path to the dotfiles repository root.
#   - zsh/managed-links.txt: Source and destination mappings to reconcile.
#   - zsh/retired-links.txt: Mappings sync used to create, to remove.

if [[ -z "${DOTFILES:-}" ]]; then
  echo "ERROR: \$DOTFILES is not set. Run this script through just sync." >&2
  exit 1
fi

manifest_path="$DOTFILES/zsh/managed-links.txt"
if [[ ! -r "$manifest_path" ]]; then
  echo "ERROR: managed-links manifest is not readable: $manifest_path" >&2
  exit 1
fi

# Create a symbolic link from a canonical dotfiles entry to its runtime path.
# Arguments:
#   - `src`: Canonical file or directory in the dotfiles repository.
#   - `dst`: Path through which programs discover `src`.
# A symbolic-link `src` is skipped to avoid chained links. Otherwise, `ln -sfn`
# replaces an existing destination without prompting and does not follow a
# destination symlink to a directory.
# Usage: _symlink <source_path> <destination_path>
_symlink() {
  local src="$1"
  local dst="$2"

  if [[ -L "$src" ]]; then
    return 0
  fi

  ln -sfn "$src" "$dst"
}

while IFS=' ' read -r source_relative destination_relative; do
  [[ -z "$source_relative" || "$source_relative" == \#* ]] && continue

  source_path="$DOTFILES/$source_relative"
  destination_path="$HOME/$destination_relative"
  mkdir -p "$(dirname "$destination_path")"
  _symlink "$source_path" "$destination_path"
done < "$manifest_path"

# Remove links that sync used to create and no longer manages
# (zsh/retired-links.txt). Only a symlink that still resolves to its
# recorded source is removed, so a replacement someone made stays.
retired_path="$DOTFILES/zsh/retired-links.txt"
if [[ -r "$retired_path" ]]; then
  while IFS=' ' read -r source_relative destination_relative; do
    [[ -z "$source_relative" || "$source_relative" == \#* ]] && continue

    destination_path="$HOME/$destination_relative"
    [[ -L "$destination_path" ]] || continue
    # readlink -f prints nothing when a parent folder is missing; two empty
    # results must not count as a match.
    destination_target="$(readlink -f -- "$destination_path" || true)"
    source_target="$(readlink -f -- "$DOTFILES/$source_relative" || true)"
    if [[ -n "$source_target" && "$destination_target" == "$source_target" ]]
    then
      if rm -f -- "$destination_path"; then
        echo "removed retired link: $destination_path"
      else
        echo "WARNING: could not remove retired link: $destination_path" >&2
      fi
    fi
  done < "$retired_path"
fi

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
