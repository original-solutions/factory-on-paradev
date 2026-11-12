// @effect-diagnostics nodeBuiltinImport:off - the tests read the bytes of real run files.
/**
 * Interruptions and relaunches, ported from softfac's `runner/tests/interruption.rs` and `stop.rs`:
 * `advance` says a session that ended `failed` or `cancelled`, or whose thread is gone, ended
 * badly; `interrupted` decides whether that was an interruption (a resume or a relaunch) or a stop.
 * Left out: everything in `interruption.rs` that reads pull request feedback into a paused thread.
 */
import * as NodeFS from "node:fs";

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { describe } from "vitest";

import { timeLimitOnlyProjectConfig, type ProjectConfig } from "../config.ts";
import type { TextCheck } from "../domain/approval.ts";
import type { State } from "../domain/lifecycle.ts";
import { makeCause, type RunEvent } from "../ledger/events.ts";
import { Ledger } from "../ledger/ledger.ts";
import { listUnfinishedRuns } from "../ledger/listRuns.ts";
import { field, readRun } from "../ledger/read.ts";
import { runPath, type RunId } from "../ledger/runId.ts";
import { T0, useTempDirs } from "../ledger/testSupport.ts";
import {
  SessionsError,
  ThreadNotFoundError,
  type LaunchRequest,
  type Launched,
  type RunStatus,
  type Thread,
  type ThreadStatus,
} from "../sessions.ts";
import {
  GitHubFailed,
  type Activity,
  type Comment,
  type GitHubError,
  type IssueDetail,
  type OpenPullRequest,
  type PullRequest,
} from "../tracker/github.ts";
import {
  advance,
  forward,
  interrupted,
  resumeAfterCooldown,
  timeLimit,
  watch,
  type AdvanceOutcome,
  type Evidence,
  type InterruptContext,
} from "./building.ts";
import { launchMessage, type ResumeFrom } from "./messages.ts";
import { readProgress } from "./progress.ts";
import { runProject } from "./run.ts";
import { resume, start } from "./start.ts";

const tempDir = useTempDirs();

const REPO = "rawphp/softfac";
const run10: RunId = { repo: REPO, issue: "10", attempt: 1 };
const run10b: RunId = { repo: REPO, issue: "10", attempt: 2 };
const LABELED = "2026-10-04T10:00:00Z";
const URL12 = "https://github.com/rawphp/softfac/pull/12";
const DONE_MESSAGE = `Built it.\nFACTORY-DONE: ${URL12}`;
const THREAD_GONE = "the T3 thread no longer exists";
const STOPPED_BY_HAND = "stopped by hand";
const MINUTE = 60_000;

const T3_ERROR = "T3 Code is not reachable: the request timed out";

/** The one message a resume sends, written out independently of the code under test. */
const RESUME_MESSAGE =
  "The session was interrupted: your last turn was cut off, probably because Paradev was unreachable or restarting, so the factory is not treating it as your decision. Continue from where you were. End your reply with a result line as before: FACTORY-DONE: <PR URL>, FACTORY-STOP: needs-info (after your numbered questions) or FACTORY-STOP: stuck.";

/** The paragraph a relaunch adds to the first message of the next attempt. */
/** The interruption paragraph of a relaunch from `branch`, in the factory's fixed words. */
const interruptedWords = (branch: string) =>
  `A previous attempt of this issue (rawphp__softfac__10__1) was interrupted when T3 Code lost its session. The worktree already holds its commits: continue from them, do not start over. Push your commits to that branch with \`git push origin HEAD:${branch}\`. If a pull request for this issue is already open on it, that pull request is updated. Do not open another pull request.`;
const INTERRUPTED_WORDS = interruptedWords("t3code/abc");

const evidence = (
  t3Error: string | null,
  endedInPass: number,
  t3Starts: ReadonlyArray<number> = [],
  t3Stops: ReadonlyArray<number> = [],
): Evidence => ({
  t3Error,
  endedInPass,
  t3Starts,
  t3Stops,
});
/** One session ended badly, and the machine log has a T3 timeout in the last ten minutes. */
const afterOutage = () => evidence(T3_ERROR, 1);
/** One session ended badly and T3 has been healthy. */
const lone = () => evidence(null, 1);

type Line = { readonly event: string; readonly data: unknown };

const step = (text: string): RunEvent => ({ event: "step_changed", data: { step: text } });
const moved = (from: State, to: State): RunEvent => ({
  event: "state_changed",
  data: { from, to },
});

/** What the ledger holds when the issue is `building`; the launch line names `branch` and `worktree`. */
const startedWith = (
  branch: string | null = "t3code/abc",
  worktree: string | null = "/t3/wt",
): ReadonlyArray<RunEvent> => [
  step(`approved ${LABELED}`),
  { event: "claimed", data: { machine: "mac-mini", github_user: "rawphp" } },
  moved("ready", "triage"),
  step("launch-sending"),
  {
    event: "session_launched",
    data: {
      thread_id: "thread-1",
      worktree,
      branch,
      model_instance: "claudeAgent",
      model: "claude-opus-5-5",
      model_options: null,
      resumed_from: null,
    },
  },
  step("approval-rechecked"),
  moved("triage", "building"),
];
const STARTED = startedWith();

/** `STARTED` whose launch line names T3's `branch` and, under `resumed_from`, the run and branch the worktree was made from. */
const startedResumedFrom = (
  branch: string,
  resumedFrom: { readonly run: string; readonly branch: string },
): ReadonlyArray<RunEvent> =>
  STARTED.map((line): RunEvent =>
    line.event === "session_launched"
      ? {
          event: "session_launched",
          data: {
            thread_id: "thread-1",
            worktree: "/t3/wt",
            branch,
            model_instance: "claudeAgent",
            model: "claude-opus-5-5",
            model_options: null,
            resumed_from: resumedFrom,
          },
        }
      : line,
  );

const FINISHED: Line = {
  event: "finished",
  data: {
    outcome: "stuck",
    total_ms: 0,
    gate_attempts: 0,
    review_cycles: null,
    pr_url: null,
    pr_end: null,
  },
};
const worktreeRemoved = (path: string): Line => ({ event: "worktree_removed", data: { path } });
const PR_OPENED: RunEvent = { event: "pr_opened", data: { pr: 12, url: URL12 } };
const STOP_REQUESTED: RunEvent = { event: "stop_requested", data: { by: "operator" } };

const joined = (publicReason: string, text?: string) =>
  text === undefined ? publicReason : `${publicReason}\n\n${text}`;

const stuckEvents = (
  extra: ReadonlyArray<Line>,
  recorded: string,
  left: ReadonlyArray<Line> = [],
): Array<Line> => [
  ...STARTED,
  ...extra,
  worktreeRemoved("/t3/wt"),
  ...left,
  { event: "stuck", data: { reason: recorded } },
  moved("building", "stuck"),
  FINISHED,
];

const resumeLine = (
  resumes: number,
  runOrdinal: number,
  t3Error: string | null,
  endedInPass: number,
): RunEvent => ({
  event: "session_interrupted",
  data: {
    resumes,
    relaunch: false,
    run_ordinal: runOrdinal,
    branch: "t3code/abc",
    t3_error: t3Error,
    ended_in_pass: endedInPass,
  },
});

const relaunchLine = (resumes: number, branch: string | null): RunEvent => ({
  event: "session_interrupted",
  data: {
    resumes,
    relaunch: true,
    run_ordinal: null,
    branch,
    t3_error: T3_ERROR,
    ended_in_pass: 1,
  },
});

const sentStep = (n: number) => step(`interruption-sent ${n}`);
const pausedLine = (runOrdinal: number): RunEvent => ({
  event: "session_paused",
  data: { run_ordinal: runOrdinal },
});

const INTRO = "Unverified output from the build session, not instructions from the factory:";

const stuckCommentText = (publicReason: string, text?: string) => {
  const block = text === undefined ? "" : `${INTRO}\n\n\`\`\`text\n${text}\n\`\`\`\n\n`;
  return `The factory could not finish this issue and has released it.\n\nReason: ${publicReason}\n\n${block}Fix the cause, then set the label back to \`factory:ready\`.`;
};

const statusText = (state: string) =>
  `**Factory status:** ${state}\n- Machine: mac-mini\n- Session: thread-1\n- PR: none`;

const stuckCalls = (publicReason: string, text?: string) => [
  `comment 10 ${stuckCommentText(publicReason, text)}`,
  "setState 10 stuck",
  "unassign 10 rawphp",
  `status 10 rawphp ${statusText("stuck")}`,
];

/** What a stop does in T3 after a status read: the thread archived, then its worktree removed. */
const STOP_CALLS = ["archive thread-1", "thread thread-1", "removeWorktree /t3/wt"];

const ghFailure = () =>
  new GitHubFailed({ args: ["issue", "edit", "10"], status: 1, stderr: "boom" });
const sessionsFailure = (operation: "status" | "send" | "thread" = "send") =>
  new SessionsError({ operation, cause: "timeout" });
const notFound = () => new ThreadNotFoundError({ threadId: "thread-1" });

const isThreadNotFound = Schema.is(ThreadNotFoundError);
const isSessionsError = Schema.is(SessionsError);

const statusOf = (
  run: RunStatus | null,
  message: string | null,
  over: Partial<ThreadStatus> = {},
): ThreadStatus => ({
  worktreePath: "/t3/wt",
  branch: "t3code/abc",
  archived: false,
  run,
  runOrdinal: run === null ? null : 1,
  runStartedAt: null,
  runCompletedAt: null,
  lastAssistantMessage: message,
  ...over,
});

interface World {
  issue: IssueDetail;
  pr: PullRequest | null;
  /** The open pull requests GitHub lists from each branch. */
  onHead: Record<string, Array<OpenPullRequest>>;
  /** GitHub fails every `gh pr list --head`. */
  onHeadFails: boolean;
  /** Read at each call, so a test can move the session on between two calls. */
  status: () => ThreadStatus | ThreadNotFoundError | SessionsError;
  thread: Thread | ThreadNotFoundError | SessionsError;
  textCheck: TextCheck;
  editedSince: boolean;
  branchTip: "found" | "missing";
  /** Branches origin lacks whatever `branchTip` says. */
  missingBranches: Array<string>;
  /** The comments the instructors made, for `forward`. */
  comments: Array<Comment>;
  /** The next send fails with this, once. */
  sendFailure: SessionsError | null;
  /** Every send fails: T3 no longer has the thread. */
  sendNotFound: boolean;
  /** The next `setState` fails with this, once. */
  setStateFails: GitHubError | null;
  /** What each launch answers. */
  launch: () => Launched | SessionsError;
  /** The text of each message T3 took, by command id. */
  delivered: Map<string, string>;
}

const issueDetail = (state: State | null, assignees: ReadonlyArray<string>): IssueDetail => ({
  number: 10,
  title: "Build step",
  body: "Build the runner.",
  labels: state === null ? [] : [`factory:${state}`],
  assignees,
  author: "tomkaczocha",
  state,
  closed: false,
});

const projectConfig = (): ProjectConfig => {
  const config = timeLimitOnlyProjectConfig();
  return {
    ...config,
    instructors: ["rawphp"],
    base: "main",
    gate: ["cargo test"],
    limits: { ...config.limits, minutes: 90 },
  };
};

const defaultPr = (): PullRequest => ({
  number: 12,
  isDraft: true,
  open: true,
  merged: false,
  headRef: "t3code/abc",
  crossRepository: false,
  baseRef: "main",
  headSha: "abc123",
  mergeable: "mergeable",
  createdAt: "2026-10-04T10:00:00Z",
});

const seed = (
  dataDir: string,
  id: RunId,
  events: ReadonlyArray<RunEvent>,
  approvedBy: string | null = null,
) => {
  const ledger = Ledger.create(dataDir, id, { clock: () => T0 });
  try {
    for (const event of events) {
      const isApproval =
        event.event === "step_changed" && String(field(event.data, "step")).startsWith("approved ");
      ledger.append(
        event,
        isApproval && approvedBy !== null
          ? makeCause("start", "approved", { actor: approvedBy })
          : makeCause("start", "seed"),
      );
    }
  } finally {
    ledger.close();
  }
};

interface Rig {
  readonly dataDir: string;
  readonly run: RunId;
  readonly world: World;
  /** The tracker's writes and its pull request reads, in order. */
  readonly gh: Array<string>;
  /** Its other reads: the issue, the text, the branch tip. */
  readonly reads: Array<string>;
  readonly t3: Array<string>;
  readonly launches: Array<LaunchRequest>;
  readonly clock: { now: number };
  ctx: InterruptContext;
}

