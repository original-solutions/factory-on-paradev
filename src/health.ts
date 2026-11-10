/**
 * The machine's health as the status report carries it: the free space, load and gates the pass
 * holds claims on, with the limits it holds them at. Read by the status route on each status read,
 * with the predicates `Pass.lowDisk` and `Pass.highLoad` use, so the page shows what the pass decides.
 */
import { diskFloor, isLowDisk, type FreeSpace } from "./disk.ts";
import { isOverloaded, loadLimit, type Load } from "./load.ts";

export interface MachineHealth {
  readonly disk:
    | {
        /** The directory read: of the worktrees and the factory dir, the one with least free. */
        readonly path: string;
        readonly free_bytes: number;
        readonly total_bytes: number;
        /** `min_free_gib` in bytes; null when 0 turns the check off. */
        readonly floor_bytes: number | null;
        /** Below the floor: the pass claims nothing and starts no gate. */
        readonly low: boolean;
      }
    | { readonly error: string };
  readonly load: {
    readonly one_minute: number;
    readonly cores: number;
    /** `max_load_per_core` times the cores; null when 0 turns the check off. */
    readonly limit: number | null;
    /** Above the limit: the pass claims nothing and a second gate waits. */
    readonly high: boolean;
  };
  readonly gates: {
    readonly running: number;
    readonly max: number;
    /** How long the gate that started first has run; null with none running. */
    readonly oldest_ms: number | null;
  };
}

export const machineHealth = (input: {
  /** The free space read, or what reading it threw. */
  readonly space: FreeSpace | Error;
  readonly load: Load;
  readonly minFreeGib: number;
  readonly maxLoadPerCore: number;
  /** `max_concurrent_gates` and when each running gate started. */
  readonly gates: { readonly max: number; readonly startedMs: ReadonlyArray<number> };
  readonly nowMs: number;
}): MachineHealth => {
  const { space, load, gates } = input;
  const floor = diskFloor(input.minFreeGib);
  const limit = loadLimit(input.maxLoadPerCore, load.cores);
  const oldest = gates.startedMs.length === 0 ? null : Math.min(...gates.startedMs);
  return {
    disk:
      space instanceof Error
        ? { error: space.message }
        : {
            path: space.path,
            free_bytes: space.freeBytes,
            total_bytes: space.totalBytes,
            floor_bytes: floor,
            low: isLowDisk(space.freeBytes, input.minFreeGib),
          },
    load: {
      one_minute: load.oneMinute,
      cores: load.cores,
      limit,
      high: isOverloaded(load.oneMinute, limit),
    },
    gates: {
      running: gates.startedMs.length,
      max: gates.max,
      oldest_ms: oldest === null ? null : Math.max(0, input.nowMs - oldest),
    },
  };
};
