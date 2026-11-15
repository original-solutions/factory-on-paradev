# The plugin spike (#92)

Run on 2026-11-15 with CLI 2.0.8 on this Mac, on the Trilogy Mac over SSH, and in one cloud workspace. Fixtures are `spike/fixtures/2.0.8/plugins-*.json`, each with its `.meta.json`. Quotes of the CLI's own code come from the text inside its binary (`strings` on `superset`), not from a published source.

Status: not finished. S1, S3, S5, S6 and S8 are answered. S2 is half answered. S4 and S7 could not run, because no machine has yet put the plugin's skill where an agent reads it.

## What it found

1. **The marketplace installs with no publish.** `plugins marketplace add original-solutions/factory-on-paradev` clones the repo's default branch to `~/.paradev/plugins/marketplaces/factory-on-paradev`, and `plugins install factory@factory-on-paradev` copies the plugin to `~/.paradev/plugins/cache/factory-on-paradev/factory/0.1.0` and adds a row to `~/.paradev/plugins/installed_plugins.json` (`plugins-marketplace-add.json`, `plugins-install-unpublished.json`). The Trilogy Mac's own CLI at `~/superset/bin/superset` did the same over SSH, signed in (`plugins-host-marketplace-add.json`, `plugins-host-install.json`).

2. **No skill reached an agent on either Mac.** Both installs answered `"skills": 0`, with `[agent-setup] Bundled plugin missing at /$bunfs/templates/plugin; skipping managed skills` on stderr. `superset skills list` answers `[]` on this Mac. A throwaway plugin with a skill of a new name, from a local marketplace, got `"skills": 0` too (`plugins-install-probe.json`), so a clash with the existing `factory` link is not the cause. The CLI's code returns before it copies any skill when its bundled templates are missing, and the compiled CLI has none. `plugins sync` hits the same line (`plugins-sync.json`). The desktop app carries the same function and calls it at start and on a plugin change made in the app.

3. **A plugin's skill is renamed `<plugin>-<skill>`.** The CLI's code writes each skill to `~/.agents/skills/<plugin>-<skill>/` as a copy, with the `name` in its frontmatter set to that folder name and a `<!-- superset-managed-skill v1 -->` marker. The cloud sandbox shows it: the `github` plugin's skills are `github-ci-triage` and `github-issue-triage`, and Paradev's own are `superset-doctor` and so on (`plugins-cloud-term-look-read.json`). The Trilogy Mac has the `superset-*` folders too. So the `factory` skill of the `factory` plugin would be `/factory-factory`, not `/factory`.

4. **The account does not take the install.** Both installs answered `"connection": "account sync failed"`. The CLI hides the reason in every output mode tried. `plugins list` reads the account, so it does not show `factory` on either Mac (`plugins-list-installed.json`, `plugins-host-list.json`), and `plugins list --available` does not either. Only `installed_plugins.json` knows about it.

5. **A cloud sandbox gets what the account has, and nothing else.** A fresh sandbox had `github`, `posthog` and `slack` in `/home/ubuntu/.paradev/plugins/installed_plugins.json`, installed at boot, with their skills under `~/.agents/skills` and listed by `superset skills list`. `factory` was not there. The sandbox's CLI has no `plugins marketplace add` and no `plugins install`: both answer `Unknown command` (`plugins-cloud-term-install-read.json`). So V7 (a) fails today and V7 (c) cannot be built.

6. **`validate` and the tag.** `plugins validate .` answering `[]` with exit 0 means no problems. A broken `plugin.json` exits 1 with the problem on stderr. `--strict` exits 1 with `factory: 0.1.0 has no factory@0.1.0 tag yet`, so a published version is a git tag `factory@<version>`, which does not match `v*`. `validate` reads git tags and fails outside a repo.

## The spike's questions

| # | Answer |
|---|---|
| S1 | `[]` is "no problems". `--strict` wants a `factory@<version>` tag |
| S2 | An install needs no publish. What `plugins publish` writes was not run. Its tag is `factory@<version>` by the `--strict` message |
| S3 | Install path `~/.paradev/plugins/cache/factory-on-paradev/factory/<version>`. The skill an agent would read is `~/.agents/skills/factory-factory`, name `factory-factory`. Not seen on disk: finding 2 |
| S4 | Not run. No second copy exists to compare |
| S5 | The account's install does not reach the host (finding 4). `install` on the host over SSH works and writes the same files. The host had no `~/.paradev/plugins` at all before it. Its `~/.claude/skills/factory` and `~/.agents/skills/factory` link to `~/EA/skills/factory`, which links to `~/EA/projects/factory` |
| S6 | (a) no, (c) impossible. `plugins organization sources list` and `organization list` answer `[]`. The org route was not tried: it changes the org's settings |
| S7 | Not run. The install path holds the version, so an update moves it |
| S8 | `plugins list` does not show a plugin the account did not take. The row to read is in `installed_plugins.json`: `{ name, marketplace, version, installPath, installedAt, enabled }` |

## What this does to the spec

- V8: the first message cannot say `/factory` for a plugin skill. It is `/factory-factory`, or the plugin or the skill takes another name.
- V7: the cloud needs the account, or the org, to hold the plugin. The org route is the only one left untried.
- V6 and the local check: `installed_plugins.json` is the thing to read on a Mac, and it proves an install but not that the skill is where an agent reads it. The check also has to look for `~/.agents/skills/<plugin>-<skill>/SKILL.md`.
- V3: `~/EA/skills/factory` would point at `~/.agents/skills/factory-factory`, a stable path, and not at the versioned install path.

## Left as it was found, and not

- This Mac: the `factory-on-paradev` marketplace is added and `factory` 0.1.0 is installed. The probe plugin and its marketplace are removed; an empty folder `~/.paradev/plugins/cache/p3-probe-mp` is left.
- The Trilogy Mac: the marketplace is added and `factory` 0.1.0 is installed. `~/.paradev/plugins` is new there.
- The cloud workspace is archived, and `workspaces list --host cloud` answers `[]`.
- The old skill links on both Macs are untouched. No branch or tag of the plugin was pushed. The machine config was not changed.
