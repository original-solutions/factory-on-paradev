/**
 * What a run's ledger already records, for a step that must not do twice what is done. The part
 * of softfac's `runner/progress.rs` the claim, the build and the gate need; later steps add what
 * they read.
 */

import { fallbackOf } from "../cooldown.ts";
import { isState, type State } from "../domain/lifecycle.ts";
import { dataField, type Entry } from "../ledger/read.ts";
import { runIdToString, type RunId } from "../ledger/runId.ts";
import { launchBranchOf, type Model } from "../sessions.ts";
import { isCommitId } from "../text.ts";
import type { CheckStatus } from "../tracker/github.ts";

/** A passing attempt as the ledger records it: the commands that ran, and the commit they were gated on. */
export interface PassRecord {
  readonly attempt: number;
  /** The commit the commands ran on, in lower case. */
  readonly sha: string;
  /** The tip of the base branch the attempt ran against, from its `gate_checkout` line; empty when the ledger has none. */
  readonly baseSha: string;
  /** When the `gate-passed` step was written. */
  readonly atMs: number;
  /** Command, exit code and duration of each line of the attempt, in order. */
  readonly lines: ReadonlyArray<CommandLine>;
  /** How many of the last `lines` the marker says the passing run wrote. */
  readonly count: number;
}

/** One `gate_command` line. */
export interface CommandLine {
  readonly attempt: number;
  readonly command: string;
  readonly exitCode: number;
  readonly durationMs: number;
}

/** A `session_interrupted` or `session_rate_limited` line as `readProgress` keeps it. */
export interface Interruption {
  /** How many interruptions the run has been through, this one included. */
  readonly resumes: number;
  /** The thread could not be resumed: the next attempt is started instead. */
  readonly relaunch: boolean;
  /** The ordinal of the run that ended, for a resume. */
  readonly runOrdinal: number | null;
  /** The line's branch: the thread's for a resume, where the next attempt resumes from for a relaunch; null when it names none. */
  readonly branch: string | null;
  /** The `interruption-sent <resumes>` (or `rate-limited-sent <run ordinal>`) step for this resume is in the ledger. */
  readonly sent: boolean;
  /** A `session_rate_limited` line: its resume is sent after the cooldown and counts as none. */
  readonly rateLimited: boolean;
  /** The model the resume moves the session to, by id on the same instance; null to keep its own. */
  readonly model: string | null;
}

/**
 * What started a re-gate, for the run's line. A moved head (with or without the base) is `head` or
 * `both`; a head that did not move leaves only `conflict`: GitHub says the pull request conflicts
 * with the base branch, whatever the base did. A moved base alone starts no gate. `earlier` is a
 * re-gate an older factory began with the head unchanged, whose line does not say why.
 */
export type Moved = "head" | "both" | "conflict" | "earlier";

/**
 * Whether the head moved since the pass (`passedHead` on `passedAgainst`): `head`, or `both` when
 * the tip differs from `passedAgainst` too. `null` when no pass head is on record or the head did
 * not move, whatever the base did.
 */
export const movedSince = (
  passedHead: string,
  passedAgainst: string,
  head: string,
  tip: string,
): Extract<Moved, "head" | "both"> | null => {
  if (passedHead === "" || head.toLowerCase() === passedHead.toLowerCase()) return null;
  const baseMoved = passedAgainst !== "" && tip.toLowerCase() !== passedAgainst.toLowerCase();
  return baseMoved ? "both" : "head";
};

/**
 * The decision of a `regate_relaunching` or `feedback_relaunching` line: what a new session needs
 * to fix a failed re-gate of a ready pull request (or to act on instructor feedback), kept so that
 * a call that finds it with no `session_launched` after it can send the launch again without
 * running the gate.
 */
export interface Relaunch {
  readonly fixes:
    | { readonly kind: "regate"; readonly attempt: number }
    | { readonly kind: "feedback"; readonly n: number };
  /** The pull request's branch, which the session starts from and pushes to. */
  readonly branch: string;
  /** The failure text (or the feedback block) the session is sent after the launch's own words. */
  readonly message: string;
}

/**
 * `seen` as the `gate-passed` step of a new pass leaves it: no read of the checks, since one in
 * the ledger was about the pass before. For a pass recorded in this call, which `seen` predates.
 */
export const withoutCheckReads = (seen: Seen): Seen => ({
  ...seen,
  checksPassed: null,
  checksFailed: null,
  checksTimedOut: null,
});

/** The gate attempt a re-gate relaunch fixes; `null` for a feedback relaunch, which is no attempt. */
export const regateAttempt = (relaunch: Relaunch): number | null =>
  relaunch.fixes.kind === "regate" ? relaunch.fixes.attempt : null;

/** The command id of the launch: the same on every call, so T3 answers a repeat with the thread it made. */
export const relaunchCommandId = (relaunch: Relaunch, run: RunId): string =>
  relaunch.fixes.kind === "regate"
    ? `softfac:${runIdToString(run)}:regate:${relaunch.fixes.attempt}`
    : `softfac:${runIdToString(run)}:feedback:${relaunch.fixes.n}`;

