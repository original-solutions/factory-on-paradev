/**
 * One pass of the factory: watched repos (T3 projects that opt in), their config and tracker
 * login, unfinished runs, claims with no run, then new issues. Ported from softfac's `tick.rs`
 * up to the claim. Pure over `PassWorld`, so tests script a world; `pass_started` and
 * `pass_finished` bracket the pass in the machine log.
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

import type { Attention, NewItem } from "./attention.ts";
import type { HandPause } from "./claims.ts";
import {
  ambiguousMessage,
  ambiguousRepos,
  type MachineConfig,
  type ProjectConfig,
  type WatchedListing,
  type WatchedRepo,
} from "./config.ts";
import {
  coolingDown,
  cooldownKey,
  forgetQuietCooldowns,
  launchModel,
  recordRateLimit,
  type Cooldown,
} from "./cooldown.ts";
import { GIB, isLowDisk, type FreeSpace } from "./disk.ts";
import { stateLabel, type State } from "./domain/lifecycle.ts";
import { overload, type Load, type Overload } from "./load.ts";
import { readHostLoad } from "./paradev/hostLoad.ts";
import type { SshRunner } from "./paradev/ssh.ts";
import type { LedgerError } from "./ledger/errors.ts";
import type { CauseStep, ErrorKind, MachineEvent } from "./ledger/events.ts";
import { holdsSlot, type RunInfo } from "./ledger/listRuns.ts";
import { PASS_TIMEOUT } from "./loop.ts";
import { asciiLower, runIdToString, type RunId } from "./ledger/runId.ts";
import { duration, formatTs } from "./ledger/time.ts";
import type {
  AdvanceOutcome,
  BadEnd,
  BuildingError,
  CooldownOutcome,
  Evidence,
  ForwardOutcome,
  InterruptOutcome,
  LimitOutcome,
  WatchOutcome,
} from "./runner/building.ts";
import type { FeedbackError, FeedbackStep } from "./runner/feedback.ts";
import { unchangedSince, type GateStepError, type LastPass } from "./runner/gating.ts";
import {
  CLAIM_GAVE_WAY,
  claimedByLine,
  mention,
  type StartError,
  type StartOutcome,
} from "./runner/start.ts";
import type { Model, SessionsError } from "./sessions.ts";
import type { StopRequestOutcome } from "./runner/stop.ts";
import { sanitize } from "./text.ts";
import {
  LIST_LIMIT,
  type Blocker,
  type Listing,
  type Mergeable,
  type UnassignedClaim,
} from "./tracker/github.ts";

// Local copies of the types `t3/branchPrune.ts` and `t3/sessions.ts` gave the pass world at the
// source commit. The P1 runner has neither: `pruneBranches` answers an empty report and
// `threadsOnBrokenWorktrees` answers none.

/** Why the Paradev hold holds claims: what failed, in the CLI's or the check's words. */
export interface ParadevDown {
  /** `offline`: the host service does not answer. `signed-out`: no login. `cli-check`: `superset schema` lacks what the runner uses. */
  readonly reason: "offline" | "signed-out" | "cli-check";
  readonly message: string;
}

/** Why a `t3/*` branch was pruned. */
export type PruneReason = "merged" | "pr-merged" | "pr-closed" | "stale";

/** A branch a prune deleted, or in a dry run would have. */
export interface Pruned {
  readonly ref: string;
  readonly sha: string;
  readonly scope: "local" | "remote";
  readonly reason: PruneReason;
}

export interface PruneReport {
  /** What was deleted, or in a dry run what would have been. */
  readonly pruned: ReadonlyArray<Pruned>;
  /** Branches judged prunable that were left because they moved or went meanwhile, each with why. */
  readonly left: ReadonlyArray<{ readonly ref: string; readonly why: string }>;
  /** Branches judged prunable whose deletion failed, each with why. */
  readonly failed: ReadonlyArray<{
    readonly ref: string;
    readonly kind: "git" | "github";
    readonly why: string;
  }>;
  /** Remote branches judged prunable that wait for the next prune. */
  readonly waiting: number;
}

/** A live thread on a worktree that is gone, or is no longer a git checkout. */
export interface ThreadOnBrokenWorktree {
  readonly threadId: string;
  readonly worktreePath: string;
  /**
   * Every thread on the path, archived ones and this one included: an archived session keeps
   * its path, so the thread a run launched is among them.
   */
  readonly threadsOnPath: ReadonlyArray<string>;
}

/** An error of the pass's own: what kind it is for the machine log, and what it says. */
export interface PassError {
  readonly kind: ErrorKind;
  readonly message: string;
  /** True when the failure was one GitHub never received, so a later read may well succeed. */
  readonly transient?: boolean;
}

/** The project config and tracker login a repo last loaded. */
export interface LastGood {
  readonly project?: ProjectConfig | undefined;
  readonly trackerUser?: string | undefined;
}

/**
 * What a failed read of `what` falls back on: the last good copy when GitHub never received the
 * call and an earlier pass loaded one that no failure since has dropped, else nothing.
 */
export const lastGoodCopy = <K extends keyof LastGood>(
  lastGood: ReadonlyMap<string, LastGood>,
  repo: string,
  what: K,
  error: { readonly transient?: boolean | undefined },
): LastGood[K] | undefined =>
  error.transient === true ? lastGood.get(asciiLower(repo))?.[what] : undefined;

/** A watched repo with its project config and the login its tracker knows the factory by. */
export interface Repo {
  readonly watched: WatchedRepo;
  readonly project: ProjectConfig;
  readonly trackerUser: string;
}

/** A watched repo, with its config or without it. */
export type Loaded =
  | { readonly kind: "ready"; readonly repo: Repo }
  /** The name of a repo that could not be loaded, already reported. */
  | { readonly kind: "broken"; readonly name: string };

/** An open `factory:ready` issue nobody is assigned to, with its label names. */
export interface ReadyIssue {
  readonly number: number;
  readonly labels: ReadonlyArray<string>;
}

/**
 * The label that parks a ready issue: it is not claimed while it has one of this name in any
 * ASCII case. Checked at claim time only; a run already started goes on.
 */
const POSTPONED = "postponed";

const isPostponed = (issue: ReadyIssue) =>
  issue.labels.some((label) => asciiLower(label) === POSTPONED);

/** What the tracker's cut-short scan found: see `unassignedClaims` on the tracker. */
export interface ClaimScanResult {
  readonly claims: ReadonlyArray<UnassignedClaim>;
  /** Issues whose label history could not be read, each with the tracker's message. */
  readonly unread: ReadonlyArray<{ readonly issue: number; readonly message: string }>;
}

/**
 * The run each session thread was launched for, and whether that session is stopped (ledger
 * `runsByThread`). `complete` is false when a run file could not be read, so a thread missing
 * from `runs` may still be a session's.
 */
export interface SessionRuns {
  readonly runs: ReadonlyMap<string, { readonly run: RunId; readonly stopped: boolean }>;
  readonly complete: boolean;
}

/** What the check for threads on broken worktrees keeps from pass to pass. */
export interface BrokenThreadMemo {
  /** Threads on a broken worktree that no run's session was on: a person's, never archived. */
  readonly notFactory: Set<string>;
  /**
   * The threads the last ledger read could not settle (a run still going, or a run file that
   * could not be read), with when it read, in epoch milliseconds.
   */
  readonly unsettled: Map<string, number>;
}

