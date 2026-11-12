// @effect-diagnostics nodeBuiltinImport:off - the tests read the bytes of real run files and the gate's real checkout directories.
/**
 * Instructor feedback on a `pr-open` run, ported from softfac's `runner/tests/feedback.rs`. Left
 * out: the required-checks rig tests, the older build's numbering, the gate lock (gates run
 * in-process) and the older archive of a pending relaunch's thread (`start` has no such step).
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeUtil from "node:util";

import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { describe } from "vitest";

import { timeLimitOnlyProjectConfig, type ProjectConfig } from "../config.ts";
import type { TextCheck } from "../domain/approval.ts";
import type { State } from "../domain/lifecycle.ts";
import {
  GateCommandSpawnError,
  WorkspaceSpawnError,
  WorkspaceUnexpectedError,
  gateRoot,
  type CommandResult,
  type GateError,
  type GateInput,
  type GateResult,
  type Merge,
} from "../gate.ts";
import { makeCause, type RunEvent } from "../ledger/events.ts";
import { Ledger } from "../ledger/ledger.ts";
import { readRun } from "../ledger/read.ts";
import { RUNS_DIR, feedbackReadFile, runPath, type RunId } from "../ledger/runId.ts";
import { T0, useTempDirs } from "../ledger/testSupport.ts";
import {
  SessionsError,
  ThreadNotFoundError,
  type FactoryProject,
  type LaunchRequest,
  type RunStatus,
  type ThreadStatus,
} from "../sessions.ts";
import {
  type CheckStatus,
  GitHubFailed,
  GitHubRateLimited,
  type Activity,
  type Feedback,
  type GitHubError,
  type InlineComment,
  type IssueDetail,
  type PullRequest,
} from "../tracker/github.ts";
import { advance, forward, timeLimit } from "./building.ts";
import { interruptible } from "./testSupport.ts";
import { feedback, type FeedbackContext, type FeedbackStep } from "./feedback.ts";
import { gate, lastPass, regate, type GateContext } from "./gating.ts";
import { SESSION_MAY_EXIST, feedbackMessage } from "./messages.ts";
import { nextGateAttempt, readProgress } from "./progress.ts";
import { runProject } from "./run.ts";

const tempDir = useTempDirs();

const REPO = "rawphp/softfac";
const run10: RunId = { repo: REPO, issue: "10", attempt: 1 };
const RUN = "rawphp__softfac__10__1";
const LABELED = "2026-10-04T10:00:00Z";
const URL12 = "https://github.com/rawphp/softfac/pull/12";
const DONE_MESSAGE = `Built it.\nFACTORY-DONE: ${URL12}`;
const HEAD = "4f1c2d3e4a5b60718293a4b5c6d7e8f901234567";
const BASE = "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d";
const FMT = "cargo fmt --check";
const TEST = "cargo test";
const CHANGED_DURING_BUILD_TEXT =
  "the issue text was changed during the build by someone who is not an instructor";
const END_WITH_DONE =
  "When you have fixed this, end your reply with the line FACTORY-DONE: <PR URL> as before.";

type Line = { readonly event: string; readonly data: unknown };

const step = (text: string): RunEvent => ({ event: "step_changed", data: { step: text } });
const moved = (from: State, to: State): RunEvent => ({
  event: "state_changed",
  data: { from, to },
});

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

const gateCmd = (attempt: number, command: string, exitCode: number, durationMs: number): Line => ({
  event: "gate_command",
  data: { attempt, command, exit_code: exitCode, duration_ms: durationMs },
});

/** Where an attempt ran and on which commits, with the directory blanked as `events` does. */
const checkoutOf = (base: string, attempt: number): Line => ({
  event: "gate_checkout",
  data: { attempt, dir: "", sha: HEAD, base_sha: base },
});
const checkoutBlank = (attempt: number) => checkoutOf(BASE, attempt);

/** An attempt that passes: where it ran, then its two commands with the fake's durations. */
const passingOn = (base: string, attempt: number): Array<Line> => [
  checkoutOf(base, attempt),
  gateCmd(attempt, FMT, 0, 1_234),
  gateCmd(attempt, TEST, 0, 12_300),
];
const passingAttempt = (attempt: number) => passingOn(BASE, attempt);

/** An attempt whose `cargo test` exits 101. */
const failingAttempt = (attempt: number): Array<Line> => [
  checkoutBlank(attempt),
  gateCmd(attempt, FMT, 0, 1_234),
  gateCmd(attempt, TEST, 101, 12_300),
];

const PASSED_STEP: Line = step(`gate-passed ${HEAD} 2`);
const sending = (attempt: number, ordinal: number): Line =>
  step(`gate-sending ${attempt} ${ordinal}`);
const sentBack = (attempt: number, ordinal: number): Line => ({
  event: "gate_sent_back",
  data: { attempt, run_ordinal: ordinal },
});
const regateLine = (previous: string, base: string): Line => ({
  event: "gate_regate",
  data: { sha: HEAD, base_sha: base, previous_base_sha: previous },
});
const worktreeRemoved: Line = { event: "worktree_removed", data: { path: "/t3/wt" } };

const UNCHANGED_READ = `textCheck 10 ${LABELED} rawphp`;

const ghFailure = () => new GitHubFailed({ args: ["issue"], status: 1, stderr: "boom" });
const ghRateLimit = () => new GitHubRateLimited({ args: ["issue"], stderr: "rate limit" });
const sessionsFailure = (
  operation:
    | "status"
    | "send"
    | "archive"
    | "thread"
    | "launch"
    | "find-project"
    | "remove-worktree",
) => new SessionsError({ operation, cause: "timeout" });

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
  headSha: HEAD,
  mergeable: "mergeable",
  createdAt: "2026-10-04T10:00:00Z",
});

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

/** The issue and its pull request as GitHub shows them: what the fake's writes change. */
interface World {
  state: State | null;
  assignees: Array<string>;
  comments: Array<string>;
  status: string | null;
  prReady: boolean;
  prDrafted: boolean;
  prComments: Array<string>;
}

/** The fake tracker: every call logged, the zero-based call `failAt` failing. */
class FakeGh {
  readonly calls: Array<string> = [];
  world: World = {
    state: "building",
    assignees: ["rawphp"],
    comments: [],
    status: null,
    prReady: false,
    prDrafted: false,
    prComments: [],
  };
  pr: PullRequest | null = defaultPr();
  /** What `pullRequest` answers from its second call on, when set: the pull request changed in between. */
  laterPr: PullRequest | null | undefined = undefined;
  prReads = 0;
  baseTip = BASE;
  /** When set, what `branchTip` answers in place of `baseTip`: a base a test moves from outside. */
  tipCell: { tip: string } | null = null;
  failAt: number | null = null;
  /** The failing call still has its effect: the answer was lost, not the request. */
  loseResponse = false;
  /** The failing call is refused for the rate limit, with no effect. */
  rateLimited = false;
  /** What the next `textCheck` calls answer, in order; unchanged once empty. */
  unchanged: Array<boolean> = [];
  /** A `false` in `unchanged` says the histories cannot be judged. */
  unjudged = false;
  /** The reads of the issue and of who closed it: kept out of `calls`, which the crash matrix indexes by position. */
  readonly reads: Array<string> = [];
  /** GitHub says the issue is closed. */
  closed = false;
  /** Who GitHub says closed it; `"fails"` is a read that fails. */
  closedByAnswer: string | null | "fails" = null;
  /** The next reads of the issue fail. */
  issueFails = false;
  readyBy: string | null = "tom";
  readyByFails = false;
  readyByRateLimited = false;
  /** `markPrDraft` fails and has no effect, whatever `failAt` says. */
  markDraftFails = false;
  /** What the instructors did on the issue since the run began: what `forward` reads. */
  activity: Activity = { comments: [], bodyEdit: null, dropped: [] };
  /** The reviews and comments of the pull request that `prFeedback` answers. */
  feedback: Array<Feedback> = [];

  /** Records the call, then applies `effect` unless the call fails before reaching GitHub. */
  run(call: string, effect: (world: World) => void): Effect.Effect<void, GitHubError> {
    this.calls.push(call);
    const failing = this.failAt === this.calls.length - 1;
    if (!failing || this.loseResponse) effect(this.world);
    if (failing && this.rateLimited) return Effect.fail(ghRateLimit());
    if (failing) return Effect.fail(ghFailure());
    return Effect.void;
  }

  readonly tracker: FeedbackContext["tracker"] = {
    prFeedback: (pr, since, floor, instructors) =>
      this.run(`feedback ${pr} ${since} ${floor} ${instructors.join(",")}`, () => {}).pipe(
        Effect.map(() => [...this.feedback]),
      ),
    activitySince: (n, since, instructors) =>
      this.run(`activity ${n} ${since} ${instructors.join(",")}`, () => {}).pipe(
        Effect.map(() => this.activity),
      ),
    issue: (n) =>
      this.run(`issue ${n}`, () => {}).pipe(
        Effect.map(() => ({
          ...issueDetail(this.world.state, this.world.assignees),
          closed: this.closed,
        })),
      ),
    closedBy: (n) => {
      this.reads.push(`closedBy ${n}`);
      return this.closedByAnswer === "fails"
        ? Effect.fail(ghFailure())
        : Effect.succeed(this.closedByAnswer);
    },
    openPullRequestsOnHead: () => Effect.succeed([]),
    pullRequest: (n) =>
      this.run(`pullRequest ${n}`, () => {}).pipe(
        Effect.map(() => {
          const read = this.prReads;
          this.prReads += 1;
          const shown = this.laterPr !== undefined && read >= 1 ? this.laterPr : this.pr;
          if (shown === null) return null;
          // What GitHub shows once the pull request has been taken out of draft.
          return {
            ...shown,
            isDraft: (shown.isDraft || this.world.prDrafted) && !this.world.prReady,
          };
        }),
      ),
    markPrReady: (pr) =>
      this.run(`markPrReady ${pr}`, (w) => {
        w.prReady = true;
      }),
    markPrDraft: (pr) => {
      if (this.markDraftFails) {
        this.calls.push(`markPrDraft ${pr}`);
        return Effect.fail(ghFailure());
      }
      return this.run(`markPrDraft ${pr}`, (w) => {
        w.prReady = false;
        w.prDrafted = true;
      });
    },
    commentOnPr: (pr, body) =>
      this.run(`prComment ${pr} ${body}`, (w) => {
        w.prComments.push(body);
      }),
    readyBy: (pr) =>
      this.run(`readyBy ${pr}`, () => {}).pipe(
        Effect.flatMap((): Effect.Effect<string | null, GitHubError> => {
          if (this.readyByFails) return Effect.fail(ghFailure());
          if (this.readyByRateLimited) return Effect.fail(ghRateLimit());
          return Effect.succeed(this.readyBy);
        }),
      ),
    branchTip: (branch) =>
      this.run(`branchTip ${branch}`, () => {}).pipe(
        Effect.map(() => (this.tipCell === null ? this.baseTip : this.tipCell.tip)),
      ),
    // The feedback step reads no checks (required checks after a relaunch wait for #26).
    checks: (sha, names) =>
      this.run(`checks ${sha} ${names.join(",")}`, () => {}).pipe(
        Effect.map((): Array<CheckStatus> =>
          names.map((name) => ({ name, state: "passed", conclusion: "success", url: null })),
        ),
      ),
    setState: (n, state) =>
      this.run(`setState ${n} ${state}`, (w) => {
        w.state = state;
      }),
    assign: (n, user) =>
      this.run(`assign ${n} ${user}`, (w) => {
        if (!w.assignees.includes(user)) w.assignees.push(user);
      }),
    unassign: (n, user) =>
      this.run(`unassign ${n} ${user}`, (w) => {
        w.assignees = w.assignees.filter((a) => a !== user);
      }),
    postComment: (n, body) =>
      this.run(`comment ${n} ${body}`, (w) => {
        w.comments.push(body);
      }),
    upsertStatusComment: (n, user, body) =>
      this.run(`status ${n} ${user} ${body}`, (w) => {
        w.status = body;
      }),
    textCheck: (n, since, instructors) =>
      this.run(`textCheck ${n} ${since} ${instructors.join(",")}`, () => {}).pipe(
        Effect.map((): TextCheck => {
          const next = this.unchanged.shift() ?? true;
          return next ? "unchanged" : this.unjudged ? "unjudged" : "changed";
        }),
      ),
  };
}

