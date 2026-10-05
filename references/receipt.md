# Receipt

Write to a tempfile and pass `--body-file`. This is the change receipt.

```markdown
Closes #<n>

## Contract
- done: …
- out: …
- risk: …
- test: `<command>` → pass | skip (reason)

## Acceptance criteria
- [x] <criterion> — <test name or file:line that proves it>

## Gate
- `<command>` → exit <code>

## Models
- maker: <id>
- checker: <id> | default (peer unavailable)

## Review
- cycles: n
- fixed: …
- leftovers: none | list (non-blockers only)

## Lessons
- none | **<title>.** Symptom: … Cause: … Default: …

## Commits
- `<sha>` `<subject>` — Make slice | Check cycle n | Ship leftover

## Files
- path — why
```

## What goes under Lessons

Every receipt has `## Lessons`, including the receipt of a draft pull request opened on a `stuck` stop. A run that ends with no pull request puts the same section in its final message, above the result line.

The section holds `none`, or one item for each lesson with its symptom, its cause and its default action.

A lesson is about how to run `/factory` and would hold on a different repo. A fact about the repo being built, its stack or its domain is not a lesson and is left out. `none` is the usual answer.

The receipt is the only place a run writes a lesson. `references/field-lessons.md` changes only by pull request.

No post-deploy monitoring section. No branding. No AI attribution.
