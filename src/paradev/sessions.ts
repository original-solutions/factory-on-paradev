// @effect-diagnostics nodeBuiltinImport:off - the home dir for Claude's session store, as paths.ts reads it.
/**
 * `FactorySessions` over Paradev's `superset` CLI, for workspaces on this Mac: one workspace per
 * thread, one factory agent per workspace, and the adapter's own records in `state.ts`. This file
 * answers every method of the core's `FactorySessions`.
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type { PlatformError } from "effect/PlatformError";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as NodeOS from "node:os";

import {
  configFlags,
  FETCH_ARGS,
  FETCH_CREDENTIAL_FLAGS,
  FETCH_HTTP_FLAGS,
  FETCH_RETRY_DELAYS_MS,
  fetchCredentialEnv,
  fileTransportFor,
  HARDENED_GIT_CONFIG,
  HARDENED_GIT_ENV,
  listSessionPins,
  normalizeRemoteBase,
  retryFetch,
} from "../gitHardening.ts";
import { FactoryPaths } from "../paths.ts";
import { FactoryProcess, type RunResult, type RunSpawnError } from "../process.ts";
import {
  type FactorySessions,
  type LaunchRequest,
  MessageRejectedError,
  type RunStatus,
  SessionsError,
  ThreadNotFoundError,
  type ThreadStatus,
} from "../sessions.ts";
import { isCommitId } from "../text.ts";
import { isSafeBranchName } from "../tracker/github.ts";
import { launchBranch, worktreesRootOf } from "./branches.ts";
import { call, callWithRetry, decodeAnswer } from "./call.ts";
import { type CliError, SupersetCli } from "./cli.ts";
import { listProjects, type ParadevProject, projectAt } from "./projects.ts";
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
/** A Paradev project's `repo`: a GitHub repository URL. */
const GITHUB_REPO = /^https:\/\/github\.com\/([A-Za-z0-9-]+\/[A-Za-z0-9._-]+?)(?:\.git)?\/?$/;

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
const Archived = Schema.Struct({
  deleted: Schema.Array(Schema.String),
  notFound: Schema.Array(Schema.String),
  failed: Schema.Array(Schema.Unknown),
});
/** A Claude session id: the name of its `.jsonl`, passed on as `--resume-session`. */
const SESSION_ID = /^[A-Za-z0-9-]+$/;

/** A launch or read the adapter cannot carry out, with what it found. */
export class ParadevAdapterError extends Schema.TaggedError<ParadevAdapterError>()(
  "ParadevAdapterError",
  { what: Schema.String },
) {
  override get message(): string {
    return this.what;
  }
}

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
  /**
   * Where a base is fetched from: `<remoteBase>/<owner>/<repo>.git` for the project's GitHub
   * repo. Default `https://github.com`; tests pass `file:///…`.
   */
  readonly remoteBase?: string;
  /** `gh_config_dir`: the `gh` login a base fetch authenticates as, as for the gate. */
  readonly ghConfigDir?: string;
  /** The waits before the base fetch is tried again after a dropped connection. Default the gate's. */
  readonly fetchRetryDelaysMs?: ReadonlyArray<number>;
  /**
   * The waits before the snapshot is read again while it shows a terminal with no agent yet: an
   * agent shows none until its first hook. Default 5, 10 and 15 seconds.
   */
  readonly agentPollDelaysMs?: ReadonlyArray<number>;
  /** How often `send` reads explain for the agent's reaction. Default 2 s. */
  readonly sendPollMs?: number;
  /** How long `send` waits for a reaction: after the text, then after Enter. Default 20 s, 10 s. */
  readonly sendWaitsMs?: readonly [number, number];
  /** Claude's own session store, where resume finds the session id. Default `~/.claude/projects`. */
  readonly claudeProjectsDir?: string;
}

const AGENT_POLL_DELAYS_MS: ReadonlyArray<number> = [5_000, 10_000, 15_000];
/** `send` reads explain this often for the agent's reaction... */
const SEND_POLL_MS = 2_000;
/** ...for this long after the text, then this long after Enter. */
const SEND_WAITS_MS: readonly [number, number] = [20_000, 10_000];