/** The fake sessions: every call logged; the zero-based call `failAt` of status, thread, send and archive fails. */
class FakeT3 {
  readonly calls: Array<string> = [];
  status: () => ThreadStatus | ThreadNotFoundError | SessionsError = () =>
    statusOf("completed", DONE_MESSAGE);
  readonly archived: Array<string> = [];
  /** How many GitHub calls had been made at each archive. */
  readonly countedAtArchive: Array<number> = [];
  archiveFails = false;
  failAt: number | null = null;
  worktreeRemoveFails = false;
  /** The T3 project of the repo; none when there is no project for it on this machine. */
  project: FactoryProject | null = {
    id: "proj-1",
    model: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
  };
  /** Every launch request T3 received, in order. */
  readonly launches: Array<LaunchRequest> = [];
  /** The thread T3 made for each launch command id: a launch sent again under an id answers the thread it made. */
  readonly made = new Map<string, string>();
  /** The launch took effect and then the server died: the call never returns, as a crash would. */
  dieAfterLaunch = false;
  private readonly gh: FakeGh;

  constructor(gh: FakeGh) {
    this.gh = gh;
  }

  /** Records the call; the zero-based call `failAt` among the ones a crash can hit fails. */
  private call(
    text: string,
    operation: Parameters<typeof sessionsFailure>[0] = "status",
  ): SessionsError | null {
    this.calls.push(text);
    const index = this.calls.filter((c) => !c.startsWith("removeWorktree")).length - 1;
    return this.failAt === index ? sessionsFailure(operation) : null;
  }

  readonly sessions: GateContext["sessions"] = {
    findProject: (path) => {
      const failed = this.call(`findProject ${path}`, "find-project");
      return failed !== null ? Effect.fail(failed) : Effect.succeed(this.project);
    },
    launch: (request) => {
      const failed = this.call(`launch ${request.commandId}`, "launch");
      if (failed !== null) return Effect.fail(failed);
      this.launches.push(request);
      const known = this.made.get(request.commandId);
      const threadId = known ?? `thread-${this.made.size + 2}`;
      this.made.set(request.commandId, threadId);
      if (this.dieAfterLaunch) return Effect.die(new Error("the server died"));
      return Effect.succeed({ threadId, worktreePath: "/t3/wt2", branch: "t3code/def" });
    },
    status: (threadId) => {
      const failed = this.call(`status ${threadId}`);
      if (failed !== null) return Effect.fail(failed);
      const answer = this.status();
      return isThreadNotFound(answer) || isSessionsError(answer)
        ? Effect.fail(answer)
        : Effect.succeed(answer);
    },
    thread: (threadId) => {
      const failed = this.call(`thread ${threadId}`);
      if (failed !== null) return Effect.fail(failed);
      const answer = this.status();
      if (isThreadNotFound(answer)) return Effect.fail(answer);
      if (isSessionsError(answer)) return Effect.fail(answer);
      return Effect.succeed({
        worktreePath: answer.worktreePath,
        branch: answer.branch,
        archived: this.archived.includes(threadId),
      });
    },
    send: (threadId, commandId, text) => {
      const failed = this.call(`send ${threadId} ${commandId} ${text}`);
      if (failed !== null) return Effect.fail(failed);
      return Effect.void;
    },
    archive: (threadId) => {
      const failed = this.call(`archive ${threadId}`);
      if (failed !== null) return Effect.fail(failed);
      if (this.archiveFails) return Effect.fail(sessionsFailure("archive"));
      this.archived.push(threadId);
      this.countedAtArchive.push(this.gh.calls.length);
      return Effect.void;
    },
    worktreeCheckout: () => Effect.die("no worktree head"),
    lastActivity: () => Effect.succeed(null),
    removeWorktree: (path) => {
      this.calls.push(`removeWorktree ${path}`);
      if (this.worktreeRemoveFails) {
        return Effect.fail(sessionsFailure("remove-worktree"));
      }
      return Effect.void;
    },
  };
}

const DURATIONS = [1_234, 12_300, 450, 3_000];

const result = (
  command: string,
  exitCode: number,
  durationMs: number,
  output: string,
): CommandResult => ({ command, exitCode, durationMs, timedOut: false, output });

/** Every command passes. */
const passing = (commands: ReadonlyArray<string>): Array<CommandResult> =>
  commands.map((c, i) => result(c, 0, DURATIONS[i % 4]!, ""));

/** Every command but the last passes and the last exits with `exitCode`. */
const failingLast = (
  commands: ReadonlyArray<string>,
  exitCode: number,
  output: string,
): Array<CommandResult> => {
  const results = passing(commands);
  const last = results.length - 1;
  results[last] = result(commands[last]!, exitCode, DURATIONS[last % 4]!, output);
  return results;
};

type GateScript = (call: number, commands: ReadonlyArray<string>) => Array<CommandResult>;

/**
 * A scripted `FactoryGate`: it makes a real directory for each attempt and writes the ledger
 * lines the real gate writes (where the attempt ran, then each command that ran, or the
 * conflict line), so the runner is tested against the gate's contract.
 */
class FakeGate {
  readonly calls: Array<string> = [];
  script: GateScript = (_, commands) => passing(commands);
  gateCalls = 0;
  /** The gate call that fails to start, as if the shell were missing. */
  failGateAt: number | null = null;
  /** The checkout itself fails, after it made its directory. */
  checkoutFails = false;
  /** What the checkout reports as its head. */
  checkoutHead: (sha: string) => string = (sha) => sha;
  merge: () => Merge = () => ({ _tag: "merged" });
  /** Called with the base of every checkout, before it is made. */
  onCheckout: ((base: string) => void) | null = null;
  /** The server is dead: nothing is removed. Set while a call is meant to crash. */
  dead = false;
  removeFails = false;

  readonly gate: GateContext["gate"] = {
    run: (input) => this.runGate(input),
  };

  private runGate(input: GateInput): Effect.Effect<GateResult, GateError> {
    const { dataDir, run, attempt } = input;
    const root = gateRoot(dataDir, run);
    const dir = NodePath.join(root, String(attempt));
    const clock = input.options?.clock ?? (() => T0);
    const append = (event: RunEvent, cause: Parameters<Ledger["append"]>[1]) => {
      const ledger = Ledger.open(dataDir, run, { clock });
      try {
        ledger.append(event, cause);
      } finally {
        ledger.close();
      }
    };
    const noted = () =>
      readRun(dataDir, run).entries.flatMap((entry) =>
        entry.event === "gate_cleanup_failed" &&
        typeof entry.data === "object" &&
        entry.data !== null &&
        "dir" in entry.data
          ? [String(entry.data.dir)]
          : [],
      );
    const remove = (path: string, extras: { attempt?: number }) => {
      this.calls.push(`remove ${path}`);
      if (this.dead) return;
      if (this.removeFails) {
        if (!noted().includes(path)) {
          append(
            {
              event: "gate_cleanup_failed",
              data: { dir: path, error: "the directory is still there" },
            },
            makeCause("gate", "gate-cleanup-failed", extras),
          );
        }
        return;
      }
      NodeFS.rmSync(path, { recursive: true, force: true });
    };
    const rmdirRoot = () => {
      try {
        NodeFS.rmdirSync(root);
      } catch {
        // Not empty.
      }
    };
    return Effect.suspend((): Effect.Effect<GateResult, GateError> => {
      NodeFS.mkdirSync(root, { recursive: true });
      // Leftovers of a call the server died in.
      for (const name of NodeFS.readdirSync(root).sort()) remove(NodePath.join(root, name), {});
      NodeFS.mkdirSync(dir, { recursive: true });
      NodeFS.writeFileSync(NodePath.join(dir, "checked-out"), input.head);
      this.calls.push(`checkout ${input.head} ${input.base} ${dir}`);
      this.onCheckout?.(input.base);
      if (this.checkoutFails) {
        if (!this.dead) NodeFS.rmSync(dir, { recursive: true, force: true });
        return Effect.fail(new WorkspaceSpawnError({ cause: new Error("died") }));
      }
      const head = this.checkoutHead(input.head);
      if (head.toLowerCase() !== input.head.toLowerCase()) {
        remove(dir, { attempt });
        return Effect.fail(
          new WorkspaceUnexpectedError({
            what: `the checkout is at ${head} but the pull request's head is ${input.head}`,
          }),
        );
      }
      append(
        { event: "gate_checkout", data: { attempt, dir, sha: input.head, base_sha: input.base } },
        makeCause("gate", "gate-checkout-made", { attempt }),
      );
      const merged = this.merge();
      if (merged._tag === "conflict") {
        append(
          {
            event: "gate_command",
            data: {
              attempt,
              command: "softfac: merge the base branch into the head",
              exit_code: 1,
              duration_ms: 0,
            },
          },
          makeCause("gate", "gate-merge-conflict", { attempt }),
        );
        remove(dir, { attempt });
        rmdirRoot();
        return Effect.succeed({ _tag: "conflict", dir, paths: merged.paths } satisfies GateResult);
      }
      const all = [...input.provision, ...input.gate];
      this.calls.push(`gate ${dir} ${all.join(", ")}`);
      const n = this.gateCalls;
      this.gateCalls += 1;
      if (this.failGateAt === n) {
        if (!this.dead) remove(dir, { attempt });
        return Effect.fail(
          new GateCommandSpawnError({ command: all[0]!, cause: new Error("no shell") }),
        );
      }
      const results = this.script(n, all);
      const ran: Array<CommandResult> = [];
      let gateCount = 0;
      let failure: CommandResult | null = null;
      for (const [i, res] of results.entries()) {
        ran.push(res);
        if (i >= input.provision.length) gateCount += 1;
        append(
          {
            event: "gate_command",
            data: {
              attempt,
              command: res.command,
              exit_code: res.exitCode,
              duration_ms: res.durationMs,
            },
          },
          makeCause("gate", "gate-command-ran", { command: res.command, attempt }),
        );
        if (res.exitCode !== 0 || res.timedOut) {
          failure = res;
          break;
        }
      }
      remove(dir, { attempt });
      rmdirRoot();
      return Effect.succeed(
        failure === null
          ? ({ _tag: "pass", dir, commands: ran, gateCount } satisfies GateResult)
          : ({ _tag: "fail", dir, commands: ran, failure, gateCount } satisfies GateResult),
      );
    });
  }
}

