# Ship

Load at step 7 after Check is clean and the gate passed here.

## Commit

Make and Check already committed (`references/commits.md`). Ship only commits leftover named files (format, lockfile). If the tree is clean, skip commit.

Never squash Make or Check commits. Never `git add -A` or `git add .`. Never co-author trailers.

## PR

```bash
git push -u origin HEAD
gh pr create --draft --base <factory.base> --title "<issue title>" --body-file <receipt path>
```

Push the worktree's branch under its own name. Never rename it on push (`HEAD:<other>`) and never pass `--head` with another name: the factory binds the PR by its head branch and stops `stuck` on any other.

Receipt: `references/receipt.md`. It starts with `Closes #<n>`.

Always a draft. The factory marks it ready after its own gate passes. Never merge.

Existing PR for this branch: `gh pr edit` with the same body file, do not open a second.

No remote / `gh` missing → stop `stuck`. A local-only commit is not a result the factory can use.

## Teardown

Remove the worktree only if this run created it (`references/isolate.md`). Keep the branch.

## Last line

`FACTORY-DONE: <PR URL>`
