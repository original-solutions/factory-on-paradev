// @effect-diagnostics nodeBuiltinImport:off - The factory runs commands as detached process groups, which Node's child_process exposes and ProcessRunner does not.
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";

/**
 * Runs commands the way softfac does: a known environment, a hard time limit that kills the whole
 * process tree, and only the end of the output kept. POSIX only: relies on /bin/sh, process groups
 * and negative-pid kill. `ProcessRunner` cannot do this (see factory/docs/design.md, open question
 * 2), so this imports no T3 code.
 */

/**
 * Names copied from the server's environment, besides `LC_*`. This is defence
 * in depth, not a sandbox: code running as the same user can still read the
 * token file and ~/.ssh.
 */
const INHERITED_ENV: ReadonlySet<string> = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "TMPDIR",
  "TERM",
]);

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_TAIL_BYTES = 16 * 1024;
const DEFAULT_TERM_GRACE_MS = 10_000;
/** A process that left the group may still hold the pipe; do not wait long for it. */
const DRAIN_WAIT_MS = 2_000;

/** The command itself is only in `cause`: in shell mode it is a whole script. */
export class RunSpawnError extends Schema.TaggedError<RunSpawnError>()("RunSpawnError", {
  shell: Schema.Boolean,
  cwd: Schema.optional(Schema.String),
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return this.shell ? "Failed to spawn a shell command." : "Failed to spawn a command.";
  }
}

export interface RunInput {
  readonly command: string;
  readonly args?: ReadonlyArray<string>;
  /** Run `command` as a /bin/sh script; `args` become its positional parameters ($0, $1, …). */
  readonly shell?: boolean;
  readonly cwd?: string;
  /** Added after the inherited allowlist; may override an inherited name. */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Names copied from the server's environment in place of the default allowlist, with no
   * `LC_*`. For a command that must see a narrower environment than a gate does.
   */
  readonly inheritEnv?: ReadonlyArray<string>;
  /** Default 30 minutes (softfac's gate default). */
  readonly timeoutMs?: number;
  /** Default 16 KiB. */
  readonly tailBytes?: number;
  /** The cap for `stderrTail` when `separateStderr` is set. Default `tailBytes`. */
  readonly stderrTailBytes?: number;
  /** How long after SIGTERM to send SIGKILL. Default 10_000. Exists so a test can be fast. */
  readonly termGraceMs?: number;
  /**
   * Keep stderr apart from stdout: stdout alone is `tail`, stderr is `stderrTail`.
   * Default false, which merges both into `tail` in order. For commands whose
   * stdout is data (gh's JSON) that stderr text must not end up in.
   */
  readonly separateStderr?: boolean;
  /**
   * Run the command, and everything it starts, at this niceness, so it cannot starve the
   * server. A process already nicer keeps its own. Unset: the server's priority.
   */
  readonly niceness?: number;
  /**
   * Append every stdout and stderr chunk to this file as it arrives, in arrival order, besides
   * keeping the tails. The directory must exist. A file that cannot be opened or written costs a
   * warning at most: the command still runs and its result does not change.
   */
  readonly logFile?: string;
}

export interface RunResult {
  /**
   * Node's exit code; null when the process ended by a signal. A command that
   * handles the timeout's SIGTERM can still exit with a code, even 0, so check
   * `timedOut` first.
   */
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  /**
   * The last `tailBytes` of stdout and stderr interleaved, decoded as UTF-8; of
   * stdout alone when `separateStderr` was set.
   */
  readonly tail: string;
  /** The last `stderrTailBytes` of stderr; "" unless `separateStderr` was set. */
  readonly stderrTail: string;
  /** True when a tail dropped bytes, i.e. the output was longer than its cap. */
  readonly truncated: boolean;
  /** True when `tail` itself dropped bytes; a cut `stderrTail` does not count. */
  readonly tailTruncated: boolean;
}

/**
 * Keeps the end of a byte stream. Chunks are joined only to trim or finish, so a large cap costs
 * one copy per doubling, not one per chunk. Memory stays under about twice the cap: the front is
 * dropped down to the cap only once the kept bytes pass twice it.
 */
class Tail {
  private chunks: Array<Buffer> = [];
  private length = 0;
  private dropped = false;

  private readonly cap: number;

  constructor(cap: number) {
    this.cap = cap;
  }

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.length += chunk.length;
    if (this.length > 2 * this.cap) this.trim();
  }

  get truncated(): boolean {
    return this.dropped || this.length > this.cap;
  }

  finish(): string {
    const buf = this.trim();
    let start = 0;
    // A cut inside a character loses that character instead of becoming U+FFFD.
    if (this.dropped) {
      while (start < buf.length && (buf[start]! & 0xc0) === 0x80) start++;
    }
    return new TextDecoder().decode(buf.subarray(start));
  }

  private trim(): Buffer {
    let buf = Buffer.concat(this.chunks, this.length);
    if (buf.length > this.cap) {
      // A copy, so the kept end does not hold the whole joined buffer alive.
      buf = Buffer.from(buf.subarray(buf.length - this.cap));
      this.dropped = true;
    }
    this.chunks = [buf];
    this.length = buf.length;
    return buf;
  }
}

