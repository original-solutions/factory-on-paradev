/**
 * The steps that work a building run: `advance` moves the issue on once the session ends, `watch`
 * stops a run whose issue text a non-instructor edited, `forward` sends instructor feedback,
 * `timeLimit` enforces the time limit. Each step reads the ledger first and does only what it does
 * not record, so calling it again resumes. A tracker or T3 failure leaves nothing final written.
 */
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ProjectConfig } from "../config.ts";
import { rateLimitOf } from "../cooldown.ts";
import { transition } from "../domain/lifecycle.ts";
import {
  NO_MESSAGE,
  NO_RESULT_LINE,
  SAID_STUCK,
  parseSessionResult,
  type SessionResult,
} from "../domain/resultLine.ts";
import { LedgerIoError, ledgerCall as ledger, type LedgerError } from "../ledger/errors.ts";
import { makeCause, type CauseStep, type RunEvent } from "../ledger/events.ts";
import { Ledger } from "../ledger/ledger.ts";
import { readRuns } from "../ledger/listRuns.ts";
import { readRun } from "../ledger/read.ts";
import { asciiLower, runIdToString, runPath, type RunId } from "../ledger/runId.ts";
import { formatTs, parseTs } from "../ledger/time.ts";
import { isUtcSecond } from "../tracker/approvalHistory.ts";
import {
  GitHubParse,
  isPlainRefName,
  isSafeBranchName,
  issueCommentFeedbackId,
  type Activity,
  type BoundGitHub,
  type Dropped,
  type IssueDetail,
  type PullRequest,
} from "../tracker/github.ts";
import {
  MessageRejectedError,
  ThreadNotFoundError,
  isLaunchBranch,
  launchBranchOf,
  type FactorySessions,
  type Model,
  type RunStatus,
  type SessionsError,
  type ThreadStatus,
} from "../sessions.ts";
import {
  CANNOT_CONFIRM,
  CANNOT_VERIFY_DURING_BUILD,
  CHANGED_DURING_BUILD,
  INTERRUPTION_MESSAGE,
  RESULT_LINE_REMINDER,
  STOPPED_BY_HAND,
  THREAD_GONE,
  WRONG_ACCOUNT,
  WRONG_ACCOUNT_PREFIX,
  REFUSED_BODY_EDIT,
  bodyEditMessage,
  commentMessage,
  rateLimitedMessage,
  timeLimitReason,
  type CommentDropReason,
  droppedCommentMessage,
  prepareSessionText,
} from "./messages.ts";
import {
  BODY_EDIT_DROPPED,
  BODY_EDIT_FORWARDED,
  BODY_EDIT_REFUSED,
  COMMENT_DROPPED,
  COMMENT_REFUSED,
  FORWARD_WAIT,
  FORWARD_WAIT_CANCELLED,
  INTERRUPTION_SENT,
  RATE_LIMITED_SENT,
  RESULT_LINE_REMINDED,
  RESULT_LINE_REMINDING,
  readProgress,
  regateBranch,
  runNames,
  type Seen,
} from "./progress.ts";
import {
  abandon,
  applyActions,
  closedIssue,
  describe,
  endOwnMerge,
  endRun,
  finishBuilding,
  goStuck,
  progressFrom,
  recordedReason,
  stopSession,
  type Progress,
  type RunContext,
  type RunError,
  type Stop,
} from "./run.ts";
import {
  earlierRuns,
  isOwnPull,
  isResumablePull,
  previousRun,
  recordApproval,
  resume,
  type GateRunningError,
  type StartContext,
  type StartOutcome,
} from "./start.ts";

/** What the steps of a building run ask of the factory: the run's repo and project, the tracker and the sessions. */
export interface BuildingContext extends RunContext {
  /** `owner/name` as the machine config writes it. */
  readonly repo: string;
  readonly project: ProjectConfig;
  readonly dataDir: string;
  readonly tracker: Pick<
    BoundGitHub,
    | "setState"
    | "assign"
    | "unassign"
    | "postComment"
    | "upsertStatusComment"
    | "pullRequest"
    | "markPrReady"
    | "markPrDraft"
    | "commentOnPr"
    | "textCheck"
    | "activitySince"
    | "issue"
    | "closedBy"
    | "openPullRequestsOnHead"
  >;
  readonly sessions: Pick<
    FactorySessions["Service"],
    | "status"
    | "thread"
    | "send"
    | "archive"
    | "removeWorktree"
    | "worktreeCheckout"
    | "lastActivity"
  >;
  /** Unix epoch milliseconds. */
  readonly clock: () => number;
}

const RunRef = Schema.Struct({ repo: Schema.String, issue: Schema.String, attempt: Schema.Number });

/** The run has a `finished` line: it is not a building run any more. */
export class NotBuildingError extends Schema.TaggedError<NotBuildingError>()("NotBuildingError", {
  run: RunRef,
}) {
  override get message(): string {
    return `run ${runIdToString(this.run)} is already finished`;
  }
}

/** The run has no `session_launched` line: there is no session to read. */
export class NoSessionError extends Schema.TaggedError<NoSessionError>()("NoSessionError", {
  run: RunRef,
}) {
  override get message(): string {
    return `run ${runIdToString(this.run)} has no launched session`;
  }
}

/** The run is another repo's. */
export class WrongRepoError extends Schema.TaggedError<WrongRepoError>()("WrongRepoError", {
  run: RunRef,
  repo: Schema.String,
}) {
  override get message(): string {
    return `run ${runIdToString(this.run)} is not a run of ${this.repo}`;
  }
}

/** A relaunch that cannot be carried out: the run has no recorded approval. */
export class RelaunchUnsupportedError extends Schema.TaggedError<RelaunchUnsupportedError>()(
  "RelaunchUnsupportedError",
  { run: RunRef },
) {
  override get message(): string {
    return `run ${runIdToString(this.run)} cannot be relaunched: it has no recorded approval`;
  }
}

export type BuildingError =
  | RunError
  | GateRunningError
  | RelaunchUnsupportedError
  | NotBuildingError
  | NoSessionError
  | WrongRepoError
  | ThreadNotFoundError
  | MessageRejectedError;

/** What `advance` did. */
export type AdvanceOutcome =
  /** The session is working, or the factory waits for a run it asked for. Nothing was decided. */
  | { readonly kind: "running" }
  /** The run ended with no result line and the one reminder was sent (or is waited for). */
  | { readonly kind: "reminded" }
  /** A person stopped the session's run in T3: nothing is sent and the issue is not touched. */
  | { readonly kind: "paused" }
  /**
   * The session's draft pull request is bound to the run and waits for the gate. Also what
   * `advance` says when the ledger already records that the gate passed and the move to
   * `pr-open` is not finished: the gate finishes it.
   */
  | { readonly kind: "ready-for-gate"; readonly pr: number; readonly prUrl: string }
  /** The gate passed and everything is written. The run stays open while its pull request waits for a person. */
  | { readonly kind: "passed"; readonly pr: number }
  /** The pull request was merged or closed, or it was merged and closed the issue: the run is finished. Nothing was written on GitHub. */
  | { readonly kind: "ended" }
  /** A person closed the issue: the session's thread is archived and the run is finished. Nothing was written on GitHub. */
  | { readonly kind: "abandoned" }
  /** The session asked its questions: they are on the issue and the run is ended. */
  | { readonly kind: "needs-info" }
  /** The issue went to `stuck`. `reason` is the one the ledger records. */
  | { readonly kind: "stuck"; readonly reason: string }
  /**
   * The session's run ended `failed` or `cancelled` with no `FACTORY-DONE` line, or T3 no longer
   * has its thread. Nothing was written: the pass decides about these together (`interrupted`).
   */
  | { readonly kind: "ended-badly"; readonly what: BadEnd }
  /**
   * The session's run ended `failed` or `cancelled` on the provider's rate limit, at `endedMs`.
   * Nothing was written: the pass backs `model` (the session's) off and resumes the session once
   * the cooldown is over, or at once on a fallback (`resumeAfterCooldown`).
   */
  | {
      readonly kind: "rate-limited";
      readonly endedMs: number;
      readonly retryAfterMs: number | null;
      readonly model: Model | null;
    }
  /** A relaunch decided earlier was finished: the old run is over and `start` went on for the next attempt. */
  | { readonly kind: "relaunched"; readonly start: StartOutcome };

/** How a session ended badly, as `advance` says it. */
export type BadEnd = "failed" | "cancelled" | "thread-gone";

/**
 * What the pass knows when it decides about a session that ended badly: the newest T3 trouble in
 * the machine log within the last ten minutes, and how many sessions ended badly in the pass.
 */
export interface Evidence {
  /** The error text of a failed T3 preflight or an `error` of kind `t3` in that window. */
  readonly t3Error: string | null;
  /** How many runs `advance` said ended badly in this pass, this one included. */
  readonly endedInPass: number;
  /**
   * When T3 Code, this server, started, and the servers before it in the last day: the machine
   * log's `server_started` lines, oldest first. A restart ends every turn that was running as
   * `cancelled` and no call fails, so the log has no error: a run that was running when one of
   * these happened was cut off by it.
   */
  readonly t3Starts: ReadonlyArray<number>;
  /**
   * When those servers began shutting down, oldest first: the `server_stopping` lines of the
   * machine log that each start of the last day follows. A shutdown marks running turns
   * `cancelled`, so a run that ended between a stop and the next start was cut off by that restart.
   * A stop with no line (crash, power cut) has no entry; the start's grace stands in.
   */
  readonly t3Stops: ReadonlyArray<number>;
}

/** The `t3_error` recorded for a run a server start cut off. */
const t3Started = (ms: number): string =>
  `T3 Code started at ${DateTime.formatIso(DateTime.makeUnsafe(ms))}`;

/**
 * How long before a server start a run may have ended and still be the restart's doing: a
 * graceful stop (`launchctl`, `install.sh`) marks the running turn `cancelled` as the old process
 * shuts down, and the new one starts seconds to a minute or two later.
 */
const RESTART_GRACE_MS = 10 * 60 * 1000;

/**
 * The server start that cut the session's run off, or null: the run began before it and ended at or
 * after the stop that start follows, with the grace before either. A run cancelled while still
 * being prepared counts from its request. The stop is the newest `server_stopping` after the
 * previous start; a start with none uses its own time. The oldest matching start wins.
 */
