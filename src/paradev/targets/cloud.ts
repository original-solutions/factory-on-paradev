/**
 * The target of a thread that runs in Paradev Cloud: the host Paradev calls `cloud`. The sandbox's
 * worktree is `/workspace`, not on this Mac, and anything the adapter reads there goes through a
 * helper terminal.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { call, callWithRetry, decodeAnswer } from "../call.ts";
import { shellQuote } from "../ssh.ts";
import type { ThreadRecord } from "../state.ts";
import {
  archiveCall,
  type Cli,
  fail,
  isNotFound,
  notArchived,
  type ParadevTarget,
  Screen,
  SESSION_ID,
  SILENT_WORKING_MS,
} from "./target.ts";

/** Where a cloud sandbox keeps Claude's sessions: its worktree is `/workspace`. */
const CLOUD_SESSIONS_DIR = "/home/ubuntu/.claude/projects/-workspace";
export const CLOUD_WORKTREE = "/workspace";
/** The end marks of the helper terminals' commands. */
const ALIVE_MARK = "FACTORY-ALIVE-DONE";
const SESSION_MARK = "FACTORY-SESSION-DONE";

const TerminalCreated = Schema.Struct({ terminalId: Schema.String });
/** A cloud workspace has no worktree path on this Mac; its `status` goes `provisioning`, `ready`, `deleted`. */
const CloudGot = Schema.Struct({ status: Schema.String, branch: Schema.String });

/** `mark` as a helper command echoes it: split by an empty quote, so the echoed command line does not match it. */
const echoed = (mark: string): string => mark.replace(/-([^-]*)$/, "-''$1");

/** The trimmed line just before the last line that is `mark`; null when there is none. */
const lineBefore = (text: string, mark: string): string | null => {
  const lines = text.split("\n").map((line) => line.trim());
  const end = lines.lastIndexOf(mark);
  return end > 0 ? lines[end - 1]! : null;
};

export const getCloudWorkspace = (cli: Cli, at: ReadonlyArray<string>, workspaceId: string) => {
  const argv = ["workspaces", "get", workspaceId, ...at];
  return callWithRetry(cli, argv, 30_000).pipe(
    Effect.flatMap((answer) => decodeAnswer(CloudGot, answer, argv)),
  );
};

/** What the module needs of the adapter. */
export interface CloudDeps {
  readonly cli: Cli;
  /** The location flag of cloud. */
  readonly at: ReadonlyArray<string>;
  /** The process a record's preset runs. */
  readonly commandOf: (record: ThreadRecord) => string;
  /**
   * Each cloud agent's last liveness read for `status`, by thread and terminal: at most one helper
   * terminal per 10 minutes. A send never answers from it.
   */
  readonly aliveReads: Map<string, { readonly at: number; readonly alive: boolean | null }>;
}

export const makeCloudTarget = (deps: CloudDeps): ParadevTarget => {
  const { cli, at: AT, commandOf, aliveReads } = deps;

  /** The helper command's output: the end mark, echoed so the echoed command line does not match it. */
  const helperRead = (record: ThreadRecord, command: string, mark: string) =>
    Effect.gen(function* () {
      const where = [...AT, "--workspace", record.workspaceId];
      const createArgv = ["terminals", "create", ...where, "--command", `${command}; echo ${echoed(mark)}`];
      const created = yield* decodeAnswer(TerminalCreated, yield* call(cli, createArgv, 30_000), createArgv);
      const terminal = ["--terminal", created.terminalId];
      const closeArgv = ["terminals", "close", ...where, ...terminal];
      return yield* Effect.gen(function* () {
        yield* call(cli, ["terminals", "wait", ...where, ...terminal, "--match", mark, "--timeout", "30"], 45_000);
        const readArgv = ["terminals", "read", ...where, ...terminal, "--max-lines", "5"];
        return (yield* decodeAnswer(Screen, yield* call(cli, readArgv, 30_000), readArgv)).text;
      }).pipe(
        Effect.ensuring(
          call(cli, closeArgv, 30_000).pipe(
            Effect.catch((error) => Effect.logWarning(`could not close the helper terminal: ${error.message}`)),
          ),
        ),
      );
    });

  /**
   * Whether a cloud run's agent is alive: `pgrep -c` in a helper terminal; a count of 0 is dead.
   * Null when the read failed or answered nothing to count. For `status` (`fresh` false) it reads
   * at most once per 10 minutes per agent; a send always reads, since it types on the answer.
   */
  const cloudAgentAlive = (record: ThreadRecord, now: number, fresh: boolean) =>
    Effect.gen(function* () {
      const key = `${record.threadId}/${record.terminals.at(-1) ?? ""}`;
      const last = aliveReads.get(key);
      if (!fresh && last !== undefined && now - last.at < SILENT_WORKING_MS) return last.alive;
      const alive = yield* helperRead(record, `pgrep -c ${shellQuote(commandOf(record))}`, ALIVE_MARK).pipe(
        Effect.map((text) => {
          const count = lineBefore(text, ALIVE_MARK);
          return count !== null && /^\d+$/.test(count) ? Number(count) > 0 : null;
        }),
        Effect.catch((error) =>
          Effect.logWarning(`could not read whether ${record.threadId}'s agent is alive: ${error.message}`).pipe(
            Effect.as(null),
          ),
        ),
      );
      aliveReads.set(key, { at: now, alive });
      return alive;
    });

  /** The newest Claude session in a cloud sandbox, through a helper terminal: its worktree is `/workspace`. */
  const newestCloudSession = (record: ThreadRecord) =>
    Effect.gen(function* () {
      const text = yield* helperRead(record, `ls -t ${CLOUD_SESSIONS_DIR}/*.jsonl | head -1`, SESSION_MARK);
      const line = lineBefore(text, SESSION_MARK) ?? "";
      const id = line.startsWith(`${CLOUD_SESSIONS_DIR}/`) && line.endsWith(".jsonl")
        ? line.slice(CLOUD_SESSIONS_DIR.length + 1, -".jsonl".length)
        : "";
      return SESSION_ID.test(id) ? id : null;
    });

  return {
    at: AT,
    snapshotAt: AT,
    onThisMac: false,
    label: "cloud",
    worktreeRepo: () => fail("a cloud worktree is not on this Mac"),
    // A cloud sandbox's `/workspace` is not on this Mac; its run binds through the record's branch.
    checkoutRepo: () => Effect.succeed(null),
    agentAlive: cloudAgentAlive,
    newestSession: (record) => newestCloudSession(record),
    // A cloud workspace has no worktree here, and reads `deleted` once it is archived.
    readWorkspace: (record) =>
      getCloudWorkspace(cli, AT, record.workspaceId).pipe(
        Effect.map((got) =>
          got.status === "deleted" ? null : { worktreePath: record.worktreePath, branch: got.branch },
        ),
      ),
    archiveWorkspace: (workspaceId) =>
      Effect.gen(function* () {
        const gone = yield* archiveCall(cli, AT, workspaceId);
        // A cloud workspace that `workspaces get` reads as `deleted` is archived, whatever archive said.
        if (gone !== null) {
          const got = yield* getCloudWorkspace(cli, AT, workspaceId).pipe(
            Effect.catchIf(isNotFound, () => Effect.succeed(null)),
          );
          if (got === null || got.status === "deleted") return;
          return yield* notArchived(workspaceId, gone);
        }
      }),
    startingHeld: () => Effect.succeed(null),
  };
};
