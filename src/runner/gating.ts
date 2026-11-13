/**
 * The gate of a building run, ported from softfac's `runner/gating.rs`, and `regate` for a
 * `pr-open` pull request whose head moved. `FactoryGate` (`gate.ts`) owns the checkout, commands
 * and removal; this module decides what they mean. Each call does only what the ledger does not
 * record, so a repeat resumes; a tracker, T3 or checkout failure writes nothing final.
 */

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { transition, type Action } from "../domain/lifecycle.ts";
import {
  MERGE_COMMAND,
  WorkspaceUnexpectedError,
  commandCode,
  gateLogPath,
  gateResultsComment,
  gateRoot,
  leftoverCheckouts,
  regateResultsComment,
  removeEmptyGateRoot,
  removeLeftoverCheckouts,
  type CommandResult,
  type FactoryGate,
  type GateError,
  type GateOptions,
} from "../gate.ts";
import { ledgerCall as ledger, type LedgerError } from "../ledger/errors.ts";
import { makeCause, type RunEvent } from "../ledger/events.ts";
import { readRun } from "../ledger/read.ts";
import { asciiLower, runIdToString, type RunId } from "../ledger/runId.ts";
import type { FactorySessions, ThreadStatus } from "../sessions.ts";
import { isCommitId, sanitize } from "../text.ts";
import type { BoundGitHub, IssueDetail, PullRequest } from "../tracker/github.ts";
import {
  WrongRepoError,
  append,
  checkBinding,
  earlierAttempts,
  withBoundBranches,
  sessionBusy,
  stopOf,
  textStop,
  threadStatus,
  withLedger,
  type BuildingContext,
  type BuildingError,
  type Out,
} from "./building.ts";
import {
  CHECKS_HEAD_MOVED,
  END_WITH_DONE,
  STOPPED_BY_HAND,
  THREAD_GONE,
  checksFailureMessage,
  failureMessage,
  howItEnded,
  mergeConflictMessage,
  prepareOutputTail,
} from "./messages.ts";
import {
  CHECKS_TIMED_OUT,
  GATE_PASSED,
  GATE_PASSED_CLEAN,
  GATE_SENDING,
  attemptsSincePass,
  nextGateAttempt,
  pendingRelaunch,
  readProgress,
  regateAttempt,
  withoutCheckReads,
  type Moved,
  type PassRecord,
  type Relaunch,
  type Seen,
} from "./progress.ts";
import { branchRefused, relaunchSession } from "./relaunch.ts";
import {
  abandon,
  applyActions,
  closedIssue,
  endOwnMerge,
  endRun,
  goStuck,
  progressFrom,
  recordedReason,
  stopSession,
  type Progress,
  type Stop,
} from "./run.ts";

export { mergeConflictMessage } from "./messages.ts";

/**
 * What the gate asks of the factory besides what a building run asks: the base tip, who marked a
 * pull request ready, the gate itself, and what a failed re-gate needs to launch the session that
 * fixes it.
 */
export interface GateContext extends BuildingContext {
  readonly tracker: BuildingContext["tracker"] &
    Pick<BoundGitHub, "branchTip" | "readyBy" | "checks">;
  readonly gate: Pick<FactoryGate["Service"], "run">;
  readonly maxConcurrentGates: number;
  readonly gateOptions?: GateOptions;
  readonly repoPath: string;
  readonly ghConfigDir: string;
  readonly sessions: BuildingContext["sessions"] &
    Pick<FactorySessions["Service"], "findProject" | "launch" | "showGateLog">;
}

/** The project names no gate command: nothing can pass, and the pass marker could not tell a gate command from a provision command. */
export class NoGateCommandsError extends Schema.TaggedError<NoGateCommandsError>()(
  "NoGateCommandsError",
  { repo: Schema.String },
) {
  override get message(): string {
    return `${this.repo}: the project config names no gate command`;
  }
}

export type GateStepError = BuildingError | GateError | NoGateCommandsError;

/** What `gate` did. */
export type GateStep =
  /**
   * Every command passed. The pull request is ready for review, the results are on it and the
   * issue is `pr-open`. The run is not finished: it stays open while its pull request waits for
   * a person.
   */
  | { readonly kind: "passed"; readonly pr: number }
  /** An attempt failed and was sent into the session. `advance` reports the run ready for the gate again only after the session has finished a new run. */
  | { readonly kind: "sent-back"; readonly attempt: number }
  /** The issue went to `stuck`. The pull request stays open, a draft. `reason` is as the ledger records it. */
  | { readonly kind: "stuck"; readonly reason: string }
  /**
   * Nothing to gate yet, or any more: the run is finished, has no pull request or session, is not
   * `building`, or its session is still working. Also the answer when the pull request's head
   * moved while the commands ran: the next call gates the new head. Nothing was decided, though a
   * gate run that did happen is on record.
   */
  | { readonly kind: "not-ready" }
  /** The pull request was merged or closed, so the run is finished and is never looked at again. A pass on the commit that was merged is recorded and moves the issue to `pr-open` first. */
  | { readonly kind: "ended" }
  /** A person closed the issue: the session's thread is archived and the run is finished, with no command run and nothing written on GitHub. */
  | { readonly kind: "abandoned" }
  /** This run has a gate running already: its lock is held. */
  | { readonly kind: "running" }
  /**
   * Every command passed and the project names required checks that have not all finished on the
   * commit that was gated. Nothing is marked ready; the next call reads them again.
   */
  | { readonly kind: "checks-pending" }
  /**
   * Only `regate` says this: the pull request's head is the one the last pass ran on and GitHub
   * does not say it conflicts, so there is nothing to gate again. One read was made and nothing
   * was written.
   */
  | { readonly kind: "unchanged" }
  /** `max_concurrent_gates` gates run already; the next call tries again. */
  | { readonly kind: "queued"; readonly running: number; readonly max: number };

const NOT_READY = { kind: "not-ready" } as const;

/** `attempt` as the stuck comment counts it: "1 attempt", "2 attempts". */
const attempts = (n: number): string => `${n} ${n === 1 ? "attempt" : "attempts"}`;

/** The results of a pass, as the comment needs them: the last `count` command lines of the attempt. */
const resultsOf = (pass: PassRecord): ReadonlyArray<CommandResult> =>
  pass.lines.slice(Math.max(0, pass.lines.length - pass.count)).map((line) => ({
    command: line.command,
    exitCode: line.exitCode,
    durationMs: line.durationMs,
    timedOut: false,
    output: "",
  }));

/** The gate's stuck path: `goStuck` with the gate as the step, and the reason as the ledger records it. */
const stuckWith = Effect.fn("RunnerGating.stuckWith")(function* (
  ctx: GateContext,
  out: Out,
  issue: number,
  at: Progress,
  code: string,
  stop: Stop,
) {
  const opened = yield* out.open;
  yield* goStuck(ctx, issue, opened, at, code, stop);
  return { kind: "stuck", reason: recordedReason(stop) } as const;
});

/**
 * The gate's stop for a pull request that is not the run's own (`checkBinding`), or is gone:
 * `pr-not-bound`, with the session's last `message` for the stuck comment when there is a session.
 */
const stuckUnbound = (
  ctx: GateContext,
  out: Out,
  issue: number,
  at: Progress,
  message: string | null,
  unbound: { readonly public: string; readonly detail?: string },
): Effect.Effect<GateStep, GateStepError> =>
  stuckWith(
    ctx,
    out,
    issue,
    at,
    "pr-not-bound",
    stopOf(unbound.public, message, unbound.detail === undefined ? {} : { detail: unbound.detail }),
  );

