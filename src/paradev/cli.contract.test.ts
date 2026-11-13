// @effect-diagnostics nodeBuiltinImport:off - Lists the recorded fixtures.
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeFS from "node:fs";

import { type CliErrorKind, layer, SupersetCli } from "./cli.ts";
import { FIXTURES_DIR, fakeSuperset, readFixture } from "./fake-superset.ts";

/** Each failure the spike recorded, by the start of its `Error: ` line. */
const SEEN: ReadonlyArray<readonly [string, CliErrorKind]> = [
  ["Host service for this machine isn't running", "PARADEV_OFFLINE"],
  ["Host is not online", "PARADEV_OFFLINE"],
  ["Not logged in", "PARADEV_SIGNED_OUT"],
  ["Workspace not found on host ", "NOT_FOUND"],
  ['Terminal session "', "UNKNOWN"],
  ["No transcript for that terminal", "NO_TRANSCRIPT"],
  ["A stored value is at most 65536 bytes", "TOO_LARGE"],
  ["No agent is running in terminal ", "AGENT_EXITED"],
  ["Timed out after ", "TIMEOUT"],
];

const failed = NodeFS.readdirSync(FIXTURES_DIR)
  .filter((file) => file.endsWith(".meta.json"))
  .map((file) => file.slice(0, -".meta.json".length))
  .filter((name) => readFixture(name).exit === 1);

const runThrough = (name: string) => {
  const fake = fakeSuperset([{ argv: readFixture(name).argv, fixture: name }]);
  return Effect.gen(function* () {
    const cli = yield* SupersetCli;
    return yield* Effect.flip(cli.run(readFixture(name).argv));
  }).pipe(Effect.provide(layer({ cli: "superset" }).pipe(Layer.provide(fake.layer))));
};

it("the spike recorded failures to map", () => {
  assert.isAtLeast(failed.length, 8);
});

for (const name of failed) {
  it.effect(`${name} maps to its kind`, () =>
    Effect.gen(function* () {
      const stderr = readFixture(name).stderr;
      const expected = SEEN.find(([prefix]) => stderr.startsWith(`Error: ${prefix}`));
      assert.isDefined(expected, `no kind expected for ${name}: ${stderr}`);
      const error = yield* runThrough(name);
      assert.strictEqual(error.kind, expected![1]);
      assert.isTrue(stderr.startsWith(`Error: ${error.text}\n`));
    }),
  );
}

it.effect("a failure keeps the CLI's hint", () =>
  Effect.gen(function* () {
    const error = yield* runThrough("ws-create-local-4-nologin");
    assert.strictEqual(error.text, "Not logged in");
    assert.strictEqual(error.hint, "Run: superset auth login (or set SUPERSET_API_KEY)");
  }),
);

it.effect("exit 0 answers the recorded stdout parsed", () =>
  Effect.gen(function* () {
    const argv = ["workspaces", "get", "be47b9e8-7687-4c3c-8791-5fd7f04ba5fe", "--local"];
    const fake = fakeSuperset([{ argv, fixture: "ws-get-local" }]);
    const answer = yield* Effect.gen(function* () {
      const cli = yield* SupersetCli;
      return yield* cli.run(argv);
    }).pipe(Effect.provide(layer().pipe(Layer.provide(fake.layer))));
    assert.deepStrictEqual(answer, JSON.parse(readFixture("ws-get-local").stdout));
    assert.deepStrictEqual(fake.unused(), []);
  }),
);
