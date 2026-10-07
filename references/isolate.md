# Isolate

Load at step 2, before any product-code write.

## Worktree

- Already in a linked worktree (the factory launched this session in one) → stay. Keep its branch and its name, including on push; the `issue-<n>-<short-slug>` name below is only for a worktree this run creates. Do not remove it at the end: the factory runs its gate there.
- Primary checkout → read and follow the `git-worktree` skill. Create a worktree from `factory.base` on branch `issue-<n>-<short-slug>`. This run owns it and removes it after the PR URL. Keep the branch.
- A Linear issue: a worktree this run creates is on branch `factory/<key lowercased>-<slug>`, for example `factory/eng-42-export-csv`; a worktree the factory launched keeps its branch. Either way the pull request title starts with `ENG-42`, and Linear's GitHub integration links the pull request to the issue by that key. The GitHub name stays `issue-<n>-<short-slug>`.
- Primary dirty → stop `stuck`. Never stash.

Every later `git`, test, and install command starts with `cd <absolute-worktree-path> &&`.

## Provision

Run each `factory.provision` command in the worktree, in order. A failure → stop `stuck` with the command and its output. Skip a command the factory already ran only if the launch message says so.