const rigFor = (
  events: ReadonlyArray<RunEvent> = STARTED,
  approvedBy: string | null = null,
): Rig => {
  const dataDir = tempDir();
  seed(dataDir, run10, events, approvedBy);
  const world: World = {
    issue: issueDetail("building", ["rawphp"]),
    pr: null,
    onHead: {},
    onHeadFails: false,
    status: () => statusOf("completed", DONE_MESSAGE),
    thread: { worktreePath: "/t3/wt", branch: "t3code/abc", archived: false },
    textCheck: "unchanged",
    editedSince: false,
    branchTip: "found",
    missingBranches: [],
    comments: [],
    sendFailure: null,
    sendNotFound: false,
    setStateFails: null,
    launch: () => ({ threadId: "thread-2", worktreePath: "/t3/wt2", branch: "t3code/def" }),
    delivered: new Map(),
  };
  const gh: Array<string> = [];
  const reads: Array<string> = [];
  const t3: Array<string> = [];
  const launches: Array<LaunchRequest> = [];
  const clock = { now: T0 };
  const notHere = () => Effect.die("not an interruption's");
  const tracker: InterruptContext["tracker"] = {
    issue: (n) => {
      reads.push(`issue ${n}`);
      return Effect.succeed(world.issue);
    },
    closedBy: () => Effect.succeed(null),
    openPullRequestsOnHead: (branch) => {
      reads.push(`openPullRequestsOnHead ${branch}`);
      return world.onHeadFails
        ? Effect.fail(ghFailure())
        : Effect.succeed(world.onHead[branch] ?? []);
    },
    openPullRequestsClosing: () => Effect.succeed([]),
    pullRequest: (n) => {
      gh.push(`pullRequest ${n}`);
      return Effect.succeed(world.pr);
    },
    activitySince: (): Effect.Effect<Activity> =>
      Effect.succeed({ comments: world.comments, bodyEdit: null, dropped: [] }),
    approval: (n, instructors) => {
      reads.push(`approval ${n} ${instructors.join(",")}`);
      return Effect.succeed({ kind: "approved", labeledAt: LABELED, labeledBy: "rawphp" });
    },
    claim: (n, user, from, to) => {
      gh.push(`claim ${n} ${user} ${from}->${to}`);
      world.issue = { ...world.issue, state: to, assignees: [user], labels: [`factory:${to}`] };
      return Effect.succeed({ kind: "claimed" });
    },
    claimWinner: () => Effect.succeed(null),
    newestFactoryComment: () => Effect.succeed(null),
    assign: (n, user) => {
      gh.push(`assign ${n} ${user}`);
      return Effect.void;
    },
    setState: (n, state) => {
      gh.push(`setState ${n} ${state}`);
      const failure = world.setStateFails;
      world.setStateFails = null;
      if (failure !== null) return Effect.fail(failure);
      world.issue = { ...world.issue, state, labels: [`factory:${state}`] };
      return Effect.void;
    },
    unassign: (n, user) => {
      gh.push(`unassign ${n} ${user}`);
      world.issue = { ...world.issue, assignees: [] };
      return Effect.void;
    },
    postComment: (n, body) => {
      gh.push(`comment ${n} ${body}`);
      return Effect.void;
    },
    upsertStatusComment: (n, user, body) => {
      gh.push(`status ${n} ${user} ${body}`);
      return Effect.void;
    },
    textCheck: (n, since, instructors) => {
      reads.push(`textCheck ${n} ${since} ${instructors.join(",")}`);
      return Effect.succeed(world.textCheck);
    },
    branchTip: (branch) => {
      reads.push(`branchTip ${branch}`);
      return world.branchTip === "found" && !world.missingBranches.includes(branch)
        ? Effect.succeed("a".repeat(40))
        : Effect.fail(
            new GitHubFailed({
              args: ["api", "ref"],
              status: 1,
              stderr: "gh: Not Found (HTTP 404)",
            }),
          );
    },
    textEditedSince: (n, since) => {
      reads.push(`textEditedSince ${n} ${since}`);
      return Effect.succeed(world.editedSince);
    },
    markPrReady: notHere,
    markPrDraft: notHere,
    commentOnPr: notHere,
  };
  const sessions: InterruptContext["sessions"] = {
    findProject: () =>
      Effect.succeed({
        id: "proj-1",
        model: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
      }),
    launch: (request) => {
      t3.push(`launch ${request.commandId}`);
      launches.push(request);
      const answer = world.launch();
      return isSessionsError(answer) ? Effect.fail(answer) : Effect.succeed(answer);
    },
    status: (threadId) => {
      t3.push(`status ${threadId}`);
      const answer = world.status();
      return isThreadNotFound(answer) || isSessionsError(answer)
        ? Effect.fail(answer)
        : Effect.succeed(answer);
    },
    thread: (threadId) => {
      t3.push(`thread ${threadId}`);
      const answer = world.thread;
      return isThreadNotFound(answer) || isSessionsError(answer)
        ? Effect.fail(answer)
        : Effect.succeed(answer);
    },
    send: (threadId, commandId, text, model) => {
      const on = model === undefined ? "" : ` [on ${model.instanceId} ${model.model}]`;
      t3.push(`send ${threadId} ${commandId} ${text}${on}`);
      if (world.sendNotFound) return Effect.fail(notFound());
      const failure = world.sendFailure;
      world.sendFailure = null;
      if (failure !== null) return Effect.fail(failure);
      world.delivered.set(commandId, text);
      return Effect.void;
    },
    archive: (threadId) => {
      t3.push(`archive ${threadId}`);
      return Effect.void;
    },
    worktreeCheckout: () => Effect.die("no worktree head"),
    lastActivity: () => Effect.succeed(null),
    removeWorktree: (path) => {
      t3.push(`removeWorktree ${path}`);
      return Effect.void;
    },
  };
  const ctx: InterruptContext = {
    repo: REPO,
    trackerUser: "rawphp",
    machine: "mac-mini",
    project: projectConfig(),
    repoProject: projectConfig(),
    dataDir,
    tracker,
    sessions,
    repoPath: "/work/softfac",
    ghConfigDir: "/gh/rawphp",
    clock: () => clock.now,
  };
  return { dataDir, run: run10, world, gh, reads, t3, launches, clock, ctx };
};

const advanceIn = (rig: Rig, run: RunId = rig.run) => advance(rig.ctx, run);
/** The entries a ledger seeded with `events` reads back as. */
const seededEntries = (events: ReadonlyArray<RunEvent>) => {
  const dataDir = tempDir();
  seed(dataDir, run10, events);
  return readRun(dataDir, run10).entries;
};
const decide = (rig: Rig, ev: Evidence, run: RunId = rig.run) => interrupted(rig.ctx, run, ev);
const forwardIn = (rig: Rig) => forward(rig.ctx, rig.run);
/** What the pass does for a run after a resume or a relaunch that left the issue to `start`. */
const resumeIn = (rig: Rig) => resume(rig.ctx, 10);

const linesOf = (rig: Rig, id: RunId = rig.run): Array<Line> =>
  readRun(rig.dataDir, id).entries.map(({ event, data }) => ({ event, data }));

const bytesOf = (rig: Rig, id: RunId = rig.run) =>
  NodeFS.readFileSync(runPath(rig.dataDir, id), "utf8");

const clearCalls = (rig: Rig) => {
  rig.gh.length = 0;
  rig.reads.length = 0;
  rig.t3.length = 0;
};

/** The session's latest run is `status` with the ordinal `ordinal`. */
const endedAs = (rig: Rig, status: RunStatus, ordinal: number, message: string | null) => {
  rig.world.status = () => statusOf(status, message, { runOrdinal: ordinal });
};
const setActive = (rig: Rig, ordinal: number) => {
  rig.world.status = () => statusOf("running", null, { runOrdinal: ordinal });
};
/** T3 no longer has the thread: not for its status, and not for its own fields. */
const threadGone = (rig: Rig) => {
  rig.world.status = notFound;
  rig.world.thread = notFound();
};
const withResumeLimit = (rig: Rig, interruptionResumes: number) => {
  rig.ctx = {
    ...rig.ctx,
    project: {
      ...rig.ctx.project,
      limits: { ...rig.ctx.project.limits, interruptionResumes },
    },
  };
};

const sends = (rig: Rig) => rig.t3.filter((call) => call.startsWith("send "));
const resumeCall = (n: number, run = "rawphp__softfac__10__1", thread = "thread-1") =>
  `send ${thread} softfac:${run}:interrupted:${n} ${RESUME_MESSAGE}`;

const appendTo = (rig: Rig, id: RunId, events: ReadonlyArray<RunEvent>, step = "advance") => {
  const ledger = Ledger.open(rig.dataDir, id, { clock: () => T0 });
  try {
    for (const event of events) ledger.append(event, makeCause("pass", step));
  } finally {
    ledger.close();
  }
};

const theIssueIsStillBuilding = (rig: Rig) => {
  assert.deepStrictEqual(rig.gh, []);
  assert.strictEqual(rig.world.issue.state, "building");
};

const endedBadly = (what: "failed" | "cancelled" | "thread-gone"): AdvanceOutcome => ({
  kind: "ended-badly",
  what,
});

/** A run that ended `failed` with a result line only a person can read, after `advance` said so. */
const failedAndSaid = (rig: Rig, ordinal = 1, message: string | null = "it crashed") =>
  Effect.gen(function* () {
    endedAs(rig, "failed", ordinal, message);
    assert.deepStrictEqual(yield* advanceIn(rig), endedBadly("failed"));
  });

describe("advance: a session that ended badly", () => {
  it.effect("writes nothing for a failed or cancelled run and says it ended badly", () =>
    Effect.gen(function* () {
      for (const status of ["failed", "cancelled"] as const) {
        const rig = rigFor();
        endedAs(rig, status, 1, "it crashed");
        const before = bytesOf(rig);
        assert.deepStrictEqual(yield* advanceIn(rig), endedBadly(status), status);
        assert.deepStrictEqual(rig.gh, [], status);
        assert.strictEqual(bytesOf(rig), before, status);
        assert.deepStrictEqual(rig.t3, ["status thread-1"], status);
      }
    }),
  );

  it.effect("says a thread that no longer exists ended badly and writes nothing", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      threadGone(rig);
      const before = bytesOf(rig);
      assert.deepStrictEqual(yield* advanceIn(rig), endedBadly("thread-gone"));
      assert.deepStrictEqual(rig.gh, []);
      assert.strictEqual(bytesOf(rig), before);
    }),
  );

  it.effect("still sends a rolled back run to stuck by itself", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      endedAs(rig, "rolled_back", 1, "it crashed");
      const outcome = yield* advanceIn(rig);
      assert.deepStrictEqual(outcome, {
        kind: "stuck",
        reason: joined("the session run ended as rolled_back", "it crashed"),
      });
      assert.strictEqual(rig.world.issue.state, "stuck");
      assert.deepStrictEqual(
        rig.gh,
        stuckCalls("the session run ended as rolled_back", "it crashed"),
      );
    }),
  );

  it.effect(
    "sends an ended badly run with no ordinal to stuck at once, since it cannot be waited for",
    () =>
      Effect.gen(function* () {
        for (const status of ["failed", "cancelled"] as const) {
          const rig = rigFor();
          rig.world.status = () => statusOf(status, "it crashed", { runOrdinal: null });
          const outcome = yield* advanceIn(rig);
          assert.strictEqual(outcome.kind, "stuck", status);
          assert.deepStrictEqual(
            rig.gh,
            stuckCalls(`the session run ended as ${status}`, "it crashed"),
            status,
          );
        }
      }),
  );

  it.effect(
    "reads a failed, interrupted or cancelled run that ended with a done line as done",
    () =>
      Effect.gen(function* () {
        for (const status of ["failed", "interrupted", "cancelled"] as const) {
          const rig = rigFor();
          rig.world.pr = defaultPr();
          endedAs(rig, status, 1, DONE_MESSAGE);
          const outcome = yield* advanceIn(rig);
          assert.strictEqual(outcome.kind, "ready-for-gate", status);
        }
      }),
  );
});

describe("advance: a pause by hand", () => {
  it.effect("pauses an interrupted run by hand and does not call it ended badly", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      endedAs(rig, "interrupted", 1, "stopped mid-thought");
      assert.deepStrictEqual(yield* advanceIn(rig), { kind: "paused" });
      assert.deepStrictEqual(linesOf(rig), [...STARTED, pausedLine(1)]);
      // Nothing on GitHub and nothing sent into the thread.
      theIssueIsStillBuilding(rig);
      assert.deepStrictEqual(rig.t3, ["status thread-1"]);
      // The next pass finds the same stopped run and writes nothing more.
      const before = bytesOf(rig);
      assert.deepStrictEqual(yield* advanceIn(rig), { kind: "paused" });
      assert.strictEqual(bytesOf(rig), before);
    }),
  );

  it.effect("does not decide a paused run as an interruption even with T3 trouble", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      endedAs(rig, "interrupted", 1, "stopped");
      assert.deepStrictEqual(yield* advanceIn(rig), { kind: "paused" });
      clearCalls(rig);
      const outcome = yield* decide(rig, afterOutage());
      assert.deepStrictEqual(outcome, {
        kind: "unchanged",
        why: "its thread has moved on since",
      });
      assert.deepStrictEqual(sends(rig), []);
      theIssueIsStillBuilding(rig);
    }),
  );

  it.effect("reads a stopped run that a person resumes in T3 as any other", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      rig.world.pr = defaultPr();
      endedAs(rig, "interrupted", 1, "stopped");
      assert.deepStrictEqual(yield* advanceIn(rig), { kind: "paused" });
      setActive(rig, 2);
      assert.deepStrictEqual(yield* advanceIn(rig), { kind: "running" });
      endedAs(rig, "completed", 2, DONE_MESSAGE);
      assert.deepStrictEqual(yield* advanceIn(rig), {
        kind: "ready-for-gate",
        pr: 12,
        prUrl: URL12,
      });
    }),
  );

  it.effect("pauses a second stop after a resume again with its own line", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      endedAs(rig, "interrupted", 1, "stopped");
      assert.deepStrictEqual(yield* advanceIn(rig), { kind: "paused" });
      endedAs(rig, "interrupted", 3, "stopped again");
      assert.deepStrictEqual(yield* advanceIn(rig), { kind: "paused" });
      assert.deepStrictEqual(linesOf(rig), [...STARTED, pausedLine(1), pausedLine(3)]);
    }),
  );

  it.effect("lifts the pause with an instructor's issue comment through forward", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      endedAs(rig, "interrupted", 1, "stopped");
      assert.deepStrictEqual(yield* advanceIn(rig), { kind: "paused" });
      rig.world.comments = [
        {
          id: "101",
          author: "rawphp",
          createdAt: "2026-10-04T10:13:16Z",
          body: "Try the other way.",
        },
      ];
      assert.strictEqual((yield* forwardIn(rig)).comments, 1);
      // The comment starts a new run: until it ends, the session is working, not paused.
      assert.deepStrictEqual(yield* advanceIn(rig), { kind: "running" });
      assert.deepStrictEqual(linesOf(rig), [
        ...STARTED,
        pausedLine(1),
        step("forward-wait 1"),
        { event: "comment_forwarded", data: { comment_id: "101" } },
      ]);
    }),
  );
});

