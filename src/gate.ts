// @effect-diagnostics nodeBuiltinImport:off - The gate keeps its locks and checkouts as plain files and directories (O_EXCL, lstat, rmdir) that Effect's FileSystem does not expose.
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Random from "effect/Random";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { configFlags, HARDENED_GIT_CONFIG, HARDENED_GIT_ENV } from "./gitHardening.ts";
import type { AppendIo } from "./ledger/appendFile.ts";
import { errnoCode, ledgerCall, type LedgerError } from "./ledger/errors.ts";
import { makeCause } from "./ledger/events.ts";
import { Ledger } from "./ledger/ledger.ts";
import { readRun } from "./ledger/read.ts";
import { runIdToString, validateRunId, type RunId } from "./ledger/runId.ts";
import { FactoryProcess, type RunInput, type RunResult, type RunSpawnError } from "./process.ts";
import { commandLine, isCommitId, sanitize, shortSha } from "./text.ts";

/**
 * The gate: a fresh checkout of a pull request's head merged with the base tip, with the project's
 * provision and gate commands run in it. The commands come from the caller (default-branch config),
 * never the checkout, so a pull request cannot edit its own gate. A lock file exists only while a
 * gate effect runs; `clearGateLocks` removes one a dead server left.
 */

const DEFAULT_REMOTE_BASE = "https://github.com";
const DEFAULT_COMMAND_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_GIT_TIMEOUT_MS = 30_000;
const DEFAULT_CHECKOUT_TIMEOUT_MS = 10 * 60 * 1000;
const GIT_TAIL_BYTES = 1024 * 1024;
/** Provision and gate commands load the host; at this niceness the server's event loop still gets the CPU. */
const COMMAND_NICENESS = 10;
/** The `gate_command` line of an attempt that ran no command because the head conflicts with the base. */
export const MERGE_COMMAND = "softfac: merge the base branch into the head";

// The messages are the ones softfac's `WorkspaceError` and `GateError` print.

const causeText = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** `git` ran and failed: no such directory, not a repo, and so on. `status` is null when a signal ended it. */
export class WorkspaceFailedError extends Schema.TaggedError<WorkspaceFailedError>()(
  "WorkspaceFailedError",
  { args: Schema.String, status: Schema.NullOr(Schema.Number), stderr: Schema.String },
) {
  override get message(): string {
    const stderr = this.stderr.trimEnd();
    return this.status === null
      ? `\`git ${this.args}\` was killed by a signal: ${stderr}`
      : `\`git ${this.args}\` exited with status ${this.status}: ${stderr}`;
  }
}

/** `git` answered with something that is not what it should print. */
export class WorkspaceUnexpectedError extends Schema.TaggedError<WorkspaceUnexpectedError>()(
  "WorkspaceUnexpectedError",
  { what: Schema.String },
) {
  override get message(): string {
    return `unexpected output from git: ${this.what}`;
  }
}

/** A checkout could not be removed completely. `what` says what is left. */
export class WorkspaceCleanupError extends Schema.TaggedError<WorkspaceCleanupError>()(
  "WorkspaceCleanupError",
  { what: Schema.String },
) {
  override get message(): string {
    return `could not remove the checkout: ${this.what}`;
  }
}

/** The gate could not make a directory or a lock of its own. */
export class WorkspaceIoError extends Schema.TaggedError<WorkspaceIoError>()("WorkspaceIoError", {
  path: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `cannot make ${this.path}: ${causeText(this.cause)}`;
  }
}

/** `git` could not be started. */
export class WorkspaceSpawnError extends Schema.TaggedError<WorkspaceSpawnError>()(
  "WorkspaceSpawnError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return `cannot start \`git\`: ${causeText(this.cause)}`;
  }
}

export type WorkspaceError =
  | WorkspaceFailedError
  | WorkspaceUnexpectedError
  | WorkspaceCleanupError
  | WorkspaceIoError
  | WorkspaceSpawnError;

/** A gate command could not start (a command that fails or times out is a normal result). */
export class GateCommandSpawnError extends Schema.TaggedError<GateCommandSpawnError>()(
  "GateCommandSpawnError",
  { command: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `could not start \`${this.command}\`: ${causeText(this.cause)}`;
  }
}

/**
 * The attempt's commands ran and the ledger failed while their `gate_command` lines were written,
 * after at least one of them went in. The ledger counts the attempt, so the caller does too.
 */
export class GateRecordError extends Schema.TaggedError<GateRecordError>()("GateRecordError", {
  attempt: Schema.Number,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `attempt ${this.attempt} is used: the ledger failed while its gate_command lines were written: ${causeText(this.cause)}`;
  }
}

/**
 * Why `run` failed. A `GateRecordError` means the attempt was used; any other failure means no
 * attempt was used, and the caller retries on its next pass.
 */
export type GateError = WorkspaceError | GateCommandSpawnError | GateRecordError | LedgerError;

