# Host smoke results

The live smoke of the runner with the Trilogy Mac as a host, issue 58. Times are UTC on 2026-11-15, a few minutes after midnight, unless a line says otherwise.

Runner: `factory-runner` 0.3.1 installed on personal-mac, acting as `tomkaczocha` | CLI and app: 2.0.8 on both Macs | Host: `trilogy-mac`, id `c9c39956e0c1756e30d6bb9f4f907ff1`, `max_runs: 2` | Spike repo: original-solutions/factory-paradev-spike

Machine config for the smoke: `repos[].hosts` on the spike repo named the host, and `local.max_runs: 0` held for the whole smoke, so every placement was forced to the host. The machine log shows `local` dropped each time with `slots full: 0 of 0 running`.

## Result

Passed on the second attempt, with one gap: a killed agent waited for an instructor's comment before it resumed (see "The kill test"; issue 81). The first attempt, on 0.3.0, found a bug that stopped every host run (see "Found on the way"). Issue 78 fixed it and 0.3.1 carries the fix.

| Case | Spike issue | Run | Result |
|---|---|---|---|
| Ends `FACTORY-DONE`, and the kill test | 17 | `…__17__2` | Killed 75 s after launch, paused, resumed after an instructor's comment, PR 21, gate passed first time, `pr-open` |
| Ends `FACTORY-STOP: needs-info` | 18 | `…__18__1` | Stopped because `docs/farewell.txt` is missing, questions posted, `needs-info` after 114 s. No branch, no PR |
| Gate fails once | 19 | `…__19__1` | PR 20. First gate: `node scripts/smoke-gate.js` exit 1. Sent back, the agent deleted `GATE_FAIL_ONCE`, second gate passed, `pr-open` |
| Stale host clone | 22 | `…__22__1` | PR 23, gate passed first time, `pr-open` |

- Every thread id starts `host:c9c39956e0c1756e30d6bb9f4f907ff1:`.
- The belt (v2, runner 0.3.1) lists the target `trilogy-mac` with its load and `slots 0/2`, and each of the four runs with `target: trilogy-mac`. `factory-runner status` shows the same rows.
- With two host slots taken, issue 19 waited one pass with `no target has room` and started when issue 18 finished.
- The runner archived each host workspace and removed each worktree over SSH. The three pull requests were closed afterwards.

## `hosts check`

`factory-runner hosts check trilogy-mac` printed every line `ok` at install: online, ssh, cli, clone, project, trusted, proxy env, git identity, gh, gh login tomkaczocha, claude. A run by hand before the smoke took 5.4 s.

Before the smoke two lines failed, and a person fixed both on the host: the spike clone was no Paradev project there (`superset projects create --host …`), and git had no global `user.email`.

## The kill test

On run `…__17__2`, workspace `32addc14…`, terminal `7dfaf8cc…`:

| Time | What |
|---|---|
| 00:13:09 | Launched. At 00:14:11 `agents explain` said `working`, last hook `Start` 4 s old, and the screen showed the agent dispatching reviewers |
| 00:14:24 | `kill -9` of that `claude` on the host, its working directory checked first as `…/fac/17-2` |
| 00:14:31 to 00:15:32 | Three reads: `agents explain` still `working`, `lastEventType: Start`, the hook's age growing; `terminals list` still `exited: false`. The screen ended at a shell prompt after `killed 'claude' …` |
| 00:24:34 | The runner's first pass after 10 minutes with no hook (the last hook was at 00:14:07) wrote `session_paused`. The log said `session stopped by hand, waiting for an instructor's comment on the pull request or the issue` |
| 00:26:28 | An instructor's comment on issue 17, posted at 00:26, was forwarded. The thread record gained a second terminal, `0d2cb7c0…`, and a `resume` turn |
| 00:29:41 | PR 21 opened; the gate passed at 00:29:46 and the issue went `pr-open` at 00:29:56 |

So a killed host agent reads as L5b did on local, and the run resumes from its session id and ends with a result line. It does not resume by itself: between the pause and the comment the run sat idle, and it would have stayed there. The P1 spec's failure table says the core sends its resume message here, so this is a defect in the runner, not the design: issue 81.

## The base check

It never found a mismatch on the host.

For the first three launches the host clone was already at GitHub's tip of `main` (`f3e2fec`), so there was nothing to find. For issue 22 the host clone's `main` and `origin/main` were first set one commit behind (`7818033`). The worktree Paradev made 50 s later was cut from `f3e2fec`, and the clone's `origin/main` was back at `f3e2fec` while its local `main` stayed at `7818033`. The worktree's reflog holds no reset to another commit, so the runner's repair did not run.

A second probe set `origin/main` behind again and made an agentless workspace with `workspaces create --host … --base-branch main` 75 s later: again cut from `f3e2fec`. The ref had already moved back before the create, while the agent of issue 22 was working in the same clone, so this probe does not say whether the create or the agent fetched. The first one does: no agent was on the host then.

So X8 does not hold on this host: `--base-branch main` gave a branch from GitHub's tip, not from the clone's stale `main`.

## Pass time with one host

- One SSH read of the host's load: 0.39 to 0.41 s. One `snapshot --host`: 0.63 to 0.78 s. Three readings each, with this Mac's 1-minute load at 8.
- A pass with no runs took about 16 s with the host configured (0.3.0, four passes) against a median of 17.5 s over the 30 passes before it, with no host.
- Passes with host runs took 30 to 122 s (median 36 s with three runs listed). This Mac's load was 8 to 35 from a people-hub build at the time, as in issue 27's readings, so these say little about the host.

## Found on the way

1. On 0.3.0 the launch message told a host session it acts as the runner's login and forbade any other. A Paradev terminal on the Trilogy Mac has `rawphp` active, so run `…__17__1` ended `FACTORY-STOP: stuck` 10 s after launch. Issue 78 added `hosts[].gh_login` and `repos[].hosts[].gh_login`; a host session now uses the named login's token when the terminal's login differs. All four runs of this smoke did that: each reported the active login as `rawphp` and opened its pull request as `tomkaczocha`.
2. `gh` over SSH on the host has `tomkaczocha` active, where a Paradev terminal has `rawphp`. `hosts check` reads over SSH, so its `gh` lines cannot say which login a terminal will have.
3. The commits of the host pull requests show on GitHub as `rawphp`: the email set as the host's git `user.email` belongs to that account. The pull requests themselves are by `tomkaczocha`.
4. A repo that runs only on hosts is still skipped until its clone is a Paradev project on this Mac. With `local.max_runs: 0` the runner claimed nothing for four passes, with the attention item `its clone … is no Paradev project on this Mac`, until `superset projects create --local` was run for the spike clone.
5. The public reason of run `…__17__1` told the reader to restart "the factory's T3 server". Issue 78 reworded it.
6. A killed agent is paused, not resumed: see the kill test. The P1 spec's failure table says the core sends its resume message after the liveness check; here it waited for an instructor. Issue 81.

## Left as it was found

The machine config is back to what it was, with no `hosts` block. On the host: the spike clone is a Paradev project, git has a global `user.email`, and the clone is back at `origin/main`. Spike issues 17, 19 and 22 are `factory:pr-open` with closed pull requests, and 18 is `factory:needs-info`.
