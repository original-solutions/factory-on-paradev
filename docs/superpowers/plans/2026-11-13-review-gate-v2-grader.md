# review-gate-v2 as the factory's grader: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The `/factory` skill's Check step runs the review-gate-v2 CLI in author mode until it says `done`, so a factory PR reaches the same 5/5 the separate review loop reaches today, and the skill's own reviewer panel is deleted.

**Architecture:** `references/review.md` stops describing a panel the session dispatches itself and instead gives the exact `review_gate review` command, how to wait for it, how to read `verdict.json`, and the stop rules. `references/check.md` keeps its loop shape (tests → review → Make → commit → review) with "round" in place of "cycle" and `--full` on every round. The mutation pass stays, since review-gate has none, and moves to `references/mutation.md`. `references/reviewers/` goes. `scripts/check.sh`, the repo's gate, pins each of these facts.

**Tech Stack:** Markdown skill files; bash (`scripts/check.sh`); the review-gate-v2 CLI (`python3 -P -m review_gate`, Python 3.11+) from the `tc-review-gate` checkout; `jq`.

**Spec:** this plan's § Why and § Requirements below. There is no separate spec document; the diagnosis is in the chat of 2026-11-13.

## Why

The factory never ran review-gate. Its Check step ran `references/review.md`, a prose copy of review-gate's method (same door/risk call, same blocker/action/nit contract, same 1 to 5 score, same seat names) executed by the maker's own session dispatching subagents. So each PR was graded twice by two graders with one rubric, and only review-gate's grade was independent. Four mechanisms made the self-grade come out higher: the graded party chose the roster, combined and dropped findings and could settle actions itself; a reviewer that returned nothing was marked `incomplete` on the receipt and the panel carried on, so under machine load a panel passed with seats missing; later cycles read only the narrow diff; and the two panels ran different personas on different models. A score belongs to the pair (code, grader), so the inner loop can only match the outer loop by running the same grader.

## Requirements

1. Check (M and L weights) runs `review_gate review` on the worktree's tip, with `--base origin/<base>`, `--maker-model <maker id>`, `--full`, `--format json`, `--out` under `.factory/`, and the issue title and body as `--title` and `--body`.
2. The round runs in the background with its exit code in a file, and the session waits in bounded foreground polls, so no single harness call outlives its cap and the turn never ends before the result line.
3. The session reads only `verdict.json` (`status`, `score`, `head`, `counts`, `findings`, `door`, `risk`, `report.markdown`). `verdict.head` must equal `git rev-parse HEAD`, else the round is discarded and run again.
4. Open blockers and actions become the next Make packet verbatim (`id`, `severity`, `title`, `sites`, `scenario`, `fix`). Nits only when cheap and inside the contract's `files`.
5. Stop rules: `done` → mutation pass → live → Gate. `open` → fix, commit, round again. Round cap 5. Two consecutive saved rounds that do not improve the pair (open blockers, open actions) → stop `stuck`. `incomplete` → run again as it is, once; two in a row → stop `stuck` naming the failed reviewers. A 429 that names a reset time → stop `stuck` naming it, no retry.
6. A run never calls `settle` on its own word. An instructor comment with a `settled: <id> — <reason>` line is applied with `review_gate settle <id> --reason "instructor <login>: <reason>"`.
7. The CLI is found at `$REVIEW_GATE_V2_HOME`, else two folders above `~/.claude/skills/review-gate` resolved with `cd -P`. Neither present, or `python3 -P` rejected → stop `stuck` naming the path tried. Never fall back to a self-run review.
8. The mutation pass (`references/reviewers/mutation.md`) is kept as `references/mutation.md`, dispatched on the checker model as before, once, after `done`.
9. `references/reviewers/` is deleted. `references/review.md` describes only the CLI round. Every mention of "cycle", "panel", "seat" and "persona-review" in `SKILL.md`, `check.md`, `make.md`, `models.md`, `receipt.md`, `weight.md` changes to the new words.
10. The receipt's `## Review` lists each saved round as `round n: <score>/5 (b/a)`, the final `door` and `risk`, `fixed` ids, `open` ids with one line each, `incomplete` reviewers, `mutation`, and the round's `report.markdown` path.
11. `scripts/check.sh` asserts every fact above that a grep can pin, and `bash scripts/check.sh` exits 0.

