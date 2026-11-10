// @effect-diagnostics nodeBuiltinImport:off - the time of the last read is a two-line file in the data dir that a failed write must not fail the step over.
/**
 * Instructor feedback on a `pr-open` run, ported from softfac's `runner/feedback.rs`: a review or
 * comment on the pull request, or on the issue, starts a new session on the pull request's
 * branch and the issue goes from `pr-open` to `building`. Each call reads the ledger first and
 * does only what it does not record, so calling again resumes whatever was left half done.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";

import { transition } from "../domain/lifecycle.ts";
import { ledgerCall as ledger } from "../ledger/errors.ts";
import type { Ledger } from "../ledger/ledger.ts";
import { makeCause } from "../ledger/events.ts";
import { readRun } from "../ledger/read.ts";
import { asciiLower, feedbackReadFile, type RunId } from "../ledger/runId.ts";
import { formatTs } from "../ledger/time.ts";
import { issueCommentFeedbackId, type BoundGitHub, type Feedback } from "../tracker/github.ts";
import { WrongRepoError, textStop, withLedger, type BuildingError, type Out } from "./building.ts";
import type { GateContext } from "./gating.ts";
import { feedbackMessage } from "./messages.ts";
import {
  committingFeedback,
  pendingRelaunch,
  readProgress,
  type Relaunch,
  type Seen,
} from "./progress.ts";
import { branchRefused, relaunchSession } from "./relaunch.ts";
import {
  abandon,
  applyActions,
  endRun,
  goStuck,
  progressFrom,
  recordedReason,
  stopSession,
  type Progress,
  type Stop,
} from "./run.ts";

/**
 * How far before the start of the last clean read the next read pages back. GitHub's clock can
 * differ from ours and a read can lag behind a write, so a review submitted just before that
 * start may not have been there to read. It costs at most one more page in a flood of reviews.
 */
const CLEAN_READ_MARGIN_MS = 60_000;

/** What the feedback step asks of the factory: what a re-gate asks, and the read of a pull request's feedback. */
export interface FeedbackContext extends GateContext {
  readonly tracker: GateContext["tracker"] & Pick<BoundGitHub, "prFeedback">;
  /** The machine's `feedback_seconds`: the least time between two reads of a run's feedback. */
  readonly feedbackSeconds: number;
}

export type FeedbackError = BuildingError;

/** What `feedback` did. */
export type FeedbackStep =
  /**
   * Nothing to do: the run is not waiting in `pr-open` (finished, stuck, no session or pull
   * request, or not in that state), a re-gate is the gate's to carry out, no read is due, or no
   * instructor wrote anything new.
   */
  | { readonly kind: "none" }
  /**
   * The feedback was sent. A new session works on the pull request's branch, the pull request is
   * a draft again and the issue is `building`; `items` is how many pieces of feedback the
   * session's first message carries.
   */
  | { readonly kind: "relaunched"; readonly pr: number; readonly items: number }
  /**
   * The issue went to `stuck`, with nothing sent: its text changed, the pull request's branch
   * cannot be passed to a session, or the launch was refused. `reason` is as the ledger records it.
   */
  | { readonly kind: "stuck"; readonly reason: string }
  /** The pull request was merged or closed, so the run is finished and the feedback is not sent. */
  | { readonly kind: "ended" }
  /** The issue is closed (see `abandon`). The run is finished and nothing was written on GitHub. */
  | { readonly kind: "abandoned" };

const NONE: FeedbackStep = { kind: "none" };

/**
 * Acts on feedback from `factory.instructors` on a `pr-open` run since its pull request last
 * passed the gate; call it every pass, before gating. Reads are at most every
 * `ctx.feedbackSeconds`, the time written first so a failing read waits too. An item the ledger
 * names by GitHub id (an edit keeps it) is never resent; the rest goes into one new session.
 */
