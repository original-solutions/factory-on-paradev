# Review

Native persona batch. Inspired by CE multi-lens review. Do not load `ce-code-review` or EA `code-review`.

## Select

Always spawn `correctness`.

Spawn when the diff earns it:

| Persona | When |
|---------|------|
| `testing` | Tests changed, or runtime behavior changed with no matching test work |
| `security` | Auth, public endpoints, user input, permissions, secrets |
| `api-contract` | External route/schema/event/package signature |
| `reliability` | Retries, jobs, timeouts, error paths, health |
| `maintainability` | Substantial structure, new abstractions, or ≥200 executable lines |
| `adversarial` | Auth, payments, persistence writes |

Skip a lens that has no surface. Do not spawn "just in case."

Announce the roster in one line per extra persona, then dispatch.

## Dispatch

Each selected file in `references/reviewers/<name>.md` is the whole prompt plus:

- The unit diff (or path list + `git diff`)
- Contract `done` / `out` / `settled`
- Output shape below

One concurrent batch of host parallel subagents. Checker model from `references/models.md`.

Maker session does not play a persona.

One worktree → at most **one** reviewer (usually `testing`) may edit files; it restores with `git checkout` and ends on a clean `git status`. Every other persona is strictly read-only (read `git show HEAD:<path>` if code looks changed). After cycle 1, drop the read-only reviewers and keep the mutating one; its re-check is "re-run your surviving mutants." If the maker model changes, keep at least one reviewer on a different model.

## Merge

Each reviewer returns:

```text
## Findings
- id: <persona>-<n>
  severity: blocker | action | nit
  file: <path:line>
  problem: <one sentence>
  fix: <one sentence>
## Verdict
Approve | Request changes
```

**blocker** / **action** → Make. **nit** → drop unless cheap and in `files`. Duplicate findings: keep one.

Empty blocker+action list → Check continues to Ship.

Do not invent findings the diff does not support. High conviction only.