/**
 * The rest of a passing gate once the pass is recorded: stop the session and remove its worktree
 * (the branch stays), mark the pull request ready, post the results, move the issue to `pr-open`.
 * The run stays open while the pull request waits for a person; one merged or closed meanwhile
 * (`stillOpen` false) gets nothing posted. The stop precedes any GitHub write; a resume skips it.
 */
const finishPass = Effect.fn("RunnerGating.finishPass")(function* (
  ctx: GateContext,
  out: Out,
  issue: number,
  at: Progress,
  pass: PassRecord,
  pr: number,
  stillOpen: boolean,
) {
  const opened = yield* out.open;
  yield* stopSession(ctx, opened, at);
  const moved = yield* Effect.fromResult(transition("building", { kind: "pr-ready", pr }));
  const actions = moved.actions.filter(
    (action) =>
      stillOpen || (action.kind !== "mark-pr-ready" && action.kind !== "post-gate-results"),
  );
  const comment = gateResultsComment(resultsOf(pass), pass.attempt, pass.sha, pass.baseSha);
  yield* applyActions(ctx, issue, opened, at, actions, makeCause("gate", "gate-passed"), {
    comment,
  });
  return { kind: "passed", pr } as const;
});

/** Whether the checks the project names still have to be decided for the pass on `sha`. */
const checksWanted = (ctx: GateContext, seen: Seen, sha: string): boolean =>
  ctx.project.requiredChecks.length > 0 && seen.checksPassed !== sha;

/**
 * The `gate-sending` step of `attempt` when its `gate_sent_back` is missing: the send was started
 * and may or may not have reached the session.
 */
const owedSend = (seen: Seen, attempt: number): Seen["sending"] =>
  seen.sending !== null &&
  seen.sending.attempt === attempt &&
  seen.commandAttempts.has(attempt) &&
  !seen.sentBackAttempts.has(attempt)
    ? seen.sending
    : null;

/**
 * Writes the missing `gate_sent_back` of an `owed` send when the session has run since it: the
 * send did reach it, so the attempt is used. True when it was written.
 */
const recoverSend = (
  out: Out,
  attempt: number,
  owed: NonNullable<Seen["sending"]>,
  status: ThreadStatus,
): Effect.Effect<boolean, GateStepError> =>
  status.runOrdinal !== null && status.runOrdinal > owed.runOrdinal
    ? append(
        out,
        { event: "gate_sent_back", data: { attempt, run_ordinal: owed.runOrdinal } },
        "gate",
        "gate-send-recovered",
        { attempt },
      ).pipe(Effect.as(true))
    : Effect.succeed(false);

/**
 * Puts a pull request someone else took out of draft back to draft before a failure is handled,
 * as `advance` does: only the gate marks it ready. Null when there was nothing to do or it went
 * back; a call that fails leaves it as it is, and stuck, while a rate limit is an error, so the
 * next call asks again. `message` is the session's last message, for the stuck comment.
 */
const backToDraft = Effect.fn("RunnerGating.backToDraft")(function* (
  ctx: GateContext,
  out: Out,
  pr: number,
  pull: PullRequest | null,
  stuck: (code: string, stop: Stop) => Effect.Effect<GateStep, GateStepError>,
  message: string | null,
) {
  if (pull === null || !pull.open || pull.isDraft) return null;
  const drafted = yield* Effect.result(ctx.tracker.markPrDraft(pr));
  if (drafted._tag === "Failure") {
    if (drafted.failure._tag === "GitHubRateLimited") return yield* drafted.failure;
    return yield* stuck(
      "pr-not-bound",
      stopOf(`the session reported PR #${pr} but it is not a draft`, message),
    );
  }
  yield* append(out, { event: "pr_set_draft", data: { pr } }, "gate", "pr-set-draft");
  return null;
});

/**
 * Sends a failed attempt (`ordinal` is that of the session run it was gated on) back into the
 * session under the command id `softfac:<run>:gate:<attempt>:<ordinal>`, and records that it
 * went. The `gate-sending` step comes first: with it a later call knows which run this attempt
 * was gated on. `why` is the reason of the lines the send writes.
 */
const sendBack = Effect.fn("RunnerGating.sendBack")(function* (
  ctx: GateContext,
  out: Out,
  run: RunId,
  seen: Seen,
  at: Progress,
  attempt: number,
  ordinal: number,
  text: string,
  why: string,
) {
  const issue = Number(run.issue);
  if (
    seen.sending === null ||
    seen.sending.attempt !== attempt ||
    seen.sending.runOrdinal !== ordinal
  ) {
    yield* append(
      out,
      { event: "step_changed", data: { step: `${GATE_SENDING} ${attempt} ${ordinal}` } },
      "gate",
      "gate-sending",
      { attempt },
    );
  }
  const failed = yield* Effect.fromResult(
    transition("building", { kind: "gate-failed", output: `${END_WITH_DONE}\n\n${text}` }),
  );
  // The id holds the ordinal: a retry before the session ran again is the same command, and
  // a send after a newer run is a new one even if T3 dedupes by id.
  const commandId = `softfac:${runIdToString(run)}:gate:${attempt}:${ordinal}`;
  yield* applyActions(ctx, issue, yield* out.open, at, failed.actions, makeCause("gate", why), {
    send: { commandId, attempt, runOrdinal: ordinal },
  });
  return { kind: "sent-back", attempt } as const;
});

/** The fixed reason of a wait that ran out: a check that never appeared has its own. */
const checksTimedOutReason = (minutes: number, missing: boolean): string =>
  missing
    ? `a required check was not reported within ${minutes} minutes`
    : `the required checks did not finish within ${minutes} minutes`;

/**
 * The decision a read on record already made for the pass on `sha`, which stands: a failure's,
 * so a check run again since cannot mark ready a pull request whose failure may already be in a
 * session; or a wait that ran out, so the stuck decision an earlier call began and did not
 * finish is finished, not judged again. Null while the pass is undecided.
 */
const recordedChecks = (seen: Seen, sha: string) => {
  if (seen.checksFailed !== null && seen.checksFailed.sha === sha) {
    return { kind: "failed", failed: seen.checksFailed.failed } as const;
  }
  if (seen.checksTimedOut !== null && seen.checksTimedOut.sha === sha) {
    return { kind: "timed-out", missing: seen.checksTimedOut.missing } as const;
  }
  return null;
};

/**
 * What the required checks say about the pass on `pass.sha`: all passed, one failed (with the
 * read), pending or missing within `limits.checks_minutes`, or past that limit. A decision on
 * record (`recordedChecks`) stands and `read` is null. The caller writes the `checks_read`
 * line, since its order among the caller's other lines matters.
 */
const decideChecks = Effect.fn("RunnerGating.decideChecks")(function* (
  ctx: GateContext,
  seen: Seen,
  pass: PassRecord,
) {
  const minutes = ctx.project.limits.checksMinutes;
  const recorded = recordedChecks(seen, pass.sha);
  if (recorded?.kind === "failed") {
    return { kind: "failed", read: null, failed: recorded.failed } as const;
  }
  if (recorded?.kind === "timed-out") {
    const reason = checksTimedOutReason(minutes, recorded.missing);
    return { kind: "timed-out", read: null, reason } as const;
  }
  const checks = yield* ctx.tracker.checks(pass.sha, ctx.project.requiredChecks);
  const read: RunEvent = {
    event: "checks_read",
    data: {
      sha: pass.sha,
      checks: checks.map((c) => ({ name: c.name, state: c.state })),
    },
  };
  const failed = checks.filter((c) => c.state === "failed");
  if (failed.length > 0) return { kind: "failed", read, failed } as const;
  if (checks.every((c) => c.state === "passed")) return { kind: "passed", read } as const;
  if (ctx.clock() - pass.atMs < minutes * 60_000) return { kind: "pending" } as const;
  const reason = checksTimedOutReason(
    minutes,
    checks.some((c) => c.state === "missing"),
  );
  return { kind: "timed-out", read, reason } as const;
});

