// @effect-diagnostics nodeBuiltinImport:off - a gate lock is a file, checked the way gate.ts makes it.
/**
 * The claim: takes a `ready` issue to `factory:triage` with a run file, launches the `/factory`
 * session and moves the issue to `factory:building`. A fresh start builds only when an instructor
 * applied `factory:ready` and every later edit was an instructor's; otherwise it is `refused`, with
 * a comment posted before the label goes back to `factory:proposed`. Calling it again resumes.
 */
import * as NodeFS from "node:fs";

import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import type { ProjectConfig } from "../config.ts";
import { fallbackOf } from "../cooldown.ts";
import { refusalReason, unapprovedComment, type Refusal } from "../domain/approval.ts";
import { issueBase } from "../domain/base.ts";
import { InvalidTransition, stateLabel, transition } from "../domain/lifecycle.ts";
import { gateLockFile } from "../gate.ts";
import { ledgerCall as ledger, type LedgerError } from "../ledger/errors.ts";
import {
  makeCause,
  type Cause,
  type CauseStep,
  type ClaimRepair,
  type Outcome,
} from "../ledger/events.ts";
import { Ledger } from "../ledger/ledger.ts";
import { MachineLog } from "../ledger/machineLog.ts";
import { field, readRun, type Entry } from "../ledger/read.ts";
import { asciiLower, newRunId, nextAttempt, runIdToString, type RunId } from "../ledger/runId.ts";
import { formatTs } from "../ledger/time.ts";
import { isUtcSecond } from "../tracker/approvalHistory.ts";
import {
  isBranchPath,
  isNotFound,
  isPlainRefName,
  isSafeBranchName,
  sameMachine,
  type BoundGitHub,
  type ClaimComment,
  type OpenPullRequest,
  type GitHubError,
  type IssueDetail,
} from "../tracker/github.ts";
import type {
  FactoryProject,
  FactorySessions,
  MessageRejectedError,
  Model,
  SessionsError,
  ThreadNotFoundError,
} from "../sessions.ts";
import {
  CANNOT_CONFIRM,
  CUT_SHORT_COMMENT,
  LAUNCH_FAILED,
  TEXT_CHANGED,
  baseNotABranch,
  baseNotOnOrigin,
  launchMessage,
  sessionMayExistNote,
  type EarlierRunResume,
  type ExistingPrResume,
} from "./messages.ts";
import { launchable } from "./launchTarget.ts";
import {
  APPROVAL_RECHECKED,
  LAUNCH_BASE,
  LAUNCH_MODEL,
  LAUNCH_PULL_REQUEST,
  LAUNCH_SENDING,
  LAUNCH_SENDING_RESUMED,
  readProgress,
  type Seen,
} from "./progress.ts";
import {
  abandon,
  describe,
  finishBuilding,
  goStuck,
  movedOnByClosing,
  progressFrom,
} from "./run.ts";

/**
 * What the claim asks of the tracker: the subset of `makeGitHub` it calls, with the process
 * runner already supplied (`bindProcess`), so a test can fake it with plain effects. A later
 * step adds the names it calls here and a line to the fake.
 */
export type Tracker = Pick<
  BoundGitHub,
  | "issue"
  | "approval"
  | "claim"
  | "claimWinner"
  | "setState"
  | "assign"
  | "unassign"
  | "postComment"
  | "upsertStatusComment"
  | "newestFactoryComment"
  | "textCheck"
  | "markPrReady"
  | "markPrDraft"
  | "commentOnPr"
  | "pullRequest"
  | "closedBy"
  | "branchTip"
  | "textEditedSince"
  | "openPullRequestsClosing"
>;

/** The runs of an issue before `run` that have a ledger, oldest first, with their lines. */
export const earlierRuns = Effect.fn("RunnerStart.earlierRuns")(function* (
  dataDir: string,
  run: RunId,
): Effect.fn.Return<
  Array<{ readonly id: RunId; readonly entries: ReadonlyArray<Entry> }>,
  LedgerError
> {
  const runs: Array<{ id: RunId; entries: ReadonlyArray<Entry> }> = [];
  for (let attempt = 1; attempt < run.attempt; attempt += 1) {
    const id = newRunId(run.repo, run.issue, attempt);
    const record = yield* ledger(() => readRun(dataDir, id)).pipe(
      Effect.catchTags({ LedgerNotFoundError: () => Effect.succeed(null) }),
    );
    if (record !== null) runs.push({ id, entries: record.entries });
  }
  return runs;
});

/** Whether the factory's own login (`user`, matched without case) opened `pull`. */
export const isOwnPull = (pull: { readonly author: string | null }, user: string): boolean =>
  pull.author !== null && asciiLower(pull.author) === asciiLower(user);

/**
 * Whether a session can be launched onto `pull` and told to push to its branch: it is in this
 * repo, merges into `base`, and its head is a name a command can be handed (`isSafeBranchName`:
 * the head goes into the launch message's `git push`).
 */
export const isResumablePull = (
  pull: { readonly crossRepository: boolean; readonly baseRef: string; readonly headRef: string },
  base: string,
): boolean => !pull.crossRepository && pull.baseRef === base && isSafeBranchName(pull.headRef);

/** The subset of `FactorySessions` the claim calls. */
export type Sessions = Pick<
  FactorySessions["Service"],
  "findProject" | "launch" | "thread" | "archive" | "removeWorktree" | "send"
>;

export interface StartContext {
  /** `owner/name` as the machine config writes it. */
  readonly repo: string;
  /** The login the tracker knows the factory by. */
  readonly trackerUser: string;
  /** The host name, for the `claimed` line and the status comment. */
  readonly machine: string;
  readonly project: ProjectConfig;
  readonly dataDir: string;
  readonly tracker: Tracker;
  /** The local clone the T3 project is rooted at: `WatchedRepo.path`. */
  readonly repoPath: string;
  /** The `GH_CONFIG_DIR` the launch message names. */
  readonly ghConfigDir: string;
  readonly sessions: Sessions;
  /** Unix epoch milliseconds. */
  readonly clock: () => number;
  /**
   * The model a session launched now runs on, given the project's: its fallback while the
   * project's model cools down from a provider rate limit (`cooldown.ts`). Absent is the project's.
   */
  readonly launchModel?: (model: Model) => Model;
}