/** Everything a pass reads and writes. */
export interface PassWorld {
  /**
   * The repos to watch, read anew at the start of each pass: the environment's T3 projects whose
   * checkout opts in, and the opted-in checkouts the reader could not identify this time.
   */
  readonly watchedRepos: Effect.Effect<WatchedListing, PassError>;
  /** The repo's project config, from `.dw/config.yml` at the tip of its default branch. */
  readonly project: (repo: WatchedRepo) => Effect.Effect<ProjectConfig, PassError>;
  /** This machine's host name: the `Machine:` line of a status comment, and what `factory.owner` names. */
  readonly machineName: string;
  /** The login the repo's tracker knows the factory by. */
  readonly trackerUser: (repo: WatchedRepo) => Effect.Effect<string, PassError>;
  /** Every run that is not finished, oldest first; with `only`, the runs of that one issue. */
  readonly unfinishedRuns: (only?: {
    readonly repo: string;
    readonly issue: number;
  }) => Effect.Effect<ReadonlyArray<RunInfo>, LedgerError>;
  /** The open `factory:ready` issues nobody is assigned to, and whether the listing was cut. */
  readonly readyIssues: (repo: Repo) => Effect.Effect<Listing<ReadyIssue>, PassError>;
  /** The open `factory:triage` issues the factory's login is the only assignee of. */
  readonly triageIssues: (repo: Repo) => Effect.Effect<Listing<number>, PassError>;
  /**
   * The claims of this factory's that were cut short: see `unassignedClaims` on the tracker.
   * `known` is the issues the pass has a run for, whose label history is not read.
   */
  readonly unassignedClaims: (
    repo: Repo,
    known: ReadonlySet<number>,
  ) => Effect.Effect<ClaimScanResult, PassError>;
  /** Moves a claim that was cut short to `factory:proposed`, with the cut-short comment. */
  readonly releaseClaim: (repo: Repo, issue: number, from: State) => Effect.Effect<void, PassError>;
  /** The open issues the tracker marks as blocking the issue. */
  readonly openBlockers: (
    repo: Repo,
    issue: number,
  ) => Effect.Effect<ReadonlyArray<Blocker>, PassError>;
  /** The open issues the issue's `## Depends on` text names. */
  readonly dependsOnBlockers: (
    repo: Repo,
    issue: number,
  ) => Effect.Effect<ReadonlyArray<Blocker>, PassError>;
  /** The claim: `runner/start.ts`. */
  readonly start: (repo: Repo, issue: number) => Effect.Effect<StartOutcome, StartError>;
  /** The claim gone on with, never made: `resume` in `runner/start.ts`. */
  readonly resume: (repo: Repo, issue: number) => Effect.Effect<StartOutcome, StartError>;
  /**
   * The open issues labelled `factory:triage` or `factory:building`, with that state, and the
   * states whose listing was cut: `claimedIssues` in `tracker/github.ts`.
   */
  readonly claimedIssues: (
    repo: Repo,
  ) => Effect.Effect<
    { readonly states: ReadonlyMap<number, State>; readonly cut: ReadonlyArray<State> },
    PassError
  >;
  /**
   * Finishes this machine's runs of the issue that another machine's claim comment beat, and
   * names that machine: `yieldToClaim` in `runner/start.ts`. Null when this machine's claim won.
   */
  readonly yieldToClaim: (
    repo: Repo,
    issue: number,
  ) => Effect.Effect<
    { readonly machine: string; readonly finished: ReadonlyArray<RunId> } | null,
    StartError
  >;
  /**
   * Takes the stop request an operator left for the run (`factory/scripts/stop-run.sh`) into its
   * ledger: `runner/stop.ts` `takeStopRequest`.
   */
  readonly takeStopRequest: (run: RunId) => Effect.Effect<StopRequestOutcome, LedgerError>;
  /**
   * The time limit: `runner/building.ts` `timeLimit`. This and every other step of a run take
   * `base`, the base its launch recorded (`RunInfo.base`), so the step is built for the run's base
   * without reading the ledger again for it.
   */
  readonly timeLimit: (
    repo: Repo,
    run: RunId,
    base: string | null,
  ) => Effect.Effect<LimitOutcome, BuildingError>;
  /** The text watch: `watch`. */
  readonly watch: (
    repo: Repo,
    run: RunId,
    base: string | null,
  ) => Effect.Effect<WatchOutcome, BuildingError>;
  /** The instructors' comments and edits of the issue body, sent to the session: `forward`. */
  readonly forward: (
    repo: Repo,
    run: RunId,
    base: string | null,
  ) => Effect.Effect<ForwardOutcome, BuildingError>;
  /** The session's result: `advance`. */
  readonly advance: (
    repo: Repo,
    run: RunId,
    base: string | null,
  ) => Effect.Effect<AdvanceOutcome, BuildingError>;
  /**
   * The newest sign of T3 trouble in the machine log within the last ten minutes (a failed `t3`
   * preflight or an `error` of kind `t3`), as its text; null for none. Read once a pass, and only
   * when a session ended badly.
   */
  readonly t3Trouble: () => Effect.Effect<string | null, LedgerError>;
  /** The server starts recorded in the machine log in the last day (`server_started`), oldest first: the rest of the evidence `interrupted` gets. */
  readonly t3Starts: () => Effect.Effect<ReadonlyArray<number>, LedgerError>;
  /** The `server_stopping` each start of the last day follows, whatever its age, oldest first. */
  readonly t3Stops: () => Effect.Effect<ReadonlyArray<number>, LedgerError>;
  /** Decides about a session `advance` said ended badly, with the pass's evidence: `interrupted`. */
  readonly interrupted: (
    repo: Repo,
    run: RunId,
    base: string | null,
    evidence: Evidence,
  ) => Effect.Effect<InterruptOutcome, BuildingError>;
  /**
   * Resumes a session `advance` found rate-limited, once, moving it to `model` first when given:
   * `resumeAfterCooldown`.
   */
  readonly resumeAfterCooldown: (
    repo: Repo,
    run: RunId,
    base: string | null,
    model: Model | null,
  ) => Effect.Effect<CooldownOutcome, BuildingError>;
  /** Each model's provider rate limit, by `cooldownKey`; kept from pass to pass. */
  readonly cooldowns: Map<string, Cooldown>;
  /**
   * The model a new session on the repo's T3 project runs on before any fallback, null for none:
   * read only while a model cools down.
   */
  readonly projectModel: (repo: Repo) => Effect.Effect<Model | null, PassError>;
  /** Whether the run's gate is running now. */
  readonly gateRunning: (run: RunId) => boolean;
  /**
   * Whether a gate send is pending in the run's ledger (`gateSendPending`): only the gate records
   * that the send arrived, so a pass that finds one calls the gate whatever the session is doing.
   */
  readonly hasPendingGateSend: (run: RunId) => Effect.Effect<boolean, LedgerError>;
  /**
   * Starts the run's gate (`runner/gating.ts`) in the background and returns at once: a pass
   * never waits for a gate. The ledger has the result, and the next pass carries on from there.
   */
  readonly gate: (repo: Repo, run: RunId) => Effect.Effect<GateStart>;
  /**
   * The instructors' feedback on a `pr-open` run's pull request and issue, acted on at most once
   * every ten minutes per run: `runner/feedback.ts`. A run it acts on is not gated this pass.
   */
  readonly feedback: (
    repo: Repo,
    run: RunId,
    base: string | null,
  ) => Effect.Effect<FeedbackStep, FeedbackError>;
  /**
   * What a `pr-open` run's last recorded pass ran against, when the pass can compare it with
   * GitHub before it starts the gate; null for a run the gate has more to do for:
   * `runner/gating.ts` `lastPass`.
   */
  readonly lastPass: (run: RunId) => Effect.Effect<LastPass | null, LedgerError>;
  /** Whether GitHub has the issue closed. */
  readonly issueClosed: (repo: Repo, issue: number) => Effect.Effect<boolean, PassError>;
  /** When the issue of each stuck attention item was last read, by item id, in epoch milliseconds; kept from pass to pass. */
  readonly stuckReads: Map<string, number>;
  /** The head of the open pull request, in lower case, and GitHub's mergeable state; null for one that is merged, closed or gone. */
  readonly openPull: (
    repo: Repo,
    pr: number,
  ) => Effect.Effect<{ readonly head: string; readonly mergeable: Mergeable } | null, PassError>;
  /** Appends an `error` line to the run's own ledger. */
  readonly recordError: (
    run: RunId,
    step: CauseStep,
    kind: ErrorKind,
    message: string,
  ) => Effect.Effect<void, LedgerError>;
  /** The claims pause a person made, when there is one. */
  readonly handPause: () => HandPause | null;
  /**
   * Why Paradev cannot take a new session now: the CLI check at start failed, or `superset
   * status` fails this pass. Null when it can. Read once a pass.
   */
  readonly paradevDown: () => Effect.Effect<ParadevDown | null>;
  /** How many passes in a row the Paradev hold has held claims; kept from pass to pass. */
  readonly paradevHold: { passes: number };
  /** Reads a host over ssh: its load each pass, and what `hosts check` asks. */
  readonly ssh: SshRunner;
  /**
   * How many reads of a host's load have failed in a row, by host id; kept from pass to pass. At
   * `HOST_UNREACHABLE_PASSES` the pass raises `host-unreachable`; a good read clears the count.
   */
  readonly hostMisses: Map<string, number>;
  /**
   * Each configured host's reading this pass, by host id: its load, or null when the read failed
   * and the host takes no run this pass. Placement (#55) reads it.
   */
  readonly hostLoads: Map<string, Load | null>;
  /**
   * The hosts that failed `hosts check` at the last config load, by host id, with the first
   * failing line: none of them is a launch candidate. Placement (#55) reads it.
   */
  readonly hostsNotReady: ReadonlyMap<string, string>;
  /**
   * The free space of the fuller of the volumes that hold the sessions' worktrees and the gate's
   * checkouts; not read when `min_free_gib` is 0.
   */
  readonly freeSpace: () => Effect.Effect<FreeSpace, PassError>;
  /** The machine's 1-minute load and its cores; not read when `max_load_per_core` is 0. */
  readonly load: () => Load;
  /** The live threads whose worktree is gone or no longer a git checkout: `brokenWorktrees` on the sessions. */
  readonly threadsOnBrokenWorktrees: () => Effect.Effect<
    ReadonlyArray<ThreadOnBrokenWorktree>,
    PassError
  >;
  /** Reads every run file in the ledger whole, so only for a pass that found such a thread. */
  readonly sessionRuns: () => Effect.Effect<SessionRuns, PassError>;
  /** Archives the thread: `archive` on the sessions. */
  readonly archiveThread: (threadId: string) => Effect.Effect<void, PassError>;
  readonly brokenThreads: BrokenThreadMemo;
  /**
   * How many passes in a row each repo's project config has not loaded, by lower-cased
   * `owner/name`; kept from pass to pass, and from scratch after a restart.
   */
  readonly configSkips: Map<string, number>;
  /**
   * The project config and tracker login each repo last loaded, by lower-cased `owner/name`: what
   * a pass runs on when a re-read fails in a way that says GitHub never received the call.
   */
  readonly lastGood: Map<string, LastGood>;
  /** Prunes the repo's stale `t3/*` branches: `t3/branchPrune.ts`. */
  readonly pruneBranches: (repo: Repo) => Effect.Effect<PruneReport, PassError>;
  /** When each repo's branches were last pruned, by lower-cased `owner/name`; kept from pass to pass. */
  readonly prunedAt: Map<string, number>;
  readonly nowMs: () => number;
  /** Writes one event to the machine log. */
  readonly record: (event: MachineEvent) => Effect.Effect<void, LedgerError>;
  /** The open attention items: what the pass raises when it needs a person, and what it clears. */
  readonly attention: Pick<Attention["Service"], "list" | "raise" | "clear">;
}

/**
 * What starting a gate did: it runs now, `max_concurrent_gates` are running already, or one is
 * running and the load is above `max_load_per_core`.
 */
export type GateStart =
  | { readonly kind: "started" }
  | { readonly kind: "queued"; readonly running: number; readonly max: number }
  | { readonly kind: "high-load"; readonly oneMinute: number; readonly limit: number };

/** The line of a run that ended in `stuck`. The reason is not printed: it can hold text the session or GitHub wrote. */
export const stuckLine = (run: string): string =>
  `stuck, the reason is in the ledger of run ${run}`;

/** The attention item of a run that ended in `stuck`, whether a pass or a background gate saw it end. */
export const stuckItem = (repo: string, issue: number, run: string): NewItem => ({
  id: `run:${run}:stuck`,
  kind: "stuck",
  repo,
  issue,
  run,
  message: `${plain(repo)}${mention(issue)} ${stuckLine(run)}`,
});

/** The attention line for a run whose issue a person closed, after the issue's label. */
const abandonedText = (label: string): string =>
  `${label} Abandoned: the issue was closed, so the factory stopped the session and closed the run`;

/**
 * The item `abandoned` raises for a run whose issue a person closed, which the background gate
 * raises too when it is the step that finds the issue closed.
 */
export const abandonedItem = (repo: string, issue: number, run: string): NewItem => ({
  id: `attention:${run}:abandoned`,
  kind: "attention",
  repo,
  issue,
  run,
  message: abandonedText(`${plain(repo)}${mention(issue)}`),
});

/** The counts the pass prints in its last line. */
export interface Report {
  runs: number;
  claimed: number;
  errors: number;
  attention: number;
}

/** What the pass has to say about one issue, collected as its steps go and printed at the end. */
interface Notes {
  readonly repo: string;
  readonly issue: number;
  readonly label: string;
  readonly state: string;
  readonly parts: Array<string>;
  readonly errors: Array<NoteError>;
  /** The attention items to raise when the notes are flushed. */
  readonly raises: Array<NewItem>;
  /** How `advance` found the session's run ended, when it ended badly: the pass decides about it after every run. */
  endedBadly: BadEnd | null;
}

/** An error, as printed and as recorded. */
interface NoteError {
  /** The error line, without its `error: ` prefix. */
  readonly line: string;
  readonly step: CauseStep;
  readonly kind: ErrorKind;
  /** What went wrong, before it is cleaned for the ledger. */
  readonly message: string;
  /**
   * T3's session layer did not answer (a `FactorySessionsError`); the error also goes to the
   * machine log, where `t3Trouble` reads it as the sign that sessions ended badly by interruption.
   * The project lookup is in-process and cannot fail when T3 is down, so these calls are the sign.
   */
  readonly t3Down?: boolean;
}

/** `text` with nothing in it that could drive a terminal or hide text. */
export const plain = (text: string): string => sanitize(text, false);

/** An error of the pass's own, in the words `what` and `detail`. */
const passError = (kind: ErrorKind, what: string, detail: string): NoteError => ({
  line: `${plain(what)}${plain(detail)}`,
  step: "pass",
  kind,
  message: `${what}${detail}`,
});

/**
 * What an error of a run's step was about, for its `error` line. Every call `start` makes is a
 * tracker call, whatever host the tracker runs on; the gate's checkout is git.
 */
export const errorKind = (error: StartError | BuildingError | GateStepError): ErrorKind => {
  switch (error._tag) {
    case "WorkspaceFailedError":
    case "WorkspaceUnexpectedError":
    case "WorkspaceCleanupError":
    case "WorkspaceIoError":
    case "WorkspaceSpawnError":
      return "git";
    case "GitHubSpawnError":
    case "GitHubInvalidArgument":
    case "GitHubFailed":
    case "GitHubTimedOut":
    case "GitHubOutputTooLarge":
    case "GitHubParse":
    case "GitHubRateLimited":
      return "tracker";
    case "GateRunningError":
    case "GateCommandSpawnError":
    case "GateRecordError":
      return "gate";
    case "FactorySessionsError":
    case "FactoryThreadNotFoundError":
    case "FactoryMessageRejectedError":
      return "t3";
    case "WrongRepoError":
    case "NoGateCommandsError":
      return "config";
    default:
      // The run's own record disagrees with what the step expected.
      return "ledger";
  }
};

/**
 * The sessions operations that are a call on T3 itself: one that fails is T3 in trouble, the sign
 * `t3Trouble` reads. `launch` is left out, as it also fails on the worktree (git, `origin`) and on
 * bad ids, and so is `remove-worktree`, which is git on this machine.
 */
const T3_OPERATIONS: ReadonlySet<SessionsError["operation"]> = new Set([
  "find-project",
  "status",
  "thread",
  "send",
  "archive",
]);

/** Repos match as run ids do: `owner/name` folded with `asciiLower`. */
const sameRepo = (a: string, b: string) => asciiLower(a) === asciiLower(b);

const GATE_RUNNING = "gate running";
const PULL_REQUEST_ENDED = "its pull request was merged or closed, the run is finished";
/** The line of a building run whose gate this pass started. */
const GATE_STARTED = "gate started in the background";
/** The words for a gate that could not start: `max_concurrent_gates` are running. */
export const gateQueued = (start: { readonly running: number; readonly max: number }) =>
  `gate queued: ${start.running} gates running, max_concurrent_gates is ${start.max}`;
/** `1-minute load 55.2 is above 12`. */
const loadAboveLimit = (over: Pick<Overload, "oneMinute" | "limit">): string =>
  `1-minute load ${over.oneMinute.toFixed(1)} is above ${over.limit}`;
/** The line of a gate held back because the load is high and a gate runs already. */
const gateHeldByLoad = (over: Pick<Overload, "oneMinute" | "limit">) =>
  `gate queued: ${loadAboveLimit(over)} and a gate is already running`;
/** The line of a run whose gate passed. */
export const GATE_PASSED_LINE = "the gate passed and the pull request is ready for review";

const FROM_TEXT = " (from Depends on, add the GitHub link)";

/** `blocked by #13, acme/widgets#7`: a blocker in the repo being claimed from is written by its number alone. */
const blockedBy = (repo: string, blockers: ReadonlyArray<Blocker>, suffix: string): string =>
  `blocked by ${blockers
    .map((b) =>
      sameRepo(b.repo, repo)
        ? `${mention(b.number)}${suffix}`
        : `${plain(b.repo)}${mention(b.number)}${suffix}`,
    )
    .join(", ")}`;

const plural = (n: number, one: string) => (n === 1 ? one : `${one}s`);

/** The machine log's text limit, as softfac prepares session text: cleaned, trimmed, cut. */
const SESSION_TEXT_LIMIT = 4000;
const prepareText = (text: string): string => {
  const trimmed = text.replaceAll("\r\n", "\n").trim();
  const chars = Array.from(trimmed);
  const cut =
    chars.length > SESSION_TEXT_LIMIT
      ? `${chars.slice(0, SESSION_TEXT_LIMIT).join("")}\n[cut]`
      : trimmed;
  return sanitize(cut, true);
};

