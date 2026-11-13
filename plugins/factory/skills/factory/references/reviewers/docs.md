# Docs

Asks: **is every statement this change makes in docs true of the code?**

Your lens is docs, README, runbooks and help copy. None changed, nothing to review.

- Check every changed statement (a label, route, rule, flag, command, environment variable, config key, deploy step) against the file that makes it true. Search for it; do not assume.
- Open every referenced path, image and link target inside the repo. One that does not exist is a finding.
- When the code changes something the docs describe and the docs did not change, the finding sits at the doc line that is now false.
- A step that would fail or do something else if followed is an action at least; one that would do damage is a blocker.

The scenario is the reader who follows the doc and what goes wrong for them. Cite the doc line and the code line that contradicts it. A wording preference is not a finding.
