/**
 * `FactorySessions` over Paradev's `superset` CLI, for workspaces on this Mac: one workspace per
 * thread, one factory agent per workspace, and the adapter's own records in `state.ts`. This file
 * has `findProject`, `launch`, `status`, `thread`, `runningThreads`, `worktreeCheckout`,
 * `lastActivity` and `worktreesDirectory`; `send`, `archive` and `removeWorktree` come later.
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { configFlags, HARDENED_GIT_CONFIG, HARDENED_GIT_ENV } from "../gitHardening.ts";
import { FactoryPaths } from "../paths.ts";
import { FactoryProcess } from "../process.ts";
import {
  type FactorySessions,
  type LaunchRequest,
  type RunStatus,
  SessionsError,
  ThreadNotFoundError,
  type ThreadStatus,
} from "../sessions.ts";
import { launchBranch, worktreesRootOf } from "./branches.ts";
import { call, callWithRetry, decodeAnswer } from "./call.ts";
import { type CliError, SupersetCli } from "./cli.ts";
import { listProjects, projectAt } from "./projects.ts";
import {
  listThreads,
  readLaunch,
  readThread,
  type ThreadRecord,
  threadIdOf,
  workspaceIdOf,
  writeLaunch,
  writeThread,
} from "./state.ts";
import { lastAssistantMessage } from "./transcript.ts";

const MINUTE = 60_000;
/** Right after `agents create`, explain says `none` until the agent's first hook. */
const STARTING_GRACE_MS = 5 * MINUTE;
/** A `working` agent this long without a hook gets the process lookup. */
const SILENT_WORKING_MS = 10 * MINUTE;
const NAME_MAX = 80;

const Created = Schema.Struct({
  workspace: Schema.Struct({ id: Schema.String, branch: Schema.String }),
  alreadyExists: Schema.Boolean,
});
const Got = Schema.Struct({ worktreePath: Schema.NullOr(Schema.String), branch: Schema.String });
const Snapshot = Schema.Struct({
  workspaces: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      terminals: Schema.Array(
        Schema.Struct({
          id: Schema.String,
          agent: Schema.optional(
            Schema.NullOr(Schema.Struct({ id: Schema.String, state: Schema.String })),
          ),
        }),
      ),
    }),
  ),
});
type SnapshotAnswer = typeof Snapshot.Type;
/** `sessionId` is the new terminal's id (X1). */
const AgentStarted = Schema.Struct({ kind: Schema.Literal("terminal"), sessionId: Schema.String });
const Explained = Schema.Struct({
  state: Schema.String,
  lastEventType: Schema.NullOr(Schema.String),
  lastEventAt: Schema.NullOr(Schema.Number),
});
type Explanation = typeof Explained.Type;
const Transcript = Schema.Struct({ text: Schema.String });

export class AgentLookupError extends Schema.TaggedError<AgentLookupError>()(
  "ParadevAgentLookupError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Looking for the agent's process failed.";
  }
}

/**
 * The liveness check's process lookup: the pid of a process named `command` whose working
 * directory is `cwd`, else null. Paradev's agent state comes only from hooks, so a killed agent
 * still reads `working`; only its process tells.
 */
export class AgentProcess extends Context.Service<
  AgentProcess,
  {
    readonly find: (
      command: string,
      cwd: string,
    ) => Effect.Effect<number | null, AgentLookupError>;
  }
>()("factory-runner/paradev/sessions/AgentProcess") {}

