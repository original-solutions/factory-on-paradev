/**
 * The launch reaper (`launchTimeout.ts`): a run still starting whose launch recorded no thread id
 * within `launch_timeout_seconds` is failed, its slot freed and its issue put back to
 * `factory:ready`, until `launch_timeout_retries` are used and it goes `factory:stuck`. A stop by
 * hand of such a run is carried out here too. Over real run files, with a scripted tracker and T3.
 */
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { describe } from "vitest";

import {
  DEFAULT_LAUNCH_TIMEOUT_RETRIES,
  DEFAULT_LAUNCH_TIMEOUT_SECONDS,
  parseMachineConfig,
} from "../config.ts";
import type { State } from "../domain/lifecycle.ts";
import { makeCause, type RunEvent } from "../ledger/events.ts";
import { Ledger } from "../ledger/ledger.ts";
import { holdsSlot, listUnfinishedRuns } from "../ledger/listRuns.ts";
import { readRun } from "../ledger/read.ts";
import type { RunId } from "../ledger/runId.ts";
import { T0, useTempDirs } from "../ledger/testSupport.ts";
import { SessionsError, ThreadNotFoundError, type Thread } from "../sessions.ts";
import { GitHubFailed, type IssueDetail } from "../tracker/github.ts";
import {
  LAUNCH_STOPPED_REASON,
  LAUNCH_TIMEOUT_REASON,
  reapLaunch,
  type LaunchTimeoutContext,
} from "./launchTimeout.ts";
import { readProgress } from "./progress.ts";
import { launchCommandId } from "./start.ts";

const tempDir = useTempDirs();

const REPO = "rawphp/softfac";
const runOf = (attempt: number): RunId => ({ repo: REPO, issue: "10", attempt });
const MINUTE = 60_000;
const SECOND = 1000;

