// @effect-diagnostics globalDate:off - one test checks lines are stamped with the wall clock.
// @effect-diagnostics nodeBuiltinImport:off - the tests read and lay out a real machine log.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";

import { LedgerUnknownEventError, LedgerIoError } from "./errors.ts";
import type { AppendIo } from "./appendFile.ts";
import { MACHINE_EVENT_FIELDS, type MachineEvent } from "./events.ts";
import {
  MachineLog,
  scanMachineLog,
  machineLogSince,
  scanMachineLogBack,
  serverStartsSince,
  readServerStopsForStarts,
  serverStopsForStartsSince,
  t3TroubleSince,
  type MachineEntry,
  type MachineLogOptions,
} from "./machineLog.ts";
import { catchLedgerError, scripted, T0, ticking, useTempDirs } from "./testSupport.ts";

const tempDir = useTempDirs();

const logFile = (dataDir: string) => NodePath.join(dataDir, "events.jsonl");
const readText = (path: string) => NodeFS.readFileSync(path, "utf8");

// Open handles are closed after each test: a run of this file would otherwise hold many.
const handles: Array<MachineLog> = [];
afterEach(() => {
  for (const log of handles.splice(0)) log.close();
});

const open = (
  dataDir: string,
  clock: () => number = ticking(T0, 1000),
  options: Omit<MachineLogOptions, "clock"> = {},
) => {
  const log = MachineLog.open(dataDir, { clock, ...options });
  handles.push(log);
  return log;
};

/** A line as written at `T0`. */
const lineAtT0 = (event: string, dataJson: string) =>
  `{"ts":"2026-10-04T10:13:16.123Z","ms":1791108796123,"event":"${event}","data":${dataJson}}\n`;

const passStarted: MachineEvent = { event: "pass_started", data: {} };

/** Every machine event, with the exact line it is written as at `T0`. */
const samples: ReadonlyArray<{ readonly event: MachineEvent; readonly line: string }> = [
  { event: passStarted, line: lineAtT0("pass_started", `{}`) },
  {
    event: { event: "server_started", data: { started_at: 1791108790000 } },
    line: lineAtT0("server_started", `{"started_at":1791108790000}`),
  },
  {
    event: { event: "server_stopping", data: { stopping_at: 1791108796000 } },
    line: lineAtT0("server_stopping", `{"stopping_at":1791108796000}`),
  },
  {
    event: { event: "pass_finished", data: { runs: 3, claimed: 1, errors: 2, attention: 0 } },
    line: lineAtT0("pass_finished", `{"runs":3,"claimed":1,"errors":2,"attention":0}`),
  },
  {
    event: { event: "preflight_failed", data: { check: "t3", why: "T3 Code is not reachable" } },
    line: lineAtT0("preflight_failed", `{"check":"t3","why":"T3 Code is not reachable"}`),
  },
  {
    event: {
      event: "repo_skipped",
      data: {
        repo: "rawphp/softfac",
        reason: "config-not-loaded",
        message: "the project config is invalid",
      },
    },
    line: lineAtT0(
      "repo_skipped",
      `{"repo":"rawphp/softfac","reason":"config-not-loaded","message":"the project config is invalid"}`,
    ),
  },
  {
    event: {
      event: "repo_config_stale",
      data: { repo: "rawphp/softfac", what: "config", message: "TLS handshake timeout" },
    },
    line: lineAtT0(
      "repo_config_stale",
      `{"repo":"rawphp/softfac","what":"config","message":"TLS handshake timeout"}`,
    ),
  },
  {
    event: {
      event: "claim_skipped",
      data: { repo: "rawphp/softfac", issue: "12", reason: "limit" },
    },
    line: lineAtT0("claim_skipped", `{"repo":"rawphp/softfac","issue":12,"reason":"limit"}`),
  },
  {
    event: {
      event: "claim_skipped",
      data: { repo: "acme/widgets", issue: "ENG-42", reason: "blocked" },
    },
    line: lineAtT0("claim_skipped", `{"repo":"acme/widgets","issue":"ENG-42","reason":"blocked"}`),
  },
  {
    event: { event: "claim_skipped", data: { reason: "paused" } },
    line: lineAtT0("claim_skipped", `{"reason":"paused"}`),
  },
  {
    event: { event: "ready_listed", data: { repos: 2 } },
    line: lineAtT0("ready_listed", `{"repos":2}`),
  },
  {
    event: {
      event: "claim_repaired",
      data: { repo: "rawphp/softfac", issue: "12", outcome: "finished" },
    },
    line: lineAtT0("claim_repaired", `{"repo":"rawphp/softfac","issue":12,"outcome":"finished"}`),
  },
  {
    event: { event: "attention", data: { run: "rawphp__softfac__8__1", reason: "abandoned" } },
    line: lineAtT0("attention", `{"run":"rawphp__softfac__8__1","reason":"abandoned"}`),
  },
  {
    event: {
      event: "attention",
      data: { reason: "disk-floor", volume: "/", free_bytes: 5000000000, floor_gb: 10, held: 2 },
    },
    line: lineAtT0(
      "attention",
      `{"reason":"disk-floor","volume":"/","free_bytes":5000000000,"floor_gb":10,"held":2}`,
    ),
  },
  {
    event: {
      event: "attention",
      data: {
        reason: "t3-gh-config-dir",
        url: "http://localhost:3773",
        user: "rawphp",
        gh_config_dir: "/home/me/.config/gh-rawphp",
      },
    },
    line: lineAtT0(
      "attention",
      `{"reason":"t3-gh-config-dir","url":"http://localhost:3773","user":"rawphp","gh_config_dir":"/home/me/.config/gh-rawphp"}`,
    ),
  },
  {
    event: { event: "self_update_started", data: { from: "abc123", to: "def456" } },
    line: lineAtT0("self_update_started", `{"from":"abc123","to":"def456"}`),
  },
  {
    event: {
      event: "self_update_installed",
      data: { from: "abc123", to: "def456", duration_ms: 1200 },
    },
    line: lineAtT0("self_update_installed", `{"from":"abc123","to":"def456","duration_ms":1200}`),
  },
  {
    event: {
      event: "self_update_failed",
      data: { from: "abc123", to: "def456", step: "install", reason: "update-build-failed" },
    },
    line: lineAtT0(
      "self_update_failed",
      `{"from":"abc123","to":"def456","step":"install","reason":"update-build-failed"}`,
    ),
  },
  {
    event: { event: "self_update_rolled_back", data: { from: "def456", to: "abc123" } },
    line: lineAtT0("self_update_rolled_back", `{"from":"def456","to":"abc123"}`),
  },
  {
    event: {
      event: "fleet_failed",
      data: {
        call: "events",
        reason: "fleet-timeout",
        message: "the call took longer than 10 seconds",
      },
    },
    line: lineAtT0(
      "fleet_failed",
      `{"call":"events","reason":"fleet-timeout","message":"the call took longer than 10 seconds"}`,
    ),
  },
  {
    event: {
      event: "fleet_desired",
      data: {
        what: "config",
        asked: "7",
        state: "refused",
        reason: "config-key-not-allowed",
        detail: "poll_seconds",
      },
    },
    line: lineAtT0(
      "fleet_desired",
      `{"what":"config","asked":"7","state":"refused","reason":"config-key-not-allowed","detail":"poll_seconds"}`,
    ),
  },
  {
    event: {
      event: "fleet_desired",
      data: {
        what: "target-commit",
        asked: "abc123",
        state: "applied",
        reason: "target-installed",
      },
    },
    line: lineAtT0(
      "fleet_desired",
      `{"what":"target-commit","asked":"abc123","state":"applied","reason":"target-installed"}`,
    ),
  },
  {
    event: {
      event: "retro_started",
      data: {
        n: 1,
        thread_id: "thr_9",
        runs: 5,
        since_ms: null,
        model_instance: "claudeAgent",
        model: "claude-opus-5-5",
      },
    },
    line: lineAtT0(
      "retro_started",
      `{"n":1,"thread_id":"thr_9","runs":5,"since_ms":null,"model_instance":"claudeAgent","model":"claude-opus-5-5"}`,
    ),
  },
  {
    event: {
      event: "retro_finished",
      data: { n: 1, thread_id: "thr_9", result: "done", duration_ms: 60000 },
    },
    line: lineAtT0(
      "retro_finished",
      `{"n":1,"thread_id":"thr_9","result":"done","duration_ms":60000}`,
    ),
  },
  {
    event: { event: "worktrees_swept", data: { paths: ["/t3/worktrees/a", "/t3/worktrees/b"] } },
    line: lineAtT0("worktrees_swept", `{"paths":["/t3/worktrees/a","/t3/worktrees/b"]}`),
  },
  {
    event: {
      event: "error",
      data: { step: "retro", kind: "t3", message: "the retro thread could not be read" },
    },
    line: lineAtT0(
      "error",
      `{"step":"retro","kind":"t3","message":"the retro thread could not be read"}`,
    ),
  },
  {
    event: {
      event: "error",
      data: {
        run: "rawphp__softfac__8__1",
        step: "pass",
        kind: "ledger",
        message:
          "run rawphp__softfac__8__1: its ledger file cannot be read, so nothing was done for it and it counts as active",
      },
    },
    line: lineAtT0(
      "error",
      `{"run":"rawphp__softfac__8__1","step":"pass","kind":"ledger","message":"run rawphp__softfac__8__1: its ledger file cannot be read, so nothing was done for it and it counts as active"}`,
    ),
  },
];