const cutByRestart = (
  status: ThreadStatus,
  starts: ReadonlyArray<number>,
  stops: ReadonlyArray<number>,
): number | null => {
  const begun = status.runStartedAt;
  const ended = status.runCompletedAt;
  if (begun === null || ended === null) return null;
  let previous = Number.NEGATIVE_INFINITY;
  for (const at of starts) {
    const stop = stops.findLast((s) => s > previous && s < at) ?? at;
    if (begun < at && ended >= stop - RESTART_GRACE_MS) return at;
    previous = at;
  }
  return null;
};

/** What `interrupted` did. */
export type InterruptOutcome =
  /** The run is no longer one that ended badly (its thread has a newer run, say), or a relaunch is already decided. Nothing was written. */
  | { readonly kind: "unchanged"; readonly why: string }
  /** The session was sent one resume message in its thread and the run stays `building`. `resumes` of `limit` are used, this one included. */
  | {
      readonly kind: "resumed";
      readonly resumes: number;
      readonly limit: number;
      readonly status: "failed" | "cancelled";
    }
  /** The thread could not be resumed: the run is finished, and `start` went on for the next attempt, which continues from the run's branch. */
  | {
      readonly kind: "relaunched";
      readonly resumes: number;
      readonly limit: number;
      readonly start: StartOutcome;
    }
  /** Not an interruption, or the cap is used up: the issue went to `stuck`. `reason` is the one the ledger records. */
  | { readonly kind: "stuck"; readonly reason: string };

/**
 * What `interrupted` asks: the steps of a building run, and the claim's context to start the next
 * attempt with. `project` is the run's (its base is the one its launch recorded); `repoProject` is
 * the repo's, which the next attempt, a new run, starts with.
 */
export type InterruptContext = BuildingContext &
  StartContext & { readonly repoProject: ProjectConfig };

/** What `watch` did. */
export type WatchOutcome =
  /** The text is as the approval left it. Nothing was written. */
  | { readonly kind: "unchanged" }
  /** The run went to `stuck`. `reason` is the one the ledger records. */
  | { readonly kind: "stopped"; readonly reason: string }
  | {
      readonly kind: "skipped";
      readonly why:
        | "finished"
        | "relaunching"
        | "no-session"
        | "not-building"
        | "gate-passed"
        | "pr-merged";
    };

/** Why `forward` did nothing for a run. */
export type SkipReason =
  | "finished"
  /** A relaunch is decided: `advance` finishes it. */
  | "relaunching"
  | "no-session"
  | "not-building"
  /** A gate attempt is being sent into the session: a message sent now could be mistaken for the proof that it arrived. */
  | "gate-send-pending"
  /** A person closed the issue: the run is over. */
  | "abandoned"
  /** The run's own pull request was merged and closed the issue: `advance` ends it. */
  | "pr-merged"
  /** T3 no longer has the session's thread. */
  | "no-thread";

/**
 * What `forward` did: how many comments and whether the edited body went into the session. What T3
 * refused is left out of the counts.
 */
export interface ForwardOutcome {
  readonly comments: number;
  readonly bodyEdit: boolean;
  readonly skipped: SkipReason | null;
}

/** What `timeLimit` did. */
export type LimitOutcome =
  | { readonly kind: "within" }
  /** The run went to `stuck`. `reason` is the one the ledger records. */
  | { readonly kind: "stopped"; readonly reason: string }
  | {
      readonly kind: "skipped";
      readonly why:
        | "finished"
        | "relaunching"
        | "not-running"
        | "launch-unrecorded"
        | "pr-reported"
        | "pr-merged";
    };

const MINUTE_MS = 60_000;

const issueOf = (run: RunId) => Number(run.issue);

const checkRepo = (ctx: BuildingContext, run: RunId) =>
  asciiLower(run.repo) === asciiLower(ctx.repo)
    ? Effect.void
    : Effect.fail(new WrongRepoError({ run, repo: ctx.repo }));

const readSeen = (ctx: BuildingContext, run: RunId) =>
  ledger(() => readRun(ctx.dataDir, run)).pipe(
    Effect.map((record) => readProgress(record.entries)),
  );

/** The run file, opened for append the first time a step writes to it and closed when the step ends. */
export interface Out {
  readonly open: Effect.Effect<Ledger, LedgerError>;
  readonly close: () => void;
}

const lazyLedger = (ctx: BuildingContext, run: RunId): Out => {
  let handle: Ledger | null = null;
  return {
    open: ledger(() => (handle ??= Ledger.open(ctx.dataDir, run, { clock: ctx.clock }))),
    close: () => handle?.close(),
  };
};

export const withLedger = <A, E>(
  ctx: BuildingContext,
  run: RunId,
  body: (out: Out) => Effect.Effect<A, E>,
): Effect.Effect<A, E> =>
  Effect.suspend(() => {
    const out = lazyLedger(ctx, run);
    return body(out).pipe(Effect.ensuring(Effect.sync(out.close)));
  });

export const append = (
  out: Out,
  event: RunEvent,
  step: CauseStep,
  reason: string,
  extras: { readonly attempt?: number; readonly command?: string } = {},
) =>
  Effect.flatMap(out.open, (opened) =>
    ledger(() => opened.append(event, makeCause(step, reason, extras))),
  );

/** A stop with the session's text, prepared once and left out when empty. */
export const stopOf = (
  reason: string,
  sessionText: string | null | undefined,
  extra: { readonly detail?: string } = {},
): Stop => {
  const prepared =
    sessionText === null || sessionText === undefined ? "" : prepareSessionText(sessionText);
  return {
    reason,
    ...(extra.detail !== undefined && { detail: extra.detail }),
    ...(prepared !== "" && { sessionText: prepared }),
  };
};

/** Whether a run status is one the run ended badly with: not completed, and not stopped by a person. */
const isEndedBadly = (status: RunStatus): boolean =>
  status === "failed" || status === "cancelled" || status === "rolled_back";

/** Whether a run status is one the run has finished with. An active status is not. */
const isTerminal = (status: RunStatus): boolean =>
  status === "completed" || status === "interrupted" || isEndedBadly(status);

/**
 * The run's newest `session_interrupted` line is a relaunch: the pass decided to start the next
 * attempt, and `advance` finishes that whatever else is true of the run (a time limit, an edit of
 * the issue text), so nothing else may stop the run first and leave the next attempt's ledger
 * with nothing to start it.
 */
const relaunchDecided = (seen: Seen): boolean =>
  seen.interruption !== null && seen.interruption.relaunch;

/**
 * Whether the session's latest run ended badly, as of now: `failed`, `cancelled` or `rolled_back`,
 * nothing owed a newer run (see `sessionBusy`), and no `FACTORY-DONE` in its last message. `what`
 * is set when the pass may call it an interruption: `failed` or `cancelled` with an ordinal to wait
 * for a newer run by. A `rolled_back` run is a stop with no second look.
 */
const endedBadlyNow = (
  seen: Seen,
  status: ThreadStatus,
  result: SessionResult,
): { readonly name: string; readonly what: "failed" | "cancelled" | null } | null => {
  const run = status.run;
  if (run === null || sessionBusy(seen, status) || !isEndedBadly(run)) return null;
  if (result.kind === "done") return null;
  const what = run === "failed" || run === "cancelled" ? run : null;
  return { name: run, what: status.runOrdinal === null ? null : what };
};

/**
 * Whether the session ended without any result line: no message, or a last line that is none of
 * the three. A malformed `FACTORY-DONE`, or questions with no questions, is not this: the
 * session did write a result line.
 */
const lacksResultLine = (result: SessionResult): boolean =>
  result.kind === "stuck" && (result.reason === NO_MESSAGE || result.reason === NO_RESULT_LINE);

/**
 * Whether the session is still working: its latest run must have ended, and after the factory
 * asked for a newer run (the reminder), that run must be a newer one than the run the marker
 * names. A newer run is enough, whichever message started it.
 */
export const sessionBusy = (seen: Seen, status: ThreadStatus): boolean => {
  const ended = status.run !== null && isTerminal(status.run);
  const newer =
    seen.waitingAfter === null ||
    (status.runOrdinal !== null && status.runOrdinal > seen.waitingAfter);
  return !ended || !newer;
};

/** Whether the first non-empty line of what a stuck session said is the one the launch message asks for. */
const saysWrongAccount = (sessionText: string | undefined): boolean => {
  if (sessionText === undefined) return false;
  const first = sessionText
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "");
  return first !== undefined && first.startsWith(WRONG_ACCOUNT_PREFIX);
};

const isThreadNotFound = Schema.is(ThreadNotFoundError);

/** The thread's status. A thread that is archived counts as one T3 no longer has: `null`. */
export const threadStatus = (
  ctx: BuildingContext,
  threadId: string,
): Effect.Effect<ThreadStatus | null, BuildingError> =>
  ctx.sessions.status(threadId).pipe(
    Effect.map((status) => (status.archived ? null : status)),
    Effect.catchIf(isThreadNotFound, () => Effect.succeed(null)),
  );

/** Why a pull request is not the session's own. `public` is one of the factory's fixed lines. */
export interface Unbound {
  /** What the comment says. */
  readonly public: string;
  /** Set when the public line must leave out something that came from the pull request: the ledger and the caller get this instead. */
  readonly detail?: string;
}

/**
 * What the earlier attempts of the issue left, for `checkBinding`: every branch their ledgers name
 * and every pull request they recorded (see `earlierAttempts`). A pull request on one of those, or
 * one of those, is the issue's own work, which a later session may have pushed to or reported.
 */
export interface EarlierAttempts {
  readonly branches: ReadonlyArray<string>;
  readonly prs: ReadonlyArray<number>;
}

const NO_EARLIER: EarlierAttempts = { branches: [], prs: [] };

/**
 * Binds a pull request to a run: it is in this repo, not a fork, merges into `base`, and its head
 * is the session's `branch`, its `resumedFrom`, T3's `worktreePath` branch or an earlier attempt's
 * branch, or an earlier attempt recorded it (`earlier`). The text comes from a session that issue
 * text can steer, so it must not be able to name someone else's pull request.
 */
