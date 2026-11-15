# The plugin spike (#92)

Run on 2026-11-15 with CLI 2.0.8 on this Mac, on the Trilogy Mac over SSH with its own CLI (`~/superset/bin/superset`), and in three cloud workspaces. Fixtures are `spike/fixtures/2.0.8/plugins-*.json`, each with its `.meta.json`. Quotes of the CLI's own code come from the text inside its binary and inside the host service's `host-service.js`, not from a published source.

## Result

The plugin reaches all three targets when it is the organization's plugin, and not when it is installed from a marketplace a person added.

| Target | How the skill gets there | Seen |
|---|---|---|
| cloud | Nothing to do per launch. A sandbox boots with every plugin the account has, at the version the organization last synced | `plugins-cloud2-term-look-read.json`, `plugins-cloud3-term-look-read.json` |
| the Trilogy Mac | `superset plugins install factory@organization` on the host, then a restart of its host service | `~/.agents/skills/factory-factory` appeared 30 s after `launchctl kickstart -k gui/$(id -u)/sh.superset.host` |
| this Mac | `superset plugins install factory@organization`, which is done. The skill has not landed: the desktop app was not restarted | `plugins-install-organization.json`, `"skills": 0` |

The skill lands as `~/.agents/skills/factory-factory/`, a copy of the plugin's `skills/factory` folder with every file in it, and its name is `factory-factory`.

## What it found

1. **A marketplace a person adds is a dead end.** `plugins marketplace add original-solutions/factory-on-paradev` and `plugins install factory@factory-on-paradev` work with nothing published, on both Macs (`plugins-marketplace-add.json`, `plugins-install-unpublished.json`, `plugins-host-install.json`). Both answer `"connection": "account sync failed"`, and the CLI hides the reason. The account never holds the install, `plugins list` never shows it, and a cloud sandbox never gets it. Both installs were removed again.

2. **The organization route works.** `plugins organization sources add original-solutions/factory-on-paradev` records the repo, `sources sync` reads its default branch, and `plugins organization list` then shows `factory` 0.1.0 with `owner` and `admin` set to `available` and `member` to `unavailable` (`plugins-org-sources-add.json`, `plugins-org-list-after.json`). No tag and no `plugins publish` is involved. `plugins install factory@organization` answers `"connection": "not required"`, and `plugins list` shows `factory` as `installed` under the marketplace `organization-<organization id>` (`plugins-install-organization.json`).

3. **A plugin's skill is renamed `<plugin>-<skill>`.** The skill is written to `~/.agents/skills/factory-factory/` with `name: factory-factory` in its frontmatter and a `<!-- superset-managed-skill v1 -->` line after it. `references/`, `scripts/` and `install.sh` are copied beside it unchanged. `superset skills list` shows `directory: factory-factory`, `plugin: factory`, `skill: factory`. It is also under `~/.claude/skills/superset/skills/factory-factory`. Paradev's own skills are `superset-doctor` and so on, and the `github` plugin's are `github-ci-triage` and `github-issue-triage`.

4. **The CLI installs and does not provision.** Every `install`, `sync` and `uninstall` on both Macs prints `[agent-setup] Bundled plugin missing at /$bunfs/templates/plugin; skipping managed skills` and reports `"skills": 0`. The step that copies skills returns early when the bundled templates are missing, and the compiled CLI has none. The host service runs the same step when it starts, and that is what landed the skill on the Trilogy Mac. The desktop app carries the step too and calls it at start. A cloud sandbox boots with it done.

5. **The host service does not fetch the account's plugins.** With `factory` on the account, a restart of the Trilogy Mac's host service left its `installed_plugins.json` empty and no skill. Only after `plugins install factory@organization` ran on that Mac did the next restart land the skill.

6. **The old copy and the plugin's copy do not clash.** On the Trilogy Mac `~/.agents/skills/factory` (the link to `~/EA/skills/factory`) and `~/.agents/skills/factory-factory` sit side by side under different names. The same is true in the sandbox, where the spike repo's `.claude/skills/factory` is in `/workspace`. `/factory` is the old text and `/factory-factory` is the plugin's.