/**
 * The LaunchAgent exports its PATH (`~/.config/t3fac/env` included) as `T3FAC_LAUNCH_PATH`;
 * `fixPath` then puts the login shell's PATH ahead of it, where `/usr/bin` can shadow the
 * interpreter the env file names. Children get the launch entries first. Unset: PATH as is.
 */
const buildChildPath = (launchPath: string | undefined, serverPath: string): string => {
  if (launchPath === undefined) return serverPath;
  const entries: Array<string> = [];
  for (const entry of [...launchPath.split(":"), ...serverPath.split(":")]) {
    if (entry !== "" && !entries.includes(entry)) entries.push(entry);
  }
  return entries.join(":");
};

const buildEnv = (
  extra: Readonly<Record<string, string>> | undefined,
  inherit: ReadonlyArray<string> | undefined,
): Record<string, string> => {
  const only = inherit === undefined ? null : new Set(inherit);
  const inherited = (name: string): boolean =>
    only === null ? INHERITED_ENV.has(name) || name.startsWith("LC_") : only.has(name);
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(globalThis.process.env)) {
    if (value === undefined) continue;
    if (inherited(name)) env[name] = value;
  }
  if (env.PATH !== undefined) {
    env.PATH = buildChildPath(globalThis.process.env.T3FAC_LAUNCH_PATH, env.PATH);
  }
  return { ...env, ...extra };
};