/**
 * A pass this far in starts no more claims: `PASS_TIMEOUT` stops a pass wherever it is, and a
 * claim cut short goes stuck. The margin covers one claim whose GitHub calls all retry.
 */
const CLAIM_CUTOFF_MS = Duration.toMillis(PASS_TIMEOUT) - 10 * 60_000;

/** A pass in flight: the counts, the lines, and whether the machine log has failed once. */
class Pass {
  readonly report: Report = { runs: 0, claimed: 0, errors: 0, attention: 0 };
  /** A probed volume is below `min_free_gib`: nothing is claimed and no gate starts. */
  lowDisk = false;
  /** The load is above `max_load_per_core`: nothing is claimed. */
  highLoad = false;
  /** Paradev does not answer, or its CLI lacks what the runner uses: nothing is claimed. */
  paradevOffline = false;
  /** The machine's `model_fallbacks`. */
  fallbacks: Readonly<Record<string, string>> = {};
  readonly startedMs: number;
  private logFailed = false;
  private readonly world: PassWorld;
  private readonly out: (line: string) => void;

  constructor(world: PassWorld, out: (line: string) => void) {
    this.world = world;
    this.out = out;
    this.startedMs = world.nowMs();
  }

  line(text: string): void {
    this.out(text);
  }

  error(text: string): void {
    this.report.errors += 1;
    this.out(`error: ${text}`);
  }

  /**
   * A line a person has to act on about `run`, the machine log's `attention` event for it with
   * the ledger.md `reason` code, and an attention item whose message is the line.
   */
  attention(notes: Notes, text: string, run: string, reason: string): Effect.Effect<void> {
    this.report.attention += 1;
    this.out(`ATTENTION: ${text}`);
    return this.record({ event: "attention", data: { run, reason } }).pipe(
      Effect.andThen(
        this.world.attention.raise({
          id: `attention:${run}:${reason}`,
          kind: "attention",
          repo: notes.repo,
          issue: notes.issue,
          run,
          message: text,
        }),
      ),
    );
  }

  /**
   * Writes `event` to the machine log. A log that cannot be written is an error line once per
   * pass and nothing else: it is not an event, which could not be written either.
   */
  record(event: MachineEvent): Effect.Effect<void> {
    return this.world.record(event).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          if (this.logFailed) return;
          this.logFailed = true;
          this.error(`machine log: ${plain(error.message)}`);
        }),
      ),
    );
  }

  /**
   * Prints `error` as an error line and records it: in the ledger of `run` when it can take it,
   * else in the machine log. A `t3Down` error goes to both, so the machine log holds this pass's
   * T3 trouble. `unreadable` is a run whose own ledger cannot be read.
   */
  fail(run: RunId | null, error: NoteError, unreadable = false): Effect.Effect<void> {
    this.error(error.line);
    const message = prepareText(error.message);
    const toMachineLog = (id: string | null) =>
      this.record({
        event: "error",
        data: { ...(id === null ? {} : { run: id }), step: error.step, kind: error.kind, message },
      });
    if (run === null) return toMachineLog(null);
    const id = runIdToString(run);
    if (unreadable) return toMachineLog(id);
    return this.world.recordError(run, error.step, error.kind, message).pipe(
      Effect.matchEffect({
        onFailure: () => toMachineLog(id),
        onSuccess: () => (error.t3Down === true ? toMachineLog(id) : Effect.void),
      }),
    );
  }

  notes(repo: string, issue: number, state: State | null): Notes {
    return {
      repo,
      issue,
      label: `${plain(repo)}${mention(issue)}`,
      state: state ?? "starting",
      parts: [],
      errors: [],
      raises: [],
      endedBadly: null,
    };
  }

  /** The step called `label` in the pass line failed for this issue; the ledger records it under `step`. */
  failed(notes: Notes, label: string, step: CauseStep, error: StartError | BuildingError): void {
    notes.errors.push({
      line: `${notes.label} ${label}: ${plain(error.message)}`,
      step,
      kind: errorKind(error),
      message: error.message,
      t3Down: error._tag === "FactorySessionsError" && T3_OPERATIONS.has(error.operation),
    });
  }

  /** An error of the pass's own about this issue, in the words `what` and `detail`. */
  trouble(notes: Notes, kind: ErrorKind, what: string, detail: string): void {
    const error = passError(kind, what, detail);
    notes.errors.push({ ...error, line: `${notes.label} ${error.line}` });
  }

  /** The run ended in `stuck`. */
  stuck(notes: Notes, run: string): void {
    notes.parts.push(stuckLine(run));
    notes.raises.push(stuckItem(notes.repo, notes.issue, run));
  }

  flush(notes: Notes, run: RunId | null): Effect.Effect<void> {
    if (notes.parts.length > 0) {
      this.line(`${notes.label} ${notes.state}: ${notes.parts.join(", ")}`);
    }
    return Effect.forEach(notes.raises, (item) => this.world.attention.raise(item), {
      discard: true,
    }).pipe(
      Effect.andThen(
        Effect.forEach(notes.errors, (error) => this.fail(run, error), { discard: true }),
      ),
    );
  }

  sayIfCut(repo: string, state: State, cut: boolean): void {
    if (cut) {
      this.line(
        `${plain(repo)}: more than ${LIST_LIMIT} open ${stateLabel(state)} issues, so the oldest were not read`,
      );
    }
  }
}

/** One pass. Calls `out` with each line as it is decided. */
export const runPass = Effect.fn("Pass.runPass")(function* (
  world: PassWorld,
  machine: MachineConfig,
  out: (line: string) => void,
) {
  const pass = new Pass(world, out);
  pass.fallbacks = machine.modelFallbacks;
  yield* pass.record({ event: "pass_started", data: {} });
  const listed = yield* Effect.result(world.watchedRepos);
  if (listed._tag === "Failure") {
    // Without the list nothing is worked, and nothing is cleared: a repo that is missing from
    // an unread list has not left it.
    yield* pass.fail(null, passError(listed.failure.kind, "", listed.failure.message));
  }
  const listing =
    listed._tag === "Success" ? listed.success : { repos: [], departed: [], unresolved: [] };
  const watched = listing.repos;
  // A repo whose T3 project was deleted has nothing the factory still needs a person for. Only
  // the reader's `departed` says so: a repo whose project stays (a branch without the opt-in,
  // an unreadable checkout) keeps its items, since `stuck` and `needs-info` are raised once.
  if (listed._tag === "Success") {
    yield* world.attention.clear(
      (item) => item.repo !== null && listing.departed.some((repo) => sameRepo(repo, item.repo!)),
    );
    // The config skips are counted in a row: a repo not in this pass's list, whether it left or
    // its checkout could not be settled this time, starts over. Only a list that could not be
    // read at all says nothing about any repo, so then every count stays.
    const watchedKeys = new Set(watched.map((repo) => asciiLower(repo.repo)));
    for (const key of world.configSkips.keys()) {
      if (!watchedKeys.has(key)) world.configSkips.delete(key);
    }
    for (const key of world.lastGood.keys()) {
      if (!watchedKeys.has(key)) world.lastGood.delete(key);
    }
    if (listing.unresolved.length > 0) {
      pass.line(
        `watched: ${listing.unresolved.length} project(s) could not be settled this pass (${listing.unresolved.map(plain).join(", ")})`,
      );
    }
  }
  const repos = yield* loadRepos(world, watched, pass);
  pass.lowDisk = yield* lowDisk(world, machine, pass);
  pass.highLoad = yield* highLoad(world, machine, pass);
  pass.paradevOffline = yield* paradevOffline(world, pass);
  yield* hostLoads(world, machine, pass);
  yield* brokenWorktrees(world, pass);
  // Without the ledger there is no telling how many runs are active, so nothing is claimed.
  const infos = yield* runs(world, pass);
  if (infos !== null) {
    const known = new Known(infos);
    yield* yieldedRuns(world, repos, known, pass);
    yield* workRuns(world, repos, known, pass);
    // The runs this machine holds go on above; a repo another machine owns gets nothing new.
    const owned = yield* ownedRepos(world, repos, pass);
    yield* untrackedClaims(world, owned, known, pass);
    yield* unassignedClaims(world, owned, known, pass);
    yield* sayCooldowns(world, pass);
    yield* claim(world, owned, known, machine, pass);
    // Last: a claim of an issue put back to `ready` ends its older pr-open run, and a re-gate
    // takes a gate slot.
    yield* prOpenRuns(world, repos, known, pass);
    // After every claim and launch of the pass, so none is under way while a repo is pruned.
    yield* pruneStaleBranches(world, repos, machine, pass);
    // A run-bound attention item whose run is no longer unfinished (stopped, abandoned, timed
    // out, claimed on) is over. `stuck` and `needs-info` items are about finished runs and stay.
    if (!known.lost) {
      yield* world.attention.clear(
        (item) =>
          item.kind === "attention" &&
          item.run !== null &&
          !known.infos.some((info) => runIdToString(info.id) === item.run),
      );
    }
  }
  yield* closedStuck(world, repos, pass);
  const report = pass.report;
  pass.line(
    `pass done: ${report.runs} runs, ${report.claimed} claimed, ${report.errors} errors, ${report.attention} need attention`,
  );
  yield* pass.record({ event: "pass_finished", data: { ...report } });
  return report;
});

/**
 * How often the issue of one stuck item is read at most. Stuck items stay until a person or the
 * issue closes them, so they pile up: at 40 of them a 60 second poll would spend 2,400 reads an
 * hour of the login's 5,000 points. At one read in 10 minutes it is about 240.
 */
export const STUCK_READ_EVERY_MS = 10 * 60 * 1000;

/**
 * Clears the item of a stuck run whose issue GitHub has closed. Only stuck items of repos loaded
 * this pass are asked about, each at most once every `STUCK_READ_EVERY_MS`. An issue that cannot
 * be read leaves the item with a non-error line: one that can never be read again (deleted,
 * transferred) must not fail every pass.
 */
const closedStuck = Effect.fn("Pass.closedStuck")(function* (
  world: PassWorld,
  repos: ReadonlyArray<Loaded>,
  pass: Pass,
) {
  const items = yield* world.attention.list();
  for (const id of world.stuckReads.keys()) {
    if (!items.some((item) => item.id === id)) world.stuckReads.delete(id);
  }
  const now = world.nowMs();
  for (const item of items) {
    const { repo: name, issue } = item;
    if (item.kind !== "stuck" || name === null || issue === null) continue;
    const loaded = repos.find((l) => l.kind === "ready" && sameRepo(l.repo.watched.repo, name));
    if (loaded === undefined || loaded.kind !== "ready") continue;
    const last = world.stuckReads.get(item.id);
    if (last !== undefined && now >= last && now - last < STUCK_READ_EVERY_MS) continue;
    world.stuckReads.set(item.id, now);
    const closed = yield* Effect.result(world.issueClosed(loaded.repo, issue));
    if (closed._tag === "Failure") {
      pass.line(
        plain(
          `${name}${mention(issue)}: cannot read whether the issue is closed: ${closed.failure.message}`,
        ),
      );
    } else if (closed.success) {
      yield* world.attention.clear((open) => open.id === item.id);
      world.stuckReads.delete(item.id);
    }
  }
});

/** How often a repo's `t3/*` branches are pruned at most. */
export const PRUNE_EVERY_MS = 60 * 60 * 1000;

/** Prunes each loaded repo's stale `t3/*` branches, at most once every `PRUNE_EVERY_MS`. */
const pruneStaleBranches = Effect.fn("Pass.pruneStaleBranches")(function* (
  world: PassWorld,
  repos: ReadonlyArray<Loaded>,
  machine: MachineConfig,
  pass: Pass,
) {
  const now = world.nowMs();
  for (const loaded of repos) {
    if (loaded.kind !== "ready") continue;
    const name = loaded.repo.watched.repo;
    const last = world.prunedAt.get(asciiLower(name));
    if (last !== undefined && now >= last && now - last < PRUNE_EVERY_MS) continue;
    world.prunedAt.set(asciiLower(name), now);
    const result = yield* Effect.result(world.pruneBranches(loaded.repo));
    if (result._tag === "Failure") {
      const { kind, message } = result.failure;
      yield* pass.fail(null, passError(kind, `${name}: branch prune: `, message));
      continue;
    }
    for (const { ref, sha, reason } of result.success.pruned) {
      pass.line(plain(`${name}: pruned ${ref} at ${sha} (${reason})`));
    }
    for (const { ref, why } of result.success.left) {
      pass.line(plain(`${name}: left ${ref}: ${why}`));
    }
    for (const { ref, kind, why } of result.success.failed) {
      yield* pass.fail(null, passError(kind, `${name}: branch prune: ${ref}: `, why));
    }
    if (result.success.waiting > 0) {
      pass.line(
        plain(`${name}: ${result.success.waiting} remote branches wait for the next prune`),
      );
    }
  }
});

