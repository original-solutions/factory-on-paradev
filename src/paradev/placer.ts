/**
 * The per-pass glue of placement (#55): it gathers what the pass has read about each target of a
 * repo, asks `choosePlacement`, and records why a candidate was not used. `launch` asks it once per
 * command id, through `place`. Placement reads everything at most once per pass; the rows the
 * belt and `status` show, built after the pass, reuse that read or make their own.
 */
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

import type { CloudConfig, HostConfig, MachineConfig, WatchedRepo } from "../config.ts";
import type { MachineEvent } from "../ledger/events.ts";
import type { Load } from "../load.ts";
import { NoTargetHasRoom, type LaunchRequest } from "../sessions.ts";
import { type Candidate, choosePlacement, targetKey, targetRow, type TargetReading } from "./placement.ts";
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

/** Why cloud takes no run before a pass has checked the proxy under the config in use. */
export const PROXY_NOT_CHECKED = "the proxy is not checked yet since the config load";

export const makePlacer = (deps: PlacerDeps) => {
  let localHeld: string | null = null;
  /** This Mac's load this pass; read on the first candidate list of the pass and kept for the rest of it. */
  let localLoad: Load | null = null;
  /** Running agents per target this pass; null when its snapshot could not be read. Null here: not read yet. */
  let counts: Map<string, number | null> | null = null;
  /** Which pass this is, so a read that ends after the next pass began is not taken for that pass's own. */
  let pass = 0;
  /** Why cloud takes no run this pass, from the pass's proxy check; null when it passed or was not run. */
  let proxyReason: string | null = null;
  /**
   * The machine config the last pass's proxy check ran under, as the pass says. The check holds for
   * it alone: before the first pass, or after a reload until a pass under the new config, cloud is
   * unchecked.
   */
  let checkedUnder: MachineConfig | null = null;
  let recorded = new Set<string>();
  /**
   * The placements whose launch has not ended, by command id, with the key of their target; kept
   * across passes. Such a launch has no agent in a snapshot yet, so each counts as one running.
   */
  const inFlight = new Map<string, string>();
  /** One placement at a time: a re-gate relaunch and a pass launch never read or bump the counts at once. */
  const exclusive = Semaphore.makeUnsafe(1);

  /** The snapshots, with the launches in flight on top: the counts as placement reads them. */
  const readCounts = Effect.gen(function* () {
    const read = yield* deps.running;
    const running = new Map(read.map((count) => [targetKey(count.target), count.running]));
    // A launch in flight is in no snapshot yet: it counts on top of what the snapshot read.
    for (const key of inFlight.values()) bump(running, key);
    return running;
  });

  /** The pass's counts: read on the first placement of the pass and kept for the rest of it. */
  const countsOf = Effect.gen(function* () {
    if (counts === null) counts = yield* readCounts;
    return counts;
  });

  /** This Mac's load, read on the first candidate list of the pass and kept for the rest of it. */
  const passLoad = (): Load => (localLoad ??= deps.readLoad());

  /** This Mac as a candidate; `held` is why P1's checks hold claims, which a repo with nowhere else to go ignores. */
  const localOf = (running: ReadonlyMap<string, number | null>, held: string | null, load: Load): Candidate => ({
    kind: "local",
    slots: { running: running.get("local") ?? null, max: deps.machine.local.maxRuns },
    load,
    held,
  });

  /** A host's readings this pass, whatever repo is placed. */
  const hostOf = (
    host: HostConfig,
    running: ReadonlyMap<string, number | null>,
    notReady: ReadonlyMap<string, string>,
  ): Extract<TargetReading, { readonly kind: "host" }> => ({
    kind: "host",
    id: host.id,
    name: host.name,
    slots: { running: running.get(targetKey({ kind: "host", id: host.id })) ?? null, max: host.maxRuns },
    maxLoadPerCore: host.maxLoadPerCore,
    load: deps.hostLoads.get(host.id) ?? null,
    notReady: notReady.get(host.id) ?? null,
  });

  /** Cloud's readings this pass, whatever repo is placed. */
  const cloudOf = (
    cloud: CloudConfig,
    running: ReadonlyMap<string, number | null>,
  ): Extract<TargetReading, { readonly kind: "cloud" }> => ({
    kind: "cloud",
    machineSize: cloud.machineSize,
    slots: { running: running.get("cloud") ?? null, max: cloud.maxRuns },
    proxy: checkedUnder === deps.machine ? proxyReason : PROXY_NOT_CHECKED,
  });

  const candidatesOf = (repo: WatchedRepo, running: ReadonlyMap<string, number | null>): Array<Candidate> => {
    const candidates: Array<Candidate> = [localOf(running, localHeld, passLoad())];
    const notReady = deps.hostsNotReady();
    for (const listed of repo.hosts ?? []) {
      const host = deps.machine.hosts.find((entry) => entry.id === listed.id);
      if (host === undefined) continue;
      candidates.push({ ...hostOf(host, running, notReady), path: listed.path });
    }
    const { cloud } = deps.machine;
    if (repo.cloud !== undefined && cloud !== undefined) {
      candidates.push({ ...cloudOf(cloud, running), environmentId: repo.cloud });
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
    pinned = false,
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
      if (placement.kind === "refused") {
        // A pinned check has the one candidate, so the first drop is why it was refused.
        const why = pinned ? placement.dropped[0] : undefined;
        return yield* Effect.fail(
          new NoTargetHasRoom(why === undefined ? {} : { pinned: `${why.target}: ${why.reason}` }),
        );
      }
      // The slot is taken for the rest of the pass: the next launch counts it.
      bump(running, targetKey(placement.target));
      inFlight.set(request.commandId, targetKey(placement.target));
      return placement.target;
    });

  return {
    /**
     * A row for this Mac, each configured host, and cloud when configured, from this pass's
     * readings. The counts are the ones a launch read this pass, taken under the lock so a
     * placement under way is counted first. When no launch read any, the rows read them here,
     * off the lock, so a slow snapshot holds up no launch; the read is kept as the pass's own
     * only while it is still this pass and no launch read meanwhile.
     */
    targets: Effect.gen(function* () {
      const began = pass;
      let running = yield* Effect.sync(() => counts).pipe(exclusive.withPermits(1));
      if (running === null) {
        running = yield* readCounts;
        if (pass === began && counts === null) counts = running;
      }
      // The same for the load: this pass's one read, or one the rows keep to themselves.
      const load = pass === began ? passLoad() : deps.readLoad();
      const notReady = deps.hostsNotReady();
      const { cloud } = deps.machine;
      const readings: Array<TargetReading> = [
        localOf(running, localHeld, load),
        ...deps.machine.hosts.map((host) => hostOf(host, running, notReady)),
        ...(cloud === undefined ? [] : [cloudOf(cloud, running)]),
      ];
      return readings.map(targetRow);
    }),
    /** The launch of `commandId` ended: its agent is in the snapshots now, so it stops counting on its own. */
    launchEnded: (commandId: string): Effect.Effect<void> =>
      Effect.sync(() => void inFlight.delete(commandId)),
    /**
     * Starts a pass: forgets the last pass's counts and recorded drops. `localHeld` is why P1's
     * checks hold claims this pass ("low disk", "high load"), else null; `proxy` is why cloud
     * takes no run this pass (the pass's proxy check), else null; `machine` is the config that
     * check ran under, so a reload during the pass does not take the check as its own.
     */
    beginPass: (began: {
      readonly localHeld: string | null;
      readonly proxy: string | null;
      readonly machine: MachineConfig;
    }): void => {
      pass += 1;
      localHeld = began.localHeld;
      proxyReason = began.proxy;
      checkedUnder = began.machine;
      counts = null;
      localLoad = null;
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
          return yield* settle(repo?.repo ?? request.projectId, [localOf(running, null, passLoad())], running, request);
        }
        const running = yield* countsOf;
        const candidates = candidatesOf(repo, running);
        const keptCandidate =
          kept === undefined ? undefined : candidates.find((candidate) => targetKey(candidate) === targetKey(kept));
        return yield* settle(
          repo.repo,
          keptCandidate === undefined ? candidates : [keptCandidate],
          running,
          request,
          keptCandidate !== undefined,
        );
      }).pipe(exclusive.withPermits(1)),
  };
};
