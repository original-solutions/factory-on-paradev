// @effect-diagnostics nodeBuiltinImport:off - the tests read the bytes of real run files.
/**
 * `advance` of a building run, ported from softfac's `runner/tests.rs`, with the end of a run:
 * a merged or closed pull request, a closed issue and a stop by hand. Left out: the "a new
 * attempt ..." tests (`start.ts`), `apply()` internals, the gate and forward interplay, the
 * crash matrix, a recorded gate pass, and the real `gh` client (`tracker/github.test.ts`).
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe } from "vitest";

import { timeLimitOnlyProjectConfig, type ProjectConfig } from "../config.ts";
import type { TextCheck } from "../domain/approval.ts";
import type { State } from "../domain/lifecycle.ts";
import { makeCause, type RunEvent } from "../ledger/events.ts";
import { Ledger } from "../ledger/ledger.ts";
import { readRun } from "../ledger/read.ts";
import { runPath, type RunId } from "../ledger/runId.ts";
import { T0, useTempDirs } from "../ledger/testSupport.ts";
import {
  MessageRejectedError,
  SessionsError,
  ThreadNotFoundError,
  type Checkout,
  type RunStatus,
  type Thread,
  type ThreadStatus,
} from "../sessions.ts";
import {
  GitHubFailed,
  GitHubRateLimited,
  type OpenPullRequest,
  type GitHubError,
  type IssueDetail,
  type PullRequest,
} from "../tracker/github.ts";
import {
  advance,
  checkBinding,
  timeLimit,
  watch,
  type AdvanceOutcome,
  type BuildingContext,
} from "./building.ts";
import { readProgress } from "./progress.ts";
import { runProject } from "./run.ts";
import { interruptible } from "./testSupport.ts";

const tempDir = useTempDirs();

const REPO = "rawphp/softfac";
const run10: RunId = { repo: REPO, issue: "10", attempt: 1 };
const LABELED = "2026-10-04T10:00:00Z";
const URL12 = "https://github.com/rawphp/softfac/pull/12";
const URL14 = "https://github.com/rawphp/softfac/pull/14";
const DONE_MESSAGE = `Built it.\nFACTORY-DONE: ${URL12}`;
const QUESTIONS = "1. Which database?\n2. Which user?";
const WORKING_MESSAGE = "Review is running in the background. I'm waiting on it.";
const NO_RESULT_LINE = "the session ended without a FACTORY-DONE or FACTORY-STOP line";
const SAID_STUCK = "the session stopped and said it was stuck";
const THREAD_GONE = "the T3 thread no longer exists";
const REMINDER =
  "Your last reply had no result line. If your work is still in progress, finish it. End your reply with one of these lines as the last line: FACTORY-DONE: <PR URL>, FACTORY-STOP: needs-info (after your numbered questions) or FACTORY-STOP: stuck.";
const WRONG_ACCOUNT =
  "the session ran as the wrong GitHub account: restart the factory's T3 server so it has GH_CONFIG_DIR, then set factory:ready again";

type Line = { readonly event: string; readonly data: unknown };

const step = (text: string): RunEvent => ({ event: "step_changed", data: { step: text } });
const moved = (from: State, to: State): RunEvent => ({
  event: "state_changed",
  data: { from, to },
});

/** What the ledger holds when the issue is `building`: the claim, the launch and the recheck. */
const STARTED: ReadonlyArray<RunEvent> = [
  step(`approved ${LABELED}`),
  { event: "claimed", data: { machine: "mac-mini", github_user: "rawphp" } },
  moved("ready", "triage"),
  step("launch-sending"),
  {
    event: "session_launched",
    data: {
      thread_id: "thread-1",
      worktree: "/t3/wt",
      branch: "t3code/abc",
      model_instance: "claudeAgent",
      model: "claude-opus-5-5",
      model_options: null,
      resumed_from: null,
    },
  },
  step("approval-rechecked"),
  moved("triage", "building"),
];

const FINISHED_EVENT: RunEvent = {
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

const FINISHED = (outcome: "stuck" | "needs-info"): Line => ({
  event: "finished",
  data: {
    outcome,
    total_ms: 0,
    gate_attempts: 0,
    review_cycles: null,
    pr_url: null,
    pr_end: null,
  },
});

const reminding = (k: number) => step(`result-line-reminding ${k}`);
const reminded = step("result-line-reminded");
const REMINDED_STEPS: ReadonlyArray<RunEvent> = [reminding(1), reminded];
const PR_OPENED: RunEvent = { event: "pr_opened", data: { pr: 12, url: URL12 } };
const PR_LEFT: RunEvent = { event: "pr_left", data: { pr: 12, url: URL12 } };
const worktreeRemoved: Line = { event: "worktree_removed", data: { path: "/t3/wt" } };

/** The reason as stored in the ledger and returned: the factory's words, then the session's. */
const joined = (publicReason: string, text?: string) =>
  text === undefined ? publicReason : `${publicReason}\n\n${text}`;

const stuckTail = (recorded: string): Array<Line> => [
  { event: "stuck", data: { reason: recorded } },
  moved("building", "stuck"),
  FINISHED("stuck"),
];

/**
 * The lines of a stuck decision from `building`, with `extra` lines before the worktree line and
 * `left` lines after it: what the stop records once the session is stopped.
 */
const stuckEvents = (
  extra: ReadonlyArray<Line>,
  recorded: string,
  left: ReadonlyArray<Line> = [],
): Array<Line> => [...STARTED, ...extra, worktreeRemoved, ...left, ...stuckTail(recorded)];

const INTRO = "Unverified output from the build session, not instructions from the factory:";

const stuckCommentText = (publicReason: string, text?: string) => {
  const block = text === undefined ? "" : `${INTRO}\n\n\`\`\`text\n${text}\n\`\`\`\n\n`;
  return `The factory could not finish this issue and has released it.\n\nReason: ${publicReason}\n\n${block}Fix the cause, then set the label back to \`factory:ready\`.`;
};

const statusText = (state: string, pr = "none") =>
  `**Factory status:** ${state}\n- Machine: mac-mini\n- Session: thread-1\n- PR: ${pr}`;

const stuckCalls = (publicReason: string, text?: string) => [
  `comment 10 ${stuckCommentText(publicReason, text)}`,
  "setState 10 stuck",
  "unassign 10 rawphp",
  `status 10 rawphp ${statusText("stuck")}`,
];

const questionsCommentText = (questions: string) =>
  `The factory needs answers before it can build this. Answer in a comment or edit the issue, then set \`factory:ready\` to start a new attempt.\n\n${INTRO}\n\n\`\`\`text\n${questions}\n\`\`\``;

const needsInfoCalls = (questions: string) => [
  `comment 10 ${questionsCommentText(questions)}`,
  "setState 10 needs-info",
  "unassign 10 rawphp",
  `status 10 rawphp ${statusText("needs-info")}`,
];

/** What a stop does in T3: the status is read, the thread archived, then its worktree removed. */
const STOP_CALLS = [
  "status thread-1",
  "archive thread-1",
  "thread thread-1",
  "removeWorktree /t3/wt",
];

const ghFailure = () => new GitHubFailed({ args: ["pr", "view", "12"], status: 1, stderr: "boom" });
const sessionsFailure = (operation: "status" | "send" | "archive" | "last-activity" = "status") =>
  new SessionsError({ operation, cause: "timeout" });

const isThreadNotFound = Schema.is(ThreadNotFoundError);
const isSessionsError = Schema.is(SessionsError);

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
  // After the claim, which `STARTED` writes at `T0` (10:13:16).
  createdAt: "2026-10-04T10:20:00Z",
});

/** The folder T3 names a new worktree on branch `t3/2e8db933`. */
const LAUNCH_WORKTREE = "/t3/worktrees/softfac/t3-2e8db933";

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

/** What the fakes answer. A test changes it before it calls, or between two calls. */
interface World {
  pr: PullRequest | null;
  issue: IssueDetail;
  textCheck: TextCheck | GitHubError;
  status: ThreadStatus | ThreadNotFoundError | SessionsError;
  thread: Thread | ThreadNotFoundError | SessionsError;
  /** What each worktree has checked out, by path, or the failed read of it; a path missing here has no worktree. */
  checkouts: Record<string, Checkout | SessionsError | null>;
  /** A thread by id, in place of `thread`. */
  threads: Record<string, Thread | ThreadNotFoundError | SessionsError>;
  /** The next call of each method fails with this, once. */
  failNext: {
    pullRequest?: GitHubError;
    markPrDraft?: GitHubError;
    postComment?: GitHubError;
    textCheck?: GitHubError;
    issue?: GitHubError;
    closedBy?: GitHubError;
    openPullRequestsOnHead?: GitHubError;
  };
  /** Who GitHub says closed the issue: a login, nobody, or a failed read. */
  closedBy: string | null | GitHubError;
  /** The open pull requests GitHub lists from each branch. */
  onHead: Record<string, Array<OpenPullRequest>>;
  /** The next send fails; `delivered` says T3 took the message all the same. */
  sendFailure: {
    error: SessionsError | MessageRejectedError | ThreadNotFoundError;
    delivered: boolean;
  } | null;
  archiveFails: SessionsError | null;
  /** The next read of the thread fails, once. */
  threadOnce: SessionsError | null;
  /** When the session last did anything, as epoch milliseconds, or the failed read of it. */
  lastActivity: number | null | SessionsError;
  /** The text of each message T3 took, by command id. */
  delivered: Map<string, string>;
  archived: Array<string>;
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

const MINUTE = 60_000;

const projectConfig = (base = "main"): ProjectConfig => {
  const config = timeLimitOnlyProjectConfig();
  return {
    ...config,
    instructors: ["rawphp"],
    base,
    gate: ["cargo test"],
    limits: { ...config.limits, minutes: 90 },
  };
};

/** Seeds a run file with `events`, line `i` written at `ms(i)`. */
const seed = (
  dataDir: string,
  id: RunId,
  events: ReadonlyArray<RunEvent>,
  ms: (index: number) => number = () => T0,
) => {
  let now = T0;
  const ledger = Ledger.create(dataDir, id, { clock: () => now });
  try {
    events.forEach((event, index) => {
      now = ms(index);
      ledger.append(event, makeCause("start", "seed"));
    });
  } finally {
    ledger.close();
  }
};

interface Rig {
  readonly dataDir: string;
  readonly run: RunId;
  readonly world: World;
  /** The calls to the tracker (its writes and the pull request reads) and to T3, in order, and the two interleaved. */
  readonly gh: Array<string>;
  /** The reads of the issue (`issue n`) and of who closed it (`closedBy n`): kept out of `gh`, which a closed-issue check must not change. */
  readonly reads: Array<string>;
  readonly t3: Array<string>;
  readonly order: Array<string>;
  readonly clock: { now: number };
  ctx: BuildingContext;
}

const rigFor = (
  events: ReadonlyArray<RunEvent> = STARTED,
  options: { base?: string; ms?: (index: number) => number } = {},
): Rig => {
  const dataDir = tempDir();
  seed(dataDir, run10, events, options.ms);
  const world: World = {
    pr: defaultPr(),
    issue: issueDetail("building", ["rawphp"]),
    textCheck: "unchanged",
    status: statusOf("completed", DONE_MESSAGE),
    thread: { worktreePath: "/t3/wt", branch: "t3code/abc", archived: false },
    checkouts: { "/t3/wt": { head: "def456", branch: "t3code/abc" } },
    threads: {},
    failNext: {},
    closedBy: null,
    onHead: {},
    sendFailure: null,
    archiveFails: null,
    threadOnce: null,
    lastActivity: null,
    delivered: new Map(),
    archived: [],
  };
  const gh: Array<string> = [];
  const reads: Array<string> = [];
  const t3: Array<string> = [];
  const order: Array<string> = [];
  const clock = { now: T0 };
  const ghCall = (text: string) => {
    gh.push(text);
    order.push(`gh:${text}`);
  };
  const t3Call = (text: string) => {
    t3.push(text);
    order.push(`t3:${text}`);
  };
  const takeFailure = <K extends keyof World["failNext"]>(key: K) => {
    const error = world.failNext[key];
    delete world.failNext[key];
    return error;
  };
  const readCall = (text: string) => {
    reads.push(text);
    order.push(`read:${text}`);
  };
  const tracker: BuildingContext["tracker"] = {
    // Forwarding's: `forward.test.ts` owns it.
    activitySince: () => Effect.die("not the build's"),
    issue: (n) => {
      readCall(`issue ${n}`);
      const error = takeFailure("issue");
      return error === undefined ? Effect.succeed(world.issue) : Effect.fail(error);
    },
    closedBy: (n) => {
      readCall(`closedBy ${n}`);
      const error = takeFailure("closedBy");
      if (error !== undefined) return Effect.fail(error);
      const answer = world.closedBy;
      return typeof answer === "object" && answer !== null
        ? Effect.fail(answer)
        : Effect.succeed(answer);
    },
    pullRequest: (n) => {
      ghCall(`pullRequest ${n}`);
      const error = takeFailure("pullRequest");
      return error === undefined ? Effect.succeed(world.pr) : Effect.fail(error);
    },
    openPullRequestsOnHead: (branch) => {
      readCall(`openPullRequestsOnHead ${branch}`);
      const error = takeFailure("openPullRequestsOnHead");
      return error === undefined ? Effect.succeed(world.onHead[branch] ?? []) : Effect.fail(error);
    },
    markPrDraft: (n) => {
      ghCall(`markPrDraft ${n}`);
      const error = takeFailure("markPrDraft");
      if (error !== undefined) return Effect.fail(error);
      if (world.pr !== null) world.pr = { ...world.pr, isDraft: true };
      return Effect.void;
    },
    // The gate's: the build never performs them.
    markPrReady: () => Effect.die("not the build's"),
    commentOnPr: () => Effect.die("not the build's"),
    assign: (n, user) => {
      ghCall(`assign ${n} ${user}`);
      return Effect.void;
    },
    setState: (n, state) => {
      ghCall(`setState ${n} ${state}`);
      world.issue = { ...world.issue, state, labels: [`factory:${state}`] };
      return Effect.void;
    },
    unassign: (n, user) => {
      ghCall(`unassign ${n} ${user}`);
      world.issue = { ...world.issue, assignees: [] };
      return Effect.void;
    },
    postComment: (n, body) => {
      ghCall(`comment ${n} ${body}`);
      const error = takeFailure("postComment");
      return error === undefined ? Effect.void : Effect.fail(error);
    },
    upsertStatusComment: (n, user, body) => {
      ghCall(`status ${n} ${user} ${body}`);
      return Effect.void;
    },
    textCheck: (n, since, instructors) => {
      ghCall(`textCheck ${n} ${since} ${instructors.join(",")}`);
      const error = takeFailure("textCheck");
      if (error !== undefined) return Effect.fail(error);
      return typeof world.textCheck === "string"
        ? Effect.succeed(world.textCheck)
        : Effect.fail(world.textCheck);
    },
  };
  const sessions: BuildingContext["sessions"] = {
    status: (threadId) => {
      t3Call(`status ${threadId}`);
      const answer = world.status;
      return isThreadNotFound(answer) || isSessionsError(answer)
        ? Effect.fail(answer)
        : Effect.succeed(answer);
    },
    thread: (threadId) => {
      t3Call(`thread ${threadId}`);
      const once = world.threadOnce;
      world.threadOnce = null;
      if (once !== null) return Effect.fail(once);
      const answer = world.threads[threadId] ?? world.thread;
      return isThreadNotFound(answer) || isSessionsError(answer)
        ? Effect.fail(answer)
        : Effect.succeed(answer);
    },
    send: (threadId, commandId, text) => {
      t3Call(`send ${threadId} ${commandId} ${text}`);
      const failure = world.sendFailure;
      world.sendFailure = null;
      if (failure !== null) {
        if (failure.delivered) world.delivered.set(commandId, text);
        return Effect.fail(failure.error);
      }
      world.delivered.set(commandId, text);
      return Effect.void;
    },
    archive: (threadId) => {
      t3Call(`archive ${threadId}`);
      if (world.archiveFails !== null) return Effect.fail(world.archiveFails);
      world.archived.push(threadId);
      return Effect.void;
    },
    removeWorktree: (path) => {
      t3Call(`removeWorktree ${path}`);
      return Effect.void;
    },
    // A read for the stop's reason only: kept out of `t3`, whose calls are the stop's own.
    lastActivity: () => {
      const answer = world.lastActivity;
      return isSessionsError(answer) ? Effect.fail(answer) : Effect.succeed(answer);
    },
    worktreeCheckout: (path) => {
      t3Call(`worktreeCheckout ${path}`);
      const answer = world.checkouts[path] ?? null;
      return isSessionsError(answer) ? Effect.fail(answer) : Effect.succeed(answer);
    },
  };
  const ctx: BuildingContext = {
    repo: REPO,
    trackerUser: "rawphp",
    machine: "mac-mini",
    project: projectConfig(options.base),
    dataDir,
    tracker,
    sessions,
    clock: () => clock.now,
  };
  return { dataDir, run: run10, world, gh, reads, t3, order, clock, ctx };
};

const advanceIn = (rig: Rig) => advance(interruptible(rig.ctx), rig.run);

/** GitHub says the run's issue is closed, by `by` when it names someone. */
const closeIssue = (rig: Rig, by: string | null | GitHubError = null) => {
  rig.world.issue = { ...rig.world.issue, closed: true };
  rig.world.closedBy = by;
};

const linesOf = (rig: Rig, id: RunId = rig.run): Array<Line> =>
  readRun(rig.dataDir, id).entries.map(({ event, data }) => ({ event, data }));

const bytesOf = (rig: Rig) => NodeFS.readFileSync(runPath(rig.dataDir, rig.run), "utf8");

const lastCause = (rig: Rig) => {
  const cause = readRun(rig.dataDir, rig.run).entries.at(-1)?.cause;
  return { step: cause?.step, reason: cause?.reason };
};

/** The code, as the causes of the last three lines (`stuck`, `state_changed`, `finished`) carry it. */
const stuckCauses = (rig: Rig) =>
  readRun(rig.dataDir, rig.run)
    .entries.slice(-3)
    .map((entry) => `${entry.cause?.step} ${entry.cause?.reason}`);

const clearCalls = (rig: Rig) => {
  rig.gh.length = 0;
  rig.reads.length = 0;
  rig.t3.length = 0;
  rig.order.length = 0;
};

const setStatus = (
  rig: Rig,
  run: RunStatus | null,
  message: string | null,
  over: Partial<ThreadStatus> = {},
) => {
  rig.world.status = statusOf(run, message, over);
};

/** Run `ordinal` of the session has ended with `message`. */
const setEnded = (rig: Rig, ordinal: number, message: string | null) =>
  setStatus(rig, "completed", message, { runOrdinal: ordinal });

const sends = (rig: Rig) => rig.t3.filter((call) => call.startsWith("send "));
const remindCall = (k = 1) =>
  `send thread-1 softfac:rawphp__softfac__10__1:remind:${k} ${REMINDER}`;

/** Asserts `advance` goes stuck: the outcome, the tracker calls, the ledger, and the stop before any write. */
const assertStuck = (
  rig: Rig,
  outcome: AdvanceOutcome,
  expected: {
    publicReason: string;
    text?: string;
    before?: ReadonlyArray<string>;
    extra?: ReadonlyArray<Line>;
    left?: ReadonlyArray<Line>;
    recorded?: string;
  },
) => {
  const recorded = expected.recorded ?? joined(expected.publicReason, expected.text);
  assert.deepStrictEqual(outcome, { kind: "stuck", reason: recorded });
  assert.deepStrictEqual(rig.gh, [
    ...(expected.before ?? []),
    ...stuckCalls(expected.publicReason, expected.text),
  ]);
  assert.deepStrictEqual(linesOf(rig), stuckEvents(expected.extra ?? [], recorded, expected.left));
  // The session is stopped before anything is written on the issue.
  assert.ok(
    rig.order.indexOf("t3:archive thread-1") <
      rig.order.findIndex((call) => call.startsWith("gh:comment")),
    rig.order.join("\n"),
  );
};

/** A started run whose run 1 ended with `first` (no result line) and was reminded, and whose run 2 ended with `second`. */
const remindedRun = (first: string | null, second: string | null) =>
  Effect.gen(function* () {
    const rig = rigFor();
    setEnded(rig, 1, first);
    assert.deepStrictEqual(yield* advanceIn(rig), { kind: "reminded" });
    setEnded(rig, 2, second);
    clearCalls(rig);
    return rig;
  });

/** A run whose `state_changed` to `needs-info` is written but that was not ended. */
const waitingInNeedsInfo = () => {
  const rig = rigFor([
    ...STARTED,
    { event: "questions_posted", data: { questions: "Which one?" } },
    moved("building", "needs-info"),
  ]);
  rig.world.issue = issueDetail("needs-info", []);
  setStatus(rig, "completed", "Which one?\nFACTORY-STOP: needs-info");
  return rig;
};

const WAITING_LINES: ReadonlyArray<Line> = [
  { event: "questions_posted", data: { questions: "Which one?" } },
  moved("building", "needs-info"),
];

describe("advance: while the session works", () => {
  it.effect("does nothing while the run is active, even for a message that looks final", () =>
    Effect.gen(function* () {
      const actives: ReadonlyArray<RunStatus | null> = [
        "preparing",
        "queued",
        "starting",
        "running",
        "waiting",
        null,
      ];
      for (const run of actives) {
        const rig = rigFor();
        setStatus(rig, run, DONE_MESSAGE);
        const before = bytesOf(rig);
        assert.deepStrictEqual(yield* advanceIn(rig), { kind: "running" }, String(run));
        assert.deepStrictEqual(rig.gh, [], String(run));
        assert.deepStrictEqual(rig.t3, ["status thread-1"], String(run));
        assert.strictEqual(bytesOf(rig), before, String(run));
      }
    }),
  );

  it.effect("leaves a run in triage to start until the text was checked again", () =>
    Effect.gen(function* () {
      const rig = rigFor(STARTED.slice(0, 5));
      const before = bytesOf(rig);
      assert.deepStrictEqual(yield* advanceIn(rig), { kind: "running" });
      assert.deepStrictEqual(rig.gh, []);
      assert.deepStrictEqual(rig.t3, []);
      assert.strictEqual(bytesOf(rig), before);
    }),
  );

  it.effect("moves a rechecked run in triage to building, then reads the session", () =>
    Effect.gen(function* () {
      const rig = rigFor(STARTED.slice(0, 6));
      setStatus(rig, "running", "working");
      assert.deepStrictEqual(yield* advanceIn(rig), { kind: "running" });
      assert.deepStrictEqual(rig.gh, [
        "setState 10 building",
        `status 10 rawphp ${statusText("building")}`,
      ]);
      assert.deepStrictEqual(linesOf(rig), [...STARTED]);
      assert.deepStrictEqual(lastCause(rig), { step: "advance", reason: "session-started" });
    }),
  );
});

describe("advance: done", () => {
  it.effect("with an open draft pull request on the session's branch is ready for the gate", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      const outcome = yield* advanceIn(rig);
      assert.deepStrictEqual(outcome, { kind: "ready-for-gate", pr: 12, prUrl: URL12 });
      // Only a read: the label stays building and the gate moves it on.
      assert.deepStrictEqual(rig.gh, ["pullRequest 12"]);
      assert.deepStrictEqual(linesOf(rig), [...STARTED, PR_OPENED]);
      assert.deepStrictEqual(lastCause(rig), { step: "advance", reason: "pr-opened" });
    }),
  );

