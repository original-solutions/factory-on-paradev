// @effect-diagnostics globalDate:off - one test checks lines are stamped with the wall clock.
// @effect-diagnostics nodeBuiltinImport:off - the tests read and lay out real run files.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";

import {
  InvalidRunIdError,
  LedgerAlreadyExistsError,
  LedgerAlreadyFinishedError,
  LedgerNotFoundError,
  LedgerUnknownEventError,
  LedgerIoError,
} from "./errors.ts";
import { RUN_EVENT_FIELDS, makeCause, type Cause, type RunEvent } from "./events.ts";
import { Ledger, type LedgerOptions } from "./ledger.ts";
import type { AppendIo } from "./appendFile.ts";
import { parseLines, readRun, type Entry, type ReadCause } from "./read.ts";
import { formatTs } from "./time.ts";
import { catchLedgerError, scripted, T0, ticking, useTempDirs } from "./testSupport.ts";
import { feedbackReadFile, type RunId } from "./runId.ts";

const tempDir = useTempDirs();

const softfacRun: RunId = { repo: "rawphp/softfac", issue: "8", attempt: 1 };

const runFileFor = (dataDir: string, id: RunId = softfacRun) =>
  NodePath.join(dataDir, "runs", `${id.repo.replace("/", "__")}__${id.issue}__${id.attempt}.jsonl`);

const readText = (path: string) => NodeFS.readFileSync(path, "utf8");

/** The cause of a line that a test writes only to have something in the ledger. */
const testCause = (): Cause => makeCause("pass", "claimed");

/** The cause as a read gives it back. */
const testCauseRead: ReadCause = { step: "pass", reason: "claimed" };

// Open handles are closed after each test: a run of this file would otherwise hold hundreds.
const handles: Array<Ledger> = [];
afterEach(() => {
  for (const ledger of handles.splice(0)) ledger.close();
});

const create = (
  dataDir: string,
  clock: () => number = ticking(T0, 1000),
  id: RunId = softfacRun,
  options: Omit<LedgerOptions, "clock"> = {},
) => {
  const ledger = Ledger.create(dataDir, id, { clock, ...options });
  handles.push(ledger);
  return ledger;
};

const reopen = (
  dataDir: string,
  clock: () => number = ticking(T0, 1000),
  id: RunId = softfacRun,
  options: Omit<LedgerOptions, "clock"> = {},
) => {
  const ledger = Ledger.open(dataDir, id, { clock, ...options });
  handles.push(ledger);
  return ledger;
};

const step = (name: string): RunEvent => ({ event: "step_changed", data: { step: name } });

const gate = (attempt: number, command: string): RunEvent => ({
  event: "gate_command",
  data: { attempt, command, exit_code: 0, duration_ms: 10 },
});

const stuck = (reason = "r"): RunEvent => ({ event: "stuck", data: { reason } });

/** The last line of the run file, without its newline. */
const lastLine = (dataDir: string) => readText(runFileFor(dataDir)).trimEnd().split("\n").pop()!;

const PASS_CLAIMED = `"cause":{"step":"pass","reason":"claimed"}`;

/** A line as written at T0 with the test cause. */
const lineAtT0 = (event: string, dataJson: string) =>
  `{"ts":"2026-10-04T10:13:16.123Z","ms":1791108796123,"event":"${event}","data":${dataJson},${PASS_CLAIMED}}\n`;

const RED = `{"ts":"2026-10-04T10:13:16.123Z","ms":1791108796123,"event":"step_changed","data":{"step":"red"},${PASS_CLAIMED}}\n`;
const GREEN = `{"ts":"2026-10-04T10:13:17.123Z","ms":1791108797123,"event":"step_changed","data":{"step":"green"},${PASS_CLAIMED}}\n`;
const REFACTOR = `{"ts":"2026-10-04T10:13:18.123Z","ms":1791108798123,"event":"step_changed","data":{"step":"refactor"},${PASS_CLAIMED}}\n`;
const SHIP = `{"ts":"2026-10-04T10:13:19.123Z","ms":1791108799123,"event":"step_changed","data":{"step":"ship"},${PASS_CLAIMED}}\n`;

const GOOD_LINE = `{"ts":"2026-10-04T10:13:16.123Z","ms":1791108796123,"event":"step_changed","data":{"step":"red"}}\n`;

const SHA = "4f1c2d3e4a5b60718293a4b5c6d7e8f901234567";
const BASE_SHA = "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d";

/** Every event type but `finished`, with the exact line it is written as at `T0`. */
const sampleEvents: ReadonlyArray<{ readonly event: RunEvent; readonly line: string }> = [
  {
    event: { event: "claimed", data: { machine: "mac-mini", github_user: "rawphp" } },
    line: lineAtT0("claimed", `{"machine":"mac-mini","github_user":"rawphp"}`),
  },
  {
    event: {
      event: "triage_result",
      data: { passed: false, reasons: ["no acceptance criteria", "too vague"] },
    },
    line: lineAtT0(
      "triage_result",
      `{"passed":false,"reasons":["no acceptance criteria","too vague"]}`,
    ),
  },
  {
    event: { event: "triage_result", data: { passed: true, reasons: [] } },
    line: lineAtT0("triage_result", `{"passed":true,"reasons":[]}`),
  },
  {
    event: {
      event: "questions_posted",
      data: { questions: 'Which table?\nAnd "why"? café' },
    },
    line: lineAtT0("questions_posted", '{"questions":"Which table?\\nAnd \\"why\\"? café"}'),
  },
  {
    event: { event: "answer_received", data: { comment_id: null, body_edited: true } },
    line: lineAtT0("answer_received", `{"comment_id":null,"body_edited":true}`),
  },
  {
    event: { event: "answer_received", data: { comment_id: "42", body_edited: false } },
    line: lineAtT0("answer_received", `{"comment_id":"42","body_edited":false}`),
  },
  {
    event: {
      event: "session_launched",
      data: {
        thread_id: "thr_1",
        worktree: "/tmp/wt",
        branch: "issue-8",
        model_instance: "claudeAgent",
        model: "claude-opus-5-5",
        model_options: [{ id: "reasoningEffort", value: "high" }],
        resumed_from: { run: "rawphp__softfac__8__1", branch: "t3code/abc" },
      },
    },
    line: lineAtT0(
      "session_launched",
      `{"thread_id":"thr_1","worktree":"/tmp/wt","branch":"issue-8","model_instance":"claudeAgent","model":"claude-opus-5-5","model_options":[{"id":"reasoningEffort","value":"high"}],"resumed_from":{"run":"rawphp__softfac__8__1","branch":"t3code/abc"}}`,
    ),
  },
  {
    event: {
      event: "session_launched",
      data: {
        thread_id: "thr_2",
        worktree: null,
        branch: null,
        model_instance: null,
        model: null,
        model_options: null,
        resumed_from: null,
      },
    },
    line: lineAtT0(
      "session_launched",
      `{"thread_id":"thr_2","worktree":null,"branch":null,"model_instance":null,"model":null,"model_options":null,"resumed_from":null}`,
    ),
  },
  {
    event: { event: "comment_forwarded", data: { comment_id: "42" } },
    line: lineAtT0("comment_forwarded", `{"comment_id":"42"}`),
  },
  {
    event: step("review"),
    line: lineAtT0("step_changed", `{"step":"review"}`),
  },
  {
    event: {
      event: "pr_opened",
      data: { pr: 12, url: "https://github.com/rawphp/softfac/pull/12" },
    },
    line: lineAtT0("pr_opened", `{"pr":12,"url":"https://github.com/rawphp/softfac/pull/12"}`),
  },
  {
    event: {
      event: "pr_left",
      data: { pr: 12, url: "https://github.com/rawphp/softfac/pull/12" },
    },
    line: lineAtT0("pr_left", `{"pr":12,"url":"https://github.com/rawphp/softfac/pull/12"}`),
  },
  {
    event: {
      event: "gate_command",
      data: { attempt: 1, command: "cargo test", exit_code: -1, duration_ms: 4200 },
    },
    line: lineAtT0(
      "gate_command",
      `{"attempt":1,"command":"cargo test","exit_code":-1,"duration_ms":4200}`,
    ),
  },
  {
    event: { event: "state_changed", data: { from: "building", to: "needs-info" } },
    line: lineAtT0("state_changed", `{"from":"building","to":"needs-info"}`),
  },
  {
    event: stuck("gate failed 3 times"),
    line: lineAtT0("stuck", `{"reason":"gate failed 3 times"}`),
  },
  {
    event: { event: "gate_sent_back", data: { attempt: 2, run_ordinal: 7 } },
    line: lineAtT0("gate_sent_back", `{"attempt":2,"run_ordinal":7}`),
  },
  {
    event: {
      event: "gate_checkout",
      data: {
        attempt: 2,
        dir: "/data/gate/rawphp__softfac__8__1/2",
        sha: SHA,
        base_sha: BASE_SHA,
      },
    },
    line: lineAtT0(
      "gate_checkout",
      `{"attempt":2,"dir":"/data/gate/rawphp__softfac__8__1/2","sha":"${SHA}","base_sha":"${BASE_SHA}"}`,
    ),
  },
  {
    event: { event: "gate_finished", data: { attempt: 2, total_ms: 754321 } },
    line: lineAtT0("gate_finished", `{"attempt":2,"total_ms":754321}`),
  },
  {
    event: {
      event: "gate_regate",
      data: {
        sha: SHA,
        base_sha: "9f8e7d6c5b4a39281706f5e4d3c2b1a098765432",
        previous_base_sha: BASE_SHA,
      },
    },
    line: lineAtT0(
      "gate_regate",
      `{"sha":"${SHA}","base_sha":"9f8e7d6c5b4a39281706f5e4d3c2b1a098765432","previous_base_sha":"${BASE_SHA}"}`,
    ),
  },
  {
    event: {
      event: "regate_relaunching",
      data: {
        attempt: 1,
        branch: "t3code/abc",
        message: "The factory gate failed.\nCommand: cargo test",
      },
    },
    line: lineAtT0(
      "regate_relaunching",
      `{"attempt":1,"branch":"t3code/abc","message":"The factory gate failed.\\nCommand: cargo test"}`,
    ),
  },
  {
    event: {
      event: "feedback_relaunching",
      data: {
        n: 1,
        branch: "t3code/abc",
        items: ["review:11", "issue-comment:42"],
        message: "The factory forwards new feedback.\nFeedback 1 of 2",
      },
    },
    line: lineAtT0(
      "feedback_relaunching",
      `{"n":1,"branch":"t3code/abc","items":["review:11","issue-comment:42"],"message":"The factory forwards new feedback.\\nFeedback 1 of 2"}`,
    ),
  },
  {
    event: {
      event: "session_interrupted",
      data: {
        resumes: 1,
        relaunch: false,
        run_ordinal: 3,
        branch: "t3code/abc",
        t3_error: "T3 Code is not reachable: timed out",
        ended_in_pass: 2,
      },
    },
    line: lineAtT0(
      "session_interrupted",
      `{"resumes":1,"relaunch":false,"run_ordinal":3,"branch":"t3code/abc","t3_error":"T3 Code is not reachable: timed out","ended_in_pass":2}`,
    ),
  },
  {
    event: {
      event: "session_interrupted",
      data: {
        resumes: 2,
        relaunch: true,
        run_ordinal: null,
        branch: null,
        t3_error: null,
        ended_in_pass: 1,
      },
    },
    line: lineAtT0(
      "session_interrupted",
      `{"resumes":2,"relaunch":true,"run_ordinal":null,"branch":null,"t3_error":null,"ended_in_pass":1}`,
    ),
  },
  {
    event: {
      event: "session_rate_limited",
      data: { run_ordinal: 3, branch: "t3code/abc", resumes: 1, model: "claude-opus-5-5" },
    },
    line: lineAtT0(
      "session_rate_limited",
      `{"run_ordinal":3,"branch":"t3code/abc","resumes":1,"model":"claude-opus-5-5"}`,
    ),
  },
  {
    event: { event: "session_paused", data: { run_ordinal: 3 } },
    line: lineAtT0("session_paused", `{"run_ordinal":3}`),
  },
  {
    event: { event: "stop_requested", data: { by: "operator" } },
    line: lineAtT0("stop_requested", `{"by":"operator"}`),
  },
  {
    event: {
      event: "feedback_forwarding",
      data: {
        n: 1,
        run_ordinal: 3,
        items: ["pr-comment:7", "review:11"],
        message: "The factory forwards new feedback.\nFeedback 1 of 2",
      },
    },
    line: lineAtT0(
      "feedback_forwarding",
      `{"n":1,"run_ordinal":3,"items":["pr-comment:7","review:11"],"message":"The factory forwards new feedback.\\nFeedback 1 of 2"}`,
    ),
  },
  {
    event: {
      event: "pr_adopted",
      data: { pr: 12, branch: "t3code/abc", run: "rawphp__softfac__8__1" },
    },
    line: lineAtT0("pr_adopted", `{"pr":12,"branch":"t3code/abc","run":"rawphp__softfac__8__1"}`),
  },
  {
    event: { event: "branch_bound", data: { pr: 12, branch: "t3code/abc" } },
    line: lineAtT0("branch_bound", `{"pr":12,"branch":"t3code/abc"}`),
  },
  {
    event: { event: "pr_set_draft", data: { pr: 12 } },
    line: lineAtT0("pr_set_draft", `{"pr":12}`),
  },
  {
    event: { event: "pr_ready_outside", data: { pr: 12, by: "alice" } },
    line: lineAtT0("pr_ready_outside", `{"pr":12,"by":"alice"}`),
  },
  {
    event: { event: "pr_ready_outside", data: { pr: 12 } },
    line: lineAtT0("pr_ready_outside", `{"pr":12}`),
  },
  {
    event: {
      event: "gate_cleanup_failed",
      data: {
        dir: "/data/gate/rawphp__softfac__8__1/2",
        error: "could not remove the checkout: permission denied",
      },
    },
    line: lineAtT0(
      "gate_cleanup_failed",
      `{"dir":"/data/gate/rawphp__softfac__8__1/2","error":"could not remove the checkout: permission denied"}`,
    ),
  },
  {
    event: { event: "worktree_removed", data: { path: "/t3/worktrees/softfac/t3-01ac8cf3" } },
    line: lineAtT0("worktree_removed", `{"path":"/t3/worktrees/softfac/t3-01ac8cf3"}`),
  },
  {
    event: {
      event: "worktree_remove_failed",
      data: {
        path: "/t3/worktrees/softfac/t3-01ac8cf3",
        error:
          "`git worktree remove --force -- /t3/worktrees/softfac/t3-01ac8cf3` exited with status 128: fatal: cannot remove the worktree",
      },
    },
    line: lineAtT0(
      "worktree_remove_failed",
      `{"path":"/t3/worktrees/softfac/t3-01ac8cf3","error":"\`git worktree remove --force -- /t3/worktrees/softfac/t3-01ac8cf3\` exited with status 128: fatal: cannot remove the worktree"}`,
    ),
  },
  {
    event: {
      event: "checks_read",
      data: {
        sha: SHA,
        checks: [
          { name: "gate", state: "passed" },
          { name: "lint", state: "pending" },
        ],
      },
    },
    line: lineAtT0(
      "checks_read",
      `{"sha":"${SHA}","checks":[{"name":"gate","state":"passed"},{"name":"lint","state":"pending"}]}`,
    ),
  },
  {
    event: {
      event: "stuck",
      data: { reason: "the run passed its time limit", branch: "t3code/abc", commits_ahead: 2 },
    },
    line: lineAtT0(
      "stuck",
      `{"reason":"the run passed its time limit","branch":"t3code/abc","commits_ahead":2}`,
    ),
  },
  {
    event: {
      event: "error",
      data: { step: "gate", kind: "github", message: "the pull request could not be read" },
    },
    line: lineAtT0(
      "error",
      `{"step":"gate","kind":"github","message":"the pull request could not be read"}`,
    ),
  },
];

