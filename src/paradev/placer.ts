/**
 * The per-pass glue of placement (#55): it gathers what the pass has read about each target of a
 * repo, asks `choosePlacement`, and records why a candidate was not used. `launch` asks it once per
 * command id, through `place`. Everything it reads is read at most once per pass.
 */
import * as Effect from "effect/Effect";

import type { Attention } from "../attention.ts";
import type { MachineConfig, WatchedRepo } from "../config.ts";
import type { MachineEvent } from "../ledger/events.ts";
import type { Load } from "../load.ts";
import { NoTargetHasRoom, type LaunchRequest } from "../sessions.ts";
import { type Candidate, choosePlacement } from "./placement.ts";
import { checkProxy, type ProxyAnswer, type ProxyGet } from "./proxy.ts";
import type { LaunchTarget, TargetCount } from "./sessions.ts";

/** Raised when the proxy has not answered 401 for `CLOUD_PROXY_DOWN_PASSES` passes in a row. */
export const CLOUD_PROXY_DOWN_ITEM_ID = "cloud-proxy-down";
/** Raised while the proxy answers 200 to a call with no key: its key check is off. */
export const CLOUD_PROXY_OPEN_ITEM_ID = "cloud-proxy-open";
export const CLOUD_PROXY_DOWN_PASSES = 3;

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
  readonly proxyGet: ProxyGet;
  readonly attention: Pick<Attention["Service"], "raise" | "clear">;
  /** Writes to the machine log; callers swallow their own errors. */
  readonly record: (event: MachineEvent) => Effect.Effect<void>;
}

/** The port the proxy's `https://` address names, 443 when it names none. */
const portOf = (proxy: string): string => {
  try {
    return new URL(proxy).port || "443";
  } catch {
    return "443";
  }
};

const keyOf = (target: TargetCount["target"]): string =>
  target.kind === "host" ? `host:${target.machineId}` : target.kind;

export const makePlacer = (deps: PlacerDeps) => {
  const { machine } = deps;
  let localHeld: string | null = null;
  /** Running agents per target this pass; null when its snapshot could not be read. Null here: not read yet. */
  let counts: Map<string, number | null> | null = null;
  let proxyAnswer: ProxyAnswer | null = null;
  let recorded = new Set<string>();
  /** Passes in a row the proxy was down; kept across passes. */
  let proxyMisses = 0;

  const countsOf = Effect.gen(function* () {
    if (counts === null) {
      const read = yield* deps.running;
      counts = new Map(read.map((count) => [keyOf(count.target), count.running]));
    }
    return counts;
  });

  /** Why cloud takes no run this pass, or null when the proxy check passed. Asks the proxy once per pass. */
  const proxyReason = Effect.gen(function* (): Effect.fn.Return<string | null> {
    const cloud = machine.cloud;
    if (cloud === undefined) return "no cloud block in the machine config";
    if (proxyAnswer === null) {
      proxyAnswer = yield* checkProxy(deps.proxyGet, cloud.proxy);
      if (proxyAnswer.kind === "guarded") {
        proxyMisses = 0;
        yield* deps.attention.clear(
          (item) => item.id === CLOUD_PROXY_DOWN_ITEM_ID || item.id === CLOUD_PROXY_OPEN_ITEM_ID,
        );
      } else if (proxyAnswer.kind === "open") {
        proxyMisses = 0;
        yield* deps.attention.clear((item) => item.id === CLOUD_PROXY_DOWN_ITEM_ID);
        yield* deps.attention.raise({
          id: CLOUD_PROXY_OPEN_ITEM_ID,
          kind: "attention",
          repo: null,
          issue: null,
          run: null,
          message: `the cloud proxy at ${cloud.proxy} answered 200 to a call with no key, so its key check is off; cloud takes no run until it is back on`,
        });
      } else {
        proxyMisses += 1;
        yield* deps.attention.clear((item) => item.id === CLOUD_PROXY_OPEN_ITEM_ID);
        if (proxyMisses >= CLOUD_PROXY_DOWN_PASSES) {
          // No error text: an open item is not raised again, so it would go stale.
          yield* deps.attention.raise({
            id: CLOUD_PROXY_DOWN_ITEM_ID,
            kind: "attention",
            repo: null,
            issue: null,
            run: null,
            message: `the cloud proxy at ${cloud.proxy} has not answered 401 for ${CLOUD_PROXY_DOWN_PASSES} passes; cloud takes no run until it does; on the proxy's Mac check the CLI Proxy API is up and the Funnel is on: tailscale funnel status, and tailscale funnel --bg --https=${portOf(cloud.proxy)} <the proxy's local port>`,
          });
        }
      }
    }
    return proxyAnswer.kind === "guarded"
      ? null
      : proxyAnswer.kind === "open"
        ? "the proxy's key check is off (it answered 200 with no key)"
        : `the proxy check failed: ${proxyAnswer.reason}`;
  });

  const candidatesOf = (repo: WatchedRepo, running: ReadonlyMap<string, number | null>) =>
    Effect.gen(function* () {
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
          slots: { running: countOf(`host:${host.id}`), max: host.maxRuns },
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
          proxy: yield* proxyReason,
        });
      }
      return candidates;
    });

  const keyOfPlaced = (target: LaunchTarget): string =>
    target.kind === "host" ? `host:${target.machineId}` : target.kind;

  return {
    /**
     * Starts a pass: forgets the last pass's counts, proxy answer and recorded drops. `localHeld`
     * is why P1's checks hold claims this pass ("low disk", "high load"), else null.
     */
    beginPass: (held: string | null): void => {
      localHeld = held;
      counts = null;
      proxyAnswer = null;
      recorded = new Set();
    },
    place: (request: LaunchRequest): Effect.Effect<LaunchTarget, NoTargetHasRoom> =>
      Effect.gen(function* () {
        const repo = deps.repoOfProject(request.projectId);
        // A repo with no hosts and no cloud runs as in P1: on this Mac, with nothing read.
        const hosted = (repo?.hosts?.length ?? 0) > 0;
        const clouded = repo?.cloud !== undefined && machine.cloud !== undefined;
        if (repo === null || (!hosted && !clouded)) return { kind: "local" } as const;
        const running = yield* countsOf;
        const placement = choosePlacement(yield* candidatesOf(repo, running));
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
        const key = keyOfPlaced(placement.target);
        const before = running.get(key);
        if (before !== null && before !== undefined) running.set(key, before + 1);
        return placement.target;
      }),
  };
};