  it.effect("again does not record the pull request twice", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      yield* advanceIn(rig);
      const afterFirst = bytesOf(rig);
      assert.deepStrictEqual(yield* advanceIn(rig), {
        kind: "ready-for-gate",
        pr: 12,
        prUrl: URL12,
      });
      assert.strictEqual(bytesOf(rig), afterFirst);
      assert.strictEqual(linesOf(rig).length, STARTED.length + 1);
    }),
  );

  it.effect("counts with a failed status when the pull request is open", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      setStatus(rig, "failed", DONE_MESSAGE);
      assert.strictEqual((yield* advanceIn(rig)).kind, "ready-for-gate");
    }),
  );

  it.effect("with a pull request that is not a draft puts it back to draft and goes on", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      rig.world.pr = { ...defaultPr(), isDraft: false };
      assert.strictEqual((yield* advanceIn(rig)).kind, "ready-for-gate");
      assert.deepStrictEqual(rig.gh, ["pullRequest 12", "markPrDraft 12"]);
      assert.deepStrictEqual(linesOf(rig).slice(STARTED.length), [
        { event: "pr_set_draft", data: { pr: 12 } },
        PR_OPENED,
      ]);
      assert.deepStrictEqual(
        readRun(rig.dataDir, rig.run)
          .entries.slice(STARTED.length)
          .map((e) => e.cause?.reason),
        ["pr-set-draft", "pr-opened"],
      );
    }),
  );

  it.effect("with a pull request that is not a draft and cannot be drafted is stuck", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      rig.world.pr = { ...defaultPr(), isDraft: false };
      rig.world.failNext.markPrDraft = ghFailure();
      assertStuck(rig, yield* advanceIn(rig), {
        publicReason: "the session reported PR #12 but it is not a draft",
        text: DONE_MESSAGE,
        before: ["pullRequest 12", "markPrDraft 12"],
      });
      assert.deepStrictEqual(stuckCauses(rig), Array(3).fill("advance pr-not-bound"));
    }),
  );

  it.effect("with a rate limit on putting it back to draft is an error, not stuck", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      rig.world.pr = { ...defaultPr(), isDraft: false };
      rig.world.failNext.markPrDraft = new GitHubRateLimited({ args: ["pr"], stderr: "slow down" });
      const error = yield* Effect.flip(advanceIn(rig));
      assert.strictEqual(error._tag, "GitHubRateLimited");
      // Nothing final was written: the run is still building and the next pass asks again.
      assert.deepStrictEqual(linesOf(rig), [...STARTED]);
      assert.notStrictEqual(rig.world.issue.state, "stuck");
      assert.strictEqual((yield* advanceIn(rig)).kind, "ready-for-gate");
    }),
  );

  it.effect("with someone else's pull request that is not a draft does not draft it", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      rig.world.pr = { ...defaultPr(), isDraft: false, headRef: "someone/else" };
      const outcome = yield* advanceIn(rig);
      assert.ok(
        outcome.kind === "stuck" &&
          outcome.reason.startsWith(
            "the session reported PR #12 but its branch someone/else is not this session's branch",
          ),
        JSON.stringify(outcome),
      );
      assert.ok(!rig.gh.includes("markPrDraft 12"));
    }),
  );

  it.effect("with a merged pull request on someone else's branch is still stuck", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      rig.world.pr = {
        ...defaultPr(),
        open: false,
        merged: true,
        isDraft: false,
        headRef: "someone/else",
      };
      const outcome = yield* advanceIn(rig);
      assert.deepStrictEqual(outcome, {
        kind: "stuck",
        reason: joined(
          "the session reported PR #12 but its branch someone/else is not this session's branch",
          DONE_MESSAGE,
        ),
      });
      assert.deepStrictEqual(linesOf(rig).at(-1), FINISHED("stuck"));
    }),
  );

  it.effect(
    "with a pull request on the branch T3 made the session's worktree on is ready for the gate",
    () =>
      Effect.gen(function* () {
        // T3 renamed the thread's branch; the session pushed the worktree's own `t3/<hash>`.
        const rig = rigFor();
        setStatus(rig, "completed", DONE_MESSAGE, { worktreePath: LAUNCH_WORKTREE });
        rig.world.pr = { ...defaultPr(), headRef: "t3/2e8db933" };
        const outcome = yield* advanceIn(rig);
        assert.deepStrictEqual(outcome, { kind: "ready-for-gate", pr: 12, prUrl: URL12 });
        assert.deepStrictEqual(linesOf(rig), [...STARTED, PR_OPENED]);
      }),
  );

  it.effect(
    "with a pull request on a branch that is not the worktree's launch branch is stuck",
    () =>
      Effect.gen(function* () {
        // A session that checks out someone else's branch in its worktree cannot bind its PR, nor
        // one on another worktree's `t3/<hash>`.
        for (const headRef of ["someone/else", "t3/0badf00d", "t3-2e8db933x"]) {
          const rig = rigFor();
          setStatus(rig, "completed", DONE_MESSAGE, { worktreePath: LAUNCH_WORKTREE });
          rig.world.pr = { ...defaultPr(), headRef };
          const outcome = yield* advanceIn(rig);
          assert.ok(
            outcome.kind === "stuck" &&
              outcome.reason.startsWith(
                `the session reported PR #12 but its branch ${headRef} is not this session's branch`,
              ),
            JSON.stringify(outcome),
          );
          assert.deepStrictEqual(stuckCauses(rig), Array(3).fill("advance pr-not-bound"));
        }
      }),
  );

  it.effect("with no branch recorded for the thread binds the worktree's launch branch", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      setStatus(rig, "completed", DONE_MESSAGE, { branch: null, worktreePath: LAUNCH_WORKTREE });
      // T3 flattens `t3/<hex>` to `t3-<hex>` when a plain `t3` branch exists; the folder is the same.
      rig.world.pr = { ...defaultPr(), headRef: "t3-2e8db933" };
      assert.deepStrictEqual(yield* advanceIn(rig), {
        kind: "ready-for-gate",
        pr: 12,
        prUrl: URL12,
      });
    }),
  );

  it.effect("with a pull request that does not exist is stuck", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      rig.world.pr = null;
      assertStuck(rig, yield* advanceIn(rig), {
        publicReason: "the session reported PR #12 but it does not exist",
        text: DONE_MESSAGE,
        before: ["pullRequest 12"],
      });
    }),
  );

  it.effect(
    "with someone else's pull request is stuck, and the branch stays out of the comment",
    () =>
      Effect.gen(function* () {
        for (const head of ["someone/else", "main", "T3CODE/ABC", "t3code/abc2", ""]) {
          const rig = rigFor();
          rig.world.pr = { ...defaultPr(), headRef: head };
          const recorded = joined(
            `the session reported PR #12 but its branch ${head} is not this session's branch`,
            DONE_MESSAGE,
          );
          assertStuck(rig, yield* advanceIn(rig), {
            publicReason: "the session reported PR #12 but its branch is not this session's branch",
            text: DONE_MESSAGE,
            before: ["pullRequest 12"],
            recorded,
          });
          assert.ok(!linesOf(rig).some((line) => line.event === "pr_opened"), head);
        }
      }),
  );

  it.effect("with a pull request from a fork is stuck", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      rig.world.pr = { ...defaultPr(), crossRepository: true };
      assertStuck(rig, yield* advanceIn(rig), {
        publicReason: "the session reported PR #12 but it comes from a fork",
        text: DONE_MESSAGE,
        before: ["pullRequest 12"],
      });
    }),
  );

  it.effect(
    "with a pull request into another base is stuck, and the base stays out of the comment",
    () =>
      Effect.gen(function* () {
        for (const base of [
          "release/1.0",
          "develop",
          "MAIN",
          "main2",
          "release/main",
          "@octocat",
        ]) {
          const rig = rigFor();
          rig.world.pr = { ...defaultPr(), baseRef: base };
          const shown = base.replaceAll("@", "@\u200B");
          assertStuck(rig, yield* advanceIn(rig), {
            publicReason: "the session reported PR #12 but its base is not the base branch main",
            text: DONE_MESSAGE,
            before: ["pullRequest 12"],
            recorded: joined(
              `the session reported PR #12 but its base ${shown} is not the base branch main`,
              DONE_MESSAGE,
            ),
          });
        }
      }),
  );

  it.effect("compares the base with the configured base, not with main", () =>
    Effect.gen(function* () {
      const rig = rigFor(STARTED, { base: "develop" });
      rig.world.pr = { ...defaultPr(), baseRef: "develop" };
      assert.strictEqual((yield* advanceIn(rig)).kind, "ready-for-gate");
    }),
  );

  it.effect("binds to the base the run's launch recorded, not the project's", () =>
    Effect.gen(function* () {
      const onFeature = STARTED.map((event) =>
        event.event === "session_launched"
          ? { ...event, data: { ...event.data, base: "feature/x" } }
          : event,
      );
      const forRun = (rig: Rig): Rig => ({
        ...rig,
        ctx: {
          ...rig.ctx,
          project: runProject(
            rig.ctx.project,
            readProgress(readRun(rig.dataDir, rig.run).entries).base,
          ),
        },
      });
      const bound = forRun(rigFor(onFeature));
      bound.world.pr = { ...defaultPr(), baseRef: "feature/x" };
      assert.strictEqual((yield* advanceIn(bound)).kind, "ready-for-gate");
      const refused = forRun(rigFor(onFeature));
      refused.world.pr = { ...defaultPr(), baseRef: "main" };
      assert.deepStrictEqual(yield* advanceIn(refused), {
        kind: "stuck",
        reason: joined(
          "the session reported PR #12 but its base main is not the base branch feature/x",
          DONE_MESSAGE,
        ),
      });
      assert.deepStrictEqual(refused.gh, [
        "pullRequest 12",
        ...stuckCalls(
          "the session reported PR #12 but its base is not the base branch feature/x",
          DONE_MESSAGE,
        ),
      ]);
    }),
  );

  it.effect("reports a fork before a wrong base or branch", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      rig.world.pr = {
        ...defaultPr(),
        crossRepository: true,
        baseRef: "release",
        headRef: "other",
      };
      assertStuck(rig, yield* advanceIn(rig), {
        publicReason: "the session reported PR #12 but it comes from a fork",
        text: DONE_MESSAGE,
        before: ["pullRequest 12"],
      });
    }),
  );

  it.effect("when the session has no branch fails closed", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      setStatus(rig, "completed", DONE_MESSAGE, { branch: null });
      assertStuck(rig, yield* advanceIn(rig), {
        publicReason: "the session reported PR #12 but the session has no branch",
        text: DONE_MESSAGE,
        before: ["pullRequest 12"],
      });
    }),
  );

  it.effect("is accepted when open, a draft and on the session's branch", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      setStatus(rig, "completed", DONE_MESSAGE, { branch: "t3code/xyz" });
      rig.world.pr = { ...defaultPr(), headRef: "t3code/xyz" };
      assert.strictEqual((yield* advanceIn(rig)).kind, "ready-for-gate");
    }),
  );

  it.effect("with an unusable pull request URL is stuck without asking GitHub", () =>
    Effect.gen(function* () {
      const cases = [
        [
          "https://github.com/rawphp/other/pull/12",
          "the session reported a pull request that is not on this repo",
        ],
        [
          "https://github.com/rawphp/softfac/pull/12?x=1",
          "the session reported a malformed pull request URL",
        ],
        [
          "https://github.com/rawphp/softfac/pull/12 and more",
          "the session reported a malformed pull request URL",
        ],
        [
          "https://gitlab.com/rawphp/softfac/pull/12",
          "the session reported a malformed pull request URL",
        ],
        [
          "https://github.com/rawphp/softfac/pull/0",
          "the session reported a malformed pull request URL",
        ],
        [
          "https://github.com/rawphp/softfac/pull/twelve",
          "the session reported a malformed pull request URL",
        ],
      ] as const;
      for (const [url, reason] of cases) {
        const rig = rigFor();
        const message = `Done.\nFACTORY-DONE: ${url}`;
        setStatus(rig, "completed", message);
        assertStuck(rig, yield* advanceIn(rig), { publicReason: reason, text: message });
      }
    }),
  );

  it.effect("is a runner error that writes nothing when the pull request cannot be read", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      rig.world.failNext.pullRequest = ghFailure();
      const before = bytesOf(rig);
      const error = yield* Effect.flip(advanceIn(rig));
      assert.strictEqual(error._tag, "GitHubFailed");
      assert.strictEqual(bytesOf(rig), before);
    }),
  );
});

/** The started run of a session that continued the branch `t3code/old` of the run before it. */
const RESUMED: ReadonlyArray<RunEvent> = STARTED.map((event) =>
  event.event === "session_launched"
    ? {
        event: "session_launched",
        data: {
          ...event.data,
          resumed_from: { run: "rawphp__softfac__10__1", branch: "t3code/old" },
        },
      }
    : event,
);

describe("advance: a resumed run's pull request", () => {
  it.effect("is accepted from the branch the run resumed from", () =>
    Effect.gen(function* () {
      const rig = rigFor(RESUMED);
      rig.world.pr = { ...defaultPr(), headRef: "t3code/old" };
      assert.deepStrictEqual(yield* advanceIn(rig), {
        kind: "ready-for-gate",
        pr: 12,
        prUrl: URL12,
      });
      assert.deepStrictEqual(linesOf(rig), [...RESUMED, PR_OPENED]);
    }),
  );

  it.effect("is still accepted from the run's own branch", () =>
    Effect.gen(function* () {
      const rig = rigFor(RESUMED);
      assert.strictEqual((yield* advanceIn(rig)).kind, "ready-for-gate");
      assert.deepStrictEqual(linesOf(rig), [...RESUMED, PR_OPENED]);
    }),
  );

  it.effect("is refused from a third branch", () =>
    Effect.gen(function* () {
      const rig = rigFor(RESUMED);
      rig.world.pr = { ...defaultPr(), headRef: "someone/else" };
      const outcome = yield* advanceIn(rig);
      assert.ok(
        outcome.kind === "stuck" &&
          outcome.reason.startsWith(
            "the session reported PR #12 but its branch someone/else is not this session's branch",
          ),
        JSON.stringify(outcome),
      );
    }),
  );
});

describe("advance: questions", () => {
  it.effect("posts them, releases the issue and ends the run", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      setStatus(rig, "completed", `${QUESTIONS}\nFACTORY-STOP: needs-info`);
      assert.deepStrictEqual(yield* advanceIn(rig), { kind: "needs-info" });
      assert.deepStrictEqual(rig.gh, needsInfoCalls(QUESTIONS));
      // The thread is archived and the worktree removed, then the run is finished.
      assert.deepStrictEqual(rig.t3, STOP_CALLS);
      assert.deepStrictEqual(linesOf(rig), [
        ...STARTED,
        { event: "questions_posted", data: { questions: QUESTIONS } },
        moved("building", "needs-info"),
        worktreeRemoved,
        FINISHED("needs-info"),
      ]);
      assert.deepStrictEqual(lastCause(rig), { step: "advance", reason: "questions-asked" });
    }),
  );

  it.effect("with no questions is stuck", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      setStatus(rig, "completed", "FACTORY-STOP: needs-info");
      assertStuck(rig, yield* advanceIn(rig), {
        publicReason: "the session asked for information but gave no questions",
      });
    }),
  );

  it.effect("are not asked by a run that ended badly", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      const message = "Why?\nFACTORY-STOP: needs-info";
      setStatus(rig, "failed", message);
      // The pass decides about a run that ended badly (`interruption.test.ts`): nothing is written.
      assert.deepStrictEqual(yield* advanceIn(rig), { kind: "ended-badly", what: "failed" });
      assert.deepStrictEqual(rig.gh, []);
    }),
  );

  it.effect("fail with the comment as a runner error that a retry can finish", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      setStatus(rig, "completed", "Which one?\nFACTORY-STOP: needs-info");
      rig.world.failNext.postComment = ghFailure();
      const error = yield* Effect.flip(advanceIn(rig));
      assert.strictEqual(error._tag, "GitHubFailed");
      assert.deepStrictEqual(linesOf(rig), [...STARTED]);
      assert.deepStrictEqual(yield* advanceIn(rig), { kind: "needs-info" });
    }),
  );

  it.effect("already posted are not posted again by the next call", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      setStatus(rig, "completed", "Which one?\nFACTORY-STOP: needs-info");
      // The label call fails after the comment was posted and recorded.
      rig.world.issue = issueDetail("building", ["rawphp"]);
      const original = rig.ctx.tracker.setState;
      let failed = false;
      rig.ctx = {
        ...rig.ctx,
        tracker: {
          ...rig.ctx.tracker,
          setState: (n, state) => {
            if (!failed) {
              failed = true;
              return Effect.fail(ghFailure());
            }
            return original(n, state);
          },
        },
      };
      assert.strictEqual((yield* Effect.flip(advanceIn(rig)))._tag, "GitHubFailed");
      assert.strictEqual(rig.gh.filter((call) => call.startsWith("comment")).length, 1);
      assert.deepStrictEqual(yield* advanceIn(rig), { kind: "needs-info" });
      assert.strictEqual(rig.gh.filter((call) => call.startsWith("comment")).length, 1);
    }),
  );
});