export interface Seen {
  readonly claimed: boolean;
  /** When the first `claimed` line was written, in Unix epoch milliseconds; null before the claim. */
  readonly claimedMs: number | null;
  /** The `github_user` of the first `claimed` line; null when there is none or it is not text. */
  readonly githubUser: string | null;
  /** The moment in the first `approved <time>` step: when an instructor applied the label the run was approved on. */
  readonly approvedAt: string | null;
  /** The instructor on that step's cause (`actor`), who applied the label; null when the line names none. */
  readonly approvedBy: string | null;
  /** From the last `state_changed`; null before any. */
  readonly state: State | null;
  /** The `session_launched` line's thread. */
  readonly threadId: string | null;
  /**
   * The base branch the newest `session_launched` line that names one records: the run's base,
   * read from the ledger on every later pass and never from the issue again. Null for none.
   */
  readonly base: string | null;
  /**
   * The model the session runs on: the newest `session_launched` line's, moved by any rate-limited
   * resume since. Null for a launch that recorded none.
   */
  readonly model: Model | null;
  /** The `launch-sending` step: a launch call was about to be sent, so a session may exist. */
  readonly launchSent: boolean;
  /**
   * The branch in a `launch-sending resumed-from <branch>` step: the decision to resume, made
   * before the first launch call. Null for a plain `launch-sending` or none. A launch sent again
   * reads it and never asks GitHub again.
   */
  readonly launchResumedFrom: string | null;
  /**
   * The pull request of a `launch-pull-request <branch> <url>` step written just before that
   * `launch-sending resumed-from <branch>` step: the decision to continue an earlier attempt's
   * open pull request on that branch. Null for a resume from a branch alone, or none.
   */
  readonly launchResumedPr: string | null;
  /**
   * The branch in a `launch-base <branch>` step: the base the first launch call was decided on,
   * when it is not the repo's. A launch sent again reads it and never the issue again.
   */
  readonly launchBase: string | null;
  /**
   * The model id in a `launch-model <model>` step: the model the first launch call was decided on,
   * when it is not the project's. A launch sent again reads it and never the cooldowns again.
   */
  readonly launchModel: string | null;
  /** The `approval-rechecked` step: the issue text was checked again after the launch. */
  readonly rechecked: boolean;
  /** The `session_launched` line's worktree path. */
  readonly worktree: string | null;
  /** A `worktree_removed` or `worktree_remove_failed` line follows the last `session_launched`. */
  readonly worktreeDone: boolean;
  /** The reason on the `stuck` line: the comment is on the issue. */
  readonly stuck: string | null;
  /** A `stop_requested` line: an operator asked for this run to be stopped by hand. */
  readonly stopRequested: boolean;
  readonly finished: boolean;
  /** Every pull request a `pr_opened` line names, once each, in the order first named. */
  readonly opened: ReadonlyArray<number>;
  /** The newest `pr_opened`: the number and the URL as the session wrote it. */
  readonly lastPr: { readonly pr: number; readonly url: string } | null;
  /**
   * Every `pr_left` line, in order: a pull request the session left open on its branch when the
   * run ended short of the gate, for the next attempt to continue. The session did not report it,
   * so it is in none of `opened`, `lastPr` and `prReported`.
   */
  readonly left: ReadonlyArray<{ readonly pr: number; readonly url: string }>;
  /** A `questions_posted` since the run last entered `building`: this stop's questions are on the issue. */
  readonly questionsPosted: boolean;
  /** A `pr_opened` since the run last entered `building` or had a gate sent back: the session's pull request waits for the gate. */
  readonly prReported: boolean;
  /** The ordinal in the newest `result-line-reminding` step: a reminder send was started. */
  readonly reminding: number | null;
  /** A `result-line-reminded` step: the session has had its one reminder. */
  readonly reminded: boolean;
  /**
   * The session is working until a run newer than this ordinal has ended: the reminder's, a
   * forward's or a gate send-back's wait marker. Never goes down. A send-back's marker is dropped
   * by the next `gate_command`, which shows the gate ran; a forward's only by a newer ended run,
   * or by `forward-wait-cancelled` when nothing it covered went in.
   */
  readonly waitingAfter: number | null;
  /**
   * The ordinal in the newest wait marker of either kind (a forward's, a reminder's or a
   * send-back's), kept after the marker is dropped: `forward` writes no second marker for the
   * same ordinal.
   */
  readonly lastWait: number | null;
  /** The id of every comment a `comment_forwarded` line names: it is in the session. */
  readonly forwarded: ReadonlySet<string>;
  /** The time of every `body-edit-forwarded` or `body-edit-dropped` step: that edit is in the session, or the issue was told it was not sent. */
  readonly bodyEdits: ReadonlySet<string>;
  /**
   * The ordinal in the newest `forward-wait` step that no `comment_forwarded` line or
   * `body-edit-forwarded` step follows and that was not cancelled: nothing sent under it is known
   * to have gone in.
   */
  readonly idleForwardWait: number | null;
  /**
   * `idleForwardWait` when the ledger proves T3 refused every send under it: each send has its own
   * `forward-wait <k>` line naming its T3 command id, and a `comment-refused` or
   * `body-edit-refused` step names the same id. T3 keeps one result per command id, so a resend's
   * refusal answers for a send whose own was lost. No run started, so `forward` cancels it.
   */
  readonly refusedForwardWait: number | null;
  /** The id of every comment a `comment-dropped <id>` step names: the issue was told it was not forwarded. */
  readonly dropped: ReadonlySet<string>;
  /** The newest `session_paused` line: a person stopped the session's run in T3, and this is its ordinal. */
  readonly paused: { readonly runOrdinal: number | null } | null;
  /** The newest `session_interrupted` or `session_rate_limited` line, until a new session is launched: the decision to resume or to relaunch. */
  readonly interruption: Interruption | null;
  /** The newest branch a `session_launched`, `session_interrupted` or `session_rate_limited` line names: where the run's work is. */
  readonly lastBranch: string | null;
  /** Every branch a `branch_bound` line names: a branch the session made, whose pull request `advance` bound. */
  readonly boundBranches: ReadonlyArray<string>;
  /** Milliseconds spent in `triage` and `building` in stints that have ended, less the factory's gate. */
  readonly workedMs: number;
  /** When the stint that is running began; null when the run is not working. */
  readonly workingSince: number | null;
  /** The attempts that have a `gate_command` line. */
  readonly commandAttempts: ReadonlySet<number>;
  /** The attempts that were sent back into the session. */
  readonly sentBackAttempts: ReadonlySet<number>;
  /** The attempts whose `gate-passed` step is in the ledger and that were not sent back or checked out again after it. */
  readonly passedAttempts: ReadonlySet<number>;
  /** The `gate-passed <sha> <n>` step: the decision that the gate passed, made before the pull request was marked ready. */
  readonly pass: PassRecord | null;
  /** The newest `gate-sending` step: the attempt, and the ordinal of the session run it was gated on. */
  readonly sending: { readonly attempt: number; readonly runOrdinal: number } | null;
  /** A `gate-results-posted` step: the passing gate's results are on the pull request. */
  readonly resultsPosted: boolean;
  /** The directories a `gate_cleanup_failed` line already names. */
  readonly cleanupFailed: ReadonlySet<string>;
  /** A `pr_ready_outside` line: someone else marked the pull request ready while a gate ran, and it is noted. */
  readonly readyOutside: boolean;
  /**
   * The lower-case sha of the newest `checks_read` line whose checks are non-empty and all
   * `passed`; null when the newest read decided otherwise, there is none, or a pass was recorded
   * after it.
   */
  readonly checksPassed: string | null;
  /**
   * The newest `checks_read` line with a failed check, since the last recorded pass: its
   * lower-case sha and the checks that failed, with no result or link. The decision that the
   * pass's checks failed, which a later read does not undo.
   */
  readonly checksFailed: {
    readonly sha: string;
    readonly failed: ReadonlyArray<CheckStatus>;
  } | null;
  /** A `gate_regate` line since the run last changed state or posted the results of a pass: a re-gate is under way. */
  readonly regating: boolean;
  /** What started the re-gate the newest `gate_regate` line begins, judged against the pass on record when it was written. */
  readonly regateMoved: Moved | null;
  /** That re-gate recorded its pass (`gate-passed`), and the results are not posted yet. */
  readonly regatePassed: boolean;
  /**
   * The newest `checks_read` line of the pass on record that the wait running out wrote (its
   * cause says `checks-timed-out`): the decision to go `stuck`, which stands as a recorded
   * failure does. `missing` says a check never appeared.
   */
  readonly checksTimedOut: { readonly sha: string; readonly missing: boolean } | null;
  /**
   * Finishing the pass on record sets the ready state again, since a stuck path an earlier call did
   * not finish may have drafted the pull request or relabelled the issue. False only for a pass
   * whose cause is `gate-passed-clean`, written when a re-gate began itself: there is nothing to
   * set again, and a person's draft or assignment stands.
   */
  readonly regatePassReassert: boolean;
  /** That re-gate's failure was recorded as sent back, and the state has not changed yet. */
  readonly regateSentBack: boolean;
  /** The newest `regate_relaunching` or `feedback_relaunching` line, until the state changes. */
  readonly relaunch: Relaunch | null;
  /** A `session_launched` line follows the newest `gate-sending` step or relaunch decision. */
  readonly launchedSinceSending: boolean;
  /**
   * The branch the newest `session_launched` line says its worktree was made from (a relaunch for
   * a failed re-gate or feedback, or an attempt resumed onto an earlier one's work); null for a
   * first launch. That session works on a branch of T3's own and is told to push to this one, so
   * a pull request from it is the session's.
   */
  readonly resumedFrom: string | null;
  /** The ids named by any `feedback_relaunching` or `feedback_forwarding` line: each is acted on at most once. */
  readonly feedbackSent: ReadonlySet<string>;
  /** The number on the newest `feedback_relaunching` line, 0 before any: how many feedback relaunches the run has had. */
  readonly feedbackRelaunches: number;
  /** How many items the newest `feedback_relaunching` line names. */
  readonly feedbackLastItems: number;
  /**
   * When the run first reached `pr-open` since its last feedback relaunch (since it began, if
   * none), in epoch milliseconds: the gate pass that took it there. Feedback is read from here. A
   * feedback relaunch resets it to null and the next `pr-open` sets it; a trip through `building`
   * and back, or a re-gate pass on a moved base, does not move it, so feedback from then is kept.
   */
  readonly prOpenSince: number | null;
  /**
   * The run on that `resumed_from`: this run's own id for a session that pushes to a pull
   * request's branch (a re-gate's or feedback's, or one resumed onto an earlier attempt's open
   * pull request), the earlier attempt's for a resume from its branch.
   */
  readonly resumedFromRun: string | null;
}

