#!/usr/bin/env bash
# The gate for this repo: the skill loads, every reference it points at exists,
# the receipt has its Lessons section, the lessons are numbered 1 to n, and
# the retro has its route, its proposal sections, its labels and its result lines.
set -euo pipefail
cd "$(dirname "$0")/.."

bash -n install.sh

[ "$(sed -n '1p' SKILL.md)" = "---" ] || { echo "SKILL.md: no frontmatter"; exit 1; }
grep -qx 'name: factory' SKILL.md || { echo "SKILL.md: name is not factory"; exit 1; }

grep -qx '## Lessons' references/receipt.md || { echo "references/receipt.md: no ## Lessons heading"; exit 1; }

numbers="$(grep -oE '^[0-9]+\.' references/field-lessons.md | tr -d '.' || true)"
expected="$(seq 1 "$(printf '%s\n' "$numbers" | wc -l)")"
[ "$numbers" = "$expected" ] || { echo "references/field-lessons.md: lesson numbers are not 1 to n in order"; exit 1; }

grep -q '/factory retro.*references/retro\.md' SKILL.md || { echo "SKILL.md: no line routes /factory retro to references/retro.md"; exit 1; }
[ -f references/retro.md ] || { echo "references/retro.md: missing"; exit 1; }
for heading in '## Outcome' '## Acceptance criteria' '## Notes' '## Evidence' '## Measure'; do
  grep -qxF -- "$heading" references/retro.md || { echo "references/retro.md: the proposal has no $heading heading"; exit 1; }
done
for needle in 'softfac retro --json --since' 'factory:proposed' 'retro-report' \
  'FACTORY-DONE: <report issue URL>' 'FACTORY-STOP: stuck'; do
  grep -qF -- "$needle" references/retro.md || { echo "references/retro.md: no $needle"; exit 1; }
done
if grep -vE 'never|Never' references/retro.md | grep -qE 'FACTORY-STOP: needs-info|factory:ready'; then
  echo "references/retro.md: names needs-info or factory:ready outside a never rule"; exit 1
fi

missing=0
for path in $(grep -ohE 'references/[A-Za-z0-9_./-]+\.md' SKILL.md references/*.md references/reviewers/*.md | sort -u); do
  [ -f "$path" ] || { echo "missing: $path"; missing=1; }
done
exit "$missing"