/** `pgrep -x <command>`, then `lsof -a -d cwd -p <pid>` for each pid. Local runs only. */
export const agentProcessLayer = Layer.effect(
  AgentProcess,
  Effect.gen(function* () {
    const runner = yield* FactoryProcess;
    const fs = yield* FileSystem.FileSystem;
    const run = (command: string, args: ReadonlyArray<string>) =>
      runner
        .run({
          command,
          args,
          separateStderr: true,
          timeoutMs: 10_000,
          env: { PATH: `${globalThis.process.env.PATH ?? ""}:/usr/bin:/usr/sbin:/bin:/sbin` },
        })
        .pipe(
          Effect.mapError((cause) => new AgentLookupError({ cause })),
          Effect.filterOrFail(
            (result) => !result.timedOut,
            () => new AgentLookupError({ cause: `${command} did not answer within 10 s` }),
          ),
        );
    const real = (path: string) => fs.realPath(path).pipe(Effect.orElseSucceed(() => path));
    return AgentProcess.of({
      find: Effect.fn("AgentProcess.find")(function* (command: string, cwd: string) {
        const listed = yield* run("pgrep", ["-x", command]);
        // pgrep exits 1 when no process matched.
        if (listed.exitCode === 1) return null;
        if (listed.exitCode !== 0) {
          return yield* new AgentLookupError({
            cause: `pgrep exited ${listed.exitCode}: ${listed.stderrTail}`,
          });
        }
        const want = yield* real(cwd);
        for (const pid of listed.tail.split("\n").map((line) => line.trim())) {
          if (!/^\d+$/.test(pid)) continue;
          const open = yield* run("lsof", ["-a", "-d", "cwd", "-p", pid, "-Fn"]);
          // lsof exits 1 for a process that has gone since pgrep listed it.
          if (open.exitCode !== 0) continue;
          const dir = open.tail
            .split("\n")
            .find((line) => line.startsWith("n"))
            ?.slice(1);
          if (dir !== undefined && (yield* real(dir)) === want) return Number(pid);
        }
        return null;
      }),
    });
  }),
);

export interface ParadevSessionsConfig {
  /** `paradev.agent`: the preset id, e.g. `claude`. */
  readonly agent: string;
  /** The process the preset runs, for the liveness check. Default `agent`. */
  readonly agentCommand?: string;
  /** `paradev.model`, passed as `--model`. Unset: the agent's default. */
  readonly model?: string;
  /** `paradev.effort`, passed as `--effort`. */
  readonly effort?: string;
}

/** What this issue builds of `FactorySessions`. */
export type ParadevSessions = Omit<FactorySessions["Service"], "send" | "archive" | "removeWorktree">;

type Operation = SessionsError["operation"];

const failWith =
  (operation: Operation) =>
  (cause: unknown): SessionsError =>
    new SessionsError({ operation, cause });

const isNotFound = (error: CliError) => error.kind === "NOT_FOUND";

