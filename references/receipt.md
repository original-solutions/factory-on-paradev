# Receipt

Write it to `.factory/receipt.md` in the worktree (`SKILL.md` § Scratch) and pass `--body-file` that path. This is the change receipt. It is never committed.

```markdown
Closes #<n>

## Testing
- <how a reviewer sees it work: setup, command or click path, expected result>
- suite: `<command>` → pass

## Risk: <0-5>/5
<one line: what could break and who would notice>

## How to revert
- `git revert <merge sha>`
- <anything a revert does not undo: migration ran, data written, message sent, config or flag changed> | nothing else

## Contract
- done: …
- out: …
- risk: …
- test: `<command>` → pass | skip (reason)

## Acceptance criteria
- [x] <criterion> — <test name or file:line that proves it>

## Gate
- `<command>` → exit <code>
- account: <login> — active | other logged-in account (`SKILL.md` § GitHub account)

## Models
- maker: <id>
- checker: <id> | default (peer unavailable)

## Review
- door: one-way | two-way — <reason>
- risk: high | low — <reason>
- cycles: n — cycle 1: <score>/5 (b/a) → cycle n: <score>/5 (b/a)
- fixed: …
- settled: none | <id> — <reason>
- dropped: none | <seat>: n
- incomplete: none | <seat>
- mutation: skipped (<reason>) | killed n, survived n, unreached n
- leftovers: none | list (non-blockers only)

## Lessons
- none | **<title>.** Symptom: … Cause: … Default: …

## Commits
- `<sha>` `<subject>` — Make slice | Check cycle n | Ship leftover

## Files
- path — why
```

The first line is `Closes #<n>` for a GitHub issue. A Linear issue writes `Closes <KEY-n>`.

## Testing, Risk, How to revert

Every pull request has these three sections, in this order, at the top.

- **Testing:** steps a reviewer can follow without reading the diff. Name the setup, the command or click path, and what they should see.
- **Risk:** one score from 0 to 5.
  - 0: no runtime effect (docs, comments, tests only).
  - 1: cosmetic or isolated. A failure would be obvious and harmless.
  - 2: an ordinary change in one area, covered by tests.
  - 3: shared code, several callers, or behaviour a user will notice.
  - 4: auth, money, data writes, a public API, or infra and config.
  - 5: cannot be taken back: a schema or data migration, a delete, a message sent outside.
  The review ruling bounds the score: `risk: high` is 3 or more.
- **How to revert:** the revert command, then every step a revert does not undo. If a revert is not enough on its own, say so.

## What goes under Lessons

Every receipt has `## Lessons`, including the receipt of a draft pull request opened on a `stuck` stop. A run that ends with no pull request puts the same section in its final message, above the result line.

The section holds `none`, or one item for each lesson with its symptom, its cause and its default action.

A lesson is about how to run `/factory` and would hold on a different repo. A fact about the repo being built, its stack or its domain is not a lesson and is left out. `none` is the usual answer.

The receipt is the only place a run writes a lesson. `references/field-lessons.md` changes only by pull request.

No post-deploy monitoring section. No branding. No AI attribution.