/** `finished` written as the only line of a run: the ledger fills in the summary itself. */
const finishedSample: { readonly event: RunEvent; readonly line: string } = {
  event: {
    event: "finished",
    data: {
      outcome: "pr-open",
      total_ms: 0,
      gate_attempts: 0,
      review_cycles: null,
      pr_url: null,
      pr_end: null,
    },
  },
  line: lineAtT0(
    "finished",
    `{"outcome":"pr-open","total_ms":0,"gate_attempts":0,"review_cycles":null,"pr_url":null,"pr_end":null}`,
  ),
};

/** What reading `event` written at `secs` after `T0` gives back, for a line with the test cause. */
const at = (secs: number, event: RunEvent): Entry => ({
  ts: formatTs(T0 + secs * 1000),
  ms: T0 + secs * 1000,
  event: event.event,
  data: JSON.parse(JSON.stringify(event.data)),
  cause: testCauseRead,
});

/** An entry as read from a line written before causes existed. */
const oldAt = (secs: number, event: RunEvent): Entry => ({ ...at(secs, event), cause: null });

const goodEntry = (): Entry => oldAt(0, step("red"));

/** A run file holding exactly `content`. */
const writeRun = (dataDir: string, content: string | Uint8Array) => {
  NodeFS.mkdirSync(NodePath.join(dataDir, "runs"), { recursive: true });
  NodeFS.writeFileSync(runFileFor(dataDir), content);
};

const readSoftfacRun = (dataDir: string) => readRun(dataDir, softfacRun);

const FRAGMENT = `{"ts":"2026-10-04T10:13:17.123Z","ms":17911087`;