/** The stop of a pass whose required checks failed `since` attempts after the last pass. */
const checksRetriesUsedUp = (since: number, message: string): Stop => {
  const sessionText = prepareOutputTail(message);
  return {
    reason: `the required checks failed after ${attempts(since)}`,
    ...(sessionText !== "" && { sessionText }),
  };
};

/**
 * What a decided check read does, the same for the first gate and the re-gate. All passed: the
 * issue text is judged again (the wait can be long), then the read is recorded and `finish`
 * runs. Pending writes nothing. Past the limit the read is recorded and the issue goes `stuck`.
 * A failure is the caller's: where it goes depends on whether there is a session to send it to.
 */
const settleChecks = Effect.fn("RunnerGating.settleChecks")(function* (
  ctx: GateContext,
  out: Out,
  issue: number,
  seen: Seen,
  at: Progress,
  pass: PassRecord,
  finish: Effect.Effect<GateStep, GateStepError>,
) {
  const attempt = pass.attempt;
  const decided = yield* decideChecks(ctx, seen, pass);
  switch (decided.kind) {
    case "passed": {
      const why = yield* textStop(ctx, issue, seen);
      if (why !== null)
        return yield* stuckWith(ctx, out, issue, at, why.code, { reason: why.reason });
      yield* append(out, decided.read, "gate", "required-checks-read", { attempt });
      return yield* finish;
    }
    case "pending":
      return { kind: "checks-pending" } as const;
    case "timed-out":
      if (decided.read !== null) {
        yield* append(out, decided.read, "gate", CHECKS_TIMED_OUT, { attempt });
      }
      return yield* stuckWith(ctx, out, issue, at, "checks-timed-out", { reason: decided.reason });
    case "failed":
      return decided;
  }
});

/**
 * What is left of a passing gate when the project names required checks: all must pass on the
 * gated commit before the pull request is marked ready, so a head that moved goes `stuck`. A
 * recorded failed or timed-out read stands (`decideChecks`): a rerun check cannot mark ready a pull
 * request whose failure may be in the session. A failed check goes back like a gate failure.
 */
const awaitChecks = Effect.fn("RunnerGating.awaitChecks")(function* (
  ctx: GateContext,
  out: Out,
  run: RunId,
  seen: Seen,
  at: Progress,
  pass: PassRecord,
  gating: { readonly threadId: string; readonly pr: number },
) {
  const { threadId, pr } = gating;
  const issue = Number(run.issue);
  const attempt = pass.attempt;
  const stuck = (code: string, stop: Stop) => stuckWith(ctx, out, issue, at, code, stop);
  const owed = owedSend(seen, attempt);
  if (owed !== null) {
    const status = yield* threadStatus(ctx, threadId);
    if (status === null) return yield* stuck("thread-gone", stopOf(THREAD_GONE, null));
    if (yield* recoverSend(out, attempt, owed, status)) {
      return { kind: "sent-back", attempt } as const;
    }
  }
  const pull = yield* ctx.tracker.pullRequest(pr);
  if (pull === null || !pull.open) return yield* finishPass(ctx, out, issue, at, pass, pr, false);
  if (pull.headSha.toLowerCase() !== pass.sha) {
    return yield* stuck("checks-head-moved", { reason: CHECKS_HEAD_MOVED });
  }
  const decided = yield* settleChecks(
    ctx,
    out,
    issue,
    seen,
    at,
    pass,
    finishPass(ctx, out, issue, at, pass, pr, true),
  );
  if (decided.kind !== "failed") return decided;
  const status = yield* threadStatus(ctx, threadId);
  if (status === null) return yield* stuck("thread-gone", stopOf(THREAD_GONE, null));
  // Without an ordinal the run cannot be told from another one, and a failure is not sent
  // into a run that is still going: nothing is decided, and the session is what is waited
  // for, not the checks.
  if (status.runOrdinal === null) return NOT_READY;
  if (sessionBusy(seen, status)) return NOT_READY;
  if (decided.read !== null) {
    yield* append(out, decided.read, "gate", "required-checks-failed", { attempt });
  }
  const drafted = yield* backToDraft(ctx, out, pr, pull, stuck, status.lastAssistantMessage);
  if (drafted !== null) return drafted;
  const message = checksFailureMessage(pass.sha, decided.failed);
  const since = attemptsSincePass(seen, attempt);
  if (since > ctx.project.limits.gateRetries) {
    return yield* stuck("checks-retries-used-up", checksRetriesUsedUp(since, message));
  }
  return yield* sendBack(
    ctx,
    out,
    run,
    seen,
    at,
    attempt,
    status.runOrdinal,
    message,
    "required-checks-failed",
  );
});

/**
 * What is left of a passing re-gate when the project names required checks: as `awaitChecks`, but
 * the pull request stays ready and the new pass is posted only once they pass. A failure relaunches
 * a session (`relaunchForRegate`), or goes `stuck` once the retries since the last pass are used.
 * A head that moved never comes here: `regate` compares and gates the new head.
 */
const awaitRegateChecks = Effect.fn("RunnerGating.awaitRegateChecks")(function* (
  ctx: GateContext,
  out: Out,
  run: RunId,
  seen: Seen,
  at: Progress,
  pass: PassRecord,
  pull: PullRequest,
  gating: { readonly pr: number; readonly prUrl: string; readonly reassert: boolean },
) {
  const { pr, prUrl, reassert } = gating;
  const issue = Number(run.issue);
  const attempt = pass.attempt;
  const decided = yield* settleChecks(
    ctx,
    out,
    issue,
    seen,
    at,
    pass,
    finishRegatePass(ctx, out, issue, at, pass, pr, reassert),
  );
  if (decided.kind !== "failed") return decided;
  if (decided.read !== null) {
    yield* append(out, decided.read, "gate", "required-checks-failed", { attempt });
  }
  const message = checksFailureMessage(pass.sha, decided.failed);
  const since = attemptsSincePass(seen, attempt);
  if (since > ctx.project.limits.gateRetries) {
    return yield* stuckWith(
      ctx,
      out,
      issue,
      at,
      "checks-retries-used-up",
      checksRetriesUsedUp(since, message),
    );
  }
  return yield* relaunchFailedRegate(
    ctx,
    out,
    run,
    seen,
    at,
    { pr, prUrl, pull },
    {
      attempt,
      message,
    },
  );
});

/**
 * A failed re-gate of a ready pull request, with a retry left. The failure is about to put a
 * session back to work, so the issue text is checked as `watch` checks it: a change by
 * someone who is not an instructor goes `stuck` and nothing is sent.
 */
const relaunchFailedRegate = Effect.fn("RunnerGating.relaunchFailedRegate")(function* (
  ctx: GateContext,
  out: Out,
  run: RunId,
  seen: Seen,
  at: Progress,
  pull: { readonly pr: number; readonly prUrl: string; readonly pull: PullRequest },
  failure: { readonly attempt: number; readonly message: string },
) {
  const issue = Number(run.issue);
  const why = yield* textStop(ctx, issue, seen);
  if (why !== null) return yield* stuckWith(ctx, out, issue, at, why.code, { reason: why.reason });
  return yield* relaunchForRegate(
    ctx,
    out,
    issue,
    at,
    run,
    { pr: pull.pr, prUrl: pull.prUrl, branch: pull.pull.headRef },
    failure,
  );
});

/**
 * The attempt of a re-gate failure whose new session the ledger records (`regate_relaunching`,
 * then `session_launched`) and whose send it does not (no `gate_sent_back`): the call died
 * between the two. The launch happened, so the attempt is used and the session is not launched
 * again. Null when there is no such gap.
 */