const step = (text: string): RunEvent => ({ event: "step_changed", data: { step: text } });
const moved = (from: State, to: State): RunEvent => ({
  event: "state_changed",
  data: { from, to },
});
const LAUNCHED: RunEvent = {
  event: "session_launched",
  data: {
    thread_id: "thread-1",
    worktree: "/t3/wt",
    branch: "t3code/abc",
    model_instance: null,
    model: null,
    model_options: null,
    resumed_from: null,
  },
};
const STOP_LINE: RunEvent = { event: "stop_requested", data: { by: "operator" } };
const FINISHED: RunEvent = {
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

/** The claim of a run, approved: what every run here starts with. */
const CLAIMED: ReadonlyArray<RunEvent> = [
  step("approved 2026-10-04T10:00:00Z"),
  { event: "claimed", data: { machine: "mac-mini", github_user: "rawphp" } },
  moved("ready", "triage"),
];

/** A run stuck in `launch-sending` with no thread id: the claim, then the step, all at `T0`. */
const SENDING: ReadonlyArray<RunEvent> = [...CLAIMED, step("launch-sending")];

const seed = (dataDir: string, run: RunId, events: ReadonlyArray<RunEvent>, at = T0) => {
  const ledger = Ledger.create(dataDir, run, { clock: () => at });
  try {
    for (const event of events) ledger.append(event, makeCause("start", "seed"));
  } finally {
    ledger.close();
  }
};

const issueDetail = (state: State | null, closed = false): IssueDetail => ({
  number: 10,
  title: "Build step",
  body: "Build the runner.",
  labels: state === null ? [] : [`factory:${state}`],
  assignees: ["rawphp"],
  author: "tomkaczocha",
  state,
  closed,
});

interface Rig {
  readonly dataDir: string;
  readonly calls: Array<string>;
  readonly clock: { now: number };
  world: {
    issue: IssueDetail;
    thread: Thread | ThreadNotFoundError | SessionsError;
    /** The machine whose claim comment holds the issue, when it is another machine's. */
    winner: string | null;
    /** The next `unassign` fails, once, leaving the issue as it was. */
    unassignFailsOnce: boolean;
    /** The next `setState` lands on GitHub and still answers with an error, once. */
    setStateErrsOnce: boolean;
    /** The next `setState` fails, once, leaving the issue as it was. */
    setStateFailsOnce: boolean;
    /** The thread the Paradev adapter recorded for the run's launch command id. */
    launched: string | null;
  };
  /** The launch command ids `launchThread` was asked for. */
  readonly launchAsks: Array<string>;
  ctx: (over?: { seconds?: number; retries?: number; owner?: string }) => LaunchTimeoutContext;
}

const rigFor = (): Rig => {
  const dataDir = tempDir();
  const calls: Array<string> = [];
  const clock = { now: T0 };
  const world: Rig["world"] = {
    issue: issueDetail("triage"),
    thread: { worktreePath: "/t3/wt", branch: "t3code/abc", archived: false },
    winner: null,
    unassignFailsOnce: false,
    setStateErrsOnce: false,
    setStateFailsOnce: false,
    launched: null,
  };
  const launchAsks: Array<string> = [];
  const boom = () => new GitHubFailed({ args: ["issue", "edit"], status: 1, stderr: "boom" });
  const notExpected = (name: string) => () => Effect.die(`${name} was not expected`);
  const ctx = (
    over: { seconds?: number; retries?: number; owner?: string } = {},
  ): LaunchTimeoutContext => ({
    trackerUser: "rawphp",
    hostLogins: new Map(),
    cloud: false,
    machine: "mac-mini",
    project: { base: "main", owner: over.owner ?? null },
    dataDir,
    clock: () => clock.now,
    launchTimeout: {
      seconds: over.seconds ?? DEFAULT_LAUNCH_TIMEOUT_SECONDS,
      retries: over.retries ?? DEFAULT_LAUNCH_TIMEOUT_RETRIES,
    },
    launchThread: (commandId) => {
      launchAsks.push(commandId);
      return Effect.succeed(world.launched);
    },
    yieldToClaim: (n) => {
      calls.push(`yield ${n}`);
      return Effect.succeed(
        world.winner === null ? null : { machine: world.winner, finished: [] },
      );
    },
    tracker: {
      issue: (n) => {
        calls.push(`issue ${n}`);
        return Effect.succeed(world.issue);
      },
      setState: (n, state) => {
        calls.push(`setState ${n} ${state}`);
        if (world.setStateFailsOnce) {
          world.setStateFailsOnce = false;
          return Effect.fail(boom());
        }
        world.issue = { ...world.issue, state, labels: [`factory:${state}`] };
        if (world.setStateErrsOnce) {
          world.setStateErrsOnce = false;
          return Effect.fail(boom());
        }
        return Effect.void;
      },
      unassign: (n, user) => {
        calls.push(`unassign ${n} ${user}`);
        if (world.unassignFailsOnce) {
          world.unassignFailsOnce = false;
          return Effect.fail(boom());
        }
        world.issue = {
          ...world.issue,
          assignees: world.issue.assignees.filter((a) => a !== user),
        };
        return Effect.void;
      },
      postComment: (n) => {
        calls.push(`comment ${n}`);
        return Effect.void;
      },
      upsertStatusComment: (n, _user, body) => {
        calls.push(`status ${n} ${body.split("\n")[0]}`);
        return Effect.void;
      },
      assign: notExpected("assign"),
      markPrReady: notExpected("markPrReady"),
      markPrDraft: notExpected("markPrDraft"),
      commentOnPr: notExpected("commentOnPr"),
      pullRequest: notExpected("pullRequest"),
      closedBy: notExpected("closedBy"),
    },
    sessions: {
      thread: (id) => {
        calls.push(`thread ${id}`);
        const answer = world.thread;
        return "_tag" in answer ? Effect.fail(answer) : Effect.succeed(answer);
      },
      archive: (id) => {
        calls.push(`archive ${id}`);
        return Effect.void;
      },
      removeWorktree: (path) => {
        calls.push(`removeWorktree ${path}`);
        return Effect.void;
      },
      send: notExpected("send"),
    },
  });
  return { dataDir, calls, clock, world, launchAsks, ctx };
};

const linesOf = (dataDir: string, run: RunId) =>
  readRun(dataDir, run).entries.map((entry) => ({
    event: entry.event,
    data: entry.data,
    cause: entry.cause,
  }));

const bytesOf = (dataDir: string, run: RunId) => JSON.stringify(readRun(dataDir, run).entries);

/** The lines a reap that puts a `triage` run's issue back to ready appends after the run's own. */
const readyTail = (marker: string, reason: string, totalMs: number) => [
  { event: "step_changed", data: { step: marker }, cause: makeCause("pass", reason) },
  { event: "state_changed", data: { from: "triage", to: "ready" }, cause: makeCause("pass", reason) },
  {
    event: "finished",
    data: { ...FINISHED.data, total_ms: totalMs },
    cause: makeCause("pass", reason),
  },
];

const READY_CALLS = ["issue 10", "yield 10", "setState 10 ready", "unassign 10 rawphp"];
const STUCK_CALLS = [
  "issue 10",
  "yield 10",
  "comment 10",
  "setState 10 stuck",
  "unassign 10 rawphp",
  "status 10 **Factory status:** stuck",
];

describe("reapLaunch: the launch-sending timeout", () => {
  it.effect("leaves a launch-sending run with no thread id that is younger than the timeout", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      seed(rig.dataDir, runOf(1), SENDING);
      const bytes = bytesOf(rig.dataDir, runOf(1));
      rig.clock.now = T0 + 899 * SECOND;
      assert.deepStrictEqual(yield* reapLaunch(rig.ctx(), runOf(1)), { kind: "left" });
      assert.strictEqual(bytesOf(rig.dataDir, runOf(1)), bytes);
      assert.deepStrictEqual(rig.calls, []);
      assert.isTrue(holdsSlot(listUnfinishedRuns(rig.dataDir)[0]!));
    }),
  );

  it.effect(
    "fails one older than the timeout: the run is finished, the slot is free, and the issue is ready and unassigned",
    () =>
      Effect.gen(function* () {
        const rig = rigFor();
        seed(rig.dataDir, runOf(1), SENDING);
        rig.clock.now = T0 + 901 * SECOND;
        assert.deepStrictEqual(yield* reapLaunch(rig.ctx(), runOf(1)), {
          kind: "ready",
          ended: "timed-out",
          failures: 1,
          mayHaveSession: true,
        });
        assert.deepStrictEqual(rig.calls, READY_CALLS);
        assert.deepStrictEqual(rig.world.issue.state, "ready");
        assert.deepStrictEqual(rig.world.issue.assignees, []);
        assert.deepStrictEqual(
          linesOf(rig.dataDir, runOf(1)).slice(SENDING.length),
          readyTail("launch-timed-out", "launch-timeout", 901 * SECOND),
        );
        const seen = readProgress(readRun(rig.dataDir, runOf(1)).entries);
        assert.isTrue(seen.finished);
        assert.strictEqual(seen.launchFailed, "timed-out");
        assert.deepStrictEqual(listUnfinishedRuns(rig.dataDir), []);
        // Finished: the next call leaves it.
        rig.calls.length = 0;
        assert.deepStrictEqual(yield* reapLaunch(rig.ctx(), runOf(1)), { kind: "left" });
        assert.deepStrictEqual(rig.calls, []);
      }),
  );

  it.effect("leaves a launch whose session the adapter recorded before the ledger did, for the pass to resume", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      seed(rig.dataDir, runOf(1), SENDING);
      const bytes = bytesOf(rig.dataDir, runOf(1));
      rig.clock.now = T0 + 901 * SECOND;
      rig.world.launched = "local:ws-9";
      assert.deepStrictEqual(yield* reapLaunch(rig.ctx(), runOf(1)), { kind: "left" });
      assert.deepStrictEqual(rig.launchAsks, [launchCommandId(runOf(1))]);
      assert.deepStrictEqual(rig.calls, ["thread local:ws-9"]);
      assert.strictEqual(bytesOf(rig.dataDir, runOf(1)), bytes);
      // That thread gone: the launch timed out after all.
      rig.calls.length = 0;
      rig.world.thread = new ThreadNotFoundError({ threadId: "local:ws-9" });
      assert.deepStrictEqual(yield* reapLaunch(rig.ctx(), runOf(1)), {
        kind: "ready",
        ended: "timed-out",
        failures: 1,
        mayHaveSession: true,
      });
      assert.deepStrictEqual(rig.calls, ["thread local:ws-9", ...READY_CALLS]);
    }),
  );

  it.effect("times out a launch-sending resumed-from step the same way", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      seed(rig.dataDir, runOf(1), [...CLAIMED, step("launch-sending resumed-from t3code/abc")]);
      rig.clock.now = T0 + 16 * MINUTE;
      assert.deepStrictEqual(yield* reapLaunch(rig.ctx(), runOf(1)), {
        kind: "ready",
        ended: "timed-out",
        failures: 1,
        mayHaveSession: true,
      });
      assert.deepStrictEqual(rig.calls, READY_CALLS);
    }),
  );

  it.effect("counts the timeout from the launch-sending step, not from the claim", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      seed(rig.dataDir, runOf(1), CLAIMED);
      // The launch was first sent 30 minutes after the claim.
      const ledger = Ledger.open(rig.dataDir, runOf(1), { clock: () => T0 + 30 * MINUTE });
      ledger.append(step("launch-sending"), makeCause("start", "launch-sending"));
      ledger.close();
      rig.clock.now = T0 + 40 * MINUTE;
      assert.deepStrictEqual(yield* reapLaunch(rig.ctx(), runOf(1)), { kind: "left" });
      rig.clock.now = T0 + 46 * MINUTE;
      assert.strictEqual((yield* reapLaunch(rig.ctx(), runOf(1))).kind, "ready");
    }),
  );

  it.effect("defaults to 900 seconds, as the machine config does when it names no timeout", () =>
    Effect.gen(function* () {
      const parsed = parseMachineConfig(
        "gh_config_dir: /gh\nmax_concurrent_runs: 1\nrepos: []\nparadev:\n  agent: claude\n",
        "config.yml",
      );
      assert.isTrue(Result.isSuccess(parsed));
      if (!Result.isSuccess(parsed)) return;
      const { launchTimeoutSeconds, launchTimeoutRetries } = parsed.success.config;
      assert.strictEqual(launchTimeoutSeconds, 900);
      const rig = rigFor();
      seed(rig.dataDir, runOf(1), SENDING);
      const ctx = rig.ctx({ seconds: launchTimeoutSeconds, retries: launchTimeoutRetries });
      rig.clock.now = T0 + 900 * SECOND;
      assert.deepStrictEqual(yield* reapLaunch(ctx, runOf(1)), { kind: "left" });
      rig.clock.now = T0 + 900 * SECOND + 1;
      assert.strictEqual((yield* reapLaunch(ctx, runOf(1))).kind, "ready");
    }),
  );

  it.effect("honours a configured timeout", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      seed(rig.dataDir, runOf(1), SENDING);
      rig.clock.now = T0 + 61 * SECOND;
      assert.deepStrictEqual(yield* reapLaunch(rig.ctx(), runOf(1)), { kind: "left" });
      assert.strictEqual((yield* reapLaunch(rig.ctx({ seconds: 60 }), runOf(1))).kind, "ready");
    }),
  );

  it.effect("reaps a leftover launch-sending run after a restart, from its ledger alone", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      // A runner that crashed mid-launch left this; the new process has only the file.
      seed(rig.dataDir, runOf(1), SENDING, T0 - 2 * 60 * MINUTE);
      const fresh = rig.ctx();
      assert.deepStrictEqual(yield* reapLaunch(fresh, runOf(1)), {
        kind: "ready",
        ended: "timed-out",
        failures: 1,
        mayHaveSession: true,
      });
      assert.deepStrictEqual(listUnfinishedRuns(rig.dataDir), []);
    }),
  );

  it.effect("leaves a run that recorded its thread id before the timeout, while the thread is live", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      seed(rig.dataDir, runOf(1), [...SENDING, LAUNCHED]);
      const bytes = bytesOf(rig.dataDir, runOf(1));
      rig.clock.now = T0 + 5 * MINUTE;
      assert.deepStrictEqual(yield* reapLaunch(rig.ctx(), runOf(1)), { kind: "left" });
      assert.deepStrictEqual(rig.calls, []);
      rig.clock.now = T0 + 20 * MINUTE;
      assert.deepStrictEqual(yield* reapLaunch(rig.ctx(), runOf(1)), { kind: "left" });
      assert.deepStrictEqual(rig.calls, ["thread thread-1"]);
      assert.strictEqual(bytesOf(rig.dataDir, runOf(1)), bytes);
    }),
  );

  it.effect("leaves building, needs-info, pr-open and finished runs alone, however old", () =>
    Effect.gen(function* () {
      for (const events of [
        [...SENDING, LAUNCHED, moved("triage", "building")],
        [...SENDING, moved("triage", "building")],
        [...SENDING, LAUNCHED, moved("triage", "building"), moved("building", "needs-info")],
        [...SENDING, LAUNCHED, moved("triage", "building"), moved("building", "pr-open")],
        [...SENDING, FINISHED],
      ]) {
        const rig = rigFor();
        seed(rig.dataDir, runOf(1), events);
        const bytes = bytesOf(rig.dataDir, runOf(1));
        rig.clock.now = T0 + 10 * 60 * MINUTE;
        assert.deepStrictEqual(yield* reapLaunch(rig.ctx(), runOf(1)), { kind: "left" });
        assert.deepStrictEqual(rig.calls, []);
        assert.strictEqual(bytesOf(rig.dataDir, runOf(1)), bytes);
      }
    }),
  );

  it.effect("leaves a run that never sent a launch, and a run with no approval or thread", () =>
    Effect.gen(function* () {
      for (const events of [CLAIMED, [CLAIMED[1]!, CLAIMED[2]!, step("launch-sending")]]) {
        const rig = rigFor();
        seed(rig.dataDir, runOf(1), events);
        rig.clock.now = T0 + 10 * 60 * MINUTE;
        assert.deepStrictEqual(yield* reapLaunch(rig.ctx(), runOf(1)), { kind: "left" });
        assert.deepStrictEqual(rig.calls, []);
      }
    }),
  );

  it.effect("leaves a run whose issue is closed to the start, which abandons it", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      seed(rig.dataDir, runOf(1), SENDING);
      rig.world.issue = issueDetail("triage", true);
      const bytes = bytesOf(rig.dataDir, runOf(1));
      rig.clock.now = T0 + 16 * MINUTE;
      assert.deepStrictEqual(yield* reapLaunch(rig.ctx(), runOf(1)), { kind: "left" });
      assert.deepStrictEqual(rig.calls, ["issue 10"]);
      assert.strictEqual(bytesOf(rig.dataDir, runOf(1)), bytes);
    }),
  );

  it.effect("goes on from a decision already recorded, as after a crash, and writes it once", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      seed(rig.dataDir, runOf(1), [...SENDING, step("launch-timed-out")]);
      // Within the timeout by the clock: the recorded decision stands all the same.
      rig.clock.now = T0;
      assert.deepStrictEqual(yield* reapLaunch(rig.ctx(), runOf(1)), {
        kind: "ready",
        ended: "timed-out",
        failures: 1,
        mayHaveSession: true,
      });
      const steps = linesOf(rig.dataDir, runOf(1)).filter(
        (line) => line.event === "step_changed" && JSON.stringify(line.data).includes("launch-timed-out"),
      );
      assert.strictEqual(steps.length, 1);
      assert.isTrue(readProgress(readRun(rig.dataDir, runOf(1)).entries).finished);
    }),
  );

  it.effect("fails with the GitHub error and finishes nothing when the label cannot move; the next call ends it", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      seed(rig.dataDir, runOf(1), SENDING);
      rig.clock.now = T0 + 16 * MINUTE;
      const base = rig.ctx();
      const failing: LaunchTimeoutContext = {
        ...base,
        tracker: {
          ...base.tracker,
          setState: () =>
            Effect.fail(new GitHubFailed({ args: ["issue", "edit"], status: 1, stderr: "boom" })),
        },
      };
      const error = yield* Effect.flip(reapLaunch(failing, runOf(1)));
      assert.strictEqual(error._tag, "GitHubFailed");
      assert.isFalse(readProgress(readRun(rig.dataDir, runOf(1)).entries).finished);
      assert.strictEqual((yield* reapLaunch(base, runOf(1))).kind, "ready");
    }),
  );
});

