// @effect-diagnostics nodeBuiltinImport:off - the tests lay out real run files and a machine log in a temp data dir.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vitest";

import type { AttentionItem } from "./attention.ts";
import { LedgerIoError } from "./ledger/errors.ts";
import { formatTs } from "./ledger/time.ts";
import { catchLedgerError, T0, useTempDirs } from "./ledger/testSupport.ts";
import { scanMachineLog } from "./ledger/machineLog.ts";
import { buildStatus, readMachineLog, type FactoryStatus, type StatusReport } from "./status.ts";

/** 2026-10-05T10:13:16.123Z */
const NOW = T0 + 86_400_000;
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;

const tempDir = useTempDirs();

const ago = (ms: number) => NOW - ms;

/** One line of a run file or the machine log, with the data as written. */
const line = (ms: number, event: string, data: unknown) =>
  `${JSON.stringify({
    ts: formatTs(ms),
    ms,
    event,
    data,
    cause: { step: "pass", reason: "claimed" },
  })}\n`;

const claimed = (ms: number, user = "rawphp") =>
  line(ms, "claimed", { machine: "mac", github_user: user });
const state = (ms: number, from: string, to: string) => line(ms, "state_changed", { from, to });
const launched = (ms: number, thread: string, title?: string) =>
  line(ms, "session_launched", {
    thread_id: thread,
    worktree: null,
    branch: null,
    ...(title === undefined ? {} : { title }),
  });
const prOpened = (ms: number, pr: number, url: string) => line(ms, "pr_opened", { pr, url });
const finished = (ms: number) =>
  line(ms, "finished", {
    outcome: "pr-open",
    total_ms: 1,
    gate_attempts: 1,
    review_cycles: null,
    pr_url: null,
    pr_end: null,
  });
const runError = (ms: number, step: string, kind: string, message: string) =>
  line(ms, "error", { step, kind, message });
const passFinished = (ms: number) =>
  line(ms, "pass_finished", { runs: 1, claimed: 0, errors: 0, attention: 0 });
const passStarted = (ms: number) => line(ms, "pass_started", {});
const machineError = (
  ms: number,
  run: string | null,
  step: string,
  kind: string,
  message: string,
) => line(ms, "error", { ...(run === null ? {} : { run }), step, kind, message });
const attentionLine = (ms: number, run: string, reason: string) =>
  line(ms, "attention", { run, reason });

