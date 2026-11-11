/**
 * How the adapter calls the CLI: a timeout of its own per call, one retry after 2 s for an
 * answer that may differ next time, and each answer checked against the fields it reads.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { CliError, type CliErrorKind, type SupersetCli } from "./cli.ts";

/** Failures a second call may not repeat. Offline, signed out and not found answer the same. */
const RETRYABLE: ReadonlySet<CliErrorKind> = new Set(["TRANSIENT", "TIMEOUT"]);

const RETRY_DELAY = "2 seconds";

type Cli = SupersetCli["Service"];

export const call = (cli: Cli, argv: ReadonlyArray<string>, timeoutMs: number) =>
  cli.run(argv, { timeoutMs });

/** {@link call}, and once more after 2 s when the first failure was transient or a timeout. */
export const callWithRetry = (cli: Cli, argv: ReadonlyArray<string>, timeoutMs: number) =>
  call(cli, argv, timeoutMs).pipe(
    Effect.catchIf(
      (error) => RETRYABLE.has(error.kind),
      () => Effect.sleep(RETRY_DELAY).pipe(Effect.andThen(call(cli, argv, timeoutMs))),
    ),
  );

/** The answer as `schema` reads it, else a `PARADEV_SHAPE` error naming the call. */
export const decodeAnswer = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  answer: unknown,
  argv: ReadonlyArray<string>,
): Effect.Effect<S["Type"], CliError> => {
  const decoded = Schema.decodeUnknownOption(schema)(answer);
  return Option.isSome(decoded)
    ? Effect.succeed(decoded.value)
    : Effect.fail(
        new CliError({
          kind: "PARADEV_SHAPE",
          argv: [...argv, "--json"],
          text: "the answer lacks a field the runner reads",
          hint: null,
        }),
      );
};
