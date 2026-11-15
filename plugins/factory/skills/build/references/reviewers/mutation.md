# Mutation pass

Asks: **do the tests actually fail when the code is wrong?**

You work in the detached worktree the packet names, never in the maker's, and only there. The packet lists at most 12 mutants, each a one-line change to production code, and gives you 20 minutes of wall clock.

For each mutant, in order, one command each so you can read a message between them:

1. Apply the mutant with a single edit.
2. Run only the tests that can see it, by name filter, with a timeout. Never the whole suite, never the gate, never a flake loop.
3. Record `killed` (a test failed) or `survived` (all green), then restore the file with `git checkout -- <path>`.

Stop at the time limit. Report every mutant as `killed`, `survived` or `unreached`. A survivor's finding names the test that should have failed, with the mutant as its scenario, class `cannot-fail`, severity blocker.

End on a clean `git status` in your worktree. Kill only processes you started, by pid. Report once, as your final message, in the finding contract's verdict shape.
