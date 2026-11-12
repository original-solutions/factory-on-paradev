# P1: Solo runner, local only

Product: Factory - by Original Solutions. This phase is its free Solo runner.

Status: draft, written 2026-11-10 before the spike ran, updated 2026-11-11 with the local spike results. The `[P0: ...]` markers are resolved: the text now says what the spike showed, and "What P0 settled" lists each result. Facts that wait on a host or cloud run are marked `[P2: ...]`; P1 does not need them. Anything marked `[Assumption]` is not shown by the source and must be checked during the build.

Depends on: the P0 spike's `spike/RESULTS.md` and `spike/fixtures/2.0.8/` in this repo. The CLI was 2.0.8 when the spike ran, so there is no `2.0.7` folder.

## Goal

A runner on this Mac that does what t3fac does today, with Paradev in place of the T3 fork. It watches GitHub for `factory:ready` issues, starts each build as a Claude agent in a Paradev workspace on this Mac, gates the draft PR on a fresh checkout, keeps the softfac-format ledger, and shows the belt as a Paradev Page.

Exit criterion, from the plan: the repos t3fac builds today move to the runner one at a time, and 30 runner runs compare like for like with t3fac's in `factory-runner retro` (T5). See "Acceptance run" for why it says t3fac and not Rust softfac.

## Scope

In:

- The factory core lifted out of `t3code-factory/apps/server/src/factory/` into its own package, behaviour unchanged.
- A `paradev/` adapter over the `superset` CLI's JSON, with contract tests that replay the P0 fixtures.
- `factory-runner` as a command with a LaunchAgent: `run`, `install`, `uninstall`, `status`, `runs stop`, `claims pause`, `claims resume`.
- GitHub polling with `gh`, as the core does now.
- The gate on a fresh worktree on this Mac, as the core does now.
- The JSONL ledger, same format and layout.
- The belt as a Paradev Page written through `pages storage`.
- Local location only: `--local`.

Out: hosts and cloud go to P2, the plugin to P3, anything hosted to P4, the web app at https://factory.originalsolutions.com.au. Also out: Linear, model fallbacks, wake-ups from Paradev events, branch pruning, the Factory web page and its HTTP API, autodeploy, desktop and mobile apps.

## Decisions

All settled 2026-11-11. T1, T3, T4 and T5 took the suggested default.

| # | Decision | Settled |
|---|---|---|
| T1 | Where the runner's code lives | The public MIT repo `original-solutions/factory-on-paradev`, package `@original-solutions/factory-runner`, command `factory-runner`. Its skeleton and gate are in place (#1). The core comes from `original-solutions/t3code-factory`, which is public and MIT too. t3code-factory keeps running t3fac until the migration ends |
| T2 | Which GitHub login Paradev agents act as | The active `gh` login on this Mac, `tomkaczocha` (P0 X9). Commits carry the worktree's git `user.email`, which GitHub shows as `rawphp`. Paradev starts agents with its own environment, so the runner cannot hand them `GH_CONFIG_DIR` the way t3fac does |
| T3 | How repos are chosen | An explicit `repos:` list in the runner's config. While both factories run, discovery would let the runner claim a repo t3fac still watches. Account mode (every repo in an account with a `.dw/config.yml` factory block) waits for a later phase |
| T4 | Belt page visibility | `just_me` by default. `org` is allowed only when every member of the Paradev org can read every watched repo, and the runner logs a warning when it is set. `everyone` is refused at config load. The payload never carries gate output or logs |
| T5 | Where the retro runs for the comparison | `factory-runner retro --data-dir <dir>`, #29. It reads the softfac-format ledger, so the same command reads t3fac's data dir. There is no `softfac` binary on this Mac |
| T6 | Node version | The repo's `engines` is `^22.18.0 \|\| ^24.0.0 \|\| >=26.0.0`, and `tsconfig.json` already sets `erasableSyntaxOnly`. This Mac has 22.23 |

## Package layout

The repo root is `original-solutions/factory-on-paradev`. Entries marked "exists" are already there.

```text
factory-on-paradev/
  package.json            exists. Adds bin: factory-runner -> src/bin.ts; deps: effect 4.1.2, @effect/platform-node 4.1.2, yaml ^2.9.0; devDeps: @effect/vitest 4.1.2 (the versions t3code-factory's catalog pins at the source commit)
  tsconfig.json           exists: noEmit, allowImportingTsExtensions, erasableSyntaxOnly
  npm run check           exists: tsc --noEmit, vitest run, the fixture secret scan. Gains the boundary test
  .dw/config.yml          exists: factory block, gate `npm run check`, so t3fac can build this repo until it builds itself
  .github/workflows/      check.yml runs `npm ci && npm run check` on pull requests
  spike/                  exists: the P0 driver, RESULTS.md and fixtures/2.0.8/, which the contract tests read in place
  launchd/                io.github.original-solutions.factory-runner.plist, ...factory-runner.logrotate.plist
  scripts/rotate-log.sh
  src/
    bin.ts                command line: run, install, uninstall, status, runs stop, claims pause|resume
    main.ts               the layer graph and the pass world (was index.ts)
    sessions.ts           the adapter interface and its errors (was the type half of t3/sessions.ts)
    paths.ts files.ts     (were t3/paths.ts, t3/files.ts)
    domain/ ledger/ tracker/ runner/
    pass.ts gate.ts config.ts process.ts claims.ts cooldown.ts attention.ts control.ts
    loop.ts status.ts text.ts disk.ts load.ts logStreams.ts defaultProject.ts gitHardening.ts
    paradev/
      cli.ts              runs `superset` and maps its answers and errors
      schema.ts           the CLI check at start
      state.ts            the adapter's own records, one file per thread
      transcript.ts       the last assistant message from `agents read`
      branches.ts         launch branch names; re-exports isLaunchBranch, launchBranchOf from sessions.ts
      sessions.ts         FactorySessions over the CLI
      projects.ts         repo path to Paradev project id
      belt.ts belt.html   the belt page and its storage writer
      fake-superset.ts    a scripted `superset` for tests, answering from spike/fixtures/2.0.8/
      *.contract.test.ts
```

[Assumption] The core uses only TypeScript that Node can strip. `erasableSyntaxOnly` is already on, so the first moved file shows it. If it fails, the package adds a `tsc` build to `dist/` and `bin` points there.

### The source

Every path below is under `apps/server/src/factory/` in `original-solutions/t3code-factory` at commit `19e155be0872dcfa627eea1721f941f9dbcdf607` (its `main` on 2026-11-09). The repo is public. Read it with:

```bash
git clone --filter=blob:none --no-checkout https://github.com/original-solutions/t3code-factory /tmp/t3cf
git -C /tmp/t3cf checkout 19e155be0872dcfa627eea1721f941f9dbcdf607 -- apps/server/src/factory factory/scripts packages/shared/src/atomicWrite.ts
```

A file at that commit that no table below names moves unchanged when it imports nothing from `t3/`, `observability/` or `@t3tools/*`. Any other unnamed file is a stop: `FACTORY-STOP: needs-info` naming the file.

### Moves unchanged

Only the folder changes, plus mechanical import edits in every file: `./t3/sessions.ts`, `./t3/paths.ts` and `./t3/files.ts` become `./sessions.ts`, `./paths.ts` and `./files.ts` (with `../` from `runner/`), and tests import from `vitest` and `@effect/vitest` instead of `vite-plus/test`.

