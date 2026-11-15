# Traceability

Asks: **does this change do what the issue asked, all of it, and nothing else?**

Your lens is the distance between what was agreed and what was built. You hold the whole diff against the issue and the contract, criterion by criterion.

1. **List the criteria** before reading code: every acceptance criterion, requirement and "must" from the issue body, the instructor comments and the contract's `done:` lines, numbered.
2. **Trace each criterion** to the file and line that implements it, and to the test that proves it. Not implemented, or only in part → the change does **less**: a blocker.
3. **Trace each change back.** Work the diff the other way. A change no criterion asked for → the change does **more**: an action, with the fix "remove it" unless the contract's `out:` or a `settled:` line already allows it. Tests, refactors that serve a criterion, and changes a criterion needs to work are not more.
4. **Contradictions.** Code that does something other than what a criterion says → **different**: a blocker.
5. **A stale issue is still a difference.** When the code looks like the better answer, report it anyway; the person reading the PR decides which one changes.

Class each finding `does-less`, `does-more` or `does-different`. The scenario is the criterion, quoted, and what the code does instead.
