# Isolate

Load at step 2, before any product-code write.

## Worktree

- Already in a linked worktree (the factory launched this session in one) → stay. Never create or switch branches there: the folder name is not the branch name (T3 renames the branch after launch and leaves the folder), so read it with `git branch --show-current` and push that, including on push; the `issue-<n>-<short-slug>` name below is only for a worktree this run creates. Do not remove it at the end: the factory runs its gate there.
- Primary checkout → read and follow the `git-worktree` skill. Create a worktree from `factory.base` on branch `issue-<n>-<short-slug>`. This run owns it and removes it after the PR URL. Keep the branch.
- A Linear issue: a worktree this run creates is on branch `factory/<key lowercased>-<slug>`, for example `factory/eng-42-export-csv`; a worktree the factory launched keeps its branch. Either way the pull request title starts with `ENG-42`, and Linear's GitHub integration links the pull request to the issue by that key. The GitHub name stays `issue-<n>-<short-slug>`.
- Primary dirty → stop `stuck`. Never stash.

Before reading code, `git fetch origin` and compare `HEAD` with `origin/<base>`: a worktree cut from a stale local base is missing the code the issue depends on. When `HEAD` is an ancestor and the tree is clean, `git merge --ff-only origin/<base>` and say so on the receipt.

When Read picked a login other than the active one, or picked its account by a push dry run, `git fetch` runs as `SKILL.md` § GitHub account says.

Every later `git`, test, and install command starts with `cd <absolute-worktree-path> &&`.

Then make the scratch directory (`SKILL.md` § Scratch): `mkdir -p .factory && printf '*\n' > .factory/.gitignore`. Every file the run writes for itself goes under `.factory/`.

## Provision

Run each `factory.provision` command in the worktree, in order. A failure → stop `stuck` with the command and its output. Skip a command the factory already ran only if the launch message says so.
