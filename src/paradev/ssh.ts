/**
 * The runner's one way onto a Paradev host: `ssh` with `BatchMode=yes` and `ConnectTimeout=10`, so
 * a host that wants a password or does not answer fails at once instead of hanging a pass. The
 * adapter uses it for a host's base check, its process lookup and its session listing; the host
 * readings of #54 reuse it.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { FactoryProcess, RunResult } from "../process.ts";

/** The options every call passes: no prompt for a password or a host key, and a 10 s connect. */
export const SSH_OPTIONS: ReadonlyArray<string> = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10"];

/** ssh's own exit code for a failure of its own: no connection, a refused key, a lost link. */
const SSH_FAILED = 255;

const DEFAULT_TIMEOUT_MS = 10_000;

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
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
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
