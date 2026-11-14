import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { checkProxy, type ProxyGet } from "./proxy.ts";

const answering =
  (status: number): { get: ProxyGet; asked: Array<string> } => {
    const asked: Array<string> = [];
    return {
      asked,
      get: (url) => {
        asked.push(url);
        return Effect.succeed(status);
      },
    };
  };

describe("checkProxy", () => {
  it.effect("401 with no key is guarded: the key check is on", () =>
    Effect.gen(function* () {
      const { get } = answering(401);
      assert.deepStrictEqual(yield* checkProxy(get, "https://proxy.example"), { kind: "guarded" });
    }),
  );

  it.effect("200 with no key is open: the key check is off", () =>
    Effect.gen(function* () {
      const { get } = answering(200);
      assert.deepStrictEqual(yield* checkProxy(get, "https://proxy.example"), { kind: "open" });
    }),
  );

  it.effect("any other answer is down, with the status", () =>
    Effect.gen(function* () {
      const { get } = answering(503);
      assert.deepStrictEqual(yield* checkProxy(get, "https://proxy.example"), {
        kind: "down",
        reason: "answered HTTP 503",
      });
    }),
  );

  // The real clock: it.effect runs on a TestClock that the timeout would wait on forever.
  it.live("no answer within the timeout is down", () =>
    Effect.gen(function* () {
      const never: ProxyGet = () => Effect.never;
      assert.deepStrictEqual(yield* checkProxy(never, "https://proxy.example", 20), {
        kind: "down",
        reason: "did not answer within 0.02 s",
      });
    }),
  );

  it.effect("a connect failure is down, with its reason", () =>
    Effect.gen(function* () {
      const refused: ProxyGet = () => Effect.fail("connection refused");
      assert.deepStrictEqual(yield* checkProxy(refused, "https://proxy.example"), {
        kind: "down",
        reason: "connection refused",
      });
    }),
  );

  it.effect("asks /v1/models, with no double slash after a trailing one", () =>
    Effect.gen(function* () {
      const plain = answering(401);
      yield* checkProxy(plain.get, "https://proxy.example");
      const slashed = answering(401);
      yield* checkProxy(slashed.get, "https://proxy.example:8443//");
      assert.deepStrictEqual(plain.asked, ["https://proxy.example/v1/models"]);
      assert.deepStrictEqual(slashed.asked, ["https://proxy.example:8443/v1/models"]);
    }),
  );
});