/** What `start` did. */
export type StartOutcome =
  /** The issue is claimed, its session is launched and the issue is `factory:building`. */
  | { readonly kind: "started"; readonly run: RunId; readonly threadId: string }
  /**
   * The issue was not ours to take. Nothing was written anywhere. `moved` says a person closed
   * the issue, or put it back to `factory:ready` with nobody assigned, which the claim step takes.
   */
  | {
      readonly kind: "skipped";
      readonly reason: string;
      readonly moved?: "closed" | "ready";
      /** Another machine's claim comment won the issue: the machine it names. */
      readonly claimedBy?: string;
      /** The claim took over 5 minutes and gave way, so the issue stays `factory:ready`. */
      readonly gaveWay?: true;
    }
  /** The issue was `ready` but not approved, so it went back to `factory:proposed` with one fixed comment, and no run was made. */
  | { readonly kind: "refused"; readonly reason: string }
  /** The issue went to `stuck`. */
  | { readonly kind: "stuck"; readonly run: RunId; readonly reason: string }
  /**
   * The issue is closed and a person closed it: its unfinished runs are finished and their sessions
   * archived. `mayHaveSession` names runs that sent a launch the ledger never got a thread for, so
   * a session may exist that this could not archive. `error` is why a later run could not be ended
   * after earlier ones were; the next call tries again, and the runs it names are finished.
   */
  | {
      readonly kind: "abandoned";
      readonly mayHaveSession: ReadonlyArray<RunId>;
      readonly error?: StartError;
    };

/** An older unfinished run of the issue has its gate running, so nothing was called or written. */
export class GateRunningError extends Schema.TaggedError<GateRunningError>()("GateRunningError", {
  run: Schema.Struct({ repo: Schema.String, issue: Schema.String, attempt: Schema.Number }),
}) {
  override get message(): string {
    return `the gate of run ${runIdToString(this.run)} is running`;
  }
}

export type StartError =
  | GitHubError
  | LedgerError
  | InvalidTransition
  | GateRunningError
  | SessionsError
  | ThreadNotFoundError
  | MessageRejectedError;

/** An issue as the pass's lines and the skip reasons name it. */
export const mention = (issue: number) => `#${issue}`;

/** What the pass says of a claim that gave way (`gave-way` in `tracker/github.ts`). */
export const CLAIM_GAVE_WAY =
  "not claimed: the claim took over 5 minutes and gave way, a later pass claims it";

/** What the pass says of an issue another machine's claim comment won. */
export const claimedByLine = (machine: string) => `claimed by machine ${machine}`;

/** The logins whose claim comments count beside the repo's members: this one's and the instructors. */
const claimTrusted = (ctx: StartContext): ReadonlyArray<string> => [
  ctx.trackerUser,
  ...ctx.project.instructors,
];

const claimedElsewhere = (machine: string): StartOutcome => ({
  kind: "skipped",
  reason: claimedByLine(machine),
  claimedBy: machine,
});

const skipped = (issue: number, assignees: ReadonlyArray<string>): StartOutcome => ({
  kind: "skipped",
  reason: `issue ${mention(issue)} is already assigned to ${assignees.join(", ")}`,
});

/** Whether `user` is the only assignee. Not `asciiLower`: a Linear user can be a display name. */
export const isOurs = (assignees: ReadonlyArray<string>, user: string) =>
  assignees.length === 1 && assignees[0]!.toLowerCase() === user.toLowerCase();

export const start = Effect.fn("RunnerStart.start")(function* (
  ctx: StartContext,
  issue: number,
): Effect.fn.Return<StartOutcome, StartError, never> {
  const detail = yield* ctx.tracker.issue(issue);
  // A closed issue is never claimed, whatever its label says: its unfinished runs are ended.
  if (detail.closed) return yield* abandonClosed(ctx, issue);
  if (detail.state === "ready" && detail.assignees.length === 0) {
    return yield* startFresh(ctx, issue, detail);
  }
  if (detail.state === "ready") return skipped(issue, detail.assignees);
  return yield* goOn(ctx, issue, detail);
});

/**
 * `start` for a claim already made, which never makes one: what the pass calls for a run it
 * knows of and for a `triage` issue of ours with no run. An issue someone put back to
 * `factory:ready` is left to the claim step, which checks the pause, the limit and the blockers
 * first, and which finishes the issue's older runs when it claims it.
 */
export const resume = Effect.fn("RunnerStart.resume")(function* (
  ctx: StartContext,
  issue: number,
): Effect.fn.Return<StartOutcome, StartError, never> {
  const detail = yield* ctx.tracker.issue(issue);
  if (detail.closed) return yield* abandonClosed(ctx, issue);
  if (detail.state === "ready" && detail.assignees.length === 0) {
    return { kind: "skipped", reason: `issue ${mention(issue)} is ready again`, moved: "ready" };
  }
  if (detail.state === "ready") return skipped(issue, detail.assignees);
  return yield* goOn(ctx, issue, detail);
});

const closed = (issue: number): StartOutcome => ({
  kind: "skipped",
  reason: `issue ${mention(issue)} is closed`,
  moved: "closed",
});

/**
 * What `start` does with a closed issue: every unfinished run that a person's closing ended is
 * abandoned (see `abandon`), oldest first, and nothing is claimed or written on GitHub. A run in
 * `pr-open` or `stuck`, or one whose own merged pull request closed the issue, is left alone. While
 * any such run's gate is running none is touched (`GateRunningError`).
 */