export const checkBinding = (
  pull: PullRequest | null,
  pr: number,
  base: string,
  branch: string | null,
  mustBeDraft = false,
  resumedFrom: string | null = null,
  worktreePath: string | null = null,
  earlier: EarlierAttempts = NO_EARLIER,
): Unbound | null => {
  const reported = `the session reported PR #${pr} but`;
  if (pull === null) return { public: `${reported} it does not exist` };
  if (pull.open && mustBeDraft && !pull.isDraft) return { public: `${reported} it is not a draft` };
  if (pull.crossRepository) return { public: `${reported} it comes from a fork` };
  if (pull.baseRef !== base) {
    const runBase = prepareSessionText(base);
    return {
      public: `${reported} its base is not the base branch ${runBase}`,
      detail: `${reported} its base ${prepareSessionText(pull.baseRef)} is not the base branch ${runBase}`,
    };
  }
  // A launch branch is this session's only when its own worktree is on it. A cloud-shaped branch
  // matches any path, so a cloud session's binds through `branch`, the thread's own.
  const launched =
    worktreePath !== null &&
    worktreePath.endsWith(`/${pull.headRef}`) &&
    isLaunchBranch(pull.headRef, worktreePath);
  const issues = earlier.prs.includes(pr) || earlier.branches.includes(pull.headRef);
  if (branch === null && resumedFrom === null && !launched && !issues) {
    return { public: `${reported} the session has no branch` };
  }
  // A session relaunched for a failed re-gate pushes to the pull request's branch, which its
  // `session_launched` line names; a resumed run may hold the draft its earlier session opened on
  // the branch it resumed from; a session told of an earlier attempt's work may push there.
  if (!launched && !issues && pull.headRef !== branch && pull.headRef !== resumedFrom) {
    return {
      public: `${reported} its branch is not this session's branch`,
      detail: `${reported} its branch ${prepareSessionText(pull.headRef)} is not this session's branch`,
    };
  }
  return null;
};

/**
 * `earlier` with the branches this run bound (`branch_bound`): what `checkBinding` accepts for
 * the run, in `advance` and in the gate alike.
 */
export const withBoundBranches = (earlier: EarlierAttempts, seen: Seen): EarlierAttempts =>
  seen.boundBranches.length === 0
    ? earlier
    : { ...earlier, branches: [...earlier.branches, ...seen.boundBranches] };

/**
 * Whether the live worktree of another run's thread holds `pull`: its thread or checkout is on the
 * head branch, or its HEAD is the head commit. A thread T3 no longer has, or has archived, or whose
 * worktree is gone, holds nothing. A failed read fails: the pass asks again.
 */
const threadHolds = (ctx: BuildingContext, threadId: string, pull: PullRequest) =>
  ctx.sessions.thread(threadId).pipe(
    Effect.flatMap((thread) => {
      if (thread.archived) return Effect.succeed(false);
      if (thread.branch === pull.headRef) return Effect.succeed(true);
      if (thread.worktreePath === null) return Effect.succeed(false);
      return ctx.sessions
        .worktreeCheckout(thread.worktreePath)
        .pipe(
          Effect.map(
            (checkout) =>
              checkout !== null &&
              (checkout.head === pull.headSha || checkout.branch === pull.headRef),
          ),
        );
    }),
    Effect.catchIf(isThreadNotFound, () => Effect.succeed(false)),
  );

/**
 * Whether another issue's run of the repo has `pull`: its ledger, finished or not, names the pull
 * request or its head branch, or an unfinished run's worktree holds it (`threadHolds`), which
 * covers work not yet reported. A read that fails, or a ledger that cannot be read, fails: the
 * pass asks again rather than end finished work as stuck.
 */
const otherRunHas = Effect.fn("RunnerBuilding.otherRunHas")(function* (
  ctx: BuildingContext,
  run: RunId,
  pull: PullRequest,
): Effect.fn.Return<boolean, LedgerError | SessionsError> {
  const others = yield* ledger(() =>
    readRuns(ctx.dataDir).filter(
      ({ summary: { id } }) =>
        asciiLower(id.repo) === asciiLower(run.repo) && id.issue !== run.issue,
    ),
  );
  const live: Array<string> = [];
  for (const { summary, record, seen } of others) {
    if (record === null || seen === null) {
      return yield* new LedgerIoError({
        path: runPath(ctx.dataDir, summary.id),
        cause: "the run cannot be read",
      });
    }
    const named = runNames(record.entries, seen);
    if (named.prs.has(pull.number) || named.branches.has(pull.headRef)) return true;
    if (!seen.finished && seen.threadId !== null) live.push(seen.threadId);
  }
  for (const threadId of live) {
    if (yield* threadHolds(ctx, threadId, pull)) return true;
  }
  return false;
});

/**
 * Whether `pull` is on a branch the session made: open, in this repo, onto `base`, opened after
 * the claim, no other issue's run has it (`otherRunHas`), and the worktree is on its head branch at
 * its head commit. Another machine's runs and a person's pull request are not seen. No worktree is
 * no proof; a failed read fails, so the pass asks again while the worktree is still there.
 */
const madeBySession = Effect.fn("RunnerBuilding.madeBySession")(function* (
  ctx: BuildingContext,
  run: RunId,
  pull: PullRequest,
  claimedMs: number | null,
  worktreePath: string | null,
): Effect.fn.Return<boolean, LedgerError | SessionsError> {
  const createdMs = parseTs(pull.createdAt);
  if (
    !pull.open ||
    pull.crossRepository ||
    pull.baseRef !== ctx.project.base ||
    !isSafeBranchName(pull.headRef) ||
    claimedMs === null ||
    createdMs === null ||
    createdMs <= claimedMs ||
    worktreePath === null
  ) {
    return false;
  }
  const own = yield* ctx.sessions.worktreeCheckout(worktreePath);
  if (own === null || own.head !== pull.headSha || own.branch !== pull.headRef) {
    return false;
  }
  return !(yield* otherRunHas(ctx, run, pull));
});

const stuckOutcome = (stop: Stop): AdvanceOutcome => ({
  kind: "stuck",
  reason: recordedReason(stop),
});

/**
 * Reads how the run's session ended and moves the issue on; writes nothing while it is active. The
 * last result line decides: an open draft pull request on the session's branch goes to the gate,
 * questions go on the issue, anything else is `stuck` (no result line gets one reminder first).
 * Repeat calls resume from the ledger; comments are at-least-once, everything else happens once.
 */
