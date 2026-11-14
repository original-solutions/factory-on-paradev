/**
 * `FactorySessions` over Paradev's `superset` CLI: one workspace per thread, one factory agent per
 * workspace, and the adapter's own records in `state.ts`. A thread runs on its record's target,
 * this Mac, a Paradev host or Paradev Cloud, and every call for it carries that target's flag
 * (`ParadevTarget.at`). This file answers every method of the core's `FactorySessions`.
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type { PlatformError } from "effect/PlatformError";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

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
import { type HostConfig, type MachineSize, paradevModel } from "../config.ts";
import { FactoryPaths } from "../paths.ts";
import { FactoryProcess, type RunResult, type RunSpawnError } from "../process.ts";
import {
  type FactoryProject,
  type FactorySessions,
  isPlainId,
  type LaunchRequest,
  MessageRejectedError,
  type NoTargetHasRoom,
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
import { listProjects, listProjectsAt, type ParadevProject, projectAt } from "./projects.ts";
import { shellQuote, type SshError, type SshRunner, sshRunner } from "./ssh.ts";
import {
  listThreads,
  readLaunch,
  readPlacement,
  readThread,
  runnerId,
  type Target,
  type ThreadRecord,
  type ThreadTarget,
  targetOf,
  threadFileExists,
  threadIdOf,
  writeLaunch,
  writePlacement,
  writeThread,
} from "./state.ts";
import { CLOUD_WORKTREE, getCloudWorkspace, makeCloudTarget } from "./targets/cloud.ts";
import { makeHostTarget } from "./targets/host.ts";
import { makeLocalTarget } from "./targets/local.ts";
import {
  fail,
  type GitOptions,
  gitOkOf,
  type GitRepo,
  isNotFound,
  ParadevAdapterError,
  type ParadevTarget,
  SILENT_WORKING_MS,
  STARTING_GRACE_MS,
} from "./targets/target.ts";
import { lastAssistantMessage } from "./transcript.ts";

export { ParadevAdapterError } from "./targets/target.ts";

const MINUTE = 60_000;
/** A tagged cloud workspace with no thread record this old is an orphan: its launch died before the record. */
const ORPHAN_AGE_MS = 10 * MINUTE;
const NAME_MAX = 80;
/** How often a cloud launch reads its workspace while it provisions, and for how long at most. */
const CLOUD_READY_POLL_MS = 5_000;
const CLOUD_READY_MAX_MS = 300_000;
/** A Paradev project's `repo`: a GitHub repository URL. */
const GITHUB_REPO = /^https:\/\/github\.com\/([A-Za-z0-9-]+\/[A-Za-z0-9._-]+?)(?:\.git)?\/?$/;

const Created = Schema.Struct({
  workspace: Schema.Struct({ id: Schema.String, branch: Schema.String }),
  alreadyExists: Schema.Boolean,
});
/** A cloud create answers the workspace itself, still `provisioning`, with the branch Paradev named. */
const CloudCreated = Schema.Struct({ id: Schema.String, branch: Schema.String });
/** A listed workspace's tag: a name, or `{ name }`; the recorded list shows only an empty `tags`. */
const Tag = Schema.Union([Schema.String, Schema.Struct({ name: Schema.String })]);
const CloudRows = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    name: Schema.optional(Schema.NullOr(Schema.String)),
    status: Schema.optional(Schema.NullOr(Schema.String)),
    createdAt: Schema.String,
    tags: Schema.optional(Schema.NullOr(Schema.Array(Tag))),
  }),
);
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
export type Explanation = typeof Explained.Type;
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

/**
 * Where `launch` starts a new thread: placement's answer (#55). A host comes with the repo's clone
 * there, a cloud environment with the machine size to ask for.
 */
export type LaunchTarget =
  | { readonly kind: "local" }
  | { readonly kind: "host"; readonly machineId: string; readonly path: string }
  | { readonly kind: "cloud"; readonly environmentId: string; readonly machineSize: MachineSize };

/** A configured host as the adapter needs it: its name for the record, its ssh destination. */
export type ParadevHost = Pick<HostConfig, "id" | "name" | "ssh">;

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
  /** Claude's own session store, where resume finds the session id. Default `FactoryPaths.claudeProjectsDir`. */
  readonly claudeProjectsDir?: string;
  /** The machine config's `hosts`: every host a thread may run on. Default none. */
  readonly hosts?: ReadonlyArray<ParadevHost>;
  /**
   * Where a launch runs: a retry that finds its launch file never asks. Placement's answer; fails
   * with `NoTargetHasRoom` when nothing has room. `kept` is the this-Mac or host target an earlier
   * send of this command id was placed on, which the answer must check again. Default this Mac.
   */
  readonly place?: (
    request: LaunchRequest,
    kept?: Exclude<LaunchTarget, { readonly kind: "cloud" }>,
  ) => Effect.Effect<LaunchTarget, ParadevAdapterError | NoTargetHasRoom>;
  /**
   * Told the launch's command id when a launch that was placed ends, however it ends: the
   * agent is in the snapshot by then, or the launch failed. Until then the placement counts as
   * a running agent. Default nothing.
   */
  readonly launchEnded?: (commandId: string) => Effect.Effect<void>;
  /** Whether the machine config has a cloud block, so `snapshot --host cloud` is read for the counts. Default false. */
  readonly cloud?: boolean;
  /** How the adapter reaches a host. Default `ssh` through the runner's process service. */
  readonly ssh?: SshRunner;
  /** How often a cloud launch reads its provisioning workspace, and for how long. Default 5 s and 300 s. */
  readonly cloudReadyPollMs?: number;
  readonly cloudReadyMaxMs?: number;
}

const AGENT_POLL_DELAYS_MS: ReadonlyArray<number> = [5_000, 10_000, 15_000];
/** `send` reads explain this often for the agent's reaction... */
const SEND_POLL_MS = 2_000;
/** ...for this long after the text, then this long after Enter. */
const SEND_WAITS_MS: readonly [number, number] = [20_000, 10_000];

/** A failed `terminals send` of these kinds typed nothing: Paradev refused it before the terminal. */
const UNTYPED: ReadonlyArray<CliError["kind"]> = [
  "PARADEV_OFFLINE",
  "PARADEV_SIGNED_OUT",
  "PARADEV_PLAN",
  "NOT_FOUND",
  "AGENT_EXITED",
  "TOO_LARGE",
];

