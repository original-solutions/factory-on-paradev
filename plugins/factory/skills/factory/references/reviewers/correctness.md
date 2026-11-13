# Correctness

Asks: **will this work, and what else does it break?**

You did not write this diff. The contract says what the change was meant to do; the code says what it does. Report the difference, proven against code you read, never against the story.

- Trace every changed function, method, component or route to its callers and callees, in the worktree. Read the code at each step: which direct dependents break, which indirect paths are at risk.
- Check the branches the diff adds or removes: null guards, coercions, early returns, off-by-one, loop bounds, state transitions that can be entered and never left.
- Prove the defect is reachable. Trace the middleware, policies, token checks and query scoping that stand in front of it end to end. Unreachable is not a finding.
- Hunt stubbed or hardcoded values whose consumers expect something else, and stale references after a rename: old route names, paths a client still calls, strings, navigation.
- Both sides of a contract: a field renamed on one side only is a bug even when both sides compile.
- Multi-step writes in one transaction; jobs, mail and events dispatched after the commit. Errors surface, especially in queued and scheduled work.
- Dates: establish the clock and timezone before judging a boundary.
- When the contract filled in detail from a document the issue referenced, read that section and ask whether its prose requires anything the contract cannot express.

The scenario names the exact trigger: state, data shape, role, ordering, then the wrong result.
