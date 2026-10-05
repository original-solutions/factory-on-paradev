#!/usr/bin/env bash
# The gate for this repo: the skill loads, and every reference it points at exists.
set -euo pipefail
cd "$(dirname "$0")/.."

bash -n install.sh

[ "$(sed -n '1p' SKILL.md)" = "---" ] || { echo "SKILL.md: no frontmatter"; exit 1; }
grep -qx 'name: factory' SKILL.md || { echo "SKILL.md: name is not factory"; exit 1; }

missing=0
for path in $(grep -ohE 'references/[A-Za-z0-9_./-]+\.md' SKILL.md references/*.md references/reviewers/*.md | sort -u); do
  [ -f "$path" ] || { echo "missing: $path"; missing=1; }
done
exit "$missing"
