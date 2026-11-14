import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type { HostConfig, MachineConfig, WatchedRepo } from "../config.ts";
import type { MachineEvent } from "../ledger/events.ts";
import type { Load } from "../load.ts";
import { NoTargetHasRoom, type LaunchRequest } from "../sessions.ts";
import { makePlacer } from "./placer.ts";
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
const BOTH: WatchedRepo = {
  repo: "acme/both",
  path: "/Users/tom/both",
  hosts: [
    { id: "h1", path: "/srv/both" },
    { id: "h2", path: "/srv/both" },
  ],
};
const BY_PROJECT: Record<string, WatchedRepo> = { both: BOTH, mac: MAC, wide: WIDE, hosted: HOSTED, cloudy: CLOUDY };

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
    hostLoad?: Load | null;
    notReady?: ReadonlyMap<string, string>;
    /** Effect run before `running` answers: a slow read. */
    slowRead?: Effect.Effect<void>;
  } = {},
) => {
  const reads = { running: 0, load: 0 };
  const events: Array<MachineEvent> = [];
  const counts = options.counts ?? [
    { target: { kind: "local" }, running: 0 },
    { target: { kind: "host", machineId: "h1" }, running: 0 },
    { target: { kind: "cloud" }, running: 0 },
  ];
  const placer = makePlacer({
    machine: options.machine ?? machine(),
    repoOfProject: (id) => BY_PROJECT[id] ?? null,
    hostLoads: new Map<string, Load | null>([["h1", options.hostLoad === undefined ? quiet : options.hostLoad]]),
    hostsNotReady: () => options.notReady ?? new Map(),
    readLoad: () => {
      reads.load += 1;
      return quiet;
    },
    running: Effect.gen(function* () {
      reads.running += 1;
      if (options.slowRead !== undefined) yield* options.slowRead;
      return counts.map((count) => ({ ...count }));
    }),
    record: (event) => Effect.sync(() => void events.push(event)),
  });
  return { placer, reads, events };
};

/** The placement drops the machine log got, in order. */
const drops = (events: ReadonlyArray<MachineEvent>) =>
  events.flatMap((event) => (event.event === "placement" ? [event.data] : []));

const full = (target: TargetCount["target"]): TargetCount => ({ target, running: 1 });