describe("advance: a run left in needs-info", () => {
  it.effect("is ended without posting the questions again", () =>
    Effect.gen(function* () {
      const rig = waitingInNeedsInfo();
      assert.deepStrictEqual(yield* advanceIn(rig), { kind: "needs-info" });
      // Nothing is written on GitHub: the label stays factory:needs-info. The issue is read once,
      // for whether it is closed and for an old claim.
      assert.deepStrictEqual(rig.gh, []);
      assert.deepStrictEqual(rig.reads, ["issue 10"]);
      assert.deepStrictEqual(rig.world.archived, ["thread-1"]);
      assert.deepStrictEqual(rig.t3.slice(0, 3), [
        "archive thread-1",
        "thread thread-1",
        "removeWorktree /t3/wt",
      ]);
      assert.deepStrictEqual(linesOf(rig), [
        ...STARTED,
        ...WAITING_LINES,
        worktreeRemoved,
        FINISHED("needs-info"),
      ]);
      assert.deepStrictEqual(lastCause(rig), { step: "advance", reason: "questions-asked" });
    }),
  );

  it.effect("is not carried out as stuck by a decision an older version recorded", () =>
    Effect.gen(function* () {
      // The old timeout path wrote `stuck` before it moved the label, then died.
      const rig = rigFor([
        ...STARTED,
        { event: "questions_posted", data: { questions: "Which one?" } },
        { event: "stuck", data: { reason: "the questions went unanswered" } },
        moved("building", "needs-info"),
      ]);
      rig.world.issue = issueDetail("needs-info", []);
      assert.deepStrictEqual(yield* advanceIn(rig), { kind: "needs-info" });
      assert.deepStrictEqual(rig.gh, []);
      assert.deepStrictEqual(rig.reads, ["issue 10"]);
      assert.deepStrictEqual(linesOf(rig).at(-1), FINISHED("needs-info"));
    }),
  );

  it.effect("whose issue a person changed is ended and the issue left alone", () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<[State | null, ReadonlyArray<string>]> = [
        ["building", ["someone"]],
        ["building", ["rawphp", "someone"]],
        ["building", []],
        ["ready", []],
        ["stuck", ["rawphp"]],
        [null, ["rawphp"]],
      ];
      for (const [state, assignees] of cases) {
        const rig = waitingInNeedsInfo();
        rig.world.issue = issueDetail(state, assignees);
        assert.deepStrictEqual(yield* advanceIn(rig), { kind: "needs-info" }, `${state}`);
        assert.deepStrictEqual(rig.gh, [], `${state} ${assignees}`);
        assert.deepStrictEqual(rig.reads, ["issue 10"], `${state} ${assignees}`);
        assert.deepStrictEqual(linesOf(rig).at(-1), FINISHED("needs-info"));
      }
    }),
  );

  it.effect("that an older version claimed back before its marker is given the issue back", () =>
    Effect.gen(function* () {
      const rig = waitingInNeedsInfo();
      rig.world.issue = issueDetail("building", ["RawPHP"]);
      assert.deepStrictEqual(yield* advanceIn(rig), { kind: "needs-info" });
      assert.deepStrictEqual(rig.gh, ["setState 10 needs-info", "unassign 10 rawphp"]);
      assert.deepStrictEqual(rig.reads, ["issue 10"]);
      assert.deepStrictEqual(rig.world.archived, ["thread-1"]);
      assert.deepStrictEqual(linesOf(rig).slice(-2), [worktreeRemoved, FINISHED("needs-info")]);
    }),
  );

  it.effect("that is ended is not ended again", () =>
    Effect.gen(function* () {
      const rig = waitingInNeedsInfo();
      yield* advanceIn(rig);
      const bytes = bytesOf(rig);
      clearCalls(rig);
      const error = yield* Effect.flip(advanceIn(rig));
      assert.strictEqual(error._tag, "NotBuildingError");
      assert.deepStrictEqual(rig.gh, []);
      assert.deepStrictEqual(rig.t3, []);
      assert.strictEqual(bytesOf(rig), bytes);
    }),
  );

  it.effect("stays open for the next call when the archive fails", () =>
    Effect.gen(function* () {
      const rig = waitingInNeedsInfo();
      rig.world.archiveFails = sessionsFailure("archive");
      assert.strictEqual((yield* Effect.flip(advanceIn(rig)))._tag, "FactorySessionsError");
      assert.deepStrictEqual(rig.world.archived, []);
      assert.notStrictEqual(linesOf(rig).at(-1)?.event, "finished");
      rig.world.archiveFails = null;
      assert.deepStrictEqual(yield* advanceIn(rig), { kind: "needs-info" });
      assert.deepStrictEqual(linesOf(rig).at(-1), FINISHED("needs-info"));
      assert.deepStrictEqual(linesOf(rig).at(-2), worktreeRemoved);
    }),
  );
});

describe("advance: stuck", () => {
  it.effect("carries out a decision already in the ledger without asking T3 or posting again", () =>
    Effect.gen(function* () {
      const rig = rigFor([...STARTED, { event: "stuck", data: { reason: "gave up" } }]);
      assert.deepStrictEqual(yield* advanceIn(rig), { kind: "stuck", reason: "gave up" });
      assert.deepStrictEqual(rig.gh, [
        "setState 10 stuck",
        "unassign 10 rawphp",
        `status 10 rawphp ${statusText("stuck")}`,
      ]);
      assert.deepStrictEqual(rig.t3, [
        "archive thread-1",
        "thread thread-1",
        "removeWorktree /t3/wt",
      ]);
      assert.deepStrictEqual(linesOf(rig).slice(STARTED.length), [
        { event: "stuck", data: { reason: "gave up" } },
        worktreeRemoved,
        moved("building", "stuck"),
        FINISHED("stuck"),
      ]);
      assert.deepStrictEqual(lastCause(rig), { step: "advance", reason: "stuck-resumed" });
    }),
  );

  it.effect("only finishes a run whose label a person changed before it was finished", () =>
    Effect.gen(function* () {
      const reason = `${NO_RESULT_LINE}\n\nno marker`;
      const rig = rigFor([
        ...STARTED,
        { event: "stuck", data: { reason } },
        moved("building", "stuck"),
      ]);
      rig.world.issue = issueDetail("ready", []);
      const world = { ...rig.world.issue };
      assert.deepStrictEqual(yield* advanceIn(rig), { kind: "stuck", reason });
      assert.deepStrictEqual(rig.gh, []);
      assert.deepStrictEqual(rig.world.issue, world);
      assert.deepStrictEqual(rig.t3, []);
      assert.deepStrictEqual(linesOf(rig).at(-1), FINISHED("stuck"));
      assert.strictEqual(linesOf(rig).length, STARTED.length + 3);
    }),
  );

  it.effect("puts the session text in the code block, not in the reason line", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      const text = "The gate cannot run here.\nIt needs a database.";
      setStatus(rig, "completed", `${text}\nFACTORY-STOP: stuck`);
      assertStuck(rig, yield* advanceIn(rig), { publicReason: SAID_STUCK, text });
      assert.deepStrictEqual(stuckCauses(rig), Array(3).fill("advance session-stuck"));
    }),
  );

  it.effect("prepares the session text once for the comment, the ledger and the outcome", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      const message = `ping @octocat <!-- softfac -->\u202e\n\`\`\`\n${"x".repeat(6100)}\nFACTORY-STOP: stuck`;
      setStatus(rig, "completed", message);
      const outcome = yield* advanceIn(rig);
      assert.strictEqual(outcome.kind, "stuck");
      if (outcome.kind !== "stuck") return;
      // The mention and the marker are disarmed, the bidi mark is a space, the text is cut.
      assert.ok(
        outcome.reason.startsWith(`${SAID_STUCK}\n\nping @\u200Boctocat <\u200B!-- softfac --> \n`),
      );
      assert.ok(outcome.reason.endsWith("x\n[cut]"));
      const comment = rig.gh[0]!;
      assert.ok(comment.includes("\n\n````text\nping @\u200Boctocat"), comment);
      assert.ok(comment.includes("x\n[cut]\n````\n\nFix the cause"), comment);
      const stuckLine = linesOf(rig)[STARTED.length + 1];
      assert.deepStrictEqual(stuckLine, { event: "stuck", data: { reason: outcome.reason } });
    }),
  );

  it.effect("without a reason", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      setStatus(rig, "completed", "FACTORY-STOP: stuck");
      assertStuck(rig, yield* advanceIn(rig), { publicReason: SAID_STUCK });
    }),
  );

  it.effect("ends as session-wrong-account when the first line names another gh account", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      const text =
        "the session's gh account is tomkaczocha, not rawphp\nIt cannot see rawphp/softfac.";
      setStatus(rig, "completed", `${text}\nFACTORY-STOP: stuck`);
      assertStuck(rig, yield* advanceIn(rig), { publicReason: WRONG_ACCOUNT, text });
      assert.deepStrictEqual(stuckCauses(rig), Array(3).fill("advance session-wrong-account"));
    }),
  );

  it.effect("counts the wrong-account line after blank lines, and alone", () =>
    Effect.gen(function* () {
      for (const message of [
        "\n  \nthe session's gh account is x, not rawphp\nmore\nFACTORY-STOP: stuck",
        "the session's gh account is x, not rawphp\nFACTORY-STOP: stuck",
      ]) {
        const rig = rigFor();
        setStatus(rig, "completed", message);
        const outcome = yield* advanceIn(rig);
        assert.ok(outcome.kind === "stuck" && outcome.reason.startsWith(WRONG_ACCOUNT), message);
        assert.strictEqual(stuckCauses(rig)[0], "advance session-wrong-account");
      }
    }),
  );

  it.effect(
    "stays session-stuck when the wrong-account words are anywhere but the first line",
    () =>
      Effect.gen(function* () {
        for (const message of [
          "The gate cannot run.\nthe session's gh account is x, not rawphp\nFACTORY-STOP: stuck",
          "I think the session's gh account is x, not rawphp\nFACTORY-STOP: stuck",
          "FACTORY-STOP: stuck",
        ]) {
          const rig = rigFor();
          setStatus(rig, "completed", message);
          const outcome = yield* advanceIn(rig);
          assert.ok(outcome.kind === "stuck" && outcome.reason.startsWith(SAID_STUCK), message);
          assert.strictEqual(stuckCauses(rig)[0], "advance session-stuck", message);
        }
      }),
  );

  it.effect("counts the wrong-account words only with the stuck line", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      setStatus(
        rig,
        "completed",
        "the session's gh account is x, not rawphp\nFACTORY-DONE: not a url",
      );
      const outcome = yield* advanceIn(rig);
      assert.ok(
        outcome.kind === "stuck" &&
          outcome.reason.startsWith("the session reported a malformed pull request URL"),
        JSON.stringify(outcome),
      );
      assert.strictEqual(stuckCauses(rig)[0], "advance session-stuck");
    }),
  );

  it.effect("when the message has no usable marker, after the one reminder", () =>
    Effect.gen(function* () {
      for (const message of [
        "I changed some files.",
        "FACTORY-STOP: stuck\nThanks for waiting.",
        "FACTORY-STOP: stuck, sorry",
        "FACTORY-STOP: needs-info\n1. Why?",
        `FACTORY-DONE: ${URL12}\nbye`,
      ]) {
        // The first ended run gets the reminder, the second goes stuck.
        const rig = yield* remindedRun(message, message);
        assertStuck(rig, yield* advanceIn(rig), {
          publicReason: NO_RESULT_LINE,
          text: message,
          extra: REMINDED_STEPS,
        });
      }
    }),
  );

  it.effect("when there is no final message, after the one reminder", () =>
    Effect.gen(function* () {
      for (const message of [null, "", "  \n"]) {
        const rig = yield* remindedRun(message, message);
        assertStuck(rig, yield* advanceIn(rig), {
          publicReason: "the session ended without a final message",
          extra: REMINDED_STEPS,
        });
      }
    }),
  );

  it.effect("when the run ended badly, with its status and no reminder", () =>
    Effect.gen(function* () {
      // A rolled back run is a stop with no second look; a failed or cancelled one is left to
      // the pass's decision (`interruption.test.ts`).
      const rig = rigFor();
      setStatus(rig, "rolled_back", "it crashed");
      assertStuck(rig, yield* advanceIn(rig), {
        publicReason: "the session run ended as rolled_back",
        text: "it crashed",
      });
      assert.deepStrictEqual(stuckCauses(rig), Array(3).fill("advance session-ended-badly"));
      for (const status of ["failed", "cancelled"] as const) {
        const other = rigFor();
        setStatus(other, status, "it crashed");
        assert.deepStrictEqual(yield* advanceIn(other), { kind: "ended-badly", what: status });
        assert.deepStrictEqual(other.gh, []);
      }
    }),
  );

  it.effect("counts only the known terminal statuses as ended", () =>
    Effect.gen(function* () {
      const statuses = ["completed", "interrupted", "failed", "cancelled", "rolled_back"] as const;
      for (const status of statuses) {
        const rig = rigFor();
        setStatus(rig, status, "no marker");
        const outcome = yield* advanceIn(rig);
        // A run that ended on its own with no result line is reminded; one a person stopped is
        // paused; one that ended badly is the pass's to decide, except a rolled back one, which
        // is stuck at once.
        if (status === "completed") assert.deepStrictEqual(outcome, { kind: "reminded" }, status);
        else if (status === "interrupted")
          assert.deepStrictEqual(outcome, { kind: "paused" }, status);
        else if (status === "rolled_back") assert.strictEqual(outcome.kind, "stuck", status);
        else assert.deepStrictEqual(outcome, { kind: "ended-badly", what: status }, status);
      }
    }),
  );

  it.effect("when the thread no longer exists", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      rig.world.status = new ThreadNotFoundError({ threadId: "thread-1" });
      // The pass decides about it (`interruption.test.ts`): nothing is written.
      const before = bytesOf(rig);
      assert.deepStrictEqual(yield* advanceIn(rig), { kind: "ended-badly", what: "thread-gone" });
      assert.deepStrictEqual(rig.gh, []);
      assert.strictEqual(bytesOf(rig), before);
    }),
  );

  it.effect("when the thread is archived", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      setStatus(rig, "completed", DONE_MESSAGE, { archived: true });
      assert.deepStrictEqual(yield* advanceIn(rig), { kind: "ended-badly", what: "thread-gone" });
      assert.deepStrictEqual(rig.gh, []);
    }),
  );

  it.effect("is never decided by a transient T3 error, which writes nothing", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      rig.world.status = sessionsFailure();
      const before = bytesOf(rig);
      const error = yield* Effect.flip(advanceIn(rig));
      assert.strictEqual(error._tag, "FactorySessionsError");
      assert.deepStrictEqual(rig.gh, []);
      assert.strictEqual(bytesOf(rig), before);
    }),
  );
});

describe("advance: a run a person stopped", () => {
  it.effect("is paused, once for each run, with nothing sent and nothing on the issue", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      setStatus(rig, "interrupted", "I was about to");
      assert.deepStrictEqual(yield* advanceIn(rig), { kind: "paused" });
      assert.deepStrictEqual(linesOf(rig).slice(STARTED.length), [
        { event: "session_paused", data: { run_ordinal: 1 } },
      ]);
      assert.deepStrictEqual(lastCause(rig), { step: "advance", reason: "session-paused" });
      const bytes = bytesOf(rig);
      assert.deepStrictEqual(yield* advanceIn(rig), { kind: "paused" });
      assert.strictEqual(bytesOf(rig), bytes);
      // The person resumes the session and stops its next run.
      setStatus(rig, "interrupted", "again", { runOrdinal: 2 });
      assert.deepStrictEqual(yield* advanceIn(rig), { kind: "paused" });
      assert.deepStrictEqual(linesOf(rig).slice(STARTED.length), [
        { event: "session_paused", data: { run_ordinal: 1 } },
        { event: "session_paused", data: { run_ordinal: 2 } },
      ]);
      assert.deepStrictEqual(rig.gh, []);
      assert.deepStrictEqual(sends(rig), []);
    }),
  );

  it.effect("is read as done when its last message says so", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      setStatus(rig, "interrupted", DONE_MESSAGE);
      assert.strictEqual((yield* advanceIn(rig)).kind, "ready-for-gate");
    }),
  );
});

describe("advance: refused before anything is read", () => {
  it.effect("on a finished run", () =>
    Effect.gen(function* () {
      const rig = rigFor([...STARTED, FINISHED_EVENT]);
      const error = yield* Effect.flip(advanceIn(rig));
      assert.strictEqual(error._tag, "NotBuildingError");
      assert.strictEqual(error.message, "run rawphp__softfac__10__1 is already finished");
      assert.deepStrictEqual(rig.gh, []);
      assert.deepStrictEqual(rig.t3, []);
    }),
  );

  it.effect("on a run with no session", () =>
    Effect.gen(function* () {
      const rig = rigFor([
        { event: "claimed", data: { machine: "mac-mini", github_user: "rawphp" } },
      ]);
      const error = yield* Effect.flip(advanceIn(rig));
      assert.strictEqual(error._tag, "NoSessionError");
      assert.strictEqual(error.message, "run rawphp__softfac__10__1 has no launched session");
      assert.deepStrictEqual(rig.t3, []);
    }),
  );

  it.effect("on a run with no file", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      const error = yield* Effect.flip(advance(interruptible(rig.ctx), { ...run10, attempt: 2 }));
      assert.strictEqual(error._tag, "LedgerNotFoundError");
    }),
  );

  it.effect("on a run from another repo", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      const other: RunId = { repo: "someone/else", issue: "10", attempt: 1 };
      const error = yield* Effect.flip(advance(interruptible(rig.ctx), other));
      assert.strictEqual(error._tag, "WrongRepoError");
      assert.strictEqual(error.message, "run someone__else__10__1 is not a run of rawphp/softfac");
      assert.deepStrictEqual(rig.gh, []);
      assert.deepStrictEqual(rig.t3, []);
    }),
  );

  it.effect("compares the repo case-insensitively", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      setStatus(rig, "running", null);
      const outcome = yield* advance(
        interruptible({ ...rig.ctx, repo: "RawPHP/SoftFac" }),
        rig.run,
      );
      assert.deepStrictEqual(outcome, { kind: "running" });
    }),
  );
});

