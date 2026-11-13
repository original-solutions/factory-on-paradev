#!/usr/bin/env bash
# Install this skill into the active skills hub (~/.agents/skills).
set -euo pipefail
SOURCE_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILL_NAME="$(basename "$SOURCE_DIR")"
HUB="${AGENTS_SKILLS_HUB:-$HOME/.agents/skills}"
target="$HUB/$SKILL_NAME"

mkdir -p "$HUB"
if [ -L "$target" ]; then
  rm "$target"
elif [ -e "$target" ]; then
  mkdir -p "$HUB/.backups"
  mv "$target" "$HUB/.backups/$SKILL_NAME.bak.$(date +%s)"
  echo "Backed up existing $SKILL_NAME"
fi
ln -s "$SOURCE_DIR" "$target"
echo "Installed $SKILL_NAME -> $target (skills hub)"