const abandonClosed = Effect.fn("RunnerStart.abandonClosed")(function* (
  ctx: StartContext,
  issue: number,
): Effect.fn.Return<StartOutcome, StartError> {
  const next = nextAttempt(ctx.dataDir, ctx.repo, String(issue));
  const unfinished = yield* unfinishedRuns(
    ctx,
    issue,
    next,
    (seen) => seen.state !== "pr-open" && seen.state !== "stuck",
  );
  let abandoned = false;
  const mayHaveSession: Array<RunId> = [];
  for (const { id, seen } of unfinished) {
    const ended = yield* Effect.result(
      Effect.gen(function* () {
        const closing = yield* movedOnByClosing(ctx, seen, true);
        if (closing.kind !== "persons-move") return "left" as const;
        const out = yield* ledger(() => Ledger.open(ctx.dataDir, id, { clock: ctx.clock }));
        try {
          return (yield* abandon(ctx, out, id, seen, "start")) ? "may-have-session" : "ended";
        } finally {
          out.close();
        }
      }),
    );
    if (ended._tag === "Failure") {
      if (!abandoned) return yield* ended.failure;
      return { kind: "abandoned", mayHaveSession, error: ended.failure };
    }
    if (ended.success === "left") continue;
    if (ended.success === "may-have-session") mayHaveSession.push(id);
    abandoned = true;
  }
  return abandoned ? { kind: "abandoned", mayHaveSession } : closed(issue);
});

/**
 * Goes on from the ledger with an issue that is not `ready`: a `triage` issue of ours, or a
 * `stuck` issue whose newest run gave up and was cut short before its summary line (the label
 * moves before the release and the status comment, so a failure in between leaves the run
 * unfinished in `triage`), which finishes the stuck path.
 */
const goOn = Effect.fn("RunnerStart.goOn")(function* (
  ctx: StartContext,
  issue: number,
  detail: IssueDetail,
): Effect.fn.Return<StartOutcome, StartError> {
  if (detail.state === "triage" && isOurs(detail.assignees, ctx.trackerUser)) {
    // A login several machines share is "ours" on each of them: only the machine whose claim
    // comment won goes on, or any machine when there is none (a claim from before comments).
    // `factory.owner` lets one machine alone work the repo, so no comment decides there.
    if (ctx.project.owner === null) {
      const yielded = yield* yieldToClaim(ctx, issue, "start");
      if (yielded !== null) return claimedElsewhere(yielded.machine);
    }
    return yield* resumeStart(ctx, issue, detail);
  }
  if (detail.state === "stuck" && (yield* stuckCutShort(ctx, issue))) {
    return yield* resumeStart(ctx, issue, detail);
  }
  return {
    kind: "skipped",
    reason: `issue ${mention(issue)} is not factory:triage assigned to ${ctx.trackerUser} alone`,
  };
});

/** Whether the issue's newest run is unfinished, still in `triage`, and its ledger says it went stuck. */
const stuckCutShort = Effect.fn("RunnerStart.stuckCutShort")(function* (
  ctx: StartContext,
  issue: number,
): Effect.fn.Return<boolean, LedgerError> {
  const next = nextAttempt(ctx.dataDir, ctx.repo, String(issue));
  if (next === 1) return false;
  const newest = newRunId(ctx.repo, String(issue), next - 1);
  const seen = readProgress((yield* ledger(() => readRun(ctx.dataDir, newest))).entries);
  return !seen.finished && seen.stuck !== null && (seen.state === null || seen.state === "triage");
});

const startFresh = Effect.fn("RunnerStart.startFresh")(function* (
  ctx: StartContext,
  issue: number,
  detail: IssueDetail,
): Effect.fn.Return<StartOutcome, StartError> {
  // Before the claim: nothing is written for an issue that is not approved except the
  // explanation.
  const approval = yield* ctx.tracker.approval(issue, ctx.project.instructors);
  if (approval.kind === "refused") return yield* refuseStart(ctx, issue, approval.refusal);
  const { labeledAt, labeledBy } = approval;
  // Also before the claim: with T3 out of reach nothing is claimed, so no issue is left in
  // `triage` for a launch that cannot be sent.
  const project = yield* ctx.sessions.findProject(ctx.repoPath);
  const run = newRunId(ctx.repo, String(issue), nextAttempt(ctx.dataDir, ctx.repo, String(issue)));
  // Before the claim, so a crash after it cannot leave an older run stranded in front of a
  // resume. An instructor applied the label again, which is what began this attempt.
  yield* finishOlderRuns(ctx, issue, run.attempt, labeledBy === "" ? null : labeledBy);
  const claimed = yield* ctx.tracker
    .claim(issue, ctx.trackerUser, "ready", "triage", {
      machine: ctx.machine,
      since: labeledAt,
      trusted: claimTrusted(ctx),
    })
    .pipe(
      // The edit may have landed all the same. See `repairClaim`.
      Effect.catch((error) => repairClaim(ctx, issue, error)),
    );
  if (claimed.kind === "skipped-assigned") return skipped(issue, claimed.assignees);
  if (claimed.kind === "claimed-elsewhere") return claimedElsewhere(claimed.machine);
  if (claimed.kind === "gave-way") {
    return { kind: "skipped", reason: CLAIM_GAVE_WAY, gaveWay: true };
  }
  const out = yield* ledger(() => Ledger.create(ctx.dataDir, run, { clock: ctx.clock }));
  try {
    yield* recordApproval(out, labeledAt, labeledBy === "" ? null : labeledBy, "start");
    return yield* begin(ctx, issue, detail, run, out, project);
  } finally {
    out.close();
  }
});

/**
 * What to do about a claim call that returned `error`: GitHub can apply the edit and still answer
 * with an error, leaving the issue in `factory:triage` with no assignee, where no pass looks. The
 * issue is read again. A whole claim, or one only missing the assignee, is finished. Otherwise it
 * loses our assignee before it goes to `factory:proposed`, so it is never `proposed` and assigned.
 */