interface Rig {
  readonly dataDir: string;
  readonly run: RunId;
  readonly gh: FakeGh;
  readonly t3: FakeT3;
  readonly ws: FakeGate;
  project: ProjectConfig;
  feedbackSeconds: number;
  readonly clock: { now: number };
  ctx: FeedbackContext;
}

const projectConfig = (): ProjectConfig => {
  const config = timeLimitOnlyProjectConfig();
  return {
    ...config,
    instructors: ["rawphp"],
    base: "main",
    gate: [FMT, TEST],
    limits: { ...config.limits, minutes: 90, gateRetries: 2 },
  };
};

const seed = (dataDir: string, id: RunId, events: ReadonlyArray<RunEvent>) => {
  const ledger = Ledger.create(dataDir, id, { clock: () => T0 });
  try {
    for (const event of events) ledger.append(event, makeCause("start", "seed"));
  } finally {
    ledger.close();
  }
};

/** The machine's default `feedback_seconds`, which the rig's context starts with. */
const FEEDBACK_SECONDS = 600;

const rigFor = (events: ReadonlyArray<RunEvent> = STARTED): Rig => {
  const dataDir = tempDir();
  seed(dataDir, run10, events);
  const gh = new FakeGh();
  const t3 = new FakeT3(gh);
  const ws = new FakeGate();
  const clock = { now: T0 };
  const project = projectConfig();
  const rig: Rig = {
    dataDir,
    run: run10,
    gh,
    t3,
    ws,
    project,
    feedbackSeconds: FEEDBACK_SECONDS,
    clock,
    ctx: undefined as unknown as FeedbackContext,
  };
  rig.ctx = {
    repo: REPO,
    trackerUser: "rawphp",
    machine: "mac-mini",
    get project() {
      return rig.project;
    },
    dataDir,
    repoPath: "/p/softfac",
    ghConfigDir: "/gh/rawphp",
    tracker: gh.tracker,
    sessions: t3.sessions,
    gate: ws.gate,
    maxConcurrentGates: 2,
    get feedbackSeconds() {
      return rig.feedbackSeconds;
    },
    gateOptions: { clock: () => clock.now },
    clock: () => clock.now,
  };
  return rig;
};

const gateIn = (rig: Rig) => gate(rig.ctx, rig.run);
const advanceIn = (rig: Rig) => advance(interruptible(rig.ctx), rig.run);

/** The run's ledger lines, with the directory of each `gate_checkout` blanked. */
const linesOf = (rig: Rig, id: RunId = rig.run): Array<Line> =>
  readRun(rig.dataDir, id).entries.map(({ event, data }) =>
    event === "gate_checkout" && typeof data === "object" && data !== null
      ? { event, data: { ...(data as object), dir: "" } }
      : { event, data },
  );

const rawLines = (rig: Rig): Array<Line> =>
  readRun(rig.dataDir, rig.run).entries.map(({ event, data }) => ({ event, data }));

const bytesOf = (rig: Rig) => NodeFS.readFileSync(runPath(rig.dataDir, rig.run), "utf8");

const worktreeLines = (rig: Rig) =>
  rawLines(rig).filter(
    (l) => l.event === "worktree_removed" || l.event === "worktree_remove_failed",
  );

const clearCalls = (rig: Rig) => {
  rig.gh.calls.length = 0;
  rig.gh.reads.length = 0;
  rig.t3.calls.length = 0;
  rig.t3.launches.length = 0;
  rig.ws.calls.length = 0;
};

/** The thread's latest run is `ordinal`, in `status`, with the session's DONE message. */
const setRun = (rig: Rig, status: RunStatus, ordinal: number) => {
  rig.t3.status = () => statusOf(status, DONE_MESSAGE, { runOrdinal: ordinal });
};

const sends = (rig: Rig) => rig.t3.calls.filter((c) => c.startsWith("send "));

/** A started run whose finished session reported its draft PR, advanced to ready for the gate. */
const readyForGate = () =>
  Effect.gen(function* () {
    const rig = rigFor();
    setRun(rig, "completed", 1);
    const outcome = yield* advanceIn(rig);
    assert.strictEqual(outcome.kind, "ready-for-gate");
    clearCalls(rig);
    return rig;
  });

/** `cargo test` exits 101 with "boom" on its first `n` runs and passes after. */
const failFirst = (rig: Rig, n: number) => {
  rig.ws.script = (call, commands) =>
    call < n ? failingLast(commands, 101, "boom\n") : passing(commands);
};

/** Fails `retries` attempts into the session, with a new finished run each time; the lines they wrote. */
const sendBackAttempts = (rig: Rig, retries: number) =>
  Effect.gen(function* () {
    const middle: Array<Line> = [];
    for (let attempt = 1; attempt <= retries; attempt += 1) {
      setRun(rig, "completed", attempt);
      assert.strictEqual((yield* advanceIn(rig)).kind, "ready-for-gate");
      assert.deepStrictEqual(
        yield* gateIn(rig),
        { kind: "sent-back", attempt },
        `attempt ${attempt}`,
      );
      middle.push(
        ...failingAttempt(attempt),
        sending(attempt, attempt),
        sentBack(attempt, attempt),
      );
    }
    setRun(rig, "completed", retries + 1);
    assert.strictEqual((yield* advanceIn(rig)).kind, "ready-for-gate");
    return middle;
  });

const MOVED = "9f8e7d6c5b4a39281706f5e4d3c2b1a098765432";
const PUSHED = "7e6d5c4b3a291807f6e5d4c3b2a190817263a4b5";

/** The tips a base branch that keeps moving goes through, in order. */
const TIPS = [
  BASE,
  MOVED,
  "5a6b7c8d9e0f1a2b3c4d5e6f708192a3b4c5d6e7",
  "6b7c8d9e0f1a2b3c4d5e6f708192a3b4c5d6e7f8",
  "7c8d9e0f1a2b3c4d5e6f708192a3b4c5d6e7f809",
  "8d9e0f1a2b3c4d5e6f708192a3b4c5d6e7f80910",
];

/** The base branch moves on to its next tip each time a checkout merges with the current one. */
const baseMoves = (rig: Rig, steps: number) => {
  const cell = { tip: BASE };
  rig.gh.tipCell = cell;
  rig.ws.onCheckout = (base) => {
    const at = Math.max(0, TIPS.indexOf(base));
    if (at < steps) cell.tip = TIPS[at + 1]!;
  };
};
const regateIn = (rig: Rig) => regate(rig.ctx, rig.run);

/** A run whose gate passed at `BASE`: the pull request is ready, the issue is `pr-open` and the run is open. */
const prOpenRun = () =>
  Effect.gen(function* () {
    const rig = yield* readyForGate();
    assert.deepStrictEqual(yield* gateIn(rig), { kind: "passed", pr: 12 });
    clearCalls(rig);
    return rig;
  });

/** The pull request's head moved after the pass, and the base branch is `MOVED` now. */
const headAndBaseMoved = (rig: Rig) => {
  baseMoves(rig, 0);
  rig.gh.tipCell!.tip = MOVED;
  rig.gh.pr = { ...rig.gh.pr!, headSha: PUSHED };
};

/** The commands pass on the first run and fail on every later one. */
const passThenFail = (rig: Rig) => {
  rig.ws.script = (call, commands) =>
    call === 0 ? passing(commands) : failingLast(commands, 101, "boom\n");
};

const conflicting = (rig: Rig, paths: ReadonlyArray<string>) => {
  rig.ws.merge = () => ({ _tag: "conflict", paths });
};

const sameLine = (a: Line, b: Line) => NodeUtil.isDeepStrictEqual(a, b);
const hasLine = (rig: Rig, want: Line) => linesOf(rig).some((l) => sameLine(l, want));
const eventsOf = (rig: Rig, name: string) => linesOf(rig).filter((l) => l.event === name);

/** The `session_launched` line of the session that acts on feedback (or fixes a failed re-gate). */
const relaunchedLine: Line = {
  event: "session_launched",
  data: {
    thread_id: "thread-2",
    worktree: "/t3/wt2",
    branch: "t3code/def",
    model_instance: "claudeAgent",
    model: "claude-opus-5-5",
    model_options: null,
    resumed_from: { run: RUN, branch: "t3code/abc" },
    base: "main",
    title: "Build step",
  },
};

/** The threads T3 made that are not archived, `thread-1` first. */
const liveThreads = (rig: Rig) =>
  ["thread-1", ...rig.t3.made.values()].filter((t) => !rig.t3.archived.includes(t));

/** Appends `events` to the run's ledger as written at `ms`. */
const appendAt = (rig: Rig, ms: number, events: ReadonlyArray<Line>) => {
  const ledger = Ledger.open(rig.dataDir, rig.run, { clock: () => ms });
  try {
    for (const event of events) ledger.append(event as RunEvent, makeCause("gate", "seed"));
  } finally {
    ledger.close();
  }
};

const mergedPull = (): PullRequest => ({
  ...defaultPr(),
  open: false,
  merged: true,
  isDraft: false,
});

const feedbackIn = (rig: Rig) => feedback(rig.ctx, rig.run);
const NONE: FeedbackStep = { kind: "none" };
const relaunched = (items: number): FeedbackStep => ({ kind: "relaunched", pr: 12, items });