const writeRun = (dir: string, id: string, lines: ReadonlyArray<string>) => {
  NodeFS.mkdirSync(NodePath.join(dir, "runs"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(dir, "runs", `${id}.jsonl`), lines.join(""));
};
/**
 * A regular run file that cannot be read, whoever runs the test: a sparse file over the 2 GiB a
 * Node read allows, which fails at once without reading it.
 */
const writeUnreadableRun = (path: string) => {
  NodeFS.writeFileSync(path, "");
  NodeFS.truncateSync(path, 3 * 2 ** 30);
};
const writeEvents = (dir: string, lines: ReadonlyArray<string>) =>
  NodeFS.writeFileSync(NodePath.join(dir, "events.jsonl"), lines.join(""));

const REPOS = ["rawphp/softfac", "rawphp/broken", "original-solutions/answer-bot", "acme/site"];

const running = (pollSeconds = 60, repos: ReadonlyArray<string> = REPOS): FactoryStatus => ({
  state: "running",
  settings: { pollSeconds, maxConcurrentRuns: 5, repos },
});

const input = (dir: string, over: Partial<Parameters<typeof buildStatus>[0]> = {}) => ({
  status: running(),
  version: "0.1.0",
  machine: "mac",
  machineConfigPath: "/etc/factory.yml",
  dataDir: dir,
  nowMs: NOW,
  passRunning: false,
  runningThreads: 0,
  attention: [] as ReadonlyArray<AttentionItem>,
  ...over,
});

const report = (dir: string, over: Partial<Parameters<typeof buildStatus>[0]> = {}) =>
  buildStatus(input(dir, over));

/** Runs in several states, a finished one, a run with no state change and an unreadable file. */
const runsFixture = (dir: string): boolean => {
  // Building for 34 minutes, with a draft pull request and a thread.
  writeRun(dir, "rawphp__softfac__59__1", [
    claimed(ago(2 * HOUR)),
    state(ago(2 * HOUR - SEC), "ready", "triage"),
    launched(ago(110 * MIN), "thread:a"),
    prOpened(ago(35 * MIN), 63, "https://github.com/rawphp/softfac/pull/63"),
    state(ago(34 * MIN), "triage", "building"),
  ]);
  // Waiting on a pull request for 2h10m: holds no slot.
  writeRun(dir, "original-solutions__answer-bot__10__1", [
    claimed(ago(5 * HOUR)),
    launched(ago(299 * MIN), "thread:b"),
    prOpened(ago(3 * HOUR), 4, "https://github.com/original-solutions/answer-bot/pull/4"),
    state(ago(2 * HOUR + 10 * MIN), "building", "pr-open"),
  ]);
  // Finished: not listed.
  writeRun(dir, "rawphp__softfac__12__1", [claimed(ago(10 * HOUR)), finished(ago(9 * HOUR))]);
  // Asked a question five minutes ago: no thread, no pull request.
  writeRun(dir, "rawphp__softfac__70__1", [
    claimed(ago(30 * MIN)),
    state(ago(5 * MIN), "building", "needs-info"),
  ]);
  // No state change yet.
  writeRun(dir, "rawphp__softfac__71__1", [claimed(ago(MIN))]);
  // A file that cannot be read.
  const broken = NodePath.join(dir, "runs", "rawphp__broken__2__1.jsonl");
  NodeFS.writeFileSync(broken, "x\n");
  NodeFS.chmodSync(broken, 0o000);
  try {
    NodeFS.readFileSync(broken);
  } catch {
    return true;
  }
  // Root reads anything, so the file is readable and the fixture is not what it says.
  NodeFS.rmSync(broken);
  return false;
};

const attentionItem = (over: Partial<AttentionItem> = {}): AttentionItem => ({
  id: "stuck:a/b#1",
  kind: "stuck",
  repo: "a/b",
  issue: 1,
  run: "a__b__1__1",
  message: "run went stuck",
  firstSeenMs: ago(HOUR),
  ...over,
});

describe("buildStatus: nothing recorded", () => {
  it("an empty data dir says so in every section", () => {
    expect(report(tempDir())).toEqual({
      state: "running",
      reason: null,
      version: "0.1.0",
      machine_config: "/etc/factory.yml",
      machine: "mac",
      data_dir: expect.any(String),
      passes: {
        at: null,
        ago_ms: null,
        result: null,
        reason: null,
        poll_seconds: 60,
        running: false,
        running_for_ms: null,
        stale: false,
      },
      slots: { used: 0, max: 5 },
      threads: { running: 0 },
      paused_by_hand: null,
      runs: [],
      left_out: [],
      problems: [],
      health: null,
      attention: [],
      dismissed: [],
    });
  });

  it("a missing data dir reads as an empty one", () => {
    const missing = NodePath.join(tempDir(), "nope");
    const status = report(missing);
    expect(status.passes.at).toBeNull();
    expect(status.runs).toEqual([]);
    expect(NodeFS.existsSync(missing)).toBe(false);
  });

  it("an idle status has no poll interval or slot limit and is not stale", () => {
    const dir = tempDir();
    writeEvents(dir, [passFinished(ago(HOUR))]);
    writeRun(dir, "acme__widgets__9__1", [claimed(ago(HOUR))]);
    const status = report(dir, { status: { state: "idle", reason: "no factory config" } });
    expect(status.state).toBe("idle");
    expect(status.reason).toBe("no factory config");
    expect(status.passes.poll_seconds).toBeNull();
    expect(status.passes.stale).toBe(false);
    expect(status.passes.at).toBe(formatTs(ago(HOUR)));
    expect(status.slots.max).toBeNull();
    expect(status.left_out).toEqual([]);
    expect(status.runs).toHaveLength(1);
  });

  it("the machine, the machine config and the data dir come through as given", () => {
    const dir = tempDir();
    const status = report(dir, { machine: "studio", machineConfigPath: "/x/config.yml" });
    expect(status.machine).toBe("studio");
    expect(status.machine_config).toBe("/x/config.yml");
    expect(status.data_dir).toBe(dir);
  });

  it("the threads with an agent at work come through as given, null included", () => {
    expect(report(tempDir(), { runningThreads: 3 }).threads).toEqual({ running: 3 });
    expect(report(tempDir(), { runningThreads: null }).threads).toEqual({ running: null });
  });

  it("the json keys are in the documented order", () => {
    const status = report(tempDir());
    expect(Object.keys(status)).toEqual([
      "state",
      "reason",
      "version",
      "machine_config",
      "machine",
      "data_dir",
      "passes",
      "slots",
      "threads",
      "paused_by_hand",
      "runs",
      "left_out",
      "problems",
      "health",
      "attention",
      "dismissed",
    ]);
    expect(Object.keys(status.passes)).toEqual([
      "at",
      "ago_ms",
      "result",
      "reason",
      "poll_seconds",
      "running",
      "running_for_ms",
      "stale",
    ]);
    expect(Object.keys(JSON.parse(JSON.stringify(status)))).toEqual(Object.keys(status));
  });
});

describe("buildStatus: runs and slots", () => {
  it("a run that ended in needs-info is not listed and holds no slot", () => {
    const dir = tempDir();
    writeRun(dir, "rawphp__softfac__24__1", [
      claimed(ago(30 * MIN)),
      state(ago(5 * MIN), "building", "needs-info"),
      line(ago(4 * MIN), "finished", {
        outcome: "needs-info",
        total_ms: 1,
        gate_attempts: 0,
        review_cycles: null,
        pr_url: null,
        pr_end: null,
      }),
    ]);
    const status = report(dir);
    expect(status.runs).toEqual([]);
    expect(status.slots.used).toBe(0);
  });

  it("runs are listed oldest first with state, age, pr and thread", () => {
    const dir = tempDir();
    const readable = runsFixture(dir);
    const rows = report(dir).runs;
    const expected = [
      {
        id: "original-solutions__answer-bot__10__1",
        state: "pr-open",
        last_event: "state_changed",
        title: null,
        user: "rawphp",
        for_ms: 2 * HOUR + 10 * MIN,
        pr_url: "https://github.com/original-solutions/answer-bot/pull/4",
        thread_id: "thread:b",
        pr_reported: true,
        unreadable: false,
      },
      {
        id: "rawphp__softfac__59__1",
        state: "building",
        last_event: "state_changed",
        title: null,
        user: "rawphp",
        for_ms: 34 * MIN,
        pr_url: "https://github.com/rawphp/softfac/pull/63",
        thread_id: "thread:a",
        pr_reported: false,
        unreadable: false,
      },
      {
        id: "rawphp__softfac__70__1",
        state: "needs-info",
        last_event: "state_changed",
        title: null,
        user: "rawphp",
        for_ms: 5 * MIN,
        pr_url: null,
        thread_id: null,
        pr_reported: false,
        unreadable: false,
      },
      {
        id: "rawphp__softfac__71__1",
        state: null,
        last_event: "claimed",
        title: null,
        user: "rawphp",
        for_ms: null,
        pr_url: null,
        thread_id: null,
        pr_reported: false,
        unreadable: false,
      },
      ...(readable
        ? [
            {
              id: "rawphp__broken__2__1",
              state: null,
              last_event: null,
              title: null,
              user: null,
              for_ms: null,
              pr_url: null,
              thread_id: null,
              pr_reported: false,
              unreadable: true,
            },
          ]
        : []),
    ];
    expect(rows).toEqual(expected);
  });

  it("a run shows the event of its last line and the title its launch recorded", () => {
    const dir = tempDir();
    writeRun(dir, "rawphp__softfac__1__1", [
      claimed(ago(3 * HOUR)),
      launched(ago(2 * HOUR), "thread:a", "Fix the thing"),
      launched(ago(90 * MIN), "thread:b", "Later title"),
      line(ago(10 * MIN), "gate_command", { command: "vp check" }),
    ]);
    writeRun(dir, "rawphp__softfac__2__1", [
      claimed(ago(HOUR)),
      launched(ago(50 * MIN), "thread:c"),
    ]);
    const rows = report(dir).runs.map((row) => [row.id, row.last_event, row.title]);
    expect(rows).toEqual([
      ["rawphp__softfac__1__1", "gate_command", "Fix the thing"],
      ["rawphp__softfac__2__1", "session_launched", null],
    ]);
  });

  it("a run with no readable line has no last event and no title", () => {
    const dir = tempDir();
    writeRun(dir, "rawphp__softfac__3__1", ["not json\n"]);
    expect(report(dir).runs.map((row) => [row.id, row.last_event, row.title])).toEqual([
      ["rawphp__softfac__3__1", null, null],
    ]);
  });

  // The fork counts a slot as its pass does (`holdsSlot`): a run that was never confirmed holds
  // none, which softfac's `holds_slot` would count. This is the one place the port differs.
  it("a confirmed building run holds a slot, an unreadable one does, a pr-open one does not", () => {
    const dir = tempDir();
    const readable = runsFixture(dir);
    expect(report(dir).slots).toEqual({ used: readable ? 2 : 1, max: 5 });
  });

  it("a building run whose session reported its pull request says so and holds no slot", () => {
    const dir = tempDir();
    writeRun(dir, "rawphp__softfac__5__1", [
      claimed(ago(HOUR)),
      launched(ago(50 * MIN), "thread:a"),
      state(ago(50 * MIN), "triage", "building"),
      prOpened(ago(MIN), 9, "https://github.com/rawphp/softfac/pull/9"),
    ]);
    const status = report(dir);
    expect(status.runs.map((row) => [row.id, row.state, row.pr_reported])).toEqual([
      ["rawphp__softfac__5__1", "building", true],
    ]);
    expect(status.slots.used).toBe(0);
  });

  it("a run shows the user its claim names and null when there is none", () => {
    const dir = tempDir();
    writeRun(dir, "acme__site__7__1", [
      claimed(ago(HOUR), "alice"),
      state(ago(30 * MIN), "triage", "building"),
    ]);
    writeRun(dir, "rawphp__softfac__8__1", [state(ago(20 * MIN), "triage", "building")]);
    expect(report(dir).runs.map((row) => [row.id, row.user])).toEqual([
      ["acme__site__7__1", "alice"],
      ["rawphp__softfac__8__1", null],
    ]);
  });
});

describe("buildStatus: one read of the runs", () => {
  it("a directory or symlink named like a run is no row and no slot", () => {
    const dir = tempDir();
    writeRun(dir, "rawphp__softfac__59__1", [
      claimed(ago(HOUR)),
      state(ago(MIN), "ready", "building"),
    ]);
    NodeFS.mkdirSync(NodePath.join(dir, "runs", "rawphp__softfac__60__1.jsonl"));
    NodeFS.writeFileSync(NodePath.join(dir, "elsewhere"), claimed(ago(HOUR)));
    NodeFS.symlinkSync(
      NodePath.join(dir, "elsewhere"),
      NodePath.join(dir, "runs", "rawphp__softfac__61__1.jsonl"),
    );
    const status = report(dir);
    expect(status.runs.map((run) => run.id)).toEqual(["rawphp__softfac__59__1"]);
    expect(status.slots.used).toBe(0);
  });

  it("a finished run whose file has not been written for over a day is not read", () => {
    const dir = tempDir();
    writeRun(dir, "rawphp__softfac__12__1", [
      claimed(ago(40 * HOUR)),
      runError(ago(HOUR), "advance", "github", "inside the window, in a file that says it is old"),
      finished(ago(MIN)),
    ]);
    // A finished file is never appended to, so a stale mtime means none of its lines are in the
    // window: the report does not open it. The mtime is real time and the clock of the report is
    // `NOW`, so age the file from `NOW`.
    const seconds = (NOW - 2 * 86_400_000) / 1000;
    NodeFS.utimesSync(NodePath.join(dir, "runs", "rawphp__softfac__12__1.jsonl"), seconds, seconds);
    writeRun(dir, "rawphp__softfac__13__1", [
      claimed(ago(5 * HOUR)),
      runError(ago(4 * HOUR), "advance", "github", "recent"),
      finished(ago(3 * HOUR)),
    ]);
    const status = report(dir);
    expect(status.problems.map((problem) => problem.message)).toEqual(["recent"]);
  });
});

describe("buildStatus: passes", () => {
  it("the last pass is read from the machine log", () => {
    const dir = tempDir();
    writeEvents(dir, [
      passFinished(ago(10 * MIN)),
      passFinished(ago(40 * SEC)),
      passStarted(ago(10 * SEC)),
    ]);
    const { passes } = report(dir);
    expect(passes).toMatchObject({
      at: "2026-10-05T10:12:36.123Z",
      ago_ms: 40_000,
      result: "ok",
      reason: null,
      stale: false,
    });
  });

  it("a failed preflight is the last pass with its reason", () => {
    const dir = tempDir();
    writeEvents(dir, [
      passFinished(ago(5 * MIN)),
      line(ago(2 * MIN), "preflight_failed", { check: "t3-token", why: "cannot read the token" }),
    ]);
    const { passes } = report(dir);
    expect(passes).toMatchObject({
      at: formatTs(ago(2 * MIN)),
      result: "preflight_failed",
      reason: "t3-token: cannot read the token",
      stale: false,
    });
  });

  it("a machine log with no finished pass has no passes recorded", () => {
    const dir = tempDir();
    writeEvents(dir, [passStarted(ago(MIN))]);
    const { passes } = report(dir);
    expect(passes).toMatchObject({ at: null, ago_ms: null, result: null, stale: false });
  });

  it("passes are stale only after three polls", () => {
    const dir = tempDir();
    writeEvents(dir, [passFinished(ago(3 * 60 * SEC))]);
    expect(report(dir).passes.stale).toBe(false);
    writeEvents(dir, [passFinished(ago(3 * 60 * SEC + 1))]);
    expect(report(dir).passes.stale).toBe(true);
  });

  it("staleness follows the poll interval of the machine config", () => {
    const dir = tempDir();
    writeEvents(dir, [passFinished(ago(10 * MIN))]);
    expect(report(dir, { status: running(60) }).passes.stale).toBe(true);
    expect(report(dir, { status: running(300) }).passes.stale).toBe(false);
  });

  it("a pass stamped in the future is not stale and is zero ms ago", () => {
    const dir = tempDir();
    writeEvents(dir, [passFinished(NOW + HOUR)]);
    const { passes } = report(dir);
    expect(passes.stale).toBe(false);
    expect(passes.ago_ms).toBe(0);
  });

  it("a stopped machine still reports its last pass from days ago", () => {
    const dir = tempDir();
    const day = 24 * HOUR;
    const lines = [
      passStarted(ago(9 * day)),
      passFinished(ago(9 * day - SEC)),
      machineError(ago(8 * day), null, "pass", "github", "down"),
      passStarted(ago(3 * day + SEC)),
      passFinished(ago(3 * day)),
    ];
    // A long tail of old lines after it, none of them a pass.
    for (let i = 0; i < 50; i += 1) {
      lines.push(machineError(ago(2 * day + i), null, "pass", "github", "down"));
    }
    writeEvents(dir, lines);
    const status = report(dir);
    expect(status.passes.at).toBe(formatTs(ago(3 * day)));
    expect(status.passes.result).toBe("ok");
    expect(status.problems).toEqual([]);
    expect(status.passes.stale).toBe(true);
  });

  it("a pass that is running now is never stale", () => {
    const dir = tempDir();
    writeEvents(dir, [passFinished(ago(HOUR))]);
    expect(report(dir).passes.stale).toBe(true);
    const status = report(dir, { passRunning: true });
    expect(status.passes.stale).toBe(false);
    expect(status.passes.running).toBe(true);
  });

  it("a running pass says how long it has been running", () => {
    const dir = tempDir();
    // The pass that began after the last one ended is the one that is running.
    writeEvents(dir, [
      passStarted(ago(HOUR + MIN)),
      passFinished(ago(HOUR)),
      passStarted(ago(4 * MIN)),
    ]);
    const status = report(dir, { passRunning: true });
    expect(status.passes.running).toBe(true);
    expect(status.passes.running_for_ms).toBe(4 * MIN);
    expect(status.passes.stale).toBe(false);

    // A start the last end came after is a finished pass, not this one.
    writeEvents(dir, [passStarted(ago(HOUR + MIN)), passFinished(ago(HOUR))]);
    const ended = report(dir, { passRunning: true });
    expect(ended.passes.running).toBe(true);
    expect(ended.passes.running_for_ms).toBeNull();

    // With no pass recorded, a start on its own is the running pass.
    writeEvents(dir, [passStarted(ago(2 * MIN))]);
    expect(report(dir, { passRunning: true }).passes.running_for_ms).toBe(2 * MIN);
  });

  it("a started pass while none runs is not running", () => {
    const dir = tempDir();
    writeEvents(dir, [passFinished(ago(HOUR)), passStarted(ago(4 * MIN))]);
    const { passes } = report(dir);
    expect(passes.stale).toBe(true);
    expect(passes.running).toBe(false);
    expect(passes.running_for_ms).toBeNull();
  });
});

describe("buildStatus: problems", () => {
  it("come from both logs newest first and stop at 24 hours", () => {
    const dir = tempDir();
    writeEvents(dir, [
      machineError(ago(10 * MIN), null, "pass", "github", "listing issues failed"),
      attentionLine(ago(20 * MIN), "rawphp__softfac__14__1", "abandoned"),
      machineError(ago(5 * MIN), "rawphp__softfac__14__2", "advance", "github", "boom"),
      machineError(ago(24 * HOUR + 1), null, "pass", "github", "too old"),
      machineError(ago(24 * HOUR), null, "pass", "t3", "right at the edge"),
      passFinished(ago(MIN)),
      line(ago(MIN), "claim_skipped", { repo: "a/b", issue: 1, reason: "limit" }),
    ]);
    writeRun(dir, "rawphp__softfac__70__1", [
      claimed(ago(2 * HOUR)),
      runError(ago(15 * MIN), "gate", "git", "checkout failed"),
      runError(ago(30 * HOUR), "gate", "git", "ancient"),
    ]);
    expect(report(dir).problems).toEqual([
      {
        at: formatTs(ago(5 * MIN)),
        event: "error",
        run: "rawphp__softfac__14__2",
        step: "advance",
        kind: "github",
        reason: null,
        message: "boom",
      },
      {
        at: formatTs(ago(10 * MIN)),
        event: "error",
        run: null,
        step: "pass",
        kind: "github",
        reason: null,
        message: "listing issues failed",
      },
      {
        at: formatTs(ago(15 * MIN)),
        event: "error",
        run: "rawphp__softfac__70__1",
        step: "gate",
        kind: "git",
        reason: null,
        message: "checkout failed",
      },
      {
        at: formatTs(ago(20 * MIN)),
        event: "attention",
        run: "rawphp__softfac__14__1",
        step: null,
        kind: null,
        reason: "abandoned",
        message: null,
      },
      {
        at: formatTs(ago(24 * HOUR)),
        event: "error",
        run: null,
        step: "pass",
        kind: "t3",
        reason: null,
        message: "right at the edge",
      },
    ]);
  });

  it("only the ten newest are listed", () => {
    const dir = tempDir();
    writeEvents(
      dir,
      Array.from({ length: 12 }, (_, i) =>
        machineError(ago((i + 1) * MIN), null, "pass", "github", `problem ${i + 1}`),
      ),
    );
    expect(report(dir).problems.map((problem) => problem.message)).toEqual(
      Array.from({ length: 10 }, (_, i) => `problem ${i + 1}`),
    );
  });

  it("with the same time are listed newest first", () => {
    const dir = tempDir();
    writeEvents(
      dir,
      Array.from({ length: 12 }, (_, i) =>
        machineError(ago(MIN), null, "pass", "github", `same time ${i + 1}`),
      ),
    );
    expect(report(dir).problems.map((problem) => problem.message)).toEqual(
      Array.from({ length: 10 }, (_, i) => `same time ${12 - i}`),
    );
  });

  it("a damaged machine log line is skipped", () => {
    const dir = tempDir();
    writeEvents(dir, [
      passFinished(ago(40 * SEC)),
      "not json\n\n",
      machineError(ago(MIN), null, "pass", "github", "kept"),
      '{"ts":"2026-10-05T10:13:00.000Z","ms":',
    ]);
    const status = report(dir);
    expect(status.passes.at).toBe(formatTs(ago(40 * SEC)));
    expect(status.problems.map((problem) => problem.message)).toEqual(["kept"]);
  });

  it("a machine log that is a symlink is refused", () => {
    const dir = tempDir();
    NodeFS.writeFileSync(NodePath.join(dir, "real"), passFinished(ago(SEC)));
    NodeFS.symlinkSync(NodePath.join(dir, "real"), NodePath.join(dir, "events.jsonl"));
    catchLedgerError(() => report(dir), LedgerIoError);
  });
});

describe("buildStatus: the rest of the report", () => {
  it("the json has the documented keys and values", () => {
    const dir = tempDir();
    writeEvents(dir, [
      passFinished(ago(40 * SEC)),
      machineError(ago(10 * MIN), null, "pass", "github", "listing failed"),
      attentionLine(ago(20 * MIN), "rawphp__softfac__59__1", "not-progressing"),
    ]);
    writeRun(dir, "rawphp__softfac__59__1", [
      claimed(ago(2 * HOUR)),
      launched(ago(100 * MIN), "thread:a"),
      prOpened(ago(50 * MIN), 63, "https://github.com/rawphp/softfac/pull/63"),
      state(ago(34 * MIN), "triage", "building"),
      runError(ago(15 * MIN), "advance", "t3", "gone"),
    ]);
    const status = report(dir, { attention: [attentionItem()] });
    expect(JSON.parse(JSON.stringify(status))).toEqual({
      state: "running",
      reason: null,
      version: "0.1.0",
      machine_config: "/etc/factory.yml",
      machine: "mac",
      data_dir: dir,
      passes: {
        at: "2026-10-05T10:12:36.123Z",
        ago_ms: 40_000,
        result: "ok",
        reason: null,
        poll_seconds: 60,
        running: false,
        running_for_ms: null,
        stale: false,
      },
      slots: { used: 1, max: 5 },
      threads: { running: 0 },
      paused_by_hand: null,
      runs: [
        {
          id: "rawphp__softfac__59__1",
          state: "building",
          last_event: "error",
          title: null,
          user: "rawphp",
          for_ms: 34 * MIN,
          pr_url: "https://github.com/rawphp/softfac/pull/63",
          thread_id: "thread:a",
          pr_reported: false,
          unreadable: false,
        },
      ],
      left_out: [],
      problems: [
        {
          at: "2026-10-05T10:03:16.123Z",
          event: "error",
          run: null,
          step: "pass",
          kind: "github",
          reason: null,
          message: "listing failed",
        },
        {
          at: "2026-10-05T09:58:16.123Z",
          event: "error",
          run: "rawphp__softfac__59__1",
          step: "advance",
          kind: "t3",
          reason: null,
          message: "gone",
        },
        {
          at: "2026-10-05T09:53:16.123Z",
          event: "attention",
          run: "rawphp__softfac__59__1",
          step: null,
          kind: null,
          reason: "not-progressing",
          message: null,
        },
      ],
      health: null,
      attention: [
        {
          id: "stuck:a/b#1",
          kind: "stuck",
          repo: "a/b",
          issue: 1,
          run: "a__b__1__1",
          message: "run went stuck",
          first_seen: formatTs(ago(HOUR)),
        },
      ],
      dismissed: [],
    });
  });

  it("building the report writes nothing", () => {
    const dir = tempDir();
    runsFixture(dir);
    writeEvents(dir, [passFinished(ago(SEC))]);
    const snapshot = () =>
      ["", "runs"]
        .flatMap((sub) => {
          const base = NodePath.join(dir, sub);
          return NodeFS.readdirSync(base).map((name) => {
            const path = NodePath.join(base, name);
            const stat = NodeFS.lstatSync(path);
            return [
              `${sub}/${name}`,
              stat.mtimeMs,
              stat.isFile() && (stat.mode & 0o400) !== 0 ? NodeFS.readFileSync(path, "utf8") : null,
            ];
          });
        })
        .toSorted((a, b) => String(a[0]).localeCompare(String(b[0])));
    const before = snapshot();
    report(dir);
    expect(snapshot()).toEqual(before);
  });
});

describe("buildStatus: claims paused by hand", () => {
  const writePause = (dir: string, sinceMs: number) =>
    NodeFS.writeFileSync(NodePath.join(dir, "claims-paused"), `${formatTs(sinceMs)}\n`);

  it("are shown with their age", () => {
    const dir = tempDir();
    writePause(dir, ago(3 * HOUR + 5 * MIN));
    expect(report(dir).paused_by_hand).toEqual({
      since: "2026-10-05T07:08:16.123Z",
      for_ms: 3 * HOUR + 5 * MIN,
    });
  });

  it("without the pause file the key is null", () => {
    const status = report(tempDir());
    expect(Object.keys(status)).toContain("paused_by_hand");
    expect(status.paused_by_hand).toBeNull();
  });

  it("a pause file that is a symlink is no pause", () => {
    const dir = tempDir();
    NodeFS.writeFileSync(NodePath.join(dir, "elsewhere"), formatTs(ago(HOUR)));
    NodeFS.symlinkSync(NodePath.join(dir, "elsewhere"), NodePath.join(dir, "claims-paused"));
    expect(report(dir).paused_by_hand).toBeNull();
  });

  it("a pause a person wrote by hand still shows", () => {
    const dir = tempDir();
    NodeFS.writeFileSync(NodePath.join(dir, "claims-paused"), "away\n");
    expect(report(dir).paused_by_hand).not.toBeNull();
  });
});

describe("buildStatus: runs of repos the machine config leaves out", () => {
  const leftOutFixture = (dir: string, repos: ReadonlyArray<string>): StatusReport => {
    writeRun(dir, "rawphp__softfac__1__1", [
      claimed(ago(HOUR)),
      state(ago(HOUR - SEC), "ready", "building"),
    ]);
    writeRun(dir, "acme__widgets__9__1", [
      claimed(ago(5 * HOUR)),
      prOpened(ago(3 * HOUR), 4, "https://github.com/acme/widgets/pull/4"),
      state(ago(2 * HOUR), "building", "pr-open"),
    ]);
    return report(dir, { status: running(60, repos) });
  };

  it("a run of a repo not in the machine config is listed in left_out", () => {
    const status = leftOutFixture(tempDir(), ["rawphp/softfac"]);
    expect(status.left_out).toEqual([
      {
        id: "acme__widgets__9__1",
        state: "pr-open",
        pr_url: "https://github.com/acme/widgets/pull/4",
      },
    ]);
    // It is still an open run in the runs list.
    expect(status.runs.map((row) => row.id)).toContain("acme__widgets__9__1");
  });

  it("an unreadable run, or one with no state yet, says so", () => {
    const dir = tempDir();
    writeRun(dir, "acme__widgets__9__1", [claimed(ago(HOUR))]);
    expect(report(dir, { status: running(60, []) }).left_out).toEqual([
      { id: "acme__widgets__9__1", state: "starting", pr_url: null },
    ]);
    writeUnreadableRun(NodePath.join(dir, "runs", "acme__widgets__8__1.jsonl"));
    expect(
      report(dir, { status: running(60, []) }).left_out.find((run) => run.id.endsWith("__8__1")),
    ).toEqual({ id: "acme__widgets__8__1", state: "unreadable", pr_url: null });
  });

  it("no left_out when every run is of a repo in the config", () => {
    const dir = tempDir();
    runsFixture(dir);
    expect(report(dir).left_out).toEqual([]);
  });

  it("a finished run of a repo not in the config is not listed", () => {
    const dir = tempDir();
    writeRun(dir, "acme__widgets__9__1", [claimed(ago(10 * HOUR)), finished(ago(9 * HOUR))]);
    expect(report(dir, { status: running(60, ["rawphp/softfac"]) }).left_out).toEqual([]);
  });

  it("a repo whose case differs in the config is not left out", () => {
    const dir = tempDir();
    runsFixture(dir);
    const upper = REPOS.map((repo) => repo.toUpperCase());
    expect(report(dir, { status: running(60, upper) }).left_out).toEqual([]);
  });
});

describe("buildStatus: attention", () => {
  it("items come through with first_seen, in list order", () => {
    const status = report(tempDir(), {
      attention: [
        attentionItem({ id: "config", kind: "config", repo: null, issue: null, run: null }),
        attentionItem({ firstSeenMs: T0 }),
      ],
    });
    expect(
      status.attention.map((item) => [item.id, item.kind, item.repo, item.first_seen]),
    ).toEqual([
      ["config", "config", null, formatTs(ago(HOUR))],
      ["stuck:a/b#1", "stuck", "a/b", formatTs(T0)],
    ]);
    expect(status.dismissed).toEqual([]);
  });

  it("dismissed items come apart from the open ones", () => {
    const status = report(tempDir(), {
      attention: [attentionItem()],
      dismissed: [
        attentionItem({ id: "config", kind: "config", repo: null, issue: null, run: null }),
      ],
    });
    expect(status.attention.map((item) => item.id)).toEqual(["stuck:a/b#1"]);
    expect(status.dismissed.map((item) => item.id)).toEqual(["config"]);
  });
});

describe("readMachineLog: only the end of the log", () => {
  const DAY = 24 * HOUR;
  const problemLine = (ms: number, event: "error" | "attention") =>
    line(ms, event, {
      run: "rawphp__softfac__1__1",
      step: "pass",
      kind: "x",
      reason: "y",
      message: "m",
    });

  /** The machine part of the report as one forward scan of the whole file gives it. */
  const forward = (dir: string) => {
    let lastPass: unknown = null;
    let lastStart: number | null = null;
    const problems: Array<unknown> = [];
    for (const entry of scanMachineLog(dir)) {
      if (entry.event === "pass_started") lastStart = entry.ms;
      if (entry.event === "pass_finished" || entry.event === "preflight_failed") lastPass = entry;
      if ((entry.event === "error" || entry.event === "attention") && entry.ms + DAY >= NOW) {
        problems.push(entry);
      }
    }
    return { lastPass, lastStart, problems };
  };

  /** The read, after checking it equals the forward scan. */
  const sameAsForward = (dir: string) => {
    const read = readMachineLog(dir, NOW);
    const old = forward(dir);
    expect(read.lastPass).toEqual(old.lastPass);
    expect(read.lastStart).toEqual(old.lastStart);
    expect(read.problems).toEqual(old.problems);
    return read;
  };

  /** `count` lines of a machine that ran long ago, oldest first and all older than the window. */
  const oldLines = (count: number) => {
    const base = NOW - 10 * DAY;
    return Array.from({ length: count }, (_, i) => {
      const ms = base + i * 1000;
      return i % 3 === 0
        ? passStarted(ms)
        : i % 3 === 1
          ? problemLine(ms, "error")
          : passFinished(ms);
    });
  };

  it("a long old log is not read to the start and the report is the same", () => {
    const dir = tempDir();
    const lines = [
      ...oldLines(40_000),
      passStarted(NOW - 3000),
      passFinished(NOW - 2000),
      problemLine(NOW - 1500, "error"),
      problemLine(NOW - 1000, "attention"),
    ];
    writeEvents(dir, lines);
    const size = lines.join("").length;
    expect(size).toBeGreaterThan(3 * 1024 * 1024);

    const read = sameAsForward(dir);
    expect(read.problems).toHaveLength(2);
    expect(read.lastPass?.ms).toBe(NOW - 2000);
    expect(read.lastStart).toBe(NOW - 3000);
    expect(read.bytesRead).toBeLessThan(1024 * 1024);
  });

  it("stops at the first old line once it has a pass and a start", () => {
    const dir = tempDir();
    const lines = [...oldLines(30_000), passStarted(NOW - 2000), passFinished(NOW - 1000)];
    writeEvents(dir, lines);
    const read = sameAsForward(dir);
    expect(read.bytesRead).toBeLessThan(lines.join("").length / 10);
  });

  it("a log with no pass lines is read to the start", () => {
    const dir = tempDir();
    const lines = [
      ...Array.from({ length: 200 }, (_, i) => problemLine(NOW - DAY - 1000 + i, "error")),
      problemLine(NOW - 1000, "attention"),
    ];
    writeEvents(dir, lines);
    const read = sameAsForward(dir);
    expect(read.bytesRead).toBe(lines.join("").length);
    expect(read.lastPass).toBeNull();
    expect(read.lastStart).toBeNull();
  });

  it("problems written before the last pass and start are still reported", () => {
    const dir = tempDir();
    writeEvents(dir, [
      ...oldLines(3000),
      problemLine(NOW - 5000, "error"),
      problemLine(NOW - 4500, "attention"),
      passStarted(NOW - 4000),
      passFinished(NOW - 3000),
    ]);
    const read = sameAsForward(dir);
    expect(read.problems.map((entry) => entry.event)).toEqual(["error", "attention"]);
    expect(read.lastPass?.ms).toBe(NOW - 3000);
    expect(read.lastStart).toBe(NOW - 4000);
  });

  it("a problem at exactly the window edge is reported", () => {
    const dir = tempDir();
    writeEvents(dir, [
      problemLine(NOW - DAY - 1, "attention"),
      problemLine(NOW - DAY, "error"),
      passStarted(NOW - 2000),
      passFinished(NOW - 1000),
    ]);
    const read = sameAsForward(dir);
    expect(read.problems.map((entry) => entry.event)).toEqual(["error"]);
  });

  it("problems come back in file order", () => {
    const dir = tempDir();
    writeEvents(dir, [
      passStarted(NOW - 4000),
      passFinished(NOW - 3000),
      problemLine(NOW - 2000, "error"),
      problemLine(NOW - 2000, "attention"),
      problemLine(NOW - 1000, "error"),
    ]);
    const read = sameAsForward(dir);
    expect(read.problems.map((entry) => entry.event)).toEqual(["error", "attention", "error"]);
  });

  it("the report built from a long log equals the one a forward scan gives", () => {
    const dir = tempDir();
    writeEvents(dir, [
      ...oldLines(20_000),
      passStarted(NOW - 3000),
      passFinished(NOW - 2000),
      problemLine(NOW - 1000, "error"),
    ]);
    const status = report(dir);
    expect(status.passes.at).toBe(formatTs(NOW - 2000));
    expect(status.passes.result).toBe("ok");
    expect(status.problems.map((problem) => problem.event)).toEqual(["error"]);
  });
});