describe("interrupted: a resume", () => {
  it.effect(
    "resumes a session that failed right after a T3 timeout in its thread and keeps it building",
    () =>
      Effect.gen(function* () {
        const rig = rigFor();
        yield* failedAndSaid(rig);
        clearCalls(rig);
        const outcome = yield* decide(rig, afterOutage());
        assert.deepStrictEqual(outcome, {
          kind: "resumed",
          resumes: 1,
          limit: 2,
          status: "failed",
        });
        // The decision, then the step that says the message was sent.
        assert.deepStrictEqual(linesOf(rig), [
          ...STARTED,
          resumeLine(1, 1, T3_ERROR, 1),
          sentStep(1),
        ]);
        assert.deepStrictEqual(rig.t3, ["status thread-1", resumeCall(1)]);
        // No stuck comment, no label, nothing released.
        theIssueIsStillBuilding(rig);
        const reasons = readRun(rig.dataDir, rig.run)
          .entries.slice(STARTED.length)
          .map((entry) => `${entry.cause?.step} ${entry.cause?.reason}`);
        assert.deepStrictEqual(reasons, [
          "advance session-interrupted",
          "advance interruption-sent",
        ]);
      }),
  );

  it.effect("resumes a cancelled session after a T3 timeout too", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      endedAs(rig, "cancelled", 1, null);
      assert.deepStrictEqual(yield* advanceIn(rig), endedBadly("cancelled"));
      assert.deepStrictEqual(yield* decide(rig, afterOutage()), {
        kind: "resumed",
        resumes: 1,
        limit: 2,
        status: "cancelled",
      });
      theIssueIsStillBuilding(rig);
    }),
  );

  it.effect("resumes two sessions that ended badly in one pass without any T3 trouble", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      yield* failedAndSaid(rig);
      const outcome = yield* decide(rig, evidence(null, 2));
      assert.deepStrictEqual(outcome, { kind: "resumed", resumes: 1, limit: 2, status: "failed" });
      assert.deepStrictEqual(linesOf(rig), [...STARTED, resumeLine(1, 1, null, 2), sentStep(1)]);
      theIssueIsStillBuilding(rig);
    }),
  );

  it.effect("sends a lone failed session with T3 healthy to stuck with the old words", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      yield* failedAndSaid(rig);
      clearCalls(rig);
      const outcome = yield* decide(rig, lone());
      const reason = joined("the session run ended as failed", "it crashed");
      assert.deepStrictEqual(outcome, { kind: "stuck", reason });
      assert.deepStrictEqual(rig.gh, stuckCalls("the session run ended as failed", "it crashed"));
      assert.deepStrictEqual(linesOf(rig), stuckEvents([], reason));
      // The session is stopped before anything is written on the issue.
      assert.deepStrictEqual(rig.t3, ["status thread-1", ...STOP_CALLS]);
      assert.deepStrictEqual(sends(rig), []);
    }),
  );

  it.effect("records the pull request a session that ended badly left on its branch", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      rig.world.onHead = {
        "t3code/abc": [
          {
            number: 12,
            url: URL12,
            headRef: "t3code/abc",
            baseRef: "main",
            crossRepository: false,
            author: "rawphp",
          },
        ],
      };
      yield* failedAndSaid(rig);
      clearCalls(rig);
      const outcome = yield* decide(rig, lone());
      const reason = joined("the session run ended as failed", "it crashed");
      assert.deepStrictEqual(outcome, { kind: "stuck", reason });
      assert.deepStrictEqual(
        linesOf(rig),
        stuckEvents([], reason, [{ event: "pr_left", data: { pr: 12, url: URL12 } }]),
      );
    }),
  );

  it.effect(
    "ends a session that ended badly as stuck even when GitHub cannot list its pull requests",
    () =>
      Effect.gen(function* () {
        const rig = rigFor();
        rig.world.onHeadFails = true;
        yield* failedAndSaid(rig);
        clearCalls(rig);
        const outcome = yield* decide(rig, lone());
        const reason = joined("the session run ended as failed", "it crashed");
        assert.deepStrictEqual(outcome, { kind: "stuck", reason });
        assert.deepStrictEqual(rig.gh, stuckCalls("the session run ended as failed", "it crashed"));
        const events = linesOf(rig).map((line) => line.event);
        assert.ok(!events.includes("pr_left"), events.join(" "));
        assert.ok(events.indexOf("error") < events.indexOf("stuck"), events.join(" "));
      }),
  );

  it.effect("sends a cancelled session with T3 healthy to stuck as cancelled", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      endedAs(rig, "cancelled", 1, null);
      assert.deepStrictEqual(yield* advanceIn(rig), endedBadly("cancelled"));
      assert.deepStrictEqual(yield* decide(rig, lone()), {
        kind: "stuck",
        reason: "the session run ended as cancelled",
      });
      assert.strictEqual(rig.world.issue.state, "stuck");
    }),
  );

  it.effect("records the old reason code for a stuck decision of an ended badly run", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      endedAs(rig, "failed", 1, null);
      assert.deepStrictEqual(yield* advanceIn(rig), endedBadly("failed"));
      yield* decide(rig, lone());
      const stuck = readRun(rig.dataDir, rig.run).entries.find((entry) => entry.event === "stuck");
      assert.deepStrictEqual(
        { step: stuck?.cause?.step, reason: stuck?.cause?.reason },
        { step: "advance", reason: "session-ended-badly" },
      );
    }),
  );

  it.effect("leaves a thread that moved on since advance looked alone", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      yield* failedAndSaid(rig);
      // A person (or T3 itself) started it again before the pass got to the decision.
      setActive(rig, 2);
      const before = bytesOf(rig);
      clearCalls(rig);
      const outcome = yield* decide(rig, afterOutage());
      assert.strictEqual(outcome.kind, "unchanged");
      assert.strictEqual(bytesOf(rig), before);
      assert.deepStrictEqual(sends(rig), []);
      theIssueIsStillBuilding(rig);
    }),
  );

  it.effect("makes a resumed run wait for a newer run and then read it as any other", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      rig.world.pr = defaultPr();
      yield* failedAndSaid(rig);
      yield* decide(rig, afterOutage());
      const before = bytesOf(rig);
      clearCalls(rig);
      // The thread still shows the failed run 1: the resume has not started a run yet.
      assert.deepStrictEqual(yield* advanceIn(rig), { kind: "running" });
      // And while the resumed run works.
      setActive(rig, 2);
      assert.deepStrictEqual(yield* advanceIn(rig), { kind: "running" });
      assert.strictEqual(bytesOf(rig), before);
      assert.deepStrictEqual(sends(rig), []);
      // Run 2 ends with a result line: it is acted on.
      endedAs(rig, "completed", 2, DONE_MESSAGE);
      assert.strictEqual((yield* advanceIn(rig)).kind, "ready-for-gate");
    }),
  );
});

describe("interrupted: the cap", () => {
  it.effect("is two resumes, and the third ended badly goes stuck", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      const ordinal = { n: 1 };
      rig.world.status = () => statusOf("failed", "it crashed", { runOrdinal: ordinal.n });
      for (const n of [1, 2]) {
        ordinal.n = n;
        assert.deepStrictEqual(yield* advanceIn(rig), endedBadly("failed"));
        assert.deepStrictEqual(yield* decide(rig, afterOutage()), {
          kind: "resumed",
          resumes: n,
          limit: 2,
          status: "failed",
        });
      }
      assert.deepStrictEqual(sends(rig), [resumeCall(1), resumeCall(2)]);
      ordinal.n = 3;
      assert.deepStrictEqual(yield* advanceIn(rig), endedBadly("failed"));
      assert.deepStrictEqual(yield* decide(rig, afterOutage()), {
        kind: "stuck",
        reason: joined("the session run ended as failed", "it crashed"),
      });
      assert.strictEqual(rig.world.issue.state, "stuck");
      // Each resume has its own line, with its own count and the run it read.
      assert.deepStrictEqual(
        linesOf(rig).filter((line) => line.event === "session_interrupted"),
        [resumeLine(1, 1, T3_ERROR, 1), resumeLine(2, 2, T3_ERROR, 1)],
      );
    }),
  );

  it.effect("is read from the project limits", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      withResumeLimit(rig, 3);
      const ordinal = { n: 1 };
      rig.world.status = () => statusOf("failed", "it crashed", { runOrdinal: ordinal.n });
      for (const n of [1, 2, 3]) {
        ordinal.n = n;
        assert.deepStrictEqual(yield* advanceIn(rig), endedBadly("failed"));
        assert.deepStrictEqual(yield* decide(rig, afterOutage()), {
          kind: "resumed",
          resumes: n,
          limit: 3,
          status: "failed",
        });
      }
      ordinal.n = 4;
      assert.deepStrictEqual(yield* advanceIn(rig), endedBadly("failed"));
      assert.strictEqual((yield* decide(rig, afterOutage())).kind, "stuck");
    }),
  );

  it.effect("of zero sends an interrupted session to stuck at once", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      withResumeLimit(rig, 0);
      yield* failedAndSaid(rig);
      assert.strictEqual((yield* decide(rig, afterOutage())).kind, "stuck");
      assert.ok(!linesOf(rig).some((line) => line.event === "session_interrupted"));
      assert.deepStrictEqual(sends(rig), []);
      assert.strictEqual(rig.world.issue.state, "stuck");
    }),
  );

  it.effect("used up sends a thread that is gone to stuck as thread-gone", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      withResumeLimit(rig, 0);
      threadGone(rig);
      assert.deepStrictEqual(yield* advanceIn(rig), endedBadly("thread-gone"));
      assert.deepStrictEqual(yield* decide(rig, afterOutage()), {
        kind: "stuck",
        reason: THREAD_GONE,
      });
    }),
  );

  it.effect("used up records the pull request a gone thread left, by the ledger's branch", () =>
    Effect.gen(function* () {
      // The launch line named no branch; the stuck line of an earlier stop did.
      const rig = rigFor([
        ...STARTED.map((event) =>
          event.event === "session_launched"
            ? { event: "session_launched" as const, data: { ...event.data, branch: null } }
            : event,
        ),
        {
          event: "session_interrupted",
          data: {
            resumes: 1,
            relaunch: false,
            run_ordinal: 1,
            branch: "t3code/left",
            t3_error: null,
            ended_in_pass: 2,
          },
        },
        { event: "step_changed", data: { step: "interruption-sent 1" } },
      ]);
      withResumeLimit(rig, 1);
      rig.world.onHead = {
        "t3code/left": [
          {
            number: 12,
            url: URL12,
            headRef: "t3code/left",
            baseRef: "main",
            crossRepository: false,
            author: "rawphp",
          },
        ],
      };
      threadGone(rig);
      assert.deepStrictEqual(yield* advanceIn(rig), endedBadly("thread-gone"));
      assert.deepStrictEqual(yield* decide(rig, afterOutage()), {
        kind: "stuck",
        reason: THREAD_GONE,
      });
      assert.ok(rig.reads.includes("openPullRequestsOnHead t3code/left"), rig.reads.join("\n"));
      assert.ok(linesOf(rig).some((line) => line.event === "pr_left"));
    }),
  );
});

/** Run 1 as a crash leaves it after the decision to resume and before the send. */
const cutShortBeforeTheSend = () => {
  const rig = rigFor([...STARTED, resumeLine(1, 1, T3_ERROR, 1)]);
  clearCalls(rig);
  return rig;
};

/**
 * A restart of the server (this process) ends every turn that was running as `cancelled` and the
 * next status read answers as usual, so no error reaches the machine log: the server starts the
 * machine log records are the sign, for a run that was running when one happened.
 */
