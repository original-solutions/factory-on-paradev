# Check

Load at step 5. This is a loop, not a report.

```text
tests green
  → review cycle (gate call → panel → collect → decide)
      → score 5 → mutation pass → live → Gate
      → findings → Make → tests → commit → review cycle
until: score 5 | cycle == 5 | two cycles without progress
```

## 1. Tests

Run the contract `test:` command from the worktree. Red → Make (counts toward Make's 3-strike, not the review cycle). One unexplained failure in many runs is red too: find the cause (a parallel test, an inherited handle, a timing bound) and prove the fix with 30 or more consecutive green runs at the tip.

**S mechanical:** green (or no tests needed, say why) → Gate. No panel.

## 2. Review (M/L)

Load `references/review.md` and run one cycle on the tip. Checker model: `references/models.md`.

## 3. Feed into Make

The cycle's open blockers and actions, with their ids, are the next Make contract. Blockers cannot be skipped. Re-run tests.

When that Make is green, commit the cycle (`references/commits.md`, `fix:`) **before** the next cycle. Reviewers re-check the tip that includes the fixes; a finding is fixed when its reviewer says so, not when the maker does.

## 4. Cycle

Before each cycle, `git fetch origin`; when `origin/<base>` moved (another PR landed), `git merge origin/<base>`, re-run tests and commit, so reviewers and the gate see the merged tree rather than a conflict on the files every change touches.

Cycle starts at 1 after the first review. Score 5 → the mutation pass (`references/review.md` § 6), then § 5 Live, then Gate. Else review again.

**Max 5**, or two consecutive cycles without progress (`references/review.md` § 5): stop `stuck` and list the leftovers. Do not open a "good enough" PR as if it were clean.

## 5. Live

An acceptance criterion with no test (docs, visual): verify it yourself and note `screenshot <path>` or `verified <file:line>` on the receipt.

A UI or API criterion: run it once through its real entry point with data shaped like the contract's own examples, from a detached worktree at the tip. Whatever breaks becomes a failing test first, then Make.

A reviewer's note that nothing in the repo shows what an outside system returns for a repeated call is a live check, not a nit: makers and reviewers only have fakes. Call it twice against the real system before the fix cycle closes and give the maker the exact responses.

Receipt fields: `references/receipt.md` § Review.
