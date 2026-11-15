# Cloud smoke results

The live smoke of the runner in Paradev Cloud, issue 59. Times are UTC on 2026-11-15.

Runner: `factory-runner` 0.3.4 installed on personal-mac, acting as `tomkaczocha` | CLI and app: 2.0.8 | Environment: `factory-spike`, id `edad9805-e48d-40f3-a06c-e19a4105f974` | Machine size: small | Spike repo: original-solutions/factory-paradev-spike at `69f8c0f`

Machine config for the smoke: `repos[].cloud` on the spike repo named the environment, `cloud.max_runs: 1`, and `local.max_runs: 0` held for the whole smoke, so every placement was forced to the cloud.

## Result

Passed on the third attempt. The first two, on 0.3.2 and 0.3.3, never started an agent (see "Found on the way").

| Case | Spike issue | Run | Result |
|---|---|---|---|
| Ends `FACTORY-DONE` | 27 | `…__27__2` | PR 28 three minutes after launch, gate passed first time, `pr-open` |
| Ends `FACTORY-STOP: needs-info` | 25 | `…__25__1` | Stopped because `docs/salute.txt` is missing, questions posted, `needs-info` 46 s after launch. No PR |
| Gate fails once | 26 | `…__26__1` | PR 29. First gate: `node scripts/smoke-gate.js` exit 1. Sent back, second gate passed, `pr-open` |

- Every thread id starts `cloud:`.
- The belt (v2, runner 0.3.4) lists the target `cloud` with `slots 0/1`, and each run with `target: cloud`.
- With the one cloud slot taken, issues 25 and 26 each waited with `slots full: 1 of 1 running` and started within a pass of the run before them ending.
- The runner archived each workspace when its run ended. `workspaces list --host cloud` answered `[]` after the last one, and `workspaces get` says `status: deleted` for all three.
- The two pull requests were closed afterwards.

## Before the smoke

- The Tailscale Funnel was off. It was turned on for the smoke with `tailscale funnel --bg --https=10000 8317` on the Trilogy Mac, and `GET <cloud.proxy>/v1/models` answered 401 with no key and with a wrong key. It was turned off again afterwards.
- The org's Claude connection was already set to the Funnel address (last validated 2026-11-13).
- The spike repo's `.claude/skills/factory` dated from the phase 0 scaffold and lacked the push dry run of issue 57. A cloud sandbox gets `/factory` from there, so the skill was copied in from this repo at `73d844a` (spike commit `69f8c0f`).

## The base of a cloud branch

For the done case, `origin/main` on GitHub was `69f8c0f` at launch (07:40:08). The first commit on the branch `superset/fac-27-2-7665e5b6` is `2e76a4d`, and its parent is `69f8c0f`. The gate's `base_sha` was `69f8c0f` too. So a cloud branch is cut from GitHub's current tip, as assumption 4 said.

## Who the sandbox is on GitHub

Not the Paradev GitHub App, as the cloud spike of 2026-11-13 saw. Each session reported `gh auth status` showing `tomkaczocha` through `GH_TOKEN`, with `permissions.push` true, and both pull requests and all their commits are by `tomkaczocha`. The first message of issue 82 tells the session it holds an app token whose `permissions` read all-false; the sessions noted the mismatch and carried on, because the push dry run passed.

## Cost

The billing page, read on 2026-11-15 after the smoke: Team plan, `GB-hours used: 6.7 of 1,200`, resets 2026-12-13, extra GB-hours at $0.06 each. The page counts GB-hours, not GB-minutes, and gives one total for the cycle, so the 6.7 also holds the cloud spike of 2026-11-13 and the probe workspace of issue 87.

The smoke's own share comes from the ledgers: the three workspaces lived 3 min 13 s, 59 s and 5 min 6 s, 9 min 18 s in all, on a small machine (2 vCPU, 4 GB). That is about 0.6 GB-hours, or 37 GB-minutes, and about 0.2 GB-hours for a run that ends `FACTORY-DONE`. At that rate the plan's 1,200 GB-hours cover about 6,000 such runs a month, and a run past the pool would cost about one cent.

The recommendation on the plan is still to be added.

## Found on the way

1. On 0.3.1 a cloud run would have received the local first message, with a `gh api user` login check the sandbox could not pass. Issue 82 gave the cloud its own message.
2. On 0.3.2 the runner counted cloud agents with `snapshot --host cloud` and no workspace, which CLI 2.0.8 refuses. `status` showed `target cloud: ?/1` and nothing was placed. Issue 85 counts one workspace at a time.
3. On 0.3.3 the launch failed at `workspaces create --host cloud … --tag …`: `--tag does not apply to a cloud workspace`. Issue 87 creates first and tags with `workspaces update`.
4. A claimed run that cannot be placed sits in `triage`, and `factory-runner runs stop` refuses it: `Only a building run is stopped this way. To end it, close its issue.` Spike issue 24 was closed for that reason.
5. From the done case's receipt: in a cloud worktree `git rev-parse origin/<branch>` fails after a fetch, because `remote.origin.fetch` covers only `main`; and the sandbox runs every subagent in the background whatever the skill asks.

## Left as it was found

The machine config is back to what it was, with no `cloud` block. The Funnel is off. Spike issues 26 and 27 are `factory:pr-open` with closed pull requests, 25 is `factory:needs-info`, and 24 is closed unbuilt.