describe("open", () => {
  it("open makes the data dir and an empty owner-only file, and fsyncs the directories", () => {
    const root = tempDir();
    const dataDir = NodePath.join(root, "fresh", "data");
    const synced: Array<string> = [];
    open(dataDir, ticking(T0, 1), { syncDir: (dir) => void synced.push(dir) });
    expect(NodeFS.readFileSync(logFile(dataDir)).length).toBe(0);
    expect(NodeFS.statSync(logFile(dataDir)).mode & 0o777).toBe(0o600);
    expect(NodeFS.statSync(dataDir).mode & 0o777).toBe(0o700);
    expect(synced).toEqual([dataDir, NodePath.join(root, "fresh")]);
  });

  it("open in an existing data dir leaves its mode alone and still syncs it and its parent", () => {
    const dataDir = tempDir();
    NodeFS.chmodSync(dataDir, 0o755);
    const synced: Array<string> = [];
    open(dataDir, ticking(T0, 1), { syncDir: (dir) => void synced.push(dir) });
    expect(NodeFS.statSync(dataDir).mode & 0o777).toBe(0o755);
    expect(synced).toEqual([dataDir, NodePath.dirname(dataDir)]);
  });

  it("open on an existing log syncs the data dir and its parent and leaves the bytes alone", () => {
    const dataDir = tempDir();
    const content = lineAtT0("pass_started", `{}`);
    NodeFS.writeFileSync(logFile(dataDir), content);
    NodeFS.chmodSync(logFile(dataDir), 0o644);
    const synced: Array<string> = [];
    open(dataDir, ticking(T0, 1), { syncDir: (dir) => void synced.push(dir) });
    expect(synced).toEqual([dataDir, NodePath.dirname(dataDir)]);
    expect(readText(logFile(dataDir))).toBe(content);
    expect(NodeFS.statSync(logFile(dataDir)).mode & 0o777).toBe(0o644);
  });

  it("an open whose directory sync fails is an Io error, and the retry syncs and appends", () => {
    const root = tempDir();
    const dataDir = NodePath.join(root, "data");
    const error = catchLedgerError(
      () =>
        open(dataDir, ticking(T0, 1), {
          syncDir: () => {
            throw new Error("injected disk error");
          },
        }),
      LedgerIoError,
    );
    expect(error._tag).toBe("LedgerIoError");
    expect(error.path).toBe(dataDir);

    const synced: Array<string> = [];
    const log = open(dataDir, ticking(T0, 1), { syncDir: (dir) => void synced.push(dir) });
    expect(synced).toEqual([dataDir, root]);
    log.append(passStarted);
    expect(readText(logFile(dataDir))).toBe(lineAtT0("pass_started", `{}`));
  });

  it("open ends an incomplete last line with a newline and leaves one that ends in a newline alone", () => {
    const whole = lineAtT0("pass_started", `{}`);
    const fragment = `{"ts":"2026-10-04T10:13:17.123Z","ms":17911087`;

    const torn = tempDir();
    NodeFS.writeFileSync(logFile(torn), `${whole}${fragment}`);
    const log = open(torn, ticking(T0 + 9000, 1000));
    expect(readText(logFile(torn))).toBe(`${whole}${fragment}\n`);
    log.append(passStarted);
    expect(readText(logFile(torn))).toBe(
      `${whole}${fragment}\n{"ts":"2026-10-04T10:13:25.123Z","ms":1791108805123,"event":"pass_started","data":{}}\n`,
    );

    const clean = tempDir();
    NodeFS.writeFileSync(logFile(clean), whole);
    open(clean);
    expect(readText(logFile(clean))).toBe(whole);
  });

  it("open refuses a symlink or a directory at events.jsonl", () => {
    const linked = tempDir();
    const target = NodePath.join(linked, "elsewhere.jsonl");
    NodeFS.writeFileSync(target, "");
    NodeFS.symlinkSync(target, logFile(linked));
    const error = catchLedgerError(() => open(linked), LedgerIoError);
    expect(error._tag).toBe("LedgerIoError");
    expect(error.path).toBe(logFile(linked));
    expect(readText(target)).toBe("");

    const dangling = tempDir();
    NodeFS.symlinkSync(NodePath.join(dangling, "missing.jsonl"), logFile(dangling));
    expect(catchLedgerError(() => open(dangling))._tag).toBe("LedgerIoError");
    expect(NodeFS.existsSync(NodePath.join(dangling, "missing.jsonl"))).toBe(false);

    const directory = tempDir();
    NodeFS.mkdirSync(logFile(directory));
    expect(catchLedgerError(() => open(directory))._tag).toBe("LedgerIoError");
  });

  it("open refuses a pipe at events.jsonl without waiting on it", () => {
    const dataDir = tempDir();
    const made = NodeChildProcess.spawnSync("mkfifo", [logFile(dataDir)]);
    expect(made.status).toBe(0);
    expect(catchLedgerError(() => open(dataDir))._tag).toBe("LedgerIoError");
  });
});

