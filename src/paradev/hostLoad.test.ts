import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

import type { HostConfig } from "../config.ts";
import { parseLoad, readHostLoad } from "./hostLoad.ts";
import { LOAD_COMMAND, sshArgs, type SshAnswer, type SshRunner } from "./ssh.ts";

const HOST: HostConfig = { id: "h1", name: "mini", ssh: "me@mini", maxRuns: 2, maxLoadPerCore: 1 };

const runnerAnswering = (reply: Partial<SshAnswer>): { run: SshRunner; calls: Array<ReadonlyArray<string>> } => {
  const calls: Array<ReadonlyArray<string>> = [];
  return {
    calls,
    run: (args) => {
      calls.push(args);
      return Effect.succeed({ exitCode: 0, timedOut: false, stdout: "", stderr: "", ...reply });
    },
  };
};

describe("parseLoad", () => {
  it("reads macOS: the second field of the { } line, and the last line", () => {
    assert.deepStrictEqual(parseLoad("{ 1.52 1.73 1.80 }\n10\n"), { oneMinute: 1.52, cores: 10 });
  });

  it("reads Linux: the first field of the first line, and the last line", () => {
    assert.deepStrictEqual(parseLoad("0.52 0.58 0.59 1/389 12345\n8\n"), { oneMinute: 0.52, cores: 8 });
  });

  it("reads nothing from a line it does not know", () => {
    for (const text of ["hello", "", "10\n", "{ x y z }\n10", "0.5 0.5 0.5 1/2 3\n0", "0.5 0.5 0.5 1/2 3\nabc", "hello\nworld"]) {
      assert.isNull(parseLoad(text), JSON.stringify(text));
    }
  });
});

describe("readHostLoad", () => {
  it.effect("asks the host for the spec's command and answers the load", () =>
    Effect.gen(function* () {
      const fake = runnerAnswering({ stdout: "0.5 0.5 0.5 1/2 3\n4\n" });
      const load = yield* readHostLoad(fake.run, HOST);
      assert.deepStrictEqual(load, { oneMinute: 0.5, cores: 4 });
      assert.deepStrictEqual(fake.calls, [sshArgs("me@mini", LOAD_COMMAND)]);
    }),
  );

  it.effect("fails with the ssh message when the read fails", () =>
    Effect.gen(function* () {
      const fake = runnerAnswering({ exitCode: 255, stderr: "Connection refused\n" });
      const result = yield* Effect.result(readHostLoad(fake.run, HOST));
      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) assert.strictEqual(result.failure, "exit 255: Connection refused");
    }),
  );

  it.effect("fails when the answer is not a load", () =>
    Effect.gen(function* () {
      const fake = runnerAnswering({ stdout: "hello\n" });
      const result = yield* Effect.result(readHostLoad(fake.run, HOST));
      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.strictEqual(result.failure, "the load answer is not one the runner reads");
      }
    }),
  );
});