const repairClaim = Effect.fn("RunnerStart.repairClaim")(function* (
  ctx: StartContext,
  issue: number,
  error: GitHubError,
): Effect.fn.Return<
  { readonly kind: "claimed" } | { readonly kind: "claimed-elsewhere"; readonly machine: string },
  GitHubError
> {
  const now = yield* ctx.tracker.issue(issue).pipe(Effect.option);
  if (now._tag === "None") return yield* error;
  const seen = now.value;
  const user = ctx.trackerUser;
  const ours = isOurs(seen.assignees, user);
  const nobody = seen.assignees.length === 0;
  const swapped = seen.state === "triage" || seen.state === "ready" || seen.state === null;
  // Still `factory:ready` with no assignee: nothing was applied.
  if (seen.closed || !swapped || !(ours || nobody) || (seen.state === "ready" && nobody)) {
    return yield* error;
  }
  // A login several machines share is "ours" when another machine's claim landed: the comment says.
  const holder = yield* ctx.tracker.claimWinner(issue, claimTrusted(ctx)).pipe(Effect.option);
  if (holder._tag === "None") return yield* error;
  if (holder.value !== null && !sameMachine(holder.value.machine, ctx.machine)) {
    return { kind: "claimed-elsewhere", machine: holder.value.machine };
  }
  const ok = <A>(call: Effect.Effect<A, GitHubError>) =>
    call.pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
  const assigned = nobody ? yield* ok(ctx.tracker.assign(issue, user)) : true;
  const labelled =
    assigned && (seen.state === "triage" || (yield* ok(ctx.tracker.setState(issue, "triage"))));
  if (assigned && labelled) {
    yield* recordClaimRepair(ctx, issue, "finished");
    return { kind: "claimed" };
  }
  // Both are tried, so a label that will not move does not leave our assignee on the issue.
  const off = yield* ok(ctx.tracker.unassign(issue, user));
  const moved = yield* ok(ctx.tracker.setState(issue, "proposed"));
  if (off && moved) {
    yield* ok(ctx.tracker.postComment(issue, CUT_SHORT_COMMENT));
    yield* recordClaimRepair(ctx, issue, "released");
  }
  return yield* error;
});

/**
 * Writes a `claim_repaired` line to the machine log. A log that cannot be written is not worth
 * failing the claim for, so it is logged as a warning that names the issue.
 */