export const feedback = (
  ctx: FeedbackContext,
  run: RunId,
): Effect.Effect<FeedbackStep, FeedbackError> =>
  withLedger(ctx, run, (out) =>
    Effect.gen(function* () {
      if (asciiLower(run.repo) !== asciiLower(ctx.repo)) {
        return yield* new WrongRepoError({ run, repo: ctx.repo });
      }
      const seen = readProgress((yield* ledger(() => readRun(ctx.dataDir, run))).entries);
      const last = seen.lastPr;
      if (seen.threadId === null || last === null) return NONE;
      if (seen.finished || seen.stuck !== null || seen.state !== "pr-open") return NONE;
      const issue = Number(run.issue);
      const at = progressFrom("forward", seen, "pr-open");
      const decided = yield* finishDecided(ctx, out, run, seen, at, last);
      if (decided !== null) return decided;
      // A re-gate is the gate's, and the feedback waits for it to settle.
      if (seen.prOpenSince === null || seen.relaunch !== null || seen.regating) return NONE;
      const started = readIsDue(ctx, run);
      if (started === null) return NONE;
      const items = yield* newFeedback(ctx, run, seen, last.pr, seen.prOpenSince);
      if (items.length === 0) {
        keepCleanRead(ctx, run, started);
        return NONE;
      }

      const pull = yield* ctx.tracker.pullRequest(last.pr);
      if (pull === null || !pull.open) {
        yield* endRun(ctx, yield* out.open, at, last.url, pull, at.step);
        return { kind: "ended" } as const;
      }
      const detail = yield* ctx.tracker.issue(issue);
      if (detail.closed) {
        yield* abandon(ctx, yield* out.open, run, seen, at.step);
        return { kind: "abandoned" } as const;
      }
      // The text the session would work on is checked as `watch` checks it.
      const why = yield* textStop(ctx, issue, seen);
      if (why !== null) {
        return yield* stuck(ctx, out, issue, at, why.code, { reason: why.reason });
      }
      const refused = branchRefused(pull.headRef);
      if (refused !== null) return yield* stuck(ctx, out, issue, at, "launch-failed", refused);

      const opened = yield* out.open;
      // A run that reached `pr-open` before a pass removed worktrees still has its session.
      if (!seen.worktreeDone) yield* stopSession(ctx, opened, at);
      const n = seen.feedbackRelaunches + 1;
      const relaunch: Relaunch = {
        fixes: { kind: "feedback", n },
        branch: pull.headRef,
        message: feedbackMessage(last.url, items),
      };
      yield* ledger(() =>
        opened.append(
          {
            event: "feedback_relaunching",
            data: {
              n,
              branch: relaunch.branch,
              items: items.map((item) => item.id),
              message: relaunch.message,
            },
          },
          makeCause(at.step, "instructor-feedback"),
        ),
      );
      const launched = yield* relaunchSession(
        ctx,
        opened,
        at,
        run,
        { prUrl: last.url, earlierCall: false },
        detail,
        relaunch,
      );
      if (launched.kind === "stuck") return { kind: "stuck", reason: launched.reason } as const;
      yield* commit(ctx, opened, issue, at, last.pr);
      return { kind: "relaunched", pr: last.pr, items: items.length } as const;
    }),
  );

/**
 * Finishes a feedback relaunch an earlier call decided, before anything else: the launch is
 * resent under the same command id, or only the state change is left. The feedback is not read
 * again nor the pull request and issue judged; the next pass does that. A failing T3 call is an
 * error with nothing written. `null` when the ledger holds no such relaunch.
 */
const finishDecided = Effect.fn("RunnerFeedback.finishDecided")(function* (
  ctx: FeedbackContext,
  out: Out,
  run: RunId,
  seen: Seen,
  at: Progress,
  last: { readonly pr: number; readonly url: string },
) {
  const issue = Number(run.issue);
  const relaunched = {
    kind: "relaunched",
    pr: last.pr,
    items: seen.feedbackLastItems,
  } as const;
  const pending = pendingRelaunch(seen);
  if (pending !== null && pending.fixes.kind === "feedback") {
    const opened = yield* out.open;
    const detail = yield* ctx.tracker.issue(issue);
    const launched = yield* relaunchSession(
      ctx,
      opened,
      at,
      run,
      { prUrl: last.url, earlierCall: true },
      detail,
      pending,
    );
    if (launched.kind === "stuck") return { kind: "stuck", reason: launched.reason } as const;
    yield* commit(ctx, opened, issue, at, last.pr);
    return relaunched;
  }
  if (committingFeedback(seen) !== null) {
    yield* commit(ctx, yield* out.open, issue, at, last.pr);
    return relaunched;
  }
  return null;
});