describe("advance: the result-line reminder", () => {
  it.effect("is sent once, as one fixed message, to a run that ended with no result line", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      setEnded(rig, 1, WORKING_MESSAGE);
      assert.deepStrictEqual(yield* advanceIn(rig), { kind: "reminded" });
      assert.deepStrictEqual(rig.t3, ["status thread-1", remindCall()]);
      // Nothing on GitHub: the issue is still building and still ours.
      assert.deepStrictEqual(rig.gh, []);
      assert.deepStrictEqual(linesOf(rig), [...STARTED, ...REMINDED_STEPS]);
      assert.deepStrictEqual(
        readRun(rig.dataDir, rig.run)
          .entries.slice(STARTED.length)
          .map((e) => e.cause?.reason),
        ["result-line-reminding", "result-line-reminded"],
      );
    }),
  );

  it.effect("writes the wait marker before the send and the step after it", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      setEnded(rig, 1, WORKING_MESSAGE);
      rig.world.sendFailure = { error: sessionsFailure("send"), delivered: false };
      assert.strictEqual((yield* Effect.flip(advanceIn(rig)))._tag, "FactorySessionsError");
      assert.deepStrictEqual(linesOf(rig), [...STARTED, reminding(1)]);
    }),
  );

  it.effect("is not sent again while the session works on it", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      setEnded(rig, 1, WORKING_MESSAGE);
      assert.deepStrictEqual(yield* advanceIn(rig), { kind: "reminded" });
      const bytes = bytesOf(rig);
      // T3 has not started the run yet, then it is running.
      assert.deepStrictEqual(yield* advanceIn(rig), { kind: "running" });
      setStatus(rig, "running", "working", { runOrdinal: 2 });
      assert.deepStrictEqual(yield* advanceIn(rig), { kind: "running" });
      assert.deepStrictEqual(sends(rig), [remindCall()]);
      assert.strictEqual(bytesOf(rig), bytes);
    }),
  );

  it.effect("is not sent for a run that is still active", () =>
    Effect.gen(function* () {
      const actives: ReadonlyArray<RunStatus | null> = [
        "preparing",
        "queued",
        "starting",
        "running",
        "waiting",
        null,
      ];
      for (const run of actives) {
        const rig = rigFor();
        setStatus(rig, run, WORKING_MESSAGE);
        assert.deepStrictEqual(yield* advanceIn(rig), { kind: "running" }, String(run));
        assert.deepStrictEqual(sends(rig), [], String(run));
        assert.deepStrictEqual(linesOf(rig), [...STARTED], String(run));
      }
    }),
  );

  it.effect("is followed by a newer run that ends with done, which goes to the gate", () =>
    Effect.gen(function* () {
      const rig = yield* remindedRun(WORKING_MESSAGE, `Done.\nFACTORY-DONE: ${URL12}`);
      assert.strictEqual((yield* advanceIn(rig)).kind, "ready-for-gate");
      assert.deepStrictEqual(sends(rig), []);
      assert.strictEqual(rig.world.issue.state, "building");
      assert.deepStrictEqual(linesOf(rig).at(-1), PR_OPENED);
      assert.deepStrictEqual(rig.world.archived, []);
    }),
  );

  it.effect("is followed by a newer run that ends with questions, which posts them", () =>
    Effect.gen(function* () {
      const rig = yield* remindedRun(WORKING_MESSAGE, `${QUESTIONS}\nFACTORY-STOP: needs-info`);
      assert.deepStrictEqual(yield* advanceIn(rig), { kind: "needs-info" });
      assert.strictEqual(rig.world.issue.state, "needs-info");
      assert.deepStrictEqual(rig.gh, needsInfoCalls(QUESTIONS));
      assert.deepStrictEqual(sends(rig), []);
    }),
  );

  it.effect(
    "is followed by a second run with no result line, which goes stuck, with no second reminder",
    () =>
      Effect.gen(function* () {
        const rig = yield* remindedRun(WORKING_MESSAGE, "Still working.");
        assertStuck(rig, yield* advanceIn(rig), {
          publicReason: NO_RESULT_LINE,
          text: "Still working.",
          extra: REMINDED_STEPS,
        });
        assert.deepStrictEqual(sends(rig), []);
        assert.strictEqual(rig.world.delivered.size, 1);
      }),
  );

  it.effect("waits for the second run in the exact live sequence and releases nothing", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      setEnded(rig, 1, WORKING_MESSAGE);
      assert.deepStrictEqual(yield* advanceIn(rig), { kind: "reminded" });
      // The session wakes up and finishes: running, then ended with the result line.
      setStatus(rig, "running", "working", { runOrdinal: 2 });
      assert.deepStrictEqual(yield* advanceIn(rig), { kind: "running" });
      setEnded(rig, 2, `Opened it.\nFACTORY-DONE: ${URL12}`);
      assert.strictEqual((yield* advanceIn(rig)).kind, "ready-for-gate");
      assert.strictEqual(rig.world.issue.state, "building");
      assert.deepStrictEqual(rig.world.issue.assignees, ["rawphp"]);
      assert.deepStrictEqual(
        rig.gh.filter((call) => call.startsWith("comment")),
        [],
      );
      assert.ok(!rig.t3.some((call) => call.startsWith("archive")), rig.t3.join("\n"));
      assert.ok(!linesOf(rig).some((line) => line.event === "stuck"));
    }),
  );

  it.effect("treats a missing message like one with no result line", () =>
    Effect.gen(function* () {
      for (const message of [null, "", "   \n"]) {
        const rig = rigFor();
        setEnded(rig, 1, message);
        assert.deepStrictEqual(yield* advanceIn(rig), { kind: "reminded" });
        assert.deepStrictEqual(sends(rig), [remindCall()]);
      }
    }),
  );

  it.effect("is not sent for a result line that is present but unusable", () =>
    Effect.gen(function* () {
      for (const message of [
        "FACTORY-DONE: nonsense",
        "FACTORY-DONE: https://github.com/someone/else/pull/3",
        "FACTORY-STOP: needs-info",
      ]) {
        const rig = rigFor();
        setEnded(rig, 1, message);
        assert.strictEqual((yield* advanceIn(rig)).kind, "stuck", message);
        assert.deepStrictEqual(sends(rig), [], message);
      }
    }),
  );

  it.effect("is not sent for a run that ended badly", () =>
    Effect.gen(function* () {
      for (const status of ["failed", "cancelled", "rolled_back"] as const) {
        const rig = rigFor();
        setStatus(rig, status, WORKING_MESSAGE);
        assert.strictEqual(
          (yield* advanceIn(rig)).kind,
          status === "rolled_back" ? "stuck" : "ended-badly",
          status,
        );
        assert.deepStrictEqual(sends(rig), [], status);
      }
    }),
  );

  it.effect("cut short before its send is sent on the next call, under one reminding step", () =>
    Effect.gen(function* () {
      const rig = rigFor([...STARTED, reminding(1)]);
      setEnded(rig, 1, WORKING_MESSAGE);
      assert.deepStrictEqual(yield* advanceIn(rig), { kind: "reminded" });
      assert.deepStrictEqual(sends(rig), [remindCall()]);
      assert.deepStrictEqual(linesOf(rig), [...STARTED, ...REMINDED_STEPS]);
    }),
  );

  it.effect("whose step is missing is not sent again when the session answered it", () =>
    Effect.gen(function* () {
      const rig = rigFor([...STARTED, reminding(1)]);
      setEnded(rig, 2, `Done.\nFACTORY-DONE: ${URL12}`);
      assert.strictEqual((yield* advanceIn(rig)).kind, "ready-for-gate");
      assert.deepStrictEqual(sends(rig), []);
      // The send is taken to have arrived, and the step is made good.
      assert.deepStrictEqual(linesOf(rig), [...STARTED, ...REMINDED_STEPS, PR_OPENED]);
    }),
  );

  it.effect("sent again after a crash between the send and its step uses the same command id", () =>
    Effect.gen(function* () {
      for (const delivered of [false, true]) {
        const rig = rigFor();
        setEnded(rig, 1, WORKING_MESSAGE);
        rig.world.sendFailure = { error: sessionsFailure("send"), delivered };
        yield* Effect.flip(advanceIn(rig));
        assert.deepStrictEqual(yield* advanceIn(rig), { kind: "reminded" });
        const ids = sends(rig).map((call) => call.split(" ")[2]);
        assert.strictEqual(ids.length, 2, `delivered ${delivered}`);
        assert.strictEqual(ids[0], ids[1], `delivered ${delivered}`);
        assert.strictEqual(rig.world.delivered.size, 1, `delivered ${delivered}`);
        assert.deepStrictEqual(
          linesOf(rig),
          [...STARTED, ...REMINDED_STEPS],
          `delivered ${delivered}`,
        );
      }
    }),
  );

  it.effect("is not owed to a run with no ordinal and no result line, which is stuck at once", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      setStatus(rig, "completed", WORKING_MESSAGE, { runOrdinal: null });
      assert.strictEqual((yield* advanceIn(rig)).kind, "stuck");
      assert.deepStrictEqual(sends(rig), []);
      assert.ok(
        !linesOf(rig).some(
          (line) =>
            JSON.stringify(line) ===
            JSON.stringify({ event: "step_changed", data: { step: "result-line-reminded" } }),
        ),
      );
    }),
  );

  it.effect("with a lost step and a newer run that has no line goes stuck and does not hang", () =>
    Effect.gen(function* () {
      const rig = rigFor([...STARTED, reminding(1)]);
      setEnded(rig, 2, "Nothing yet.");
      assert.strictEqual((yield* advanceIn(rig)).kind, "stuck");
      assert.deepStrictEqual(sends(rig), []);
    }),
  );

  const refusal = () =>
    new MessageRejectedError({
      threadId: "thread-1",
      commandId: "softfac:rawphp__softfac__10__1:remind:1",
      cause: "no",
    });

  /** A refused reminder is final: T3 keeps its refusal under the command id, so the run goes stuck at once. */
  const assertRefusedReminderIsStuck = (rig: Rig, outcome: AdvanceOutcome) =>
    Effect.gen(function* () {
      const recorded = `${NO_RESULT_LINE}; T3 refused the reminder: ${refusal().message}\n\n${WORKING_MESSAGE}`;
      assert.deepStrictEqual(outcome, { kind: "stuck", reason: recorded });
      assert.deepStrictEqual(rig.gh, stuckCalls(NO_RESULT_LINE, WORKING_MESSAGE));
      assert.deepStrictEqual(linesOf(rig), stuckEvents([reminding(1)], recorded));
      assert.deepStrictEqual(rig.world.archived, ["thread-1"]);
      assert.strictEqual(stuckCauses(rig)[0], "advance session-stuck");
      // The run is finished: a second call sends nothing.
      clearCalls(rig);
      assert.strictEqual((yield* Effect.flip(advanceIn(rig)))._tag, "NotBuildingError");
      assert.deepStrictEqual(sends(rig), []);
    });

  it.effect("goes stuck at once, with the marker written, when T3 refuses the message", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      setEnded(rig, 1, WORKING_MESSAGE);
      rig.world.sendFailure = { error: refusal(), delivered: false };
      const outcome = yield* advanceIn(rig);
      yield* assertRefusedReminderIsStuck(rig, outcome);
    }),
  );

  it.effect("goes stuck at once when T3 refuses the message of a reminder cut short", () =>
    Effect.gen(function* () {
      const rig = rigFor([...STARTED, reminding(1)]);
      setEnded(rig, 1, WORKING_MESSAGE);
      rig.world.sendFailure = { error: refusal(), delivered: false };
      const outcome = yield* advanceIn(rig);
      yield* assertRefusedReminderIsStuck(rig, outcome);
    }),
  );

  it.effect("goes stuck as thread-gone when T3 no longer has the thread at the send", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      setEnded(rig, 1, WORKING_MESSAGE);
      rig.world.sendFailure = {
        error: new ThreadNotFoundError({ threadId: "thread-1" }),
        delivered: false,
      };
      const outcome = yield* advanceIn(rig);
      assert.deepStrictEqual(outcome, { kind: "stuck", reason: THREAD_GONE });
      assert.strictEqual(stuckCauses(rig)[0], "advance thread-gone");
    }),
  );
});

const CHANGED_DURING_BUILD =
  "the issue text was changed during the build by someone who is not an instructor";
const CANNOT_VERIFY_DURING_BUILD =
  "the factory could not verify who changed the issue text during the build";
const CANNOT_CONFIRM = "the factory could not confirm the issue text was approved";
const TEXT_READ = `textCheck 10 ${LABELED} rawphp`;
/** What a stop that does not read the session does in T3: archive the thread, then remove its worktree. */
const ARCHIVE_CALLS = ["archive thread-1", "thread thread-1", "removeWorktree /t3/wt"];

const approvedLine = (at: string): RunEvent => step(`approved ${at}`);

describe("watch", () => {
  it.effect("leaves a run alone when the text is unchanged since the approval", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      const bytes = bytesOf(rig);
      assert.deepStrictEqual(yield* watch(rig.ctx, rig.run), { kind: "unchanged" });
      // One read, since the moment the run's first line records, with the project's instructors.
      assert.deepStrictEqual(rig.gh, [TEXT_READ]);
      assert.deepStrictEqual(rig.t3, []);
      assert.strictEqual(bytesOf(rig), bytes);
      // And again: the same read each pass, never a step that says it passed.
      assert.deepStrictEqual(yield* watch(rig.ctx, rig.run), { kind: "unchanged" });
      assert.deepStrictEqual(rig.gh, [TEXT_READ, TEXT_READ]);
      assert.strictEqual(bytesOf(rig), bytes);
    }),
  );

  it.effect("checks since the approval the ledger records", () =>
    Effect.gen(function* () {
      const rig = rigFor([approvedLine("2026-10-04T12:34:56Z"), ...STARTED.slice(1)]);
      assert.deepStrictEqual(yield* watch(rig.ctx, rig.run), { kind: "unchanged" });
      assert.deepStrictEqual(rig.gh, ["textCheck 10 2026-10-04T12:34:56Z rawphp"]);
    }),
  );

  it.effect("stops a run whose text someone else changed", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      rig.world.textCheck = "changed";
      assert.deepStrictEqual(yield* watch(rig.ctx, rig.run), {
        kind: "stopped",
        reason: CHANGED_DURING_BUILD,
      });
      assert.deepStrictEqual(rig.gh, [TEXT_READ, ...stuckCalls(CHANGED_DURING_BUILD)]);
      assert.deepStrictEqual(rig.t3, ["thread thread-1", ...ARCHIVE_CALLS]);
      assert.deepStrictEqual(linesOf(rig), stuckEvents([], CHANGED_DURING_BUILD));
      assert.deepStrictEqual(stuckCauses(rig), Array(3).fill("watch text-changed-during-build"));
      assert.strictEqual(rig.world.issue.state, "stuck");
      assert.deepStrictEqual(rig.world.issue.assignees, []);
    }),
  );

  it.effect("stops a run whose history cannot be judged, without blaming anyone", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      rig.world.textCheck = "unjudged";
      assert.deepStrictEqual(yield* watch(rig.ctx, rig.run), {
        kind: "stopped",
        reason: CANNOT_VERIFY_DURING_BUILD,
      });
      assert.deepStrictEqual(rig.gh, [TEXT_READ, ...stuckCalls(CANNOT_VERIFY_DURING_BUILD)]);
      assert.deepStrictEqual(rig.t3, ["thread thread-1", ...ARCHIVE_CALLS]);
      assert.deepStrictEqual(linesOf(rig), stuckEvents([], CANNOT_VERIFY_DURING_BUILD));
      assert.deepStrictEqual(stuckCauses(rig), Array(3).fill("watch edits-unverifiable"));
    }),
  );

  it.effect("finishes a stopped run, and nothing polls it again", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      rig.world.textCheck = "changed";
      yield* watch(rig.ctx, rig.run);
      clearCalls(rig);
      assert.deepStrictEqual(yield* watch(rig.ctx, rig.run), { kind: "skipped", why: "finished" });
      assert.strictEqual((yield* Effect.flip(advanceIn(rig)))._tag, "NotBuildingError");
      assert.deepStrictEqual(rig.gh, []);
      assert.deepStrictEqual(rig.t3, []);
    }),
  );

  it.effect("leaves the draft pull request open and does not mark it ready", () =>
    Effect.gen(function* () {
      const rig = rigFor([...STARTED, PR_OPENED]);
      rig.world.textCheck = "changed";
      assert.strictEqual((yield* watch(rig.ctx, rig.run)).kind, "stopped");
      assert.ok(
        !rig.gh.some((call) => call.startsWith("pullRequest") || call.startsWith("markPrDraft")),
        rig.gh.join("\n"),
      );
      // The status comment still names the pull request the run reported.
      assert.ok(rig.gh.at(-1)!.endsWith(statusText("stuck", "#12")), rig.gh.at(-1));
    }),
  );

  it.effect("does nothing for a run that is finished, has no session or is not building", () =>
    Effect.gen(function* () {
      const questions: RunEvent = { event: "questions_posted", data: { questions: "1. Which?" } };
      const stuck: RunEvent = { event: "stuck", data: { reason: "gave up" } };
      const cases: ReadonlyArray<
        [string, ReadonlyArray<RunEvent>, "finished" | "no-session" | "not-building"]
      > = [
        ["finished", [...STARTED, FINISHED_EVENT], "finished"],
        [
          "no session",
          [STARTED[0]!, STARTED[1]!, moved("ready", "triage"), moved("triage", "building")],
          "no-session",
        ],
        ["triage", STARTED.slice(0, 5), "not-building"],
        ["needs-info", [...STARTED, questions, moved("building", "needs-info")], "not-building"],
        ["stuck", [...STARTED, stuck, moved("building", "stuck")], "not-building"],
        // The decision is in the ledger and `state_changed` is not: `advance` finishes it.
        ["half stuck", [...STARTED, stuck], "not-building"],
        ["half needs-info", [...STARTED, questions], "not-building"],
      ];
      for (const [name, events, why] of cases) {
        const rig = rigFor(events);
        rig.world.textCheck = "changed";
        const bytes = bytesOf(rig);
        assert.deepStrictEqual(yield* watch(rig.ctx, rig.run), { kind: "skipped", why }, name);
        assert.deepStrictEqual(rig.gh, [], name);
        assert.deepStrictEqual(rig.t3, [], name);
        assert.strictEqual(bytesOf(rig), bytes, name);
      }
    }),
  );

  it.effect("refuses a run of another repo before touching anything", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      const other: RunId = { repo: "rawphp/other", issue: "10", attempt: 1 };
      const error = yield* Effect.flip(watch(rig.ctx, other));
      assert.strictEqual(error._tag, "WrongRepoError");
      assert.deepStrictEqual(rig.gh, []);
      assert.deepStrictEqual(rig.t3, []);
    }),
  );

  it.effect("is an error, never a stop or a pass, when the text cannot be read", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      rig.world.textCheck = "changed";
      rig.world.failNext.textCheck = ghFailure();
      const bytes = bytesOf(rig);
      assert.strictEqual((yield* Effect.flip(watch(rig.ctx, rig.run)))._tag, "GitHubFailed");
      assert.deepStrictEqual(rig.gh, [TEXT_READ]);
      assert.deepStrictEqual(rig.t3, [], "nothing archived");
      assert.strictEqual(bytesOf(rig), bytes, "nothing written");
      assert.strictEqual(rig.world.issue.state, "building");
      // The next pass reads again and, the text being changed, stops the run.
      assert.strictEqual((yield* watch(rig.ctx, rig.run)).kind, "stopped");
    }),
  );

  it.effect(
    "is an error with nothing written when the archive fails, and the next pass retries",
    () =>
      Effect.gen(function* () {
        const rig = rigFor();
        rig.world.textCheck = "changed";
        rig.world.archiveFails = sessionsFailure("archive");
        const bytes = bytesOf(rig);
        for (const pass of [1, 2]) {
          const error = yield* Effect.flip(watch(rig.ctx, rig.run));
          assert.strictEqual(error._tag, "FactorySessionsError");
          assert.strictEqual(bytesOf(rig), bytes, `pass ${pass}`);
          assert.strictEqual(rig.world.issue.state, "building");
          // Only the read: no comment, no label, no release.
          assert.strictEqual(rig.gh.length, pass, rig.gh.join("\n"));
        }
        rig.world.archiveFails = null;
        assert.strictEqual((yield* watch(rig.ctx, rig.run)).kind, "stopped");
        assert.deepStrictEqual(rig.world.archived, ["thread-1"]);
        assert.deepStrictEqual(linesOf(rig), stuckEvents([], CHANGED_DURING_BUILD));
      }),
  );

  it.effect("does not let a thread T3 no longer knows stop the stop", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      rig.world.textCheck = "changed";
      rig.world.thread = new ThreadNotFoundError({ threadId: "thread-1" });
      assert.strictEqual((yield* watch(rig.ctx, rig.run)).kind, "stopped");
      assert.strictEqual(rig.world.issue.state, "stuck");
      // The worktree is removed from the path the launch recorded.
      assert.deepStrictEqual(linesOf(rig), stuckEvents([], CHANGED_DURING_BUILD));
    }),
  );

  it.effect("fails closed for a run with no approval step", () =>
    Effect.gen(function* () {
      const rig = rigFor(STARTED.slice(1));
      assert.deepStrictEqual(yield* watch(rig.ctx, rig.run), {
        kind: "stopped",
        reason: CANNOT_CONFIRM,
      });
      // No read: there is no moment to read since. The archive, then the stuck path.
      assert.deepStrictEqual(rig.gh, stuckCalls(CANNOT_CONFIRM));
      assert.deepStrictEqual(rig.t3, ["thread thread-1", ...ARCHIVE_CALLS]);
      assert.deepStrictEqual(linesOf(rig), [
        ...STARTED.slice(1),
        worktreeRemoved,
        ...stuckTail(CANNOT_CONFIRM),
      ]);
      assert.deepStrictEqual(stuckCauses(rig), Array(3).fill("watch approval-unconfirmed"));
    }),
  );

  it.effect(
    "is an error with nothing written for a run with no approval step and a failing archive",
    () =>
      Effect.gen(function* () {
        const rig = rigFor(STARTED.slice(1));
        rig.world.archiveFails = sessionsFailure("archive");
        const bytes = bytesOf(rig);
        assert.strictEqual(
          (yield* Effect.flip(watch(rig.ctx, rig.run)))._tag,
          "FactorySessionsError",
        );
        assert.deepStrictEqual(rig.gh, []);
        assert.strictEqual(bytesOf(rig), bytes);
      }),
  );
});

const TIME_LIMIT = "the run passed its time limit";
const LIMIT_MS = 90 * MINUTE;

/** The started run, claimed at `T0` and building one minute later. */
const startedAtT0 = (index: number) => (index === STARTED.length - 1 ? T0 + MINUTE : T0);

