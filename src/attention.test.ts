import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";

import {
  Attention,
  ATTENTION_FILE,
  CONFIG_ITEM_ID,
  layer,
  PASS_ERRORS_ITEM_ID,
  type NewItem,
} from "./attention.ts";
import { FactoryProcess, RunSpawnError, type RunInput, type RunResult } from "./process.ts";
import * as Paths from "./paths.ts";

const NOW = 1_791_380_000_000;

const item = (overrides: Partial<NewItem> = {}): NewItem => ({
  id: "attention:rawphp__softfac__12__1:not-progressing",
  kind: "attention",
  repo: "rawphp/softfac",
  issue: 12,
  run: "rawphp__softfac__12__1",
  message: "rawphp/softfac#12 run rawphp__softfac__12__1 is not progressing",
  ...overrides,
});

const done = (exitCode: number | null, tail = ""): RunResult => ({
  exitCode,
  timedOut: false,
  tail,
  stderrTail: "",
  truncated: false,
  tailTruncated: false,
});

/** A FactoryProcess that records each call and answers with `reply`. */
const recorder = (
  reply: (input: RunInput) => Effect.Effect<RunResult, RunSpawnError> = () =>
    Effect.succeed(done(0)),
) => {
  const calls: Array<RunInput> = [];
  const process = FactoryProcess.of({
    run: (input) => {
      calls.push(input);
      return reply(input);
    },
  });
  return { calls, process };
};

const messageText = (message: unknown): string => {
  const first = Array.isArray(message) ? message[0] : message;
  return typeof first === "string" ? first : String(first);
};

/** The service over `dir`, as a restart builds it again. The clock reads `now.ms`. */
const serviceOver = (
  dir: string,
  process: FactoryProcess["Service"],
  now: { ms: number } = { ms: NOW },
) =>
  layer({ clock: () => now.ms }).pipe(
    Layer.provide(
      Layer.succeed(Paths.FactoryPaths, {
        baseDir: dir,
        worktreesDir: `${dir}/worktrees`,
        factoryDir: dir,
        machineConfigPath: `${dir}/config.yml`,
        claudeProjectsDir: `${dir}/claude-projects`,
      }),
    ),
    Layer.provide(Layer.succeed(FactoryProcess, process)),
  );

/** Runs `body` over a fresh factory dir, with the warnings it logs collected. */
const withDir = <A, E>(
  body: (dir: string, warnings: Array<string>) => Effect.Effect<A, E, FileSystem.FileSystem>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { join } = yield* Path.Path;
      const base = yield* fs.makeTempDirectoryScoped({ prefix: "factory-attention-" });
      const dir = join(base, "factory");
      const warnings: Array<string> = [];
      const capture = Logger.make(({ message, logLevel }) => {
        if (logLevel === "Warn") warnings.push(messageText(message));
      });
      return yield* body(dir, warnings).pipe(
        Effect.provide(Logger.layer([capture], { mergeWithExisting: false })),
      );
    }),
  ).pipe(Effect.provide(NodeServices.layer));

const fileOf = (dir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return JSON.parse(yield* fs.readFileString(`${dir}/${ATTENTION_FILE}`)) as {
      items: Array<Record<string, unknown>>;
    };
  });

it.effect(
  "raise keeps the item with the clock's first-seen time, and a second raise changes nothing",
  () =>
    withDir((dir) => {
      const now = { ms: NOW };
      const { calls, process } = recorder();
      return Effect.gen(function* () {
        const attention = yield* Attention;
        yield* attention.raise(item());
        now.ms = NOW + 60_000;
        yield* attention.raise(item({ message: "changed" }));
        const listed = yield* attention.list();
        assert.deepStrictEqual(listed, [{ ...item(), firstSeenMs: NOW }]);
        assert.strictEqual(calls.length, 1);
      }).pipe(Effect.provide(serviceOver(dir, process, now)));
    }),
);

it.effect("open items are kept in attention.json and a restart notifies none of them again", () =>
  withDir((dir) => {
    const first = recorder();
    const second = recorder();
    return Effect.gen(function* () {
      yield* Effect.gen(function* () {
        yield* (yield* Attention).raise(item());
      }).pipe(Effect.provide(serviceOver(dir, first.process)));
      const file = yield* fileOf(dir);
      assert.strictEqual(file.items.length, 1);
      assert.strictEqual(file.items[0]!["id"], item().id);
      assert.strictEqual(file.items[0]!["first_seen"], "2026-10-07T13:33:20.000Z");

      yield* Effect.gen(function* () {
        const attention = yield* Attention;
        assert.deepStrictEqual(yield* attention.list(), [{ ...item(), firstSeenMs: NOW }]);
        yield* attention.raise(item());
      }).pipe(Effect.provide(serviceOver(dir, second.process, { ms: NOW + 1000 })));
      assert.strictEqual(first.calls.length, 1);
      assert.strictEqual(second.calls.length, 0);
    });
  }),
);

