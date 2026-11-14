/**
 * Where a launch runs (#55), as a pure function of what the pass read about each candidate. The
 * readings come from `placer.ts`; nothing here reads, logs or waits, so every rule is a unit test.
 * The rules are `docs/specs/P2-targets.md` "Placement, inside `launch`", steps 2 to 5.
 */
import type { MachineSize } from "../config.ts";
import type { Load } from "../load.ts";
import { NO_TARGET_HAS_ROOM } from "../sessions.ts";
import type { LaunchTarget } from "./sessions.ts";

/** A target's slots: `running` is null when its snapshot could not be read. */
export interface Slots {
  readonly running: number | null;
  readonly max: number;
}

/**
 * One place a launch could run. Callers list this Mac first, then the repo's hosts in its order,
 * then cloud: that order breaks a tie in load, so this Mac wins one.
 */
export type Candidate =
  | {
      readonly kind: "local";
      readonly slots: Slots;
      readonly load: Load;
      /** Why P1's load or disk check holds claims this pass; null when it does not. */
      readonly held: string | null;
    }
  | {
      readonly kind: "host";
      readonly id: string;
      readonly name: string;
      /** The repo's path on the host. */
      readonly path: string;
      readonly slots: Slots;
      readonly maxLoadPerCore: number;
      /** The host's load this pass; null when the read failed. */
      readonly load: Load | null;
      /** The first failing line of the host's last `hosts check`; null when it passed. */
      readonly notReady: string | null;
    }
  | {
      readonly kind: "cloud";
      readonly environmentId: string;
      readonly machineSize: MachineSize;
      readonly slots: Slots;
      /** Null when the proxy check passed this pass; else why it did not. */
      readonly proxy: string | null;
    };

/**
 * A candidate placement did not use, and why. `id` is the candidate's identity (`local`,
 * `host:<id>` or `cloud`); `target` is what the log and the belt call it: "local", the host's
 * name, or "cloud".
 */
export interface Dropped {
  readonly id: string;
  readonly target: string;
  readonly reason: string;
}

export type Placement =
  | { readonly kind: "placed"; readonly target: LaunchTarget; readonly dropped: ReadonlyArray<Dropped> }
  | { readonly kind: "refused"; readonly reason: typeof NO_TARGET_HAS_ROOM; readonly dropped: ReadonlyArray<Dropped> };

const perCore = (load: Load): number => load.oneMinute / load.cores;

const slotsReason = ({ running, max }: Slots): string | null =>
  running === null
    ? "its running agents could not be counted"
    : running >= max
      ? `slots full: ${running} of ${max} running`
      : null;

/** Why `candidate` cannot take a launch, the first reason that applies; null when it can. */
const dropReason = (candidate: Candidate): string | null => {
  const full = slotsReason(candidate.slots);
  if (full !== null) return full;
  switch (candidate.kind) {
    case "local":
      return candidate.held === null ? null : `this Mac holds claims: ${candidate.held}`;
    case "host": {
      if (candidate.load === null) return "its load was not read this pass";
      const { oneMinute, cores } = candidate.load;
      if (candidate.maxLoadPerCore > 0 && oneMinute > candidate.maxLoadPerCore * cores) {
        return `load ${(oneMinute / cores).toFixed(2)} per core is over max_load_per_core ${candidate.maxLoadPerCore}`;
      }
      return candidate.notReady === null ? null : `not ready: ${candidate.notReady}`;
    }
    case "cloud":
      return candidate.proxy;
  }
};

/**
 * The one identity of a target: `local`, `host:<id>` or `cloud`. A candidate, a placed target and a
 * counted target all go through it, so a drop, a count and a kept target match by the same rule.
 */
export const targetKey = (
  target:
    | { readonly kind: "local" | "cloud" }
    | { readonly kind: "host"; readonly id: string }
    | { readonly kind: "host"; readonly machineId: string },
): string =>
  target.kind !== "host" ? target.kind : `host:${"id" in target ? target.id : target.machineId}`;

const nameOf = (candidate: Candidate): string =>
  candidate.kind === "local" ? "local" : candidate.kind === "host" ? candidate.name : "cloud";

const targetOf = (candidate: Candidate): LaunchTarget =>
  candidate.kind === "local"
    ? { kind: "local" }
    : candidate.kind === "host"
      ? { kind: "host", machineId: candidate.id, path: candidate.path }
      : { kind: "cloud", environmentId: candidate.environmentId, machineSize: candidate.machineSize };

/**
 * The machine (this Mac or a host) with room and the lowest load per core, this Mac on a tie;
 * cloud only when no machine has room; a refusal when nothing does. Every candidate that was
 * dropped comes back with one reason, so the belt can say why a run waits. A machine that
 * qualified and lost on load is not dropped, and neither is cloud when a machine won.
 */
export const choosePlacement = (candidates: ReadonlyArray<Candidate>): Placement => {
  const dropped: Array<Dropped> = [];
  /** The machines with room, each with the load that qualified it (a host with no load was dropped). */
  const machines: Array<{ readonly candidate: Candidate; readonly load: Load }> = [];
  let cloud: Candidate | null = null;
  for (const candidate of candidates) {
    const reason = dropReason(candidate);
    if (reason !== null) {
      dropped.push({ id: targetKey(candidate), target: nameOf(candidate), reason });
    } else if (candidate.kind === "cloud") cloud = candidate;
    else if (candidate.load !== null) machines.push({ candidate, load: candidate.load });
  }
  let best: (typeof machines)[number] | null = null;
  for (const machine of machines) {
    if (best === null || perCore(machine.load) < perCore(best.load)) best = machine;
  }
  if (best !== null) return { kind: "placed", target: targetOf(best.candidate), dropped };
  if (cloud !== null) return { kind: "placed", target: targetOf(cloud), dropped };
  return { kind: "refused", reason: NO_TARGET_HAS_ROOM, dropped };
};
