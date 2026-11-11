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

import {
  configFlags,
  FETCH_ARGS,
  FETCH_CREDENTIAL_FLAGS,
  FETCH_HTTP_FLAGS,
  fetchCredentialEnv,
  fileTransportFor,
  HARDENED_GIT_CONFIG,
  HARDENED_GIT_ENV,
  normalizeRemoteBase,
} from "../gitHardening.ts";
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
  const remoteBase = normalizeRemoteBase(config.remoteBase);
  /** The process a record's preset runs: the configured command for the configured preset. */
  const commandOf = (record: ThreadRecord) =>
    record.agent === config.agent ? (config.agentCommand ?? config.agent) : record.agent;

  /** The adapter's file and CLI helpers need these; the service's methods require nothing. */
  const local = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | SupersetCli>) =>
    Effect.provideContext(effect, services);

  // ---- git ----------------------------------------------------------------------------------

  /**
   * One git call, hardened as the gate's are: a session can write the clone's config and hooks.
   * The invariant: no git call the adapter runs in the clone or a worktree executes a command
   * that repo's config names. Each exec-capable key is pinned one way:
   * - hooks directory, fsmonitor, `ext` transport, alternate refs, auto gc and maintenance:
   *   HARDENED_GIT_CONFIG;
   * - lazy fetch from a promisor remote: `GIT_NO_LAZY_FETCH` in HARDENED_GIT_ENV;
   * - `remote.<name>.uploadpack`: the clone-side fetch passes `--upload-pack` on the command line;
   * - `protocol.<name>.allow` (with `insteadOf` and `core.sshCommand`): `GIT_ALLOW_PROTOCOL`,
   *   which overrides every `protocol.*.allow`, so no `-c protocol` flag is needed;
   * - filter drivers and config hooks (`hook.<name>.*`): `sessionRepo` blanks each one listed, and
   *   refuses the launch when the listing is not complete.
   * So `git` is for the adapter's own scratch repository and the listing itself; every call in the
   * clone or a worktree goes through `sessionRepo`. Only the by-URL fetch gets credentials,
   * through `gh`, and only into a repository whose config is the adapter's own.
   */
  const git = (
    dir: string,
    args: ReadonlyArray<string>,
    options: {
      readonly fetch?: boolean;
      readonly timeoutMs?: number;
      readonly pre?: ReadonlyArray<string>;
      readonly env?: Readonly<Record<string, string>>;
      readonly tailBytes?: number;
    } = {},
  ) =>
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
  const gitOk = (dir: string, args: ReadonlyArray<string>, options?: Parameters<typeof git>[2]) =>
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
   * starting agent shows no agent until its first hook, and a person may open a shell), beside
   * which a launch neither takes nor starts an agent; else nothing.
   */
  const agentIn = (
    answer: SnapshotAnswer,
    workspaceId: string,
    preset: string,
    skip: ReadonlyArray<string>,
  ): { readonly terminal: string } | "unclear" | null => {
    const terminals = answer.workspaces.find((ws) => ws.id === workspaceId)?.terminals ?? [];
    const others = terminals.filter((t) => !skip.includes(t.id));
    const agent = others.find((t) => t.agent?.id === preset);
    if (agent !== undefined) return { terminal: agent.id };
    return others.length > 0 ? "unclear" : null;
  };

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
      // No retry here, unlike the gate's: a launch that fails on the network is retried by the next pass.
      yield* gitOk(
        scratch,
        [...fetchArgs, `${remoteBase}/${repo}.git`, `+refs/heads/${baseRef}:refs/heads/${baseRef}`],
        {
          fetch: true,
          timeoutMs: 120_000,
          pre: FETCH_HTTP_FLAGS,
          env: { GIT_ALLOW_PROTOCOL: fileTransportFor(remoteBase) === "always" ? "https:file" : "https" },
        },
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
   * every filter driver and config hook its config names turned off, and only `file` transport. The
   * names come from one listing, taken here: they are what the calls of this operation run with.
   * `-c` splits at the first `=`, so a name with anything outside `[A-Za-z0-9._-]` cannot be
   * turned off that way: the launch fails rather than run git where it would run. The listing must
   * be complete: a truncated one, or a failure other than "none configured" (exit 1), fails the
   * launch too, since a name left out of it would not be turned off. A hook is turned off with
   * `enabled=false`; an empty `command` would make git fail the call it hooks.
   */
  const sessionRepo = (dir: string) =>
    Effect.gen(function* () {
      const listed = yield* git(dir, ["config", "-z", "--name-only", "--get-regexp", "^(filter|hook)\\."], {
        tailBytes: 1024 * 1024,
      });
      if (listed.timedOut || listed.tailTruncated || (listed.exitCode !== 0 && listed.exitCode !== 1)) {
        return yield* fail("the filter drivers and hooks of the repository could not be listed in full; nothing was run in it");
      }
      const names = new Set(
        listed.exitCode === 0
          ? listed.tail.split("\0").flatMap((key) => {
              const match = /^(filter|hook)\.(.+)\.[^.]+$/s.exec(key);
              return match === null ? [] : [`${match[1]}.${match[2]}`];
            })
          : [],
      );
      for (const name of names) {
        if (!/^(filter|hook)\.[A-Za-z0-9._-]+$/.test(name)) {
          return yield* fail(`${JSON.stringify(name)} in the repository's config cannot be turned off safely; nothing was run in it`);
        }
      }
      const pins = [...names].flatMap((name) =>
        (name.startsWith("filter.")
          ? ["smudge=", "clean=", "process=", "required=false"].map((key) => `${name}.${key}`)
          : [`${name}.enabled=false`]
        ).flatMap((setting) => ["-c", setting]),
      );
      const options = (given: Parameters<typeof git>[2] = {}): Parameters<typeof git>[2] => ({
        ...given,
        pre: [...pins, ...(given.pre ?? [])],
        env: { GIT_ALLOW_PROTOCOL: "file", ...given.env },
      });
      return {
        git: (args: ReadonlyArray<string>, given?: Parameters<typeof git>[2]) => git(dir, args, options(given)),
        gitOk: (args: ReadonlyArray<string>, given?: Parameters<typeof git>[2]) => gitOk(dir, args, options(given)),
      };
    });

  /**
   * Paradev does not fetch the base, and builds a worktree from the clone's own refs: a local
   * branch the runner never moves, or the project's default branch for one the clone lacks (X8).
   * So the new worktree's HEAD must be `base`, the commit just fetched, else it is reset there.
   * A worktree holding work (an edit, or a commit no other branch has) is never reset: that is an
   * earlier attempt's agent, and the answer is `kept`. Filter drivers and hooks a session put in
   * the shared config are turned off for every call.
   */
  const baseCheck = (worktreePath: string, base: string) =>
    Effect.gen(function* () {
      const repo = yield* sessionRepo(worktreePath);
      const head = yield* repo.gitOk(["rev-parse", "--verify", "HEAD^{commit}"]);
      if (head === base) return "at-base" as const;
      // No status inside a submodule: its own config and filters are not blanked here. `dirty`
      // still shows a changed submodule commit, which is work.
      const changed = yield* repo.gitOk(
        ["status", "--porcelain", "--untracked-files=normal", "--ignore-submodules=dirty"],
        { pre: ["--no-optional-locks"] },
      );
      // A commit only the checked-out branch has is work; one another branch has is not.
      const onBranch = yield* repo.git(["symbolic-ref", "-q", "HEAD"]);
      // `--exclude` before `--branches` takes the name without `refs/heads/`.
      const exclude =
        onBranch.exitCode === 0 ? [`--exclude=${onBranch.tail.trim().replace(/^refs\/heads\//, "")}`] : [];
      const ownCommit = yield* repo.gitOk([
        "rev-list", "--max-count=1", "HEAD", "--not", ...exclude, "--branches", "--remotes",
      ]);
      if (changed !== "" || ownCommit !== "") return "kept" as const;
      yield* repo.gitOk(["reset", "--hard", "--no-recurse-submodules", "-q", base], {
        pre: ["-c", "submodule.recurse=false"],
      });
      return "reset" as const;
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
      // No retry: a launch that finds its record without a terminal looks for the agent first.
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
      if (!snapshotDone) {
        const found = agentIn(yield* snapshot(record.workspaceId), record.workspaceId, placed.agent, placed.terminals);
        if (found === "unclear") return yield* noAgentYet(placed);
        if (found !== null) return yield* withAgent(placed, found.terminal, request);
      }
      if (checked === "kept") {
        return yield* fail(
          `the worktree ${got.worktreePath} holds work off the base and no agent runs there; it was left as it is`,
        );
      }
      return yield* withAgent(placed, yield* createAgent(placed, request), request);
    });

  const noAgentYet = (record: ThreadRecord) =>
    fail(`workspace ${record.workspaceId} has a terminal with no ${record.agent} agent in it yet; the next attempt looks again`);

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
      const found = agentIn(yield* snapshot(earlier.workspaceId), earlier.workspaceId, earlier.agent, []);
      if (found === "unclear") return yield* noAgentYet(earlier);
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

  const status = Effect.fn("ParadevSessions.status")(function* (threadId: string) {
    const record = yield* recordOf(threadId, "status");
    const place = { worktreePath: record.worktreePath, branch: record.branch };
    const noRun = { run: null, runOrdinal: null, runStartedAt: null, runCompletedAt: null, lastAssistantMessage: null };
    if (record.archivedAt !== null) return { ...place, archived: true, ...noRun } satisfies ThreadStatus;
    const terminal = record.terminals.at(-1);
    if (terminal === undefined) return { ...place, archived: false, ...noRun } satisfies ThreadStatus;

    const notFound = () => new ThreadNotFoundError({ threadId });
    const explained = yield* explain(record, terminal).pipe(
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
    const repo = yield* sessionRepo(path);
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
