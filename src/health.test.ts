import { describe, expect, it } from "vitest";

import { machineHealth } from "./health.ts";

const GIB = 1024 ** 3;
const base = {
  space: { path: "/data/worktrees", freeBytes: 7 * GIB, totalBytes: 460 * GIB },
  load: { oneMinute: 4, cores: 12 },
  minFreeGib: 10,
  maxLoadPerCore: 2,
  gates: { max: 2, startedMs: [] as ReadonlyArray<number> },
  nowMs: 100_000,
};

describe("machineHealth", () => {
  it("calls the disk low by the pass's own rule: free below min_free_gib", () => {
    expect(machineHealth(base).disk).toEqual({
      path: "/data/worktrees",
      free_bytes: 7 * GIB,
      total_bytes: 460 * GIB,
      floor_bytes: 10 * GIB,
      low: true,
    });
    const enough = { ...base.space, freeBytes: 10 * GIB };
    expect(machineHealth({ ...base, space: enough }).disk).toMatchObject({ low: false });
  });

  it("has no floor and is never low when min_free_gib is 0", () => {
    expect(machineHealth({ ...base, minFreeGib: 0 }).disk).toMatchObject({
      floor_bytes: null,
      low: false,
    });
  });

  it("says why the free space could not be read", () => {
    expect(machineHealth({ ...base, space: new Error("EACCES") }).disk).toEqual({
      error: "EACCES",
    });
  });

  it("calls the load high above max_load_per_core times the cores, and has no limit at 0", () => {
    expect(machineHealth(base).load).toEqual({ one_minute: 4, cores: 12, limit: 24, high: false });
    const busy = { oneMinute: 24.5, cores: 12 };
    expect(machineHealth({ ...base, load: busy }).load).toMatchObject({ high: true });
    expect(machineHealth({ ...base, load: busy, maxLoadPerCore: 0 }).load).toMatchObject({
      limit: null,
      high: false,
    });
  });

  it("counts the gates running and how long the oldest has run", () => {
    expect(machineHealth(base).gates).toEqual({ running: 0, max: 2, oldest_ms: null });
    const gates = { max: 2, startedMs: [90_000, 40_000] };
    expect(machineHealth({ ...base, gates }).gates).toEqual({
      running: 2,
      max: 2,
      oldest_ms: 60_000,
    });
  });
});
