# P3: The plugin is the only place an agent gets its factory skill

Product: Factory - by Original Solutions. This phase makes the `factory` plugin in this repo the one source of the factory skill on every target, and has the runner refuse a target that lacks it.

Status: draft, written 2026-11-15 and rewritten the same day from the plugin spike (#92). Every fact about Paradev's plugin commands is in `spike/PLUGIN-SPIKE.md` or a fixture under `spike/fixtures/2.0.8/plugins-*`. Anything marked `[Assumption]` is not shown by the source and must be checked during the build. Issue numbers are in "Issues, in order".

Depends on: P2's two smokes, which passed (#58 on v0.3.1, `spike/HOST-SMOKE.md`; #59 on v0.3.4, `spike/CLOUD-SMOKE.md`). P2's exit criterion also asks for #60, the clockwork week on this Mac and the Trilogy Mac. That week has not run, so P2 is still open, and P3 does not wait for it. P3 changes placement in one place: this Mac can be dropped for a failed plugin check, as a host is dropped for a failed host check.

## Goal

An agent the runner starts, on this Mac, on a host or in a cloud sandbox, loads its skill from the installed `factory` plugin. The runner checks each target for the plugin before it sends a run there.

Exit criterion: the spike repo's three smoke cases (done, needs-info, gate fails once) pass on this Mac, on the Trilogy Mac and in Paradev Cloud, with `factory-factory` the only factory skill folder on either Mac and no `.claude/skills/factory` in the spike repo.

## What the spike settled

1. The plugin has to be the organization's. A marketplace a person adds installs on one machine and never reaches the account, so a cloud sandbox never gets it. `superset plugins organization sources add original-solutions/factory-on-paradev` makes this repo's default branch the organization's plugin source, with no tag and no publish.
2. Paradev names a plugin's skill `<plugin>-<skill>`. The skill lands at `~/.agents/skills/factory-factory/`, a copy of `plugins/factory/skills/factory` with every file in it, and a session calls it `/factory-factory`.
3. A cloud sandbox boots with the account's plugins at the version the organization last synced. Nothing is installed at launch, and nothing can be: the sandbox's CLI has no `plugins install`.
4. A Mac needs two steps by a person: `superset plugins install factory@organization`, then a restart of the Paradev host service (a host) or the desktop app (this Mac). The CLI records the install and copies no skill. The service does the copy when it starts.
5. The organization refuses changed content under an unchanged version. A skill change reaches no target until the plugin's version is bumped and the source is synced.
6. The old copy and the plugin's do not clash, because their names differ. `/factory` stays the old text for as long as an old copy exists, and `/factory-factory` is the plugin's.

## Where the skill comes from today

| Target | Where a session finds it | Version |
|---|---|---|
| this Mac | `~/.claude/skills` is a link to `~/.agents/skills`, where `factory` links to `~/EA/skills/factory`, which links to `~/EA/projects/factory`, a clone of `rawphp/factory` at `7be6029` | Behind this repo. Six files differ |
| the Trilogy Mac | The same chain of links under `/Users/tomk`, and since the spike `~/.agents/skills/factory-factory` from the plugin at 0.1.0 | Old text under `/factory`, the plugin's under `/factory-factory` |
| cloud | `.claude/skills/factory` committed in the spike repo, and since the spike `~/.agents/skills/factory-factory` in every new sandbox | The same pair |
| this repo | `plugins/factory/skills/factory`, plugin `factory` 0.1.0 | The source |

## Scope

In:

- `make release` giving the plugin the runner's version and syncing the organization's source.
- A plugin check per target: this Mac beside the pass, a host in `hosts check`, the cloud from the organization's listing.
- Self-update refusing a release that needs a newer plugin than this Mac has.
- The first message calling `/factory-factory`.
- Removing the old copies: the links on both Macs, the copy in the spike repo, and `rawphp/factory` as a place that takes changes.
- The README's setup steps.

Out: anything hosted stays P4. Also out: more skills in the plugin (the filing side, `factory-issue`, stays where it is), an MCP server or an account connection in the plugin, a listing in Paradev's built-in marketplace, the runner installing the plugin or restarting anything (V5), giving the plugin to the organization's `member` role, agents other than Claude, Linux hosts, and #60. Also out, because finding 6 removes the need: a check for a second copy on a machine, and a launch refusing a repo that carries `.claude/skills/factory`. The three smoke findings that touch neither the skill nor its first message become their own fix issues. The two that do are fixed (#93, merged).

## Decisions

V1 and V2 are Tom's answers. V5 follows the review of the first draft. V3, V6, V8 and V9 are proposals from the spike and wait for Tom's yes.

| # | Decision | Settled or proposed |
|---|---|---|
| V1 | Where the skill comes from | The installed plugin, for every session the runner starts |
| V2 | What ends the phase | The three smoke cases on all three targets with the old copies gone (Goal) |
| V3 | The old copies | Proposed: remove them. `~/EA/skills/factory`, `~/.agents/skills/factory` and the `rawphp/factory` clone go on both Macs, and people type `/factory-factory` as the runner does. The plugin's skill lands in `~/.agents/skills`, the hub every client on these Macs reads, so Grok, Cursor and Codex see it too. Keeping a link named `factory` to the landed folder would give one skill two names, and keeping the old clone would give `/factory` different text from what the runner's agents follow |
| V4 | The plugin's version | The runner's. One number in `package.json`, `plugins/factory/plugin.json`, `.agent-marketplace.json` and `plugins/factory/skills/factory/VERSION`, written in the release commit. The runner needs a target's plugin at `factory.minPluginVersion` or newer, a field in `package.json` that the release sets to the new version when the skill's text changed since the previous tag. Versions compare as three numbers, since `0.3.10` sorts below `0.3.9` as text |
| V5 | Who installs and updates the plugin | A person, on each Mac, with the commands the check prints. The runner never installs and never restarts a service. Self-update refuses a tag whose `factory.minPluginVersion` is newer than this Mac's plugin and stays on the running version |
| V6 | What the check reads on a Mac | Proposed: one file, `~/.agents/skills/factory-factory/VERSION`, on this Mac directly and on a host over SSH. Paradev copies every file of the skill folder, so the file says both that the skill has landed and at which version. `installed_plugins.json` and `plugins list` cannot say the first: after an update they show the new version while the landed skill is still the old text, until the restart |
| V7 | How a cloud sandbox gets the plugin | With no step. The check reads `superset plugins organization list` for `factory` at `factory.minPluginVersion` or newer, and `superset plugins list` for `factory` as `installed` on the runner's account. Cloud is no candidate while either fails |
| V8 | What the first message calls the skill | Proposed: `/factory-factory`. Renaming the skill folder to get a better name (`build` would give `/factory-build`) means editing the skill's own text and its gate for a string only the runner types |
| V9 | A second copy | Proposed: no check. The names differ, so an old copy cannot shadow the plugin's (finding 6). #99 is not built |

## One-time setup, by a person

Done during the spike for this organization and both Macs, except the last line.

```sh
superset plugins organization sources add original-solutions/factory-on-paradev   # once per organization
superset plugins install factory@organization                                     # once per account, and on each Mac
launchctl kickstart -k gui/$(id -u)/sh.superset.host                              # on a host, after its install
```

On this Mac the last step is a restart of the Paradev desktop app. `[Assumption]` The app copies the skill at start as the host service does. The app's code has the same step and the same call at start, and the spike did not restart it.

## Release

`npm version` refuses a dirty tree, so the plugin's version cannot be written before it runs. `package.json` gains a `version` script, which npm runs after it bumps `package.json` and before it commits. The script writes the new number to `plugins/factory/plugin.json`, to the `factory` row of `.agent-marketplace.json` and to `plugins/factory/skills/factory/VERSION`, and stages all three, so they land in the release commit the `v*` tag points at.

When `git diff --quiet <previous v* tag> -- plugins/factory/skills ':!plugins/factory/skills/factory/VERSION'` exits 1, the script also sets `factory.minPluginVersion` to the new number. That exit is the answer, and the script carries on. An exit above 1 stops the release. #94 writes the first `factory.minPluginVersion` by hand, equal to the version already in `package.json`, and adds the first `VERSION` file.

`make release` then:

1. Before `npm version`, `superset plugins validate .`, which exits 1 on a manifest it cannot read.
2. After the push, `superset plugins organization sources sync original-solutions/factory-on-paradev`, then reads `organization sources list` and `organization list`. The release fails, with the text Paradev gave, when `syncProblems` is not empty or the organization's `factory` is not at the new version.

The `VERSION` file changes in every release, so every release is new content under a new version, which is what the organization's sync asks for. Between releases a merge that changes the skill does not reach any target: a sync of `main` at that point is refused with `its content changed but its version is still x`, and the organization keeps the last release's text. So a skill fix ships with a release, as a runner fix does.

`[Assumption]` The organization's source syncs only when someone runs `sources sync`. The spike saw no sync in the 75 s after a push.

`npm run check` stays free of the CLI, since `.github/workflows/check.yml` runs it where no Paradev is installed. It gains one test: the four version fields are equal, and `factory.minPluginVersion` is no newer than them.

## The check, per target

| Target | When | How | When it fails |
|---|---|---|---|
| this Mac | Beside the pass, on the host check's cadence: right after each config load, every 5 minutes while not ready, every hour while ready | `~/.agents/skills/factory-factory/VERSION` | This Mac is no candidate for placement, with one attention item `plugin-not-ready` that prints the fix |
| a host | In `hosts check`, as its other lines | The same file over SSH, read-only. A file that is missing or does not hold a version fails the line | The host is `host-not-ready` with the failing line, as today |
| cloud | On this Mac's cadence | `plugins organization list` and `plugins list` (V7) | Cloud is no candidate, with a reason that prints the fix |

The fixes printed:

```sh
# this Mac
superset plugins install factory@organization     # then restart the Paradev app
# a host, run on that host
superset plugins install factory@organization && launchctl kickstart -k gui/$(id -u)/sh.superset.host
# cloud
superset plugins organization sources sync original-solutions/factory-on-paradev
```

A host service restart does not stop that host's agents (P2, H5), and the spike restarted the Trilogy Mac's four times.

Placement today drops a host on `notReady` and drops this Mac only when the load or disk check holds claims (`dropReason` in `src/paradev/placement.ts`). #95 gives the local reading the same `notReady` field and the same line in `dropReason`.

Under V7 the runner never looks inside the sandbox. If the skill is missing there all the same, `/factory-factory` is an unknown command, the session ends with no result line, and the core handles it as it handles any turn that ends without one.

`factory-runner status` shows a failure as the target's `reason`. The belt says only which check failed, as it does for a host check. `BeltV2` does not change. No new config keys.

### Self-update

Self-update clones a newer tag, smokes it and places it under `versions/`. One step is added after the clone and before it is placed: read the clone's `factory.minPluginVersion` and this Mac's `VERSION` file. When the landed plugin is older, the tag is not staged. The runner stays on its version and logs one line with the tag, the version it needs and this Mac's fix. A read that fails skips the stage the same way. The next ten-minute check looks again, so the update goes through by itself once a person has updated the plugin. It raises no attention item. `plugin-not-ready` belongs to the version check, which placement reads to drop this Mac, and the running version does not need the newer plugin, so this Mac keeps taking runs.

## The first message

`launchBody` calls `/factory-factory` in place of `/factory`, for every target. The switch lands with the last of the three checks (#97), so no target that passed its check gets a command it does not have.

## Removing the old copies

#98, by hand, after the three checks are live:

1. On both Macs, remove `~/.agents/skills/factory` and `~/EA/skills/factory` (V3).
2. Delete `.claude/skills/factory` from the spike repo's `main`.
3. Replace `rawphp/factory`'s README with a pointer to this repo, and archive it.

`plugins/factory/skills/factory/install.sh`, which links the skill into `~/.agents/skills`, is deleted in #95 with its line `bash -n install.sh` in `plugins/factory/skills/factory/scripts/check.sh`.

## Tests

Contract tests replay the spike's fixtures, as P1's and P2's do: the organization's listing with `factory` missing, old and current (`plugins-org-list-after.json`, `plugins-org-list-after-bump.json`), the account's listing (`plugins-list-update-available.json`), and a source with a sync problem. Unit tests cover the version comparison (`0.3.10` against `0.3.9`), the `VERSION` read when the file is missing, empty and current, the equal version fields, the `version` script with and without a skill change since the previous tag, the local `notReady` drop and its cadence, the first message's skill name, and self-update's refusal and its skipped stage on a failed read.

The live smoke is the exit criterion. It runs the three cases once per target with the runner installed, as #58 and #59 did, after #98. One more case per Mac: remove `~/.agents/skills/factory-factory`, see the target drop out with `plugin-not-ready` or `host-not-ready`, restart the service or the app, and see the target return within 5 minutes with no config reload.

## Issues, in order

Filed 2026-11-15 on `original-solutions/factory-on-paradev`. Each body is the build contract; where a body and this spec differ, the body wins. The bodies of #94 to #98 and #100 predate the spike and are rewritten to this spec before any is set ready.

| Issue | Title | Depends on | Kind |
|---|---|---|---|
| #91 | chore: land the P3 spec | none | closed |
| #92 | test: spike Paradev's plugin commands on this Mac, the Trilogy Mac and the cloud | #91 | hands-on, closed by the record's pull request |
| #93 | fix: Ship proves the push with ls-remote, and the cloud first message asserts no token | #91 | closed |
| #94 | feat: a release gives the plugin the runner's version and syncs the organization's source | #92 | factory, S |
| #95 | feat: this Mac is no target without the factory plugin, and self-update refuses a release that needs a newer one | #94 | factory, M |
| #96 | feat: hosts check reads the host's plugin | #95 | factory, S |
| #97 | feat: cloud is no target without the organization's plugin, and the first message calls /factory-factory | #96 | factory, S |
| #98 | chore: remove the old copies of the skill | #95, #96, #97 | hands-on |
| #99 | feat: a second copy of the skill fails the check | | not built (V9) |
| #100 | test: live smoke on all three targets with the plugin as the only copy | #98 | hands-on |

## Asks for Paradev that would remove workarounds

- `superset plugins install` and `plugins sync` copying skills themselves. On CLI 2.0.8 both skip it with `Bundled plugin missing at /$bunfs/templates/plugin`, which is why each update needs a service or app restart.
- The host service installing the account's plugins when it starts, as a cloud sandbox does. That removes the per-host install.
- The reason behind `account sync failed` in the install's answer.
- A plugin's own choice of skill name, so `factory` could stay `/factory`.

## Dates

The live smoke needs the Team plan, which renews on 2026-12-13, so it runs before then.