const owedRegateSend = (seen: Seen): number | null => {
  if (seen.relaunch === null || !seen.launchedSinceSending || seen.sending === null) return null;
  const attempt = regateAttempt(seen.relaunch);
  if (attempt === null || seen.sending.attempt !== attempt) return null;
  return seen.sentBackAttempts.has(attempt) ? null : attempt;
};

/**
 * Runs the project's commands in a fresh checkout of the pull request's head merged with the base
 * tip, and decides from their exit codes alone. `ctx.project` must be the base branch's config: a
 * pull request must not edit its own gate. `gate-passed <sha> <n>` is written before anything is
 * marked ready and `state_changed` last, so a call after an error resumes without rerunning.
 */
export const gate = (ctx: GateContext, run: RunId): Effect.Effect<GateStep, GateStepError> =>
  withLedger(ctx, run, (out) =>
    Effect.gen(function* () {
      if (asciiLower(run.repo) !== asciiLower(ctx.repo)) {
        return yield* new WrongRepoError({ run, repo: ctx.repo });
      }
      const seen = readProgress((yield* ledger(() => readRun(ctx.dataDir, run))).entries);
      const threadId = seen.threadId;
      const last = seen.lastPr;
      if (threadId === null || last === null || seen.finished) return NOT_READY;
      const issue = Number(run.issue);
      // Before anything is decided or written: a closed issue is a person's move, or the run's
      // own merged pull request, which ends the run here unless a recorded pass finishes it below.
      const { closing } = yield* closedIssue(ctx, run, seen);
      if (closing.kind === "persons-move") {
        yield* abandon(ctx, yield* out.open, run, seen, "gate");
        return { kind: "abandoned" } as const;
      }
      if (closing.kind === "own-merge" && seen.pass === null) {
        yield* endOwnMerge(ctx, yield* out.open, run, seen, "gate", closing.pull);
        return { kind: "ended" } as const;
      }
      const at = progressFrom("gate", seen, "triage");
      // A decision to give up that is already in the ledger stands, and is carried out without
      // asking T3 or git anything.
      if (seen.stuck !== null) {
        return yield* stuckWith(ctx, out, issue, at, "stuck-resumed", { reason: seen.stuck });
      }
      // `stop-run.sh` ended the run: no attempt starts, and the run goes `stuck` as stopped by
      // hand, its thread archived first.
      if (seen.stopRequested && at.state === "building") {
        return yield* stuckWith(ctx, out, issue, at, "stop-requested", { reason: STOPPED_BY_HAND });
      }
      // Every write is done: the run stays open while its pull request waits for a person.
      if (at.state === "pr-open") return { kind: "passed", pr: last.pr } as const;
      if (at.state !== "building") return NOT_READY;
      // The gate already passed: what is left is the rest of the transition. No checkout is
      // made, no command is run, and neither the session nor the pull request's binding is
      // looked at again; a pull request that is no longer open gets nothing posted on it.
      if (seen.pass !== null) {
        if (checksWanted(ctx, seen, seen.pass.sha)) {
          return yield* awaitChecks(ctx, out, run, seen, at, seen.pass, { threadId, pr: last.pr });
        }
        const pull = yield* ctx.tracker.pullRequest(last.pr);
        const stillOpen = pull !== null && pull.open;
        return yield* finishPass(ctx, out, issue, at, seen.pass, last.pr, stillOpen);
      }
      return yield* gateAttempts(
        ctx,
        out,
        run,
        seen,
        at,
        buildingMode(ctx, out, run, seen, at, {
          threadId,
          pr: last.pr,
          prUrl: last.url,
        }),
      );
    }),
  );

/**
 * What `gate` and `regate` each supply around `gateAttempts`. A `building` run's pull request
 * has a session the gate waits for and sends failures to. A ready pull request (`regate`) has
 * none: any branch is its own, merged or closed ends the run, a failure starts a new session,
 * and its pass waits for the required checks on the new head.
 */
interface GateMode {
  readonly pr: number;
  readonly prUrl: string;
  /** The cause reason of the `gate-passed` step: `GATE_PASSED_CLEAN` for a re-gate pass with nothing to set again (`Seen.regatePassReassert`), else `GATE_PASSED`. */
  readonly passReason: string;
  /**
   * What the mode reads before the attempt `first`, and, for a building run, how it recovers an
   * owed send (`gate-sending` with no `gate_sent_back`). A ready pull request's owed send is
   * `regate`'s to recover (`owedRegateSend`). Answers with the attempt's steps, or `not-ready`
   * while the session is busy, or `stuck` when its thread is gone.
   */
  readonly begin: (
    first: number,
    owed: Seen["sending"],
  ) => Effect.Effect<AttemptSteps | GateStep, GateStepError>;
}

/**
 * The steps of one attempt that depend on what is gated. Each is read from the mode's own
 * fields: the session's run and branch for a building run, the pull request's branch for a ready
 * one. A step's answer is a `GateStep` when the gate is done with the attempt; `GateStep` has
 * `kind` and neither `AttemptSteps` nor `PullRequest` does, which is how `gateAttempts` tells.
 */
interface AttemptSteps {
  /** The attempt the gate runs under: one more than `first` when the mode found that one used. */
  readonly attempt: number;
  /**
   * Binds the pull request to the run as the mode sees it, and answers the pull request to gate.
   * A building run's pull request must be the session's own on its branch, and a draft when
   * `mustBeDraft` (before the commands run, not after); one that is gone is `stuck`. A ready pull
   * request a person merged or closed is `ended`, and binds whichever branch it is on.
   */
  readonly bind: (
    pull: PullRequest | null,
    mustBeDraft: boolean,
  ) => Effect.Effect<PullRequest | GateStep, GateStepError>;
  /** Notes once, for a building run, that someone took its pull request out of draft while the commands ran. */
  readonly noteReadyOutside: (pull: PullRequest) => Effect.Effect<void, GateStepError>;
  /** The rest of a recorded pass on `pull`, read after the commands: open, and at the gated commit. */
  readonly passed: (pass: PassRecord, pull: PullRequest) => Effect.Effect<GateStep, GateStepError>;
  /**
   * Before a failure is counted: a building run's pull request someone took out of draft goes back
   * to draft, and the step when that cannot be done. Null to go on.
   */
  readonly beforeFailure: () => Effect.Effect<GateStep | null, GateStepError>;
  /** A failure with a retry left: into the session, or a new session from `pull`'s branch. */
  readonly failed: (pull: PullRequest, text: string) => Effect.Effect<GateStep, GateStepError>;
}

/**
 * `gateAttempts` for a `building` run's pull request, which the session `threadId` opened: the
 * gate waits for the session to have finished a run, binds the pull request to its branch, and
 * sends a failure back into it under that run's ordinal.
 */
