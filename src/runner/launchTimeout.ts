/**
 * The launch reaper. A run still starting (`isStarting`) whose `launch-sending` step is older than
 * `launch_timeout_seconds` and that has recorded no thread id, or whose recorded thread or
 * workspace is gone, holds a `max_concurrent_runs` slot that nothing else frees: the launch is
 * failed, the run finished and its issue put back to `factory:ready`, until the issue has used
 * `launch_timeout_retries` and goes `factory:stuck` instead. A launch refused for room writes no
 * step, so a wait for room past the timeout is such a run too. A stop by hand of a starting run is
 * carried out here as well. The pass calls it for each such run before it works the runs, so a
 * launch left mid-way by a crash is reaped on the first pass after the restart. The issue is moved
 * only while it is still the run's (`factory:triage`, the factory alone assigned, no other
 * machine's claim): otherwise the run is finished in the ledger and the issue left as it is.
 */
import * as Effect from "effect/Effect";

import { ledgerCall as ledger } from "../ledger/errors.ts";
import { makeCause } from "../ledger/events.ts";
import { Ledger } from "../ledger/ledger.ts";
import { readRun } from "../ledger/read.ts";
import type { RunId } from "../ledger/runId.ts";
import { STOPPED_BY_HAND } from "./messages.ts";
import {
  isStarting,
  LAUNCH_STOPPED,
  LAUNCH_TIMED_OUT,
  readProgress,
  type Seen,
} from "./progress.ts";
import { goStuck, progressFrom, stopSession, type RunContext } from "./run.ts";
import { earlierRuns, isOurs, type StartError } from "./start.ts";

/** The public reason of an issue that went `stuck` because its launches keep recording no thread id. */
export const LAUNCH_TIMEOUT_REASON =
  "the session launch never recorded a thread id, and the issue has used its launch retries";

export interface LaunchTimeoutContext extends RunContext {
  readonly dataDir: string;
  /** Unix epoch milliseconds. */
  readonly clock: () => number;
  /** `launch_timeout_seconds` and `launch_timeout_retries` from the machine config. */
  readonly launchTimeout: { readonly seconds: number; readonly retries: number };
  /**
   * `yieldToClaim` for the issue on a repo with no `factory.owner`: the machine whose claim comment
   * holds the issue when it is not this one (this machine's runs of it are then finished), else
   * null. Null at once on a repo `factory.owner` gives to one machine.
   */
  readonly yieldToClaim: (
    issue: number,
  ) => Effect.Effect<
    { readonly machine: string; readonly finished: ReadonlyArray<RunId> } | null,
    StartError
  >;
}

/** How a launch with no thread id was ended: by the timeout, or by a stop by hand. */
export type LaunchEnd = "timed-out" | "stopped";

/**
 * What `reapLaunch` did. `failures` is the issue's launch timeouts in this repo's ledgers, this one
 * included when it is a timeout: a stop by hand uses no retry. `mayHaveSession`: the launch was
 * sent and no thread id was recorded, so a session may exist under the run's launch command id
 * that nothing archived.
 */
export type LaunchReap =
  /** Nothing: the run is not starting, its launch is within the timeout or live, its ledger already decided it is stuck, or its issue is closed. */
  | { readonly kind: "left" }
  /** The run is finished and the issue is `factory:ready` and unassigned. */
  | {
      readonly kind: "ready";
      readonly ended: LaunchEnd;
      readonly failures: number;
      readonly mayHaveSession: boolean;
    }
  /**
   * The run is finished and the issue is `factory:stuck`. `limit`: the issue had used its launch
   * retries, so this is the `launch-timeout` item's; otherwise a stop by hand of a run with a
   * thread, which ends as a building run's stop does.
   */
  | {
      readonly kind: "stuck";
      readonly ended: LaunchEnd;
      readonly failures: number;
      readonly limit: boolean;
      readonly mayHaveSession: boolean;
    }
  /**
   * The issue is no longer the run's (moved off `factory:triage`, or not assigned to the factory
   * alone): the run is finished in the ledger, its recorded thread stopped, and the issue left as
   * it is. Not a launch failure.
   */
  | { readonly kind: "released" }
  /** Another machine's claim comment holds the issue: `yieldToClaim` finished this machine's runs of it. */
  | { readonly kind: "yielded"; readonly machine: string };

const LEFT: LaunchReap = { kind: "left" };

/** The step that records how the launch ended, and the reason of every line this writes for it. */
const recordOf = (ended: LaunchEnd) =>
  ended === "timed-out"
    ? { step: LAUNCH_TIMED_OUT, reason: "launch-timeout" }
    : { step: LAUNCH_STOPPED, reason: "stop-requested" };

/** Whether T3 still has the thread, not archived. A read T3 cannot answer is an error. */
const threadLive = (ctx: LaunchTimeoutContext, threadId: string) =>
  ctx.sessions.thread(threadId).pipe(
    Effect.map((thread) => !thread.archived),
    Effect.catchTag("FactoryThreadNotFoundError", () => Effect.succeed(false)),
  );