/**
 * The pull request's branch when the run's session was launched to push there: to fix a failed
 * re-gate of this run, for feedback, or to continue an earlier attempt's open pull request. Null
 * for a first launch, and for a session resumed from an earlier attempt's branch: older versions
 * left that work on T3's branch, so `start` tries it first and this one only if origin lacks it.
 */
export const regateBranch = (seen: Seen, run: RunId): string | null =>
  seen.resumedFromRun === runIdToString(run) ? seen.resumedFrom : null;

/** A relaunch that was decided and whose session the ledger does not name: the launch may have reached T3. */
export const pendingRelaunch = (seen: Seen): Relaunch | null =>
  seen.launchedSinceSending ? null : seen.relaunch;

/**
 * A feedback relaunch whose session the ledger records and whose state change it does not: what
 * is left of it is the transition.
 */
export const committingFeedback = (seen: Seen): Relaunch | null =>
  seen.relaunch !== null &&
  seen.relaunch.fixes.kind === "feedback" &&
  seen.launchedSinceSending &&
  seen.state === "pr-open"
    ? seen.relaunch
    : null;

/** The ledger step that says a launch call is about to be sent. */
export const LAUNCH_SENDING = "launch-sending";
/** The start of the `launch-sending` step of a launch that resumes from an earlier run's branch: `launch-sending resumed-from <branch>`. */
export const LAUNCH_SENDING_RESUMED = `${LAUNCH_SENDING} resumed-from `;
/**
 * The step written just before `launch-sending resumed-from <branch>` when the launch continues
 * an earlier attempt's open pull request: `launch-pull-request <branch> <url>`. A step of its own,
 * so a version that does not know it reads the `launch-sending` step as a resume from the branch.
 */
