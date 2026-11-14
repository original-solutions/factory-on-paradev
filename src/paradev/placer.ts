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
import { type Candidate, choosePlacement } from "./placement.ts";
import type { LaunchTarget, TargetCount } from "./sessions.ts";

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

/** The key a target's count is kept under: `local`, `host:<id>` or `cloud`; a counted or a placed target alike. */
const keyOf = (
  target: { readonly kind: "local" | "cloud" } | { readonly kind: "host"; readonly machineId: string },
): string => (target.kind === "host" ? `host:${target.machineId}` : target.kind);

export const makePlacer = (deps: PlacerDeps) => {
  const { machine } = deps;
  let localHeld: string | null = null;
  /** Running agents per target this pass; null when its snapshot could not be read. Null here: not read yet. */
  let counts: Map<string, number | null> | null = null;
  /** Why cloud takes no run this pass, from the pass's proxy check; null when it passed or was not run. */
  let proxyReason: string | null = null;
  let recorded = new Set<string>();
  /** One placement at a time: a re-gate relaunch and a pass launch never read or bump the counts at once. */
  const exclusive = Semaphore.makeUnsafe(1);

  const countsOf = Effect.gen(function* () {
    if (counts === null) {
      const read = yield* deps.running;
      counts = new Map(read.map((count) => [keyOf(count.target), count.running]));
    }
    return counts;
  });

  const candidatesOf = (repo: WatchedRepo, running: ReadonlyMap<string, number | null>): Array<Candidate> => {
    const countOf = (key: string): number | null => running.get(key) ?? null;
    const candidates: Array<Candidate> = [
      {
        kind: "local",
        slots: { running: countOf("local"), max: machine.local.maxRuns },
        load: deps.readLoad(),
        held: localHeld,
      },
    ];
    const notReady = deps.hostsNotReady();
    for (const listed of repo.hosts ?? []) {
      const host = machine.hosts.find((entry) => entry.id === listed.id);
      if (host === undefined) continue;
      candidates.push({
        kind: "host",
        id: host.id,
        name: host.name,
        path: listed.path,
        slots: { running: countOf(keyOf({ kind: "host", machineId: host.id })), max: host.maxRuns },
        maxLoadPerCore: host.maxLoadPerCore,
        load: deps.hostLoads.get(host.id) ?? null,
        notReady: notReady.get(host.id) ?? null,
      });
    }
    if (repo.cloud !== undefined && machine.cloud !== undefined) {
      candidates.push({
        kind: "cloud",
        environmentId: repo.cloud,
        machineSize: machine.cloud.machineSize,
        slots: { running: countOf("cloud"), max: machine.cloud.maxRuns },
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

  return {
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
    place: (request: LaunchRequest): Effect.Effect<LaunchTarget, NoTargetHasRoom> =>
      Effect.gen(function* () {
        const repo = deps.repoOfProject(request.projectId);
        // A repo with no hosts and no cloud runs as in P1: on this Mac, with nothing read.
        const hosted = (repo?.hosts?.length ?? 0) > 0;
        const clouded = repo?.cloud !== undefined && machine.cloud !== undefined;
        if (repo === null || (!hosted && !clouded)) {
          // It still takes a slot on this Mac, when this pass has counted them.
          if (counts !== null) bump(counts, "local");
          return { kind: "local" } as const;
        }
        const running = yield* countsOf;
        const placement = choosePlacement(candidatesOf(repo, running));
        for (const dropped of placement.dropped) {
          const key = `${repo.repo}\u0000${dropped.target}`;
          if (recorded.has(key)) continue;
          recorded.add(key);
          yield* deps.record({
            event: "placement",
            data: { repo: repo.repo, target: dropped.target, reason: dropped.reason },
          });
        }
        if (placement.kind === "refused") return yield* Effect.fail(new NoTargetHasRoom());
        // The slot is taken for the rest of the pass: the next launch counts it.
        bump(running, keyOf(placement.target));
        return placement.target;
      }).pipe(exclusive.withPermits(1)),
  };
};
