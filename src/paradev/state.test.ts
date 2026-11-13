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
  targetOf,
  type ThreadRecord,
  threadIdOf,
  workspaceIdOf,
  writeLaunch,
  writeThread,
} from "./state.ts";

const tempDir = useTempDirs();

const WS = "be47b9e8-7687-4c3c-8791-5fd7f04ba5fe";

const record = (over: Partial<ThreadRecord> = {}): ThreadRecord => ({
  v: 2,
  threadId: `local:${WS}`,
  target: { kind: "local" },
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

  it.effect("a pending send reads back, and a record written before pendingSend existed still decodes", () =>
    Effect.gen(function* () {
      const data = tempDir("state");
      const pending = record({ pendingSend: { commandId: "softfac:o__r__1__1:gate-1", before: null } });
      yield* writeThread(data, pending);
      assert.deepStrictEqual(yield* readThread(data, WS), pending);
      NodeFS.writeFileSync(threadFile(data), JSON.stringify(record()));
      const older = yield* readThread(data, WS);
      assert.deepStrictEqual(older, record());
      assert.notProperty(older, "pendingSend");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("a v1 record reads as a local target, and is written back as v2", () =>
    Effect.gen(function* () {
      const data = tempDir("state");
      const { v: _v, target: _target, ...fields } = record();
      const v1 = { v: 1, ...fields, location: "local" };
      NodeFS.mkdirSync(NodePath.dirname(threadFile(data)), { recursive: true });
      NodeFS.writeFileSync(threadFile(data), `${JSON.stringify(v1)}\n`);
      const read = yield* readThread(data, WS);
      assert.deepStrictEqual(read, record());
      assert.notProperty(read, "location");
      assert.deepStrictEqual(yield* listThreads(data), [record()]);
      // Reading never rewrites the file.
      assert.deepStrictEqual(JSON.parse(NodeFS.readFileSync(threadFile(data), "utf8")), v1);
      yield* writeThread(data, { ...read!, archivedAt: 1 });
      assert.deepStrictEqual(JSON.parse(NodeFS.readFileSync(threadFile(data), "utf8")), record({ archivedAt: 1 }));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("a v2 record of each target round-trips", () =>
    Effect.gen(function* () {
      const data = tempDir("state");
      for (const over of [
        { threadId: `local:${WS}`, target: { kind: "local" } },
        {
          threadId: `host:c9c39956e0c1756e30d6bb9f4f907ff1:${WS}`,
          target: { kind: "host", machineId: "c9c39956e0c1756e30d6bb9f4f907ff1", name: "trilogy-mac" },
        },
        {
          threadId: `cloud:${WS}`,
          target: { kind: "cloud", environmentId: "edad9805-e48d-40f3-a06c-e19a4105f974" },
          branch: "superset/fac-1-1-a2bc69cb",
          worktreePath: "/workspace",
        },
      ] as const) {
        yield* writeThread(data, record(over));
        assert.deepStrictEqual(yield* readThread(data, WS), record(over));
        assert.deepStrictEqual(JSON.parse(NodeFS.readFileSync(threadFile(data), "utf8")), record(over));
      }
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
      NodeFS.writeFileSync(threadFile(data), JSON.stringify({ ...record(), v: 3 }));
      assert.isNull(yield* readThread(data, WS));
      const { target: _, ...noTarget } = record();
      NodeFS.writeFileSync(threadFile(data), JSON.stringify(noTarget));
      assert.isNull(yield* readThread(data, WS));
      NodeFS.writeFileSync(threadFile(data), JSON.stringify({ ...record(), target: { kind: "host", machineId: "m" } }));
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
  const HOST = "c9c39956e0c1756e30d6bb9f4f907ff1";

  it("are local:<ws>, host:<machineId>:<ws> or cloud:<ws> from a target", () => {
    assert.strictEqual(threadIdOf({ kind: "local" }, WS), `local:${WS}`);
    assert.strictEqual(threadIdOf({ kind: "host", machineId: HOST, name: "trilogy-mac" }, WS), `host:${HOST}:${WS}`);
    assert.strictEqual(threadIdOf({ kind: "cloud", environmentId: "env" }, WS), `cloud:${WS}`);
  });

  it("targetOf reads each form back, and a malformed id as null", () => {
    assert.deepStrictEqual(targetOf(`local:${WS}`), { target: { kind: "local" }, workspaceId: WS });
    assert.deepStrictEqual(targetOf(`host:${HOST}:${WS}`), {
      target: { kind: "host", machineId: HOST },
      workspaceId: WS,
    });
    assert.deepStrictEqual(targetOf(`cloud:${WS}`), { target: { kind: "cloud" }, workspaceId: WS });
    for (const target of [{ kind: "local" }, { kind: "host", machineId: HOST }, { kind: "cloud" }] as const) {
      assert.deepStrictEqual(targetOf(threadIdOf(target, WS)), { target, workspaceId: WS });
    }
    for (const bad of [
      "",
      WS,
      "local:",
      "local:../etc",
      "local:a/b",
      "local:a:b",
      "host:",
      `host:${HOST}`,
      `host:${HOST}:`,
      `host::${WS}`,
      `host:a/b:${WS}`,
      `host:${HOST}:${WS}:x`,
      "cloud:",
      "cloud:a.b",
      `remote:${WS}`,
      `LOCAL:${WS}`,
    ]) {
      assert.isNull(targetOf(bad), bad);
    }
  });

  it("workspaceIdOf answers local thread ids only, and only a plain id parses back", () => {
    assert.strictEqual(workspaceIdOf(`local:${WS}`), WS);
    for (const bad of [WS, "local:", "host:m:abc", "local:../etc", "local:a/b", "cloud:abc"]) {
      assert.isNull(workspaceIdOf(bad), bad);
    }
  });
});