export const LAUNCH_PULL_REQUEST = "launch-pull-request ";
/** The step written before `launch-sending` when the run's base is not the repo's: `launch-base <branch>`. */
export const LAUNCH_BASE = "launch-base ";
/** The step written before `launch-sending` when the launch runs on a fallback: `launch-model <model>`. */
export const LAUNCH_MODEL = "launch-model ";
/** The ledger step that says the issue text was checked again after the launch. */
export const APPROVAL_RECHECKED = "approval-rechecked";
/** The ledger step written before the reminder is sent: `result-line-reminding <k>`, `k` the ordinal of the run that ended. */
export const RESULT_LINE_REMINDING = "result-line-reminding";
/** The ledger step written after the reminder was sent. */
export const RESULT_LINE_REMINDED = "result-line-reminded";
/** The ledger step written once the resume of a `session_interrupted` line was sent: `interruption-sent <resumes>`. */
export const INTERRUPTION_SENT = "interruption-sent";
/** The ledger step written once the resume of a `session_rate_limited` line was sent: `rate-limited-sent <run ordinal>`. */
export const RATE_LIMITED_SENT = "rate-limited-sent";
/** The ledger step that waits for a run newer than `k` (a forwarded comment); read here for the steps that write it. */
export const FORWARD_WAIT = "forward-wait";
/** The ledger step written when every message sent under a `forward-wait <k>` was refused by T3, so no run was started and the wait is over: `forward-wait-cancelled <k>`. */
export const FORWARD_WAIT_CANCELLED = "forward-wait-cancelled";
/** The ledger step written as soon as T3 refused a comment sent under an idle `forward-wait`: `comment-refused <id>`. */
export const COMMENT_REFUSED = "comment-refused";
/** The ledger step written as soon as T3 refused a body edit sent under an idle `forward-wait`: `body-edit-refused <edited_at>`. */
export const BODY_EDIT_REFUSED = "body-edit-refused";
/** The ledger step written once the issue was told that T3 refused an edit of the body: `body-edit-dropped <edited_at>`; the edit counts as handled. */
export const BODY_EDIT_DROPPED = "body-edit-dropped";
/** The ledger step written once an edit of the issue body is in the session: `body-edit-forwarded <edited_at>`. */
export const BODY_EDIT_FORWARDED = "body-edit-forwarded";
/** The ledger step written once the issue was told that an instructor's comment was not forwarded: `comment-dropped <id>`. */
export const COMMENT_DROPPED = "comment-dropped";
/** The ledger step written before a failed attempt is sent: `gate-sending <attempt> <ordinal>`. */
export const GATE_SENDING = "gate-sending";
/** The ledger step that records the decision that an attempt passed: `gate-passed <sha> <n>`. */
export const GATE_PASSED = "gate-passed";
/** The cause reason of a re-gate's `gate-passed` step with nothing cut short before it to repair. */
export const GATE_PASSED_CLEAN = "gate-passed-clean";
/** The cause reason of the `checks_read` line written when the wait for the checks ran out. */
export const CHECKS_TIMED_OUT = "checks-timed-out";
/** The ledger step that says the gate results are on the pull request. */
export const GATE_RESULTS_POSTED = "gate-results-posted";

/** `text` when it is a number without a sign or leading zero that is a safe integer. */
const canonical = (text: string): number | null =>
  /^(?:0|[1-9][0-9]*)$/.test(text) && Number.isSafeInteger(Number(text)) ? Number(text) : null;

/** The `k` of a step written as `<name> <k>`, `k` a number without a sign or leading zero. */
const stepNumber = (step: string, name: string): number | null =>
  step.startsWith(`${name} `) ? canonical(step.slice(name.length + 1)) : null;

/** The id in a `comment-dropped <id>` step, or null when it is not one plain token (empty, or with a space or control character). */
const commentDroppedId = (step: string): string | null => {
  if (!step.startsWith(`${COMMENT_DROPPED} `)) return null;
  const id = step.slice(COMMENT_DROPPED.length + 1);
  return id === "" || /[\s\p{Cc}]/u.test(id) ? null : id;
};

/** The `gate-sending <attempt> <ordinal>` step's numbers, or null for text that breaks the rules. */
const parseGateSending = (
  step: string,
): { readonly attempt: number; readonly runOrdinal: number } | null => {
  if (!step.startsWith(`${GATE_SENDING} `)) return null;
  const parts = step.slice(GATE_SENDING.length + 1).split(" ");
  if (parts.length !== 2) return null;
  const attempt = canonical(parts[0]!);
  const runOrdinal = canonical(parts[1]!);
  return attempt === null || runOrdinal === null ? null : { attempt, runOrdinal };
};

/** The `gate-passed <sha> <n>` step's commit (lower case) and count, or null for text that breaks the rules. */
const parseGatePassed = (step: string): { readonly sha: string; readonly count: number } | null => {
  if (!step.startsWith(`${GATE_PASSED} `)) return null;
  const parts = step.slice(GATE_PASSED.length + 1).split(" ");
  if (parts.length !== 2) return null;
  const [sha, count] = parts as [string, string];
  if (!isCommitId(sha)) return null;
  const n = canonical(count);
  return n === null || n === 0 ? null : { sha: sha.toLowerCase(), count: n };
};

/** The item ids a feedback line names; anything but a string is not one. */
const feedbackItems = (data: unknown): ReadonlyArray<string> => {
  const items = dataField(data, "items");
  return Array.isArray(items) ? items.filter((id): id is string => typeof id === "string") : [];
};

const sentInterruption = (interruption: Interruption): Interruption => ({
  ...interruption,
  sent: true,
});

