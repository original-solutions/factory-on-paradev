import { assert, describe, it } from "@effect/vitest";

import type { Load } from "../load.ts";
import { NO_TARGET_HAS_ROOM } from "../sessions.ts";
import { type Candidate, choosePlacement, targetRow } from "./placement.ts";

const load = (perCore: number, cores = 10): Load => ({ oneMinute: perCore * cores, cores });

const local = (over: Partial<Extract<Candidate, { kind: "local" }>> = {}): Candidate => ({
  kind: "local",
  slots: { running: 0, max: 2 },
  load: load(0.5),
  held: null,
  ...over,
});

const host = (id: string, over: Partial<Extract<Candidate, { kind: "host" }>> = {}): Candidate => ({
  kind: "host",
  id,
  name: `name-${id}`,
  path: `/srv/${id}`,
  slots: { running: 0, max: 2 },
  maxLoadPerCore: 1,
  load: load(0.5),
  notReady: null,
  ...over,
});

const cloud = (over: Partial<Extract<Candidate, { kind: "cloud" }>> = {}): Candidate => ({
  kind: "cloud",
  environmentId: "env-1",
  machineSize: "small",
  slots: { running: 0, max: 2 },
  proxy: null,
  ...over,
});

describe("choosePlacement", () => {
  it("picks the lowest load per core", () => {
    const placed = choosePlacement([local({ load: load(0.8) }), host("a", { load: load(0.2) }), host("b", { load: load(0.5) })]);
    assert.deepStrictEqual(placed, {
      kind: "placed",
      target: { kind: "host", machineId: "a", path: "/srv/a" },
      dropped: [],
    });
  });

  it("compares load per core, not the raw load", () => {
    const placed = choosePlacement([
      local({ load: { oneMinute: 4, cores: 4 } }),
      host("a", { load: { oneMinute: 8, cores: 16 } }),
    ]);
    assert.strictEqual(placed.kind === "placed" && placed.target.kind, "host");
  });

  it("gives a tie to this Mac, the first candidate", () => {
    const placed = choosePlacement([local({ load: load(0.5) }), host("a", { load: load(0.5) })]);
    assert.deepStrictEqual(placed, { kind: "placed", target: { kind: "local" }, dropped: [] });
  });

  it("skips a full target", () => {
    const placed = choosePlacement([local({ slots: { running: 2, max: 2 }, load: load(0.1) }), host("a")]);
    assert.deepStrictEqual(placed, {
      kind: "placed",
      target: { kind: "host", machineId: "a", path: "/srv/a" },
      dropped: [{ id: "local", target: "local", reason: "slots full: 2 of 2 running" }],
    });
  });

  it("skips a target whose running agents could not be counted", () => {
    const placed = choosePlacement([host("a", { slots: { running: null, max: 2 } }), local()]);
    assert.deepStrictEqual(placed, {
      kind: "placed",
      target: { kind: "local" },
      dropped: [{ id: "host:a", target: "name-a", reason: "its running agents could not be counted" }],
    });
  });

  it("skips an overloaded host", () => {
    const placed = choosePlacement([host("a", { load: load(1.5), maxLoadPerCore: 1 }), local({ load: load(0.9) })]);
    assert.deepStrictEqual(placed, {
      kind: "placed",
      target: { kind: "local" },
      dropped: [{ id: "host:a", target: "name-a", reason: "load 1.50 per core is over max_load_per_core 1" }],
    });
  });

  it("does not skip a host at exactly max_load_per_core", () => {
    const placed = choosePlacement([host("a", { load: load(1), maxLoadPerCore: 1 })]);
    assert.deepStrictEqual(placed, {
      kind: "placed",
      target: { kind: "host", machineId: "a", path: "/srv/a" },
      dropped: [],
    });
  });

  it("does not limit a host whose max_load_per_core is 0", () => {
    const placed = choosePlacement([host("a", { load: load(30), maxLoadPerCore: 0 })]);
    assert.strictEqual(placed.kind, "placed");
  });

  it("skips a host whose check failed", () => {
    const placed = choosePlacement([host("a", { notReady: "claude is not trusted" }), local()]);
    assert.deepStrictEqual(placed, {
      kind: "placed",
      target: { kind: "local" },
      dropped: [{ id: "host:a", target: "name-a", reason: "not ready: claude is not trusted" }],
    });
  });

  it("skips a host whose load read failed", () => {
    const placed = choosePlacement([host("a", { load: null }), local()]);
    assert.deepStrictEqual(placed, {
      kind: "placed",
      target: { kind: "local" },
      dropped: [{ id: "host:a", target: "name-a", reason: "its load was not read this pass" }],
    });
  });

  it("skips this Mac while P1's checks hold claims", () => {
    const placed = choosePlacement([local({ held: "high load" }), host("a", { load: load(0.9) })]);
    assert.deepStrictEqual(placed, {
      kind: "placed",
      target: { kind: "host", machineId: "a", path: "/srv/a" },
      dropped: [{ id: "local", target: "local", reason: "this Mac holds claims: high load" }],
    });
  });

  it("chooses cloud only when no machine qualifies", () => {
    const placed = choosePlacement([local({ slots: { running: 2, max: 2 } }), host("a", { load: null }), cloud()]);
    assert.deepStrictEqual(placed, {
      kind: "placed",
      target: { kind: "cloud", environmentId: "env-1", machineSize: "small" },
      dropped: [
        { id: "local", target: "local", reason: "slots full: 2 of 2 running" },
        { id: "host:a", target: "name-a", reason: "its load was not read this pass" },
      ],
    });
  });

  it("does not choose cloud while a machine qualifies, however loaded", () => {
    const placed = choosePlacement([local({ load: load(5) }), cloud()]);
    assert.deepStrictEqual(placed, { kind: "placed", target: { kind: "local" }, dropped: [] });
  });

  it("drops cloud whose proxy check did not pass", () => {
    const placed = choosePlacement([local({ held: "low disk" }), cloud({ proxy: "the proxy check failed: down" })]);
    assert.deepStrictEqual(placed, {
      kind: "refused",
      reason: NO_TARGET_HAS_ROOM,
      dropped: [
        { id: "local", target: "local", reason: "this Mac holds claims: low disk" },
        { id: "cloud", target: "cloud", reason: "the proxy check failed: down" },
      ],
    });
  });

  it("refuses with `no target has room` when nothing qualifies, listing every drop", () => {
    const placed = choosePlacement([
      local({ slots: { running: 3, max: 3 } }),
      host("a", { notReady: "x" }),
      cloud({ slots: { running: 1, max: 1 } }),
    ]);
    assert.strictEqual(NO_TARGET_HAS_ROOM, "no target has room");
    assert.deepStrictEqual(placed, {
      kind: "refused",
      reason: "no target has room",
      dropped: [
        { id: "local", target: "local", reason: "slots full: 3 of 3 running" },
        { id: "host:a", target: "name-a", reason: "not ready: x" },
        { id: "cloud", target: "cloud", reason: "slots full: 1 of 1 running" },
      ],
    });
  });

  it("names a dropped candidate by identity, so two hosts of one name are two drops", () => {
    const placed = choosePlacement([host("a", { name: "same", load: null }), host("b", { name: "same", load: null })]);
    assert.deepStrictEqual(
      placed.dropped.map((d) => d.id),
      ["host:a", "host:b"],
    );
  });

  it("refuses when there are no candidates", () => {
    assert.deepStrictEqual(choosePlacement([]), { kind: "refused", reason: NO_TARGET_HAS_ROOM, dropped: [] });
  });
});