const buildingMode = (
  ctx: GateContext,
  out: Out,
  run: RunId,
  seen: Seen,
  at: Progress,
  gating: {
    readonly threadId: string;
    readonly pr: number;
    readonly prUrl: string;
  },
): GateMode => {
  const { threadId, pr, prUrl } = gating;
  const issue = Number(run.issue);
  const stuck = (code: string, stop: Stop) => stuckWith(ctx, out, issue, at, code, stop);
  return {
    pr,
    prUrl,
    passReason: GATE_PASSED,
    begin: Effect.fn("RunnerGating.begin")(function* (first, owed) {
      // The thread, read first, to wait for the session.
      const status = yield* threadStatus(ctx, threadId);
      if (status === null) return yield* stuck("thread-gone", stopOf(THREAD_GONE, null));
      // A newer run is visible: the send did reach the session, so the attempt is used. Record
      // that at once, and gate afresh as the next attempt once the run has ended.
      const attempt =
        owed !== null && (yield* recoverSend(out, first, owed, status)) ? first + 1 : first;
      // Wait for the session to have finished a run to gate, which has an ordinal.
      if (sessionBusy(seen, status)) return NOT_READY;
      const ordinal = status.runOrdinal;
      if (ordinal === null) return NOT_READY;
      const message = status.lastAssistantMessage;
      const branch = status.branch;
      // What `advance` bound the pull request with: the gate binds it the same way.
      const earlier = withBoundBranches(yield* earlierAttempts(ctx, run), seen);
      return {
        attempt,
        bind: (pull, mustBeDraft) => {
          const unbound = checkBinding(
            pull,
            pr,
            ctx.project.base,
            branch,
            mustBeDraft,
            seen.resumedFrom,
            status.worktreePath,
            earlier,
          );
          if (unbound !== null || pull === null) {
            return stuckUnbound(
              ctx,
              out,
              issue,
              at,
              message,
              unbound ?? { public: `the session reported PR #${pr} but it does not exist` },
            );
          }
          return Effect.succeed(pull);
        },
        // Said once for the run, with who did it when GitHub knows. A failed read only costs
        // the name. The pull request is not stuck: the factory was about to mark it ready itself.
        noteReadyOutside: (pull) =>
          pull.open && !pull.isDraft && !seen.readyOutside
            ? Effect.gen(function* () {
                const by = yield* ctx.tracker.readyBy(pr).pipe(Effect.orElseSucceed(() => null));
                yield* append(
                  out,
                  { event: "pr_ready_outside", data: { pr, ...(by !== null && { by }) } },
                  "gate",
                  "pr-ready-outside",
                  { attempt },
                );
              })
            : Effect.void,
        passed: (pass) => {
          const unread = withoutCheckReads(seen);
          if (checksWanted(ctx, unread, pass.sha)) {
            return awaitChecks(ctx, out, run, unread, at, pass, { threadId, pr });
          }
          return finishPass(ctx, out, issue, at, pass, pr, true);
        },
        beforeFailure: Effect.fn("RunnerGating.beforeFailure")(function* () {
          const pullNow = yield* ctx.tracker.pullRequest(pr);
          return yield* backToDraft(ctx, out, pr, pullNow, stuck, message);
        }),
        // The session the failure goes to, which the gate has read: the run it was gated on.
        failed: (_pull, text) =>
          sendBack(ctx, out, run, seen, at, attempt, ordinal, text, "gate-failed"),
      };
    }),
  };
};

/**
 * `gateAttempts` for a pull request that is ready for review (`regate`). With `reassert`, a stuck
 * decision an earlier call did not finish may have drafted the pull request or relabelled the
 * issue, so a pass sets the ready state again, and is recorded as owing that (`GATE_PASSED`) in
 * case it is finished by a later call. Without it the pass is recorded as `GATE_PASSED_CLEAN`.
 */
const readyMode = (
  ctx: GateContext,
  out: Out,
  run: RunId,
  seen: Seen,
  at: Progress,
  gating: {
    readonly reassert: boolean;
    readonly pr: number;
    readonly prUrl: string;
  },
): GateMode => {
  const { reassert, pr, prUrl } = gating;
  const issue = Number(run.issue);
  // A ready pull request that a person merged or closed is done with, and not stuck.
  const ended = Effect.fn("RunnerGating.ended")(function* (pull: PullRequest | null) {
    yield* endRun(ctx, yield* out.open, at, prUrl, pull, "gate");
    return { kind: "ended" } as const;
  });
  return {
    pr,
    prUrl,
    passReason: reassert ? GATE_PASSED : GATE_PASSED_CLEAN,
    // A re-gate does not depend on the session, which has been stopped since the pass: a failure
    // starts a new one (`relaunchFailedRegate`). One whose launch is recorded and whose send is
    // not was finished by `regate` before this attempt; one whose launch is not recorded is run
    // again, and launches under the same command id. Nothing is read before the attempt.
    begin: (attempt) =>
      Effect.succeed<AttemptSteps>({
        attempt,
        // A pull request's branch does not change, so a re-gate binds whichever it is.
        bind: (pull) => {
          if (pull === null || !pull.open) return ended(pull);
          const unbound = checkBinding(
            pull,
            pr,
            ctx.project.base,
            pull.headRef,
            false,
            seen.resumedFrom,
          );
          if (unbound !== null) return stuckUnbound(ctx, out, issue, at, null, unbound);
          return Effect.succeed(pull);
        },
        noteReadyOutside: () => Effect.void,
        // A ready pull request stays ready; the results are posted again once the required
        // checks, when the project names any, have passed on the new head. A read of the checks
        // in `seen` was about an earlier pass on another commit, which the sha comparisons
        // inside already discount.
        passed: (pass, pull) =>
          checksWanted(ctx, seen, pass.sha)
            ? awaitRegateChecks(ctx, out, run, seen, at, pass, pull, {
                pr,
                prUrl,
                reassert,
              })
            : finishRegatePass(ctx, out, issue, at, pass, pr, reassert),
        beforeFailure: () => Effect.succeed(null),
        // No session to send the failure to: its worktree was removed at the pass.
        failed: (pull, text) =>
          relaunchFailedRegate(
            ctx,
            out,
            run,
            seen,
            at,
            { pr, prUrl, pull },
            {
              attempt,
              message: text,
            },
          ),
      }),
  };
};

/**
 * The gate's run on one pull request, from what the mode reads first to the decision: the
 * attempt, and what follows a pass or a failure. `gate` and `regate` call it with their mode
 * (`GateMode`).
 */