/** The comment a time-limit stop posts, with the line that says where the work is. */
const limitComment = (workLine?: string) => {
  const work = workLine === undefined ? "" : `${workLine}\n\n`;
  return `The factory could not finish this issue and has released it.\n\nReason: ${TIME_LIMIT}\n\n${work}Fix the cause, then set the label back to \`factory:ready\`.`;
};

/** The lines of a time-limit stop `elapsed` ms after the run began, with the branch the stop recorded. */
const limitEvents = (elapsed: number, branch?: string): Array<Line> => [
  ...STARTED,
  worktreeRemoved,
  { event: "stuck", data: { reason: TIME_LIMIT, ...(branch !== undefined && { branch }) } },
  moved("building", "stuck"),
  { event: "finished", data: { ...(FINISHED("stuck").data as object), total_ms: elapsed } },
];

/** A started run that is past its limit and stopped by `timeLimit`; returns the elapsed time. */
const stopAtTheLimit = (rig: Rig) =>
  Effect.gen(function* () {
    const elapsed = LIMIT_MS + 1;
    rig.clock.now = T0 + elapsed;
    const outcome = yield* timeLimit(rig.ctx, rig.run);
    assert.deepStrictEqual(outcome, { kind: "stopped", reason: TIME_LIMIT });
    return elapsed;
  });

const limitedRig = () => rigFor(STARTED, { ms: startedAtT0 });

describe("timeLimit", () => {
  it.effect("is within the limit up to and including the last millisecond of it", () =>
    Effect.gen(function* () {
      const rig = limitedRig();
      const bytes = bytesOf(rig);
      rig.clock.now = T0 + 1;
      assert.deepStrictEqual(yield* timeLimit(rig.ctx, rig.run), { kind: "within" });
      rig.clock.now = T0 + LIMIT_MS;
      assert.deepStrictEqual(yield* timeLimit(rig.ctx, rig.run), { kind: "within" });
      assert.deepStrictEqual(rig.gh, []);
      assert.deepStrictEqual(rig.t3, []);
      assert.strictEqual(bytesOf(rig), bytes);
    }),
  );

  it.effect("stops a run past its limit and names the branch without a count of commits", () =>
    Effect.gen(function* () {
      const rig = limitedRig();
      const elapsed = yield* stopAtTheLimit(rig);
      assert.deepStrictEqual(linesOf(rig), limitEvents(elapsed, "t3code/abc"));
      assert.deepStrictEqual(rig.gh, [
        `comment 10 ${limitComment("The work so far is on branch t3code/abc.")}`,
        "setState 10 stuck",
        "unassign 10 rawphp",
        `status 10 rawphp ${statusText("stuck")}`,
      ]);
      // The branch is read before the archive, then the archive and the worktree as for any stop.
      assert.deepStrictEqual(rig.t3, ["thread thread-1", ...ARCHIVE_CALLS]);
      assert.deepStrictEqual(stuckCauses(rig), Array(3).fill("pass time-limit"));
    }),
  );

  it.effect("says how long the run worked and how recently a busy session was active", () =>
    Effect.gen(function* () {
      const rig = limitedRig();
      const stopAt = T0 + LIMIT_MS + 1;
      // Three and a half minutes: whole minutes, rounded down.
      rig.world.lastActivity = stopAt - 3.5 * MINUTE;
      rig.clock.now = stopAt;
      const reason = `${TIME_LIMIT} (90 min worked; last session activity 3 min before the stop)`;
      assert.deepStrictEqual(yield* timeLimit(rig.ctx, rig.run), { kind: "stopped", reason });
      assert.deepStrictEqual(
        linesOf(rig).find((line) => line.event === "stuck"),
        { event: "stuck", data: { reason, branch: "t3code/abc" } },
      );
      assert.include(rig.gh[0]!, `Reason: ${reason}\n`);
    }),
  );

  it.effect("says the session looked idle when it did nothing for more than 15 minutes", () =>
    Effect.gen(function* () {
      const rig = limitedRig();
      const stopAt = T0 + LIMIT_MS + 1;
      rig.world.lastActivity = stopAt - 15 * MINUTE - 1;
      rig.clock.now = stopAt;
      const reason = `${TIME_LIMIT} (90 min worked; last session activity 15 min before the stop: the session looked idle)`;
      assert.deepStrictEqual(yield* timeLimit(rig.ctx, rig.run), { kind: "stopped", reason });
      assert.include(rig.gh[0]!, `Reason: ${reason}\n`);
    }),
  );

  it.effect("does not call a session idle that was active 15 minutes before the stop", () =>
    Effect.gen(function* () {
      const rig = limitedRig();
      const stopAt = T0 + LIMIT_MS + 1;
      rig.world.lastActivity = stopAt - 15 * MINUTE;
      rig.clock.now = stopAt;
      assert.deepStrictEqual(yield* timeLimit(rig.ctx, rig.run), {
        kind: "stopped",
        reason: `${TIME_LIMIT} (90 min worked; last session activity 15 min before the stop)`,
      });
    }),
  );

  it.effect("stops a run with no session thread with the plain reason", () =>
    Effect.gen(function* () {
      const triage = [STARTED[0]!, STARTED[1]!, moved("ready", "triage")];
      const rig = rigFor(triage);
      // A read would put minutes in the reason: none is made without a thread.
      rig.world.lastActivity = T0;
      rig.clock.now = T0 + LIMIT_MS + 1;
      assert.deepStrictEqual(yield* timeLimit(rig.ctx, rig.run), {
        kind: "stopped",
        reason: TIME_LIMIT,
      });
      assert.deepStrictEqual(
        linesOf(rig).find((line) => line.event === "stuck"),
        { event: "stuck", data: { reason: TIME_LIMIT } },
      );
      assert.deepStrictEqual(rig.t3, []);
    }),
  );

  it.effect("stops with the plain reason when the thread is already archived", () =>
    Effect.gen(function* () {
      // A stop retried after its archive: the session ended at the first try, not at this one.
      const rig = limitedRig();
      rig.world.thread = { worktreePath: "/t3/wt", branch: "t3code/abc", archived: true };
      rig.world.lastActivity = T0 + LIMIT_MS;
      const elapsed = yield* stopAtTheLimit(rig);
      assert.deepStrictEqual(linesOf(rig), limitEvents(elapsed, "t3code/abc"));
    }),
  );

  it.effect("reads the last activity at the stop time even when T3 records it later", () =>
    Effect.gen(function* () {
      const rig = limitedRig();
      const stopAt = T0 + LIMIT_MS + 1;
      // T3's clock runs two minutes ahead of the runner's.
      rig.world.lastActivity = stopAt + 2 * MINUTE;
      rig.clock.now = stopAt;
      assert.deepStrictEqual(yield* timeLimit(rig.ctx, rig.run), {
        kind: "stopped",
        reason: `${TIME_LIMIT} (90 min worked; last session activity 0 min before the stop)`,
      });
    }),
  );

  it.effect("stops with the plain reason when T3 cannot say when the session was last active", () =>
    Effect.gen(function* () {
      const rig = limitedRig();
      rig.world.lastActivity = sessionsFailure("last-activity");
      const elapsed = yield* stopAtTheLimit(rig);
      assert.deepStrictEqual(linesOf(rig), limitEvents(elapsed, "t3code/abc"));
    }),
  );

  it.effect(
    "stops a run past its limit whose thread has no branch as it would without the work",
    () =>
      Effect.gen(function* () {
        const rig = limitedRig();
        rig.world.thread = { worktreePath: "/t3/wt", branch: null, archived: false };
        const elapsed = yield* stopAtTheLimit(rig);
        assert.deepStrictEqual(linesOf(rig), limitEvents(elapsed));
        assert.deepStrictEqual(rig.gh[0], `comment 10 ${limitComment()}`);
        assert.strictEqual(rig.world.issue.state, "stuck");
      }),
  );

  it.effect(
    "stops a run past its limit whose thread cannot be read as it would without the work",
    () =>
      Effect.gen(function* () {
        const rig = limitedRig();
        // The first read of the thread is the branch; the stop path's own read goes through.
        rig.world.threadOnce = sessionsFailure();
        // A read of its activity would put minutes in the reason: none is made.
        rig.world.lastActivity = T0 + LIMIT_MS;
        const elapsed = yield* stopAtTheLimit(rig);
        assert.deepStrictEqual(linesOf(rig), limitEvents(elapsed));
        assert.deepStrictEqual(rig.gh[0], `comment 10 ${limitComment()}`);
        assert.deepStrictEqual(rig.t3, ["thread thread-1", ...ARCHIVE_CALLS]);
      }),
  );

  it.effect(
    "stops a run past its limit whose thread T3 no longer knows as it would without the work",
    () =>
      Effect.gen(function* () {
        const rig = limitedRig();
        rig.world.thread = new ThreadNotFoundError({ threadId: "thread-1" });
        const elapsed = yield* stopAtTheLimit(rig);
        assert.deepStrictEqual(linesOf(rig), limitEvents(elapsed));
      }),
  );

  it.effect(
    "is an error with nothing written when the archive fails, and the next call decides again",
    () =>
      Effect.gen(function* () {
        const rig = limitedRig();
        rig.clock.now = T0 + LIMIT_MS + 1;
        rig.world.archiveFails = sessionsFailure("archive");
        const bytes = bytesOf(rig);
        assert.strictEqual(
          (yield* Effect.flip(timeLimit(rig.ctx, rig.run)))._tag,
          "FactorySessionsError",
        );
        assert.strictEqual(bytesOf(rig), bytes);
        assert.deepStrictEqual(rig.gh, []);
        rig.world.archiveFails = null;
        assert.strictEqual((yield* timeLimit(rig.ctx, rig.run)).kind, "stopped");
      }),
  );

  it.effect(
    "skips a finished run, and a run that is waiting, stuck or in the middle of either",
    () =>
      Effect.gen(function* () {
        const questions: RunEvent = { event: "questions_posted", data: { questions: "1. Which?" } };
        const stuck: RunEvent = { event: "stuck", data: { reason: "gave up" } };
        const cases: ReadonlyArray<[string, ReadonlyArray<RunEvent>, "finished" | "not-running"]> =
          [
            ["finished", [...STARTED, FINISHED_EVENT], "finished"],
            ["needs-info", [...STARTED, questions, moved("building", "needs-info")], "not-running"],
            ["stuck", [...STARTED, stuck, moved("building", "stuck")], "not-running"],
            ["pr-open", [...STARTED, moved("building", "pr-open")], "not-running"],
            ["half stuck", [...STARTED, stuck], "not-running"],
            ["half needs-info", [...STARTED, questions], "not-running"],
          ];
        for (const [name, events, why] of cases) {
          const rig = rigFor(events);
          rig.clock.now = T0 + 10 * LIMIT_MS;
          const bytes = bytesOf(rig);
          assert.deepStrictEqual(
            yield* timeLimit(rig.ctx, rig.run),
            { kind: "skipped", why },
            name,
          );
          assert.deepStrictEqual(rig.gh, [], name);
          assert.deepStrictEqual(rig.t3, [], name);
          assert.strictEqual(bytesOf(rig), bytes, name);
        }
      }),
  );

  it.effect(
    "leaves a triage run whose launch was sent and not recorded to resume, which names its session",
    () =>
      Effect.gen(function* () {
        const sent = [STARTED[0]!, STARTED[1]!, moved("ready", "triage"), step("launch-sending")];
        const rig = rigFor(sent);
        rig.clock.now = T0 + 10 * LIMIT_MS;
        const bytes = bytesOf(rig);
        assert.deepStrictEqual(yield* timeLimit(rig.ctx, rig.run), {
          kind: "skipped",
          why: "launch-unrecorded",
        });
        assert.deepStrictEqual(rig.gh, []);
        assert.deepStrictEqual(rig.t3, []);
        assert.strictEqual(bytesOf(rig), bytes);
      }),
  );

  it.effect(
    "does not charge the wait for the gate once the session reported its pull request",
    () =>
      Effect.gen(function* () {
        const rig = rigFor([...STARTED, PR_OPENED], { ms: startedAtT0 });
        rig.clock.now = T0 + 10 * LIMIT_MS;
        const bytes = bytesOf(rig);
        assert.deepStrictEqual(yield* timeLimit(rig.ctx, rig.run), {
          kind: "skipped",
          why: "pr-reported",
        });
        assert.deepStrictEqual(rig.gh, []);
        assert.deepStrictEqual(rig.t3, []);
        assert.strictEqual(bytesOf(rig), bytes);
      }),
  );

  it.effect("does not charge the factory's gate to a run it sent back", () =>
    Effect.gen(function* () {
      const sentBack: RunEvent = { event: "gate_sent_back", data: { attempt: 1, run_ordinal: 1 } };
      const back = [...STARTED, PR_OPENED, sentBack];
      const at = [T0 + 20 * MINUTE, T0 + 90 * MINUTE];
      const rig = rigFor(back, {
        ms: (index) => (index < STARTED.length ? startedAtT0(index) : at[index - STARTED.length]!),
      });
      const bytes = bytesOf(rig);
      rig.clock.now = T0 + 100 * MINUTE;
      assert.deepStrictEqual(yield* timeLimit(rig.ctx, rig.run), { kind: "within" });
      assert.deepStrictEqual(rig.gh, []);
      assert.deepStrictEqual(rig.t3, []);
      assert.strictEqual(bytesOf(rig), bytes);
      rig.clock.now = T0 + 161 * MINUTE;
      assert.deepStrictEqual(yield* timeLimit(rig.ctx, rig.run), {
        kind: "stopped",
        reason: TIME_LIMIT,
      });
    }),
  );

  it.effect("limits a run again once it comes back to building from pr-open", () =>
    Effect.gen(function* () {
      const back = [
        ...STARTED,
        PR_OPENED,
        moved("building", "pr-open"),
        moved("pr-open", "building"),
      ];
      const rig = rigFor(back, {
        ms: (index) => (index === back.length - 1 ? T0 + 2 * MINUTE : T0),
      });
      rig.clock.now = T0 + 2 * MINUTE + LIMIT_MS + 1;
      assert.strictEqual((yield* timeLimit(rig.ctx, rig.run)).kind, "stopped");
    }),
  );

  it.effect("names a hostile branch in the comment and the ledger only as prepared text", () =>
    Effect.gen(function* () {
      const rig = limitedRig();
      rig.world.thread = {
        worktreePath: "/t3/wt",
        branch: "x@octocat<!-- softfac -->",
        archived: false,
      };
      const elapsed = yield* stopAtTheLimit(rig);
      const prepared = "x@\u200Boctocat<\u200B!-- softfac -->";
      assert.deepStrictEqual(linesOf(rig), limitEvents(elapsed, prepared));
      assert.deepStrictEqual(
        rig.gh[0],
        `comment 10 ${limitComment(`The work so far is on branch ${prepared}.`)}`,
      );
      assert.ok(!rig.gh[0]!.includes("@octocat"), rig.gh[0]);
      assert.ok(!rig.gh[0]!.includes("<!--"), rig.gh[0]);
    }),
  );

  it.effect("stops a run that never launched anything with the plain reason", () =>
    Effect.gen(function* () {
      const claimed = [STARTED[0]!, STARTED[1]!, moved("ready", "triage")];
      const rig = rigFor(claimed);
      rig.clock.now = T0 + LIMIT_MS + 1;
      assert.deepStrictEqual(yield* timeLimit(rig.ctx, rig.run), {
        kind: "stopped",
        reason: TIME_LIMIT,
      });
      assert.deepStrictEqual(rig.t3, []);
    }),
  );

  it.effect("refuses a run of another repo before touching anything", () =>
    Effect.gen(function* () {
      const rig = limitedRig();
      const other: RunId = { repo: "rawphp/other", issue: "10", attempt: 1 };
      const error = yield* Effect.flip(timeLimit(rig.ctx, other));
      assert.strictEqual(error._tag, "WrongRepoError");
      assert.deepStrictEqual(rig.gh, []);
      assert.deepStrictEqual(rig.t3, []);
    }),
  );
});

const HEAD_SHA = "4f1c2d3e4a5b60718293a4b5c6d7e8f901234567";
const STOPPED_BY_HAND = "stopped by hand";
const STOP_REQUESTED: RunEvent = { event: "stop_requested", data: { by: "operator" } };

const mergedPr = (): PullRequest => ({ ...defaultPr(), open: false, merged: true, isDraft: false });
const closedPr = (): PullRequest => ({ ...defaultPr(), open: false, merged: false });

const finishedPrEnd = (prEnd: "merged" | "closed"): Line => ({
  event: "finished",
  data: {
    outcome: "pr-open",
    total_ms: 0,
    gate_attempts: 0,
    review_cycles: null,
    pr_url: URL12,
    pr_end: prEnd,
  },
});

/** A run whose gate passed: the issue is `pr-open`, its session stopped, its worktree removed. */
const PR_OPEN_RUN: ReadonlyArray<RunEvent> = [
  ...STARTED,
  PR_OPENED,
  { event: "worktree_removed", data: { path: "/t3/wt" } },
  moved("building", "pr-open"),
];

/** A run whose gate recorded a pass for the pull request but did not finish the move to `pr-open`. */
const PASS_RECORDED: ReadonlyArray<RunEvent> = [
  ...STARTED,
  PR_OPENED,
  {
    event: "gate_command",
    data: { attempt: 1, command: "cargo test", exit_code: 0, duration_ms: 5 },
  },
  step(`gate-passed ${HEAD_SHA} 1`),
];

const causeOf = (rig: Rig) => {
  const cause = readRun(rig.dataDir, rig.run).entries.at(-1)?.cause;
  return { step: cause?.step, reason: cause?.reason, actor: cause?.actor };
};

const expectNotBuilding = (rig: Rig) =>
  Effect.gen(function* () {
    clearCalls(rig);
    const error = yield* Effect.flip(advanceIn(rig));
    assert.strictEqual(error._tag, "NotBuildingError");
    assert.deepStrictEqual(rig.gh, []);
    assert.deepStrictEqual(rig.reads, []);
    assert.deepStrictEqual(rig.t3, []);
  });

describe("advance: a merged or closed pull request ends the run", () => {
  it.effect("done with a merged pull request ends the run as merged", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      rig.world.pr = mergedPr();
      assert.deepStrictEqual(yield* advanceIn(rig), { kind: "ended" });
      // Only a read: nothing is posted, no label moves.
      assert.deepStrictEqual(rig.gh, ["pullRequest 12"]);
      assert.deepStrictEqual(rig.t3, STOP_CALLS);
      assert.deepStrictEqual(linesOf(rig), [
        ...STARTED,
        PR_OPENED,
        worktreeRemoved,
        finishedPrEnd("merged"),
      ]);
      assert.strictEqual(rig.world.issue.state, "building");
      assert.deepStrictEqual(lastCause(rig), { step: "advance", reason: "pull-request-ended" });
      yield* expectNotBuilding(rig);
    }),
  );

  it.effect("done with a pull request closed without a merge ends the run as closed", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      rig.world.pr = closedPr();
      assert.deepStrictEqual(yield* advanceIn(rig), { kind: "ended" });
      assert.deepStrictEqual(rig.gh, ["pullRequest 12"]);
      assert.deepStrictEqual(linesOf(rig).at(-1), finishedPrEnd("closed"));
      assert.deepStrictEqual(lastCause(rig), { step: "advance", reason: "pull-request-ended" });
      yield* expectNotBuilding(rig);
    }),
  );

  it.effect(
    "done with a merged pull request that a failed archive cannot stop writes nothing",
    () =>
      Effect.gen(function* () {
        const rig = rigFor();
        rig.world.pr = mergedPr();
        rig.world.archiveFails = sessionsFailure("archive");
        const error = yield* Effect.flip(advanceIn(rig));
        assert.strictEqual(error._tag, "FactorySessionsError");
        // The pull request is recorded; the end is not.
        assert.deepStrictEqual(linesOf(rig), [...STARTED, PR_OPENED]);
        rig.world.archiveFails = null;
        assert.deepStrictEqual(yield* advanceIn(rig), { kind: "ended" });
        assert.deepStrictEqual(linesOf(rig).at(-1), finishedPrEnd("merged"));
      }),
  );

  it.effect.each([
    { label: "merged", pull: mergedPr(), prEnd: "merged" },
    { label: "closed", pull: closedPr(), prEnd: "closed" },
    { label: "gone", pull: null, prEnd: "closed" },
  ] as const)("a pr-open run whose pull request is $label is ended as $prEnd", ({ pull, prEnd }) =>
    Effect.gen(function* () {
      const rig = rigFor(PR_OPEN_RUN);
      rig.world.pr = pull;
      assert.deepStrictEqual(yield* advanceIn(rig), { kind: "ended" });
      // The only read is the pull request; the issue is not read for a run with nothing to write.
      assert.deepStrictEqual(rig.gh, ["pullRequest 12"]);
      assert.deepStrictEqual(rig.reads, []);
      // The thread is archived again; its worktree line is not written twice.
      assert.deepStrictEqual(rig.t3, ["archive thread-1"]);
      assert.deepStrictEqual(linesOf(rig), [...PR_OPEN_RUN, finishedPrEnd(prEnd)]);
      assert.deepStrictEqual(lastCause(rig), { step: "advance", reason: "pull-request-ended" });
      yield* expectNotBuilding(rig);
    }),
  );

  it.effect("a pr-open run whose pull request is still open stays open and writes nothing", () =>
    Effect.gen(function* () {
      const rig = rigFor(PR_OPEN_RUN);
      rig.world.pr = { ...defaultPr(), isDraft: false };
      const bytes = bytesOf(rig);
      assert.deepStrictEqual(yield* advanceIn(rig), { kind: "passed", pr: 12 });
      assert.deepStrictEqual(rig.gh, ["pullRequest 12"]);
      assert.deepStrictEqual(rig.reads, []);
      assert.deepStrictEqual(rig.t3, []);
      assert.strictEqual(bytesOf(rig), bytes);
    }),
  );

  it.effect("a pr-open run whose pull request cannot be read is an error and stays open", () =>
    Effect.gen(function* () {
      const rig = rigFor(PR_OPEN_RUN);
      rig.world.failNext.pullRequest = ghFailure();
      const bytes = bytesOf(rig);
      assert.strictEqual((yield* Effect.flip(advanceIn(rig)))._tag, "GitHubFailed");
      assert.strictEqual(bytesOf(rig), bytes);
      assert.deepStrictEqual(rig.t3, []);
    }),
  );
});