export type ParadevSessions = FactorySessions["Service"];

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
  const remoteBase = normalizeRemoteBase(config.remoteBase);
  const fetchRetryDelaysMs = config.fetchRetryDelaysMs ?? FETCH_RETRY_DELAYS_MS;
  const agentPollDelaysMs = config.agentPollDelaysMs ?? AGENT_POLL_DELAYS_MS;
  const sendPollMs = config.sendPollMs ?? SEND_POLL_MS;
  const sendWaitsMs = config.sendWaitsMs ?? SEND_WAITS_MS;
  const claudeProjectsDir = config.claudeProjectsDir ?? `${NodeOS.homedir()}/.claude/projects`;
  /** The process a record's preset runs: the configured command for the configured preset. */
  const commandOf = (record: ThreadRecord) =>
    record.agent === config.agent ? (config.agentCommand ?? config.agent) : record.agent;

  /** The adapter's file and CLI helpers need these; the service's methods require nothing. */
  const local = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | SupersetCli>) =>
    Effect.provideContext(effect, services);

  // ---- git ----------------------------------------------------------------------------------

  type GitOptions = {
    readonly fetch?: boolean;
    readonly timeoutMs?: number;
    readonly pre?: ReadonlyArray<string>;
    readonly env?: Readonly<Record<string, string>>;
    readonly tailBytes?: number;
  };

  /**
   * One git call, hardened as the gate's are: a session can write the clone's config and hooks.
   * The invariant: no git call the adapter runs in the clone or a worktree that can run a filter,
   * a hook or a transport (the clone-side fetch, status, reset, and the rest of `baseCheck`)
   * executes a command that repo's config names. Each exec-capable key is pinned one way:
   * - hooks directory, fsmonitor, `ext` transport, alternate refs: HARDENED_GIT_CONFIG;
   * - auto gc and maintenance (`gc.recentObjectsHook`): `--no-auto-maintenance` on the clone-side
   *   fetch, the one command that starts it;
   * - lazy fetch from a promisor remote: `GIT_NO_LAZY_FETCH` in HARDENED_GIT_ENV;
   * - `remote.<name>.uploadpack`: the clone-side fetch passes `--upload-pack` on the command line;
   * - `protocol.<name>.allow` (with `insteadOf` and `core.sshCommand`): `GIT_ALLOW_PROTOCOL`,
   *   which overrides every `protocol.*.allow`, so no `-c protocol` flag is needed;
   * - filter drivers and config hooks (`hook.<name>.*`): `sessionRepo` turns off each one listed
   *   (`listSessionPins` in `gitHardening.ts`), and refuses the launch when the listing is not complete.
   * So `git` is for the adapter's own scratch repository and the listing itself; every call in the clone or a
   * worktree that can run a filter, hook or transport goes through `sessionRepo`. The exceptions are three
   * reads in a worktree: `worktreeCheckout`'s `rev-parse` and `symbolic-ref`, and `removeWorktree`'s
   * `rev-parse --git-common-dir`. They run no filter, hook or transport, and `GIT_NO_LAZY_FETCH` is set in every
   * call, so they use plain `git` and a session cannot stall them by writing an odd name.
   * The pins come from one listing; a session that writes the shared config between the listing
   * and a later call can still get a filter or config hook run. That is the accepted P1 residual
   * risk, and the git processes involved carry no GitHub credential. Only the by-URL fetch gets
   * credentials, through `gh`, and only into a repository whose config is the adapter's own.
   */
  const git = (dir: string, args: ReadonlyArray<string>, options: GitOptions = {}) =>
    runner.run({
      command: "git",
      args: [
        ...configFlags(HARDENED_GIT_CONFIG),
        ...(options.fetch === true ? FETCH_CREDENTIAL_FLAGS : []),
        ...(options.pre ?? []),
        "-C",
        dir,
        ...args,
      ],
      env: {
        ...HARDENED_GIT_ENV,
        ...(options.fetch === true ? fetchCredentialEnv(config.ghConfigDir) : {}),
        ...options.env,
      },
      separateStderr: true,
      ...(options.tailBytes === undefined ? {} : { tailBytes: options.tailBytes }),
      timeoutMs: options.timeoutMs ?? 30_000,
    });

  /** `git` that must exit 0: its stdout, trimmed. */
  const gitOk = (dir: string, args: ReadonlyArray<string>, options?: GitOptions) =>
    git(dir, args, options).pipe(
      Effect.flatMap((result) =>
        result.exitCode === 0 && !result.timedOut
          ? Effect.succeed(result.tail.trim())
          : Effect.fail(
              new ParadevAdapterError({
                what: `git ${args.join(" ")} ${result.timedOut ? "timed out" : `exited ${result.exitCode}`}: ${result.stderrTail.trim()}`,
              }),
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

  /**
   * What the snapshot shows in the workspace beyond the terminals in `skip`: a terminal running
   * an agent of `preset`, which a launch takes as its own; `unclear` for any other terminal (a
   * starting agent shows no agent until its first hook, and a person may open a shell), with
   * those terminals' ids, beside which a launch neither takes nor starts an agent; else nothing.
   */
  const agentIn = (
    answer: SnapshotAnswer,
    workspaceId: string,
    preset: string,
    skip: ReadonlyArray<string>,
  ): { readonly terminal: string } | { readonly unclear: ReadonlyArray<string> } | null => {
    const terminals = answer.workspaces.find((ws) => ws.id === workspaceId)?.terminals ?? [];
    const others = terminals.filter((t) => !skip.includes(t.id));
    const agent = others.find((t) => t.agent?.id === preset);
    if (agent !== undefined) return { terminal: agent.id };
    return others.length > 0 ? { unclear: others.map((t) => t.id) } : null;
  };

  /**
   * {@link agentIn} on a fresh snapshot, read again after each of `agentPollDelaysMs` while it is
   * `unclear`: a starting agent gets its first hook within seconds.
   */
  const findAgent = (workspaceId: string, preset: string, skip: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      for (let polled = 0; ; polled += 1) {
        const found = agentIn(yield* snapshot(workspaceId), workspaceId, preset, skip);
        const wait = agentPollDelaysMs[polled];
        if (found === null || "terminal" in found || wait === undefined) return found;
        yield* Effect.sleep(wait);
      }
    });

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

  // ---- launch -----------------------------------------------------------------------------

  const fail = (what: string) => Effect.fail(new ParadevAdapterError({ what }));

  /** The Paradev project of `projectId` on this Mac. */
  const projectOf = (projectId: string) =>
    Effect.gen(function* () {
      const project = (yield* local(listProjects)).find((p) => p.id === projectId);
      return project ?? (yield* fail(`no Paradev project ${projectId} on this Mac`));
    });

  /**
   * Fetches the base into the project's clone as `origin/<baseRef>`, and answers its commit. The
   * credentialed fetch goes by URL, from the project's GitHub repo, into a bare repository of the
   * adapter's own with no config, as the gate's does; the clone then fetches from that one with
   * no credentials. The clone's own `origin`, transport and filter settings, which a session can
   * write, never meet a token, and the commit answered is read where no session can move it.
   */
  const fetchBase = (project: ParadevProject, baseRef: string) =>
    Effect.gen(function* () {
      if (!isSafeBranchName(baseRef)) return yield* fail(`the base ${baseRef} is not a plain branch name`);
      if (!/^[A-Za-z0-9_-]+$/.test(project.id)) return yield* fail(`Paradev project id ${project.id} is not plain`);
      const repo = GITHUB_REPO.exec(project.repo)?.[1];
      if (repo === undefined) {
        return yield* fail(`Paradev project ${project.id} names no GitHub repository: ${project.repo}`);
      }
      const scratch = `${dataDir}/paradev/fetch/${project.id}.git`;
      if (!(yield* fs.exists(`${scratch}/HEAD`))) {
        yield* fs.makeDirectory(scratch, { recursive: true });
        yield* gitOk(scratch, ["init", "--quiet", "--bare", "--template="]);
      }
      const fetchArgs = ["fetch", "--quiet", ...FETCH_ARGS];
      // A dropped connection is tried again, as the gate's fetch is: a failed launch sends the run
      // to stuck, and no later pass launches it again.
      const byUrl = [...fetchArgs, `${remoteBase}/${repo}.git`, `+refs/heads/${baseRef}:refs/heads/${baseRef}`];
      const fetchOnce = git(scratch, byUrl, {
        fetch: true,
        timeoutMs: 120_000,
        pre: FETCH_HTTP_FLAGS,
        env: { GIT_ALLOW_PROTOCOL: fileTransportFor(remoteBase) === "always" ? "https:file" : "https" },
      }).pipe(
        Effect.flatMap((result) => (result.exitCode === 0 && !result.timedOut ? Effect.void : Effect.fail(result))),
      );
      const isResult = (error: RunResult | RunSpawnError): error is RunResult => "stderrTail" in error;
      yield* retryFetch(fetchOnce, {
        delaysMs: fetchRetryDelaysMs,
        stderrOf: (error) => (isResult(error) && !error.timedOut ? error.stderrTail : undefined),
        name: () => `\`git ${byUrl.join(" ")}\``,
      }).pipe(
        Effect.catchIf(isResult, (result) =>
          fail(
            `git ${byUrl.join(" ")} ${result.timedOut ? "timed out" : `exited ${result.exitCode}`}: ${result.stderrTail.trim()}`,
          ),
        ),
      );
      const clone = yield* sessionRepo(project.path);
      yield* clone.gitOk(
        [
          ...fetchArgs,
          "--no-auto-maintenance",
          "--upload-pack=git-upload-pack",
          scratch,
          `+refs/heads/${baseRef}:refs/remotes/origin/${baseRef}`,
        ],
        { timeoutMs: 120_000 },
      );
      return yield* gitOk(scratch, ["rev-parse", "--verify", "--end-of-options", `refs/heads/${baseRef}^{commit}`]);
    });

  /**
   * `git` and `gitOk` for a repository a session can write (the clone, or a worktree of it), with
   * every filter driver and config hook its config names turned off ({@link listSessionPins}), and
   * only `file` transport. The names come from one listing, taken here: they are what the calls of
   * this operation run with. A listing that is not complete, or a name that cannot be turned off,
   * fails the call rather than run git where it would run.
   */
  const sessionRepo = (dir: string) =>
    Effect.gen(function* () {
      const pinned = yield* listSessionPins((args, tailBytes) => git(dir, args, { tailBytes }));
      if ("refused" in pinned) return yield* fail(`${pinned.refused}; nothing was run in it`);
      const options = (given: GitOptions = {}): GitOptions => ({
        ...given,
        env: { GIT_ALLOW_PROTOCOL: "file", ...given.env, ...pinned.env },
      });
      return {
        git: (args: ReadonlyArray<string>, given?: GitOptions) => git(dir, args, options(given)),
        gitOk: (args: ReadonlyArray<string>, given?: GitOptions) => gitOk(dir, args, options(given)),
      };
    });

  /**
   * Paradev does not fetch the base, and builds a worktree from the clone's own refs: a local
   * branch the runner never moves, or the project's default branch for one the clone lacks (X8).
   * So the new worktree's HEAD must be `base`, the commit just fetched, else it is reset there.
   * A worktree holding work (an edit, or a commit no other branch has, its own remote-tracking
   * branch included) is never reset: that is an earlier attempt's agent, and the answer is `kept`.
   * The check only reads; `behind` carries the reset, which the caller runs once it knows no
   * agent works there. Filter drivers and hooks a session put in the shared config are turned off
   * for every call.
   */
  const baseCheck = (worktreePath: string, base: string) =>
    Effect.gen(function* () {
      const repo = yield* sessionRepo(worktreePath);
      const head = yield* repo.gitOk(["rev-parse", "--verify", "HEAD^{commit}"]);
      if (head === base) return { state: "at-base" } as const;
      // No status inside a submodule: its own config and filters are not blanked here. `dirty`
      // still shows a changed submodule commit, which is work.
      const changed = yield* repo.gitOk(
        ["status", "--porcelain", "--untracked-files=normal", "--ignore-submodules=dirty"],
        { pre: ["--no-optional-locks"] },
      );
      // A commit only the checked-out branch has is work, pushed or not; one another branch has
      // is not. Each `--exclude` applies to the `--branches` or `--remotes` after it, and takes
      // the name without `refs/heads/` or `refs/remotes/`.
      const onBranch = yield* repo.git(["symbolic-ref", "-q", "HEAD"]);
      const branch = onBranch.exitCode === 0 ? onBranch.tail.trim().replace(/^refs\/heads\//, "") : null;
      const ownCommit = yield* repo.gitOk([
        "rev-list", "--max-count=1", "HEAD", "--not",
        ...(branch === null ? [] : [`--exclude=${branch}`]), "--branches",
        ...(branch === null ? [] : [`--exclude=*/${branch}`]), "--remotes",
      ]);
      if (changed !== "" || ownCommit !== "") return { state: "kept" } as const;
      const reset = repo.gitOk(["reset", "--hard", "--no-recurse-submodules", "-q", base], {
        pre: ["-c", "submodule.recurse=false"],
      });
      return { state: "behind", reset } as const;
    });

  const createAgent = (record: ThreadRecord, request: LaunchRequest) =>
    Effect.gen(function* () {
      const effort = request.model.options?.find((option) => option.id === "effort")?.value;
      const argv = [
        "agents", "create", "--local", "--workspace", record.workspaceId, "--agent", record.agent,
        ...(request.model.model === "" ? [] : ["--model", request.model.model]),
        ...(typeof effort === "string" ? ["--effort", effort] : []),
        "--prompt", request.message,
      ];
      // No retry: a second create could start a second agent. `startAgent` looks for the agent
      // when this fails.
      const answer = yield* call(cli, argv, 120_000);
      return (yield* decodeAnswer(AgentStarted, answer, argv)).sessionId;
    });

  /** The record with `terminal` as its agent and a `launch` turn. */
  const withAgent = (record: ThreadRecord, terminal: string, request: LaunchRequest) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const started: ThreadRecord = {
        ...record,
        terminals: [...record.terminals, terminal],
        turns: [...record.turns, { commandId: request.commandId, at: now, kind: "launch" }],
      };
      yield* save(started);
      return started;
    });

  /**
   * Steps 5 to 7 of a launch: the worktree, the base check, then the agent. An agent of the
   * preset already in the workspace is the one an earlier attempt started, so it is taken; only
   * with no terminal there is an agent started, and only on a worktree at the base.
   */
  const startAgent = (record: ThreadRecord, request: LaunchRequest, base: string, snapshotDone: boolean) =>
    Effect.gen(function* () {
      const got = yield* getWorkspace(record.workspaceId);
      if (got.worktreePath === null) return yield* fail(`workspace ${record.workspaceId} has no worktree`);
      const placed: ThreadRecord = { ...record, worktreePath: got.worktreePath };
      yield* save(placed);
      const checked = yield* baseCheck(got.worktreePath, base);
      // The reset waits for the snapshot: an agent an earlier attempt started works there.
      if (!snapshotDone) {
        const found = yield* findAgent(record.workspaceId, placed.agent, placed.terminals);
        if (found !== null && "unclear" in found) return yield* noAgentYet(placed);
        if (found !== null) return yield* withAgent(placed, found.terminal, request);
      }
      if (checked.state === "kept") {
        return yield* fail(
          `the worktree ${got.worktreePath} holds work off the base and no agent runs there; it was left as it is`,
        );
      }
      if (checked.state === "behind") yield* checked.reset;
      // A create that timed out or failed may still have started the agent: a failed launch goes
      // to stuck, so it looks for it now and takes it. A terminal that still shows no agent is
      // named in the error, since it may be that agent; a failed look keeps the create's error.
      const started = yield* createAgent(placed, request).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            const found = yield* findAgent(record.workspaceId, placed.agent, placed.terminals).pipe(
              Effect.catch((looked) =>
                fail(`agents create failed (${error.message}), and looking for its agent failed too (${looked.message})`),
              ),
            );
            if (found === null) return yield* Effect.fail(error);
            if ("terminal" in found) return found.terminal;
            return yield* fail(
              `agents create failed (${error.message}), and workspace ${record.workspaceId} has terminal ` +
                `${found.unclear.join(", ")} with no ${placed.agent} agent after ${agentPollDelaysMs.length + 1} looks: ` +
                "it may be the agent that create started, still running, and it is not recorded",
            );
          }),
        ),
      );
      return yield* withAgent(placed, started, request);
    });

  const noAgentYet = (record: ThreadRecord) =>
    fail(`workspace ${record.workspaceId} has a terminal with no ${record.agent} agent in it, after ${agentPollDelaysMs.length + 1} looks`);

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
      // It stopped between the record and the agent's start: the agent may be there already.
      const found = yield* findAgent(earlier.workspaceId, earlier.agent, []);
      if (found !== null && "unclear" in found) return yield* noAgentYet(earlier);
      if (found !== null) return launched(yield* withAgent(earlier, found.terminal, request));
      const base = yield* fetchBase(yield* projectOf(earlier.projectId), request.baseRef);
      return launched(yield* startAgent(earlier, request, base, true));
    }

    // 2. The base into the repo clone.
    const project = yield* projectOf(request.projectId);
    const base = yield* fetchBase(project, request.baseRef);

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
    return launched(yield* startAgent(record, request, base, false));
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
            record.worktreePath === null ? null : yield* processes.find(commandOf(record), record.worktreePath);
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
          return yield* fail(`agents explain answered an unknown state: ${explained.state}`);
      }
    });

  const ENDED: ReadonlySet<RunStatus> = new Set(["completed", "failed", "interrupted"]);

  /**
   * Explain on `terminal` and the run it reads as. An exited agent reads `exited`; a workspace
   * Paradev no longer has is `ThreadNotFoundError`.
   */
  const explainRun = (record: ThreadRecord, terminal: string) =>
    Effect.gen(function* () {
      const explained = yield* explain(record, terminal).pipe(
        Effect.catchIf(
          (error) => error.kind === "AGENT_EXITED",
          (): Effect.Effect<Explanation> => Effect.succeed({ state: "exited", lastEventType: null, lastEventAt: null }),
        ),
        Effect.catchIf(isNotFound, () => Effect.fail(new ThreadNotFoundError({ threadId: record.threadId }))),
      );
      const { run, completedAt } = yield* runOf(record, explained, yield* Clock.currentTimeMillis);
      return { explained, run, completedAt };
    });

  const status = Effect.fn("ParadevSessions.status")(function* (threadId: string) {
    const record = yield* recordOf(threadId, "status");
    const place = { worktreePath: record.worktreePath, branch: record.branch };
    const noRun = { run: null, runOrdinal: null, runStartedAt: null, runCompletedAt: null, lastAssistantMessage: null };
    if (record.archivedAt !== null) return { ...place, archived: true, ...noRun } satisfies ThreadStatus;
    const terminal = record.terminals.at(-1);
    if (terminal === undefined) return { ...place, archived: false, ...noRun } satisfies ThreadStatus;

    const notFound = () => new ThreadNotFoundError({ threadId });
    const { run, completedAt } = yield* explainRun(record, terminal);
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
    if (!isCommitId(head)) {
      return yield* fail(`HEAD is not a commit id: ${head}`);
    }
    const branch = yield* git(path, ["symbolic-ref", "-q", "--short", "HEAD"]);
    if (branch.timedOut || (branch.exitCode !== 0 && branch.exitCode !== 1)) {
      return yield* fail(`git symbolic-ref exited ${branch.exitCode}`);
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

  // ---- send, resume ---------------------------------------------------------------------------

  /** The record with `terminal` (when given) as its current agent, a turn for `commandId`, no resume pending. */
  const withTurn = (record: ThreadRecord, commandId: string, kind: "send" | "resume", terminal?: string) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const next: ThreadRecord = {
        ...record,
        terminals: terminal === undefined ? record.terminals : [...record.terminals, terminal],
        turns: [...record.turns, { commandId, at: now, kind }],
        pendingResume: null,
      };
      yield* save(next);
      return next;
    });

  /**
   * The id of the newest session Claude keeps for `worktreePath`: the newest `*.jsonl` under its
   * projects folder, named for the path with `/` and `.` as `-`. Null when there is none.
   */
  const newestSession = (worktreePath: string) =>
    Effect.gen(function* () {
      const folder = `${claudeProjectsDir}/${worktreePath.replace(/[/.]/g, "-")}`;
      const names = yield* fs.readDirectory(folder).pipe(
        Effect.catchIf((error) => error.reason._tag === "NotFound", () => Effect.succeed([] as ReadonlyArray<string>)),
      );
      let newest: { readonly id: string; readonly at: number } | null = null;
      for (const name of names) {
        const id = name.endsWith(".jsonl") ? name.slice(0, -".jsonl".length) : "";
        if (!SESSION_ID.test(id)) continue;
        const info = yield* fs.stat(`${folder}/${name}`);
        const at = Option.getOrUndefined(info.mtime)?.getTime() ?? 0;
        if (info.type === "File" && (newest === null || at > newest.at)) newest = { id, at };
      }
      return newest?.id ?? null;
    });

  /**
   * Starts the dead agent's Claude session again in a new terminal, with `text` as its prompt.
   * The dead terminal is closed first when the snapshot still lists it, since its agent reads
   * `working` for ever. The resume is recorded as pending before `agents create`, which is not
   * retried: an agent it started before failing is adopted by the next send.
   */
  const resume = (record: ThreadRecord, listed: boolean, worktreePath: string, commandId: string, text: string) =>
    Effect.gen(function* () {
      if (listed) {
        const dead = record.terminals.at(-1)!;
        yield* call(cli, ["terminals", "close", "--local", "--workspace", record.workspaceId, "--terminal", dead], 30_000);
      }
      const session = yield* newestSession(worktreePath);
      if (session === null) return yield* new ThreadNotFoundError({ threadId: record.threadId });
      const pending: ThreadRecord = { ...record, pendingResume: commandId };
      yield* save(pending);
      const argv = [
        "agents", "create", "--local", "--workspace", record.workspaceId, "--agent", record.agent,
        "--resume-session", session, "--prompt", text,
      ];
      const started = yield* decodeAnswer(AgentStarted, yield* call(cli, argv, 120_000), argv);
      yield* withTurn(pending, commandId, "resume", started.sessionId);
    });

  /** Reads explain every `sendPollMs` for up to `windowMs`: whether its last hook is newer than `before`. */
  const reactedWithin = (record: ThreadRecord, terminal: string, before: number | null, windowMs: number) =>
    Effect.gen(function* () {
      for (let waited = 0; waited < windowMs; waited += sendPollMs) {
        yield* Effect.sleep(sendPollMs);
        const { lastEventAt } = yield* explain(record, terminal);
        if (lastEventAt !== null && (before === null || lastEventAt > before)) return true;
      }
      return false;
    });

  /**
   * Types into the current terminal only when its agent is alive. A killed agent still reads
   * `working`, and its terminal is a shell that would run the text, so the process decides as
   * well as the state. The snapshot is read first: an agent of the preset in a terminal the
   * record lacks is the one a pending resume started, and is adopted under that resume's id;
   * with no resume pending it makes the process lookup ambiguous, so nothing is typed.
   */
  const deliver = (record: ThreadRecord, commandId: string, text: string): Effect.Effect<
    void,
    ThreadNotFoundError | MessageRejectedError | SessionsError | ParadevAdapterError | CliError | AgentLookupError | PlatformError
  > =>
    Effect.gen(function* () {
      const threadId = record.threadId;
      if (record.turns.some((turn) => turn.commandId === commandId)) return;
      const terminal = record.terminals.at(-1);
      if (record.archivedAt !== null || terminal === undefined) return yield* new ThreadNotFoundError({ threadId });
      const worktreePath = record.worktreePath;
      if (worktreePath === null) return yield* fail(`thread ${threadId} has no worktree to look for its agent in`);

      const answer = yield* snapshot(record.workspaceId).pipe(
        Effect.catchIf(isNotFound, () => Effect.fail(new ThreadNotFoundError({ threadId }))),
      );
      const other = agentIn(answer, record.workspaceId, record.agent, record.terminals);
      const pending = record.pendingResume ?? null;
      if (pending !== null && other !== null) {
        if ("terminal" in other) {
          return yield* deliver(yield* withTurn(record, pending, "resume", other.terminal), commandId, text);
        }
        // A terminal with no agent of the preset: one starting has a process; with none, the
        // resume started nothing, and it is no longer pending.
        if ((yield* processes.find(commandOf(record), worktreePath)) !== null) {
          return yield* fail(
            `a resume of ${pending} is pending and terminal ${other.unclear.join(", ")} shows no ${record.agent} agent yet; nothing was started`,
          );
        }
        record = { ...record, pendingResume: null };
        yield* save(record);
      }
      if (other !== null && "terminal" in other) {
        return yield* fail(
          `terminal ${other.terminal} runs a ${record.agent} agent the thread did not start, so whether its own agent is alive cannot be told; nothing was typed`,
        );
      }
      const listed = answer.workspaces
        .find((ws) => ws.id === record.workspaceId)
        ?.terminals.some((t) => t.id === terminal) === true;
      if (!listed) return yield* resume(record, false, worktreePath, commandId, text);

      const { explained, run } = yield* explainRun(record, terminal);
      const alive = run !== "interrupted" && (yield* processes.find(commandOf(record), worktreePath)) !== null;
      if (!alive) return yield* resume(record, true, worktreePath, commandId, text);

      const terminalArgv = ["terminals", "send", "--local", "--workspace", record.workspaceId, "--terminal", terminal];
      yield* call(cli, [...terminalArgv, "--text", text], 30_000);
      const [first, second] = sendWaitsMs;
      if (!(yield* reactedWithin(record, terminal, explained.lastEventAt, first))) {
        yield* call(cli, [...terminalArgv, "--keys", "enter"], 30_000);
        if (!(yield* reactedWithin(record, terminal, explained.lastEventAt, second))) {
          return yield* new MessageRejectedError({
            threadId,
            commandId,
            cause: `the agent did not react within ${(first + second) / 1000} s, Enter included`,
          });
        }
      }
      yield* withTurn(record, commandId, "send");
    });

  const send = Effect.fn("ParadevSessions.send")(function* (threadId: string, commandId: string, text: string) {
    yield* deliver(yield* recordOf(threadId, "send"), commandId, text);
  }, (effect) =>
    effect.pipe(
      Effect.mapError((error) =>
        error instanceof ThreadNotFoundError || error instanceof MessageRejectedError || error instanceof SessionsError
          ? error
          : failWith("send")(error),
      ),
    ));

  // ---- archive, removeWorktree --------------------------------------------------------------

  const archive = Effect.fn("ParadevSessions.archive")(function* (threadId: string) {
    const workspaceId = workspaceIdOf(threadId);
    const record = workspaceId === null ? null : yield* local(readThread(dataDir, workspaceId));
    // A thread the adapter does not know is gone already.
    if (record === null) return;
    const argv = ["workspaces", "archive", record.workspaceId, "--local"];
    const gone = yield* callWithRetry(cli, argv, 120_000).pipe(
      Effect.flatMap((answer) => decodeAnswer(Archived, answer, argv)),
      Effect.map((answer) => answer.deleted.includes(record.workspaceId) || answer.notFound.includes(record.workspaceId)
        ? null
        : answer),
      Effect.catchIf(isNotFound, () => Effect.succeed(null)),
    );
    if (gone !== null) {
      return yield* fail(`workspaces archive did not archive ${record.workspaceId}: ${JSON.stringify(gone.failed)}`);
    }
    yield* save({ ...record, archivedAt: record.archivedAt ?? (yield* Clock.currentTimeMillis) });
  }, (effect) => effect.pipe(Effect.mapError(failWith("archive"))));

  /** `git worktree remove --force` in the clone the worktree belongs to; its branch stays. */
  const removeWorktree = Effect.fn("ParadevSessions.removeWorktree")(function* (path: string) {
    if (!(yield* fs.exists(path))) return;
    const common = yield* gitOk(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const clone = common.endsWith("/.git") ? common.slice(0, -"/.git".length) : common;
    const repo = yield* sessionRepo(clone);
    yield* repo.gitOk(["worktree", "remove", "--force", path], { timeoutMs: 60_000 });
  }, (effect) => effect.pipe(Effect.mapError(failWith("remove-worktree"))));

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
    send,
    archive,
    removeWorktree,
    runningThreads,
    worktreeCheckout,
    lastActivity,
    worktreesDirectory,
  } satisfies ParadevSessions;
});