export const make = Effect.fn("ParadevSessions.make")(function* (config: ParadevSessionsConfig) {
  const cli = yield* SupersetCli;
  const runner = yield* FactoryProcess;
  const processes = yield* AgentProcess;
  const dataDir = (yield* FactoryPaths).baseDir;
  const services = yield* Effect.context<FileSystem.FileSystem | Path.Path | SupersetCli>();
  const fs = yield* FileSystem.FileSystem;
  const agentCommand = config.agentCommand ?? config.agent;

  /** The adapter's file and CLI helpers need these; the service's methods require nothing. */
  const local = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | SupersetCli>) =>
    Effect.provideContext(effect, services);

  // ---- git ----------------------------------------------------------------------------------

  /**
   * One git call, hardened as the gate's are: a session can write the clone's config and hooks,
   * so none of them runs here. Only the fetch gets credentials, through `gh`.
   */
  const git = (dir: string, args: ReadonlyArray<string>, options: { readonly fetch?: boolean; readonly timeoutMs?: number } = {}) =>
    Effect.gen(function* () {
      const env: Record<string, string> = { ...HARDENED_GIT_ENV };
      if (options.fetch === true) {
        for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "GH_CONFIG_DIR", "XDG_CONFIG_HOME"]) {
          const value = globalThis.process.env[name];
          if (value !== undefined) env[name] = value;
        }
      }
      const credentials =
        options.fetch === true
          ? ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"]
          : [];
      const result = yield* runner.run({
        command: "git",
        args: [...configFlags(HARDENED_GIT_CONFIG), ...credentials, "-C", dir, ...args],
        env,
        separateStderr: true,
        timeoutMs: options.timeoutMs ?? 30_000,
      });
      return result;
    });

  /** `git` that must exit 0: its stdout, trimmed. */
  const gitOk = (dir: string, args: ReadonlyArray<string>, options?: { readonly fetch?: boolean; readonly timeoutMs?: number }) =>
    git(dir, args, options).pipe(
      Effect.flatMap((result) =>
        result.exitCode === 0 && !result.timedOut
          ? Effect.succeed(result.tail.trim())
          : Effect.fail(
              new Error(
                `git ${args.join(" ")} ${result.timedOut ? "timed out" : `exited ${result.exitCode}`}: ${result.stderrTail.trim()}`,
              ),
            ),
      ),
    );

  // ---- CLI calls ----------------------------------------------------------------------------

  const getWorkspace = (workspaceId: string) => {
    const argv = ["workspaces", "get", workspaceId, "--local"];
    return callWithRetry(cli, argv, 30_000).pipe(
      Effect.flatMap((answer) => decodeAnswer(Got, answer, argv)),
    );
  };

  const snapshot = (workspaceId?: string): Effect.Effect<SnapshotAnswer, CliError> => {
    const argv = workspaceId === undefined ? ["snapshot"] : ["snapshot", "--workspace", workspaceId];
    return callWithRetry(cli, argv, 30_000).pipe(
      Effect.flatMap((answer) => decodeAnswer(Snapshot, answer, argv)),
    );
  };

  const explain = (record: ThreadRecord, terminal: string) => {
    const argv = ["agents", "explain", "--local", "--workspace", record.workspaceId, "--terminal", terminal];
    return callWithRetry(cli, argv, 30_000).pipe(
      Effect.flatMap((answer) => decodeAnswer(Explained, answer, argv)),
    );
  };

  /** The last assistant message of the terminal's transcript; null when it has none. */
  const readMessage = (record: ThreadRecord, terminal: string) => {
    const argv = ["agents", "read", "--local", "--workspace", record.workspaceId, "--terminal", terminal];
    return callWithRetry(cli, argv, 60_000).pipe(
      Effect.flatMap((answer) => decodeAnswer(Transcript, answer, argv)),
      Effect.map(({ text }) => lastAssistantMessage(text)),
      Effect.catchIf(
        (error) => error.kind === "NO_TRANSCRIPT" || error.kind === "AGENT_EXITED",
        () => Effect.succeed(null),
      ),
    );
  };

  /** A terminal of the workspace in `answer` that runs this preset's agent and is not in `skip`. */
  const agentTerminalIn = (answer: SnapshotAnswer, workspaceId: string, skip: ReadonlyArray<string>) =>
    answer.workspaces
      .find((ws) => ws.id === workspaceId)
      ?.terminals.find((t) => t.agent?.id === config.agent && !skip.includes(t.id))?.id ?? null;

  // ---- records ------------------------------------------------------------------------------

  /** The record of a thread id; `ThreadNotFoundError` for an id or a record the adapter lacks. */
  const recordOf = (threadId: string, operation: Operation) =>
    Effect.gen(function* () {
      const workspaceId = workspaceIdOf(threadId);
      if (workspaceId === null) return yield* new ThreadNotFoundError({ threadId });
      const record = yield* local(readThread(dataDir, workspaceId)).pipe(
        Effect.mapError(failWith(operation)),
      );
      if (record === null) return yield* new ThreadNotFoundError({ threadId });
      return record;
    });

  const save = (record: ThreadRecord) => local(writeThread(dataDir, record));

  // ---- launch -------------------------------------------------------------------------------

  /** Steps 5 to 7 of a launch: the worktree, the base check, and the agent. */
  const startAgent = (record: ThreadRecord, request: LaunchRequest, clone: string | null) =>
    Effect.gen(function* () {
      const got = yield* getWorkspace(record.workspaceId);
      if (got.worktreePath === null) {
        return yield* Effect.fail(new Error(`workspace ${record.workspaceId} has no worktree`));
      }
      const placed: ThreadRecord = { ...record, worktreePath: got.worktreePath };
      yield* save(placed);
      yield* baseCheck(got.worktreePath, request, clone);
      const found = agentTerminalIn(yield* snapshot(record.workspaceId), record.workspaceId, placed.terminals);
      const terminal = found ?? (yield* createAgent(record.workspaceId, request));
      const now = yield* Clock.currentTimeMillis;
      const started: ThreadRecord = {
        ...placed,
        terminals: [...placed.terminals, terminal],
        turns: [...placed.turns, { commandId: request.commandId, at: now, kind: "launch" }],
      };
      yield* save(started);
      return started;
    });

  /**
   * Paradev does not fetch the base, and falls back to the project's default branch for one the
   * clone lacks (X8). So the new worktree's HEAD must be the base commit, else it is reset there;
   * the agent has not started, so nothing is lost. With no clone path to fetch into (a launch
   * picked up after a crash), the worktree fetches, since it shares the clone's refs.
   */
  const baseCheck = (worktreePath: string, request: LaunchRequest, clone: string | null) =>
    Effect.gen(function* () {
      if (clone === null) yield* fetchBase(worktreePath, request.baseRef);
      const ref = request.startFromOrigin ? `origin/${request.baseRef}` : request.baseRef;
      const want = yield* gitOk(worktreePath, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
      const head = yield* gitOk(worktreePath, ["rev-parse", "--verify", "HEAD^{commit}"]);
      if (head !== want) yield* gitOk(worktreePath, ["reset", "--hard", "-q", ref]);
    });

  const fetchBase = (dir: string, baseRef: string) =>
    gitOk(dir, ["fetch", "--no-tags", "origin", "--end-of-options", baseRef], { fetch: true, timeoutMs: 120_000 });

  const createAgent = (workspaceId: string, request: LaunchRequest) =>
    Effect.gen(function* () {
      const effort = request.model.options?.find((option) => option.id === "effort")?.value;
      const argv = [
        "agents", "create", "--local", "--workspace", workspaceId, "--agent", config.agent,
        ...(request.model.model === "" ? [] : ["--model", request.model.model]),
        ...(typeof effort === "string" ? ["--effort", effort] : []),
        "--prompt", request.message,
      ];
      // No retry: a launch that finds its record without a terminal looks for the agent first.
      const answer = yield* call(cli, argv, 120_000);
      return (yield* decodeAnswer(AgentStarted, answer, argv)).sessionId;
    });

  const launched = (record: ThreadRecord) => ({
    threadId: record.threadId,
    worktreePath: record.worktreePath,
    branch: record.branch,
  });

  const launch = Effect.fn("ParadevSessions.launch")(function* (request: LaunchRequest) {
    // 1. A launch already recorded under this command id.
    const known = yield* local(readLaunch(dataDir, request.commandId));
    const workspaceId = known === null ? null : workspaceIdOf(known);
    const earlier = workspaceId === null ? null : yield* local(readThread(dataDir, workspaceId));
    if (earlier !== null && earlier.terminals.length > 0) return launched(earlier);
    if (earlier !== null) {
      // It stopped between the record and the agent's start: the agent may be there already,
      // started after its base check.
      const found = agentTerminalIn(yield* snapshot(earlier.workspaceId), earlier.workspaceId, []);
      if (found !== null) {
        const now = yield* Clock.currentTimeMillis;
        const adopted: ThreadRecord = {
          ...earlier,
          terminals: [found],
          turns: [{ commandId: request.commandId, at: now, kind: "launch" }],
        };
        yield* save(adopted);
        return launched(adopted);
      }
      return launched(yield* startAgent(earlier, request, null));
    }

    // 2. The base into the repo clone.
    const project = (yield* local(listProjects)).find((p) => p.id === request.projectId);
    if (project === undefined) {
      return yield* Effect.fail(new Error(`no Paradev project ${request.projectId} on this Mac`));
    }
    yield* fetchBase(project.path, request.baseRef);

    // 3. The workspace, with no agent: a repeat create with `--agent` starts a second one (X7).
    const argv = [
      "workspaces", "create", "--local", "--project", request.projectId,
      "--name", request.title.slice(0, NAME_MAX),
      "--branch", launchBranch(request.commandId), "--skip-branch-prefix",
      "--base-branch", request.baseRef, "--tag", "factory",
    ];
    const created = yield* decodeAnswer(Created, yield* callWithRetry(cli, argv, 300_000), argv);

    // 4. The thread record, then the launch file that finds it again.
    const id = created.workspace.id;
    const existing = yield* local(readThread(dataDir, id));
    const record: ThreadRecord = existing ?? {
      v: 1,
      threadId: threadIdOf(id),
      location: "local",
      workspaceId: id,
      projectId: request.projectId,
      branch: created.workspace.branch,
      worktreePath: null,
      launchCommandId: request.commandId,
      agent: config.agent,
      terminals: [],
      turns: [],
      archivedAt: null,
    };
    yield* save(record);
    yield* local(writeLaunch(dataDir, request.commandId, record.threadId));
    if (record.terminals.length > 0) return launched(record);

    // 5 to 7.
    return launched(yield* startAgent(record, request, project.path));
  }, (effect) => effect.pipe(Effect.mapError(failWith("launch"))));

  // ---- status -------------------------------------------------------------------------------

  /** The run's status from explain, the newest turn and, for a silent `working`, the process lookup. */
  const runOf = (record: ThreadRecord, explained: Explanation, now: number) =>
    Effect.gen(function* () {
      const newest = record.turns.at(-1)?.at ?? null;
      switch (explained.state) {
        case "starting":
          return { run: "starting" as RunStatus, completedAt: null };
        case "none":
          return {
            run: (newest !== null && now - newest <= STARTING_GRACE_MS ? "starting" : "interrupted") as RunStatus,
            completedAt: null,
          };
        case "working": {
          const silent = explained.lastEventAt === null || now - explained.lastEventAt > SILENT_WORKING_MS;
          if (!silent) return { run: "running" as RunStatus, completedAt: null };
          const pid =
            record.worktreePath === null ? null : yield* processes.find(agentCommand, record.worktreePath);
          return { run: (pid === null ? "interrupted" : "running") as RunStatus, completedAt: null };
        }
        case "blocked":
          return { run: "waiting" as RunStatus, completedAt: null };
        case "idle":
          return {
            run: (explained.lastEventType === "Failed" ? "failed" : "completed") as RunStatus,
            completedAt: explained.lastEventAt,
          };
        case "exited":
          return { run: "interrupted" as RunStatus, completedAt: explained.lastEventAt };
        default:
          return yield* Effect.fail(new Error(`agents explain answered an unknown state: ${explained.state}`));
      }
    });

  const ENDED: ReadonlySet<RunStatus> = new Set(["completed", "failed", "interrupted"]);

  const status = Effect.fn("ParadevSessions.status")(function* (threadId: string) {
    const record = yield* recordOf(threadId, "status");
    const place = { worktreePath: record.worktreePath, branch: record.branch };
    const noRun = { run: null, runOrdinal: null, runStartedAt: null, runCompletedAt: null, lastAssistantMessage: null };
    if (record.archivedAt !== null) return { ...place, archived: true, ...noRun } satisfies ThreadStatus;
    const terminal = record.terminals.at(-1);
    if (terminal === undefined) return { ...place, archived: false, ...noRun } satisfies ThreadStatus;

    const notFound = () => new ThreadNotFoundError({ threadId });
    const explained = yield* explain(record, terminal).pipe(
      Effect.map((answer): Explanation => answer),
      Effect.catchIf(
        (error) => error.kind === "AGENT_EXITED",
        (): Effect.Effect<Explanation> =>
          Effect.succeed({ state: "exited", lastEventType: null, lastEventAt: null }),
      ),
      Effect.catchIf(isNotFound, () => Effect.fail(notFound())),
    );
    const now = yield* Clock.currentTimeMillis;
    const { run, completedAt } = yield* runOf(record, explained, now);
    const message = ENDED.has(run)
      ? yield* readMessage(record, terminal).pipe(Effect.catchIf(isNotFound, () => Effect.fail(notFound())))
      : null;
    return {
      ...place,
      archived: false,
      run,
      runOrdinal: record.turns.length,
      runStartedAt: record.turns.at(-1)?.at ?? null,
      runCompletedAt: completedAt,
      lastAssistantMessage: message,
    } satisfies ThreadStatus;
  }, (effect) =>
    effect.pipe(
      Effect.mapError((error) =>
        error instanceof ThreadNotFoundError || error instanceof SessionsError ? error : failWith("status")(error),
      ),
    ));

  // ---- the other reads ----------------------------------------------------------------------

  const thread = Effect.fn("ParadevSessions.thread")(function* (threadId: string) {
    const record = yield* recordOf(threadId, "thread");
    const recorded = { worktreePath: record.worktreePath, branch: record.branch, archived: true };
    if (record.archivedAt !== null) return recorded;
    return yield* getWorkspace(record.workspaceId).pipe(
      Effect.map((got) => ({ worktreePath: got.worktreePath, branch: got.branch, archived: false })),
      Effect.catchIf(isNotFound, () => Effect.succeed(recorded)),
      Effect.mapError(failWith("thread")),
    );
  });

  const runningThreads = Effect.gen(function* () {
    const answer = yield* snapshot();
    const records = yield* local(listThreads(dataDir));
    let running = 0;
    for (const record of records) {
      const terminal = record.terminals.at(-1);
      if (record.archivedAt !== null || terminal === undefined) continue;
      const state = answer.workspaces
        .find((ws) => ws.id === record.workspaceId)
        ?.terminals.find((t) => t.id === terminal)?.agent?.state;
      if (state === "starting" || state === "working") running += 1;
    }
    return running;
  }).pipe(Effect.mapError(failWith("running-threads")));

  const worktreeCheckout = Effect.fn("ParadevSessions.worktreeCheckout")(function* (path: string) {
    if (!(yield* fs.exists(`${path}/.git`))) return null;
    const head = yield* gitOk(path, ["rev-parse", "--verify", "HEAD^{commit}"]);
    if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(head)) {
      return yield* Effect.fail(new Error(`HEAD is not a commit id: ${head}`));
    }
    const branch = yield* git(path, ["symbolic-ref", "-q", "--short", "HEAD"]);
    if (branch.timedOut || (branch.exitCode !== 0 && branch.exitCode !== 1)) {
      return yield* Effect.fail(new Error(`git symbolic-ref exited ${branch.exitCode}`));
    }
    return { head, branch: branch.exitCode === 0 ? branch.tail.trim() : null };
  }, (effect) => effect.pipe(Effect.mapError(failWith("worktree-head"))));

  const lastActivity = Effect.fn("ParadevSessions.lastActivity")(function* (threadId: string) {
    const workspaceId = workspaceIdOf(threadId);
    const record = workspaceId === null ? null : yield* local(readThread(dataDir, workspaceId));
    const terminal = record?.terminals.at(-1);
    if (record === null || record === undefined || terminal === undefined) return null;
    const explained = yield* explain(record, terminal);
    return explained.state === "none" ? null : explained.lastEventAt;
  }, (effect) => effect.pipe(Effect.mapError(failWith("last-activity"))));

  const worktreesDirectory = Effect.fn("ParadevSessions.worktreesDirectory")(function* (defaultDir: string) {
    const records = yield* local(listThreads(dataDir));
    const newest = records
      .filter((record) => record.worktreePath !== null)
      .sort((a, b) => (b.turns.at(-1)?.at ?? 0) - (a.turns.at(-1)?.at ?? 0))[0];
    return (newest === undefined ? null : worktreesRootOf(newest.worktreePath!, newest.branch)) ?? defaultDir;
  }, (effect) => effect.pipe(Effect.mapError(failWith("worktrees-directory"))));

  const findProject = Effect.fn("ParadevSessions.findProject")(function* (workspaceRoot: string) {
    const project = yield* local(Effect.flatMap(listProjects, (projects) => projectAt(projects, workspaceRoot)));
    if (project === null) return null;
    const options = config.effort === undefined ? undefined : [{ id: "effort", value: config.effort }];
    return {
      id: project.id,
      model: { instanceId: config.agent, model: config.model ?? "", ...(options === undefined ? {} : { options }) },
    };
  }, (effect) => effect.pipe(Effect.mapError(failWith("find-project"))));

  return {
    findProject,
    launch,
    status,
    thread,
    runningThreads,
    worktreeCheckout,
    lastActivity,
    worktreesDirectory,
  } satisfies ParadevSessions;
});
