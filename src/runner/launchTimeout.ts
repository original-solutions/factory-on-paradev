/**
 * The launch reaper. A run still starting (`triage`, or no state yet) whose `launch-sending` step
 * is older than `launch_timeout_seconds` and that has recorded no thread id, or whose recorded
 * thread or workspace is gone, holds a `max_concurrent_runs` slot that nothing else frees: the
 * launch is failed, the run finished and its issue put back to `factory:ready`, until the issue
 * has used `launch_timeout_retries` and goes `factory:stuck` instead. A stop by hand of a starting
 * run is carried out here too. The pass calls it for each such run before it works the runs, so a
 * launch left mid-way by a crash is reaped on the first pass after the restart.
 */
import * as Effect from "effect/Effect";

import { ledgerCall as ledger } from "../ledger/errors.ts";
import { makeCause } from "../ledger/events.ts";
import { Ledger } from "../ledger/ledger.ts";
import { readRun } from "../ledger/read.ts";
import type { RunId } from "../ledger/runId.ts";
import { STOPPED_BY_HAND } from "./messages.ts";
import { LAUNCH_STOPPED, LAUNCH_TIMED_OUT, readProgress, type Seen } from "./progress.ts";
import { goStuck, progressFrom, stopSession, type RunContext } from "./run.ts";
import { earlierRuns } from "./start.ts";

/** The public reason of an issue that went `stuck` because its launches keep recording no thread id. */
export const LAUNCH_TIMEOUT_REASON =
  "the session launch never recorded a thread id, and the issue has used its launch retries";

export interface LaunchTimeoutContext extends RunContext {
  readonly dataDir: string;
  /** Unix epoch milliseconds. */
  readonly clock: () => number;
  /** `launch_timeout_seconds` and `launch_timeout_retries` from the machine config. */
  readonly launchTimeout: { readonly seconds: number; readonly retries: number };
}

/** How a launch with no thread id was ended: by the timeout, or by a stop by hand. */
export type LaunchEnd = "timed-out" | "stopped";

/** What `reapLaunch` did. */
export type LaunchReap =
  /** Nothing: the run is not starting, its launch is within the timeout or live, or its issue is closed. */
  | { readonly kind: "left" }
  /** The run is finished and the issue is `factory:ready` and unassigned. `failures` counts this one. */
  | { readonly kind: "ready"; readonly ended: LaunchEnd; readonly failures: number }
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
    };

const LEFT: LaunchReap = { kind: "left" };

/** The step that records how the launch ended, and the reason of every line this writes for it. */
const recordOf = (ended: LaunchEnd) =>
  ended === "timed-out"
    ? { step: LAUNCH_TIMED_OUT, reason: "launch-timeout" }
    : { step: LAUNCH_STOPPED, reason: "stop-requested" };

/** Whether the run is still starting: confirmed, unfinished, in `triage` or before any state. */
const starting = (seen: Seen): boolean =>
  !seen.finished &&
  (seen.approvedAt !== null || seen.threadId !== null) &&
  (seen.state === null || seen.state === "triage");

/** Whether T3 still has the thread, not archived. A read T3 cannot answer is an error. */
const threadLive = (ctx: LaunchTimeoutContext, threadId: string) =>
  ctx.sessions.thread(threadId).pipe(
    Effect.map((thread) => !thread.archived),
    Effect.catchTag("FactoryThreadNotFoundError", () => Effect.succeed(false)),
  );

/** How many earlier runs of the issue, in this repo, ended a launch that recorded no thread id. */
const earlierFailures = Effect.fn("RunnerLaunchTimeout.earlierFailures")(function* (
  ctx: LaunchTimeoutContext,
  run: RunId,
) {
  const runs = yield* earlierRuns(ctx.dataDir, run);
  return runs.filter(({ entries }) => readProgress(entries).launchFailed !== null).length;
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
 * Reaps `run` if its launch timed out or a stop by hand asks for it. The decision is written to
 * the ledger first (`launch-timed-out` or `launch-stopped`), so a call cut short goes on from it
 * and a later run of the issue counts it. Then the session, if any, is stopped and the issue moved;
 * `state_changed` and the `finished` line come last. A failed call leaves the run unfinished and
 * the next pass tries again. An issue that was closed is left to `start`, which abandons the run.
 */
export const reapLaunch = Effect.fn("RunnerLaunchTimeout.reapLaunch")(function* (
  ctx: LaunchTimeoutContext,
  run: RunId,
) {
  const seen = readProgress((yield* ledger(() => readRun(ctx.dataDir, run))).entries);
  if (!starting(seen)) return LEFT;
  const decided = yield* decide(ctx, seen);
  if (decided === null) return LEFT;
  const issue = Number(run.issue);
  if ((yield* ctx.tracker.issue(issue)).closed) return LEFT;
  const out = yield* ledger(() => Ledger.open(ctx.dataDir, run, { clock: ctx.clock }));
  try {
    const at = progressFrom("pass", seen, "triage");
    if (decided === "stuck-by-hand") {
      yield* goStuck(ctx, issue, out, at, "stop-requested", { reason: STOPPED_BY_HAND });
      return { kind: "stuck", ended: "stopped", failures: 0, limit: false } satisfies LaunchReap;
    }
    const { step, reason } = recordOf(decided);
    const cause = makeCause("pass", reason);
    if (seen.launchFailed === null) {
      yield* ledger(() => out.append({ event: "step_changed", data: { step } }, cause));
    }
    const failures = (yield* earlierFailures(ctx, run)) + 1;
    if (failures > ctx.launchTimeout.retries) {
      yield* goStuck(ctx, issue, out, at, reason, { reason: LAUNCH_TIMEOUT_REASON });
      return { kind: "stuck", ended: decided, failures, limit: true } satisfies LaunchReap;
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
    return { kind: "ready", ended: decided, failures } satisfies LaunchReap;
  } finally {
    out.close();
  }
});