export const advance = (
  ctx: InterruptContext,
  run: RunId,
): Effect.Effect<AdvanceOutcome, BuildingError> =>
  withLedger(ctx, run, (out) =>
    Effect.gen(function* () {
      yield* checkRepo(ctx, run);
      const seen = yield* readSeen(ctx, run);
      if (seen.finished) return yield* new NotBuildingError({ run });
      const issue = issueOf(run);
      // Before anything is decided or written: a closed issue is a person's move, or the run's
      // own merged pull request, which ends the run here unless a recorded pass has the gate
      // finish it.
      const { closing, detail } = yield* closedIssue(ctx, run, seen);
      if (closing.kind === "persons-move") {
        yield* abandon(ctx, yield* out.open, run, seen, "advance");
        return { kind: "abandoned" } as const;
      }
      if (closing.kind === "own-merge" && seen.pass === null) {
        yield* endOwnMerge(ctx, yield* out.open, run, seen, "advance", closing.pull);
        return { kind: "ended" } as const;
      }
      const at = progressFrom("advance", seen, "triage");
      // `place` is where the session's pull request would be (`recordLeftPullRequest`).
      const stuck = Effect.fn("RunnerBuilding.stuck")(function* (
        code: string,
        stop: Stop,
        place: ThreadPlace,
      ) {
        const opened = yield* out.open;
        const left = recordLeftPullRequest(ctx, out, seen, "advance", place);
        yield* goStuck(ctx, issue, opened, at, code, stop, left);
        return stuckOutcome(stop);
      });
      // A stuck decision an older version recorded for a run it left in `needs-info` is not
      // carried out: that run is ended below and the issue stays `needs-info`.
      if (seen.stuck !== null && at.state !== "needs-info") {
        // Carried out, not decided again: nothing is looked up for it.
        const stop: Stop = { reason: seen.stuck };
        yield* goStuck(ctx, issue, yield* out.open, at, "stuck-resumed", stop);
        return stuckOutcome(stop);
      }
      // `stop-run.sh` ended the run on purpose. The thread is archived, or found gone, by the
      // stuck path and its status is never read, only where its work is: whatever the session is
      // doing, the run goes `stuck` as stopped by hand.
      // Only a building run: a line that is there for a run past `building` is stale.
      if (seen.stopRequested && at.state === "building") {
        if (relaunchDecided(seen) && (yield* endUnbegunRelaunch(ctx, run))) {
          // The issue is the next attempt's now: this run is finished as the relaunch would have
          // finished it, with no stuck line, label or comment. The operator stopped the issue's
          // work, so the stop is carried over to that attempt, as the line `stop-run.sh` writes,
          // and the next pass stops it.
          yield* carryStopToNext(ctx, run);
          const opened = yield* out.open;
          yield* stopSession(ctx, opened, at);
          yield* ledger(() =>
            opened.finish("stuck", null, null, makeCause("advance", "stop-requested")),
          );
          return stuckOutcome({ reason: STOPPED_BY_HAND });
        }
        return yield* stuck(
          "stop-requested",
          { reason: STOPPED_BY_HAND },
          yield* threadPlace(ctx, seen),
        );
      }
      // A relaunch is decided once, in `interrupted`, and carried out from the ledger: this is the
      // rest of one that was cut short. No evidence is needed again.
      if (relaunchDecided(seen)) {
        const start = yield* carryOutRelaunch(ctx, run, seen);
        return { kind: "relaunched", start } as const;
      }
      const threadId = seen.threadId;
      if (threadId === null) return yield* new NoSessionError({ run });
      // `state_changed` is the commit marker: a run in `needs-info` has had every write done, and
      // a person may have changed the issue since, so it is ended and nothing is written on GitHub.
      if (at.state === "needs-info") {
        yield* releaseOldClaim(ctx, issue, detail);
        yield* endNeedsInfo(ctx, out, at);
        return { kind: "needs-info" } as const;
      }
      // Every write is done: the run stays open while its pull request waits for a person, and
      // ends when a person merges or closes it (or it is gone).
      if (at.state === "pr-open" && seen.lastPr !== null) {
        const pull = yield* ctx.tracker.pullRequest(seen.lastPr.pr);
        if (pull === null || !pull.open) {
          yield* endRun(ctx, yield* out.open, at, seen.lastPr.url, pull, "advance");
          return { kind: "ended" } as const;
        }
        return { kind: "passed", pr: seen.lastPr.pr } as const;
      }
      // The gate passed and died before the move to `pr-open` was finished: the gate finishes
      // it, and nothing here looks at the session or the pull request again.
      if (seen.pass !== null && seen.lastPr !== null) {
        return { kind: "ready-for-gate", pr: seen.lastPr.pr, prUrl: seen.lastPr.url } as const;
      }
      if (at.state === "triage") {
        // `start` looks at the issue text again after the launch. A launch it has not done that
        // for is left to it, so this cannot give the run its `building` label around the check.
        if (!seen.rechecked) return { kind: "running" } as const;
        yield* finishBuilding(ctx, issue, yield* out.open, at);
      }

      // A thread T3 no longer has is not stuck by itself: the pass decides (see `interrupted`).
      const status = yield* threadStatus(ctx, threadId);
      if (status === null) return { kind: "ended-badly", what: "thread-gone" } as const;
      const message = status.lastAssistantMessage;
      const result = parseSessionResult(ctx.repo, message ?? undefined);
      // A `session_interrupted` (or `session_rate_limited`) line with no sent step is a resume cut
      // short. If the thread has a run newer than the one that ended, the message arrived and only
      // the step is written; else the send is repeated under the same command id. A thread T3 no
      // longer has is the thread-gone case.
      const owedResume = seen.interruption;
      if (owedResume !== null && !owedResume.relaunch && !owedResume.sent) {
        const arrived =
          status.runOrdinal !== null &&
          owedResume.runOrdinal !== null &&
          status.runOrdinal > owedResume.runOrdinal;
        if (!arrived) {
          const resent = owedResume.rateLimited
            ? yield* sendRateLimited(
                ctx,
                run,
                threadId,
                owedResume.runOrdinal,
                owedResume.model === null ? null : seen.model,
              )
            : yield* sendInterruption(ctx, run, threadId, owedResume.resumes);
          if (resent === "gone") return { kind: "ended-badly", what: "thread-gone" } as const;
        }
        yield* append(
          out,
          {
            event: "step_changed",
            data: {
              step: owedResume.rateLimited
                ? `${RATE_LIMITED_SENT} ${owedResume.runOrdinal}`
                : `${INTERRUPTION_SENT} ${owedResume.resumes}`,
            },
          },
          "advance",
          owedResume.rateLimited ? "rate-limited-sent" : "interruption-sent",
        );
        if (!arrived) return { kind: "running" } as const;
      }
      // Sends the reminder for run `k`; a thread T3 no longer has, or a refusal, ends the run.
      const remind = Effect.fn("RunnerBuilding.remind")(function* (k: number) {
        const sent = yield* sendReminder(ctx, out, run, threadId, k);
        if (sent === "gone") {
          return yield* stuck("thread-gone", stopOf(THREAD_GONE, null), status);
        }
        if (sent !== "sent") {
          return yield* stuck("session-stuck", refusedStop(result, message, sent), status);
        }
        return { kind: "reminded" } as const;
      });

      // A `result-line-reminding <k>` step with no `result-line-reminded` is a reminder cut short
      // before its send or its step. If a run newer than `k` exists the send reached the session
      // and the step is only written; otherwise the send is made again, under the same command id.
      let alreadyReminded = seen.reminded;
      if (seen.reminding !== null && !alreadyReminded) {
        if (status.runOrdinal !== null && status.runOrdinal > seen.reminding) {
          yield* append(out, remindedStep, "advance", "result-line-reminded");
          alreadyReminded = true;
        } else {
          return yield* remind(seen.reminding);
        }
      }
      // The reminder is owed once per run: the latest run, which has an ordinal, ended with
      // no result line, and none was sent. A run with no ordinal cannot be waited for, so it is
      // read as it always was. Paused and ended-badly runs return below, before this is read.
      const owed =
        !alreadyReminded &&
        lacksResultLine(result) &&
        status.runOrdinal !== null &&
        status.run !== null &&
        isTerminal(status.run);
      if (sessionBusy(seen, status)) return { kind: "running" } as const;
      // A run a person stopped in T3 is paused, on purpose: nothing is sent to resume it and the
      // issue is not touched.
      if (status.run === "interrupted" && result.kind !== "done") {
        if (seen.paused === null || seen.paused.runOrdinal !== status.runOrdinal) {
          yield* append(
            out,
            { event: "session_paused", data: { run_ordinal: status.runOrdinal } },
            "advance",
            "session-paused",
          );
        }
        return { kind: "paused" } as const;
      }
      const endedBadly = endedBadlyNow(seen, status, result);
      if (endedBadly !== null) {
        // A rate limit is the provider's, not the issue's: the pass waits it out.
        const limit = rateLimitOf(message);
        if (limit !== null && endedBadly.what !== null) {
          return {
            kind: "rate-limited",
            // Never the clock, which each pass would read as a new hit: a run T3 gave no end is
            // placed at its start, else long ago, so it counts as part of the window it opened.
            endedMs: status.runCompletedAt ?? status.runStartedAt ?? 0,
            retryAfterMs: limit.retryAfterMs,
            model: seen.model,
          } as const;
        }
        // A failed or cancelled run may be an interruption, which the pass decides. It needs an
        // ordinal to wait for a newer run by, so a run without one is stuck as it always was.
        if (endedBadly.what !== null)
          return { kind: "ended-badly", what: endedBadly.what } as const;
        return yield* stuck(
          "session-ended-badly",
          stopOf(`the session run ended as ${endedBadly.name}`, message),
          status,
        );
      }
      if (owed && status.runOrdinal !== null) {
        yield* append(
          out,
          {
            event: "step_changed",
            data: { step: `${RESULT_LINE_REMINDING} ${status.runOrdinal}` },
          },
          "advance",
          "result-line-reminding",
        );
        return yield* remind(status.runOrdinal);
      }

      switch (result.kind) {
        case "done": {
          const { pr, prUrl } = result;
          const pull = yield* ctx.tracker.pullRequest(pr);
          const unbound = checkBinding(
            pull,
            pr,
            ctx.project.base,
            status.branch,
            false,
            seen.resumedFrom,
            status.worktreePath,
            withBoundBranches(yield* earlierAttempts(ctx, run), seen),
          );
          // A branch the session made is bound once, here, while its worktree is still there:
          // the stuck path removes it. The `branch_bound` line is the proof from then on.
          const madeHere =
            unbound !== null &&
            pull !== null &&
            (yield* madeBySession(ctx, run, pull, seen.claimedMs, status.worktreePath));
          if (madeHere && pull !== null) {
            yield* append(
              out,
              { event: "branch_bound", data: { pr, branch: pull.headRef } },
              "advance",
              "branch-bound",
            );
          } else if (unbound !== null) {
            return yield* stuck(
              "pr-not-bound",
              stopOf(
                unbound.public,
                message,
                unbound.detail === undefined ? {} : { detail: unbound.detail },
              ),
              status,
            );
          }
          // The session's pull request that is open and ready for review goes back to draft:
          // only the gate marks it ready. A call that fails leaves it as it is, and stuck.
          if (pull !== null && pull.open && !pull.isDraft) {
            const drafted = yield* Effect.result(ctx.tracker.markPrDraft(pr));
            if (drafted._tag === "Failure") {
              // A rate limit says nothing about the pull request: ask again next pass.
              if (drafted.failure._tag === "GitHubRateLimited") return yield* drafted.failure;
              return yield* stuck(
                "pr-not-bound",
                stopOf(`the session reported PR #${pr} but it is not a draft`, message),
                status,
              );
            }
            yield* append(out, { event: "pr_set_draft", data: { pr } }, "advance", "pr-set-draft");
          }
          // Once per hand-off to the gate: the first report, and the report after each send-back.
          if (!seen.opened.includes(pr) || !seen.prReported) {
            yield* append(
              out,
              { event: "pr_opened", data: { pr, url: prUrl } },
              "advance",
              "pr-opened",
            );
          }
          // A pull request a person merged or closed before the gate looked at it ends the run:
          // nothing is left to gate.
          if (pull !== null && !pull.open) {
            yield* endRun(ctx, yield* out.open, at, prUrl, pull, "advance");
            return { kind: "ended" } as const;
          }
          return { kind: "ready-for-gate", pr, prUrl } as const;
        }
        case "needs-info": {
          yield* recordLeftPullRequest(ctx, out, seen, "advance", status);
          const prepared = prepareSessionText(result.questions);
          const raised = yield* Effect.fromResult(
            transition(at.state, { kind: "questions-raised", questions: prepared }),
          );
          yield* applyActions(
            ctx,
            issue,
            yield* out.open,
            at,
            raised.actions,
            makeCause("advance", "questions-asked"),
          );
          yield* endNeedsInfo(ctx, out, at);
          return { kind: "needs-info" } as const;
        }
        case "stuck": {
          if (result.reason === SAID_STUCK && saysWrongAccount(result.sessionText)) {
            return yield* stuck(
              "session-wrong-account",
              stopOf(WRONG_ACCOUNT, result.sessionText),
              status,
            );
          }
          return yield* stuck("session-stuck", stopOf(result.reason, result.sessionText), status);
        }
      }
    }),
  );

const remindedStep: RunEvent = { event: "step_changed", data: { step: RESULT_LINE_REMINDED } };

/**
 * What the attempts before `run` left, from their ledgers (`EarlierAttempts`): every branch their
 * lines name and every pull request they recorded. Nothing is read for a first attempt, and an
 * attempt with no ledger is passed over. The gate reads it too, so a pull request `advance` bound
 * through it is bound the same way at gate time.
 */
export const earlierAttempts = Effect.fn("RunnerBuilding.earlierAttempts")(function* (
  ctx: BuildingContext,
  run: RunId,
): Effect.fn.Return<EarlierAttempts, LedgerError> {
  const branches = new Set<string>();
  const prs = new Set<number>();
  for (const { entries } of yield* earlierRuns(ctx.dataDir, run)) {
    const named = runNames(entries, readProgress(entries));
    for (const branch of named.branches) branches.add(branch);
    for (const pr of named.prs) prs.add(pr);
  }
  return { branches: [...branches], prs: [...prs] };
});

