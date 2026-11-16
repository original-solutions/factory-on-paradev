# factory-on-paradev

The open-source runner for Factory by Original Solutions. Label a GitHub issue `factory:ready`, and the runner has a coding agent build it in a [Paradev](https://github.com/ParadevAI/Paradev) workspace, checks the result with your own tests on a fresh checkout, and opens a draft pull request.

**Status: pre-alpha.** Nothing here runs yet. The first milestone is a spike against a live Paradev to pin down the exact CLI responses the runner depends on.

## How it works

The runner is a small process on a machine where Paradev is signed in: your Mac, a Mac mini, or a Linux box added to Paradev as a host. It watches the repos you choose, or every repo in an account, for issues labelled `factory:ready`. For each one it:

1. Claims the issue and picks where the agent runs: this machine, another of your Paradev hosts, or Paradev Cloud.
2. Starts an isolated Paradev workspace with an agent running the `/factory-build` skill.
3. Waits for the agent's result line (`FACTORY-DONE: <PR URL>` or `FACTORY-STOP: <reason>`).
4. Runs the repo's gate commands on a fresh checkout of the pull request, and sends failures back to the same agent.
5. Marks the draft pull request ready for review, or posts the agent's questions on the issue.

It drives Paradev through the signed-in `superset` CLI, so your Paradev and agent logins stay on that machine. The runner works on its own, with no account anywhere. The hosted Factory dashboard by Original Solutions is a separate, optional product.

The repo is also the organization's Paradev plugin source: `superset plugins install factory@organization` lands the factory skill as `/factory-build` (see [The factory plugin](#the-factory-plugin)).

## Develop

```sh
npm ci
npm run check
```

Scripts run with Node's built-in type stripping (`node file.ts`), so there is no build step. `make build` is the same two commands.

## The factory plugin

The `factory` plugin in this repo carries the skill the runner's agents follow. Paradev lands it at `~/.agents/skills/factory-build/`, where a session calls it `/factory-build`. Set the plugin up once:

```sh
superset plugins organization sources add original-solutions/factory-on-paradev   # once per organization
superset plugins install factory@organization                                     # once per account, and on each Mac
launchctl kickstart -k gui/$(id -u)/sh.superset.host                              # on a host, after its install
```

On this Mac, restart the Paradev desktop app after the install. The install only records the plugin. A host's service copies the skill when it starts, and the app is expected to do the same.

The runner reads `~/.agents/skills/factory-build/VERSION` right after each config load, every 5 minutes while the check fails, and every hour while it passes. While that file is missing, empty, not a version, or older than `factory.minPluginVersion` in the runner's `package.json`, this Mac takes no run: placement drops it with `not ready: <reason>`, `factory-runner status` shows the reason on the `local` row, and the `plugin-not-ready` attention item prints the fix. Run `superset plugins install factory@organization`, restart the Paradev app, and this Mac takes runs again at the next check. The runner never installs the plugin and never restarts the app.

Cloud is checked only when the machine config has a `cloud` block, on the same cadence. The runner reads `superset plugins organization list` for a `factory` row at `factory.minPluginVersion` or newer, and `superset plugins list` for a `factory` row from an `organization-` marketplace whose status is `installed`. While either read fails or either row is missing or old, cloud takes no run, and `factory-runner status` shows the reason on the `cloud` row. When the organization's plugin is missing or old, the reason prints `make release-finish VERSION=<the runner's version>`, to run in a checkout of this repo. When the runner's account has not installed it, the reason prints `superset plugins install factory@organization`. A cloud sandbox boots with the account's plugins, so nothing is installed at launch.

Self-update holds back a tag whose `factory.minPluginVersion` is newer than this Mac's plugin, and a tag where either version cannot be read. It logs one line with the tag, the plugin it needs and the fix, raises `plugin-update-needed`, and stays on the running version, which keeps taking runs. Ten minutes later it tries the tag again, so the update goes through by itself once the plugin is new enough. A tag with no `factory.minPluginVersion` installs as before.

## Release and deploy

A release is a tag. `make release VERSION=0.1.0` runs the gate, refuses unless local `main` is `origin/main`, checks the plugin with `superset plugins validate .`, bumps `package.json`, commits `release: v0.1.0` on `main` and tags `v0.1.0`. Merges to `main` are not deploys; the tag is the decision to ship.

The release gives the `factory` plugin the runner's version. The release commit holds one number in `package.json`, `plugins/factory/plugin.json`, the `factory` row of `.agent-marketplace.json` and `plugins/factory/skills/build/VERSION`. When the skill changed since the previous `v*` tag, the release also sets `factory.minPluginVersion` in `package.json` to that number. Then `make release-finish VERSION=0.1.0` pushes the release commit to `main` without the tag, runs `superset plugins organization sources sync original-solutions/factory-on-paradev`, waits for the sync to land, checks that the organization synced the release commit with no problem and lists `factory` at the new version, and pushes the tag last. A `git` or `superset` call that does not answer within 60 s counts as a failure. If any of that fails, no tag is on GitHub, and the output says what comes next: run `make release-finish VERSION=0.1.0` again once the cause is fixed; or, when `main` moved on before the sync, nothing, since the next release carries the change; or, when `origin` refused the release commit as `main` because `main` moved on, drop the local tag and release commit with `git tag -d v0.1.0 && git fetch origin main && git reset --hard origin/main` and run `make release VERSION=0.1.0` again.

A skill change reaches a target only through a release. The organization refuses changed content under an unchanged version, and the release is the only step that syncs it, so a merge that changes `plugins/factory/skills` waits on `main` until the next release.

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