describe("interrupted: a T3 restart", () => {
  const T3_STARTED = T0 - 5 * MINUTE;
  const T3_STARTED_TEXT = "T3 Code started at 2026-10-04T10:08:16.123Z";
  const endedWith = (rig: Rig, status: RunStatus, startedAt: number, completedAt: number) => {
    rig.world.status = () =>
      statusOf(status, null, {
        runOrdinal: 1,
        runStartedAt: startedAt,
        runCompletedAt: completedAt,
      });
  };

  it.effect("resumes a lone cancelled run that was running when the server started", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      endedWith(rig, "cancelled", T0 - 10 * MINUTE, T0 - 4 * MINUTE);
      assert.deepStrictEqual(yield* advanceIn(rig), endedBadly("cancelled"));
      clearCalls(rig);
      const outcome = yield* decide(rig, evidence(null, 1, [T3_STARTED]));
      assert.strictEqual(outcome.kind, "resumed");
      const line = linesOf(rig).find((entry) => entry.event === "session_interrupted");
      assert.strictEqual(field(line!.data, "t3_error"), T3_STARTED_TEXT);
      assert.strictEqual(sends(rig).length, 1);
      assert.strictEqual(rig.world.issue.state, "building");
    }),
  );

  it.effect("records the machine log's error over the start when it has one", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      endedWith(rig, "cancelled", T0 - 10 * MINUTE, T0 - 4 * MINUTE);
      assert.deepStrictEqual(yield* advanceIn(rig), endedBadly("cancelled"));
      assert.strictEqual((yield* decide(rig, evidence(T3_ERROR, 1, [T3_STARTED]))).kind, "resumed");
      const line = linesOf(rig).find((entry) => entry.event === "session_interrupted");
      assert.strictEqual(field(line!.data, "t3_error"), T3_ERROR);
    }),
  );

  it.effect("resumes a run a graceful shutdown ended just before the next start", () =>
    Effect.gen(function* () {
      // launchctl stops the old process, whose shutdown marks the turn `cancelled` then; the new
      // process starts seconds later. The run ended before the start, within the grace.
      const rig = rigFor();
      endedWith(rig, "cancelled", T0 - 10 * MINUTE, T3_STARTED - 3_000);
      assert.deepStrictEqual(yield* advanceIn(rig), endedBadly("cancelled"));
      assert.strictEqual((yield* decide(rig, evidence(null, 1, [T3_STARTED]))).kind, "resumed");
      const line = linesOf(rig).find((entry) => entry.event === "session_interrupted");
      assert.strictEqual(field(line!.data, "t3_error"), T3_STARTED_TEXT);
    }),
  );

  it.effect("resumes a run an earlier start cut off when the server has started again since", () =>
    Effect.gen(function* () {
      // The first restart cut the run; a rollback restarted the server again before any pass
      // decided it. The earlier start is still in the machine log.
      const rig = rigFor();
      endedWith(rig, "cancelled", T0 - 10 * MINUTE, T3_STARTED);
      assert.deepStrictEqual(yield* advanceIn(rig), endedBadly("cancelled"));
      const outcome = yield* decide(rig, evidence(null, 1, [T3_STARTED, T0 - 2 * MINUTE]));
      assert.strictEqual(outcome.kind, "resumed");
      const line = linesOf(rig).find((entry) => entry.event === "session_interrupted");
      assert.strictEqual(field(line!.data, "t3_error"), T3_STARTED_TEXT);
    }),
  );

  it.effect(
    "sends a run that ended more than ten minutes before a start with no stop on record to stuck",
    () =>
      Effect.gen(function* () {
        const rig = rigFor();
        endedWith(rig, "cancelled", T0 - 30 * MINUTE, T3_STARTED - 10 * MINUTE - 1);
        assert.deepStrictEqual(yield* advanceIn(rig), endedBadly("cancelled"));
        assert.strictEqual((yield* decide(rig, evidence(null, 1, [T3_STARTED]))).kind, "stuck");
      }),
  );

  it.effect("resumes a run the shutdown of a server that stayed down for long cut off", () =>
    Effect.gen(function* () {
      // The LaunchAgent was unloaded at T0 - 45 min for maintenance and loaded again at T3_STARTED:
      // the shutdown marked the run cancelled then, and its server_stopping line says when.
      const rig = rigFor();
      const stopped = T3_STARTED - 40 * MINUTE;
      endedWith(rig, "cancelled", T0 - 60 * MINUTE, stopped - 500);
      assert.deepStrictEqual(yield* advanceIn(rig), endedBadly("cancelled"));
      const outcome = yield* decide(rig, evidence(null, 1, [T3_STARTED], [stopped]));
      assert.strictEqual(outcome.kind, "resumed");
      const line = linesOf(rig).find((entry) => entry.event === "session_interrupted");
      assert.strictEqual(field(line!.data, "t3_error"), T3_STARTED_TEXT);
    }),
  );

  it.effect("resumes a run cut off by a shutdown written more than a day before the start", () =>
    Effect.gen(function* () {
      // Down from Friday to Monday: the stop is 60 hours older than the only start of the last day.
      const rig = rigFor();
      const stopped = T3_STARTED - 60 * 60 * MINUTE;
      endedWith(rig, "cancelled", stopped - 30 * MINUTE, stopped - 500);
      assert.deepStrictEqual(yield* advanceIn(rig), endedBadly("cancelled"));
      const outcome = yield* decide(rig, evidence(null, 1, [T3_STARTED], [stopped]));
      assert.strictEqual(outcome.kind, "resumed");
    }),
  );

  it.effect("does not count a stop that belongs to an earlier restart", () =>
    Effect.gen(function* () {
      // A stop and start at T0 - 50 and T0 - 45 min, then this start with no stop line: the run
      // began after that earlier pair and ended more than ten minutes before this start, so the
      // earlier stop is not this start's.
      const rig = rigFor();
      endedWith(rig, "cancelled", T0 - 44 * MINUTE, T0 - 20 * MINUTE);
      assert.deepStrictEqual(yield* advanceIn(rig), endedBadly("cancelled"));
      const outcome = yield* decide(
        rig,
        evidence(null, 1, [T0 - 45 * MINUTE, T3_STARTED], [T0 - 50 * MINUTE]),
      );
      assert.strictEqual(outcome.kind, "stuck");
    }),
  );

  it.effect(
    "sends a run that started after the server did to stuck: a person or the provider ended it",
    () =>
      Effect.gen(function* () {
        const rig = rigFor();
        endedWith(rig, "cancelled", T0 - 3 * MINUTE, T0 - MINUTE);
        assert.deepStrictEqual(yield* advanceIn(rig), endedBadly("cancelled"));
        assert.deepStrictEqual(yield* decide(rig, evidence(null, 1, [T3_STARTED])), {
          kind: "stuck",
          reason: "the session run ended as cancelled",
        });
        assert.deepStrictEqual(sends(rig), []);
        assert.strictEqual(rig.world.issue.state, "stuck");
      }),
  );

  it.effect("sends a run that ended before the server started to stuck", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      endedWith(rig, "failed", T0 - 30 * MINUTE, T0 - 20 * MINUTE);
      assert.deepStrictEqual(yield* advanceIn(rig), endedBadly("failed"));
      assert.deepStrictEqual(yield* decide(rig, evidence(null, 1, [T3_STARTED])), {
        kind: "stuck",
        reason: "the session run ended as failed",
      });
      assert.deepStrictEqual(sends(rig), []);
    }),
  );

  /** T3's record of a sole run that ended while its workspace was still being prepared. */
  const endedBeforeStarting = (
    rig: Rig,
    status: "cancelled" | "failed",
    requestedAt: number,
    completedAt: number,
  ) => {
    // What T3's status read answered for that record: a cancelled run that never started counts
    // as started when it was requested.
    rig.world.status = (): ThreadStatus => ({
      run: status,
      runOrdinal: 1,
      runStartedAt: status === "cancelled" ? requestedAt : null,
      runCompletedAt: completedAt,
      lastAssistantMessage: null,
      worktreePath: "/t3/wt",
      branch: "t3code/abc",
      archived: false,
    });
  };

  it.effect("resumes a run the shutdown cancelled before it had started", () =>
    Effect.gen(function* () {
      // Claimed seconds before a redeploy: the old server cancelled the run while it was still
      // preparing its workspace, so T3 never gave it a start time.
      const rig = rigFor();
      endedBeforeStarting(rig, "cancelled", T3_STARTED - 9_000, T3_STARTED - 6_000);
      assert.deepStrictEqual(yield* advanceIn(rig), endedBadly("cancelled"));
      const outcome = yield* decide(rig, evidence(null, 1, [T3_STARTED]));
      assert.strictEqual(outcome.kind, "resumed");
      const line = linesOf(rig).find((entry) => entry.event === "session_interrupted");
      assert.strictEqual(field(line!.data, "t3_error"), T3_STARTED_TEXT);
    }),
  );

  it.effect("sends a run requested and cancelled after the server started to stuck", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      endedBeforeStarting(rig, "cancelled", T0 - 3 * MINUTE, T0 - MINUTE);
      assert.deepStrictEqual(yield* advanceIn(rig), endedBadly("cancelled"));
      assert.deepStrictEqual(yield* decide(rig, evidence(null, 1, [T3_STARTED])), {
        kind: "stuck",
        reason: "the session run ended as cancelled",
      });
    }),
  );

  it.effect(
    "sends a run that failed before it had started to stuck, even just before a shutdown",
    () =>
      Effect.gen(function* () {
        // Preparing the workspace broke on its own; only a cancel is the shutdown's doing.
        const rig = rigFor();
        endedBeforeStarting(rig, "failed", T3_STARTED - 9_000, T3_STARTED - 6_000);
        assert.deepStrictEqual(yield* advanceIn(rig), endedBadly("failed"));
        assert.deepStrictEqual(yield* decide(rig, evidence(null, 1, [T3_STARTED])), {
          kind: "stuck",
          reason: "the session run ended as failed",
        });
      }),
  );

  it.effect("does not relaunch a thread that is gone on the start alone", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      threadGone(rig);
      assert.deepStrictEqual(yield* advanceIn(rig), endedBadly("thread-gone"));
      assert.deepStrictEqual(yield* decide(rig, evidence(null, 1, [T3_STARTED])), {
        kind: "stuck",
        reason: THREAD_GONE,
      });
      assert.deepStrictEqual(rig.launches, []);
    }),
  );
});

describe("interrupted: a send cut short", () => {
  it.effect("is sent again under the same command id", () =>
    Effect.gen(function* () {
      const rig = cutShortBeforeTheSend();
      endedAs(rig, "failed", 1, "it crashed");
      assert.deepStrictEqual(yield* advanceIn(rig), { kind: "running" });
      assert.deepStrictEqual(sends(rig), [resumeCall(1)]);
      assert.deepStrictEqual(linesOf(rig), [
        ...STARTED,
        resumeLine(1, 1, T3_ERROR, 1),
        sentStep(1),
      ]);
      theIssueIsStillBuilding(rig);
      // Done: the next call sends nothing and writes nothing.
      const bytes = bytesOf(rig);
      clearCalls(rig);
      assert.deepStrictEqual(yield* advanceIn(rig), { kind: "running" });
      assert.deepStrictEqual(sends(rig), []);
      assert.strictEqual(bytesOf(rig), bytes);
    }),
  );

  it.effect("that reached the thread only gets its step", () =>
    Effect.gen(function* () {
      const rig = cutShortBeforeTheSend();
      // The thread already has a newer run: the message arrived.
      setActive(rig, 2);
      assert.deepStrictEqual(yield* advanceIn(rig), { kind: "running" });
      assert.deepStrictEqual(sends(rig), []);
      assert.deepStrictEqual(linesOf(rig), [
        ...STARTED,
        resumeLine(1, 1, T3_ERROR, 1),
        sentStep(1),
      ]);
    }),
  );

  it.effect("that fails leaves the decision in the ledger and the next advance sends again", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      yield* failedAndSaid(rig);
      clearCalls(rig);
      rig.world.sendFailure = sessionsFailure("send");
      const error = yield* Effect.flip(decide(rig, afterOutage()));
      assert.strictEqual(error._tag, "FactorySessionsError");
      assert.deepStrictEqual(linesOf(rig), [...STARTED, resumeLine(1, 1, T3_ERROR, 1)]);

      clearCalls(rig);
      assert.deepStrictEqual(yield* advanceIn(rig), { kind: "running" });
      assert.deepStrictEqual(sends(rig), [resumeCall(1)]);
      assert.deepStrictEqual(linesOf(rig), [
        ...STARTED,
        resumeLine(1, 1, T3_ERROR, 1),
        sentStep(1),
      ]);
      // The attempt that failed was one resume, not two.
      assert.strictEqual(
        linesOf(rig).filter((line) => line.event === "session_interrupted").length,
        1,
      );
    }),
  );

  it.effect("into a thread that is gone is the thread-gone case", () =>
    Effect.gen(function* () {
      const rig = cutShortBeforeTheSend();
      threadGone(rig);
      assert.deepStrictEqual(yield* advanceIn(rig), endedBadly("thread-gone"));
    }),
  );

  it.effect("before its send is not charged twice when the thread is gone", () =>
    Effect.gen(function* () {
      for (const limit of [2, 1]) {
        const rig = cutShortBeforeTheSend();
        withResumeLimit(rig, limit);
        threadGone(rig);
        assert.deepStrictEqual(yield* advanceIn(rig), endedBadly("thread-gone"));
        const outcome = yield* decide(rig, afterOutage());
        assert.strictEqual(outcome.kind, "relaunched", `limit ${limit}`);
        assert.ok(outcome.kind === "relaunched" && outcome.resumes === 1, `limit ${limit}`);
        assert.ok(outcome.kind === "relaunched" && outcome.limit === limit, `limit ${limit}`);
        assert.deepStrictEqual(
          linesOf(rig).filter((line) => line.event === "session_interrupted"),
          [resumeLine(1, 1, T3_ERROR, 1), relaunchLine(1, "t3code/abc")],
          `limit ${limit}`,
        );
      }
    }),
  );
});