describe("reapLaunch: the retry limit", () => {
  /** Seeds attempt `n` of the issue as a launch the timeout already failed and finished. */
  const timedOutBefore = (dataDir: string, attempt: number, marker = "launch-timed-out") =>
    seed(dataDir, runOf(attempt), [...SENDING, step(marker), moved("triage", "ready"), FINISHED]);

  it.effect("with the default of 1: the first timeout is ready, the second on a new run is stuck", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      seed(rig.dataDir, runOf(1), SENDING);
      rig.clock.now = T0 + 16 * MINUTE;
      assert.strictEqual((yield* reapLaunch(rig.ctx(), runOf(1))).kind, "ready");
      // The issue was claimed again: a new run, which times out too.
      rig.world.issue = issueDetail("triage");
      rig.calls.length = 0;
      seed(rig.dataDir, runOf(2), SENDING, T0 + 20 * MINUTE);
      rig.clock.now = T0 + 40 * MINUTE;
      assert.deepStrictEqual(yield* reapLaunch(rig.ctx(), runOf(2)), {
        kind: "stuck",
        ended: "timed-out",
        failures: 2,
        limit: true,
        mayHaveSession: true,
      });
      assert.deepStrictEqual(rig.calls, STUCK_CALLS);
      assert.strictEqual(rig.world.issue.state, "stuck");
      const seen = readProgress(readRun(rig.dataDir, runOf(2)).entries);
      assert.isTrue(seen.finished);
      assert.strictEqual(seen.launchFailed, "timed-out");
      assert.strictEqual(seen.stuck, LAUNCH_TIMEOUT_REASON);
      assert.deepStrictEqual(listUnfinishedRuns(rig.dataDir), []);
    }),
  );

  it.effect("with launch_timeout_retries 0 the first timeout is stuck", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      seed(rig.dataDir, runOf(1), SENDING);
      rig.clock.now = T0 + 16 * MINUTE;
      assert.deepStrictEqual(yield* reapLaunch(rig.ctx({ retries: 0 }), runOf(1)), {
        kind: "stuck",
        ended: "timed-out",
        failures: 1,
        limit: true,
        mayHaveSession: true,
      });
      assert.deepStrictEqual(rig.calls, STUCK_CALLS);
    }),
  );

  it.effect("counts only this issue's earlier launch timeouts in this repo, not its stops by hand", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      timedOutBefore(rig.dataDir, 1, "launch-stopped");
      timedOutBefore(rig.dataDir, 4, "launch-timed-out");
      // An earlier run that failed some other way does not count.
      seed(rig.dataDir, runOf(2), [...SENDING, LAUNCHED, moved("triage", "building"), FINISHED]);
      // Another issue's, and another repo's, failures do not count.
      seed(rig.dataDir, { repo: REPO, issue: "11", attempt: 1 }, [...SENDING, step("launch-timed-out"), FINISHED]);
      seed(rig.dataDir, { repo: "rawphp/other", issue: "10", attempt: 1 }, [...SENDING, step("launch-timed-out"), FINISHED]);
      seed(rig.dataDir, runOf(5), SENDING);
      rig.clock.now = T0 + 16 * MINUTE;
      // Run 4's timeout is the one prior failure: this one makes 2, within 2 retries.
      assert.deepStrictEqual(yield* reapLaunch(rig.ctx({ retries: 2 }), runOf(5)), {
        kind: "ready",
        ended: "timed-out",
        failures: 2,
        mayHaveSession: true,
      });
    }),
  );
});

