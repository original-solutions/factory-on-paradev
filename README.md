# factory-on-paradev

The open-source runner for Factory by Original Solutions. Label a GitHub issue `factory:ready`, and the runner has a coding agent build it in a [Paradev](https://github.com/ParadevAI/Paradev) workspace, checks the result with your own tests on a fresh checkout, and opens a draft pull request.

**Status: pre-alpha.** Nothing here runs yet. The first milestone is a spike against a live Paradev to pin down the exact CLI responses the runner depends on.

## How it works

The runner is a small process on a machine where Paradev is signed in: your Mac, a Mac mini, or a Linux box added to Paradev as a host. It watches the repos you choose, or every repo in an account, for issues labelled `factory:ready`. For each one it:

1. Claims the issue and picks where the agent runs: this machine, another of your Paradev hosts, or Paradev Cloud.
2. Starts an isolated Paradev workspace with an agent running the `/factory` skill.
3. Waits for the agent's result line (`FACTORY-DONE: <PR URL>` or `FACTORY-STOP: <reason>`).
4. Runs the repo's gate commands on a fresh checkout of the pull request, and sends failures back to the same agent.
5. Marks the draft pull request ready for review, or posts the agent's questions on the issue.

It drives Paradev through the signed-in `superset` CLI, so your Paradev and agent logins stay on that machine. The runner works on its own, with no account anywhere. The hosted Factory dashboard by Original Solutions is a separate, optional product.

The repo will also be a Paradev plugin marketplace, so `superset plugins install factory@factory-on-paradev` gives every agent the skills it needs.

## Develop

```sh
npm ci
npm run check
```

Scripts run with Node's built-in type stripping (`node file.ts`), so there is no build step. `make build` is the same two commands.

## Release and deploy

A release is a tag. `make release VERSION=0.1.0` runs the gate, bumps `package.json`, commits `release: v0.1.0` on `main`, tags `v0.1.0` and pushes both. Merges to `main` are not deploys; the tag is the decision to ship.

`make deploy` clones the highest `v*` tag, installs its runtime dependencies and runs its `factory-runner install`, which places it at `~/.local/share/factory-runner/versions/<version>/`, points `current` at it and reloads the LaunchAgent. `make deploy TAG=v0.1.0` installs that version instead, which is how to go back by hand.

A running runner with `self_update` on installs a new tag that is on `main` itself within about ten minutes and restarts between passes when no gate runs; `make deploy` is for the first install, for going back, and after a node or PATH change. The runner reads `self_update` when it starts. To hold back an update it has already staged (the log says `update staged: vX.Y.Z ...` and no `restarting into`), set `self_update: false` and restart the runner with `launchctl kickstart -k gui/$(id -u)/io.github.original-solutions.factory-runner`: `current` has not moved, so the running version starts again with the key off. To go back, first take self-update out of the way, or the older runner installs the newer tag again ten minutes after it starts: going back to a version that has `self_update`, set it to `false` in the machine config; going back to one from before it (v0.2.0 and earlier), delete the `self_update` line instead, since that version rejects the key and does not update itself.

A tag the runner installed itself goes back on its own when it keeps dying before it completes a pass. The restart writes `update-pending.json` to the data dir, each start of the new version counts itself there before it takes the runner lock, and its first finished pass removes the file. After three starts with no pass finished, the fourth start points `current` back at the version it came from, logs `went back to vA.B.C from vX.Y.Z: 3 starts without a pass` and exits 0, so launchd starts the older version. A version that stays up and finishes a pass keeps running, whatever that pass's error count. The tag gone back from is kept in `update-refused.json`: while it is the highest tag, the older version stages nothing, and `status` shows it as an `update-refused` attention row, or as a `factory-runner: warning:` line on stderr when the file cannot be read. A higher tag installs as usual, and its first finished pass removes the file; `factory-runner install` removes both files. So going back by hand is now only for a version that crashes before `run` begins. Its limits:

- The going-back code runs inside the new version, so a tree that crashes before `run` reaches its first line still loops under `KeepAlive`. The smoke at staging catches most of those.
- Both versions need it. The version gone back to must skip the refused tag and show the `status` row, so the first release that carries this has neither when it goes back to a version from before it.
- One refused tag is remembered, and only while it is the highest. Deleting that tag on GitHub lets a lower bad tag be staged again.
- It counts starts, so a version that stays up while every pass fails is never counted and does not go back.
- The count is read and written outside the runner lock, so two `run` processes that overlap can lose one count. launchd starts one at a time, and a second `factory-runner run` by hand hits the lock and gives its count back while the count is below three. At three it goes back as the fourth start would, before it looks at the lock, even with a runner of that version still up in its first pass. That runner's passes then clear nothing, so `status` says the older version runs until the next restart starts it.

## Not affiliated with Paradev

Paradev is a product of Superset Inc. This project uses Paradev's public CLI and is not made or endorsed by them.

## License

MIT. See [LICENSE](LICENSE).