/**
 * `command` as one line in a code span for a table cell: the span's backticks are longer than any
 * run in the command, and `|` is escaped so it does not end the cell.
 */
const tableCode = (command: string): string =>
  codeSpan(commandLine(command).replaceAll("|", "\\|"));

/** A command as {@link commandLine} cleans it, in a code span nothing can leave. For prose outside a table. */
export const commandCode = (command: string): string => codeSpan(commandLine(command));

const codeSpan = (line: string): string => {
  const longest = Math.max(0, ...(line.match(/`+/g) ?? []).map((run) => run.length));
  const ticks = "`".repeat(longest + 1);
  // A span may not start or end with a backtick of its own, so a space goes in between.
  const pad = line.startsWith("`") || line.endsWith("`") ? " " : "";
  return `${ticks}${pad}${line}${pad}${ticks}`;
};

/**
 * The comment for a pull request whose gate ended with `verdict`. `headSha` is the commit the gate
 * ran on and `baseSha` the tip of the base branch it was merged with. The commands are config
 * text, so each is cleaned like the gate's own command line, then put in a code span nothing can
 * leave.
 */
const resultsComment = (
  verdict: string,
  results: ReadonlyArray<CommandResult>,
  attempt: number,
  headSha: string,
  baseSha: string,
): string => {
  const head = shortSha(headSha);
  const base = shortSha(baseSha) || "unknown";
  let text = `**Factory gate: ${verdict}** (attempt ${attempt}, run by the factory in a fresh checkout of the pull request's head \`${head}\` merged with the base branch tip \`${base}\`)\n\n| Command | Exit | Time |\n|---|---|---|`;
  for (const result of results) {
    const tenths = Math.floor((result.durationMs + 50) / 100);
    text += `\n| ${tableCode(result.command)} | ${result.exitCode} | ${Math.floor(tenths / 10)}.${tenths % 10} s |`;
  }
  return text;
};

/** The comment for a pull request whose gate passed. */
export const gateResultsComment = (
  results: ReadonlyArray<CommandResult>,
  attempt: number,
  headSha: string,
  baseSha: string,
): string => resultsComment("passed", results, attempt, headSha, baseSha);

/**
 * The comment for a pull request that was ready already and passed the gate again on a head or a
 * base branch that had moved: the same table, headed `passed again`.
 */
export const regateResultsComment = (
  results: ReadonlyArray<CommandResult>,
  attempt: number,
  headSha: string,
  baseSha: string,
): string => resultsComment("passed again", results, attempt, headSha, baseSha);

/** How many times the fetch of a checkout is tried before its failure is returned. */
const FETCH_ATTEMPTS = 3;
/** The wait before the second and the third fetch, in milliseconds; each gets up to a second more. */
const FETCH_RETRY_DELAYS_MS = [5_000, 15_000] as const;
/**
 * What git's stderr says when the network dropped the fetch: HTTP/2 stream error, TLS handshake
 * timeout, unresolved name, failed or timed-out connection, or a cut-off pack or answer. Anything else
 * (missing ref, refused login) returns at once. `RPC failed` counts only with a curl code right
 * after it; `RPC failed; HTTP 403 curl 22` means the server answered and refused.
 */
const TRANSIENT_FETCH =
  /Error in the HTTP2 framing layer|TLS handshake timeout|Could not resolve host|Failed to connect|Connection timed out|SSL_ERROR_SYSCALL|early EOF|unexpected EOF|RPC failed; curl \d+/;

export interface GateOptions {
  /** Where repositories are fetched from: `<remoteBase>/<owner>/<name>.git`. Default `https://github.com`; tests pass `file:///…`. */
  readonly remoteBase?: string;
  /** Set as `GH_CONFIG_DIR` on the fetch only, so `gh auth git-credential` finds the factory's own login. */
  readonly ghConfigDir?: string;
  /** Each provision and gate command. Default 30 minutes. */
  readonly commandTimeoutMs?: number;
  /** Each small git call. Default 30 seconds. */
  readonly gitTimeoutMs?: number;
  /** The calls that move a repository's worth of data: init, fetch, checkout, merge. Default 10 minutes. */
  readonly checkoutTimeoutMs?: number;
  /** The ledger's clock (epoch milliseconds). */
  readonly clock?: () => number;
  /** The most a git call may print, on stdout or on stderr. Default 1 MiB. */
  readonly gitTailBytes?: number;
  /** Test only: the waits before the second and the third fetch, default 5 s and 15 s. */
  readonly fetchRetryDelaysMs?: ReadonlyArray<number>;
  /** Test only: variables set on every git call after the others, so a test can give git another HOME or PATH. */
  readonly env?: Readonly<Record<string, string>>;
  /** Test only: the ledger's write and sync, so a test can fail an append. */
  readonly ledgerIo?: AppendIo;
}

export interface GateInput {
  /** `<base>/factory`, the factory's data dir. */
  readonly dataDir: string;
  readonly run: RunId;
  /** One-based. */
  readonly attempt: number;
  /** `owner/name`. */
  readonly repo: string;
  /** Full commit id of the pull request head. */
  readonly head: string;
  /** Full commit id of the base branch tip. */
  readonly base: string;
  readonly provision: ReadonlyArray<string>;
  readonly gate: ReadonlyArray<string>;
  readonly maxConcurrentGates: number;
  readonly options?: GateOptions;
}

export interface CommandResult {
  readonly command: string;
  /** -1 when a signal or the time limit ended it. */
  readonly exitCode: number;
  readonly durationMs: number;
  readonly timedOut: boolean;
  /** The tail of the combined stdout and stderr. */
  readonly output: string;
  /** The time limit the command had, when it timed out. */
  readonly timeoutMs?: number;
  /** Output was dropped from the front of `output`. */
  readonly truncated?: boolean;
}

export type GateResult =
  | {
      readonly _tag: "pass";
      readonly dir: string;
      readonly commands: ReadonlyArray<CommandResult>;
      /** The number of gate commands (not provision commands) that ran. */
      readonly gateCount: number;
    }
  | {
      readonly _tag: "fail";
      readonly dir: string;
      readonly commands: ReadonlyArray<CommandResult>;
      readonly failure: CommandResult;
      /** The number of gate commands that ran, the failing one included; 0 when provision failed. */
      readonly gateCount: number;
    }
  | { readonly _tag: "conflict"; readonly dir: string; readonly paths: ReadonlyArray<string> }
  /** This run already has a gate: its lock file exists. */
  | { readonly _tag: "running" }
  /** `maxConcurrentGates` locks are held. */
  | { readonly _tag: "queued"; readonly running: number; readonly max: number };

/** What merging the base branch tip into the head did. */
export type Merge =
  | { readonly _tag: "contained" }
  | { readonly _tag: "merged" }
  | { readonly _tag: "conflict"; readonly paths: ReadonlyArray<string> };

export interface Checkout {
  /** The commit the head was checked out at, before any merge. */
  readonly head: string;
  readonly merge: Merge;
}

const gatesDir = (dataDir: string) => NodePath.join(dataDir, "gates");

/** `<dataDir>/gate/<run id>`: the directory that holds one directory per attempt. */
export const gateRoot = (dataDir: string, run: RunId): string => {
  validateRunId(run);
  return NodePath.join(dataDir, "gate", runIdToString(run));
};

/** `<dataDir>/gates/<run id>.lock`: it exists exactly while that run's gate runs. */
export const gateLockFile = (dataDir: string, run: RunId): string => {
  validateRunId(run);
  return NodePath.join(gatesDir(dataDir), `${runIdToString(run)}.lock`);
};

const lockNames = (dataDir: string): ReadonlyArray<string> => {
  try {
    return NodeFS.readdirSync(gatesDir(dataDir), { withFileTypes: true })
      .filter((entry) => entry.name.endsWith(".lock") && !entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
};

/** How many gates hold a lock now. */
export const gateLocksHeld = (dataDir: string): number => lockNames(dataDir).length;

/** When each gate that holds a lock now took it: the lock file's mtime. One gone since is left out. */
export const gateLockTimes = (dataDir: string): ReadonlyArray<number> =>
  lockNames(dataDir).flatMap((name) => {
    try {
      return [NodeFS.statSync(NodePath.join(gatesDir(dataDir), name)).mtimeMs];
    } catch {
      return [];
    }
  });

/** Removes every lock file a dead server left under `<dataDir>/gates/`; returns how many went. */
export const clearGateLocks = (dataDir: string): Effect.Effect<number> =>
  Effect.sync(() => {
    let removed = 0;
    for (const name of lockNames(dataDir)) {
      try {
        NodeFS.unlinkSync(NodePath.join(gatesDir(dataDir), name));
        removed += 1;
      } catch {
        // Gone already, or not ours to remove: the count says what went.
      }
    }
    return removed;
  });

/** The names in a directory in name order; none when it cannot be read. */
const listNames = (dir: string): ReadonlyArray<string> => {
  try {
    return NodeFS.readdirSync(dir).sort();
  } catch {
    return [];
  }
};

/**
 * Removes a checkout, or whatever is at `dir`: a symlink is unlinked and never followed, here
 * and inside the directory. A checkout that is already gone is fine.
 */
const removeCheckout = (dir: string): Effect.Effect<void, WorkspaceCleanupError> =>
  Effect.tryPromise({
    // Asynchronous: a checkout with installed dependencies takes seconds to delete, and this
    // runs inside the server.
    try: async () => {
      let stat: NodeFS.Stats;
      try {
        stat = await NodeFS.promises.lstat(dir);
      } catch (error) {
        if (errnoCode(error) === "ENOENT") return;
        throw error;
      }
      if (stat.isDirectory()) await NodeFS.promises.rm(dir, { recursive: true, force: true });
      else await NodeFS.promises.unlink(dir);
    },
    catch: (cause) => new WorkspaceCleanupError({ what: `${dir}: ${causeText(cause)}` }),
  });

/**
 * What is under the run's gate directory, in name order. While no gate runs for the run, every
 * entry is a checkout of a call the server died in.
 */
export const leftoverCheckouts = (dataDir: string, run: RunId): ReadonlyArray<string> =>
  listNames(gateRoot(dataDir, run));

/**
 * Removes every entry under a run's gate directory `root`, in name order, as the gate removes its
 * own checkout. `failed` is called with each one that is still there and the error the gate's
 * `gate_cleanup_failed` line records; the caller decides whether to write the line. The gate calls
 * this before each checkout, and `regate` before it reads anything.
 */
export const removeLeftoverCheckouts = Effect.fn("FactoryGate.removeLeftoverCheckouts")(function* <
  E,
>(root: string, failed: (dir: string, error: string) => Effect.Effect<void, E>) {
  for (const name of listNames(root)) {
    const dir = NodePath.join(root, name);
    const removed = yield* Effect.result(removeCheckout(dir));
    if (Result.isFailure(removed)) yield* failed(dir, removed.failure.message);
  }
});

/** Removes a run's gate directory `root` when it is empty. */
export const removeEmptyGateRoot = (root: string): Effect.Effect<void> =>
  Effect.sync(() => {
    try {
      NodeFS.rmdirSync(root);
    } catch {
      // Not empty, or already gone.
    }
  });

const exists = (path: string): boolean => {
  try {
    NodeFS.lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

type LockOutcome =
  | { readonly _tag: "held"; readonly file: string }
  | { readonly _tag: "running" }
  | { readonly _tag: "queued"; readonly running: number; readonly max: number };

const acquireLock = (
  dataDir: string,
  file: string,
  max: number,
): Effect.Effect<LockOutcome, WorkspaceIoError> =>
  Effect.try({
    try: (): LockOutcome => {
      NodeFS.mkdirSync(gatesDir(dataDir), { recursive: true, mode: 0o700 });
      if (exists(file)) return { _tag: "running" };
      const running = gateLocksHeld(dataDir);
      if (running >= max) return { _tag: "queued", running, max };
      try {
        NodeFS.closeSync(
          NodeFS.openSync(
            file,
            NodeFS.constants.O_CREAT | NodeFS.constants.O_EXCL | NodeFS.constants.O_WRONLY,
            0o600,
          ),
        );
      } catch (error) {
        if (errnoCode(error) === "EEXIST") return { _tag: "running" };
        throw error;
      }
      return { _tag: "held", file };
    },
    catch: (cause) => new WorkspaceIoError({ path: file, cause }),
  });

const releaseLock = (outcome: LockOutcome) =>
  Effect.sync(() => {
    if (outcome._tag !== "held") return;
    try {
      NodeFS.unlinkSync(outcome.file);
    } catch {
      // Already gone.
    }
  });

type Runner = {
  readonly run: (input: RunInput) => Effect.Effect<RunResult, RunSpawnError>;
};

interface GitCall {
  /** Options after the hardening and before the subcommand. */
  readonly pre?: ReadonlyArray<string>;
  readonly args: ReadonlyArray<string>;
  readonly timeoutMs: number;
  /** The fetch from the remote: it is the only call that gets credentials. */
  readonly fetch?: boolean;
  /** Its stdout is read, so output cut at the cap is refused. The other calls' output is only shown. */
  readonly parsed?: boolean;
}

/**
 * An `owner/name` of plain characters: both parts non-empty, not `.` or `..`, not starting with
 * `-` (it would be an option), and only `[A-Za-z0-9._-]`.
 */
const isRepoName = (text: string): boolean => {
  const parts = text.split("/");
  return (
    parts.length === 2 &&
    parts.every(
      (part) =>
        part !== "" &&
        part !== "." &&
        part !== ".." &&
        !part.startsWith("-") &&
        /^[A-Za-z0-9._-]+$/.test(part),
    )
  );
};

const sameCommit = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

const lines = (text: string): ReadonlyArray<string> => {
  const all = text.split("\n").map((line) => line.replace(/\r$/, ""));
  if (all.at(-1) === "") all.pop();
  return all;
};

const unexpected = (what: string) => new WorkspaceUnexpectedError({ what });

/**
 * The gate's checkout, merge and removal through `git`, in a repository of its own. The fetch URL
 * is built here, never read from git config, so nothing a session writes in its repository reaches
 * it. Git runs with no system or global config, hooks, fsmonitor, eol conversion or `ext`
 * transport; only the fetch gets credentials. A session as the same OS user can still read ours.
 */
export const makeWorkspace = (runner: Runner, options: GateOptions = {}) => {
  const remoteBase = (options.remoteBase ?? DEFAULT_REMOTE_BASE).replace(/\/+$/, "");
  const gitTimeoutMs = options.gitTimeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
  const gitTailBytes = options.gitTailBytes ?? GIT_TAIL_BYTES;
  const checkoutTimeoutMs = options.checkoutTimeoutMs ?? DEFAULT_CHECKOUT_TIMEOUT_MS;
  const fetchRetryDelaysMs = options.fetchRetryDelaysMs ?? FETCH_RETRY_DELAYS_MS;
  const fileTransport = remoteBase.startsWith("file://") ? "always" : "never";
  const hardening = configFlags([...HARDENED_GIT_CONFIG, `protocol.file.allow=${fileTransport}`]);

  const gitEnv = (fetch: boolean): Record<string, string> => {
    const env: Record<string, string> = { ...HARDENED_GIT_ENV };
    if (fetch) {
      for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "XDG_CONFIG_HOME"]) {
        const value = globalThis.process.env[name];
        if (value !== undefined) env[name] = value;
      }
      const ghConfigDir = options.ghConfigDir ?? globalThis.process.env.GH_CONFIG_DIR;
      if (ghConfigDir !== undefined) env.GH_CONFIG_DIR = ghConfigDir;
    }
    return { ...env, ...options.env };
  };

  /** One git call in `dir`: its output when it exits 0, else the failure. */
  const git = (dir: string, call: GitCall): Effect.Effect<string, WorkspaceError> =>
    runner
      .run({
        command: "git",
        args: [...hardening, ...(call.pre ?? []), ...call.args],
        shell: false,
        cwd: dir,
        env: gitEnv(call.fetch === true),
        timeoutMs: call.timeoutMs,
        tailBytes: gitTailBytes,
        // What git prints on stdout is data to parse; its stderr (warnings) only explains a failure.
        separateStderr: true,
      })
      .pipe(
        Effect.mapError((error) => new WorkspaceSpawnError({ cause: error.cause })),
        Effect.flatMap((result): Effect.Effect<string, WorkspaceError> => {
          const failed = (status: number | null, stderr: string) =>
            Effect.fail(new WorkspaceFailedError({ args: call.args.join(" "), status, stderr }));
          if (result.timedOut) {
            return failed(null, `it did not finish within ${call.timeoutMs}ms and was killed`);
          }
          if (result.exitCode !== 0) return failed(result.exitCode, result.stderrTail);
          // Output cut at the cap would be parsed from a truncated front. A merge that prints a
          // line per file of a large base update is not parsed, so its size does not matter.
          if (call.parsed === true && result.truncated) {
            return Effect.fail(
              unexpected(`\`git ${call.args.join(" ")}\` printed more than ${gitTailBytes} bytes`),
            );
          }
          return Effect.succeed(result.tail);
        }),
      );

  const quick = (dir: string, args: ReadonlyArray<string>, pre?: ReadonlyArray<string>) =>
    git(dir, { args, timeoutMs: gitTimeoutMs, parsed: true, ...(pre && { pre }) });

  /** Exact: the files are the commit's only when nothing is modified, deleted, untracked or ignored. */
  const checkTree = (dir: string) =>
    quick(
      dir,
      [
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
        "--ignored",
        "--ignore-submodules=none",
      ],
      ["--no-optional-locks"],
    ).pipe(
      Effect.flatMap((status) =>
        status.length === 0
          ? Effect.void
          : Effect.fail(
              unexpected(
                `the checkout is not exactly the commit: ${lines(status)
                  .slice(0, 5)
                  .map((line) => sanitize(line, false))
                  .join("; ")}`,
              ),
            ),
      ),
    );

  const isNotAncestor = (error: WorkspaceError) =>
    error._tag === "WorkspaceFailedError" && error.status === 1;

  const checkoutIn = Effect.fn("FactoryGate.checkoutIn")(function* (
    repo: string,
    sha: string,
    base: string,
    dir: string,
  ) {
    // No template: nothing is copied into `.git`, hooks included.
    yield* git(dir, { args: ["init", "--quiet", "--template="], timeoutMs: checkoutTimeoutMs });
    // The commits come into the new object store and nothing else changes: no ref, no
    // FETCH_HEAD, no tags, no submodules. The URL is the gate's, not git config's.
    // HTTP/1.1, because the HTTP/2 framing layer is what a flaky link breaks first.
    const fetch = git(dir, {
      pre: [
        "-c",
        "credential.helper=",
        "-c",
        "credential.helper=!gh auth git-credential",
        "-c",
        "http.version=HTTP/1.1",
      ],
      args: [
        "fetch",
        "--no-tags",
        "--no-recurse-submodules",
        "--no-write-fetch-head",
        `${remoteBase}/${repo}.git`,
        sha,
        ...(base === sha ? [] : [base]),
      ],
      timeoutMs: checkoutTimeoutMs,
      fetch: true,
    });
    for (let tried = 1; ; tried += 1) {
      const fetched = yield* Effect.result(fetch);
      if (Result.isSuccess(fetched)) break;
      const error = fetched.failure;
      const reason =
        error._tag === "WorkspaceFailedError" ? TRANSIENT_FETCH.exec(error.stderr)?.[0] : undefined;
      if (
        error._tag !== "WorkspaceFailedError" ||
        reason === undefined ||
        tried >= FETCH_ATTEMPTS
      ) {
        return yield* error;
      }
      const wait = fetchRetryDelaysMs[tried - 1] ?? 0;
      const delayMs = wait + (yield* Random.nextIntBetween(0, Math.min(1000, wait)));
      yield* Effect.logInfo(
        `\`git ${error.args}\` attempt ${tried} of ${FETCH_ATTEMPTS} failed (${reason}); trying again in ${(delayMs / 1000).toFixed(1)} s`,
      );
      yield* Effect.sleep(delayMs);
    }
    yield* git(dir, {
      args: ["checkout", "--quiet", "--detach", "--no-recurse-submodules", sha],
      timeoutMs: checkoutTimeoutMs,
    });
    const head = (yield* quick(dir, ["rev-parse", "HEAD"])).trim();
    if (!isCommitId(head)) return yield* unexpected("`rev-parse HEAD` did not print a commit id");
    // Fetched by its id, so this is git doing something it should not.
    if (!sameCommit(head, sha)) {
      return yield* unexpected(`the checkout is at ${head} but the pull request's head is ${sha}`);
    }
    yield* checkTree(dir);

    // Merge the base tip into the head, unless it is in the head already. Exit status 1 is
    // "not an ancestor".
    const ancestor = yield* Effect.result(
      quick(dir, ["merge-base", "--is-ancestor", base, "HEAD"]),
    );
    if (Result.isSuccess(ancestor))
      return { head, merge: { _tag: "contained" } } satisfies Checkout;
    if (!isNotAncestor(ancestor.failure)) return yield* ancestor.failure;

    // The gate's identity, no signing, `--no-ff` so that the head is always the first parent
    // (a head behind the base would otherwise fast-forward to the base), and no editor.
    const merged = yield* Effect.result(
      git(dir, {
        pre: [
          "-c",
          "user.name=softfac",
          "-c",
          "user.email=softfac@localhost",
          "-c",
          "commit.gpgsign=false",
        ],
        args: ["merge", "--no-ff", "--no-edit", base],
        timeoutMs: checkoutTimeoutMs,
      }),
    );
    if (Result.isFailure(merged)) {
      // Exit status 1 is a conflict when git names conflicted files. Anything else that fails
      // (unrelated histories, say) is the failure itself.
      if (!isNotAncestor(merged.failure)) return yield* merged.failure;
      const listed = yield* quick(dir, ["diff", "--name-only", "--diff-filter=U", "-z"]);
      const paths = listed.split("\0").filter((path) => path !== "");
      if (paths.length === 0) return yield* merged.failure;
      // Leave the tree as the head's. The caller removes the directory anyway.
      yield* Effect.ignore(quick(dir, ["merge", "--abort"]));
      return { head, merge: { _tag: "conflict", paths } } satisfies Checkout;
    }
    // The merge commit must hold exactly the head and the base, in that order.
    const [first = "", second = ""] = lines(
      yield* quick(dir, ["rev-parse", "HEAD^1", "HEAD^2"]),
    ).map((line) => line.trim());
    if (!sameCommit(first, head) || !sameCommit(second, base)) {
      return yield* unexpected(
        `the merge commit's parents are ${first} and ${second}, not the head and the base`,
      );
    }
    yield* checkTree(dir);
    return { head, merge: { _tag: "merged" } } satisfies Checkout;
  });

  const remove = removeCheckout;

  /**
   * Makes a standalone repository in `dir` (which should not exist yet), fetches `sha` and `base`
   * by full id, checks `sha` out detached and merges `base` into it. A conflict is not an error:
   * the merge is aborted and the paths are returned. On any error nothing is left behind.
   */
  const checkout = Effect.fn("FactoryGate.checkout")(function* (
    repo: string,
    sha: string,
    base: string,
    dir: string,
  ) {
    // The ids and the repo go to git as arguments, so they must be nothing but commit ids and
    // an `owner/name`: a name starting with `-` would be an option.
    if (!isCommitId(sha) || !isCommitId(base)) {
      return yield* unexpected("the commits to check out are not full commit ids");
    }
    if (!isRepoName(repo)) return yield* unexpected("the repo is not an owner and a name");
    yield* Effect.try({
      try: () => NodeFS.mkdirSync(dir, { recursive: true, mode: 0o700 }),
      catch: (cause) => new WorkspaceIoError({ path: dir, cause }),
    });
    return yield* checkoutIn(repo, sha, base, dir).pipe(
      // Leave nothing half made.
      Effect.onExit((exit) => (Exit.isFailure(exit) ? Effect.ignore(remove(dir)) : Effect.void)),
    );
  });

  return { checkout, remove };
};

const runGate = (runner: Runner, input: GateInput): Effect.Effect<GateResult, GateError> => {
  const options = input.options ?? {};
  const { dataDir, run, attempt } = input;
  const workspace = makeWorkspace(runner, options);

  const underLock = Effect.gen(function* () {
    const root = yield* ledgerCall(() => gateRoot(dataDir, run));
    const dir = NodePath.join(root, String(attempt));

    const withLedger = <A, E>(use: (ledger: Ledger) => Effect.Effect<A, E>) =>
      Effect.acquireUseRelease(
        ledgerCall(() =>
          Ledger.open(dataDir, run, {
            ...(options.clock && { clock: options.clock }),
            ...(options.ledgerIo && { io: options.ledgerIo }),
          }),
        ),
        use,
        (ledger) =>
          Effect.sync(() => {
            try {
              ledger.close();
            } catch {
              // Already closed.
            }
          }),
      );

    return yield* withLedger((ledger) =>
      Effect.gen(function* () {
        const append = (...args: Parameters<Ledger["append"]>) =>
          ledgerCall(() => ledger.append(...args));

        yield* Effect.try({
          try: () => NodeFS.mkdirSync(root, { recursive: true, mode: 0o700 }),
          catch: (cause) => new WorkspaceIoError({ path: root, cause }),
        });

        // Anything under the root is a leftover of a call the server died in. One that cannot be
        // removed is noted once per directory, and is tried again by the next call.
        let noted: ReadonlySet<string> | undefined;
        const removeLeftovers = removeLeftoverCheckouts(root, (leftover, error) =>
          Effect.gen(function* () {
            noted ??= new Set(
              (yield* ledgerCall(() => readRun(dataDir, run))).entries.flatMap((entry) =>
                entry.event === "gate_cleanup_failed" &&
                typeof entry.data === "object" &&
                entry.data !== null &&
                "dir" in entry.data &&
                typeof entry.data.dir === "string"
                  ? [entry.data.dir]
                  : [],
              ),
            );
            if (noted.has(leftover)) return;
            yield* append(
              { event: "gate_cleanup_failed", data: { dir: leftover, error } },
              makeCause("gate", "gate-cleanup-failed"),
            );
          }),
        );

        // After the checkout made `dir`, on every path out: remove it, and note it in the ledger
        // when that fails. The result of the attempt stands either way.
        const cleanup = Effect.gen(function* () {
          const removed = yield* Effect.result(workspace.remove(dir));
          if (Result.isFailure(removed)) {
            yield* Effect.ignore(
              append(
                { event: "gate_cleanup_failed", data: { dir, error: removed.failure.message } },
                makeCause("gate", "gate-cleanup-failed", { attempt }),
              ),
            );
          }
        });

        // Whether the ledger holds a `gate_command` line of this attempt, so its summary counts it.
        const ledgerCountsAttempt = ledgerCall(() => readRun(dataDir, run)).pipe(
          Effect.map((record) =>
            record.entries.some(
              (entry) =>
                entry.event === "gate_command" &&
                typeof entry.data === "object" &&
                entry.data !== null &&
                "attempt" in entry.data &&
                entry.data.attempt === attempt,
            ),
          ),
          Effect.orElseSucceed(() => false),
        );

        // The attempt's `gate_command` lines, appended one at a time (the ledger has no batch).
        // When an append fails once the ledger counts the attempt (an earlier line went in, or
        // the failed one did: a failed sync leaves the line in the file), the attempt is used and
        // the failure is a GateRecordError; otherwise it is the ledger's own error.
        const appendCommandLines = Effect.fn("FactoryGate.appendCommandLines")(function* (
          lines: ReadonlyArray<{
            readonly command: string;
            readonly exitCode: number;
            readonly durationMs: number;
            readonly cause: Parameters<Ledger["append"]>[1];
          }>,
        ) {
          let written = 0;
          for (const line of lines) {
            const appended = yield* Effect.result(
              append(
                {
                  event: "gate_command",
                  data: {
                    attempt,
                    command: line.command,
                    exit_code: line.exitCode,
                    duration_ms: line.durationMs,
                  },
                },
                line.cause,
              ),
            );
            if (Result.isSuccess(appended)) {
              written += 1;
              continue;
            }
            const used = written > 0 || (yield* ledgerCountsAttempt);
            return yield* used
              ? new GateRecordError({ attempt, cause: appended.failure })
              : appended.failure;
          }
        });

        // The lines go in once the commands have ended in a pass or a fail, never on an error path:
        // an attempt that errors (a command that cannot start, a ledger failure) used none,
        // unless the ledger already counts it (see `appendCommandLines`).
        const record = (outcome: Extract<GateResult, { readonly _tag: "pass" | "fail" }>) =>
          appendCommandLines(
            outcome.commands.map((result) => ({
              command: result.command,
              exitCode: result.exitCode,
              durationMs: result.durationMs,
              cause: makeCause("gate", "gate-command-ran", { command: result.command, attempt }),
            })),
          ).pipe(Effect.as(outcome));

        const runCommands = Effect.gen(function* () {
          const commands: Array<CommandResult> = [];
          const all = [
            ...input.provision.map((command) => ({ command, provision: true })),
            ...input.gate.map((command) => ({ command, provision: false })),
          ];
          let gateCount = 0;
          for (const { command, provision } of all) {
            const started = yield* Clock.currentTimeMillis;
            const ran = yield* runner
              .run({
                command,
                shell: true,
                cwd: dir,
                timeoutMs: options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
                niceness: COMMAND_NICENESS,
              })
              .pipe(
                Effect.mapError(
                  (error) => new GateCommandSpawnError({ command, cause: error.cause }),
                ),
              );
            const ended = yield* Clock.currentTimeMillis;
            const timeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
            const result: CommandResult = {
              command,
              exitCode: ran.timedOut || ran.exitCode === null ? -1 : ran.exitCode,
              durationMs: Math.max(0, ended - started),
              timedOut: ran.timedOut,
              output: ran.tail,
              ...(ran.timedOut && { timeoutMs }),
              ...(ran.truncated && { truncated: true }),
            };
            commands.push(result);
            if (!provision) gateCount += 1;
            if (result.exitCode !== 0 || result.timedOut) {
              return yield* record({ _tag: "fail", dir, commands, failure: result, gateCount });
            }
          }
          return yield* record({ _tag: "pass", dir, commands, gateCount });
        });

        // How long the attempt took, from the start of its checkout to the end of its last
        // command or of its aborted merge, for the run log. The attempt is decided by then, so
        // a line that cannot be written changes nothing: the result stands without it.
        const recordTime = Effect.fn("FactoryGate.recordTime")(function* (startedMs: number) {
          const endedMs = yield* Clock.currentTimeMillis;
          yield* Effect.ignore(
            append(
              {
                event: "gate_finished",
                data: { attempt, total_ms: Math.max(0, endedMs - startedMs) },
              },
              makeCause("gate", "gate-finished", { attempt }),
            ),
          );
        });

        const attemptInDir = Effect.gen(function* () {
          yield* removeLeftovers;
          // A leftover that could not be removed is in the way of this attempt: a fault of this
          // machine and not of the pull request.
          if (exists(dir)) {
            return yield* new WorkspaceCleanupError({
              what: `${dir} is still there from an earlier call`,
            });
          }
          const startedMs = yield* Clock.currentTimeMillis;
          const made = yield* workspace.checkout(input.repo, input.head, input.base, dir);
          return yield* Effect.gen(function* () {
            // Where the attempt runs and on which commits goes into the ledger before the
            // commands start, so a server that dies in them leaves a record of the directory.
            yield* append(
              {
                event: "gate_checkout",
                data: { attempt, dir, sha: input.head, base_sha: input.base },
              },
              makeCause("gate", "gate-checkout-made", { attempt }),
            );
            if (made.merge._tag === "conflict") {
              // Nothing runs, and the line counts the attempt in the ledger's summary.
              yield* appendCommandLines([
                {
                  command: MERGE_COMMAND,
                  exitCode: 1,
                  durationMs: 0,
                  cause: makeCause("gate", "gate-merge-conflict", { attempt }),
                },
              ]);
              return { _tag: "conflict", dir, paths: made.merge.paths } satisfies GateResult;
            }
            return yield* runCommands;
          }).pipe(
            Effect.tap(() => recordTime(startedMs)),
            Effect.ensuring(cleanup),
          );
        });

        // Only an empty root goes.
        return yield* attemptInDir.pipe(Effect.ensuring(removeEmptyGateRoot(root)));
      }),
    );
  });

  return Effect.gen(function* () {
    const lock = yield* ledgerCall(() => gateLockFile(dataDir, run));
    return yield* Effect.acquireUseRelease(
      acquireLock(dataDir, lock, input.maxConcurrentGates),
      (outcome): Effect.Effect<GateResult, GateError> =>
        outcome._tag === "held" ? underLock : Effect.succeed(outcome),
      releaseLock,
    );
  });
};

/** Callers depend on this tag, so their tests can swap in a fake that runs no gate. */
export class FactoryGate extends Context.Service<
  FactoryGate,
  { readonly run: (input: GateInput) => Effect.Effect<GateResult, GateError> }
>()("t3/factory/gate/FactoryGate") {}

export const layer: Layer.Layer<FactoryGate, never, FactoryProcess> = Layer.effect(
  FactoryGate,
  Effect.gen(function* () {
    const runner = yield* FactoryProcess;
    return FactoryGate.of({
      run: Effect.fn("FactoryGate.run")(function (input) {
        return runGate(runner, input);
      }),
    });
  }),
);