| From | Tests that move with it |
|---|---|
| `domain/*.ts` | `domain/*.test.ts` |
| `ledger/*.ts`, including `testSupport.ts` | `ledger/*.test.ts` |
| `tracker/github.ts`, `tracker/approvalHistory.ts`, `tracker/fixtures/` | `tracker/*.test.ts` |
| every `runner/*.ts` except `messages.ts` (see below) | `runner/*.test.ts` except `messages.test.ts` |
| `gate.ts`, `gitHardening.ts`, `process.ts`, `cooldown.ts`, `attention.ts`, `control.ts`, `loop.ts`, `status.ts`, `text.ts`, `disk.ts`, `load.ts`, `logStreams.ts`, `defaultProject.ts`, `health.ts`, `runGitHub.ts` | their `*.test.ts` |
| `factory/scripts/rotate-log.sh` (repo root) | `rotateLog.test.ts` |

### Moves with edits

| From | To | Edit |
|---|---|---|
| `t3/sessions.ts` | `src/sessions.ts` | Keep the types, the errors and the `FactorySessions` service shape. Drop every T3 import and the implementation. `Model.options` keeps the ledger's array shape, `ReadonlyArray<{ readonly id: string; readonly value: string | boolean }>`, defined here with no T3 import, so `session_launched.model_options` and its readers and writers stay as they are; the Paradev adapter reads the `effort` entry. Drop `brokenWorktrees`, `liveBranches`, `latestRun` and `threadStatusOf`. `ThreadOnBrokenWorktree` moves to `pass.ts` beside `PruneReport`. `isLaunchBranch` and `launchBranchOf` are defined here and re-exported from `paradev/branches.ts`, so the core imports nothing from `src/paradev/` (#24) |
| `t3/files.ts` | `src/files.ts` | Its one T3 import, `writeFileStringAtomically` from `@t3tools/shared/atomicWrite`, becomes a local copy of that function from `packages/shared/src/atomicWrite.ts` at the source commit. `t3/files.test.ts` moves with it |
| `t3/paths.ts` | `src/paths.ts` | The data dir is `~/.config/factory-runner`, or `FACTORY_RUNNER_HOME` when set. No `ServerConfig` |
| `index.ts` | `src/main.ts` | Build the pass world from the Paradev layers. No `Events` stream, `ServerExit`, `WatchedRepos` over T3, stall attribution or branch prune. `t3Starts` and `t3Stops` answer `[]`, because a runner restart does not stop a Paradev agent. `threadsOnBrokenWorktrees` answers `[]`. `pruneBranches` answers an empty report. After each pass, hand the status to the belt writer. Write `runner started` to the log once the first pass begins |
| `pass.ts` | `src/pass.ts` | Replace the deploy-pending hold (`pendingDeploy`, `deploy_wait_minutes`, reason `deploy-pending`) with a Paradev hold: while the CLI check or `superset status` fails, the pass claims nothing and resumes no claim (a resume may launch a session), records `claim_skipped` with reason `paradev-offline`, and raises one attention item once the hold has lasted three passes. Same mechanics as the hold it replaces |
| `config.ts` | `src/config.ts` | Read a `repos:` list again (T3). Add the `paradev:` block. Drop `deploy_wait_minutes`. Refuse a non-empty `model_fallbacks` with a clear error, since Paradev cannot move a running session to another model through the CLI |
| `claims.ts` | `src/claims.ts` | Drop `loadPendingDeploy` |
| `runner/messages.ts` | `src/runner/messages.ts` | `launchMessage` loses the T3 sentence "Your T3 server should have been started with GH_CONFIG_DIR=..." and says Paradev started the session with this Mac's `gh` login (T2). `INTERRUPTION_MESSAGE` says "Paradev" for "T3 Code". `messages.test.ts` changes with it |
| `index.test.ts`, `liveWorldBase.test.ts` | `src/main.test.ts` | The T3 fakes become `fake-superset` |
| `e2e.test.ts` | `src/e2e.test.ts` | Same two cases (one issue to `pr-open`; a failed gate sent back and passed on the second attempt). The faked provider becomes `fake-superset` scripted with fixture answers; GitHub stays faked by argv; git and the gate stay real |
| `boundary.test.ts` | `src/boundary.test.ts` | New rule: only `src/paradev/**` may spawn `superset`; nothing outside `src/paradev/` imports from it except `main.ts` |

### Dropped

| Path | Why |
|---|---|
| `t3/**` except `files.ts` | The T3 adapter, its HTTP routes and auth, events, exit, stall attribution, branch prune, watched repos over T3 projects, the gh credential retry for T3 |
| `observability/**` | Only `t3/stallAttribution.ts` used it |
| `settings.ts` | Backed the Settings page |
| `readyQueue.ts` | Only `t3/http.ts` reads it, for the Factory web page |
| `autodeploy.test.ts`, `installScripts.test.ts`, `sync.test.ts`, `check.test.ts`, `checkSeams.test.ts`, `regenerate-routes.test.ts`, `desktop*.test.ts`, `mobile*.test.ts`, `stopRun.test.ts`, `liveWorldPrune.test.ts` | Fork, release, app and script machinery the runner does not have. `runs stop` replaces `stop-run.sh` |
| `apps/web/src/factory`, `apps/desktop/src/factory`, `apps/mobile/src/factory`, `factory/SEAMS`, `factory/UPSTREAM`, the fork workflows | The fork itself |

## The adapter

### The interface the core uses today

Copied from `t3/sessions.ts` before the source commit. At the source commit the service also has `worktreeCheckout(path)` and `lastActivity(threadId)`, which `runner/building.ts` calls; the method table covers both. Where this block and the file differ, the file at the source commit wins. Doc comments are cut to one line; the file has the full ones.

```ts
export const RUN_STATUSES = [
  "preparing", "queued", "starting", "running", "waiting",
  "completed", "interrupted", "failed", "cancelled", "rolled_back",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export interface Model {
  readonly instanceId: string;          // the configured provider instance, e.g. `claudeAgent`
  readonly model: string;               // e.g. `claude-sonnet-5-5`
  readonly options?: ModelSelection["options"];
}

export interface FactoryProject {
  readonly id: string;
  readonly model: Model | null;         // null: the factory launches nothing
}

export interface LaunchRequest {
  readonly commandId: string;           // same id again = same launch
  readonly projectId: string;
  readonly title: string;
  readonly baseRef: string;
  readonly message: string;
  readonly model: Model;
  readonly pullRequestUrl?: string;
}

export interface Launched {
  readonly threadId: string;
  readonly worktreePath: string | null;
  readonly branch: string | null;
}

export interface Thread {
  readonly worktreePath: string | null;
  readonly branch: string | null;
  readonly archived: boolean;
}

export interface ThreadStatus extends Thread {
  readonly run: RunStatus | null;
  readonly runOrdinal: number | null;
  readonly runStartedAt: number | null;   // epoch ms
  readonly runCompletedAt: number | null; // epoch ms
  readonly lastAssistantMessage: string | null;
}

export interface ThreadOnBrokenWorktree {
  readonly threadId: string;
  readonly worktreePath: string;
  readonly threadsOnPath: ReadonlyArray<string>;
}

export class ThreadNotFoundError   // "FactoryThreadNotFoundError", { threadId }
export class MessageRejectedError  // "FactoryMessageRejectedError", { threadId, commandId, cause }
export class SessionsError         // "FactorySessionsError", { operation, cause }
//   operation: "find-project" | "launch" | "status" | "thread" | "send" | "archive"
//            | "remove-worktree" | "broken-worktrees" | "running-threads"
//            | "live-branches" | "worktrees-directory"

export class FactorySessions extends Context.Service<FactorySessions, {
  readonly findProject: (workspaceRoot: string) => Effect.Effect<FactoryProject | null, SessionsError>;
  readonly launch: (request: LaunchRequest) => Effect.Effect<Launched, SessionsError>;
  readonly status: (threadId: string) => Effect.Effect<ThreadStatus, ThreadNotFoundError | SessionsError>;
  readonly thread: (threadId: string) => Effect.Effect<Thread, ThreadNotFoundError | SessionsError>;
  readonly send: (threadId: string, commandId: string, text: string, model?: Model)
    => Effect.Effect<void, ThreadNotFoundError | MessageRejectedError | SessionsError>;
  readonly archive: (threadId: string) => Effect.Effect<void, SessionsError>;
  readonly removeWorktree: (path: string) => Effect.Effect<void, SessionsError>;
  readonly brokenWorktrees: Effect.Effect<ReadonlyArray<ThreadOnBrokenWorktree>, SessionsError>;
  readonly runningThreads: Effect.Effect<number, SessionsError>;
  readonly liveBranches: Effect.Effect<ReadonlySet<string>, SessionsError>;
  readonly worktreesDirectory: (defaultDir: string) => Effect.Effect<string | null, SessionsError>;
}>()("t3/factory/t3/sessions/FactorySessions") {}

export const isLaunchBranch: (branch: string, worktreePath: string | null) => boolean;
export const launchBranchOf: (worktreePath: string | null) => string | null;
```