7. **An update needs a version bump, a sync, and on a Mac an install and a restart.**
   - A branch with `0.1.1` in `plugin.json` and `.agent-marketplace.json` and a marker line in `SKILL.md` was pushed, and the source pointed at it with `sources add --ref`, which updates the one source in place. After `sources sync` the organization listed `0.1.1`.
   - On the Trilogy Mac `plugins install factory@organization --update` moved `installed_plugins.json` and the cache folder to `0.1.1` and removed `0.1.0`. `~/.agents/skills/factory-factory/SKILL.md` kept the old text until the host service restarted, then had the marker. The folder's path did not change.
   - A plain `plugins install factory@organization` with no `--update` moves an installed organization plugin to the current version too (`plugins-install-org-no-update.json`).
   - A fresh sandbox had `0.1.1` and the marker with no step at all.
   - A second push that changed `SKILL.md` and left the version at `0.1.1` was refused at the next sync: `syncProblems` said `its content changed but its version is still 0.1.1; bump the version`, and the organization, the host and a fresh sandbox all kept the first `0.1.1` text.
   - The source did not sync by itself in the 75 s after a push. Whether it ever does was not waited for.
   - Pointing the source back at the default branch and syncing took the organization back to `0.1.0`, and `install --update` plus a restart took the Trilogy Mac back with it.

8. **`validate`.** `plugins validate .` answering `[]` with exit 0 means no problems. A broken `plugin.json` exits 1 with the problem on stderr. `--strict` exits 1 with `factory: 0.1.0 has no factory@0.1.0 tag yet`. The organization route reads a branch, so that tag is not needed.

9. **The sandbox's CLI has no `plugins install` and no `plugins marketplace add`.** Both answer `Unknown command` (`plugins-cloud-term-install-read.json`). Nothing can be installed at launch.

## The spike's questions

| # | Answer |
|---|---|
| S1 | `[]` is "no problems". `--strict` asks for a `factory@<version>` tag that the organization route does not use |
| S2 | No publish. The organization syncs the default branch of this repo, at the version in `.agent-marketplace.json`, and refuses changed content under an unchanged version |
| S3 | The install is at `~/.paradev/plugins/cache/organization-<organization id>/factory/<version>`. The skill an agent reads is `~/.agents/skills/factory-factory`, named `factory-factory` |
| S4 | Neither wins. The names differ, so both load |
| S5 | The account's install does not reach a host. `plugins install factory@organization` on the host, then a host service restart. The host's old copy is the link `~/.agents/skills/factory` to `~/EA/skills/factory` to `~/EA/projects/factory` |
| S6 | (a), once the plugin is the organization's and the launching user has installed it. (c) cannot be built. Setting it to `installed` for a role was not needed |
| S7 | Yes, with a restart on a Mac. The cache path holds the version and moves. `~/.agents/skills/factory-factory` does not move, and its old text is replaced |
| S8 | `plugins list` shows `{ name, version, marketplace: "organization-<id>", status: "installed" }`, where `version` is the organization's current one and not the one on this machine. `installed_plugins.json` has the machine's: `{ name, marketplace, version, installPath, tools, installedAt, enabled }`. Neither says whether the skill has landed |

## Not seen

- The skill landing on this Mac. It needs the desktop app restarted, and this session runs inside it.
- A session calling `/factory-factory` and following it. The live smoke (#100) is the first.
- Whether the organization source ever syncs without `sources sync`.
- The reason behind `account sync failed`.

## Left as it was found, and not

- The organization has one plugin source, this repo's default branch, synced at `cd62fda`, and the plugin `factory` 0.1.0. The account has it installed.
- This Mac: `factory` 0.1.0 from the organization is in `installed_plugins.json`. No skill has landed. The marketplace `factory-on-paradev` and the probe plugin are removed.
- The Trilogy Mac: `factory` 0.1.0 from the organization is installed and `~/.agents/skills/factory-factory` is there. Its host service was restarted four times. One `claude` process was running on that Mac before the first restart; Paradev's snapshot listed no agent, so it was not checked further.
- The three cloud workspaces are archived, and `workspaces list --host cloud` answers `[]`.
- The old skill links on both Macs are untouched. The machine config was not changed. No tag was pushed.
- The branch `spike/92-plugin-update` is on `origin` with the two test commits. Nothing reads it now.