describe("append", () => {
  it("append writes a numeric issue key as a JSON number and an identifier as a string", () => {
    const dataDir = tempDir();
    const log = open(dataDir, ticking(T0, 1000));
    log.append({ event: "claim_skipped", data: { repo: "a/b", issue: "8", reason: "limit" } });
    log.append({
      event: "claim_repaired",
      data: { repo: "a/b", issue: "ENG-42", outcome: "released" },
    });
    const lines = readText(logFile(dataDir)).split("\n");
    expect(lines[0]).toContain(`"data":{"repo":"a/b","issue":8,"reason":"limit"}`);
    expect(lines[1]).toContain(`"data":{"repo":"a/b","issue":"ENG-42","outcome":"released"}`);
  });

  it("append writes an issue number above 2^53 digit for digit", () => {
    const dataDir = tempDir();
    const log = open(dataDir, ticking(T0, 1000));
    for (const issue of ["9007199254740993", "18446744073709551615"]) {
      log.append({ event: "claim_skipped", data: { repo: "a/b", issue, reason: "limit" } });
    }
    const lines = readText(logFile(dataDir)).split("\n");
    expect(lines[0]).toContain(`"issue":9007199254740993,`);
    expect(lines[1]).toContain(`"issue":18446744073709551615,`);
  });

  it("append writes the five example lines of the doc as exact bytes, with no cause", () => {
    const dataDir = tempDir();
    const log = open(
      dataDir,
      scripted([1791108796123, 1791108797123, 1791108798123, 1791108799123, 1791108800123]),
    );
    log.append({ event: "pass_started", data: {} });
    log.append({ event: "pass_finished", data: { runs: 3, claimed: 1, errors: 2, attention: 0 } });
    log.append({
      event: "claim_skipped",
      data: { repo: "rawphp/softfac", issue: "12", reason: "limit" },
    });
    log.append({ event: "attention", data: { run: "rawphp__softfac__8__1", reason: "abandoned" } });
    log.append({
      event: "error",
      data: {
        run: "rawphp__softfac__8__1",
        step: "pass",
        kind: "ledger",
        message:
          "run rawphp__softfac__8__1: its ledger file cannot be read, so nothing was done for it and it counts as active",
      },
    });
    expect(readText(logFile(dataDir))).toBe(
      [
        `{"ts":"2026-10-04T10:13:16.123Z","ms":1791108796123,"event":"pass_started","data":{}}`,
        `{"ts":"2026-10-04T10:13:17.123Z","ms":1791108797123,"event":"pass_finished","data":{"runs":3,"claimed":1,"errors":2,"attention":0}}`,
        `{"ts":"2026-10-04T10:13:18.123Z","ms":1791108798123,"event":"claim_skipped","data":{"repo":"rawphp/softfac","issue":12,"reason":"limit"}}`,
        `{"ts":"2026-10-04T10:13:19.123Z","ms":1791108799123,"event":"attention","data":{"run":"rawphp__softfac__8__1","reason":"abandoned"}}`,
        `{"ts":"2026-10-04T10:13:20.123Z","ms":1791108800123,"event":"error","data":{"run":"rawphp__softfac__8__1","step":"pass","kind":"ledger","message":"run rawphp__softfac__8__1: its ledger file cannot be read, so nothing was done for it and it counts as active"}}`,
        "",
      ].join("\n"),
    );
  });

  it("append writes one exact line per machine event and variant", () => {
    const dataDir = tempDir();
    const log = open(dataDir, ticking(T0, 0));
    let expected = "";
    const seen = new Set<string>();
    for (const { event, line } of samples) {
      log.append(event);
      expected += line;
      seen.add(event.event);
      expect(readText(logFile(dataDir)), event.event).toBe(expected);
    }
    // Every one of the 21 event types has at least one exact line.
    expect([...seen].sort()).toEqual(Object.keys(MACHINE_EVENT_FIELDS).sort());
    expect(seen.size).toBe(21);
  });

  it("the claims paused line has a reason and nothing else", () => {
    const dataDir = tempDir();
    open(dataDir, ticking(T0, 0)).append({ event: "claim_skipped", data: { reason: "paused" } });
    const text = readText(logFile(dataDir));
    expect(text).toBe(
      `{"ts":"2026-10-04T10:13:16.123Z","ms":1791108796123,"event":"claim_skipped","data":{"reason":"paused"}}\n`,
    );
    expect(text).toContain(`"event":"claim_skipped","data":{"reason":"paused"}}`);
    expect(Object.keys((JSON.parse(text) as { data: object }).data)).toEqual(["reason"]);
  });

  it("append writes the fields in the doc order whatever order the caller built the object in", () => {
    const dataDir = tempDir();
    open(dataDir, ticking(T0, 0)).append({
      event: "retro_finished",
      data: { duration_ms: 5, result: "stopped", thread_id: "t", n: 2 },
    });
    expect(readText(logFile(dataDir))).toBe(
      lineAtT0("retro_finished", `{"n":2,"thread_id":"t","result":"stopped","duration_ms":5}`),
    );
  });

  it("append refuses an event name the doc does not list and writes nothing", () => {
    const dataDir = tempDir();
    const log = open(dataDir, ticking(T0, 0));
    for (const name of ["merged", "toString", "__proto__", "claimed"]) {
      const error = catchLedgerError(
        () => log.append({ event: name, data: {} } as unknown as MachineEvent),
        LedgerUnknownEventError,
      );
      expect(error._tag).toBe("LedgerUnknownEventError");
      expect(error.event).toBe(name);
    }
    expect(readText(logFile(dataDir))).toBe("");
  });

  it("two handles on one log interleave appends without overwriting", () => {
    const dataDir = tempDir();
    const first = open(dataDir, ticking(T0, 0));
    const second = open(dataDir, ticking(T0, 0));
    first.append({ event: "pass_started", data: {} });
    second.append({
      event: "pass_finished",
      data: { runs: 0, claimed: 0, errors: 0, attention: 0 },
    });
    first.append({ event: "pass_started", data: {} });
    expect(readText(logFile(dataDir)).split("\n")).toHaveLength(4);
  });

  it("a failed write gets a line break before the next event", () => {
    const dataDir = tempDir();
    let failAfter: number | null = null;
    const io: AppendIo = {
      writeSync(fd, buffer) {
        if (failAfter !== null) {
          const keep = failAfter;
          failAfter = null;
          NodeFS.writeSync(fd, buffer.subarray(0, keep));
          throw new Error("injected disk error");
        }
        return NodeFS.writeSync(fd, buffer);
      },
      fsyncSync: (fd) => NodeFS.fsyncSync(fd),
    };
    const log = open(dataDir, ticking(T0, 0), { io });
    log.append(passStarted);
    failAfter = 10;
    const error = catchLedgerError(() => log.append(passStarted), LedgerIoError);
    expect(error._tag).toBe("LedgerIoError");
    expect(error.path).toBe(logFile(dataDir));
    log.append(passStarted);
    log.append(passStarted);
    const line = lineAtT0("pass_started", `{}`);
    expect(readText(logFile(dataDir))).toBe(`${line}{"ts":"202\n${line}${line}`);
    // The reader skips the fragment and gets the three whole lines.
    expect(scanMachineLog(dataDir)).toHaveLength(3);
  });

  it("a line another handle's failed write cut off gets a line break before this handle's event", () => {
    const dataDir = tempDir();
    let failAfter: number | null = null;
    const io: AppendIo = {
      writeSync(fd, buffer) {
        if (failAfter !== null) {
          const keep = failAfter;
          failAfter = null;
          NodeFS.writeSync(fd, buffer.subarray(0, keep));
          throw new Error("injected disk error");
        }
        return NodeFS.writeSync(fd, buffer);
      },
      fsyncSync: (fd) => NodeFS.fsyncSync(fd),
    };
    const first = open(dataDir, ticking(T0, 0), { io });
    const second = open(dataDir, ticking(T0, 0));
    failAfter = 10;
    expect(catchLedgerError(() => first.append(passStarted))._tag).toBe("LedgerIoError");
    second.append(passStarted);
    const line = lineAtT0("pass_started", `{}`);
    expect(readText(logFile(dataDir))).toBe(`{"ts":"202\n${line}`);
    // The first handle still adds its own break after its failure, as softfac does: a blank line.
    first.append(passStarted);
    expect(readText(logFile(dataDir))).toBe(`{"ts":"202\n${line}\n${line}`);
    expect(scanMachineLog(dataDir)).toHaveLength(2);
  });

  it("a failed sync gets a line break before the next event", () => {
    const dataDir = tempDir();
    let failSync = true;
    const io: AppendIo = {
      writeSync: (fd, buffer) => NodeFS.writeSync(fd, buffer),
      fsyncSync(fd) {
        if (failSync) {
          failSync = false;
          throw new Error("injected disk error");
        }
        NodeFS.fsyncSync(fd);
      },
    };
    const log = open(dataDir, ticking(T0, 0), { io });
    expect(catchLedgerError(() => log.append(passStarted))._tag).toBe("LedgerIoError");
    log.append(passStarted);
    const line = lineAtT0("pass_started", `{}`);
    expect(readText(logFile(dataDir))).toBe(`${line}\n${line}`);
  });

  it("open without a clock stamps events with the system clock", () => {
    const dataDir = tempDir();
    // Not T0, so a stamp from any clock but the system's would not match.
    const systemNow = 1_800_000_123_456;
    vi.useFakeTimers({ toFake: ["Date"] });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    vi.setSystemTime(systemNow);
    const log = MachineLog.open(dataDir);
    handles.push(log);
    log.append(passStarted);
    const line = JSON.parse(readText(logFile(dataDir))) as { ms: number };
    expect(line.ms).toBe(systemNow);
  });
});