/** The machine's attention item while a probed volume is below `min_free_gib`. */
const LOW_DISK_ITEM_ID = "low-disk";

/**
 * Whether the worktrees' or gate checkouts' volume has less free than `min_free_gib`. A full disk
 * fails runs and gates for reasons that are not the code, so the pass claims nothing and starts no
 * gate: one line, one `claim_skipped` event and one attention item that clears when space returns.
 * An unreadable space is an error line and holds nothing back. 0 turns it off.
 */
const lowDisk = Effect.fn("Pass.lowDisk")(function* (
  world: PassWorld,
  machine: MachineConfig,
  pass: Pass,
) {
  const clear = world.attention.clear((item) => item.id === LOW_DISK_ITEM_ID);
  if (machine.minFreeGib === 0) {
    yield* clear;
    return false;
  }
  const read = yield* Effect.result(world.freeSpace());
  if (read._tag === "Failure") {
    yield* pass.fail(
      null,
      passError(read.failure.kind, "cannot read the free disk space: ", read.failure.message),
    );
    // Claims go on, so an item that says they do not would be wrong.
    yield* clear;
    return false;
  }
  const { path, freeBytes } = read.success;
  if (!isLowDisk(freeBytes, machine.minFreeGib)) {
    yield* clear;
    return false;
  }
  const held = "no issue is claimed and no gate starts until there is more";
  pass.line(
    `low disk: ${(freeBytes / GIB).toFixed(1)} GiB free on ${plain(path)}, below min_free_gib ${machine.minFreeGib}; ${held}`,
  );
  pass.report.attention += 1;
  yield* pass.record({ event: "claim_skipped", data: { reason: "low-disk" } });
  yield* world.attention.raise({
    id: LOW_DISK_ITEM_ID,
    kind: "attention",
    repo: null,
    issue: null,
    run: null,
    // No figure and no path: an open item is not raised again, so they would go stale.
    message: `low disk: free space is below min_free_gib ${machine.minFreeGib}; ${held}`,
  });
  return true;
});

/**
 * Whether the 1-minute load is above `max_load_per_core` times the cores. Gates on an overloaded
 * machine fail on timeouts the code did not cause, so the pass claims nothing, with no attention
 * item: load drops without a person. `Factory.startGate` holds a second gate by the same rule.
 * 0 turns it off; relaunches of claimed runs are not held back.
 */
const highLoad = Effect.fn("Pass.highLoad")(function* (
  world: PassWorld,
  machine: MachineConfig,
  pass: Pass,
) {
  const over = overload(machine.maxLoadPerCore, () => world.load());
  if (over === null) return false;
  pass.line(
    `high load: ${loadAboveLimit(over)} (${over.cores} cores x max_load_per_core ${machine.maxLoadPerCore}); no issue is claimed and a second gate waits until it drops`,
  );
  yield* pass.record({ event: "claim_skipped", data: { reason: "high-load" } });
  return true;
});

/** The machine's attention item while the Paradev hold has lasted `PARADEV_HOLD_PASSES` passes. */
export const PARADEV_OFFLINE_ITEM_ID = "paradev-offline";

/** Passes in a row the Paradev hold lasts before it raises its attention item. */
export const PARADEV_HOLD_PASSES = 3;

/**
 * The line of a run in `triage` while Paradev is offline. Its resume may launch a session, and a
 * launch that fails sends the run stuck, so it waits for Paradev as a new claim does.
 */
export const PARADEV_WAIT = "waits for Paradev to resume it";

/** The attention text of a Paradev hold, by what failed. */
const paradevHoldText = (down: ParadevDown): string => {
  const held = `no issue has been claimed for ${PARADEV_HOLD_PASSES} passes`;
  switch (down.reason) {
    case "offline":
      return `Paradev is offline: ${held}; open the Paradev app, or start its host service (superset status fails)`;
    case "signed-out":
      return `Paradev is signed out: ${held}; run superset auth login`;
    case "cli-check":
      return `the Paradev CLI check failed: ${held}; ${plain(down.message)}`;
  }
};

/**
 * Whether Paradev holds claims back: while the CLI check or `superset status` fails, the pass
 * claims nothing and records `claim_skipped` with reason `paradev-offline`. Running builds are
 * worked as usual. Once the hold has lasted `PARADEV_HOLD_PASSES` passes in a row one attention
 * item is raised; it clears on the first pass Paradev answers.
 */
const paradevOffline = Effect.fn("Pass.paradevOffline")(function* (world: PassWorld, pass: Pass) {
  const down = yield* world.paradevDown();
  if (down === null) {
    world.paradevHold.passes = 0;
    yield* world.attention.clear((item) => item.id === PARADEV_OFFLINE_ITEM_ID);
    return false;
  }
  world.paradevHold.passes += 1;
  pass.line(
    `paradev offline: ${plain(down.message)}; no issue claimed or resumed until Paradev answers`,
  );
  yield* pass.record({ event: "claim_skipped", data: { reason: "paradev-offline" } });
  if (world.paradevHold.passes < PARADEV_HOLD_PASSES) return true;
  pass.report.attention += 1;
  yield* world.attention.raise({
    id: PARADEV_OFFLINE_ITEM_ID,
    kind: "attention",
    repo: null,
    issue: null,
    run: null,
    message: paradevHoldText(down),
  });
  return true;
});

/** Passes in a row a host's load may fail to read before one attention item is raised. */
export const HOST_UNREACHABLE_PASSES = 3;

/** The id prefix of a host's `host-unreachable` attention item; the host id follows. */
export const HOST_UNREACHABLE_PREFIX = "host-unreachable:";

/**
 * Reads every configured host's load once, all at once, before any claim or launch. A host whose
 * read fails has a null load this pass and takes no run; after `HOST_UNREACHABLE_PASSES` failed
 * passes in a row one attention item names it, and the first good read clears it. A host that
 * has left the config is forgotten, and its item is cleared.
 */
const hostLoads = Effect.fn("Pass.hostLoads")(function* (
  world: PassWorld,
  machine: MachineConfig,
  pass: Pass,
) {
  const ids = new Set(machine.hosts.map((host) => host.id));
  for (const map of [world.hostMisses, world.hostLoads]) {
    for (const id of map.keys()) if (!ids.has(id)) map.delete(id);
  }
  yield* world.attention.clear(
    (item) => item.id.startsWith(HOST_UNREACHABLE_PREFIX) && !ids.has(item.id.slice(HOST_UNREACHABLE_PREFIX.length)),
  );
  const reads = yield* Effect.forEach(
    machine.hosts,
    (host) => Effect.result(readHostLoad(world.ssh, host)),
    { concurrency: "unbounded" },
  );
  for (const [index, host] of machine.hosts.entries()) {
    const read = reads[index]!;
    const itemId = `${HOST_UNREACHABLE_PREFIX}${host.id}`;
    if (read._tag === "Success") {
      world.hostLoads.set(host.id, read.success);
      world.hostMisses.delete(host.id);
      yield* world.attention.clear((item) => item.id === itemId);
      continue;
    }
    world.hostLoads.set(host.id, null);
    const misses = (world.hostMisses.get(host.id) ?? 0) + 1;
    world.hostMisses.set(host.id, misses);
    pass.line(
      `host ${host.name}: its load was not read over ssh (${plain(read.failure)}); it takes no run this pass`,
    );
    if (misses < HOST_UNREACHABLE_PASSES) continue;
    pass.report.attention += 1;
    // No error text: an open item is not raised again, so it would go stale.
    yield* world.attention.raise({
      id: itemId,
      kind: "attention",
      repo: null,
      issue: null,
      run: null,
      message: `host ${host.name} (${host.ssh}) has not answered over ssh for ${HOST_UNREACHABLE_PASSES} passes; it takes no run until it does`,
    });
  }
});

/** How often a pass reads the whole ledger again for threads on a broken worktree it could not settle. */
export const UNSETTLED_READ_EVERY_MS = 5 * 60 * 1000;

/**
 * Archives live threads on a stopped session's worktree that is gone or no longer a git checkout,
 * where T3's pull request lookup runs git every minute and fails. Only a stopped session's worktree
 * is the factory's: until then the run's own stop archives it. The attention item names the run in
 * its text, not in `run`, so it stays after the run finished.
 */
const brokenWorktrees = Effect.fn("Pass.brokenWorktrees")(function* (world: PassWorld, pass: Pass) {
  const cannotCheck = (failure: PassError) =>
    pass.fail(
      null,
      passError(failure.kind, "cannot check the sessions' worktrees: ", failure.message),
    );
  const found = yield* Effect.result(world.threadsOnBrokenWorktrees());
  if (found._tag === "Failure") return yield* cannotCheck(found.failure);
  const memo = world.brokenThreads;
  const broken = found.success.filter((thread) => !memo.notFactory.has(thread.threadId));
  if (broken.length === 0) return;
  const now = world.nowMs();
  const waiting = broken.every((thread) => {
    const last = memo.unsettled.get(thread.threadId);
    return last !== undefined && now >= last && now - last < UNSETTLED_READ_EVERY_MS;
  });
  if (waiting) return;
  const read = yield* Effect.result(world.sessionRuns());
  if (read._tag === "Failure") return yield* cannotCheck(read.failure);
  const { runs, complete } = read.success;
  memo.unsettled.clear();
  const byPath = new Map<string, { run: RunId; threadIds: Array<string> }>();
  for (const { threadId, worktreePath, threadsOnPath } of broken) {
    const owner = threadsOnPath.map((id) => runs.get(id)).find((r) => r !== undefined);
    if (owner === undefined && complete) memo.notFactory.add(threadId);
    else if (owner?.stopped !== true) memo.unsettled.set(threadId, now);
    if (owner?.stopped !== true) continue;
    const entry = byPath.get(worktreePath) ?? { run: owner.run, threadIds: [] };
    entry.threadIds.push(threadId);
    byPath.set(worktreePath, entry);
  }
  for (const [worktreePath, { run, threadIds }] of byPath) {
    let archived = 0;
    for (const threadId of threadIds) {
      const result = yield* Effect.result(world.archiveThread(threadId));
      if (result._tag === "Failure") {
        yield* pass.fail(
          null,
          passError(
            result.failure.kind,
            `cannot archive thread ${threadId} on broken worktree ${worktreePath}: `,
            result.failure.message,
          ),
        );
      } else {
        archived += 1;
      }
    }
    if (archived === 0) continue;
    const what = `${run.repo}#${run.issue}: worktree ${worktreePath} of run ${runIdToString(run)} is gone or no longer a git checkout`;
    pass.line(
      plain(
        `${what}; archived ${archived} thread(s) still on it, so T3 stops looking up their branch there`,
      ),
    );
    pass.report.attention += 1;
    const issue = Number(run.issue);
    yield* world.attention.raise({
      id: `worktree:${worktreePath}`,
      kind: "attention",
      repo: run.repo,
      issue: Number.isInteger(issue) ? issue : null,
      run: null,
      // No count: an open item is not raised again, so it would go stale.
      message: plain(`${what}; the factory archived the threads still on it`),
    });
  }
});

/** After this many passes in a row without a repo's config, a person is told. */
const CONFIG_SKIPS_BEFORE_ATTENTION = 3;

const configNotLoadedId = (key: string): string => `config-not-loaded:${key}`;

/**
 * The project config and tracker login of every watched repo. A repo whose config or login cannot
 * be read, or that two T3 projects name (`ambiguousRepos`), is reported and its issues left
 * alone. A config failing {@link CONFIG_SKIPS_BEFORE_ATTENTION} passes in a row raises an
 * attention item that the next successful load clears.
 */
