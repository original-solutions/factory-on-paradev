# P2: Hosts and cloud as run targets

Product: Factory - by Original Solutions. This phase lets the Solo runner start each build on the machine with the most room: this Mac, another Paradev host, or Paradev Cloud.

Status: draft, written 2026-11-14 from the three P0 runs. Every fact here is in `spike/RESULTS.md` or a fixture under `spike/fixtures/2.0.8/`, named where it is used. Anything marked `[Assumption]` is not shown by the source and must be checked during the build. Issue numbers are in "Issues, in order".

Depends on: P1 shipped and live (it is: issues #19 to #29 are closed, the live smoke passed on 2026-11-13, and clockwork runs on the runner), and the host spike's record on `main` (PR #49).

## Goal

The runner of P1, unchanged in what it does for a run, with one more decision at launch: where the agent runs. A build on the Trilogy Mac or in a cloud sandbox is claimed, gated, labelled, resumed and archived exactly as a local one, and the belt says where each run is.

Exit criterion: the spike repo's three smoke cases pass on a host and in the cloud, then clockwork's builds spread across this Mac and the Trilogy Mac for a week with no run stuck because of placement, and the retro (#29) shows no change in time to `pr-open` against P1's local runs.

## Scope

In:

- Targets in the machine config: this Mac, each Paradev host by machine id, and Paradev Cloud by environment.
- Placement by load: at launch, the target with the lowest 1-minute load per core that has a free slot for the repo; cloud only when no machine qualifies.
- The adapter running every call against the thread's target: `--local`, `--host <id>`, or `--host cloud`.
- The cloud shape of a launch: provisioning, the branch Paradev picks, the agent terminal found through `snapshot`, and the orphan sweep.
- Host readings over SSH: load, the liveness check, the session id for resume.
- `factory-runner hosts check`: the read-only checklist a host must pass before it gets runs.
- Status and the belt showing each target and where each run is.
- A fix to the `/factory` skill so a cloud agent does not stop on GitHub's all-false permissions object (X9).

Out: the plugin stays P3, anything hosted P4. Also out: a reboot test of a host, the runner turning the Tailscale Funnel on or off, agents on Linux hosts (nothing here forbids one, but nothing was run on one), moving the gate off this Mac, Paradev's `workspaces sleep`, cost accounting beyond a slot cap, and any change to the ledger's event shapes.

## Decisions

Settled 2026-11-14. U1 was Tom's; the rest took the smallest option that the spike supports.

| # | Decision | Settled |
|---|---|---|
| U1 | How a run is placed | By load on each machine: the lowest 1-minute load per core among the targets that list the repo, are online, pass their check, and have a free slot. This Mac wins a tie. Cloud is the overflow: it is chosen only when no machine qualifies, because it costs GB-minutes and its plan is on a one-month trial (U5) |
| U2 | Who the agent is on GitHub, per target | Local PRs by this Mac's active `gh` login, host PRs by the host's configured login (`repos[].hosts[].gh_login`, else `hosts[].gh_login`, else the runner's login), which the session selects with that login's token when the host terminal's active `gh` login is another one, cloud PRs by the Paradev GitHub App bot (`app/superset-app`). The runner's own writes (claims, labels, comments, ready) use `gh_config_dir` as in P1, so the issue trail reads the same whatever opened the PR. An open pull request that closes the issue counts as the run's own when the runner's login or the resolved login of any host the repo lists opened it, wherever the run is placed, so a person's own pull request under one of those logins is taken over. One the Paradev GitHub App (`app/superset-app`) opened counts only when the repo names a `cloud` environment and its head is a branch Paradev Cloud names for the issue's launch branch (`superset/fac-<issue>-<attempt>-<id8>`): the app is the author of every cloud workspace's pull request, so a person's from a cloud workspace is on another branch and is not taken over. A host must have a git `user.email` set, or `hosts check` fails: an auto-detected email links to no GitHub user, which the host spike's pull request 16 on the spike repo shows |
| U3 | How agents reach Claude | Every target goes through the CLI Proxy API on the Trilogy Mac. This Mac and hosts carry `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` in their own `~/.claude/settings.json` `env` (hosts get nothing from the org's connection: X9 host). Cloud gets `ANTHROPIC_API_KEY` and `ANTHROPIC_BASE_URL` from `connections agents set` through the Tailscale Funnel (C0). The Funnel stays on while `cloud` is in the config; the runner never turns it on or off. Before each cloud launch it checks the proxy answers 401 to an unkeyed `GET /v1/models` through the Funnel: up and guarded. Anything else makes cloud no candidate this pass |
| U4 | Host prerequisites | Read-only. `factory-runner hosts check` reads each host over SSH and prints what is missing with the command that fixes it. The runner writes nothing into a host's dotfiles. Trusting the clone, the proxy env, the git identity and the gh login are the person's, done once per host |
| U5 | The Team plan trial | Hosts land first, cloud second. The cloud smoke (#59) runs before 2026-12-13, when the trial ends, and its result decides whether the plan stays. Until then `cloud.max_runs` is 1. Decided on 2026-11-15, after #59 passed: keep the plan for now, and look again after #60's week (`spike/CLOUD-SMOKE.md`, "Cost") |
| U6 | The channel to a host | SSH, `BatchMode=yes`, `ConnectTimeout=10`, read-only commands only: load, process list, the session store's listing, and the check. `hosts add` already needs SSH, so it adds no new requirement. No command writes to a host |
| U7 | Where the gate runs | This Mac, for every target, on a fresh checkout from GitHub as in P1. The gate's log terminal (`showGateLog`) is local only: a host or cloud workspace cannot read this Mac's log file |
| U8 | The ledger | Unchanged. The target is the thread id's prefix (`local:`, `host:<machineId>:`, `cloud:`), already reserved in P1, so `factory-runner retro` reads both phases' ledgers as they are |

## Config

### Machine config

New keys. Everything in P1's config keeps its meaning. `max_concurrent_runs` stays the cap on runs the runner holds at once, across every target.

```yaml
repos:
  - repo: original-solutions/clockwork
    path: /Users/tomkaczocha/factory-runner/original-solutions/clockwork   # this Mac, as P1
    hosts:                                                                   # optional: where else it may run
      - id: c9c39956e0c1756e30d6bb9f4f907ff1                                 # superset hosts list
        path: /Users/tomk/factory-runner/original-solutions/clockwork        # the clone on that host
        gh_login: tomkaczocha                                                # optional: the GitHub login this repo's runs on that host act as, over the host's
    cloud: edad9805-e48d-40f3-a06c-e19a4105f974                              # optional: an environment id that has this repo

hosts:                        # every host a repo names must be here
  - id: c9c39956e0c1756e30d6bb9f4f907ff1
    name: trilogy-mac         # as `superset hosts list` shows it; used in the belt and the log
    ssh: tomk@trilogy-mac     # an ssh destination that works with BatchMode=yes
    max_runs: 2
    max_load_per_core: 1      # 0 turns the load check off for this host
    gh_login: tomkaczocha     # optional: the GitHub login runs on this host act as; default the runner's own

cloud:                        # present only when some repo names an environment
  machine_size: small         # small | medium | large
  max_runs: 1
  proxy: https://trilogy-mac.tail459612.ts.net:10000   # the Funnel address the connection points at; checked before each launch

local:
  max_runs: 1                 # defaults to max_concurrent_runs
```

Refused at config load, each with the line to fix: a repo `hosts[].id` not in `hosts`, a `hosts[].id` not in `superset hosts list`, a `cloud` environment id not in `superset environments list`, and a `hosts` entry whose `ssh` has no user (`user@box` or a `Host` alias; a bare hostname is refused because BatchMode then guesses the user).

A repo with no `hosts` and no `cloud` runs as in P1, so a P1 config loads unchanged.

### What P1's load and disk checks become

P1's `max_load_per_core` and `min_free_gib` keep guarding this Mac: the gate runs here, so an overloaded or full Mac still claims nothing. They say nothing about hosts. Each host has its own `max_load_per_core`; a host has no disk check in P2 (Paradev removes worktrees at archive, X10).

## Targets

A target is one of:

| Target | Thread id | CLI flag | Project id the adapter uses | How the runner reads it |
|---|---|---|---|---|
| this Mac | `local:<workspaceId>` | `--local` | from `projects list --local` by clone path, as P1 | in process |
| a host | `host:<machineId>:<workspaceId>` | `--host <machineId>` | from `projects list --host <machineId>` by the repo's `hosts[].path` | SSH for load and processes; the CLI for everything else |
| cloud | `cloud:<workspaceId>` | `--host cloud` | the environment id; cloud has no project | the CLI only |

`findProject(root)` keeps its P1 signature and meaning: it answers the local project for the repo's clone. Placement happens in `launch`, which is where the adapter learns the command id, so a retried launch places the same way (below). The core changes little for placement: `LaunchRequest` gains two optional fields, `hostMessage(machineId)`, the first message for a launch placed on a host (it names the host's resolved `gh_login` and lets the session select that login's token), and `cloudMessage`, the first message for a launch placed in the cloud (`cloudLaunchMessage`, with no login check); the adapter uses each in place of `message` when placement picks its target. `Launched.threadId` still carries the target.

### Thread record v2

```ts
interface ThreadRecord {
  readonly v: 2;
  readonly threadId: string;                       // local:<ws> | host:<machineId>:<ws> | cloud:<ws>
  readonly target: { readonly kind: "local" } | { readonly kind: "host"; readonly machineId: string; readonly name: string } | { readonly kind: "cloud"; readonly environmentId: string };
  // every v1 field as in P1: workspaceId, projectId (the environment id for cloud), branch, worktreePath,
  // launchCommandId, agent, terminals, turns, archivedAt, pendingResume, pendingSend, gateLogAttempts
  readonly pendingArchive?: boolean;               // cloud: a failed launch could not archive its workspace
}
```

A v1 record reads as `target: { kind: "local" }`. Records are never rewritten to v2 in place; a v1 record is written back as v2 the first time it changes.

### Placement, inside `launch`

Runs once per launch, before step 2 of P1's `launch`. A retry of the same command id finds the launch file first (P1 step 1) and never places again. The answer is written to `<data>/paradev/placements/<sha256 of the command id>.json` before anything is fetched or created, so a send cut off between the placement and the launch file goes back to its target: a kept this-Mac or host target is checked again as the only candidate (the other targets' slots still count), and a launch whose kept target has no room waits for it rather than moving, for at most `launch_timeout_seconds` from its `launch-sending` step (P1's launch timeout). Two kept targets are placed afresh: a cloud target, since with no launch file the workspace it made is an orphan the sweep archives, and a target the repo no longer lists. A placement file that does not read back fails the launch without placing, since placing again could move it. The old code ignores these files, so a revert leaves them behind.

1. Candidates: this Mac, each host the repo lists, and cloud when the repo names an environment.
2. Drop a candidate whose slots are full: its running threads (the target's own `runningThreads`, below) are at its `max_runs`.
3. Drop this Mac when P1's load or disk check would hold the pass; drop a host when its last reading (this pass, below) failed or is over its `max_load_per_core`; drop cloud when the proxy check failed this pass, or no pass has checked the proxy under the config in use. `hosts list` says nothing about cloud: `hosts-list-host-online.json`, recorded on an org that used cloud, has no cloud row, so its absence cannot be read; a cloud listing or a workspace's `snapshot --host cloud --workspace <id>` that fails gives cloud a null count, which step 2 drops as uncountable.
4. Drop a host whose `hosts check` failed at the last config load.
5. Pick the machine with the lowest load per core; this Mac on a tie. No machine: cloud if it is a candidate. Nothing: `launch` fails with `SessionsError` operation `launch`, text `no target has room`, and the core's existing retry runs it again next pass. A refusal writes no ledger step, so a run that waits for room past `launch_timeout_seconds` is failed by P1's launch timeout like any launch with no thread id: the issue goes back to `factory:ready` and the timeout counts against `launch_timeout_retries`. The machine log gets one `claim_skipped`-style note per pass, event `placement`, data `{ repo, target, reason }`, for every candidate dropped, so the belt can say why a run waits. `[Assumption]` `placement` is a new machine-log event; U8 keeps run events unchanged, and the machine log already takes new event types without a ledger version bump.

The host's load is read once per pass for every configured host, before any launch, by `ssh <host.ssh> 'sysctl -n vm.loadavg hw.ncpu 2>/dev/null || (cat /proc/loadavg; nproc)'`, timeout 10 s. The 1-minute figure and the core count come from the first line's second field and the last line on macOS, or the first field and the last line on Linux. A failed read drops the host this pass and, after three passes, raises one attention item `host-unreachable` naming the host.

### `runningThreads` per target

P1's `runningThreads` counts factory agents in `snapshot` on this Mac. P2 counts per target: `snapshot --host <id>` for a host, read once per pass. Cloud is not one host: each cloud workspace runs its own, and CLI 2.0.8 refuses `snapshot --host cloud` with no `--workspace` (exit 1, `` `--host cloud` is not one host``; #85). So for cloud the runner lists `workspaces list --host cloud`, keeps the workspaces that carry its tag `factory-<runner id>` and are not `deleted` (the listing the orphan sweep reads), and reads each of those that holds a live record (an unarchived cloud thread record with an agent terminal) with `snapshot --host cloud --workspace <id>`, once per pass, two at a time. No such workspace is a count of 0 with no `snapshot`. Only live records count, so a tagged workspace with none (an archived run's, an orphan the sweep has not archived) is not read, and its `snapshot` cannot fail the count; with no live record the count is 0 with no call at all; and when a live record's workspace is listed, but neither with the tag nor as `archived` or `deleted`, the count is unknown for that pass, never 0 (assumption 3 below is not verified, and a dropped tag must not let cloud take more runs than it has room for). CLI 2.0.11's listing leaves out an archived workspace, so a live record's workspace the listing leaves out gets one `workspaces get <id> --host cloud` (#113), two at a time, and each gets its read whatever the others answer. A status of `archived` or `deleted` means it counts nothing, and the runner sets `archivedAt` on its thread record, so later passes skip it without another read; a revert does not unset it. Any other status, known or not, makes the count unknown for that pass and leaves the record as it is. So does a `get` that fails: `Workspace not found on host …` and CLI 2.0.11's `No cloud workspace <id> in this organization` among them, since no recording shows what the CLI answers for a cloud workspace that no longer exists, and a CLI on another organization gives the second for a live one. A failed listing or a failed `snapshot` makes the cloud count unknown for that pass. Both shapes are the same (`snapshot-host-after-restart.json`, `snapshot-cloud.json`, recorded with `--workspace`), and an agent counts by the same rule on every target. The core's single `runningThreads` is the sum, so `max_concurrent_runs` keeps its meaning.

## The adapter, per target

Every P1 method keeps its contract. What changes is the flag each call carries, read from the thread record, and the cloud shape of a launch.

### Host

- `launch`: P1's steps with `--host <id>` on `workspaces create`, `workspaces get`, `snapshot`, `agents create`. P1's base fetch into this Mac's bare repo stays the source of truth for the base commit. X8 did not hold on the Trilogy Mac in #58's smoke: with the host clone's `main` and `origin/main` one commit behind GitHub, `workspaces create --host <id> --base-branch main` cut the branch from GitHub's tip, and the clone's `origin/main` had moved to it (`spike/HOST-SMOKE.md`). The base check stays for a host whose clone cannot fetch: it compares the host worktree's HEAD, read over SSH, with that commit, and on a mismatch with no agent in the worktree runs `git fetch origin <baseRef>` and `git reset --hard <commit>` in the host's worktree over SSH, with the host's own credentials. This is the one SSH command that writes, and it writes only inside a worktree the runner created. In #58's four host launches it found no mismatch, the stale-clone launch included.
- `status`, `thread`, `send`, `archive`, `showGateLog`: `--host <id>`. `showGateLog` is a no-op with one log line (U7).
- The liveness check: the same process lookup over SSH: `pgrep -x claude` then `lsof -a -d cwd -p <pid>`, on the host, timeout 10 s. A failed SSH read keeps the run `running`, as a long tool call would; after three passes of failed reads the host is `host-unreachable` and the run stays as it is. A killed host agent reads as L5b did on local: in #58's smoke, 68 s after `kill -9`, `agents explain` still said `working` with its last hook the `Start` from 17 s before the kill, and the terminal stayed `exited: false` at a shell prompt after `killed 'claude'`. The check read the run as `interrupted` on the first pass after 10 minutes with no hook. `status` marks that reading `agentDied`, and the core sends the run its resume message, as P1 says (#81). In the smoke, before #81, the core paused it for an instructor's comment instead.
- Resume: the session id is the newest `*.jsonl` under the host's `~/.claude/projects/<worktreePath with every character other than a letter or digit as ->/`, read over SSH with `ls -t`, never through a Paradev terminal (`terminals read` wraps at the terminal's width and cut the id in the spike: `terminals-read-host-sessions.json`). Then `agents create --host <id> --resume-session <sid>` (`agents-create-host-resume.json`, 1.1 s; the new terminal was `working` 3 s later).
- `removeWorktree(path)`: a no-op for a host: Paradev removed the folder at archive, and the path is not on this Mac.
- Errors: `Host is not online` is `PARADEV_OFFLINE` (`agents-explain-host-offline.meta.json`, in the adapter since PR #49). The hold is per host: claims for a repo whose only candidates are that host wait; other targets go on. `hosts list` says `online: no` meanwhile (`hosts-list-host-offline.json`) and `yes` within 5 s of the service's return (`hosts-list-host-online.json`), with the same terminal ids `working` (`agents-explain-host-after-restart.json`).

### Cloud

- `launch`: 1. `workspaces create --host cloud --environment <env> --machine-size <size> --name <launch branch, fac/<issue>-<attempt>> --base-branch <baseRef>` with no `--agent`, no `--branch` and no `--tag`: a cloud create takes no `--branch` and answers `status: provisioning` with no terminal (`ws-create-cloud.json`), and CLI 2.0.8 refuses `--tag` on it (`--tag does not apply to a cloud workspace`, #87). Before the create, the launch writes a create mark, `<data dir>/paradev/cloud-creates/<sha256 of the command id>-<send time>.json`, with the workspace name and the time of the send. Each send writes its own mark and none is rewritten: a launch placed again sends the create again under the same command id, with a second mark. The next Paradev call is `workspaces update <id> --host cloud --tag factory --tag factory-<runner id>`, sent once step 2 is written and before step 3. It takes tags while the workspace is still provisioning and replaces its tag set, so a retry of the launch sends it again before step 3. `[Assumption]` The refusal of `--tag` on the create and the update of a workspace still provisioning are from #87's hand probe, which no fixture records (Assumptions, 3). A failed update fails the launch, and the workspace is archived as for any launch that fails before its agent. That holds on a retry too, where an earlier attempt's agent may run there: a recorded workspace with an agent and no tag fails the cloud count. A crash between the create and the update leaves an untagged workspace, which the sweep finds by its record once step 2 is written and by its create mark before that. The runner id is a random id written once to `<data dir>/paradev/runner-id` and read back after that. 2. Write the launch file and the record at once: a cloud create is not idempotent by branch, because Paradev names the branch `superset/<name slug>-<first 8 of the workspace id>` (`superset/fac-3-divide-a2bc69cb`), so a repeat create would make a second workspace. The launch file is the only thing that stops that. When either write fails, the workspace is archived at once and the launch fails. 3. Poll `workspaces get <id> --host cloud` every 5 s until the workspace is up: `status: ready` on CLI 2.0.8 (`ws-get-cloud-provisioning.json`, `ws-get-cloud-ready.json`: 16 to 22 s), `status: awake` on 2.0.11 (`spike/fixtures/2.0.11/ws-get-cloud-awake.json`). `asleep` is not up. The poll runs 300 s at most; past it the workspace is archived and `launch` fails. A workspace that reads archived while it provisions (`deleted` on 2.0.8, `archived` on 2.0.11) fails the launch at once. 4. `agents create --host cloud --workspace <id> --agent <preset> --prompt <cloudMessage, else message>`, and the terminal id is its `sessionId`, as on local (`agents-create-cloud-resume.json` has the shape). 5. The record's `branch` is `workspace.branch` from the create answer; `worktreePath` is `/workspace` and is never used on this Mac.
- A cloud launch that records no thread id within `launch_timeout_seconds` (default 900, longer than the 5-minute create limit plus the 5-minute ready limit) is failed by P1's launch timeout at the start of a pass, its slot freed and its issue put back to `factory:ready` (or `factory:stuck` once `launch_timeout_retries` are used). Such a run, still in `triage` or `launch-sending`, can also be ended with `factory-runner runs stop <run id>`, which no longer takes only building runs. The timeout archives no workspace such a launch made, since the ledger names no thread: the sweep below archives one with no thread record, but one whose launch wrote its record and launch file is neither archived nor swept. The pass raises a `session-may-exist` attention line for every run it ends this way, naming the launch command id `softfac:<run id>:launch` to look for and archive by hand.
- The workspace name is `fac/<issue>-<attempt>` from P1's branch rule, so the branch Paradev picks is `superset/fac-<issue>-<attempt>-<id8>`. `isLaunchBranch` also accepts `^superset/fac-(\d+|x)-[0-9a-f-]+-[0-9a-f]{8}$` with any `worktreePath`, and `launchBranchOf` answers null for a cloud path: the core relaunches from the record's branch, which the adapter answers in `thread`.
- The base check: none. Paradev cuts a cloud branch from the repository's branch on GitHub (`--base-branch` "the branch the workspace's new branch is cut from"), so there is no stale local base. The cut is from GitHub's current tip: in #59's smoke the first commit of the done case's branch had `origin/main` at launch time as its parent (`spike/CLOUD-SMOKE.md`).
- `status`, `send`, `archive`, `showGateLog`: `--host cloud`. `showGateLog` is a no-op (U7). `terminals send --host cloud` delivered a gate failure as one User chunk (`terminals-send-cloud.json`, 30 s).
- The liveness check: no SSH. When a cloud run has been `working` with no hook for 10 minutes: `terminals create --host cloud --workspace <w> --command 'pgrep -c claude; echo FACTORY-ALIVE-DONE'`, then `terminals wait --match FACTORY-ALIVE-DONE --timeout 30` and `terminals read --max-lines 5`, the X3 pattern (`terminals-create-cloud-gate.json`, `terminals-wait-cloud-gate-pass.json`, `terminals-read-cloud-gate-long.json`). A count of 0 is `interrupted`. The helper terminal is closed after the read. The 10-minute limit applies to `status` reads only, one per 10 minutes per agent terminal at most: each `send` reads liveness fresh before it types.
- Resume: the session id from the same pattern, `ls -t /home/ubuntu/.claude/projects/-workspace/*.jsonl | head -1`, read back with `--max-lines 5`: the sandbox's path is `/workspace`, so the folder is `-workspace` (`terminals-read-cloud-6-sessions.json`). Then `agents create --host cloud --resume-session <sid>` (`agents-create-cloud-resume.json`, 0.8 s; the transcript held the old conversation, `agents-read-cloud-resume.json`). Never `workspaces sleep`: a slept box's agent does not come back on wake (C5).
- `archive`: `workspaces archive <id> --host cloud` answers `deleted` in about a second (`ws-archive-cloud.json`); `workspaces get` afterwards says `status: deleted` on CLI 2.0.8 (`ws-get-cloud-6-archived.json`) and `status: archived` on 2.0.11 (`spike/fixtures/2.0.11/ws-get-cloud-archived.json`). The adapter reads both as archived, here and in the cloud count, the orphan sweep and `thread`.
- Status words: Paradev renamed two of them between CLI 2.0.8 and 2.0.11, and the runner compares exact words. The words it knows are `provisioning`, `ready`, `awake`, `asleep`, `deleted` and `archived`. Any other status on a `workspaces get` or a `workspaces list --host cloud` row reads as neither up nor archived, and the runner logs one warning per unknown word per run, naming the workspace. It does not fail the read: a word it has never seen must not stop the count, the sweep or an archive. The runner archives every cloud workspace itself when its run ends: Paradev did not stop a box idle for 65 minutes (C6), and an idle box bills.
- The orphan sweep, once per pass: every cloud workspace from `workspaces list --host cloud` with this runner's tag `factory-<runner id>` and no thread record, created over 10 minutes ago, is archived with one log line. That covers a record lost after the tags went on. A workspace with a thread record is this runner's whether or not it is tagged, since the tags go on after the record and a failed update leaves it untagged, and the record decides as below. A record with no agent that no launch file names is swept the same way: the launch died between the record and its launch file, so a repeat of it creates another workspace and never reaches this one. A launch that fails after step 2 and before its agent is recorded archives its workspace before it fails; when that archive fails too, the record keeps `pendingArchive`, a repeat of the launch starts nothing there, and the sweep archives the workspace with one log line, record or not. A workspace with neither this runner's tag nor a thread record is archived only by a create mark: it has no tag at all, carries the name a mark holds, was created no earlier than a minute before the mark's time (Paradev's clock may read behind this Mac's), and is over 10 minutes old. It is one a create made and never answered with (a timeout, an error, a crash before step 2), or one whose record could not be written and whose archive failed. A workspace with any tag is never matched to a mark: another runner's launch of the same issue and attempt sends the same name, and its update has tagged it. A launch tags its workspace within about a minute of its record or archives it, so one still bare after 10 minutes is in no runner's launch. A mark is removed once 15 minutes have passed since its send (the create's 5-minute timeout and the sweep's 10) and no bare workspace it names is listed live, whatever that workspace's age: one Paradev made late is listed under 10 minutes old when its mark is past 15. The sweep runs beside the pass and removes only marks it listed as past 15 minutes, so a launch placed again during a sweep keeps the mark it has just written. Any other workspace without this runner's tag and with no thread record is never archived: it may be another runner's, a dev instance's, or this runner's from before its data dir was reset. `[Assumption]` A listed cloud workspace's `name` is its create's `--name`: `ws-create-cloud.json` and `ws-list-noflag-after-cloud.json` show the same name for one workspace, and #59 is the first to show it for a `fac/` name. No cloud workspace predates the runner tag (#59, the first cloud launch, had not run when it was added), so none carries only `factory`. `[Assumption]` `workspaces list --host cloud` lists tags as plain strings and refuses `--tag`: #87's hand probe, which no fixture records (Assumptions, 3); `ws-list-noflag-after-cloud.json` shows the cloud list's rows. `[Assumption]` A cloud workspace keeps both tags its update set: #87's probe updated with one tag, so the first cloud launch (#59) is the first to show both come back.
- The proxy check, before placement considers cloud: `GET <cloud.proxy>/v1/models` with no key, timeout 10 s, expecting HTTP 401. The host spike saw the proxy answer 401 to an unkeyed call (`proxy log`, and C0 for the Funnel). 200 means the key check is off, so cloud is dropped too, with an attention item that says so: a cloud agent would be a free client of the proxy.
- Identity: in #59's smoke, on 2026-11-15, the sandbox's `GH_TOKEN` was the launching user's own GitHub login, from that person's Paradev connections: `gh auth status` showed `tomkaczocha`, the repo's `permissions.push` read true, and the pull requests and commits were by `tomkaczocha`. The cloud first message still describes the app token below, and the sessions carried on because the push dry run passed. The cloud spike of 2026-11-13 saw the app instead: `gh auth status` in the sandbox shows `superset-app[bot]` through `GH_TOKEN`, `gh api user` answers 403, the repo's `permissions` object reads all-false, and yet `git push` works and the draft PR is by `app/superset-app` (`terminals-read-cloud-whoami.json`, pull request 15 on the spike repo). The `/factory` skill's Read step must not refuse on that object (#57). So the cloud first message (`cloudLaunchMessage`) carries no login check and names no login of the runner or of a host: `gh api user` cannot answer there, so it says the session acts as the app through the sandbox's `GH_TOKEN` and proves push access with the skill's push dry run (#82).

### Status mapping

P1's table, with two rows now seen on a host and one new state:

| `agents explain` state | `lastEventType` | `run` |
|---|---|---|
| `starting` | `Attached` | `starting`. Seen when Claude Code's trust dialog held the agent (`agents-explain-host-working.json`): no prompt had reached Claude. After 5 minutes of `Attached` with no later hook the adapter reads the screen once (`terminals read --max-lines 40`) and, when it shows "Yes, I trust this folder", fails the run with `SessionsError` text `the host's clone is not trusted by Claude Code; run factory-runner hosts check <name>`. It never answers the dialog: that is the person's choice (U4) |
| `idle` | `Failed` | `failed`. Seen after a 401 from the proxy (`agents-explain-host-proxy-401.json`); the transcript's last Assistant chunk holds the error text (`agents-read-host-proxy.json`), which `lastAssistantMessage` passes to the core's rate-limit and trouble checks as it is |
| `exited` | `Failed` | `interrupted`. Seen after `terminals close` on a working agent (`agents-explain-host-working-2.json`) |

## `factory-runner hosts check [<name>]`

Reads every configured host, or one, over SSH and through the CLI. Prints one line per check, `ok` or the fix, exits 1 when any fails. Runs at `install` and beside the pass, as the orphan sweep does, so a slow host holds up no claim: every host right after each config load, then a not-ready host every 5 minutes and a ready one every hour. A host that fails is not a candidate until a check passes, and the failure is one attention item `host-not-ready` with the first failing line.

| Check | How | Fix printed |
|---|---|---|
| online | `superset hosts list` has the id with `online: yes` | `superset hosts add <ssh> --name <name>` or start its service |
| ssh | `ssh -o BatchMode=yes <ssh> true` | the key to install |
| cli | `superset projects list --host <id>` answers | as online |
| clone, per repo | `git -C <path> remote get-url origin` over SSH equals the repo's GitHub URL | `git clone https://github.com/<repo> <path>` on the host |
| project, per repo | `projects list --host <id>` has a project at `<path>` (`projects-create-host.json` shape) | `superset projects create --host <id> --name <name> --import <path>` |
| trusted, per repo | the host's `~/.claude.json` has `projects["<path>"].hasTrustDialogAccepted: true`, read with `python3 -c` over SSH | `claude` once in that folder and accept, or the one-line `python3` edit from the host spike (H0) |
| proxy env | `~/.claude/settings.json` `env` has `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` (presence only; the value is never printed) | the two keys to add |
| git identity | `git config --global user.email` non-empty | `git config --global user.email <email>` |
| gh | `gh auth status` exits 0 over SSH | `gh auth login` on the host |
| gh login, per distinct login | `gh auth token --user <login>` exits 0 over SSH, its output discarded and never printed; the logins are the host's `gh_login`, each repo's override, and the runner's login for any that names none | `gh auth login` as `<login>` on the host |
| claude | `claude --version` over SSH | install Claude Code |

It writes nothing on the host (U4).

## Status and the belt

`factory-runner status` gains `targets`: one row per target with `kind`, `name`, `online`, `load` (`{ oneMinute, cores }` or null), `slots: { used, max }`, `ready` (the check), and `reason` when it is not a candidate. Each run row gains `target` (the name) read from the thread id. `status` reads only the data dir, so after each pass the runner writes the rows to `<data>/targets.json`, beside the pass as the belt is, and `status` shows them while the runner is running. The rows are always this runner's last pass: a start removes the file a stopped runner left, and a write that fails removes the rows it could not replace, so `status` shows none rather than old ones. `name` is `local`, the host's name, or `cloud`; `online` is whether the target's running agents were counted that pass (its reads answered: one `snapshot` for this Mac or a host; for cloud the listing and the `snapshot` of each live cloud record's tagged workspace, with every live cloud record's workspace listed with the tag or as `archived` or `deleted`, or left out of the listing and read `archived` or `deleted` by its own `workspaces get`, or none when no cloud record could count; and the thread records read), and `slots.used` is null when they were not. `reason` is the first reason placement would drop the target, judged on the target alone, not for any one repo.

`BeltV1` becomes `BeltV2`: `runner` gains `targets` with the same rows, and each run gains `target`. The page shows the target beside the workspace link. The workspace link is `https://app.superset.sh/workspaces/<workspaceId>`, the `webUrl` Paradev answers on every target, so `workspaceId` is now set for host and cloud runs too. The page still reads a v1 belt. A runner that upgrades to v2 and fails to publish the new page keeps writing to the old one, which reads only v1 and shows "No belt yet" until a publish succeeds (tried again an hour after each failure). A target that is not ready says on the belt only which check failed: its reason there can be a host check's failing line or a proxy error, which quote paths, users and addresses, and the belt carries no such text; `status` has the line. The payload cap and trim rule stay; targets are at most four rows.

## Process model

Nothing new runs. The runner still needs the Paradev app open on this Mac. A host needs its LaunchAgent `sh.superset.host` up (`hosts add` installs it with RunAtLoad and KeepAlive). Cloud needs the Funnel up on the Trilogy Mac and the org's Claude connection set (C0), both done by hand before `cloud` goes into the config.

### What survives what, per target

| Event | Host | Cloud |
|---|---|---|
| Runner restart or crash | As P1: records and the ledger carry on; a placement already made is in the thread id, or in `paradev/placements/` when the launch file was not written yet, and the resend goes back to it | As host, except a kept cloud placement is placed afresh. The orphan sweep catches a workspace created before its record |
| The host's service stops | Agents keep running in `pty-daemon`; every call for that host is `PARADEV_OFFLINE`; claims for that host hold; the same terminal ids answer within 5 s of its return (H5) | n/a |
| The host reboots | Not tested (H0: FileVault with no auto-login holds the Mac offline until someone types the password). Expected: agents die and the host reads offline. Once it is back, a run whose explain still says `working` goes as the next row says: the liveness check reads it `interrupted` with `agentDied` and the core resumes it, which #58's kill test covers short of the reboot. A run whose explain reads `exited` or `none` is paused for an instructor's comment, as a person's stop is | n/a |
| The host sleeps mid-turn | Claude Code ends a turn the sleep cut off with `API Error: Your computer went to sleep mid-response`, read `completed` or `failed`. The core reads that message as an interruption with no T3 evidence: `advance` sends the resume message once for that run ordinal, using one of `limits.interruption_resumes`, and the run stays `building`, with no result-line reminder; while a resume is left, an instructor's comment waits until it is sent. The time limit does not stop a run waiting on that resume, unless T3 knows no activity of the session or cannot read its thread: that run is stopped as before. For any run past its limit, slept or not, a status T3 cannot give is asked for again on later passes for 15 minutes from the first failure, and then the run is stopped as before. The time from the message (the run's `runCompletedAt`; its `runStartedAt` when T3 gives no end, and with neither the start of the run's current stint of work) to the resume is not counted as work. A resumed session that sleeps again is resumed again, until the resumes are used up; then the run goes `stuck` saying the host slept. A sleep during a tool call, with no API call in flight, leaves no message: the session carries on after the wake and the time limit counts the sleep | n/a |
| The agent process dies | As L5b (#58): explain stays `working`, the terminal stays alive, and after 10 minutes with no hook the liveness check reads `interrupted` with `agentDied`. The core sends its resume message once for that run (#81); the adapter closes the dead terminal and resumes the Claude session in a new one. A resumed run that dies again is resumed again at the next liveness reading, until the run's time limit. In #58's smoke, before #81, the core paused the run instead and it waited for an instructor's comment | The X3-pattern liveness read counts 0 processes: `interrupted` with `agentDied`, then the core's resume, which resumes from `/home/ubuntu/.claude/projects/-workspace/` (C5). The core handles a dead agent the same for every target |
| The box sleeps | n/a | The agent does not come back on wake (C5). The runner never sleeps a box; a person who does gets a resume on the next `send` |
| The proxy or the Funnel is down | Hosts fail their turn with `idle` + `Failed` and the 401 text (X2); the core's trouble path applies | Same for a running agent; no new cloud launch while the check fails |

## Tests

### Contract tests, from the fixtures

| Test | Fixtures |
|---|---|
| host launch creates with `--host <id>` and records a `host:` thread | `projects-create-host.json`, `ws-create-host-5.json`, `ws-get-host-5.json`, `agents-wait-host-5-working.json` |
| host status while starting at the trust dialog, working, idle | `agents-explain-host-starting.json`, `agents-explain-host-working.json` (`Attached`), `terminals-read-host-starting.json`, `agents-explain-host-5-working.json`, `agents-explain-host-5-idle.json`, `agents-read-host-5.json` |
| a host's `Failed` turn reads as failed with the error text | `agents-explain-host-proxy-401.json`, `agents-read-host-proxy.json` |
| host offline holds that host only | `agents-explain-host-offline.meta.json`, `snapshot-host-offline.meta.json`, `ws-get-host-offline.meta.json`, `hosts-list-host-offline.json`, `hosts-list-host-online.json` |
| host resume closes the old terminal and starts a new one from the session id | `terminals-close-host-proxy-failed.json`, `snapshot-host-after-close.json`, `agents-create-host-resume.json`, `agents-wait-host-resume-working.json`, `agents-read-host-resume.json`, with a faked SSH listing |
| host gate failure delivered | `terminals-send-host-5.json`, `agents-read-host-5-after-gate.json` |
| cloud launch waits for ready, starts the agent, records the Paradev branch | `ws-create-cloud.json`, `ws-get-cloud-provisioning.json`, `ws-get-cloud-ready.json`, `snapshot-cloud.json`, `agents-create-cloud-resume.json` (the `agents create` shape) |
| cloud status and result | `agents-explain-cloud-working.json`, `agents-wait-cloud.json`, `agents-explain-cloud-idle.json`, `agents-read-cloud.json` |
| cloud liveness and session id through a helper terminal | `terminals-create-cloud-gate.json`, `terminals-wait-cloud-gate-pass.json`, `terminals-read-cloud-gate-long.json`, `terminals-create-cloud-6-sessions.json`, `terminals-read-cloud-6-sessions.json` |
| cloud resume and archive | `agents-create-cloud-resume.json`, `agents-read-cloud-resume-settled.json`, `ws-archive-cloud.json`, `ws-get-cloud-6-archived.json` |
| the orphan sweep archives a tagged cloud workspace with no record | `ws-list-noflag-after-cloud.json`, `ws-archive-cloud-6.json` |
| placement picks the lowest load, this Mac on a tie, cloud only as overflow, and nothing when every target is full | faked load readings and snapshots |
| every known stderr maps to its kind | every `*.meta.json` with `exit: 1`, as P1 |

Unit tests: the config's new keys and each refusal; `isLaunchBranch` on the cloud form; the load-line parser for macOS and Linux; the thread record's v1 to v2 read; the belt's target rows under the 60 KiB cap.

### Live smokes, hands-on

Each runs the spike repo's three cases (done, needs-info, gate fails once) with the runner installed, as #27 did, on one target, then one placement case:

- Host (#58): `repos[].hosts` names the Trilogy Mac. While a run works, `kill -9` its `claude` on the host: records whether explain sticks at `working` and the resume path runs. Then `max_runs: 0` on this Mac for one issue, so placement must choose the host.
- Cloud (#59): `repos[].cloud` names the spike environment, `cloud.max_runs: 1`, local `max_runs: 0` for one issue. Pass: the three cases, the archive on each end, and the first commit's parent equals `origin/main` at launch. Run before 2026-12-13 (U5).
- Spread (#60): clockwork lists both this Mac and the Trilogy Mac for a week; the retro compares against P1's runs.

## Issues, in order

Filed 2026-11-14 on `original-solutions/factory-on-paradev`, all `factory:proposed`. Each body is the build contract; where a body and this spec differ, the body wins.

| Issue | Title | Depends on | Kind |
|---|---|---|---|
| #51 | chore: land the P2 spec | PR #49 | tracking, closed by the PR that adds this file |
| #52 | feat: targets in the config, and thread records that carry their target | #51 | factory, M |
| #53 | feat: the adapter runs every call against the thread's target, with the cloud launch, liveness, resume and orphan sweep | #52 | factory, L |
| #54 | feat: host readings over SSH, and factory-runner hosts check | #52 | factory, M |
| #55 | feat: placement by load at launch, with per-target slots and the cloud proxy check | #53, #54 | factory, M |
| #56 | feat: status and the belt show each target and where each run is | #55 | factory, S |
| #57 | fix: the factory skill trusts a push dry run over GitHub's permissions object | none | factory, S |
| #58 | test: live smoke of the runner on the Trilogy Mac host | #55, #56 | hands-on |
| #59 | test: live smoke of the runner in Paradev Cloud, before 2026-12-13 | #55, #56, #57 | hands-on |
| #60 | chore: clockwork runs on this Mac and the Trilogy Mac for a week | #58 | hands-on |

## Assumptions

1. Seen in #58: X8 does not hold on the Trilogy Mac. A branch made with `--base-branch main` on a clone one commit behind was cut from GitHub's tip, so the base check found no mismatch in four launches. It stays as the guard for a clone that cannot fetch.
2. Seen in #58: a killed host agent reads as L5b. Explain stayed `working` and the terminal alive; the run was paused 10 minutes 27 seconds after its last hook, which is 10 minutes 10 seconds after the kill, and resumed from its session id in a new terminal once an instructor commented. Since #81 the core resumes such a run without a comment, as P1 says.
3. Seen in #87's hand probe, with no fixture: CLI 2.0.8 refuses `--tag` on a cloud `workspaces create` and on `workspaces list --host cloud`; `workspaces update <id> --host cloud --tag factory` exits 0 while the workspace is still `provisioning`; the list then shows `"tags": ["factory"]`, plain strings; `workspaces get` answers `tags: null`. The probe sent one tag to a workspace made by hand. #59 then showed the update accepted on a launch's own workspace and both tags kept: the list row of run `…__27__2` carried `"tags": ["factory", "factory-<runner id>"]`.
4. Seen in #59: a cloud branch is cut from GitHub's current tip of the base. The first commit of the done case's branch had `origin/main` at launch time as its parent.
5. `placement` is a new machine-log event type the ledger reader accepts without a version bump.
6. Seen in #58: one SSH read of the host took 0.4 s and one `snapshot --host` 0.6 to 0.8 s. A pass with no runs took about 16 s with the host configured and about 17.5 s without it, so the host adds nothing a pass notices.
7. A listed cloud workspace's `name` is its create's `--name` when that is a `fac/<issue>-<attempt>` launch branch; the create mark's match rests on it. Seen in #59: the rows listed were named `fac/27-2` and `fac/25-1`, as created.

## Asks for Paradev that would remove workarounds

- `hosts list --json` with the host's load and core count: removes the SSH read for placement.
- The agent's session id and the exit of its process in `agents explain --json`, on every target: removes the SSH listing on hosts and the helper terminal in the cloud.
- A caller's idempotency id on a cloud `workspaces create`: removes the orphan sweep.
- The org's Claude connection handed to host agents as it is to cloud sandboxes: removes the per-host settings edit.