## Global Constraints

- The skill is read by a dark session: no questions, every message ends with a result line (`SKILL.md` § Stops). Nothing in the new text may ask the person anything.
- Scratch stays under `<worktree>/.factory/` (`SKILL.md` § Scratch). No `/tmp`, no `$TMPDIR` outside a never rule; `scripts/check.sh` greps for it.
- Every reference that runs a GitHub-reaching command names `` `SKILL.md` § GitHub account `` (check.sh enforces it). `git fetch origin` in `review.md` and `check.md` does.
- A run never writes to the directory the skill was loaded from; lessons go on the receipt. This plan changes the skill through a pull request only.
- `references/field-lessons.md` numbering stays 1 to n (check.sh). Do not renumber or delete lessons; leave the file alone.
- Commit messages carry the change only: no `Co-Authored-By`, no harness byline. Commit with plain `git commit`.
- The repo's gate is `bash scripts/check.sh` (`.dw/config.yml`). Run it before every commit.

## Review Focus

Five failure modes the requirements imply but no step's own run exercises, each pinned by a `check.sh` assertion in the task named:

1. The CLI is missing on the machine (a new host, a cloud box): the run must stop `stuck` naming the path it tried, never quietly review itself. Task 1 asserts `Never fall back to a self-run review`.
2. A round runs past the harness's ten-minute call cap: the session must background it and poll in bounded waits, or the turn ends with no result line and the factory reads a failure. Task 1 asserts the `nohup` start and the `for i in 1 2 3 4` poll.
3. The maker commits while a round runs: `verdict.head` is stale and the findings name lines that moved. Task 1 asserts `verdict.head` must equal the tip.
4. Reviewers die on a weekly 429: a retry loop burns the run's clock. Task 2 asserts the 429 stop.
5. A reviewer is wrong and the run "fixes" it by settling: the grade is self-graded again. Task 1 asserts `A run never calls settle on its own word`.

---

### Task 1: `references/review.md` becomes the review-gate-v2 round

**Files:**
- Modify: `references/review.md` (replace the whole file)
- Modify: `scripts/check.sh:81-85` (the review assertions)
- Test: `scripts/check.sh`

**Interfaces:**
- Consumes: `references/models.md` (the maker id), `SKILL.md` § Scratch (`.factory/`), § GitHub account.
- Produces: the round command, the verdict read, the stop rules and the Make packet shape that Task 2's `check.md` and Task 4's `receipt.md` refer to by these names: `round`, `verdict.json`, `the pair (open blockers, open actions)`, `references/mutation.md`.

- [ ] **Step 1: Write the failing assertions**

Replace lines 81 to 85 of `scripts/check.sh` (the block from `# Review: a gate call, an independent blind reader` through its `done`) with:

```bash
# Review: the review-gate-v2 CLI is the grader. The session runs it, reads verdict.json, never grades or settles itself.
for needle in 'python3 -P -m review_gate review' '--maker-model' '--full' '--format json' '--out .factory/review/round-' \
  'REVIEW_GATE_V2_HOME' 'Never fall back to a self-run review' 'nohup' 'for i in 1 2 3 4' \
  '`verdict.head` must equal' 'the pair (open blockers, open actions)' 'A run never calls `settle` on its own word' \
  'review_gate settle <id> --reason "instructor' 'references/mutation.md'; do
  grep -qF -- "$needle" references/review.md || { echo "references/review.md: no $needle"; exit 1; }
done
if grep -qE 'dispatch|packet|seat|panel|blind-reader|traceability' references/review.md; then
  echo "references/review.md: still describes the skill's own panel"; exit 1
fi
```

- [ ] **Step 2: Run the gate to see it fail**

Run: `bash scripts/check.sh`
Expected: `references/review.md: no python3 -P -m review_gate review`, exit 1.

- [ ] **Step 3: Write the new `references/review.md`**

Replace the file's whole content with:

````markdown
# Review

Load at Check step 2. One review round is: run the review-gate-v2 CLI on the tip → read its verdict → hand the open findings to Make. The CLI is the grader. The session never grades, combines, drops or settles a finding itself.

## 1. Find the CLI

Once per run, before the first round:

```bash
RG="${REVIEW_GATE_V2_HOME:-$(cd -P "$HOME/.claude/skills/review-gate/../.." 2>/dev/null && pwd)}"
[ -f "$RG/review_gate/__main__.py" ] && python3 -P -c 'import sys; sys.exit(sys.version_info < (3, 11))'
```

Either check failing → stop `stuck`, naming `$RG` and the Python version. Never fall back to a self-run review: a run with no grader ships nothing.

## 2. Run a round

The tree is clean at the tip and the maker is idle. `n` is the round number, starting at 1. `.factory/issue-title.txt` and `.factory/issue-body.md` hold the issue's title and body as Read copied them; write them at the first round if Read did not.

```bash
cd <worktree> && git fetch origin <base>        # `SKILL.md` § GitHub account
mkdir -p .factory/review/round-<n>
nohup sh -c 'PYTHONPATH="'"$RG"'" python3 -P -m review_gate review \
  --base origin/<base> --maker-model <maker id from references/models.md> --full \
  --title "$(cat .factory/issue-title.txt)" --body "$(cat .factory/issue-body.md)" \
  --out .factory/review/round-<n> --format json \
  > .factory/review/round-<n>/stdout.json 2> .factory/review/round-<n>/stderr.log; echo $? > .factory/review/round-<n>/exit' \
  > /dev/null 2>&1 &
```

`--full` every round: the whole `base...tip` diff is read each time, so a fix is judged beside the code it changes, and round count, ids and settles are kept. `--maker-model` puts the reviewers on another model family than the maker's.

Then wait in the same turn, in bounded polls, until the exit file exists:

```bash
for i in 1 2 3 4; do [ -f .factory/review/round-<n>/exit ] && break; sleep 30; done; cat .factory/review/round-<n>/exit 2>/dev/null
```

Repeat that command until it prints a number. Never end the turn while it is empty (`SKILL.md` § Stops). If it stays empty and `pgrep -f 'review_gate review'` finds nothing, the CLI died: read the last lines of `stderr.log` and stop `stuck` with them.

## 3. Read the verdict

Read `.factory/review/round-<n>/verdict.json` and nothing else from the round: not `events.jsonl`, not `report.md`, not `stdout.json`.

```bash
jq '{status, score, head, door: .door.kind, risk, counts, report: .report.markdown,
     open: [.findings[] | select(.status == "open" and (.severity == "blocker" or .severity == "action"))
            | {id, severity, title, sites, scenario, fix}],
     reviewers_failed: [.report.reviewers[]? | select(.status != "done") | .name]}' .factory/review/round-<n>/verdict.json
```

- `verdict.head` must equal `git rev-parse HEAD`. A mismatch means something committed while the round ran: the round is discarded (not counted toward the cap) and run again on the tip.
- Exit 2 or 4: there is no verdict. Stop `stuck` with the last line of `stderr.log`.
- `status: done` (exit 0): score 5, nothing open. On to `references/mutation.md`, then Check § 5 Live.
- `status: open` (exit 1): the open blockers and actions go to Make (§ 4), then the next round.
- `status: incomplete` (exit 1): reviewers failed, not the code. Run the same round again as it is, once; an incomplete round is not saved, so it spends no round. Two incomplete in a row → stop `stuck`, naming `reviewers_failed`. A 429 in `stderr.log` that names a reset time → stop `stuck` at once, naming the time; a retry before it fails the same way.

Receipt fields: `references/receipt.md` § Review. Every saved round's `score` and pair go there as they happen, so a stop still shows the trail.

## 4. Open findings to Make

The open blockers and actions, verbatim from the verdict (`id`, `severity`, `title`, `sites`, `scenario`, `fix`), are one combined Make packet (`references/make.md` § Findings from Check). Blockers cannot be skipped. A fix covers every place the finding's rule applies, not only the first site. Nits go in only when the fix is a few lines inside the contract's `files`; otherwise they are listed on the receipt. The fix text is a reviewer's guess: read the code at the sites first, and when the fix needs data the code does not hold, change the source of that data rather than patching around it.

When Make is green, commit the round's fixes (`references/commits.md`, `fix: review round <n>`) before the next round. A finding is fixed when the next round's verdict no longer lists it, never when the maker says so.