/** Where a session's work is: the thread's branch and worktree, as its status reports them. */
type ThreadPlace = Pick<ThreadStatus, "branch" | "worktreePath">;

/**
 * Where the session's work is, for a stop that has not read the thread's status: the thread's
 * branch and worktree as T3 reports them, each else what the ledger last recorded
 * (`Seen.lastBranch`, `Seen.worktree`), which is all a thread T3 no longer has leaves. A read that
 * fails is not a stop.
 */
const threadPlace = (ctx: BuildingContext, seen: Seen): Effect.Effect<ThreadPlace> => {
  const recorded: ThreadPlace = { branch: seen.lastBranch, worktreePath: seen.worktree };
  if (seen.threadId === null) return Effect.succeed(recorded);
  return ctx.sessions.thread(seen.threadId).pipe(
    Effect.map((thread) => ({
      branch: thread.branch ?? recorded.branch,
      worktreePath: thread.worktreePath ?? recorded.worktreePath,
    })),
    Effect.orElseSucceed(() => recorded),
  );
};

/**
 * Records the pull request a session leaves open short of the gate as `pr_left`, so the next
 * attempt continues it (`start`'s `resumeFrom`); not `pr_opened`, so the run keeps its slot. Asked
 * by branch, never by its text, after the stop, so an outage never keeps a session working. A
 * failed read is an `error` line and is not retried: the archived thread reads as gone.
 */
const recordLeftPullRequest = Effect.fn("RunnerBuilding.recordLeftPullRequest")(function* (
  ctx: BuildingContext,
  out: Out,
  seen: Seen,
  step: CauseStep,
  place: ThreadPlace,
) {
  const heads = new Set<string>();
  for (const head of [place.branch, launchBranchOf(place.worktreePath), seen.resumedFrom]) {
    if (head !== null && isSafeBranchName(head)) heads.add(head);
  }
  for (const head of heads) {
    const listed = yield* Effect.result(ctx.tracker.openPullRequestsOnHead(head));
    if (listed._tag === "Failure") {
      yield* append(
        out,
        { event: "error", data: { step, kind: "github", message: describe(listed.failure) } },
        step,
        "step-failed",
      );
      return;
    }
    const left = listed.success.find(
      (pull) => isOwnPull(pull, ctx.trackerUser) && isResumablePull(pull, ctx.project.base),
    );
    if (left === undefined) continue;
    const recorded =
      seen.opened.includes(left.number) || seen.left.some((l) => l.pr === left.number);
    if (!recorded) {
      yield* append(
        out,
        { event: "pr_left", data: { pr: left.number, url: left.url } },
        step,
        "pr-left",
      );
    }
    return;
  }
});

/**
 * Gives back an issue that an older version's `answer` claimed for a run now left in `needs-info`:
 * it set `factory:building` and the machine's user before writing `state_changed`, so a crash
 * between left the issue claimed with no unfinished run. Only that exact shape is touched (label
 * `factory:building`, the machine's user the only assignee); anything else is a person's.
 */
const releaseOldClaim = Effect.fn("RunnerBuilding.releaseOldClaim")(function* (
  ctx: BuildingContext,
  issue: number,
  read: IssueDetail | null,
) {
  const detail = read ?? (yield* ctx.tracker.issue(issue));
  const ours =
    detail.assignees.length === 1 &&
    asciiLower(detail.assignees[0]!) === asciiLower(ctx.trackerUser);
  if (detail.state === "building" && ours) {
    yield* ctx.tracker.setState(issue, "needs-info");
    yield* ctx.tracker.unassign(issue, ctx.trackerUser);
  }
});

/**
 * Ends a run whose questions are on the issue: the thread is archived, its worktree is removed,
 * and the ledger is finished as `needs-info`. Nothing is written on GitHub: the questions, the
 * label and the release were done before `state_changed`, which is what says so. An archive that
 * fails is an error with nothing written, so the next call ends the run.
 */
const endNeedsInfo = Effect.fn("RunnerBuilding.endNeedsInfo")(function* (
  ctx: BuildingContext,
  out: Out,
  at: Progress,
) {
  const opened = yield* out.open;
  yield* stopSession(ctx, opened, at);
  yield* ledger(() =>
    opened.finish("needs-info", null, null, makeCause("advance", "questions-asked")),
  );
});

/**
 * Sends the session its one reminder to end with a result line, and records it. `k` is the ordinal
 * of the run that ended without one. The command id `softfac:<run>:remind:<k>` makes a repeat after
 * a crash the same command, so the worst case is a second reminder, never a hang. T3 not having the
 * thread is `"gone"`; a refusal is final (T3 keeps it under the command id) and is returned.
 */
const sendReminder = Effect.fn("RunnerBuilding.sendReminder")(function* (
  ctx: BuildingContext,
  out: Out,
  run: RunId,
  threadId: string,
  k: number,
) {
  const sent = yield* ctx.sessions
    .send(threadId, `softfac:${runIdToString(run)}:remind:${k}`, RESULT_LINE_REMINDER)
    .pipe(
      Effect.as("sent" as const),
      Effect.catchIf(isThreadNotFound, () => Effect.succeed("gone" as const)),
      Effect.catchIf(isMessageRejected, (refused) => Effect.succeed(refused)),
    );
  if (sent !== "sent") return sent;
  yield* append(out, remindedStep, "advance", "result-line-reminded");
  return sent;
});

const isMessageRejected = Schema.is(MessageRejectedError);

/**
 * The stop for a reminder T3 refused: the public reason is the run's own (it ended with no result
 * line, or no message), the ledger's detail says the reminder could not reach it.
 */
const refusedStop = (
  result: SessionResult,
  message: string | null,
  refused: MessageRejectedError,
): Stop => {
  const reason =
    result.kind === "stuck" && lacksResultLine(result) ? result.reason : NO_RESULT_LINE;
  return stopOf(reason, message, {
    detail: `${reason}; T3 refused the reminder: ${describe(refused)}`,
  });
};

/**
 * Why the issue text no longer stands for a building run, or `null`. A run with no `approved` step
 * fails closed without a read; otherwise every rename and body edit since the approval must be an
 * instructor's. A history that cannot be judged counts as changed; a failed read is an error, never
 * an answer.
 */
export const textStop = Effect.fn("RunnerBuilding.textStop")(function* (
  ctx: BuildingContext,
  issue: number,
  seen: Seen,
) {
  if (seen.approvedAt === null) return { code: "approval-unconfirmed", reason: CANNOT_CONFIRM };
  const check = yield* ctx.tracker.textCheck(issue, seen.approvedAt, ctx.project.instructors);
  switch (check) {
    case "unchanged":
      return null;
    case "changed":
      return { code: "text-changed-during-build", reason: CHANGED_DURING_BUILD };
    case "unjudged":
      return { code: "edits-unverifiable", reason: CANNOT_VERIFY_DURING_BUILD };
  }
});

/**
 * Stops a building run whose issue text a non-instructor changed, or whose edit history cannot be
 * judged: the thread is archived, then the run goes `stuck`. Nothing is written when the text is
 * unchanged, and no step records a pass, since an edit can come at any time. A failed read or
 * archive is an error with nothing written. Call it before `advance`; it has no loop or timer.
 */
export const watch = Effect.fn("RunnerBuilding.watch")(function* (
  ctx: BuildingContext,
  run: RunId,
) {
  yield* checkRepo(ctx, run);
  const seen = yield* readSeen(ctx, run);
  if (seen.finished) return { kind: "skipped", why: "finished" } as const;
  if (relaunchDecided(seen)) return { kind: "skipped", why: "relaunching" } as const;
  if (seen.threadId === null) return { kind: "skipped", why: "no-session" } as const;
  if (
    seen.state !== "building" ||
    seen.stuck !== null ||
    seen.stopRequested ||
    seen.questionsPosted
  ) {
    return { kind: "skipped", why: "not-building" } as const;
  }
  // The gate checks the text itself before it records a pass, and after one the session is done.
  if (seen.pass !== null) return { kind: "skipped", why: "gate-passed" } as const;
  const issue = issueOf(run);
  const why = yield* textStop(ctx, issue, seen);
  if (why === null) return { kind: "unchanged" } as const;
  // Only a run that has reported a pull request can have been closed by its own merge: no read
  // for any other. `advance` ends that run; a closed issue otherwise changes nothing here.
  if (seen.opened.length > 0) {
    const { closing } = yield* closedIssue(ctx, run, seen);
    if (closing.kind === "own-merge") return { kind: "skipped", why: "pr-merged" } as const;
  }
  const at = progressFrom("watch", seen, "building");
  const stop: Stop = { reason: why.reason };
  const place = yield* threadPlace(ctx, seen);
  yield* withLedger(ctx, run, (out) =>
    Effect.flatMap(out.open, (opened) =>
      goStuck(
        ctx,
        issue,
        opened,
        at,
        why.code,
        stop,
        recordLeftPullRequest(ctx, out, seen, "watch", place),
      ),
    ),
  );
  return { kind: "stopped", reason: recordedReason(stop) } as const;
});

/**
 * A gate attempt was being sent into the session (a `gate-sending` step with no matching
 * `gate_sent_back`), so a message sent now could be mistaken for the proof that it arrived.
 */
export const gateSendPending = (seen: Seen): boolean =>
  seen.sending !== null && !seen.sentBackAttempts.has(seen.sending.attempt);

/**
 * The `since` of every read of an issue's activity for a run: the run's first ledger line, cut
 * to whole seconds, never a moving cursor. The milliseconds are cut off, not rounded, so `since`
 * may be early, never late.
 */
const sinceRunStart = (firstMs: number): string => `${formatTs(firstMs).slice(0, 19)}Z`;

/**
 * What `forward` still has to send from one read of the instructors' activity: comments with no
 * `comment_forwarded` in the ledger, oldest first and each id once, and the body edit whose time
 * has no `body-edit-forwarded` step. A comment already dropped or sent as feedback is never sent
 * later. A body edit time not in GitHub's form is refused before anything is sent or written.
 */