describe("create", () => {
  it("create makes the runs dir and an empty file", () => {
    const dataDir = tempDir();
    const ledger = create(dataDir);
    expect(ledger.path).toBe(runFileFor(dataDir));
    expect(NodeFS.readFileSync(runFileFor(dataDir)).length).toBe(0);
  });

  it("create rejects an invalid run id and makes nothing", () => {
    const dataDir = tempDir();
    const error = catchLedgerError(
      () => create(dataDir, ticking(T0, 1), { ...softfacRun, repo: "../x" }),
      InvalidRunIdError,
    );
    expect(error._tag).toBe("InvalidRunIdError");
    expect(error.input).toBe("../x");
    expect(NodeFS.existsSync(NodePath.join(dataDir, "runs"))).toBe(false);
  });

  it("create on an existing file is already exists and leaves it alone", () => {
    const dataDir = tempDir();
    const ledger = create(dataDir);
    ledger.append(step("red"), testCause());
    ledger.close();
    const before = NodeFS.readFileSync(runFileFor(dataDir));

    const error = catchLedgerError(() => create(dataDir), LedgerAlreadyExistsError);
    expect(error._tag).toBe("LedgerAlreadyExistsError");
    expect(error.path).toBe(runFileFor(dataDir));
    expect(NodeFS.readFileSync(runFileFor(dataDir))).toEqual(before);
  });

  it("create now stamps events with the system clock", () => {
    const dataDir = tempDir();
    // Not T0, so a stamp from any clock but the system's would not match.
    const systemNow = 1_800_000_123_456;
    vi.useFakeTimers({ toFake: ["Date"] });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    vi.setSystemTime(systemNow);
    const ledger = Ledger.create(dataDir, softfacRun);
    handles.push(ledger);
    ledger.append(stuck(), testCause());

    const line = JSON.parse(readText(runFileFor(dataDir)).trimEnd()) as { ts: string; ms: number };
    expect(line.ms).toBe(systemNow);
    expect(line.ts).toBe(formatTs(systemNow));
  });

  it("create makes new directories private and the file owner only", () => {
    const root = tempDir();
    const dataDir = NodePath.join(root, "fresh", "data");
    create(dataDir, ticking(T0, 1));
    const mode = (path: string) => NodeFS.statSync(path).mode & 0o777;
    expect(mode(dataDir)).toBe(0o700);
    expect(mode(NodePath.join(dataDir, "runs"))).toBe(0o700);
    expect(mode(runFileFor(dataDir))).toBe(0o600);
    // The parents made on the way are not forced private: they get whatever a plain `mkdir`
    // gives here, whatever the umask is.
    NodeFS.mkdirSync(NodePath.join(root, "plain"));
    expect(mode(NodePath.join(root, "fresh"))).toBe(mode(NodePath.join(root, "plain")));
  });

  it("create does not change the mode of directories that already exist", () => {
    const dataDir = tempDir();
    const runs = NodePath.join(dataDir, "runs");
    NodeFS.mkdirSync(runs);
    for (const dir of [dataDir, runs]) NodeFS.chmodSync(dir, 0o755);
    create(dataDir, ticking(T0, 1));
    expect(NodeFS.statSync(dataDir).mode & 0o777).toBe(0o755);
    expect(NodeFS.statSync(runs).mode & 0o777).toBe(0o755);
    expect(NodeFS.statSync(runFileFor(dataDir)).mode & 0o777).toBe(0o600);
  });

  it("create in an existing data dir makes only runs private", () => {
    const dataDir = tempDir();
    NodeFS.chmodSync(dataDir, 0o755);
    create(dataDir, ticking(T0, 1));
    expect(NodeFS.statSync(dataDir).mode & 0o777).toBe(0o755);
    expect(NodeFS.statSync(NodePath.join(dataDir, "runs")).mode & 0o777).toBe(0o700);
  });

  it("create syncs runs, then the data dir, then its parent, whether or not it made them", () => {
    const root = tempDir();
    const dataDir = NodePath.join(root, "data");
    const synced: Array<string> = [];
    create(dataDir, ticking(T0, 1), softfacRun, { syncDir: (dir) => void synced.push(dir) });
    expect(synced).toEqual([NodePath.join(dataDir, "runs"), dataDir, root]);

    synced.length = 0;
    const second: RunId = { ...softfacRun, attempt: 2 };
    create(dataDir, ticking(T0, 1), second, { syncDir: (dir) => void synced.push(dir) });
    expect(synced).toEqual([NodePath.join(dataDir, "runs"), dataDir, root]);
  });

  it("a create retried after a failed sync still syncs the directories the first try made", () => {
    const root = tempDir();
    const dataDir = NodePath.join(root, "data");
    let failing = true;
    const synced: Array<string> = [];
    const syncDir = (dir: string) => {
      if (failing && dir === dataDir) throw new Error("injected disk error");
      synced.push(dir);
    };
    expect(
      catchLedgerError(
        () => create(dataDir, ticking(T0, 1), softfacRun, { syncDir }),
        LedgerIoError,
      ).path,
    ).toBe(dataDir);
    failing = false;
    synced.length = 0;
    create(dataDir, ticking(T0, 1), softfacRun, { syncDir });
    expect(synced).toEqual([NodePath.join(dataDir, "runs"), dataDir, root]);
  });

  it("create removes the file it just made if the directory sync fails", () => {
    const dataDir = tempDir();
    const error = catchLedgerError(
      () =>
        create(dataDir, ticking(T0, 1000), softfacRun, {
          syncDir: () => {
            throw new Error("injected disk error");
          },
        }),
      LedgerIoError,
    );
    expect(error._tag).toBe("LedgerIoError");
    expect(error.path).toBe(NodePath.join(dataDir, "runs"));
    expect(NodeFS.existsSync(runFileFor(dataDir))).toBe(false);

    // The retry is not blocked by an orphan.
    const ledger = create(dataDir);
    ledger.append(step("red"), testCause());
    expect(readText(runFileFor(dataDir))).toBe(RED);
  });

  it("create that finds the file already there does not remove it", () => {
    const dataDir = tempDir();
    writeRun(dataDir, RED);
    const error = catchLedgerError(() =>
      create(dataDir, ticking(T0, 1000), softfacRun, {
        syncDir: () => {
          throw new Error("injected disk error");
        },
      }),
    );
    expect(error._tag).toBe("LedgerAlreadyExistsError");
    expect(readText(runFileFor(dataDir))).toBe(RED);
  });

  it("create over a symlink named like a run is already exists and writes nothing", () => {
    const dataDir = tempDir();
    const target = NodePath.join(dataDir, "elsewhere.jsonl");
    NodeFS.mkdirSync(NodePath.join(dataDir, "runs"));
    NodeFS.symlinkSync(target, runFileFor(dataDir));
    expect(catchLedgerError(() => create(dataDir))._tag).toBe("LedgerAlreadyExistsError");
    expect(NodeFS.existsSync(target)).toBe(false);
  });
});

describe("append", () => {
  it("append writes one exact line per event type", () => {
    const dataDir = tempDir();
    const samples = [...sampleEvents, finishedSample];
    const seen = new Set<string>();
    samples.forEach(({ event, line }, i) => {
      const ledger = create(dataDir, ticking(T0, 0), { ...softfacRun, attempt: i + 1 });
      ledger.append(event, testCause());
      expect(readText(ledger.path), event.event).toBe(line);
      seen.add(event.event);
    });
    // Every one of the 33 event types has at least one exact line.
    expect([...seen].sort()).toEqual(Object.keys(RUN_EVENT_FIELDS).sort());
    expect(seen.size).toBe(33);
  });

  it("event name is the snake case type, and data holds exactly the field list in order", () => {
    const dataDir = tempDir();
    [...sampleEvents, finishedSample].forEach(({ event }, i) => {
      const ledger = create(dataDir, ticking(T0, 0), { ...softfacRun, attempt: i + 1 });
      ledger.append(event, testCause());
      const written = JSON.parse(readText(ledger.path)) as {
        event: string;
        data: Record<string, unknown>;
      };
      expect(written.event).toBe(event.event);
      const given = event.data as Record<string, unknown>;
      // A field that is left out (`undefined`) is not written; every other one is, in order.
      const expected = RUN_EVENT_FIELDS[event.event].filter((field) => given[field] !== undefined);
      expect(Object.keys(written.data), event.event).toEqual(expected);
    });
  });

  it("append writes the fields in the doc order whatever order the caller built the object in", () => {
    const dataDir = tempDir();
    const ledger = create(dataDir, ticking(T0, 0));
    ledger.append(
      {
        event: "session_launched",
        data: {
          resumed_from: { branch: "t3code/abc", run: "r" },
          model_options: null,
          model: "m",
          model_instance: "i",
          branch: "b",
          worktree: "w",
          thread_id: "t",
        },
      },
      testCause(),
    );
    expect(readText(ledger.path)).toBe(
      lineAtT0(
        "session_launched",
        `{"thread_id":"t","worktree":"w","branch":"b","model_instance":"i","model":"m","model_options":null,"resumed_from":{"run":"r","branch":"t3code/abc"}}`,
      ),
    );
  });

  it("append adds lines without changing earlier bytes", () => {
    const dataDir = tempDir();
    const ledger = create(dataDir);
    const steps: ReadonlyArray<readonly [RunEvent, string]> = [
      [
        { event: "claimed", data: { machine: "m", github_user: "u" } },
        `{"ts":"2026-10-04T10:13:16.123Z","ms":1791108796123,"event":"claimed","data":{"machine":"m","github_user":"u"},${PASS_CLAIMED}}\n`,
      ],
      [
        step("red"),
        `{"ts":"2026-10-04T10:13:17.123Z","ms":1791108797123,"event":"step_changed","data":{"step":"red"},${PASS_CLAIMED}}\n`,
      ],
      [
        stuck("r"),
        `{"ts":"2026-10-04T10:13:18.123Z","ms":1791108798123,"event":"stuck","data":{"reason":"r"},${PASS_CLAIMED}}\n`,
      ],
    ];
    let expected = "";
    for (const [event, line] of steps) {
      ledger.append(event, testCause());
      expected += line;
      expect(readText(ledger.path)).toBe(expected);
    }
  });

  it("append refuses an event name the doc does not list, writes nothing and names the event", () => {
    const dataDir = tempDir();
    const ledger = create(dataDir, ticking(T0, 0));
    ledger.append(step("red"), testCause());
    const before = readText(ledger.path);
    for (const name of ["merged", "toString", "__proto__", "constructor"]) {
      const error = catchLedgerError(
        () =>
          ledger.append({ event: name, data: { sha: "abc" } } as unknown as RunEvent, testCause()),
        LedgerUnknownEventError,
      );
      expect(error._tag).toBe("LedgerUnknownEventError");
      expect(error.event).toBe(name);
      expect(error.message).toContain(name);
    }
    expect(readText(ledger.path)).toBe(before);
    // The refusal does not mark the run finished or dirty: the next append is a clean line.
    ledger.append(step("green"), testCause());
    expect(readText(ledger.path)).toBe(`${before}${lineAtT0("step_changed", `{"step":"green"}`)}`);
  });

  it("append cleans the cause: actor, command, attempt and label come in that order and only when set", () => {
    const dataDir = tempDir();
    const ledger = create(dataDir, ticking(T0, 0));
    const events: ReadonlyArray<readonly [Cause, string]> = [
      [makeCause("start", "approved"), `{"step":"start","reason":"approved"}`],
      [
        makeCause("gate", "gate-command-ran", {
          label: "factory:ready",
          attempt: 1,
          command: "cargo test",
          actor: "alice",
        }),
        `{"step":"gate","reason":"gate-command-ran","actor":"alice","command":"cargo test","attempt":1,"label":"factory:ready"}`,
      ],
      [
        makeCause("gate", "gate-regated", { attempt: 0 }),
        `{"step":"gate","reason":"gate-regated","attempt":0}`,
      ],
      [
        makeCause("start", "new-attempt-started", { label: "factory:ready" }),
        `{"step":"start","reason":"new-attempt-started","label":"factory:ready"}`,
      ],
    ];
    let expected = "";
    for (const [cause, causeJson] of events) {
      ledger.append(step("s"), cause);
      expected += `{"ts":"2026-10-04T10:13:16.123Z","ms":1791108796123,"event":"step_changed","data":{"step":"s"},"cause":${causeJson}}\n`;
    }
    expect(readText(ledger.path)).toBe(expected);
  });

  it("append cleans a hand-built cause on the way to the file", () => {
    const dataDir = tempDir();
    const ledger = create(dataDir, ticking(T0, 1000));
    const cause: Cause = {
      step: "start",
      reason: "approved",
      actor: `al\u202ei${"x".repeat(150)}`,
      command: `a\nb${"c".repeat(1500)}`,
      label: "la\u0007bel\u2066",
    };
    ledger.append(step("s"), cause);
    const written = JSON.parse(readText(ledger.path).trimEnd()).cause;
    expect(written).toEqual({
      step: "start",
      reason: "approved",
      actor: `ali${"x".repeat(97)}`,
      command: `ab${"c".repeat(998)}`,
      label: "label",
    });
  });

  it("a cause attempt that is not a u32 is left out, so the cause still reads back", () => {
    const dataDir = tempDir();
    const ledger = create(dataDir, ticking(T0, 0));
    const handBuilt = (attempt: number): Cause => ({
      step: "gate",
      reason: "gate-regated",
      attempt,
    });
    const causes = [
      makeCause("gate", "gate-regated", { attempt: -1 }),
      handBuilt(1.5),
      handBuilt(2 ** 32),
      handBuilt(Number.NaN),
      handBuilt(4294967295),
    ];
    for (const cause of causes) ledger.append(step("s"), cause);
    expect(readSoftfacRun(dataDir).entries.map((entry) => entry.cause)).toEqual([
      { step: "gate", reason: "gate-regated" },
      { step: "gate", reason: "gate-regated" },
      { step: "gate", reason: "gate-regated" },
      { step: "gate", reason: "gate-regated" },
      { step: "gate", reason: "gate-regated", attempt: 4294967295 },
    ]);
    expect(makeCause("gate", "gate-regated", { attempt: -1 })).toEqual({
      step: "gate",
      reason: "gate-regated",
    });
  });

  it("a cause cleans actor and label of control and bidi characters and cuts them at 100, and cuts a command at 1000", () => {
    const actor = makeCause("start", "approved", { actor: "al\u0007i‮ce⁦\u0000\n\u007f\u0085" });
    expect(actor.actor).toBe("alice");
    const label = makeCause("start", "approved", { label: "x".repeat(150) });
    expect(label.label).toBe("x".repeat(100));
    // Characters, not UTF-16 units.
    const emoji = makeCause("start", "approved", { actor: "\u{1f600}".repeat(150) });
    expect([...emoji.actor!]).toHaveLength(100);
    const command = makeCause("gate", "gate-command-ran", { command: `${"c".repeat(1500)}` });
    expect(command.command).toBe("c".repeat(1000));
    // A command is cleaned the same way as the others: one line, no control characters.
    expect(makeCause("gate", "gate-command-ran", { command: "a\nb\tc" }).command).toBe("abc");
    // Nothing else goes in a cause, and an unset extra is left out.
    expect(Object.keys(makeCause("pass", "claimed"))).toEqual(["step", "reason"]);
  });
});