describe("reapLaunch: a stop by hand of a run still starting", () => {
  it.effect("ends a run with no thread id at once and puts the issue back to ready", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      seed(rig.dataDir, runOf(1), [...SENDING, STOP_LINE]);
      // Within the timeout: the stop does not wait for it.
      rig.clock.now = T0 + MINUTE;
      assert.deepStrictEqual(yield* reapLaunch(rig.ctx(), runOf(1)), {
        kind: "ready",
        ended: "stopped",
        failures: 0,
        mayHaveSession: true,
      });
      assert.deepStrictEqual(rig.calls, READY_CALLS);
      assert.deepStrictEqual(
        linesOf(rig.dataDir, runOf(1)).slice(SENDING.length + 1),
        readyTail("launch-stopped", "stop-requested", MINUTE),
      );
    }),
  );

  it.effect("ends a triage run that never sent its launch the same way, with no session to look for", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      seed(rig.dataDir, runOf(1), [...CLAIMED, STOP_LINE]);
      assert.deepStrictEqual(yield* reapLaunch(rig.ctx(), runOf(1)), {
        kind: "ready",
        ended: "stopped",
        failures: 0,
        mayHaveSession: false,
      });
      assert.deepStrictEqual(rig.calls, READY_CALLS);
    }),
  );

  it.effect("a stop is not a timeout: it uses no retry, and a later first timeout goes back to ready", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      seed(rig.dataDir, runOf(1), [...SENDING, STOP_LINE]);
      assert.strictEqual((yield* reapLaunch(rig.ctx(), runOf(1))).kind, "ready");
      rig.world.issue = issueDetail("triage");
      seed(rig.dataDir, runOf(2), SENDING, T0 + MINUTE);
      rig.clock.now = T0 + 20 * MINUTE;
      assert.deepStrictEqual(yield* reapLaunch(rig.ctx(), runOf(2)), {
        kind: "ready",
        ended: "timed-out",
        failures: 1,
        mayHaveSession: true,
      });
    }),
  );

  it.effect("with launch_timeout_retries 0 the limit is used from the start, so a stop is stuck", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      seed(rig.dataDir, runOf(1), [...SENDING, STOP_LINE]);
      assert.deepStrictEqual(yield* reapLaunch(rig.ctx({ retries: 0 }), runOf(1)), {
        kind: "stuck",
        ended: "stopped",
        failures: 0,
        limit: true,
        mayHaveSession: true,
      });
      assert.deepStrictEqual(rig.calls, STUCK_CALLS);
      // The stuck comment says a person stopped it, not that it timed out.
      const seen = readProgress(readRun(rig.dataDir, runOf(1)).entries);
      assert.strictEqual(seen.stuck, LAUNCH_STOPPED_REASON);
    }),
  );

  it.effect("sends the issue stuck when the retry limit is already used", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      seed(rig.dataDir, runOf(1), [...SENDING, step("launch-timed-out"), FINISHED]);
      seed(rig.dataDir, runOf(2), [...SENDING, STOP_LINE]);
      assert.deepStrictEqual(yield* reapLaunch(rig.ctx(), runOf(2)), {
        kind: "stuck",
        ended: "stopped",
        failures: 1,
        limit: true,
        mayHaveSession: true,
      });
      assert.deepStrictEqual(rig.calls, STUCK_CALLS);
    }),
  );

  it.effect("stops a triage run that has a thread as a building stop does: archived, then stuck", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      seed(rig.dataDir, runOf(1), [...SENDING, LAUNCHED, STOP_LINE]);
      assert.deepStrictEqual(yield* reapLaunch(rig.ctx(), runOf(1)), {
        kind: "stuck",
        ended: "stopped",
        failures: 0,
        limit: false,
        mayHaveSession: false,
      });
      assert.deepStrictEqual(rig.calls, [
        "issue 10",
        "yield 10",
        "archive thread-1",
        "thread thread-1",
        "removeWorktree /t3/wt",
        "comment 10",
        "setState 10 stuck",
        "unassign 10 rawphp",
        "status 10 **Factory status:** stuck",
      ]);
      const seen = readProgress(readRun(rig.dataDir, runOf(1)).entries);
      assert.isTrue(seen.finished);
      assert.strictEqual(seen.stuck, "stopped by hand");
      assert.strictEqual(seen.launchFailed, null);
    }),
  );
});