Callers today:

- `runner/start.ts`, `runner/relaunch.ts`: `findProject`, `launch`.
- `runner/building.ts`, `runner/gating.ts`: `status`, `thread`, `isLaunchBranch`, `launchBranchOf`.
- `runner/run.ts`: `send`, `archive`, `thread`, `removeWorktree`.
- `index.ts`: `findProject`, `brokenWorktrees`, `archive`, `liveBranches`, `worktreesDirectory`, `runningThreads`.
- `cooldown.ts`, `pass.ts`, `runner/progress.ts`, `runner/launchTarget.ts`: types only.

The P1 interface is the same minus `brokenWorktrees` and `liveBranches`, with `ThreadOnBrokenWorktree` moved to `pass.ts`, `Model.options` keeping the ledger's array shape `ReadonlyArray<{ readonly id: string; readonly value: string | boolean }>`, and the service key renamed `factory-runner/sessions/FactorySessions`.

### Ids and the adapter's records

- `threadId` is `local:<workspaceId>`. The prefix leaves room for `host:<machineId>:` and `cloud:` in P2. The ledger stores it as `thread_id`, as it stores T3's thread ids now.
- One workspace holds one factory agent. The adapter keeps one JSON file per thread at `<data>/paradev/threads/<workspaceId>.json`, written atomically with `files.ts`:

```ts
interface ThreadRecord {
  readonly v: 1;
  readonly threadId: string;            // local:<workspaceId>
  readonly location: "local";
  readonly workspaceId: string;
  readonly projectId: string;
  readonly branch: string;              // the branch Paradev reported at create
  readonly worktreePath: string | null;
  readonly launchCommandId: string;
  readonly agent: string;               // paradev.agent, e.g. "claude"
  readonly terminals: ReadonlyArray<string>;   // oldest first; the last is current
  readonly turns: ReadonlyArray<{ readonly commandId: string; readonly at: number; readonly kind: "launch" | "send" | "resume" }>;
  readonly archivedAt: number | null;
  // The command id of a resume about to run, or that ran, `agents create`, whose agent is not recorded yet (#23):
  // the next send adopts the agent it started instead of starting a second one.
  readonly pendingResume?: string | null;
  // The send about to type, or that typed, its text, whose turn is not recorded yet (#37), with the `lastEventAt`
  // read before typing (null when the agent had no hook yet): a repeat of its command id types nothing.
  readonly pendingSend?: { readonly commandId: string; readonly before: number | null } | null;
}
```

- A launch is found again by its command id through `<data>/paradev/launches/<sha256(commandId)>.json`, which holds the `threadId`. That file is written right after `workspaces create` answers, before the agent starts.
- Paradev has no run ordinals. The adapter counts its own deliveries: `runOrdinal` is `turns.length`. A `send` turn is recorded only once the agent reacted to it, shown by a newer `lastEventAt`. A `launch` or `resume` turn is recorded when `agents create` answers, or when the adapter adopts an agent an earlier attempt started. This gives the core what it needs from an ordinal: a message the factory sent shows up as a newer run once it starts.

### Launch branch names

`paradev/branches.ts` derives the branch from the command id, so a retried launch asks for the same branch and `workspaces create` returns the same workspace.

- `softfac:<owner>__<repo>__<issue>__<attempt>:launch` gives `fac/<issue>-<attempt>`.
- Any other command id of a run gives `fac/<issue>-<attempt>-<first 8 hex of sha256(commandId)>`.
- An id that does not parse gives `fac/x-<first 12 hex of sha256(commandId)>`.

Paradev puts a local worktree at `~/.paradev/worktrees/<project name>/<branch>`, with the branch's slashes kept as folders: `fac/1-1` lives in `~/.paradev/worktrees/factory-paradev-spike/fac/1-1` (`ws-get-local.json`). `isLaunchBranch(branch, worktreePath)` is true when `branch` matches `^fac/(\d+|x)-[0-9a-f-]+$` and `worktreePath` ends with `/<branch>`. `launchBranchOf` is its inverse. Paradev never renames a branch after create, unlike T3, so these two matter less than before but keep their contract.

### Method by method

Every call but `snapshot` passes `--local`, and the runner adds `--json`. Timeouts are the runner's own: it kills the `superset` child's process group when one passes.