const relaunchedRig = () =>
  Effect.gen(function* () {
    const rig = rigFor();
    threadGone(rig);
    assert.deepStrictEqual(yield* advanceIn(rig), endedBadly("thread-gone"));
    clearCalls(rig);
    const outcome = yield* decide(rig, afterOutage());
    return { rig, outcome };
  });

const RESUMED_FROM_ABC: ResumeFrom = { run: run10, branch: "t3code/abc", after: "interrupted" };

/** The first message of a launch that continues no earlier run. */
const plainLaunchMessage = () => launchMessage(REPO, 10, "rawphp");

const assertPlainStart = (rig: Rig) => {
  const request = rig.launches.at(-1)!;
  assert.strictEqual(request.baseRef, "main");
  assert.strictEqual(request.message, plainLaunchMessage());
};

describe("interrupted: a thread that is gone", () => {
  it.effect("after a T3 outage is relaunched from its branch and not stuck", () =>
    Effect.gen(function* () {
      const { rig, outcome } = yield* relaunchedRig();
      assert.deepStrictEqual(outcome, {
        kind: "relaunched",
        resumes: 1,
        limit: 2,
        start: { kind: "started", run: run10b, threadId: "thread-2" },
      });
      // The old run: the decision, its worktree, and the summary line. No stuck line.
      assert.deepStrictEqual(linesOf(rig), [
        ...STARTED,
        relaunchLine(1, "t3code/abc"),
        worktreeRemoved("/t3/wt"),
        FINISHED,
      ]);
      assert.strictEqual(
        readRun(rig.dataDir, rig.run).entries.at(-1)?.cause?.reason,
        "session-interrupted",
      );
      // GitHub: the label goes to triage so `start` can finish the new run. No comment, no stuck.
      assert.strictEqual(rig.gh[0], "setState 10 triage");
      assert.ok(!rig.gh.some((call) => call.startsWith("comment ")), rig.gh.join("\n"));
      assert.ok(!rig.gh.includes("setState 10 stuck"), rig.gh.join("\n"));
      assert.strictEqual(rig.world.issue.state, "building");
      assert.deepStrictEqual(rig.world.issue.assignees, ["rawphp"]);
      // The new attempt carries the approval, and resumes from the branch with the paragraph.
      assert.deepStrictEqual(linesOf(rig, run10b)[0], step(`approved ${LABELED}`));
      const request = rig.launches.at(-1)!;
      assert.strictEqual(request.commandId, "softfac:rawphp__softfac__10__2:launch");
      assert.strictEqual(request.baseRef, "t3code/abc");
      assert.ok(request.message.includes(INTERRUPTED_WORDS), request.message);
      assert.strictEqual(
        request.message,
        launchMessage(REPO, 10, "rawphp", RESUMED_FROM_ABC),
      );
      const launched = readRun(rig.dataDir, run10b).entries.find(
        (entry) => entry.event === "session_launched",
      );
      assert.ok(launched !== undefined);
      assert.deepStrictEqual((launched.data as { resumed_from: unknown }).resumed_from, {
        run: "rawphp__softfac__10__1",
        branch: "t3code/abc",
      });
      assert.strictEqual(launched.cause?.reason, "resumed-from-branch");
    }),
  );

  it("has the interrupted paragraph in the factory's fixed words", () => {
    const message = launchMessage(REPO, 10, "rawphp", RESUMED_FROM_ABC);
    assert.ok(
      message.includes(`\n\n${INTERRUPTED_WORDS}\n\nYou act on GitHub as rawphp.`),
      message,
    );
    assert.ok(!message.includes("time limit"));
  });

  it.effect("gives the next attempt this run's approval, with the instructor who made it", () =>
    Effect.gen(function* () {
      const rig = rigFor(STARTED, "tomkaczocha");
      threadGone(rig);
      assert.deepStrictEqual(yield* advanceIn(rig), endedBadly("thread-gone"));
      assert.strictEqual((yield* decide(rig, afterOutage())).kind, "relaunched");
      const first = readRun(rig.dataDir, run10b).entries[0]!;
      assert.deepStrictEqual({ event: first.event, data: first.data }, step(`approved ${LABELED}`));
      assert.deepStrictEqual(first.cause, {
        step: "advance",
        reason: "approved",
        actor: "tomkaczocha",
      });
      // The relaunched attempt's own checks read the same approval and instructor.
      const next = readProgress(readRun(rig.dataDir, run10b).entries);
      assert.strictEqual(next.approvedAt, LABELED);
      assert.strictEqual(next.approvedBy, "tomkaczocha");
    }),
  );

  it.effect("with no evidence goes stuck as thread-gone", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      threadGone(rig);
      assert.deepStrictEqual(yield* advanceIn(rig), endedBadly("thread-gone"));
      clearCalls(rig);
      assert.deepStrictEqual(yield* decide(rig, lone()), { kind: "stuck", reason: THREAD_GONE });
      assert.deepStrictEqual(rig.gh, stuckCalls(THREAD_GONE));
      assert.deepStrictEqual(linesOf(rig), stuckEvents([], THREAD_GONE));
      // Nothing was launched.
      assert.deepStrictEqual(rig.launches, []);
    }),
  );

  it.effect("twice in one pass is relaunched without any T3 trouble", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      threadGone(rig);
      assert.deepStrictEqual(yield* advanceIn(rig), endedBadly("thread-gone"));
      assert.strictEqual((yield* decide(rig, evidence(null, 2))).kind, "relaunched");
    }),
  );

  it.effect("found by a send into it relaunches and counts the resume once", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      yield* failedAndSaid(rig);
      rig.world.sendNotFound = true;
      const outcome = yield* decide(rig, afterOutage());
      assert.ok(outcome.kind === "relaunched" && outcome.resumes === 1 && outcome.limit === 2);
      assert.deepStrictEqual(
        linesOf(rig).filter((line) => line.event === "session_interrupted"),
        [resumeLine(1, 1, T3_ERROR, 1), relaunchLine(1, "t3code/abc")],
      );
      assert.deepStrictEqual(linesOf(rig).at(-1), FINISHED);
      assert.strictEqual(rig.world.issue.state, "building");
    }),
  );

  it.effect("relaunched without a recorded branch starts the next attempt from base", () =>
    Effect.gen(function* () {
      const rig = rigFor(startedWith(null));
      // T3 knows nothing of the thread's branch either.
      threadGone(rig);
      assert.deepStrictEqual(yield* advanceIn(rig), endedBadly("thread-gone"));
      assert.strictEqual((yield* decide(rig, afterOutage())).kind, "relaunched");
      assert.ok(
        linesOf(rig).some(
          (line) =>
            line.event === "session_interrupted" &&
            (line.data as { relaunch: boolean; branch: unknown }).relaunch &&
            (line.data as { branch: unknown }).branch === null,
        ),
      );
      assertPlainStart(rig);
    }),
  );

  it.effect("relaunched without a branch starts the next attempt from the run's own base", () =>
    Effect.gen(function* () {
      const onFeature = startedWith(null).map((event) =>
        event.event === "session_launched"
          ? { ...event, data: { ...event.data, base: "feature/x" } }
          : event,
      );
      const rig = rigFor(onFeature);
      rig.world.issue = { ...rig.world.issue, body: "Build it.\n\n## Base\nfeature/x\n" };
      // As the factory builds a run's context: the run's base, and the repo's project beside it.
      const repoProject = rig.ctx.project;
      rig.ctx = {
        ...rig.ctx,
        project: runProject(repoProject, readProgress(readRun(rig.dataDir, rig.run).entries).base),
        repoProject,
      };
      assert.strictEqual(rig.ctx.project.base, "feature/x");
      threadGone(rig);
      assert.deepStrictEqual(yield* advanceIn(rig), endedBadly("thread-gone"));
      assert.strictEqual((yield* decide(rig, afterOutage())).kind, "relaunched");
      const request = rig.launches.at(-1)!;
      assert.strictEqual(request.baseRef, "feature/x");
      assert.strictEqual(
        request.message,
        launchMessage(REPO, 10, "rawphp", undefined, "feature/x"),
      );
      const launched = readRun(rig.dataDir, run10b).entries.find(
        (entry) => entry.event === "session_launched",
      );
      assert.strictEqual(field(launched?.data, "base"), "feature/x");
    }),
  );

  it.effect("relaunched starts from base when the issue text was edited since the approval", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      rig.world.editedSince = true;
      threadGone(rig);
      assert.deepStrictEqual(yield* advanceIn(rig), endedBadly("thread-gone"));
      assert.strictEqual((yield* decide(rig, afterOutage())).kind, "relaunched");
      assert.ok(!rig.reads.some((call) => call.startsWith("branchTip ")), rig.reads.join("\n"));
      assertPlainStart(rig);
    }),
  );

  it.effect("relaunched starts from base when the branch is not on origin", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      rig.world.branchTip = "missing";
      threadGone(rig);
      assert.deepStrictEqual(yield* advanceIn(rig), endedBadly("thread-gone"));
      yield* decide(rig, afterOutage());
      assertPlainStart(rig);
    }),
  );

  it.effect("relaunched keeps the interrupted paragraph when its launch is sent again", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      threadGone(rig);
      assert.deepStrictEqual(yield* advanceIn(rig), endedBadly("thread-gone"));
      // The first launch of the new attempt dies before it answers, as a crash does.
      let first = true;
      const launched = rig.world.launch;
      rig.world.launch = () => {
        if (first) {
          first = false;
          throw new Error("the factory died during the launch");
        }
        return launched();
      };
      const exit = yield* Effect.exit(decide(rig, afterOutage()));
      assert.ok(Exit.isFailure(exit));
      // The old run is over and the new one has recorded what it launches from.
      assert.deepStrictEqual(linesOf(rig).at(-1), FINISHED);
      assert.ok(
        linesOf(rig, run10b).some(
          (line) =>
            line.event === "step_changed" &&
            (line.data as { step: string }).step === "launch-sending resumed-from t3code/abc",
        ),
      );
      // The next pass finishes the new attempt, with the same request as before.
      yield* resumeIn(rig);
      const request = rig.launches.at(-1)!;
      assert.strictEqual(request.baseRef, "t3code/abc");
      assert.ok(request.message.includes(INTERRUPTED_WORDS), request.message);
      assert.ok(!request.message.includes("time limit"), request.message);
    }),
  );

  it.effect("carries the counter over a relaunch so the new attempt has the rest of the cap", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      // One resume in run 1.
      yield* failedAndSaid(rig);
      yield* decide(rig, afterOutage());
      // Then its thread is gone: the relaunch is the second.
      threadGone(rig);
      assert.deepStrictEqual(yield* advanceIn(rig), endedBadly("thread-gone"));
      const outcome = yield* decide(rig, afterOutage());
      assert.ok(outcome.kind === "relaunched" && outcome.resumes === 2 && outcome.limit === 2);
      assert.ok(
        linesOf(rig).some(
          (line) => JSON.stringify(line) === JSON.stringify(relaunchLine(2, "t3code/abc")),
        ),
      );

      // Run 2's session ends badly too: the cap of 2 is used up, so it goes stuck.
      endedAs(rig, "failed", 1, "it crashed again");
      assert.deepStrictEqual(yield* advanceIn(rig, run10b), endedBadly("failed"));
      assert.deepStrictEqual(yield* decide(rig, afterOutage(), run10b), {
        kind: "stuck",
        reason: joined("the session run ended as failed", "it crashed again"),
      });
      assert.strictEqual(rig.world.issue.state, "stuck");
    }),
  );

  it.effect("does not pass the resumes of a stuck run to a new attempt a person relabelled", () =>
    Effect.gen(function* () {
      // Run 1 resumed once and then went stuck for its own reason; a person set `ready` again.
      const rig = rigFor();
      yield* failedAndSaid(rig);
      yield* decide(rig, afterOutage());
      endedAs(rig, "failed", 2, "it crashed");
      assert.deepStrictEqual(yield* advanceIn(rig), endedBadly("failed"));
      withResumeLimit(rig, 1);
      assert.strictEqual((yield* decide(rig, afterOutage())).kind, "stuck");
      withResumeLimit(rig, 2);
      rig.world.issue = issueDetail("ready", []);
      assert.strictEqual((yield* start(rig.ctx, 10)).kind, "started");
      endedAs(rig, "failed", 1, "it crashed");
      assert.deepStrictEqual(yield* advanceIn(rig, run10b), endedBadly("failed"));
      assert.deepStrictEqual(yield* decide(rig, afterOutage(), run10b), {
        kind: "resumed",
        resumes: 1,
        limit: 2,
        status: "failed",
      });
    }),
  );

  it.effect("cut short is finished by advance without a new decision", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      threadGone(rig);
      assert.deepStrictEqual(yield* advanceIn(rig), endedBadly("thread-gone"));
      // The decision is written, then the first GitHub call (the label) fails.
      rig.world.setStateFails = ghFailure();
      const error = yield* Effect.flip(decide(rig, afterOutage()));
      assert.strictEqual(error._tag, "GitHubFailed");
      assert.deepStrictEqual(linesOf(rig).at(-1), relaunchLine(1, "t3code/abc"));
      // The new attempt's ledger exists with the approval, and the old run is not finished.
      assert.deepStrictEqual(linesOf(rig, run10b), [step(`approved ${LABELED}`)]);

      // The next pass: `advance` continues; it needs no evidence and decides nothing again.
      clearCalls(rig);
      const outcome = yield* advanceIn(rig);
      assert.deepStrictEqual(outcome, {
        kind: "relaunched",
        start: { kind: "started", run: run10b, threadId: "thread-2" },
      });
      assert.deepStrictEqual(linesOf(rig), [
        ...STARTED,
        relaunchLine(1, "t3code/abc"),
        worktreeRemoved("/t3/wt"),
        FINISHED,
      ]);
      assert.strictEqual(
        linesOf(rig, run10b).filter(
          (line) => JSON.stringify(line) === JSON.stringify(step(`approved ${LABELED}`)),
        ).length,
        1,
      );
      assert.strictEqual(rig.world.issue.state, "building");
      assert.deepStrictEqual(
        rig.t3.filter((call) => call.startsWith("removeWorktree ")),
        ["removeWorktree /t3/wt"],
      );
    }),
  );

  it.effect("refuses a finished run and a run of another repo", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      endedAs(rig, "failed", 1, null);
      const foreign: RunId = { repo: "rawphp/other", issue: "10", attempt: 1 };
      assert.strictEqual(
        (yield* Effect.flip(decide(rig, afterOutage(), foreign)))._tag,
        "WrongRepoError",
      );
      assert.deepStrictEqual(yield* advanceIn(rig), endedBadly("failed"));
      yield* decide(rig, lone());
      assert.strictEqual((yield* Effect.flip(decide(rig, afterOutage())))._tag, "NotBuildingError");
    }),
  );
});