describe("open", () => {
  it("open a missing run is not found", () => {
    const dataDir = tempDir();
    const error = catchLedgerError(() => reopen(dataDir), LedgerNotFoundError);
    expect(error._tag).toBe("LedgerNotFoundError");
    expect(error.path).toBe(runFileFor(dataDir));
  });

  it("open appends after the existing lines", () => {
    const dataDir = tempDir();
    const ledger = create(dataDir);
    ledger.append(step("red"), testCause());
    ledger.close();

    const second = reopen(dataDir, ticking(T0 + 5000, 1000));
    second.append(step("green"), testCause());
    expect(readText(runFileFor(dataDir))).toBe(
      `${RED}{"ts":"2026-10-04T10:13:21.123Z","ms":1791108801123,"event":"step_changed","data":{"step":"green"},${PASS_CLAIMED}}\n`,
    );
  });

  it("open leaves a file that ends in a newline alone", () => {
    const dataDir = tempDir();
    writeRun(dataDir, GOOD_LINE);
    reopen(dataDir, ticking(T0, 1));
    expect(readText(runFileFor(dataDir))).toBe(GOOD_LINE);
  });

  it("open terminates an incomplete last line before appending", () => {
    const dataDir = tempDir();
    writeRun(dataDir, `${GOOD_LINE}${FRAGMENT}`);

    const ledger = reopen(dataDir, ticking(T0 + 9000, 1000));
    expect(readText(runFileFor(dataDir))).toBe(`${GOOD_LINE}${FRAGMENT}\n`);

    ledger.append(stuck("r"), testCause());
    expect(readText(runFileFor(dataDir))).toBe(
      `${GOOD_LINE}${FRAGMENT}\n{"ts":"2026-10-04T10:13:25.123Z","ms":1791108805123,"event":"stuck","data":{"reason":"r"},${PASS_CLAIMED}}\n`,
    );
  });

  it("open rebuilds start time and gate attempts from the file", () => {
    const dataDir = tempDir();
    const ledger = create(dataDir);
    ledger.append(step("red"), testCause());
    ledger.append(gate(1, "cargo test"), testCause());
    ledger.close();

    const second = reopen(dataDir, ticking(T0 + 60_000, 1000));
    second.append(gate(2, "cargo test"), testCause());
    second.finish("pr-open", null, null, testCause());
    expect(lastLine(dataDir)).toBe(
      `{"ts":"2026-10-04T10:14:17.123Z","ms":1791108857123,"event":"finished","data":{"outcome":"pr-open","total_ms":61000,"gate_attempts":2,"review_cycles":null,"pr_url":null,"pr_end":null},${PASS_CLAIMED}}`,
    );
  });

  it("open a finished run then append is an error and writes nothing", () => {
    const dataDir = tempDir();
    const ledger = create(dataDir);
    ledger.finish("stuck", null, null, testCause());
    ledger.close();
    const before = NodeFS.readFileSync(runFileFor(dataDir));

    const second = reopen(dataDir);
    expect(catchLedgerError(() => second.append(stuck(), testCause()))._tag).toBe(
      "LedgerAlreadyFinishedError",
    );
    expect(NodeFS.readFileSync(runFileFor(dataDir))).toEqual(before);
  });

  it("a finished line this code cannot read still ends the run after open", () => {
    const dataDir = tempDir();
    const newerFinished = `{"ts":"2026-10-04T10:13:17.123Z","ms":1791108797123,"event":"finished","data":{"outcome":"merged","total_ms":"soon"}}\n`;
    writeRun(dataDir, `${RED}${newerFinished}`);
    const before = NodeFS.readFileSync(runFileFor(dataDir));
    const ledger = reopen(dataDir);
    expect(catchLedgerError(() => ledger.append(step("green"), testCause()))._tag).toBe(
      "LedgerAlreadyFinishedError",
    );
    expect(catchLedgerError(() => ledger.finish("stuck", null, null, testCause()))._tag).toBe(
      "LedgerAlreadyFinishedError",
    );
    expect(NodeFS.readFileSync(runFileFor(dataDir))).toEqual(before);
  });

  it("a gate command line that does not parse is not counted", () => {
    const dataDir = tempDir();
    const bad = `{"ts":"2026-10-04T10:13:16.123Z","ms":1791108796123,"event":"gate_command","data":{"attempt":"two","command":"c"}}\n`;
    writeRun(dataDir, `${bad}${bad}`);
    const ledger = reopen(dataDir, ticking(T0 + 5000, 1000));
    ledger.append(gate(1, "cargo test"), testCause());
    ledger.finish("stuck", null, null, testCause());
    expect(lastLine(dataDir)).toBe(
      `{"ts":"2026-10-04T10:13:22.123Z","ms":1791108802123,"event":"finished","data":{"outcome":"stuck","total_ms":6000,"gate_attempts":1,"review_cycles":null,"pr_url":null,"pr_end":null},${PASS_CLAIMED}}`,
    );
  });

  it("a gate command line counts only when every field parses", () => {
    const dataDir = tempDir();
    const line = (data: string) =>
      `{"ts":"2026-10-04T10:13:16.123Z","ms":1791108796123,"event":"gate_command","data":${data}}\n`;
    writeRun(
      dataDir,
      [
        // No exit_code.
        line(`{"attempt":2,"command":"c","duration_ms":5}`),
        // A string duration_ms.
        line(`{"attempt":3,"command":"c","exit_code":0,"duration_ms":"5"}`),
        // A non-integer exit_code.
        line(`{"attempt":4,"command":"c","exit_code":1.5,"duration_ms":5}`),
        // A negative duration_ms is not a u64.
        line(`{"attempt":5,"command":"c","exit_code":0,"duration_ms":-1}`),
        // An exit_code outside i32.
        line(`{"attempt":6,"command":"c","exit_code":2147483648,"duration_ms":5}`),
        // A missing command.
        line(`{"attempt":7,"exit_code":0,"duration_ms":5}`),
        // An attempt below or above u32.
        line(`{"attempt":-1,"command":"c","exit_code":0,"duration_ms":5}`),
        line(`{"attempt":4294967296,"command":"c","exit_code":0,"duration_ms":5}`),
      ].join(""),
    );
    const ledger = reopen(dataDir, ticking(T0 + 5000, 1000));
    ledger.append(gate(1, "cargo test"), testCause());
    ledger.finish("stuck", null, null, testCause());
    expect(lastLine(dataDir)).toContain(`"gate_attempts":1,`);
  });

  it("read and open refuse a symlink named like a run", () => {
    const dataDir = tempDir();
    const target = NodePath.join(dataDir, "elsewhere.jsonl");
    NodeFS.writeFileSync(target, RED);
    NodeFS.mkdirSync(NodePath.join(dataDir, "runs"));
    NodeFS.symlinkSync(target, runFileFor(dataDir));

    const readError = catchLedgerError(() => readSoftfacRun(dataDir), LedgerNotFoundError);
    expect(readError._tag).toBe("LedgerNotFoundError");
    expect(readError.path).toBe(runFileFor(dataDir));
    const openError = catchLedgerError(() => reopen(dataDir), LedgerNotFoundError);
    expect(openError._tag).toBe("LedgerNotFoundError");
    expect(openError.path).toBe(runFileFor(dataDir));
    expect(readText(target)).toBe(RED);
    // Nothing was created or truncated through the link.
    expect(NodeFS.lstatSync(runFileFor(dataDir)).isSymbolicLink()).toBe(true);
    expect(NodeFS.readdirSync(NodePath.join(dataDir, "runs"))).toEqual([
      NodePath.basename(runFileFor(dataDir)),
    ]);
  });

  effectIt.effect(
    "a ledger error is caught by its tag in an Effect and keeps softfac's message",
    () =>
      Effect.gen(function* () {
        const dataDir = tempDir();
        const error = catchLedgerError(() => reopen(dataDir));
        const caught = yield* Effect.fail(error).pipe(
          Effect.catchTags({
            LedgerNotFoundError: (failure) => Effect.succeed(failure.path),
            LedgerIoError: () => Effect.succeed("io"),
          }),
        );
        expect(caught).toBe(runFileFor(dataDir));
        expect(error.message).toBe(`no run file at ${runFileFor(dataDir)}`);
      }),
  );

  it("open a missing run is not found and creates no file", () => {
    const dataDir = tempDir();
    expect(catchLedgerError(() => reopen(dataDir))._tag).toBe("LedgerNotFoundError");
    expect(NodeFS.existsSync(runFileFor(dataDir))).toBe(false);
    // The same with a runs directory that exists but holds no such run.
    NodeFS.mkdirSync(NodePath.join(dataDir, "runs"));
    expect(catchLedgerError(() => reopen(dataDir))._tag).toBe("LedgerNotFoundError");
    expect(NodeFS.existsSync(runFileFor(dataDir))).toBe(false);
  });

  it("read and open refuse a directory named like a run", () => {
    const dataDir = tempDir();
    NodeFS.mkdirSync(runFileFor(dataDir), { recursive: true });
    expect(catchLedgerError(() => readSoftfacRun(dataDir))._tag).toBe("LedgerNotFoundError");
    expect(catchLedgerError(() => reopen(dataDir))._tag).toBe("LedgerNotFoundError");
  });

  it("open counts a whole finished line that a crash left without its newline", () => {
    const dataDir = tempDir();
    writeRun(dataDir, `${RED}${finishedSample.line.trimEnd()}`);
    const ledger = reopen(dataDir);
    const before = NodeFS.readFileSync(runFileFor(dataDir));
    expect(catchLedgerError(() => ledger.append(step("green"), testCause()))._tag).toBe(
      "LedgerAlreadyFinishedError",
    );
    expect(NodeFS.readFileSync(runFileFor(dataDir))).toEqual(before);
  });

  it("open counts a whole gate command line that a crash left without its newline", () => {
    const dataDir = tempDir();
    writeRun(
      dataDir,
      `{"ts":"2026-10-04T10:13:16.123Z","ms":1791108796123,"event":"gate_command","data":{"attempt":1,"command":"c","exit_code":0,"duration_ms":5}}`,
    );
    const ledger = reopen(dataDir, ticking(T0 + 5000, 1000));
    ledger.finish("stuck", null, null, testCause());
    expect(lastLine(dataDir)).toContain(`"total_ms":5000,"gate_attempts":1,`);
  });

  it("a handle refuses to append after another handle finished the run", () => {
    const dataDir = tempDir();
    const first = create(dataDir);
    const second = reopen(dataDir);
    first.finish("stuck", null, null, testCause());
    const before = NodeFS.readFileSync(runFileFor(dataDir));
    expect(catchLedgerError(() => second.append(step("green"), testCause()))._tag).toBe(
      "LedgerAlreadyFinishedError",
    );
    expect(catchLedgerError(() => second.finish("stuck", null, null, testCause()))._tag).toBe(
      "LedgerAlreadyFinishedError",
    );
    expect(NodeFS.readFileSync(runFileFor(dataDir))).toEqual(before);
  });

  it("a handle's finish counts the lines another handle wrote after it opened", () => {
    const dataDir = tempDir();
    const first = create(dataDir, scripted([T0, T0 + 1000]));
    const second = reopen(dataDir, scripted([T0 + 2000, T0 + 9000]));
    first.append(step("red"), testCause());
    first.append(gate(1, "cargo test"), testCause());
    second.append(gate(2, "cargo test"), testCause());
    second.finish("stuck", null, null, testCause());
    expect(lastLine(dataDir)).toContain(`"total_ms":9000,"gate_attempts":2,`);
  });

  it("a created ledger and a reopened one interleave appends without overwriting", () => {
    const dataDir = tempDir();
    const first = create(dataDir, ticking(T0, 10_000));
    const second = reopen(dataDir, ticking(T0 + 1000, 10_000));
    first.append(step("red"), testCause());
    second.append(step("green"), testCause());
    first.append(step("refactor"), testCause());
    second.append(step("ship"), testCause());
    expect(readText(runFileFor(dataDir))).toBe(
      `${RED}${GREEN}{"ts":"2026-10-04T10:13:26.123Z","ms":1791108806123,"event":"step_changed","data":{"step":"refactor"},${PASS_CLAIMED}}\n{"ts":"2026-10-04T10:13:27.123Z","ms":1791108807123,"event":"step_changed","data":{"step":"ship"},${PASS_CLAIMED}}\n`,
    );
  });
});