const loadRepos = Effect.fn("Pass.loadRepos")(function* (
  world: PassWorld,
  watchedRepos: ReadonlyArray<WatchedRepo>,
  pass: Pass,
) {
  const repos: Array<Loaded> = [];
  const ambiguous = ambiguousRepos(watchedRepos);
  const said = new Set<string>();
  const countMiss = Effect.fn("Pass.countMiss")(function* (
    key: string,
    watched: WatchedRepo,
    message: string,
    stale: boolean,
  ) {
    const skips = (world.configSkips.get(key) ?? 0) + 1;
    world.configSkips.set(key, skips);
    if (skips < CONFIG_SKIPS_BEFORE_ATTENTION) return;
    pass.report.attention += 1;
    yield* world.attention.raise({
      id: configNotLoadedId(key),
      kind: "attention",
      repo: watched.repo,
      issue: null,
      run: null,
      message: plain(
        stale
          ? `${watched.repo}: project config or tracker login could not be re-read for ${CONFIG_SKIPS_BEFORE_ATTENTION} passes in a row, running on the last good copy; last error: ${message}`
          : `${watched.repo}: project config not loaded for ${CONFIG_SKIPS_BEFORE_ATTENTION} passes in a row, issues are not being picked up; last error: ${message}`,
      ),
    });
  });
  const clearMiss = Effect.fn("Pass.clearMiss")(function* (key: string) {
    world.configSkips.delete(key);
    // Cleared whether or not this process counted the skips: the item outlives a restart.
    yield* world.attention.clear((item) => item.id === configNotLoadedId(key));
  });
  for (const watched of watchedRepos) {
    const key = asciiLower(watched.repo);
    const paths = ambiguous.get(key);
    if (paths !== undefined) {
      // Said once per repo, not per project: the repo is skipped whole.
      if (!said.has(key)) {
        said.add(key);
        const message = `${watched.repo}: ${ambiguousMessage(paths)}`;
        pass.error(plain(message));
        yield* pass.record({
          event: "repo_skipped",
          data: {
            repo: watched.repo,
            reason: "ambiguous-project",
            message: prepareText(message),
          },
        });
        repos.push({ kind: "broken", name: watched.repo });
      }
      // Not tried, so not a skip in a row.
      world.configSkips.delete(key);
      continue;
    }
    // The first failure this pass fell back on a last good copy for, if any.
    let staleMessage: string | null = null;
    const useStale = Effect.fn("Pass.useStale")(function* (
      what: "config" | "login",
      message: string,
    ) {
      const text = prepareText(message);
      pass.line(
        plain(
          `${watched.repo}: ${what === "config" ? "project config" : "tracker login"} could not be re-read, using the last good copy: ${text}`,
        ),
      );
      yield* pass.record({
        event: "repo_config_stale",
        data: { repo: watched.repo, what, message: text },
      });
      staleMessage ??= message;
    });
    const loaded = yield* Effect.result(world.project(watched));
    let projectNow: ProjectConfig;
    if (loaded._tag === "Failure") {
      const failure = loaded.failure;
      const message = failure.message;
      const copy = lastGoodCopy(world.lastGood, watched.repo, "project", failure);
      if (copy !== undefined) {
        projectNow = copy;
        yield* useStale("config", message);
      } else {
        // A config removed or broken on purpose must not come back on a later blip.
        world.lastGood.set(key, { ...world.lastGood.get(key), project: undefined });
        pass.error(
          `${plain(watched.repo)}: project config not loaded, repo skipped: ${plain(message)}`,
        );
        yield* pass.record({
          event: "repo_skipped",
          data: { repo: watched.repo, reason: "config-not-loaded", message: prepareText(message) },
        });
        yield* countMiss(key, watched, message, false);
        repos.push({ kind: "broken", name: watched.repo });
        continue;
      }
    } else {
      projectNow = loaded.success;
      world.lastGood.set(key, { ...world.lastGood.get(key), project: projectNow });
    }
    const loginResult = yield* Effect.result(world.trackerUser(watched));
    let userNow: string;
    if (loginResult._tag === "Failure") {
      const failure = loginResult.failure;
      const copy = lastGoodCopy(world.lastGood, watched.repo, "trackerUser", failure);
      if (copy !== undefined) {
        userNow = copy;
        yield* useStale("login", failure.message);
      } else {
        world.lastGood.set(key, { ...world.lastGood.get(key), trackerUser: undefined });
        // A fresh config clears the count whatever became of the login, as it always has.
        if (staleMessage === null) yield* clearMiss(key);
        else
          yield* countMiss(
            key,
            watched,
            `cannot read the tracker's login: ${failure.message}`,
            false,
          );
        yield* pass.fail(
          null,
          passError(
            failure.kind,
            `${watched.repo}: cannot read the tracker's login: `,
            failure.message,
          ),
        );
        repos.push({ kind: "broken", name: watched.repo });
        continue;
      }
    } else {
      userNow = loginResult.success;
      world.lastGood.set(key, { ...world.lastGood.get(key), trackerUser: userNow });
    }
    // Counted like a skip when stale, so a read that keeps failing is still told to a person.
    if (staleMessage === null) yield* clearMiss(key);
    else yield* countMiss(key, watched, staleMessage, true);
    repos.push({
      kind: "ready",
      repo: { watched, project: projectNow, trackerUser: userNow },
    });
  }
  return repos;
});

/** Every unfinished run, counted; a run whose file cannot be read is an error line and counts as active. */
const runs = Effect.fn("Pass.runs")(function* (world: PassWorld, pass: Pass) {
  const listed = yield* Effect.result(world.unfinishedRuns());
  if (listed._tag === "Failure") {
    yield* pass.fail(
      null,
      passError("ledger", "cannot read the run ledger: ", listed.failure.message),
    );
    return null;
  }
  for (const info of listed.success) {
    pass.report.runs += 1;
    if (info.unreadable) {
      const id = runIdToString(info.id);
      // Its own ledger is what cannot be read, so the machine log takes the error.
      yield* pass.fail(
        info.id,
        passError(
          "ledger",
          `run ${id}: its ledger file cannot be read, so nothing was done for it and it counts as active`,
          "",
        ),
        true,
      );
      continue;
    }
  }
  return listed.success;
});

/**
 * Finishes this machine's runs that another machine's newer claim beat (`yieldToClaim`), before
 * the runs are worked. Only on a repo with no `factory.owner`, and only for an issue now
 * `factory:triage` or `factory:building` while a run of it is in another state, so a pass reads
 * no claim comments for a run whose label is where the run expects it.
 */
const yieldedRuns = Effect.fn("Pass.yieldedRuns")(function* (
  world: PassWorld,
  repos: ReadonlyArray<Loaded>,
  known: Known,
  pass: Pass,
) {
  for (const loaded of repos) {
    if (loaded.kind !== "ready" || loaded.repo.project.owner !== null) continue;
    const repo = loaded.repo;
    const name = repo.watched.repo;
    const ours = (issue: number) =>
      known.of(name, issue).filter((info) => info.confirmed && !info.unreadable);
    const issues = [...known.issues(name)].filter((issue) => ours(issue).length > 0);
    if (issues.length === 0) continue;
    const listed = yield* Effect.result(world.claimedIssues(repo));
    if (listed._tag === "Failure") {
      yield* pass.fail(
        null,
        passError("tracker", `${name}: cannot list the claimed issues: `, listed.failure.message),
      );
      continue;
    }
    for (const state of listed.success.cut) pass.sayIfCut(name, state, true);
    for (const issue of issues.toSorted((a, b) => a - b)) {
      const label = listed.success.states.get(issue);
      const runs = ours(issue);
      if (label === undefined || runs.every((info) => (info.state ?? "triage") === label)) continue;
      // The gate has the run; the next pass looks again.
      if (runs.some((info) => world.gateRunning(info.id))) continue;
      const notes = pass.notes(name, issue, label);
      const yielded = yield* Effect.result(world.yieldToClaim(repo, issue));
      if (yielded._tag === "Failure") {
        if (yielded.failure._tag === "GateRunningError") notes.parts.push(GATE_RUNNING);
        else pass.failed(notes, "claim check", "pass", yielded.failure);
      } else if (yielded.success !== null && yielded.success.finished.length > 0) {
        const finished = yielded.success.finished.map(runIdToString).join(", ");
        notes.parts.push(
          `${claimedByLine(yielded.success.machine)}, finished ${plural(yielded.success.finished.length, "run")} ${finished}`,
        );
        yield* known.refresh(world, pass, name, issue);
      }
      yield* pass.flush(notes, null);
    }
  }
});

/**
 * Works each confirmed run: a stop request is taken into its ledger, then the time limit applies.
 * `resume` continues `triage` runs; `advance` watches building runs and starts the gate on
 * `ready-for-gate`, and finishes `needs-info` and `stuck` runs; `prOpenRuns` gates `pr-open`
 * runs. Runs of unloaded repos are left alone. None of it is a new claim.
 */
const workRuns = Effect.fn("Pass.workRuns")(function* (
  world: PassWorld,
  repos: ReadonlyArray<Loaded>,
  known: Known,
  pass: Pass,
) {
  // The runs whose session `advance` found ended badly: they are decided together below.
  const ended: Array<EndedBadly> = [];
  for (const info of known.infos) {
    if (info.unreadable || !info.confirmed) continue;
    // A pull request that waits for a person is gated again after the others (`prOpenRuns`).
    if (info.state === "pr-open") continue;
    const loaded = repos.find(
      (l) => l.kind === "ready" && sameRepo(l.repo.watched.repo, info.id.repo),
    );
    if (loaded === undefined || loaded.kind !== "ready") continue;
    const repo = loaded.repo;
    const name = repo.watched.repo;
    const issue = Number(info.id.issue);
    const notes = pass.notes(name, issue, info.state);
    if (world.gateRunning(info.id)) {
      // The gate has the run: nothing else is done for it (softfac's `work_runs`). A stop
      // request waits, so the gate's own result decides the state first.
      notes.parts.push(GATE_RUNNING);
    } else if (yield* takeStopRequestThenWithin(world, repo, info, notes, pass)) {
      if (inTriage(info)) yield* resumeRun(world, repo, info, notes, pass);
      else if (info.state === "building") yield* followBuilding(world, repo, info, notes, pass);
      // A run left in `needs-info` or `stuck` has its end done by `advance` (softfac's `finishing`).
      else if (info.state === "needs-info" || info.state === "stuck") {
        yield* advanceRun(world, repo, info, notes, pass);
      }
    }
    if (notes.endedBadly !== null) ended.push({ info, repo, what: notes.endedBadly });
    yield* known.refresh(world, pass, name, issue);
    yield* pass.flush(notes, info.id);
  }
  yield* decideInterruptions(world, ended, pass);
});

/** A run `advance` found ended badly, with the repo it is in. */
interface EndedBadly {
  readonly info: RunInfo;
  readonly repo: Repo;
  readonly what: BadEnd;
}

/** How a pass says a session ended, from what `advance` called it. */
const endedAs = (what: BadEnd): string =>
  what === "thread-gone" ? "the T3 thread is gone" : `session ended as ${what}`;

/**
 * Decides whether each session `advance` found ended badly this pass was an interruption or a
 * stop (`interrupted` in `runner/building.ts`), from the newest T3 trouble in the machine log and
 * the count of such sessions. The log is read once, and not at all when none did. If it cannot be
 * read, only two or more bad endings are decided; a lone one waits for the next pass.
 */
const decideInterruptions = Effect.fn("Pass.decideInterruptions")(function* (
  world: PassWorld,
  ended: ReadonlyArray<EndedBadly>,
  pass: Pass,
) {
  if (ended.length === 0) return;
  const trouble = yield* Effect.result(
    Effect.all([world.t3Trouble(), world.t3Starts(), world.t3Stops()], { concurrency: 1 }),
  );
  let t3Error: string | null = null;
  let t3Starts: ReadonlyArray<number> = [];
  let t3Stops: ReadonlyArray<number> = [];
  if (trouble._tag === "Failure") {
    yield* pass.fail(
      null,
      passError("ledger", "cannot read the machine log for T3 trouble: ", trouble.failure.message),
    );
    // Without the log a lone session cannot be told from a stop, and a stop cannot be undone:
    // those runs stay as they are and `advance` reports them again next pass. Two or more need
    // no log.
    if (ended.length < 2) return;
  } else {
    [t3Error, t3Starts, t3Stops] = trouble.success;
  }
  const evidence: Evidence = { t3Error, endedInPass: ended.length, t3Starts, t3Stops };
  for (const { info, repo, what } of ended) {
    const notes = pass.notes(repo.watched.repo, Number(info.id.issue), info.state);
    const why = endedAs(what);
    const decided = yield* Effect.result(world.interrupted(repo, info.id, info.base, evidence));
    if (decided._tag === "Failure") {
      pass.failed(notes, "interrupted", "advance", decided.failure);
    } else {
      const outcome = decided.success;
      switch (outcome.kind) {
        case "resumed":
          notes.parts.push(
            `${why}; interrupted, sent it a resume (${outcome.resumes} of ${outcome.limit})`,
          );
          break;
        case "relaunched":
          yield* relaunched(
            pass,
            notes,
            why,
            ` (${outcome.resumes} of ${outcome.limit})`,
            outcome.start,
          );
          break;
        case "unchanged":
          notes.parts.push(`${why}, but ${outcome.why}; left alone`);
          break;
        case "stuck":
          pass.stuck(notes, runIdToString(info.id));
          break;
      }
    }
    yield* pass.flush(notes, info.id);
  }
});

/**
 * What a pass says of the next attempt that a relaunch started: `counted` is the resume count,
 * when there is one to say.
 */
const relaunched = Effect.fn("Pass.relaunched")(function* (
  pass: Pass,
  notes: Notes,
  why: string,
  counted: string,
  start: StartOutcome,
) {
  switch (start.kind) {
    case "started":
      notes.parts.push(
        `${why}; interrupted, relaunched as run ${runIdToString(start.run)}${counted}`,
      );
      break;
    case "stuck":
      notes.parts.push(`${why}; interrupted, relaunched${counted}`);
      pass.stuck(notes, runIdToString(start.run));
      break;
    case "abandoned":
      notes.parts.push(`${why}; interrupted, relaunching${counted}`);
      yield* abandoned(pass, notes, null, start.mayHaveSession, start.error);
      break;
    case "skipped":
    case "refused":
      notes.parts.push(
        `${why}; interrupted, relaunching${counted}, the new attempt starts on the next pass`,
      );
      break;
  }
});

