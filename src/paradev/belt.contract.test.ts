// @effect-diagnostics nodeBuiltinImport:off - Reads what the writer left in its data dir.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import type * as Path from "effect/Path";

import type { BeltV1 } from "../belt.ts";
import { sha256 } from "../text.ts";
import {
  BELT_HTML,
  HEARTBEAT_MS,
  newBeltMemo,
  PUBLISH_RETRY_MS,
  writeBelt,
  type BeltMemo,
  type BeltTarget,
} from "./belt.ts";
import { FactoryProcess, type RunResult } from "../process.ts";
import { layer as cliLayer, SupersetCli } from "./cli.ts";
import { fakeSuperset, readFixture, type Step } from "./fake-superset.ts";

/** The page id the spike's publish answered, and its storage writes were made to. */
const PAGE_ID = "30c684ae-67ab-41c9-b673-cdacc8d5254e";
const NOW = Date.UTC(2026, 10, 12, 9, 0, 0);
const HTML = NodeFS.readFileSync(BELT_HTML, "utf8");

/** The belt the spike wrote with `pages-storage-set-belt`: the recorded `--set` value. */
const recordedBelt = (): BeltV1 => {
  const argv = readFixture("pages-storage-set-belt").argv;
  return JSON.parse(argv[argv.indexOf("--set") + 1]!) as BeltV1;
};

const oversizeBelt = (): BeltV1 => {
  const argv = readFixture("pages-storage-set-belt-oversize").argv;
  return JSON.parse(argv[argv.indexOf("--set") + 1]!) as BeltV1;
};

const at = (belt: BeltV1, nowMs: number): BeltV1 => ({ ...belt, updatedAt: new Date(nowMs).toISOString() });

const isPublish = (argv: ReadonlyArray<string>) => argv[0] === "pages" && argv[1] === "publish";
const isSet = (argv: ReadonlyArray<string>) => argv[0] === "pages" && argv[1] === "storage";

const publishStep: Step = { argv: isPublish, fixture: "pages-publish-probe-ws" };
const setStep: Step = { argv: isSet, fixture: "pages-storage-set-belt" };

interface WriterOptions {
  /** Writes files into the data dir before the writer runs. */
  readonly seed?: (dataDir: string) => void;
  readonly visibility?: BeltVisibility;
  readonly memo?: BeltMemo;
  /** The first `pages publish` gets no answer in time: the CLI runner's timeout. */
  readonly firstPublishTimesOut?: boolean;
}

type BeltVisibility = BeltTarget["visibility"];

const timedOut: RunResult = {
  exitCode: null,
  timedOut: true,
  tail: "",
  stderrTail: "",
  truncated: false,
  tailTruncated: false,
};

/**
 * Runs `body` with a temp data dir, a scripted superset and the warnings the writer logs. The
 * script must be used up.
 */
const withWriter = <A>(
  script: ReadonlyArray<Step>,
  body: (
    write: (belt: BeltV1, nowMs: number) => Effect.Effect<void, never, FileSystem.FileSystem | Path.Path>,
    dataDir: string,
    fake: ReturnType<typeof fakeSuperset>,
    warnings: Array<string>,
  ) => Effect.Effect<A, never, FileSystem.FileSystem | Path.Path>,
  options: WriterOptions = {},
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dataDir = yield* fs.makeTempDirectoryScoped({ prefix: "belt-" });
      options.seed?.(dataDir);
      const fake = fakeSuperset(script);
      const scripted = yield* Effect.provide(
        Effect.gen(function* () {
          return yield* FactoryProcess;
        }),
        fake.layer,
      );
      let timeOut = options.firstPublishTimesOut === true;
      const process = FactoryProcess.of({
        run: (input) => {
          if (timeOut && input.args?.[1] === "publish") {
            timeOut = false;
            fake.calls.push((input.args ?? []).slice(0, -1));
            return Effect.succeed(timedOut);
          }
          return scripted.run(input);
        },
      });
      const cli = yield* Effect.provide(
        Effect.gen(function* () {
          return yield* SupersetCli;
        }),
        cliLayer({ cli: "superset" }).pipe(Layer.provide(Layer.succeed(FactoryProcess, process))),
      );
      const warnings: Array<string> = [];
      const capture = Logger.make(({ logLevel, message }) => {
        if (logLevel === "Warn") warnings.push(String(Array.isArray(message) ? message[0] : message));
      });
      const target: BeltTarget = {
        cli,
        dataDir,
        host: "mac",
        version: "0.0.0",
        visibility: options.visibility ?? "just_me",
        memo: options.memo ?? newBeltMemo(),
      };
      const result = yield* body(
        (belt, nowMs) =>
          writeBelt(target, belt, nowMs).pipe(
            Effect.provide(Logger.layer([capture], { mergeWithExisting: false })),
          ),
        dataDir,
        fake,
        warnings,
      );
      assert.deepStrictEqual(fake.unused(), [], "every scripted call was made");
      return result;
    }),
  ).pipe(Effect.provide(NodeServices.layer));

