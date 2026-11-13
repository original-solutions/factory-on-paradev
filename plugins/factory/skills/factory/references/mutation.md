# Mutation pass

## Dispatch

Once per issue, after a round ends `done`, on the tip that ships. The orchestrator (this session) runs it; the maker is idle.

1. Make the detached worktree: `cd <worktree> && git worktree add --detach .factory/mutation "$(git branch --show-current)"`, with its own dependency directory as `SKILL.md` § Scratch says, and run the suite once for green.
2. At most 12 mutants, each named by you, a one-line change to production code: first the places the last verdict's `testing` findings named as untestable, then the diff's riskiest decisions (a skipped check, a wrong order, a leak into public text).
3. Dispatch one read-write subagent on the checker model (`references/models.md`) with the text below this section, the worktree path, the mutant list, the test filter command, and 20 minutes of wall clock. Foreground; wait for its report in the same turn (`SKILL.md` § Stops).
4. A surviving mutant is a blocker: the test that should have failed, with the mutant as its scenario. Surviving mutants go to Make as one packet; the next review round confirms the tests. Unreached mutants are listed on the receipt, not chased.
5. Remove the worktree: `git worktree remove .factory/mutation`.

When the last fix round was a few lines you can read, read the diff and skip the pass; say so on the receipt.

## The brief

Asks: **do the tests actually fail when the code is wrong?**

You work in the detached worktree the packet names, never in the maker's, and only there. The packet lists at most 12 mutants, each a one-line change to production code, and gives you 20 minutes of wall clock.

For each mutant, in order, one command each so you can read a message between them:

1. Apply the mutant with a single edit.
2. Run only the tests that can see it, by name filter, with a timeout. Never the whole suite, never the gate, never a flake loop.
3. Record `killed` (a test failed) or `survived` (all green), then restore the file with `git checkout -- <path>`.

Stop at the time limit. Report every mutant as `killed`, `survived` or `unreached`. A survivor's finding names the test that should have failed, with the mutant as its scenario, class `cannot-fail`, severity blocker.

End on a clean `git status` in your worktree. Kill only processes you started, by pid. Report once, as your final message, in the finding contract's verdict shape.