/**
 * The gate started once for every `pr-open` run, after the claims, unless its head did not move
 * since its last pass (see `unchanged`): such a run costs no process or gate slot and is not
 * mentioned. A stop request left for the run is dropped first. `regate` handles the rest: merged
 * or closed pull requests, a re-gate under way, a relaunch not yet recorded, leftovers on disk.
 */
const prOpenRuns = Effect.fn("Pass.prOpenRuns")(function* (
  world: PassWorld,
  repos: ReadonlyArray<Loaded>,
  known: Known,
  pass: Pass,
) {
  const failed = new Set<string>();
  for (const info of known.infos) {
    if (info.unreadable || info.state !== "pr-open") continue;
    const loaded = repos.find(
      (l) => l.kind === "ready" && sameRepo(l.repo.watched.repo, info.id.repo),
    );
    if (loaded === undefined || loaded.kind !== "ready") continue;
    const repo = loaded.repo;
    const notes = pass.notes(repo.watched.repo, Number(info.id.issue), info.state);
    if (world.gateRunning(info.id)) {
      notes.parts.push(GATE_RUNNING);
    } else {
      // A stop asked for while the run was building waits for its gate (see `workRuns`). Once
      // the gate passed it is dropped here, before a failed re-gate relaunches a session.
      yield* takeStopRequest(world, pass, info, notes);
      // Instructor feedback comes before all of that: a run it acted on is not gated this
      // pass, whatever its head and its base did, because the gate runs when the new
      // session's first run ends.
      if (yield* actedOnFeedback(world, repo, info, notes, pass)) {
        // Said.
      } else if (!(yield* unchanged(world, repo, info.id, failed))) {
        yield* startGate(world, repo, info, notes, pass);
      }
    }
    yield* pass.flush(notes, info.id);
  }
});

/**
 * Calls the feedback step for a `pr-open` run. True when it did anything, so the run is not gated
 * this pass. A failing step is said, then the run is treated as having no feedback, so a read
 * that fails every pass cannot keep a moved head from the gate or a merge from ending the run.
 * No gate lock is taken: gates are fibers of this process and `gateRunning` was asked first.
 */
const actedOnFeedback = Effect.fn("Pass.actedOnFeedback")(function* (
  world: PassWorld,
  repo: Repo,
  info: RunInfo,
  notes: Notes,
  pass: Pass,
) {
  const run = runIdToString(info.id);
  const stepped = yield* Effect.result(world.feedback(repo, info.id, info.base));
  if (stepped._tag === "Failure") {
    pass.failed(notes, "feedback", "forward", stepped.failure);
    return false;
  }
  const outcome = stepped.success;
  switch (outcome.kind) {
    case "none":
      return false;
    case "relaunched":
      notes.parts.push(
        `instructor feedback (${outcome.items} ${plural(outcome.items, "item")}) on PR https://github.com/${info.id.repo}/pull/${outcome.pr}: a new session was launched on its branch, the PR is a draft again`,
      );
      break;
    case "stuck":
      pass.stuck(notes, run);
      break;
    case "ended":
      notes.parts.push(PULL_REQUEST_ENDED);
      break;
    case "abandoned":
      yield* abandoned(pass, notes, run, []);
      break;
  }
  return true;
});

/**
 * Whether `regate` would find the run's pull request at the head its last pass ran on. The base
 * is not read: a pass stays valid while it moves. A conflicted pull request, or a failed read, is
 * not unchanged. `failed` holds the lowercase repos whose read failed this pass, so other runs on
 * one go to the gate without a read that could time out again.
 */
const unchanged = Effect.fn("Pass.unchanged")(function* (
  world: PassWorld,
  repo: Repo,
  run: RunId,
  failed: Set<string>,
) {
  const last = yield* Effect.result(world.lastPass(run));
  if (last._tag === "Failure" || last.success === null) return false;
  const key = asciiLower(repo.watched.repo);
  if (failed.has(key)) return false;
  const pull = yield* Effect.result(world.openPull(repo, last.success.pr));
  if (pull._tag === "Failure") {
    failed.add(key);
    return false;
  }
  if (pull.success === null || pull.success.mergeable === "conflicting") return false;
  return unchangedSince(last.success.head, pull.success.head);
});

/**
 * Takes the run's stop request into its ledger, and says so. A request that cannot be taken is an
 * error line and the file stays for the next pass; the run is worked all the same.
 */
const takeStopRequest = Effect.fn("Pass.takeStopRequest")(function* (
  world: PassWorld,
  pass: Pass,
  info: RunInfo,
  notes: Notes,
) {
  const taken = yield* Effect.result(world.takeStopRequest(info.id));
  if (taken._tag === "Failure") {
    pass.failed(notes, "stop request", "pass", taken.failure);
  } else if (taken.success === "recorded") {
    notes.parts.push("stop requested by hand");
  } else if (taken.success === "not-building") {
    notes.parts.push("stop request dropped: the run is not building");
  }
});

/** Takes the stop request, then checks the time limit: true when the run is still to be worked. */
const takeStopRequestThenWithin = Effect.fn("Pass.takeStopRequestThenWithin")(function* (
  world: PassWorld,
  repo: Repo,
  info: RunInfo,
  notes: Notes,
  pass: Pass,
) {
  yield* takeStopRequest(world, pass, info, notes);
  return yield* withinLimit(world, repo, info, notes, pass);
});

/** The time limit for the run. False when the run was stopped or the call failed: it is done for this pass. */
const withinLimit = Effect.fn("Pass.withinLimit")(function* (
  world: PassWorld,
  repo: Repo,
  info: RunInfo,
  notes: Notes,
  pass: Pass,
) {
  const outcome = yield* Effect.result(world.timeLimit(repo, info.id, info.base));
  if (outcome._tag === "Failure") {
    pass.failed(notes, "time limit", "pass", outcome.failure);
    return false;
  }
  if (outcome.success.kind === "stopped") {
    pass.stuck(notes, runIdToString(info.id));
    return false;
  }
  return true;
});

/** `resume` for a run in `triage`. */
const resumeRun = Effect.fn("Pass.resumeRun")(function* (
  world: PassWorld,
  repo: Repo,
  info: RunInfo,
  notes: Notes,
  pass: Pass,
) {
  if (pass.paradevOffline) {
    notes.parts.push(PARADEV_WAIT);
    return;
  }
  const issue = Number(info.id.issue);
  const outcome = yield* Effect.result(world.resume(repo, issue));
  if (outcome._tag === "Failure") {
    if (outcome.failure._tag === "GateRunningError") notes.parts.push(GATE_RUNNING);
    else pass.failed(notes, "start", "start", outcome.failure);
    return;
  }
  switch (outcome.success.kind) {
    case "started":
      notes.parts.push("session started, the issue is building");
      break;
    case "stuck":
      pass.stuck(notes, runIdToString(outcome.success.run));
      break;
    case "abandoned":
      yield* abandoned(
        pass,
        notes,
        runIdToString(info.id),
        outcome.success.mayHaveSession,
        outcome.success.error,
      );
      break;
    case "skipped":
    case "refused": {
      const moved = outcome.success.kind === "skipped" ? outcome.success.moved : undefined;
      const claimedBy = outcome.success.kind === "skipped" ? outcome.success.claimedBy : undefined;
      if (moved === "ready") notes.parts.push(READY_AGAIN);
      // `resume` finished this machine's runs claimed before that machine's claim.
      else if (claimedBy !== undefined) notes.parts.push(claimedByLine(claimedBy));
      else {
        const run = runIdToString(info.id);
        yield* stalled(pass, notes, run, outcome.success.reason, moved === "closed");
      }
      break;
    }
  }
});

/** The line of a run whose gate was held back because something was sent to its session. */
const GATE_WAITS = "the gate waits for the next pass because a comment was sent";

/**
 * The watch, then `forward`, then `advance`, for a building run. A forward that failed may have
 * sent something, so it counts as sent; a pass where something was sent does not start the gate,
 * since the message starts a new run the gate would judge too early. A forward that cannot write
 * the ledger leaves the run alone for the pass.
 */
const followBuilding = Effect.fn("Pass.followBuilding")(function* (
  world: PassWorld,
  repo: Repo,
  info: RunInfo,
  notes: Notes,
  pass: Pass,
) {
  const watched = yield* Effect.result(world.watch(repo, info.id, info.base));
  if (watched._tag === "Failure") return pass.failed(notes, "watch", "watch", watched.failure);
  if (watched.success.kind === "stopped") return pass.stuck(notes, runIdToString(info.id));
  let sent = false;
  const forwarded = yield* Effect.result(world.forward(repo, info.id, info.base));
  if (forwarded._tag === "Failure") {
    pass.failed(notes, "forward", "forward", forwarded.failure);
    if (errorKind(forwarded.failure) === "ledger") return;
    sent = true;
  } else {
    const { comments, bodyEdit, skipped } = forwarded.success;
    if (skipped === "abandoned") {
      return yield* abandoned(pass, notes, runIdToString(info.id), []);
    }
    if (comments > 0) notes.parts.push(`forwarded ${comments} ${plural(comments, "comment")}`);
    if (bodyEdit) notes.parts.push("forwarded the edited issue body");
    sent = comments > 0 || bodyEdit;
  }
  yield* advanceRun(world, repo, info, notes, pass, sent);
});

/** The words for a gate held back because the disk is low; a later pass starts it. */
const GATE_WAITS_FOR_DISK = "the gate waits for more free disk space";

/**
 * Starts the run's gate in the background, and says so, or that it is queued. While the disk is
 * low it is not started: the gate counts an attempt only when it runs, so the wait costs none.
 */
const startGate = (
  world: PassWorld,
  repo: Repo,
  info: RunInfo,
  notes: Notes,
  pass: Pass,
): Effect.Effect<void> => {
  if (pass.lowDisk) {
    notes.parts.push(GATE_WAITS_FOR_DISK);
    return Effect.void;
  }
  return Effect.map(world.gate(repo, info.id), (start) => {
    notes.parts.push(
      start.kind === "started"
        ? GATE_STARTED
        : start.kind === "queued"
          ? gateQueued(start)
          : gateHeldByLoad(start),
    );
  });
};

/**
 * `advance` for a run, and what it did in a line. The gate is not started when `sent` says
 * something was sent into the session this pass.
 */
const advanceRun = Effect.fn("Pass.advanceRun")(function* (
  world: PassWorld,
  repo: Repo,
  info: RunInfo,
  notes: Notes,
  pass: Pass,
  sent = false,
) {
  const run = runIdToString(info.id);
  const advanced = yield* Effect.result(world.advance(repo, info.id, info.base));
  // A `NotBuildingError` is a run that finished meanwhile: softfac prints it as an error too.
  if (advanced._tag === "Failure")
    return pass.failed(notes, "advance", "advance", advanced.failure);
  // softfac's `advance_and_gate`: the gate starts for a session that finished, and for a run with
  // a gate send pending while the session still lives, which only the gate can settle.
  let wantsGate = false;
  switch (advanced.success.kind) {
    case "running":
      notes.parts.push("session still running");
      break;
    case "reminded":
      notes.parts.push("session ended without a result line, sent it a reminder");
      break;
    case "paused":
      notes.parts.push(
        "session stopped by hand, waiting for an instructor's comment on the pull request or the issue",
      );
      break;
    case "ready-for-gate":
      notes.parts.push("session finished");
      wantsGate = true;
      break;
    case "passed":
      notes.parts.push(GATE_PASSED_LINE);
      break;
    case "needs-info":
      notes.parts.push(
        "session asked questions, the issue is now needs-info and the run is finished",
      );
      notes.raises.push({
        id: `run:${run}:needs-info`,
        kind: "needs-info",
        repo: notes.repo,
        issue: notes.issue,
        run,
        message: `${notes.label} needs-info, the session asked questions on the issue`,
      });
      break;
    case "stuck":
      pass.stuck(notes, run);
      break;
    case "ended":
      notes.parts.push(PULL_REQUEST_ENDED);
      break;
    case "abandoned":
      yield* abandoned(pass, notes, run, []);
      break;
    case "ended-badly":
      // Said at the decision, after every run has been through the pass.
      notes.endedBadly = advanced.success.what;
      break;
    case "rate-limited":
      yield* coolDown(world, repo, info, notes, pass, advanced.success);
      break;
    case "relaunched":
      yield* relaunched(pass, notes, endedAs("thread-gone"), "", advanced.success.start);
      break;
  }
  const kind = advanced.success.kind;
  const mayGatePending =
    kind === "running" || kind === "reminded" || kind === "paused" || kind === "ready-for-gate";
  let pending = false;
  if (mayGatePending) {
    const read = yield* Effect.result(world.hasPendingGateSend(info.id));
    if (read._tag === "Failure") {
      return pass.trouble(notes, "ledger", "gate send check", read.failure.message);
    }
    pending = read.success;
  }
  if (wantsGate && sent && !pending) notes.parts.push(GATE_WAITS);
  else if (wantsGate || pending) yield* startGate(world, repo, info, notes, pass);
});