it.effect("a file that is not valid is an empty list and one warning", () =>
  withDir((dir, warnings) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(dir, { recursive: true });
      yield* fs.writeFileString(`${dir}/${ATTENTION_FILE}`, "{not json");
      const { process } = recorder();
      yield* Effect.gen(function* () {
        assert.deepStrictEqual(yield* (yield* Attention).list(), []);
      }).pipe(Effect.provide(serviceOver(dir, process)));
      assert.strictEqual(warnings.length, 1);
    }),
  ),
);

it.effect("entries of the file that are malformed are skipped", () =>
  withDir((dir) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(dir, { recursive: true });
      yield* fs.writeFileString(
        `${dir}/${ATTENTION_FILE}`,
        JSON.stringify({
          items: [
            {
              id: "a",
              kind: "config",
              repo: null,
              issue: null,
              run: null,
              message: "m",
              first_seen: "nope",
            },
            {
              id: "b",
              kind: "config",
              repo: null,
              issue: null,
              run: null,
              message: "ok",
              first_seen: "2026-10-07T13:33:20.000Z",
            },
            "junk",
          ],
        }),
      );
      const { process } = recorder();
      yield* Effect.gen(function* () {
        const listed = yield* (yield* Attention).list();
        assert.deepStrictEqual(
          listed.map((i) => i.id),
          ["b"],
        );
      }).pipe(Effect.provide(serviceOver(dir, process)));
    }),
  ),
);

it.effect("the text goes to osascript as argv and never into the script", () =>
  withDir((dir) => {
    const { calls, process } = recorder();
    const message = 'say "hi"\\\\ " & do shell script "rm -rf /" & "';
    return Effect.gen(function* () {
      const attention = yield* Attention;
      yield* attention.raise(item({ id: "a", repo: "a/b", issue: 7, run: null, message }));
      yield* attention.raise(
        item({ id: "b", kind: "config", repo: null, issue: null, run: null, message }),
      );
      yield* attention.raise(item({ id: "c", repo: "a/b", issue: null, run: null, message }));
      assert.strictEqual(calls.length, 3);
      const [issueCall, machineCall, repoCall] = calls;
      assert.strictEqual(issueCall!.command, "osascript");
      assert.strictEqual(issueCall!.args![0], "-e");
      const script = issueCall!.args![1]!;
      assert.include(script, "on run argv");
      assert.notInclude(script, "do shell script");
      assert.notInclude(script, message);
      assert.strictEqual(issueCall!.args![2], "a/b#7");
      assert.strictEqual(issueCall!.args![3], message);
      assert.strictEqual(issueCall!.args!.length, 4);
      assert.strictEqual(issueCall!.timeoutMs, 15_000);
      assert.strictEqual(issueCall!.termGraceMs, 1_000);
      assert.strictEqual(machineCall!.args![2], "factory");
      assert.strictEqual(repoCall!.args![2], "a/b");
    }).pipe(Effect.provide(serviceOver(dir, process)));
  }),
);

it.effect("notify off keeps the list and posts nothing", () =>
  withDir((dir) => {
    const { calls, process } = recorder();
    return Effect.gen(function* () {
      const attention = yield* Attention;
      yield* attention.setNotify(false);
      yield* attention.raise(item());
      assert.strictEqual(calls.length, 0);
      assert.strictEqual((yield* attention.list()).length, 1);
    }).pipe(Effect.provide(serviceOver(dir, process)));
  }),
);

it.effect("a missing osascript is logged once and no later item runs a process", () =>
  withDir((dir, warnings) => {
    const { calls, process } = recorder(() => Effect.succeed(done(127, "osascript: not found")));
    return Effect.gen(function* () {
      const attention = yield* Attention;
      yield* attention.raise(item({ id: "a" }));
      yield* attention.raise(item({ id: "b" }));
      assert.strictEqual(calls.length, 1);
      assert.strictEqual(warnings.length, 1);
      assert.include(warnings[0]!, "osascript not found");
      assert.strictEqual((yield* attention.list()).length, 2);
    }).pipe(Effect.provide(serviceOver(dir, process)));
  }),
);

