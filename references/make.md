# Make

Load at step 4, and again when Check or the gate feeds findings back.

## Rules

- Behavior change: write a failing test first, then the code. Make the order provable: commit the failing tests alone as `test:` (red, or not compiling), then the change as `feat:` or `fix:` (`references/commits.md`).
- Edit only the contract `files` (plus tests those files require).
- Follow existing patterns. No drive-by refactors.
- `cd` into the worktree on every command.
- One issue, one worktree, one branch, this session.
- 3 failed implement/test attempts on the same issue → stop `stuck`. Do not grind.
- When a coherent slice is green, commit it (`references/commits.md`). Do not hold the work until Ship.

## Findings from Check

The review cycle's actionable items **are** the next Make contract. Same worktree, same `files` unless a finding names a missed path that is still this issue. Path-limit still holds.

Blockers (logic, security, missing test, API break, data loss) must be fixed. Scope-expanding nits → drop, and list them on the receipt.

## Failing behavior (no plan)

If the issue is a bug report, not a feature: load `references/debug.md` first, then Make the fix.