const gateAttempts = Effect.fn("RunnerGating.gateAttempts")(function* (
  ctx: GateContext,
  out: Out,
  run: RunId,
  seen: Seen,
  at: Progress,
  mode: GateMode,
) {
  const { pr, prUrl } = mode;
  const issue = Number(run.issue);
  const stuck = (code: string, stop: Stop) => stuckWith(ctx, out, issue, at, code, stop);

  // An attempt that was sent (the `gate-sending` step is in the ledger) whose `gate_sent_back`
  // is missing is the mode's to recover.
  const first = nextGateAttempt(seen);
  const begun = yield* mode.begin(first, owedSend(seen, first));
  if ("kind" in begun) return begun;
  const steps = begun;
  const { attempt } = steps;

  const bound = yield* steps.bind(yield* ctx.tracker.pullRequest(pr), true);
  if ("kind" in bound) return bound;
  const pull = bound;
  // The session's own pull request that a person merged or closed before the gate could run:
  // nothing is left to gate, and nothing is marked ready.
  if (!pull.open) {
    yield* endRun(ctx, yield* out.open, at, prUrl, pull, "gate");
    return { kind: "ended" } as const;
  }
  // The commit the gate is about is the one the pull request holds now, and it is a commit
  // id: the decision that it passed names it.
  const head = pull.headSha.toLowerCase();
  if (!isCommitId(head)) {
    return yield* new WorkspaceUnexpectedError({
      what: "the pull request's head is not a commit id",
    });
  }
  if (ctx.project.gate.length === 0) return yield* new NoGateCommandsError({ repo: ctx.repo });

  /**
   * A failed attempt: `text` for the session, `why` for the public stuck line. A pull request
   * someone took out of draft goes back first. Every attempt since the last pass failed;
   * `gate_retries` of them may go back into the session, and the one after that is the end.
   */
  const failed = Effect.fn("RunnerGating.attemptFailed")(function* (text: string, why: string) {
    const drafted = yield* steps.beforeFailure();
    if (drafted !== null) return drafted;
    const since = attemptsSincePass(seen, attempt);
    if (since > ctx.project.limits.gateRetries) {
      const failedAfter = `the gate failed after ${attempts(since)}`;
      // The conflicted paths and the command output are text from the session's repo, and
      // output can hold what a command printed from its environment: the public comment gets
      // the factory's fixed line, and the ledger and the caller the whole message. Command
      // output ends with the error, so a long one is cut from the front.
      return yield* stuck("gate-retries-used-up", {
        reason: `${failedAfter}: ${why}`,
        detail: `${failedAfter}\n\n${prepareOutputTail(text)}`,
      });
    }
    return yield* steps.failed(pull, text);
  });
  const conflictWhy = `the branch conflicts with the base branch ${sanitize(ctx.project.base, false)}`;

  // GitHub already says the head conflicts with the base: the attempt is a conflict, recorded
  // with the line the gate's own merge writes, and no checkout or gate slot is taken for it.
  // GitHub names no paths; the session sees them when it merges the base itself.
  if (pull.mergeable === "conflicting") {
    yield* append(
      out,
      {
        event: "gate_command",
        data: { attempt, command: MERGE_COMMAND, exit_code: 1, duration_ms: 0 },
      },
      "gate",
      "gate-merge-conflict",
      { attempt },
    );
    return yield* failed(mergeConflictMessage(ctx.project.base, []), conflictWhy);
  }

  // The commit the head is merged with is the tip the base branch has now. The pass is recorded
  // against it, and a base that moves while the commands run does not undo the pass: only a
  // moved head does, and a conflict with the newer base is the pull request's `mergeable`.
  const baseSha = (yield* ctx.tracker.branchTip(ctx.project.base)).toLowerCase();
  const ran = yield* ctx.gate.run({
    dataDir: ctx.dataDir,
    run,
    attempt,
    repo: ctx.repo,
    head,
    base: baseSha,
    provision: ctx.project.provision,
    gate: ctx.project.gate,
    maxConcurrentGates: ctx.maxConcurrentGates,
    // The thread's workspace shows the attempt's log while the commands run.
    ...(seen.threadId !== null && {
      onStart: ctx.sessions.showGateLog(seen.threadId, attempt, gateLogPath(ctx.dataDir, run, attempt)),
    }),
    ...(ctx.gateOptions !== undefined && { options: ctx.gateOptions }),
  });
  if (ran._tag === "running") return { kind: "running" } as const;
  if (ran._tag === "queued") {
    return { kind: "queued", running: ran.running, max: ran.max } as const;
  }
  // The attempt's lines are in the ledger: where it ran, then every command that ran, or
  // the conflict line that counts it.
  if (ran._tag === "pass") {
    // The commands can run for a long time. The pull request must still be the run's own,
    // whole, and still at the commit that was gated, before anything is marked ready.
    const boundNow = yield* steps.bind(yield* ctx.tracker.pullRequest(pr), false);
    if ("kind" in boundNow) return boundNow;
    const pullNow = boundNow;
    // One a person closed without a merge while the commands ran is a decision against the
    // work: the run ends, and the commands' pass is not recorded. One that was merged has
    // its pass recorded first, when it is a pass on the commit that was merged.
    const merged = !pullNow.open && pullNow.merged;
    if (!pullNow.open && !merged) {
      yield* endRun(ctx, yield* out.open, at, prUrl, pullNow, "gate");
      return { kind: "ended" } as const;
    }
    if (pullNow.headSha.toLowerCase() !== head) return NOT_READY;
    // The issue text is looked at again before the pass is recorded. It does not matter to a
    // merged pull request: nothing moves under it.
    if (!merged) {
      const why = yield* textStop(ctx, issue, seen);
      if (why !== null) return yield* stuck(why.code, { reason: why.reason });
    }
    yield* steps.noteReadyOutside(pullNow);
    // Record the decision before anything is marked ready: a call that dies after
    // `gh pr ready` must not look at a draft that is gone.
    yield* append(
      out,
      { event: "step_changed", data: { step: `${GATE_PASSED} ${head} ${ran.gateCount}` } },
      "gate",
      mode.passReason,
      { attempt },
    );
    const pass: PassRecord = {
      attempt,
      sha: head,
      baseSha,
      atMs: ctx.clock(),
      lines: ran.commands.map((result) => ({
        attempt,
        command: result.command,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
      })),
      count: ran.gateCount,
    };
    // An earlier pass's results can be on the pull request; these are new.
    at.gateResultsPosted = false;
    if (merged) {
      yield* finishPass(ctx, out, issue, at, pass, pr, false);
      yield* endRun(ctx, yield* out.open, at, prUrl, pullNow, "gate");
      return { kind: "ended" } as const;
    }
    return yield* steps.passed(pass, pullNow);
  }

  return yield* ran._tag === "conflict"
    ? failed(mergeConflictMessage(ctx.project.base, ran.paths), conflictWhy)
    : failed(
        failureMessage(ran.failure),
        `${commandCode(ran.failure.command)} failed (${howItEnded(ran.failure)})`,
      );
});

/**
 * The rest of a passing gate on an already-ready pull request: a new comment with the results
 * and the head and base they ran against. With `reassert`, a resumed call may have left a
 * failure or stuck decision half done on GitHub, so the ready state is set again (repeatable).
 * Otherwise a draft or assignment a person made meanwhile stands.
 */
const finishRegatePass = Effect.fn("RunnerGating.finishRegatePass")(function* (
  ctx: GateContext,
  out: Out,
  issue: number,
  at: Progress,
  pass: PassRecord,
  pr: number,
  reassert: boolean,
) {
  const comment = regateResultsComment(resultsOf(pass), pass.attempt, pass.sha, pass.baseSha);
  const actions: ReadonlyArray<Action> = reassert
    ? [
        { kind: "mark-pr-ready", pr },
        { kind: "assign-to-machine" },
        { kind: "set-label", state: "pr-open" },
        { kind: "update-status-comment" },
        // Last: the step it writes says the pass is complete, so a call cut short before it
        // finds the pass recorded and does the re-assertions again.
        { kind: "post-gate-results", pr },
      ]
    : [{ kind: "post-gate-results", pr }];
  yield* applyActions(ctx, issue, yield* out.open, at, actions, makeCause("gate", "gate-passed"), {
    comment,
  });
  return { kind: "passed", pr } as const;
});

/**
 * A failed re-gate whose failure the new session already has (the ledger says it was sent back,
 * with ordinal 0): what is left of the transition, without sending again. The pull request goes
 * back to draft, the issue is assigned and labelled `building` again, and the state change, which
 * comes last, commits it.
 */
const finishRegateFailure = Effect.fn("RunnerGating.finishRegateFailure")(function* (
  ctx: GateContext,
  out: Out,
  issue: number,
  at: Progress,
  pr: number,
  attempt: number,
) {
  const failed = yield* Effect.fromResult(
    transition("pr-open", { kind: "regate-failed", pr, output: "" }),
  );
  const actions = failed.actions.filter((action) => action.kind !== "send-gate-failure");
  yield* applyActions(ctx, issue, yield* out.open, at, actions, makeCause("gate", "gate-failed"));
  return { kind: "sent-back", attempt } as const;
});

/**
 * A failed re-gate of a ready pull request: its session was stopped at the pass, so a new one
 * launches from the branch tip on `origin` (`relaunchSession`) with the failure in its first
 * message, using one attempt. From the `regate_relaunching` line the failure is decided and
 * `regate` goes to `resumeRelaunch` first. A branch unsafe for `git push` goes `stuck` first.
 */