describe("scan machine log", () => {
  const machineLine = (ms: number, event: string, note: string) =>
    `{"ts":"2026-10-04T10:13:16.123Z","ms":${ms},"event":"${event}","data":{"note":"${note}"}}\n`;

  it("scanMachineLog gives the lines oldest first", () => {
    const dataDir = tempDir();
    const log = open(dataDir, ticking(T0, 1000));
    log.append(passStarted);
    log.append({ event: "pass_finished", data: { runs: 1, claimed: 0, errors: 0, attention: 0 } });
    expect(scanMachineLog(dataDir)).toEqual([
      { ts: "2026-10-04T10:13:16.123Z", ms: T0, event: "pass_started", data: {} },
      {
        ts: "2026-10-04T10:13:17.123Z",
        ms: T0 + 1000,
        event: "pass_finished",
        data: { runs: 1, claimed: 0, errors: 0, attention: 0 },
      },
    ]);
  });

  it("scanMachineLog skips blank and unparsable lines and keeps a last line with no newline that parses", () => {
    const dataDir = tempDir();
    NodeFS.writeFileSync(
      logFile(dataDir),
      [
        "\n\r\n",
        machineLine(10, "pass_started", "a"),
        "this is not json\n",
        `{"ts":"x"}\n`,
        "[]\n",
        `{"ts":"t","ms":"1","event":"e"}\n`,
        "\n",
        machineLine(20, "pass_finished", "b"),
        "\n\n",
        // A line from a newer build with extra keys, and one with no data at all.
        `{"ts":"t","ms":25,"event":"newer","data":{"k":1},"cause":{"step":"pass","reason":"x"},"extra":true}\n`,
        `{"ts":"t","ms":26,"event":"bare"}\n`,
        machineLine(30, "error", "c").trimEnd(),
      ].join(""),
    );
    expect(scanMachineLog(dataDir).map((entry) => [entry.ms, entry.event, entry.data])).toEqual([
      [10, "pass_started", { note: "a" }],
      [20, "pass_finished", { note: "b" }],
      [25, "newer", { k: 1 }],
      [26, "bare", null],
      [30, "error", { note: "c" }],
    ]);
  });

  it("scanMachineLog skips a line cut off by a crash", () => {
    const dataDir = tempDir();
    NodeFS.writeFileSync(
      logFile(dataDir),
      `${machineLine(10, "pass_started", "a")}${machineLine(40, "attention", "d").slice(0, 30)}`,
    );
    expect(scanMachineLog(dataDir).map((entry) => entry.ms)).toEqual([10]);
  });

  it("scanMachineLog skips a line that is not UTF-8", () => {
    const dataDir = tempDir();
    NodeFS.writeFileSync(
      logFile(dataDir),
      Buffer.concat([
        Buffer.from(machineLine(10, "pass_started", "a")),
        Buffer.from([0xff, 0xfe, 0x0a]),
        Buffer.from(machineLine(20, "pass_started", "b")),
      ]),
    );
    expect(scanMachineLog(dataDir).map((entry) => entry.ms)).toEqual([10, 20]);
  });

  it("scanMachineLog returns no lines for a missing or empty log", () => {
    const dataDir = tempDir();
    expect(scanMachineLog(dataDir)).toEqual([]);
    expect(scanMachineLog(NodePath.join(dataDir, "no", "such", "dir"))).toEqual([]);
    NodeFS.writeFileSync(logFile(dataDir), "");
    expect(scanMachineLog(dataDir)).toEqual([]);
  });

  it("scanMachineLog refuses a symlink and a directory", () => {
    const linked = tempDir();
    NodeFS.writeFileSync(NodePath.join(linked, "real"), machineLine(1, "pass_started", "a"));
    NodeFS.symlinkSync(NodePath.join(linked, "real"), logFile(linked));
    const error = catchLedgerError(() => scanMachineLog(linked), LedgerIoError);
    expect(error._tag).toBe("LedgerIoError");
    expect(error.path).toBe(logFile(linked));

    const directory = tempDir();
    NodeFS.mkdirSync(logFile(directory));
    expect(catchLedgerError(() => scanMachineLog(directory))._tag).toBe("LedgerIoError");
  });

  it("scanMachineLog refuses a pipe without waiting on it", () => {
    const dataDir = tempDir();
    expect(NodeChildProcess.spawnSync("mkfifo", [logFile(dataDir)]).status).toBe(0);
    expect(catchLedgerError(() => scanMachineLog(dataDir))._tag).toBe("LedgerIoError");
  });
});

