import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { describe } from "vitest";

import { PASS_TIMEOUT, runLoop } from "./loop.ts";
import type { Report } from "./pass.ts";

const report = (n: number): Report => ({ runs: n, claimed: 0, errors: 0, attention: 0 });

/** A pass that counts its calls; the `n`th one waits on `gate` when given. */
const counting = (gate?: { readonly at: number; readonly on: Deferred.Deferred<void> }) => {
  const calls = { n: 0 };
  const onePass = Effect.gen(function* () {
    calls.n += 1;
    const n = calls.n;
    if (gate !== undefined && n === gate.at) yield* Deferred.await(gate.on);
    return report(n);
  });
  return { calls, onePass };
};

describe("the pass loop", () => {
  it.effect("runs a pass when it starts and every poll_seconds after", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { calls, onePass } = counting();
        yield* runLoop(onePass, () => 60);
        assert.strictEqual(calls.n, 1);
        yield* TestClock.adjust("59 seconds");
        assert.strictEqual(calls.n, 1);
        yield* TestClock.adjust("1 second");
        assert.strictEqual(calls.n, 2);
        yield* TestClock.adjust("60 seconds");
        assert.strictEqual(calls.n, 3);
      }),
    ),
  );

  it.effect("wake starts the next pass now, and the poll counts from its end", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { calls, onePass } = counting();
        const loop = yield* runLoop(onePass, () => 60);
        yield* TestClock.adjust("30 seconds");
        const next = yield* Effect.forkChild(loop.awaitPass, { startImmediately: true });
        yield* loop.wake;
        assert.deepStrictEqual(yield* Fiber.join(next), report(2));
        assert.strictEqual(calls.n, 2);
        yield* TestClock.adjust("59 seconds");
        assert.strictEqual(calls.n, 2);
        yield* TestClock.adjust("1 second");
        assert.strictEqual(calls.n, 3);
      }),
    ),
  );

  it.effect("passes never overlap: a wake during a pass makes the next follow it, once", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const on = yield* Deferred.make<void>();
        const { calls, onePass } = counting({ at: 2, on });
        const loop = yield* runLoop(onePass, () => 60);
        yield* TestClock.adjust("60 seconds");
        assert.strictEqual(calls.n, 2);
        yield* loop.wake;
        yield* loop.wake;
        yield* TestClock.adjust("120 seconds");
        assert.strictEqual(calls.n, 2, "the second pass is still running");
        const next = yield* Effect.forkChild(loop.awaitPass, { startImmediately: true });
        yield* Deferred.succeed(on, undefined);
        assert.deepStrictEqual(yield* Fiber.join(next), report(2));
        // The third pass follows the second at once, in the loop's own fiber.
        yield* Effect.yieldNow;
        assert.strictEqual(calls.n, 3, "one pass follows, not one per wake");
        yield* TestClock.adjust("59 seconds");
        assert.strictEqual(calls.n, 3);
        yield* TestClock.adjust("1 second");
        assert.strictEqual(calls.n, 4);
      }),
    ),
  );

  it.effect("passRunning is true while a pass runs and false between passes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const on = yield* Deferred.make<void>();
        const { onePass } = counting({ at: 1, on });
        const loop = yield* runLoop(onePass, () => 60);
        assert.isTrue(yield* loop.passRunning);
        const first = yield* Effect.forkChild(loop.awaitPass, { startImmediately: true });
        yield* Deferred.succeed(on, undefined);
        yield* Fiber.join(first);
        yield* Effect.yieldNow;
        assert.isFalse(yield* loop.passRunning, "idle until the poll");
        yield* TestClock.adjust("60 seconds");
        yield* Effect.yieldNow;
        assert.isFalse(yield* loop.passRunning, "the second pass finished at once");
      }),
    ),
  );

  it.effect("passRunning is false again after a pass that died", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const loop = yield* runLoop(Effect.die(new Error("boom")), () => 60);
        yield* Effect.yieldNow;
        assert.isFalse(yield* loop.passRunning);
      }),
    ),
  );

  it.effect("a pass that dies is logged and the loop goes on", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const calls = { n: 0 };
        const onePass = Effect.suspend(() => {
          calls.n += 1;
          return calls.n === 1 ? Effect.die(new Error("boom")) : Effect.succeed(report(calls.n));
        });
        const loop = yield* runLoop(onePass, () => 60);
        assert.strictEqual(calls.n, 1);
        const next = yield* Effect.forkChild(loop.awaitPass, { startImmediately: true });
        yield* TestClock.adjust("60 seconds");
        assert.deepStrictEqual(yield* Fiber.join(next), report(2));
      }),
    ),
  );

  it.effect("a pass that hangs is stopped at the pass timeout and the loop goes on", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const never = yield* Deferred.make<void>();
        const { calls, onePass } = counting({ at: 1, on: never });
        const loop = yield* runLoop(onePass, () => 60);
        const first = yield* Effect.forkChild(loop.awaitPass, { startImmediately: true });
        yield* TestClock.adjust(Duration.subtract(PASS_TIMEOUT, Duration.seconds(1)));
        assert.strictEqual(calls.n, 1, "the hung pass is still running");
        yield* TestClock.adjust("1 second");
        assert.strictEqual(yield* Fiber.join(first), null);
        const second = yield* Effect.forkChild(loop.awaitPass, { startImmediately: true });
        yield* TestClock.adjust("60 seconds");
        assert.deepStrictEqual(yield* Fiber.join(second), report(2));
      }),
    ),
  );

  it.effect("a long pass that finishes before the pass timeout keeps its report", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const on = yield* Deferred.make<void>();
        const { calls, onePass } = counting({ at: 1, on });
        const loop = yield* runLoop(onePass, () => 60);
        const first = yield* Effect.forkChild(loop.awaitPass, { startImmediately: true });
        yield* TestClock.adjust(Duration.subtract(PASS_TIMEOUT, Duration.seconds(1)));
        yield* Deferred.succeed(on, undefined);
        assert.deepStrictEqual(yield* Fiber.join(first), report(1));
        // The timeout that would have fired is gone: the next pass comes on the poll alone.
        yield* TestClock.adjust("59 seconds");
        assert.strictEqual(calls.n, 1);
        yield* TestClock.adjust("1 second");
        assert.strictEqual(calls.n, 2);
      }),
    ),
  );

  it.effect("the loop stops with its scope", () =>
    Effect.gen(function* () {
      const { calls, onePass } = counting();
      yield* Effect.scoped(runLoop(onePass, () => 60));
      assert.strictEqual(calls.n, 1);
      yield* TestClock.adjust("600 seconds");
      assert.strictEqual(calls.n, 1);
    }),
  );

  it.effect("a changed poll interval applies to the next wait, not the one running", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const poll = { seconds: 60 };
        const { calls, onePass } = counting();
        yield* runLoop(onePass, () => poll.seconds);
        poll.seconds = 10;
        yield* TestClock.adjust("59 seconds");
        assert.strictEqual(calls.n, 1, "the wait that began at 60 seconds goes on");
        yield* TestClock.adjust("1 second");
        assert.strictEqual(calls.n, 2);
        yield* TestClock.adjust("9 seconds");
        assert.strictEqual(calls.n, 2);
        yield* TestClock.adjust("1 second");
        assert.strictEqual(calls.n, 3, "the wait after that pass is 10 seconds");
      }),
    ),
  );
});
