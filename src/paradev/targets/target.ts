/**
 * What differs between the places a Paradev thread runs, this Mac, a Paradev host and Paradev
 * Cloud, as one interface ({@link ParadevTarget}) with one module each: `local.ts`, `host.ts` and
 * `cloud.ts`. `sessions.ts` picks the module of a record's target in one place and never asks the
 * target's kind again. This file also holds what the modules share.
 */
import * as Effect from "effect/Effect";
import type { PlatformError } from "effect/PlatformError";
import * as Schema from "effect/Schema";

import type { RunResult, RunSpawnError } from "../../process.ts";
import { callWithRetry, decodeAnswer } from "../call.ts";
import type { CliError, SupersetCli } from "../cli.ts";
import type { AgentLookupError, Explanation } from "../sessions.ts";
import type { SshError } from "../ssh.ts";
import type { ThreadRecord } from "../state.ts";

const MINUTE = 60_000;
/**
 * Right after `agents create`, explain says `none` until the agent's first hook. On a host, a
 * `starting` agent this long at `Attached` gets its screen read for Claude Code's trust dialog.
 */
export const STARTING_GRACE_MS = 5 * MINUTE;
/**
 * A `working` agent this long without a hook gets the process lookup. A cloud run gets it at most
 * this often, since each look starts a terminal in the sandbox.
 */
export const SILENT_WORKING_MS = 10 * MINUTE;

/** A launch or read the adapter cannot carry out, with what it found. */
export class ParadevAdapterError extends Schema.TaggedError<ParadevAdapterError>()(
  "ParadevAdapterError",
  { what: Schema.String },
) {
  override get message(): string {
    return this.what;
  }
}

export const fail = (what: string) => Effect.fail(new ParadevAdapterError({ what }));

export type Cli = SupersetCli["Service"];

export const isNotFound = (error: CliError) => error.kind === "NOT_FOUND";

export type GitOptions = {
  readonly fetch?: boolean;
  readonly timeoutMs?: number;
  readonly pre?: ReadonlyArray<string>;
  readonly env?: Readonly<Record<string, string>>;
  readonly tailBytes?: number;
};

/** A repository git runs in: `git` answers the call, `gitOk` its stdout when it exited 0. */
export type GitRepo = {
  readonly git: (args: ReadonlyArray<string>, options?: GitOptions) => Effect.Effect<RunResult, RunSpawnError | SshError>;
  readonly gitOk: (
    args: ReadonlyArray<string>,
    options?: GitOptions,
  ) => Effect.Effect<string, RunSpawnError | SshError | ParadevAdapterError>;
};

/** A git call's stdout, trimmed, when it exited 0; else what it did. */
export const gitOkOf = (args: ReadonlyArray<string>) => (result: RunResult) =>
  result.exitCode === 0 && !result.timedOut
    ? Effect.succeed(result.tail.trim())
    : Effect.fail(
        new ParadevAdapterError({
          what: `git ${args.join(" ")} ${result.timedOut ? "timed out" : `exited ${result.exitCode}`}: ${result.stderrTail.trim()}`,
        }),
      );

/** A worktree's repository for the launch, with the base brought there before the reset. */
export type WorktreeRepo = GitRepo & {
  /** Brings the base, fetched on this Mac, to this repository before the reset. */
  readonly fetchBase: (baseRef: string) => Effect.Effect<void, RunSpawnError | SshError | ParadevAdapterError>;
};

/** What a target's reads can fail with. */
export type TargetError = ParadevAdapterError | AgentLookupError | SshError | CliError | PlatformError;