/** One second before `ms`, spelled out without the code under test. */
const secondBefore = (ms: number) =>
  `${DateTime.formatIso(DateTime.makeUnsafe(ms - 1_000)).slice(0, 19)}Z`;

/** The moment the fake's feedback is read from when the run reached `pr-open` at the rig's first instant. */
const SINCE_THE_PASS = secondBefore(T0);
const TEN_MINUTES = FEEDBACK_SECONDS * 1000;

/** The two reads a pass makes of the feedback from the starting point, paging the reviews back only to `floor`. */
const feedbackReads = (floor = SINCE_THE_PASS, since = SINCE_THE_PASS, instructors = "rawphp") => [
  `feedback 12 ${since} ${floor} ${instructors}`,
  `activity 10 ${since} ${instructors}`,
];

const inline = (path: string, line: number | null, body: string): InlineComment => ({
  path,
  line,
  body,
});

/** A review by an instructor that asks for changes, with an inline comment. */
const review11 = (): Feedback => ({
  id: "review:11",
  author: "rawphp",
  kind: { kind: "review", state: "CHANGES_REQUESTED" },
  createdAt: "2026-10-04T11:00:00Z",
  body: "Please rename it.",
  inline: [inline("src/a.rs", 7, "use a better name")],
  inlineUnread: 0,
});

const prComment = (id: number, createdAt: string, body: string): Feedback => ({
  id: `pr-comment:${id}`,
  author: "rawphp",
  kind: { kind: "pr-comment" },
  createdAt,
  body,
  inline: [],
  inlineUnread: 0,
});

const issueComment = (id: string, createdAt: string, body: string) => ({
  id,
  author: "rawphp",
  createdAt,
  body,
});

/** A `pr-open` run whose pull request has the review `review11` on it. */
const reviewedRun = () =>
  Effect.map(prOpenRun(), (rig) => {
    rig.gh.feedback.push(review11());
    return rig;
  });

const reviewBlock = () => feedbackMessage(URL12, [review11()]);

const decisions = (rig: Rig) =>
  eventsOf(rig, "feedback_relaunching").map((l) => {
    const data = l.data as { n: number; branch: string; items: Array<string>; message: string };
    return [data.n, data.branch, data.items, data.message] as const;
  });

const progressOf = (rig: Rig) => readProgress(readRun(rig.dataDir, rig.run).entries);

const deciding = (n: number, items: ReadonlyArray<string>): Line => ({
  event: "feedback_relaunching",
  data: { n, branch: "t3code/abc", items, message: "Feedback 1 of 1" },
});

/** What the run's last feedback read left in `<data dir>/feedback/<run id>.read`. */
const readTime = (rig: Rig) => NodeFS.readFileSync(feedbackReadFile(rig.dataDir, rig.run), "utf8");
const writeReadTime = (rig: Rig, text: string) => {
  NodeFS.mkdirSync(NodePath.join(rig.dataDir, "feedback"), { recursive: true });
  NodeFS.writeFileSync(feedbackReadFile(rig.dataDir, rig.run), text);
};

const isFeedbackRead = (call: string) =>
  call.startsWith("feedback ") || call.startsWith("activity ");

/** The run comes back to `pr-open` at `ms`: the feedback session finished, the gate ran again and passed, and the new session was stopped. */
const backToPrOpen = (rig: Rig, ms: number) => {
  rig.clock.now = ms;
  appendAt(rig, ms, [
    ...passingAttempt(1),
    PASSED_STEP,
    { event: "worktree_removed", data: { path: "/t3/wt2" } },
    moved("building", "pr-open"),
  ]);
};

/** The calls a feedback relaunch makes, from a run of its own. */
const referenceCalls = () =>
  Effect.gen(function* () {
    const rig = yield* reviewedRun();
    assert.deepStrictEqual(yield* feedbackIn(rig), relaunched(1));
    return { gh: [...rig.gh.calls], t3: [...rig.t3.calls] };
  });

/**
 * A feedback relaunch whose launch reached T3 but whose reply was lost (the server died after
 * it): the decision is in the ledger, the new thread may be running and nothing names it.
 */
const lostFeedbackLaunch = () =>
  Effect.gen(function* () {
    const rig = yield* reviewedRun();
    rig.t3.dieAfterLaunch = true;
    assert.isTrue(Exit.isFailure(yield* Effect.exit(feedbackIn(rig))));
    rig.t3.dieAfterLaunch = false;
    assert.strictEqual(rig.t3.launches.length, 1);
    assert.deepStrictEqual(liveThreads(rig), ["thread-2"]);
    assert.strictEqual(decisions(rig).length, 1);
    const message = rig.t3.launches[0]!.message;
    clearCalls(rig);
    return { rig, message };
  });

const finishedStatus =
  (ordinal: number, run: RunStatus = "completed") =>
  () =>
    statusOf(run, DONE_MESSAGE, { runOrdinal: ordinal, branch: "t3code/def" });

describe("feedback: the window", () => {
  it.effect("a failed regate does not move the start of the feedback window", () =>
    Effect.gen(function* () {
      const rig = yield* prOpenRun();
      const hour = 3_600_000;
      const first = progressOf(rig).prOpenSince;
      assert.strictEqual(first, T0);
      // The run is sent back to `building` by a failed re-gate at 2h, and passes again at 3h.
      appendAt(rig, T0 + 2 * hour, [moved("pr-open", "building")]);
      appendAt(rig, T0 + 3 * hour, [moved("building", "pr-open")]);
      assert.strictEqual(progressOf(rig).prOpenSince, first);
      // A review an instructor wrote at 1h, while the failing re-gate ran, is still new.
      rig.gh.feedback.push({ ...review11(), createdAt: "2026-10-04T11:13:16Z" });
      assert.deepStrictEqual(yield* feedbackIn(rig), relaunched(1));
      // It is named now, so it is not sent again; the window starts over after the relaunch.
      assert.strictEqual(decisions(rig).length, 1);
      assert.deepStrictEqual(decisions(rig)[0]![2], ["review:11"]);
      appendAt(rig, T0 + 4 * hour, [moved("building", "pr-open")]);
      assert.strictEqual(progressOf(rig).prOpenSince, T0 + 4 * hour);
      rig.clock.now = T0 + 5 * hour;
      clearCalls(rig);
      assert.deepStrictEqual(yield* feedbackIn(rig), NONE);
      const since = secondBefore(T0 + 4 * hour);
      assert.deepStrictEqual(rig.gh.calls, feedbackReads(since, since));
    }),
  );
});

