import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type { AttentionItem, NewItem } from "../attention.ts";
import type { HostConfig, MachineConfig, WatchedRepo } from "../config.ts";
import type { MachineEvent } from "../ledger/events.ts";
import type { Load } from "../load.ts";
import { NoTargetHasRoom, type LaunchRequest } from "../sessions.ts";
import {
  CLOUD_PROXY_DOWN_ITEM_ID,
  CLOUD_PROXY_OPEN_ITEM_ID,
  makePlacer,
} from "./placer.ts";
import type { ProxyGet } from "./proxy.ts";
import type { TargetCount } from "./sessions.ts";

const HOST: HostConfig = { id: "h1", name: "mini", ssh: "me@mini", maxRuns: 1, maxLoadPerCore: 1 };
const PROXY = "https://proxy.example.ts.net:8443";

const machine = (over: Partial<MachineConfig> = {}): MachineConfig => ({
  ghConfigDir: "/gh",
  pollSeconds: 60,
  maxConcurrentRuns: 4,
  maxConcurrentGates: 2,
  feedbackSeconds: 600,
  notify: true,
  minFreeGib: 10,
  maxLoadPerCore: 1,
  modelFallbacks: {},
  repos: [],
  hosts: [HOST],
  cloud: { machineSize: "small", maxRuns: 1, proxy: PROXY },
  local: { maxRuns: 1 },
  paradev: { cli: "/opt/superset", agent: "claude", belt: { enabled: false, visibility: "just_me" } },
  ...over,
});

const MAC: WatchedRepo = { repo: "acme/mac", path: "/Users/tom/mac" };
const WIDE: WatchedRepo = {
  repo: "acme/wide",
  path: "/Users/tom/wide",
  hosts: [{ id: "h1", path: "/srv/wide" }],
  cloud: "env-1",
};
const HOSTED: WatchedRepo = { repo: "acme/hosted", path: "/Users/tom/hosted", hosts: [{ id: "h1", path: "/srv/hosted" }] };
const CLOUDY: WatchedRepo = { repo: "acme/cloudy", path: "/Users/tom/cloudy", cloud: "env-1" };
const BY_PROJECT: Record<string, WatchedRepo> = { mac: MAC, wide: WIDE, hosted: HOSTED, cloudy: CLOUDY };

const request = (projectId: string, n = 1): LaunchRequest => ({
  commandId: `launch-${projectId}-${n}`,
  projectId,
  title: "t",
  baseRef: "main",
  message: "m",
  model: { instanceId: "claude", model: "opus" },
});

const quiet: Load = { oneMinute: 1, cores: 10 };

const setup = (
  options: {
    machine?: MachineConfig;
    counts?: ReadonlyArray<TargetCount>;
    proxy?: Array<number>;
    hostLoad?: Load | null;
    notReady?: ReadonlyMap<string, string>;
  } = {},
) => {
  const reads = { running: 0, proxy: 0, load: 0 };
  const asked: Array<string> = [];
  const items = new Map<string, NewItem>();
  const events: Array<MachineEvent> = [];
  const counts = options.counts ?? [
    { target: { kind: "local" }, running: 0 },
    { target: { kind: "host", machineId: "h1" }, running: 0 },
    { target: { kind: "cloud" }, running: 0 },
  ];
  const statuses = options.proxy ?? [401];
  const proxyGet: ProxyGet = (url) =>
    Effect.sync(() => {
      reads.proxy += 1;
      asked.push(url);
      return statuses.length > 1 ? statuses.shift()! : statuses[0]!;
    });
  const placer = makePlacer({
    machine: options.machine ?? machine(),
    repoOfProject: (id) => BY_PROJECT[id] ?? null,
    hostLoads: new Map<string, Load | null>([["h1", options.hostLoad === undefined ? quiet : options.hostLoad]]),
    hostsNotReady: () => options.notReady ?? new Map(),
    readLoad: () => {
      reads.load += 1;
      return quiet;
    },
    running: Effect.sync(() => {
      reads.running += 1;
      return counts.map((count) => ({ ...count }));
    }),
    proxyGet,
    attention: {
      raise: (item) => Effect.sync(() => void items.set(item.id, item)),
      clear: (matches) =>
        Effect.sync(() => {
          for (const [id, item] of [...items]) {
            if (matches({ ...item, firstSeenMs: 0 } satisfies AttentionItem)) items.delete(id);
          }
        }),
    },
    record: (event) => Effect.sync(() => void events.push(event)),
  });
  return { placer, reads, asked, items, events };
};

/** The placement drops the machine log got, in order. */
const drops = (events: ReadonlyArray<MachineEvent>) =>
  events.flatMap((event) => (event.event === "placement" ? [event.data] : []));