/** The key of a rate limit on a session whose launch recorded no model. */
const UNNAMED_MODEL = "a-model-the-ledger-does-not-name";

/**
 * A session `advance` found rate-limited: its model's backoff is recorded (`recordRateLimit`), and
 * the session is resumed once in its own thread, at once on the model's fallback while that is
 * free, else when the window is over. Until then it waits, and nothing is written.
 */
const coolDown = Effect.fn("Pass.coolDown")(function* (
  world: PassWorld,
  repo: Repo,
  info: RunInfo,
  notes: Notes,
  pass: Pass,
  limited: Extract<AdvanceOutcome, { readonly kind: "rate-limited" }>,
) {
  const { model } = limited;
  const now = world.nowMs();
  const key = model === null ? UNNAMED_MODEL : cooldownKey(model);
  recordRateLimit(world.cooldowns, key, model, limited.endedMs, now, limited.retryAfterMs);
  const why = `session hit the provider's rate limit on ${plain(key)}`;
  const cooling = coolingDown(world.cooldowns, key, now);
  const on = model === null ? null : launchModel(world.cooldowns, pass.fallbacks, model, now);
  if (cooling !== null && on === null) {
    notes.parts.push(
      `${why}; it is resumed once the cooldown ends at ${formatTs(cooling.untilMs)}`,
    );
    return;
  }
  const moveTo = cooling !== null ? on : null;
  const resumed = yield* Effect.result(world.resumeAfterCooldown(repo, info.id, info.base, moveTo));
  if (resumed._tag === "Failure") {
    return pass.failed(notes, "resume after the rate limit", "advance", resumed.failure);
  }
  if (resumed.success.kind === "unchanged") {
    notes.parts.push(`${why}, but ${resumed.success.why}; left alone`);
  } else if (moveTo === null) {
    notes.parts.push(`${why}; the cooldown is over, sent it a resume`);
  } else {
    notes.parts.push(`${why}; moved it to ${plain(moveTo.model)} and sent it a resume`);
  }
});

/** The attention item of a model that keeps hitting its rate limit, by its key after this prefix. */
const COOLDOWN_ITEM = "cooldown:";
/** The windows in a row a model may hit before a person is told, once per streak. */
const COOLDOWN_ATTENTION_WINDOWS = 3;

/**
 * One line per model whose rate limit cools down now, saying until when and whether new sessions
 * go to its fallback or wait (`claim` holds those back). A model past `COOLDOWN_ATTENTION_WINDOWS`
 * windows in a row raises one item per streak. A model quiet past its window is forgotten, and an
 * item with no streak behind it is cleared, as after a restart, which forgets every streak.
 */
const sayCooldowns = Effect.fn("Pass.sayCooldowns")(function* (world: PassWorld, pass: Pass) {
  const now = world.nowMs();
  forgetQuietCooldowns(world.cooldowns, now);
  yield* world.attention.clear(
    (item) =>
      item.id.startsWith(COOLDOWN_ITEM) &&
      world.cooldowns.get(item.id.slice(COOLDOWN_ITEM.length))?.raised !== true,
  );
  for (const [key, cooldown] of world.cooldowns) {
    if (now >= cooldown.untilMs) continue;
    const { model } = cooldown;
    const on = model === null ? null : launchModel(world.cooldowns, pass.fallbacks, model, now);
    const tail =
      model === null
        ? "its sessions wait for it to end"
        : on === null
          ? "no issue is claimed on it"
          : `new sessions run on ${plain(on.model)}`;
    pass.line(
      `provider cooling down until ${formatTs(cooldown.untilMs)}: ${plain(key)} hit its rate limit (${cooldown.windows} ${plural(cooldown.windows, "window")} in a row); ${tail}`,
    );
    if (cooldown.windows > COOLDOWN_ATTENTION_WINDOWS && !cooldown.raised) {
      cooldown.raised = true;
      pass.report.attention += 1;
      yield* world.attention.raise({
        id: `${COOLDOWN_ITEM}${key}`,
        kind: "attention",
        repo: null,
        issue: null,
        run: null,
        message: `${plain(key)} has hit its provider rate limit ${cooldown.windows} windows in a row; ${
          on === null
            ? "claims on it wait for each cooldown to end"
            : `new sessions and rate-limited sessions run on ${plain(on.model)}`
        }`,
      });
    }
  }
});

/**
 * The run's issue was closed by a person, so the run is over and its session stopped. Asks a
 * person to look. `mayHaveSession` names runs that sent a launch and never got a thread, with the
 * command id to look for. `error` is why `start` could not end a later run of the issue; the next
 * pass tries again.
 */
const abandoned = Effect.fn("Pass.abandoned")(function* (
  pass: Pass,
  notes: Notes,
  run: string | null,
  mayHaveSession: ReadonlyArray<RunId>,
  error?: StartError,
) {
  notes.parts.push("the issue is closed, the run is closed");
  if (error !== undefined) pass.failed(notes, "start", "start", error);
  if (run !== null) {
    yield* pass.attention(notes, abandonedText(notes.label), run, "abandoned");
  }
  for (const id of mayHaveSession) {
    const name = runIdToString(id);
    yield* pass.attention(
      notes,
      `${notes.label} the issue was closed, and a session may exist for ${name}: look for launch command id softfac:${name}:launch in T3 Code and archive that thread by hand`,
      name,
      "session-may-exist",
    );
  }
});

/**
 * A ready issue the limit holds back only because of its own triage run whose session may be
 * running: only the claim would finish that run (`finishOlderRuns`), so the slot never frees.
 */
const waitsOnItself = (pass: Pass, notes: Notes, run: string): Effect.Effect<void> =>
  pass.attention(
    notes,
    `${notes.label} run ${run} is not progressing and holds a slot: its issue is ready again, and the new claim waits for a slot this run holds. Put the issue back to \`factory:triage\` assigned to the factory's user so \`start\` can finish this run, or free a slot`,
    run,
    "not-progressing",
  );

const READY_AGAIN = "its issue is ready again, so it is left to the claim step";

/** A confirmed run still in `triage` (or before any state): what `finishOlderRuns` would end. */
const inTriage = (run: RunInfo): boolean =>
  !run.unreadable && run.confirmed && (run.state === null || run.state === "triage");

/**
 * A confirmed run in `triage` that `resume` would not take, for `why`: a person moved or closed
 * its issue, so nothing in the pass will move it, and it holds a slot. softfac's `stalled` words.
 * A closed issue's run is ended by `start` when it finds the issue closed (`abandoned`); this is
 * for the run it left alone, so its line says how to let the start finish it.
 */
const stalled = (
  pass: Pass,
  notes: Notes,
  run: string,
  why: string,
  closed: boolean,
): Effect.Effect<void> => {
  const back =
    "put it back to `factory:triage` assigned to the factory's user so `start` can finish it";
  const advice = closed
    ? `If it was closed by mistake, reopen it and ${back}`
    : `If you moved the issue by hand, ${back}`;
  return pass.attention(
    notes,
    `${notes.label} run ${run} is not progressing and holds a slot: ${plain(why)}. ${advice}`,
    run,
    "not-progressing",
  );
};

/**
 * The unfinished runs as this pass knows them: listed once at the start of the pass, then the
 * runs of an issue read again after each `start` for it, so the ledger is not listed whole again.
 */
class Known {
  infos: ReadonlyArray<RunInfo>;
  /** An issue's runs could not be read again, so how many runs are active is not known. */
  lost = false;

  constructor(infos: ReadonlyArray<RunInfo>) {
    this.infos = infos;
  }

  of(repo: string, issue: number): ReadonlyArray<RunInfo> {
    return this.infos.filter((i) => i.id.issue === String(issue) && sameRepo(i.id.repo, repo));
  }

  /** The issues this pass knows a run for in the repo. */
  issues(repo: string): ReadonlySet<number> {
    return new Set(
      this.infos.filter((i) => sameRepo(i.id.repo, repo)).map((i) => Number(i.id.issue)),
    );
  }

  /** Reads the issue's runs again. A ledger that cannot be read is an error line, once a pass. */
  refresh(world: PassWorld, pass: Pass, repo: string, issue: number): Effect.Effect<void> {
    return Effect.matchEffect(world.unfinishedRuns({ repo, issue }), {
      onSuccess: (fresh) =>
        Effect.sync(() => {
          const others = this.infos.filter(
            (i) => !(i.id.issue === String(issue) && sameRepo(i.id.repo, repo)),
          );
          this.infos = [...others, ...fresh];
        }),
      onFailure: (error) => {
        if (this.lost) return Effect.void;
        this.lost = true;
        return pass.fail(null, passError("ledger", "cannot read the run ledger: ", error.message));
      },
    });
  }
}

/**
 * The loaded repos this machine may claim on: those with no `factory.owner`, or one that names
 * this machine ignoring ASCII case. On any other no issue is listed, claimed, resumed or
 * released, so it is left as the owner's pass finds it. Each says so in one line and one
 * `claim_skipped` event per pass, with no attention item: the owner is a setting, not trouble.
 */
const ownedRepos = Effect.fn("Pass.ownedRepos")(function* (
  world: PassWorld,
  repos: ReadonlyArray<Loaded>,
  pass: Pass,
) {
  const owned: Array<Loaded> = [];
  for (const loaded of repos) {
    const owner = loaded.kind === "ready" ? loaded.repo.project.owner : null;
    if (
      loaded.kind !== "ready" ||
      owner === null ||
      asciiLower(owner) === asciiLower(world.machineName)
    ) {
      owned.push(loaded);
      continue;
    }
    const name = loaded.repo.watched.repo;
    pass.line(
      plain(
        `not owner: ${name}: factory.owner is ${owner}, this machine is ${world.machineName}; no issue is claimed`,
      ),
    );
    yield* pass.record({ event: "claim_skipped", data: { repo: name, reason: "not-owner" } });
  }
  return owned;
});

/**
 * Claims `start` began that left no run it can go on from: the issue is `factory:triage`,
 * assigned to the factory's login alone, with no confirmed unfinished run (`RunInfo`). `resume`
 * finishes such an issue every pass until it is done. They are claims already made, so the limit
 * on new claims does not apply. A resume may launch a session, so none runs while Paradev is
 * offline; the hold's line says so once.
 */
const untrackedClaims = Effect.fn("Pass.untrackedClaims")(function* (
  world: PassWorld,
  repos: ReadonlyArray<Loaded>,
  known: Known,
  pass: Pass,
) {
  if (pass.paradevOffline) return;
  for (const loaded of repos) {
    if (loaded.kind !== "ready") continue;
    const repo = loaded.repo;
    const name = repo.watched.repo;
    const listing = yield* Effect.result(world.triageIssues(repo));
    if (listing._tag === "Failure") {
      yield* pass.fail(
        null,
        passError("tracker", `${name}: cannot list the triage issues: `, listing.failure.message),
      );
      continue;
    }
    pass.sayIfCut(name, "triage", listing.success.cut);
    for (const issue of listing.success.items) {
      if (known.of(name, issue).some((i) => i.unreadable || i.confirmed)) continue;
      const notes = pass.notes(name, issue, "triage");
      const run = yield* noteStart(world, pass, known, notes, repo, issue, "resume", {
        claimed: (run) => `no run on record, claimed in run ${run}`,
        notTaken: "no run on record, not ours to resume",
        stuck: "no run on record",
      });
      yield* pass.flush(notes, run);
    }
  }
});

/**
 * Moves claims that were cut short to `factory:proposed`: the issue is `factory:triage` or
 * `factory:building`, nobody is assigned, no unfinished run is for it, and it has not changed for
 * the grace period the tracker applies. An issue that someone is assigned to is not looked at.
 */
const unassignedClaims = Effect.fn("Pass.unassignedClaims")(function* (
  world: PassWorld,
  repos: ReadonlyArray<Loaded>,
  known: Known,
  pass: Pass,
) {
  for (const loaded of repos) {
    if (loaded.kind !== "ready") continue;
    const repo = loaded.repo;
    const name = repo.watched.repo;
    const issues = yield* Effect.result(world.unassignedClaims(repo, known.issues(name)));
    if (issues._tag === "Failure") {
      yield* pass.fail(
        null,
        passError(
          "tracker",
          `${name}: cannot list the unassigned claims: `,
          issues.failure.message,
        ),
      );
      continue;
    }
    for (const { issue, message } of issues.success.unread) {
      yield* pass.fail(
        null,
        passError("tracker", `${name}${mention(issue)}: cannot read its label history: `, message),
      );
    }
    for (const { issue, state } of issues.success.claims) {
      if (known.of(name, issue).length > 0) continue;
      const notes = pass.notes(name, issue, state);
      const released = yield* Effect.result(world.releaseClaim(repo, issue, state));
      if (released._tag === "Success") {
        notes.parts.push("no run on record and no assignee, moved to proposed");
        yield* pass.record({
          event: "claim_repaired",
          data: { repo: name, issue: String(issue), outcome: "reconciled" },
        });
      } else {
        pass.trouble(notes, "tracker", "cannot move it to proposed: ", released.failure.message);
      }
      yield* pass.flush(notes, null);
    }
  }
});