describe("read", () => {
  it("read gives back every event type equal", () => {
    const dataDir = tempDir();
    const ledger = create(dataDir);
    for (const { event } of sampleEvents) ledger.append(event, testCause());
    ledger.close();

    const record = readSoftfacRun(dataDir);
    expect(record.id).toEqual(softfacRun);
    expect(record.entries).toEqual(sampleEvents.map(({ event }, i) => at(i, event)));
    expect(record.truncated).toBe(false);
    expect(record.skipped).toBe(0);
  });

  it("read an empty file is an empty untruncated record", () => {
    const dataDir = tempDir();
    writeRun(dataDir, "");
    expect(readSoftfacRun(dataDir)).toEqual({
      id: softfacRun,
      entries: [],
      truncated: false,
      skipped: 0,
    });
  });

  it("read a missing run is not found", () => {
    const dataDir = tempDir();
    const error = catchLedgerError(() => readSoftfacRun(dataDir), LedgerNotFoundError);
    expect(error._tag).toBe("LedgerNotFoundError");
    expect(error.path).toBe(runFileFor(dataDir));
  });

  it("read refuses an invalid run id", () => {
    const dataDir = tempDir();
    const error = catchLedgerError(
      () => readRun(dataDir, { ...softfacRun, repo: "../x" }),
      InvalidRunIdError,
    );
    expect(error._tag).toBe("InvalidRunIdError");
    expect(error.input).toBe("../x");
  });

  it("read drops a last line cut off mid json", () => {
    const dataDir = tempDir();
    writeRun(dataDir, `${GOOD_LINE}${FRAGMENT}`);
    const record = readSoftfacRun(dataDir);
    expect(record.entries).toEqual([goodEntry()]);
    expect(record.truncated).toBe(true);
    expect(record.skipped).toBe(0);
  });

  it("read drops a last line with no newline even if it is valid json", () => {
    const dataDir = tempDir();
    writeRun(dataDir, GOOD_LINE.trimEnd());
    const record = readSoftfacRun(dataDir);
    expect(record.entries).toEqual([]);
    expect(record.truncated).toBe(true);
    expect(record.skipped).toBe(0);
  });

  it("read drops a last line that ends in a newline but is not json", () => {
    const dataDir = tempDir();
    writeRun(dataDir, `${GOOD_LINE}{"ts":\n`);
    const record = readSoftfacRun(dataDir);
    expect(record.entries).toEqual([goodEntry()]);
    expect(record.truncated).toBe(true);
    expect(record.skipped).toBe(0);
  });

  it("read skips and counts an invalid line in the middle", () => {
    const dataDir = tempDir();
    writeRun(dataDir, `${GOOD_LINE}not json at all\n${GOOD_LINE}`);
    const record = readSoftfacRun(dataDir);
    expect(record.entries).toEqual([goodEntry(), goodEntry()]);
    expect(record.truncated).toBe(false);
    expect(record.skipped).toBe(1);
  });

  it("read skips lines that are not ledger lines", () => {
    const dataDir = tempDir();
    const bad: ReadonlyArray<Uint8Array> = [
      Buffer.from("[]\n"),
      Buffer.from("42\n"),
      Buffer.from(`{"event":"stuck","data":{"reason":"r"}}\n`),
      Buffer.from(`{"ts":"t","ms":"1","event":"stuck","data":{"reason":"r"}}\n`),
      Buffer.from([0xff, 0xfe, 0x0a]),
    ];
    writeRun(dataDir, Buffer.concat(bad.flatMap((line) => [line, Buffer.from(GOOD_LINE)])));
    const record = readSoftfacRun(dataDir);
    expect(record.entries).toHaveLength(5);
    expect(record.truncated).toBe(false);
    expect(record.skipped).toBe(5);
  });

  it("read skips a line whose ms, ts or event has the wrong type or is not a whole number", () => {
    const line = (fields: string) => `{${fields},"data":{}}\n`;
    const content = [
      line(`"ts":"t","ms":1.5,"event":"e"`),
      line(`"ts":"t","ms":-1,"event":"e"`),
      line(`"ts":1,"ms":1,"event":"e"`),
      line(`"ts":"t","ms":1,"event":5`),
      line(`"ts":"t","ms":null,"event":"e"`),
      line(`"ts":"t","ms":0,"event":"e"`),
    ].join("");
    const { entries, truncated, skipped } = parseLines(Buffer.from(content));
    expect(entries).toEqual([{ ts: "t", ms: 0, event: "e", data: {}, cause: null }]);
    expect(truncated).toBe(false);
    expect(skipped).toBe(5);
  });

  it("read after open and append keeps old entries and skips the fragment", () => {
    const dataDir = tempDir();
    writeRun(dataDir, `${GOOD_LINE}${FRAGMENT}`);
    const ledger = reopen(dataDir, ticking(T0 + 9000, 1000));
    ledger.append(stuck("r"), testCause());

    const record = readSoftfacRun(dataDir);
    expect(record.entries).toEqual([goodEntry(), at(9, stuck("r"))]);
    expect(record.truncated).toBe(false);
    expect(record.skipped).toBe(1);
  });

  it("read keeps an unknown event type as written", () => {
    const dataDir = tempDir();
    writeRun(
      dataDir,
      `{"ts":"2026-10-04T10:13:16.123Z","ms":1791108796123,"event":"merged","data":{"sha":"abc","n":1}}\n`,
    );
    expect(readSoftfacRun(dataDir).entries).toEqual([
      {
        ts: "2026-10-04T10:13:16.123Z",
        ms: T0,
        event: "merged",
        data: { sha: "abc", n: 1 },
        cause: null,
      },
    ]);
  });

  it("read keeps a known type with the wrong data and a missing data key as written", () => {
    const dataDir = tempDir();
    writeRun(
      dataDir,
      `{"ts":"2026-10-04T10:13:16.123Z","ms":1791108796123,"event":"claimed","data":{"machine":1}}\n{"ts":"2026-10-04T10:13:16.123Z","ms":1791108796123,"event":"stuck"}\n`,
    );
    const record = readSoftfacRun(dataDir);
    expect(record.entries).toEqual([
      {
        ts: "2026-10-04T10:13:16.123Z",
        ms: T0,
        event: "claimed",
        data: { machine: 1 },
        cause: null,
      },
      { ts: "2026-10-04T10:13:16.123Z", ms: T0, event: "stuck", data: null, cause: null },
    ]);
    expect(record.skipped).toBe(0);
  });

  it("read keeps a state changed with an unknown state name as written", () => {
    const dataDir = tempDir();
    writeRun(
      dataDir,
      `{"ts":"2026-10-04T10:13:16.123Z","ms":1791108796123,"event":"state_changed","data":{"from":"building","to":"merged"}}\n`,
    );
    expect(readSoftfacRun(dataDir).entries).toEqual([
      oldAt(0, {
        event: "state_changed",
        data: { from: "building", to: "merged" },
      } as unknown as RunEvent),
    ]);
  });

  it("lines of the answer step that older versions wrote still read", () => {
    // The `answer` step, the `needs-info-nudged` step and the `unanswered` and `kept-asking`
    // reasons are no longer written. A ledger that holds them reads as it was written.
    const dataDir = tempDir();
    const prefix = `{"ts":"2026-10-04T10:13:16.123Z","ms":1791108796123,"event"`;
    writeRun(
      dataDir,
      [
        `${prefix}:"stuck","data":{"reason":"the questions went unanswered"},"cause":{"step":"answer","reason":"unanswered"}}\n`,
        `${prefix}:"step_changed","data":{"step":"needs-info-nudged"},"cause":{"step":"answer","reason":"needs-info-nudged"}}\n`,
        `${prefix}:"state_changed","data":{"from":"needs-info","to":"building"},"cause":{"step":"answer","reason":"reply-received"}}\n`,
      ].join(""),
    );
    const { entries, skipped } = readSoftfacRun(dataDir);
    expect(skipped).toBe(0);
    expect(entries.map((entry) => [entry.event, entry.data, entry.cause])).toEqual([
      [
        "stuck",
        { reason: "the questions went unanswered" },
        { step: "answer", reason: "unanswered" },
      ],
      [
        "step_changed",
        { step: "needs-info-nudged" },
        { step: "answer", reason: "needs-info-nudged" },
      ],
      [
        "state_changed",
        { from: "needs-info", to: "building" },
        { step: "answer", reason: "reply-received" },
      ],
    ]);
  });

  it("lines written before this change with a numeric comment id still read", () => {
    const dataDir = tempDir();
    const prefix = `{"ts":"2026-10-04T10:13:16.123Z","ms":1791108796123,"event"`;
    writeRun(
      dataDir,
      [
        `${prefix}:"answer_received","data":{"comment_id":42,"body_edited":false},${PASS_CLAIMED}}\n`,
        `${prefix}:"comment_forwarded","data":{"comment_id":42},${PASS_CLAIMED}}\n`,
      ].join(""),
    );
    const { entries } = readSoftfacRun(dataDir);
    expect(entries.map((entry) => [entry.event, entry.data, entry.cause])).toEqual([
      ["answer_received", { comment_id: 42, body_edited: false }, testCauseRead],
      ["comment_forwarded", { comment_id: 42 }, testCauseRead],
    ]);
  });

  it("lines from before the pr end and model fields read as written", () => {
    const oldFinished = `{"ts":"2026-10-04T10:13:16.123Z","ms":1791108796123,"event":"finished","data":{"outcome":"pr-open","total_ms":3000,"gate_attempts":1,"review_cycles":null,"pr_url":null},${PASS_CLAIMED}}\n`;
    const oldLaunched = `{"ts":"2026-10-04T10:13:16.123Z","ms":1791108796123,"event":"session_launched","data":{"thread_id":"thr_1","worktree":null,"branch":null},${PASS_CLAIMED}}\n`;
    const { entries, truncated, skipped } = parseLines(Buffer.from(`${oldLaunched}${oldFinished}`));
    expect([truncated, skipped]).toEqual([false, 0]);
    expect(entries[0]?.data).toEqual({ thread_id: "thr_1", worktree: null, branch: null });
    expect(entries[1]?.data).toEqual({
      outcome: "pr-open",
      total_ms: 3000,
      gate_attempts: 1,
      review_cycles: null,
      pr_url: null,
    });
  });

  it("a stuck line with a branch and commits round trips and an old one reads without", () => {
    const dataDir = tempDir();
    const id: RunId = { repo: "o/r", issue: "1", attempt: 1 };
    const ledger = create(dataDir, ticking(T0, 1), id);
    const event: RunEvent = {
      event: "stuck",
      data: { reason: "the run passed its time limit", branch: "t3code/abc", commits_ahead: 2 },
    };
    ledger.append(event, testCause());
    expect(readText(ledger.path)).toContain(
      `"data":{"reason":"the run passed its time limit","branch":"t3code/abc","commits_ahead":2}`,
    );
    expect(readRun(dataDir, id).entries[0]?.data).toEqual(event.data);

    const old = `{"ts":"2026-10-04T10:13:16.123Z","ms":1791108796123,"event":"stuck","data":{"reason":"gate failed 3 times"},${PASS_CLAIMED}}\n`;
    expect(parseLines(Buffer.from(old)).entries[0]?.data).toEqual({
      reason: "gate failed 3 times",
    });
  });

  it("read ignores empty lines without counting them", () => {
    for (const [name, content] of [
      ["lf", `${GOOD_LINE}\n${GOOD_LINE}`],
      ["crlf", `${GOOD_LINE}\r\n${GOOD_LINE}`],
      ["several", `\n${GOOD_LINE}\n\r\n\n${GOOD_LINE}`],
    ] as const) {
      const dataDir = tempDir();
      writeRun(dataDir, content);
      const record = readSoftfacRun(dataDir);
      expect(record.entries, name).toEqual([goodEntry(), goodEntry()]);
      expect(record.truncated, name).toBe(false);
      expect(record.skipped, name).toBe(0);
    }
  });

  it("read an empty final line is not a truncation", () => {
    for (const [name, content] of [
      ["blank-last", `${GOOD_LINE}\n`],
      ["cr-last", `${GOOD_LINE}\r\n`],
      ["bare-cr-tail", `${GOOD_LINE}\r`],
      ["only-newlines", "\n\n"],
    ] as const) {
      const dataDir = tempDir();
      writeRun(dataDir, content);
      const record = readSoftfacRun(dataDir);
      expect(record.entries, name).toEqual(content.includes('{"ts"') ? [goodEntry()] : []);
      expect(record.truncated, name).toBe(false);
      expect(record.skipped, name).toBe(0);
    }
  });

  it("a blank line does not hide a real truncation", () => {
    const dataDir = tempDir();
    writeRun(dataDir, `${GOOD_LINE}\n{"ts":"2026`);
    const record = readSoftfacRun(dataDir);
    expect(record.entries).toEqual([goodEntry()]);
    expect(record.truncated).toBe(true);
    expect(record.skipped).toBe(0);
  });

  it("a cause that is not an object with a step and a reason reads as no cause, and one that is keeps its extra keys", () => {
    const base = `{"ts":"2026-10-04T10:13:16.123Z","ms":1791108796123,"event":"stuck","data":{"reason":"r"}`;
    const causes: ReadonlyArray<readonly [string, unknown]> = [
      [`"cause":null`, null],
      [`"cause":"claimed"`, null],
      [`"cause":["pass","claimed"]`, null],
      [`"cause":{"step":"pass"}`, null],
      [`"cause":{"reason":"claimed"}`, null],
      [`"cause":{"step":1,"reason":"claimed"}`, null],
      [`"cause":{"step":"pass","reason":"claimed","attempt":"1"}`, null],
      [`"cause":{"step":"pass","reason":"claimed","actor":5}`, null],
      [
        `"cause":{"step":"newer","reason":"unknown-code","actor":"alice","attempt":2,"extra":{"k":1}}`,
        { step: "newer", reason: "unknown-code", actor: "alice", attempt: 2, extra: { k: 1 } },
      ],
    ];
    const dataDir = tempDir();
    writeRun(dataDir, causes.map(([cause]) => `${base},${cause}}\n`).join(""));
    const record = readSoftfacRun(dataDir);
    expect(record.skipped).toBe(0);
    expect(record.entries.map((entry) => entry.cause)).toEqual(causes.map(([, read]) => read));
  });
});