const full = (target: TargetCount["target"]): TargetCount => ({ target, running: 1 });

describe("placer", () => {
  it.effect("a repo with no hosts and no cloud runs here, with nothing read", () =>
    Effect.gen(function* () {
      const t = setup();
      t.placer.beginPass(null);
      assert.deepStrictEqual(yield* t.placer.place(request("mac")), { kind: "local" });
      assert.deepStrictEqual(t.reads, { running: 0, proxy: 0, load: 0 });
      assert.deepStrictEqual(t.events, []);
    }),
  );

  it.effect("a project no watched repo is known for runs here too", () =>
    Effect.gen(function* () {
      const t = setup();
      t.placer.beginPass(null);
      assert.deepStrictEqual(yield* t.placer.place(request("nobody")), { kind: "local" });
      assert.deepStrictEqual(t.reads, { running: 0, proxy: 0, load: 0 });
    }),
  );

  it.effect("a repo with a cloud environment on a machine with no cloud block runs as one with no cloud", () =>
    Effect.gen(function* () {
      const t = setup({ machine: machine({ hosts: [], cloud: undefined }) });
      t.placer.beginPass(null);
      assert.deepStrictEqual(yield* t.placer.place(request("cloudy")), { kind: "local" });
      assert.deepStrictEqual(t.reads, { running: 0, proxy: 0, load: 0 });
    }),
  );

  it.effect("places on the least loaded machine, this Mac on a tie", () =>
    Effect.gen(function* () {
      const quietHost = setup({ hostLoad: { oneMinute: 0.5, cores: 10 } });
      quietHost.placer.beginPass(null);
      assert.deepStrictEqual(yield* quietHost.placer.place(request("hosted")), {
        kind: "host",
        machineId: "h1",
        path: "/srv/hosted",
      });
      const tied = setup();
      tied.placer.beginPass(null);
      assert.deepStrictEqual(yield* tied.placer.place(request("hosted")), { kind: "local" });
    }),
  );

  it.effect("reads the counts once per pass, and a second launch sees the first one's slot", () =>
    Effect.gen(function* () {
      const t = setup();
      t.placer.beginPass("high load");
      const first = yield* t.placer.place(request("hosted", 1));
      assert.deepStrictEqual(first, { kind: "host", machineId: "h1", path: "/srv/hosted" });
      // The host's one slot is taken, and this Mac holds claims: nothing has room.
      const second = yield* t.placer.place(request("hosted", 2)).pipe(Effect.flip);
      assert.instanceOf(second, NoTargetHasRoom);
      assert.strictEqual(t.reads.running, 1);
    }),
  );

  it.effect("a new pass reads the counts again", () =>
    Effect.gen(function* () {
      const t = setup();
      t.placer.beginPass(null);
      yield* t.placer.place(request("hosted"));
      t.placer.beginPass(null);
      yield* t.placer.place(request("hosted"));
      assert.strictEqual(t.reads.running, 2);
    }),
  );

  it.effect("a refusal fails with NoTargetHasRoom and records every drop once per pass and target", () =>
    Effect.gen(function* () {
      const t = setup({ counts: [full({ kind: "local" }), full({ kind: "host", machineId: "h1" })] });
      t.placer.beginPass(null);
      const error = yield* t.placer.place(request("hosted", 1)).pipe(Effect.flip);
      assert.instanceOf(error, NoTargetHasRoom);
      assert.strictEqual(error.message, "no target has room");
      yield* t.placer.place(request("hosted", 2)).pipe(Effect.flip);
      const dropped = [
        { repo: "acme/hosted", target: "local", reason: "slots full: 1 of 1 running" },
        { repo: "acme/hosted", target: "mini", reason: "slots full: 1 of 1 running" },
      ];
      assert.deepStrictEqual(drops(t.events), dropped);
      t.placer.beginPass(null);
      yield* t.placer.place(request("hosted", 3)).pipe(Effect.flip);
      assert.deepStrictEqual(drops(t.events), [...dropped, ...dropped]);
    }),
  );

  it.effect("a target that was not read has no count, and is dropped", () =>
    Effect.gen(function* () {
      const t = setup({ counts: [{ target: { kind: "local" }, running: 0 }] });
      t.placer.beginPass(null);
      assert.deepStrictEqual(yield* t.placer.place(request("hosted")), { kind: "local" });
      assert.deepStrictEqual(drops(t.events), [
        { repo: "acme/hosted", target: "mini", reason: "its running agents could not be counted" },
      ]);
    }),
  );

  it.effect("a host that is not ready, or whose load was not read, is dropped", () =>
    Effect.gen(function* () {
      const notReady = setup({ notReady: new Map([["h1", "claude is not trusted"]]) });
      notReady.placer.beginPass(null);
      yield* notReady.placer.place(request("hosted"));
      assert.deepStrictEqual(drops(notReady.events), [
        { repo: "acme/hosted", target: "mini", reason: "not ready: claude is not trusted" },
      ]);
      const unread = setup({ hostLoad: null });
      unread.placer.beginPass(null);
      yield* unread.placer.place(request("hosted"));
      assert.deepStrictEqual(drops(unread.events), [
        { repo: "acme/hosted", target: "mini", reason: "its load was not read this pass" },
      ]);
    }),
  );

  it.effect("a proxy that answers 401 lets cloud take a launch no machine has room for", () =>
    Effect.gen(function* () {
      const t = setup({ counts: [full({ kind: "local" }), full({ kind: "host", machineId: "h1" }), { target: { kind: "cloud" }, running: 0 }] });
      t.placer.beginPass(null);
      assert.deepStrictEqual(yield* t.placer.place(request("wide")), {
        kind: "cloud",
        environmentId: "env-1",
        machineSize: "small",
      });
      assert.deepStrictEqual(t.asked, [`${PROXY}/v1/models`]);
      assert.deepStrictEqual([...t.items.keys()], []);
    }),
  );

  it.effect("asks the proxy at most once per pass", () =>
    Effect.gen(function* () {
      const t = setup({ machine: machine({ cloud: { machineSize: "small", maxRuns: 5, proxy: PROXY } }), counts: [full({ kind: "local" }), full({ kind: "host", machineId: "h1" }), { target: { kind: "cloud" }, running: 0 }] });
      t.placer.beginPass(null);
      yield* t.placer.place(request("wide", 1));
      yield* t.placer.place(request("wide", 2));
      assert.strictEqual(t.reads.proxy, 1);
      t.placer.beginPass(null);
      yield* t.placer.place(request("wide", 3));
      assert.strictEqual(t.reads.proxy, 2);
    }),
  );

  it.effect("a proxy that answers 200 raises an item and drops cloud", () =>
    Effect.gen(function* () {
      const t = setup({ proxy: [200], counts: [full({ kind: "local" }), full({ kind: "host", machineId: "h1" }), { target: { kind: "cloud" }, running: 0 }] });
      t.placer.beginPass(null);
      const error = yield* t.placer.place(request("wide")).pipe(Effect.flip);
      assert.instanceOf(error, NoTargetHasRoom);
      const item = t.items.get(CLOUD_PROXY_OPEN_ITEM_ID)!;
      assert.strictEqual(item.kind, "attention");
      assert.include(item.message, PROXY);
      assert.include(item.message, "key check is off");
      assert.deepStrictEqual(
        drops(t.events).filter((e) => e.target === "cloud"),
        [{ repo: "acme/wide", target: "cloud", reason: "the proxy's key check is off (it answered 200 with no key)" }],
      );
    }),
  );

  it.effect("a proxy that is down raises cloud-proxy-down on the third pass in a row, and a 401 clears it", () =>
    Effect.gen(function* () {
      const t = setup({ proxy: [503, 503, 503, 401], counts: [{ target: { kind: "local" }, running: 0 }, { target: { kind: "host", machineId: "h1" }, running: 0 }, { target: { kind: "cloud" }, running: 0 }] });
      const pass = Effect.gen(function* () {
        t.placer.beginPass(null);
        yield* t.placer.place(request("wide"));
      });
      yield* pass;
      yield* pass;
      assert.isFalse(t.items.has(CLOUD_PROXY_DOWN_ITEM_ID));
      yield* pass;
      const item = t.items.get(CLOUD_PROXY_DOWN_ITEM_ID)!;
      assert.include(item.message, PROXY);
      assert.include(item.message, "tailscale funnel status");
      assert.include(item.message, "tailscale funnel --bg --https=8443");
      assert.notInclude(item.message, "503");
      assert.isTrue(
        drops(t.events).some((e) => e.target === "cloud" && e.reason === "the proxy check failed: answered HTTP 503"),
      );
      yield* pass;
      assert.isFalse(t.items.has(CLOUD_PROXY_DOWN_ITEM_ID));
    }),
  );

  it.effect("a miss then a good answer starts the count over", () =>
    Effect.gen(function* () {
      const t = setup({ proxy: [503, 503, 401, 503, 503] });
      const pass = Effect.gen(function* () {
        t.placer.beginPass(null);
        yield* t.placer.place(request("wide"));
      });
      for (let i = 0; i < 5; i += 1) yield* pass;
      assert.isFalse(t.items.has(CLOUD_PROXY_DOWN_ITEM_ID));
    }),
  );
});