describe("advance: a closed issue", () => {
  it.effect("ends the run in advance, writes nothing on GitHub and archives once", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      closeIssue(rig);
      assert.deepStrictEqual(yield* advanceIn(rig), { kind: "abandoned" });
      assert.deepStrictEqual(rig.gh, []);
      assert.deepStrictEqual(rig.reads, ["issue 10", "closedBy 10"]);
      // The session's status is never read; the thread is archived, then its worktree removed.
      assert.deepStrictEqual(rig.t3, ARCHIVE_CALLS);
      assert.deepStrictEqual(rig.world.archived, ["thread-1"]);
      // The worktree line is the second to last: the summary line comes after it.
      assert.deepStrictEqual(linesOf(rig), [...STARTED, worktreeRemoved, FINISHED("stuck")]);
      assert.deepStrictEqual(causeOf(rig), {
        step: "advance",
        reason: "issue-closed",
        actor: undefined,
      });
      yield* expectNotBuilding(rig);
    }),
  );

  it.effect("ends a run left in needs-info as a person's move, finished as needs-info", () =>
    Effect.gen(function* () {
      const rig = waitingInNeedsInfo();
      closeIssue(rig);
      assert.deepStrictEqual(yield* advanceIn(rig), { kind: "abandoned" });
      assert.deepStrictEqual(rig.gh, []);
      assert.deepStrictEqual(linesOf(rig), [
        ...STARTED,
        ...WAITING_LINES,
        worktreeRemoved,
        FINISHED("needs-info"),
      ]);
      assert.deepStrictEqual(causeOf(rig), {
        step: "advance",
        reason: "issue-closed",
        actor: undefined,
      });
    }),
  );

  it.effect("whose archive fails is an error with nothing written, and the next call retries", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      closeIssue(rig);
      rig.world.archiveFails = sessionsFailure("archive");
      const bytes = bytesOf(rig);
      assert.strictEqual((yield* Effect.flip(advanceIn(rig)))._tag, "FactorySessionsError");
      assert.strictEqual(bytesOf(rig), bytes);
      assert.deepStrictEqual(rig.gh, []);
      rig.world.archiveFails = null;
      assert.deepStrictEqual(yield* advanceIn(rig), { kind: "abandoned" });
      assert.deepStrictEqual(rig.world.archived, ["thread-1"]);
      assert.deepStrictEqual(linesOf(rig).at(-1), FINISHED("stuck"));
    }),
  );

  it.effect("on a thread T3 no longer has still ends the run, removing the ledger's worktree", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      closeIssue(rig);
      rig.world.thread = new ThreadNotFoundError({ threadId: "thread-1" });
      assert.deepStrictEqual(yield* advanceIn(rig), { kind: "abandoned" });
      assert.deepStrictEqual(rig.t3, ARCHIVE_CALLS);
      assert.deepStrictEqual(linesOf(rig), [...STARTED, worktreeRemoved, FINISHED("stuck")]);
    }),
  );

  it.effect("that cannot be read is an error and never an abandon", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      rig.world.failNext.issue = ghFailure();
      const bytes = bytesOf(rig);
      assert.strictEqual((yield* Effect.flip(advanceIn(rig)))._tag, "GitHubFailed");
      assert.strictEqual(bytesOf(rig), bytes);
      assert.deepStrictEqual(rig.t3, []);
      // The next call reads it, finds it open, and goes on.
      assert.strictEqual((yield* advanceIn(rig)).kind, "ready-for-gate");
    }),
  );

  it.effect("that is open is not touched by the check", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      assert.strictEqual((yield* advanceIn(rig)).kind, "ready-for-gate");
      assert.deepStrictEqual(rig.reads, ["issue 10"]);
      assert.deepStrictEqual(rig.gh, ["pullRequest 12"]);
      assert.deepStrictEqual(linesOf(rig), [...STARTED, PR_OPENED]);
    }),
  );

  it.effect("is not asked about by a step that would skip the run or has nothing to write", () =>
    Effect.gen(function* () {
      const finished = rigFor([...STARTED, FINISHED_EVENT]);
      closeIssue(finished);
      assert.strictEqual((yield* Effect.flip(advanceIn(finished)))._tag, "NotBuildingError");
      assert.deepStrictEqual(finished.reads, []);

      // `pr-open` and `stuck` runs have every write done.
      const open = rigFor(PR_OPEN_RUN);
      closeIssue(open);
      assert.deepStrictEqual(yield* advanceIn(open), { kind: "passed", pr: 12 });
      assert.deepStrictEqual(open.reads, []);

      const stuck = rigFor([
        ...STARTED,
        { event: "stuck", data: { reason: "gave up" } },
        moved("building", "stuck"),
      ]);
      closeIssue(stuck);
      assert.strictEqual((yield* advanceIn(stuck)).kind, "stuck");
      assert.deepStrictEqual(stuck.reads, []);
    }),
  );

  it.effect("ends the run with the person who closed it", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      closeIssue(rig, "alice");
      assert.deepStrictEqual(yield* advanceIn(rig), { kind: "abandoned" });
      assert.deepStrictEqual(causeOf(rig), {
        step: "advance",
        reason: "issue-closed",
        actor: "alice",
      });
    }),
  );

  it.effect("leaves the actor out when GitHub names none or cannot be asked", () =>
    Effect.gen(function* () {
      const nobody = rigFor();
      closeIssue(nobody, null);
      assert.deepStrictEqual(yield* advanceIn(nobody), { kind: "abandoned" });
      assert.strictEqual(causeOf(nobody).actor, undefined);

      const failing = rigFor();
      closeIssue(failing, ghFailure());
      assert.deepStrictEqual(yield* advanceIn(failing), { kind: "abandoned" });
      assert.deepStrictEqual(causeOf(failing), {
        step: "advance",
        reason: "issue-closed",
        actor: undefined,
      });
      assert.deepStrictEqual(linesOf(failing).at(-1), FINISHED("stuck"));
    }),
  );

  it.effect("closed by the run's own merged pull request, before a pass, is its own finish", () =>
    Effect.gen(function* () {
      const rig = rigFor([...STARTED, PR_OPENED]);
      closeIssue(rig, "alice");
      rig.world.pr = mergedPr();
      assert.deepStrictEqual(yield* advanceIn(rig), { kind: "ended" });
      assert.deepStrictEqual(rig.gh, ["pullRequest 12"]);
      // Nobody is asked who closed it: a merge is not a person's move.
      assert.deepStrictEqual(rig.reads, ["issue 10"]);
      assert.deepStrictEqual(rig.t3, ARCHIVE_CALLS);
      assert.deepStrictEqual(linesOf(rig), [
        ...STARTED,
        PR_OPENED,
        worktreeRemoved,
        finishedPrEnd("merged"),
      ]);
      assert.deepStrictEqual(lastCause(rig), { step: "advance", reason: "pull-request-ended" });
    }),
  );

  it.effect(
    "closed by a merged pull request the ledger holds under another number names its url",
    () =>
      Effect.gen(function* () {
        const rig = rigFor([
          ...STARTED,
          { event: "pr_opened", data: { pr: 14, url: "https://example.test/x/14" } },
          { event: "pr_opened", data: { pr: 13, url: "https://example.test/x/13" } },
        ]);
        closeIssue(rig);
        rig.world.pr = { ...mergedPr(), number: 14 };
        assert.deepStrictEqual(yield* advanceIn(rig), { kind: "ended" });
        assert.deepStrictEqual(rig.gh, ["pullRequest 14"]);
        assert.deepStrictEqual(
          (linesOf(rig).at(-1)?.data as { pr_url: string } | undefined)?.pr_url,
          "https://github.com/rawphp/softfac/pull/14",
        );
      }),
  );

  it.effect("closed by a merge after a recorded pass leaves the end to the gate", () =>
    Effect.gen(function* () {
      const rig = rigFor(PASS_RECORDED);
      closeIssue(rig);
      rig.world.pr = mergedPr();
      assert.deepStrictEqual(yield* advanceIn(rig), {
        kind: "ready-for-gate",
        pr: 12,
        prUrl: URL12,
      });
      assert.deepStrictEqual(rig.gh, ["pullRequest 12"]);
      assert.deepStrictEqual(rig.t3, []);
      assert.deepStrictEqual(linesOf(rig), [...PASS_RECORDED]);
    }),
  );

  it.effect("while its pull request is closed unmerged is abandoned", () =>
    Effect.gen(function* () {
      const rig = rigFor([...STARTED, PR_OPENED]);
      closeIssue(rig);
      rig.world.pr = closedPr();
      assert.deepStrictEqual(yield* advanceIn(rig), { kind: "abandoned" });
      assert.deepStrictEqual(rig.gh, ["pullRequest 12"]);
      assert.deepStrictEqual(linesOf(rig), [
        ...STARTED,
        PR_OPENED,
        worktreeRemoved,
        FINISHED("stuck"),
      ]);
    }),
  );

  it.effect("while its pull request cannot be read is an error, never an abandon", () =>
    Effect.gen(function* () {
      const rig = rigFor([...STARTED, PR_OPENED]);
      closeIssue(rig);
      rig.world.failNext.pullRequest = ghFailure();
      const bytes = bytesOf(rig);
      assert.strictEqual((yield* Effect.flip(advanceIn(rig)))._tag, "GitHubFailed");
      assert.strictEqual(bytesOf(rig), bytes);
      assert.deepStrictEqual(rig.t3, []);
    }),
  );
});

describe("advance: a run stopped by hand", () => {
  const stoppedLines = [{ event: "stop_requested", data: { by: "operator" } }] as const;

  it.effect("whose thread is gone finishes as stuck by hand", () =>
    Effect.gen(function* () {
      const rig = rigFor([...STARTED, STOP_REQUESTED]);
      rig.world.thread = new ThreadNotFoundError({ threadId: "thread-1" });
      assert.deepStrictEqual(yield* advanceIn(rig), { kind: "stuck", reason: STOPPED_BY_HAND });
      // The ledger's worktree path is used when T3 cannot name one.
      assert.deepStrictEqual(rig.t3, ["thread thread-1", ...ARCHIVE_CALLS]);
      assert.deepStrictEqual(rig.gh, stuckCalls(STOPPED_BY_HAND));
      assert.deepStrictEqual(linesOf(rig), stuckEvents(stoppedLines, STOPPED_BY_HAND));
      // Every line after the request, the worktree line aside, has the reason of the request.
      assert.deepStrictEqual(stuckCauses(rig), Array(3).fill("advance stop-requested"));
      assert.strictEqual(rig.world.issue.state, "stuck");
    }),
  );

  it.effect("whose thread is still there is archived and its worktree removed, status unread", () =>
    Effect.gen(function* () {
      const rig = rigFor([...STARTED, STOP_REQUESTED]);
      assert.deepStrictEqual(yield* advanceIn(rig), { kind: "stuck", reason: STOPPED_BY_HAND });
      // The thread is read for where its work is, never its status.
      assert.deepStrictEqual(rig.t3, ["thread thread-1", ...ARCHIVE_CALLS]);
      assert.ok(!rig.t3.includes("status thread-1"));
      assert.deepStrictEqual(rig.world.archived, ["thread-1"]);
      // The session is stopped before anything is written on the issue.
      assert.ok(
        rig.order.indexOf("t3:archive thread-1") <
          rig.order.findIndex((call) => call.startsWith("gh:comment")),
        rig.order.join("\n"),
      );
    }),
  );

  it.effect("with a failing archive writes nothing, and the next call archives again", () =>
    Effect.gen(function* () {
      const rig = rigFor([...STARTED, STOP_REQUESTED]);
      rig.world.archiveFails = sessionsFailure("archive");
      const bytes = bytesOf(rig);
      assert.strictEqual((yield* Effect.flip(advanceIn(rig)))._tag, "FactorySessionsError");
      assert.strictEqual(bytesOf(rig), bytes);
      assert.deepStrictEqual(rig.gh, []);
      rig.world.archiveFails = null;
      assert.deepStrictEqual(yield* advanceIn(rig), { kind: "stuck", reason: STOPPED_BY_HAND });
      assert.deepStrictEqual(rig.world.archived, ["thread-1"]);
    }),
  );

  it.effect("is never said to have ended badly", () =>
    Effect.gen(function* () {
      const rig = rigFor([...STARTED, STOP_REQUESTED]);
      setStatus(rig, "cancelled", "I was stopped");
      assert.deepStrictEqual(yield* advanceIn(rig), { kind: "stuck", reason: STOPPED_BY_HAND });
      assert.strictEqual(rig.t3[1], "archive thread-1");
      assert.deepStrictEqual(linesOf(rig), stuckEvents(stoppedLines, STOPPED_BY_HAND));
    }),
  );

  it.effect("is ended as a closed issue first when the issue was closed too", () =>
    Effect.gen(function* () {
      const rig = rigFor([...STARTED, STOP_REQUESTED]);
      closeIssue(rig);
      assert.deepStrictEqual(yield* advanceIn(rig), { kind: "abandoned" });
      assert.deepStrictEqual(rig.gh, []);
      assert.deepStrictEqual(causeOf(rig), {
        step: "advance",
        reason: "issue-closed",
        actor: undefined,
      });
    }),
  );
});

describe("advance: a stop line that is there though the run is no longer building", () => {
  it.effect("on a pr-open run reads the pull request as usual and never sticks the run", () =>
    Effect.gen(function* () {
      const rig = rigFor([...PR_OPEN_RUN, STOP_REQUESTED]);
      rig.world.pr = { ...defaultPr(), isDraft: false };
      const bytes = bytesOf(rig);
      assert.deepStrictEqual(yield* advanceIn(rig), { kind: "passed", pr: 12 });
      assert.deepStrictEqual(rig.gh, ["pullRequest 12"]);
      assert.deepStrictEqual(rig.t3, []);
      assert.strictEqual(bytesOf(rig), bytes);
    }),
  );

  it.effect("on a needs-info run ends it as needs-info", () =>
    Effect.gen(function* () {
      const rig = rigFor([
        ...STARTED,
        { event: "questions_posted", data: { questions: "Which one?" } },
        moved("building", "needs-info"),
        STOP_REQUESTED,
      ]);
      rig.world.issue = issueDetail("needs-info", []);
      setStatus(rig, "completed", "Which one?\nFACTORY-STOP: needs-info");
      assert.deepStrictEqual(yield* advanceIn(rig), { kind: "needs-info" });
      assert.deepStrictEqual(rig.gh, []);
      assert.deepStrictEqual(linesOf(rig).at(-1), FINISHED("needs-info"));
    }),
  );
});

describe("watch and timeLimit: the end of a run", () => {
  it.effect("watch leaves a stopped run to advance", () =>
    Effect.gen(function* () {
      const rig = rigFor([...STARTED, STOP_REQUESTED]);
      rig.world.textCheck = "changed";
      assert.deepStrictEqual(yield* watch(rig.ctx, rig.run), {
        kind: "skipped",
        why: "not-building",
      });
      assert.deepStrictEqual(rig.gh, []);
      assert.deepStrictEqual(rig.t3, []);
    }),
  );

  it.effect("watch skips a run whose own merged pull request closed the issue", () =>
    Effect.gen(function* () {
      const rig = rigFor([...STARTED, PR_OPENED]);
      rig.world.textCheck = "changed";
      closeIssue(rig);
      rig.world.pr = mergedPr();
      assert.deepStrictEqual(yield* watch(rig.ctx, rig.run), {
        kind: "skipped",
        why: "pr-merged",
      });
      assert.deepStrictEqual(rig.gh, [TEXT_READ, "pullRequest 12"]);
      assert.deepStrictEqual(rig.t3, []);
      assert.deepStrictEqual(linesOf(rig), [...STARTED, PR_OPENED]);
    }),
  );

  it.effect("watch goes on to stop a run whose issue a person closed", () =>
    Effect.gen(function* () {
      const rig = rigFor([...STARTED, PR_OPENED]);
      rig.world.textCheck = "changed";
      closeIssue(rig);
      rig.world.pr = closedPr();
      assert.strictEqual((yield* watch(rig.ctx, rig.run)).kind, "stopped");
      assert.strictEqual(rig.world.issue.state, "stuck");
    }),
  );

  it.effect("watch asks about the issue only for a run that reported a pull request", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      rig.world.textCheck = "changed";
      closeIssue(rig);
      assert.strictEqual((yield* watch(rig.ctx, rig.run)).kind, "stopped");
      // The stop looks for a pull request on the branch; the issue itself is not read.
      assert.deepStrictEqual(rig.reads, ["openPullRequestsOnHead t3code/abc"]);
    }),
  );

  it.effect("the time limit leaves a stopped run to advance", () =>
    Effect.gen(function* () {
      const rig = rigFor([...STARTED, STOP_REQUESTED], { ms: startedAtT0 });
      rig.clock.now = T0 + LIMIT_MS + 1;
      assert.deepStrictEqual(yield* timeLimit(rig.ctx, rig.run), {
        kind: "skipped",
        why: "not-running",
      });
      assert.deepStrictEqual(rig.gh, []);
      assert.deepStrictEqual(rig.t3, []);
    }),
  );

  const SENT_BACK: RunEvent = { event: "gate_sent_back", data: { attempt: 1, run_ordinal: 1 } };

  it.effect("the time limit skips a run past its limit whose own merge closed the issue", () =>
    Effect.gen(function* () {
      const rig = rigFor([...STARTED, PR_OPENED, SENT_BACK], { ms: startedAtT0 });
      closeIssue(rig);
      rig.world.pr = mergedPr();
      rig.clock.now = T0 + LIMIT_MS + 1;
      assert.deepStrictEqual(yield* timeLimit(rig.ctx, rig.run), {
        kind: "skipped",
        why: "pr-merged",
      });
      assert.deepStrictEqual(rig.gh, ["pullRequest 12"]);
      assert.deepStrictEqual(rig.t3, []);
    }),
  );

  it.effect("the time limit goes on to stop a run past its limit whose issue a person closed", () =>
    Effect.gen(function* () {
      const rig = rigFor([...STARTED, PR_OPENED, SENT_BACK], { ms: startedAtT0 });
      closeIssue(rig);
      rig.world.pr = closedPr();
      rig.clock.now = T0 + LIMIT_MS + 1;
      assert.strictEqual((yield* timeLimit(rig.ctx, rig.run)).kind, "stopped");
    }),
  );

  it.effect("the time limit asks about the issue only past the limit and with a pull request", () =>
    Effect.gen(function* () {
      const within = rigFor([...STARTED, PR_OPENED, SENT_BACK], { ms: startedAtT0 });
      closeIssue(within);
      within.clock.now = T0 + 1;
      assert.deepStrictEqual(yield* timeLimit(within.ctx, within.run), { kind: "within" });
      assert.deepStrictEqual(within.reads, []);

      const noPr = limitedRig();
      closeIssue(noPr);
      noPr.clock.now = T0 + LIMIT_MS + 1;
      assert.strictEqual((yield* timeLimit(noPr.ctx, noPr.run)).kind, "stopped");
      // The stop looks for a pull request on the branch; the issue itself is not read.
      assert.deepStrictEqual(noPr.reads, ["openPullRequestsOnHead t3code/abc"]);
    }),
  );
});