/** The newest of the issue's unfinished runs, or null when there is none. */
const newestRun = (runs: ReadonlyArray<RunInfo>): RunId | null =>
  runs
    .map((info) => info.id)
    .reduce<RunId | null>(
      (best, id) => (best === null || id.attempt > best.attempt ? id : best),
      null,
    );

/**
 * The run a `start` that failed made: the newest unfinished one after the call when it is a newer
 * attempt than `before`, the newest before the call. A failed start may have made a run or
 * reopened the newest, so only a run that is new belongs to the failure.
 */
const madeSince = (after: RunId | null, before: RunId | null): RunId | null =>
  after !== null && (before === null || after.attempt > before.attempt) ? after : null;

/** The words a start's outcome puts on the issue's line, by outcome. */
interface StartWords {
  readonly claimed: (run: string) => string;
  readonly notTaken: string;
  readonly stuck: string;
}

/**
 * Calls `call` (`start`, or `resume` for a claim already made) for the issue and puts what it
 * did on `notes`: the run it names, when it made one, is the run the notes' errors belong to.
 * The issue's runs are read again into `known` after the call. A refused claim is a
 * `claim_skipped`; a claim counts only when the issue was `ready`.
 */
const noteStart = Effect.fn("Pass.noteStart")(function* (
  world: PassWorld,
  pass: Pass,
  known: Known,
  notes: Notes,
  repo: Repo,
  issue: number,
  call: "start" | "resume",
  words: StartWords,
) {
  const name = repo.watched.repo;
  const before = newestRun(known.of(name, issue));
  // The issue was claimed again, so what was open about its earlier runs is over.
  const clearEarlier = world.attention.clear(
    (item) => item.repo !== null && sameRepo(item.repo, name) && item.issue === issue,
  );
  const outcome = yield* Effect.result(world[call](repo, issue));
  if (outcome._tag === "Failure" && outcome.failure._tag === "GateRunningError") {
    // Nothing was called or written.
    notes.parts.push(GATE_RUNNING);
    return null;
  }
  yield* known.refresh(world, pass, name, issue);
  if (outcome._tag === "Failure") {
    pass.failed(notes, "start", "start", outcome.failure);
    return madeSince(newestRun(known.of(name, issue)), before);
  }
  switch (outcome.success.kind) {
    case "started": {
      const run = runIdToString(outcome.success.run);
      notes.parts.push(words.claimed(run));
      if (notes.state === "ready") pass.report.claimed += 1;
      yield* clearEarlier;
      return outcome.success.run;
    }
    case "abandoned": {
      // The runs the call ended are not told apart; the newest one known before it stands for them.
      const run = before === null ? null : runIdToString(before);
      yield* abandoned(pass, notes, run, outcome.success.mayHaveSession, outcome.success.error);
      return null;
    }
    case "skipped":
      notes.parts.push(
        outcome.success.claimedBy !== undefined
          ? claimedByLine(outcome.success.claimedBy)
          : outcome.success.gaveWay === true
            ? CLAIM_GAVE_WAY
            : words.notTaken,
      );
      return null;
    case "refused":
      notes.parts.push(words.notTaken);
      if (notes.state === "ready") {
        yield* pass.record({
          event: "claim_skipped",
          data: { repo: name, issue: String(issue), reason: "unapproved" },
        });
      }
      return null;
    case "stuck": {
      const run = runIdToString(outcome.success.run);
      notes.parts.push(words.stuck);
      // The new run's item is raised when the pass flushes, so it outlives this clear.
      yield* clearEarlier;
      pass.stuck(notes, run);
      return outcome.success.run;
    }
  }
});

/** A watched repo's ready issues still to try this pass, oldest first, and how many of its runs hold a slot. */
interface Queue {
  readonly repo: Repo;
  readonly issues: Array<number>;
  /** The issues among them labelled `postponed`, which are not claimed. */
  readonly postponed: ReadonlySet<number>;
  held: number;
}

/** Sets each queue's `held` from the runs that hold a slot, and returns the machine's count. */
const count = (known: Known, queues: ReadonlyArray<Queue>): number => {
  const holding = known.infos.filter(holdsSlot).map((run) => run.id.repo);
  for (const queue of queues) {
    queue.held = holding.filter((repo) => sameRepo(repo, queue.repo.watched.repo)).length;
  }
  return holding.length;
};

/**
 * Claims `factory:ready` issues with `start` while fewer than `max_concurrent_runs` runs are
 * active. Each claim goes to the repo with the fewest slot-holding runs (T3's listing order on a
 * tie), recounted after every claim so slots spread across repos. Within a repo, by issue number.
 */
const claim = Effect.fn("Pass.claim")(function* (
  world: PassWorld,
  repos: ReadonlyArray<Loaded>,
  known: Known,
  machine: MachineConfig,
  pass: Pass,
) {
  // A start before this step left runs that could not be read again.
  if (known.lost) return;
  // Said once by `lowDisk`: a run started now would write to a disk that is nearly full.
  if (pass.lowDisk) return;
  // Said once by `highLoad`: a run claimed now would gate on a machine too busy to pass it.
  if (pass.highLoad) return;
  // Said once by `paradevOffline`: a session cannot be started now.
  if (pass.paradevOffline) return;
  const paused = world.handPause();
  // Ready issues that were not tried because the limit was reached. Every repo this machine
  // may claim on is still listed, so the count is the whole machine's.
  let left = 0;
  const queues: Array<Queue> = [];
  for (const loaded of repos) {
    if (loaded.kind !== "ready") continue;
    const repo = loaded.repo;
    const name = repo.watched.repo;
    const listing = yield* Effect.result(world.readyIssues(repo));
    if (listing._tag === "Failure") {
      yield* pass.fail(
        null,
        passError("tracker", `${name}: cannot list the ready issues: `, listing.failure.message),
      );
      yield* pass.record({ event: "claim_skipped", data: { repo: name, reason: "list-failed" } });
      continue;
    }
    pass.sayIfCut(name, "ready", listing.success.cut);
    const items = listing.success.items;
    // GitHub numbers go by number, which is the order they were opened in.
    const issues = [...new Set(items.map((item) => item.number))].sort((a, b) => a - b);
    const postponed = new Set(items.filter(isPostponed).map((item) => item.number));
    queues.push({ repo, issues, postponed, held: 0 });
  }
  if (queues.length > 0) {
    yield* pass.record({ event: "ready_listed", data: { repos: queues.length } });
  }
  // A model whose rate limit cools down with no fallback free takes no new session: a repo whose T3
  // project runs on it claims nothing (said once by `sayCooldowns`). Read only while one cools.
  const now = world.nowMs();
  if ([...world.cooldowns.values()].some((cooldown) => now < cooldown.untilMs)) {
    for (const queue of queues) {
      if (queue.issues.length === 0) continue;
      const read = yield* Effect.result(world.projectModel(queue.repo));
      if (read._tag === "Failure") {
        const what = `${queue.repo.watched.repo}: cannot read the T3 project's model: `;
        yield* pass.fail(null, passError(read.failure.kind, what, read.failure.message));
        queue.issues.length = 0;
        yield* pass.record({
          event: "claim_skipped",
          data: { repo: queue.repo.watched.repo, reason: "model-unread" },
        });
      } else if (
        read.success !== null &&
        launchModel(world.cooldowns, pass.fallbacks, read.success, now) === null
      ) {
        queue.issues.length = 0;
        yield* pass.record({
          event: "claim_skipped",
          data: { repo: queue.repo.watched.repo, reason: "cooling-down" },
        });
      }
    }
  }
  let active = count(known, queues);
  let late = false;
  // A blocked issue takes no slot, so its repo stays the one with the fewest and its next
  // issue is tried.
  for (;;) {
    const queue = queues
      .filter((q) => q.issues.length > 0)
      .reduce<Queue | null>((best, q) => (best === null || q.held < best.held ? q : best), null);
    if (queue === null) break;
    if (world.nowMs() - pass.startedMs >= CLAIM_CUTOFF_MS) {
      late = true;
      break;
    }
    const repo = queue.repo;
    const name = repo.watched.repo;
    const issue = queue.issues.shift()!;
    const notes = pass.notes(name, issue, "ready");
    // An issue with a run whose gate is running waits: `start` would finish that run under
    // its gate. It takes no slot, no blocker read, and is not counted as left over.
    const gating = known.of(name, issue).some((info) => world.gateRunning(info.id));
    if (gating) {
      notes.parts.push(GATE_RUNNING);
      yield* pass.flush(notes, null);
      continue;
    }
    // Checked before the blockers: a person paused claims, so no claim is started. The pause is
    // the machine's, said once after the loop.
    if (paused !== null) continue;
    // A postponed issue is parked by a person: it takes no slot, its blockers are not read, and
    // nothing is written to it.
    if (queue.postponed.has(issue)) {
      notes.parts.push("postponed, not claimed");
      yield* pass.flush(notes, null);
      yield* pass.record({
        event: "claim_skipped",
        data: { repo: name, issue: String(issue), reason: "postponed" },
      });
      continue;
    }
    // Before the blockers: with no slot free nothing is claimed, so they are not read. The
    // issue's own triage runs end with this claim (`finishOlderRuns`). One with no session leaves
    // its slot to the claim; one whose session may be running keeps it, so no second session
    // starts past the limit.
    const own = known.of(name, issue).filter(inTriage);
    const freed = own.filter((run) => !run.session).length;
    if (active - freed >= machine.maxConcurrentRuns) {
      left += 1;
      yield* pass.record({
        event: "claim_skipped",
        data: { repo: name, issue: String(issue), reason: "limit" },
      });
      // Its own running sessions fill the limit alone: when every other run frees its slot,
      // the claim still waits, and only the claim would end them.
      const running = own.filter((run) => run.session);
      if (running.length > 0 && running.length >= machine.maxConcurrentRuns) {
        yield* waitsOnItself(pass, notes, runIdToString(running[0]!.id));
      }
      continue;
    }
    // A blocked issue takes no slot, and a read that fails holds it back too, written as
    // `read-failed` so the Queue keeps its wait. `## Depends on` is read only with no linked blocker open.
    const unread = () =>
      pass.record({
        event: "claim_skipped",
        data: { repo: name, issue: String(issue), reason: "read-failed" },
      });
    const linked = yield* Effect.result(world.openBlockers(repo, issue));
    if (linked._tag === "Failure") {
      pass.trouble(
        notes,
        "tracker",
        "cannot read the issue's dependencies: ",
        linked.failure.message,
      );
      yield* pass.flush(notes, null);
      yield* unread();
      continue;
    }
    let blocked: string | null = null;
    if (linked.success.length > 0) {
      blocked = blockedBy(name, linked.success, "");
    } else {
      const text = yield* Effect.result(world.dependsOnBlockers(repo, issue));
      if (text._tag === "Failure") {
        pass.trouble(
          notes,
          "tracker",
          "cannot read the issue's Depends on: ",
          text.failure.message,
        );
        yield* pass.flush(notes, null);
        yield* unread();
        continue;
      }
      if (text.success.length > 0) blocked = blockedBy(name, text.success, FROM_TEXT);
    }
    if (blocked !== null) {
      notes.parts.push(blocked);
      yield* pass.flush(notes, null);
      yield* pass.record({
        event: "claim_skipped",
        data: { repo: name, issue: String(issue), reason: "blocked" },
      });
      continue;
    }
    const run = yield* noteStart(world, pass, known, notes, repo, issue, "start", {
      claimed: (run) => `claimed, session started in run ${run}`,
      notTaken: "not claimed",
      stuck: "claimed, but the launch failed",
    });
    yield* pass.flush(notes, run);
    if (known.lost) return;
    // Count again: a claim that ended in `stuck`, or in an error that left the issue in
    // `triage`, changes how many runs are active, and which repo has the fewest.
    active = count(known, queues);
  }
  if (paused !== null) {
    pass.line(
      `claims paused: by hand since ${formatTs(paused.sinceMs)}, for ${duration(Math.max(0, world.nowMs() - paused.sinceMs))}; no ready issue claimed`,
    );
    yield* pass.record({ event: "claim_skipped", data: { reason: "paused" } });
  }
  if (late) {
    pass.line(
      `claims stopped: the pass has run for ${duration(world.nowMs() - pass.startedMs)}; the ready issues left wait for the next pass`,
    );
    yield* pass.record({ event: "claim_skipped", data: { reason: "late" } });
  }
  if (left > 0) {
    pass.line(
      `limit reached: ${left} ready ${plural(left, "issue")} ${left === 1 ? "was" : "were"} not claimed, max_concurrent_runs is ${machine.maxConcurrentRuns}`,
    );
  }
});