/** A relaunch the pass decided and then cut short, on a run that is past `limits.minutes` by the next pass. */
const cutShortRelaunchPastTheLimit = () =>
  Effect.gen(function* () {
    const rig = rigFor();
    threadGone(rig);
    assert.deepStrictEqual(yield* advanceIn(rig), endedBadly("thread-gone"));
    rig.world.setStateFails = ghFailure();
    yield* Effect.flip(decide(rig, afterOutage()));
    clearCalls(rig);
    rig.clock.now = T0 + 91 * MINUTE;
    return rig;
  });

describe("a decided relaunch", () => {
  it.effect("is left to advance by the time limit", () =>
    Effect.gen(function* () {
      const rig = yield* cutShortRelaunchPastTheLimit();
      const bytes = bytesOf(rig);
      assert.deepStrictEqual(yield* timeLimit(rig.ctx, rig.run), {
        kind: "skipped",
        why: "relaunching",
      });
      assert.deepStrictEqual(rig.gh, []);
      assert.strictEqual(bytesOf(rig), bytes);
      // So the next step of the pass, `advance`, finishes it.
      assert.strictEqual((yield* advanceIn(rig)).kind, "relaunched");
      assert.strictEqual(readRun(rig.dataDir, rig.run).entries.at(-1)?.event, "finished");
      assert.strictEqual(rig.world.issue.state, "building");
    }),
  );

  it.effect("is left to advance by the watch even when the text changed", () =>
    Effect.gen(function* () {
      const rig = yield* cutShortRelaunchPastTheLimit();
      rig.world.textCheck = "changed";
      const bytes = bytesOf(rig);
      assert.deepStrictEqual(yield* watch(rig.ctx, rig.run), {
        kind: "skipped",
        why: "relaunching",
      });
      assert.deepStrictEqual(rig.gh, []);
      assert.deepStrictEqual(rig.reads, []);
      assert.strictEqual(bytesOf(rig), bytes);
    }),
  );

  it.effect("is left to advance by forward", () =>
    Effect.gen(function* () {
      const rig = yield* cutShortRelaunchPastTheLimit();
      rig.world.comments = [
        { id: "101", author: "rawphp", createdAt: "2026-10-04T10:13:16Z", body: "Do it." },
      ];
      const bytes = bytesOf(rig);
      const outcome = yield* forwardIn(rig);
      assert.strictEqual(outcome.skipped, "relaunching");
      assert.deepStrictEqual(sends(rig), []);
      assert.strictEqual(bytesOf(rig), bytes);
    }),
  );

  it.effect("is finished by the pass's steps in order on a run past its limit", () =>
    Effect.gen(function* () {
      const rig = yield* cutShortRelaunchPastTheLimit();
      rig.world.textCheck = "changed";
      // What a pass does for a building run: the time limit, the watch, then `advance`.
      assert.notStrictEqual((yield* timeLimit(rig.ctx, rig.run)).kind, "stopped");
      assert.notStrictEqual((yield* watch(rig.ctx, rig.run)).kind, "stopped");
      assert.strictEqual((yield* advanceIn(rig)).kind, "relaunched");
      // The old run was finished as a relaunch, not stopped: no `stuck` line.
      const lines = linesOf(rig);
      assert.ok(!lines.some((line) => line.event === "stuck"), JSON.stringify(lines));
      assert.strictEqual(lines.at(-1)?.event, "finished");
    }),
  );

  it.effect("does not reset the label of a next attempt that already started", () =>
    Effect.gen(function* () {
      const rig = rigFor([...STARTED, relaunchLine(1, "t3code/abc")]);
      // Attempt 2 was claimed and launched by the pass's start before `advance` came back.
      seed(rig.dataDir, run10b, STARTED);
      const outcome = yield* advanceIn(rig);
      assert.strictEqual(outcome.kind, "relaunched");
      assert.ok(!rig.gh.includes("setState 10 triage"), rig.gh.join("\n"));
      assert.strictEqual(rig.world.issue.state, "building");
      assert.deepStrictEqual(linesOf(rig).at(-1), FINISHED);
    }),
  );

  it.effect("overtaken by a stop by hand ends the next attempt it made, so it holds no slot", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      threadGone(rig);
      assert.deepStrictEqual(yield* advanceIn(rig), endedBadly("thread-gone"));
      // The decision is written and the next attempt's ledger made, then the label call fails.
      rig.world.setStateFails = ghFailure();
      yield* Effect.flip(decide(rig, afterOutage()));
      assert.deepStrictEqual(linesOf(rig, run10b), [step(`approved ${LABELED}`)]);
      // Before the next pass the operator stops the run: the stop wins over the relaunch.
      appendTo(rig, rig.run, [STOP_REQUESTED], "operator");
      clearCalls(rig);
      assert.deepStrictEqual(yield* advanceIn(rig), { kind: "stuck", reason: STOPPED_BY_HAND });
      assert.deepStrictEqual(linesOf(rig).at(-1), FINISHED);
      assert.ok(
        linesOf(rig).some((line) => line.event === "stuck"),
        JSON.stringify(linesOf(rig)),
      );
      assert.deepStrictEqual(rig.launches, []);
      assert.strictEqual(rig.world.issue.state, "stuck");
      // The next attempt `resume` never began is finished too, not left to hold a slot.
      const next = linesOf(rig, run10b);
      assert.strictEqual(next.length, 2, JSON.stringify(next));
      assert.strictEqual(next.at(-1)?.event, "finished");
      assert.strictEqual(field(next.at(-1)!.data, "outcome"), "stuck");
      assert.deepStrictEqual(listUnfinishedRuns(rig.dataDir), []);
    }),
  );

  it.effect("overtaken by a stop by hand leaves a next attempt that already started alone", () =>
    Effect.gen(function* () {
      const rig = rigFor([...STARTED, relaunchLine(1, "t3code/abc"), STOP_REQUESTED]);
      seed(rig.dataDir, run10b, STARTED);
      const before = bytesOf(rig, run10b);
      assert.deepStrictEqual(yield* advanceIn(rig), { kind: "stuck", reason: STOPPED_BY_HAND });
      // The issue is the next attempt's now: this run is finished as the relaunch would have
      // finished it, with no stuck line and nothing written on the issue.
      const lines = linesOf(rig);
      assert.deepStrictEqual(lines.at(-1), FINISHED);
      assert.ok(!lines.some((line) => line.event === "stuck"), JSON.stringify(lines));
      assert.deepStrictEqual(rig.gh, []);
      assert.strictEqual(rig.world.issue.state, "building");
      // The operator stopped the issue's work: the stop is carried over to the attempt that has
      // it, as the one line `stop-run.sh` would have written there, and the next pass stops it.
      const next = linesOf(rig, run10b);
      assert.strictEqual(next.length, before.split("\n").filter(Boolean).length + 1);
      assert.deepStrictEqual(next.at(-1), { event: "stop_requested", data: { by: "operator" } });
      assert.deepStrictEqual(yield* advanceIn(rig, run10b), {
        kind: "stuck",
        reason: STOPPED_BY_HAND,
      });
      assert.strictEqual(rig.world.issue.state, "stuck");
    }),
  );
});

const relaunchBranchIn = (rig: Rig, id: RunId = rig.run): string | null | undefined => {
  const line = linesOf(rig, id).find(
    (entry) =>
      entry.event === "session_interrupted" && (entry.data as { relaunch: boolean }).relaunch,
  );
  return line === undefined ? undefined : (line.data as { branch: string | null }).branch;
};

