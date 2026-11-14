/**
 * The per-pass glue of placement (#55): it gathers what the pass has read about each target of a
 * repo, asks `choosePlacement`, and records why a candidate was not used. `launch` asks it once per
 * command id, through `place`. Everything it reads is read at most once per pass.
 */
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

import type { MachineConfig, WatchedRepo } from "../config.ts";
import type { MachineEvent } from "../ledger/events.ts";
import type { Load } from "../load.ts";
import { NoTargetHasRoom, type LaunchRequest } from "../sessions.ts";
import { type Candidate, choosePlacement, targetKey } from "./placement.ts";
import type { LaunchTarget, TargetCount } from "./sessions.ts";

/**
 * What the placer reads. The placer is made once per process and every field is read on each use,
 * so a getter lets it follow a config reload while its in-flight launches and semaphore stay.
 */
export interface PlacerDeps {
  readonly machine: MachineConfig;
  /** The watched repo whose local Paradev project is `projectId`, from the last project listing; null when none is known. */
  readonly repoOfProject: (projectId: string) => WatchedRepo | null;
  /** Each host's load this pass, by host id; null when its read failed. */
  readonly hostLoads: ReadonlyMap<string, Load | null>;
  /** The hosts whose last check failed, by host id, with its first failing line. */
  readonly hostsNotReady: () => ReadonlyMap<string, string>;
  readonly readLoad: () => Load;
  /** The running agents per target, one snapshot each. */
  readonly running: Effect.Effect<ReadonlyArray<TargetCount>>;
  /** Writes to the machine log; callers swallow their own errors. */
  readonly record: (event: MachineEvent) => Effect.Effect<void>;
}