describe("targetRow", () => {
  it("shows this Mac's slots, load and readiness, with no reason when it would take a run", () => {
    assert.deepStrictEqual(targetRow(local({ slots: { running: 1, max: 2 } })), {
      kind: "local",
      name: "local",
      online: true,
      load: { oneMinute: 5, cores: 10 },
      slots: { used: 1, max: 2 },
      ready: true,
      reason: null,
    });
  });

  it("gives this Mac's hold as its reason and calls it not ready", () => {
    const row = targetRow(local({ held: "low disk" }));
    assert.deepStrictEqual({ ready: row.ready, reason: row.reason }, { ready: false, reason: "this Mac holds claims: low disk" });
  });

  it("names a host by its name and gives the first reason placement would drop it for", () => {
    assert.deepStrictEqual(targetRow(host("a", { load: load(2), slots: { running: 0, max: 1 } })), {
      kind: "host",
      name: "name-a",
      online: true,
      load: { oneMinute: 20, cores: 10 },
      slots: { used: 0, max: 1 },
      ready: true,
      reason: "load 2.00 per core is over max_load_per_core 1",
    });
    const notReady = targetRow(host("a", { notReady: "ssh: no key" }));
    assert.deepStrictEqual({ ready: notReady.ready, reason: notReady.reason }, { ready: false, reason: "not ready: ssh: no key" });
  });

  it("reads a target whose running agents could not be counted as offline, with no used count", () => {
    const row = targetRow(host("a", { slots: { running: null, max: 2 }, load: null }));
    assert.deepStrictEqual(
      { online: row.online, load: row.load, slots: row.slots, reason: row.reason },
      { online: false, load: null, slots: { used: null, max: 2 }, reason: "its running agents could not be counted" },
    );
  });

  it("gives cloud no load, and its proxy check as its readiness", () => {
    assert.deepStrictEqual(targetRow(cloud({ slots: { running: 1, max: 1 } })), {
      kind: "cloud",
      name: "cloud",
      online: true,
      load: null,
      slots: { used: 1, max: 1 },
      ready: true,
      reason: "slots full: 1 of 1 running",
    });
    const down = targetRow(cloud({ proxy: "the proxy check failed: down" }));
    assert.deepStrictEqual({ ready: down.ready, reason: down.reason }, { ready: false, reason: "the proxy check failed: down" });
  });
});
