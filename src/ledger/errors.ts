import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

// Why a ledger operation failed, one class per case so an Effect caller can pick them apart with
// `Effect.catchTags`. The messages are the ones softfac's Rust `Display` prints.

/** A run id or repo that does not have the shape `<owner>__<repo>__<issue>__<attempt>`. */
export class InvalidRunIdError extends Schema.TaggedError<InvalidRunIdError>()(
  "InvalidRunIdError",
  { input: Schema.String, reason: Schema.String },
) {
  override get message(): string {
    return `invalid run id \`${this.input}\`: ${this.reason}`;
  }
}

/** `create` found a file for that run already; it was left untouched. */
export class LedgerAlreadyExistsError extends Schema.TaggedError<LedgerAlreadyExistsError>()(
  "LedgerAlreadyExistsError",
  { path: Schema.String },
) {
  override get message(): string {
    return `run file ${this.path} already exists`;
  }
}

/** The run already wrote its `finished` line; nothing more can be appended. */
export class LedgerAlreadyFinishedError extends Schema.TaggedError<LedgerAlreadyFinishedError>()(
  "LedgerAlreadyFinishedError",
  { path: Schema.String },
) {
  override get message(): string {
    return `run file ${this.path} is already finished`;
  }
}

/** There is no file for that run. */
export class LedgerNotFoundError extends Schema.TaggedError<LedgerNotFoundError>()(
  "LedgerNotFoundError",
  { path: Schema.String },
) {
  override get message(): string {
    return `no run file at ${this.path}`;
  }
}

/** An event name that ledger.md does not list. Nothing was written. */
export class LedgerUnknownEventError extends Schema.TaggedError<LedgerUnknownEventError>()(
  "LedgerUnknownEventError",
  { event: Schema.String },
) {
  override get message(): string {
    return `unknown event \`${this.event}\`: ledger.md does not list it`;
  }
}

/**
 * Reading or writing the file failed; `cause` is what the file system threw. The message is
 * softfac's, the path and then the file system's own words, so the two factories log alike.
 */
export class LedgerIoError extends Schema.TaggedError<LedgerIoError>()("LedgerIoError", {
  path: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    const cause = this.cause instanceof Error ? this.cause.message : String(this.cause);
    return `${this.path}: ${cause}`;
  }
}

export const LedgerError = Schema.Union([
  InvalidRunIdError,
  LedgerAlreadyExistsError,
  LedgerAlreadyFinishedError,
  LedgerNotFoundError,
  LedgerUnknownEventError,
  LedgerIoError,
]);
export type LedgerError = typeof LedgerError.Type;

export const isLedgerError = Schema.is(LedgerError);

/** The `code` of an error thrown by `node:fs`, e.g. `ENOENT`. */
export const errnoCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;

/** Runs a ledger call, which throws typed `LedgerError`s, as an effect; anything else it throws is a defect. */
export const ledgerCall = <A>(call: () => A): Effect.Effect<A, LedgerError> =>
  Effect.suspend(() => {
    try {
      return Effect.succeed(call());
    } catch (error) {
      return isLedgerError(error) ? Effect.fail(error) : Effect.die(error);
    }
  });