/** T3's refusal of the reminder, as the reminder tests build it. */
const reminderRefusal = () =>
  new MessageRejectedError({
    threadId: "thread-1",
    commandId: "softfac:rawphp__softfac__10__1:remind:1",
    cause: "no",
  });

/** An open draft by the factory on `head` into `main`, as GitHub lists it from the branch. */
const draftOn = (head: string, over: Partial<OpenPullRequest> = {}): OpenPullRequest => ({
  number: 12,
  url: URL12,
  headRef: head,
  baseRef: "main",
  crossRepository: false,
  author: "rawphp",
  ...over,
});

/** The started run of attempt 1 of issue 10, on `t3code/old`, which reported pull request #12. */
const FIRST_ATTEMPT: ReadonlyArray<RunEvent> = [
  ...STARTED.map((event) =>
    event.event === "session_launched"
      ? { event: "session_launched" as const, data: { ...event.data, branch: "t3code/old" } }
      : event,
  ),
  PR_OPENED,
];

describe("advance: an earlier attempt's pull request", () => {
  const run10n2: RunId = { ...run10, attempt: 2 };
  /** Attempt 2 of issue 10, started, after attempt 1 left the lines `first`. */
  const secondAttempt = (first: ReadonlyArray<RunEvent> = FIRST_ATTEMPT) => {
    const rig = rigFor(first);
    seed(rig.dataDir, run10n2, STARTED);
    const second: Rig = { ...rig, run: run10n2 };
    return second;
  };

  it.effect("is bound by the branch attempt 1 worked on, and recorded", () =>
    Effect.gen(function* () {
      const rig = secondAttempt();
      rig.world.pr = { ...defaultPr(), number: 14, headRef: "t3code/old" };
      setStatus(rig, "completed", `Built it.\nFACTORY-DONE: ${URL14}`);
      assert.deepStrictEqual(yield* advanceIn(rig), {
        kind: "ready-for-gate",
        pr: 14,
        prUrl: URL14,
      });
      assert.deepStrictEqual(linesOf(rig), [
        ...STARTED,
        { event: "pr_opened", data: { pr: 14, url: URL14 } },
      ]);
    }),
  );

  it.effect("is bound by the number attempt 1 recorded, whatever its branch is now", () =>
    Effect.gen(function* () {
      const rig = secondAttempt();
      rig.world.pr = { ...defaultPr(), headRef: "t3code/renamed" };
      assert.deepStrictEqual(yield* advanceIn(rig), {
        kind: "ready-for-gate",
        pr: 12,
        prUrl: URL12,
      });
      assert.deepStrictEqual(linesOf(rig), [...STARTED, PR_OPENED]);
    }),
  );

  it.effect("is bound by the branch attempt 1's stuck line recorded", () =>
    Effect.gen(function* () {
      const rig = secondAttempt([
        ...STARTED,
        {
          event: "stuck",
          data: { reason: "the run passed its time limit", branch: "t3code/left" },
        },
        moved("building", "stuck"),
        FINISHED_EVENT,
      ]);
      rig.world.pr = { ...defaultPr(), headRef: "t3code/left" };
      assert.strictEqual((yield* advanceIn(rig)).kind, "ready-for-gate");
    }),
  );

  it.effect("is bound by the branch attempt 1 was relaunched on after an interruption", () =>
    Effect.gen(function* () {
      const rig = secondAttempt([
        ...STARTED,
        {
          event: "session_interrupted",
          data: {
            resumes: 1,
            relaunch: true,
            run_ordinal: null,
            branch: "t3code/int",
            t3_error: null,
            ended_in_pass: 2,
          },
        },
        FINISHED_EVENT,
      ]);
      rig.world.pr = { ...defaultPr(), headRef: "t3code/int" };
      assert.strictEqual((yield* advanceIn(rig)).kind, "ready-for-gate");
    }),
  );

  it.effect("is bound by the branch attempt 1's launch resumed from", () =>
    Effect.gen(function* () {
      const rig = secondAttempt(
        STARTED.map((event) =>
          event.event === "session_launched"
            ? {
                event: "session_launched" as const,
                data: {
                  ...event.data,
                  resumed_from: { run: "rawphp__softfac__10__1", branch: "t3code/res" },
                },
              }
            : event,
        ),
      );
      rig.world.pr = { ...defaultPr(), headRef: "t3code/res" };
      assert.strictEqual((yield* advanceIn(rig)).kind, "ready-for-gate");
    }),
  );

  it.effect("passes over an attempt with no ledger", () =>
    Effect.gen(function* () {
      // Attempt 1 is the plain start `rigFor` seeds; attempt 2 worked on t3code/old; attempt 3
      // left no ledger; attempt 4 reports the pull request on t3code/old.
      const rig = rigFor();
      seed(rig.dataDir, { ...run10, attempt: 2 }, FIRST_ATTEMPT);
      const run10n4: RunId = { ...run10, attempt: 4 };
      seed(rig.dataDir, run10n4, STARTED);
      const fourth: Rig = { ...rig, run: run10n4 };
      fourth.world.pr = { ...defaultPr(), number: 14, headRef: "t3code/old" };
      setStatus(fourth, "completed", `Built it.\nFACTORY-DONE: ${URL14}`);
      assert.strictEqual((yield* advanceIn(fourth)).kind, "ready-for-gate");
    }),
  );

  it.effect("is still refused on a branch no attempt of the issue worked on", () =>
    Effect.gen(function* () {
      const rig = secondAttempt();
      rig.world.pr = { ...defaultPr(), number: 14, headRef: "someone/else" };
      setStatus(rig, "completed", `Built it.\nFACTORY-DONE: ${URL14}`);
      const outcome = yield* advanceIn(rig);
      assert.ok(
        outcome.kind === "stuck" &&
          outcome.reason.startsWith(
            "the session reported PR #14 but its branch someone/else is not this session's branch",
          ),
        JSON.stringify(outcome),
      );
      assert.deepStrictEqual(stuckCauses(rig), Array(3).fill("advance pr-not-bound"));
    }),
  );

  it.effect("is not looked for by a first attempt", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      rig.world.pr = { ...defaultPr(), headRef: "t3code/old" };
      assert.strictEqual((yield* advanceIn(rig)).kind, "stuck");
    }),
  );
});

describe("advance: the pull request a session leaves when it stops or asks", () => {
  /** STARTED with a launch line that, as usual, names no branch: only the thread knows it. */
  const unnamedLaunch = (): ReadonlyArray<RunEvent> =>
    STARTED.map((event) =>
      event.event === "session_launched"
        ? { event: "session_launched" as const, data: { ...event.data, branch: null } }
        : event,
    );
  const leftLines = (rig: Rig) => linesOf(rig).filter((line) => line.event === "pr_left");

  it.effect("is recorded when the session said stuck after opening one on its branch", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      rig.world.onHead = { "t3code/abc": [draftOn("t3code/abc")] };
      setStatus(rig, "completed", "FACTORY-STOP: stuck");
      assertStuck(rig, yield* advanceIn(rig), { publicReason: SAID_STUCK, left: [PR_LEFT] });
      // The issue is read first, as for every building run; the lookup is the only other read.
      assert.deepStrictEqual(rig.reads, ["issue 10", "openPullRequestsOnHead t3code/abc"]);
      assert.deepStrictEqual(
        readRun(rig.dataDir, rig.run).entries.find((e) => e.event === "pr_left")?.cause,
        { step: "advance", reason: "pr-left" },
      );
      // Not the session's report: the run holds no pull request for the gate.
      const seen = readProgress(readRun(rig.dataDir, rig.run).entries);
      assert.deepStrictEqual(seen.opened, []);
      assert.strictEqual(seen.lastPr, null);
    }),
  );

  it.effect("is recorded when the session asked questions after opening one on its branch", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      rig.world.onHead = { "t3code/abc": [draftOn("t3code/abc")] };
      setStatus(rig, "completed", `${QUESTIONS}\nFACTORY-STOP: needs-info`);
      assert.deepStrictEqual(yield* advanceIn(rig), { kind: "needs-info" });
      assert.deepStrictEqual(rig.gh, needsInfoCalls(QUESTIONS));
      assert.deepStrictEqual(linesOf(rig), [
        ...STARTED,
        PR_LEFT,
        { event: "questions_posted", data: { questions: QUESTIONS } },
        moved("building", "needs-info"),
        worktreeRemoved,
        FINISHED("needs-info"),
      ]);
    }),
  );

  it.effect("is recorded from the branch T3 made the worktree on", () =>
    Effect.gen(function* () {
      // T3 renamed the thread's branch; the session pushed the worktree's own `t3/<hash>`.
      const rig = rigFor();
      rig.world.onHead = { "t3/2e8db933": [draftOn("t3/2e8db933")] };
      setStatus(rig, "completed", "FACTORY-STOP: stuck", { worktreePath: LAUNCH_WORKTREE });
      const outcome = yield* advanceIn(rig);
      assert.strictEqual(outcome.kind, "stuck");
      assert.strictEqual(leftLines(rig).length, 1);
      assert.deepStrictEqual(rig.reads, [
        "issue 10",
        "openPullRequestsOnHead t3code/abc",
        "openPullRequestsOnHead t3/2e8db933",
      ]);
    }),
  );

  it.effect("is recorded from the branch a resumed session was told to push to", () =>
    Effect.gen(function* () {
      // Resumed from attempt 1's `t3code/old` and told to push there; T3 named its own branch.
      const rig = rigFor(
        STARTED.map((event) =>
          event.event === "session_launched"
            ? {
                event: "session_launched" as const,
                data: {
                  ...event.data,
                  resumed_from: { run: "rawphp__softfac__10__1", branch: "t3code/old" },
                },
              }
            : event,
        ),
        { base: "dev" },
      );
      // A base other than the repo's default: GitHub links no closing reference for it.
      rig.world.onHead = { "t3code/old": [draftOn("t3code/old", { baseRef: "dev" })] };
      setStatus(rig, "completed", "FACTORY-STOP: stuck");
      assert.strictEqual((yield* advanceIn(rig)).kind, "stuck");
      assert.deepStrictEqual(leftLines(rig), [PR_LEFT]);
      assert.deepStrictEqual(rig.reads, [
        "issue 10",
        "openPullRequestsOnHead t3code/abc",
        "openPullRequestsOnHead t3code/old",
      ]);
    }),
  );

  it.effect("is not recorded from another branch, another author, a fork or another base", () =>
    Effect.gen(function* () {
      for (const onHead of [
        { "someone/else": [draftOn("someone/else")] },
        { "t3code/abc": [draftOn("t3code/abc", { author: "someone" })] },
        { "t3code/abc": [draftOn("t3code/abc", { author: null })] },
        { "t3code/abc": [draftOn("t3code/abc", { crossRepository: true })] },
        { "t3code/abc": [draftOn("t3code/abc", { baseRef: "dev" })] },
      ] as Array<Record<string, Array<OpenPullRequest>>>) {
        const rig = rigFor();
        rig.world.onHead = onHead;
        setStatus(rig, "completed", "FACTORY-STOP: stuck");
        assertStuck(rig, yield* advanceIn(rig), { publicReason: SAID_STUCK });
      }
    }),
  );

  it.effect("matches the factory's login whatever its case", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      rig.world.onHead = { "t3code/abc": [draftOn("t3code/abc", { author: "RAWPHP" })] };
      setStatus(rig, "completed", "FACTORY-STOP: stuck");
      assertStuck(rig, yield* advanceIn(rig), { publicReason: SAID_STUCK, left: [PR_LEFT] });
    }),
  );

  it.effect("is recorded when the session refused the result-line reminder", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      rig.world.onHead = { "t3code/abc": [draftOn("t3code/abc")] };
      setEnded(rig, 1, WORKING_MESSAGE);
      rig.world.sendFailure = { error: reminderRefusal(), delivered: false };
      const outcome = yield* advanceIn(rig);
      assert.strictEqual(outcome.kind, "stuck");
      assert.strictEqual(leftLines(rig).length, 1);
    }),
  );

  it.effect("is recorded when the run is stopped at its time limit", () =>
    Effect.gen(function* () {
      const rig = limitedRig();
      rig.world.onHead = { "t3code/abc": [draftOn("t3code/abc")] };
      const elapsed = yield* stopAtTheLimit(rig);
      assert.deepStrictEqual(linesOf(rig), [
        ...STARTED,
        worktreeRemoved,
        PR_LEFT,
        ...limitEvents(elapsed, "t3code/abc").slice(STARTED.length + 1),
      ]);
      assert.deepStrictEqual(rig.reads, ["openPullRequestsOnHead t3code/abc"]);
    }),
  );

  it.effect("does not keep the time limit from stopping the run when the stop fails after it", () =>
    Effect.gen(function* () {
      // The record is written, then the stuck comment fails: the next call stops the run still.
      const rig = limitedRig();
      rig.world.onHead = { "t3code/abc": [draftOn("t3code/abc")] };
      rig.world.failNext.postComment = ghFailure();
      rig.clock.now = T0 + LIMIT_MS + 1;
      assert.strictEqual((yield* Effect.flip(timeLimit(rig.ctx, rig.run)))._tag, "GitHubFailed");
      assert.strictEqual(leftLines(rig).length, 1);
      assert.deepStrictEqual(yield* timeLimit(rig.ctx, rig.run), {
        kind: "stopped",
        reason: TIME_LIMIT,
      });
      assert.strictEqual(leftLines(rig).length, 1);
      assert.deepStrictEqual(stuckCauses(rig), Array(3).fill("pass time-limit"));
    }),
  );

  it.effect("is recorded at the time limit from the branch T3 made the worktree on", () =>
    Effect.gen(function* () {
      // The launch line recorded the worktree; the session pushed its own `t3/<hash>`.
      const rig = rigFor(
        STARTED.map((event) =>
          event.event === "session_launched"
            ? {
                event: "session_launched" as const,
                data: { ...event.data, worktree: LAUNCH_WORKTREE },
              }
            : event,
        ),
        { ms: startedAtT0 },
      );
      rig.world.thread = { worktreePath: LAUNCH_WORKTREE, branch: "t3code/abc", archived: false };
      rig.world.onHead = { "t3/2e8db933": [draftOn("t3/2e8db933")] };
      yield* stopAtTheLimit(rig);
      assert.strictEqual(leftLines(rig).length, 1);
      assert.deepStrictEqual(rig.reads, [
        "openPullRequestsOnHead t3code/abc",
        "openPullRequestsOnHead t3/2e8db933",
      ]);
    }),
  );

  it.effect("is recorded when the run is stopped by hand, from the branch the thread reports", () =>
    Effect.gen(function* () {
      const rig = rigFor([...unnamedLaunch(), STOP_REQUESTED]);
      rig.world.onHead = { "t3code/abc": [draftOn("t3code/abc")] };
      assert.deepStrictEqual(yield* advanceIn(rig), { kind: "stuck", reason: STOPPED_BY_HAND });
      assert.deepStrictEqual(leftLines(rig), [PR_LEFT]);
      assert.deepStrictEqual(rig.reads, ["issue 10", "openPullRequestsOnHead t3code/abc"]);
    }),
  );

  it.effect("stopped by hand with its thread gone is looked up by the ledger's branch", () =>
    Effect.gen(function* () {
      const rig = rigFor([...STARTED, STOP_REQUESTED]);
      rig.world.thread = new ThreadNotFoundError({ threadId: "thread-1" });
      rig.world.onHead = { "t3code/abc": [draftOn("t3code/abc")] };
      assert.deepStrictEqual(yield* advanceIn(rig), { kind: "stuck", reason: STOPPED_BY_HAND });
      assert.deepStrictEqual(leftLines(rig), [PR_LEFT]);
    }),
  );

  it.effect("is recorded when the watch stops the run, from the branch the thread reports", () =>
    Effect.gen(function* () {
      const rig = rigFor(unnamedLaunch());
      rig.world.textCheck = "changed";
      rig.world.onHead = { "t3code/abc": [draftOn("t3code/abc")] };
      assert.strictEqual((yield* watch(rig.ctx, rig.run)).kind, "stopped");
      assert.deepStrictEqual(leftLines(rig), [PR_LEFT]);
      assert.deepStrictEqual(rig.reads, ["openPullRequestsOnHead t3code/abc"]);
    }),
  );

  it.effect("is recorded when the reminder's thread is gone", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      rig.world.onHead = { "t3code/abc": [draftOn("t3code/abc")] };
      setEnded(rig, 1, WORKING_MESSAGE);
      rig.world.sendFailure = {
        error: new ThreadNotFoundError({ threadId: "thread-1" }),
        delivered: false,
      };
      const outcome = yield* advanceIn(rig);
      assert.strictEqual(outcome.kind, "stuck");
      assert.strictEqual(leftLines(rig).length, 1);
    }),
  );

  it.effect("is recorded once, and not for a pull request the session reported", () =>
    Effect.gen(function* () {
      for (const recorded of [PR_LEFT, PR_OPENED]) {
        const rig = rigFor([...STARTED, recorded]);
        rig.world.onHead = { "t3code/abc": [draftOn("t3code/abc")] };
        setStatus(rig, "completed", "FACTORY-STOP: stuck");
        const outcome = yield* advanceIn(rig);
        assert.strictEqual(outcome.kind, "stuck");
        assert.strictEqual(
          linesOf(rig).filter((line) => line.event === "pr_left" || line.event === "pr_opened")
            .length,
          1,
        );
      }
    }),
  );

  it.effect("does not keep a later report of the same pull request from being recorded", () =>
    Effect.gen(function* () {
      // A stop recorded #12 as left and then failed; the session has since reported #12.
      const rig = rigFor([...STARTED, PR_LEFT], { ms: startedAtT0 });
      assert.deepStrictEqual(yield* advanceIn(rig), {
        kind: "ready-for-gate",
        pr: 12,
        prUrl: URL12,
      });
      assert.deepStrictEqual(linesOf(rig), [...STARTED, PR_LEFT, PR_OPENED]);
      // Reported, so it waits for the gate and its time limit no longer runs.
      rig.clock.now = T0 + LIMIT_MS + 1;
      assert.deepStrictEqual(yield* timeLimit(rig.ctx, rig.run), {
        kind: "skipped",
        why: "pr-reported",
      });
    }),
  );

  /** The lines a stop ends with when GitHub could not list the pull requests: an error, no record. */
  const lookupFailed = (rig: Rig, step: string) => {
    const lines = readRun(rig.dataDir, rig.run).entries;
    const error = lines.find((e) => e.event === "error");
    assert.ok(error !== undefined, lines.map((e) => e.event).join(" "));
    assert.deepStrictEqual(error.cause, { step, reason: "step-failed" });
    assert.strictEqual((error.data as { kind: string }).kind, "github");
    assert.deepStrictEqual(leftLines(rig), []);
    // Written once the session is stopped, and before anything is written on the issue.
    const kinds = lines.map((e) => e.event);
    assert.ok(kinds.indexOf("worktree_removed") < kinds.indexOf("error"), kinds.join(" "));
    assert.ok(kinds.indexOf("error") < kinds.indexOf("stuck"), kinds.join(" "));
  };

  it.effect("finishes the stop without the record when GitHub cannot list them", () =>
    Effect.gen(function* () {
      // After the archive T3 reads the thread as gone, so the stop cannot wait for a retry.
      const rig = rigFor();
      rig.world.onHead = { "t3code/abc": [draftOn("t3code/abc")] };
      rig.world.failNext.openPullRequestsOnHead = ghFailure();
      setStatus(rig, "completed", "FACTORY-STOP: stuck");
      assert.deepStrictEqual(yield* advanceIn(rig), { kind: "stuck", reason: SAID_STUCK });
      assert.deepStrictEqual(rig.t3, STOP_CALLS);
      assert.deepStrictEqual(rig.gh, stuckCalls(SAID_STUCK));
      lookupFailed(rig, "advance");
    }),
  );

  it.effect("at the time limit, stops the run even when GitHub cannot list them", () =>
    Effect.gen(function* () {
      const rig = limitedRig();
      rig.world.onHead = { "t3code/abc": [draftOn("t3code/abc")] };
      rig.world.failNext.openPullRequestsOnHead = ghFailure();
      rig.clock.now = T0 + LIMIT_MS + 1;
      assert.deepStrictEqual(yield* timeLimit(rig.ctx, rig.run), {
        kind: "stopped",
        reason: TIME_LIMIT,
      });
      assert.deepStrictEqual(rig.t3, ["thread thread-1", ...ARCHIVE_CALLS]);
      assert.strictEqual(rig.world.issue.state, "stuck");
      lookupFailed(rig, "pass");
    }),
  );

  it.effect("in the watch, stops the run even when GitHub cannot list them", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      rig.world.textCheck = "changed";
      rig.world.onHead = { "t3code/abc": [draftOn("t3code/abc")] };
      rig.world.failNext.openPullRequestsOnHead = ghFailure();
      assert.strictEqual((yield* watch(rig.ctx, rig.run)).kind, "stopped");
      assert.deepStrictEqual(rig.t3, ["thread thread-1", ...ARCHIVE_CALLS]);
      assert.strictEqual(rig.world.issue.state, "stuck");
      lookupFailed(rig, "watch");
    }),
  );
});