it.effect("an osascript that times out is logged once and no later item runs a process", () =>
  withDir((dir, warnings) => {
    const { calls, process } = recorder(() =>
      Effect.succeed({
        exitCode: null,
        timedOut: true,
        tail: "",
        stderrTail: "",
        truncated: false,
        tailTruncated: false,
      }),
    );
    return Effect.gen(function* () {
      const attention = yield* Attention;
      yield* attention.raise(item({ id: "a" }));
      yield* attention.raise(item({ id: "b" }));
      assert.strictEqual(calls.length, 1);
      assert.strictEqual(warnings.length, 1);
      assert.include(warnings[0]!, "osascript did not answer in 15 seconds");
      assert.strictEqual((yield* attention.list()).length, 2);
    }).pipe(Effect.provide(serviceOver(dir, process)));
  }),
);

it.effect("a failing notifier is logged and the raise still succeeds", () =>
  withDir((dir, warnings) => {
    let n = 0;
    const { calls, process } = recorder(() => {
      n += 1;
      return n === 1
        ? Effect.succeed(done(1, "execution error"))
        : Effect.fail(new RunSpawnError({ shell: false, cause: new Error("no spawn") }));
    });
    return Effect.gen(function* () {
      const attention = yield* Attention;
      yield* attention.raise(item({ id: "a" }));
      yield* attention.raise(item({ id: "b" }));
      assert.strictEqual(calls.length, 2);
      assert.strictEqual(warnings.length, 2);
      assert.include(warnings[0]!, "a");
      assert.strictEqual((yield* attention.list()).length, 2);
    }).pipe(Effect.provide(serviceOver(dir, process)));
  }),
);

it.effect(
  "clear removes the items that match and the file follows, so a stopped run's item is gone",
  () =>
    withDir((dir) => {
      const { process } = recorder();
      return Effect.gen(function* () {
        const attention = yield* Attention;
        yield* attention.raise(item({ id: "a", run: "run-1" }));
        yield* attention.raise(item({ id: "b", run: "run-2" }));
        yield* attention.clear((i) => i.run === "run-1");
        assert.deepStrictEqual(
          (yield* attention.list()).map((i) => i.id),
          ["b"],
        );
        assert.deepStrictEqual(
          (yield* fileOf(dir)).items.map((i) => i["id"]),
          ["b"],
        );
        yield* attention.clear(() => false);
        assert.strictEqual((yield* attention.list()).length, 1);
      }).pipe(Effect.provide(serviceOver(dir, process)));
    }),
);

it.effect("an item cleared and raised again is new, so it is notified again", () =>
  withDir((dir) => {
    const { calls, process } = recorder();
    return Effect.gen(function* () {
      const attention = yield* Attention;
      yield* attention.raise(item());
      yield* attention.clear(() => true);
      yield* attention.raise(item());
      assert.strictEqual(calls.length, 2);
    }).pipe(Effect.provide(serviceOver(dir, process)));
  }),
);

it.effect(
  "the third pass in a row that errors raises pass-errors, and a success clears it and resets the count",
  () =>
    withDir((dir) => {
      const { calls, process } = recorder();
      return Effect.gen(function* () {
        const attention = yield* Attention;
        const fail = (message: string) => attention.passEnded({ ok: false, message });
        yield* fail("one");
        yield* fail("two");
        assert.strictEqual((yield* attention.list()).length, 0);
        yield* fail("three");
        const listed = yield* attention.list();
        assert.strictEqual(listed.length, 1);
        assert.strictEqual(listed[0]!.id, PASS_ERRORS_ITEM_ID);
        assert.strictEqual(listed[0]!.kind, "pass-errors");
        assert.strictEqual(listed[0]!.repo, null);
        assert.include(listed[0]!.message, "3 times in a row");
        assert.include(listed[0]!.message, "three");
        assert.strictEqual(calls.length, 1);
        // Later failures keep the one item and notify nothing.
        yield* fail("four");
        assert.strictEqual(calls.length, 1);

        yield* attention.passEnded({ ok: true });
        assert.strictEqual((yield* attention.list()).length, 0);
        yield* fail("five");
        yield* fail("six");
        assert.strictEqual((yield* attention.list()).length, 0);
      }).pipe(Effect.provide(serviceOver(dir, process)));
    }),
);

it.effect("dismiss hides the open items it names and answers the ids it dismissed", () =>
  withDir((dir) => {
    const { process } = recorder();
    return Effect.gen(function* () {
      const attention = yield* Attention;
      yield* attention.raise(item({ id: "a" }));
      yield* attention.raise(item({ id: "b" }));
      const dismissed = yield* attention.dismiss(["a", "a", "nope"]);
      assert.deepStrictEqual(dismissed, ["a"]);
      assert.deepStrictEqual(
        (yield* attention.list()).map((i) => i.id),
        ["b"],
      );
      assert.deepStrictEqual(
        (yield* attention.listDismissed()).map((i) => i.id),
        ["a"],
      );
      assert.deepStrictEqual(yield* attention.dismiss(["a"]), []);
      const file = yield* fileOf(dir);
      assert.deepStrictEqual(
        file.items.map((i) => [i["id"], i["dismissed"]]),
        [
          ["a", true],
          ["b", undefined],
        ],
      );
    }).pipe(Effect.provide(serviceOver(dir, process)));
  }),
);