describe("placer", () => {
  it.effect("a repo with no hosts and no cloud runs here, with nothing read, when local.max_runs reaches the core's cap", () =>
    Effect.gen(function* () {
      const t = setup({ machine: machine({ local: { maxRuns: 4 } }) });
      t.placer.beginPass({ localHeld: null, proxy: null });
      assert.deepStrictEqual(yield* t.placer.place(request("mac")), { kind: "local" });
      assert.deepStrictEqual(t.reads, { running: 0, load: 0 });
      assert.deepStrictEqual(t.events, []);
    }),
  );

  it.effect("a project no watched repo is known for runs here too", () =>
    Effect.gen(function* () {
      const t = setup({ machine: machine({ local: { maxRuns: 4 } }) });
      t.placer.beginPass({ localHeld: null, proxy: null });
      assert.deepStrictEqual(yield* t.placer.place(request("nobody")), { kind: "local" });
      assert.deepStrictEqual(t.reads, { running: 0, load: 0 });
    }),
  );

  it.effect("a repo with no hosts and no cloud is refused when this Mac's slots are full, and the drop is recorded", () =>
    Effect.gen(function* () {
      const t = setup({ counts: [{ target: { kind: "local" }, running: 1 }] });
      t.placer.beginPass({ localHeld: null, proxy: null });
      const error = yield* t.placer.place(request("mac")).pipe(Effect.flip);
      assert.instanceOf(error, NoTargetHasRoom);
      assert.deepStrictEqual(drops(t.events), [
        { repo: "acme/mac", target: "local", reason: "slots full: 1 of 1 running" },
      ]);
    }),
  );

  it.effect("a project no watched repo is known for gets the same slot check on this Mac", () =>
    Effect.gen(function* () {
      const t = setup({ counts: [{ target: { kind: "local" }, running: 1 }] });
      t.placer.beginPass({ localHeld: null, proxy: null });
      const error = yield* t.placer.place(request("nobody")).pipe(Effect.flip);
      assert.instanceOf(error, NoTargetHasRoom);
      assert.strictEqual(drops(t.events).length, 1);
    }),
  );

  it.effect("a repo with no hosts takes this Mac's last slot once, and the check adds no load or held test", () =>
    Effect.gen(function* () {
      const t = setup({ counts: [{ target: { kind: "local" }, running: 0 }] });
      t.placer.beginPass({ localHeld: "high load", proxy: null });
      assert.deepStrictEqual(yield* t.placer.place(request("mac", 1)), { kind: "local" });
      const second = yield* t.placer.place(request("mac", 2)).pipe(Effect.flip);
      assert.instanceOf(second, NoTargetHasRoom);
      assert.strictEqual(t.reads.running, 1);
    }),
  );

  it.effect("a repo with a cloud environment on a machine with no cloud block runs as one with no cloud", () =>
    Effect.gen(function* () {
      const t = setup({ machine: machine({ hosts: [], cloud: undefined, local: { maxRuns: 4 } }) });
      t.placer.beginPass({ localHeld: null, proxy: null });
      assert.deepStrictEqual(yield* t.placer.place(request("cloudy")), { kind: "local" });
      assert.deepStrictEqual(t.reads, { running: 0, load: 0 });
    }),
  );

  it.effect("places on the least loaded machine, this Mac on a tie", () =>
    Effect.gen(function* () {
      const quietHost = setup({ hostLoad: { oneMinute: 0.5, cores: 10 } });
      quietHost.placer.beginPass({ localHeld: null, proxy: null });
      assert.deepStrictEqual(yield* quietHost.placer.place(request("hosted")), {
        kind: "host",
        machineId: "h1",
        path: "/srv/hosted",
      });
      const tied = setup();
      tied.placer.beginPass({ localHeld: null, proxy: null });
      assert.deepStrictEqual(yield* tied.placer.place(request("hosted")), { kind: "local" });
    }),
  );

  it.effect("reads the counts once per pass, and a second launch sees the first one's slot", () =>
    Effect.gen(function* () {
      const t = setup();
      t.placer.beginPass({ localHeld: "high load", proxy: null });
      const first = yield* t.placer.place(request("hosted", 1));
      assert.deepStrictEqual(first, { kind: "host", machineId: "h1", path: "/srv/hosted" });
      // The host's one slot is taken, and this Mac holds claims: nothing has room.
      const second = yield* t.placer.place(request("hosted", 2)).pipe(Effect.flip);
      assert.instanceOf(second, NoTargetHasRoom);
      assert.strictEqual(t.reads.running, 1);
    }),
  );

  it.effect("a launch on a repo with no hosts takes a slot on this Mac for the rest of the pass", () =>
    Effect.gen(function* () {
      const t = setup({ machine: machine({ local: { maxRuns: 2 }, hosts: [{ ...HOST, maxRuns: 2 }] }) });
      t.placer.beginPass({ localHeld: null, proxy: null });
      // The first hosted launch reads the counts; this Mac wins the tie and holds one.
      assert.deepStrictEqual(yield* t.placer.place(request("hosted", 1)), { kind: "local" });
      // A launch on a repo with no hosts is this Mac's too, and fills it.
      assert.deepStrictEqual(yield* t.placer.place(request("mac")), { kind: "local" });
      assert.deepStrictEqual(yield* t.placer.place(request("hosted", 3)), {
        kind: "host",
        machineId: "h1",
        path: "/srv/hosted",
      });
    }),
  );

  it.effect("two launches placed at once read the counts once and do not both take the last slot", () =>
    Effect.gen(function* () {
      const t = setup({ slowRead: Effect.forEach([1, 2, 3, 4, 5], () => Effect.yieldNow, { discard: true }) });
      t.placer.beginPass({ localHeld: "high load", proxy: null });
      const results = yield* Effect.all(
        [t.placer.place(request("hosted", 1)), t.placer.place(request("hosted", 2))].map((place) => Effect.result(place)),
        { concurrency: "unbounded" },
      );
      assert.strictEqual(t.reads.running, 1);
      assert.deepStrictEqual(results.map((result) => result._tag).sort(), ["Failure", "Success"]);
    }),
  );

  it.effect("a placement whose launch has not ended still counts in the next pass, and stops when it ends", () =>
    Effect.gen(function* () {
      const t = setup();
      t.placer.beginPass({ localHeld: "high load", proxy: null });
      const first = request("hosted", 1);
      assert.deepStrictEqual(yield* t.placer.place(first), { kind: "host", machineId: "h1", path: "/srv/hosted" });
      // The next pass: the snapshot does not show the agent yet, but the launch is still running.
      t.placer.beginPass({ localHeld: "high load", proxy: null });
      const refused = yield* t.placer.place(request("hosted", 2)).pipe(Effect.flip);
      assert.instanceOf(refused, NoTargetHasRoom);
      // The launch ended: its agent is in the snapshot now, which is what counts.
      yield* t.placer.launchEnded(first.commandId);
      t.placer.beginPass({ localHeld: "high load", proxy: null });
      assert.deepStrictEqual(yield* t.placer.place(request("hosted", 3)), {
        kind: "host",
        machineId: "h1",
        path: "/srv/hosted",
      });
    }),
  );

  it.effect("a launch on a repo with no hosts is in flight too", () =>
    Effect.gen(function* () {
      const t = setup();
      t.placer.beginPass({ localHeld: null, proxy: null });
      const mac = request("mac");
      assert.deepStrictEqual(yield* t.placer.place(mac), { kind: "local" });
      t.placer.beginPass({ localHeld: null, proxy: null });
      // This Mac holds one slot of one: the hosted repo's launch goes to the host.
      assert.deepStrictEqual(yield* t.placer.place(request("hosted")), {
        kind: "host",
        machineId: "h1",
        path: "/srv/hosted",
      });
    }),
  );

  it.effect("a new pass reads the counts again", () =>
    Effect.gen(function* () {
      const t = setup();
      t.placer.beginPass({ localHeld: null, proxy: null });
      yield* t.placer.place(request("hosted"));
      t.placer.beginPass({ localHeld: null, proxy: null });
      yield* t.placer.place(request("hosted"));
      assert.strictEqual(t.reads.running, 2);
    }),
  );

  it.effect("a refusal fails with NoTargetHasRoom and records every drop once per pass and target", () =>
    Effect.gen(function* () {
      const t = setup({ counts: [full({ kind: "local" }), full({ kind: "host", machineId: "h1" })] });
      t.placer.beginPass({ localHeld: null, proxy: null });
      const error = yield* t.placer.place(request("hosted", 1)).pipe(Effect.flip);
      assert.instanceOf(error, NoTargetHasRoom);
      assert.strictEqual(error.message, "no target has room");
      yield* t.placer.place(request("hosted", 2)).pipe(Effect.flip);
      const dropped = [
        { repo: "acme/hosted", target: "local", reason: "slots full: 1 of 1 running" },
        { repo: "acme/hosted", target: "mini", reason: "slots full: 1 of 1 running" },
      ];
      assert.deepStrictEqual(drops(t.events), dropped);
      t.placer.beginPass({ localHeld: null, proxy: null });
      yield* t.placer.place(request("hosted", 3)).pipe(Effect.flip);
      assert.deepStrictEqual(drops(t.events), [...dropped, ...dropped]);
    }),
  );

  it.effect("two hosts of one name are recorded as two drops", () =>
    Effect.gen(function* () {
      const other: HostConfig = { ...HOST, id: "h2", name: HOST.name };
      const t = setup({
        machine: machine({ hosts: [HOST, other] }),
        counts: [
          { target: { kind: "local" }, running: 0 },
          { target: { kind: "host", machineId: "h1" }, running: 1 },
          { target: { kind: "host", machineId: "h2" }, running: 1 },
        ],
      });
      t.placer.beginPass({ localHeld: null, proxy: null });
      yield* t.placer.place(request("both"));
      assert.deepStrictEqual(
        drops(t.events).map((drop) => drop.reason),
        ["slots full: 1 of 1 running", "slots full: 1 of 1 running"],
      );
    }),
  );

  it.effect("a target that was not read has no count, and is dropped", () =>
    Effect.gen(function* () {
      const t = setup({ counts: [{ target: { kind: "local" }, running: 0 }] });
      t.placer.beginPass({ localHeld: null, proxy: null });
      assert.deepStrictEqual(yield* t.placer.place(request("hosted")), { kind: "local" });
      assert.deepStrictEqual(drops(t.events), [
        { repo: "acme/hosted", target: "mini", reason: "its running agents could not be counted" },
      ]);
    }),
  );

  it.effect("a host that is not ready, or whose load was not read, is dropped", () =>
    Effect.gen(function* () {
      const notReady = setup({ notReady: new Map([["h1", "claude is not trusted"]]) });
      notReady.placer.beginPass({ localHeld: null, proxy: null });
      yield* notReady.placer.place(request("hosted"));
      assert.deepStrictEqual(drops(notReady.events), [
        { repo: "acme/hosted", target: "mini", reason: "not ready: claude is not trusted" },
      ]);
      const unread = setup({ hostLoad: null });
      unread.placer.beginPass({ localHeld: null, proxy: null });
      yield* unread.placer.place(request("hosted"));
      assert.deepStrictEqual(drops(unread.events), [
        { repo: "acme/hosted", target: "mini", reason: "its load was not read this pass" },
      ]);
    }),
  );

  it.effect("cloud takes a launch no machine has room for, when the proxy check passed", () =>
    Effect.gen(function* () {
      const t = setup({ counts: [full({ kind: "local" }), full({ kind: "host", machineId: "h1" }), { target: { kind: "cloud" }, running: 0 }] });
      t.placer.beginPass({ localHeld: null, proxy: null });
      assert.deepStrictEqual(yield* t.placer.place(request("wide")), {
        kind: "cloud",
        environmentId: "env-1",
        machineSize: "small",
      });
    }),
  );

  it.effect("cloud is dropped, with the reason the pass gave, when the proxy check did not pass", () =>
    Effect.gen(function* () {
      const reason = "the proxy's key check is off (it answered 200 with no key)";
      const t = setup({ counts: [full({ kind: "local" }), full({ kind: "host", machineId: "h1" }), { target: { kind: "cloud" }, running: 0 }] });
      t.placer.beginPass({ localHeld: null, proxy: reason });
      const error = yield* t.placer.place(request("wide")).pipe(Effect.flip);
      assert.instanceOf(error, NoTargetHasRoom);
      assert.deepStrictEqual(drops(t.events).filter((e) => e.target === "cloud"), [
        { repo: "acme/wide", target: "cloud", reason },
      ]);
    }),
  );

  describe("a placement kept from an earlier send", () => {
    const HOST_TARGET = { kind: "host", machineId: "h1", path: "/srv/hosted" } as const;

    it.effect("is checked as the only candidate and, when it qualifies, counted like a fresh placement", () =>
      Effect.gen(function* () {
        const t = setup();
        t.placer.beginPass({ localHeld: "high load", proxy: null });
        assert.deepStrictEqual(yield* t.placer.place(request("hosted", 1), HOST_TARGET), HOST_TARGET);
        // The host's one slot is taken by the kept launch, and this Mac holds claims.
        const second = yield* t.placer.place(request("hosted", 2)).pipe(Effect.flip);
        assert.instanceOf(second, NoTargetHasRoom);
        // It is in flight until its launch ends, as a fresh placement is.
        t.placer.beginPass({ localHeld: "high load", proxy: null });
        assert.instanceOf(yield* t.placer.place(request("hosted", 3)).pipe(Effect.flip), NoTargetHasRoom);
        yield* t.placer.launchEnded("launch-hosted-1");
        t.placer.beginPass({ localHeld: "high load", proxy: null });
        assert.deepStrictEqual(yield* t.placer.place(request("hosted", 4)), HOST_TARGET);
      }),
    );

    it.effect("that no longer qualifies is refused, and the launch does not move to a machine with room", () =>
      Effect.gen(function* () {
        const t = setup({
          counts: [
            { target: { kind: "local" }, running: 0 },
            { target: { kind: "host", machineId: "h1" }, running: 1 },
          ],
        });
        t.placer.beginPass({ localHeld: null, proxy: null });
        const error = yield* t.placer.place(request("hosted"), HOST_TARGET).pipe(Effect.flip);
        assert.instanceOf(error, NoTargetHasRoom);
        assert.deepStrictEqual(drops(t.events), [
          { repo: "acme/hosted", target: "mini", reason: "slots full: 1 of 1 running" },
        ]);
      }),
    );

    it.effect("on a host that is not ready, or over its load, is refused", () =>
      Effect.gen(function* () {
        const notReady = setup({ notReady: new Map([["h1", "claude is not trusted"]]) });
        notReady.placer.beginPass({ localHeld: null, proxy: null });
        assert.instanceOf(yield* notReady.placer.place(request("hosted"), HOST_TARGET).pipe(Effect.flip), NoTargetHasRoom);
        const busy = setup({ hostLoad: { oneMinute: 20, cores: 10 } });
        busy.placer.beginPass({ localHeld: null, proxy: null });
        assert.instanceOf(yield* busy.placer.place(request("hosted"), HOST_TARGET).pipe(Effect.flip), NoTargetHasRoom);
      }),
    );

    it.effect("on this Mac is refused when its slots are full, though a host has room", () =>
      Effect.gen(function* () {
        const t = setup({ counts: [{ target: { kind: "local" }, running: 1 }, { target: { kind: "host", machineId: "h1" }, running: 0 }] });
        t.placer.beginPass({ localHeld: null, proxy: null });
        const error = yield* t.placer.place(request("hosted"), { kind: "local" }).pipe(Effect.flip);
        assert.instanceOf(error, NoTargetHasRoom);
      }),
    );

    it.effect("on this Mac qualifies and is counted", () =>
      Effect.gen(function* () {
        const t = setup();
        t.placer.beginPass({ localHeld: null, proxy: null });
        assert.deepStrictEqual(yield* t.placer.place(request("hosted", 1), { kind: "local" }), { kind: "local" });
        // This Mac's one slot is taken: the next hosted launch goes to the host.
        assert.deepStrictEqual(yield* t.placer.place(request("hosted", 2)), HOST_TARGET);
      }),
    );

    it.effect("on a target the repo no longer lists is placed afresh", () =>
      Effect.gen(function* () {
        const t = setup();
        t.placer.beginPass({ localHeld: null, proxy: null });
        // The repo lists no hosts now: it runs on this Mac.
        assert.deepStrictEqual(yield* t.placer.place(request("mac"), HOST_TARGET), { kind: "local" });
        // The repo lists the host, but the machine config no longer has it.
        const gone = setup({ machine: machine({ hosts: [] }) });
        gone.placer.beginPass({ localHeld: null, proxy: null });
        assert.deepStrictEqual(yield* gone.placer.place(request("hosted"), HOST_TARGET), { kind: "local" });
      }),
    );

    it.effect("uses the path the repo lists now", () =>
      Effect.gen(function* () {
        const t = setup();
        t.placer.beginPass({ localHeld: null, proxy: null });
        assert.deepStrictEqual(
          yield* t.placer.place(request("hosted"), { kind: "host", machineId: "h1", path: "/old/place" }),
          HOST_TARGET,
        );
      }),
    );
  });
});