| Method | CLI calls, in order | Fields read | Timeout, retry |
|---|---|---|---|
| `findProject(root)` | `projects list --local` | `[].path`, `[].id`. Match `realpath(path) === realpath(root)` | 30 s, one retry after 2 s |
| `launch(req)` | 1. If the launch file for `req.commandId` exists and its thread record has a terminal, return the thread. If it exists and the record has no terminal, an earlier attempt stopped between steps 4 and 7 (a crash, or an `agents create` timeout): run step 7's `snapshot` first, and when an agent of the preset is there, the earlier attempt started it after its base check, so record that terminal and a `launch` turn and return. Otherwise fetch the base (step 2) and carry on at step 5. 2. Fetch the base (see below): `<req.baseRef>` by URL from the project's GitHub repo into the adapter's own bare repo `<data>/paradev/fetch/<project id>.git`, the one fetch with credentials, then from there into the clone's `refs/remotes/origin/<req.baseRef>` with none. A project whose `repo` is not an `https://github.com/…` URL fails `launch`. 3. `workspaces create --local --project <req.projectId> --name <req.title cut to 80 chars> --branch <branch> --skip-branch-prefix --base-branch <req.baseRef> --tag factory`, with no `--agent`, because a repeat create with `--agent` starts a second agent (X7). 4. Write the launch file and the thread record. 5. `workspaces get <id> --local` for the worktree path. 6. The base check (below), which only reads. 7. `snapshot --workspace <id>`: when a terminal there already runs an agent with `id == paradev.agent`, take it. A terminal with no agent of the preset (a starting agent shows none until its first hook) is looked at again after 5, 10 and 15 s, and still none fails `launch`, starting nothing. With no terminal, run the base check's reset if it needs one, then `agents create --local --workspace <id> --agent <paradev.agent> [--model <paradev.model>] [--effort <paradev.effort>] --prompt <req.message>`. Either way, append the terminal and a `launch` turn to the record | create: `workspace.id`, `workspace.branch`, `alreadyExists`. The create answer's `worktreePath` is null, so get gives it. agents create: `kind` must be `terminal`, `sessionId` is the terminal id (X1). get: `worktreePath`, `worktreeExists` | each fetch 120 s; the by-URL fetch is tried 3 times, after 5 and 15 s, when git's stderr says the network dropped it, as the gate's fetch is. A failed `launch` sends the run to stuck, and no later pass launches it again. create 300 s, one retry on a timeout or transient error, since create is idempotent by branch when no agent is started. P0 creates took about 2 s. agents create 120 s, no retry, since a second create could start a second agent: when it fails or times out, `launch` reads the snapshot as in step 7 and takes an agent of the preset it finds there, and the snapshot check in step 1 covers a crash. get 30 s, one retry |
| `status(threadId)` | 1. Read the thread record; none is `ThreadNotFoundError`; `archivedAt` set returns `archived: true`. 2. `agents explain --local --workspace <w> --terminal <t>` on the record's current terminal. 3. When the state is `working` and `lastEventAt` is over 10 minutes old, the liveness check (below). 4. When the run has ended, `agents read --local --workspace <w> --terminal <t>` | explain: `state`, `lastEventType`, `lastEventAt`. read: `text` | explain 30 s, read 60 s, each one retry after 2 s |
| `thread(threadId)` | Thread record, then `workspaces get <w> --local` | `worktreePath`, `branch`. The error `Workspace not found on host <host id>: <w>` answers the record's values with `archived: true` (`ws-get-local-archived.meta.json`) | 30 s, one retry |
| `send(threadId, commandId, text)` | 1. `commandId` already in `turns`: return. A `pendingSend` under another command id is cleared, and this is a fresh send. 2. `snapshot --workspace <w>`. When a terminal that is not in the record's `terminals` runs an agent with `id == paradev.agent` and a resume is pending (`pendingResume`), that resume started it and then crashed or timed out before writing the record: adopt it by appending that terminal and a `resume` turn under the pending command id, then carry on with this send (nothing more when it is the same id). Recorded terminals are skipped because the dead one can still read `working` there (`snapshot-local-after-resume.json`). A pending resume beside a terminal with no agent of the preset fails, starting nothing, while an agent process is in `worktreePath` (it may be starting); with none, the resume started nothing and is no longer pending. Such an agent with no resume pending makes the process lookup ambiguous: `send` fails and types nothing. 3. The record's current terminal not in the snapshot: resume (below). 4. `agents explain` for `before = lastEventAt` and `state`. 5. The liveness check's process lookup (below), whatever the state and however recent the last hook: the run reading `interrupted`, or no agent process for `worktreePath`, means resume. The state alone cannot decide this, because a killed agent still reads `working` (`agents-explain-local-killed.json`), and its terminal is a shell prompt (`terminals-read-local-killed.json`) that would run the text as a command. So `send` never types into a terminal whose agent process is gone. A live agent under a `pendingSend` with this command id typed its text on an earlier attempt that failed or crashed: nothing is typed, and step 4's `lastEventAt` decides. Newer than `pendingSend.before` (or any hook when it is null): append the turn and clear `pendingSend`. Else a `SessionsError` that keeps `pendingSend`, so the core's next retry reads again. A live agent whose state is `blocked` is showing a permission prompt, which the text and Enter would answer: `MessageRejectedError`, with nothing typed. 6. Else write `pendingSend: { commandId, before }` to the record, then `terminals send --local --workspace <w> --terminal <t> --text <text>` without `--wait`. A failure Paradev reports before typing (offline, signed out, plan, not found, agent exited, too large) clears `pendingSend`, so the retry types again; a timeout or any other failure keeps it. 7. Poll `agents explain` every 2 s for up to 20 s for `lastEventAt > before`. 8. No reaction: `terminals send ... --keys enter` once and poll 10 s more. 9. Still none: when the last `agents explain` says `idle`, the agent dropped the text: `MessageRejectedError`, and `pendingSend` is cleared. Any other state may still have the text queued, as an agent in a long tool call does: a `SessionsError` that keeps `pendingSend`. Reacted: append the turn and clear `pendingSend` | snapshot: `workspaces[].terminals[].id`, `.agent.id`. explain: `lastEventAt`, `state`. The process lookup: a pid, or none | snapshot 30 s, one retry. send 30 s, no retry |
| resume, inside `send` | 1. When the snapshot still lists the record's current terminal, `terminals close --local --workspace <w> --terminal <old>`: a dead agent's terminal keeps saying `working` forever, and closing it removes that stale agent from `snapshot` (`terminals-close-local-killed.json`, `snapshot-local-after-close.json`). A closed terminal is no longer listed, so a retry does not close it twice. 2. Find the agent's session id: the newest `*.jsonl` under `~/.claude/projects/<worktreePath with every character other than a letter or digit as ->/`, which is how Claude names the folder (`_` and spaces included, not only `/` and `.`). Its file name is the session id, the same as the `sessionId` inside it (L5b). No session id found: `ThreadNotFoundError`, and the core relaunches from the pushed branch. 3. Write the command id to the record as `pendingResume`. 4. `agents create --local --workspace <w> --agent <a> --resume-session <id> --prompt <text>`. Paradev opens a new terminal, Claude restores the old conversation, and the prompt arrives after it (`agents-create-local-resume.json`). 5. Append the new terminal and a `resume` turn, and clear `pendingResume` and `pendingSend`. P0 ran steps 1 and 4 the other way round: the resume first, and the close about 170 s later, after the resumed agent had finished. That a resume works after its old terminal is closed is not recorded; the live smoke checks it | agents create: `sessionId`, the new terminal id | agents create 120 s, no retry: `send`'s step 2 covers a crash or a timeout |
| `archive(threadId)` | `workspaces archive <w> --local` | `deleted`, `notFound`, `failed`. The id in `deleted` or `notFound` counts as archived; in `failed` it is a `SessionsError`. Paradev removes the worktree folder and keeps the local branch (X10) | 120 s, one retry |
| `removeWorktree(path)` | Nothing when `path` is gone, which it is after `workspaces archive`. Else `git worktree remove --force <path>` in the repo clone, keeping the branch, as the T3 adapter does now | none | 60 s |
| `runningThreads` | `snapshot`, then the thread records | count of terminals that are the current terminal of a thread record with no `archivedAt` and whose `agent.state` is `starting` or `working`. `snapshot` lists every workspace on this Mac, so the person's own Paradev agents and terminals the adapter has moved on from do not count. A dead agent counts until resume closes its terminal or the workspace is archived | 30 s, one retry |
| `worktreeCheckout(path)` | None. `git -C <path> rev-parse HEAD` and `git -C <path> symbolic-ref -q --short HEAD`, as the T3 adapter does | `head`, `branch` (null when detached). Null when `path` has no `.git` | 30 s |
| `lastActivity(threadId)` | `agents explain` on the current terminal | `lastEventAt`; null when the state is `none`. Hooks fire on tool calls and on prompts, so a prompt the factory sent counts too, which T3's answer did not | explain 30 s, one retry |
| `worktreesDirectory(dir)` | None. `~/.paradev/worktrees`: the newest thread record's `worktreePath` with `/<project name>/<branch>` cut off, else `dir` | none | none |

`req.pullRequestUrl` is not used: a local Paradev workspace has no PR link.