describe("advance: done on a branch the session made itself", () => {
  const OWN = "t3/kpi-push-screen";
  const NOT_ITS_BRANCH = "the session reported PR #12 but its branch is not this session's branch";
  const BOUND: Line = { event: "branch_bound", data: { pr: 12, branch: OWN } };
  /** Issue 11 building in thread-2, launched with no branch or worktree recorded. */
  const siblingStarted: ReadonlyArray<RunEvent> = STARTED.map((event) =>
    event.event === "session_launched"
      ? { ...event, data: { ...event.data, thread_id: "thread-2", worktree: null, branch: null } }
      : event,
  );
  /** A run whose session pushed `OWN` from its worktree, whose HEAD is the pull request's head. */
  const ownBranchRig = (pr: Partial<PullRequest> = {}) => {
    const rig = rigFor();
    rig.world.pr = { ...defaultPr(), headRef: OWN, ...pr };
    rig.world.checkouts["/t3/wt"] = { head: "abc123", branch: pr.headRef ?? OWN };
    return rig;
  };
  const assertUnbound = (rig: Rig, outcome: AdvanceOutcome, publicReason = NOT_ITS_BRANCH) => {
    assert.strictEqual(outcome.kind, "stuck", JSON.stringify(outcome));
    assert.ok(rig.gh.includes(`comment 10 ${stuckCommentText(publicReason, DONE_MESSAGE)}`));
    assert.deepStrictEqual(stuckCauses(rig), Array(3).fill("advance pr-not-bound"));
    assert.ok(!linesOf(rig).some((line) => line.event === "branch_bound"));
  };

  /** The pass failed before deciding: nothing written, nothing said, the worktree kept. */
  const assertWaits = (rig: Rig, failure: { readonly _tag: string }, tag: string) => {
    assert.strictEqual(failure._tag, tag);
    assert.deepStrictEqual(linesOf(rig), [...STARTED]);
    assert.deepStrictEqual(
      rig.gh.filter((call) => call.startsWith("comment")),
      [],
    );
    assert.ok(!rig.t3.some((call) => call.startsWith("removeWorktree")), rig.t3.join("\n"));
  };

  it.effect("binds a pull request opened after the claim on the worktree's HEAD", () =>
    Effect.gen(function* () {
      const rig = ownBranchRig();
      assert.deepStrictEqual(yield* advanceIn(rig), {
        kind: "ready-for-gate",
        pr: 12,
        prUrl: URL12,
      });
      assert.deepStrictEqual(linesOf(rig), [...STARTED, BOUND, PR_OPENED]);
      assert.ok(rig.t3.includes("worktreeCheckout /t3/wt"), rig.t3.join("\n"));
      // Once bound, the ledger is the proof: the worktree is not read again.
      clearCalls(rig);
      rig.world.checkouts["/t3/wt"] = { head: "def456", branch: null };
      assert.strictEqual((yield* advanceIn(rig)).kind, "ready-for-gate");
      assert.ok(!rig.t3.some((call) => call.startsWith("worktreeCheckout")));
      assert.deepStrictEqual(linesOf(rig), [...STARTED, BOUND, PR_OPENED]);
    }),
  );

  it.effect("is stuck when the pull request's head is not the worktree's HEAD", () =>
    Effect.gen(function* () {
      const rig = ownBranchRig({ headSha: "0ther" });
      assertUnbound(rig, yield* advanceIn(rig));
      // The worktree is read before the stuck path removes it.
      assert.ok(
        rig.order.indexOf("t3:worktreeCheckout /t3/wt") <
          rig.order.indexOf("t3:removeWorktree /t3/wt"),
        rig.order.join("\n"),
      );
    }),
  );

  it.effect("is stuck for an older pull request the session checked out (#117)", () =>
    Effect.gen(function* () {
      // Someone else's pull request, opened before the claim: its head is what the worktree holds.
      const rig = ownBranchRig({ createdAt: "2026-10-04T10:00:00Z" });
      assertUnbound(rig, yield* advanceIn(rig));
    }),
  );

  it.effect("is stuck for a pull request from a fork", () =>
    Effect.gen(function* () {
      const rig = ownBranchRig({ crossRepository: true });
      assertUnbound(
        rig,
        yield* advanceIn(rig),
        "the session reported PR #12 but it comes from a fork",
      );
    }),
  );

  it.effect("is stuck for a pull request onto another base", () =>
    Effect.gen(function* () {
      const rig = ownBranchRig({ baseRef: "release" });
      assertUnbound(
        rig,
        yield* advanceIn(rig),
        "the session reported PR #12 but its base is not the base branch main",
      );
    }),
  );

  it.effect("is stuck when the thread has no worktree", () =>
    Effect.gen(function* () {
      const rig = ownBranchRig();
      setStatus(rig, "completed", DONE_MESSAGE, { worktreePath: null });
      assertUnbound(rig, yield* advanceIn(rig));
      assert.ok(!rig.t3.some((call) => call.startsWith("worktreeCheckout")));
    }),
  );

  it.effect("is stuck for a pull request or branch another issue's run names", () =>
    Effect.gen(function* () {
      const other: RunId = { repo: REPO, issue: "11", attempt: 1 };
      const launched = (branch: string, worktree = "/t3/wt2"): RunEvent => ({
        event: "session_launched",
        data: {
          thread_id: "thread-2",
          worktree,
          branch,
          model_instance: "claudeAgent",
          model: "claude-opus-5-5",
          model_options: null,
          resumed_from: null,
        },
      });
      const elsewhere = launched("t3code/xyz");
      const cases: ReadonlyArray<[string, string, ReadonlyArray<RunEvent>]> = [
        ["its branch", OWN, [launched(OWN)]],
        [
          "its bound branch",
          OWN,
          [elsewhere, { event: "branch_bound", data: { pr: 9, branch: OWN } }],
        ],
        ["its pull request", OWN, [elsewhere, PR_OPENED]],
        ["the pull request it left", OWN, [elsewhere, PR_LEFT]],
        [
          "the branch it resumed from",
          OWN,
          [
            {
              ...elsewhere,
              data: {
                ...(elsewhere.data as object),
                resumed_from: { run: "rawphp__softfac__11__0", branch: OWN },
              },
            } as RunEvent,
          ],
        ],
        [
          "the branch it plans to resume from",
          OWN,
          [elsewhere, step(`launch-sending resumed-from ${OWN}`)],
        ],
        [
          "the branch it relaunches on",
          OWN,
          [
            elsewhere,
            { event: "regate_relaunching", data: { attempt: 1, branch: OWN, message: "fix it" } },
          ],
        ],
        [
          "the branch it was interrupted on",
          OWN,
          [
            elsewhere,
            {
              event: "session_interrupted",
              data: {
                resumes: 0,
                relaunch: false,
                run_ordinal: 1,
                branch: OWN,
                t3_error: null,
                ended_in_pass: 0,
              },
            } as RunEvent,
            // A relaunch moves its newest branch on; the interruption still names the old one.
            launched("t3code/relaunched", "/t3/wt3"),
          ],
        ],
        [
          "the branch it launched on, two relaunches ago",
          OWN,
          [
            launched(OWN),
            launched("t3code/second", "/t3/wt3"),
            launched("t3code/third", "/t3/wt4"),
          ],
        ],
        // T3's launch branch of the other worktree, which the ledger names only by its folder.
        [
          "its worktree's launch branch",
          "t3/0a1b2c3d",
          [launched("t3code/xyz", "/t3/worktrees/softfac/t3-0a1b2c3d")],
        ],
      ];
      for (const [what, headRef, events] of cases) {
        const rig = ownBranchRig({ headRef });
        seed(rig.dataDir, other, events);
        assertUnbound(rig, yield* advanceIn(rig));
        // Its ledger decides: its live worktree is not asked.
        assert.ok(!rig.t3.includes("thread thread-2"), what);
      }
      // A run that finished, its file last written a week before the claim, still names them.
      for (const events of [[launched(OWN)], [elsewhere, PR_OPENED]]) {
        const rig = ownBranchRig();
        seed(rig.dataDir, other, [...events, FINISHED_EVENT]);
        const weekBefore = (T0 - 7 * 24 * 60 * MINUTE) / 1000;
        NodeFS.utimesSync(runPath(rig.dataDir, other), weekBefore, weekBefore);
        assertUnbound(rig, yield* advanceIn(rig));
      }
    }),
  );

  it.effect("waits a pass when the runs cannot be listed", () =>
    Effect.gen(function* () {
      const rig = ownBranchRig();
      // The run's own file stays open to write; only the listing fails.
      const runs = NodePath.dirname(runPath(rig.dataDir, rig.run));
      NodeFS.chmodSync(runs, 0o300);
      try {
        assertWaits(rig, yield* Effect.flip(advanceIn(rig)), "LedgerIoError");
      } finally {
        NodeFS.chmodSync(runs, 0o700);
      }
      assert.strictEqual((yield* advanceIn(rig)).kind, "ready-for-gate");
    }),
  );

  it.effect("waits a pass when another issue's ledger cannot be read", () =>
    Effect.gen(function* () {
      const rig = ownBranchRig();
      seed(rig.dataDir, { repo: REPO, issue: "11", attempt: 1 }, STARTED);
      const path = runPath(rig.dataDir, { repo: REPO, issue: "11", attempt: 1 });
      NodeFS.chmodSync(path, 0o000);
      try {
        assertWaits(rig, yield* Effect.flip(advanceIn(rig)), "LedgerIoError");
      } finally {
        NodeFS.chmodSync(path, 0o600);
      }
    }),
  );

  it.effect("binds while a run of another repo is active", () =>
    Effect.gen(function* () {
      const rig = ownBranchRig();
      seed(rig.dataDir, { repo: "rawphp/other", issue: "11", attempt: 1 }, [
        ...STARTED,
        { event: "branch_bound", data: { pr: 12, branch: OWN } },
      ]);
      assert.strictEqual((yield* advanceIn(rig)).kind, "ready-for-gate");
    }),
  );

  it.effect(
    "is stuck for a closed pull request, an unsafe branch name, or a run with no claim",
    () =>
      Effect.gen(function* () {
        const closed = ownBranchRig({ open: false, isDraft: false });
        const outcome = yield* advanceIn(closed);
        assert.strictEqual(outcome.kind, "stuck", JSON.stringify(outcome));
        assert.ok(!linesOf(closed).some((line) => line.event === "branch_bound"));
        const unsafe = ownBranchRig({ headRef: "-kpi push" });
        assert.strictEqual((yield* advanceIn(unsafe)).kind, "stuck");
        assert.ok(!linesOf(unsafe).some((line) => line.event === "branch_bound"));
        const unclaimed = rigFor(STARTED.filter((event) => event.event !== "claimed"));
        unclaimed.world.pr = { ...defaultPr(), headRef: OWN };
        unclaimed.world.checkouts["/t3/wt"] = { head: "abc123", branch: OWN };
        assert.strictEqual((yield* advanceIn(unclaimed)).kind, "stuck");
        assert.ok(!linesOf(unclaimed).some((line) => line.event === "branch_bound"));
        assert.ok(!unclaimed.t3.some((call) => call.startsWith("worktreeCheckout")));
      }),
  );

  it.effect("is stuck for a pull request opened in the claim's own second", () =>
    Effect.gen(function* () {
      const claimMs = Date.parse("2026-10-04T10:13:16Z");
      const rig = rigFor(STARTED, { ms: () => claimMs });
      rig.world.pr = { ...defaultPr(), headRef: OWN, createdAt: "2026-10-04T10:13:16Z" };
      rig.world.checkouts["/t3/wt"] = { head: "abc123", branch: OWN };
      assertUnbound(rig, yield* advanceIn(rig));
    }),
  );

  it.effect("is stuck when the worktree is not on the pull request's branch", () =>
    Effect.gen(function* () {
      // A detached HEAD at the pull request's head, or another branch at it.
      for (const branch of [null, "t3code/abc"]) {
        const rig = ownBranchRig();
        rig.world.checkouts["/t3/wt"] = { head: "abc123", branch };
        assertUnbound(rig, yield* advanceIn(rig));
      }
    }),
  );

  it.effect("is stuck while another issue's live worktree holds the pull request", () =>
    Effect.gen(function* () {
      // Issue 11's session made the branch and opened the pull request, and has not reported it:
      // its ledger names neither yet.
      const holds: ReadonlyArray<[string, Thread, Checkout]> = [
        [
          "its thread is on the branch",
          { worktreePath: "/t3/wt2", branch: OWN, archived: false },
          { head: "f00", branch: "t3code/xyz" },
        ],
        [
          "its checkout is on the branch",
          { worktreePath: "/t3/wt2", branch: "t3code/xyz", archived: false },
          { head: "f00", branch: OWN },
        ],
        [
          "its HEAD is the head",
          { worktreePath: "/t3/wt2", branch: "t3code/xyz", archived: false },
          { head: "abc123", branch: null },
        ],
      ];
      for (const [what, thread, checkout] of holds) {
        const rig = ownBranchRig();
        seed(rig.dataDir, { repo: REPO, issue: "11", attempt: 1 }, siblingStarted);
        rig.world.threads["thread-2"] = thread;
        rig.world.checkouts["/t3/wt2"] = checkout;
        const outcome = yield* advanceIn(rig);
        assert.strictEqual(outcome.kind, "stuck", what);
      }
    }),
  );

  it.effect("binds when another issue's live worktree is elsewhere or its thread is gone", () =>
    Effect.gen(function* () {
      const elsewhere = ownBranchRig();
      seed(elsewhere.dataDir, { repo: REPO, issue: "11", attempt: 1 }, siblingStarted);
      elsewhere.world.threads["thread-2"] = {
        worktreePath: "/t3/wt2",
        branch: "t3code/xyz",
        archived: false,
      };
      elsewhere.world.checkouts["/t3/wt2"] = { head: "f00", branch: "t3code/xyz" };
      assert.strictEqual((yield* advanceIn(elsewhere)).kind, "ready-for-gate");
      const gone = ownBranchRig();
      seed(gone.dataDir, { repo: REPO, issue: "11", attempt: 1 }, siblingStarted);
      gone.world.threads["thread-2"] = new ThreadNotFoundError({ threadId: "thread-2" });
      assert.strictEqual((yield* advanceIn(gone)).kind, "ready-for-gate");
      const noWorktree = ownBranchRig();
      seed(noWorktree.dataDir, { repo: REPO, issue: "11", attempt: 1 }, siblingStarted);
      noWorktree.world.threads["thread-2"] = {
        worktreePath: "/t3/wt2",
        branch: "t3code/xyz",
        archived: false,
      };
      noWorktree.world.checkouts["/t3/wt2"] = null;
      assert.strictEqual((yield* advanceIn(noWorktree)).kind, "ready-for-gate");
      for (const thread of [
        { worktreePath: "/t3/wt2", branch: OWN, archived: true },
        { worktreePath: null, branch: "t3code/xyz", archived: false },
      ]) {
        const quiet = ownBranchRig();
        seed(quiet.dataDir, { repo: REPO, issue: "11", attempt: 1 }, siblingStarted);
        quiet.world.threads["thread-2"] = thread;
        assert.strictEqual(
          (yield* advanceIn(quiet)).kind,
          "ready-for-gate",
          JSON.stringify(thread),
        );
      }
    }),
  );

  it.effect("waits a pass when another issue's thread or worktree cannot be read", () =>
    Effect.gen(function* () {
      const live: Thread = { worktreePath: "/t3/wt2", branch: "t3code/xyz", archived: false };
      const threadFails = ownBranchRig();
      seed(threadFails.dataDir, { repo: REPO, issue: "11", attempt: 1 }, siblingStarted);
      threadFails.world.threads["thread-2"] = new SessionsError({
        operation: "thread",
        cause: "timeout",
      });
      assertWaits(threadFails, yield* Effect.flip(advanceIn(threadFails)), "FactorySessionsError");
      const checkoutFails = ownBranchRig();
      seed(checkoutFails.dataDir, { repo: REPO, issue: "11", attempt: 1 }, siblingStarted);
      checkoutFails.world.threads["thread-2"] = live;
      checkoutFails.world.checkouts["/t3/wt2"] = new SessionsError({
        operation: "worktree-head",
        cause: "git timed out",
      });
      assertWaits(
        checkoutFails,
        yield* Effect.flip(advanceIn(checkoutFails)),
        "FactorySessionsError",
      );
      // The next pass reads it and binds.
      checkoutFails.world.checkouts["/t3/wt2"] = { head: "f00", branch: "t3code/xyz" };
      assert.strictEqual((yield* advanceIn(checkoutFails)).kind, "ready-for-gate");
    }),
  );

  it.effect("is stuck when the worktree is gone", () =>
    Effect.gen(function* () {
      const rig = ownBranchRig();
      rig.world.checkouts["/t3/wt"] = null;
      assertUnbound(rig, yield* advanceIn(rig));
    }),
  );

  it.effect("waits a pass when the worktree's HEAD cannot be read", () =>
    Effect.gen(function* () {
      const rig = ownBranchRig();
      rig.world.checkouts["/t3/wt"] = new SessionsError({
        operation: "worktree-head",
        cause: "git timed out",
      });
      assertWaits(rig, yield* Effect.flip(advanceIn(rig)), "FactorySessionsError");
      rig.world.checkouts["/t3/wt"] = { head: "abc123", branch: OWN };
      assert.strictEqual((yield* advanceIn(rig)).kind, "ready-for-gate");
    }),
  );
});

describe("advance: a branch an earlier attempt's session made", () => {
  it.effect("binds a pull request on it without reading the worktree", () =>
    Effect.gen(function* () {
      const rig = rigFor([
        ...STARTED,
        { event: "branch_bound", data: { pr: 12, branch: "t3/kpi-push-screen" } },
        FINISHED_EVENT,
      ]);
      const second: Rig = { ...rig, run: { ...run10, attempt: 2 } };
      seed(rig.dataDir, second.run, STARTED);
      // A new pull request on that branch, opened before this attempt's claim.
      rig.world.pr = {
        ...defaultPr(),
        headRef: "t3/kpi-push-screen",
        createdAt: "2026-10-04T10:00:00Z",
      };
      const outcome = yield* advance(interruptible(second.ctx), second.run);
      assert.strictEqual(outcome.kind, "ready-for-gate", JSON.stringify(outcome));
      assert.ok(!rig.t3.some((call) => call.startsWith("worktreeCheckout")));
    }),
  );
});

describe("checkBinding: a session relaunched from a pull request's branch", () => {
  const pull = (headRef: string): PullRequest => ({ ...defaultPr(), headRef });
  const NOT_ITS_BRANCH = "the session reported PR #12 but its branch is not this session's branch";

  it("binds the pull request on the branch it was started from", () => {
    assert.strictEqual(
      checkBinding(pull("t3code/abc"), 12, "main", "t3code/def", false, "t3code/abc"),
      null,
    );
    assert.strictEqual(
      checkBinding(pull("t3code/abc"), 12, "main", null, false, "t3code/abc"),
      null,
    );
  });

  it("refuses a pull request on any other branch", () => {
    for (const branch of ["t3code/def", null]) {
      assert.strictEqual(
        checkBinding(pull("someone/else"), 12, "main", branch, false, "t3code/abc")?.public,
        NOT_ITS_BRANCH,
        String(branch),
      );
    }
  });
});