/** One line of the read-time file as a time, or `null` when it is not a canonical non-negative integer. */
const parseTime = (line: string | undefined): number | null => {
  const text = line?.trim();
  if (text === undefined || !/^(0|[1-9][0-9]*)$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
};

/**
 * The two times in `feedbackReadFile`: when the feedback was last read, and when the last read
 * that found nothing new started (epoch milliseconds). A missing or unreadable line is `null`.
 */
const readTimes = (
  ctx: FeedbackContext,
  run: RunId,
): { readonly last: number | null; readonly clean: number | null } => {
  let text = "";
  try {
    text = NodeFS.readFileSync(feedbackReadFile(ctx.dataDir, run), "utf8");
  } catch {
    // Missing or unreadable: the read is due.
  }
  const lines = text.split("\n");
  return { last: parseTime(lines[0]), clean: parseTime(lines[1]) };
};

/**
 * Writes the two times to `feedbackReadFile`. A file that cannot be written is dropped: the read
 * is then due on every pass, and reading too often is better than never reading.
 */
const writeReadTimes = (
  ctx: FeedbackContext,
  run: RunId,
  last: number,
  clean: number | null,
): void => {
  try {
    NodeFS.mkdirSync(NodePath.join(ctx.dataDir, "feedback"), { recursive: true });
    NodeFS.writeFileSync(
      feedbackReadFile(ctx.dataDir, run),
      clean === null ? `${last}` : `${last}\n${clean}`,
    );
  } catch {
    // See above.
  }
};

/**
 * The time of this read when the run's feedback is due to be read, which is recorded first (the
 * time of the last read that found nothing new stays as it was); `null` when it is not due.
 */
const readIsDue = (ctx: FeedbackContext, run: RunId): number | null => {
  const now = ctx.clock();
  const { last, clean } = readTimes(ctx, run);
  if (last !== null && now >= last && now - last < ctx.feedbackSeconds * 1000) return null;
  writeReadTimes(ctx, run, now, clean);
  return now;
};

/** Records that the read which started at `started` succeeded and found nothing new. */
const keepCleanRead = (ctx: FeedbackContext, run: RunId, started: number): void =>
  writeReadTimes(ctx, run, started, started);

/** One second before `ms`, as GitHub is asked for it: `YYYY-MM-DDTHH:MM:SSZ`. */
const secondBefore = (ms: number): string => `${formatTs(Math.max(0, ms - 1_000)).slice(0, 19)}Z`;

/**
 * The instructors' feedback new since `sinceMs` (when the run reached `pr-open`), less what the
 * ledger already names as relaunched, forwarded or dropped. Oldest first; the read starts one
 * second early so the pass's own second is not missed. A read that found nothing judged every
 * review after its floor, so the next one pages back only to its start, less a margin.
 */
const newFeedback = Effect.fn("RunnerFeedback.newFeedback")(function* (
  ctx: FeedbackContext,
  run: RunId,
  seen: Seen,
  pr: number,
  sinceMs: number,
) {
  const since = secondBefore(sinceMs);
  const { clean } = readTimes(ctx, run);
  const cleanFloor = Math.max(0, (clean ?? 0) - CLEAN_READ_MARGIN_MS);
  const floor = secondBefore(Math.max(sinceMs, cleanFloor));
  const instructors = ctx.project.instructors;
  const reviewed = yield* ctx.tracker.prFeedback(pr, since, floor, instructors);
  const activity = yield* ctx.tracker.activitySince(Number(run.issue), since, instructors);
  const fromIssue = activity.comments
    .filter((c) => !seen.forwarded.has(c.id) && !seen.dropped.has(c.id))
    .map((c): Feedback => ({
      id: issueCommentFeedbackId(c.id),
      author: c.author,
      kind: { kind: "issue-comment" },
      createdAt: c.createdAt,
      body: c.body,
      inline: [],
      inlineUnread: 0,
    }));
  return [...reviewed, ...fromIssue]
    .filter((item) => !seen.feedbackSent.has(item.id))
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
});

/**
 * The rest of the transition once the new session is recorded: the pull request goes back to
 * draft, the issue is assigned to the machine and labelled `building`, the status comment names
 * the new session, and the `state_changed` line, which commits it, comes last. Each call can be
 * made again after a crash.
 */
const commit = Effect.fn("RunnerFeedback.commit")(function* (
  ctx: FeedbackContext,
  opened: Ledger,
  issue: number,
  at: Progress,
  pr: number,
) {
  const moved = yield* Effect.fromResult(
    transition("pr-open", { kind: "instructor-feedback", pr }),
  );
  yield* applyActions(
    ctx,
    issue,
    opened,
    at,
    moved.actions,
    makeCause(at.step, "instructor-feedback"),
  );
});

/** The issue goes `stuck` for `stop`, and nothing is sent. */
const stuck = Effect.fn("RunnerFeedback.stuck")(function* (
  ctx: FeedbackContext,
  out: Out,
  issue: number,
  at: Progress,
  code: string,
  stop: Stop,
) {
  yield* goStuck(ctx, issue, yield* out.open, at, code, stop);
  return { kind: "stuck", reason: recordedReason(stop) } as const;
});