A finding the run disagrees with stays open. Say why in one line on the receipt. A run never calls `settle` on its own word. The one exception: an instructor comment on the issue (`SKILL.md` § Issue) holding a line `settled: <id> — <reason>` is applied before the next round with `PYTHONPATH="$RG" python3 -P -m review_gate settle <id> --reason "instructor <login>: <reason>"`, from the worktree, and the receipt lists it under `settled`.

## 5. Progress and the cap

Round n improves on round n-1 when it has fewer open blockers, or the same open blockers and fewer open actions: the pair (open blockers, open actions), blockers first. A new blocker where there was none is never progress. Two consecutive saved rounds that do not improve → stop `stuck` and list the open ids. Round 5 ending `open` → stop `stuck`. The `stuck` rules in `SKILL.md` § Stops still open the draft PR when the branch is coherent, with the open findings on its receipt, so nobody mistakes it for clean.

Score for the receipt is the verdict's `score`: 5 nothing open, 4 one or two actions, 3 three or more actions, 2 a blocker, 1 a blocker in `security` or `data`.

## 6. After `done`

The mutation pass, `references/mutation.md`, once per issue, on the tip that ships. review-gate reads code; the pass executes it, so the two never replace each other. Then Check § 5 Live, then Gate.
````

- [ ] **Step 4: Run the gate**

Run: `bash scripts/check.sh`
Expected: the review block passes; the next failure is `references/reviewers/mutation.md: missing` is **not** yet expected (the seat loop still finds the files). The run should now fail at `missing: references/mutation.md` from the final path sweep, exit 1. That is Task 3's job; if any other line fails, fix `review.md` until only that one remains.

- [ ] **Step 5: Commit**

```bash
git add references/review.md scripts/check.sh
git commit -m "feat: the review round is a review-gate-v2 CLI round, read from verdict.json"
```

(The gate is red only on the missing `references/mutation.md`, which the next two tasks add. Commit anyway so the round text has its own commit; Task 3 turns the gate green.)

---

### Task 2: `references/check.md` loops on rounds

**Files:**
- Modify: `references/check.md` (replace the whole file)
- Modify: `scripts/check.sh` (append assertions after the review block)
- Test: `scripts/check.sh`

**Interfaces:**
- Consumes: Task 1's names: `round`, `verdict.json`, `the pair (open blockers, open actions)`, `references/mutation.md`.
- Produces: the Check loop that `SKILL.md` § Weight and § Hard rules (Task 4) describe in one line each.

- [ ] **Step 1: Write the failing assertions**

Append to `scripts/check.sh`, directly after the review block from Task 1:

```bash
# Check: a loop of review-gate rounds, with the stops that end it.
for needle in 'review round' 'round == 5' 'two rounds without progress' '`git merge origin/<base>`' \
  'references/mutation.md' 'a 429' 'An incomplete round is not saved'; do
  grep -qF -- "$needle" references/check.md || { echo "references/check.md: no $needle"; exit 1; }
done
if grep -qiE 'cycle|panel|checker model' references/check.md; then
  echo "references/check.md: still speaks of cycles or a panel"; exit 1
fi
```

- [ ] **Step 2: Run the gate to see it fail**

Run: `bash scripts/check.sh`
Expected: `references/check.md: no review round`, exit 1.

- [ ] **Step 3: Write the new `references/check.md`**

Replace the file's whole content with:

````markdown
# Check

Load at step 5. This is a loop, not a report.

```text
tests green
  → review round (references/review.md: run the CLI → read verdict.json)
      → done → mutation pass → live → Gate
      → open → Make → tests → commit → review round
until: done | round == 5 | two rounds without progress | two incomplete rounds in a row | a 429 naming a reset time
```

## 1. Tests