export const makePlacer = (deps: PlacerDeps) => {
  let localHeld: string | null = null;
  /** Running agents per target this pass; null when its snapshot could not be read. Null here: not read yet. */
  let counts: Map<string, number | null> | null = null;
  /** Why cloud takes no run this pass, from the pass's proxy check; null when it passed or was not run. */
  let proxyReason: string | null = null;
  let recorded = new Set<string>();
  /**
   * The placements whose launch has not ended, by command id, with the key of their target; kept
   * across passes. Such a launch has no agent in a snapshot yet, so each counts as one running.
   */
  const inFlight = new Map<string, string>();
  /** One placement at a time: a re-gate relaunch and a pass launch never read or bump the counts at once. */
  const exclusive = Semaphore.makeUnsafe(1);

  const countsOf = Effect.gen(function* () {
    if (counts === null) {
      const read = yield* deps.running;
      counts = new Map(read.map((count) => [targetKey(count.target), count.running]));
      // A launch in flight is in no snapshot yet: it counts on top of what the snapshot read.
      for (const key of inFlight.values()) bump(counts, key);
    }
    return counts;
  });

  /** This Mac as a candidate; `held` is why P1's checks hold claims, which a repo with nowhere else to go ignores. */
  const localOf = (running: ReadonlyMap<string, number | null>, held: string | null): Candidate => ({
    kind: "local",
    slots: { running: running.get("local") ?? null, max: deps.machine.local.maxRuns },
    load: deps.readLoad(),
    held,
  });

  const candidatesOf = (repo: WatchedRepo, running: ReadonlyMap<string, number | null>): Array<Candidate> => {
    const countOf = (key: string): number | null => running.get(key) ?? null;
    const candidates: Array<Candidate> = [localOf(running, localHeld)];
    const notReady = deps.hostsNotReady();
    for (const listed of repo.hosts ?? []) {
      const host = deps.machine.hosts.find((entry) => entry.id === listed.id);
      if (host === undefined) continue;
      candidates.push({
        kind: "host",
        id: host.id,
        name: host.name,
        path: listed.path,
        slots: { running: countOf(targetKey({ kind: "host", id: host.id })), max: host.maxRuns },
        maxLoadPerCore: host.maxLoadPerCore,
        load: deps.hostLoads.get(host.id) ?? null,
        notReady: notReady.get(host.id) ?? null,
      });
    }
    const { cloud } = deps.machine;
    if (repo.cloud !== undefined && cloud !== undefined) {
      candidates.push({
        kind: "cloud",
        environmentId: repo.cloud,
        machineSize: cloud.machineSize,
        slots: { running: countOf("cloud"), max: cloud.maxRuns },
        proxy: proxyReason,
      });
    }
    return candidates;
  };

  /** One more running agent on `key`, when its count is known. */
  const bump = (running: Map<string, number | null>, key: string): void => {
    const before = running.get(key);
    if (before !== null && before !== undefined) running.set(key, before + 1);
  };

  /** Chooses among `candidates`, records what was dropped, and takes the chosen target's slot for the rest of the pass. */
  const settle = (
    repoName: string,
    candidates: ReadonlyArray<Candidate>,
    running: Map<string, number | null>,
    request: LaunchRequest,
  ): Effect.Effect<LaunchTarget, NoTargetHasRoom> =>
    Effect.gen(function* () {
      const placement = choosePlacement(candidates);
      for (const dropped of placement.dropped) {
        const key = `${repoName}\u0000${dropped.id}`;
        if (recorded.has(key)) continue;
        recorded.add(key);
        yield* deps.record({
          event: "placement",
          data: { repo: repoName, target: dropped.target, reason: dropped.reason },
        });
      }
      if (placement.kind === "refused") return yield* Effect.fail(new NoTargetHasRoom());
      // The slot is taken for the rest of the pass: the next launch counts it.
      bump(running, targetKey(placement.target));
      inFlight.set(request.commandId, targetKey(placement.target));
      return placement.target;
    });

  return {
    /** The launch of `commandId` ended: its agent is in the snapshots now, so it stops counting on its own. */
    launchEnded: (commandId: string): Effect.Effect<void> =>
      Effect.sync(() => void inFlight.delete(commandId)),
    /**
     * Starts a pass: forgets the last pass's counts and recorded drops. `localHeld` is why P1's
     * checks hold claims this pass ("low disk", "high load"), else null; `proxy` is why cloud
     * takes no run this pass (the pass's proxy check), else null.
     */
    beginPass: (began: { readonly localHeld: string | null; readonly proxy: string | null }): void => {
      localHeld = began.localHeld;
      proxyReason = began.proxy;
      counts = null;
      recorded = new Set();
    },
    /**
     * Where `request` runs. `kept` is the target an earlier send of it was placed on, when this Mac
     * or a host: it is checked as the only candidate (the others' slots still count), and a launch
     * that fails the check waits for it. A kept target the repo no longer lists is placed afresh.
     */
    place: (
      request: LaunchRequest,
      kept?: Exclude<LaunchTarget, { readonly kind: "cloud" }>,
    ): Effect.Effect<LaunchTarget, NoTargetHasRoom> =>
      Effect.gen(function* () {
        const repo = deps.repoOfProject(request.projectId);
        // A repo with no hosts and no cloud runs as in P1: on this Mac, with no load or claims check.
        const hosted = (repo?.hosts?.length ?? 0) > 0;
        const clouded = repo?.cloud !== undefined && deps.machine.cloud !== undefined;
        if (repo === null || (!hosted && !clouded)) {
          // The core's cap on runs covers this Mac's slots when local.max_runs reaches it.
          if (deps.machine.local.maxRuns >= deps.machine.maxConcurrentRuns) {
            if (counts !== null) bump(counts, "local");
            inFlight.set(request.commandId, "local");
            return { kind: "local" } as const;
          }
          const running = yield* countsOf;
          return yield* settle(repo?.repo ?? request.projectId, [localOf(running, null)], running, request);
        }
        const running = yield* countsOf;
        const candidates = candidatesOf(repo, running);
        const keptCandidate =
          kept === undefined ? undefined : candidates.find((candidate) => targetKey(candidate) === targetKey(kept));
        return yield* settle(repo.repo, keptCandidate === undefined ? candidates : [keptCandidate], running, request);
      }).pipe(exclusive.withPermits(1)),
  };
};
