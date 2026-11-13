# Debug

Load from Make when the input is failing behavior, not a feature brief.

1. Reproduce. File:line evidence. One hypothesis at a time.
2. Causal chain with no gaps, or stop and say where it breaks.
3. Regression test that fails on the bug, then the fix (`references/make.md`).
4. 2–3 hypotheses exhausted without confirmation, or 3 failed fix attempts → stop. Diagnose why, do not shotgun.

Divergent fix (would reverse a deliberate product decision) → stop `needs-info`. Do not apply in the dark.