export const readProgress = (entries: ReadonlyArray<Entry>): Seen => {
  let claimed = false;
  let claimedMs: number | null = null;
  let githubUser: string | null = null;
  let approvedAt: string | null = null;
  let approvedBy: string | null = null;
  let state: State | null = null;
  let threadId: string | null = null;
  let launchSent = false;
  let launchResumedFrom: string | null = null;
  let launchResumedPr: string | null = null;
  let launchPullRequest: { branch: string; url: string } | null = null;
  let launchBase: string | null = null;
  let launchModel: string | null = null;
  let rechecked = false;
  let worktree: string | null = null;
  let worktreeDone = false;
  let stuck: string | null = null;
  let stopRequested = false;
  let finished = false;
  const opened: Array<number> = [];
  let lastPr: Seen["lastPr"] = null;
  const left: Array<{ pr: number; url: string }> = [];
  let questionsPosted = false;
  let prReported = false;
  let reminding: number | null = null;
  let reminded = false;
  let waitingAfter: number | null = null;
  let waitIsForward = false;
  let lastWait: number | null = null;
  let idleForwardWait: number | null = null;
  // The command ids sent under the idle marker with no outcome yet; null once a marker names none.
  let idleOpen: Set<string> | null = null;
  let lastWaitBefore: number | null = null;
  const forwarded = new Set<string>();
  const bodyEdits = new Set<string>();
  const dropped = new Set<string>();
  let paused: Seen["paused"] = null;
  let interruption: Interruption | null = null;
  let lastBranch: string | null = null;
  const boundBranches: Array<string> = [];
  let base: string | null = null;
  let model: Model | null = null;
  let workedMs = 0;
  let workingSince: number | null = entries[0]?.ms ?? null;
  const commandAttempts = new Set<number>();
  const sentBackAttempts = new Set<number>();
  const passedAttempts = new Set<number>();
  let pass: PassRecord | null = null;
  /** The `gate_command` lines since the newest `gate_checkout`, newest last. */
  let commandRun: Array<CommandLine> = [];
  let lastCheckout: { readonly attempt: number; readonly baseSha: string } | null = null;
  let sending: Seen["sending"] = null;
  let resultsPosted = false;
  const cleanupFailed = new Set<string>();
  let readyOutside = false;
  let checksPassed: string | null = null;
  let checksFailed: Seen["checksFailed"] = null;
  let checksTimedOut: Seen["checksTimedOut"] = null;
  let regating = false;
  let regateMoved: Moved | null = null;
  let regatePassed = false;
  let regatePassReassert = false;
  let regateSentBack = false;
  let relaunch: Relaunch | null = null;
  let launchedSinceSending = false;
  let resumedFrom: string | null = null;
  let resumedFromRun: string | null = null;
  const feedbackSent = new Set<string>();
  let feedbackRelaunches = 0;
  let feedbackLastItems = 0;
  let prOpenSince: number | null = null;
  // A wait marker names run `k`: the awaited ordinal never goes down.
  const awaitRun = (k: number, forward: boolean) => {
    if (waitingAfter === null || k >= waitingAfter) {
      waitingAfter = k;
      waitIsForward = forward;
    }
    lastWait = lastWait === null ? k : Math.max(lastWait, k);
  };
  const number = (value: unknown): number | null => (typeof value === "number" ? value : null);
  for (const entry of entries) {
    switch (entry.event) {
      case "claimed": {
        if (!claimed) {
          const user = dataField(entry.data, "github_user");
          githubUser = typeof user === "string" ? user : null;
          claimedMs = entry.ms;
        }
        claimed = true;
        break;
      }
      case "step_changed": {
        const step = dataField(entry.data, "step");
        if (typeof step !== "string") break;
        if (approvedAt === null && step.startsWith("approved ")) {
          approvedAt = step.slice("approved ".length);
          const actor = entry.cause?.actor;
          approvedBy = typeof actor === "string" && actor !== "" ? actor : null;
        }
        if (step === APPROVAL_RECHECKED) rechecked = true;
        if (step === RESULT_LINE_REMINDED) reminded = true;
        if (step === GATE_RESULTS_POSTED) {
          resultsPosted = true;
          regating = false;
          regatePassed = false;
          regateSentBack = false;
        }
        const remindingRun = stepNumber(step, RESULT_LINE_REMINDING);
        if (remindingRun !== null) {
          reminding = remindingRun;
          awaitRun(remindingRun, true);
        }
        const forwardRun = stepNumber(step, FORWARD_WAIT);
        const command = entry.cause?.command;
        if (forwardRun !== null) {
          // The same idle marker again is the next send under it.
          if (idleForwardWait !== forwardRun) {
            lastWaitBefore = lastWait;
            idleForwardWait = forwardRun;
            idleOpen = new Set();
          }
          if (typeof command === "string") idleOpen?.add(command);
          else idleOpen = null;
          awaitRun(forwardRun, true);
        }
        if (
          typeof command === "string" &&
          (step.startsWith(`${COMMENT_REFUSED} `) || step.startsWith(`${BODY_EDIT_REFUSED} `))
        ) {
          idleOpen?.delete(command);
        }
        const cancelledRun = stepNumber(step, FORWARD_WAIT_CANCELLED);
        if (cancelledRun !== null && idleForwardWait === cancelledRun) {
          if (waitIsForward && waitingAfter === cancelledRun) {
            waitingAfter = null;
            waitIsForward = false;
          }
          lastWait = lastWaitBefore;
          idleForwardWait = null;
        }
        const sentRun = stepNumber(step, INTERRUPTION_SENT);
        if (
          sentRun !== null &&
          interruption !== null &&
          !interruption.relaunch &&
          !interruption.rateLimited &&
          interruption.resumes === sentRun
        ) {
          interruption = sentInterruption(interruption);
        }
        const sentLimited = stepNumber(step, RATE_LIMITED_SENT);
        if (
          sentLimited !== null &&
          interruption !== null &&
          interruption.rateLimited &&
          interruption.runOrdinal === sentLimited
        ) {
          interruption = sentInterruption(interruption);
        }
        if (step.startsWith(`${BODY_EDIT_FORWARDED} `)) {
          bodyEdits.add(step.slice(BODY_EDIT_FORWARDED.length + 1));
          idleForwardWait = null;
        }
        if (step.startsWith(`${BODY_EDIT_DROPPED} `)) {
          bodyEdits.add(step.slice(BODY_EDIT_DROPPED.length + 1));
        }
        const droppedId = commentDroppedId(step);
        if (droppedId !== null) dropped.add(droppedId);
        if (step === LAUNCH_SENDING) {
          launchSent = true;
          launchResumedFrom = null;
          launchResumedPr = null;
          launchPullRequest = null;
        } else if (step.startsWith(LAUNCH_SENDING_RESUMED)) {
          launchSent = true;
          launchResumedFrom = step.slice(LAUNCH_SENDING_RESUMED.length);
          // Only the pull request decided with this branch: one from a decision a crash cut short
          // before its `launch-sending` step is not this one's.
          launchResumedPr =
            launchPullRequest?.branch === launchResumedFrom ? launchPullRequest.url : null;
          launchPullRequest = null;
        } else if (step.startsWith(LAUNCH_PULL_REQUEST)) {
          // A branch name has no whitespace, so the first space splits the branch from the URL.
          const rest = step.slice(LAUNCH_PULL_REQUEST.length);
          const at = rest.indexOf(" ");
          launchPullRequest =
            at < 0 ? null : { branch: rest.slice(0, at), url: rest.slice(at + 1) };
        } else if (step.startsWith(LAUNCH_BASE)) {
          launchBase = step.slice(LAUNCH_BASE.length);
        } else if (step.startsWith(LAUNCH_MODEL)) {
          launchModel = step.slice(LAUNCH_MODEL.length);
        }
        const gateSending = parseGateSending(step);
        if (gateSending !== null) {
          sending = gateSending;
          launchedSinceSending = false;
        }
        const gatePassed = parseGatePassed(step);
        if (gatePassed !== null) {
          // The results of this pass are not posted yet, whatever an earlier one's were.
          resultsPosted = false;
          // A read of the checks is about the pass before it: this one's are read afresh.
          checksPassed = null;
          checksFailed = null;
          checksTimedOut = null;
          regatePassed = regating;
          regatePassReassert = entry.cause?.reason !== GATE_PASSED_CLEAN;
          // The step's own cause names the attempt; a ledger from before it did is read by the
          // last command.
          const fromCause = entry.cause === null ? undefined : entry.cause.attempt;
          const attempt =
            typeof fromCause === "number" ? fromCause : (commandRun.at(-1)?.attempt ?? null);
          if (attempt !== null) {
            passedAttempts.add(attempt);
            const baseSha =
              lastCheckout !== null && lastCheckout.attempt === attempt ? lastCheckout.baseSha : "";
            pass = {
              attempt,
              sha: gatePassed.sha,
              baseSha,
              atMs: entry.ms,
              lines: commandRun.filter((line) => line.attempt === attempt),
              count: gatePassed.count,
            };
          }
        }
        break;
      }
      case "state_changed": {
        const to = dataField(entry.data, "to");
        if (workingSince !== null) workedMs += Math.max(0, entry.ms - workingSince);
        workingSince = null;
        // A pull request that was ready and comes back to building starts a new stint: the build
        // before it was ready came within the limit and is not charged again.
        if (state === "pr-open" && to === "building") workedMs = 0;
        if (to === "triage" || to === "building") workingSince = entry.ms;
        // The first time here since the last feedback relaunch: the moment of the pass that took
        // the run here, else of this line.
        if (to === "pr-open" && prOpenSince === null) prOpenSince = pass?.atMs ?? entry.ms;
        state = isState(to) ? to : null;
        relaunch = null;
        regating = false;
        regatePassed = false;
        regateSentBack = false;
        if (to === "building") {
          questionsPosted = false;
          prReported = false;
          // A run that comes back to `building` has no pass: its gate failed again on a moved
          // base, and the session has to finish a new run for it to be decided.
          pass = null;
        }
        break;
      }
      case "session_launched": {
        const id = dataField(entry.data, "thread_id");
        if (typeof id === "string") threadId = id;
        const path = dataField(entry.data, "worktree");
        worktree = typeof path === "string" ? path : null;
        worktreeDone = false;
        launchedSinceSending = true;
        const from = dataField(entry.data, "resumed_from");
        const fromBranch = dataField(from, "branch");
        resumedFrom = typeof fromBranch === "string" ? fromBranch : null;
        const fromRun = dataField(from, "run");
        resumedFromRun = typeof fromRun === "string" ? fromRun : null;
        const launchedBranch = dataField(entry.data, "branch");
        if (typeof launchedBranch === "string") lastBranch = launchedBranch;
        const launchedBase = dataField(entry.data, "base");
        if (typeof launchedBase === "string") base = launchedBase;
        const instanceId = dataField(entry.data, "model_instance");
        const modelId = dataField(entry.data, "model");
        const options = dataField(entry.data, "model_options");
        model =
          typeof instanceId === "string" && typeof modelId === "string"
            ? {
                instanceId,
                model: modelId,
                ...(Array.isArray(options) && { options: options as Model["options"] }),
              }
            : null;
        // A resume owed to the old thread is not owed to this one.
        if (interruption !== null) interruption = sentInterruption(interruption);
        // A new session has run numbers of its own, one reminder, and no stop by hand yet.
        waitingAfter = null;
        waitIsForward = false;
        lastWait = null;
        idleForwardWait = null;
        lastWaitBefore = null;
        reminding = null;
        reminded = false;
        paused = null;
        break;
      }
      case "worktree_removed":
      case "worktree_remove_failed":
        worktreeDone = true;
        break;
      case "stuck": {
        const reason = dataField(entry.data, "reason");
        stuck = typeof reason === "string" ? reason : "";
        break;
      }
      case "stop_requested":
        stopRequested = true;
        break;
      case "comment_forwarded": {
        const id = dataField(entry.data, "comment_id");
        if (typeof id === "string") forwarded.add(id);
        idleForwardWait = null;
        break;
      }
      case "questions_posted":
        questionsPosted = true;
        break;
      case "pr_opened": {
        const pr = dataField(entry.data, "pr");
        const url = dataField(entry.data, "url");
        if (typeof pr === "number" && typeof url === "string") {
          if (!opened.includes(pr)) opened.push(pr);
          lastPr = { pr, url };
          prReported = true;
          // The run is the factory's until its gate sends it back: that wait is not charged.
          if (workingSince !== null) workedMs += Math.max(0, entry.ms - workingSince);
          workingSince = null;
        }
        break;
      }
      case "pr_left": {
        const pr = dataField(entry.data, "pr");
        const url = dataField(entry.data, "url");
        if (typeof pr === "number" && typeof url === "string") left.push({ pr, url });
        break;
      }
      case "pr_ready_outside":
        readyOutside = true;
        break;
      case "branch_bound": {
        const branch = dataField(entry.data, "branch");
        if (typeof branch === "string" && !boundBranches.includes(branch)) {
          boundBranches.push(branch);
        }
        break;
      }
      case "session_interrupted": {
        const resumes = number(dataField(entry.data, "resumes"));
        const ordinal = number(dataField(entry.data, "run_ordinal"));
        const branch = dataField(entry.data, "branch");
        if (typeof branch === "string") lastBranch = branch;
        if (resumes === null) break;
        const relaunch = dataField(entry.data, "relaunch") === true;
        interruption = {
          resumes,
          relaunch,
          runOrdinal: ordinal,
          branch: typeof branch === "string" ? branch : null,
          sent: false,
          rateLimited: false,
          model: null,
        };
        // The resume starts a new run: the session is working until one newer than the run that
        // ended has ended. Like a forward's, only a newer run drops the wait.
        if (!relaunch && ordinal !== null) awaitRun(ordinal, true);
        break;
      }
      case "session_rate_limited": {
        const resumes = number(dataField(entry.data, "resumes"));
        const ordinal = number(dataField(entry.data, "run_ordinal"));
        const branch = dataField(entry.data, "branch");
        if (typeof branch === "string") lastBranch = branch;
        if (resumes === null || ordinal === null) break;
        const moved = dataField(entry.data, "model");
        const movedTo = typeof moved === "string" ? moved : null;
        interruption = {
          resumes,
          relaunch: false,
          runOrdinal: ordinal,
          branch: typeof branch === "string" ? branch : null,
          sent: false,
          rateLimited: true,
          model: movedTo,
        };
        if (movedTo !== null && model !== null) model = fallbackOf(model, movedTo);
        awaitRun(ordinal, true);
        break;
      }
      case "session_paused": {
        const ordinal = dataField(entry.data, "run_ordinal");
        paused = { runOrdinal: typeof ordinal === "number" ? ordinal : null };
        break;
      }
      case "gate_checkout": {
        const attempt = number(dataField(entry.data, "attempt"));
        const baseSha = dataField(entry.data, "base_sha");
        if (attempt === null) break;
        // A new run of commands begins at its checkout: the attempt is open again.
        passedAttempts.delete(attempt);
        commandRun = [];
        lastCheckout = { attempt, baseSha: typeof baseSha === "string" ? baseSha : "" };
        break;
      }
      case "gate_command": {
        const attempt = number(dataField(entry.data, "attempt"));
        const command = dataField(entry.data, "command");
        const exitCode = number(dataField(entry.data, "exit_code"));
        const durationMs = number(dataField(entry.data, "duration_ms"));
        if (attempt === null) break;
        commandAttempts.add(attempt);
        if (!waitIsForward) waitingAfter = null;
        if (typeof command === "string" && exitCode !== null && durationMs !== null) {
          commandRun.push({ attempt, command, exitCode, durationMs });
        }
        break;
      }
      case "gate_sent_back": {
        const attempt = number(dataField(entry.data, "attempt"));
        const ordinal = number(dataField(entry.data, "run_ordinal"));
        if (attempt !== null) {
          sentBackAttempts.add(attempt);
          passedAttempts.delete(attempt);
        }
        regateSentBack = regating;
        if (ordinal !== null) awaitRun(ordinal, false);
        // A pass that was sent back is no pass: the session runs again and the head is gated afresh.
        pass = null;
        // The session is at work again: the run is a building run with no pull request reported
        // until the session reports it again, so it is time-limited, watched and read.
        prReported = false;
        // The stint the pull request paused begins again; a run that is not building waits for
        // its next state change to decide. A clock already running keeps the time it counted.
        if (state === "triage" || state === "building") {
          if (workingSince !== null) workedMs += Math.max(0, entry.ms - workingSince);
          workingSince = entry.ms;
        }
        break;
      }
      case "gate_regate": {
        const sha = dataField(entry.data, "sha");
        const baseSha = dataField(entry.data, "base_sha");
        const previous = dataField(entry.data, "previous_base_sha");
        // The pass this re-gate replaces is still the one on record here. With the head where the
        // pass left it, a conflict GitHub reported is the trigger the line names; a line without
        // one was written before a moved base stopped starting a gate, and its trigger is unknown.
        const headMoved = movedSince(
          pass?.sha ?? "",
          typeof previous === "string" ? previous : "",
          typeof sha === "string" ? sha : "",
          typeof baseSha === "string" ? baseSha : "",
        );
        regateMoved =
          headMoved ??
          (pass === null
            ? null
            : dataField(entry.data, "conflict") === true
              ? "conflict"
              : "earlier");
        regating = true;
        regatePassed = false;
        regateSentBack = false;
        break;
      }
      case "checks_read": {
        const sha = dataField(entry.data, "sha");
        const checks = dataField(entry.data, "checks");
        if (typeof sha !== "string" || !Array.isArray(checks)) {
          checksPassed = null;
          break;
        }
        const read: ReadonlyArray<unknown> = checks;
        checksPassed =
          read.length > 0 && read.every((check) => dataField(check, "state") === "passed")
            ? sha.toLowerCase()
            : null;
        const failed = read.flatMap((check): Array<CheckStatus> => {
          const name = dataField(check, "name");
          if (dataField(check, "state") !== "failed" || typeof name !== "string") return [];
          // The line records no result or link.
          return [{ name, state: "failed", conclusion: "", url: null }];
        });
        if (failed.length > 0) checksFailed = { sha: sha.toLowerCase(), failed };
        else if (entry.cause?.reason === CHECKS_TIMED_OUT) {
          checksTimedOut = {
            sha: sha.toLowerCase(),
            missing: read.some((check) => dataField(check, "state") === "missing"),
          };
        }
        break;
      }
      case "regate_relaunching": {
        const attempt = number(dataField(entry.data, "attempt"));
        const branch = dataField(entry.data, "branch");
        const message = dataField(entry.data, "message");
        if (attempt === null || typeof branch !== "string" || typeof message !== "string") break;
        // Its own `gate-sending <attempt> 0`: the new thread has no run yet.
        sending = { attempt, runOrdinal: 0 };
        launchedSinceSending = false;
        relaunch = { fixes: { kind: "regate", attempt }, branch, message };
        break;
      }
      // No `gate-sending`: it is no gate attempt, and no re-gate. Read only so that a feedback
      // relaunch that is decided and not committed is never gated meanwhile.
      case "feedback_relaunching": {
        const n = number(dataField(entry.data, "n"));
        const branch = dataField(entry.data, "branch");
        const message = dataField(entry.data, "message");
        if (n === null || typeof branch !== "string" || typeof message !== "string") break;
        launchedSinceSending = false;
        relaunch = { fixes: { kind: "feedback", n }, branch, message };
        prOpenSince = null;
        const items = feedbackItems(entry.data);
        for (const id of items) feedbackSent.add(id);
        feedbackRelaunches = Math.max(feedbackRelaunches, n);
        feedbackLastItems = items.length;
        break;
      }
      case "feedback_forwarding":
        for (const id of feedbackItems(entry.data)) feedbackSent.add(id);
        break;
      case "gate_cleanup_failed": {
        const dir = dataField(entry.data, "dir");
        if (typeof dir === "string") cleanupFailed.add(dir);
        break;
      }
      case "finished":
        finished = true;
        workingSince = null;
        break;
    }
  }
  return {
    claimed,
    claimedMs,
    githubUser,
    approvedAt,
    approvedBy,
    state,
    threadId,
    launchSent,
    launchResumedFrom,
    launchResumedPr,
    launchBase,
    launchModel,
    rechecked,
    worktree,
    worktreeDone,
    stuck,
    stopRequested,
    finished,
    opened,
    lastPr,
    left,
    questionsPosted,
    prReported,
    reminding,
    reminded,
    waitingAfter,
    lastWait,
    idleForwardWait,
    refusedForwardWait:
      idleForwardWait !== null && idleOpen !== null && idleOpen.size === 0 ? idleForwardWait : null,
    forwarded,
    bodyEdits,
    dropped,
    paused,
    interruption,
    lastBranch,
    boundBranches,
    base,
    model,
    workedMs,
    workingSince,
    commandAttempts,
    sentBackAttempts,
    passedAttempts,
    pass,
    sending,
    resultsPosted,
    cleanupFailed,
    readyOutside,
    checksPassed,
    checksFailed,
    checksTimedOut,
    regating,
    regateMoved,
    regatePassed,
    regatePassReassert,
    regateSentBack,
    relaunch,
    launchedSinceSending,
    resumedFrom,
    resumedFromRun,
    feedbackSent,
    feedbackRelaunches,
    feedbackLastItems,
    prOpenSince,
  };
};

