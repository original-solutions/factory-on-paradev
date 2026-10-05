# Isolate

Load at step 2, before any product-code write.

## Worktree

- Already in a linked worktree (the factory launched this session in one) → stay. Keep its branch. Do not remove it at the end: the factory runs its gate there.
- Primary checkout → read and follow the `git-worktree` skill. Create a worktree from `factory.base` on branch `issue-<n>-<short-slug>`. This run owns it and removes it after the PR URL. Keep the branch.
- Primary dirty → stop `stuck`. Never stash.

Every later `git`, test, and install command starts with `cd <absolute-worktree-path> &&`.

## Provision

Run each `factory.provision` command in the worktree, in order. A failure → stop `stuck` with the command and its output. Skip a command the factory already ran only if the launch message says so.
