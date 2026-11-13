# Review

Load at Check step 2. One review round is: run the review-gate-v2 CLI on the tip → read its verdict → hand the open findings to Make. The CLI is the grader. The session never grades, combines, drops or settles a finding itself.

## 1. Find the CLI

Once per run, before the first round:

```bash
RG="${REVIEW_GATE_V2_HOME:-$(cd -P "$HOME/.claude/skills/review-gate/../.." 2>/dev/null && pwd)}"
[ -f "$RG/review_gate/__main__.py" ] && python3 -P -c 'import sys; sys.exit(sys.version_info < (3, 11))' && printf '%s\n' "$RG" > .factory/rg-home
rm -f "$(git rev-parse --git-common-dir)/review/$(git branch --show-current | sed 's#/#%2f#g').json"
```

Either check failing → stop `stuck`, naming `$RG` and the Python version. Never fall back to a self-run review: a run with no grader ships nothing. Shell state does not carry from one call to the next, so every later command reads the path from `.factory/rg-home`. The `rm -f` clears round state a previous run of this branch left in the clone's common git dir, which otherwise makes the CLI's round 1 this run's round k+1 or, when that run's head is gone, exit 2 on every attempt.

## 2. Run a round

The tree is clean at the tip and the maker is idle. When the newest saved verdict already names the tip (`verdict.head` equals `git rev-parse HEAD`), do not run: a round on an unchanged head can mark open findings fixed that nobody fixed. Stop `stuck` with the open ids instead. `n` is the round number, starting at 1. `.factory/issue-title.txt` and `.factory/issue-body.md` hold the issue's title and body as Read copied them; write them at the first round if Read did not.

```bash
cd <worktree> && git fetch origin <base>        # `SKILL.md` § GitHub account
rm -rf .factory/review/round-<n> && mkdir -p .factory/review/round-<n>
nohup sh -c 'PYTHONPATH="$(cat .factory/rg-home)" python3 -P -m review_gate review \
  --base origin/<base> --maker-model <maker id from references/models.md> --full \
  --title "$(cat .factory/issue-title.txt)" --body "$(cat .factory/issue-body.md)" \
  --out .factory/review/round-<n> --format json \
  > .factory/review/round-<n>/stdout.json 2> .factory/review/round-<n>/stderr.log; echo $? > .factory/review/round-<n>/exit' \
  > /dev/null 2>&1 &
echo $! > .factory/review/round-<n>/pid
```

The `rm -rf` matters when a round is run again (an incomplete round, a head mismatch): without it the old `exit` file ends the poll at once and the session reads the old verdict while the new CLI still runs.

`--full` every round: the whole `base...tip` diff is read each time, so a fix is judged beside the code it changes, and round count, ids and settles are kept. `--maker-model` puts the reviewers on another model family than the maker's.

Then wait in the same turn, in bounded polls, until the exit file exists:

```bash
for i in 1 2 3 4; do [ -f .factory/review/round-<n>/exit ] && break; sleep 30; done; cat .factory/review/round-<n>/exit 2>/dev/null
```

Repeat that command until it prints a number. Never end the turn while it is empty (`SKILL.md` § Stops). Between repeats, `kill -0 "$(cat .factory/review/round-<n>/pid)"`: when that fails and the exit file is still missing, the CLI died, so read the last lines of `stderr.log` and stop `stuck` with them. Other sessions' rounds run on this host, so never test liveness with `pgrep`. A round still running after 60 minutes is also a stop `stuck`, naming the round.

## 3. Read the verdict

Read `.factory/review/round-<n>/verdict.json` and nothing else from the round: not `events.jsonl`, not `report.md`, not `stdout.json`.

```bash
jq '{status, score, head, door: .door.kind, risk, counts, report: .report.markdown,
     open: [.findings[] | select(.status == "open" and (.severity == "blocker" or .severity == "action"))
            | {id, severity, title, sites, scenario, fix}],
     reviewers_failed: [.personas.failed[]? | {name, reason}]}' .factory/review/round-<n>/verdict.json
```

- `verdict.head` must equal `git rev-parse HEAD`. A mismatch means something committed while the round ran: the round is discarded (not counted toward the cap) and run again from § 2 on the tip.
- Exit 2 or 4, any exit the table below does not name, or an exit file with no `verdict.json` beside it: there is no verdict. Stop `stuck` with the last line of `stderr.log`.
- `status: done` (exit 0): score 5, nothing open. On to `references/mutation.md`, then Check § 5 Live.
- `status: open` (exit 1): the open blockers and actions go to Make (§ 4), then the next round.
- `status: incomplete` (exit 1): reviewers failed, not the code. Read `reviewers_failed[].reason` first: when the reasons name a usage limit (`429`, `limit`, `reset`), stop `stuck` at once quoting one reason, because a retry before the reset fails the same way. Otherwise run the same round again as it is, once, from § 2; an incomplete round is not saved, so it spends no round. Two incomplete in a row → stop `stuck`, naming `reviewers_failed`. The CLI writes nothing about reviewer failures to `stderr.log`; the verdict is the only record.

Receipt fields: `references/receipt.md` § Review. Every saved round's `score` and pair go there as they happen, so a stop still shows the trail.

## 4. Open findings to Make

The open blockers and actions, verbatim from the verdict (`id`, `severity`, `title`, `sites`, `scenario`, `fix`), are one combined Make contract (`references/make.md` § Findings from Check). Blockers cannot be skipped. A fix covers every place the finding's rule applies, not only the first site. Nits go in only when the fix is a few lines inside the contract's `files`; otherwise they are listed on the receipt. The fix text is a reviewer's guess: read the code at the sites first, and when the fix needs data the code does not hold, change the source of that data rather than patching around it.

When Make is green, commit the round's fixes (`references/commits.md`, `fix: review round <n>`) before the next round. A finding is fixed when the next round's verdict no longer lists it, never when the maker says so.

A finding the run disagrees with stays open. Say why in one line on the receipt. A run never calls `settle` on its own word. The one exception: an instructor comment on the issue (`SKILL.md` § Issue) holding a line `settled: <id> — <reason>` is applied before the next round with `PYTHONPATH="$(cat .factory/rg-home)" python3 -P -m review_gate settle <id> --reason "instructor <login>: <reason>"`, from the worktree, and the receipt lists it under `settled`.

## 5. Progress and the cap

Round n improves on round n-1 when it has fewer open blockers, or the same open blockers and fewer open actions: the pair (open blockers, open actions), blockers first. A new blocker where there was none is never progress. Two consecutive saved rounds that do not improve → stop `stuck` and list the open ids. Round 5 ending `open` → stop `stuck`. The `stuck` rules in `SKILL.md` § Stops still open the draft PR when the branch is coherent, with the open findings on its receipt, so nobody mistakes it for clean.

Score for the receipt is the verdict's `score`: 5 nothing open, 4 one or two actions, 3 three or more actions, 2 a blocker, 1 a blocker in `security` or `data`.

## 6. After `done`

The mutation pass, `references/mutation.md`, once per issue, on the tip that ships. review-gate reads code; the pass executes it, so the two never replace each other. Then Check § 5 Live, then Gate.
