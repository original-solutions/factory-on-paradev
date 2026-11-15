# P3: The plugin is the only place an agent gets /factory

Product: Factory - by Original Solutions. This phase makes the `factory` plugin in this repo the one source of the `/factory` skill on every target, and has the runner refuse a target that lacks it.

Status: draft, written 2026-11-15, before the plugin spike, and revised the same day after review. What this draft knows about Paradev's plugin commands comes from `superset plugins <command> --help` on CLI 2.0.8 and three read-only calls on this Mac (`plugins validate .`, `plugins list --available`, `plugins marketplace list`). No plugin was installed, published or synced. Anything marked `[Spike: Sn]` waits on the spike question of that number, and the spike's record replaces the marker. Anything marked `[Assumption]` is not shown by the source and must be checked during the build. Issue numbers are in "Issues, in order".

Depends on: P2's two smokes, which passed (#58 on v0.3.1, `spike/HOST-SMOKE.md`; #59 on v0.3.4, `spike/CLOUD-SMOKE.md`). P2's exit criterion also asks for #60, the clockwork week on this Mac and the Trilogy Mac. That week has not run, so P2 is still open, and P3 does not wait for it. P3 changes placement in one place: this Mac can be dropped for a failed plugin check, as a host is dropped for a failed host check.

## Goal

An agent the runner starts, on this Mac, on a host or in a cloud sandbox, loads `/factory` from the installed `factory` plugin and from nowhere else. The runner checks each target for the plugin before it sends a run there.

Exit criterion: the spike repo's three smoke cases (done, needs-info, gate fails once) pass on this Mac, on the Trilogy Mac and in Paradev Cloud, with every `factory` skill folder on either Mac resolving into the installed plugin and no `.claude/skills/factory` in the spike repo.

## Where the skill comes from today

Read on 2026-11-15.

| Target | Where a session finds `/factory` | Version |
|---|---|---|
| this Mac | `~/.claude/skills/factory` and `~/.agents/skills/factory`, both links to `~/EA/skills/factory`, which links to `~/EA/projects/factory`, a clone of `rawphp/factory` at `7be6029` | Behind this repo. Six files differ, and it lacks the push dry-run rule of #57 |
| the Trilogy Mac | Not read for this draft `[Spike: S5]` | Unknown |
| cloud | `.claude/skills/factory` committed in the spike repo (its `main` at `69f8c0f`, copied from this repo at `73d844a`) | A snapshot. Any other repo that runs in the cloud needs its own copy |
| this repo | `plugins/factory/skills/factory`, plugin `factory` 0.1.0 in `plugins/factory/plugin.json`, listed in `.agent-marketplace.json` | The newest text. Nothing installs it |

So a local run and a cloud run of the same issue can follow different rules, and a fix to the skill reaches a target only when someone copies it there. `superset plugins marketplace list` on this Mac shows the built-in `superset` marketplace alone, and `~/.paradev/plugins/installed_plugins.json` has no `factory` entry.

`plugins validate .` on this checkout answers `[]` and exits 0. `[Spike: S1]` Whether `[]` means "no findings" or "no plugin found".

## Scope

In:

