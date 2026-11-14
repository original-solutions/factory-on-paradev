/**
 * The runner's way onto a Paradev host: `ssh` with `BatchMode=yes` and `ConnectTimeout=10`, so a
 * host that wants a password or does not answer fails at once instead of hanging a pass.
 *
 * Two callers. The adapter (#53) runs its calls through `sshRunner`, which has no allowlist: it
 * sends whatever text the adapter builds (#67 gives it one). The host readings and `hosts check`
 * (#54) go through `runSsh`, which refuses any text that is not one of the read-only shapes below.
 * The runner writes nothing on a host (decision U4).
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { FactoryProcess, RunResult } from "../process.ts";

/** The options every call passes: no prompt for a password or a host key, and a 10 s connect. */
export const SSH_OPTIONS: ReadonlyArray<string> = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10"];

/** ssh's own exit code for a failure of its own: no connection, a refused key, a lost link. */
const SSH_FAILED = 255;

/** How long one ssh call may take, connect included. */
export const SSH_TIMEOUT_MS = 10_000;

/** An ssh call that did not reach the host, or did not end in time. */
export class SshError extends Schema.TaggedError<SshError>()("ParadevSshError", {
  destination: Schema.String,
  what: Schema.String,
}) {
  override get message(): string {
    return `ssh ${this.destination}: ${this.what}`;
  }
}

/**
 * Runs `command` on `destination` (`user@host`), as one line for the host's login shell, so the
 * caller quotes each word ({@link shellQuote}). The answer is the command's own exit code and
 * output; ssh's own failure, a timeout or a spawn error is `SshError`.
 */
export interface SshRunner {
  readonly run: (
    destination: string,
    command: string,
    options?: { readonly timeoutMs?: number },
  ) => Effect.Effect<RunResult, SshError>;
}

/** `value` as one word for `sh`: in single quotes, each `'` closed, escaped and reopened. */
export const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

/** The argv `ssh` gets for `command` on `destination`. */
export const sshArgs = (destination: string, command: string): ReadonlyArray<string> => [
  ...SSH_OPTIONS,
  "--",
  destination,
  command,
];

/** The real runner, over the runner's process service. */
export const sshRunner = (process: FactoryProcess["Service"]): SshRunner => ({
  run: (destination, command, options = {}) => {
    const timeoutMs = options.timeoutMs ?? SSH_TIMEOUT_MS;
    return process
      .run({ command: "ssh", args: sshArgs(destination, command), separateStderr: true, timeoutMs })
      .pipe(
        Effect.mapError((cause) => new SshError({ destination, what: cause.message })),
        Effect.flatMap((result) =>
          result.timedOut
            ? Effect.fail(new SshError({ destination, what: `no answer within ${timeoutMs / 1000} s` }))
            : result.exitCode === SSH_FAILED
              ? Effect.fail(new SshError({ destination, what: result.stderrTail.trim() || "ssh exited 255" }))
              : Effect.succeed(result),
        ),
      );
  },
});

/** What one `ssh` call came to: how it ended and what it printed. */
export interface SshAnswer {
  /** The process's exit code; null when it ended by a signal or never started. */
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs the `ssh` binary with these arguments. Never fails: a spawn error is a null exit code and its text. */
export type SshSpawn = (
  args: ReadonlyArray<string>,
  timeoutMs: number,
) => Effect.Effect<SshAnswer>;

/** What a synchronous command runner answers: the CLI's and install's, each wrapping `spawnSync`. */
export interface SyncCommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** A synchronous command runner; with `inheritEnv` the command gets only those names of the environment. */
export type SyncCommandRun = (
  command: string,
  args: ReadonlyArray<string>,
  timeoutMs: number,
  inheritEnv?: ReadonlyArray<string>,
) => SyncCommandResult;

/** The environment names `ssh` gets: enough to find the key, the agent socket included, and nothing else. */
export const SSH_ENV: ReadonlyArray<string> = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "TMPDIR", "SSH_AUTH_SOCK"];

/** Why a call gave no answer: the command was refused, ssh did not answer in time, or it failed. */
export interface SshReadError {
  readonly kind: "refused" | "timeout" | "failed";
  readonly message: string;
}

/** The host's load and core count: the text the spec gives, macOS first and Linux as the fallback. */
export const LOAD_COMMAND = "sysctl -n vm.loadavg hw.ncpu 2>/dev/null || (cat /proc/loadavg; nproc)";
/** Whether the host answers over ssh at all. */
export const TRUE_COMMAND = "true";
/** The `origin` URL of the clone at `path`. */
export const remoteUrl = (path: string): string => `git -C ${shellQuote(path)} remote get-url origin`;

/** Prints `yes` when `~/.claude.json` has the folder's trust dialog accepted, else `no`. */
export const TRUST_SCRIPT =
  'import json,os,sys;d=json.load(open(os.path.expanduser("~/.claude.json")));' +
  'p=d.get("projects",{}).get(sys.argv[1],{});' +
  'print("yes" if p.get("hasTrustDialogAccepted") is True else "no")';