describe("finish", () => {
  it("finishing a run removes its feedback read file", () => {
    const dataDir = tempDir();
    const ledger = create(dataDir);
    const file = feedbackReadFile(dataDir, softfacRun);
    NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
    NodeFS.writeFileSync(file, "1000");
    ledger.finish("stuck", null, null, testCause());
    expect(NodeFS.existsSync(file)).toBe(false);
  });

  it("a run that never wrote a feedback read file finishes", () => {
    const dataDir = tempDir();
    const ledger = create(dataDir);
    ledger.finish("stuck", null, null, testCause());
    expect(NodeFS.existsSync(NodePath.join(dataDir, "feedback"))).toBe(false);
  });

  it("a reopened run removes its feedback read file when it finishes", () => {
    const dataDir = tempDir();
    create(dataDir);
    const file = feedbackReadFile(dataDir, softfacRun);
    NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
    NodeFS.writeFileSync(file, "1000");
    const ledger = reopen(dataDir);
    ledger.finish("stuck", null, null, testCause());
    expect(NodeFS.existsSync(file)).toBe(false);
  });

  it("finish writes the summary line with total time and zero gate attempts", () => {
    const dataDir = tempDir();
    const ledger = create(dataDir, scripted([T0, T0 + 90_000]));
    ledger.append({ event: "claimed", data: { machine: "m", github_user: "u" } }, testCause());
    ledger.finish("pr-open", 2, "https://github.com/rawphp/softfac/pull/12", testCause());
    expect(readText(runFileFor(dataDir))).toBe(
      `{"ts":"2026-10-04T10:13:16.123Z","ms":1791108796123,"event":"claimed","data":{"machine":"m","github_user":"u"},${PASS_CLAIMED}}\n` +
        `{"ts":"2026-10-04T10:14:46.123Z","ms":1791108886123,"event":"finished","data":{"outcome":"pr-open","total_ms":90000,"gate_attempts":0,"review_cycles":2,"pr_url":"https://github.com/rawphp/softfac/pull/12","pr_end":null},${PASS_CLAIMED}}\n`,
    );
  });

  it("finish counts commands in one attempt as one attempt", () => {
    const dataDir = tempDir();
    const ledger = create(dataDir);
    for (const command of ["cargo fmt --check", "cargo clippy", "cargo test"]) {
      ledger.append(gate(1, command), testCause());
    }
    ledger.finish("pr-open", null, null, testCause());
    expect(lastLine(dataDir)).toBe(
      `{"ts":"2026-10-04T10:13:19.123Z","ms":1791108799123,"event":"finished","data":{"outcome":"pr-open","total_ms":3000,"gate_attempts":1,"review_cycles":null,"pr_url":null,"pr_end":null},${PASS_CLAIMED}}`,
    );
  });

  it("finish counts distinct gate attempts", () => {
    const dataDir = tempDir();
    const ledger = create(dataDir);
    for (const [attempt, command] of [
      [1, "cargo fmt --check"],
      [1, "cargo test"],
      [2, "cargo fmt --check"],
      [2, "cargo test"],
      [3, "cargo test"],
    ] as const) {
      ledger.append(gate(attempt, command), testCause());
    }
    ledger.finish("stuck", null, null, testCause());
    expect(lastLine(dataDir)).toBe(
      `{"ts":"2026-10-04T10:13:21.123Z","ms":1791108801123,"event":"finished","data":{"outcome":"stuck","total_ms":5000,"gate_attempts":3,"review_cycles":null,"pr_url":null,"pr_end":null},${PASS_CLAIMED}}`,
    );
  });

  it("a gate checkout line is not a gate attempt by itself", () => {
    const dataDir = tempDir();
    const ledger = create(dataDir);
    ledger.append(
      {
        event: "gate_checkout",
        data: { attempt: 1, dir: "/d", sha: "a".repeat(40), base_sha: "b".repeat(40) },
      },
      testCause(),
    );
    ledger.append(
      { event: "gate_cleanup_failed", data: { dir: "/d", error: "busy" } },
      testCause(),
    );
    ledger.finish("stuck", null, null, testCause());
    expect(lastLine(dataDir)).toBe(
      `{"ts":"2026-10-04T10:13:18.123Z","ms":1791108798123,"event":"finished","data":{"outcome":"stuck","total_ms":2000,"gate_attempts":0,"review_cycles":null,"pr_url":null,"pr_end":null},${PASS_CLAIMED}}`,
    );
  });

  it("a gate sent back line is not a gate attempt by itself", () => {
    const dataDir = tempDir();
    const ledger = create(dataDir);
    ledger.append(gate(1, "cargo test"), testCause());
    for (const attempt of [1, 2, 3]) {
      ledger.append({ event: "gate_sent_back", data: { attempt, run_ordinal: 1 } }, testCause());
    }
    ledger.finish("stuck", null, null, testCause());
    expect(lastLine(dataDir)).toBe(
      `{"ts":"2026-10-04T10:13:20.123Z","ms":1791108800123,"event":"finished","data":{"outcome":"stuck","total_ms":4000,"gate_attempts":1,"review_cycles":null,"pr_url":null,"pr_end":null},${PASS_CLAIMED}}`,
    );
  });

  it("finish counts distinct attempt numbers not the highest", () => {
    const dataDir = tempDir();
    const ledger = create(dataDir);
    ledger.append(gate(1, "cargo test"), testCause());
    ledger.append(gate(3, "cargo test"), testCause());
    ledger.finish("needs-info", 0, null, testCause());
    expect(lastLine(dataDir)).toBe(
      `{"ts":"2026-10-04T10:13:18.123Z","ms":1791108798123,"event":"finished","data":{"outcome":"needs-info","total_ms":2000,"gate_attempts":2,"review_cycles":0,"pr_url":null,"pr_end":null},${PASS_CLAIMED}}`,
    );
  });

  it("finish as the only line has zero total time", () => {
    const dataDir = tempDir();
    const ledger = create(dataDir);
    ledger.finish("stuck", null, null, testCause());
    expect(lastLine(dataDir)).toBe(
      `{"ts":"2026-10-04T10:13:16.123Z","ms":1791108796123,"event":"finished","data":{"outcome":"stuck","total_ms":0,"gate_attempts":0,"review_cycles":null,"pr_url":null,"pr_end":null},${PASS_CLAIMED}}`,
    );
  });

  it("finish total time never goes negative if the clock steps back", () => {
    const dataDir = tempDir();
    const ledger = create(dataDir, scripted([T0, T0 - 5000]));
    ledger.append(step("red"), testCause());
    ledger.finish("stuck", null, null, testCause());
    expect(lastLine(dataDir)).toContain(`"total_ms":0,`);
  });

  it("append computes the summary even if the caller filled it in", () => {
    const dataDir = tempDir();
    const ledger = create(dataDir);
    ledger.append(gate(1, "cargo test"), testCause());
    ledger.append(
      {
        event: "finished",
        data: {
          outcome: "stuck",
          total_ms: 999_999,
          gate_attempts: 99,
          review_cycles: null,
          pr_url: null,
          pr_end: null,
        },
      },
      testCause(),
    );
    expect(lastLine(dataDir)).toBe(
      `{"ts":"2026-10-04T10:13:17.123Z","ms":1791108797123,"event":"finished","data":{"outcome":"stuck","total_ms":1000,"gate_attempts":1,"review_cycles":null,"pr_url":null,"pr_end":null},${PASS_CLAIMED}}`,
    );
  });

  it("finished reads back as a finished event", () => {
    const dataDir = tempDir();
    const ledger = create(dataDir);
    ledger.append(gate(1, "cargo test"), testCause());
    ledger.finish("pr-open", 1, "https://x/pull/1", testCause());
    ledger.close();
    expect(readSoftfacRun(dataDir).entries[1]).toEqual(
      at(1, {
        event: "finished",
        data: {
          outcome: "pr-open",
          total_ms: 1000,
          gate_attempts: 1,
          review_cycles: 1,
          pr_url: "https://x/pull/1",
          pr_end: null,
        },
      }),
    );
  });

  it("append after finished is an error and writes nothing", () => {
    const dataDir = tempDir();
    const ledger = create(dataDir);
    ledger.finish("stuck", null, null, testCause());
    const before = NodeFS.readFileSync(runFileFor(dataDir));
    for (const attempt of [
      () => ledger.append(stuck(), testCause()),
      () => ledger.finish("stuck", null, null, testCause()),
    ]) {
      const error = catchLedgerError(attempt, LedgerAlreadyFinishedError);
      expect(error._tag).toBe("LedgerAlreadyFinishedError");
      expect(error.path).toBe(runFileFor(dataDir));
    }
    expect(NodeFS.readFileSync(runFileFor(dataDir))).toEqual(before);
  });

  it("a finish with a pr end writes it last and reads back", () => {
    for (const prEnd of ["merged", "closed"] as const) {
      const dataDir = tempDir();
      const ledger = create(dataDir);
      ledger.finish("pr-open", null, "https://x/pull/1", testCause(), prEnd);
      ledger.close();
      expect(lastLine(dataDir)).toContain(
        `"pr_url":"https://x/pull/1","pr_end":"${prEnd}"},"cause"`,
      );
      expect(readSoftfacRun(dataDir).entries[0]?.data).toEqual({
        outcome: "pr-open",
        total_ms: 0,
        gate_attempts: 0,
        review_cycles: null,
        pr_url: "https://x/pull/1",
        pr_end: prEnd,
      });
    }
  });

  it("a plain finish writes a null pr end", () => {
    const dataDir = tempDir();
    create(dataDir).finish("stuck", null, null, testCause());
    expect(lastLine(dataDir)).toContain(`"pr_url":null,"pr_end":null}`);
  });

  it("append keeps the pr end when it fills in the summary", () => {
    const dataDir = tempDir();
    create(dataDir).append(
      {
        event: "finished",
        data: {
          outcome: "pr-open",
          total_ms: 0,
          gate_attempts: 0,
          review_cycles: null,
          pr_url: null,
          pr_end: "closed",
        },
      },
      testCause(),
    );
    expect(lastLine(dataDir)).toContain(`"pr_end":"closed"`);
  });
});