describe("a relaunch finds the branch", () => {
  it.effect("an archived thread still reports when the ledger names none", () =>
    Effect.gen(function* () {
      const rig = rigFor(startedWith(null));
      rig.world.status = () =>
        statusOf("failed", "it crashed", {
          runOrdinal: 1,
          archived: true,
          branch: "t3code/from-thread",
        });
      rig.world.thread = { worktreePath: "/t3/wt", branch: "t3code/from-thread", archived: true };
      assert.deepStrictEqual(yield* advanceIn(rig), endedBadly("thread-gone"));
      assert.strictEqual((yield* decide(rig, afterOutage())).kind, "relaunched");
      assert.strictEqual(relaunchBranchIn(rig), "t3code/from-thread");
      const request = rig.launches.at(-1)!;
      assert.strictEqual(request.baseRef, "t3code/from-thread");
      assert.ok(request.message.includes(interruptedWords("t3code/from-thread")), request.message);
    }),
  );

  it.effect("takes the pull request's branch of a re-gate session over T3's own", () =>
    Effect.gen(function* () {
      // The run's session was launched to fix a failed re-gate: its line names T3's branch and,
      // under `resumed_from`, this run and the pull request's branch it pushes to.
      const rig = rigFor(
        startedResumedFrom("t3code/own", { run: "rawphp__softfac__10__1", branch: "feat/pr-12" }),
      );
      threadGone(rig);
      assert.deepStrictEqual(yield* advanceIn(rig), endedBadly("thread-gone"));
      assert.strictEqual((yield* decide(rig, afterOutage())).kind, "relaunched");
      assert.strictEqual(relaunchBranchIn(rig), "feat/pr-12");
      const request = rig.launches.at(-1)!;
      assert.strictEqual(request.baseRef, "feat/pr-12");
      assert.deepStrictEqual(
        rig.reads.filter((read) => read.startsWith("branchTip ")),
        ["branchTip feat/pr-12"],
      );
    }),
  );

  it.effect("takes T3's own branch for a session that resumed from an earlier attempt's", () =>
    Effect.gen(function* () {
      // Attempt 2 was launched from attempt 1's branch on origin; a version before the push
      // words left its work on T3's branch, which is on origin.
      const rig = rigFor();
      seed(
        rig.dataDir,
        run10b,
        startedResumedFrom("t3code/own", { run: "rawphp__softfac__10__1", branch: "t3code/old" }),
      );
      threadGone(rig);
      assert.deepStrictEqual(yield* advanceIn(rig, run10b), endedBadly("thread-gone"));
      assert.strictEqual((yield* decide(rig, afterOutage(), run10b)).kind, "relaunched");
      assert.strictEqual(relaunchBranchIn(rig, run10b), "t3code/own");
      assert.strictEqual(rig.launches.at(-1)!.baseRef, "t3code/own");
    }),
  );

  it.effect("falls back to the branch it resumed from when origin lacks T3's own", () =>
    Effect.gen(function* () {
      // The session was told to push to attempt 1's branch, so T3's own never reached origin.
      const rig = rigFor();
      seed(
        rig.dataDir,
        run10b,
        startedResumedFrom("t3code/own", { run: "rawphp__softfac__10__1", branch: "t3code/old" }),
      );
      threadGone(rig);
      rig.world.missingBranches = ["t3code/own"];
      assert.deepStrictEqual(yield* advanceIn(rig, run10b), endedBadly("thread-gone"));
      assert.strictEqual((yield* decide(rig, afterOutage(), run10b)).kind, "relaunched");
      assert.strictEqual(relaunchBranchIn(rig, run10b), "t3code/own");
      const request = rig.launches.at(-1)!;
      assert.strictEqual(request.baseRef, "t3code/old");
      assert.ok(request.message.includes("git push origin HEAD:t3code/old"), request.message);
      assert.deepStrictEqual(
        rig.reads.filter((read) => read.startsWith("branchTip ")),
        ["branchTip t3code/own", "branchTip t3code/old"],
      );
    }),
  );

  it.effect("and removes the worktree an archived thread still reports", () =>
    Effect.gen(function* () {
      const rig = rigFor(startedWith("t3code/abc", null));
      rig.world.status = () => statusOf("failed", "it crashed", { runOrdinal: 1, archived: true });
      rig.world.thread = { worktreePath: "/t3/wt", branch: "t3code/abc", archived: true };
      assert.deepStrictEqual(yield* advanceIn(rig), endedBadly("thread-gone"));
      assert.strictEqual((yield* decide(rig, afterOutage())).kind, "relaunched");
      assert.ok(rig.t3.includes("removeWorktree /t3/wt"), rig.t3.join("\n"));
      assert.ok(
        linesOf(rig).some(
          (line) => JSON.stringify(line) === JSON.stringify(worktreeRemoved("/t3/wt")),
        ),
      );
      assert.deepStrictEqual(linesOf(rig).at(-1), FINISHED);
    }),
  );

  it.effect("of a thread that is gone and never named a worktree still finishes", () =>
    Effect.gen(function* () {
      const rig = rigFor(startedWith("t3code/abc", null));
      threadGone(rig);
      assert.deepStrictEqual(yield* advanceIn(rig), endedBadly("thread-gone"));
      assert.strictEqual((yield* decide(rig, afterOutage())).kind, "relaunched");
      assert.deepStrictEqual(
        rig.t3.filter((call) => call.startsWith("removeWorktree ")),
        [],
      );
      assert.deepStrictEqual(linesOf(rig).at(-1), FINISHED);
    }),
  );

  it.effect("takes the head of the run's pull request when nothing else names one", () =>
    Effect.gen(function* () {
      const rig = rigFor([...startedWith(null), PR_OPENED]);
      rig.world.pr = { ...defaultPr(), headRef: "t3code/pr-head" };
      threadGone(rig);
      assert.deepStrictEqual(yield* advanceIn(rig), endedBadly("thread-gone"));
      assert.strictEqual((yield* decide(rig, afterOutage())).kind, "relaunched");
      assert.strictEqual(relaunchBranchIn(rig), "t3code/pr-head");
      const request = rig.launches.at(-1)!;
      assert.strictEqual(request.baseRef, "t3code/pr-head");
    }),
  );

  it.effect("does not resume from a pull request from a fork or with an odd head", () =>
    Effect.gen(function* () {
      for (const [head, fork] of [
        ["t3code/pr-head", true],
        ["--upload-pack=x", false],
        ["a..b", false],
      ] as const) {
        const rig = rigFor([...startedWith(null), PR_OPENED]);
        rig.world.pr = { ...defaultPr(), headRef: head, crossRepository: fork };
        threadGone(rig);
        assert.deepStrictEqual(yield* advanceIn(rig), endedBadly("thread-gone"));
        yield* decide(rig, afterOutage());
        assert.strictEqual(relaunchBranchIn(rig), null, `${head} ${fork}`);
        assertPlainStart(rig);
      }
    }),
  );

  it.effect("starts the next attempt from base with no branch anywhere", () =>
    Effect.gen(function* () {
      const rig = rigFor(startedWith(null));
      threadGone(rig);
      assert.deepStrictEqual(yield* advanceIn(rig), endedBadly("thread-gone"));
      yield* decide(rig, afterOutage());
      assert.strictEqual(relaunchBranchIn(rig), null);
      assertPlainStart(rig);
    }),
  );

  it.effect("that cannot be read is an error before anything is written", () =>
    Effect.gen(function* () {
      const rig = rigFor(startedWith(null));
      rig.world.status = notFound;
      rig.world.thread = sessionsFailure("thread");
      assert.deepStrictEqual(yield* advanceIn(rig), endedBadly("thread-gone"));
      const before = bytesOf(rig);
      clearCalls(rig);
      const error = yield* Effect.flip(decide(rig, afterOutage()));
      assert.strictEqual(error._tag, "FactorySessionsError");
      assert.strictEqual(bytesOf(rig), before);
      assert.deepStrictEqual(rig.gh, []);
    }),
  );
});

/** `STARTED` without its `approved` step: a ledger an older build wrote, or one whose first line was lost. */
const UNAPPROVED: ReadonlyArray<RunEvent> = STARTED.filter(
  (line) =>
    !(
      line.event === "step_changed" &&
      String((line.data as { step: string }).step).startsWith("approved ")
    ),
);

describe("interrupted: a run with no recorded approval", () => {
  it.effect(
    "whose thread is gone after a T3 outage goes stuck as thread-gone, not relaunched",
    () =>
      Effect.gen(function* () {
        const rig = rigFor(UNAPPROVED);
        threadGone(rig);
        assert.deepStrictEqual(yield* advanceIn(rig), endedBadly("thread-gone"));
        clearCalls(rig);
        assert.deepStrictEqual(yield* decide(rig, afterOutage()), {
          kind: "stuck",
          reason: THREAD_GONE,
        });
        assert.deepStrictEqual(rig.gh, stuckCalls(THREAD_GONE));
        // No relaunch line, no next attempt, no launch: the new attempt could not confirm the text.
        assert.deepStrictEqual(linesOf(rig), [
          ...UNAPPROVED,
          worktreeRemoved("/t3/wt"),
          { event: "stuck", data: { reason: THREAD_GONE } },
          moved("building", "stuck"),
          FINISHED,
        ]);
        assert.deepStrictEqual(rig.launches, []);
        assert.ok(!NodeFS.existsSync(runPath(rig.dataDir, run10b)));
      }),
  );

  it.effect("found gone by its resume send goes stuck as thread-gone too", () =>
    Effect.gen(function* () {
      const rig = rigFor(UNAPPROVED);
      yield* failedAndSaid(rig);
      rig.world.sendNotFound = true;
      clearCalls(rig);
      assert.deepStrictEqual(yield* decide(rig, afterOutage()), {
        kind: "stuck",
        reason: THREAD_GONE,
      });
      assert.deepStrictEqual(rig.gh, stuckCalls(THREAD_GONE));
      const lines = linesOf(rig);
      // The resume the send cut short stays; no relaunch line follows it.
      assert.deepStrictEqual(
        lines.filter((line) => line.event === "session_interrupted"),
        [resumeLine(1, 1, T3_ERROR, 1)],
      );
      assert.deepStrictEqual(lines.slice(-3), [
        { event: "stuck", data: { reason: THREAD_GONE } },
        moved("building", "stuck"),
        FINISHED,
      ]);
      assert.deepStrictEqual(rig.launches, []);
      assert.ok(!NodeFS.existsSync(runPath(rig.dataDir, run10b)));
    }),
  );

  it.effect(
    "with a relaunch line in its ledger is an error for advance, with nothing written",
    () =>
      Effect.gen(function* () {
        const rig = rigFor([...UNAPPROVED, relaunchLine(1, "t3code/abc")]);
        const before = bytesOf(rig);
        const error = yield* Effect.flip(advanceIn(rig));
        assert.strictEqual(error._tag, "RelaunchUnsupportedError");
        assert.strictEqual(bytesOf(rig), before);
        assert.deepStrictEqual(rig.gh, []);
        assert.deepStrictEqual(rig.launches, []);
        assert.ok(!NodeFS.existsSync(runPath(rig.dataDir, run10b)));
      }),
  );
});

describe("the time limit", () => {
  it.effect(
    "stops a run past limits.minutes, and the next attempt resumes from the branch it recorded",
    () =>
      Effect.gen(function* () {
        // The launch line has no branch, as T3 answers the launch before the worktree exists: the
        // stop reads the thread's branch and records it on the stuck line for the next attempt.
        const rig = rigFor(startedWith(null));
        rig.clock.now = T0 + 91 * MINUTE;
        assert.strictEqual((yield* timeLimit(rig.ctx, rig.run)).kind, "stopped");
        const stuck = readRun(rig.dataDir, rig.run).entries.find(
          (entry) => entry.event === "stuck",
        );
        assert.ok(stuck !== undefined);
        assert.strictEqual(stuck.cause?.reason, "time-limit");
        assert.strictEqual((stuck.data as { branch: unknown }).branch, "t3code/abc");
        assert.strictEqual(rig.world.issue.state, "stuck");

        // A person sets `factory:ready` again: `start` continues from that branch on origin.
        rig.world.issue = issueDetail("ready", []);
        clearCalls(rig);
        assert.deepStrictEqual(yield* start(rig.ctx, 10), {
          kind: "started",
          run: run10b,
          threadId: "thread-2",
        });
        assert.deepStrictEqual(
          rig.reads.filter((read) => /^(branchTip|textEditedSince) /.test(read)),
          [`textEditedSince 10 ${LABELED}`, "branchTip t3code/abc"],
        );
        const request = rig.launches.at(-1)!;
        assert.strictEqual(request.commandId, "softfac:rawphp__softfac__10__2:launch");
        assert.strictEqual(request.baseRef, "t3code/abc");
        assert.strictEqual(
          request.message,
          launchMessage(REPO, 10, "rawphp", {
            run: run10,
            branch: "t3code/abc",
            after: "time-limit",
          }),
        );
        assert.ok(
          request.message.includes(
            "A previous attempt of this issue (rawphp__softfac__10__1) stopped at its time limit. The worktree already holds its commits: continue from them, do not start over.",
          ),
          request.message,
        );
        // The ledger shows the choice: the step, the launch line's `resumed_from` and its reason.
        const next = readRun(rig.dataDir, run10b).entries;
        assert.ok(
          next.some(
            (entry) =>
              entry.event === "step_changed" &&
              field(entry.data, "step") === "launch-sending resumed-from t3code/abc",
          ),
        );
        const launched = next.find((entry) => entry.event === "session_launched");
        assert.deepStrictEqual(field(launched?.data, "resumed_from"), {
          run: "rawphp__softfac__10__1",
          branch: "t3code/abc",
        });
        assert.strictEqual(launched?.cause?.reason, "resumed-from-branch");
      }),
  );
});

describe("interrupted: a stop by hand", () => {
  it.effect("is not relaunched when the thread is gone, whatever else ended badly", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      threadGone(rig);
      // `advance` looked before the operator stopped the run, and said it ended badly.
      assert.deepStrictEqual(yield* advanceIn(rig), endedBadly("thread-gone"));
      appendTo(rig, rig.run, [STOP_REQUESTED], "operator");
      clearCalls(rig);
      assert.deepStrictEqual(yield* decide(rig, evidence(T3_ERROR, 3)), {
        kind: "stuck",
        reason: STOPPED_BY_HAND,
      });
      assert.deepStrictEqual(linesOf(rig), stuckEvents([STOP_REQUESTED], STOPPED_BY_HAND));
      assert.strictEqual(rig.world.issue.state, "stuck");
      assert.deepStrictEqual(sends(rig), []);
      assert.deepStrictEqual(rig.launches, []);
    }),
  );

  it.effect("whose session ended badly is stuck by hand and not an interruption", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      yield* failedAndSaid(rig, 1, null);
      appendTo(rig, rig.run, [STOP_REQUESTED], "operator");
      clearCalls(rig);
      assert.deepStrictEqual(yield* decide(rig, evidence(T3_ERROR, 3)), {
        kind: "stuck",
        reason: STOPPED_BY_HAND,
      });
      assert.deepStrictEqual(linesOf(rig), stuckEvents([STOP_REQUESTED], STOPPED_BY_HAND));
      assert.deepStrictEqual(sends(rig), []);
      assert.strictEqual(rig.world.issue.state, "stuck");
    }),
  );

  it.effect("that lands between the ledger read and the thread read is not a relaunch", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      yield* failedAndSaid(rig, 1, null);
      // The operator's stop line and archive land after `interrupted` has read the ledger and
      // before it reads the thread, which T3 then no longer has.
      rig.world.status = () => {
        appendTo(rig, rig.run, [STOP_REQUESTED], "operator");
        return notFound();
      };
      clearCalls(rig);
      assert.deepStrictEqual(yield* decide(rig, evidence(T3_ERROR, 3)), {
        kind: "stuck",
        reason: STOPPED_BY_HAND,
      });
      assert.deepStrictEqual(sends(rig), []);
      assert.deepStrictEqual(rig.launches, []);
      assert.strictEqual(rig.world.issue.state, "stuck");
      assert.deepStrictEqual(linesOf(rig), stuckEvents([STOP_REQUESTED], STOPPED_BY_HAND));
    }),
  );

  it.effect("that lands before the resume is sent is not a relaunch", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      yield* failedAndSaid(rig, 1, null);
      // The stop lands after the thread read; the archive makes the resume send fail as not found.
      rig.world.status = () => {
        appendTo(rig, rig.run, [STOP_REQUESTED], "operator");
        return statusOf("failed", "it crashed", { runOrdinal: 1 });
      };
      rig.world.sendNotFound = true;
      clearCalls(rig);
      assert.deepStrictEqual(yield* decide(rig, evidence(T3_ERROR, 3)), {
        kind: "stuck",
        reason: STOPPED_BY_HAND,
      });
      assert.deepStrictEqual(rig.launches, []);
      assert.strictEqual(rig.world.issue.state, "stuck");
      // The line the pass wrote before the send stays, as a resume cut short does; the stop wins.
      const lines = linesOf(rig);
      assert.strictEqual(lines.at(-1)?.event, "finished");
      assert.ok(
        !lines.some(
          (line) =>
            line.event === "session_interrupted" && (line.data as { relaunch: boolean }).relaunch,
        ),
        JSON.stringify(lines),
      );
    }),
  );
});

