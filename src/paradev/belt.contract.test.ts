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
  writeBelt,
  type BeltMemo,
  type BeltTarget,
} from "./belt.ts";
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
  seed: (dataDir: string) => void = () => {},
  memo: BeltMemo = newBeltMemo(),
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dataDir = yield* fs.makeTempDirectoryScoped({ prefix: "belt-" });
      seed(dataDir);
      const fake = fakeSuperset(script);
      const cli = yield* Effect.provide(
        Effect.gen(function* () {
          return yield* SupersetCli;
        }),
        cliLayer({ cli: "superset" }).pipe(Layer.provide(fake.layer)),
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
        visibility: "just_me",
        memo,
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
  };

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
        assert.deepStrictEqual(saved(dataDir), { pageId: PAGE_ID, htmlSha256: sha256(HTML) });
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

  it.effect("a saved page with the same HTML is not published again", () =>
    withWriter(
      [setStep],
      (write, _dataDir, fake) =>
        Effect.gen(function* () {
          yield* write(at(recordedBelt(), NOW), NOW);
          assert.strictEqual(fake.calls.length, 1);
          assert.isTrue(isSet(fake.calls[0]!));
        }),
      (dataDir) =>
        NodeFS.writeFileSync(
          NodePath.join(dataDir, "belt.json"),
          JSON.stringify({ pageId: PAGE_ID, htmlSha256: sha256(HTML) }),
        ),
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
            "--no-watch",
          ]);
          assert.deepStrictEqual(saved(dataDir), { pageId: PAGE_ID, htmlSha256: sha256(HTML) });
        }),
      (dataDir) =>
        NodeFS.writeFileSync(
          NodePath.join(dataDir, "belt.json"),
          JSON.stringify({ pageId: PAGE_ID, htmlSha256: sha256("an older page") }),
        ),
    ),
  );

  it.effect("an unchanged payload is not written again until the last write is 10 minutes old", () =>
    withWriter([publishStep, setStep, setStep, setStep], (write, _dataDir, fake) =>
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
        assert.strictEqual(HEARTBEAT_MS, 10 * 60_000);
      }),
    ),
  );

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
      (dataDir) =>
        NodeFS.writeFileSync(
          NodePath.join(dataDir, "belt.json"),
          JSON.stringify({ pageId: PAGE_ID, htmlSha256: sha256("an older page") }),
        ),
    ),
  );
});
