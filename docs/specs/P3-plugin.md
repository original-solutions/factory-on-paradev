# P3: The plugin is the only place an agent gets /factory

Product: Factory - by Original Solutions. This phase makes the `factory` plugin in this repo the one source of the `/factory` skill on every target, and has the runner refuse a target that lacks it.

Status: draft, written 2026-11-15, before the plugin spike. What this draft knows about Paradev's plugin commands comes from `superset plugins <command> --help` on CLI 2.0.8 and three read-only calls on this Mac (`plugins validate .`, `plugins list --available`, `plugins marketplace list`). No plugin was installed, published or synced. Anything marked `[Spike: Sn]` waits on the spike question of that number, and the spike's record replaces the marker. Anything marked `[Assumption]` is not shown by the source and must be checked during the build. The issues are not filed yet.

Depends on: P2's two smokes, which passed (#58 on v0.3.1, `spike/HOST-SMOKE.md`; #59 on v0.3.4, `spike/CLOUD-SMOKE.md`). P2's exit criterion also asks for #60, the clockwork week on this Mac and the Trilogy Mac. That week has not run, so P2 is still open. P3 does not wait for it, and nothing here changes placement.

## Goal

An agent on this Mac, on a host or in a cloud sandbox loads `/factory` from the installed `factory` plugin and from nowhere else. The runner checks each target for the plugin before it sends a run there.

Exit criterion: the spike repo's three smoke cases (done, needs-info, gate fails once) pass on this Mac, on the Trilogy Mac and in Paradev Cloud, with no `~/.claude/skills/factory` on either Mac and no `.claude/skills/factory` in the spike repo.

## Where the skill comes from today

Read on 2026-11-15.

| Target | Where a session finds `/factory` | Version |
|---|---|---|
| this Mac | `~/.claude/skills/factory`, a link to `~/EA/skills/factory`, which links to `~/EA/projects/factory`, a clone of `rawphp/factory` at `7be6029` | Behind this repo. Six files differ, and it lacks the push dry-run rule of #57 |
| the Trilogy Mac | Not read for this draft `[Spike: S5]` | Unknown |
| cloud | `.claude/skills/factory` committed in the spike repo (its `main` at `69f8c0f`, copied from this repo at `73d844a`) | A snapshot. Any other repo that runs in the cloud needs its own copy |
| this repo | `plugins/factory/skills/factory`, plugin `factory` 0.1.0 in `plugins/factory/plugin.json`, listed in `.agent-marketplace.json` | The newest text. Nothing installs it |

So a local run and a cloud run of the same issue can follow different rules, and a fix to the skill reaches a target only when someone copies it there. `superset plugins marketplace list` on this Mac shows the built-in `superset` marketplace alone, and `~/.paradev/plugins/installed_plugins.json` has no `factory` entry.

`plugins validate .` on this checkout answers `[]` and exits 0. `[Spike: S1]` Whether `[]` means "no findings" or "no plugin found".

## Scope

In:

- The spike: Paradev's plugin commands run on all three targets, recorded as fixtures.
- `make release` publishing the plugin with each runner release.
- A plugin check per target. This Mac at start, a host in `hosts check`, the cloud before placement considers it.
- The first message calling the skill by the name the plugin gives it.
- Removing every other copy: the links on both Macs, the copy in the spike repo, and `rawphp/factory` as a place that takes changes.
- Two smoke findings in the text a session reads. The cloud first message describes an app token where #59's sandbox held the launching user's. The skill's Ship step runs `git rev-parse HEAD origin/<branch>`, which fails in a cloud worktree whose `remote.origin.fetch` covers only `main`.
- The README's install steps.

Out: anything hosted stays P4. Also out: more skills in the plugin (the filing side, `factory-issue`, stays where it is), an MCP server or an account connection in the plugin, a listing in Paradev's built-in marketplace, the runner installing or updating the plugin on a host (V5), plugin access for other people in the org beyond what a cloud sandbox needs, agents other than Claude, Linux hosts, and #60. The three smoke findings that touch neither the skill nor its first message become their own fix issues: a host-only repo that still needs a local Paradev project, `hosts check` reading `gh` over SSH where a Paradev terminal has another login, and a claimed run in `triage` that only closing its issue can end.

## Decisions

Proposed 2026-11-15. V1, V2, V3 and V5 are Tom's answers. The rest took the smallest option the help text supports, and each one that rests on the spike says so.