describe("T3 trouble in the machine log", () => {
  // softfac's `tick/tests/interruption.rs` ("what counts as T3 trouble in the machine log").
  const NOW = 1_800_000_000_000;
  const MINUTE = 60_000;

  /** A log with `event` written as if it happened at `ms`. */
  const logWith = (dataDir: string, ...entries: ReadonlyArray<[number, MachineEvent]>) => {
    for (const [ms, event] of entries) {
      const log = MachineLog.open(dataDir, { clock: () => ms });
      try {
        log.append(event);
      } finally {
        log.close();
      }
    }
  };
  const t3Error = (message: string): MachineEvent => ({
    event: "error",
    data: { step: "pass", kind: "t3", message },
  });
  const preflight = (check: string, why: string): MachineEvent => ({
    event: "preflight_failed",
    data: { check, why },
  });

  it("is an error of kind t3 in the last ten minutes", () => {
    const dataDir = tempDir();
    logWith(dataDir, [NOW - 3 * MINUTE, t3Error("sweep: T3 timed out")]);
    expect(t3TroubleSince(dataDir, NOW)).toBe("sweep: T3 timed out");
  });

  it("is not an error of kind t3 older than ten minutes", () => {
    const dataDir = tempDir();
    logWith(dataDir, [NOW - 10 * MINUTE - 1, t3Error("sweep: T3 timed out")]);
    expect(t3TroubleSince(dataDir, NOW)).toBeNull();
  });

  it("is an error exactly ten minutes old", () => {
    const dataDir = tempDir();
    logWith(dataDir, [NOW - 10 * MINUTE, t3Error("edge")]);
    expect(t3TroubleSince(dataDir, NOW)).toBe("edge");
  });

  it("is a failed t3 preflight in the window, and says why", () => {
    const dataDir = tempDir();
    logWith(dataDir, [
      NOW - MINUTE,
      preflight("t3", "T3 Code is not reachable: connection refused"),
    ]);
    expect(t3TroubleSince(dataDir, NOW)).toBe("T3 Code is not reachable: connection refused");
  });

  it("is not another preflight check or another kind of error", () => {
    const dataDir = tempDir();
    logWith(
      dataDir,
      [NOW - MINUTE, preflight("github-login", "not logged in")],
      [
        NOW - MINUTE,
        { event: "error", data: { step: "pass", kind: "github", message: "gh failed" } },
      ],
      [NOW - MINUTE, passStarted],
    );
    expect(t3TroubleSince(dataDir, NOW)).toBeNull();
  });

  it("names the newest trouble in the window", () => {
    const dataDir = tempDir();
    logWith(
      dataDir,
      [NOW - 9 * MINUTE, preflight("t3", "first")],
      [NOW - 5 * MINUTE, t3Error("second")],
      [NOW - 2 * MINUTE, passStarted],
    );
    expect(t3TroubleSince(dataDir, NOW)).toBe("second");
  });

  it("is none for a missing machine log", () => {
    expect(t3TroubleSince(tempDir(), NOW)).toBeNull();
  });

  it("is not a server start: that is read apart, by serverStartsSince", () => {
    const dataDir = tempDir();
    logWith(dataDir, [
      NOW - MINUTE,
      { event: "server_started", data: { started_at: NOW - MINUTE } },
    ]);
    expect(t3TroubleSince(dataDir, NOW)).toBeNull();
  });
  it("stops at the first entry older than the window, so older trouble is not read", () => {
    const dataDir = tempDir();
    const entries: Array<[number, MachineEvent]> = [];
    for (let i = 0; i < 40; i += 1) {
      entries.push([NOW - 60 * MINUTE + i * MINUTE, t3Error(`old ${i} ${"x".repeat(200)}`)]);
    }
    entries.push([NOW - 11 * MINUTE, t3Error("just outside")]);
    entries.push([NOW - 9 * MINUTE, passStarted]);
    entries.push([NOW - MINUTE, passStarted]);
    logWith(dataDir, ...entries);
    expect(t3TroubleSince(dataDir, NOW)).toBeNull();
    // Only the window's entries come back, oldest first, whatever the chunk size.
    const since = NOW - 10 * MINUTE;
    const expected = scanMachineLog(dataDir).filter((entry) => entry.ms >= since);
    expect(expected).toHaveLength(2);
    for (const chunk of [1, 7, 64, 1024, 1 << 16]) {
      expect(machineLogSince(dataDir, since, chunk), `chunk ${chunk}`).toEqual(expected);
    }
  });

  it("reads a line cut by a chunk boundary whole, and the first line of the file", () => {
    const dataDir = tempDir();
    const long = (n: number) => t3Error(`${n} ${"message ".repeat(30)}`);
    logWith(
      dataDir,
      [NOW - 8 * MINUTE, long(1)],
      [NOW - 6 * MINUTE, passStarted],
      [NOW - 4 * MINUTE, long(2)],
      [NOW - 2 * MINUTE, long(3)],
    );
    const all = scanMachineLog(dataDir);
    expect(all).toHaveLength(4);
    // Chunks smaller than a line, equal to one, and odd sizes that land inside and on newlines.
    for (const chunk of [1, 2, 3, 16, 100, 255, 256, 257, 4096]) {
      expect(machineLogSince(dataDir, 0, chunk), `chunk ${chunk}`).toEqual(all);
    }
    expect(t3TroubleSince(dataDir, NOW)).toBe(`3 ${"message ".repeat(30)}`);
  });

  it("is none and reads nothing for a missing log, and is an error for a log that is not a file", () => {
    expect(machineLogSince(tempDir(), 0, 8)).toEqual([]);
    const dataDir = tempDir();
    NodeFS.mkdirSync(NodePath.join(dataDir, "events.jsonl"));
    expect(() => machineLogSince(dataDir, 0)).toThrow(LedgerIoError);
  });
});