**The base check.** Paradev does not fetch the base ref. When `--base-branch` names a branch the clone does not have, create still exits 0 with empty stderr and builds the worktree from the project's default branch (X8). So `launch` fetches first, and after create compares `git -C <worktreePath> rev-parse HEAD` with the commit it fetched: nothing moves the clone's local branches, so a local `<baseRef>` is stale. A worktree holding work is never reset: an edit, an untracked file, or a commit no other branch has (the branch's own `origin/` copy does not count as another branch, since an agent pushes there). That is an earlier attempt's agent, and with no agent of the preset there `launch` fails and leaves the worktree as it is. Otherwise, on a mismatch and only after step 7's snapshot shows no terminal, it runs `git reset --hard <fetched commit>` in the worktree, so an agent an earlier attempt started is never reset under. Every git call in the clone or a worktree runs with no credential, and with each filter driver and config hook turned off that one listing of the clone's config named before the calls run. A driver or hook a session writes into the shared `.git/config` after that listing, before the reset (the snapshot looks take up to 30 s), can still run as the runner: the residual risk accepted for P1 (#22, answer 2). Those git processes hold no credential.

**The liveness check.** Paradev's agent state comes only from the agent's hooks. When P0 killed a working `claude` with `kill -9`, `agents explain` kept saying `working` with the last `Start` hook, the terminal stayed alive with `exited: false`, and its screen showed the shell prompt after `killed 'claude'` (`agents-explain-local-killed.json`, `terminals-list-local-killed.json`, `terminals-read-local-killed.json`). So when a run has been `working` with no hook for 10 minutes, the adapter looks for a process named after the preset's `command` (`claude`) whose working directory is `worktreePath` (`pgrep -x` then `lsof -a -d cwd -p <pid>`). None found: `interrupted`. Found: still `running`, since a long tool call sends no hook. This works only for local runs; hosts and cloud need Paradev to report the exit `[P2: H5]`.

The lookup cannot tell the thread's agent from a `claude` a person starts in the worktree outside Paradev, and `send` then types into the dead terminal: the residual risk accepted for P1. An agent of the thread's preset started inside Paradev, in a terminal the record lacks, shows in the snapshot. With no resume pending, `send` refuses (its step 2). With a resume pending, `send` adopts it as the resumed agent (also step 2), since the snapshot gives no session id to tell the two apart; that adoption and any other `claude`, inside Paradev or outside it, are the same residual risk.

### Status mapping

| `agents explain` state | `lastEventType` | `run` | `runCompletedAt` |
|---|---|---|---|
| `starting` | `Attached` or null | `starting` | null |
| `none` | null, within 5 minutes of the newest turn | `starting`. Right after create, explain says `none` ("No agent in this terminal.") until the agent's first hook (`agents-explain-local-starting.json`) | null |
| `none` | null, later | `interrupted` | null |
| `working` | `Start` | `running`, unless the liveness check finds no agent process: `interrupted` | null |
| `blocked` | `PermissionRequest` | `waiting` | null |
| `idle` | `Stop` | `completed` | `lastEventAt` |
| `idle` | `Failed` | `failed` | `lastEventAt` |
| `exited` | any | `interrupted` | `lastEventAt` |
| explain fails with `Workspace not found` | | thread gone: `ThreadNotFoundError` | |

P0 saw only `none`, `working`, `idle`, `Start` and `Stop`. The other rows follow the source and cost nothing to keep.

`runOrdinal` is `turns.length`. `runStartedAt` is the newest turn's `at`. A `blocked` agent holds its slot until the run's time limit. The `claude` preset runs `claude --dangerously-skip-permissions` with the prompt as an argument (`agents-list-local.json`), so it should not block.

`interrupted` sends the run down the core's existing paused path, which resumes it with `send`. X2 did not run, so P1 does not know whether an API error reaches Paradev as `Failed`. It does not depend on it: an `idle` with no result line is an unfinished turn whatever `lastEventType` says, and the rate-limit check reads only `lastAssistantMessage`. The interruption check still looks for trouble in the machine log `[P2: X2 on the host]`.

### Reading the result line

`paradev/transcript.ts` takes `agents read`'s `text`:

1. Find the last chunk that starts with `Assistant: `, either at the start of the text or after a blank line.
2. If a chunk that starts with `User: ` comes after it, the run has no assistant message: `null`.
3. Otherwise the chunk's text without the `Assistant: ` prefix is `lastAssistantMessage`. The core's `domain/resultLine.ts` finds the result line in it, unchanged.

What P0 showed (L3, L4, L5b): nothing follows the final `Assistant:` chunk. One `/factory` prompt makes two `User:` chunks, the command and the expanded SKILL.md. A gate failure sent with `terminals send --text` arrives as one `User:` chunk wrapped in `<pasted_content id="…">`. One reply can be several `Assistant:` chunks, and the result line is in the last. After a resume the transcript holds the old conversation, then an `Assistant: No response requested.` chunk where Claude restored it, then the new prompt. The tests cover each of these layouts.

The CLI error "No transcript for that terminal" gives `null`. The adapter reads the transcript only when `run` has ended, to keep each pass to one call per running build.

### The CLI runner

`paradev/cli.ts` is the only code that spawns `superset`.

- Binary: `paradev.cli` from the config, default `/Applications/Superset.app/Contents/Resources/resources/bin/superset`.
- The runner adds `--json` to every call. Callers pass `--local` themselves: `snapshot`, `schema`, `auth whoami` and the `pages` commands take none, and `snapshot` defaults to this machine.
- Environment: `HOME`, `PATH`, `USER`, `LANG` and `TMPDIR` only, through `process.ts`'s allowlist. No `SUPERSET_API_KEY`.
- Login: a CLI started outside a Paradev terminal has no host login. P0 saw every call fail with `Not logged in` from Terminal.app until `superset auth login`, after which `auth whoami` said `authSource: oauth`. The LaunchAgent is outside Paradev, so `install` runs `superset auth whoami --json` and exits 1 with the login command when it fails.
- Exit 0: parse stdout as JSON; a parse failure is `PARADEV_SHAPE`.
- Exit 1: the first stderr line after `Error: ` is the message, the line after `Hint: ` is the hint. The CLI writes no JSON on failure.

| stderr message | Kind | What the factory does |
|---|---|---|
| `Host service for this machine isn't running` (seen, L5a), `Host service manifest is stale` | `PARADEV_OFFLINE` | The pass holds claims and their resumes (`paradev-offline`). Running builds are left as they are. Attention item after three passes |
| `Not logged in` (seen), `No active organization` | `PARADEV_SIGNED_OUT` | As offline, with its own attention text naming `superset auth login` |
| `Workspace not found on host ...` (seen, X10) | `NOT_FOUND` | `ThreadNotFoundError` in `status` and `thread`; archived in `archive` |
| `Could not connect to API` | `TRANSIENT` | One retry, then `SessionsError` |
| `Needs the ... plan` | `PARADEV_PLAN` | `SessionsError`; attention item naming the plan |
| `No agent is running in terminal ...` | `AGENT_EXITED` | Treated as `exited` |
| `No transcript for that terminal` | `NO_TRANSCRIPT` | `lastAssistantMessage: null` |
| `A stored value is at most 65536 bytes` (seen, X4) | `TOO_LARGE` | Belt writer only: a warning in the log |
| Our timeout | `TIMEOUT` | `SessionsError` |
| Anything else | `UNKNOWN` | `SessionsError` with the message |

"Seen" messages are in the fixtures' `.meta.json`, and the contract test maps each one. The others come from the CLI source and are matched by prefix.

A `SessionsError` reaches the machine log as an `error` with kind `t3`, as today. The kind keeps its old name so `factory-runner retro` (T5, #29) reads t3fac's and the runner's ledgers the same way. It still counts as trouble evidence for the interruption check and toward the three-errors attention item.

### The CLI check at start

`paradev/schema.ts` runs `superset schema` at start and on every config reload. It refuses to claim, through the Paradev hold, when any command or option below is missing, and the attention item names the version it found. It does not pin an exact version: 2.0.7 and 2.0.8 both pass.

| Command | Options the runner uses |
|---|---|
| `projects list` | `--local` |
| `workspaces create` | `--local`, `--project`, `--name`, `--branch`, `--base-branch`, `--skip-branch-prefix`, `--tag` |
| `workspaces get`, `workspaces archive` | `--local` |
| `agents create` | `--local`, `--workspace`, `--agent`, `--model`, `--effort`, `--prompt`, `--resume-session` |
| `agents explain`, `agents read` | `--local`, `--workspace`, `--terminal` |
| `terminals send` | `--local`, `--workspace`, `--terminal`, `--text`, `--keys` |
| `terminals close` | `--local`, `--workspace`, `--terminal` |
| `snapshot` | `--workspace` |
| `auth whoami` | none |
| `pages publish` | `--page`, `--title`, `--visibility`, `--label`, `--no-watch`, `--workspace` |
| `pages storage` | `--key`, `--scope`, `--set` |
| global | `--json` |

Each pass also runs `superset status --json`. A failure there is `PARADEV_OFFLINE`.

## Config

### Machine config

`~/.config/factory-runner/config.yml`. The data lives in the same folder, as t3fac keeps both in `~/.config/t3fac/factory`, so `factory-runner retro --data-dir ~/.config/factory-runner` (T5, #29) reads it.

Kept from t3fac with the same meaning and defaults: `gh_config_dir`, `poll_seconds`, `max_concurrent_runs`, `max_concurrent_gates`, `feedback_seconds`, `notify`, `min_free_gib`, `max_load_per_core`, `default_project`.

Kept but must be empty: `model_fallbacks`.

Ignored with a warning, as t3fac does for retired keys: `model_instance`, `model`, `prune_branches_after_days`, `prune_branches_dry_run`, `deploy_wait_minutes`, `keep_versions`.

New:

```yaml
# The repos this runner builds. `path` is a clone used only by the runner, added once to
# Paradev on this Mac:  superset projects create --local --name <name> --import <path>
repos:
  - repo: original-solutions/factory-paradev-spike
    path: /Users/tomkaczocha/factory-runner/original-solutions/factory-paradev-spike

paradev:
  cli: /Applications/Superset.app/Contents/Resources/resources/bin/superset
  agent: claude              # a preset id from `superset agents list --local`
  model: opus                # optional; passed as --model. Omitted: the agent's default
  effort: high               # optional; passed as --effort
  belt:
    enabled: true
    visibility: just_me      # just_me | org. everyone is refused (T4)
```

Reserved for P4: a `control_plane` block, whose `url` will default to `https://factory.originalsolutions.com.au`. P1 refuses the block with "the control plane arrives in phase 4", so no P1 config can depend on a shape P4 has not settled.

A repo whose `path` is not a Paradev project on this Mac is skipped with `claim_skipped` reason `no-paradev-project` and one attention item that gives the `projects create` command.

A repo whose `path` is the Paradev project of another GitHub repo, or of none, is skipped with `claim_skipped` reason `paradev-project-repo` and one attention item naming both: a session there would work on the other repo's code. A launch refuses such a project too, so a pass whose project lookup failed cannot start one there.

### Repo config

The `factory` block in each repo's `.dw/config.yml` is read unchanged: `instructors`, `base`, `provision`, `gate`, `required_checks`, `limits`, `autonomy`. No new keys in P1.

## The belt page

### Publishing

On the first pass with `paradev.belt.enabled`, when `<data>/belt.json` has no page id, the runner writes `src/paradev/belt.html` to `<data>/belt-page/index.html` and runs:

```bash
superset pages publish <data>/belt-page/index.html --title "Factory belt (<host>)" \
  --visibility <paradev.belt.visibility> --no-watch --json
```

[Assumption] P0 could publish only with `--workspace`. Without one, from a Paradev terminal with `SUPERSET_WORKSPACE_ID` unset, publish failed with `Not logged in` (X4). That terminal used the host's login, not OAuth. #26 publishes without `--workspace`, and the live smoke (#27) checks it under the runner's OAuth login. A failure there becomes its own fix issue.

It saves the page id and the HTML's sha256 in `<data>/belt.json`. When a new runner version ships different HTML, it publishes again with `--page <id> --label "runner <version>"`.

The page is one static file with no outside fetches, since the page CSP blocks them. It reads `window.superset.storage.get("belt", { scope: "shared" })` once and then follows `storage.subscribe("belt", ..., { scope: "shared" })`. X4 showed both work in 2.0.8: the probe page picked up a 40 KiB write live, with no reload.

### Payload

One key, `belt`, in the `shared` scope. Paradev caps one stored value at 64 KiB, `MAX_PAGE_STORAGE_VALUE_BYTES`. The 20 MiB figure is the page's total. The runner keeps the payload under 60 KiB.

```ts
interface BeltV1 {
  readonly v: 1;
  readonly updatedAt: string;                 // ISO 8601
  readonly runner: {
    readonly host: string;
    readonly version: string;
    readonly paradevCli: string;              // from `superset schema`
    readonly claimsPaused: boolean;
    readonly paradevOnline: boolean;
    readonly lastPassAt: string | null;
  };
  readonly counts: {
    readonly triage: number; readonly building: number; readonly prOpen: number;
    readonly needsInfo: number; readonly stuck: number; readonly finished7d: number;
  };
  readonly runs: ReadonlyArray<{                // listRuns: every unfinished run, finished runs of the last 7 days
    readonly id: string;                      // runIdToString
    readonly repo: string;
    readonly issue: number;
    readonly title: string | null;            // cut to 120 chars
    readonly state: "proposed" | "ready" | "triage" | "needs-info" | "building" | "pr-open" | "stuck" | null;
    readonly step: string | null;             // cut to 120 chars
    readonly reason: string | null;           // cut to 300 chars
    readonly prUrl: string | null;
    readonly startedTs: string | null;
    readonly finished: boolean;
    readonly totalMs: number | null;
    readonly workspaceId: string | null;      // from the thread record, so the page can link the workspace
  }>;
  readonly attention: ReadonlyArray<{
    readonly id: string; readonly kind: string; readonly text: string; readonly since: string;
  }>;
}
```

When the JSON is over 60 KiB, the writer drops finished runs, oldest first, until it fits, and sets `counts.finished7d` from the full list before trimming.

### Cadence

After each pass the runner builds the payload. It writes when the payload differs from the last one written, ignoring `updatedAt`, or when the last write is 10 minutes old, so a viewer can tell a stopped runner from a quiet one.

```bash
superset pages storage <page id> --key belt --scope shared --set '<json>' --json
```

Timeout 20 s, no retry: the next pass writes again. A failure goes to the log as a warning only. It is not session trouble.

## Process model

- `factory-runner run` is the loop, in the foreground. It takes `<data>/runner.lock` with its pid and exits when another live runner holds it.
- `factory-runner install`:
  1. Copies the package to `~/.local/share/factory-runner/versions/<version>/` and points `current` at it. The copy is made beside that folder first and moved in at step 5, once the old runner is gone, so a running runner's code is never removed under it.
  2. Writes `~/Library/LaunchAgents/io.github.original-solutions.factory-runner.plist` with `RunAtLoad`, `KeepAlive`, `ThrottleInterval` 10, and `ProgramArguments` set to the absolute `process.execPath` and `current/src/bin.ts run`.
  3. Writes `io.github.original-solutions.factory-runner.logrotate.plist`, which runs `rotate-log.sh` every 600 s.
  4. Copies `config.example.yml` to the config path when none exists.
  5. For each agent, the log rotation agent first: when it is loaded, runs `launchctl bootout` and waits until `launchctl print gui/<uid>/<label>` no longer finds it; then runs `launchctl bootstrap`, so launchd always reads the plist just written. Never `kickstart -k`, which keeps the old definition. Just before the runner's bootstrap, the copy from step 1 moves in and the log's length is noted.
  6. Waits up to 60 s for a `runner started` written after that point in the log, and otherwise exits 1 with the log's last 40 lines.

  Before step 1 it checks, writing nothing on a failure, that the machine config loads when there is one (its `paradev.cli` names the CLI to check) and that `superset auth whoami --json` succeeds.

  Older version folders stay, so going back is `install` from the older version. An install of the version already there replaces its folder, so going back to earlier code of the same version is `install` from a checkout of that code.
- `factory-runner uninstall` boots out both agents and removes the plists. It keeps the config, the data and the versions.
- Logs: `~/Library/Logs/factory-runner/runner.log`, rotated by the second agent, as t3fac does, because a crash-looping process writes the most log and cannot rotate its own.
- `status [--json]`, `runs stop <run id>` and `claims pause|resume` read and write the data dir through `status.ts` and `control.ts`. They do not talk to the running process. A stop takes effect on the next pass.
- The Paradev desktop app must stay open: the CLI bundled with it needs the app's host service. A standalone `superset` install with `superset start --daemon` also works, and `paradev.cli` then points at it.

### What survives what

| Event | Paradev agents | Runner |
|---|---|---|
| Runner restart or crash | Keep running | Reads the ledger and the thread records on start and carries on. A gate that was running died with the runner's process group; the next pass runs it again from a fresh checkout, as t3fac does after a restart |
| Paradev app Cmd+Q | Keep running: terminals live in a separate `pty-daemon` that stays up (L5a) | Every call fails `PARADEV_OFFLINE`. Claims and their resumes hold. Runs keep their state, and their time limits keep counting. Picks up when the app opens, with the same terminal ids |
| The agent process dies (crash, `kill`) | That agent stops; its terminal stays at a shell prompt and explain still says `working` (L5b) | The liveness check reads `interrupted` after 10 minutes with no hook. The core sends its resume message; the adapter closes the dead terminal and resumes the Claude session in a new one |
| "Quit Paradev Completely", reboot | Die. Not tried in P0: a full quit would have killed the recording terminal | Expected to read as the row above, or as `exited`/`none`. Same resume path, or the core relaunches from the pushed branch |
| A person archives the workspace in Paradev | Stop | `status` reads `ThreadNotFoundError`; the core treats the session as gone and relaunches or ends the run, as it does when a T3 thread disappears |

## Tests

### Ported as they are

All suites under "Moves unchanged". In t3code-factory that is roughly 2,000 test cases, most of them in `tracker/github.test.ts` with 348, `pass.test.ts` with 285, `runner/gating.test.ts` with 234 and `runner/building.test.ts` with 172. They exercise the core against fake sessions, so they keep passing as long as the adapter honours the interface. `config.test.ts` gains cases for the new keys and the refused `model_fallbacks`.

### New contract tests

`paradev/*.contract.test.ts` run the adapter against `fake-superset`, which answers each argv with a recorded fixture. They answer one question on each Paradev release: does the adapter still read this CLI?

| Test | Fixtures from `spike/fixtures/2.0.8/` |
|---|---|
| launch creates the workspace with no `--agent`, starts the agent with `agents create`, records the thread | `projects-list-local.json`, `ws-create-local-x8.json` (the one create recorded without `--agent`: `agents` is empty), `ws-get-local-x8.json`, `snapshot-local-before-kill.json` with its `terminals` emptied (the workspace before any agent), `agents-create-local-resume.json` as the `agents create` answer (the only one recorded; its fields do not depend on `--resume-session`), `agents-explain-local-starting.json`, with a real git repo already at the expected base, so the base check resets nothing |
| launch after a crash between the launch file and the agent's start: adopts the agent the earlier attempt started, or starts one | a launch file and a thread record with no terminal, written by the test; `snapshot-local-before-kill.json` (an agent of the preset `working`: taken, with no create call), then the emptied copy (step 5 on: get, base check, `agents create`) |
| launch again with the same command id starts nothing | `ws-create-local-repeat.json` |
| launch resets a worktree that Paradev built from the wrong base | `ws-create-local-x8.json`, `ws-get-local-x8.json`, with a real git repo |
| status while starting, working, after a clean stop | `agents-explain-local-starting.json`, `agents-explain-local-working.json`, `agents-explain-local-idle.json`, `agents-read-local.json` |
| a `working` run with no agent process and no hook for 10 minutes is `interrupted` | `agents-explain-local-killed.json`, with a faked process list |
| lastAssistantMessage is the last line source | `agents-read-local.json`, `agents-read-local-after-gate.json`, `agents-read-local-resume.json` |
| send delivers and counts a turn | `terminals-send-local.json`, `agents-explain-local-after-gate.json` |
| app closed holds claims | `agents-explain-local-appquit.meta.json`, `ws-create-local-4-nologin.meta.json` |
| send to a dead agent resumes it instead of typing into its terminal | `agents-explain-local-killed.json`, with a faked process list that has no agent process: expects `terminals close` and `agents create --resume-session`, and no `terminals send` |
| resume closes the dead terminal and starts a new one | `snapshot-local-killed.json`, `terminals-close-local-killed.json`, `agents-create-local-resume.json`, `agents-wait-local-resume.json` |
| resume after a crash between `agents create` and the record adopts the resumed agent | `snapshot-local-after-resume.json`: the recorded dead terminal still reads `working` and is skipped, the new one is adopted, and nothing is closed or created |
| runningThreads counts only the factory's current terminals | `snapshot-local-after-resume.json` with a record whose current terminal is the resumed one, plus a second workspace with no record |
| archive, then status and thread | `ws-archive-local-2.json`, `ws-archive-local-again.json`, `agents-explain-local-archived.meta.json`, `ws-get-local-archived.meta.json` |
| the CLI check passes on 2.0.8 and fails on a schema missing `agents explain` | `schema.json`, plus one edited copy |
| every known stderr maps to its kind | every `*.meta.json` with `exit: 1` |
| the belt write and its size cap | `pages-publish-probe-ws.json`, `pages-storage-set-belt.json`, `pages-storage-set-belt-oversize.meta.json` |

An API error's `Failed` has no fixture (X2 did not run). A unit test covers the rule that matters: an `idle` with no result line is an unfinished turn.

Unit tests beside them:

- `transcript.ts`: each known chunk layout, and an assistant text with `User:` mid-line.
- `branches.ts`: each command id form.
- `state.ts`: atomic write, and a torn file.
- `belt.ts`: the trim to 60 KiB, an unchanged payload not written again, the 10-minute heartbeat.

### End to end

`src/e2e.test.ts` keeps t3fac's two cases with real git and a real gate, GitHub faked by argv, and `fake-superset` scripted to answer like a build: create, working, idle with `FACTORY-DONE: <url>`, then a gate failure sent back and a second `FACTORY-DONE`.

### Live smoke

Before any real repo moves, the runner builds three issues on the spike repo, `original-solutions/factory-paradev-spike`, which P0 kept, with issues 1 to 6 still open: one that ends `FACTORY-DONE` and passes the gate, one written to end `FACTORY-STOP: needs-info`, and one whose gate fails once. While one of them is working, `kill -9` its `claude` process: after the liveness check reads `interrupted`, the adapter closes the dead terminal and then resumes the session, the order P0 did not record. Pass: the killed run resumes and ends with a result line, and the ledger, labels and comments match what t3fac writes for the same three cases.

## Acceptance run

The plan says repos move from Rust softfac. On this Mac that is out of date: there is no softfac binary and no `~/.local/share/softfac`, the factory-issue skill says softfac is retired here, and t3fac, LaunchAgent `io.github.rawphp.t3fac`, is the live factory with 482 runs in `~/.config/t3fac/factory/runs`. So the runner takes over from t3fac.

1. Pick the lowest-traffic repo in `~/.config/t3fac/factory/config.yml`. Take it out of t3fac the way `factory/docs/handover.md` in t3code-factory describes, and wait until t3fac has no unfinished run for it.
2. Clone it to `~/factory-runner/<owner>/<repo>`, add the clone as a Paradev project, and add it to the runner's `repos:`.
3. Keep both factories' `max_concurrent_runs` summed at or below t3fac's current 3, since both use the same Claude account.
4. Watch its first three runs. Fix what breaks before moving the next repo.
5. Move the rest one at a time, the same way.
6. After 30 runner runs, run the retro chosen in T5 on both data dirs for matching windows. Compare: share of runs that reach `pr-open` without a person, stuck rate by reason, time from claim to `pr-open`, and PRs merged without change requests.

Pass: the runner is no worse than t3fac on the first and second numbers, and no run went stuck because of the adapter without a fix issue filed for it.

## Issues, in order

Filed 2026-11-11 on `original-solutions/factory-on-paradev`. Each body is the build contract; where a body and this spec differ, the body wins. The spec's first draft had the pure core and the runner core as two issues, but `tracker/github.ts` imports `config.ts` and `ledger/listRuns.ts` imports `runner/progress.ts`, so they move together in #20.

| Issue | Title | Depends on | Kind |
|---|---|---|---|
| #18 | chore: land the P1 spec and the local spike fixtures | none | tracking, closed by the PR that adds this file |
| #19 | chore: CI runs the gate on pull requests, and the runner's dependencies | none | factory, S |
| #20 | refactor: move the factory core from t3code-factory behind src/sessions.ts | #18, #19 | factory, L |
| #21 | feat: run superset and check its schema | #18, #19 | factory, M |
| #22 | feat: Paradev sessions adapter, launch and status | #20, #21 | factory, L |
| #23 | feat: Paradev sessions adapter, send, resume and archive | #22 | factory, M |
| #24 | feat: factory-runner run on local Paradev, with the Paradev hold and config | #22, #23 | factory, L |
| #25 | feat: install, uninstall, status, runs stop, claims pause and resume | #24 | factory, M |
| #26 | feat: the belt as a Paradev page | #24 | factory, M |
| #27 | test: live smoke of the installed runner on the spike repo | #25, #26 | hands-on |
| #28 | chore: move the first repo from t3fac to the runner | #27 | hands-on; one issue per further repo follows |
| #29 | feat: factory-runner retro compares two factories' ledgers | #25 | factory, M |

## What P0 settled

From `spike/RESULTS.md` in factory-on-paradev, local runs on 2026-11-10 and 2026-11-11.

| Probe | Result | Used in |
|---|---|---|
| L1, X1 | The create answer's `.agents[0].sessionId` is the terminal id. Its `worktreePath` is null; `workspaces get` gives `~/.paradev/worktrees/<project>/<branch>`. Creates took about 2 s | launch, `isLaunchBranch`, `worktreesDirectory` |
| L2, L3 | The agent settles `idle` with `Stop`. Nothing follows the final `Assistant:` chunk; a `/factory` prompt is two `User:` chunks | status mapping, transcript reader |
| L4 | A multi-line send arrives as one `User:` chunk in `<pasted_content>`. The reply can be several `Assistant:` chunks | send, gate failure delivery |
| L5a | Cmd+Q leaves agents running in `pty-daemon`; calls fail `Host service for this machine isn't running` until the app reopens, then the same terminal ids answer | the Paradev hold |
| L5b | A killed agent stays `working`, its terminal live at a shell prompt. The session id is the newest `.jsonl` in Claude's project folder, and `--resume-session` with `--prompt` continues the conversation in a new terminal | the liveness check, resume |
| X2 | Not run (host only, to keep this Mac's other agents online) | nothing: the rate-limit path reads the transcript |
| X4 | Page `storage.get` and `subscribe` work; publish worked only with `--workspace`; a value over 65536 bytes fails | belt page, #27's publish check |
| X6 | No flag and `--local` give the same answer today | every call that takes `--local` still passes it (`snapshot` takes none) |
| X7 | A repeat create with `--agent` returns `alreadyExists: true` and starts a second agent | launch without `--agent` |
| X8 | `--base-branch` does not fetch, and a missing branch silently falls back to the project default | the base check |
| X9 | PRs open as the active `gh` login; commits carry the worktree's git email | T2, launch message |
| X10 | Archive answers `deleted` (also for a repeat), removes the worktree folder, keeps the branch. Afterwards every call says `Workspace not found on host …` | archive, thread, status |
| X11 | Not run | nothing in P1 |
| `agents list --local` | `claude` runs `claude --dangerously-skip-permissions`, prompt as an argument. No model ids are listed | `paradev.model` is optional |
| stderr | `Host service … isn't running`, `Not logged in`, `Workspace not found on host …`, `A stored value is at most 65536 bytes` | the error table |

P2 still needs the host and cloud runs (factory-on-paradev #8 and #9): H1's create time against the relay's 30-second cap, H5, X2, X3, C1 to C6.

## Assumptions

1. The core is erasable TypeScript, so Node runs it without a build.
2. A Paradev local workspace's worktree is a normal git worktree of the project's clone, so the gate's fresh-checkout logic and `git worktree remove` work as they do with T3.
3. Claude Code inside a Paradev terminal picks up `~/.claude/skills/factory`, as it does for t3fac sessions.
4. Two factories can share one Claude subscription during the migration if their combined concurrency stays at t3fac's current limit.
5. `superset` answers `explain` and `snapshot` in well under a second on this Mac, so a 30-second pass with three builds stays cheap. Measured in #27.

## Asks for Paradev that would remove workarounds

Raise these with Paradev:

- Print the agent's session id in `agents explain --json`. That removes the read of Claude's own store on disk.
- Print the end reason, one of `terminal-exited`, `detached`, `disposed` and `resumed`, and the successor terminal in `agents explain --json`.
- Accept a caller's idempotency id on `workspaces create` and `agents create`. The host's `create` already takes an `id`; the CLI does not pass one.
- Notice when the agent process exits. Today a killed agent stays `working` in `agents explain` until its terminal is closed.
- Fetch the base ref in `workspaces create --base-branch`, or fail when it is missing, instead of falling back to the project default with exit 0.