describe("reapLaunch: a run whose thread or workspace is gone", () => {
  it.effect("fails a triage run whose thread is gone once it is past the timeout", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      seed(rig.dataDir, runOf(1), [...SENDING, LAUNCHED]);
      rig.world.thread = new ThreadNotFoundError({ threadId: "thread-1" });
      rig.clock.now = T0 + 5 * MINUTE;
      assert.deepStrictEqual(yield* reapLaunch(rig.ctx(), runOf(1)), { kind: "left" });
      rig.clock.now = T0 + 16 * MINUTE;
      assert.deepStrictEqual(yield* reapLaunch(rig.ctx(), runOf(1)), {
        kind: "ready",
        ended: "timed-out",
        failures: 1,
        mayHaveSession: false,
      });
      assert.deepStrictEqual(rig.calls, [
        "thread thread-1",
        "issue 10",
        "yield 10",
        "archive thread-1",
        "thread thread-1",
        "removeWorktree /t3/wt",
        "setState 10 ready",
        "unassign 10 rawphp",
      ]);
      assert.deepStrictEqual(listUnfinishedRuns(rig.dataDir), []);
    }),
  );

  it.effect("fails one whose workspace was archived", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      seed(rig.dataDir, runOf(1), [...SENDING, LAUNCHED]);
      rig.world.thread = { worktreePath: "/t3/wt", branch: "t3code/abc", archived: true };
      rig.clock.now = T0 + 16 * MINUTE;
      assert.strictEqual((yield* reapLaunch(rig.ctx(), runOf(1))).kind, "ready");
    }),
  );

  it.effect("fails with the T3 error and writes nothing when T3 cannot say", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      seed(rig.dataDir, runOf(1), [...SENDING, LAUNCHED]);
      rig.world.thread = new SessionsError({ operation: "thread", cause: "timeout" });
      const bytes = bytesOf(rig.dataDir, runOf(1));
      rig.clock.now = T0 + 16 * MINUTE;
      const error = yield* Effect.flip(reapLaunch(rig.ctx(), runOf(1)));
      assert.strictEqual(error._tag, "FactorySessionsError");
      assert.strictEqual(bytesOf(rig.dataDir, runOf(1)), bytes);
    }),
  );
});

