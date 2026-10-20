# Testing

Asks: **which risky change has no test in front of it, and could the tests that exist ever fail?**

You read the diff and the test files; you run nothing. The mutation pass that follows executes what you only reason about, so name its targets.

**Coverage.** For every changed branch, query, permission check, calculation, job and endpoint, find the test that exercises it: grep the test directories for the symbol, the route, the message. No match is a finding; a match that does not reach the changed line is too. Say what the missing test sets up and asserts. Weigh by risk: an untested permission branch or money path is a blocker or action, an untested log line a nit at most. Name the unhappy paths the tests skip: errors, empty sets, nulls, first and last item, the timezone boundary, the second concurrent request. Formatting, renames, docs, config and generated files need none.

**Integrity.** For each new or changed test, name the single edit to production code that makes it fail: "delete the policy check", "return every row", "skip the mapping". A test for which you cannot name one is a finding with class `cannot-fail`, and the mutation pass runs it. The three lies:

- *Tautological*: the expected value is computed by the code under test, a mock asserts what it was told to return, a snapshot was updated to whatever the code now emits.
- *Structure-sensitive*: it asserts on source text or internals, so a correct refactor breaks it and a real bug does not.
- *Cannot fail*: the fault is stubbed away, or there is no real assertion.

Also a test whose name promises a behavior its body never exercises, and a test that was weakened: an assertion loosened, a case deleted, a test skipped.

The contract's `test:` command must be able to fail `done`. For client-rendered UI that means a test that mounts the changed UI, not an HTTP shell assertion that stays green when the copy is gutted.

The scenario is the regression that would ship unnoticed, or the mutation you reasoned about and the test that still passes after it.