export interface ParadevTarget {
  /** The location flag of every call against this target: the one place `--local` is written. */
  readonly at: ReadonlyArray<string>;
  /** `snapshot`'s flag: none on this Mac, as P1 recorded it; elsewhere `at`. */
  readonly snapshotAt: ReadonlyArray<string>;
  /** Whether the thread's worktree is on this Mac: removeWorktree, showGateLog, worktreesDirectory, and the count a pass cannot do without. */
  readonly onThisMac: boolean;
  /** The target's kind as log lines name it (`local`, `host`, `cloud`). Log text only; never branch on it. */
  readonly label: string;
  /** The worktree's repository for the launch's base check and reset, with the base brought there first. */
  readonly worktreeRepo: (dir: string) => Effect.Effect<WorktreeRepo, TargetError | RunSpawnError>;
  /** worktreeCheckout's repository at `path`; null when there is no worktree there to read. */
  readonly checkoutRepo: (path: string) => Effect.Effect<GitRepo | null, TargetError>;
  /** Whether the record's agent process is alive where it runs; null when that could not be read. */
  readonly agentAlive: (record: ThreadRecord, now: number, fresh: boolean) => Effect.Effect<boolean | null, TargetError>;
  /** The id of the newest Claude session of the record's agent, where it runs; null when none. */
  readonly newestSession: (record: ThreadRecord, worktreePath: string) => Effect.Effect<string | null, TargetError>;
  /** `workspaces get` as `thread` and the launch read it: the worktree path and branch; null when the workspace reads `deleted`. */
  readonly readWorkspace: (
    record: ThreadRecord,
  ) => Effect.Effect<{ readonly worktreePath: string | null; readonly branch: string } | null, CliError>;
  /** `workspaces archive`; succeeds when the workspace is gone. */
  readonly archiveWorkspace: (workspaceId: string) => Effect.Effect<void, TargetError>;
  /** For a `starting` agent: the error text when it is held by Claude Code's trust dialog, else null. */
  readonly startingHeld: (
    record: ThreadRecord,
    terminal: string,
    explained: Explanation,
    now: number,
  ) => Effect.Effect<string | null>;
}

// ---- what the modules share -----------------------------------------------------------------

const Got = Schema.Struct({ worktreePath: Schema.NullOr(Schema.String), branch: Schema.String });
export const Screen = Schema.Struct({ text: Schema.String });
const Archived = Schema.Struct({
  deleted: Schema.Array(Schema.String),
  notFound: Schema.Array(Schema.String),
  failed: Schema.Array(Schema.Unknown),
});

/** A Claude session id: the name of its `.jsonl`, passed on as `--resume-session`. */
export const SESSION_ID = /^[A-Za-z0-9-]+$/;

/** Claude's folder for a worktree's sessions: the path with every character but a letter or digit as `-`. */
export const claudeProjectFolder = (worktreePath: string): string => worktreePath.replace(/[^A-Za-z0-9]/g, "-");

/** `workspaces get` of a workspace with a worktree: on this Mac or a host. */
export const readWorktreeWorkspace = (cli: Cli, at: ReadonlyArray<string>) => (record: ThreadRecord) => {
  const argv = ["workspaces", "get", record.workspaceId, ...at];
  return callWithRetry(cli, argv, 30_000).pipe(
    Effect.flatMap((answer) => decodeAnswer(Got, answer, argv)),
    Effect.map((got) => ({ worktreePath: got.worktreePath, branch: got.branch })),
  );
};

/** `workspaces archive` of the workspace: null when Paradev answers it deleted or unknown, else what it answered. */
export const archiveCall = (cli: Cli, at: ReadonlyArray<string>, workspaceId: string) => {
  const argv = ["workspaces", "archive", workspaceId, ...at];
  return callWithRetry(cli, argv, 120_000).pipe(
    Effect.flatMap((answer) => decodeAnswer(Archived, answer, argv)),
    Effect.map((answer) => (answer.deleted.includes(workspaceId) || answer.notFound.includes(workspaceId) ? null : answer)),
    Effect.catchIf(isNotFound, () => Effect.succeed(null)),
  );
};

/** The error of an archive that left the workspace in place. */
export const notArchived = (workspaceId: string, gone: typeof Archived.Type) =>
  fail(`workspaces archive did not archive ${workspaceId}: ${JSON.stringify(gone.failed)}`);

/** {@link ParadevTarget.archiveWorkspace} for a target that is done when archive says so. */
export const archiveWorkspaceAt = (cli: Cli, at: ReadonlyArray<string>) => (workspaceId: string) =>
  Effect.gen(function* () {
    const gone = yield* archiveCall(cli, at, workspaceId);
    if (gone !== null) return yield* notArchived(workspaceId, gone);
  });