| # | Decision | Proposed |
|---|---|---|
| V1 | Where `/factory` comes from | The installed plugin, on every target. No link, no copy in a repo |
| V2 | What ends the phase | The three smoke cases on all three targets with the other copies gone (Goal) |
| V3 | Which copy is the source | `plugins/factory/skills/factory` in this repo. `rawphp/factory` takes no more changes, and its README points here. On this Mac the links `~/.claude/skills/factory`, `~/.agents/skills/factory` and `~/EA/skills/factory` are removed once the plugin is installed, so chat sessions get `/factory` from the plugin too. This is an exception to the rule that skill sources live in `~/EA/skills/`, agreed on 2026-11-15 because the plugin carries the skill. `launchctl list` shows no t3fac agent on this Mac, so no other factory reads the old link |
| V4 | The plugin's version | The runner's. `make release VERSION=x` writes `x` to `package.json`, `plugins/factory/plugin.json` and `.agent-marketplace.json` in the one release commit. The runner needs the installed plugin at `minPluginVersion` or newer, a constant in the source that a pull request raises when the runner starts to depend on newer skill text. It does not ask for an equal version, so a release that changes no skill text stops no target |
| V5 | Who installs and updates the plugin | On this Mac, both the runner and a person. A person installs it once with the two commands the check prints and can update it the same way at any time. Self-update updates it too: when the version it has staged needs a newer plugin than the one installed, it runs `superset plugins install factory@factory-on-paradev --update` before it restarts into that version, and stays on the running version when the update fails. On a host, a person only: P2's U4 stands, and the runner writes nothing there. So a release that raises `minPluginVersion` holds a host until someone updates it, and holds nothing on this Mac |
| V6 | How a host is checked | One more line in `hosts check`, read over SSH from the host's `~/.paradev/plugins/installed_plugins.json`, which on this Mac lists `{ name, marketplace, version }` per plugin. No Paradev login is needed over SSH `[Spike: S5]` |
| V7 | How a cloud sandbox gets the plugin | The first of these the spike shows working. (a) The launching user's install reaches the sandbox with no step. (b) The org syncs this repo as a plugin source and sets `factory` to `installed` for every role. (c) The launch installs it in the sandbox through a helper terminal before `agents create`, the X3 pattern `[Spike: S6]`. If none works, the cloud part of P3 stops and comes back to Tom |
| V8 | What the first message calls the skill | `/factory`, unless Paradev names a plugin's skill another way, in which case `launchBody` uses the recorded name `[Spike: S3]` |
| V9 | A second copy on a machine | Fails the check. A target with `~/.claude/skills/factory` present and the plugin installed is not ready until the link is gone, because which copy a session loads is not known `[Spike: S4]`. A watched repo that commits its own `.claude/skills/factory` is not detected. Only the spike repo has one, and P3 removes it |

## The spike

Hands-on, on CLI 2.0.8 or whatever is installed that day. Fixtures go to `spike/fixtures/<cli version>/` beside P0's, and the record to `spike/PLUGIN-SPIKE.md`. It installs the plugin on this Mac and the Trilogy Mac and removes nothing: the old links stay until the retire issue.

| # | Question | How |
|---|---|---|
| S1 | Does the marketplace validate, and what does `[]` mean? | `plugins validate .`, then `--strict`, then again with a broken `plugin.json` |
| S2 | What does publish write, and what tag does it name? | `plugins publish factory` on a branch. Record every file it changes and the tag. A tag that matches `v*` would be picked up by `make deploy` and by self-update, which both read the highest `v*` tag |
| S3 | Where does an install put the skill, and under what name? | `plugins marketplace add original-solutions/factory-on-paradev`, `plugins install factory@factory-on-paradev`, then the files it wrote and `/factory` in a Paradev terminal on this Mac |
| S4 | With the old link still there, which copy does a session load? | A marker line in one copy, then ask the session to quote it |
| S5 | How does a host get the plugin, and how is its version read? | The plugin commands take no `--host`. Does the account's install reach the Trilogy Mac after `plugins sync` there, or must `install` run on it? Then read `installed_plugins.json` over SSH. Also record what `~/.claude/skills/factory` is on that Mac today |
| S6 | How does a cloud sandbox get it? | V7's three ways in order, each with a fresh workspace and `ls` in a helper terminal |
| S7 | Does `plugins install --update` move an installed version, and is the old skill text gone afterwards? | Publish a second version, update, read the files |
| S8 | What does `plugins list --json` show for an installed marketplace plugin? | The row's fields, for this Mac's check |

S2 decides how V4 is built. If publish insists on its own tag, the release makes two tags and `make deploy` keeps reading `v*` only.

## Release

`make release VERSION=x` gains two steps before `npm version`, both of which need the Paradev CLI on the releasing Mac:

1. Write `x` to `plugins/factory/plugin.json` and to the `factory` row of `.agent-marketplace.json`.
2. `superset plugins validate . --strict` `[Spike: S1]`, and whatever publish step S2 records.

`npm run check` stays free of the CLI, since `.github/workflows/check.yml` runs it where no Paradev is installed. It gains one test: the three version fields are equal.

## The check, per target