const relaunchForRegate = Effect.fn("RunnerGating.relaunchForRegate")(function* (
  ctx: GateContext,
  out: Out,
  issue: number,
  at: Progress,
  run: RunId,
  pull: { readonly pr: number; readonly prUrl: string; readonly branch: string },
  failure: { readonly attempt: number; readonly message: string },
) {
  const refused = branchRefused(pull.branch);
  if (refused !== null) return yield* stuckWith(ctx, out, issue, at, "launch-failed", refused);
  // Reads first: a failing read is an error with nothing written.
  const detail = yield* ctx.tracker.issue(issue);
  const opened = yield* out.open;
  yield* stopSession(ctx, opened, at);
  const relaunch: Relaunch = {
    fixes: { kind: "regate", attempt: failure.attempt },
    branch: pull.branch,
    message: failure.message,
  };
  yield* ledger(() =>
    opened.append(
      {
        event: "regate_relaunching",
        data: { attempt: failure.attempt, branch: relaunch.branch, message: relaunch.message },
      },
      makeCause("gate", "gate-sending", { attempt: failure.attempt }),
    ),
  );
  return yield* launchForRegate(
    ctx,
    out,
    issue,
    at,
    run,
    { pr: pull.pr, prUrl: pull.prUrl, earlierCall: false },
    detail,
    relaunch,
  );
});

/**
 * Finishes a relaunch an earlier call decided (`regate_relaunching` with no `session_launched`
 * after it) before anything else is read: the launch is resent under the same command id, so
 * T3 answers with the thread it made. The gate is not rerun and the pull request is not read;
 * the next pass judges merges, closes and text changes. A failing T3 call writes nothing.
 */
const resumeRelaunch = Effect.fn("RunnerGating.resumeRelaunch")(function* (
  ctx: GateContext,
  out: Out,
  issue: number,
  at: Progress,
  run: RunId,
  pull: { readonly pr: number; readonly prUrl: string },
  relaunch: Relaunch,
) {
  const detail = yield* ctx.tracker.issue(issue);
  return yield* launchForRegate(
    ctx,
    out,
    issue,
    at,
    run,
    { ...pull, earlierCall: true },
    detail,
    relaunch,
  );
});

/**
 * The launch of a decided relaunch and what follows it: `relaunchSession`, then the
 * `gate_sent_back` line (ordinal 0) and the rest of the transition. `earlierCall` says an earlier
 * call reached this point.
 */
const launchForRegate = Effect.fn("RunnerGating.launchForRegate")(function* (
  ctx: GateContext,
  out: Out,
  issue: number,
  at: Progress,
  run: RunId,
  from: { readonly pr: number; readonly prUrl: string; readonly earlierCall: boolean },
  detail: IssueDetail,
  relaunch: Relaunch,
) {
  // Only a re-gate relaunch comes here; a feedback one is the feedback step's.
  const attempt = regateAttempt(relaunch);
  if (attempt === null) return NOT_READY;
  const opened = yield* out.open;
  const launched = yield* relaunchSession(ctx, opened, at, run, from, detail, relaunch);
  if (launched.kind === "stuck") return { kind: "stuck", reason: launched.reason } as const;
  yield* append(
    out,
    { event: "gate_sent_back", data: { attempt, run_ordinal: 0 } },
    "gate",
    "gate-failed",
    { attempt },
  );
  return yield* finishRegateFailure(ctx, out, issue, at, from.pr, attempt);
});

/** What `regate` did, and what started it, for the run's line. */
export interface Regated {
  readonly step: GateStep;
  readonly moved: Moved | null;
}

/**
 * Removes the checkouts of this run that are still on disk: an earlier call died between making
 * one and removing it. One gate runs at a time for a run, so every one is a leftover. A checkout
 * that cannot be removed is noted in the ledger, once for each directory (unless the run is
 * finished, which takes no more lines), and is tried again by the next call.
 */
const removeLeftovers = Effect.fn("RunnerGating.removeLeftovers")(function* (
  ctx: GateContext,
  out: Out,
  run: RunId,
  seen: Seen,
) {
  const root = yield* ledger(() => gateRoot(ctx.dataDir, run));
  yield* removeLeftoverCheckouts(root, (dir, error) =>
    seen.finished || seen.cleanupFailed.has(dir)
      ? Effect.void
      : append(
          out,
          { event: "gate_cleanup_failed", data: { dir, error } },
          "gate",
          "gate-cleanup-failed",
        ),
  );
  yield* removeEmptyGateRoot(root);
});

/**
 * Whether a pull request's `head` is the one a recorded pass ran on: `regate` answers `unchanged`
 * when it is, and the pass starts no gate. The base branch is not compared, so a pass stays valid
 * while the base moves; a conflict with it is the pull request's `mergeable` state, which the
 * callers check. A pass with no head recorded never is.
 */
export const unchangedSince = (passedHead: string, head: string): boolean =>
  passedHead !== "" && head.toLowerCase() === passedHead.toLowerCase();

/**
 * The pull request of a `pr-open` run and the head its last recorded pass ran on, for the pass
 * to compare with GitHub before it starts the gate (see `lastPass`).
 */
export interface LastPass {
  readonly pr: number;
  /** The head the pass ran on. */
  readonly head: string;
}

/**
 * What `regate` does first for a run, read from its ledger alone: nothing (`not-ready`), the
 * recorded stuck decision, a decided relaunch, a re-gate an earlier call began (`resume`), or
 * the comparison with the last pass (`compare`). `lastPass` answers only for `compare`, so a
 * state one of them resumes is never one the other skips.
 */
type RegateEntry =
  | { readonly kind: "not-ready" }
  | { readonly kind: "stuck"; readonly reason: string }
  | { readonly kind: "relaunch"; readonly relaunch: Relaunch }
  | { readonly kind: "resume" }
  | { readonly kind: "compare" };

const regateEntry = (seen: Seen): RegateEntry => {
  if (seen.threadId === null || seen.lastPr === null || seen.finished) return { kind: "not-ready" };
  if (seen.stuck !== null) return { kind: "stuck", reason: seen.stuck };
  if (seen.state !== "pr-open") return { kind: "not-ready" };
  if (seen.relaunch !== null && regateAttempt(seen.relaunch) === null) return { kind: "not-ready" };
  const pending = pendingRelaunch(seen);
  if (pending !== null) return { kind: "relaunch", relaunch: pending };
  if (seen.regating) return { kind: "resume" };
  return { kind: "compare" };
};

/**
 * What `regate` compares the pull request with, when that comparison is the
 * first thing it would do for the run (`regateEntry` says `compare`), its worktree line is
 * written and no checkout of an earlier gate is left on disk. `null` for any other run, which is
 * left to the gate. Reads the ledger and the run's gate directory only.
 */
export const lastPass = (
  dataDir: string,
  run: RunId,
): Effect.Effect<LastPass | null, LedgerError> =>
  ledger(() => {
    const seen = readProgress(readRun(dataDir, run).entries);
    if (regateEntry(seen).kind !== "compare" || seen.lastPr === null || seen.pass === null) {
      return null;
    }
    if (!seen.worktreeDone || leftoverCheckouts(dataDir, run).length > 0) return null;
    return { pr: seen.lastPr.pr, head: seen.pass.sha };
  });

/**
 * Gates a ready pull request again when its head moved or GitHub says it conflicts (a base move
 * alone does not), and ends the run when it was merged or closed. A quiet pass costs one API read.
 * A failure relaunches a session (`relaunchForRegate`); `gate_retries` counts failures since the
 * last pass. Safe to repeat: each ledger line follows its GitHub call, `state_changed` is last.
 */
