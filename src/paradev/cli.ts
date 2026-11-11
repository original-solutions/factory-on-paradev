/**
 * The only code that runs Paradev's `superset` CLI. It adds `--json` to every call, passes the CLI
 * a five-name environment, parses stdout as JSON on exit 0, and on a failure maps the CLI's
 * `Error: ` line to a {@link CliErrorKind}. Callers pass `--local` themselves: `snapshot`, `schema`
 * and `auth whoami` take none.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { FactoryProcess } from "../process.ts";

export const DEFAULT_CLI = "/Applications/Superset.app/Contents/Resources/resources/bin/superset";

/** All the CLI sees of the runner's environment. No `SUPERSET_API_KEY`. */
export const CLI_ENV: ReadonlyArray<string> = ["HOME", "PATH", "USER", "LANG", "TMPDIR"];

export const DEFAULT_TIMEOUT_MS = 30_000;
/** After a timeout's SIGTERM, how long the CLI's group has before SIGKILL. */
const TERM_GRACE_MS = 2_000;
/** Stdout longer than this is cut, and a cut answer cannot be parsed: `PARADEV_SHAPE`. */
const OUTPUT_CAP_BYTES = 64 * 1024 * 1024;
/** Stderr is only read for its `Error: ` line or a crash's last 2000 chars. */
const STDERR_CAP_BYTES = 64 * 1024;

export const CliErrorKind = Schema.Literals([
  "PARADEV_OFFLINE",
  "PARADEV_SIGNED_OUT",
  "PARADEV_PLAN",
  "PARADEV_SHAPE",
  "NOT_FOUND",
  "TRANSIENT",
  "AGENT_EXITED",
  "NO_TRANSCRIPT",
  "TOO_LARGE",
  "TIMEOUT",
  "UNKNOWN",
]);
export type CliErrorKind = typeof CliErrorKind.Type;

export class CliError extends Schema.TaggedError<CliError>()("ParadevCliError", {
  kind: CliErrorKind,
  /** The argv the runner passed, `--json` included, each long argument cut to its start. */
  argv: Schema.Array(Schema.String),
  /** The CLI's `Error: ` line, or what the runner saw instead. */
  text: Schema.String,
  /** The CLI's `Hint: ` line. */
  hint: Schema.NullOr(Schema.String),
}) {
  override get message(): string {
    return `superset ${this.argv.join(" ")} failed (${this.kind}): ${this.text}`;
  }
}

/** A prompt or a belt payload is an argument too; the error keeps only its start. */
const shorten = (arg: string): string =>
  arg.length > 80 ? `${arg.slice(0, 80)}…(${arg.length} chars)` : arg;

/** Matched in order against the start of the `Error: ` line. */
const KINDS: ReadonlyArray<readonly [prefix: string | RegExp, kind: CliErrorKind]> = [
  ["Host service for this machine isn't running", "PARADEV_OFFLINE"],
  ["Host service manifest is stale", "PARADEV_OFFLINE"],
  ["Not logged in", "PARADEV_SIGNED_OUT"],
  ["No active organization", "PARADEV_SIGNED_OUT"],
  ["Workspace not found on host ", "NOT_FOUND"],
  ["Could not connect to API", "TRANSIENT"],
  [/^Needs the .+ plan/, "PARADEV_PLAN"],
  ["No agent is running in terminal ", "AGENT_EXITED"],
  ["No transcript for that terminal", "NO_TRANSCRIPT"],
  ["A stored value is at most 65536 bytes", "TOO_LARGE"],
];

/** Reads a failed call's stderr: the first `Error: ` line, its kind, and the `Hint: ` after it. */
export const classify = (
  stderr: string,
): { readonly kind: CliErrorKind; readonly text: string; readonly hint: string | null } => {
  const lines = stderr.split("\n").map((line) => line.trimEnd());
  const at = lines.findIndex((line) => line.startsWith("Error: "));
  if (at === -1) {
    // A crash's stack trace can be long; its end says most.
    const text = lines.filter((line) => line !== "").join("\n").slice(-2000);
    return { kind: "UNKNOWN", text: text === "" ? "no error message" : text, hint: null };
  }
  const text = lines[at]!.slice("Error: ".length);
  const next = lines[at + 1];
  const hint = next?.startsWith("Hint: ") ? next.slice("Hint: ".length) : null;
  const found = KINDS.find(([prefix]) =>
    typeof prefix === "string" ? text.startsWith(prefix) : prefix.test(text),
  );
  return { kind: found?.[1] ?? "UNKNOWN", text, hint };
};

export interface CallOptions {
  /** Default {@link DEFAULT_TIMEOUT_MS}. Past it the CLI's whole process group is killed. */
  readonly timeoutMs?: number;
}

export class SupersetCli extends Context.Service<
  SupersetCli,
  {
    /** Runs `superset <argv> --json` and answers its parsed stdout. */
    readonly run: (
      argv: ReadonlyArray<string>,
      options?: CallOptions,
    ) => Effect.Effect<unknown, CliError>;
  }
>()("factory/paradev/cli/SupersetCli") {}

export interface CliConfig {
  /** `paradev.cli`; default {@link DEFAULT_CLI}. */
  readonly cli?: string;
}

export const layer = (config: CliConfig = {}): Layer.Layer<SupersetCli, never, FactoryProcess> =>
  Layer.effect(
    SupersetCli,
    Effect.gen(function* () {
      const runner = yield* FactoryProcess;
      const binary = config.cli ?? DEFAULT_CLI;
      return SupersetCli.of({
        run: Effect.fn("SupersetCli.run")(function* (argv, options) {
          const args = [...argv, "--json"];
          const fail = (kind: CliErrorKind, text: string, hint: string | null = null) =>
            new CliError({ kind, argv: args.map(shorten), text, hint });
          const result = yield* runner
            .run({
              command: binary,
              args,
              inheritEnv: CLI_ENV,
              separateStderr: true,
              timeoutMs: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
              termGraceMs: TERM_GRACE_MS,
              tailBytes: OUTPUT_CAP_BYTES,
              stderrTailBytes: STDERR_CAP_BYTES,
            })
            .pipe(
              Effect.mapError((error) =>
                fail("UNKNOWN", `${error.message} ${String(error.cause)}`),
              ),
            );
          if (result.timedOut) {
            const ms = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
            return yield* fail("TIMEOUT", `no answer within ${ms} ms`);
          }
          if (result.exitCode === null) {
            return yield* fail("UNKNOWN", "the CLI was ended by a signal");
          }
          if (result.exitCode !== 0) {
            const { kind, text, hint } = classify(result.stderrTail);
            return yield* fail(kind, text, hint);
          }
          if (result.tailTruncated) {
            return yield* fail("PARADEV_SHAPE", `stdout is over ${OUTPUT_CAP_BYTES} bytes`);
          }
          return yield* Effect.try({
            try: () => JSON.parse(result.tail) as unknown,
            catch: (cause) => fail("PARADEV_SHAPE", `stdout is not JSON: ${String(cause)}`),
          });
        }),
      });
    }),
  );