const recordClaimRepair = (
  ctx: StartContext,
  issue: number,
  outcome: ClaimRepair,
): Effect.Effect<void> =>
  ledger(() => {
    const log = MachineLog.open(ctx.dataDir, { clock: ctx.clock });
    try {
      log.append({
        event: "claim_repaired",
        data: { repo: ctx.repo, issue: String(issue), outcome },
      });
    } finally {
      log.close();
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning(
        `claim_repaired (${outcome}) for ${ctx.repo}${mention(issue)} could not be written to the machine log`,
        cause,
      ),
    ),
  );

/** How long a refusal comment that has no label time to be compared with counts as recent. */
const RECENT_MS = 60 * 60 * 1000;

/** The moment `ms`, in GitHub's `YYYY-MM-DDTHH:MM:SSZ` form, so it compares as text with GitHub's times. */
export const utcSecond = (ms: number): string => `${formatTs(ms).slice(0, 19)}Z`;

/**
 * Whether the issue's newest factory comment says `text` with a creation time in GitHub's
 * `YYYY-MM-DDTHH:MM:SSZ` form, so the time compares as text with a label time. A comment whose
 * time is not in that form never counts as already said.
 */
export const newestSays = <C extends { readonly body: string; readonly createdAt: string }>(
  newest: C | null,
  text: string,
): newest is C => newest !== null && newest.body === text && isUtcSecond(newest.createdAt);

/**
 * Whether the issue's newest factory comment already says this refusal for the label it was judged
 * on: same text, and newer than the label event (an older comment was about an earlier refusal). A
 * refusal without a label time is matched on text alone, for a comment under an hour old by the
 * context's clock. A comment whose time is not GitHub's form never counts.
 */
const alreadySaid = (
  ctx: StartContext,
  refusal: Refusal,
  text: string,
  newest: { readonly body: string; readonly createdAt: string } | null,
): boolean => {
  if (!newestSays(newest, text)) return false;
  if ("labeledAt" in refusal) return newest.createdAt > refusal.labeledAt;
  return newest.createdAt > utcSecond(ctx.clock() - RECENT_MS);
};

/**
 * Takes a refused `ready` issue back to `proposed`: the comment first, then the label. There is
 * no run, so nothing is written to a ledger. A label call that fails leaves the issue `ready`
 * and the next pass tries it again. The comment is not posted again while it is still the
 * issue's newest factory comment.
 */
const refuseStart = Effect.fn("RunnerStart.refuseStart")(function* (
  ctx: StartContext,
  issue: number,
  refusal: Refusal,
): Effect.fn.Return<StartOutcome, GitHubError | InvalidTransition> {
  const reason = refusalReason(refusal);
  const moved = yield* Effect.fromResult(transition("ready", { kind: "unapproved", reason }));
  for (const action of moved.actions) {
    switch (action.kind) {
      case "post-unapproved": {
        const text = unapprovedComment(refusal);
        const newest = yield* ctx.tracker.newestFactoryComment(issue);
        if (!alreadySaid(ctx, refusal, text, newest)) {
          yield* ctx.tracker.postComment(issue, text);
        }
        break;
      }
      case "set-label":
        yield* ctx.tracker.setState(issue, action.state);
        break;
      default:
        return yield* new InvalidTransition({ state: "ready", event: "unapproved" });
    }
  }
  return { kind: "refused", reason: `issue ${mention(issue)} was not approved: ${reason}` };
});

const resumeStart = Effect.fn("RunnerStart.resumeStart")(function* (
  ctx: StartContext,
  issue: number,
  detail: IssueDetail,
): Effect.fn.Return<StartOutcome, StartError> {
  const next = nextAttempt(ctx.dataDir, ctx.repo, String(issue));
  if (next > 1) {
    const newest = newRunId(ctx.repo, String(issue), next - 1);
    const seen = readProgress((yield* ledger(() => readRun(ctx.dataDir, newest))).entries);
    // A run already in `stuck` is over; it is finished below with the others. A run still in
    // `triage` (or not yet in any state) was cut short, so `begin` goes on from what its
    // ledger records, whatever it was approved on. Any other unfinished run is left to the
    // step that owns its state.
    if (!seen.finished && seen.state !== "stuck") {
      if (seen.state === null || seen.state === "triage") {
        const out = yield* ledger(() => Ledger.open(ctx.dataDir, newest, { clock: ctx.clock }));
        try {
          return yield* begin(ctx, issue, detail, newest, out, undefined);
        } finally {
          out.close();
        }
      }
      return {
        kind: "skipped",
        reason: `issue ${mention(issue)} has an unfinished run in state ${seen.state ?? "none"}`,
      };
    }
  }
  const run = newRunId(ctx.repo, String(issue), next);
  yield* finishOlderRuns(ctx, issue, next, null);
  const out = yield* ledger(() => Ledger.create(ctx.dataDir, run, { clock: ctx.clock }));
  try {
    return yield* begin(ctx, issue, detail, run, out, undefined);
  } finally {
    out.close();
  }
});

/**
 * Records the claim the tracker call has made, then goes on from the ledger: launch the session,
 * look at the issue text once more, move the issue to `building`. A run with no record of what
 * approved it fails closed. The record is written before any launch, so with no session in the
 * ledger no launch was sent. `project` is `undefined` on a resume.
 */
const begin = Effect.fn("RunnerStart.begin")(function* (
  ctx: StartContext,
  issue: number,
  detail: IssueDetail,
  run: RunId,
  out: Ledger,
  project: FactoryProject | null | undefined,
): Effect.fn.Return<StartOutcome, StartError> {
  const seen = readProgress((yield* ledger(() => readRun(ctx.dataDir, run))).entries);
  const claimed = yield* Effect.fromResult(transition("ready", { kind: "claimed" }));
  const claim = makeCause("start", "claimed");
  if (!seen.claimed) {
    yield* ledger(() =>
      out.append(
        { event: "claimed", data: { machine: ctx.machine, github_user: ctx.trackerUser } },
        claim,
      ),
    );
  }
  if (seen.state === null) {
    yield* ledger(() =>
      out.append({ event: "state_changed", data: { from: "ready", to: claimed.next } }, claim),
    );
  }
  const at = progressFrom("start", seen, claimed.next);
  // A decision to give up that is already in the ledger stands.
  if (seen.stuck !== null) {
    yield* goStuck(ctx, issue, out, at, "stuck-resumed", { reason: seen.stuck });
    return { kind: "stuck", run, reason: seen.stuck };
  }
  // The record is written before any launch: with no session either, nothing was sent, so
  // nothing is launched here (a session on unconfirmed text, only to archive it).
  if (seen.approvedAt === null && seen.threadId === null) {
    yield* goStuck(ctx, issue, out, at, "approval-unconfirmed", { reason: CANNOT_CONFIRM });
    return { kind: "stuck", run, reason: CANNOT_CONFIRM };
  }
  // A launch not in the ledger may still have started a thread: the call can fail on our side after
  // T3 acted. Launching again under the same command id starts the session or returns the thread T3
  // already started. The text is looked at after the launch, never before: skipping the launch for
  // a changed text could leave such a thread running with nobody to stop it.
  let threadId = seen.threadId;
  if (threadId === null) {
    const launched = yield* launchSession(ctx, issue, detail, run, out, seen, project);
    if (!launched.ok) {
      yield* goStuck(ctx, issue, out, at, "launch-failed", {
        reason: launched.reason ?? LAUNCH_FAILED,
        detail: launched.detail,
      });
      return { kind: "stuck", run, reason: launched.detail };
    }
    threadId = launched.threadId;
    // What the ledger now records, for a stop that has to remove the worktree while T3 may not
    // report its path yet.
    at.worktree = launched.worktree;
  }
  at.threadId = threadId;
  if (seen.approvedAt === null) {
    yield* goStuck(ctx, issue, out, at, "approval-unconfirmed", { reason: CANNOT_CONFIRM });
    return { kind: "stuck", run, reason: CANNOT_CONFIRM };
  }
  // The session reads the issue live a few seconds after the approval, and the claim has told
  // anyone watching the labels that it is starting. Check the text again now that the session
  // exists: a change by someone who is not an instructor stops the run. A failed read is an
  // error, and the next call checks again; the step says the check passed.
  if (!seen.rechecked) {
    const check = yield* ctx.tracker.textCheck(issue, seen.approvedAt, ctx.project.instructors);
    // A history that cannot be judged counts as changed.
    if (check !== "unchanged") {
      yield* goStuck(ctx, issue, out, at, "text-changed-before-start", { reason: TEXT_CHANGED });
      return { kind: "stuck", run, reason: TEXT_CHANGED };
    }
    yield* ledger(() =>
      out.append(
        { event: "step_changed", data: { step: APPROVAL_RECHECKED } },
        makeCause("start", "approval-rechecked"),
      ),
    );
  }
  if (at.state !== "building") yield* finishBuilding(ctx, issue, out, at);
  return { kind: "started", run, threadId };
});

/** A launch not sent or refused. `reason` is the public line when it is not `LAUNCH_FAILED`. */
type Launch =
  | { readonly ok: true; readonly threadId: string; readonly worktree: string | null }
  | { readonly ok: false; readonly detail: string; readonly reason?: string };

/**
 * Sends the launch. `launch-sending` is written once per run before the first call, so a launch
 * that fails on our side is known to have been sent; the run's command id makes a resend return the
 * thread T3 already made. What the launch starts from (`resumeFrom`) and the run's base are decided
 * once and recorded in steps, so every resend is the same request.
 */
const launchSession = Effect.fn("RunnerStart.launchSession")(function* (
  ctx: StartContext,
  issue: number,
  detail: IssueDetail,
  run: RunId,
  out: Ledger,
  seen: Seen,
  found: FactoryProject | null | undefined,
): Effect.fn.Return<Launch, StartError> {
  const commandId = `softfac:${runIdToString(run)}:launch`;
  const target = launchable(
    found === undefined ? yield* ctx.sessions.findProject(ctx.repoPath) : found,
  );
  if (Result.isFailure(target)) {
    const missing = target.failure;
    return {
      ok: false,
      detail: seen.launchSent ? sessionMayExistNote(missing, commandId) : missing,
    };
  }
  const project = target.success;
  // A launch sent again keeps the model and the base the first send was decided on.
  const model = seen.launchSent
    ? seen.launchModel === null
      ? project.model
      : fallbackOf(project.model, seen.launchModel)
    : (ctx.launchModel?.(project.model) ?? project.model);
  const based = seen.launchSent
    ? ({ ok: true, base: seen.launchBase ?? ctx.project.base } as const)
    : yield* runBase(ctx, detail);
  if (!based.ok) return { ok: false, reason: based.reason, detail: based.reason };
  const base = based.base;
  const named = base !== ctx.project.base;
  const resumed = seen.launchSent
    ? seen.launchResumedFrom === null
      ? null
      : yield* recordedResume(ctx, run, seen.launchResumedFrom, seen.launchResumedPr)
    : yield* resumeFrom(ctx, run, issue, base);
  if (!seen.launchSent) {
    // Also over a step a crash left before `launch-sending`, which a resend would read instead.
    if (model.model !== project.model.model || seen.launchModel !== null) {
      yield* ledger(() =>
        out.append(
          { event: "step_changed", data: { step: `${LAUNCH_MODEL}${model.model}` } },
          makeCause("start", "launch-sending"),
        ),
      );
    }
    if (named) {
      yield* ledger(() =>
        out.append(
          { event: "step_changed", data: { step: `${LAUNCH_BASE}${base}` } },
          makeCause("start", "launch-sending"),
        ),
      );
    }
    if (resumed?.after === "existing-pr") {
      yield* ledger(() =>
        out.append(
          {
            event: "step_changed",
            data: { step: `${LAUNCH_PULL_REQUEST}${resumed.branch} ${resumed.prUrl}` },
          },
          makeCause("start", "launch-sending"),
        ),
      );
    }
    yield* ledger(() =>
      out.append(
        {
          event: "step_changed",
          data: {
            step: resumed === null ? LAUNCH_SENDING : `${LAUNCH_SENDING_RESUMED}${resumed.branch}`,
          },
        },
        makeCause("start", "launch-sending"),
      ),
    );
  }
  const launched = yield* Effect.result(
    ctx.sessions.launch({
      commandId,
      projectId: project.id,
      title: `${ctx.repo}#${issue} ${detail.title}`,
      baseRef: resumed === null ? base : resumed.branch,
      message: launchMessage(
        ctx.repo,
        issue,
        ctx.trackerUser,
        resumed ?? undefined,
        named ? base : undefined,
      ),
      model,
      ...(resumed?.after === "existing-pr" && { pullRequestUrl: resumed.prUrl }),
    }),
  );
  if (launched._tag === "Failure") {
    return {
      ok: false,
      detail: sessionMayExistNote(describe(launched.failure.cause), commandId),
    };
  }
  const { threadId, worktreePath, branch } = launched.success;
  yield* ledger(() =>
    out.append(
      {
        event: "session_launched",
        data: {
          thread_id: threadId,
          worktree: worktreePath,
          branch,
          model_instance: model.instanceId,
          model: model.model,
          model_options: model.options ?? null,
          resumed_from:
            resumed === null ? null : { run: runIdToString(resumed.run), branch: resumed.branch },
          base,
          title: detail.title,
        },
      },
      makeCause("start", resumed === null ? "session-launched" : "resumed-from-branch"),
    ),
  );
  return { ok: true, threadId, worktree: worktreePath };
});

/**
 * The first line of an attempt's ledger, the `approved <labeled_at>` step: what the attempt was
 * approved on, for the text checks that come later, with the instructor whose label it was
 * (`actor` on the cause) when the approval names one. The claim writes it for the run it starts;
 * a relaunch writes the same line for the next attempt, carrying this run's approval over.
 */
export const recordApproval = (
  out: Ledger,
  labeledAt: string,
  labeledBy: string | null,
  step: CauseStep,
): Effect.Effect<void, LedgerError> =>
  ledger(() =>
    out.append(
      { event: "step_changed", data: { step: `approved ${labeledAt}` } },
      makeCause(step, "approved", labeledBy === null ? {} : { actor: labeledBy }),
    ),
  );

/** The run before `run` and its ledger lines; null for a first attempt or an earlier run with no ledger. */
export const previousRun = Effect.fn("RunnerStart.previousRun")(function* (
  ctx: StartContext,
  run: RunId,
) {
  if (run.attempt < 2) return null;
  const id = newRunId(run.repo, run.issue, run.attempt - 1);
  const record = yield* ledger(() => readRun(ctx.dataDir, id)).pipe(
    Effect.catchTags({ LedgerNotFoundError: () => Effect.succeed(null) }),
  );
  return record === null ? null : { id, entries: record.entries };
});

/**
 * What a launch continues from, with the run its `session_launched` line names as `resumed_from`:
 * the earlier attempt whose branch it continues, or, for an open pull request, this run itself, as
 * a re-gate's session names it, so the line reads the same on every machine. Either way the session
 * pushes to that branch (`Seen.resumedFrom`).
 */
type Resumed = EarlierRunResume | (ExistingPrResume & { readonly run: RunId });

/**
 * The resume a `launch-sending resumed-from <branch>` step decided, for a launch sent again. The
 * words of the first message are the same as the first send's: what the earlier attempt ended
 * with is in its ledger, which does not change, and a pull request decided with the branch is in
 * the `launch-pull-request` step before it (`Seen.launchResumedPr`).
 */
const recordedResume = Effect.fn("RunnerStart.recordedResume")(function* (
  ctx: StartContext,
  run: RunId,
  branch: string,
  prUrl: string | null,
): Effect.fn.Return<Resumed, LedgerError> {
  if (prUrl !== null) return { after: "existing-pr", branch, prUrl, run };
  const previous = yield* previousRun(ctx, run);
  return {
    run: previous?.id ?? newRunId(run.repo, run.issue, Math.max(1, run.attempt - 1)),
    branch,
    after: (previous === null ? null : continuation(previous.entries)?.after) ?? "time-limit",
  };
});

/**
 * What the new attempt `run` continues from. First the issue's open pull request, if an earlier
 * attempt left one (`existingPullRequest`): it is the work, and a start from `base` beside it would
 * open a second. Then the branch of an attempt that hit its time limit or was relaunched (see
 * `continuation`). Null is a plain start from `base`. `origin` is the only source of the work.
 */
const resumeFrom = Effect.fn("RunnerStart.resumeFrom")(function* (
  ctx: StartContext,
  run: RunId,
  issue: number,
  base: string,
): Effect.fn.Return<Resumed | null, StartError> {
  const earlier = yield* earlierRuns(ctx.dataDir, run);
  const pull = yield* existingPullRequest(ctx, earlier, issue, base);
  if (pull !== null) return { after: "existing-pr", branch: pull.branch, prUrl: pull.url, run };
  const previous = earlier.find((found) => found.id.attempt === run.attempt - 1);
  if (previous === undefined) return null;
  const found = continuation(previous.entries);
  // The branch goes to GitHub's ref path, to T3's git as a ref, and into the `git push` the
  // launch message tells the session to run: only a plain branch name is resumed from.
  const branches = found === null ? [] : found.branches.filter(isSafeBranchName);
  if (found === null || branches.length === 0) return null;
  const approvedAt = readProgress(previous.entries).approvedAt;
  if (approvedAt === null) return null;
  if (yield* ctx.tracker.textEditedSince(issue, approvedAt)) return null;
  for (const branch of branches) {
    const tip = yield* Effect.result(ctx.tracker.branchTip(branch));
    if (tip._tag === "Success") return { run: previous.id, branch, after: found.after };
    if (!isNotFound(tip.failure)) return yield* tip.failure;
  }
  return null;
});

/**
 * The open pull request an earlier attempt of the issue left, if any, and its branch. The ledger
 * first (newest `pr_opened`, then `pr_left`, of each `earlier` run) when GitHub still has it open
 * in this repo onto `base` on a branch a session can push to (`isResumablePull`). Then the newest
 * open one by the factory's login that closes the issue, which GitHub links only onto the default.
 */
const existingPullRequest = Effect.fn("RunnerStart.existingPullRequest")(function* (
  ctx: StartContext,
  earlier: ReadonlyArray<{ readonly entries: ReadonlyArray<Entry> }>,
  issue: number,
  base: string,
): Effect.fn.Return<{ readonly branch: string; readonly url: string } | null, StartError> {
  for (const { entries } of earlier.toReversed()) {
    const seen = readProgress(entries);
    // The one the session reported first, then the one a stop found it had left.
    for (const recorded of [seen.lastPr, seen.left.at(-1) ?? null]) {
      if (recorded === null) continue;
      const pull = yield* ctx.tracker.pullRequest(recorded.pr);
      if (pull !== null && pull.open && isResumablePull(pull, base)) {
        return { branch: pull.headRef, url: recorded.url };
      }
    }
  }
  const own = (yield* ctx.tracker.openPullRequestsClosing(issue)).filter(
    (pull) => isOwnPull(pull, ctx.trackerUser) && isResumablePull(pull, base),
  );
  const newest = own.reduce<OpenPullRequest | null>(
    (best, pull) => (best === null || pull.number > best.number ? pull : best),
    null,
  );
  return newest === null ? null : { branch: newest.headRef, url: newest.url };
});

/**
 * The branch the run lands on: the issue's `## Base` (`issueBase`), else `factory.base`. A named
 * branch must be a plain ref name and be on `origin` (`branchTip`); either failing is a refusal
 * with its public reason. A lookup that fails in any other way is an error, and the next pass
 * asks again.
 */
const runBase = Effect.fn("RunnerStart.runBase")(function* (
  ctx: StartContext,
  detail: IssueDetail,
) {
  const named = issueBase(detail.body);
  if (named === null || named === ctx.project.base) {
    return { ok: true, base: ctx.project.base } as const;
  }
  if (!isPlainRefName(named) || !isBranchPath(named)) {
    return { ok: false, reason: baseNotABranch(named) } as const;
  }
  const tip = yield* Effect.result(ctx.tracker.branchTip(named));
  if (tip._tag === "Success") return { ok: true, base: named } as const;
  // A name the tracker refuses is not a branch name either, whatever rule refused it.
  if (tip.failure._tag === "GitHubInvalidArgument") {
    return { ok: false, reason: baseNotABranch(named) } as const;
  }
  if (isNotFound(tip.failure)) return { ok: false, reason: baseNotOnOrigin(named) } as const;
  return yield* tip.failure;
});

/**
 * What the attempt before the new one left to continue from: its session's branch, then its own
 * `resumedFrom` for when origin lacks the first (a resumed session pushes there). Null unless it
 * hit its time limit (which wins) or was relaunched, and after `needs-info`: its questions end it.
 * A time-limit branch is the `session_launched` line's, else the `stuck` line's.
 */
const continuation = (
  entries: ReadonlyArray<Entry>,
): {
  readonly branches: ReadonlyArray<string>;
  readonly after: "time-limit" | "interrupted";
} | null => {
  if (entries.some((e) => e.event === "finished" && field(e.data, "outcome") === "needs-info")) {
    return null;
  }
  const seen = readProgress(entries);
  const withResumed = (branch: string | null, after: "time-limit" | "interrupted") => {
    const branches = [branch, seen.resumedFrom].filter((b): b is string => b !== null);
    return branches.length === 0 ? null : { branches: [...new Set(branches)], after };
  };
  const branchOn = (event: string, entry: Entry): string | null => {
    const branch = entry.event === event ? field(entry.data, "branch") : undefined;
    return typeof branch === "string" ? branch : null;
  };
  if (entries.some((e) => e.event === "stuck" && e.cause?.reason === "time-limit")) {
    const launched = entries.map((e) => branchOn("session_launched", e)).find((b) => b !== null);
    const recorded = entries.map((e) => branchOn("stuck", e)).findLast((b) => b !== null);
    return withResumed(launched ?? recorded ?? null, "time-limit");
  }
  const relaunch = seen.interruption;
  if (relaunch === null || !relaunch.relaunch) return null;
  return withResumed(relaunch.branch, "interrupted");
};

/**
 * The unfinished runs of the issue before attempt `below` that `wanted` keeps, oldest first
 * (softfac's `unfinished_runs`). While the gate of any run it keeps is running, none of them is
 * touched (`GateRunningError`).
 */
const unfinishedRuns = Effect.fn("RunnerStart.unfinishedRuns")(function* (
  ctx: StartContext,
  issue: number,
  below: number,
  wanted: (seen: Seen) => boolean,
) {
  const runs: Array<{ id: RunId; seen: Seen }> = [];
  const earlier = yield* earlierRuns(ctx.dataDir, newRunId(ctx.repo, String(issue), below));
  for (const { id, entries } of earlier) {
    const seen = readProgress(entries);
    if (seen.finished || !wanted(seen)) continue;
    if (NodeFS.existsSync(gateLockFile(ctx.dataDir, id))) {
      return yield* new GateRunningError({ run: id });
    }
    runs.push({ id, seen });
  }
  return runs;
});

/**
 * Finishes every unfinished run of the issue before attempt `below`, by its last state, so it is
 * not polled again and cannot write to an issue a newer attempt now owns. While the gate of any
 * of them is running, none of them is finished. A run that names a session or a pull request is
 * finished in the ledger only: nothing is archived or drafted.
 */
const finishOlderRuns = Effect.fn("RunnerStart.finishOlderRuns")(function* (
  ctx: StartContext,
  issue: number,
  below: number,
  appliedBy: string | null,
) {
  const older = yield* unfinishedRuns(ctx, issue, below, () => true);
  for (const { id, seen } of older) {
    const outcome = outcomeOf(seen.state);
    // A person relabelled the issue, so a new attempt began: `appliedBy` is the instructor
    // whose `factory:ready` label began it, when this start is the one that was approved.
    const cause: Cause = makeCause(
      "start",
      "new-attempt-started",
      appliedBy === null ? {} : { actor: appliedBy, label: stateLabel("ready") },
    );
    const out = yield* ledger(() => Ledger.open(ctx.dataDir, id, { clock: ctx.clock }));
    try {
      yield* ledger(() => out.finish(outcome, null, null, cause));
    } finally {
      out.close();
    }
  }
});

/** How `finishOlderRuns` and `finishRunsBefore` end a run left in `state`. */
const outcomeOf = (state: Seen["state"]): Outcome =>
  state === "needs-info" ? "needs-info" : state === "pr-open" ? "pr-open" : "stuck";

/**
 * Finishes the issue's unfinished runs claimed before `winner`, another machine's claim comment,
 * as `finishOlderRuns` does: the ledger only, nothing on GitHub. A run with no claim time counts
 * as claimed before. The runs it finished, oldest first.
 */
const finishRunsBefore = Effect.fn("RunnerStart.finishRunsBefore")(function* (
  ctx: StartContext,
  issue: number,
  winner: ClaimComment,
  step: CauseStep,
) {
  const at = Date.parse(winner.createdAt);
  const next = nextAttempt(ctx.dataDir, ctx.repo, String(issue));
  const older = yield* unfinishedRuns(
    ctx,
    issue,
    next,
    (seen) => seen.claimedMs === null || seen.claimedMs < at,
  );
  for (const { id, seen } of older) {
    const out = yield* ledger(() => Ledger.open(ctx.dataDir, id, { clock: ctx.clock }));
    try {
      yield* ledger(() =>
        out.finish(outcomeOf(seen.state), null, null, makeCause(step, "claimed-elsewhere")),
      );
    } finally {
      out.close();
    }
  }
  return older.map(({ id }) => id);
});

/**
 * When another machine's claim comment holds the issue's current claim, finishes this machine's
 * runs of it claimed before that comment (`finishRunsBefore`) and names the machine. Null when this
 * machine's claim holds it, or there is no claim comment.
 */
export const yieldToClaim = Effect.fn("RunnerStart.yieldToClaim")(function* (
  ctx: StartContext,
  issue: number,
  step: CauseStep = "pass",
): Effect.fn.Return<
  { readonly machine: string; readonly finished: ReadonlyArray<RunId> } | null,
  StartError
> {
  const winner = yield* ctx.tracker.claimWinner(issue, claimTrusted(ctx));
  if (winner === null || sameMachine(winner.machine, ctx.machine)) return null;
  const finished = yield* finishRunsBefore(ctx, issue, winner, step);
  return { machine: winner.machine, finished };
});