describe("serverStartsSince", () => {
  const NOW = 1_800_000_000_000;
  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;
  const started = (at: number): MachineEvent => ({
    event: "server_started",
    data: { started_at: at },
  });
  const stopping = (at: number): MachineEvent => ({
    event: "server_stopping",
    data: { stopping_at: at },
  });
  const logWith = (dataDir: string, ...entries: ReadonlyArray<[number, MachineEvent]>) => {
    for (const [ms, event] of entries) {
      const log = MachineLog.open(dataDir, { clock: () => ms });
      try {
        log.append(event);
      } finally {
        log.close();
      }
    }
  };

  it("is every server start recorded in the window, oldest first, by its own started_at", () => {
    const dataDir = tempDir();
    logWith(
      dataDir,
      [NOW - 30 * HOUR, started(NOW - 30 * HOUR)],
      [NOW - 3 * HOUR + 5_000, started(NOW - 3 * HOUR)],
      [NOW - 2 * MINUTE, { event: "pass_started", data: {} }],
      [NOW - MINUTE + 2_000, started(NOW - MINUTE)],
    );
    expect(serverStartsSince(dataDir, NOW - 24 * HOUR)).toEqual([NOW - 3 * HOUR, NOW - MINUTE]);
  });

  it("serverStopsForStartsSince is the newest stop before each start in the window, whatever its age", () => {
    const dataDir = tempDir();
    logWith(
      dataDir,
      [NOW - 60 * HOUR, stopping(NOW - 60 * HOUR)],
      [NOW - 30 * HOUR, stopping(NOW - 30 * HOUR)],
      // A start whose started_at is not a number is skipped, as serverStartsSince skips it, so it
      // neither ends the scan nor claims the stop.
      [
        NOW - 28 * HOUR,
        { event: "server_started", data: { started_at: "soon" } } as unknown as MachineEvent,
      ],
      [NOW - 2 * HOUR + 5_000, started(NOW - 2 * HOUR)],
    );
    expect(serverStopsForStartsSince(dataDir, NOW - 24 * HOUR)).toEqual([NOW - 30 * HOUR]);
  });

  it("pairs each start of the window with the stop before it, oldest first", () => {
    const dataDir = tempDir();
    logWith(
      dataDir,
      [NOW - 40 * HOUR, stopping(NOW - 40 * HOUR)],
      [NOW - 20 * HOUR, started(NOW - 20 * HOUR)],
      [NOW - 10 * HOUR, stopping(NOW - 11 * HOUR)],
      [NOW - 9 * HOUR, stopping(NOW - 9 * HOUR)],
      [NOW - 8 * HOUR, started(NOW - 8 * HOUR)],
      [NOW - 2 * HOUR, stopping(NOW - 2 * HOUR)],
    );
    // The stop after the newest start belongs to no start in the window; the older start has none.
    expect(serverStopsForStartsSince(dataDir, NOW - 24 * HOUR)).toEqual([
      NOW - 40 * HOUR,
      NOW - 9 * HOUR,
    ]);
  });

  it("does not pair a stop that lies before an older start with a start in the window", () => {
    const dataDir = tempDir();
    logWith(
      dataDir,
      [NOW - 50 * HOUR, stopping(NOW - 50 * HOUR)],
      [NOW - 49 * HOUR, started(NOW - 49 * HOUR)],
      [NOW - 2 * HOUR, started(NOW - 2 * HOUR)],
    );
    expect(serverStopsForStartsSince(dataDir, NOW - 24 * HOUR)).toEqual([]);
  });

  it("skips a stop whose stopping_at is not a number, is empty for a missing log, and ignores a stop after the newest start", () => {
    expect(serverStopsForStartsSince(tempDir(), NOW - HOUR)).toEqual([]);
    const dataDir = tempDir();
    logWith(
      dataDir,
      [NOW - 5 * HOUR, stopping(NOW - 5 * HOUR)],
      [
        NOW - 4 * HOUR,
        { event: "server_stopping", data: { stopping_at: "now" } } as unknown as MachineEvent,
      ],
      [NOW - 3 * HOUR, started(NOW - 3 * HOUR)],
      [NOW - HOUR, stopping(NOW - HOUR)],
    );
    expect(serverStopsForStartsSince(dataDir, NOW - 24 * HOUR)).toEqual([NOW - 5 * HOUR]);
  });

  it("stops reading at the stop the oldest start needs, so a months-old log is not decoded", () => {
    const dataDir = tempDir();
    const line = (ms: number, event: string, data: string) =>
      `{"ts":"2026-10-04T10:13:16.123Z","ms":${ms},"event":"${event}","data":${data}}\n`;
    const lines = Array.from({ length: 2000 }, (_, i) =>
      line(NOW - 90 * 24 * HOUR + i, "pass_started", `{"note":"n${i}"}`),
    );
    lines.push(line(NOW - 30 * HOUR, "server_stopping", `{"stopping_at":${NOW - 30 * HOUR}}`));
    // A line older than the window between the stop and its start does not end the scan early.
    lines.push(line(NOW - 29 * HOUR, "pass_started", `{"note":"late"}`));
    lines.push(line(NOW - 2 * HOUR, "server_started", `{"started_at":${NOW - 2 * HOUR}}`));
    NodeFS.writeFileSync(NodePath.join(dataDir, "events.jsonl"), lines.join(""));
    const read = readServerStopsForStarts(dataDir, NOW - 24 * HOUR);
    expect(read.stops).toEqual([NOW - 30 * HOUR]);
    expect(read.bytes).toBeLessThan(
      NodeFS.statSync(NodePath.join(dataDir, "events.jsonl")).size / 2,
    );
  });

  it("gives up on the stop of a start that followed a crash, so a months-old log is not decoded", () => {
    const dataDir = tempDir();
    const line = (ms: number, event: string, data: string) =>
      `{"ts":"2026-10-04T10:13:16.123Z","ms":${ms},"event":"${event}","data":${data}}\n`;
    const lines = [
      line(NOW - 91 * 24 * HOUR, "server_stopping", `{"stopping_at":${NOW - 91 * 24 * HOUR}}`),
      line(NOW - 90 * 24 * HOUR, "server_started", `{"started_at":${NOW - 90 * 24 * HOUR}}`),
    ];
    // Three months of passes, one a minute, then a power cut: no stop line.
    for (let i = 0; i < 2000; i++) {
      lines.push(line(NOW - 30 * HOUR - (2000 - i) * MINUTE, "pass_started", `{"note":"n${i}"}`));
    }
    lines.push(line(NOW - HOUR, "server_started", `{"started_at":${NOW - HOUR}}`));
    NodeFS.writeFileSync(NodePath.join(dataDir, "events.jsonl"), lines.join(""));
    const read = readServerStopsForStarts(dataDir, NOW - 24 * HOUR);
    expect(read.stops).toEqual([]);
    expect(read.bytes).toBeLessThan(
      NodeFS.statSync(NodePath.join(dataDir, "events.jsonl")).size / 2,
    );
  });

  it("is empty for a missing log, and skips a line whose started_at is not a number", () => {
    expect(serverStartsSince(tempDir(), NOW - HOUR)).toEqual([]);
    const dataDir = tempDir();
    logWith(dataDir, [
      NOW - MINUTE,
      { event: "server_started", data: { started_at: "soon" } } as unknown as MachineEvent,
    ]);
    expect(serverStartsSince(dataDir, NOW - HOUR)).toEqual([]);
  });
});

