/**
 * The pass loop: one pass at start and one every `poll_seconds`, or sooner on a wake. Passes never
 * overlap, and wakes that arrive during a pass make the next one follow at once, however many.
 * A pass past `PASS_TIMEOUT` is stopped and logged so one hung call cannot stop later passes;
 * the next pass goes on from the ledger.
 */
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";
import * as Ref from "effect/Ref";

import type { Report } from "./pass.ts";

export interface Loop {
  /** Starts the next pass now when none is running, or right after the one that is. */
  readonly wake: Effect.Effect<void>;
  /** The report of the next pass to finish; null when that pass died or timed out. */
  readonly awaitPass: Effect.Effect<Report | null>;
  /** True while a pass is running, false between passes: what the status says a pass is doing now. */
  readonly passRunning: Effect.Effect<boolean>;
}

/**
 * Well past what a pass takes, though not a sum of every call's own limit (a `gh` call 60
 * seconds, a worktree removal 10 minutes): a very slow pass is stopped too. That is safe, as
 * every step goes on from the ledger on the next pass, and a claim cut short before its run
 * file is written goes stuck, as it cannot be confirmed.
 */
export const PASS_TIMEOUT = Duration.minutes(30);

/**
 * Runs `onePass` on the loop's schedule in a fiber of the scope. The first pass starts at once.
 * `pollSeconds` is read before each wait, so a changed interval applies after the pass that ends.
 */
export const runLoop = Effect.fn("FactoryLoop.runLoop")(function* (
  onePass: Effect.Effect<Report>,
  pollSeconds: () => number,
) {
  const latch = yield* Latch.make(false);
  const passRunning = yield* Ref.make(false);
  const next = { done: yield* Deferred.make<Report | null>() };
  const loop = Effect.gen(function* () {
    for (;;) {
      yield* latch.close;
      yield* Ref.set(passRunning, true);
      const report = yield* onePass.pipe(
        Effect.timeoutOption(PASS_TIMEOUT),
        Effect.flatMap((done) =>
          done._tag === "Some"
            ? Effect.succeed(done.value)
            : Effect.logError("factory pass timed out and was stopped").pipe(Effect.as(null)),
        ),
        Effect.catchCause((cause) =>
          Effect.logError("factory pass failed", cause).pipe(Effect.as(null)),
        ),
        Effect.ensuring(Ref.set(passRunning, false)),
      );
      const finished = next.done;
      next.done = yield* Deferred.make<Report | null>();
      yield* Deferred.succeed(finished, report);
      yield* Effect.raceFirst(Effect.sleep(Duration.seconds(pollSeconds())), latch.await);
    }
  });
  yield* Effect.forkScoped(loop, { startImmediately: true });
  return {
    wake: Effect.asVoid(latch.open),
    awaitPass: Effect.suspend(() => Deferred.await(next.done)),
    passRunning: Ref.get(passRunning),
  };
});