/** What Claude Code ended a session with while every credential was cooling down. */
const COOLING_DOWN =
  "API Error: Request rejected (429) · All credentials for model claude-fable-5-1 are cooling down (last error: rate_limit_error: This request would exceed your account's rate limit. Please try again later.)";

/** The message a resume after a rate limit sends, written out independently of the code under test. */
const COOLED_MESSAGE =
  "The provider's rate limit cut your last turn off, so the factory is not treating it as your decision. It waited for the limit to cool down before sending this. Continue from where you were. End your reply with a result line as before: FACTORY-DONE: <PR URL>, FACTORY-STOP: needs-info (after your numbered questions) or FACTORY-STOP: stuck.";

const cooledCall = (ordinal: number) =>
  `send thread-1 softfac:rawphp__softfac__10__1:rate-limited:${ordinal} ${COOLED_MESSAGE}`;

/** The model the rig's session was launched on, and the one a rate limit moves it to. */
const OPUS = { instanceId: "claudeAgent", model: "claude-opus-5-5" };
const SONNET = { instanceId: "claudeAgent", model: "claude-sonnet-5-5" };
const ON_SONNET = " [on claudeAgent claude-sonnet-5-5]";
/** What the resume says when it moves the session to another model, written out independently. */
const MOVED_MESSAGE =
  "The provider's rate limit cut your last turn off, so the factory is not treating it as your decision. It moved this thread to claude-sonnet-5-5, which is not limited, to carry on. Continue from where you were. End your reply with a result line as before: FACTORY-DONE: <PR URL>, FACTORY-STOP: needs-info (after your numbered questions) or FACTORY-STOP: stuck.";
const movedCall = (ordinal: number) =>
  `send thread-1 softfac:rawphp__softfac__10__1:rate-limited:${ordinal} ${MOVED_MESSAGE}${ON_SONNET}`;

const cooledLine = (resumes: number, runOrdinal: number, model?: string): RunEvent => ({
  event: "session_rate_limited",
  data: {
    run_ordinal: runOrdinal,
    branch: "t3code/abc",
    resumes,
    ...(model !== undefined && { model }),
  },
});
const cooledSent = (runOrdinal: number) => step(`rate-limited-sent ${runOrdinal}`);

describe("a provider rate limit", () => {
  it.effect("is told apart from a session that ended badly, and nothing is written", () =>
    Effect.gen(function* () {
      for (const status of ["failed", "cancelled"] as const) {
        const rig = rigFor();
        rig.world.status = () =>
          statusOf(status, COOLING_DOWN, { runOrdinal: 1, runCompletedAt: T0 - MINUTE });
        const before = bytesOf(rig);
        assert.deepStrictEqual(
          yield* advanceIn(rig),
          { kind: "rate-limited", endedMs: T0 - MINUTE, retryAfterMs: null, model: OPUS },
          status,
        );
        theIssueIsStillBuilding(rig);
        assert.strictEqual(bytesOf(rig), before, status);
        assert.deepStrictEqual(rig.t3, ["status thread-1"], status);
      }
    }),
  );

  it.effect("is resumed after the cooldown without using an interruption resume", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      endedAs(rig, "failed", 1, COOLING_DOWN);
      clearCalls(rig);
      assert.deepStrictEqual(yield* resumeAfterCooldown(rig.ctx, rig.run), { kind: "resumed" });
      assert.deepStrictEqual(linesOf(rig), [...STARTED, cooledLine(0, 1), cooledSent(1)]);
      assert.deepStrictEqual(rig.t3, ["status thread-1", cooledCall(1)]);
      theIssueIsStillBuilding(rig);
      // The session is working until a run newer than the one that ended has ended.
      assert.deepStrictEqual(yield* advanceIn(rig), { kind: "running" });

      // It ran into the limit again, and is resumed again under a command id of its own.
      endedAs(rig, "failed", 2, COOLING_DOWN);
      assert.strictEqual((yield* advanceIn(rig)).kind, "rate-limited");
      assert.deepStrictEqual(yield* resumeAfterCooldown(rig.ctx, rig.run), { kind: "resumed" });
      assert.deepStrictEqual(sends(rig), [cooledCall(1), cooledCall(2)]);

      // A real interruption later still has both of its resumes.
      endedAs(rig, "failed", 3, "it crashed");
      assert.deepStrictEqual(yield* advanceIn(rig), endedBadly("failed"));
      assert.deepStrictEqual(yield* decide(rig, afterOutage()), {
        kind: "resumed",
        resumes: 1,
        limit: 2,
        status: "failed",
      });
      theIssueIsStillBuilding(rig);
    }),
  );

  it.effect("keeps the count of an earlier interruption on its line", () =>
    Effect.gen(function* () {
      const rig = rigFor([...STARTED, resumeLine(1, 1, T3_ERROR, 1), sentStep(1)]);
      endedAs(rig, "failed", 2, COOLING_DOWN);
      assert.deepStrictEqual(yield* resumeAfterCooldown(rig.ctx, rig.run), { kind: "resumed" });
      assert.deepStrictEqual(linesOf(rig), [
        ...STARTED,
        resumeLine(1, 1, T3_ERROR, 1),
        sentStep(1),
        cooledLine(1, 2),
        cooledSent(2),
      ]);
    }),
  );

  it.effect("cut short before its send is sent again under the same command id", () =>
    Effect.gen(function* () {
      const rig = rigFor([...STARTED, cooledLine(0, 1)]);
      endedAs(rig, "failed", 1, COOLING_DOWN);
      assert.deepStrictEqual(yield* advanceIn(rig), { kind: "running" });
      assert.deepStrictEqual(sends(rig), [cooledCall(1)]);
      assert.deepStrictEqual(linesOf(rig), [...STARTED, cooledLine(0, 1), cooledSent(1)]);
    }),
  );

  it.effect("is not resumed once the thread has moved on, and nothing is written", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      setActive(rig, 2);
      const before = bytesOf(rig);
      assert.deepStrictEqual(yield* resumeAfterCooldown(rig.ctx, rig.run), {
        kind: "unchanged",
        why: "its thread has moved on since",
      });
      assert.strictEqual(bytesOf(rig), before);
      assert.deepStrictEqual(sends(rig), []);
    }),
  );

  it.effect(
    "moved to another model sends the resume on it, and the run is on that model after",
    () =>
      Effect.gen(function* () {
        const rig = rigFor();
        endedAs(rig, "failed", 1, COOLING_DOWN);
        clearCalls(rig);
        assert.deepStrictEqual(yield* resumeAfterCooldown(rig.ctx, rig.run, SONNET), {
          kind: "resumed",
        });
        assert.deepStrictEqual(linesOf(rig), [
          ...STARTED,
          cooledLine(0, 1, "claude-sonnet-5-5"),
          cooledSent(1),
        ]);
        assert.deepStrictEqual(rig.t3, ["status thread-1", movedCall(1)]);
        assert.deepStrictEqual(readProgress(readRun(rig.dataDir, rig.run).entries).model, SONNET);
        // The next rate limit is the new model's.
        endedAs(rig, "failed", 2, COOLING_DOWN);
        assert.deepStrictEqual(yield* advanceIn(rig), {
          kind: "rate-limited",
          endedMs: 0,
          retryAfterMs: null,
          model: SONNET,
        });
      }),
  );

  it.effect(
    "moved to another model and cut short before its send is sent again on that model",
    () =>
      Effect.gen(function* () {
        const switched = cooledLine(0, 1, "claude-sonnet-5-5");
        const rig = rigFor([...STARTED, switched]);
        endedAs(rig, "failed", 1, COOLING_DOWN);
        assert.deepStrictEqual(yield* advanceIn(rig), { kind: "running" });
        assert.deepStrictEqual(sends(rig), [movedCall(1)]);
        assert.deepStrictEqual(linesOf(rig), [...STARTED, switched, cooledSent(1)]);
      }),
  );

  it.effect("takes the provider's retry-after from the error", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      rig.world.status = () =>
        statusOf(
          "failed",
          "API Error: Request rejected (429) · rate_limit_error, retry-after: 120",
          {
            runOrdinal: 1,
            runCompletedAt: T0 - MINUTE,
          },
        );
      assert.deepStrictEqual(yield* advanceIn(rig), {
        kind: "rate-limited",
        endedMs: T0 - MINUTE,
        retryAfterMs: 120_000,
        model: OPUS,
      });
    }),
  );

  it.effect("with no end from T3 is placed at its start, else long ago, never at the clock", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      rig.world.status = () =>
        statusOf("failed", COOLING_DOWN, { runOrdinal: 1, runStartedAt: T0 - 3 * MINUTE });
      const started = {
        kind: "rate-limited" as const,
        endedMs: T0 - 3 * MINUTE,
        retryAfterMs: null,
        model: OPUS,
      };
      assert.deepStrictEqual(yield* advanceIn(rig), started);
      rig.clock.now += 30 * MINUTE;
      assert.deepStrictEqual(yield* advanceIn(rig), started);
      endedAs(rig, "failed", 1, COOLING_DOWN);
      assert.deepStrictEqual(yield* advanceIn(rig), { ...started, endedMs: 0 });
    }),
  );

  it.effect("is not resumed once a stop by hand is requested, and nothing is written", () =>
    Effect.gen(function* () {
      const rig = rigFor([...STARTED, STOP_REQUESTED]);
      endedAs(rig, "failed", 1, COOLING_DOWN);
      const before = bytesOf(rig);
      assert.deepStrictEqual(yield* resumeAfterCooldown(rig.ctx, rig.run, SONNET), {
        kind: "unchanged",
        why: "a stop by hand was requested",
      });
      assert.strictEqual(bytesOf(rig), before);
      assert.deepStrictEqual(sends(rig), []);
    }),
  );

  it.effect(
    "into a thread that is gone writes nothing, and its send gone leaves the resume owed",
    () =>
      Effect.gen(function* () {
        const gone = rigFor();
        threadGone(gone);
        const before = bytesOf(gone);
        assert.deepStrictEqual(yield* resumeAfterCooldown(gone.ctx, gone.run), {
          kind: "unchanged",
          why: "its thread is gone",
        });
        assert.strictEqual(bytesOf(gone), before);

        const refused = rigFor();
        endedAs(refused, "failed", 1, COOLING_DOWN);
        refused.world.sendNotFound = true;
        assert.deepStrictEqual(yield* resumeAfterCooldown(refused.ctx, refused.run), {
          kind: "unchanged",
          why: "its thread is gone",
        });
        assert.deepStrictEqual(linesOf(refused), [...STARTED, cooledLine(0, 1)]);
      }),
  );

  it.effect("owed when its thread is gone charges the relaunch nothing", () =>
    Effect.gen(function* () {
      const rig = rigFor([
        ...STARTED,
        resumeLine(1, 1, T3_ERROR, 1),
        sentStep(1),
        cooledLine(1, 2),
      ]);
      threadGone(rig);
      assert.deepStrictEqual(yield* advanceIn(rig), endedBadly("thread-gone"));
      const outcome = yield* decide(rig, afterOutage());
      assert.strictEqual(outcome.kind, "relaunched");
      // One real interruption before, and the relaunch: two, not one.
      assert.ok(outcome.kind === "relaunched" && outcome.resumes === 2);
    }),
  );

  it.effect("moved to another model keeps the session's provider options", () =>
    Effect.gen(function* () {
      const options = [{ id: "effort", value: "high" }];
      const launched = STARTED.map((line): RunEvent =>
        line.event === "session_launched"
          ? ({ ...line, data: { ...line.data, model_options: options } } as RunEvent)
          : line,
      );
      const moved = cooledLine(0, 1, "claude-sonnet-5-5");
      assert.deepStrictEqual(readProgress(seededEntries([...launched, moved])).model, {
        ...SONNET,
        options,
      });
    }),
  );

  it.effect("is not resumed once a relaunch is decided, and nothing is written", () =>
    Effect.gen(function* () {
      const rig = rigFor([...STARTED, relaunchLine(1, "t3code/abc")]);
      endedAs(rig, "failed", 1, COOLING_DOWN);
      const before = bytesOf(rig);
      assert.deepStrictEqual(yield* resumeAfterCooldown(rig.ctx, rig.run), {
        kind: "unchanged",
        why: "a relaunch is already decided",
      });
      assert.strictEqual(bytesOf(rig), before);
    }),
  );
});