describe("reapLaunch: an issue that is no longer the run's", () => {
  it.effect.each<{ name: string; issue: IssueDetail }>([
    { name: "moved to building by another claim", issue: { ...issueDetail("building"), assignees: ["eve"] } },
    { name: "moved to needs-info", issue: issueDetail("needs-info") },
    { name: "moved to proposed", issue: issueDetail("proposed") },
    { name: "with no factory label", issue: issueDetail(null) },
    { name: "put back to ready by a person", issue: { ...issueDetail("ready"), assignees: [] } },
  ])("finishes the run in the ledger only when the issue is $name, and moves no label", ({ issue }) =>
    Effect.gen(function* () {
      const rig = rigFor();
      seed(rig.dataDir, runOf(1), SENDING);
      rig.world.issue = issue;
      rig.clock.now = T0 + 16 * MINUTE;
      assert.deepStrictEqual(yield* reapLaunch(rig.ctx(), runOf(1)), {
        kind: "released",
        mayHaveSession: true,
      });
      assert.deepStrictEqual(rig.calls, ["issue 10"]);
      const seen = readProgress(readRun(rig.dataDir, runOf(1)).entries);
      assert.isTrue(seen.finished);
      // The timeout is recorded all the same, so a later run of the issue counts it.
      assert.strictEqual(seen.launchFailed, "timed-out");
      assert.deepStrictEqual(listUnfinishedRuns(rig.dataDir), []);
    }),
  );

  it.effect("leaves the issue to another machine whose claim won it, and moves no label", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      seed(rig.dataDir, runOf(1), SENDING);
      rig.world.winner = "mac-studio";
      const bytes = bytesOf(rig.dataDir, runOf(1));
      rig.clock.now = T0 + 16 * MINUTE;
      assert.deepStrictEqual(yield* reapLaunch(rig.ctx(), runOf(1)), {
        kind: "yielded",
        machine: "mac-studio",
        mayHaveSession: true,
      });
      assert.deepStrictEqual(rig.calls, ["issue 10", "yield 10"]);
      // `yieldToClaim` finishes this machine's runs itself; the reaper writes nothing.
      assert.strictEqual(bytesOf(rig.dataDir, runOf(1)), bytes);
    }),
  );

  it.effect("stops the thread of a stopped run whose issue was moved, then finishes it in the ledger only", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      seed(rig.dataDir, runOf(1), [...SENDING, LAUNCHED, STOP_LINE]);
      rig.world.issue = issueDetail("needs-info");
      assert.deepStrictEqual(yield* reapLaunch(rig.ctx(), runOf(1)), {
        kind: "released",
        mayHaveSession: false,
      });
      assert.deepStrictEqual(rig.calls, [
        "issue 10",
        "archive thread-1",
        "thread thread-1",
        "removeWorktree /t3/wt",
      ]);
      assert.isTrue(readProgress(readRun(rig.dataDir, runOf(1)).entries).finished);
    }),
  );

  it.effect.each<{ name: string; assignees: ReadonlyArray<string> }>([
    { name: "assigned to someone else too", assignees: ["rawphp", "eve"] },
    { name: "assigned to someone else alone", assignees: ["eve"] },
    { name: "with nobody assigned", assignees: [] },
  ])("still puts an issue in factory:triage $name back to ready, as the run's", ({ assignees }) =>
    Effect.gen(function* () {
      const rig = rigFor();
      seed(rig.dataDir, runOf(1), SENDING);
      rig.world.issue = { ...issueDetail("triage"), assignees };
      rig.clock.now = T0 + 16 * MINUTE;
      assert.strictEqual((yield* reapLaunch(rig.ctx(), runOf(1))).kind, "ready");
      assert.deepStrictEqual(rig.calls, READY_CALLS);
      assert.strictEqual(rig.world.issue.state, "ready");
      assert.deepStrictEqual(
        rig.world.issue.assignees,
        assignees.filter((a) => a !== "rawphp"),
      );
    }),
  );

  it.effect("asks for no claim winner on a repo factory.owner gives to one machine", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      seed(rig.dataDir, runOf(1), SENDING);
      rig.world.winner = "mac-studio";
      rig.clock.now = T0 + 16 * MINUTE;
      assert.strictEqual((yield* reapLaunch(rig.ctx({ owner: "mac-mini" }), runOf(1))).kind, "ready");
      assert.deepStrictEqual(rig.calls, ["issue 10", "setState 10 ready", "unassign 10 rawphp"]);
    }),
  );
});

