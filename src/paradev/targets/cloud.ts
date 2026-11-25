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
  type TargetError,
} from "./target.ts";

/** Where a cloud sandbox keeps Claude's sessions: its worktree is `/workspace`. */
const CLOUD_SESSIONS_DIR = "/home/ubuntu/.claude/projects/-workspace";
export const CLOUD_WORKTREE = "/workspace";
/** The end marks of the helper terminals' commands. */
const ALIVE_MARK = "FACTORY-ALIVE-DONE";
const SESSION_MARK = "FACTORY-SESSION-DONE";
const LOGIN_MARK = "FACTORY-LOGIN-DONE";
/**
 * The env a sandbox terminal gets from the organization's Claude connection: an `api_key`
 * connection gives `ANTHROPIC_API_KEY`, the others one of the rest. Only presence is read.
 */
const LOGIN_TEST = '[ -n "$ANTHROPIC_API_KEY$ANTHROPIC_AUTH_TOKEN$CLAUDE_CODE_OAUTH_TOKEN" ] && echo yes || echo no';

const TerminalCreated = Schema.Struct({ terminalId: Schema.String });
/** A cloud workspace has no worktree path on this Mac; its `status` goes `provisioning`, then up, then gone. */
const CloudGot = Schema.Struct({ status: Schema.String, branch: Schema.String });

/** Every cloud workspace status recorded so far: CLI 2.0.8's `provisioning`, `ready` and `deleted`, and 2.0.11's `awake`, `asleep` and `archived`. */
const CLOUD_STATUSES: ReadonlySet<string> = new Set(["provisioning", "ready", "awake", "asleep", "deleted", "archived"]);

/**
 * The check every cloud status read goes through: one warning per status that is not in
 * {@link CLOUD_STATUSES}, naming the workspace it was first seen on. Such a status reads as neither
 * up nor archived, which is how CLI 2.0.11's renames went unseen (#111). It warns and does not
 * fail: a status the runner has never seen must not stop the count, the sweep or an archive.
 * Each adapter makes one, so a status is reported once per run of the runner, not once per pass.
 */
export const makeCloudStatusCheck = () => {
  const warned = new Set<string>();
  return (workspaceId: string, status: string | null | undefined) =>
    Effect.suspend(() => {
      if (status === null || status === undefined || CLOUD_STATUSES.has(status) || warned.has(status)) return Effect.void;
      warned.add(status);
      return Effect.logWarning(
        `cloud workspace ${workspaceId} has the status ${status}, which the runner does not know: it reads as ` +
          "neither up nor archived. If a Paradev CLI upgrade renamed a status, add it to src/paradev/targets/cloud.ts",
      );
    });
};
export type CloudStatusCheck = ReturnType<typeof makeCloudStatusCheck>;

/** A cloud workspace that has booted: CLI 2.0.8 says `ready`, 2.0.11 `awake`. A slept one (`asleep`) is not up. */
export const isCloudUp = (status: string): boolean => status === "ready" || status === "awake";

/** A cloud workspace that is archived: CLI 2.0.8 says `deleted`, 2.0.11 `archived`. */
export const isCloudGone = (status: string | null | undefined): boolean => status === "deleted" || status === "archived";

/** `mark` as a helper command echoes it: split by an empty quote, so the echoed command line does not match it. */
const echoed = (mark: string): string => mark.replace(/-([^-]*)$/, "-''$1");

/** The trimmed line just before the last line that is `mark`; null when there is none. */
const lineBefore = (text: string, mark: string): string | null => {
  const lines = text.split("\n").map((line) => line.trim());
  const end = lines.lastIndexOf(mark);
  return end > 0 ? lines[end - 1]! : null;
};

export const getCloudWorkspace = (cli: Cli, at: ReadonlyArray<string>, workspaceId: string, checkStatus: CloudStatusCheck) => {
  const argv = ["workspaces", "get", workspaceId, ...at];
  return callWithRetry(cli, argv, 30_000).pipe(
    Effect.flatMap((answer) => decodeAnswer(CloudGot, answer, argv)),
    Effect.tap((got) => checkStatus(workspaceId, got.status)),
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
  /** The adapter's one check of every cloud status it reads. */
  readonly checkStatus: CloudStatusCheck;
}

/** The cloud module: a {@link ParadevTarget}, and the login check only a cloud launch makes. */
export interface CloudTarget extends ParadevTarget {
  /**
   * Whether a new terminal in the sandbox gets the Claude connection's env. A sandbox can read
   * `awake` seconds before it does, and an agent started then sits at "Not logged in" for good.
   */
  readonly loginReady: (record: ThreadRecord) => Effect.Effect<boolean, TargetError>;
}

export const makeCloudTarget = (deps: CloudDeps): CloudTarget => {
  const { cli, at, commandOf, aliveReads, checkStatus } = deps;

  /** The helper command's output: the end mark, echoed so the echoed command line does not match it. */
  const helperRead = (record: ThreadRecord, command: string, mark: string) =>
    Effect.gen(function* () {
      const where = [...at, "--workspace", record.workspaceId];
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

  const loginReady = (record: ThreadRecord) =>
    helperRead(record, LOGIN_TEST, LOGIN_MARK).pipe(Effect.map((text) => lineBefore(text, LOGIN_MARK) === "yes"));

  return {
    loginReady,
    at: at,
    snapshotAt: at,
    onThisMac: false,
    label: "cloud",
    worktreeRepo: () => fail("a cloud worktree is not on this Mac"),
    // A cloud sandbox's `/workspace` is not on this Mac; its run binds through the record's branch.
    checkoutRepo: () => Effect.succeed(null),
    agentAlive: cloudAgentAlive,
    newestSession: (record) => newestCloudSession(record),
    // A cloud workspace has no worktree here, and reads gone once it is archived.
    readWorkspace: (record) =>
      getCloudWorkspace(cli, at, record.workspaceId, checkStatus).pipe(
        Effect.map((got) =>
          isCloudGone(got.status) ? null : { worktreePath: record.worktreePath, branch: got.branch },
        ),
      ),
    archiveWorkspace: (workspaceId) =>
      Effect.gen(function* () {
        const gone = yield* archiveCall(cli, at, workspaceId);
        // A cloud workspace that `workspaces get` reads as gone is archived, whatever archive said.
        if (gone !== null) {
          const got = yield* getCloudWorkspace(cli, at, workspaceId, checkStatus).pipe(
            Effect.catchIf(isNotFound, () => Effect.succeed(null)),
          );
          if (got === null || isCloudGone(got.status)) return;
          return yield* notArchived(workspaceId, gone);
        }
      }),
    startingHeld: () => Effect.succeed(null),
  };
};