it.effect(
  "restore lists a dismissed item again without notifying it, and answers the ids it restored",
  () =>
    withDir((dir) => {
      const { calls, process } = recorder();
      return Effect.gen(function* () {
        const attention = yield* Attention;
        yield* attention.raise(item({ id: "a" }));
        yield* attention.raise(item({ id: "b" }));
        yield* attention.dismiss(["a", "b"]);
        assert.deepStrictEqual(yield* attention.restore(["a", "a", "nope"]), ["a"]);
        assert.deepStrictEqual(
          (yield* attention.list()).map((i) => i.id),
          ["a"],
        );
        assert.deepStrictEqual(
          (yield* attention.listDismissed()).map((i) => i.id),
          ["b"],
        );
        assert.deepStrictEqual(yield* attention.restore(["a"]), []);
        assert.deepStrictEqual(
          (yield* fileOf(dir)).items.map((i) => [i["id"], i["dismissed"]]),
          [
            ["a", undefined],
            ["b", true],
          ],
        );
        assert.strictEqual(calls.length, 2);
      }).pipe(Effect.provide(serviceOver(dir, process)));
    }),
);

it.effect("a dismissed item raised again is neither listed nor notified, after a restart too", () =>
  withDir((dir) => {
    const first = recorder();
    const second = recorder();
    return Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const attention = yield* Attention;
        yield* attention.raise(item({ id: CONFIG_ITEM_ID, kind: "config" }));
        yield* attention.dismiss([CONFIG_ITEM_ID]);
        yield* attention.raise(item({ id: CONFIG_ITEM_ID, kind: "config" }));
        assert.deepStrictEqual(yield* attention.list(), []);
      }).pipe(Effect.provide(serviceOver(dir, first.process)));
      assert.strictEqual(first.calls.length, 1);

      yield* Effect.gen(function* () {
        const attention = yield* Attention;
        assert.deepStrictEqual(yield* attention.list(), []);
        yield* attention.raise(item({ id: CONFIG_ITEM_ID, kind: "config" }));
        assert.deepStrictEqual(yield* attention.list(), []);
      }).pipe(Effect.provide(serviceOver(dir, second.process)));
      assert.strictEqual(second.calls.length, 0);
    });
  }),
);

it.effect("clear forgets a dismissal, so the same id raised again is listed and notified", () =>
  withDir((dir) => {
    const { calls, process } = recorder();
    return Effect.gen(function* () {
      const attention = yield* Attention;
      yield* attention.raise(item({ id: CONFIG_ITEM_ID, kind: "config" }));
      yield* attention.dismiss([CONFIG_ITEM_ID]);
      yield* attention.clear((i) => i.id === CONFIG_ITEM_ID);
      assert.deepStrictEqual((yield* fileOf(dir)).items, []);
      yield* attention.raise(item({ id: CONFIG_ITEM_ID, kind: "config" }));
      assert.deepStrictEqual(
        (yield* attention.list()).map((i) => i.id),
        [CONFIG_ITEM_ID],
      );
      assert.strictEqual(calls.length, 2);
    }).pipe(Effect.provide(serviceOver(dir, process)));
  }),
);

it.effect(
  "a file from before dismissals loads every item open, and bad dismissal data is dropped with a warning",
  () =>
    withDir((dir, warnings) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(dir, { recursive: true });
        const entry = (id: string, extra: Record<string, unknown> = {}) => ({
          id,
          kind: "stuck",
          repo: "a/b",
          issue: 1,
          run: null,
          message: "m",
          first_seen: "2026-10-07T13:33:20.000Z",
          ...extra,
        });
        yield* fs.writeFileString(
          `${dir}/${ATTENTION_FILE}`,
          JSON.stringify({
            items: [
              entry("old"),
              entry("bad", { dismissed: "yes" }),
              entry("off", { dismissed: false }),
            ],
          }),
        );
        const { process } = recorder();
        yield* Effect.gen(function* () {
          assert.deepStrictEqual(
            (yield* (yield* Attention).list()).map((i) => i.id),
            ["old", "bad", "off"],
          );
        }).pipe(Effect.provide(serviceOver(dir, process)));
        assert.strictEqual(warnings.length, 1);
        assert.include(warnings[0]!, "bad");
      }),
    ),
);