describe("feedback: the step", () => {
  it.effect(
    "an issue comment forwarded or reported as dropped while building is not read as feedback",
    () =>
      Effect.gen(function* () {
        const rig = yield* prOpenRun();
        appendAt(rig, T0 + 1_000, [
          { event: "comment_forwarded", data: { comment_id: "42" } },
          step("comment-dropped 43"),
        ]);
        rig.gh.activity = {
          comments: [
            issueComment("42", "2026-10-04T11:00:00Z", "forwarded"),
            issueComment("43", "2026-10-04T11:01:00Z", "dropped"),
          ],
          bodyEdit: null,
          dropped: [],
        };
        assert.deepStrictEqual(yield* feedbackIn(rig), NONE);
        assert.deepStrictEqual(eventsOf(rig, "feedback_relaunching"), []);
        assert.deepStrictEqual(rig.t3.launches, []);
        // The filter is per id: a third comment in the same answer is relaunched alone.
        rig.gh.activity = {
          ...rig.gh.activity,
          comments: [
            ...rig.gh.activity.comments,
            issueComment("44", "2026-10-04T11:02:00Z", "new"),
          ],
        };
        rig.clock.now = T0 + TEN_MINUTES;
        assert.deepStrictEqual(yield* feedbackIn(rig), relaunched(1));
        assert.deepStrictEqual(
          decisions(rig).map((d) => d[2]),
          [["issue-comment:44"]],
        );
      }),
  );

  it.effect(
    "a run that reached pr-open before a pass removed worktrees has its old session stopped before the relaunch",
    () =>
      Effect.gen(function* () {
        const rig = yield* reviewedRun();
        // The ledger of a run from before worktrees were removed: no worktree line.
        const path = runPath(rig.dataDir, rig.run);
        const kept = NodeFS.readFileSync(path, "utf8")
          .split("\n")
          .filter((l) => l !== "" && !l.includes('"worktree_removed"'));
        NodeFS.writeFileSync(path, `${kept.join("\n")}\n`);
        assert.deepStrictEqual(worktreeLines(rig), []);
        assert.deepStrictEqual(yield* feedbackIn(rig), relaunched(1));
        assert.deepStrictEqual(
          rig.t3.calls.filter((c) => c.startsWith("archive ")),
          ["archive thread-1"],
        );
        const lines = linesOf(rig);
        const removed = lines.findIndex((l) => sameLine(l, worktreeRemoved));
        const decision = lines.findIndex((l) => l.event === "feedback_relaunching");
        assert.ok(removed >= 0 && removed < decision, `${removed} < ${decision}`);
        assert.deepStrictEqual(liveThreads(rig), ["thread-2"]);
      }),
  );

  it.effect("feedback forwarded into a paused session is not sent again by a relaunch", () =>
    Effect.gen(function* () {
      const rig = yield* reviewedRun();
      // While the run was `building` and paused, the review went into the session's thread.
      appendAt(rig, T0 + 1_000, [
        {
          event: "feedback_forwarding",
          data: { n: 1, run_ordinal: 1, items: ["review:11"], message: reviewBlock() },
        },
      ]);
      assert.deepStrictEqual(yield* feedbackIn(rig), NONE);
      assert.deepStrictEqual(decisions(rig), []);
      assert.deepStrictEqual(rig.t3.calls, []);
    }),
  );

  it.effect("no feedback leaves the run untouched", () =>
    Effect.gen(function* () {
      const rig = yield* prOpenRun();
      const bytes = bytesOf(rig);
      const world = structuredClone(rig.gh.world);
      assert.deepStrictEqual(yield* feedbackIn(rig), NONE);
      // Two reads, and nothing else: no write on GitHub, no call to T3, no gate.
      assert.deepStrictEqual(rig.gh.calls, feedbackReads());
      assert.deepStrictEqual(rig.gh.world, world);
      assert.deepStrictEqual(rig.t3.calls, []);
      assert.deepStrictEqual(rig.ws.calls, []);
      assert.strictEqual(bytesOf(rig), bytes);
      // And again, as every pass does.
      assert.deepStrictEqual(yield* feedbackIn(rig), NONE);
      assert.strictEqual(bytesOf(rig), bytes);
    }),
  );

  it.effect("feedback is read at most once every ten minutes per run", () =>
    Effect.gen(function* () {
      const rig = yield* prOpenRun();
      assert.deepStrictEqual(yield* feedbackIn(rig), NONE);
      assert.deepStrictEqual(rig.gh.calls, feedbackReads());
      assert.strictEqual(readTime(rig), `${T0}\n${T0}`);
      // A millisecond short of ten minutes later: no read, no write, nothing started.
      clearCalls(rig);
      const bytes = bytesOf(rig);
      rig.clock.now = T0 + TEN_MINUTES - 1;
      assert.deepStrictEqual(yield* feedbackIn(rig), NONE);
      assert.deepStrictEqual(rig.gh.calls, []);
      assert.deepStrictEqual(rig.t3.calls, []);
      assert.deepStrictEqual(rig.ws.calls, []);
      assert.strictEqual(bytesOf(rig), bytes);
      assert.strictEqual(readTime(rig), `${T0}\n${T0}`);
      // Ten minutes later it reads again, and records that read.
      rig.clock.now = T0 + TEN_MINUTES;
      assert.deepStrictEqual(yield* feedbackIn(rig), NONE);
      assert.deepStrictEqual(rig.gh.calls, feedbackReads());
      assert.strictEqual(readTime(rig), `${T0 + TEN_MINUTES}\n${T0 + TEN_MINUTES}`);
    }),
  );

  it.effect("feedback_seconds of 0 reads on every pass", () =>
    Effect.gen(function* () {
      const rig = yield* prOpenRun();
      rig.feedbackSeconds = 0;
      assert.deepStrictEqual(yield* feedbackIn(rig), NONE);
      assert.deepStrictEqual(rig.gh.calls, feedbackReads());
      clearCalls(rig);
      rig.clock.now = T0 + 60_000;
      assert.deepStrictEqual(yield* feedbackIn(rig), NONE);
      assert.deepStrictEqual(rig.gh.calls, feedbackReads());
      assert.strictEqual(readTime(rig), `${T0 + 60_000}\n${T0 + 60_000}`);
    }),
  );

  it.effect("feedback_seconds of 120 waits 120 seconds between reads", () =>
    Effect.gen(function* () {
      const rig = yield* prOpenRun();
      rig.feedbackSeconds = 120;
      assert.deepStrictEqual(yield* feedbackIn(rig), NONE);
      assert.deepStrictEqual(rig.gh.calls, feedbackReads());
      clearCalls(rig);
      rig.clock.now = T0 + 119_000;
      assert.deepStrictEqual(yield* feedbackIn(rig), NONE);
      assert.deepStrictEqual(rig.gh.calls, []);
      assert.strictEqual(readTime(rig), `${T0}\n${T0}`);
      rig.clock.now = T0 + 120_000;
      assert.deepStrictEqual(yield* feedbackIn(rig), NONE);
      assert.deepStrictEqual(rig.gh.calls, feedbackReads());
      assert.strictEqual(readTime(rig), `${T0 + 120_000}\n${T0 + 120_000}`);
    }),
  );

  it.effect("feedback that arrives between two reads waits for the next one", () =>
    Effect.gen(function* () {
      const rig = yield* reviewedRun();
      // The review is on the pull request, but the run was read a moment ago.
      writeReadTime(rig, `${T0}`);
      rig.clock.now = T0 + 60_000;
      assert.deepStrictEqual(yield* feedbackIn(rig), NONE);
      assert.deepStrictEqual(rig.gh.calls, []);
      assert.deepStrictEqual(rig.t3.launches, []);
      rig.clock.now = T0 + TEN_MINUTES;
      assert.deepStrictEqual(yield* feedbackIn(rig), relaunched(1));
    }),
  );

  it.effect("a read that fails also waits for the next one", () =>
    Effect.gen(function* () {
      const rig = yield* prOpenRun();
      rig.gh.failAt = 0;
      assert.isTrue(Exit.isFailure(yield* Effect.exit(feedbackIn(rig))));
      assert.strictEqual(readTime(rig), `${T0}`);
      rig.gh.failAt = null;
      clearCalls(rig);
      assert.deepStrictEqual(yield* feedbackIn(rig), NONE);
      assert.deepStrictEqual(rig.gh.calls, []);
    }),
  );

  it.effect(
    "a missing or unreadable time of the last read or a clock set back means the read is due",
    () =>
      Effect.gen(function* () {
        for (const [name, text] of [
          ["missing", null],
          ["garbage", "soon"],
          ["empty", ""],
          ["negative", "-5"],
          ["padded with zeros", "0001"],
          ["later than now", `${T0 + 1_000_000_000}`],
        ] as const) {
          const rig = yield* prOpenRun();
          if (text !== null) writeReadTime(rig, text);
          assert.deepStrictEqual(yield* feedbackIn(rig), NONE, name);
          assert.deepStrictEqual(rig.gh.calls, feedbackReads(), name);
          assert.strictEqual(readTime(rig), `${T0}\n${T0}`, name);
        }
      }),
  );

  it.effect("a time of the last read that cannot be written does not stop the read", () =>
    Effect.gen(function* () {
      const rig = yield* prOpenRun();
      // The directory the file goes in is a file.
      NodeFS.writeFileSync(NodePath.join(rig.dataDir, "feedback"), "");
      assert.deepStrictEqual(yield* feedbackIn(rig), NONE);
      assert.deepStrictEqual(rig.gh.calls, feedbackReads());
    }),
  );

  it.effect("a feedback directory nobody can write does not stop the read", () =>
    Effect.gen(function* () {
      // Root ignores the permission that makes this fail.
      if (process.getuid?.() === 0) return;
      const rig = yield* prOpenRun();
      const dir = NodePath.join(rig.dataDir, "feedback");
      NodeFS.mkdirSync(dir, { recursive: true });
      NodeFS.chmodSync(dir, 0o500);
      try {
        const first = yield* Effect.result(feedbackIn(rig));
        const calls = [...rig.gh.calls];
        // With no time recorded, the next pass reads again.
        clearCalls(rig);
        const second = yield* Effect.result(feedbackIn(rig));
        const again = [...rig.gh.calls];
        assert.strictEqual(first._tag, "Success");
        assert.deepStrictEqual(calls, feedbackReads());
        assert.strictEqual(second._tag, "Success");
        assert.deepStrictEqual(again, feedbackReads());
      } finally {
        NodeFS.chmodSync(dir, 0o700);
      }
    }),
  );

  it.effect("a read that finds nothing is where the next read stops paging", () =>
    Effect.gen(function* () {
      const rig = yield* prOpenRun();
      // The first read starts ten minutes after the run reached `pr-open`, and is clean.
      rig.clock.now = T0 + TEN_MINUTES;
      assert.deepStrictEqual(yield* feedbackIn(rig), NONE);
      assert.deepStrictEqual(rig.gh.calls, feedbackReads());
      assert.strictEqual(readTime(rig), `${T0 + TEN_MINUTES}\n${T0 + TEN_MINUTES}`);
      // The next read pages back only to a minute and a second before that read started.
      clearCalls(rig);
      rig.clock.now = T0 + 2 * TEN_MINUTES;
      assert.deepStrictEqual(yield* feedbackIn(rig), NONE);
      assert.deepStrictEqual(rig.gh.calls, feedbackReads(secondBefore(T0 + TEN_MINUTES - 60_000)));
      assert.strictEqual(readTime(rig), `${T0 + 2 * TEN_MINUTES}\n${T0 + 2 * TEN_MINUTES}`);
    }),
  );

  it.effect("a read that fails does not move the last clean read", () =>
    Effect.gen(function* () {
      const rig = yield* prOpenRun();
      rig.clock.now = T0 + TEN_MINUTES;
      assert.deepStrictEqual(yield* feedbackIn(rig), NONE);
      clearCalls(rig);
      rig.gh.failAt = 0;
      rig.clock.now = T0 + 2 * TEN_MINUTES;
      assert.isTrue(Exit.isFailure(yield* Effect.exit(feedbackIn(rig))));
      assert.strictEqual(readTime(rig), `${T0 + 2 * TEN_MINUTES}\n${T0 + TEN_MINUTES}`);
      rig.gh.failAt = null;
      clearCalls(rig);
      rig.clock.now = T0 + 3 * TEN_MINUTES;
      assert.deepStrictEqual(yield* feedbackIn(rig), NONE);
      assert.deepStrictEqual(rig.gh.calls, feedbackReads(secondBefore(T0 + TEN_MINUTES - 60_000)));
    }),
  );

  it.effect("a read that finds feedback is not a clean read", () =>
    Effect.gen(function* () {
      const rig = yield* reviewedRun();
      assert.deepStrictEqual(yield* feedbackIn(rig), relaunched(1));
      assert.strictEqual(readTime(rig), `${T0}`);
    }),
  );

  it.effect("a clean read from before the run reached pr-open is ignored", () =>
    Effect.gen(function* () {
      const rig = yield* prOpenRun();
      // The run reached `pr-open` at T0; the clean read was shortly before, in an earlier period.
      writeReadTime(rig, `${T0 - 100_000}\n${T0 - 50_000}`);
      rig.clock.now = T0 + TEN_MINUTES;
      assert.deepStrictEqual(yield* feedbackIn(rig), NONE);
      assert.deepStrictEqual(rig.gh.calls, feedbackReads());
    }),
  );

  it.effect("a garbled clean time means no clean read", () =>
    Effect.gen(function* () {
      for (const [name, text] of [
        ["garbage", "1\nsoon"],
        ["empty", "1\n"],
        ["none", "1"],
      ] as const) {
        const rig = yield* prOpenRun();
        writeReadTime(rig, text);
        rig.clock.now = T0 + TEN_MINUTES;
        assert.deepStrictEqual(yield* feedbackIn(rig), NONE, name);
        assert.deepStrictEqual(rig.gh.calls, feedbackReads(), name);
      }
    }),
  );

  it.effect("the time of a new read keeps the clean time on the next line", () =>
    Effect.gen(function* () {
      const rig = yield* prOpenRun();
      writeReadTime(rig, `${T0}\n${T0}`);
      // The read is due and fails, so only the first line moves.
      rig.gh.failAt = 0;
      rig.clock.now = T0 + TEN_MINUTES;
      assert.isTrue(Exit.isFailure(yield* Effect.exit(feedbackIn(rig))));
      assert.strictEqual(readTime(rig), `${T0 + TEN_MINUTES}\n${T0}`);
    }),
  );

  it.effect("a decided relaunch is finished within the ten minutes without a read", () =>
    Effect.gen(function* () {
      const { rig } = yield* lostFeedbackLaunch();
      // The decision's own call read the feedback a moment ago.
      assert.strictEqual(readTime(rig), `${T0}`);
      assert.deepStrictEqual(yield* feedbackIn(rig), relaunched(1));
      assert.strictEqual(readTime(rig), `${T0}`);
      assert.deepStrictEqual(rig.gh.calls.filter(isFeedbackRead), []);
      assert.strictEqual(rig.gh.world.state, "building");
    }),
  );

  it.effect(
    "after a feedback relaunch feedback is read from the pass the run came back to pr-open on",
    () =>
      Effect.gen(function* () {
        const rig = yield* prOpenRun();
        // The feedback session ran, and the gate passed again 5 000 s later.
        appendAt(rig, T0, [
          deciding(1, ["review:11"]),
          relaunchedLine,
          moved("pr-open", "building"),
        ]);
        backToPrOpen(rig, T0 + 5_000_000);
        clearCalls(rig);
        assert.deepStrictEqual(yield* feedbackIn(rig), NONE);
        // The window starts over at that pass, so what the feedback session posted as the
        // factory's login while it built is never read as new feedback and relaunched again.
        const since = secondBefore(T0 + 5_000_000);
        assert.deepStrictEqual(rig.gh.calls, feedbackReads(since, since));
      }),
  );

  it.effect(
    "an instructor review relaunches a session on the pr branch with its inline comments",
    () =>
      Effect.gen(function* () {
        const rig = yield* reviewedRun();
        assert.deepStrictEqual(yield* feedbackIn(rig), relaunched(1));
        // One launch from the pull request's branch at its tip on origin, under the feedback id.
        assert.strictEqual(rig.t3.launches.length, 1);
        const req = rig.t3.launches[0]!;
        assert.strictEqual(req.commandId, `softfac:${RUN}:feedback:1`);
        assert.strictEqual(req.baseRef, "t3code/abc");
        assert.strictEqual(req.pullRequestUrl, URL12);
        assert.ok(req.message.startsWith("/factory rawphp/softfac#10"), req.message);
        assert.ok(req.message.includes(URL12), req.message);
        assert.ok(req.message.includes("git push origin HEAD:t3code/abc"), req.message);
        assert.ok(req.message.includes("Do not open another pull request."), req.message);
        // The resume paragraph is the feedback one, not the failed re-gate's.
        assert.ok(
          req.message.includes("waits for review, and an instructor left feedback"),
          req.message,
        );
        assert.notInclude(req.message, "the gate failed when it ran again");
        // The feedback, path and line and text included, after the ordinary words.
        assert.ok(req.message.includes("Inline comment: src/a.rs:7\n"), req.message);
        assert.ok(req.message.includes("use a better name"), req.message);
        assert.ok(req.message.endsWith(`${END_WITH_DONE}\n\n${reviewBlock()}`), req.message);
        // The decision names the item and holds the block, and comes before the new session.
        assert.deepStrictEqual(decisions(rig), [[1, "t3code/abc", ["review:11"], reviewBlock()]]);
        const lines = linesOf(rig);
        const at = (want: Line) => lines.findIndex((l) => sameLine(l, want));
        const decision = lines.findIndex((l) => l.event === "feedback_relaunching");
        assert.ok(decision >= 0 && decision < at(relaunchedLine));
        // The state change is last, and no gate attempt or re-gate was written.
        assert.deepStrictEqual(lines.at(-1), moved("pr-open", "building"));
        for (const name of ["gate_sent_back", "gate_regate", "regate_relaunching"]) {
          assert.deepStrictEqual(eventsOf(rig, name), [], name);
        }
        // GitHub: the pull request a draft again, the issue ours and `building`, never `ready`.
        assert.deepStrictEqual(rig.gh.calls, [
          ...feedbackReads(),
          "pullRequest 12",
          "issue 10",
          UNCHANGED_READ,
          "markPrDraft 12",
          "assign 10 rawphp",
          "setState 10 building",
          `status 10 rawphp **Factory status:** building\n- Machine: mac-mini\n- Session: thread-2\n- PR: #12`,
        ]);
        const world = rig.gh.world;
        assert.strictEqual(world.state, "building");
        assert.isFalse(world.prReady);
        assert.deepStrictEqual(world.assignees, ["rawphp"]);
        // The old session was archived at the pass and is not touched; the new one is running.
        assert.deepStrictEqual(
          rig.t3.calls.filter((c) => c.startsWith("archive ")),
          [],
        );
        assert.deepStrictEqual(liveThreads(rig), ["thread-2"]);
        assert.deepStrictEqual(worktreeLines(rig), [worktreeRemoved]);
        // It is the same run: no new run file, and nothing was run on the gate.
        assert.strictEqual(NodeFS.readdirSync(NodePath.join(rig.dataDir, RUNS_DIR)).length, 1);
        assert.deepStrictEqual(rig.ws.calls, []);
      }),
  );

  it.effect(
    "a review a conversation comment and an issue comment make one relaunch in time order",
    () =>
      Effect.gen(function* () {
        const rig = yield* reviewedRun();
        rig.gh.feedback[0] = { ...rig.gh.feedback[0]!, createdAt: "2026-10-04T12:00:00Z" };
        rig.gh.feedback.push(prComment(21, "2026-10-04T11:00:00Z", "pr first"));
        rig.gh.activity = {
          comments: [issueComment("42", "2026-10-04T13:00:00Z", "issue last")],
          bodyEdit: null,
          dropped: [],
        };
        assert.deepStrictEqual(yield* feedbackIn(rig), relaunched(3));
        assert.strictEqual(rig.t3.launches.length, 1, "one relaunch, however many items arrived");
        assert.deepStrictEqual(decisions(rig)[0]![2], [
          "pr-comment:21",
          "review:11",
          "issue-comment:42",
        ]);
        const message = rig.t3.launches[0]!.message;
        assert.ok(message.includes("Feedback 1 of 3\nAuthor: rawphp\nKind: pull request comment"));
        assert.ok(
          message.includes("Feedback 2 of 3\nAuthor: rawphp\nKind: review, changes requested"),
        );
        assert.ok(message.includes("Feedback 3 of 3\nAuthor: rawphp\nKind: issue comment"));
      }),
  );

  it.effect("the feedback is asked of the instructors only", () =>
    Effect.gen(function* () {
      const rig = yield* prOpenRun();
      rig.project = { ...rig.project, instructors: ["rawphp", "tom"] };
      yield* feedbackIn(rig);
      assert.deepStrictEqual(
        rig.gh.calls,
        feedbackReads(SINCE_THE_PASS, SINCE_THE_PASS, "rawphp,tom"),
      );
    }),
  );

  it.effect("an item that was sent is not sent again and neither is an edited one", () =>
    Effect.gen(function* () {
      const rig = yield* reviewedRun();
      rig.gh.activity = {
        comments: [issueComment("42", "2026-10-04T13:00:00Z", "issue")],
        bodyEdit: null,
        dropped: [],
      };
      yield* feedbackIn(rig);
      // The session did its work and the gate passed again: the run is back in `pr-open`.
      backToPrOpen(rig, T0 + 5_000);
      // The same items are still on GitHub, one of them edited since.
      rig.gh.feedback[0] = { ...rig.gh.feedback[0]!, body: "Edited: never mind" };
      rig.gh.activity = {
        comments: [issueComment("42", "2026-10-04T13:00:00Z", "edited issue comment")],
        bodyEdit: null,
        dropped: [],
      };
      clearCalls(rig);
      const bytes = bytesOf(rig);
      // Each read is ten minutes after the one before.
      rig.clock.now = T0 + 5_000 + TEN_MINUTES;
      assert.deepStrictEqual(yield* feedbackIn(rig), NONE);
      assert.deepStrictEqual(rig.t3.launches, []);
      assert.strictEqual(bytesOf(rig), bytes);
      // A new item is sent, alone, as the second relaunch.
      rig.clock.now = T0 + 5_000 + 2 * TEN_MINUTES;
      rig.gh.feedback.push(prComment(30, "2026-10-04T14:00:00Z", "one more"));
      assert.deepStrictEqual(yield* feedbackIn(rig), relaunched(1));
      assert.strictEqual(rig.t3.launches[0]!.commandId, `softfac:${RUN}:feedback:2`);
      const decided = decisions(rig);
      assert.strictEqual(decided.length, 2);
      assert.strictEqual(decided[1]![0], 2);
      assert.deepStrictEqual(decided[1]![2], ["pr-comment:30"]);
    }),
  );

  it.effect("a crash after the decision sends the launch again under the same command id", () =>
    Effect.gen(function* () {
      const { rig, message } = yield* lostFeedbackLaunch();
      const before = decisions(rig);
      assert.deepStrictEqual(yield* feedbackIn(rig), relaunched(1));
      // The decision is not written again, and nothing is read before it is carried out.
      assert.deepStrictEqual(decisions(rig), before);
      assert.deepStrictEqual(rig.gh.calls.filter(isFeedbackRead), []);
      assert.strictEqual(rig.t3.launches.length, 1);
      assert.strictEqual(rig.t3.launches[0]!.commandId, `softfac:${RUN}:feedback:1`);
      assert.strictEqual(rig.t3.launches[0]!.message, message);
      // The thread T3 made is the one the ledger names, and the run is `building`.
      assert.ok(hasLine(rig, relaunchedLine));
      assert.deepStrictEqual(linesOf(rig).at(-1), moved("pr-open", "building"));
      assert.strictEqual(rig.gh.world.state, "building");
      assert.deepStrictEqual(liveThreads(rig), ["thread-2"]);
      assert.strictEqual(rig.t3.made.size, 1, "T3 starts one thread for the two launch calls");
      assert.deepStrictEqual(rig.ws.calls, []);
    }),
  );

  it.effect(
    "a launch that is cut short after the session is recorded is finished without a second launch",
    () =>
      Effect.gen(function* () {
        const reference = yield* referenceCalls();
        const rig = yield* reviewedRun();
        rig.gh.failAt = reference.gh.indexOf("markPrDraft 12");
        assert.isTrue(Exit.isFailure(yield* Effect.exit(feedbackIn(rig))));
        assert.strictEqual(rig.t3.launches.length, 1);
        assert.deepStrictEqual(linesOf(rig).at(-1), relaunchedLine);
        rig.gh.failAt = null;
        clearCalls(rig);
        assert.deepStrictEqual(yield* feedbackIn(rig), relaunched(1));
        assert.deepStrictEqual(rig.t3.launches, [], "the session is not launched again");
        assert.deepStrictEqual(rig.gh.calls.filter(isFeedbackRead), []);
        assert.deepStrictEqual(linesOf(rig).at(-1), moved("pr-open", "building"));
        assert.strictEqual(rig.gh.world.state, "building");
        assert.strictEqual(decisions(rig).length, 1);
      }),
  );

  it.effect(
    "a rate limit between the ledger and the tracker write is finished by the next call",
    () =>
      Effect.gen(function* () {
        const reference = yield* referenceCalls();
        const rig = yield* reviewedRun();
        rig.gh.failAt = reference.gh.indexOf("markPrDraft 12");
        rig.gh.rateLimited = true;
        const error = yield* Effect.flip(feedbackIn(rig));
        assert.strictEqual(error._tag, "GitHubRateLimited");
        // The decision and the new session are in the ledger; the move to `building` is not.
        assert.strictEqual(rig.t3.launches.length, 1);
        assert.deepStrictEqual(linesOf(rig).at(-1), relaunchedLine);
        assert.strictEqual(rig.gh.world.state, "pr-open");
        rig.gh.failAt = null;
        rig.gh.rateLimited = false;
        clearCalls(rig);
        assert.deepStrictEqual(yield* feedbackIn(rig), relaunched(1));
        // Finished without a second launch, and the ledger and the tracker agree.
        assert.deepStrictEqual(rig.t3.launches, [], "the session is not launched again");
        assert.deepStrictEqual(linesOf(rig).at(-1), moved("pr-open", "building"));
        assert.strictEqual(rig.gh.world.state, "building");
        assert.strictEqual(decisions(rig).length, 1);
      }),
  );

  it.effect("a feedback relaunch survives a failure of each call", () =>
    Effect.gen(function* () {
      const reference = yield* reviewedRun();
      const want = relaunched(1);
      assert.deepStrictEqual(yield* feedbackIn(reference), want);
      const nGh = reference.gh.calls.length;
      // T3 answers a launch it refuses in-process, after the request went out: that is final
      // (the issue goes stuck), and a launch that dies is the crash of the test above.
      const t3Calls = reference.t3.calls.filter((c) => !c.startsWith("launch "));
      assert.ok(nGh >= 8 && t3Calls.length >= 1, `${nGh} ${t3Calls.length}`);
      const crashes: Array<{
        readonly gh?: number;
        readonly kept?: boolean;
        readonly t3?: number;
      }> = [];
      for (let call = 0; call < nGh; call += 1) {
        crashes.push({ gh: call, kept: false }, { gh: call, kept: true });
      }
      for (let call = 0; call < t3Calls.length; call += 1) crashes.push({ t3: call });
      for (const crash of crashes) {
        const label = JSON.stringify(crash);
        const rig = yield* reviewedRun();
        if (crash.gh !== undefined) {
          rig.gh.failAt = crash.gh;
          rig.gh.loseResponse = crash.kept === true;
        }
        if (crash.t3 !== undefined) rig.t3.failAt = crash.t3;
        assert.isTrue(Exit.isFailure(yield* Effect.exit(feedbackIn(rig))), `${label}: should fail`);
        rig.gh.failAt = null;
        rig.gh.loseResponse = false;
        rig.t3.failAt = null;
        // A read that failed waits ten minutes before it is made again.
        rig.clock.now = T0 + TEN_MINUTES;
        assert.deepStrictEqual(yield* feedbackIn(rig), want, label);
        assert.deepStrictEqual(rig.gh.world, reference.gh.world, label);
        assert.deepStrictEqual(linesOf(rig), linesOf(reference), label);
        assert.deepStrictEqual(liveThreads(rig), ["thread-2"], label);
        const ids = rig.t3.launches.map((l) => l.commandId);
        assert.ok(
          ids.every((id) => id === ids[0]),
          `${label}: ${ids.join(", ")}`,
        );
      }
    }),
  );

  it.effect("regate leaves a pending feedback relaunch to the feedback step", () =>
    Effect.gen(function* () {
      const { rig, message } = yield* lostFeedbackLaunch();
      const ran = rig.ws.gateCalls;
      const bytes = bytesOf(rig);
      assert.deepStrictEqual((yield* regateIn(rig)).step, { kind: "not-ready" });
      assert.strictEqual(rig.ws.gateCalls, ran, "nothing is gated");
      assert.strictEqual(bytesOf(rig), bytes, "nothing is written");
      assert.deepStrictEqual(rig.t3.launches, []);
      assert.deepStrictEqual(rig.ws.calls, []);
      // The feedback step sends the launch again under the same command id and finishes it.
      const step = yield* feedbackIn(rig);
      assert.strictEqual(step.kind, "relaunched");
      assert.strictEqual(rig.t3.launches.length, 1);
      assert.strictEqual(rig.t3.launches[0]!.commandId, `softfac:${RUN}:feedback:1`);
      assert.strictEqual(rig.t3.launches[0]!.message, message);
      assert.deepStrictEqual(linesOf(rig).at(-1), moved("pr-open", "building"));
    }),
  );

  it.effect(
    "regate leaves a feedback relaunch whose session is recorded to the feedback step",
    () =>
      Effect.gen(function* () {
        const reference = yield* referenceCalls();
        const rig = yield* reviewedRun();
        rig.gh.failAt = reference.gh.indexOf("markPrDraft 12");
        assert.isTrue(Exit.isFailure(yield* Effect.exit(feedbackIn(rig))));
        rig.gh.failAt = null;
        clearCalls(rig);
        headAndBaseMoved(rig);
        const bytes = bytesOf(rig);
        assert.deepStrictEqual((yield* regateIn(rig)).step, { kind: "not-ready" });
        assert.strictEqual(bytesOf(rig), bytes, "nothing is written");
        assert.deepStrictEqual(rig.t3.launches, []);
        assert.deepStrictEqual(rig.ws.calls, [], "a moved head is not gated meanwhile");
        // Only the transition is left, and the feedback step makes it.
        assert.strictEqual((yield* feedbackIn(rig)).kind, "relaunched");
        assert.deepStrictEqual(rig.t3.launches, []);
        assert.deepStrictEqual(linesOf(rig).at(-1), moved("pr-open", "building"));
      }),
  );

  it.effect("a feedback relaunch that is not finished is never read as unchanged by the pass", () =>
    Effect.gen(function* () {
      const rig = yield* prOpenRun();
      assert.notStrictEqual(yield* lastPass(rig.dataDir, rig.run), null);
      appendAt(rig, T0, [deciding(1, ["review:11"])]);
      assert.strictEqual(yield* lastPass(rig.dataDir, rig.run), null, "decided");
      appendAt(rig, T0, [relaunchedLine]);
      assert.strictEqual(yield* lastPass(rig.dataDir, rig.run), null, "launched, not committed");
    }),
  );

  it.effect("a changed issue text sends the run stuck and nothing is launched", () =>
    Effect.gen(function* () {
      const rig = yield* reviewedRun();
      rig.gh.unchanged.push(false);
      assert.deepStrictEqual(yield* feedbackIn(rig), {
        kind: "stuck",
        reason: CHANGED_DURING_BUILD_TEXT,
      });
      assert.deepStrictEqual(rig.t3.launches, []);
      assert.deepStrictEqual(decisions(rig), []);
      assert.strictEqual(progressOf(rig).feedbackSent.size, 0);
      const world = rig.gh.world;
      assert.strictEqual(world.state, "stuck");
      assert.isFalse(world.prReady, "the pull request is a draft again");
      assert.ok(rig.gh.calls.includes("markPrDraft 12"));
      assert.isTrue(progressOf(rig).finished);
    }),
  );

  it.effect("a merged pull request ends the run and the feedback is not sent", () =>
    Effect.gen(function* () {
      const rig = yield* reviewedRun();
      rig.gh.pr = mergedPull();
      assert.deepStrictEqual(yield* feedbackIn(rig), { kind: "ended" });
      assert.deepStrictEqual(rig.t3.launches, []);
      assert.deepStrictEqual(decisions(rig), []);
      const end = linesOf(rig).at(-1)!;
      assert.strictEqual(end.event, "finished");
      assert.strictEqual((end.data as { outcome: string }).outcome, "pr-open");
      assert.strictEqual((end.data as { pr_end: string }).pr_end, "merged");
      // Nothing was written on GitHub.
      assert.strictEqual(rig.gh.world.state, "pr-open");
    }),
  );

  it.effect("a closed pull request ends the run too", () =>
    Effect.gen(function* () {
      const rig = yield* reviewedRun();
      rig.gh.pr = { ...defaultPr(), open: false };
      assert.deepStrictEqual(yield* feedbackIn(rig), { kind: "ended" });
      assert.strictEqual((linesOf(rig).at(-1)!.data as { pr_end: string }).pr_end, "closed");
      assert.deepStrictEqual(rig.t3.launches, []);
    }),
  );

  it.effect("a closed issue is a persons move and the feedback is not sent", () =>
    Effect.gen(function* () {
      const rig = yield* reviewedRun();
      rig.gh.closed = true;
      assert.deepStrictEqual(yield* feedbackIn(rig), { kind: "abandoned" });
      assert.deepStrictEqual(rig.t3.launches, []);
      assert.deepStrictEqual(decisions(rig), []);
      assert.isTrue(progressOf(rig).finished);
    }),
  );

  it.effect("a branch that is not a plain name is not passed to a session", () =>
    Effect.gen(function* () {
      const rig = yield* reviewedRun();
      rig.gh.pr = { ...defaultPr(), headRef: "x; rm -rf ~" };
      assert.deepStrictEqual(yield* feedbackIn(rig), {
        kind: "stuck",
        reason: "the pull request's branch is not a plain branch name",
      });
      assert.deepStrictEqual(rig.t3.launches, []);
      assert.deepStrictEqual(decisions(rig), []);
      assert.strictEqual(rig.gh.world.state, "stuck");
    }),
  );

  it.effect("a refused launch goes stuck and says the feedback command id", () =>
    Effect.gen(function* () {
      const rig = yield* reviewedRun();
      rig.t3.project = null;
      const step = yield* feedbackIn(rig);
      assert.strictEqual(step.kind, "stuck");
      const reason = step.kind === "stuck" ? step.reason : "";
      // Raised before any request went out, so no session is feared.
      assert.ok(!reason.includes(SESSION_MAY_EXIST), reason);
      assert.strictEqual(rig.gh.world.state, "stuck");
    }),
  );

  it.effect("a refused resend says a session may exist under the feedback command id", () =>
    Effect.gen(function* () {
      const { rig } = yield* lostFeedbackLaunch();
      rig.t3.project = null;
      const step = yield* feedbackIn(rig);
      assert.strictEqual(step.kind, "stuck");
      const reason = step.kind === "stuck" ? step.reason : "";
      assert.ok(reason.includes(SESSION_MAY_EXIST), reason);
      assert.ok(reason.includes(`(launch command id softfac:${RUN}:feedback:1)`), reason);
    }),
  );

  it.effect("a run that is not waiting in pr-open is left alone", () =>
    Effect.gen(function* () {
      // Building, with a session: the feedback step does nothing and asks GitHub nothing.
      const building = rigFor();
      assert.deepStrictEqual(yield* feedbackIn(building), NONE);
      assert.deepStrictEqual(building.gh.calls, []);
      // Finished.
      const rig = yield* prOpenRun();
      const ledger = Ledger.open(rig.dataDir, rig.run, { clock: () => T0 + 2_000 });
      ledger.finish("pr-open", null, null, makeCause("gate", "seed"));
      ledger.close();
      rig.gh.feedback.push(review11());
      clearCalls(rig);
      assert.deepStrictEqual(yield* feedbackIn(rig), NONE);
      assert.deepStrictEqual(rig.gh.calls, []);
    }),
  );

  it.effect("a run of another repo is an error and nothing is touched", () =>
    Effect.gen(function* () {
      const rig = yield* reviewedRun();
      const error = yield* Effect.flip(feedback({ ...rig.ctx, repo: "acme/widgets" }, rig.run));
      assert.strictEqual(error._tag, "WrongRepoError");
      assert.deepStrictEqual(rig.gh.calls, []);
    }),
  );

  it.effect("a re-gate in progress is left to the gate", () =>
    Effect.gen(function* () {
      const rig = yield* reviewedRun();
      headAndBaseMoved(rig);
      passThenFail(rig);
      // A re-gate begun and cut short: its `gate_regate` line is in the ledger.
      appendAt(rig, T0, [regateLine(BASE, MOVED)]);
      clearCalls(rig);
      assert.deepStrictEqual(yield* feedbackIn(rig), NONE);
      assert.deepStrictEqual(rig.gh.calls, []);
      assert.deepStrictEqual(rig.t3.launches, []);
    }),
  );

  /** A pr-open run with feedback on it whose re-gate failed and decided a relaunch that was cut short where `cut` says. */
  const cutRegateRelaunch = (cut: (rig: Rig) => void) =>
    Effect.gen(function* () {
      const rig = yield* reviewedRun();
      headAndBaseMoved(rig);
      passThenFail(rig);
      cut(rig);
      assert.isTrue(Exit.isFailure(yield* Effect.exit(regateIn(rig))));
      rig.t3.dieAfterLaunch = false;
      rig.gh.markDraftFails = false;
      assert.strictEqual(eventsOf(rig, "regate_relaunching").length, 1);
      clearCalls(rig);
      return rig;
    });

  it.effect("a pending re-gate relaunch holds feedback back without a re-gate on record", () =>
    Effect.gen(function* () {
      const rig = yield* reviewedRun();
      appendAt(rig, T0, [
        {
          event: "regate_relaunching",
          data: { attempt: 2, branch: "t3code/abc", message: "boom" },
        },
      ]);
      const seen = progressOf(rig);
      assert.isFalse(seen.regating, "only the relaunch holds the step back");
      assert.strictEqual(seen.relaunch?.fixes.kind, "regate");
      clearCalls(rig);
      const bytes = bytesOf(rig);
      assert.deepStrictEqual(yield* feedbackIn(rig), NONE);
      assert.deepStrictEqual(rig.gh.calls, []);
      assert.deepStrictEqual(rig.t3.launches, []);
      assert.strictEqual(bytesOf(rig), bytes, "nothing is written");
    }),
  );

  it.effect("a re-gate relaunch with no session recorded is left to the gate", () =>
    Effect.gen(function* () {
      const rig = yield* cutRegateRelaunch((r) => {
        r.t3.dieAfterLaunch = true;
      });
      assert.strictEqual(eventsOf(rig, "session_launched").length, 1, "only the first session");
      const bytes = bytesOf(rig);
      const launches = rig.t3.launches.length;
      assert.deepStrictEqual(yield* feedbackIn(rig), NONE);
      assert.deepStrictEqual(rig.gh.calls, []);
      assert.strictEqual(rig.t3.launches.length, launches, "no second session");
      assert.strictEqual(bytesOf(rig), bytes, "nothing is written");
    }),
  );

  it.effect("a re-gate relaunch whose session is recorded is left to the gate", () =>
    Effect.gen(function* () {
      const rig = yield* cutRegateRelaunch((r) => {
        r.gh.markDraftFails = true;
      });
      assert.strictEqual(
        eventsOf(rig, "session_launched").length,
        2,
        "the new session is recorded",
      );
      const bytes = bytesOf(rig);
      const launches = rig.t3.launches.length;
      assert.deepStrictEqual(yield* feedbackIn(rig), NONE);
      assert.deepStrictEqual(rig.gh.calls, []);
      assert.strictEqual(rig.t3.launches.length, launches, "no second session");
      assert.strictEqual(bytesOf(rig), bytes, "nothing is written");
    }),
  );

  it.effect(
    "a feedback relaunch is no gate attempt and the session is waited for like any other",
    () =>
      Effect.gen(function* () {
        const rig = yield* reviewedRun();
        const before = progressOf(rig);
        yield* feedbackIn(rig);
        const seen = progressOf(rig);
        assert.strictEqual(nextGateAttempt(seen), nextGateAttempt(before));
        assert.strictEqual(seen.feedbackRelaunches, 1);
        // The new session is waited for, and its `FACTORY-DONE` binds the same pull request.
        clearCalls(rig);
        rig.t3.status = finishedStatus(1, "running");
        assert.deepStrictEqual(yield* advanceIn(rig), { kind: "running" });
        rig.t3.status = finishedStatus(1);
        const outcome = yield* advanceIn(rig);
        assert.strictEqual(outcome.kind, "ready-for-gate");
        // The same pull request is reported again for the gate, and kept once.
        assert.strictEqual(eventsOf(rig, "pr_opened").length, 2);
        assert.deepStrictEqual(progressOf(rig).opened, [12]);
        assert.strictEqual(progressOf(rig).prReported, true);
      }),
  );

  it.effect("a conflict after a pass and a feedback relaunch gets the full send-back budget", () =>
    Effect.gen(function* () {
      const rig = yield* readyForGate();
      rig.project = { ...rig.project, limits: { ...rig.project.limits, gateRetries: 2 } };
      failFirst(rig, 2);
      // Attempts 1 and 2 fail and go back; attempt 3 passes.
      yield* sendBackAttempts(rig, 2);
      assert.deepStrictEqual(yield* gateIn(rig), { kind: "passed", pr: 12 });
      assert.strictEqual(progressOf(rig).pass?.attempt, 3);
      // Instructor feedback relaunches a session, which finishes.
      rig.gh.feedback.push(review11());
      assert.strictEqual((yield* feedbackIn(rig)).kind, "relaunched");
      rig.t3.status = finishedStatus(1);
      assert.strictEqual((yield* advanceIn(rig)).kind, "ready-for-gate");
      // The next gate conflicts: the pass started the budget again, so it is sent back as attempt 4.
      conflicting(rig, ["src/a.rs"]);
      assert.deepStrictEqual(yield* gateIn(rig), { kind: "sent-back", attempt: 4 });
      assert.strictEqual(rig.gh.world.state, "building");
    }),
  );

  it.effect("the time limit counts from the relaunch", () =>
    Effect.gen(function* () {
      const rig = yield* reviewedRun();
      // The pull request waited for review for a long time.
      const waited = T0 + 200 * 60_000;
      rig.clock.now = waited;
      yield* feedbackIn(rig);
      assert.deepStrictEqual(yield* timeLimit(rig.ctx, rig.run), { kind: "within" });
      rig.clock.now = waited + 89 * 60_000;
      assert.deepStrictEqual(yield* timeLimit(rig.ctx, rig.run), { kind: "within" });
      rig.clock.now = waited + 91 * 60_000;
      assert.strictEqual((yield* timeLimit(rig.ctx, rig.run)).kind, "stopped");
      assert.strictEqual(rig.gh.world.state, "stuck");
    }),
  );

  it.effect("forward does not send an issue comment again that went as feedback", () =>
    Effect.gen(function* () {
      const rig = yield* reviewedRun();
      rig.gh.activity = {
        comments: [issueComment("42", "2026-10-04T13:00:00Z", "update the docs")],
        bodyEdit: null,
        dropped: [],
      };
      yield* feedbackIn(rig);
      clearCalls(rig);
      // The run is `building` again and `activitySince` still lists the comment.
      const out = yield* forward(rig.ctx, rig.run);
      assert.deepStrictEqual([out.comments, out.bodyEdit, out.skipped], [0, false, null]);
      assert.deepStrictEqual(sends(rig), []);
      // A comment that was not feedback is still sent.
      rig.gh.activity = {
        ...rig.gh.activity,
        comments: [
          ...rig.gh.activity.comments,
          issueComment("43", "2026-10-04T14:00:00Z", "and the changelog"),
        ],
      };
      assert.strictEqual((yield* forward(rig.ctx, rig.run)).comments, 1);
    }),
  );
});