/** What the injected `AppendIo` should do wrong, once, and what it was asked to do. */
type Faults = {
  /** The next write puts this many bytes into the real file and then fails. */
  failWriteAfter: number | null;
  failSync: boolean;
  calls: Array<"write" | "sync">;
  /** At most this many bytes go into the file per write call (a short write). */
  maxPerWrite: number | null;
};

/** A real file that fails on demand, standing in for a full or failing disk. */
const faultyIo = (): { io: AppendIo; faults: Faults } => {
  const faults: Faults = { failWriteAfter: null, failSync: false, calls: [], maxPerWrite: null };
  const io: AppendIo = {
    writeSync(fd, buffer) {
      faults.calls.push("write");
      if (faults.failWriteAfter !== null) {
        const keep = faults.failWriteAfter;
        faults.failWriteAfter = null;
        NodeFS.writeSync(fd, buffer.subarray(0, Math.min(keep, buffer.length)));
        throw new Error("injected disk error");
      }
      const limit = faults.maxPerWrite ?? buffer.length;
      return NodeFS.writeSync(fd, buffer.subarray(0, limit));
    },
    fsyncSync(fd) {
      faults.calls.push("sync");
      if (faults.failSync) {
        faults.failSync = false;
        throw new Error("injected disk error");
      }
      NodeFS.fsyncSync(fd);
    },
  };
  return { io, faults };
};