Run the contract `test:` command from the worktree. Red → Make (counts toward Make's 3-strike, not the review rounds). One unexplained failure in many runs is red too: find the cause (a parallel test, an inherited handle, a timing bound) and prove the fix with 30 or more consecutive green runs at the tip.

**S mechanical:** green (or no tests needed, say why) → Gate. No review round.

## 2. Review (M/L)

Load `references/review.md` and run one round on the tip. The reviewers' model is the CLI's choice, steered off the maker's family by `--maker-model` (`references/models.md`).

## 3. Feed into Make

The round's open blockers and actions, with their ids, are the next Make contract. Blockers cannot be skipped. Re-run tests.

When that Make is green, commit the round's fixes (`references/commits.md`, `fix:`) **before** the next round. The next round re-reads the whole diff at the tip that includes the fixes; a finding is fixed when its id is gone from the verdict, not when the maker says so.

## 4. Round

Before each round, `git fetch origin` (`SKILL.md` § GitHub account); when `origin/<base>` moved (another PR landed), `git merge origin/<base>`, re-run tests and commit, so the reviewers and the gate see the merged tree rather than a conflict on the files every change touches. Every round passes `--full`, so a merged base is read with the change, never as part of it.

Round 1 is the first saved round. `done` → the mutation pass (`references/mutation.md`), then § 5 Live, then Gate. `open` → Make, then the next round. An incomplete round is not saved and does not count: run it again once as it is.

**Stop `stuck`**, listing the open ids and the last report path, when: round 5 ends `open`; two consecutive saved rounds do not improve the pair (open blockers, open actions), as `references/review.md` § 5 defines it; two rounds in a row end `incomplete`; or `stderr.log` shows a 429 that names a reset time. Do not open a "good enough" PR as if it were clean: the `stuck` path in `SKILL.md` § Stops opens the draft with the open findings on its receipt.

## 5. Live

An acceptance criterion with no test (docs, visual): verify it yourself and note `screenshot <path>` or `verified <file:line>` on the receipt.

A UI or API criterion: run it once through its real entry point with data shaped like the contract's own examples, from a detached worktree at the tip. Whatever breaks becomes a failing test first, then Make.

A reviewer's note that nothing in the repo shows what an outside system returns for a repeated call is a live check, not a nit: makers and reviewers only have fakes. Call it twice against the real system before the fix round closes and give the maker the exact responses.

Receipt fields: `references/receipt.md` § Review.
````

- [ ] **Step 4: Run the gate**

Run: `bash scripts/check.sh`
Expected: the check block passes; the remaining failure is still `missing: references/mutation.md` (Task 3), exit 1, and nothing else.

- [ ] **Step 5: Commit**

```bash
git add references/check.md scripts/check.sh
git commit -m "feat: Check loops on review-gate rounds until done, with the stops that end it"
```

---

### Task 3: the mutation pass moves, the reviewer briefs go

**Files:**
- Move: `references/reviewers/mutation.md` → `references/mutation.md`
- Delete: `references/reviewers/` (the other ten briefs)
- Modify: `references/mutation.md` (its first lines name the packet; make it self-contained)
- Modify: `scripts/check.sh:86-89` (the seat loop and the blind-reader line), `:76` (the /tmp grep), `:103` (the path sweep)
- Test: `scripts/check.sh`

**Interfaces:**
- Consumes: `references/review.md` § 6 and `references/check.md` § 4 (Tasks 1 and 2) point at `references/mutation.md`.
- Produces: `references/mutation.md`, the one reviewer brief left, with its packet rules at the top.

- [ ] **Step 1: Write the failing assertions**

In `scripts/check.sh`, replace these three lines

```bash
for seat in correctness blind-reader traceability testing security api-contract reliability maintainability docs adversarial mutation; do
  [ -f "references/reviewers/$seat.md" ] || { echo "references/reviewers/$seat.md: missing"; exit 1; }
done
grep -qF -- 'no issue, no contract, no commit messages' references/reviewers/blind-reader.md || { echo "references/reviewers/blind-reader.md: the blind reader is told the story"; exit 1; }
```

with

```bash
# The mutation pass is the one brief the skill keeps; review-gate reads code and this pass executes it.
[ -f references/mutation.md ] || { echo "references/mutation.md: missing"; exit 1; }
[ ! -d references/reviewers ] || { echo "references/reviewers/: the skill's own panel briefs are still here"; exit 1; }
for needle in 'At most 12 mutants' '20 minutes' 'detached worktree' 'git checkout -- <path>' 'class `cannot-fail`' \
  'Never the whole suite'; do
  grep -qF -- "$needle" references/mutation.md || { echo "references/mutation.md: no $needle"; exit 1; }
done
```

Then change the `/tmp` grep's file list from `SKILL.md references/reviewers/*.md \` to `SKILL.md \`, and the final path sweep from `SKILL.md references/*.md references/reviewers/*.md` to `SKILL.md references/*.md`.

- [ ] **Step 2: Run the gate to see it fail**

Run: `bash scripts/check.sh`
Expected: `references/mutation.md: missing`, exit 1.

- [ ] **Step 3: Move the brief and delete the rest**

```bash
git mv references/reviewers/mutation.md references/mutation.md
git rm -q references/reviewers/*.md
```

- [ ] **Step 4: Make `references/mutation.md` self-contained**

The brief was written for a packet the panel's orchestrator built. Insert, between the `# Mutation pass` heading and the line `Asks: **do the tests actually fail when the code is wrong?**`, this section so the orchestrator knows how to dispatch it:

````markdown
## Dispatch

Once per issue, after a round ends `done`, on the tip that ships. The orchestrator (this session) runs it; the maker is idle.

1. Make the detached worktree: `cd <worktree> && git worktree add --detach .factory/mutation "$(git branch --show-current)"`, with its own dependency directory as `SKILL.md` § Scratch says, and run the suite once for green.
2. Name at most 12 mutants, each a one-line change to production code: first the places the last verdict's `testing` findings named as untestable, then the diff's riskiest decisions (a skipped check, a wrong order, a leak into public text).
3. Dispatch one read-write subagent on the checker model (`references/models.md`) with the text below this section, the worktree path, the mutant list, the test filter command, and 20 minutes of wall clock. Foreground; wait for its report in the same turn (`SKILL.md` § Stops).
4. A surviving mutant is a blocker: the test that should have failed, with the mutant as its scenario. Surviving mutants go to Make as one packet; the next review round confirms the tests. Unreached mutants are listed on the receipt, not chased.
5. Remove the worktree: `git worktree remove .factory/mutation`.

When the last fix round was a few lines you can read, read the diff and skip the pass; say so on the receipt.

## The brief
````

Then check the needles the assertion names exist in the brief's text as it stands. `At most 12 mutants`, `20 minutes`, `git checkout -- <path>`, `class `cannot-fail``, `Never the whole suite` appear in the current file; `detached worktree` appears in the Dispatch section above. If any phrase differs in case or wording in the moved file, change the file, not the assertion, so the phrase reads exactly as asserted.

- [ ] **Step 5: Run the gate**

Run: `bash scripts/check.sh`
Expected: exit 0. If the path sweep reports `missing: references/reviewers/...`, a reference still names a deleted brief: `git grep -n 'references/reviewers/'` and fix each hit to `references/mutation.md` or remove it.

- [ ] **Step 6: Commit**

```bash
git add -u references scripts/check.sh
git add references/mutation.md
git commit -m "refactor: keep the mutation pass as references/mutation.md and drop the panel's reviewer briefs"
```

---

### Task 4: every other file speaks of rounds and the CLI

**Files:**
- Modify: `SKILL.md:4-8` (description), `:32` (Check row), `:136` (Weight table), `:164` (Stops table), `:184` (Hard rules)
- Modify: `references/models.md:26-31` (the Checker rule)
- Modify: `references/receipt.md:32-45` (`## Models`, `## Review`)
- Modify: `references/make.md:17`
- Modify: `references/weight.md:18`
- Modify: `scripts/check.sh` (append assertions)
- Test: `scripts/check.sh`

**Interfaces:**
- Consumes: the words Tasks 1 to 3 settled: `review round`, `review-gate-v2`, `references/mutation.md`, `the pair (open blockers, open actions)`.
- Produces: the receipt's `## Review` block that Ship copies into the PR body.

- [ ] **Step 1: Write the failing assertions**

Append to `scripts/check.sh` after Task 2's block:

```bash
# The rest of the skill speaks of review-gate rounds, not the panel's cycles.
grep -qF -- 'review-gate-v2' SKILL.md || { echo "SKILL.md: the description does not name review-gate-v2"; exit 1; }
if grep -n -iE 'persona-review|review cycle|cycles|a panel|checker model' SKILL.md references/make.md references/weight.md references/models.md references/receipt.md | grep -v 'references/field-lessons.md'; then
  echo "a skill file still speaks of cycles, a panel or persona review"; exit 1
fi
for needle in '- rounds: n' '- open: none' '- report:' '- reviewers: review-gate-v2' '- incomplete: none'; do
  grep -qF -- "$needle" references/receipt.md || { echo "references/receipt.md: no $needle"; exit 1; }
done
grep -qF -- 'the mutation pass' references/models.md || { echo "references/models.md: the checker is not scoped to the mutation pass"; exit 1; }
```

- [ ] **Step 2: Run the gate to see it fail**

Run: `bash scripts/check.sh`
Expected: `SKILL.md: the description does not name review-gate-v2`, exit 1.

- [ ] **Step 3: Edit `SKILL.md`**

Description (lines 4 to 8): change `persona-review, run the project gate, open a draft PR.` to `review with review-gate-v2 until it says done, run the project gate, open a draft PR.`

Step table, the Check row:

```markdown
| 5 Check | `references/check.md` then `references/review.md`; after a fix round, `references/commits.md` before the next round |
```

Weight table, the Check row:

```markdown
| Check | Tests if needed | Review round → fix (commit) → round, until review-gate says done, max 5 | Same |
```

Stops table, the `FACTORY-STOP: stuck` row's When cell: change `review cap at 5` to `review round cap at 5 or no progress`.

Hard rules, the line `- Maker does not grade M/L. Findings go back into Make until score 5, 5 cycles, or two cycles without progress.` becomes:

```markdown
- Maker does not grade M/L, and neither does this session: review-gate-v2 does. Its open findings go back into Make until it says done, round 5, or two rounds without progress. A run never settles a finding on its own word.
```

- [ ] **Step 4: Edit `references/models.md`**

Replace rules 2 to 4 under `## Resolve`:

```markdown
2. **Checker** = first `available` key **other than** `default`, if any. The mutation pass's worker runs on it (`references/mutation.md`). The review rounds do not use it: review-gate-v2 picks its own reviewers' model, and `--maker-model <maker id>` keeps them off the maker's family.
3. If the checker's `via` is unusable this session, fall back to default and set `checker: default (peer unavailable)` on the receipt.
4. One provider only → the mutation worker is the same model, different instructions. Still dispatch it. Not a skip.
```

- [ ] **Step 5: Edit `references/receipt.md`**

Replace the `## Models` and `## Review` blocks inside the template with:

```markdown
## Models
- maker: <id>
- checker: <id> | default (peer unavailable)   (the mutation pass)
- reviewers: review-gate-v2, --maker-model <maker id>

## Review
- door: one-way | two-way — <reason from the last verdict>
- risk: high | low — <reason from the last verdict>
- rounds: n — round 1: <score>/5 (b/a) → round n: <score>/5 (b/a)
- fixed: none | <id>, <id>
- open: none | <id> <severity> — <title>; <one line why it is still open>
- settled: none | <id> — instructor <login>: <reason>
- incomplete: none | round <n>: <reviewer>, <reviewer>
- mutation: skipped (<reason>) | killed n, survived n, unreached n
- report: .factory/review/round-<n>/report.md (removed with the worktree; the rounds above are the record)
```

Also change the `## Commits` template line `Check cycle n` to `Check round n`.

- [ ] **Step 6: Edit `references/make.md` and `references/weight.md`**

`make.md` line 17: `The review cycle's actionable items **are** the next Make contract.` → `The review round's open blockers and actions **are** the next Make contract, verbatim from the verdict.`

`weight.md` line 18: `Review↔Make cycle.` → `Review round ↔ Make loop.`

- [ ] **Step 7: Run the gate**

Run: `bash scripts/check.sh`
Expected: exit 0. A hit from the `cycles|a panel` grep names the file and line to fix.

- [ ] **Step 8: Commit**

```bash
git add SKILL.md references/models.md references/receipt.md references/make.md references/weight.md scripts/check.sh
git commit -m "docs: the skill names review-gate-v2 as its grader everywhere it spoke of the panel"
```

---

### Task 5: sweep, one real round, pull request

**Files:**
- Modify: none expected; whatever the sweep finds
- Test: `scripts/check.sh`; one live `review_gate review` on this branch

**Interfaces:**
- Consumes: everything above.
- Produces: the pull request on `rawphp/factory`.

- [ ] **Step 1: Sweep for leftovers**

Run: `git grep -n -iE 'cycle|panel|seat|persona|dispatch a reviewer|reviewers/' -- SKILL.md references scripts | grep -v field-lessons.md`
Expected: no output, except `references/mutation.md` lines about dispatching the mutation worker and `references/review.md`'s sentence `The session never grades, combines, drops or settles a finding itself.` Fix anything else and run `bash scripts/check.sh` again.

- [ ] **Step 2: Run the gate**

Run: `bash scripts/check.sh`
Expected: exit 0.

- [ ] **Step 3: Run one real round on this branch, with the new instructions**

From the repo root, following `references/review.md` § 1 to § 3 literally, with `<base>` = `main`, `<maker id>` = `claude-opus-5-5`, `.factory/issue-title.txt` = `review-gate-v2 as the factory's grader` and `.factory/issue-body.md` = this plan's § Why. Create `.factory/` with its `.gitignore` first (`SKILL.md` § Scratch). Expected: the exit file holds `0` or `1`, `verdict.json` exists, `verdict.head` equals `git rev-parse HEAD`, and the `jq` read prints `status`, `score` and `open`. This proves the command, the wait and the read work as written; fix the reference text, not the test, where they do not. Open findings on this branch's prose are fixed in the ordinary way before the PR.

- [ ] **Step 4: Commit any fixes**

```bash
git add -u SKILL.md references scripts
git commit -m "fix: the round command as a real round ran it"
```

(Skip when the sweep and the round changed nothing.)

- [ ] **Step 5: Push and open the pull request**

```bash
git push -u origin <branch>
gh pr create --repo rawphp/factory --title "feat: review-gate-v2 is the factory's grader" --body-file <receipt file> --base main
```

The body has, in this order: `## Testing` (steps 1 to 3 above, plus: mark one `original-solutions/factory-paradev-spike` issue `factory:ready` after merging and pulling `main` into `~/EA/projects/factory`, and check the PR's receipt shows `rounds:` with review-gate scores and `reviewers: review-gate-v2`), `## Risk: 2/5` (every M/L factory run changes its Check step; a wrong command stops runs `stuck` with the draft PR open, which is visible and recoverable), `## How to revert` (`git revert <merge sha>`, then `git -C ~/EA/projects/factory pull`; nothing else, since runs read the skill at start). Then the receipt's `## Contract`, `## Review` and `## Lessons` sections. No harness byline, no co-author trailer.

---

## Out of this plan

- **Per-repo auto-merge** (`autonomy: merge` in the `.dw` block; the runner marks the PR ready and runs `gh pr merge --auto --squash`) is a runner change in `original-solutions/factory-on-paradev`, filed as its own factory issue after this plan merges. The factory skill's `Never merge` hard rule stays: the runner merges, the session never does.
- **Repos with the review-gate GitHub Action.** After Ship the Action reviews the pushed head with its own state; `review-loop` reconciles the two when a person picks the PR up. Nothing here changes that.
- **tc-review-gate** needs no change: `review --full --format json --out --maker-model --title --body` and `settle` already exist.
- **Hosts and cloud (P2):** the CLI must be installed where the agent runs. § 1 of the new `review.md` stops `stuck` when it is not, which is the right failure until P2 installs it.

## Self-review notes

- Requirements 1 to 11 each map to a task: 1, 2, 3, 4, 5, 6, 7 → Task 1; 5 (the loop) → Task 2; 8, 9 (the briefs) → Task 3; 9 (the words), 10 → Task 4; 11 → every task's check.sh steps, Task 5's sweep.
- Names used across tasks: `references/mutation.md` (Tasks 1, 2, 3, 4), `the pair (open blockers, open actions)` (Tasks 1, 2), `.factory/review/round-<n>/` (Tasks 1, 4), `--maker-model` (Tasks 1, 2, 4), `reviewers: review-gate-v2` (Task 4 receipt and assertion). Checked for the same spelling in each.
- Review Focus items 1, 2, 3, 5 are asserted in Task 1; item 4 in Task 2.
- The `jq` path `.report.reviewers[]?` is a guess at where failed reviewers are listed; the `?` makes it safe when absent, and Task 5 step 3 shows the real shape so the text can be corrected before the PR.
