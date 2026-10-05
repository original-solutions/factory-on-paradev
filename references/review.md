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

## Testing review budget

The mutating review must not hold up a ship. It gets 20 minutes of wall clock, and the brief says so.

- **Once per issue.** Run it after the read-only reviewers approve, on the tip that is about to ship. Not on every cycle, and never on a tip the maker is about to rework.
- **At most 12 mutants.** The orchestrator names them in the brief, picked from the diff's riskiest decisions (a skipped check, a wrong order, a leak into public text). The reviewer does not invent a long list.
- **Filtered tests only.** Per mutant, run the tests that can see it with a name filter and a timeout. Never the whole suite per mutant.
- **No repeats of the gate.** No flake loops and no gate commands. The maker runs the gate, and the orchestrator runs it again in a fresh clone.
- **Short commands.** One mutant per command, so the reviewer can read a message between them. A single long script cannot be interrupted.
- **Stop at the limit.** Report survivors and what was not reached. Unreached mutants are listed on the receipt, not chased.
- **Small final batches skip it.** When the last fix cycle is a few lines the orchestrator can read, read the diff and ship.

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