const run = Effect.fn("FactoryProcess.run")(function* (input: RunInput) {
  const args = input.args ?? [];
  const separate = input.separateStderr === true;
  const tail = new Tail(input.tailBytes ?? DEFAULT_TAIL_BYTES);
  const stderrTail = new Tail(input.stderrTailBytes ?? input.tailBytes ?? DEFAULT_TAIL_BYTES);

  // By default one pipe for both streams: Node cannot hand one pipe to two
  // fds, so the wrapper shell merges stderr into stdout. With separateStderr
  // there are two pipes and no merge. /bin/sh is absolute because the caller
  // may override PATH.
  const merge = separate ? "" : "exec 2>&1\n";
  // With a niceness the wrapper waits for stdin to close, which happens once its priority is
  // set, so nothing it starts can fork at the server's priority first.
  const nice = input.niceness !== undefined;
  const hold = nice ? "read -r _\nexec </dev/null\n" : "";
  const script = input.shell
    ? ["-c", `${merge}${hold}${input.command}`, ...args]
    : ["-c", `${merge}${hold}exec "$0" "$@"`, input.command, ...args];

  // Best effort: a log that cannot be opened or written never fails the command.
  let logFd: number | null = null;
  if (input.logFile !== undefined) {
    try {
      logFd = NodeFS.openSync(input.logFile, "a");
    } catch (cause) {
      yield* Effect.logWarning(
        `could not open the log file ${input.logFile}: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }
  const log = (chunk: Buffer): void => {
    if (logFd === null) return;
    try {
      NodeFS.writeSync(logFd, chunk);
    } catch {
      closeLog();
    }
  };
  function closeLog(): void {
    if (logFd === null) return;
    const fd = logFd;
    logFd = null;
    try {
      NodeFS.closeSync(fd);
    } catch {
      // Nothing is left to lose.
    }
  }

  const exited = Deferred.makeUnsafe<
    readonly [number | null, NodeJS.Signals | null],
    RunSpawnError
  >();
  const closed = Deferred.makeUnsafe<void>();
  const stderrClosed = Deferred.makeUnsafe<void>();

  const spawnError = (cause: unknown) =>
    new RunSpawnError({ shell: input.shell === true, cwd: input.cwd, cause });

  // Acquire is uninterruptible, so an interrupt can never land between the
  // spawn and the cleanup that kills the group. Spawn reports some failures
  // by throwing (a NUL byte in env or args) and others by an 'error' event.
  const acquire = Effect.try({
    try: () => {
      const child = NodeChildProcess.spawn("/bin/sh", script, {
        cwd: input.cwd,
        env: buildEnv(input.env, input.inheritEnv),
        stdio: [nice ? "pipe" : "ignore", "pipe", separate ? "pipe" : "ignore"],
        detached: true,
      });
      // A wrapper that died early closes the pipe; the write then fails and nothing is lost.
      child.stdin?.on("error", () => {});
      child.once("error", (cause) => Deferred.doneUnsafe(exited, Exit.fail(spawnError(cause))));
      child.once("exit", (code, signal) =>
        Deferred.doneUnsafe(exited, Exit.succeed([code, signal] as const)),
      );
      child.stdout?.on("data", (chunk: Buffer) => {
        tail.push(chunk);
        log(chunk);
      });
      child.stdout?.once("close", () => Deferred.doneUnsafe(closed, Exit.void));
      // No stdout (spawn failed): nothing to drain.
      if (!child.stdout) Deferred.doneUnsafe(closed, Exit.void);
      child.stderr?.on("data", (chunk: Buffer) => {
        stderrTail.push(chunk);
        log(chunk);
      });
      child.stderr?.once("close", () => Deferred.doneUnsafe(stderrClosed, Exit.void));
      if (!child.stderr) Deferred.doneUnsafe(stderrClosed, Exit.void);
      return child;
    },
    catch: spawnError,
  });

  // Signals the group, and the leader too in case it left the group (softfac's kill_all).
  const killGroup = (child: NodeChildProcess.ChildProcess, signal: NodeJS.Signals): void => {
    const pid = child.pid;
    if (pid === undefined) return;
    try {
      globalThis.process.kill(-pid, signal);
    } catch {
      // ESRCH: the group is already gone.
    }
    try {
      child.kill(signal);
    } catch {
      // The leader is already gone.
    }
  };

  // Runs on every exit path; after a normal run both calls are no-ops.
  const release = (child: NodeChildProcess.ChildProcess) =>
    Effect.sync(() => {
      killGroup(child, "SIGKILL");
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
    });

  // Lowers the wrapper's priority, then lets it go on. Failing to lower it only costs the
  // server some CPU, so the command runs anyway.
  const lowerPriority = (child: NodeChildProcess.ChildProcess, niceness: number) =>
    Effect.try({
      try: () => {
        const pid = child.pid;
        if (pid !== undefined && NodeOS.getPriority(pid) < niceness) {
          NodeOS.setPriority(pid, niceness);
        }
      },
      catch: String,
    }).pipe(
      Effect.catch((message) =>
        Effect.logWarning(`could not run a command at niceness ${niceness}: ${message}`),
      ),
      Effect.ensuring(Effect.sync(() => child.stdin?.end())),
    );

  const use = Effect.fn("FactoryProcess.use")(function* (child: NodeChildProcess.ChildProcess) {
    if (input.niceness !== undefined) yield* lowerPriority(child, input.niceness);
    const pid = child.pid;
    // Like softfac's group_exists: signal 0 throws ESRCH once the group is empty.
    const groupExists = (): boolean => {
      if (pid === undefined) return false;
      try {
        globalThis.process.kill(-pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    // In shell mode the leader is the wrapper sh, which dies on SIGTERM
    // before the real command; the grace lasts until the group is empty.
    const groupGone = Effect.gen(function* () {
      while (!(yield* Deferred.isDone(exited)) || groupExists()) {
        yield* Effect.sleep("50 millis");
      }
    });

    let timedOut = false;
    const outcome = yield* Deferred.await(exited).pipe(
      Effect.timeoutOption(input.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    );
    if (outcome._tag === "None") {
      timedOut = true;
      killGroup(child, "SIGTERM");
      yield* groupGone.pipe(Effect.timeoutOption(input.termGraceMs ?? DEFAULT_TERM_GRACE_MS));
      killGroup(child, "SIGKILL");
    }
    const [exitCode] = yield* Deferred.await(exited);

    // Kill whatever the command left in its group. This also closes pipe
    // ends a stray in the group still held; a process that left the group
    // (setsid, setpgid) escapes, and the drain wait below bounds it.
    killGroup(child, "SIGKILL");
    const drained = yield* Deferred.await(closed).pipe(
      Effect.andThen(Deferred.await(stderrClosed)),
      Effect.timeoutOption(DRAIN_WAIT_MS),
    );
    if (drained._tag === "None") {
      child.stdout?.destroy();
      child.stderr?.destroy();
    }

    const out = tail.finish();
    const err = stderrTail.finish();
    return {
      exitCode,
      timedOut,
      tail: out,
      stderrTail: err,
      truncated: tail.truncated || stderrTail.truncated,
      tailTruncated: tail.truncated,
    } satisfies RunResult;
  });

  return yield* Effect.acquireUseRelease(acquire, use, release).pipe(
    Effect.ensuring(Effect.sync(closeLog)),
  );
});

/** Callers depend on this tag, so their tests can swap in a fake that starts no process. */
export class FactoryProcess extends Context.Service<
  FactoryProcess,
  {
    readonly run: (input: RunInput) => Effect.Effect<RunResult, RunSpawnError>;
  }
>()("t3/factory/process/FactoryProcess") {}

export const layer = Layer.succeed(FactoryProcess, FactoryProcess.of({ run }));
