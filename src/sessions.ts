import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/**
 * Agent sessions as the factory sees them: softfac's `Sessions` trait
 * (`src/t3.rs`) over T3's services, called in-process instead of over the
 * wire. Everything above this file uses these types, never T3's.
 */

/** Where a run is in its life, as T3 Code names it. */
export const RUN_STATUSES = [
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** The model a thread runs on, as T3 Code names it. */
export interface Model {
  /** The configured provider instance, e.g. `claudeAgent`. */
  readonly instanceId: string;
  /** The model id, e.g. `claude-sonnet-5-5`. */
  readonly model: string;
  /** The provider options the selection carries (a reasoning effort, say), when it has any. */
  readonly options?: ReadonlyArray<{ readonly id: string; readonly value: string | boolean }>;
}

/** The T3 project of a watched repo, as `findProject` answers it. */
export interface FactoryProject {
  readonly id: string;
  /**
   * The model a session on this project runs on: the project's default model, else the default
   * in T3's settings, the same choice a person gets in a new thread on the project. Null when
   * neither names one; the factory then launches nothing.
   */
  readonly model: Model | null;
  /**
   * The GitHub repo (`owner/name`) the project's clone belongs to, null when the project names
   * none. Absent when the adapter does not know it.
   */
  readonly repo?: string | null;
}

/** Everything `launch` needs. */
export interface LaunchRequest {
  /**
   * Names this command. Sent again after a failure, the same id lets T3 tell a
   * retry from a new launch, so callers derive it from what they are launching
   * (issue and attempt).
   */
  readonly commandId: string;
  /** A T3 project id, from `findProject`. */
  readonly projectId: string;
  readonly title: string;
  /** The ref the thread's worktree starts from. */
  readonly baseRef: string;
  /** The first message, which starts the first run. */
  readonly message: string;
  readonly model: Model;
  /**
   * The pull request the thread continues, linked to the thread at launch. Absent for a plain
   * start and for a resume from an earlier run that left no pull request.
   */
  readonly pullRequestUrl?: string;
}

/** What a worktree has checked out (`worktreeCheckout`). */
export interface Checkout {
  readonly head: string;
  readonly branch: string | null;
}

/** What `launch` returns. */
export interface Launched {
  readonly threadId: string;
  /** `null` until T3 Code has prepared the worktree. */
  readonly worktreePath: string | null;
  /** `null` until T3 Code has prepared the worktree. */
  readonly branch: string | null;
}

/** Where a thread works and whether it is archived. */
export interface Thread {
  /** `null` until T3 Code has prepared the worktree. */
  readonly worktreePath: string | null;
  /** `null` until T3 Code has prepared the worktree. */
  readonly branch: string | null;
  readonly archived: boolean;
}

/** What `status` reports about a thread. */
export interface ThreadStatus extends Thread {
  /**
   * The run with the highest ordinal, if the thread has any run yet. A
   * cancelled run that never started is left out, unless every run is one.
   */
  readonly run: RunStatus | null;
  /** The `ordinal` of that same run; `null` when the thread has no run. */
  readonly runOrdinal: number | null;
  /**
   * When that same run began, as epoch milliseconds: its start, else when it was requested if it
   * was cancelled; `null` when it never began, or the thread has no run.
   */
  readonly runStartedAt: number | null;
  /** When that same run ended, as epoch milliseconds; `null` while it runs, or when the thread has no run. */
  readonly runCompletedAt: number | null;
  /** The text of the last assistant message of that same run; `null` when the run has none. */
  readonly lastAssistantMessage: string | null;
}

/**
 * Whether `id` is plain enough to go into a thread id and a file name, and to be passed to a
 * CLI as an argument: letters, digits and `-`, not starting with `-`. Workspace, machine and
 * environment ids from Paradev all are.
 */
export const isPlainId = (id: string): boolean => /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(id);

/** The branches `paradev/branches.ts` `launchBranch` makes: `fac/<issue>-<attempt>[-<hex>]`, or `fac/x-<hex>`. */
const LAUNCH_BRANCH = /^fac\/(\d+|x)-[0-9a-f-]+$/;

/**
 * The branch Paradev Cloud names for a workspace called after a launch branch:
 * `superset/<name slug>-<first 8 of the workspace id>`, so `fac/3-1` becomes `superset/fac-3-1-a2bc69cb`.
 */
const CLOUD_LAUNCH_BRANCH = /^superset\/fac-(\d+|x)-[0-9a-f-]+-[0-9a-f]{8}$/;

/**
 * Whether `branch` is a launch branch and `worktreePath` is a Paradev worktree on it: the path
 * ends with `/<branch>`. A cloud launch branch is one with any path, since the sandbox's is
 * always `/workspace`. So a cloud-shaped branch says only what made it, never that it is a given
 * session's: that goes through the thread's own `branch`, as in `checkBinding`. Defined here, not in `paradev/`, so the core reads it without importing
 * the adapter; `paradev/branches.ts` re-exports it beside `launchBranch`.
 */
export const isLaunchBranch = (branch: string, worktreePath: string | null): boolean =>
  CLOUD_LAUNCH_BRANCH.test(branch) ||
  (worktreePath !== null && LAUNCH_BRANCH.test(branch) && worktreePath.endsWith(`/${branch}`));

/**
 * The launch branch read back from a local Paradev worktree path,
 * `<worktrees folder>/<project>/fac/<n>` (the inverse of `isLaunchBranch`). Null for any other
 * path, a cloud sandbox's `/workspace` among them: the core reads that branch from the thread.
 */
export const launchBranchOf = (worktreePath: string | null): string | null => {
  const parts = worktreePath?.split("/") ?? [];
  if (parts.length < 5 || parts.at(-2) !== "fac" || parts.slice(1, -2).includes("")) return null;
  const branch = `fac/${parts.at(-1)}`;
  return isLaunchBranch(branch, worktreePath) ? branch : null;
};

export class ThreadNotFoundError extends Schema.TaggedError<ThreadNotFoundError>()(
  "FactoryThreadNotFoundError",
  { threadId: Schema.String },
) {
  override get message(): string {
    return `T3 does not know thread ${this.threadId}.`;
  }
}

/**
 * T3 refused the message. It keeps that answer for the command id, so sending
 * the same id again fails the same way; only a new id sends the message again.
 */
export class MessageRejectedError extends Schema.TaggedError<MessageRejectedError>()(
  "FactoryMessageRejectedError",
  { threadId: Schema.String, commandId: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `T3 refused message ${this.commandId} to thread ${this.threadId}.`;
  }
}

/** The text of a launch that found no target with room. */
export const NO_TARGET_HAS_ROOM = "no target has room";

/** Placement found no target with room for a launch. The launch is sent again on a later pass. */
export class NoTargetHasRoom extends Schema.TaggedError<NoTargetHasRoom>()("FactoryNoTargetHasRoom", {}) {
  override get message(): string {
    return NO_TARGET_HAS_ROOM;
  }
}

export class SessionsError extends Schema.TaggedError<SessionsError>()("FactorySessionsError", {
  operation: Schema.Literals([
    "find-project",
    "launch",
    "status",
    "thread",
    "send",
    "archive",
    "remove-worktree",
    "worktree-head",
    "broken-worktrees",
    "running-threads",
    "live-branches",
    "worktrees-directory",
    "last-activity",
  ]),
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Factory sessions ${this.operation} failed.`;
  }
}

/**
 * Whether `error` is a launch that found no target with room: a `SessionsError` of operation
 * `launch` whose cause is `NoTargetHasRoom`. Nothing was started; the same request may be sent
 * again later, so callers treat it as a wait, not a failure.
 */
export const isNoTargetHasRoom = (error: unknown): boolean =>
  error instanceof SessionsError && error.operation === "launch" && error.cause instanceof NoTargetHasRoom;

export class FactorySessions extends Context.Service<
  FactorySessions,
  {
    /** The live T3 project whose workspace root is exactly `workspaceRoot`, with its model. */
    readonly findProject: (
      workspaceRoot: string,
    ) => Effect.Effect<FactoryProject | null, SessionsError>;
    /**
     * Starts a thread in its own worktree and runs `message` in it. The
     * worktree is prepared asynchronously, so the answer may not carry a
     * branch or path yet; `status` will. The same `commandId` again is the
     * same launch: T3 answers with the thread it made and starts nothing.
     * It can fail with operation `launch` whose cause is `NoTargetHasRoom` when
     * no target has room: nothing was started, and the same request may be sent
     * again later (see `isNoTargetHasRoom`).
     */
    readonly launch: (request: LaunchRequest) => Effect.Effect<Launched, SessionsError>;
    /** The status of the thread's run, the last assistant message and where the thread works. */
    readonly status: (
      threadId: string,
    ) => Effect.Effect<ThreadStatus, ThreadNotFoundError | SessionsError>;
    /**
     * Where the thread works and whether it is archived. Only the thread's own
     * fields are read, so this answers for a thread whose runs or messages
     * `status` cannot read: the stop path uses it, so a session can always be
     * stopped.
     */
    readonly thread: (
      threadId: string,
    ) => Effect.Effect<Thread, ThreadNotFoundError | SessionsError>;
    /**
     * Sends a follow-up message into the thread; T3 decides delivery (start, steer or queue).
     * `commandId` names it like a launch's: resent after a failure, T3 keeps one message, and a
     * refused one stays refused under its id (`MessageRejectedError`). With `model`, the run it
     * starts, and the thread from then on, run on that model.
     */
    readonly send: (
      threadId: string,
      commandId: string,
      text: string,
      model?: Model,
    ) => Effect.Effect<void, ThreadNotFoundError | MessageRejectedError | SessionsError>;
    /**
     * Archives the thread, which stops its active run. Succeeds when the
     * thread ends archived or gone: one that already was archived, and one T3
     * does not know, change nothing. T3 does not make archiving idempotent, so
     * every attempt sends a command id of its own.
     */
    readonly archive: (threadId: string) => Effect.Effect<void, SessionsError>;
    /**
     * Removes a thread's worktree with git and keeps its branch. Live threads still on it (a
     * subagent sharing the checkout) are archived first, failing as `archive` before git runs; a
     * later failure is `remove-worktree`. A worktree already gone is removed; `path` is absolute.
     * A folder git just unlisted is emptied over about 10 s; any other leftover fails for a person.
     */
    readonly removeWorktree: (path: string) => Effect.Effect<void, SessionsError>;
    /**
     * What the worktree at absolute `path` has checked out: its HEAD commit, and the branch HEAD
     * is on (null when detached). Null when `path` has no `.git`: no worktree is there. A read that
     * fails, or a HEAD that is not a full commit id, is `worktree-head`.
     */
    readonly worktreeCheckout: (path: string) => Effect.Effect<Checkout | null, SessionsError>;
    /**
     * How many of the factory's unarchived threads have an agent at work: a run preparing,
     * starting or running. A person's own agents are not counted, and a run waiting on a person
     * does not count.
     */
    readonly runningThreads: Effect.Effect<number, SessionsError>;
    /**
     * When the thread's agent last did anything (a message, reasoning, tool call or subagent), as
     * epoch milliseconds; null when it has done nothing. What is sent into the thread is not counted.
     */
    readonly lastActivity: (threadId: string) => Effect.Effect<number | null, SessionsError>;
    /**
     * Opens a terminal in the thread's workspace that follows the gate log of `attempt`, once per
     * attempt: a repeat for the same attempt opens nothing. Never fails: an error is one warning
     * in the log.
     */
    readonly showGateLog: (
      threadId: string,
      attempt: number,
      logPath: string,
    ) => Effect.Effect<void>;
    /**
     * The folder T3 makes a new thread's worktree under now: the one Settings → Storage names,
     * else `defaultDir`. Null for a setting T3 cannot make a worktree under.
     */
    readonly worktreesDirectory: (
      defaultDir: string,
    ) => Effect.Effect<string | null, SessionsError>;
  }
>()("factory-runner/sessions/FactorySessions") {}
