# Check

Load at step 5. This is a loop, not a report.

```text
tests green
  → review (persona batch)
      → no actionable findings → Gate
      → findings → Make → tests → review
until: no findings | cycle == 5
```

## 1. Tests

Run the contract `test:` command from the worktree. Red → Make (counts toward Make's 3-strike, not the review cycle).

**S mechanical:** green (or no tests needed, say why) → Gate. No roster.

## 2. Review (M/L)

Load `references/review.md`. Dispatch the native roster on the issue's diff. Maker does not play a persona. Checker model: `references/models.md`.

An acceptance criterion with no test (docs, visual): verify it yourself and note `screenshot <path>` or `verified <file:line>` on the receipt.

## 3. Feed into Make

Actionable in-scope findings become the next Make contract. Re-run tests. Blockers cannot be skipped.

When that Make is green, commit the cycle (`references/commits.md`, `fix:`) **before** the next review wave. Reviewers must see the tip that includes the fixes.

## 4. Cycle

Cycle starts at 1 after the first review. Empty actionable set → Gate. Else review again.

**Max 5.** At 5 with findings still open: stop `stuck` and list the leftovers. Do not open a "good enough" PR as if it were clean.

Receipt fields: `maker`, `checker`, `review_cycles`, findings fixed, leftovers.
