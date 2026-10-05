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

## Commits
- `<sha>` `<subject>` — Make slice | Check cycle n | Ship leftover

## Files
- path — why
```

No post-deploy monitoring section. No branding. No AI attribution.