const saved = (dataDir: string) =>
  JSON.parse(NodeFS.readFileSync(NodePath.join(dataDir, "belt.json"), "utf8")) as {
    pageId: string;
    htmlSha256: string;
    visibility: string;
  };

/** A `belt.json` naming the spike's page, published from `html` at `visibility`. */
const seedPage =
  (html = HTML, visibility = "just_me", pageId = PAGE_ID) =>
  (dataDir: string) =>
    NodeFS.writeFileSync(
      NodePath.join(dataDir, "belt.json"),
      JSON.stringify({ pageId, htmlSha256: sha256(html), visibility }),
    );

describe("the belt write and its size cap", () => {
  it.effect("the first pass publishes belt.html without --workspace, saves the page, then writes the belt", () =>
    withWriter([publishStep, setStep], (write, dataDir, fake, warnings) =>
      Effect.gen(function* () {
        const belt = at(recordedBelt(), NOW);
        yield* write(belt, NOW);
        const page = NodePath.join(dataDir, "belt-page", "index.html");
        assert.strictEqual(NodeFS.readFileSync(page, "utf8"), HTML);
        assert.deepStrictEqual(fake.calls[0], [
          "pages",
          "publish",
          page,
          "--title",
          "Factory belt (mac)",
          "--visibility",
          "just_me",
          "--no-watch",
        ]);
        assert.notInclude(fake.calls[0]!, "--workspace");
        assert.deepStrictEqual(saved(dataDir), {
          pageId: PAGE_ID,
          htmlSha256: sha256(HTML),
          visibility: "just_me",
        });
        assert.deepStrictEqual(fake.calls[1], [
          "pages",
          "storage",
          PAGE_ID,
          "--key",
          "belt",
          "--scope",
          "shared",
          "--set",
          JSON.stringify(belt),
        ]);
        assert.deepStrictEqual(warnings, []);
      }),
    ),
  );

  it.effect("a saved page with the same HTML and visibility is not published again", () =>
    withWriter(
      [setStep],
      (write, _dataDir, fake) =>
        Effect.gen(function* () {
          yield* write(at(recordedBelt(), NOW), NOW);
          assert.strictEqual(fake.calls.length, 1);
          assert.isTrue(isSet(fake.calls[0]!));
        }),
      { seed: seedPage() },
    ),
  );

  it.effect("a runner whose HTML differs publishes again to the saved page with its version", () =>
    withWriter(
      [publishStep, setStep],
      (write, dataDir, fake) =>
        Effect.gen(function* () {
          yield* write(at(recordedBelt(), NOW), NOW);
          const page = NodePath.join(dataDir, "belt-page", "index.html");
          assert.deepStrictEqual(fake.calls[0], [
            "pages",
            "publish",
            page,
            "--page",
            PAGE_ID,
            "--label",
            "runner 0.0.0",
            "--visibility",
            "just_me",
            "--no-watch",
          ]);
          assert.deepStrictEqual(saved(dataDir), {
            pageId: PAGE_ID,
            htmlSha256: sha256(HTML),
            visibility: "just_me",
          });
        }),
      { seed: seedPage("an older page") },
    ),
  );

  it.effect("a visibility that changed in the config is published to the saved page before the belt is written", () =>
    withWriter(
      [publishStep, setStep],
      (write, dataDir, fake) =>
        Effect.gen(function* () {
          yield* write(at(recordedBelt(), NOW), NOW);
          const publish = fake.calls[0]!;
          assert.isTrue(isPublish(publish));
          assert.deepStrictEqual(publish.slice(3, 5), ["--page", PAGE_ID]);
          assert.deepStrictEqual(publish.slice(7, 9), ["--visibility", "just_me"]);
          assert.isTrue(isSet(fake.calls[1]!));
          assert.strictEqual(saved(dataDir).visibility, "just_me");
        }),
      // Published for the org; the config now says just_me.
      { seed: seedPage(HTML, "org") },
    ),
  );

  it.effect("while the page cannot be moved to the configured visibility, no belt is written to it", () =>
    withWriter(
      [{ argv: isPublish, fail: "Could not connect to API" }],
      (write, dataDir, fake, warnings) =>
        Effect.gen(function* () {
          yield* write(at(recordedBelt(), NOW), NOW);
          assert.strictEqual(warnings.length, 1);
          assert.strictEqual(fake.calls.filter(isSet).length, 0);
          assert.strictEqual(saved(dataDir).visibility, "org");
        }),
      // Published for the org; the config now says just_me.
      { seed: seedPage(HTML, "org") },
    ),
  );

  it.effect("a page Paradev reports at another visibility than the config's gets no belt, and belt.json says what Paradev said", () =>
    withWriter(
      [
        {
          argv: isPublish,
          fixture: "pages-publish-probe-ws",
          // Paradev published the version and kept the page's audience.
          edit: (answer) => ({ ...(answer as object), visibility: "org" }),
        },
      ],
      (write, dataDir, fake, warnings) =>
        Effect.gen(function* () {
          yield* write(at(recordedBelt(), NOW), NOW);
          assert.strictEqual(fake.calls.filter(isSet).length, 0);
          assert.strictEqual(warnings.length, 1);
          assert.include(warnings[0], "org");
          assert.strictEqual(saved(dataDir).visibility, "org");
          // Paradev has answered for this HTML at this visibility: later passes do not ask again.
          yield* write(at(recordedBelt(), NOW + 60_000), NOW + 60_000);
          yield* write(at(recordedBelt(), NOW + PUBLISH_RETRY_MS * 2), NOW + PUBLISH_RETRY_MS * 2);
          assert.strictEqual(fake.calls.filter(isPublish).length, 1);
          assert.strictEqual(fake.calls.filter(isSet).length, 0);
        }),
      { seed: seedPage(HTML, "org") },
    ),
  );

  it.effect("a belt.json from before visibility was saved publishes again with the configured one", () =>
    withWriter(
      [
        {
          argv: isPublish,
          fixture: "pages-publish-probe-ws",
          edit: (answer) => ({ ...(answer as object), visibility: "org" }),
        },
        setStep,
      ],
      (write, _dataDir, fake) =>
        Effect.gen(function* () {
          yield* write(at(recordedBelt(), NOW), NOW);
          assert.deepStrictEqual(fake.calls[0]!.slice(7, 9), ["--visibility", "org"]);
        }),
      {
        visibility: "org",
        seed: (dataDir) =>
          NodeFS.writeFileSync(
            NodePath.join(dataDir, "belt.json"),
            JSON.stringify({ pageId: PAGE_ID, htmlSha256: sha256(HTML) }),
          ),
      },
    ),
  );

  it.effect("an unchanged payload is not written again until the last write is 10 minutes old", () =>
    withWriter([publishStep, setStep, setStep, setStep, setStep], (write, _dataDir, fake) =>
      Effect.gen(function* () {
        const belt = recordedBelt();
        yield* write(at(belt, NOW), NOW);
        // Only `updatedAt` differs: no write.
        yield* write(at(belt, NOW + 60_000), NOW + 60_000);
        yield* write(at(belt, NOW + HEARTBEAT_MS - 1), NOW + HEARTBEAT_MS - 1);
        assert.strictEqual(fake.calls.filter(isSet).length, 1);
        // The heartbeat: the same payload, 10 minutes after the last write.
        yield* write(at(belt, NOW + HEARTBEAT_MS), NOW + HEARTBEAT_MS);
        assert.strictEqual(fake.calls.filter(isSet).length, 2);
        // A change is written at once.
        const changed = { ...belt, counts: { ...belt.counts, building: belt.counts.building + 1 } };
        yield* write(at(changed, NOW + HEARTBEAT_MS + 1), NOW + HEARTBEAT_MS + 1);
        assert.strictEqual(fake.calls.filter(isSet).length, 3);
        // So is a new pass time: only `updatedAt` is ignored.
        const later = { ...changed, runner: { ...changed.runner, lastPassAt: "2026-11-12T09:30:00.000Z" } };
        yield* write(at(later, NOW + HEARTBEAT_MS + 2), NOW + HEARTBEAT_MS + 2);
        assert.strictEqual(fake.calls.filter(isSet).length, 4);
        assert.strictEqual(HEARTBEAT_MS, 10 * 60_000);
      }),
    ),
  );

  it.effect("a page that changes is written to at once, whatever was written to the last one", () => {
    const memo = newBeltMemo();
    const other = "11111111-2222-3333-4444-555555555555";
    return Effect.gen(function* () {
      yield* withWriter(
        [setStep],
        (write) => write(at(recordedBelt(), NOW), NOW),
        { seed: seedPage(), memo },
      );
      yield* withWriter(
        [setStep],
        (write, _dataDir, fake) =>
          Effect.gen(function* () {
            yield* write(at(recordedBelt(), NOW + 60_000), NOW + 60_000);
            assert.strictEqual(fake.calls.find(isSet)![2], other);
          }),
        { seed: seedPage(HTML, "just_me", other), memo },
      );
    });
  });

  it.effect("a value over 65536 bytes is a warning, and the next pass writes again", () =>
    withWriter(
      [publishStep, { argv: isSet, fixture: "pages-storage-set-belt-oversize" }, setStep],
      (write, _dataDir, fake, warnings) =>
        Effect.gen(function* () {
          const big = oversizeBelt();
          yield* write(at(big, NOW), NOW);
          assert.strictEqual(warnings.length, 1);
          assert.include(warnings[0], "A stored value is at most 65536 bytes");
          // Not recorded as written, so the same payload is tried again.
          yield* write(at(big, NOW + 60_000), NOW + 60_000);
          assert.strictEqual(fake.calls.filter(isSet).length, 2);
        }),
    ),
  );

  it.effect("a publish that fails is a warning, writes nothing and is tried on the next pass", () =>
    withWriter(
      [{ argv: isPublish, fixture: "pages-publish-probe" }, publishStep, setStep],
      (write, dataDir, fake, warnings) =>
        Effect.gen(function* () {
          yield* write(at(recordedBelt(), NOW), NOW);
          assert.strictEqual(warnings.length, 1);
          assert.include(warnings[0], "Not logged in");
          assert.isFalse(NodeFS.existsSync(NodePath.join(dataDir, "belt.json")));
          assert.strictEqual(fake.calls.filter(isSet).length, 0);
          yield* write(at(recordedBelt(), NOW + 60_000), NOW + 60_000);
          assert.strictEqual(saved(dataDir).pageId, PAGE_ID);
          assert.strictEqual(fake.calls.filter(isSet).length, 1);
        }),
    ),
  );

  it.effect("a first publish that times out may have made a page, so no new one is tried for an hour", () =>
    withWriter(
      [publishStep, setStep],
      (write, dataDir, fake, warnings) =>
        Effect.gen(function* () {
          yield* write(at(recordedBelt(), NOW), NOW);
          assert.strictEqual(warnings.length, 1);
          assert.include(warnings[0], "TIMEOUT");
          // Passes within the hour publish nothing.
          yield* write(at(recordedBelt(), NOW + 60_000), NOW + 60_000);
          yield* write(at(recordedBelt(), NOW + PUBLISH_RETRY_MS - 1), NOW + PUBLISH_RETRY_MS - 1);
          assert.strictEqual(fake.calls.filter(isPublish).length, 1);
          yield* write(at(recordedBelt(), NOW + PUBLISH_RETRY_MS), NOW + PUBLISH_RETRY_MS);
          assert.strictEqual(fake.calls.filter(isPublish).length, 2);
          assert.strictEqual(saved(dataDir).pageId, PAGE_ID);
        }),
      { firstPublishTimesOut: true },
    ),
  );

  it.effect("a republish that fails is a warning and the belt still goes to the saved page", () =>
    withWriter(
      [{ argv: isPublish, fail: "Could not connect to API" }, setStep],
      (write, dataDir, fake, warnings) =>
        Effect.gen(function* () {
          yield* write(at(recordedBelt(), NOW), NOW);
          assert.strictEqual(warnings.length, 1);
          assert.strictEqual(fake.calls.filter(isSet).length, 1);
          assert.strictEqual(fake.calls.find(isSet)![2], PAGE_ID);
          // The old hash stays, so the next pass publishes again.
          assert.strictEqual(saved(dataDir).htmlSha256, sha256("an older page"));
        }),
      { seed: seedPage("an older page") },
    ),
  );
});