describe("reapLaunch: a reap cut short", () => {
  it.effect("finishes the move to ready when the unassign failed after the label landed", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      seed(rig.dataDir, runOf(1), SENDING);
      rig.clock.now = T0 + 16 * MINUTE;
      rig.world.unassignFailsOnce = true;
      const error = yield* Effect.flip(reapLaunch(rig.ctx(), runOf(1)));
      assert.strictEqual(error._tag, "GitHubFailed");
      assert.strictEqual(rig.world.issue.state, "ready");
      assert.deepStrictEqual(rig.world.issue.assignees, ["rawphp"]);
      rig.calls.length = 0;
      assert.deepStrictEqual(yield* reapLaunch(rig.ctx(), runOf(1)), {
        kind: "ready",
        ended: "timed-out",
        failures: 1,
        mayHaveSession: true,
      });
      // The issue is ready now, so no claim winner is asked.
      assert.deepStrictEqual(rig.calls, ["issue 10", "setState 10 ready", "unassign 10 rawphp"]);
      assert.deepStrictEqual(rig.world.issue.assignees, []);
      assert.deepStrictEqual(listUnfinishedRuns(rig.dataDir), []);
    }),
  );

  it.effect("finishes it when the label landed and GitHub answered with an error", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      seed(rig.dataDir, runOf(1), SENDING);
      rig.clock.now = T0 + 16 * MINUTE;
      rig.world.setStateErrsOnce = true;
      yield* Effect.flip(reapLaunch(rig.ctx(), runOf(1)));
      assert.strictEqual(rig.world.issue.state, "ready");
      assert.strictEqual((yield* reapLaunch(rig.ctx(), runOf(1))).kind, "ready");
      assert.strictEqual(rig.world.issue.state, "ready");
      assert.deepStrictEqual(rig.world.issue.assignees, []);
    }),
  );

  it.effect("finishes a stuck at the limit cut short after its comment, with no second comment", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      seed(rig.dataDir, runOf(1), [...SENDING, step("launch-timed-out"), FINISHED]);
      seed(rig.dataDir, runOf(2), SENDING);
      rig.clock.now = T0 + 16 * MINUTE;
      rig.world.setStateFailsOnce = true;
      yield* Effect.flip(reapLaunch(rig.ctx(), runOf(2)));
      // The stuck comment and the ledger's stuck line are in; the label did not move.
      assert.strictEqual(
        readProgress(readRun(rig.dataDir, runOf(2)).entries).stuck,
        LAUNCH_TIMEOUT_REASON,
      );
      rig.calls.length = 0;
      assert.deepStrictEqual(yield* reapLaunch(rig.ctx(), runOf(2)), {
        kind: "stuck",
        ended: "timed-out",
        failures: 2,
        limit: true,
        mayHaveSession: true,
      });
      // The issue is still in triage, so the claim winner is asked again first.
      assert.deepStrictEqual(rig.calls, [
        "issue 10",
        "yield 10",
        "setState 10 stuck",
        "unassign 10 rawphp",
        "status 10 **Factory status:** stuck",
      ]);
      assert.deepStrictEqual(listUnfinishedRuns(rig.dataDir), []);
    }),
  );

  it.effect("finishes a stuck at the limit whose label landed before the unassign failed", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      seed(rig.dataDir, runOf(1), [...SENDING, step("launch-timed-out"), FINISHED]);
      seed(rig.dataDir, runOf(2), SENDING);
      rig.clock.now = T0 + 16 * MINUTE;
      rig.world.unassignFailsOnce = true;
      const error = yield* Effect.flip(reapLaunch(rig.ctx(), runOf(2)));
      assert.strictEqual(error._tag, "GitHubFailed");
      assert.strictEqual(rig.world.issue.state, "stuck");
      assert.deepStrictEqual(rig.world.issue.assignees, ["rawphp"]);
      rig.calls.length = 0;
      assert.deepStrictEqual(yield* reapLaunch(rig.ctx(), runOf(2)), {
        kind: "stuck",
        ended: "timed-out",
        failures: 2,
        limit: true,
        mayHaveSession: true,
      });
      assert.ok(!rig.calls.includes("comment 10"), rig.calls.join("\n"));
      assert.deepStrictEqual(rig.world.issue.assignees, []);
      assert.deepStrictEqual(listUnfinishedRuns(rig.dataDir), []);
    }),
  );

  it.effect("releases a ready issue a person assigned themselves to after the label landed", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      seed(rig.dataDir, runOf(1), [...SENDING, step("launch-timed-out")]);
      rig.world.issue = { ...issueDetail("ready"), assignees: ["eve"] };
      assert.strictEqual((yield* reapLaunch(rig.ctx(), runOf(1))).kind, "released");
      assert.deepStrictEqual(rig.calls, ["issue 10"]);
    }),
  );

  it.effect("finishes a run a cut left in ready after its state_changed, with no GitHub call", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      seed(rig.dataDir, runOf(1), [...SENDING, step("launch-timed-out"), moved("triage", "ready")]);
      rig.world.issue = { ...issueDetail("ready"), assignees: [] };
      assert.deepStrictEqual(yield* reapLaunch(rig.ctx(), runOf(1)), {
        kind: "ready",
        ended: "timed-out",
        failures: 1,
        mayHaveSession: true,
      });
      assert.deepStrictEqual(rig.calls, []);
      assert.deepStrictEqual(listUnfinishedRuns(rig.dataDir), []);
    }),
  );

  it.effect("finishes a run a cut left in stuck at the limit, as the launch-timeout outcome", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      seed(rig.dataDir, runOf(1), [...SENDING, step("launch-timed-out"), FINISHED]);
      seed(rig.dataDir, runOf(2), [
        ...SENDING,
        step("launch-timed-out"),
        { event: "stuck", data: { reason: LAUNCH_TIMEOUT_REASON } },
        moved("triage", "stuck"),
      ]);
      assert.deepStrictEqual(yield* reapLaunch(rig.ctx(), runOf(2)), {
        kind: "stuck",
        ended: "timed-out",
        failures: 2,
        limit: true,
        mayHaveSession: true,
      });
      assert.deepStrictEqual(rig.calls, []);
      assert.deepStrictEqual(listUnfinishedRuns(rig.dataDir), []);
    }),
  );

  it.effect("leaves a run in ready or stuck that the reaper did not decide", () =>
    Effect.gen(function* () {
      for (const to of ["ready", "stuck"] as const) {
        const rig = rigFor();
        seed(rig.dataDir, runOf(1), [...SENDING, moved("triage", to)]);
        assert.deepStrictEqual(yield* reapLaunch(rig.ctx(), runOf(1)), { kind: "left" });
        assert.deepStrictEqual(rig.calls, []);
      }
      // A building run's stop cut after its state_changed to stuck is advance's, not the reaper's.
      const rig = rigFor();
      seed(rig.dataDir, runOf(1), [
        ...SENDING,
        LAUNCHED,
        moved("triage", "building"),
        STOP_LINE,
        { event: "stuck", data: { reason: "stopped by hand" } },
        moved("building", "stuck"),
      ]);
      const bytes = bytesOf(rig.dataDir, runOf(1));
      assert.deepStrictEqual(yield* reapLaunch(rig.ctx(), runOf(1)), { kind: "left" });
      assert.strictEqual(bytesOf(rig.dataDir, runOf(1)), bytes);
    }),
  );

  it.effect("yields a recorded decision's issue to another machine whose newer claim took it", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      seed(rig.dataDir, runOf(1), [...SENDING, step("launch-timed-out")]);
      rig.world.winner = "mac-studio";
      assert.deepStrictEqual(yield* reapLaunch(rig.ctx(), runOf(1)), {
        kind: "yielded",
        machine: "mac-studio",
        mayHaveSession: true,
      });
      assert.deepStrictEqual(rig.calls, ["issue 10", "yield 10"]);
    }),
  );

  it.effect("still releases an issue a person moved after the decision was recorded", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      seed(rig.dataDir, runOf(1), [...SENDING, step("launch-timed-out")]);
      rig.world.issue = issueDetail("needs-info");
      assert.strictEqual((yield* reapLaunch(rig.ctx(), runOf(1))).kind, "released");
      assert.deepStrictEqual(rig.calls, ["issue 10"]);
    }),
  );
});

