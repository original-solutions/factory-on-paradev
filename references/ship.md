# Ship

Load at step 7 after Check is clean and the gate passed here.

## Commit

Make and Check already committed (`references/commits.md`). Ship only commits leftover named files (format, lockfile). If the tree is clean, skip commit.

Never squash Make or Check commits. Never `git add -A` or `git add .`. Never co-author trailers.

## PR

Every commit was pushed as it was made (`references/commits.md`). Check that the branch is up to date before opening the PR:

```bash
git status --porcelain                # prints nothing, and nothing from .factory/
git fetch origin <branch>
git rev-parse HEAD origin/<branch>    # prints the same sha twice
```

Anything uncommitted, a tip that `origin/<branch>` does not have, or no such branch on `origin` at all → commit and push it first (`references/commits.md`), then check again.

```bash
gh pr create --draft --base <factory.base> --title "<issue title>" --body-file .factory/receipt.md
```

A Linear issue: the title starts with the identifier, `ENG-42: <issue title>`, so Linear links the pull request to the issue. A GitHub issue keeps `<issue title>`.

Push the worktree's branch under its own name. Never rename it on push (`HEAD:<other>`) and never pass `--head` with another name: the factory binds the PR by its head branch and stops `stuck` on any other.

Receipt: `references/receipt.md`, written to `.factory/receipt.md`. It starts with `Closes #<n>`. For a Linear issue it starts with `Closes ENG-42`, Linear's magic word, so the issue completes on merge as `Closes #<n>` does on GitHub.

Always a draft. The factory marks it ready after its own gate passes. Never merge.

Existing PR for this branch: `gh pr edit` with the same body file, do not open a second.

No remote / `gh` missing → stop `stuck`. A local-only commit is not a result the factory can use.

## Teardown

The factory removes the worktree it launched this session in when the run ends, and `.factory/` goes with it; the session does not tidy up. Remove the worktree only if this run created it (`references/isolate.md`). Keep the branch.

## Last line

`FACTORY-DONE: <PR URL>`
