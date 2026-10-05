#!/usr/bin/env bash
# The gate for this repo: the skill loads, every reference it points at exists,
# the receipt has its Lessons section, and the lessons are numbered 1 to n.
set -euo pipefail
cd "$(dirname "$0")/.."

bash -n install.sh

[ "$(sed -n '1p' SKILL.md)" = "---" ] || { echo "SKILL.md: no frontmatter"; exit 1; }
grep -qx 'name: factory' SKILL.md || { echo "SKILL.md: name is not factory"; exit 1; }

grep -qx '## Lessons' references/receipt.md || { echo "references/receipt.md: no ## Lessons heading"; exit 1; }

numbers="$(grep -oE '^[0-9]+\.' references/field-lessons.md | tr -d '.' || true)"
expected="$(seq 1 "$(printf '%s\n' "$numbers" | wc -l)")"
[ "$numbers" = "$expected" ] || { echo "references/field-lessons.md: lesson numbers are not 1 to n in order"; exit 1; }

missing=0
for path in $(grep -ohE 'references/[A-Za-z0-9_./-]+\.md' SKILL.md references/*.md references/reviewers/*.md | sort -u); do
  [ -f "$path" ] || { echo "missing: $path"; missing=1; }
done
exit "$missing"