One rule on every target: the `factory` plugin from the `factory-on-paradev` marketplace is installed at `minPluginVersion` or newer, and no other copy of the skill is on the machine.

| Target | When | How | When it fails |
|---|---|---|---|
| this Mac | At start and at each config load, beside the pass as `hosts check` runs | `superset plugins list --json` `[Spike: S8]`, and `~/.claude/skills/factory` must not exist unless the install put it there `[Spike: S3]` | This Mac is no candidate for placement, with one attention item `plugin-not-ready` that prints the fix. Self-update's own plugin update (below) keeps a release from causing this. `[Assumption]` Placement can drop this Mac for a failed readiness check as it drops a host |
| a host | In `hosts check`, as its other lines | The host's `installed_plugins.json` and the same link test, over SSH, read-only | The host is `host-not-ready` with the failing line, as today |
| cloud | Depends on V7. Under (a) or (b) the first agent of a workspace cannot be checked before it starts, so the check is the cloud first message telling the session to stop `stuck` when `/factory` does not load. Under (c) the helper terminal's exit code | `[Spike: S6]` | The launch fails and the workspace is archived, as for any launch that fails before its agent |

The fix a failed check prints:

```sh
superset plugins marketplace add original-solutions/factory-on-paradev
superset plugins install factory@factory-on-paradev --update
```

`factory-runner status` shows the failure as the target's `reason`. The belt says only which check failed, as it does for a host check. `BeltV2` does not change.

No new config keys. The marketplace and plugin names are fixed.

### Self-update and the plugin

Self-update stages a new version under `versions/` and smokes it before it moves `current`. One step is added between the smoke and the restart. It reads the staged version's `minPluginVersion` and this Mac's installed plugin version. When the installed one is older, it runs `superset plugins install factory@factory-on-paradev --update`, timeout 120 s, and reads the version again `[Spike: S7]`. A failed update, or a version still too old afterwards, leaves `current` where it is, logs one line naming the staged version and the plugin version it needs, and raises the attention item `plugin-not-ready`. The next ten-minute check tries again. A missing marketplace or a plugin that was never installed is not self-update's to fix: the first install is a person's, and the check prints it.

`[Assumption]` The published plugin version is on the marketplace by the time a runner sees the release tag, since `make release` publishes before it pushes the tag. S2 records whether an install reads the repo's default branch or a tag.

## Retiring the other copies

By hand, after the checks are live and each machine has the plugin:

1. Remove the three links on this Mac (V3) and whatever S5 finds on the Trilogy Mac.
2. Delete `.claude/skills/factory` from the spike repo's `main`.
3. Replace `rawphp/factory`'s README with a pointer to this repo, and archive it.
4. Delete `plugins/factory/skills/factory/install.sh`, which links the skill into `~/.agents/skills`, and its line in `scripts/check.sh`.

## Tests

Contract tests replay the spike's fixtures, as P1's and P2's do: the plugin row parsed from `plugins list`, the host's `installed_plugins.json` with the plugin missing, old and current, and the cloud path V7 settles on. Unit tests cover the version comparison, the three equal version fields, the first message's skill name, and self-update's three outcomes: no update needed, updated, and update failed.

The live smoke is the exit criterion. It runs the three cases once per target with the runner installed, as #58 and #59 did, after the retire step. One more case per Mac: uninstall the plugin, see the target drop out with `plugin-not-ready` or `host-not-ready`, install it, see the target return.

## Issues, in order

Not filed. Each becomes a `factory:proposed` issue once this draft is agreed, and the spike's record may change 4 to 7 before they are set ready.

| # | Title | Depends on | Kind |
|---|---|---|---|
| 1 | chore: land the P3 spec | none | tracking, closed by the PR that adds this file |
| 2 | test: spike Paradev's plugin commands on this Mac, the Trilogy Mac and the cloud | 1 | hands-on |
| 3 | fix: the cloud first message describes the token the sandbox has, and Ship reads the pushed branch in a cloud worktree | none | factory, S |
| 4 | feat: make release publishes the plugin at the runner's version | 2 | factory, S |
| 5 | feat: this Mac is no target without the factory plugin, and self-update updates it | 2 | factory, M |
| 6 | feat: hosts check reads the host's plugin | 5 | factory, S |
| 7 | feat: a cloud agent gets the plugin | 2 | factory, size from S6 |
| 8 | chore: remove every other copy of the skill | 5, 6, 7 | hands-on |
| 9 | test: live smoke on all three targets with the plugin as the only copy | 8, 3 | hands-on |

The README's install steps go in with issue 5.

## Settled with Tom, 2026-11-15

1. V3's exception to the `~/EA/skills/` rule is fine, because the plugin carries the skill.
2. V5: self-update updates the plugin on this Mac, and a person can too.
3. The spike's S6 and the smoke of issue 9 run before the Team plan renews on 2026-12-13.
