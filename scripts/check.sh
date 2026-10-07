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

grep -qF -- 'git push -u origin <branch>' references/commits.md || { echo "references/commits.md: no push after each commit"; exit 1; }
grep -qF -- 'retried once' references/commits.md || { echo "references/commits.md: a failed push is not retried once"; exit 1; }
grep -qF -- 'the branch pushes, the draft PR, and the repo labels' SKILL.md || { echo "SKILL.md: the outside-writes line does not read branch pushes"; exit 1; }
grep -qF -- 'push it and open the draft PR' SKILL.md && { echo "SKILL.md: the stuck path still has its own push instruction"; exit 1; }
grep -qF -- 'until one succeeds' references/commits.md || { echo "references/commits.md: the -u push is not repeated until one succeeds"; exit 1; }
grep -qF -- 'git push' references/ship.md && { echo "references/ship.md: Ship still pushes"; exit 1; }
grep -qF -- 'git rev-parse HEAD origin/<branch>' references/ship.md || { echo "references/ship.md: Ship does not check origin/<branch> against HEAD"; exit 1; }

[ -f references/linear.md ] || { echo "references/linear.md: missing"; exit 1; }
for needle in 'api.linear.app/graphql' 'editedAt' 'displayName' 'references/linear.md'; do
  grep -qF -- "$needle" SKILL.md || { echo "SKILL.md: no $needle"; exit 1; }
done
for needle in 'issueLabels' 'issueLabelCreate' 'teamId' 'Putting one on an issue is not'; do
  grep -qF -- "$needle" references/linear.md || { echo "references/linear.md: no $needle"; exit 1; }
done
for label in 'factory:proposed' 'factory:ready' 'factory:needs-info' 'factory:triage' 'factory:building' 'factory:pr-open' 'factory:stuck'; do
  grep -qF -- "$label" references/linear.md || { echo "references/linear.md: no label $label"; exit 1; }
done
for color in '#c5def5' '#0e8a16' '#d93f0b' '#fbca04' '#1d76db' '#5319e7' '#b60205'; do
  grep -qF -- "$color" references/linear.md || { echo "references/linear.md: no colour $color"; exit 1; }
done
grep -qF -- 'factory/<key lowercased>-<slug>' references/isolate.md || { echo "references/isolate.md: no Linear branch name"; exit 1; }
grep -qF -- 'ENG-42:' references/ship.md || { echo "references/ship.md: no Linear PR title"; exit 1; }
grep -qF -- 'Linear does not say who edited it' SKILL.md || { echo "SKILL.md: no editedAt-comment rule"; exit 1; }
grep -qF -- 'Never print the key' SKILL.md || { echo "SKILL.md: no never-print-the-key rule"; exit 1; }
grep -qF -- 'are Linear display names' SKILL.md || { echo "SKILL.md: no Linear instructor rule"; exit 1; }
grep -qF -- 'Closes <KEY-n>' references/receipt.md || { echo "references/receipt.md: no Linear Closes line"; exit 1; }
grep -qF -- 'comments(first: 100, after: $after)' SKILL.md || { echo "SKILL.md: the Linear read does not page comments"; exit 1; }
grep -qF -- '.errors // .data.issue' SKILL.md || { echo "SKILL.md: the Linear read hides errors"; exit 1; }
grep -qF -- 'a worktree the factory launched keeps its branch' references/isolate.md || { echo "references/isolate.md: the Linear branch name is not scoped to a worktree this run creates (a launched worktree keeps its branch)"; exit 1; }

missing=0
for path in $(grep -ohE 'references/[A-Za-z0-9_./-]+\.md' SKILL.md references/*.md references/reviewers/*.md | sort -u); do
  [ -f "$path" ] || { echo "missing: $path"; missing=1; }
done
exit "$missing"