/** How many earlier runs of the issue, in this repo, the launch timeout failed. A stop by hand is not one. */
const earlierTimeouts = Effect.fn("RunnerLaunchTimeout.earlierTimeouts")(function* (
  ctx: LaunchTimeoutContext,
  run: RunId,
) {
  const runs = yield* earlierRuns(ctx.dataDir, run);
  return runs.filter(({ entries }) => readProgress(entries).launchFailed === "timed-out").length;
});

/**
 * How the run's launch ends now, or null to leave it: a decision already in the ledger stands; a
 * stop by hand ends it at once; else the launch must be older than the timeout with no thread id,
 * or with a thread that is gone. `stuck-by-hand` is a stop of a run whose thread is recorded.
 */
const decide = Effect.fn("RunnerLaunchTimeout.decide")(function* (
  ctx: LaunchTimeoutContext,
  seen: Seen,
) {
  if (seen.launchFailed !== null) return seen.launchFailed;
  if (seen.stopRequested) return seen.threadId === null ? "stopped" : "stuck-by-hand";
  if (seen.launchSentMs === null) return null;
  if (ctx.clock() - seen.launchSentMs <= ctx.launchTimeout.seconds * 1000) return null;
  if (seen.threadId !== null && (yield* threadLive(ctx, seen.threadId))) return null;
  return "timed-out";
});

/**
 * Reaps `run` if its launch timed out or a stop by hand asks for it. An issue that was closed is
 * left to `start`, which abandons the run, and a run whose ledger already decided it is stuck is
 * left to `start` to finish. An issue that is no longer the run's is not moved (`released`), and
 * one another machine's claim holds is left to it (`yielded`). Otherwise the decision is written
 * to the ledger first (`launch-timed-out` or `launch-stopped`), so a call cut short goes on from
 * it and a later run of the issue counts a timeout. Then the session, if any, is stopped and the
 * issue moved: to `factory:stuck` once the issue's earlier launch timeouts reach
 * `launch_timeout_retries`, else to `factory:ready`. `state_changed` and the `finished` line come
 * last. A failed call leaves the run unfinished and the next pass tries again.
 */
export const reapLaunch = Effect.fn("RunnerLaunchTimeout.reapLaunch")(function* (
  ctx: LaunchTimeoutContext,
  run: RunId,
) {
  const seen = readProgress((yield* ledger(() => readRun(ctx.dataDir, run))).entries);
  if (!isStarting(seen) || seen.stuck !== null) return LEFT;
  const decided = yield* decide(ctx, seen);
  if (decided === null) return LEFT;
  const issue = Number(run.issue);
  const detail = yield* ctx.tracker.issue(issue);
  if (detail.closed) return LEFT;
  const ours = detail.state === "triage" && isOurs(detail.assignees, ctx.trackerUser);
  if (ours) {
    const yielded = yield* ctx.yieldToClaim(issue);
    if (yielded !== null) return { kind: "yielded", machine: yielded.machine } satisfies LaunchReap;
  }
  const out = yield* ledger(() => Ledger.open(ctx.dataDir, run, { clock: ctx.clock }));
  try {
    const at = progressFrom("pass", seen, "triage");
    if (!ours) {
      // A person moved the issue, or another claim holds it: the run is over, the issue is theirs.
      yield* stopSession(ctx, out, at);
      yield* ledger(() => out.finish("stuck", null, null, makeCause("pass", "issue-moved")));
      return { kind: "released" } satisfies LaunchReap;
    }
    if (decided === "stuck-by-hand") {
      yield* goStuck(ctx, issue, out, at, "stop-requested", { reason: STOPPED_BY_HAND });
      return {
        kind: "stuck",
        ended: "stopped",
        failures: 0,
        limit: false,
        mayHaveSession: false,
      } satisfies LaunchReap;
    }
    const { step, reason } = recordOf(decided);
    const cause = makeCause("pass", reason);
    if (seen.launchFailed === null) {
      yield* ledger(() => out.append({ event: "step_changed", data: { step } }, cause));
    }
    const earlier = yield* earlierTimeouts(ctx, run);
    const failures = earlier + (decided === "timed-out" ? 1 : 0);
    const mayHaveSession = seen.launchSent && seen.threadId === null;
    if (earlier >= ctx.launchTimeout.retries) {
      yield* goStuck(ctx, issue, out, at, reason, { reason: LAUNCH_TIMEOUT_REASON });
      return {
        kind: "stuck",
        ended: decided,
        failures,
        limit: true,
        mayHaveSession,
      } satisfies LaunchReap;
    }
    // A thread recorded and gone: archiving it changes nothing, and its worktree is removed.
    yield* stopSession(ctx, out, at);
    // The label swap and release a failed start uses, to `factory:ready` this time.
    yield* ctx.tracker.setState(issue, "ready");
    yield* ctx.tracker.unassign(issue, ctx.trackerUser);
    const from = at.state;
    if (from !== "ready") {
      yield* ledger(() =>
        out.append({ event: "state_changed", data: { from, to: "ready" } }, cause),
      );
    }
    yield* ledger(() => out.finish("stuck", null, null, cause));
    return { kind: "ready", ended: decided, failures, mayHaveSession } satisfies LaunchReap;
  } finally {
    out.close();
  }
});