const unsent = Effect.fn("RunnerBuilding.unsent")(function* (seen: Seen, activity: Activity) {
  const edit = activity.bodyEdit;
  if (edit !== null && !isUtcSecond(edit.editedAt)) {
    return yield* new GitHubParse({
      args: ["api", "graphql"],
      expected: `the body edit time as YYYY-MM-DDTHH:MM:SSZ, got "${Array.from(edit.editedAt).slice(0, 40).join("").replaceAll("\n", "\\n")}"`,
    });
  }
  const told = new Set([...seen.forwarded, ...seen.dropped]);
  const comments = activity.comments.filter((comment) => {
    // Nor one that went into the session as instructor feedback, when the run was waiting for review.
    if (told.has(comment.id) || seen.feedbackSent.has(issueCommentFeedbackId(comment.id)))
      return false;
    told.add(comment.id);
    return true;
  });
  return {
    comments,
    bodyEdit: edit !== null && !seen.bodyEdits.has(edit.editedAt) ? edit : null,
  };
});

/**
 * The dropped comments the issue was not told about yet, in the order read, each id once. A
 * comment already forwarded, or sent as instructor feedback, is left out: the session has the
 * instructor's own words, and a later edit by someone else changes nothing it holds.
 */
const unreported = (seen: Seen, activity: Activity): ReadonlyArray<Dropped> => {
  const told = new Set(seen.dropped);
  return activity.dropped.filter((dropped) => {
    if (
      seen.forwarded.has(dropped.id) ||
      seen.feedbackSent.has(issueCommentFeedbackId(dropped.id)) ||
      told.has(dropped.id)
    )
      return false;
    told.add(dropped.id);
    return true;
  });
};

/** A comment for the issue and the step that records it was posted: the comment first, the step after, so a crash between them posts it again (at-least-once). */
interface Notice {
  readonly body: string;
  readonly step: string;
  readonly reason: string;
}

const dropNotice = (
  ctx: BuildingContext,
  issue: number,
  dropped: { readonly id: string; readonly reason: CommentDropReason },
): Notice => ({
  body: droppedCommentMessage(ctx.repo, issue, dropped.id, dropped.reason),
  step: `${COMMENT_DROPPED} ${dropped.id}`,
  reason: "comment-dropped",
});

const refusedEditNotice = (editedAt: string): Notice => ({
  body: REFUSED_BODY_EDIT,
  step: `${BODY_EDIT_DROPPED} ${editedAt}`,
  reason: "body-edit-dropped",
});

/** Cancels the `forward-wait <k>` under which nothing went into the session. */
const cancelForwardWait = (out: Out, k: number): Effect.Effect<void, BuildingError> =>
  append(
    out,
    { event: "step_changed", data: { step: `${FORWARD_WAIT_CANCELLED} ${k}` } },
    "forward",
    "forward-wait-cancelled",
  );

/** Posts each notice and records it. A failure stops the call and the rest is said on the next one. */
const tellIssue = (
  ctx: BuildingContext,
  out: Out,
  issue: number,
  notices: ReadonlyArray<Notice>,
): Effect.Effect<void, BuildingError> =>
  Effect.forEach(
    notices,
    (n) =>
      Effect.gen(function* () {
        yield* ctx.tracker.postComment(issue, n.body);
        yield* append(out, { event: "step_changed", data: { step: n.step } }, "forward", n.reason);
      }),
    { discard: true },
  );

/**
 * Sends the session the instructors' new comments and body edit, once each. The ledger
 * (`comment_forwarded`, `body-edit-forwarded <edited_at>`) says what is sent and each send has a
 * stable command id, so repeats are safe. A send T3 refuses is final: the item is dropped and the
 * issue told once. An idle session starts a run on a message, so `forward-wait <k>` comes first.
 */
export const forward = (
  ctx: BuildingContext,
  run: RunId,
): Effect.Effect<ForwardOutcome, BuildingError> =>
  withLedger(ctx, run, (out) =>
    Effect.gen(function* () {
      yield* checkRepo(ctx, run);
      const record = yield* ledger(() => readRun(ctx.dataDir, run));
      const seen = readProgress(record.entries);
      const skip = (skipped: SkipReason): ForwardOutcome => ({
        comments: 0,
        bodyEdit: false,
        skipped,
      });
      if (seen.finished) return skip("finished");
      if (relaunchDecided(seen)) return skip("relaunching");
      const first = record.entries[0];
      const threadId = seen.threadId;
      if (threadId === null || first === undefined) return skip("no-session");
      // `state_changed` is the commit marker, so a stuck decision or posted questions without it
      // are a transition that was cut short. A recorded gate pass is not interrupted.
      if (
        seen.state !== "building" ||
        seen.pass !== null ||
        seen.stuck !== null ||
        seen.stopRequested ||
        seen.questionsPosted
      ) {
        return skip("not-building");
      }
      // The gate infers that a send-back reached the session from a newer run having ended. A
      // run that a forwarded message starts would count too, and burn the attempt, so the
      // message waits until the gate has sent the failure and recorded it.
      if (gateSendPending(seen)) return skip("gate-send-pending");
      // Only a run that would read the issue's activity asks whether the issue is closed. A run
      // whose own merge closed the issue gets nothing more sent; `advance` ends it.
      const { closing } = yield* closedIssue(ctx, run, seen);
      if (closing.kind === "persons-move") {
        yield* abandon(ctx, yield* out.open, run, seen, "forward");
        return skip("abandoned");
      }
      if (closing.kind === "own-merge") return skip("pr-merged");

      const issue = Number(run.issue);
      const activity = yield* ctx.tracker.activitySince(
        issue,
        sinceRunStart(first.ms),
        ctx.project.instructors,
      );
      const { comments, bodyEdit } = yield* unsent(seen, activity);
      const drops = unreported(seen, activity);
      // A marker whose every send the ledger shows T3 refused, left by a call that crashed before
      // its cancel, waits for a run nothing started. It is cancelled first, whatever this call does.
      if (seen.refusedForwardWait !== null) {
        yield* cancelForwardWait(out, seen.refusedForwardWait);
      }
      if (comments.length === 0 && bodyEdit === null) {
        yield* tellIssue(
          ctx,
          out,
          issue,
          drops.map((d) => dropNotice(ctx, issue, d)),
        );
        return { comments: 0, bodyEdit: false, skipped: null };
      }

      // Something is to be sent: is the session idle? A message sent into an ended run starts a
      // new run, and the gate must wait for that run, not judge the old one again.
      const status = yield* threadStatus(ctx, threadId);
      if (status === null) return skip("no-thread");
      // The ordinal this call's messages would start a run after. An earlier call's marker for it
      // counts as working once a send under it went in, so this call writes none.
      const marker =
        status.run === null || isTerminal(status.run) ? (status.runOrdinal ?? 0) : null;
      const idleAt =
        marker !== null && (seen.lastWait !== marker || seen.idleForwardWait === marker)
          ? marker
          : null;
      const opened = yield* out.open;
      const at = progressFrom("forward", seen, "building");
      const runName = runIdToString(run);
      const refused: Array<Notice> = [];
      let sent = 0;
      let editSent = false;
      // While the session is idle and nothing this call sent has gone in, each send goes under its
      // own `forward-wait` line and a refusal is recorded at once, both naming the send's command
      // id, so the ledger proves which sends started no run (`Seen.refusedForwardWait`), even
      // after a crash.
      const stepWhileIdle = (step: string, reason: string, commandId: string) =>
        idleAt !== null && sent === 0
          ? append(out, { event: "step_changed", data: { step } }, "forward", reason, {
              command: commandId,
            })
          : Effect.void;
      for (const comment of comments) {
        const { actions } = yield* Effect.fromResult(
          transition("building", { kind: "instructor-commented", commentId: comment.id }),
        );
        const commandId = `softfac:${runName}:comment:${comment.id}`;
        yield* stepWhileIdle(`${FORWARD_WAIT} ${idleAt}`, "forward-waiting", commandId);
        const result = yield* applyActions(
          ctx,
          issue,
          opened,
          at,
          actions,
          makeCause("forward", "comment-forwarded"),
          {
            forward: {
              commandId,
              text: commentMessage(ctx.repo, issue, comment.author, comment.body),
            },
          },
        ).pipe(
          Effect.as("sent" as const),
          Effect.catchIf(isMessageRejected, () => Effect.succeed("refused" as const)),
        );
        if (result === "sent") sent += 1;
        else {
          yield* stepWhileIdle(`${COMMENT_REFUSED} ${comment.id}`, "comment-refused", commandId);
          refused.push(dropNotice(ctx, issue, { id: comment.id, reason: "refused" }));
        }
      }
      // The edit goes after the comments of this call, which may have been written before it.
      if (bodyEdit !== null) {
        const { actions } = yield* Effect.fromResult(
          transition("building", { kind: "body-edited" }),
        );
        const commandId = `softfac:${runName}:body:${bodyEdit.editedAt}`;
        yield* stepWhileIdle(`${FORWARD_WAIT} ${idleAt}`, "forward-waiting", commandId);
        const result = yield* applyActions(
          ctx,
          issue,
          opened,
          at,
          actions,
          makeCause("forward", "body-edit-forwarded"),
          {
            forward: {
              commandId,
              text: bodyEditMessage(ctx.repo, issue, bodyEdit.editor, bodyEdit.body),
              step: `${BODY_EDIT_FORWARDED} ${bodyEdit.editedAt}`,
            },
          },
        ).pipe(
          Effect.as("sent" as const),
          Effect.catchIf(isMessageRejected, () => Effect.succeed("refused" as const)),
        );
        if (result === "sent") editSent = true;
        else {
          yield* stepWhileIdle(
            `${BODY_EDIT_REFUSED} ${bodyEdit.editedAt}`,
            "body-edit-refused",
            commandId,
          );
          refused.push(refusedEditNotice(bodyEdit.editedAt));
        }
      }
      // A marker the ledger now proves T3 refused every send under, an earlier call's included,
      // waits for a run nothing started. Cancelled before the issue is told, so a failed comment
      // call leaves no wait behind.
      if (idleAt !== null) {
        const after = readProgress((yield* ledger(() => readRun(ctx.dataDir, run))).entries);
        if (after.refusedForwardWait !== null) {
          yield* cancelForwardWait(out, after.refusedForwardWait);
        }
      }
      // Last: telling the issue must not hold back what the session needs.
      yield* tellIssue(ctx, out, issue, [
        ...refused,
        ...drops.map((d) => dropNotice(ctx, issue, d)),
      ]);
      return { comments: sent, bodyEdit: editSent, skipped: null };
    }),
  );