/**
 * The number of the gate attempt to make now: one more than the attempts so far, except that an
 * attempt with commands in the ledger that was never sent back and never passed died half way,
 * and is made again under the same number. A passed attempt is closed.
 */
export const nextGateAttempt = (seen: Seen): number => {
  const all = [...new Set([...seen.commandAttempts, ...seen.sentBackAttempts])].sort(
    (a, b) => a - b,
  );
  const last = all.at(-1);
  if (
    last !== undefined &&
    seen.commandAttempts.has(last) &&
    !seen.sentBackAttempts.has(last) &&
    !seen.passedAttempts.has(last)
  ) {
    return last;
  }
  return all.length + 1;
};

/**
 * How many attempts, `attempt` included, there have been since the last pass before it: the
 * attempts the retry budget counts.
 */
export const attemptsSincePass = (seen: Seen, attempt: number): number => {
  const before = [...seen.passedAttempts].filter((n) => n < attempt);
  const lastPass = before.length === 0 ? 0 : Math.max(...before);
  return attempt - lastPass;
};

/** The branches and pull requests a run's ledger names as its work (`runNames`). */
export interface RunNames {
  readonly branches: ReadonlySet<string>;
  readonly prs: ReadonlySet<number>;
}

/**
 * Every branch and pull request any line of a run's ledger names as its work, not only the newest:
 * a launch (its branch, resumed-from branch and worktree's launch branch), a planned resume, a
 * stuck line, an interruption, a relaunch, a bound branch, and a pull request opened or left.
 */
export const runNames = (entries: ReadonlyArray<Entry>, seen: Seen): RunNames => {
  const branches = new Set<string>();
  const prs = new Set<number>();
  const addBranch = (branch: unknown) => {
    if (typeof branch === "string") branches.add(branch);
  };
  // A planned resume is a step, not a line of its own.
  addBranch(seen.launchResumedFrom);
  for (const entry of entries) {
    switch (entry.event) {
      case "session_launched": {
        addBranch(dataField(entry.data, "branch"));
        addBranch(dataField(dataField(entry.data, "resumed_from"), "branch"));
        const worktree = dataField(entry.data, "worktree");
        addBranch(launchBranchOf(typeof worktree === "string" ? worktree : null));
        break;
      }
      case "stuck":
      case "session_interrupted":
      case "session_rate_limited":
      case "branch_bound":
      case "regate_relaunching":
      case "feedback_relaunching":
        addBranch(dataField(entry.data, "branch"));
        break;
      case "pr_opened":
      case "pr_left": {
        const pr = dataField(entry.data, "pr");
        if (typeof pr === "number") prs.add(pr);
        break;
      }
    }
  }
  return { branches, prs };
};