export const regate = (ctx: GateContext, run: RunId): Effect.Effect<Regated, GateStepError> =>
  withLedger(ctx, run, (out) =>
    Effect.gen(function* () {
      if (asciiLower(run.repo) !== asciiLower(ctx.repo)) {
        return yield* new WrongRepoError({ run, repo: ctx.repo });
      }
      const seen = readProgress((yield* ledger(() => readRun(ctx.dataDir, run))).entries);
      yield* removeLeftovers(ctx, out, run, seen);
      const entry = regateEntry(seen);
      const last = seen.lastPr;
      if (entry.kind === "not-ready" || last === null) return { step: NOT_READY, moved: null };
      const issue = Number(run.issue);
      const at = progressFrom("gate", seen, "triage");
      if (entry.kind === "stuck") {
        const step = yield* stuckWith(ctx, out, issue, at, "stuck-resumed", {
          reason: entry.reason,
        });
        return { step, moved: null };
      }
      // A relaunch that an earlier call decided comes first, whatever the pull request, the
      // issue or the base look like now: the thread it made is on no run until it is finished.
      if (entry.kind === "relaunch") {
        const step = yield* resumeRelaunch(
          ctx,
          out,
          issue,
          at,
          run,
          { pr: last.pr, prUrl: last.url },
          entry.relaunch,
        );
        return { step, moved: seen.regateMoved };
      }
      // The pull request, when a resumed re-gate read it and found its head moved on from the
      // pass whose checks were still to be decided: compared and gated below as a push is.
      let movedOn: PullRequest | null = null;
      if (entry.kind === "resume") {
        // A re-gate that an earlier call began. Its failure's session is launched and the send
        // is not recorded; or its pass is recorded and the results are not posted yet; or its
        // failure is recorded as sent and the transition is not committed; or it is to be run
        // again, under the same attempt number.
        const owed = owedRegateSend(seen);
        if (owed !== null) {
          yield* append(
            out,
            { event: "gate_sent_back", data: { attempt: owed, run_ordinal: 0 } },
            "gate",
            "gate-send-recovered",
            { attempt: owed },
          );
          const step = yield* finishRegateFailure(ctx, out, issue, at, last.pr, owed);
          return { step, moved: seen.regateMoved };
        }
        if (seen.regatePassed && seen.pass !== null) {
          const pull = yield* ctx.tracker.pullRequest(last.pr);
          if (pull === null || !pull.open) {
            yield* endRun(ctx, yield* out.open, at, last.url, pull, "gate");
            return { step: { kind: "ended" }, moved: null };
          }
          const pass = seen.pass;
          // Only a pass not recorded clean can have a cut-short stuck path before it to repair
          // (`Seen.regatePassReassert`).
          const reassert = seen.regatePassReassert;
          if (!checksWanted(ctx, seen, pass.sha)) {
            const step = yield* finishRegatePass(ctx, out, issue, at, pass, last.pr, reassert);
            return { step, moved: seen.regateMoved };
          }
          // A read on record for this pass is a decision (`recordedChecks`): a wait that ran out,
          // or a failure, whose retries may be used up. The call that wrote it may have drafted
          // the pull request on a stuck path before it died, so it is finished whatever the head
          // holds now, and only an undecided pass is left behind for the new head.
          if (pull.headSha.toLowerCase() !== pass.sha && recordedChecks(seen, pass.sha) === null) {
            // No check on another commit says anything about this pass, and nothing of it is
            // posted: the new head is what the pull request holds now.
            movedOn = pull;
          } else {
            // The wait spans passes: a person who closed the issue meanwhile has taken the work
            // over, as before any gate that is about to act.
            if ((yield* ctx.tracker.issue(issue)).closed) {
              yield* abandon(ctx, yield* out.open, run, seen, "gate");
              return { step: { kind: "abandoned" }, moved: null };
            }
            const step = yield* awaitRegateChecks(ctx, out, run, seen, at, pass, pull, {
              pr: last.pr,
              prUrl: last.url,
              reassert,
            });
            return { step, moved: seen.regateMoved };
          }
        }
        if (seen.regateSentBack && seen.sending !== null) {
          const step = yield* finishRegateFailure(
            ctx,
            out,
            issue,
            at,
            last.pr,
            seen.sending.attempt,
          );
          return { step, moved: seen.regateMoved };
        }
        if (movedOn === null) {
          // The pull request first, as before a re-gate: one merged or closed while the re-gate
          // ran ends the run, whoever closed the issue. Then a re-gate under way for an issue a
          // person closed is not run again.
          const pull = yield* ctx.tracker.pullRequest(last.pr);
          if (pull === null || !pull.open) {
            yield* endRun(ctx, yield* out.open, at, last.url, pull, "gate");
            return { step: { kind: "ended" }, moved: null };
          }
          if ((yield* ctx.tracker.issue(issue)).closed) {
            yield* abandon(ctx, yield* out.open, run, seen, "gate");
            return { step: { kind: "abandoned" }, moved: null };
          }
        }
      } else {
        // A run that reached `pr-open` before a pass removed worktrees still has its session and
        // its worktree: they go now, as the pass would have taken them, with nothing else
        // written. Once the worktree line is there this is never done again.
        if (!seen.worktreeDone) yield* stopSession(ctx, yield* out.open, at);
      }
      if (entry.kind === "compare" || movedOn !== null) {
        // The pull request first: a merge or a close is noticed at once, and a push to the
        // branch is a head the last pass did not see.
        const pull = movedOn ?? (yield* ctx.tracker.pullRequest(last.pr));
        if (pull === null || !pull.open) {
          yield* endRun(ctx, yield* out.open, at, last.url, pull, "gate");
          return { step: { kind: "ended" }, moved: null };
        }
        const head = pull.headSha.toLowerCase();
        const passedAgainst = seen.pass?.baseSha ?? "";
        // A pull request GitHub says conflicts is gated even when nothing moved: the gate
        // records the conflict without a checkout.
        if (pull.mergeable !== "conflicting" && unchangedSince(seen.pass?.sha ?? "", head)) {
          return { step: { kind: "unchanged" }, moved: null };
        }
        if (!isCommitId(head)) {
          return yield* new WorkspaceUnexpectedError({
            what: "the pull request's head is not a commit id",
          });
        }
        // Only a gate that is about to run asks: a person who closed the issue has taken the work
        // over, as for a run in any other state, and the pull request is left as it is (nothing
        // is written on GitHub). A merge by the run's own pull request was found above.
        if ((yield* ctx.tracker.issue(issue)).closed) {
          yield* abandon(ctx, yield* out.open, run, seen, "gate");
          return { step: { kind: "abandoned" }, moved: null };
        }
        const tip = (yield* ctx.tracker.branchTip(ctx.project.base)).toLowerCase();
        yield* append(
          out,
          {
            event: "gate_regate",
            data: {
              sha: head,
              base_sha: tip,
              previous_base_sha: passedAgainst,
              ...(pull.mergeable === "conflicting" && { conflict: true as const }),
            },
          },
          "gate",
          "gate-regated",
        );
      }
      const step = yield* gateAttempts(
        ctx,
        out,
        run,
        seen,
        at,
        readyMode(ctx, out, run, seen, at, {
          // A re-gate an earlier call began may have a cut-short stuck path to repair. A head
          // that moved on during the checks wait is gated fresh and repairs nothing, unless the
          // pass it leaves behind still owed that repair (`Seen.regatePassReassert`), which
          // carries over.
          reassert: entry.kind === "resume" && (movedOn === null || seen.regatePassReassert),
          pr: last.pr,
          prUrl: last.url,
        }),
      );
      // What moved is read from the ledger, not kept from above, so the live answer is the same
      // as the one a resumed call gives.
      const after = readProgress((yield* ledger(() => readRun(ctx.dataDir, run))).entries);
      return { step, moved: after.regateMoved };
    }),
  );