/** The thread's own fields, or `undefined` when T3 cannot say: a read that fails is not a stop. */
const threadOf = (ctx: BuildingContext, threadId: string) =>
  ctx.sessions.thread(threadId).pipe(Effect.orElseSucceed(() => undefined));

/** How long before `now` the thread last did anything, or `null` when T3 cannot say: a read that fails is not a stop. */
const quietFor = (ctx: BuildingContext, threadId: string, now: number) =>
  ctx.sessions.lastActivity(threadId).pipe(
    Effect.map((at) => (at === null ? null : now - at)),
    Effect.orElseSucceed(() => null),
  );

/**
 * Stops a run that has worked longer than `limits.minutes`, counting `triage` and `building` time
 * from the ledger, not `pr-open`. The thread is archived and the run goes `stuck` (`timeLimitReason`).
 * Skipped: `pr-reported` since entering `building`, and `launch-unrecorded` (only `resume` names it).
 */
export const timeLimit = Effect.fn("RunnerBuilding.timeLimit")(function* (
  ctx: BuildingContext,
  run: RunId,
) {
  yield* checkRepo(ctx, run);
  const seen = yield* readSeen(ctx, run);
  if (seen.finished) return { kind: "skipped", why: "finished" } as const;
  if (relaunchDecided(seen)) return { kind: "skipped", why: "relaunching" } as const;
  const working =
    seen.state === null ||
    seen.state === "ready" ||
    seen.state === "triage" ||
    seen.state === "building";
  if (!working || seen.stuck !== null || seen.stopRequested || seen.questionsPosted) {
    return { kind: "skipped", why: "not-running" } as const;
  }
  if (seen.prReported) return { kind: "skipped", why: "pr-reported" } as const;
  if (seen.threadId === null && seen.launchSent) {
    return { kind: "skipped", why: "launch-unrecorded" } as const;
  }
  const now = ctx.clock();
  const worked =
    seen.workedMs + (seen.workingSince === null ? 0 : Math.max(0, now - seen.workingSince));
  if (worked <= ctx.project.limits.minutes * MINUTE_MS) return { kind: "within" } as const;
  // Only a run that has reported a pull request can have been closed by its own merge: no read
  // for any other.
  if (seen.opened.length > 0) {
    const { closing } = yield* closedIssue(ctx, run, seen);
    if (closing.kind === "own-merge") return { kind: "skipped", why: "pr-merged" } as const;
  }
  // Read before the archive: the next attempt is told where the work is.
  const thread = seen.threadId === null ? undefined : yield* threadOf(ctx, seen.threadId);
  const branch = thread?.branch ?? undefined;
  // An archived thread is a stop retried after its archive: the session ended at the first try.
  const quiet =
    seen.threadId === null || thread === undefined || thread.archived
      ? null
      : yield* quietFor(ctx, seen.threadId, now);
  const prepared = branch === undefined ? "" : prepareSessionText(branch);
  const stop: Stop = {
    reason: timeLimitReason(worked, quiet),
    ...(prepared !== "" && { branch: prepared, commitsAhead: null }),
  };
  // Called by the pass before any step, so the pass is what decided.
  const at = progressFrom("pass", seen, "triage");
  // The pull request the session leaves on its branch, for the next attempt to continue.
  const place = { branch: branch ?? seen.lastBranch, worktreePath: seen.worktree };
  yield* withLedger(ctx, run, (out) =>
    Effect.flatMap(out.open, (opened) =>
      goStuck(
        ctx,
        issueOf(run),
        opened,
        at,
        "time-limit",
        stop,
        recordLeftPullRequest(ctx, out, seen, "pass", place),
      ),
    ),
  );
  return { kind: "stopped", reason: recordedReason(stop) } as const;
});

/**
 * Sends the session its resume message under `softfac:<run>:interrupted:<n>`: a send repeated
 * after a crash is the same command. The caller writes the `interruption-sent <n>` step after. T3
 * not having the thread is `"gone"`; any other failure is an error, and the next call sends again.
 */
const sendInterruption = (
  ctx: BuildingContext,
  run: RunId,
  threadId: string,
  n: number,
): Effect.Effect<"sent" | "gone", BuildingError> =>
  ctx.sessions
    .send(threadId, `softfac:${runIdToString(run)}:interrupted:${n}`, INTERRUPTION_MESSAGE)
    .pipe(
      Effect.as("sent" as const),
      Effect.catchIf(isThreadNotFound, () => Effect.succeed("gone" as const)),
    );

/**
 * Sends a rate-limited session its resume under `softfac:<run>:rate-limited:<ordinal>`, the
 * ordinal of the run that ended, on `model` when it moves the session. Like `sendInterruption`.
 */
const sendRateLimited = (
  ctx: BuildingContext,
  run: RunId,
  threadId: string,
  runOrdinal: number | null,
  model: Model | null,
): Effect.Effect<"sent" | "gone", BuildingError> =>
  ctx.sessions
    .send(
      threadId,
      `softfac:${runIdToString(run)}:rate-limited:${runOrdinal}`,
      rateLimitedMessage(model?.model ?? null),
      model ?? undefined,
    )
    .pipe(
      Effect.as("sent" as const),
      Effect.catchIf(isThreadNotFound, () => Effect.succeed("gone" as const)),
    );

/**
 * The stuck path of a session that ended badly and is not an interruption, or of a stop by hand:
 * as `advance` once decided it. `place` is the thread's status when the caller read it; else the
 * thread is asked (`threadPlace`).
 */
const stuckEnded = Effect.fn("RunnerBuilding.stuckEnded")(function* (
  ctx: BuildingContext,
  run: RunId,
  seen: Seen,
  code: string,
  stop: Stop,
  place?: ThreadPlace,
): Effect.fn.Return<InterruptOutcome, BuildingError> {
  const where = place ?? (yield* threadPlace(ctx, seen));
  return yield* withLedger(ctx, run, (out) =>
    Effect.gen(function* () {
      const opened = yield* out.open;
      yield* goStuck(
        ctx,
        issueOf(run),
        opened,
        progressFrom("advance", seen, "building"),
        code,
        stop,
        recordLeftPullRequest(ctx, out, seen, "advance", where),
      );
      return { kind: "stuck", reason: recordedReason(stop) } as const;
    }),
  );
});

/**
 * The interruptions a run has used: the count on its newest `session_interrupted` line, or, when
 * it has none, the count its issue's previous attempt ended with when that attempt was relaunched
 * into this one (its newest `session_interrupted` line is a relaunch). Any other previous attempt,
 * a person's retry, starts again from zero.
 */
const resumesUsed = Effect.fn("RunnerBuilding.resumesUsed")(function* (
  ctx: InterruptContext,
  run: RunId,
  seen: Seen,
) {
  if (seen.interruption !== null) return seen.interruption.resumes;
  const previous = yield* previousRun(ctx, run);
  if (previous === null) return 0;
  const earlier = readProgress(previous.entries).interruption;
  return earlier !== null && earlier.relaunch ? earlier.resumes : 0;
});

/**
 * Decides whether a session that ended badly (`advance` said `ended-badly`) was an interruption or
 * a stop. An interruption needs `evidence` (T3 trouble in the last ten minutes, or another bad end
 * this pass) and resumes left (`limits.interruptionResumes`, shared with relaunches); else `stuck`.
 * A gone thread is relaunched, unless no approval is recorded. A stop by hand wins.
 */
export const interrupted = Effect.fn("RunnerBuilding.interrupted")(function* (
  ctx: InterruptContext,
  run: RunId,
  evidence: Evidence,
) {
  yield* checkRepo(ctx, run);
  const seen = yield* readSeen(ctx, run);
  if (seen.finished) return yield* new NotBuildingError({ run });
  const threadId = seen.threadId;
  if (threadId === null) return yield* new NoSessionError({ run });
  // The operator stopped the run after `advance` looked: a stop by hand, not an interruption,
  // whatever the evidence says.
  const byHand = (from: Seen) =>
    stuckEnded(ctx, run, from, "stop-requested", stopOf(STOPPED_BY_HAND, null));
  if (seen.stopRequested) return yield* byHand(seen);
  if (relaunchDecided(seen)) {
    return { kind: "unchanged", why: "a relaunch is already decided" } as const;
  }
  const limit = ctx.project.limits.interruptionResumes;
  // A restart counts only against the run's own times, so never for a thread that is gone.
  const may = (used: number, cutAt: number | null = null) =>
    (evidence.t3Error !== null || evidence.endedInPass >= 2 || cutAt !== null) && used < limit;
  const t3Error = evidence.t3Error === null ? null : prepareSessionText(evidence.t3Error);
  const goneStuck = (from: Seen) =>
    stuckEnded(ctx, run, from, "thread-gone", stopOf(THREAD_GONE, null));
  const relaunch = Effect.fn("RunnerBuilding.relaunch")(function* (from: Seen, resumes: number) {
    const branch = yield* relaunchBranchOf(ctx, run, from);
    yield* withLedger(ctx, run, (out) =>
      append(
        out,
        {
          event: "session_interrupted",
          data: {
            resumes,
            relaunch: true,
            run_ordinal: null,
            branch,
            t3_error: t3Error,
            ended_in_pass: evidence.endedInPass,
          },
        },
        "advance",
        "session-interrupted",
      ),
    );
    const decided = yield* readSeen(ctx, run);
    const start = yield* carryOutRelaunch(ctx, run, decided);
    return { kind: "relaunched", resumes, limit, start } as const;
  });
  const gone = Effect.gen(function* () {
    // The operator may have stopped the run since the ledger was read: the stop writes its line
    // before it archives, so a thread that stop took away always comes with the line, and a stop
    // by hand is never a relaunch.
    const latest = yield* readSeen(ctx, run);
    if (latest.stopRequested) return yield* byHand(latest);
    // A resume cut short before its send was never made, so it is not charged to a relaunch. A
    // rate-limited one charged nothing.
    const used =
      seen.interruption !== null && !seen.interruption.sent && !seen.interruption.rateLimited
        ? Math.max(0, seen.interruption.resumes - 1)
        : yield* resumesUsed(ctx, run, seen);
    if (may(used) && seen.approvedAt !== null) return yield* relaunch(seen, used + 1);
    return yield* goneStuck(seen);
  });

  const status = yield* threadStatus(ctx, threadId);
  if (status === null) return yield* gone;
  const message = status.lastAssistantMessage;
  const result = parseSessionResult(ctx.repo, message ?? undefined);
  const ended = endedBadlyNow(seen, status, result);
  if (ended === null || ended.what === null) {
    return { kind: "unchanged", why: "its thread has moved on since" } as const;
  }
  const used = yield* resumesUsed(ctx, run, seen);
  const cutAt = cutByRestart(status, evidence.t3Starts, evidence.t3Stops);
  if (!may(used, cutAt)) {
    return yield* stuckEnded(
      ctx,
      run,
      seen,
      "session-ended-badly",
      stopOf(`the session run ended as ${ended.name}`, message),
      status,
    );
  }
  const n = used + 1;
  yield* withLedger(ctx, run, (out) =>
    append(
      out,
      {
        event: "session_interrupted",
        data: {
          resumes: n,
          relaunch: false,
          run_ordinal: status.runOrdinal,
          branch: status.branch,
          t3_error: t3Error ?? (cutAt === null ? null : t3Started(cutAt)),
          ended_in_pass: evidence.endedInPass,
        },
      },
      "advance",
      "session-interrupted",
    ),
  );
  const sent = yield* sendInterruption(ctx, run, threadId, n);
  if (sent === "gone") {
    // The attempt to resume did not happen, so it is one interruption and not two. A stop by
    // hand that landed meanwhile wins, as above.
    const latest = yield* readSeen(ctx, run);
    if (latest.stopRequested) return yield* byHand(latest);
    if (latest.approvedAt !== null) return yield* relaunch(latest, n);
    return yield* goneStuck(latest);
  }
  yield* withLedger(ctx, run, (out) =>
    append(
      out,
      { event: "step_changed", data: { step: `${INTERRUPTION_SENT} ${n}` } },
      "advance",
      "interruption-sent",
    ),
  );
  return { kind: "resumed", resumes: n, limit, status: ended.what } as const;
});