describe("feedback: a run whose launch recorded a base other than the project's", () => {
  const onFeature = STARTED.map((event) =>
    event.event === "session_launched"
      ? { ...event, data: { ...event.data, base: "feature/x" } }
      : event,
  );

  it.effect("relaunches on that base, records it, and the next gate reads that base's tip", () =>
    Effect.gen(function* () {
      const rig = rigFor(onFeature);
      rig.project = runProject(rig.project, progressOf(rig).base);
      assert.strictEqual(rig.project.base, "feature/x");
      rig.gh.pr = { ...defaultPr(), baseRef: "feature/x" };
      setRun(rig, "completed", 1);
      assert.strictEqual((yield* advanceIn(rig)).kind, "ready-for-gate");
      assert.deepStrictEqual(yield* gateIn(rig), { kind: "passed", pr: 12 });
      rig.gh.feedback.push(review11());
      assert.deepStrictEqual(yield* feedbackIn(rig), relaunched(1));
      assert.deepStrictEqual(
        eventsOf(rig, "session_launched").map((l) => (l.data as { base: string }).base),
        ["feature/x", "feature/x"],
      );
      assert.strictEqual(progressOf(rig).base, "feature/x");
      // The relaunched session's work is gated against the run's base, not the project's.
      setRun(rig, "completed", 2);
      assert.strictEqual((yield* advanceIn(rig)).kind, "ready-for-gate");
      clearCalls(rig);
      assert.deepStrictEqual(yield* gateIn(rig), { kind: "passed", pr: 12 });
      assert.ok(rig.gh.calls.includes("branchTip feature/x"), rig.gh.calls.join("\n"));
      assert.ok(!rig.gh.calls.includes("branchTip main"), rig.gh.calls.join("\n"));
    }),
  );
});
