import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import { FactoryProcess } from "../process.ts";
import { fakeSuperset, readFixture } from "./fake-superset.ts";

const ask = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const process = yield* FactoryProcess;
    return yield* process.run({ command: "superset", args });
  });

it.effect("replays the fixture's stdout, exit and stderr, each step once, in any order", () =>
  Effect.gen(function* () {
    const fake = fakeSuperset([
      { argv: ["schema"], fixture: "schema" },
      { argv: (argv) => argv[0] === "workspaces", fixture: "ws-get-local-archived" },
    ]);
    const [failed, schema] = yield* Effect.all([
      ask(["workspaces", "get", "w1", "--local", "--json"]),
      ask(["schema", "--json"]),
    ]).pipe(Effect.provide(fake.layer));
    const archived = readFixture("ws-get-local-archived");
    assert.strictEqual(failed.exitCode, 1);
    assert.strictEqual(failed.stderrTail, archived.stderr);
    assert.strictEqual(failed.tail, "");
    assert.strictEqual(schema.exitCode, 0);
    assert.strictEqual(schema.tail, readFixture("schema").stdout);
    assert.deepStrictEqual(fake.calls, [["workspaces", "get", "w1", "--local"], ["schema"]]);
    assert.deepStrictEqual(fake.unused(), []);
  }),
);

it.effect("an argv no unused step expects fails the test", () =>
  Effect.gen(function* () {
    const fake = fakeSuperset([{ argv: ["schema"], fixture: "schema" }]);
    const exit = yield* Effect.exit(
      Effect.gen(function* () {
        yield* ask(["schema", "--json"]);
        yield* ask(["schema", "--json"]);
      }).pipe(Effect.provide(fake.layer)),
    );
    assert.isTrue(Exit.isFailure(exit) && Cause.hasDies(exit.cause));
    const cause = (exit as Exit.Failure<unknown, unknown>).cause;
    assert.include(String(Cause.squash(cause)), "unexpected argv");
  }),
);

it.effect("a step's edit rewrites the fixture's answer", () =>
  Effect.gen(function* () {
    const fake = fakeSuperset([
      {
        argv: ["workspaces", "get", "w1", "--local"],
        fixture: "ws-get-local",
        edit: (answer) => ({ ...(answer as object), worktreePath: "/tmp/elsewhere" }),
      },
    ]);
    const result = yield* ask(["workspaces", "get", "w1", "--local", "--json"]).pipe(
      Effect.provide(fake.layer),
    );
    const parsed = JSON.parse(result.tail) as { worktreePath: string; branch: string };
    assert.strictEqual(parsed.worktreePath, "/tmp/elsewhere");
    assert.strictEqual(parsed.branch, "fac/1-1");
  }),
);