/** What `resumeAfterCooldown` did. */
export type CooldownOutcome =
  /** The session was sent one resume, and the run stays `building`. */
  | { readonly kind: "resumed" }
  /** Its run no longer ended on a rate limit (a newer run, say), or the thread is gone. Nothing was written. */
  | { readonly kind: "unchanged"; readonly why: string };

/**
 * Resumes a session `advance` found rate-limited, once, in its own thread: on `model` when given
 * and not the session's own, which moves the thread to it, else on its own model once the pass has
 * waited out the cooldown. Not an interruption: the count of resumes stays as it is. A resume cut
 * short is sent again by `advance` under the same command id.
 */
export const resumeAfterCooldown = Effect.fn("RunnerBuilding.resumeAfterCooldown")(function* (
  ctx: InterruptContext,
  run: RunId,
  model: Model | null = null,
) {
  yield* checkRepo(ctx, run);
  const seen = yield* readSeen(ctx, run);
  if (seen.finished) return yield* new NotBuildingError({ run });
  const threadId = seen.threadId;
  if (threadId === null) return yield* new NoSessionError({ run });
  // The operator stopped the run after `advance` looked: the next `advance` carries the stop out.
  if (seen.stopRequested)
    return { kind: "unchanged", why: "a stop by hand was requested" } as const;
  if (relaunchDecided(seen)) {
    return { kind: "unchanged", why: "a relaunch is already decided" } as const;
  }
  const gone = { kind: "unchanged", why: "its thread is gone" } as const;
  const status = yield* threadStatus(ctx, threadId);
  if (status === null) return gone;
  const message = status.lastAssistantMessage;
  const ended = endedBadlyNow(seen, status, parseSessionResult(ctx.repo, message ?? undefined));
  const runOrdinal = status.runOrdinal;
  if (
    ended === null ||
    ended.what === null ||
    runOrdinal === null ||
    rateLimitOf(message) === null
  ) {
    return { kind: "unchanged", why: "its thread has moved on since" } as const;
  }
  const moveTo = model !== null && model.model !== seen.model?.model ? model : null;
  const resumes = yield* resumesUsed(ctx, run, seen);
  yield* withLedger(ctx, run, (out) =>
    append(
      out,
      {
        event: "session_rate_limited",
        data: {
          run_ordinal: runOrdinal,
          branch: status.branch,
          resumes,
          ...(moveTo !== null && { model: moveTo.model }),
        },
      },
      "advance",
      "session-rate-limited",
    ),
  );
  if ((yield* sendRateLimited(ctx, run, threadId, runOrdinal, moveTo)) === "gone") return gone;
  yield* withLedger(ctx, run, (out) =>
    append(
      out,
      { event: "step_changed", data: { step: `${RATE_LIMITED_SENT} ${runOrdinal}` } },
      "advance",
      "rate-limited-sent",
    ),
  );
  return { kind: "resumed" } as const;
});

/**
 * The branch a lost thread's work is on, for the relaunch to continue from, read before the
 * decision is written. In order: the pull request's branch for a session that pushes there
 * (`regateBranch`); the newest branch the ledger names; the archived thread's branch; the run's own
 * pull request head if a plain ref name. `null` starts from `base`.
 */
const relaunchBranchOf = Effect.fn("RunnerBuilding.relaunchBranchOf")(function* (
  ctx: BuildingContext,
  run: RunId,
  seen: Seen,
) {
  const regate = regateBranch(seen, run);
  if (regate !== null) return regate;
  if (seen.lastBranch !== null) return seen.lastBranch;
  if (seen.threadId !== null) {
    const thread = yield* ctx.sessions
      .thread(seen.threadId)
      .pipe(Effect.catchIf(isThreadNotFound, () => Effect.succeed(null)));
    if (thread !== null && thread.branch !== null) return thread.branch;
  }
  if (seen.lastPr !== null) {
    const pull = yield* ctx.tracker.pullRequest(seen.lastPr.pr);
    if (pull !== null && !pull.crossRepository && isPlainRefName(pull.headRef)) {
      return pull.headRef;
    }
  }
  return null;
});

/**
 * A relaunch was decided and cut short after the next attempt's ledger was made, and then the
 * operator stopped this run: the stop wins, so that ledger, which `resume` never began, is finished
 * too, or it would hold a slot as an active run. A next attempt that has begun is a run of its own
 * and is left alone (answered `true`). Safe to repeat.
 */
const endUnbegunRelaunch = Effect.fn("RunnerBuilding.endUnbegunRelaunch")(function* (
  ctx: InterruptContext,
  run: RunId,
) {
  const next: RunId = { ...run, attempt: run.attempt + 1 };
  const existing = yield* ledger(() => readRun(ctx.dataDir, next)).pipe(
    Effect.catchTags({ LedgerNotFoundError: () => Effect.succeed(null) }),
  );
  if (existing === null) return false;
  const seen = readProgress(existing.entries);
  if (seen.claimed || seen.state !== null) return true;
  if (seen.finished) return false;
  const out = yield* ledger(() => Ledger.open(ctx.dataDir, next, { clock: ctx.clock }));
  try {
    yield* ledger(() => out.finish("stuck", null, null, makeCause("advance", "stop-requested")));
  } finally {
    out.close();
  }
  return false;
});

/**
 * Writes the operator's `stop_requested` into the next attempt's ledger, once: the stop of a run
 * whose relaunch already started that attempt is meant for the issue's work, which is there now.
 */
const carryStopToNext = Effect.fn("RunnerBuilding.carryStopToNext")(function* (
  ctx: InterruptContext,
  run: RunId,
) {
  const next: RunId = { ...run, attempt: run.attempt + 1 };
  const record = yield* ledger(() => readRun(ctx.dataDir, next));
  const seen = readProgress(record.entries);
  if (seen.finished || seen.stopRequested) return;
  const out = yield* ledger(() => Ledger.open(ctx.dataDir, next, { clock: ctx.clock }));
  try {
    yield* ledger(() =>
      out.append(
        { event: "stop_requested", data: { by: "operator" } },
        makeCause("advance", "stop-requested"),
      ),
    );
  } finally {
    out.close();
  }
});

/**
 * Carries out a relaunch the ledger holds the decision for, in an order a crash can be picked up
 * from: the next attempt's ledger (same `approved <labeled_at>` step), the issue's label back to
 * `triage` (not if the next attempt is already claimed), this run's worktree removed and the run
 * finished without a stuck label, then `resume`. Every part is safe to repeat.
 */
const carryOutRelaunch = Effect.fn("RunnerBuilding.carryOutRelaunch")(function* (
  ctx: InterruptContext,
  run: RunId,
  seen: Seen,
) {
  if (seen.approvedAt === null) {
    return yield* new RelaunchUnsupportedError({ run });
  }
  const labeledAt = seen.approvedAt;
  const next: RunId = { ...run, attempt: run.attempt + 1 };
  const existing = yield* ledger(() => readRun(ctx.dataDir, next)).pipe(
    Effect.catchTags({ LedgerNotFoundError: () => Effect.succeed(null) }),
  );
  const nextSeen = existing === null ? null : readProgress(existing.entries);
  // The label goes back to `triage` only for an attempt `resume` has not begun: once the next
  // attempt is claimed, or has any state, the issue's label is its own.
  const begun = nextSeen !== null && (nextSeen.claimed || nextSeen.state !== null);
  const fresh = yield* ledger(() =>
    existing === null
      ? Ledger.create(ctx.dataDir, next, { clock: ctx.clock })
      : Ledger.open(ctx.dataDir, next, { clock: ctx.clock }),
  );
  try {
    if (nextSeen?.approvedAt == null) {
      yield* recordApproval(fresh, labeledAt, seen.approvedBy, "advance");
    }
  } finally {
    fresh.close();
  }
  if (!begun) yield* ctx.tracker.setState(issueOf(run), "triage");
  yield* withLedger(ctx, run, (out) =>
    Effect.gen(function* () {
      const opened = yield* out.open;
      yield* stopSession(ctx, opened, progressFrom("advance", seen, "building"));
      yield* ledger(() =>
        opened.finish("stuck", null, null, makeCause("advance", "session-interrupted")),
      );
    }),
  );
  return yield* resume({ ...ctx, project: ctx.repoProject }, issueOf(run));
});
