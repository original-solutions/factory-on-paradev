# P3: The plugin is the only place an agent gets its factory skill

Product: Factory - by Original Solutions. This phase makes the `factory` plugin in this repo the one source of the factory skill on every target, and has the runner refuse a target that lacks it.

Status: draft, written 2026-11-15 and rewritten the same day from the plugin spike (#92). Every fact about Paradev's plugin commands is in `spike/PLUGIN-SPIKE.md` or a fixture under `spike/fixtures/2.0.8/plugins-*`. Anything marked `[Assumption]` is not shown by the source and must be checked during the build. Issue numbers are in "Issues, in order".

Depends on: P2's two smokes, which passed (#58 on v0.3.1, `spike/HOST-SMOKE.md`; #59 on v0.3.4, `spike/CLOUD-SMOKE.md`). P2's exit criterion also asks for #60, the clockwork week on this Mac and the Trilogy Mac. That week has not run, so P2 is still open, and P3 does not wait for it. P3 changes placement in one place: this Mac can be dropped for a failed plugin check, as a host is dropped for a failed host check.

## Goal

An agent the runner starts, on this Mac, on a host or in a cloud sandbox, loads its skill from the installed `factory` plugin. The runner checks each target for the plugin before it sends a run there.

Exit criterion: the spike repo's three smoke cases (done, needs-info, gate fails once) pass on this Mac, on the Trilogy Mac and in Paradev Cloud, with `factory-build` the only factory skill folder on either Mac and no `.claude/skills/factory` in the spike repo.

## What the spike settled

1. The plugin has to be the organization's. A marketplace a person adds installs on one machine and never reaches the account, so a cloud sandbox never gets it. `superset plugins organization sources add original-solutions/factory-on-paradev` makes this repo's default branch the organization's plugin source, with no tag and no publish.
2. Paradev names a plugin's skill `<plugin>-<skill>`. In the spike the skill landed at `~/.agents/skills/factory-factory/`, a copy of `plugins/factory/skills/factory` with every file in it. V8 renames the skill folder to `build`, so it lands at `~/.agents/skills/factory-build/` and a session calls it `/factory-build`.
3. A cloud sandbox boots with the account's plugins at the version the organization last synced. Nothing is installed at launch, and nothing can be: the sandbox's CLI has no `plugins install`.
4. A Mac needs two steps by a person: `superset plugins install factory@organization`, then a restart of the Paradev host service (a host) or the desktop app (this Mac). The CLI records the install and copies no skill. The service does the copy when it starts.
5. The organization refuses changed content under an unchanged version. A skill change reaches no target until the plugin's version is bumped and the source is synced.
6. The old copy and the plugin's do not clash, because their names differ. `/factory` stays the old text for as long as an old copy exists, and the plugin's skill has its own name.

## Where the skill comes from today

| Target | Where a session finds it | Version |
|---|---|---|
| this Mac | `~/.claude/skills` is a link to `~/.agents/skills`, where `factory` links to `~/EA/skills/factory`, which links to `~/EA/projects/factory`, a clone of `rawphp/factory` at `7be6029` | Behind this repo. Six files differ |
| the Trilogy Mac | The same chain of links under `/Users/tomk`, and since the spike `~/.agents/skills/factory-factory` from the plugin at 0.1.0 | Old text under `/factory`, the plugin's under `/factory-factory` |
| cloud | `.claude/skills/factory` committed in the spike repo, and since the spike `~/.agents/skills/factory-factory` in every new sandbox | The same pair |
| this repo | `plugins/factory/skills/factory`, plugin `factory` 0.1.0 | The source |

## Scope

In:

- `make release` giving the plugin the runner's version and syncing the organization's source before it pushes the tag.
- A plugin check per target: this Mac beside the pass, a host in `hosts check`, the cloud from the organization's listing.
- Self-update refusing a release that needs a newer plugin than this Mac has.
- The first message calling `/factory-build`.
- Removing the old copies: the links on both Macs, the copy in the spike repo, and `rawphp/factory` as a place that takes changes.
- The README's setup steps.

Out: anything hosted stays P4. Also out: more skills in the plugin (the filing side, `factory-issue`, stays where it is), an MCP server or an account connection in the plugin, a listing in Paradev's built-in marketplace, the runner installing the plugin or restarting anything (V5), giving the plugin to the organization's `member` role, agents other than Claude, Linux hosts, and #60. Also out, because finding 6 removes the need: a check for a second copy on a machine, and a launch refusing a repo that carries `.claude/skills/factory`. The three smoke findings that touch neither the skill nor its first message become their own fix issues. The two that do are fixed (#93, merged).

## Decisions

V1, V2 and V8 are Tom's answers, and he agreed V6 and V9 on 2026-11-15. V5 follows the review of the first draft. V3 is a proposal from the spike and waits for Tom's yes.

| # | Decision | Settled or proposed |
|---|---|---|
| V1 | Where the skill comes from | The installed plugin, for every session the runner starts |
| V2 | What ends the phase | The three smoke cases on all three targets with the old copies gone (Goal) |
| V3 | The old copies | Proposed: remove them. `~/EA/skills/factory`, `~/.agents/skills/factory` and the `rawphp/factory` clone go on both Macs, and people type `/factory-build` as the runner does. The plugin's skill lands in `~/.agents/skills`, the hub every client on these Macs reads, so Grok, Cursor and Codex see it too. Keeping a link named `factory` to the landed folder would give one skill two names, and keeping the old clone would give `/factory` different text from what the runner's agents follow |
| V4 | The plugin's version | The runner's. One number in `package.json`, `plugins/factory/plugin.json`, `.agent-marketplace.json` and `plugins/factory/skills/build/VERSION`, written in the release commit. The runner needs a target's plugin at `factory.minPluginVersion` or newer, a field in `package.json` that the release sets to the new version when the skill's text changed since the previous tag. Versions compare as three numbers, since `0.3.10` sorts below `0.3.9` as text |
| V5 | Who installs and updates the plugin | A person, on each Mac, with the commands the check prints. The runner never installs and never restarts a service. Self-update refuses a tag whose `factory.minPluginVersion` is newer than this Mac's plugin, stays on the running version and raises the attention item `plugin-update-needed` |
| V6 | What the check reads on a Mac | One file, `~/.agents/skills/factory-build/VERSION`, on this Mac directly and on a host over SSH. Paradev copies every file of the skill folder, so the file says both that the skill has landed and at which version. `installed_plugins.json` and `plugins list` cannot say the first: after an update they show the new version while the landed skill is still the old text, until the restart |
| V7 | How a cloud sandbox gets the plugin | With no step. The check reads `superset plugins organization list` for `factory` at `factory.minPluginVersion` or newer, and `superset plugins list` for `factory` as `installed` on the runner's account. Cloud is no candidate while either fails |
| V8 | What the skill is called | `/factory-build`. The skill folder is renamed from `skills/factory` to `skills/build`, its frontmatter `name` becomes `build`, and Paradev lands it as `factory-build`. The plugin stays `factory`, so the install stays `factory@organization`, and a later skill can sit beside it under the same prefix: retro, now the mode `/factory retro`, could become `/factory-retro`. #94 does the rename, with the places the skill's own text and its gate say `factory` |
| V9 | A second copy | No check. The names differ, so an old copy cannot shadow the plugin's (finding 6). #99 is not built |

## One-time setup, by a person

Done during the spike for this organization and both Macs, except the last line.

```sh
superset plugins organization sources add original-solutions/factory-on-paradev   # once per organization
superset plugins install factory@organization                                     # once per account, and on each Mac
launchctl kickstart -k gui/$(id -u)/sh.superset.host                              # on a host, after its install
```

On this Mac the last step is a restart of the Paradev desktop app. `[Assumption]` The app copies the skill at start as the host service does. The app's code has the same step and the same call at start, and the spike did not restart it.

## Release

`npm version` refuses a dirty tree, so the plugin's version cannot be written before it runs. `package.json` gains a `version` script, which npm runs after it bumps `package.json` and before it commits. The script writes the new number to `plugins/factory/plugin.json`, to the `factory` row of `.agent-marketplace.json` and to `plugins/factory/skills/build/VERSION`, and stages all three, so they land in the release commit the `v*` tag points at.

When `git diff --quiet <previous v* tag> -- plugins/factory/skills ':!plugins/factory/skills/build/VERSION'` exits 1, the script also sets `factory.minPluginVersion` to the new number. That exit is the answer, and the script carries on. An exit above 1 stops the release. #94 writes the first `factory.minPluginVersion` by hand, equal to the version already in `package.json`, adds the first `VERSION` file, and renames the skill folder (V8). The `check` script in `package.json` follows the folder to `plugins/factory/skills/build/scripts/check.sh`.

`make release` then, in this order:

1. Before `npm version`, `superset plugins validate .`, which exits 1 on a manifest it cannot read.
2. `make release-finish VERSION=<version>`, a target of its own that runs steps 3 to 5 from one script, so a person can run it again. It is the only place that syncs the organization's source and the only place that pushes a tag. The `release` recipe holds no `git push` of its own.
3. `git push --no-follow-tags origin main`, which sends the release commit without its tag, unless `origin/main` already holds that commit. Today the target pushes both at once. The flag matters: `npm version` makes an annotated tag, and with `push.followTags` set in a person's git config a plain push of `main` would send it. The script then fetches and stops, before any sync, unless the head of `origin/main` is the commit the local tag `v<version>` points at.
4. `superset plugins organization sources sync original-solutions/factory-on-paradev`, then reads `organization sources list` and `organization list`. The release fails, with the text Paradev gave, when `syncProblems` is not empty, when the source's `syncedSha` is not the commit the local tag `v<version>` points at, or when the organization's `factory` is not at the new version.
5. `git push origin v<version>`, only after step 4 passes.

Self-update reads tags, so no runner sees a release before the organization holds its plugin. A release that fails at step 4 has its commit on `main` and no tag on GitHub. The target prints one command for a person to run once the cause is fixed, `make release-finish VERSION=<version>`. Nothing prints the sync or the tag push by themselves, so no tag goes out past the `syncedSha` check. When `main` has moved past the release commit, step 3 stops the second run with the organization untouched, and the next release carries the change.

A `syncedSha` that is not the release commit means a merge reached `main` between step 3's check and the sync, and the organization now holds that text under the release's version. It takes no other content under that version (finding 5), so the tag stays unpushed and the next release replaces the text under a new version. Until then the rule on a skill change below covers the targets that got it.

The `VERSION` file changes in every release, so every release is new content under a new version, which is what the organization's sync asks for. Between releases a merge that changes the skill does not reach any target: a sync of `main` at that point is refused with `its content changed but its version is still x`, and the organization keeps the last release's text. So a skill change reaches a target only at a release.

It does not reach every target together with that release's runner. The organization is synced during the release, so a new cloud sandbox, and a Mac whose plugin a person has updated, have the new skill while this Mac still runs the previous runner: for the ten minutes until self-update stages the release, or for as long as self-update refuses it. The checks allow that, since they ask for `factory.minPluginVersion` or newer. So a skill change has to work under the runner that is still running: the first message that runner sends and the result line it reads stay valid. A change to either goes out in two releases, and the first is a runner that takes both forms.

`[Assumption]` The organization's source syncs only when someone runs `sources sync`. The spike saw no sync in the 75 s after a push.

`npm run check` stays free of the CLI, since `.github/workflows/check.yml` runs it where no Paradev is installed. It gains one test: the four version fields are equal, and `factory.minPluginVersion` is no newer than them.

## The check, per target

| Target | When | How | When it fails |
|---|---|---|---|
| this Mac | Beside the pass, on the host check's cadence: right after each config load, every 5 minutes while not ready, every hour while ready | `~/.agents/skills/factory-build/VERSION` | This Mac is no candidate for placement, with one attention item `plugin-not-ready` that prints the fix |
| a host | In `hosts check`, as its other lines | The same file over SSH, read-only. A file that is missing or does not hold a version fails the line | The host is `host-not-ready` with the failing line, as today |
| cloud | On this Mac's cadence | `plugins organization list` and `plugins list` (V7) | Cloud is no candidate, with a reason that prints the fix |

The fixes printed:

```sh
# this Mac
superset plugins install factory@organization     # then restart the Paradev app
# a host, run on that host
superset plugins install factory@organization && launchctl kickstart -k gui/$(id -u)/sh.superset.host
# cloud, in a checkout of this repo, with the version the runner printed
make release-finish VERSION=<version>
```

The cloud fix is the release's own step, for an organization whose source was removed or never synced. The runner prints it with its own version. A bare `sources sync` would take `main` as it is, under whatever version `main` carries, so the runner never prints one. When `main` has moved past that version's tag, `release-finish` stops at step 3 and says so, and the fix is the next release.

A host service restart does not stop that host's agents (P2, H5), and the spike restarted the Trilogy Mac's four times.

Placement today drops a host on `notReady` and drops this Mac only when the load or disk check holds claims (`dropReason` in `src/paradev/placement.ts`). #95 gives the local reading the same `notReady` field and the same line in `dropReason`.

Under V7 the runner never looks inside the sandbox. If the skill is missing there all the same, `/factory-build` is an unknown command, the session ends with no result line, and the core handles it as it handles any turn that ends without one.

`factory-runner status` shows a failure as the target's `reason`. The belt says only which check failed, as it does for a host check. `BeltV2` does not change. No new config keys.

### Self-update

Self-update clones a newer tag, installs and smokes it and places it under `versions/`. One step is added after the clone's commit check and before `npm ci`: read the clone's `factory.minPluginVersion` and this Mac's `VERSION` file. When the landed plugin is older, the tag is not staged. The runner removes the clone, stays on its version and logs one line with the tag, the version it needs and this Mac's fix. A read that fails skips the stage the same way.

The refusal does not mark the tag. Every other step that stops a stage goes through `fail` in `stageTag` (`src/selfUpdate.ts`), which adds the tag to the `failed` set, and `check` skips a tag in that set until the runner restarts. The plugin step returns without `fail`. So the next ten-minute check looks again, and the update goes through by itself once a person has updated the plugin. A refused check costs one shallow clone, since the step comes before `npm ci` and the smoke. The runner logs the line once per tag and reason while it runs, not every ten minutes.

A log line alone leaves this Mac on the old runner for as long as nobody reads the log, and every later release waits behind the refused one. So the refusal raises one attention item, `plugin-update-needed`, with the tag, the version it needs and this Mac's fix. A failed read raises it with what the read said. The item goes as soon as that tag, or a newer one, passes the step. A stage that fails after that, at `npm ci` or the smoke, is reported as any failed stage is today, and the item does not come back for it. It is not `plugin-not-ready`, which belongs to the version check that placement reads to drop this Mac. Placement does not read `plugin-update-needed`: the running version does not need the newer plugin, so this Mac keeps taking runs.

The step holds every release after the one that carries it. It cannot hold that one, because the runner that stages #95's release was built before the step. So #95 goes out in a release that changes nothing under `plugins/factory/skills`. #94 renames the skill folder, so #94 is released before #95 merges. Before #95 merges, a person also runs this Mac's fix and reads `~/.agents/skills/factory-build/VERSION` at #94's version. #95's `factory.minPluginVersion` is then #94's release, which this Mac already has. If the skill on `main` differs from the last `v*` tag for any other reason when #95 is ready to merge, a release goes out first and is installed the same way. If the install is missed, the new runner's own check drops this Mac with `plugin-not-ready` until someone does it.

## The first message

`launchBody` calls `/factory-build` in place of `/factory`, for every target. The switch lands with the last of the three checks (#97), so no target that passed its check gets a command it does not have.

## Removing the old copies

#98, by hand, after the three checks are live:

1. On both Macs, remove `~/.agents/skills/factory` and `~/EA/skills/factory` (V3), and `~/.agents/skills/factory-factory` where it is there. The spike's 0.1.0 landed it on the Trilogy Mac, and no later install lands that name, since #94 renames the skill. Nothing shows that Paradev removes a landed folder whose skill is gone.
2. Delete `.claude/skills/factory` from the spike repo's `main`.
3. Replace `rawphp/factory`'s README with a pointer to this repo, and archive it.

`install.sh` in the skill folder, which links the skill into `~/.agents/skills`, is deleted in #94 with its line `bash -n install.sh` in the skill's `scripts/check.sh`.

## Tests

Contract tests replay the spike's fixtures, as P1's and P2's do: the organization's listing with `factory` missing, old and current (`plugins-org-list-after.json`, `plugins-org-list-after-bump.json`), the account's listing (`plugins-list-update-available.json`), a source with a sync problem, and a source whose `syncedSha` is another commit. The script behind `make release-finish` runs under a test with a stubbed `git` and `superset`, so `npm run check` still needs no CLI: for a sync problem, another `syncedSha` and an organization's version that is not the new one, no `git push` names the tag, `--tags` or `--follow-tags`, the push of `main` carries `--no-follow-tags`, and when step 4 passes the tag push is the last call. The same holds when `origin/main` is not at the release commit, where `sources sync` is not called either. One more test reads the `release` recipe in the `Makefile` and fails on a `git push` in it. Unit tests cover the version comparison (`0.3.10` against `0.3.9`), the `VERSION` read when the file is missing, empty and current, the equal version fields, the `version` script with and without a skill change since the previous tag, the local `notReady` drop and its cadence, the first message's skill name, the cloud check's reason on the `factory`-missing listing, whose fix is exactly `make release-finish VERSION=<the runner's version>` and holds no `sources sync`, self-update's refusal, its skipped stage on a failed read and the same tag staged at the next check once the plugin is new enough, and the `plugin-update-needed` item raised once and cleared when the tag passes the step, also when `npm ci` then fails.

The live smoke is the exit criterion. It runs the three cases once per target with the runner installed, as #58 and #59 did, after #98. One more case per Mac: remove `~/.agents/skills/factory-build`, see the target drop out with `plugin-not-ready` or `host-not-ready`, restart the service or the app, and see the target return within 5 minutes with no config reload.

## Issues, in order

Filed 2026-11-15 on `original-solutions/factory-on-paradev`. Each body is the build contract; where a body and this spec differ, the body wins. The bodies of #94 to #98 and #100 predate the spike and are rewritten to this spec before any is set ready.

| Issue | Title | Depends on | Kind |
|---|---|---|---|
| #91 | chore: land the P3 spec | none | closed |
| #92 | test: spike Paradev's plugin commands on this Mac, the Trilogy Mac and the cloud | #91 | hands-on, closed by the record's pull request |
| #93 | fix: Ship proves the push with ls-remote, and the cloud first message asserts no token | #91 | closed |
| #94 | feat: the skill is factory-build, and a release gives the plugin the runner's version and syncs the organization's source | #92 | factory, S |
| #95 | feat: this Mac is no target without the factory plugin, and self-update refuses a release that needs a newer one | #94, released and installed on this Mac before #95 merges (Self-update) | factory, M |
| #96 | feat: hosts check reads the host's plugin | #95 | factory, S |
| #97 | feat: cloud is no target without the organization's plugin, and the first message calls /factory-build | #96 | factory, S |
| #98 | chore: remove the old copies of the skill | #95, #96, #97 | hands-on |
| #99 | feat: a second copy of the skill fails the check | | closed, not built (V9) |
| #100 | test: live smoke on all three targets with the plugin as the only copy | #98 | hands-on |

## Asks for Paradev that would remove workarounds

- `superset plugins install` and `plugins sync` copying skills themselves. On CLI 2.0.8 both skip it with `Bundled plugin missing at /$bunfs/templates/plugin`, which is why each update needs a service or app restart.
- The host service installing the account's plugins when it starts, as a cloud sandbox does. That removes the per-host install.
- The reason behind `account sync failed` in the install's answer.
- A plugin's own choice of skill name, so `factory` could stay `/factory`.
- A skill folder's files replaced only between an agent's runs. A session reads the skill's reference files as it goes, so an update that lands mid-build can mix old and new text.

## Dates

The live smoke needs the Team plan, which renews on 2026-12-13, so it runs before then.