describe("reapLaunch: what the ledger already decided", () => {
  it.effect("leaves a run whose stuck decision is recorded, for start to finish", () =>
    Effect.gen(function* () {
      const rig = rigFor();
      seed(rig.dataDir, runOf(1), [
        ...SENDING,
        { event: "stuck", data: { reason: "the factory could not launch the session" } },
      ]);
      const bytes = bytesOf(rig.dataDir, runOf(1));
      rig.clock.now = T0 + 60 * MINUTE;
      assert.deepStrictEqual(yield* reapLaunch(rig.ctx(), runOf(1)), { kind: "left" });
      assert.deepStrictEqual(rig.calls, []);
      assert.strictEqual(bytesOf(rig.dataDir, runOf(1)), bytes);
      // A stop by hand of it is left to start as well.
      const stopped = rigFor();
      seed(stopped.dataDir, runOf(1), [
        ...SENDING,
        { event: "stuck", data: { reason: "the factory could not launch the session" } },
        STOP_LINE,
      ]);
      assert.deepStrictEqual(yield* reapLaunch(stopped.ctx(), runOf(1)), { kind: "left" });
    }),
  );

  it.effect(
    "times out a launch that keeps being refused for room: the issue asks for any launch-sending run with no thread id",
    () =>
      Effect.gen(function* () {
        const rig = rigFor();
        // A refusal for room writes nothing: each pass sends again under the same step.
        seed(rig.dataDir, runOf(1), SENDING);
        for (const minutes of [1, 5, 10, 15]) {
          rig.clock.now = T0 + minutes * MINUTE;
          assert.deepStrictEqual(yield* reapLaunch(rig.ctx(), runOf(1)), { kind: "left" });
        }
        rig.clock.now = T0 + 16 * MINUTE;
        assert.strictEqual((yield* reapLaunch(rig.ctx(), runOf(1))).kind, "ready");
      }),
  );
});
