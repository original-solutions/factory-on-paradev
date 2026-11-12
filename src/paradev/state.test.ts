// @effect-diagnostics nodeBuiltinImport:off - the test reads and tears the real files state.ts writes.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { useTempDirs } from "../ledger/testSupport.ts";
import {
  listThreads,
  readLaunch,
  readThread,
  type ThreadRecord,
  threadIdOf,
  workspaceIdOf,
  writeLaunch,
  writeThread,
} from "./state.ts";

const tempDir = useTempDirs();

const WS = "be47b9e8-7687-4c3c-8791-5fd7f04ba5fe";

const record = (over: Partial<ThreadRecord> = {}): ThreadRecord => ({
  v: 1,
  threadId: `local:${WS}`,
  location: "local",
  workspaceId: WS,
  projectId: "e9ab7dc2-e7f6-42d9-94ed-82d6d623aabd",
  branch: "fac/1-1",
  worktreePath: "/Users/me/.paradev/worktrees/factory-paradev-spike/fac/1-1",
  launchCommandId: "softfac:o__r__1__1:launch",
  agent: "claude",
  terminals: ["27446599-a510-4df8-989b-45938576d96b"],
  turns: [{ commandId: "softfac:o__r__1__1:launch", at: 1794329708000, kind: "launch" }],
  archivedAt: null,
  ...over,
});

const threadFile = (data: string, ws = WS) => NodePath.join(data, "paradev", "threads", `${ws}.json`);

describe("thread records", () => {
  it.effect("are written whole to <data>/paradev/threads/<workspaceId>.json and read back", () =>
    Effect.gen(function* () {
      const data = tempDir("state");
      yield* writeThread(data, record({ terminals: [] }));
      const first = NodeFS.statSync(threadFile(data)).ino;
      yield* writeThread(data, record());
      // A new file renamed over the old one, never the old one rewritten in place.
      assert.notStrictEqual(NodeFS.statSync(threadFile(data)).ino, first);
      assert.deepStrictEqual(yield* readThread(data, WS), record());
      assert.deepStrictEqual(JSON.parse(NodeFS.readFileSync(threadFile(data), "utf8")), record());
      // The atomic write leaves no temp file or folder beside the record.
      assert.deepStrictEqual(NodeFS.readdirSync(NodePath.dirname(threadFile(data))), [`${WS}.json`]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("a missing record reads as null", () =>
    Effect.gen(function* () {
      assert.isNull(yield* readThread(tempDir("state"), WS));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("a torn or foreign file reads as missing", () =>
    Effect.gen(function* () {
      const data = tempDir("state");
      yield* writeThread(data, record());
      const whole = NodeFS.readFileSync(threadFile(data), "utf8");
      NodeFS.writeFileSync(threadFile(data), whole.slice(0, whole.length / 2));
      assert.isNull(yield* readThread(data, WS));
      NodeFS.writeFileSync(threadFile(data), JSON.stringify({ ...record(), v: 2 }));
      assert.isNull(yield* readThread(data, WS));
      NodeFS.writeFileSync(threadFile(data), "");
      assert.isNull(yield* readThread(data, WS));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("listThreads reads every whole record and skips torn ones", () =>
    Effect.gen(function* () {
      const data = tempDir("state");
      assert.deepStrictEqual(yield* listThreads(data), []);
      const other = "f7631c1d-214c-4a35-98b8-fd0cba008887";
      yield* writeThread(data, record());
      yield* writeThread(data, record({ workspaceId: other, threadId: `local:${other}` }));
      NodeFS.writeFileSync(threadFile(data, "torn"), "{\"v\":1,");
      const ids = (yield* listThreads(data)).map((r) => r.workspaceId).sort();
      assert.deepStrictEqual(ids, [WS, other].sort());
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("launch files", () => {
  it.effect("find a thread again by its launch command id, under sha256 of the id", () =>
    Effect.gen(function* () {
      const data = tempDir("state");
      const id = "softfac:o__r__1__1:launch";
      assert.isNull(yield* readLaunch(data, id));
      yield* writeLaunch(data, id, `local:${WS}`);
      assert.strictEqual(yield* readLaunch(data, id), `local:${WS}`);
      assert.isNull(yield* readLaunch(data, "softfac:o__r__1__2:launch"));
      const hash = NodeCrypto.createHash("sha256").update(id).digest("hex");
      const file = NodePath.join(data, "paradev", "launches", `${hash}.json`);
      assert.deepStrictEqual(JSON.parse(NodeFS.readFileSync(file, "utf8")), { threadId: `local:${WS}` });
      NodeFS.writeFileSync(file, "{\"thread");
      assert.isNull(yield* readLaunch(data, id));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("thread ids", () => {
  it("are local:<workspaceId>, and only a plain id parses back", () => {
    assert.strictEqual(threadIdOf(WS), `local:${WS}`);
    assert.strictEqual(workspaceIdOf(`local:${WS}`), WS);
    for (const bad of [WS, "local:", "host:m:abc", "local:../etc", "local:a/b", "cloud:abc"]) {
      assert.isNull(workspaceIdOf(bad), bad);
    }
  });
});