/** The factory's agents starting or working on one target, as `runningByTarget` counts them. */
export interface TargetCount {
  readonly target: ThreadTarget;
  readonly running: number | null;
}

export type ParadevSessions = FactorySessions["Service"] & {
  /** `findProject` for each of `workspaceRoots`, in order, from one `projects list`. */
  readonly findProjects: (
    workspaceRoots: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<FactoryProject | null>, SessionsError>;
  /**
   * The agents running on each target, from one snapshot of it (this Mac, each configured host in
   * order, then cloud when configured): what placement checks against each target's `max_runs`.
   * `running` is null for a target whose snapshot could not be read. Never fails.
   */
  readonly runningByTarget: Effect.Effect<ReadonlyArray<TargetCount>>;
  /** Archives the orphaned cloud workspaces; the runner calls it once per pass while a repo names a cloud environment. */
  readonly sweepOrphans: Effect.Effect<void, SessionsError>;
};

type Operation = SessionsError["operation"];

const failWith =
  (operation: Operation) =>
  (cause: unknown): SessionsError =>
    new SessionsError({ operation, cause });

/** The tag that marks a cloud workspace as made by the runner of this id. */
const runnerTag = (id: string): string => `factory-${id}`;

/** Whether a listed workspace carries `name` as a tag. */
const hasTag = (tags: ReadonlyArray<typeof Tag.Type> | null | undefined, name: string): boolean =>
  (tags ?? []).some((tag) => (typeof tag === "string" ? tag : tag.name) === name);

/**
 * The location flag of every call against `target`: the one place the adapter writes `--local`.
 * Cloud is the host Paradev calls `cloud`. The target modules take their flag from here.
 */
const at = (target: Target | ThreadTarget): ReadonlyArray<string> =>
  target.kind === "local" ? ["--local"] : ["--host", "machineId" in target ? target.machineId : "cloud"];

export const make = Effect.fn("ParadevSessions.make")(function* (config: ParadevSessionsConfig) {
  const cli = yield* SupersetCli;
  const runner = yield* FactoryProcess;
  const processes = yield* AgentProcess;
  const paths = yield* FactoryPaths;
  const dataDir = paths.baseDir;
  const services = yield* Effect.context<FileSystem.FileSystem | Path.Path | SupersetCli>();
  const fs = yield* FileSystem.FileSystem;
  const remoteBase = normalizeRemoteBase(config.remoteBase);
  const fetchRetryDelaysMs = config.fetchRetryDelaysMs ?? FETCH_RETRY_DELAYS_MS;
  const agentPollDelaysMs = config.agentPollDelaysMs ?? AGENT_POLL_DELAYS_MS;
  const sendPollMs = config.sendPollMs ?? SEND_POLL_MS;
  const sendWaitsMs = config.sendWaitsMs ?? SEND_WAITS_MS;
  const claudeProjectsDir = config.claudeProjectsDir ?? paths.claudeProjectsDir;
  const ssh = config.ssh ?? sshRunner(runner);
  const hosts = config.hosts ?? [];
  const place = config.place ?? (() => Effect.succeed<LaunchTarget>({ kind: "local" }));
  const launchEnded = config.launchEnded ?? (() => Effect.void);
  const cloudReadyPollMs = config.cloudReadyPollMs ?? CLOUD_READY_POLL_MS;
  const cloudReadyMaxMs = config.cloudReadyMaxMs ?? CLOUD_READY_MAX_MS;
  /**
   * Each cloud agent's last liveness read for `status`, by thread and terminal: at most one helper
   * terminal per 10 minutes. A send never answers from it.
   */
  const cloudAliveReads = new Map<string, { readonly at: number; readonly alive: boolean | null }>();
  /** Each host terminal whose screen was read for the trust dialog, and whether it showed. */
  const trustReads = new Map<string, boolean>();
  /** The process a record's preset runs: the configured command for the configured preset. */
  const commandOf = (record: ThreadRecord) =>
    record.agent === config.agent ? (config.agentCommand ?? config.agent) : record.agent;

  /** The adapter's file and CLI helpers need these; the service's methods require nothing. */
  const local = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | SupersetCli>) =>
    Effect.provideContext(effect, services);

  /**
   * This runner's tag, `factory-<runner id>`, read once per service: the sweep and a cloud launch
   * that start together share one read, so a fresh data dir cannot mint two ids. A failed read is
   * not kept, so the next use reads again.
   */
  const mine = yield* local(runnerId(dataDir)).pipe(
    Effect.map(runnerTag),
    Effect.cachedWithTTL((exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero)),
  );

  // ---- git ----------------------------------------------------------------------------------

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
    git(dir, args, options).pipe(Effect.flatMap(gitOkOf(args)));

  // ---- CLI calls ----------------------------------------------------------------------------

  const snapshot = (target: Target | ThreadTarget, workspaceId?: string): Effect.Effect<SnapshotAnswer, CliError> => {
    const argv = [
      "snapshot",
      ...targetFor(target).snapshotAt,
      ...(workspaceId === undefined ? [] : ["--workspace", workspaceId]),
    ];
    return callWithRetry(cli, argv, 30_000).pipe(
      Effect.flatMap((answer) => decodeAnswer(Snapshot, answer, argv)),
    );
  };

  /** `--host <id>` or `--host cloud` (or `--local`) and `--workspace`: where a record's terminal calls go. */
  const inWorkspace = (record: ThreadRecord) => [...targetFor(record.target).at, "--workspace", record.workspaceId];

  const explain = (record: ThreadRecord, terminal: string) => {
    const argv = ["agents", "explain", ...inWorkspace(record), "--terminal", terminal];
    return callWithRetry(cli, argv, 30_000).pipe(
      Effect.flatMap((answer) => decodeAnswer(Explained, answer, argv)),
    );
  };

  /** The last assistant message of the terminal's transcript; null when it has none. */
  const readMessage = (record: ThreadRecord, terminal: string) => {
    const argv = ["agents", "read", ...inWorkspace(record), "--terminal", terminal];
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
  const findAgent = (target: Target, workspaceId: string, preset: string, skip: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      for (let polled = 0; ; polled += 1) {
        const found = agentIn(yield* snapshot(target, workspaceId), workspaceId, preset, skip);
        const wait = agentPollDelaysMs[polled];
        if (found === null || "terminal" in found || wait === undefined) return found;
        yield* Effect.sleep(wait);
      }
    });

  // ---- records ------------------------------------------------------------------------------

  /** The record of a thread id; `ThreadNotFoundError` for an id or a record the adapter lacks. */
  const recordOf = (threadId: string, operation: Operation) =>
    Effect.gen(function* () {
      const record = yield* local(recordNamed(threadId)).pipe(Effect.mapError(failWith(operation)));
      if (record === null) return yield* new ThreadNotFoundError({ threadId });
      return record;
    });

  /** The record whose thread id is `threadId`; null for a malformed id, or a record of another target. */
  const recordNamed = (threadId: string) =>
    Effect.gen(function* () {
      const parsed = targetOf(threadId);
      if (parsed === null) return null;
      const record = yield* readThread(dataDir, parsed.workspaceId);
      return record?.threadId === threadId ? record : null;
    });

  /**
   * Each recorded worktree path's target, a local one first: filled from the records on a miss,
   * then kept by `save`. A record's target and path never change once written.
   */
  const targetsByPath = new Map<string, Target>();
  const remember = (record: ThreadRecord) => {
    const path = record.worktreePath;
    if (path === null) return;
    const known = targetsByPath.get(path);
    if (known === undefined || !targetFor(known).onThisMac) targetsByPath.set(path, record.target);
  };
  /** Drops the liveness and trust reads of the record's terminals other than its current one. */
  const forget = (record: ThreadRecord) => {
    const current = record.archivedAt === null ? record.terminals.at(-1) : undefined;
    const reads: ReadonlyArray<readonly [Map<string, unknown>, string]> = [
      [cloudAliveReads, `${record.threadId}/`],
      [trustReads, `${record.workspaceId}/`],
    ];
    for (const [map, prefix] of reads) {
      for (const key of [...map.keys()]) if (key.startsWith(prefix) && key !== `${prefix}${current}`) map.delete(key);
    }
  };
  const save = (record: ThreadRecord) =>
    local(writeThread(dataDir, record)).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          remember(record);
          forget(record);
        }),
      ),
    );

  // ---- launch -----------------------------------------------------------------------------

  /** The configured host of `machineId`; a thread or a placement naming another fails. */
  const hostOf = (machineId: string) => {
    const host = hosts.find((h) => h.id === machineId);
    return host === undefined ? fail(`host ${machineId} is not in the config's hosts`) : Effect.succeed(host);
  };

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
      } satisfies GitRepo;
    });

  const localTarget = makeLocalTarget({ cli, at: at({ kind: "local" }), fs, processes, commandOf, claudeProjectsDir, sessionRepo, git, gitOk });
  const cloudTarget = makeCloudTarget({ cli, at: at({ kind: "cloud" }), commandOf, aliveReads: cloudAliveReads });
  const hostDeps = { cli, at: (machineId: string) => at({ kind: "host", machineId }), ssh, hostOf, commandOf, trustReads };

  /** The module of a target: the one place the adapter tells this Mac, a host and cloud apart. */
  const targetFor = (target: Target | ThreadTarget): ParadevTarget =>
    target.kind === "local" ? localTarget : target.kind === "cloud" ? cloudTarget : makeHostTarget(hostDeps, target.machineId);

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
  const baseCheck = (repo: GitRepo, base: string) =>
    Effect.gen(function* () {
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
        "agents", "create", ...inWorkspace(record), "--agent", record.agent,
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
      const got = yield* targetFor(record.target).readWorkspace(record);
      if (got === null || got.worktreePath === null) {
        return yield* fail(`workspace ${record.workspaceId} has no worktree`);
      }
      const placed: ThreadRecord = { ...record, worktreePath: got.worktreePath };
      yield* save(placed);
      const repo = yield* targetFor(placed.target).worktreeRepo(got.worktreePath);
      const checked = yield* baseCheck(repo, base);
      // The reset waits for the snapshot: an agent an earlier attempt started works there.
      if (!snapshotDone) {
        const found = yield* findAgent(record.target, record.workspaceId, placed.agent, placed.terminals);
        if (found !== null && "unclear" in found) return yield* noAgentYet(placed);
        if (found !== null) return yield* withAgent(placed, found.terminal, request);
      }
      if (checked.state === "kept") {
        return yield* fail(
          `the worktree ${got.worktreePath} holds work off the base and no agent runs there; it was left as it is`,
        );
      }
      if (checked.state === "behind") {
        yield* repo.fetchBase(request.baseRef);
        yield* checked.reset;
      }
      return yield* withAgent(placed, yield* createOrFind(placed, request), request);
    });

  /**
   * `agents create`, or the agent it started when it failed. A create that timed out or failed
   * may still have started the agent: a failed launch goes to stuck, so it looks for it now and
   * takes it. A terminal that still shows no agent is named in the error, since it may be that
   * agent; a failed look keeps the create's error.
   */
  const createOrFind = (record: ThreadRecord, request: LaunchRequest) =>
    createAgent(record, request).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          const found = yield* findAgent(record.target, record.workspaceId, record.agent, record.terminals).pipe(
            Effect.catch((looked) =>
              fail(`agents create failed (${error.message}), and looking for its agent failed too (${looked.message})`),
            ),
          );
          if (found === null) return yield* Effect.fail(error);
          if ("terminal" in found) return found.terminal;
          return yield* fail(
            `agents create failed (${error.message}), and workspace ${record.workspaceId} has terminal ` +
              `${found.unclear.join(", ")} with no ${record.agent} agent after ${agentPollDelaysMs.length + 1} looks: ` +
              "it may be the agent that create started, still running, and it is not recorded",
          );
        }),
      ),
    );

  /** Reads the cloud workspace every `cloudReadyPollMs` until it is `ready`, for `cloudReadyMaxMs` at most. */
  const waitReady = (record: ThreadRecord) =>
    Effect.gen(function* () {
      const started = yield* Clock.currentTimeMillis;
      for (;;) {
        const got = yield* getCloudWorkspace(cli, cloudTarget.at, record.workspaceId);
        if (got.status === "ready") return;
        if (got.status === "deleted") {
          return yield* fail(`cloud workspace ${record.workspaceId} was deleted while it provisioned`);
        }
        if ((yield* Clock.currentTimeMillis) - started >= cloudReadyMaxMs) {
          return yield* fail(
            `cloud workspace ${record.workspaceId} was not ready within ${cloudReadyMaxMs / 1000} s (still ${got.status})`,
          );
        }
        yield* Effect.sleep(cloudReadyPollMs);
      }
    });

  /**
   * Steps 3 to 5 of a cloud launch: ready, then the agent. A retry (`look`) first takes an agent
   * of the preset an earlier attempt started. A cloud worktree gets no base check: Paradev cuts
   * its branch from the repository's branch on GitHub. A launch that fails here is not tried
   * again and leaves the core no thread to archive, so the workspace is archived before the
   * launch fails: an idle box bills. When that archive fails too, the record keeps
   * `pendingArchive` and the orphan sweep archives it; a repeat of the launch starts nothing there.
   */
  const startCloudAgent = (record: ThreadRecord, request: LaunchRequest, look: boolean) =>
    Effect.gen(function* () {
      if (record.archivedAt !== null) {
        return yield* fail(`cloud workspace ${record.workspaceId} was archived before its agent started`);
      }
      if (record.pendingArchive === true) {
        return yield* fail(`cloud workspace ${record.workspaceId} was given up when an earlier launch failed`);
      }
      yield* waitReady(record);
      if (look) {
        const found = yield* findAgent(record.target, record.workspaceId, record.agent, []);
        if (found !== null && "unclear" in found) return yield* noAgentYet(record);
        if (found !== null) return yield* withAgent(record, found.terminal, request);
      }
      return yield* withAgent(record, yield* createOrFind(record, request), request);
    }).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          const now = (yield* local(readThread(dataDir, record.workspaceId))) ?? record;
          if (now.archivedAt !== null || now.terminals.length > 0) return yield* Effect.fail(error);
          const archived = yield* Effect.result(archiveRecord(now));
          if (archived._tag === "Failure") {
            yield* save({ ...now, pendingArchive: true }).pipe(
              Effect.catch((saveError) =>
                Effect.logWarning(
                  `cloud workspace ${now.workspaceId} could not be marked for the orphan sweep (${saveError.message}); archive it by hand`,
                ),
              ),
            );
          }
          return yield* fail(
            `${error.message}; ${
              archived._tag === "Success"
                ? "the workspace was archived"
                : `archiving the workspace failed too (${archived.failure.message})`
            }`,
          );
        }),
      ),
    );

  const noAgentYet = (record: ThreadRecord) =>
    fail(`workspace ${record.workspaceId} has a terminal with no ${record.agent} agent in it, after ${agentPollDelaysMs.length + 1} looks`);

  const launched = (record: ThreadRecord) => ({
    threadId: record.threadId,
    worktreePath: record.worktreePath,
    branch: record.branch,
  });

  /** The host's Paradev project at the repo's clone there, from `projects list --host <id>`. */
  const hostProject = (machineId: string, path: string) =>
    Effect.gen(function* () {
      const trim = (p: string) => p.replace(/\/+$/, "");
      const project = (yield* local(listProjectsAt(targetFor({ kind: "host", machineId }).at))).find(
        (p) => trim(p.path) === trim(path),
      );
      return project ?? (yield* fail(`no Paradev project at ${path} on host ${machineId}`));
    });

  /**
   * Places `request` and runs `launchOn` on the answer, which is kept under the command id. A send
   * cut off after that goes back to its kept target, and placement checks that target again; a
   * kept cloud target is not reused: no launch file was written, so the workspace it made is an
   * orphan the sweep archives. The placement is in flight until `launchOn` ends, however it ends,
   * and `launchEnded` is told then.
   */
  const placement = <A, E, R>(
    request: LaunchRequest,
    launchOn: (placed: LaunchTarget) => Effect.Effect<A, E, R>,
  ) =>
    Effect.gen(function* () {
      const kept = yield* local(readPlacement(dataDir, request.commandId));
      const placed = yield* kept === null || kept.kind === "cloud" ? place(request) : place(request, kept);
      return yield* local(writePlacement(dataDir, request.commandId, placed)).pipe(
        Effect.andThen(launchOn(placed)),
        Effect.ensuring(launchEnded(request.commandId)),
      );
    });

  const launch = Effect.fn("ParadevSessions.launch")(function* (request: LaunchRequest) {
    // 1. A launch already recorded under this command id: it is never placed again.
    const known = yield* local(readLaunch(dataDir, request.commandId));
    const workspaceId = known === null ? null : (targetOf(known)?.workspaceId ?? null);
    const earlier = workspaceId === null ? null : yield* local(readThread(dataDir, workspaceId));
    if (earlier !== null && earlier.terminals.length > 0) return launched(earlier);
    if (earlier !== null) {
      if (earlier.target.kind === "cloud") return launched(yield* startCloudAgent(earlier, request, true));
      // It stopped between the record and the agent's start: the agent may be there already.
      const found = yield* findAgent(earlier.target, earlier.workspaceId, earlier.agent, []);
      if (found !== null && "unclear" in found) return yield* noAgentYet(earlier);
      if (found !== null) return launched(yield* withAgent(earlier, found.terminal, request));
      // A host record's project is the host's; the base is fetched through this Mac's.
      const project = targetFor(earlier.target).onThisMac ? earlier.projectId : request.projectId;
      const base = yield* fetchBase(yield* projectOf(project), request.baseRef);
      return launched(yield* startAgent(earlier, request, base, true));
    }
    // Placed once per command id, and before anything is fetched or created: a send cut off after
    // this point is sent again to the same target.
    return launched(
      yield* placement(request, (placed) =>
        placed.kind === "cloud" ? launchCloud(request, placed) : launchWorktree(request, placed),
      ),
    );
  }, (effect) => effect.pipe(Effect.mapError(failWith("launch"))));

  /** A launch on this Mac or on a host: Paradev makes the worktree from that machine's clone. */
  const launchWorktree = (request: LaunchRequest, placed: Exclude<LaunchTarget, { readonly kind: "cloud" }>) =>
    Effect.gen(function* () {
      const target: Target =
        placed.kind === "host"
          ? { kind: "host", machineId: placed.machineId, name: (yield* hostOf(placed.machineId)).name }
          : placed;
      // 2. The base into this Mac's repo clone: the source of truth for the base commit.
      const base = yield* fetchBase(yield* projectOf(request.projectId), request.baseRef);
      const projectId =
        placed.kind === "host" ? (yield* hostProject(placed.machineId, placed.path)).id : request.projectId;

      // 3. The workspace, with no agent: a repeat create with `--agent` starts a second one (X7).
      const argv = [
        "workspaces", "create", ...targetFor(target).at, "--project", projectId,
        "--name", request.title.slice(0, NAME_MAX),
        "--branch", launchBranch(request.commandId), "--skip-branch-prefix",
        "--base-branch", request.baseRef, "--tag", "factory",
      ];
      const created = yield* decodeAnswer(Created, yield* callWithRetry(cli, argv, 300_000), argv);

      // 4. The thread record, then the launch file that finds it again.
      const id = created.workspace.id;
      const existing = yield* local(readThread(dataDir, id));
      const record: ThreadRecord = existing ?? {
        v: 2,
        threadId: threadIdOf(target, id),
        target,
        workspaceId: id,
        projectId,
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
      if (record.terminals.length > 0) return record;

      // 5 to 7.
      return yield* startAgent(record, request, base, false);
    });

  /**
   * A launch in Paradev Cloud. The create takes no `--branch` (Paradev names the branch
   * `superset/<name slug>-<id8>`) and no `--agent`, and answers a workspace still provisioning.
   * The name is the launch branch, so the branch Paradev picks carries the issue and attempt.
   */
  const launchCloud = (request: LaunchRequest, placed: Extract<LaunchTarget, { readonly kind: "cloud" }>) =>
    Effect.gen(function* () {
      if (!isSafeBranchName(request.baseRef)) return yield* fail(`the base ${request.baseRef} is not a plain branch name`);
      const target: Target = { kind: "cloud", environmentId: placed.environmentId };
      // 1. Not retried: a cloud create is not idempotent by branch, so a repeat makes a second
      // workspace. One that failed after making its workspace is left to the orphan sweep.
      const argv = [
        "workspaces", "create", ...targetFor(target).at, "--environment", placed.environmentId,
        "--machine-size", placed.machineSize, "--name", launchBranch(request.commandId),
        "--base-branch", request.baseRef, "--tag", "factory", "--tag", yield* mine,
      ];
      const created = yield* decodeAnswer(CloudCreated, yield* call(cli, argv, 300_000), argv);
      if (!isPlainId(created.id)) return yield* fail(`cloud workspace id ${created.id} is not plain`);

      // 2. The record and the launch file at once: only the launch file stops a second create.
      const record: ThreadRecord = {
        v: 2,
        threadId: threadIdOf(target, created.id),
        target,
        workspaceId: created.id,
        projectId: placed.environmentId,
        branch: created.branch,
        worktreePath: CLOUD_WORKTREE,
        launchCommandId: request.commandId,
        agent: config.agent,
        terminals: [],
        turns: [],
        archivedAt: null,
      };
      yield* save(record);
      yield* local(writeLaunch(dataDir, request.commandId, record.threadId));

      // 3 to 5.
      return yield* startCloudAgent(record, request, false);
    });

  // ---- status -------------------------------------------------------------------------------

  /**
   * The run's status from explain, the newest turn and, for a silent `working`, the process lookup.
   * `alive` is set when the run needed the process lookup, so a send that asked for a `fresh` one
   * types on that answer and looks no second time.
   */
  const runOf = (
    record: ThreadRecord,
    terminal: string,
    explained: Explanation,
    now: number,
    fresh: boolean,
  ): Effect.Effect<
    { readonly run: RunStatus; readonly completedAt: number | null; readonly alive?: boolean | null },
    SessionsError | ParadevAdapterError | AgentLookupError | SshError | CliError | PlatformError
  > =>
    Effect.gen(function* () {
      const newest = record.turns.at(-1)?.at ?? null;
      switch (explained.state) {
        case "starting": {
          const held = yield* targetFor(record.target).startingHeld(record, terminal, explained, now);
          if (held !== null) {
            return yield* new SessionsError({ operation: "status", cause: new ParadevAdapterError({ what: held }) });
          }
          return { run: "starting" as RunStatus, completedAt: null };
        }
        case "none":
          return {
            run: (newest !== null && now - newest <= STARTING_GRACE_MS ? "starting" : "interrupted") as RunStatus,
            completedAt: null,
          };
        case "working": {
          const silent = explained.lastEventAt === null || now - explained.lastEventAt > SILENT_WORKING_MS;
          if (!silent) return { run: "running" as RunStatus, completedAt: null };
          // A read that failed keeps the run running, as a long tool call would.
          const alive = yield* targetFor(record.target).agentAlive(record, now, fresh);
          return { run: (alive === false ? "interrupted" : "running") as RunStatus, completedAt: null, alive };
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
  const explainRun = (record: ThreadRecord, terminal: string, fresh = false) =>
    Effect.gen(function* () {
      const explained = yield* explain(record, terminal).pipe(
        Effect.catchIf(
          (error) => error.kind === "AGENT_EXITED",
          (): Effect.Effect<Explanation> => Effect.succeed({ state: "exited", lastEventType: null, lastEventAt: null }),
        ),
        Effect.catchIf(isNotFound, () => Effect.fail(new ThreadNotFoundError({ threadId: record.threadId }))),
      );
      const { run, completedAt, alive } = yield* runOf(record, terminal, explained, yield* Clock.currentTimeMillis, fresh);
      return { explained, run, completedAt, alive };
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
    // A cloud workspace has no worktree here, and reads `deleted` once it is archived.
    const read = targetFor(record.target).readWorkspace(record).pipe(
      Effect.map((got) => (got === null ? recorded : { worktreePath: got.worktreePath, branch: got.branch, archived: false })),
    );
    return yield* read.pipe(
      Effect.catchIf(isNotFound, () => Effect.succeed(recorded)),
      Effect.mapError(failWith("thread")),
    );
  });

  /**
   * The factory's agents that are starting or working on `target`: the unarchived records of that
   * target whose newest terminal the snapshot shows in either state. One snapshot, no `--workspace`.
   */
  const runningAt = (target: ThreadTarget, records: ReadonlyArray<ThreadRecord>) =>
    snapshot(target).pipe(
      Effect.map((answer) => {
        let running = 0;
        for (const record of records) {
          const terminal = record.terminals.at(-1);
          const there = record.threadId === threadIdOf(target, record.workspaceId);
          if (!there || record.archivedAt !== null || terminal === undefined) continue;
          const state = answer.workspaces
            .find((ws) => ws.id === record.workspaceId)
            ?.terminals.find((t) => t.id === terminal)?.agent?.state;
          if (state === "starting" || state === "working") running += 1;
        }
        return running;
      }),
    );

  /** The targets whose agents are counted: this Mac, each configured host, and cloud when configured. */
  const countedTargets: ReadonlyArray<ThreadTarget> = [
    { kind: "local" },
    ...hosts.map((host): ThreadTarget => ({ kind: "host", machineId: host.id })),
    ...(config.cloud === true ? [{ kind: "cloud" } as const] : []),
  ];

  /** Every counted target read once, all at the same time; a read that failed is its error. */
  const readTargets = Effect.gen(function* () {
    const records = yield* local(listThreads(dataDir));
    return yield* Effect.forEach(
      countedTargets,
      (target) => Effect.result(runningAt(target, records)).pipe(Effect.map((result) => ({ target, result }))),
      { concurrency: "unbounded" },
    );
  });

  const runningByTarget = readTargets.pipe(
    Effect.map((read) =>
      read.map(({ target, result }) => ({ target, running: Result.isSuccess(result) ? result.success : null })),
    ),
    // The records could not be read: no count can be trusted, so none is given.
    Effect.catch(() => Effect.succeed(countedTargets.map((target) => ({ target, running: null })))),
  );

  const runningThreads = readTargets.pipe(
    Effect.flatMap((read) => {
      let running = 0;
      for (const { target, result } of read) {
        if (Result.isSuccess(result)) running += result.success;
        // This Mac is the one count the pass cannot do without; a host or cloud that cannot be read waits.
        else if (targetFor(target).onThisMac) return Effect.fail(result.failure);
      }
      return Effect.succeed(running);
    }),
    Effect.mapError(failWith("running-threads")),
  );

  /**
   * Where the worktree at `path` is: the target of the thread whose worktree it is, else this Mac.
   * A path a local thread has is this Mac's, whatever else names it. The records are read only for
   * a path not seen yet: one no record names, or one another process recorded.
   */
  const whereIs = (path: string) =>
    Effect.gen(function* () {
      const known = targetsByPath.get(path);
      if (known !== undefined) return known;
      for (const record of yield* local(listThreads(dataDir))) remember(record);
      return targetsByPath.get(path) ?? { kind: "local" as const };
    });

  const worktreeCheckout = Effect.fn("ParadevSessions.worktreeCheckout")(function* (path: string) {
    const repo = yield* targetFor(yield* whereIs(path)).checkoutRepo(path);
    if (repo === null) return null;
    const head = yield* repo.gitOk(["rev-parse", "--verify", "HEAD^{commit}"]);
    if (!isCommitId(head)) {
      return yield* fail(`HEAD is not a commit id: ${head}`);
    }
    const branch = yield* repo.git(["symbolic-ref", "-q", "--short", "HEAD"]);
    if (branch.timedOut || (branch.exitCode !== 0 && branch.exitCode !== 1)) {
      return yield* fail(`git symbolic-ref exited ${branch.exitCode}`);
    }
    return { head, branch: branch.exitCode === 0 ? branch.tail.trim() : null };
  }, (effect) => effect.pipe(Effect.mapError(failWith("worktree-head"))));

  const lastActivity = Effect.fn("ParadevSessions.lastActivity")(function* (threadId: string) {
    const record = yield* local(recordNamed(threadId));
    const terminal = record?.terminals.at(-1);
    if (record === null || terminal === undefined) return null;
    const explained = yield* explain(record, terminal);
    return explained.state === "none" ? null : explained.lastEventAt;
  }, (effect) => effect.pipe(Effect.mapError(failWith("last-activity"))));

  // ---- showGateLog --------------------------------------------------------------------------

  /**
   * One terminal per attempt that follows the gate log. It runs `terminals create` once, with no
   * retry (a second try could make a second terminal), and reads only its exit code. Nothing here
   * may fail the gate that called it: every failure is one warning.
   */
  const showGateLog = (threadId: string, attempt: number, logPath: string) =>
    Effect.gen(function* () {
      const record = yield* local(recordNamed(threadId));
      if (record === null) return yield* fail("the thread has no record");
      // The gate runs on this Mac (U7): a host or cloud workspace cannot read its log file.
      const where = targetFor(record.target);
      if (!where.onThisMac) {
        return yield* Effect.logInfo(
          `the gate log of ${threadId} attempt ${attempt} stays on this Mac, at ${logPath}: a ${where.label} workspace cannot follow it`,
        );
      }
      const shown = record.gateLogAttempts ?? [];
      if (shown.includes(attempt)) return;
      yield* call(
        cli,
        [
          "terminals",
          "create",
          ...inWorkspace(record),
          "--command",
          `tail -n +1 -F ${shellQuote(logPath)}`,
        ],
        30_000,
      ).pipe(
        // Exit 0 with an answer the runner cannot parse still made the terminal.
        Effect.catchIf((error) => error.kind === "PARADEV_SHAPE", () => Effect.void),
      );
      yield* save({ ...record, gateLogAttempts: [...shown, attempt] });
    }).pipe(
      Effect.catch((error) => Effect.fail(error.message)),
      Effect.catchDefect((defect) => Effect.fail(String(defect))),
      Effect.catch((message) =>
        Effect.logWarning(`could not show the gate log of ${threadId} attempt ${attempt}: ${message}`),
      ),
    );

  const worktreesDirectory = Effect.fn("ParadevSessions.worktreesDirectory")(function* (defaultDir: string) {
    const records = yield* local(listThreads(dataDir));
    // A host's or a cloud sandbox's worktree is not on this Mac.
    const newest = records
      .filter((record) => targetFor(record.target).onThisMac && record.worktreePath !== null)
      .sort((a, b) => (b.turns.at(-1)?.at ?? 0) - (a.turns.at(-1)?.at ?? 0))[0];
    return (newest === undefined ? null : worktreesRootOf(newest.worktreePath!, newest.branch)) ?? defaultDir;
  }, (effect) => effect.pipe(Effect.mapError(failWith("worktrees-directory"))));

  // ---- send, resume ---------------------------------------------------------------------------

  /** The record with `terminal` (when given) as its current agent, a turn for `commandId`, nothing pending. */
  const withTurn = (record: ThreadRecord, commandId: string, kind: "send" | "resume", terminal?: string) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const next: ThreadRecord = {
        ...record,
        terminals: terminal === undefined ? record.terminals : [...record.terminals, terminal],
        turns: [...record.turns, { commandId, at: now, kind }],
        pendingResume: null,
        pendingSend: null,
      };
      yield* save(next);
      return next;
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
        yield* call(cli, ["terminals", "close", ...inWorkspace(record), "--terminal", dead], 30_000);
      }
      const session = yield* targetFor(record.target).newestSession(record, worktreePath);
      if (session === null) return yield* new ThreadNotFoundError({ threadId: record.threadId });
      const pending: ThreadRecord = { ...record, pendingResume: commandId };
      yield* save(pending);
      const argv = [
        "agents", "create", ...inWorkspace(record), "--agent", record.agent,
        "--resume-session", session, "--prompt", text,
      ];
      const started = yield* decodeAnswer(AgentStarted, yield* call(cli, argv, 120_000), argv);
      yield* withTurn(pending, commandId, "resume", started.sessionId);
    });

  /** Whether the agent's last hook is newer than `before`, the hook read before the text was typed. */
  const hookedSince = (explained: Explanation, before: number | null) =>
    explained.lastEventAt !== null && (before === null || explained.lastEventAt > before);

  /**
   * Reads explain every `sendPollMs` for up to `windowMs`, at least once: null as soon as the last
   * hook is newer than `before`, else the last explanation read.
   */
  const reactedWithin = (record: ThreadRecord, terminal: string, before: number | null, windowMs: number) =>
    Effect.gen(function* () {
      for (let waited = sendPollMs; ; waited += sendPollMs) {
        yield* Effect.sleep(sendPollMs);
        const explained = yield* explain(record, terminal);
        if (hookedSince(explained, before)) return null;
        if (waited >= windowMs) return explained;
      }
    });

  /**
   * Types into the current terminal only when its agent is alive. A killed agent still reads
   * `working`, and its terminal is a shell that would run the text, so the process decides as
   * well as the state. The snapshot is read first: an agent of the preset in a terminal the
   * record lacks is the one a pending resume started, and is adopted under that resume's id;
   * with no resume pending it makes the process lookup ambiguous, so nothing is typed. Nor is it
   * when the agent is `blocked`: its permission prompt would take the text and Enter as an answer.
   * The send is recorded as pending before its text is typed, so a repeat of its command id types
   * nothing: a hook since the text was typed counts its turn, and none fails for the next repeat.
   */
  const deliver = (record: ThreadRecord, commandId: string, text: string): Effect.Effect<
    void,
    | ThreadNotFoundError
    | MessageRejectedError
    | SessionsError
    | ParadevAdapterError
    | CliError
    | AgentLookupError
    | SshError
    | PlatformError
  > =>
    Effect.gen(function* () {
      const threadId = record.threadId;
      if (record.turns.some((turn) => turn.commandId === commandId)) return;
      // The core gave up on that send and sent another: this one is a fresh send.
      if (record.pendingSend != null && record.pendingSend.commandId !== commandId) {
        record = { ...record, pendingSend: null };
        yield* save(record);
      }
      const terminal = record.terminals.at(-1);
      if (record.archivedAt !== null || terminal === undefined) return yield* new ThreadNotFoundError({ threadId });
      const worktreePath = record.worktreePath;
      if (worktreePath === null) return yield* fail(`thread ${threadId} has no worktree to look for its agent in`);

      const answer = yield* snapshot(record.target, record.workspaceId).pipe(
        Effect.catchIf(isNotFound, () => Effect.fail(new ThreadNotFoundError({ threadId }))),
      );
      const other = agentIn(answer, record.workspaceId, record.agent, record.terminals);
      const pending = record.pendingResume ?? null;
      if (pending !== null && other !== null) {
        if ("terminal" in other) {
          return yield* deliver(yield* withTurn(record, pending, "resume", other.terminal), commandId, text);
        }
        // A terminal with no agent of the preset: one starting has a process. With none, the
        // resume started nothing; with no agent process, the steps below resume again, and that
        // resume writes its own pendingResume. A process that could not be looked for may be there.
        if ((yield* targetFor(record.target).agentAlive(record, yield* Clock.currentTimeMillis, true)) !== false) {
          return yield* fail(
            `a resume of ${pending} is pending and terminal ${other.unclear.join(", ")} shows no ${record.agent} agent yet; nothing was started`,
          );
        }
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

      // A fresh look, never status's cached one: a cloud agent may have died since. A silent
      // `working` run's own lookup is that look.
      const { explained, run, alive: looked } = yield* explainRun(record, terminal, true);
      const alive =
        run === "interrupted"
          ? false
          : looked !== undefined
            ? looked
            : yield* targetFor(record.target).agentAlive(record, yield* Clock.currentTimeMillis, true);
      // Its terminal is a shell once the agent is gone: text typed there would run.
      if (alive === null) {
        return yield* fail(`whether the agent of ${threadId} is alive could not be read; nothing was typed`);
      }
      if (!alive) return yield* resume(record, true, worktreePath, commandId, text);
      // This command id typed its text before, then failed or crashed before counting its turn.
      const typed = record.pendingSend ?? null;
      if (typed !== null) {
        if (!hookedSince(explained, typed.before)) {
          return yield* fail(`${commandId} typed its text before and the agent shows no hook since; nothing was typed`);
        }
        yield* withTurn(record, commandId, "send");
        return;
      }
      // A blocked agent shows a permission prompt: the text and Enter would answer it.
      if (explained.state === "blocked") {
        return yield* new MessageRejectedError({
          threadId,
          commandId,
          cause: "the agent is waiting on a permission prompt; nothing was typed",
        });
      }

      const before = explained.lastEventAt;
      const typing: ThreadRecord = { ...record, pendingSend: { commandId, before } };
      yield* save(typing);
      const terminalArgv = ["terminals", "send", ...inWorkspace(record), "--terminal", terminal];
      yield* call(cli, [...terminalArgv, "--text", text], 30_000).pipe(
        // Paradev answered that it typed nothing: a repeat should type the text, not wait for a hook.
        Effect.tapError((error) =>
          error._tag === "ParadevCliError" && UNTYPED.includes(error.kind) ? save({ ...typing, pendingSend: null }) : Effect.void,
        ),
      );
      const [first, second] = sendWaitsMs;
      if ((yield* reactedWithin(typing, terminal, before, first)) !== null) {
        yield* call(cli, [...terminalArgv, "--keys", "enter"], 30_000);
        const last = yield* reactedWithin(typing, terminal, before, second);
        // Only an idle agent dropped the text; a busy one may still have it queued.
        if (last?.state === "idle") {
          yield* save({ ...typing, pendingSend: null });
          return yield* new MessageRejectedError({
            threadId,
            commandId,
            cause: `the agent did not react within ${(first + second) / 1000} s, Enter included`,
          });
        }
        if (last !== null) {
          return yield* fail(
            `the agent, ${last.state}, did not react within ${(first + second) / 1000} s, Enter included; the text may still be queued`,
          );
        }
      }
      yield* withTurn(typing, commandId, "send");
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

  /** Archives the record's workspace and sets its `archivedAt`. */
  const archiveRecord = (record: ThreadRecord) =>
    Effect.gen(function* () {
      yield* targetFor(record.target).archiveWorkspace(record.workspaceId);
      yield* save({ ...record, archivedAt: record.archivedAt ?? (yield* Clock.currentTimeMillis) });
    });

  const archive = Effect.fn("ParadevSessions.archive")(function* (threadId: string) {
    const record = yield* local(recordNamed(threadId));
    // A thread the adapter does not know is gone already.
    if (record === null) return;
    yield* archiveRecord(record);
  }, (effect) => effect.pipe(Effect.mapError(failWith("archive"))));

  /**
   * Archives, once per pass, every cloud workspace with this runner's tag (`factory-<runner id>`,
   * which only its own creates carry) and no thread record file,
   * whole or torn, created over 10 minutes ago: a launch that died between its create and its
   * record left it, and an idle box bills. A workspace with a record is the core's, whatever state
   * the record is in, unless the core can never reach it: the record has `pendingArchive` (its
   * launch failed and could not archive it), or it has no agent and no launch file names it (the
   * launch died between its record and its launch file, so a repeat of it creates another
   * workspace). A record with an agent is the core's whatever its launch file says. One log line
   * each; a workspace that fails to archive is one warning, and the rest go on.
   */
  const sweepOrphans = Effect.gen(function* () {
    const tag = yield* mine;
    const argv = ["workspaces", "list", ...cloudTarget.at];
    const rows = yield* callWithRetry(cli, argv, 30_000).pipe(
      Effect.flatMap((answer) => decodeAnswer(CloudRows, answer, argv)),
    );
    const now = yield* Clock.currentTimeMillis;
    for (const row of rows) {
      if (row.status === "deleted" || !hasTag(row.tags, tag) || !isPlainId(row.id)) continue;
      if (!(now - Date.parse(row.createdAt) > ORPHAN_AGE_MS)) continue;
      if (yield* local(threadFileExists(dataDir, row.id))) {
        const record = yield* local(readThread(dataDir, row.id));
        if (record === null || record.archivedAt !== null) continue;
        const why =
          record.pendingArchive === true
            ? "its launch failed, and so did that launch's archive"
            : record.terminals.length === 0 &&
                (yield* local(readLaunch(dataDir, record.launchCommandId))) !== record.threadId
              ? "no agent, and no launch file names its record"
              : null;
        if (why === null) continue;
        yield* archiveRecord(record).pipe(
          Effect.andThen(Effect.logInfo(`archived cloud workspace ${row.id} (${row.name ?? "no name"}): ${why}`)),
          Effect.catch((error) =>
            Effect.logWarning(`could not archive the cloud workspace ${row.id} of a failed launch: ${error.message}`),
          ),
        );
        continue;
      }
      yield* cloudTarget.archiveWorkspace(row.id).pipe(
        Effect.andThen(
          Effect.logInfo(
            `archived cloud workspace ${row.id} (${row.name ?? "no name"}): tagged ${tag}, created ${row.createdAt}, and no thread record`,
          ),
        ),
        Effect.catch((error) =>
          Effect.logWarning(`could not archive the orphaned cloud workspace ${row.id}: ${error.message}`),
        ),
      );
    }
  }).pipe(Effect.mapError(failWith("archive")));

  /** `git worktree remove --force` in the clone the worktree belongs to; its branch stays. */
  const removeWorktree = Effect.fn("ParadevSessions.removeWorktree")(function* (path: string) {
    // A host's or a cloud sandbox's worktree is not on this Mac: Paradev removed it at archive.
    if (!targetFor(yield* whereIs(path)).onThisMac) return;
    if (!(yield* fs.exists(path))) return;
    const common = yield* gitOk(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const clone = common.endsWith("/.git") ? common.slice(0, -"/.git".length) : common;
    const repo = yield* sessionRepo(clone);
    yield* repo.gitOk(["worktree", "remove", "--force", path], { timeoutMs: 60_000 });
  }, (effect) => effect.pipe(Effect.mapError(failWith("remove-worktree"))));

  const findProjects = Effect.fn("ParadevSessions.findProjects")(function* (
    workspaceRoots: ReadonlyArray<string>,
  ) {
    return yield* local(
      Effect.gen(function* () {
        const projects = yield* listProjects;
        const found: Array<FactoryProject | null> = [];
        for (const root of workspaceRoots) {
          const project = yield* projectAt(projects, root);
          found.push(
            project === null
              ? null
              : { id: project.id, model: paradevModel(config), repo: GITHUB_REPO.exec(project.repo)?.[1] ?? null },
          );
        }
        return found;
      }),
    );
  }, (effect) => effect.pipe(Effect.mapError(failWith("find-project"))));

  const findProject = (workspaceRoot: string) =>
    findProjects([workspaceRoot]).pipe(Effect.map((found) => found[0] ?? null));

  return {
    findProject,
    findProjects,
    launch,
    status,
    thread,
    send,
    archive,
    removeWorktree,
    runningThreads,
    runningByTarget,
    worktreeCheckout,
    lastActivity,
    showGateLog,
    worktreesDirectory,
    sweepOrphans,
  } satisfies ParadevSessions;
});