describe("failed writes", () => {
  it("a write that fails partway does not swallow the next event", () => {
    const dataDir = tempDir();
    const { io, faults } = faultyIo();
    const ledger = create(dataDir, ticking(T0, 1000), softfacRun, { io });
    ledger.append(step("red"), testCause());

    faults.failWriteAfter = 10;
    const error = catchLedgerError(() => ledger.append(step("green"), testCause()), LedgerIoError);
    expect(error._tag).toBe("LedgerIoError");
    expect(error.path).toBe(runFileFor(dataDir));
    expect(readText(runFileFor(dataDir))).toBe(`${RED}{"ts":"202`);

    // The append first ends the cut-off line with its own write and sync, as a reopen does;
    // the line is then one write and one sync.
    faults.calls.length = 0;
    ledger.append(step("refactor"), testCause());
    expect(faults.calls).toEqual(["write", "sync", "write", "sync"]);
    ledger.append(step("ship"), testCause());
    expect(readText(runFileFor(dataDir))).toBe(`${RED}{"ts":"202\n${REFACTOR}${SHIP}`);

    const record = readSoftfacRun(dataDir);
    expect(record.entries).toEqual([
      at(0, step("red")),
      at(2, step("refactor")),
      at(3, step("ship")),
    ]);
    expect(record.truncated).toBe(false);
    expect(record.skipped).toBe(1);
  });

  it("an Io error's message is the path and the file system's own words, as softfac prints it", () => {
    const dataDir = tempDir();
    const { io, faults } = faultyIo();
    const ledger = create(dataDir, ticking(T0, 1000), softfacRun, { io });
    faults.failSync = true;
    const error = catchLedgerError(() => ledger.append(step("red"), testCause()), LedgerIoError);
    expect(error.message).toBe(`${runFileFor(dataDir)}: injected disk error`);
    expect(error.cause).toEqual(new Error("injected disk error"));
  });

  it("an append whose repair of a cut-off line fails writes nothing, and the next one repairs it", () => {
    const dataDir = tempDir();
    const { io, faults } = faultyIo();
    const ledger = create(dataDir, ticking(T0, 1000), softfacRun, { io });
    ledger.append(step("red"), testCause());
    faults.failWriteAfter = 10;
    expect(catchLedgerError(() => ledger.append(step("green"), testCause()))._tag).toBe(
      "LedgerIoError",
    );

    faults.failWriteAfter = 0;
    const error = catchLedgerError(
      () => ledger.append(step("refactor"), testCause()),
      LedgerIoError,
    );
    expect(error._tag).toBe("LedgerIoError");
    expect(error.path).toBe(runFileFor(dataDir));
    expect(readText(runFileFor(dataDir))).toBe(`${RED}{"ts":"202`);

    faults.failSync = true;
    expect(catchLedgerError(() => ledger.append(step("ship"), testCause()))._tag).toBe(
      "LedgerIoError",
    );
    // The newline went in before its sync failed, and the event was not written.
    expect(readText(runFileFor(dataDir))).toBe(`${RED}{"ts":"202\n`);

    ledger.append(step("ship"), testCause());
    expect(readSoftfacRun(dataDir).entries.map((entry) => entry.data)).toEqual([
      { step: "red" },
      { step: "ship" },
    ]);
  });

  it("an open whose repair of a cut-off line fails is an Io error, and a later open repairs it", () => {
    const dataDir = tempDir();
    writeRun(dataDir, `${RED}${FRAGMENT}`);
    const { io, faults } = faultyIo();
    faults.failWriteAfter = 0;
    const thrown = catchLedgerError(
      () => reopen(dataDir, ticking(T0, 1000), softfacRun, { io }),
      LedgerIoError,
    );
    expect(thrown._tag).toBe("LedgerIoError");
    expect(thrown.path).toBe(runFileFor(dataDir));
    const writesNothing: AppendIo = { writeSync: () => 0, fsyncSync: () => {} };
    const refused = catchLedgerError(() =>
      reopen(dataDir, ticking(T0, 1000), softfacRun, { io: writesNothing }),
    );
    expect(refused._tag).toBe("LedgerIoError");
    expect(readText(runFileFor(dataDir))).toBe(`${RED}${FRAGMENT}`);

    reopen(dataDir);
    expect(readText(runFileFor(dataDir))).toBe(`${RED}${FRAGMENT}\n`);
  });

  it("a write that fails before writing anything still terminates the line next time", () => {
    const dataDir = tempDir();
    const { io, faults } = faultyIo();
    const ledger = create(dataDir, ticking(T0, 1000), softfacRun, { io });
    ledger.append(step("red"), testCause());
    faults.failWriteAfter = 0;
    expect(catchLedgerError(() => ledger.append(step("green"), testCause()))._tag).toBe(
      "LedgerIoError",
    );
    ledger.append(step("refactor"), testCause());
    expect(readText(runFileFor(dataDir))).toBe(`${RED}\n${REFACTOR}`);
  });

  it("a failed sync also gets a line break before the next event", () => {
    const dataDir = tempDir();
    const { io, faults } = faultyIo();
    const ledger = create(dataDir, ticking(T0, 1000), softfacRun, { io });
    faults.failSync = true;
    expect(catchLedgerError(() => ledger.append(step("red"), testCause()))._tag).toBe(
      "LedgerIoError",
    );
    ledger.append(step("green"), testCause());
    expect(readText(runFileFor(dataDir))).toBe(`${RED}\n${GREEN}`);
    // The repair line break is not a damaged line.
    const record = readSoftfacRun(dataDir);
    expect(record.entries).toHaveLength(2);
    expect(record.skipped).toBe(0);
    expect(record.truncated).toBe(false);
  });

  it("the line break is only added once after a failure", () => {
    const dataDir = tempDir();
    const { io, faults } = faultyIo();
    const ledger = create(dataDir, ticking(T0, 1000), softfacRun, { io });
    faults.failWriteAfter = 3;
    expect(catchLedgerError(() => ledger.append(step("red"), testCause()))._tag).toBe(
      "LedgerIoError",
    );
    ledger.append(step("green"), testCause());
    ledger.append(step("refactor"), testCause());
    expect(readText(runFileFor(dataDir))).toBe(`{"t\n${GREEN}${REFACTOR}`);
  });

  it("a finish whose write failed can be retried", () => {
    const dataDir = tempDir();
    const { io, faults } = faultyIo();
    const ledger = create(dataDir, ticking(T0, 1000), softfacRun, { io });
    ledger.append(step("red"), testCause());
    faults.failWriteAfter = 5;
    expect(catchLedgerError(() => ledger.finish("stuck", null, null, testCause()))._tag).toBe(
      "LedgerIoError",
    );
    ledger.finish("stuck", null, null, testCause());

    const record = readSoftfacRun(dataDir);
    expect(record.entries).toHaveLength(2);
    expect(record.entries[1]?.event).toBe("finished");
    expect(record.skipped).toBe(1);
    expect(record.truncated).toBe(false);
  });

  it("a finish whose sync failed still counts as finished", () => {
    const dataDir = tempDir();
    const { io, faults } = faultyIo();
    const ledger = create(dataDir, ticking(T0, 1000), softfacRun, { io });
    faults.failSync = true;
    expect(catchLedgerError(() => ledger.finish("stuck", null, null, testCause()))._tag).toBe(
      "LedgerIoError",
    );
    const afterFailure = NodeFS.readFileSync(runFileFor(dataDir));

    expect(catchLedgerError(() => ledger.finish("stuck", null, null, testCause()))._tag).toBe(
      "LedgerAlreadyFinishedError",
    );
    expect(catchLedgerError(() => ledger.append(step("red"), testCause()))._tag).toBe(
      "LedgerAlreadyFinishedError",
    );
    expect(NodeFS.readFileSync(runFileFor(dataDir))).toEqual(afterFailure);
    expect(readSoftfacRun(dataDir).entries).toHaveLength(1);
  });

  it("a finished line cut off just before its newline still ends the run for live handles", () => {
    const dataDir = tempDir();
    const { io, faults } = faultyIo();
    const ledger = create(dataDir, ticking(T0, 1000), softfacRun, { io });
    const other = reopen(dataDir);
    faults.failWriteAfter = Buffer.byteLength(finishedSample.line) - 1;
    expect(catchLedgerError(() => ledger.finish("pr-open", null, null, testCause()))._tag).toBe(
      "LedgerIoError",
    );
    for (const handle of [ledger, other]) {
      expect(catchLedgerError(() => handle.append(step("green"), testCause()))._tag).toBe(
        "LedgerAlreadyFinishedError",
      );
    }
    // The refusal ended the cut-off line, as a reopen would, so a reader sees the run finished.
    expect(readText(runFileFor(dataDir))).toBe(finishedSample.line);
    expect(readSoftfacRun(dataDir).entries.map((entry) => entry.event)).toEqual(["finished"]);
  });

  it("a gate command whose sync failed still counts toward the summary", () => {
    const dataDir = tempDir();
    const { io, faults } = faultyIo();
    const ledger = create(dataDir, ticking(T0, 1000), softfacRun, { io });
    faults.failSync = true;
    expect(catchLedgerError(() => ledger.append(gate(1, "cargo test"), testCause()))._tag).toBe(
      "LedgerIoError",
    );
    ledger.finish("stuck", null, null, testCause());

    const finished = readSoftfacRun(dataDir).entries.at(-1);
    expect(finished?.event).toBe("finished");
    expect(finished?.data).toEqual({
      outcome: "stuck",
      total_ms: 1000,
      gate_attempts: 1,
      review_cycles: null,
      pr_url: null,
      pr_end: null,
    });
  });

  it("each append writes and syncs once in that order", () => {
    const dataDir = tempDir();
    const { io, faults } = faultyIo();
    const ledger = create(dataDir, ticking(T0, 1000), softfacRun, { io });
    ledger.append(step("red"), testCause());
    ledger.append(step("green"), testCause());
    ledger.finish("stuck", null, null, testCause());
    expect(faults.calls).toEqual(["write", "sync", "write", "sync", "write", "sync"]);
  });

  it("a short write is carried on until the whole line is in the file", () => {
    const dataDir = tempDir();
    const { io, faults } = faultyIo();
    faults.maxPerWrite = 7;
    const ledger = create(dataDir, ticking(T0, 1000), softfacRun, { io });
    ledger.append(step("red"), testCause());
    expect(readText(runFileFor(dataDir))).toBe(RED);
    // Many writes, but one sync for the line.
    expect(faults.calls.filter((call) => call === "sync")).toHaveLength(1);
    expect(faults.calls.filter((call) => call === "write").length).toBeGreaterThan(1);
  });
});
