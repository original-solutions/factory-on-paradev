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
expected="$( [ -n "$numbers" ] && seq 1 "$(printf '%s\n' "$numbers" | wc -l)" || true )"
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

# A repo with project_config: softfac's launch message names the config file, and the run reads every key from it.
grep -qF -- 'on this machine, not in .dw/config.yml: read `factory` from that file' SKILL.md || { echo "SKILL.md: no launch-named config file sentence"; exit 1; }
grep -qF -- 'the file the launch message names' references/models.md || { echo "references/models.md: models is not read from the launch-named config file"; exit 1; }

# Scratch lives in .factory/ at the worktree root, never in /tmp, and never reaches a commit.
grep -qx '## Scratch' SKILL.md || { echo "SKILL.md: no ## Scratch heading"; exit 1; }
for needle in '`.factory/`' '`/tmp`' '`$TMPDIR`' '.factory/.gitignore' 'node_modules/' 'target/' \
  'the factory removes the worktree'; do
  grep -qF -- "$needle" SKILL.md || { echo "SKILL.md: no $needle"; exit 1; }
done
for path in references/receipt.md references/ship.md references/review.md references/isolate.md; do
  grep -qF -- '.factory/' "$path" || { echo "$path: does not point at .factory/"; exit 1; }
done
if grep -HE '/tmp|\$TMPDIR|temp dir|tempfile' SKILL.md \
  $(ls references/*.md | grep -v field-lessons) | grep -vE 'never (in|into|under) |Nothing of a run goes under '; then
  echo "a skill file names /tmp, \$TMPDIR or a temp dir outside a never rule"; exit 1
fi

# Review: the review-gate-v2 CLI is the grader. The session runs it, reads verdict.json, never grades or settles itself.
for needle in 'python3 -P -m review_gate review' '--maker-model' '--full' '--format json' '--out .factory/review/round-' \
  'REVIEW_GATE_V2_HOME' 'Never fall back to a self-run review' 'nohup' 'for i in 1 2 3 4' \
  '`verdict.head` must equal' 'the pair (open blockers, open actions)' 'A run never calls `settle` on its own word' \
  'review_gate settle <id> --reason "instructor' 'references/mutation.md' 'rm -rf .factory/review/round-<n>' '.personas.failed' \
  '.factory/rg-home' 'no `verdict.json` beside it' 'review/$(git branch --show-current' 'already names the tip' 'kill -0' '60 minutes'; do
  grep -qF -- "$needle" references/review.md || { echo "references/review.md: no $needle"; exit 1; }
done
if grep -qE 'dispatch|packet|seat|panel|blind-reader|traceability' references/review.md; then
  echo "references/review.md: still describes the skill's own panel"; exit 1
fi
# The limit stop reads the verdict's failed reviewers, not stderr, which the CLI never writes failures to.
grep -E 'reviewers_failed.*reason.*(429|limit|reset)|reason.*(429|limit|reset).*reviewers_failed' references/review.md >/dev/null || { echo "references/review.md: the limit stop does not read reviewers_failed[].reason"; exit 1; }
if grep -qE '429 in `stderr.log`' references/review.md references/check.md; then echo "the limit stop still reads stderr.log"; exit 1; fi
# Check: a loop of review-gate rounds, with the stops that end it.
for needle in 'review round' 'round == 5' 'two rounds without progress' '`git merge origin/<base>`' \
  'references/mutation.md' 'An incomplete round is not saved' 'Any commit after `done`' 'counts toward the cap'; do
  grep -qF -- "$needle" references/check.md || { echo "references/check.md: no $needle"; exit 1; }
done
if grep -qiE 'cycle|panel|checker model' references/check.md; then
  echo "references/check.md: still speaks of cycles or a panel"; exit 1
fi
# The rest of the skill speaks of review-gate rounds, not the panel's cycles.
grep -qF -- 'review-gate-v2' SKILL.md || { echo "SKILL.md: the description does not name review-gate-v2"; exit 1; }
if grep -n -iE 'persona-review|review cycle|cycles|a panel|checker model' SKILL.md references/make.md references/weight.md references/models.md references/receipt.md | grep -v 'references/field-lessons.md'; then
  echo "a skill file still speaks of cycles, a panel or persona review"; exit 1
fi
for needle in '- rounds: n' '- open: none' '- report:' '- reviewers: review-gate-v2' '- incomplete: none'; do
  grep -qF -- "$needle" references/receipt.md || { echo "references/receipt.md: no $needle"; exit 1; }
done
grep -qF -- 'the mutation pass' references/models.md || { echo "references/models.md: the checker is not scoped to the mutation pass"; exit 1; }
# The mutation pass is the one brief the skill keeps; review-gate reads code and this pass executes it.
[ -f references/mutation.md ] || { echo "references/mutation.md: missing"; exit 1; }
[ ! -d references/reviewers ] || { echo "references/reviewers/: the skill's own panel briefs are still here"; exit 1; }
for needle in 'At most 12 mutants' '20 minutes' 'detached worktree' 'git checkout -- <path>' \
  'Never the whole suite' 'mutation: killed n, survived n, unreached n' 'the test that should have failed'; do
  grep -qF -- "$needle" references/mutation.md || { echo "references/mutation.md: no $needle"; exit 1; }
done
grep -qF -- '- settled:' references/receipt.md || { echo "references/receipt.md: no settled line under Review"; exit 1; }
# GitHub account: pick by write access, fall back to another login without switching, and stop naming every login's orgs.
for needle in '## GitHub account' 'gh api repos/<owner/repo> --jq .permissions.push' 'GH_TOKEN=$(gh auth token --user <login>)' \
  "credential.helper=!gh auth git-credential" 'Never run `gh auth switch`' 'never print, echo or export its value' \
  'No login prints `true` → stop `stuck`' "GH_TOKEN=\$(gh auth token --user <login>) gh api user/orgs --jq '.[].login'"; do
  grep -qF -- "$needle" SKILL.md || { echo "SKILL.md: no $needle"; exit 1; }
done
for f in $(grep -lE '(^|[ `(])gh (api|pr|issue|label|run|repo)|git (push|fetch|clone|ls-remote|pull)' references/*.md); do
  grep -qF -- '`SKILL.md` § GitHub account' "$f" || { echo "$f: a GitHub command with no pointer to SKILL.md § GitHub account"; exit 1; }
done
grep -qF -- '- account: <login>' references/receipt.md || { echo "references/receipt.md: no account line under Gate"; exit 1; }

missing=0
for path in $(grep -ohE 'references/[A-Za-z0-9_./-]+\.md' SKILL.md references/*.md | sort -u); do
  [ -f "$path" ] || { echo "missing: $path"; missing=1; }
done
exit "$missing"
