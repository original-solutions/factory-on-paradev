import { assert, describe, it } from "@effect/vitest";

import type { Load } from "../load.ts";
import { type Candidate, choosePlacement, NO_ROOM } from "./placement.ts";

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
      dropped: [{ target: "local", reason: "slots full: 2 of 2 running" }],
    });
  });

  it("skips a target whose running agents could not be counted", () => {
    const placed = choosePlacement([host("a", { slots: { running: null, max: 2 } }), local()]);
    assert.deepStrictEqual(placed, {
      kind: "placed",
      target: { kind: "local" },
      dropped: [{ target: "name-a", reason: "its running agents could not be counted" }],
    });
  });

  it("skips an overloaded host", () => {
    const placed = choosePlacement([host("a", { load: load(1.5), maxLoadPerCore: 1 }), local({ load: load(0.9) })]);
    assert.deepStrictEqual(placed, {
      kind: "placed",
      target: { kind: "local" },
      dropped: [{ target: "name-a", reason: "load 1.50 per core is over max_load_per_core 1" }],
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
      dropped: [{ target: "name-a", reason: "not ready: claude is not trusted" }],
    });
  });

  it("skips a host whose load read failed", () => {
    const placed = choosePlacement([host("a", { load: null }), local()]);
    assert.deepStrictEqual(placed, {
      kind: "placed",
      target: { kind: "local" },
      dropped: [{ target: "name-a", reason: "its load was not read this pass" }],
    });
  });

  it("skips this Mac while P1's checks hold claims", () => {
    const placed = choosePlacement([local({ held: "high load" }), host("a", { load: load(0.9) })]);
    assert.deepStrictEqual(placed, {
      kind: "placed",
      target: { kind: "host", machineId: "a", path: "/srv/a" },
      dropped: [{ target: "local", reason: "this Mac holds claims: high load" }],
    });
  });

  it("chooses cloud only when no machine qualifies", () => {
    const placed = choosePlacement([local({ slots: { running: 2, max: 2 } }), host("a", { load: null }), cloud()]);
    assert.deepStrictEqual(placed, {
      kind: "placed",
      target: { kind: "cloud", environmentId: "env-1", machineSize: "small" },
      dropped: [
        { target: "local", reason: "slots full: 2 of 2 running" },
        { target: "name-a", reason: "its load was not read this pass" },
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
      reason: NO_ROOM,
      dropped: [
        { target: "local", reason: "this Mac holds claims: low disk" },
        { target: "cloud", reason: "the proxy check failed: down" },
      ],
    });
  });

  it("refuses with `no target has room` when nothing qualifies, listing every drop", () => {
    const placed = choosePlacement([
      local({ slots: { running: 3, max: 3 } }),
      host("a", { notReady: "x" }),
      cloud({ slots: { running: 1, max: 1 } }),
    ]);
    assert.strictEqual(NO_ROOM, "no target has room");
    assert.deepStrictEqual(placed, {
      kind: "refused",
      reason: "no target has room",
      dropped: [
        { target: "local", reason: "slots full: 3 of 3 running" },
        { target: "name-a", reason: "not ready: x" },
        { target: "cloud", reason: "slots full: 1 of 1 running" },
      ],
    });
  });

  it("refuses when there are no candidates", () => {
    assert.deepStrictEqual(choosePlacement([]), { kind: "refused", reason: NO_ROOM, dropped: [] });
  });
});