- The spike: Paradev's plugin commands run on all three targets, recorded as fixtures.
- `make release` giving the plugin the runner's version in the release commit, and publishing it if the spike shows an install needs that.
- A plugin check per target. This Mac beside the pass, a host in `hosts check`, the cloud by whichever way the spike settles.
- Self-update refusing a release that needs a newer plugin than the one installed.
- The first message calling the skill by the name the plugin gives it.
- One copy per machine. The links on both Macs point into the installed plugin, the copy in the spike repo goes, `rawphp/factory` stops taking changes, and a second copy fails the check.
- A launch refusing a repo whose base commit carries its own `.claude/skills/factory`.
- Two smoke findings in the text a session reads (#93).
- The README's install steps.

Out: anything hosted stays P4. Also out: more skills in the plugin (the filing side, `factory-issue`, stays where it is), an MCP server or an account connection in the plugin, a listing in Paradev's built-in marketplace, the runner installing or updating the plugin on any machine (V5), giving the plugin to the rest of the org, agents other than Claude, Linux hosts, and #60. The three smoke findings that touch neither the skill nor its first message become their own fix issues: a host-only repo that still needs a local Paradev project, `hosts check` reading `gh` over SSH where a Paradev terminal has another login, and a claimed run in `triage` that only closing its issue can end.

## Decisions

Proposed 2026-11-15. V1 and V2 are Tom's answers. V3 and V5 follow the review of the first draft. The rest took the smallest option the help text supports, and each one that rests on the spike says so.

| # | Decision | Proposed |
|---|---|---|
| V1 | Where `/factory` comes from | The installed plugin, for every session the runner starts. No separate copy on a machine, no copy in a repo |
| V2 | What ends the phase | The three smoke cases on all three targets with the other copies gone (Goal) |
| V3 | Which copy is the source, and what happens to `~/EA/skills/factory` | `plugins/factory/skills/factory` in this repo is the source. `rawphp/factory` takes no more changes, and its README points here. `~/EA/skills/factory` stays, as a link to the installed plugin's skill folder once S3 shows that path. `~/.claude/skills/factory` and `~/.agents/skills/factory` already link to it, so chat sessions in Claude, Grok, Cursor and Codex keep `/factory` and read the same text the runner's agents do. A Paradev plugin alone would be invisible to the last three |
| V4 | The plugin's version | The runner's. One number in `package.json`, `plugins/factory/plugin.json` and `.agent-marketplace.json`, written in the release commit (Release). The runner needs the installed plugin at `minPluginVersion` or newer. That number lives in `package.json` as `factory.minPluginVersion`, and the release sets it: to the new version when anything under `plugins/factory/skills` differs from the previous tag, and not at all otherwise (Release). A pull request cannot write it, because the number it would need does not exist until `npm version` runs. So a release that changes skill text needs that text on every target, and a release that changes none stops no target. Versions compare as three numbers, since `0.3.10` sorts below `0.3.9` as text |
| V5 | Who installs and updates the plugin | A person, on every machine, with the commands the check prints. The runner never installs. Self-update refuses a tag whose `factory.minPluginVersion` is newer than the installed plugin, stays on the running version, and logs the two commands (Self-update). So no unattended update lands and then drops this Mac |
| V6 | How a host is checked | One more line in `hosts check`, read over SSH from the host's `~/.paradev/plugins/installed_plugins.json`, which on this Mac lists `{ name, marketplace, version }` per plugin. No Paradev login is needed over SSH `[Spike: S5]`. A file that is missing or does not parse fails the host |
| V7 | How a cloud sandbox gets the plugin | (a) if the spike shows the launching user's install is already in the sandbox. This Mac's check is then the cloud check, because the runner's Paradev login is the launching user, and cloud is no candidate while this Mac's check fails. Else (c): the launch installs it in the sandbox through a helper terminal before `agents create`, the X3 pattern. (b), the org syncing this repo as a plugin source with `factory` set to `installed`, is in bounds only when that can be set for the sandbox alone. The help text offers `--member`, `--admin` and `--owner`, which are people, so on what is known (b) is out `[Spike: S6]`. If neither (a) nor (c) works, the cloud part of P3 stops and comes back to Tom |
| V8 | What the first message calls the skill | `/factory`, unless Paradev names a plugin's skill another way, in which case `launchBody` uses the recorded name `[Spike: S3]` |
| V9 | A second copy on a machine or in a repo | Fails. On a machine, a `factory` skill folder under `~/.claude/skills` or `~/.agents/skills` passes only when its resolved path is inside the plugin's install. In a repo, a base commit that holds `.claude/skills/factory` fails the launch. Both rules are turned on by #99, after #98 has removed the copies they would trip on |

## The spike

Hands-on, on CLI 2.0.8 or whatever is installed that day. Fixtures go to `spike/fixtures/<cli version>/` beside P0's, and the record to `spike/PLUGIN-SPIKE.md`. It installs the plugin on this Mac and the Trilogy Mac and removes nothing: the old links stay until #98.

| # | Question | How |
|---|---|---|
| S1 | Does the marketplace validate, and what does `[]` mean? | `plugins validate .`, then `--strict`, then again with a broken `plugin.json` |
| S2 | Is publish how an install gets the plugin, what does it write, and what tag does it name? | `plugins install` from a `marketplace add` of this repo with nothing published, then `plugins publish factory` on a branch. Record whether the first install worked, every file publish changes, the tag, and whether an install reads the default branch or a tag. A tag that matches `v*` would be picked up by `make deploy` and by self-update, which both read the highest `v*` tag |
| S3 | Where does an install put the skill, and under what name? | `plugins marketplace add original-solutions/factory-on-paradev`, `plugins install factory@factory-on-paradev`, then the files it wrote and `/factory` in a Paradev terminal on this Mac |
| S4 | With the old link still there, which copy does a session load? | A marker line in one copy, then ask the session to quote it |
| S5 | How does a host get the plugin, and how is its version read? | The plugin commands take no `--host`. Does the account's install reach the Trilogy Mac after `plugins sync` there, or must `install` run on it? Then read `installed_plugins.json` over SSH. Also record what `~/.claude/skills/factory` is on that Mac today |
| S6 | How does a cloud sandbox get it? | A fresh workspace and `ls` in a helper terminal for (a). Then (c). Then whether `organization access` can name anything but the three roles |
| S7 | Does `plugins install --update` move an installed version, and is the old skill text gone afterwards? | A second version, update, read the files, and check the path S3 recorded is the same |
| S8 | What does `plugins list --json` show for an installed marketplace plugin? | The row's fields, for this Mac's check |

S7 matters for V3. If an update moves the skill folder, the `~/EA/skills/factory` link breaks on every update and has to point at something stable instead.

## Release

`npm version` refuses a dirty tree, so the plugin's version cannot be written before it runs. `package.json` gains a `version` script, which npm runs after it bumps `package.json` and before it commits. The script writes the new number to `plugins/factory/plugin.json` and to the `factory` row of `.agent-marketplace.json` and stages both files, so all three land in the one release commit that the `v*` tag points at. When `git diff --quiet <previous v* tag> -- plugins/factory/skills` reports a difference, the script also sets `factory.minPluginVersion` to the new number. That is how a release binds the skill text it ships: the runner of that release refuses the plugin of the one before. `git diff --quiet` exits 1 when the skill differs, and the script reads that exit as the answer and carries on. An exit above 1 stops the release.

#94 writes the first `factory.minPluginVersion` by hand, equal to the version already in `package.json`. What a pull request cannot do after that is invent the next number.

`make release` then, between `npm version` and the push:

1. `superset plugins validate . --strict` on the release commit `[Spike: S1]`. A failure stops before anything is pushed, and the target prints how to undo the local commit and tag.
2. Publish, only if S2 shows an install gets the plugin from a published version. It finishes before the `v*` tag is pushed, so no runner sees a release whose plugin is not there yet. If S2 shows that `marketplace add` of this repo is the install path, there is no publish step. If publish names a tag of its own, it must not match `v*`.

`npm run check` stays free of the CLI, since `.github/workflows/check.yml` runs it where no Paradev is installed. It gains one test: the three version fields are equal, and `factory.minPluginVersion` is no newer than them. After a release that changed the skill the four numbers are equal, so it still passes.

## The check, per target

The rule: the `factory` plugin from the `factory-on-paradev` marketplace is installed at `minPluginVersion` or newer. #99 adds the second half, that no other copy is on the machine (V9).

| Target | When | How | When it fails |
|---|---|---|---|
| this Mac | Beside the pass, on the host check's cadence: right after each config load, every 5 minutes while not ready, every hour while ready | `superset plugins list --json` `[Spike: S8]` | This Mac is no candidate for placement, with one attention item `plugin-not-ready` that prints the fix |
| a host | In `hosts check`, as its other lines | The host's `installed_plugins.json` over SSH, read-only | The host is `host-not-ready` with the failing line, as today |
| cloud, under V7 (a) | This Mac's check | The same reading | Cloud is no candidate, with this Mac's reason |
| cloud, under V7 (c) | In `launch`, after the workspace is ready and before `agents create` | The helper terminal's install, then its exit code | The launch fails and the workspace is archived, as for any launch that fails before its agent |

Under (a) the runner never looks inside the sandbox. If the plugin is missing there all the same, `/factory` is an unknown command, the session ends with no result line, and the core handles it as it handles any turn that ends without one. That is a claimed run, not a failed launch, and nothing is archived early.

Placement today drops a host on `notReady` and drops this Mac only when the load or disk check holds claims (`dropReason` in `src/paradev/placement.ts`). #95 gives the local reading the same `notReady` field and the same line in `dropReason`.

The fix a failed version check prints:

```sh
superset plugins marketplace add original-solutions/factory-on-paradev
superset plugins install factory@factory-on-paradev --update
```

The fix a second copy prints is its own line, naming the path it found: `rm <path>` for a folder or a link that points elsewhere, or for the EA link, `ln -sfn <the install's skill folder> ~/EA/skills/factory`.

`factory-runner status` shows the failure as the target's `reason`. The belt says only which check failed, as it does for a host check. `BeltV2` does not change. No new config keys.

### Self-update

Self-update clones a newer tag, smokes it and places it under `versions/`. One step is added after the clone and before it is placed: read the clone's `factory.minPluginVersion` and this Mac's installed plugin version. When the installed one is older, the tag is not staged. The runner stays on its version and logs one line with the tag, the version it needs and the two commands above. A read that fails skips the stage the same way. The next ten-minute check looks again, so the update goes through by itself once a person has updated the plugin. It raises no attention item. `plugin-not-ready` belongs to the version check, which placement reads to drop this Mac, and the running version does not need the newer plugin, so this Mac keeps taking runs.

### A repo that carries the skill

Before a launch creates anything, the adapter reads the base commit in its own bare repo, `<data>/paradev/fetch/<project id>.git`: `git ls-tree <commit> -- .claude/skills/factory`. Any output fails the launch with text that names the repo and tells the reader to delete the folder there. A project-level skill would otherwise sit beside the plugin's in every worktree of that repo, on every target.

A local and a host launch already fetch the base into that bare repo before they create anything, so they read the commit that fetch returns. A cloud launch runs no git today: `launchCloud` in `src/paradev/sessions.ts` goes straight to `workspaces create`, and its contract test asserts an empty git call list. #99 adds the bare fetch alone to the cloud path, before `workspaces create`, and reads its commit. The bare repo is keyed by the Paradev project id on the launch request, the id `fetchBase` uses, and not by the cloud thread record's `projectId`, which holds the environment id. A fetch that fails fails the launch before `workspaces create`, as a local base fetch does. It does not run the rest of `fetchBase`, which moves `origin/<base>` in this Mac's clone, something a cloud launch has never done. Without the bare fetch a repo that commits the skill still reaches the sandbox, where Paradev checks that folder out.

## One copy per machine

#98, by hand, after the checks of #95 to #97 are live and each machine has the plugin:

1. On this Mac, point `~/EA/skills/factory` at the install's skill folder (V3). The other two links follow it.
2. On the Trilogy Mac, do the same to whatever S5 finds.
3. Delete `.claude/skills/factory` from the spike repo's `main`.
4. Replace `rawphp/factory`'s README with a pointer to this repo, and archive it.

#99, built by the factory after that, turns on V9 and deletes `plugins/factory/skills/factory/install.sh` with its line `bash -n install.sh` in `plugins/factory/skills/factory/scripts/check.sh`. The order matters. With V9 on before step 1, this Mac's check would fail on a link the printed install commands do not touch, and local placement would stop.

## The two text fixes (#93)

Neither waits on the spike.

- Ship's proof of the push. `references/ship.md` runs `git rev-parse HEAD origin/<branch>`, and `plugins/factory/skills/factory/scripts/check.sh` requires that line. In a cloud worktree `remote.origin.fetch` covers only `main`, so `origin/<branch>` does not exist after a fetch. The skill compares `git ls-remote origin refs/heads/<branch>` with `HEAD` instead, which works on every target, and the gate line changes in the same commit.
- The cloud first message. It says the session acts as the Paradev GitHub App and that `gh api user` answers 403. P2 records both shapes: the app on 2026-11-13 and the launching user's own login in #59. The runner has not read the token when it sends the message, so the message stops asserting either one and stops describing the all-false permissions. It keeps the push dry run, which both shapes pass.

## Tests

Contract tests replay the spike's fixtures, as P1's and P2's do: the plugin row parsed from `plugins list`, the host's `installed_plugins.json` when it is missing, unreadable, old and current, and the cloud path V7 settles on. Unit tests cover the version comparison (`0.3.10` against `0.3.9`), the equal version fields, the local `notReady` drop and its cadence, the first message's skill name, self-update's refusal and its skipped stage on a failed read, the version script with and without a skill change since the previous tag, the link test of V9, and the launch refusal on a base commit that holds the skill, on all three launch paths. The cloud contract test's git call list becomes the one bare fetch and the `ls-tree`.

The live smoke is the exit criterion. It runs the three cases once per target with the runner installed, as #58 and #59 did, after #99. One more case per Mac: uninstall the plugin, see the target drop out with `plugin-not-ready` or `host-not-ready`, install it, and see the target return within 5 minutes with no config reload.

## Issues, in order

Filed 2026-11-15 on `original-solutions/factory-on-paradev`, all `factory:proposed`. Each body is the build contract; where a body and this spec differ, the body wins. The spike's record may change #94 to #97 before they are set ready.

| Issue | Title | Depends on | Kind |
|---|---|---|---|
| #91 | chore: land the P3 spec | none | tracking, closed by the PR that adds this file |
| #92 | test: spike Paradev's plugin commands on this Mac, the Trilogy Mac and the cloud | #91 | hands-on |
| #93 | fix: Ship proves the push with ls-remote, and the cloud first message asserts no token | #91 | factory, S |
| #94 | feat: a release gives the plugin the runner's version, and publishes it if an install needs that | #92 | factory, S |
| #95 | feat: this Mac is no target without the factory plugin, and self-update refuses a release that needs a newer one | #94 or the spike result that replaces it, and #76 | factory, M |
| #96 | feat: hosts check reads the host's plugin | #95 | factory, S |
| #97 | feat: a cloud agent gets the plugin | #95 | factory, none under (a), M under (c) |
| #98 | chore: point every copy of the skill at the installed plugin | #95, #96, #97 | hands-on |
| #99 | feat: a second copy of the skill fails the check, on a machine and in a repo | #98 | factory, S |
| #100 | test: live smoke on all three targets with the plugin as the only copy | #99, #93 | hands-on |

#95 waits for #94 because a check that merges before any installable plugin exists drops this Mac with a fix nobody can run. The README's install steps go in with #95. #95 also waits for #76, which changes `src/selfUpdate.ts`.

## Dates

S6 and the live smoke need the Team plan, which renews on 2026-12-13, so both run before then. The date does not settle V7. The spike does.