/** Whether Claude Code trusts the folder at `path` on the host. */
export const trustRead = (path: string): string => `python3 -c '${TRUST_SCRIPT}' ${shellQuote(path)}`;

/** Prints, one per line, the proxy env names that are missing or empty in `~/.claude/settings.json`. Never a value. */
export const PROXY_ENV_SCRIPT =
  'import json,os;e=json.load(open(os.path.expanduser("~/.claude/settings.json"))).get("env",{});' +
  '[print(k) for k in ("ANTHROPIC_BASE_URL","ANTHROPIC_AUTH_TOKEN") if not e.get(k)]';

/** The proxy env names the host lacks. */
export const PROXY_ENV_READ = `python3 -c '${PROXY_ENV_SCRIPT}'`;

/** The host's git identity email. */
export const GIT_EMAIL = "git config --global user.email";
/** Whether the host's `gh` is logged in. */
export const GH_AUTH_STATUS = "gh auth status";
/** Whether Claude Code is installed on the host. */
export const CLAUDE_VERSION = "claude --version";

const escapeRegExp = (text: string): string => text.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** One shell word in single quotes, where `'\''` is a quote inside it. A backslash anywhere else is refused. */
const QUOTED = "'(?:[^'\\\\]|'\\\\'')*'";

const CONSTANTS: ReadonlySet<string> = new Set([
  LOAD_COMMAND,
  TRUE_COMMAND,
  PROXY_ENV_READ,
  GIT_EMAIL,
  GH_AUTH_STATUS,
  CLAUDE_VERSION,
]);

const SHAPES: ReadonlyArray<RegExp> = [
  new RegExp(`^git -C ${QUOTED} remote get-url origin$`),
  new RegExp(`^python3 -c '${escapeRegExp(TRUST_SCRIPT)}' ${QUOTED}$`),
];

/** Whether `command` is one of the shapes the runner may send to a host. */
export const isAllowed = (command: string): boolean =>
  CONSTANTS.has(command) || SHAPES.some((shape) => shape.test(command));

const firstLine = (text: string): string =>
  text.split("\n").map((line) => line.trim()).find((line) => line !== "") ?? "";

/**
 * Runs one allowed command on `destination` and answers its stdout. A command outside the
 * allowlist is refused before `run` is called.
 */
export const runSsh = (
  run: SshSpawn,
  destination: string,
  command: string,
): Effect.Effect<string, SshReadError> =>
  Effect.gen(function* () {
    if (!isAllowed(command)) {
      return yield* Effect.fail<SshReadError>({ kind: "refused", message: "the command is not one the runner may send to a host" });
    }
    const done = yield* run(sshArgs(destination, command), SSH_TIMEOUT_MS);
    if (done.timedOut) {
      return yield* Effect.fail<SshReadError>({
        kind: "timeout",
        message: `no answer within ${SSH_TIMEOUT_MS / 1000} s`,
      });
    }
    if (done.exitCode !== 0) {
      const why = firstLine(done.stderr);
      return yield* Effect.fail<SshReadError>({
        kind: "failed",
        message:
          done.exitCode === null
            ? `did not finish${why === "" ? "" : `: ${why}`}`
            : `exit ${done.exitCode}${why === "" ? "" : `: ${why}`}`,
      });
    }
    return done.stdout;
  });

/** The real runner: the `ssh` binary through the factory's process runner, with the agent socket kept in its environment. */
export const liveSshSpawn =
  (process: FactoryProcess["Service"]): SshSpawn =>
  (args, timeoutMs) =>
    process
      .run({
        command: "ssh",
        args,
        timeoutMs,
        separateStderr: true,
        termGraceMs: 2_000,
        inheritEnv: SSH_ENV,
      })
      .pipe(
        Effect.map(
          (done): SshAnswer => ({
            exitCode: done.exitCode,
            timedOut: done.timedOut,
            stdout: done.tail,
            stderr: done.stderrTail,
          }),
        ),
        Effect.catch((error) =>
          Effect.succeed<SshAnswer>({
            exitCode: null,
            timedOut: false,
            stdout: "",
            stderr: `${error.message}: ${String(error.cause)}`,
          }),
        ),
      );

/** A synchronous command runner (the CLI's and install's) as an `SshSpawn`: always `ssh`, with `SSH_ENV` only. */
export const fromCommandRunner =
  (run: SyncCommandRun): SshSpawn =>
  (args, timeoutMs) =>
    Effect.sync(() => {
      const done = run("ssh", args, timeoutMs, SSH_ENV);
      return {
        exitCode: done.status,
        timedOut: done.status === null && done.stderr.includes("ETIMEDOUT"),
        stdout: done.stdout,
        stderr: done.stderr,
      };
    });
