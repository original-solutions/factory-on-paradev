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

**Stop `stuck`**, listing the open ids and the last report path, when: round 5 ends `open`; two consecutive saved rounds do not improve the pair (open blockers, open actions), as `references/review.md` § 5 defines it (two rounds without progress); two rounds in a row end `incomplete`; or `stderr.log` shows a 429 that names a reset time. Do not open a "good enough" PR as if it were clean: the `stuck` path in `SKILL.md` § Stops opens the draft with the open findings on its receipt.

## 5. Live

An acceptance criterion with no test (docs, visual): verify it yourself and note `screenshot <path>` or `verified <file:line>` on the receipt.

A UI or API criterion: run it once through its real entry point with data shaped like the contract's own examples, from a detached worktree at the tip. Whatever breaks becomes a failing test first, then Make.

A reviewer's note that nothing in the repo shows what an outside system returns for a repeated call is a live check, not a nit: makers and reviewers only have fakes. Call it twice against the real system before the fix round closes and give the maker the exact responses.

Receipt fields: `references/receipt.md` § Review.