describe("scan machine log back", () => {
  const machineLine = (ms: number, event: string, note: string) =>
    `{"ts":"2026-10-04T10:13:16.123Z","ms":${ms},"event":"${event}","data":{"note":"${note}"}}\n`;

  /** Every line `scanMachineLogBack` visits, newest first, and the bytes it reports reading. */
  const back = (dataDir: string, firstChunk?: number) => {
    const seen: Array<MachineEntry> = [];
    const bytes = scanMachineLogBack(
      dataDir,
      (entry) => {
        seen.push(entry);
        return "continue";
      },
      firstChunk,
    );
    return { seen, bytes };
  };

  it("gives the lines newest first, the opposite order of scanMachineLog", () => {
    const dataDir = tempDir();
    NodeFS.writeFileSync(
      logFile(dataDir),
      [10, 20, 30].map((ms) => machineLine(ms, "pass_started", `n${ms}`)).join(""),
    );
    const { seen, bytes } = back(dataDir);
    expect(seen).toEqual(scanMachineLog(dataDir).toReversed());
    expect(bytes).toBe(NodeFS.statSync(logFile(dataDir)).size);
  });

  it("completes a line cut at a chunk edge from the next chunk, whatever the first chunk size", () => {
    const dataDir = tempDir();
    const lines = Array.from({ length: 40 }, (_, i) => machineLine(i, "pass_started", `n${i}`));
    NodeFS.writeFileSync(logFile(dataDir), lines.join(""));
    const forward = scanMachineLog(dataDir).toReversed();
    for (const chunk of [1, 7, 64, 101, 5000]) {
      expect(back(dataDir, chunk).seen).toEqual(forward);
    }
  });

  it("stops when the visitor says stop, and reads only the end of the file", () => {
    const dataDir = tempDir();
    const lines = Array.from({ length: 2000 }, (_, i) => machineLine(i, "pass_started", `n${i}`));
    NodeFS.writeFileSync(logFile(dataDir), lines.join(""));
    const seen: Array<number> = [];
    const bytes = scanMachineLogBack(dataDir, (entry) => {
      seen.push(entry.ms);
      return seen.length === 3 ? "stop" : "continue";
    });
    expect(seen).toEqual([1999, 1998, 1997]);
    expect(bytes).toBeLessThan(NodeFS.statSync(logFile(dataDir)).size / 2);
  });

  it("skips blank, unparsable and cut-off lines, and keeps a last line with no newline that parses", () => {
    const dataDir = tempDir();
    NodeFS.writeFileSync(
      logFile(dataDir),
      [
        "\n\r\n",
        machineLine(10, "pass_started", "a"),
        "this is not json\n",
        `{"ts":"x"}\n`,
        machineLine(20, "pass_finished", "b"),
        "\n\n",
        machineLine(30, "error", "c").trimEnd(),
      ].join(""),
    );
    expect(back(dataDir).seen.map((entry) => entry.ms)).toEqual([30, 20, 10]);

    NodeFS.writeFileSync(
      logFile(dataDir),
      `${machineLine(10, "pass_started", "a")}${machineLine(40, "attention", "d").slice(0, 30)}`,
    );
    expect(back(dataDir).seen.map((entry) => entry.ms)).toEqual([10]);
  });

  it("skips a line that is not UTF-8", () => {
    const dataDir = tempDir();
    NodeFS.writeFileSync(
      logFile(dataDir),
      Buffer.concat([
        Buffer.from(machineLine(10, "pass_started", "a")),
        Buffer.from([0xff, 0xfe, 0x0a]),
        Buffer.from(machineLine(20, "pass_started", "b")),
      ]),
    );
    expect(back(dataDir).seen.map((entry) => entry.ms)).toEqual([20, 10]);
  });

  it("visits nothing for a missing or empty log", () => {
    const dataDir = tempDir();
    expect(back(dataDir)).toEqual({ seen: [], bytes: 0 });
    expect(back(NodePath.join(dataDir, "no", "such", "dir"))).toEqual({ seen: [], bytes: 0 });
    NodeFS.writeFileSync(logFile(dataDir), "");
    expect(back(dataDir)).toEqual({ seen: [], bytes: 0 });
  });

  it("refuses a symlink, a directory and a pipe, as scanMachineLog does", () => {
    const linked = tempDir();
    NodeFS.writeFileSync(NodePath.join(linked, "real"), machineLine(1, "pass_started", "a"));
    NodeFS.symlinkSync(NodePath.join(linked, "real"), logFile(linked));
    const error = catchLedgerError(() => back(linked), LedgerIoError);
    expect(error.path).toBe(logFile(linked));

    const directory = tempDir();
    NodeFS.mkdirSync(logFile(directory));
    expect(catchLedgerError(() => back(directory))._tag).toBe("LedgerIoError");

    const piped = tempDir();
    expect(NodeChildProcess.spawnSync("mkfifo", [logFile(piped)]).status).toBe(0);
    expect(catchLedgerError(() => back(piped))._tag).toBe("LedgerIoError");
  });
});
