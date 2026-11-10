// @effect-diagnostics nodeBuiltinImport:off - the tests lay out real run files.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { State } from "../domain/lifecycle.ts";
import { makeCause } from "./events.ts";
import { Ledger } from "./ledger.ts";
import {
  holdsSlot,
  listRuns,
  listUnfinishedRuns,
  readRuns,
  runInfoOf,
  runsByThread,
  type RunReadCache,
} from "./listRuns.ts";
import { lastLineIsFinished } from "./read.ts";
import { RUNS_DIR, runIdFileName, type RunId } from "./runId.ts";
import { T0, ticking, useTempDirs } from "./testSupport.ts";

// Records every full-file read and every chunk read; `node:fs` namespaces are frozen, so the module
// itself is wrapped.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync), readSync: vi.fn(actual.readSync) };
});

const tempDir = useTempDirs();

const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");

const handles: Array<Ledger> = [];
afterEach(() => {
  for (const ledger of handles.splice(0)) ledger.close();
  vi.mocked(NodeFS.readFileSync).mockImplementation(actualFs.readFileSync);
});

const rid = (issue: number, repo = "rawphp/softfac", attempt = 1): RunId => ({
  repo,
  issue: String(issue),
  attempt,
});

const cause = makeCause("start", "claimed");

/** A run started at `startMs` whose last state is `to`, finished when `finish`. */
const runAt = (
  dataDir: string,
  id: RunId,
  startMs: number,
  to: "triage" | "building" | "pr-open" | "needs-info" | null,
  finish = false,
  approved = true,
) => {
  const ledger = Ledger.create(dataDir, id, { clock: ticking(startMs, 1000) });
  handles.push(ledger);
  if (approved) {
    ledger.append(
      { event: "step_changed", data: { step: "approved 2026-10-04T10:00:00Z" } },
      cause,
    );
  }
  ledger.append({ event: "claimed", data: { machine: "m", github_user: "u" } }, cause);
  if (to !== null) ledger.append({ event: "state_changed", data: { from: "ready", to } }, cause);
  if (finish) ledger.finish("stuck", null, null, cause);
};

describe("listUnfinishedRuns", () => {
  it("an empty data dir has no runs", () => {
    expect(listUnfinishedRuns(tempDir())).toEqual([]);
  });

  it("lists the unfinished runs oldest first with their state and without the finished ones", () => {
    const dataDir = tempDir();
    runAt(dataDir, rid(3), T0 + 20_000, "building");
    runAt(dataDir, rid(1), T0, "triage");
    runAt(dataDir, rid(2), T0 + 10_000, "pr-open", true);
    runAt(dataDir, rid(4), T0 + 30_000, null);
    expect(listUnfinishedRuns(dataDir)).toEqual([
      {
        id: rid(1),
        state: "triage",
        unreadable: false,
        confirmed: true,
        session: false,
        prReported: false,
        base: null,
      },
      {
        id: rid(3),
        state: "building",
        unreadable: false,
        confirmed: true,
        session: false,
        prReported: false,
        base: null,
      },
      {
        id: rid(4),
        state: null,
        unreadable: false,
        confirmed: true,
        session: false,
        prReported: false,
        base: null,
      },
    ]);
  });

  it("a run that ended in needs-info is not listed", () => {
    const dataDir = tempDir();
    runAt(dataDir, rid(5), T0, "needs-info", true);
    expect(listUnfinishedRuns(dataDir)).toEqual([]);
  });

  it("a run whose file cannot be read is still listed, flagged unreadable, after the others", () => {
    const dataDir = tempDir();
    runAt(dataDir, rid(7), T0 + 5_000, "building");
    unreadableRun(dataDir, rid(6));
    expect(listUnfinishedRuns(dataDir)).toEqual([
      {
        id: rid(7),
        state: "building",
        unreadable: false,
        confirmed: true,
        session: false,
        prReported: false,
        base: null,
      },
      {
        id: rid(6),
        state: null,
        unreadable: true,
        confirmed: false,
        session: false,
        prReported: false,
        base: null,
      },
    ]);
  });

  it("files that are not named like a run are ignored", () => {
    const dataDir = tempDir();
    NodeFS.mkdirSync(NodePath.join(dataDir, RUNS_DIR), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(dataDir, RUNS_DIR, "notes.txt"), "x");
    NodeFS.writeFileSync(NodePath.join(dataDir, RUNS_DIR, "Rawphp__softfac__1__1.jsonl"), "x");
    expect(listUnfinishedRuns(dataDir)).toEqual([]);
  });

  it("a directory and a symlink named like run files are not runs, so they hold no slot", () => {
    // softfac's `scan_runs` keeps only entries whose file type `is_file` (src/ledger.rs).
    const dataDir = tempDir();
    runAt(dataDir, rid(1), T0, "building");
    notFiles(dataDir, rid(6), rid(7));
    const runs = listUnfinishedRuns(dataDir);
    expect(runs.map((info) => info.id.issue)).toEqual(["1"]);
    expect(listUnfinishedRuns(dataDir, { repo: "rawphp/softfac", issue: 6 })).toEqual([]);
    expect(listUnfinishedRuns(dataDir, { repo: "rawphp/softfac", issue: 7 })).toEqual([]);
    expect(runs.filter(holdsSlot)).toHaveLength(1);
  });

  it("a run with an unknown last state is listed with no state", () => {
    const dataDir = tempDir();
    NodeFS.mkdirSync(NodePath.join(dataDir, RUNS_DIR), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(dataDir, RUNS_DIR, runIdFileName(rid(9))),
      `{"ts":"2026-10-04T10:13:16.123Z","ms":${T0},"event":"state_changed","data":{"from":"ready","to":"later"}}\n`,
    );
    expect(listUnfinishedRuns(dataDir)).toEqual([
      {
        id: rid(9),
        state: null,
        unreadable: false,
        confirmed: false,
        session: false,
        prReported: false,
        base: null,
      },
    ]);
  });

  it("a run with no approval and no session is listed as not confirmed", () => {
    const dataDir = tempDir();
    runAt(dataDir, rid(8), T0, "triage", false, false);
    expect(listUnfinishedRuns(dataDir)).toEqual([
      {
        id: rid(8),
        state: "triage",
        unreadable: false,
        confirmed: false,
        session: false,
        prReported: false,
        base: null,
      },
    ]);
  });

  it("with one issue named, lists only that issue's runs, whatever the repo's case", () => {
    const dataDir = tempDir();
    runAt(dataDir, rid(1), T0, "triage");
    runAt(dataDir, rid(1, "rawphp/softfac", 2), T0 + 1_000, "building");
    runAt(dataDir, rid(2), T0 + 2_000, "triage");
    runAt(dataDir, rid(1, "rawphp/other"), T0 + 3_000, "triage");
    // A file of another issue that cannot be read is not opened, so it is not listed.
    NodeFS.mkdirSync(NodePath.join(dataDir, RUNS_DIR, runIdFileName(rid(3))));
    expect(listUnfinishedRuns(dataDir, { repo: "RawPhp/Softfac", issue: 1 })).toEqual([
      {
        id: rid(1),
        state: "triage",
        unreadable: false,
        confirmed: true,
        session: false,
        prReported: false,
        base: null,
      },
      {
        id: rid(1, "rawphp/softfac", 2),
        state: "building",
        unreadable: false,
        confirmed: true,
        session: false,
        prReported: false,
        base: null,
      },
    ]);
  });
});

describe("listUnfinishedRuns: whether a session may be running", () => {
  it("is set by a launched session or a launch that was sent, and not by the claim alone", () => {
    const dataDir = tempDir();
    runAt(dataDir, rid(1), T0, "triage");
    runAt(dataDir, rid(2), T0 + 10_000, "triage");
    runAt(dataDir, rid(3), T0 + 20_000, "triage");
    const step = (id: RunId, line: Parameters<Ledger["append"]>[0]) => {
      const ledger = Ledger.open(dataDir, id, { clock: ticking(T0 + 30_000, 1000) });
      handles.push(ledger);
      ledger.append(line, cause);
    };
    step(rid(2), { event: "step_changed", data: { step: "launch-sending" } });
    step(rid(3), {
      event: "session_launched",
      data: {
        thread_id: "t-3",
        worktree: "/wt",
        branch: "b",
        model_instance: "m",
        model: "x",
        model_options: null,
        resumed_from: null,
      },
    });
    expect(listUnfinishedRuns(dataDir).map((r) => [r.id.issue, r.session])).toEqual([
      ["1", false],
      ["2", true],
      ["3", true],
    ]);
  });
});

const line = (event: string, data: unknown, ms = T0) =>
  `${JSON.stringify({ ts: "2026-10-04T10:13:16.123Z", ms, event, data })}\n`;
const stateLine = (to: string) => line("state_changed", { from: "ready", to });
const finishedLine = line("finished", { outcome: "stuck" });

const writeRun = (dataDir: string, id: RunId, content: string) => {
  NodeFS.mkdirSync(NodePath.join(dataDir, RUNS_DIR), { recursive: true });
  const path = NodePath.join(dataDir, RUNS_DIR, runIdFileName(id));
  NodeFS.writeFileSync(path, content);
  return path;
};

const fullReads = () => vi.mocked(NodeFS.readFileSync).mock.calls.map(([path]) => String(path));

/** A regular run file whose bytes cannot be read: the read of it fails, whoever runs the test. */
const unreadableRun = (dataDir: string, id: RunId) => {
  const path = writeRun(dataDir, id, "x\n");
  vi.mocked(NodeFS.readFileSync).mockImplementation(((target: never, ...rest: never[]) => {
    if (String(target) === path) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    return (actualFs.readFileSync as (...args: never[]) => unknown)(target, ...rest);
  }) as typeof NodeFS.readFileSync);
  return path;
};

/** A directory and a symlink named like run files, which are not runs. */
const notFiles = (dataDir: string, directory: RunId, link: RunId) => {
  NodeFS.mkdirSync(NodePath.join(dataDir, RUNS_DIR, runIdFileName(directory)), { recursive: true });
  const target = NodePath.join(dataDir, "elsewhere.jsonl");
  NodeFS.writeFileSync(target, stateLine("building"));
  NodeFS.symlinkSync(target, NodePath.join(dataDir, RUNS_DIR, runIdFileName(link)));
};

describe("listUnfinishedRuns: finished runs are skipped by their tail", () => {
  it("never reads a large finished run whole, and still lists an unfinished sibling", () => {
    const dataDir = tempDir();
    const finished = writeRun(
      dataDir,
      rid(1),
      stateLine("triage") +
        line("step_changed", { step: "x".repeat(200) }).repeat(1000) +
        finishedLine,
    );
    expect(NodeFS.statSync(finished).size).toBeGreaterThan(64 * 1024);
    const open = writeRun(dataDir, rid(2), stateLine("building"));
    vi.mocked(NodeFS.readFileSync).mockClear();
    expect(listUnfinishedRuns(dataDir)).toEqual([
      {
        id: rid(2),
        state: "building",
        unreadable: false,
        confirmed: false,
        session: false,
        prReported: false,
        base: null,
      },
    ]);
    expect(fullReads()).toContain(open);
    expect(fullReads()).not.toContain(finished);
  });

  it("skips a small finished run, also after a trailing blank line or CRLF", () => {
    const dataDir = tempDir();
    const small = writeRun(dataDir, rid(1), stateLine("triage") + finishedLine);
    const blank = writeRun(dataDir, rid(2), stateLine("triage") + finishedLine + "\n\n");
    const crlf = writeRun(dataDir, rid(3), stateLine("triage") + finishedLine + "\r\n");
    // The control: an open sibling is read whole, so the reads below are the ones recorded.
    const open = writeRun(dataDir, rid(4), stateLine("building"));
    vi.mocked(NodeFS.readFileSync).mockClear();
    expect(listUnfinishedRuns(dataDir).map((run) => run.id)).toEqual([rid(4)]);
    expect(fullReads()).toContain(open);
    for (const path of [small, blank, crlf]) expect(fullReads()).not.toContain(path);
  });

  it("a run file that vanishes between its listing and its read is no row", () => {
    const dataDir = tempDir();
    const gone = writeRun(dataDir, rid(1), stateLine("building"));
    writeRun(dataDir, rid(2), stateLine("building"));
    // The file is still there for the listing and the lstat; the read finds it gone.
    vi.mocked(NodeFS.readFileSync).mockImplementation(((target: never, ...rest: never[]) => {
      if (String(target) === gone) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return (actualFs.readFileSync as (...args: never[]) => unknown)(target, ...rest);
    }) as typeof NodeFS.readFileSync);
    expect(listUnfinishedRuns(dataDir).map((run) => run.id)).toEqual([rid(2)]);
    expect(readRuns(dataDir).map((read) => read.summary.id)).toEqual([rid(2)]);
  });

  it("reads a file whose last line is cut off in full and lists it as unfinished", () => {
    const dataDir = tempDir();
    writeRun(dataDir, rid(1), stateLine("building") + finishedLine.slice(0, 40));
    expect(listUnfinishedRuns(dataDir)).toEqual([
      {
        id: rid(1),
        state: "building",
        unreadable: false,
        confirmed: false,
        session: false,
        prReported: false,
        base: null,
      },
    ]);
  });

  it("reads a file in full when its last line names finished but is not a valid entry", () => {
    const dataDir = tempDir();
    const path = writeRun(
      dataDir,
      rid(1),
      stateLine("building") + '{"event":"finished","data":{}}\n',
    );
    vi.mocked(NodeFS.readFileSync).mockClear();
    expect(listUnfinishedRuns(dataDir)).toEqual([
      {
        id: rid(1),
        state: "building",
        unreadable: false,
        confirmed: false,
        session: false,
        prReported: false,
        base: null,
      },
    ]);
    expect(fullReads()).toContain(path);
  });

  it("reads a file in full when a cut-off fragment follows the finished line", () => {
    const dataDir = tempDir();
    const path = writeRun(
      dataDir,
      rid(1),
      stateLine("triage") + finishedLine + finishedLine.slice(0, 40),
    );
    vi.mocked(NodeFS.readFileSync).mockClear();
    expect(listUnfinishedRuns(dataDir)).toEqual([]);
    expect(fullReads()).toContain(path);
  });

  it("reads a file whose last complete line is not JSON in full and lists it as unfinished", () => {
    const dataDir = tempDir();
    writeRun(dataDir, rid(1), stateLine("building") + "garbage\n");
    expect(listUnfinishedRuns(dataDir)).toEqual([
      {
        id: rid(1),
        state: "building",
        unreadable: false,
        confirmed: false,
        session: false,
        prReported: false,
        base: null,
      },
    ]);
  });

  it("a finished line longer than the tail is still skipped, after a full read", () => {
    const dataDir = tempDir();
    const long = writeRun(
      dataDir,
      rid(1),
      stateLine("triage") + line("finished", { outcome: "stuck", pad: "y".repeat(20_000) }),
    );
    vi.mocked(NodeFS.readFileSync).mockClear();
    expect(listUnfinishedRuns(dataDir)).toEqual([]);
    expect(fullReads()).toContain(long);
  });

  it("lists a run file of only blank lines as unfinished, as readRun reads it", () => {
    const dataDir = tempDir();
    writeRun(dataDir, rid(1), "\n");
    writeRun(dataDir, rid(2), "\n\n");
    writeRun(dataDir, rid(3), "\n\r\n");
    const unfinished = {
      state: null,
      unreadable: false,
      confirmed: false,
      session: false,
      prReported: false,
      base: null,
    };
    expect(listUnfinishedRuns(dataDir)).toEqual([
      { id: rid(1), ...unfinished },
      { id: rid(2), ...unfinished },
      { id: rid(3), ...unfinished },
    ]);
  });

  it("lists a large run file whose whole tail is blank lines, with its state", () => {
    const dataDir = tempDir();
    writeRun(dataDir, rid(1), stateLine("building") + "\n".repeat(9000));
    expect(listUnfinishedRuns(dataDir)).toEqual([
      {
        id: rid(1),
        state: "building",
        unreadable: false,
        confirmed: false,
        session: false,
        prReported: false,
        base: null,
      },
    ]);
  });
});

describe("listUnfinishedRuns: a reported pull request", () => {
  it("is listed from pr_opened until the run is building again", () => {
    const dataDir = tempDir();
    runAt(dataDir, rid(1), T0, "building");
    const opened = handles.at(-1)!;
    opened.append({ event: "pr_opened", data: { pr: 12, url: "https://x/pull/12" } }, cause);
    expect(listUnfinishedRuns(dataDir).map((info) => info.prReported)).toEqual([true]);
    opened.append({ event: "state_changed", data: { from: "building", to: "pr-open" } }, cause);
    opened.append({ event: "state_changed", data: { from: "pr-open", to: "building" } }, cause);
    expect(listUnfinishedRuns(dataDir).map((info) => info.prReported)).toEqual([false]);
  });
});

describe("holdsSlot", () => {
  const run = (state: State | null, confirmed: boolean, unreadable = false) => ({
    id: rid(1),
    state,
    unreadable,
    confirmed,
    session: false,
    prReported: false,
    base: null,
  });

  it("every confirmed unfinished run holds a slot but one waiting in pr-open", () => {
    expect(holdsSlot(run("building", true))).toBe(true);
    expect(holdsSlot(run("triage", true))).toBe(true);
    expect(holdsSlot(run(null, true))).toBe(true);
    expect(holdsSlot(run("pr-open", true))).toBe(false);
  });

  it("a run that is not confirmed holds no slot: it never launches a session", () => {
    expect(holdsSlot(run("triage", false))).toBe(false);
    expect(holdsSlot(run(null, false))).toBe(false);
  });

  it("a building run whose session reported its pull request holds no slot: it waits for the gate", () => {
    expect(holdsSlot({ ...run("building", true), prReported: true })).toBe(false);
  });

  it("a run whose file cannot be read holds a slot", () => {
    expect(holdsSlot(run(null, false, true))).toBe(true);
    expect(holdsSlot(run("pr-open", false, true))).toBe(true);
  });
});

describe("listRuns", () => {
  it("an empty ledger lists no runs", () => {
    expect(listRuns(tempDir())).toEqual([]);
    expect(readRuns(tempDir())).toEqual([]);
  });

  it("lists one summary per run, oldest first, finished runs included", () => {
    const dataDir = tempDir();
    runAt(dataDir, rid(2, "rawphp/other", 1), T0 + 60_000, null);
    runAt(dataDir, rid(8), T0, null, true);
    expect(listRuns(dataDir)).toEqual([
      {
        id: rid(8),
        startedTs: "2026-10-04T10:13:16.123Z",
        lastEvent: "finished",
        title: null,
        reason: null,
        state: null,
        step: null,
        prUrl: null,
        prEnd: null,
        finished: true,
        totalMs: 2000,
        unreadable: false,
      },
      {
        id: rid(2, "rawphp/other", 1),
        startedTs: "2026-10-04T10:14:16.123Z",
        lastEvent: "claimed",
        title: null,
        reason: null,
        state: null,
        step: "approved 2026-10-04T10:00:00Z",
        prUrl: null,
        prEnd: null,
        finished: false,
        totalMs: null,
        unreadable: false,
      },
    ]);
  });

  it("reads the state from the last state change", () => {
    const dataDir = tempDir();
    const ledger = Ledger.create(dataDir, rid(8), { clock: ticking(T0, 1000) });
    handles.push(ledger);
    ledger.append({ event: "state_changed", data: { from: "triage", to: "building" } }, cause);
    ledger.append({ event: "state_changed", data: { from: "building", to: "pr-open" } }, cause);
    expect(listRuns(dataDir).map((run) => [run.state, run.lastEvent])).toEqual([
      ["pr-open", "state_changed"],
    ]);
  });

  it("reads the step from the last step_changed of a run read whole, null before any", () => {
    const dataDir = tempDir();
    const ledger = Ledger.create(dataDir, rid(8), { clock: ticking(T0, 1000) });
    handles.push(ledger);
    ledger.append({ event: "claimed", data: { machine: "m", github_user: "u" } }, cause);
    expect(listRuns(dataDir)[0]?.step).toBeNull();
    ledger.append({ event: "step_changed", data: { step: "launch-sending" } }, cause);
    ledger.append({ event: "step_changed", data: { step: "gate-passed" } }, cause);
    ledger.append({ event: "claimed", data: { machine: "m", github_user: "u" } }, cause);
    expect(listRuns(dataDir)[0]?.step).toBe("gate-passed");
  });

  it("a finished run has no step, read whole or from the ends of its file", () => {
    const dataDir = tempDir();
    const ledger = Ledger.create(dataDir, rid(8), { clock: ticking(T0, 1000) });
    handles.push(ledger);
    ledger.append({ event: "step_changed", data: { step: "gate-passed" } }, cause);
    ledger.finish("stuck", null, null, cause);
    expect(readRuns(dataDir)[0]?.summary).toMatchObject({ finished: true, step: null });
    expect(listRuns(dataDir)[0]).toMatchObject({ finished: true, step: null });
  });

  it("reads the pull request url from the last pr_opened, and from the finished line over it", () => {
    const dataDir = tempDir();
    const ledger = Ledger.create(dataDir, rid(8), { clock: ticking(T0, 1000) });
    handles.push(ledger);
    ledger.append(
      { event: "pr_opened", data: { pr: 1, url: "https://example.test/pull/1" } },
      cause,
    );
    ledger.append(
      { event: "pr_opened", data: { pr: 2, url: "https://example.test/pull/2" } },
      cause,
    );
    expect(listRuns(dataDir)[0]?.prUrl).toBe("https://example.test/pull/2");
    ledger.finish("pr-open", null, "https://example.test/pull/3", cause, "merged");
    expect(listRuns(dataDir)[0]?.prUrl).toBe("https://example.test/pull/3");
  });

  it("a pr-open run reads finished once its pull request ended, and how it ended", () => {
    const dataDir = tempDir();
    const ledger = Ledger.create(dataDir, rid(8), { clock: ticking(T0, 1000) });
    handles.push(ledger);
    ledger.append({ event: "state_changed", data: { from: "building", to: "pr-open" } }, cause);
    expect(listRuns(dataDir)[0]?.finished).toBe(false);
    ledger.finish("pr-open", null, "https://github.com/rawphp/softfac/pull/12", cause, "closed");
    expect(listRuns(dataDir)).toEqual([
      expect.objectContaining({
        state: "pr-open",
        finished: true,
        prUrl: "https://github.com/rawphp/softfac/pull/12",
        prEnd: "closed",
      }),
    ]);
  });

  it("an unreadable run file is listed with no record, and the others still are", () => {
    const dataDir = tempDir();
    runAt(dataDir, rid(8), T0, "building");
    unreadableRun(dataDir, rid(2, "rawphp/broken"));
    const reads = readRuns(dataDir);
    expect(reads.map((read) => [read.summary.id.repo, read.summary.unreadable])).toEqual([
      ["rawphp/softfac", false],
      ["rawphp/broken", true],
    ]);
    expect(reads[0]?.record?.entries.length).toBeGreaterThan(0);
    expect(reads[1]?.record).toBeNull();
    expect(listRuns(dataDir)[1]).toEqual({
      id: rid(2, "rawphp/broken"),
      startedTs: null,
      lastEvent: null,
      title: null,
      reason: null,
      state: null,
      step: null,
      prUrl: null,
      prEnd: null,
      finished: false,
      totalMs: null,
      unreadable: true,
    });
  });

  it("a run with no readable line sorts after the started ones", () => {
    const dataDir = tempDir();
    writeRun(dataDir, rid(1), "not json\n");
    runAt(dataDir, rid(2), T0, "building");
    expect(listRuns(dataDir).map((run) => run.id.issue)).toEqual(["2", "1"]);
  });
});

describe("listRuns: a finished run is summarised from the ends of its file", () => {
  const PR_URL = "https://example.test/pull/4";
  /** A run with `events` after the claim, finished as `outcome` with the finished line's `prUrl`. */
  const finishedRun = (
    dataDir: string,
    id: RunId,
    events: ReadonlyArray<{ readonly event: string; readonly data: unknown }>,
    outcome: "pr-open" | "stuck" | "needs-info",
    prUrl: string | null,
  ) => {
    const ledger = Ledger.create(dataDir, id, {
      clock: ticking(T0 + Number(id.issue) * 60_000, 1000),
    });
    try {
      ledger.append({ event: "claimed", data: { machine: "m", github_user: "u" } }, cause);
      for (const event of events) ledger.append(event as never, cause);
      ledger.finish(outcome, null, prUrl, cause, prUrl === null ? null : "merged");
    } finally {
      ledger.close();
    }
    return NodePath.join(dataDir, RUNS_DIR, runIdFileName(id));
  };
  const moved = (from: string, to: string) => ({ event: "state_changed", data: { from, to } });
  const stepped = (step: string) => ({ event: "step_changed", data: { step } });
  const opened = (pr: number) => ({
    event: "pr_opened",
    data: { pr, url: `https://example.test/pull/${pr}` },
  });
  const padding = (n: number) =>
    Array.from({ length: n }, () => ({ event: "step_changed", data: { step: "x".repeat(1000) } }));

  it("equals the summary of the whole read, and no finished file is read whole", () => {
    const dataDir = tempDir();
    const files = [
      // No pull request at all: the scan reads back to the start.
      finishedRun(
        dataDir,
        rid(1),
        [stepped("launch-sending"), moved("ready", "triage"), moved("triage", "building")],
        "stuck",
        null,
      ),
      // The finished line carries the pull request; a step after the last state change.
      finishedRun(
        dataDir,
        rid(2),
        [
          moved("triage", "building"),
          opened(3),
          moved("building", "pr-open"),
          stepped("gate-passed"),
        ],
        "pr-open",
        PR_URL,
      ),
      // A stuck run's finished line has none, so the last pr_opened gives it.
      finishedRun(
        dataDir,
        rid(3),
        [opened(5), opened(6), moved("building", "stuck")],
        "stuck",
        null,
      ),
      // A pr_opened after the last state change, and a state this build does not know.
      finishedRun(dataDir, rid(4), [moved("ready", "launching"), opened(7)], "stuck", null),
      // No state change at all.
      finishedRun(dataDir, rid(5), [], "needs-info", null),
      // Stuck, the finished line carrying a pull request, and the stuck line before the state change.
      finishedRun(
        dataDir,
        rid(6),
        [opened(8), stuckLine("gate failed"), moved("building", "stuck")],
        "stuck",
        PR_URL,
      ),
    ];
    const whole = readRuns(dataDir).map((read) => read.summary);
    vi.mocked(NodeFS.readFileSync).mockClear();
    const summaries = listRuns(dataDir);
    expect(summaries).toEqual(whole);
    for (const file of files) expect(fullReads()).not.toContain(file);
    expect(
      summaries.map((run) => [run.state, run.prUrl, run.prEnd, run.finished, run.lastEvent]),
    ).toEqual([
      ["building", null, null, true, "finished"],
      ["pr-open", PR_URL, "merged", true, "finished"],
      ["stuck", "https://example.test/pull/6", null, true, "finished"],
      [null, "https://example.test/pull/7", null, true, "finished"],
      [null, null, null, true, "finished"],
      ["stuck", PR_URL, "merged", true, "finished"],
    ]);
    expect(summaries.map((run) => run.reason)).toEqual([
      null,
      null,
      null,
      null,
      null,
      "gate failed",
    ]);
    expect(summaries.every((run) => run.totalMs !== null && run.startedTs !== null)).toBe(true);
    expect(summaries.every((run) => run.step === null)).toBe(true);
  });

  const sessionLaunched = (title?: string) => ({
    event: "session_launched",
    data: {
      thread_id: "thr_1",
      worktree: null,
      branch: null,
      model_instance: null,
      model: null,
      model_options: null,
      resumed_from: null,
      base: "main",
      ...(title === undefined ? {} : { title }),
    },
  });
  const stuckLine = (reason: string) => ({ event: "stuck", data: { reason } });
  const asked = (questions: string) => ({ event: "questions_posted", data: { questions } });
  const titleAndReason = (dataDir: string) =>
    listRuns(dataDir).map((run) => [run.id.issue, run.title, run.reason]);

  it("reads the title of the first launch, and the reason the last state asks for, as the whole read does", () => {
    const dataDir = tempDir();
    const files = [
      // The first titled launch wins; the stuck line before the state change gives the reason.
      finishedRun(
        dataDir,
        rid(1),
        [
          sessionLaunched("Old title"),
          sessionLaunched("New title"),
          stuckLine("older"),
          stuckLine("gate failed"),
          moved("building", "stuck"),
        ],
        "stuck",
        null,
      ),
      // Needs info: the newest questions, whichever side of the state change they sit on.
      finishedRun(
        dataDir,
        rid(2),
        [asked("first?"), moved("triage", "needs-info"), asked("which db?")],
        "needs-info",
        null,
      ),
      // The first launch has no title, so the run has none, whatever a later launch carries.
      finishedRun(
        dataDir,
        rid(3),
        [
          sessionLaunched(),
          sessionLaunched("Later title"),
          ...padding(80),
          moved("ready", "building"),
        ],
        "pr-open",
        null,
      ),
      // No title anywhere: null. A stuck line that the run has since left says nothing.
      finishedRun(
        dataDir,
        rid(4),
        [sessionLaunched(), stuckLine("old"), moved("stuck", "building")],
        "pr-open",
        null,
      ),
      // Stuck with no stuck line: no reason, and the scan reaches the start.
      finishedRun(dataDir, rid(5), [...padding(80), moved("building", "stuck")], "stuck", null),
    ];
    const whole = readRuns(dataDir).map((read) => read.summary);
    vi.mocked(NodeFS.readFileSync).mockClear();
    expect(listRuns(dataDir)).toEqual(whole);
    for (const file of files) expect(fullReads()).not.toContain(file);
    expect(titleAndReason(dataDir)).toEqual([
      ["1", "Old title", "gate failed"],
      ["2", null, "which db?"],
      ["3", null, null],
      ["4", null, null],
      ["5", null, null],
    ]);
  });

  it("finds the first launch past the first read of the file, as the whole read does", () => {
    const dataDir = tempDir();
    const files = [
      // 20 KB before the launch: the forward read takes three chunks to reach it.
      finishedRun(
        dataDir,
        rid(1),
        [...padding(20), sessionLaunched("Deep title"), moved("building", "pr-open")],
        "pr-open",
        null,
      ),
      // The first launch, deep in the file, has no title: a later titled one gives none.
      finishedRun(
        dataDir,
        rid(2),
        [
          ...padding(20),
          sessionLaunched(),
          ...padding(10),
          sessionLaunched("Later title"),
          moved("building", "pr-open"),
        ],
        "pr-open",
        null,
      ),
    ];
    const whole = readRuns(dataDir).map((read) => read.summary);
    vi.mocked(NodeFS.readFileSync).mockClear();
    expect(listRuns(dataDir)).toEqual(whole);
    for (const file of files) expect(fullReads()).not.toContain(file);
    expect(titleAndReason(dataDir)).toEqual([
      ["1", "Deep title", null],
      ["2", null, null],
    ]);
  });

  it("reads the title and reason of a run that is not finished", () => {
    const dataDir = tempDir();
    const ledger = Ledger.create(dataDir, rid(1), { clock: ticking(T0, 1000) });
    handles.push(ledger);
    ledger.append({ event: "claimed", data: { machine: "m", github_user: "u" } }, cause);
    ledger.append(sessionLaunched("Open run") as never, cause);
    ledger.append(stuckLine("gate failed") as never, cause);
    ledger.append(moved("building", "stuck") as never, cause);
    expect(titleAndReason(dataDir)).toEqual([["1", "Open run", "gate failed"]]);
    expect(readRuns(dataDir)[0]?.summary).toEqual(listRuns(dataDir)[0]);
  });

  it("caps a long reason at 300 characters on a character boundary, in both reads", () => {
    const dataDir = tempDir();
    // Astral characters are two code units each, so a cut by code unit could split one.
    const long = "\u{1F600}".repeat(400);
    finishedRun(dataDir, rid(1), [stuckLine(long), moved("building", "stuck")], "stuck", null);
    finishedRun(
      dataDir,
      rid(2),
      [asked("short?"), moved("triage", "needs-info")],
      "needs-info",
      null,
    );
    const ledger = Ledger.create(dataDir, rid(3), { clock: ticking(T0, 1000) });
    handles.push(ledger);
    ledger.append({ event: "claimed", data: { machine: "m", github_user: "u" } }, cause);
    ledger.append(stuckLine(long) as never, cause);
    ledger.append(moved("building", "stuck") as never, cause);
    const listed = listRuns(dataDir);
    expect(listed).toEqual(readRuns(dataDir).map((read) => read.summary));
    const reasonOf = (issue: number) =>
      listed.find((run) => run.id.issue === String(issue))?.reason ?? "";
    const [capped, short, open] = [reasonOf(1), reasonOf(2), reasonOf(3)];
    for (const reason of [capped, open]) {
      expect(reason.isWellFormed()).toBe(true);
      expect([...reason]).toHaveLength(300);
      expect(reason.endsWith("\u2026")).toBe(true);
      expect(reason).toBe(`${"\u{1F600}".repeat(299)}\u2026`);
    }
    expect(short).toBe("short?");
  });

  it("leaves a reason of exactly 300 characters whole, and cuts one of 301 to 299 and an ellipsis", () => {
    const dataDir = tempDir();
    // 300 astral characters are 600 code units, so only a count by character keeps them whole.
    const exact = "\u{1F600}".repeat(300);
    finishedRun(dataDir, rid(1), [stuckLine(exact), moved("building", "stuck")], "stuck", null);
    finishedRun(
      dataDir,
      rid(2),
      [stuckLine(`${exact}\u{1F600}`), moved("building", "stuck")],
      "stuck",
      null,
    );
    const listed = listRuns(dataDir);
    expect(listed).toEqual(readRuns(dataDir).map((read) => read.summary));
    const reasonOf = (issue: number) =>
      listed.find((run) => run.id.issue === String(issue))?.reason ?? "";
    expect(reasonOf(1)).toBe(exact);
    expect(reasonOf(2)).toBe(`${"\u{1F600}".repeat(299)}\u2026`);
  });

  it("stops the title read at the first launch when it has no title, so a large untitled run is read from its ends", () => {
    const dataDir = tempDir();
    const path = finishedRun(
      dataDir,
      rid(1),
      [sessionLaunched(), ...padding(2000), opened(2), moved("building", "pr-open")],
      "pr-open",
      PR_URL,
    );
    // A run that never launched has no launch to stop at; it is small.
    finishedRun(dataDir, rid(2), [moved("triage", "needs-info")], "needs-info", null);
    const size = NodeFS.statSync(path).size;
    vi.mocked(NodeFS.readSync).mockClear();
    const listed = listRuns(dataDir);
    const chunked = vi
      .mocked(NodeFS.readSync)
      .mock.results.reduce((sum, result) => sum + (result.value as number), 0);
    expect(size).toBeGreaterThan(1_000_000);
    expect(chunked).toBeLessThan(100_000);
    expect(listed.map((run) => run.title)).toEqual([null, null]);
    expect(listed).toEqual(readRuns(dataDir).map((read) => read.summary));
  });

  it("skips damaged lines at both ends as the whole read does", () => {
    const dataDir = tempDir();
    const path = finishedRun(
      dataDir,
      rid(1),
      [opened(2), moved("triage", "building")],
      "stuck",
      null,
    );
    const bytes = NodeFS.readFileSync(path, "utf8");
    const finishedAt = bytes.lastIndexOf("\n", bytes.length - 2) + 1;
    NodeFS.writeFileSync(
      path,
      `not json\n\n${bytes.slice(0, finishedAt)}{"cut":\n\r\n${bytes.slice(finishedAt)}`,
    );
    expect(lastLineIsFinished(path)).toBe(true);
    const whole = readRuns(dataDir).map((read) => read.summary);
    vi.mocked(NodeFS.readFileSync).mockClear();
    expect(listRuns(dataDir)).toEqual(whole);
    expect(fullReads()).not.toContain(path);
    expect(whole[0]).toMatchObject({ state: "building", prUrl: "https://example.test/pull/2" });
  });

  it("reads only the ends of a large finished run whose pull request is near its end", () => {
    const dataDir = tempDir();
    const path = finishedRun(
      dataDir,
      rid(1),
      // The title sits near the start, as a launch writes it, before the bulk of the run.
      [sessionLaunched("Early title"), ...padding(2000), opened(2), moved("building", "pr-open")],
      "pr-open",
      PR_URL,
    );
    const size = NodeFS.statSync(path).size;
    vi.mocked(NodeFS.readSync).mockClear();
    const listed = listRuns(dataDir)[0];
    expect(listed).toMatchObject({
      state: "pr-open",
      prUrl: PR_URL,
      finished: true,
      title: "Early title",
    });
    const chunked = vi
      .mocked(NodeFS.readSync)
      .mock.results.reduce((sum, result) => sum + (result.value as number), 0);
    expect(size).toBeGreaterThan(1_000_000);
    expect(chunked).toBeLessThan(100_000);
    expect(listed).toEqual(readRuns(dataDir)[0]?.summary);
  });

  it("still reads an unfinished run whole", () => {
    const dataDir = tempDir();
    runAt(dataDir, rid(1), T0, "building");
    vi.mocked(NodeFS.readFileSync).mockClear();
    expect(listRuns(dataDir)[0]).toMatchObject({ state: "building", finished: false });
    expect(fullReads()).toContain(NodePath.join(dataDir, RUNS_DIR, runIdFileName(rid(1))));
  });
});

describe("readRuns with a cache", () => {
  it("reads a file again only once it changes, and forgets the files it no longer reads", () => {
    const dataDir = tempDir();
    const first = writeRun(dataDir, rid(1), stateLine("triage"));
    const second = writeRun(dataDir, rid(2), stateLine("building"));
    const cache: RunReadCache = new Map();
    const states = () => readRuns(dataDir, { cache }).map((read) => read.summary.state);
    expect(states()).toEqual(["triage", "building"]);

    vi.mocked(NodeFS.readFileSync).mockClear();
    expect(states()).toEqual(["triage", "building"]);
    expect(fullReads()).toEqual([]);

    NodeFS.appendFileSync(first, stateLine("pr-open"));
    vi.mocked(NodeFS.readFileSync).mockClear();
    expect(states()).toEqual(["pr-open", "building"]);
    expect(fullReads()).toEqual([first]);

    NodeFS.rmSync(second);
    expect(states()).toEqual(["pr-open"]);
    expect([...cache.keys()]).toEqual([first]);
  });

  it("reads a file again when it is rewritten to the same size", () => {
    const dataDir = tempDir();
    const path = writeRun(dataDir, rid(1), stateLine("stuck"));
    const cache: RunReadCache = new Map();
    expect(readRuns(dataDir, { cache })[0]?.summary.state).toBe("stuck");
    NodeFS.writeFileSync(path, stateLine("ready"));
    expect(readRuns(dataDir, { cache })[0]?.summary.state).toBe("ready");
  });

  it("drops a finished file once it falls before the cutoff", () => {
    const dataDir = tempDir();
    const path = writeRun(dataDir, rid(1), stateLine("building") + finishedLine);
    const cache: RunReadCache = new Map();
    readRuns(dataDir, { cache, skipFinishedBefore: 0 });
    expect([...cache.keys()]).toEqual([path]);
    NodeFS.utimesSync(path, 1, 1);
    expect(readRuns(dataDir, { cache, skipFinishedBefore: 2000 })).toEqual([]);
    expect(cache.size).toBe(0);
  });
});

describe("the run scanner", () => {
  it("skips a directory and a symlink named like a run, in both listings", () => {
    const dataDir = tempDir();
    runAt(dataDir, rid(1), T0, "building");
    notFiles(dataDir, rid(2), rid(3));
    expect(listUnfinishedRuns(dataDir).map((info) => info.id.issue)).toEqual(["1"]);
    expect(readRuns(dataDir).map((read) => read.summary.id.issue)).toEqual(["1"]);
  });

  it("a regular file that cannot be read stays a row, flagged unreadable", () => {
    const dataDir = tempDir();
    unreadableRun(dataDir, rid(1));
    expect(listRuns(dataDir).map((run) => [run.id.issue, run.unreadable])).toEqual([["1", true]]);
    expect(listUnfinishedRuns(dataDir).map((info) => [info.id.issue, info.unreadable])).toEqual([
      ["1", true],
    ]);
  });

  it("orders runs with the same start by repo, then issue and attempt as numbers", () => {
    const dataDir = tempDir();
    const ids = [
      rid(10),
      rid(9),
      rid(10, "rawphp/softfac", 10),
      rid(10, "rawphp/softfac", 2),
      rid(1, "a_b/x"),
      rid(1, "a-b/x"),
    ];
    // Runs with no readable line all sort on the tie-break alone.
    for (const id of ids) writeRun(dataDir, id, "not json\n");
    const expected = [
      "a-b/x#1#1",
      "a_b/x#1#1",
      "rawphp/softfac#9#1",
      "rawphp/softfac#10#1",
      "rawphp/softfac#10#2",
      "rawphp/softfac#10#10",
    ];
    const key = (id: RunId) => `${id.repo}#${id.issue}#${id.attempt}`;
    expect(readRuns(dataDir).map((read) => key(read.summary.id))).toEqual(expected);
    expect(listUnfinishedRuns(dataDir).map((info) => key(info.id))).toEqual(expected);
  });

  it("gives each read the progress it was summarised from", () => {
    const dataDir = tempDir();
    runAt(dataDir, rid(1), T0, "building");
    unreadableRun(dataDir, rid(2, "rawphp/other"));
    const reads = readRuns(dataDir);
    expect(reads[0]?.seen?.state).toBe("building");
    expect(reads[1]?.seen).toBeNull();
  });

  it("runInfoOf reads the slot facts from progress, and no progress is an unreadable run", () => {
    const dataDir = tempDir();
    runAt(dataDir, rid(1), T0, "pr-open");
    const seen = readRuns(dataDir)[0]?.seen ?? null;
    expect(runInfoOf(rid(1), seen)).toEqual({
      id: rid(1),
      state: "pr-open",
      unreadable: false,
      confirmed: true,
      session: false,
      prReported: false,
      base: null,
    });
    expect(runInfoOf(rid(1), null)).toEqual({
      id: rid(1),
      state: null,
      unreadable: true,
      confirmed: false,
      session: false,
      prReported: false,
      base: null,
    });
  });
});

describe("readRuns: skipFinishedBefore", () => {
  const DAY = 86_400_000;
  /** Sets the file's mtime to `ageMs` before `nowMs`. */
  const age = (path: string, nowMs: number, ageMs: number) => {
    const seconds = (nowMs - ageMs) / 1000;
    NodeFS.utimesSync(path, seconds, seconds);
  };

  it("neither reads nor returns a finished file older than the cutoff", () => {
    const dataDir = tempDir();
    const nowMs = Date.parse("2026-10-17T00:00:00Z");
    const oldFinished = writeRun(dataDir, rid(1), stateLine("building") + finishedLine);
    const newFinished = writeRun(dataDir, rid(2), stateLine("building") + finishedLine);
    age(oldFinished, nowMs, 3 * DAY);
    age(newFinished, nowMs, DAY / 2);
    vi.mocked(NodeFS.readFileSync).mockClear();
    const reads = readRuns(dataDir, { skipFinishedBefore: nowMs - DAY });
    expect(reads.map((read) => read.summary.id.issue)).toEqual(["2"]);
    expect(fullReads()).not.toContain(oldFinished);
    expect(fullReads()).toContain(newFinished);
  });

  it("reads an old file that is not finished, however old, and a cut-off finished line in full", () => {
    const dataDir = tempDir();
    const nowMs = Date.parse("2026-10-17T00:00:00Z");
    const open = writeRun(dataDir, rid(1), stateLine("building"));
    const cut = writeRun(dataDir, rid(2), stateLine("building") + finishedLine.slice(0, 30));
    age(open, nowMs, 30 * DAY);
    age(cut, nowMs, 30 * DAY);
    const reads = readRuns(dataDir, { skipFinishedBefore: nowMs - DAY });
    expect(reads.map((read) => [read.summary.id.issue, read.summary.finished])).toEqual([
      ["1", false],
      ["2", false],
    ]);
  });

  it("without the option every file is read, finished and old ones included", () => {
    const dataDir = tempDir();
    const old = writeRun(dataDir, rid(1), stateLine("building") + finishedLine);
    age(old, Date.parse("2026-10-17T00:00:00Z"), 30 * DAY);
    expect(readRuns(dataDir).map((read) => read.summary.finished)).toEqual([true]);
  });

  it("listRuns leaves out the same files, and reads an old unfinished one as ever", () => {
    const dataDir = tempDir();
    const nowMs = Date.parse("2026-10-17T00:00:00Z");
    const oldFinished = writeRun(dataDir, rid(1), stateLine("building") + finishedLine);
    const oldOpen = writeRun(dataDir, rid(2), stateLine("building"));
    writeRun(dataDir, rid(3), stateLine("building") + finishedLine);
    age(oldFinished, nowMs, 3 * DAY);
    age(oldOpen, nowMs, 3 * DAY);
    vi.mocked(NodeFS.readFileSync).mockClear();
    const runs = listRuns(dataDir, { skipFinishedBefore: nowMs - DAY });
    expect(runs.map((run) => [run.id.issue, run.finished])).toEqual([
      ["2", false],
      ["3", true],
    ]);
    expect(fullReads()).not.toContain(oldFinished);
    expect(listRuns(dataDir).map((run) => run.id.issue)).toEqual(["1", "2", "3"]);
  });
});

describe("runsByThread", () => {
  const launched = (threadId: string, ms = T0) =>
    line("session_launched", { thread_id: threadId, worktree: null, branch: null }, ms);

  it("maps each session thread to its run and whether that session is stopped", () => {
    const dataDir = tempDir();
    writeRun(dataDir, rid(1), launched("finished", T0) + finishedLine);
    // A relaunch: the earlier session was stopped before the later one started.
    writeRun(dataDir, rid(2), launched("earlier", T0 + 1000) + launched("current", T0 + 2000));
    // A pr-open run whose session was stopped and its worktree removal tried.
    writeRun(
      dataDir,
      rid(3),
      launched("pr-open", T0 + 3000) +
        line("worktree_remove_failed", { path: "/wt/t3-x", error: "not empty" }, T0 + 4000),
    );
    const { runs, complete } = runsByThread(dataDir);
    expect(complete).toBe(true);
    expect(Object.fromEntries(runs)).toEqual({
      finished: { run: rid(1), stopped: true },
      earlier: { run: rid(2), stopped: true },
      current: { run: rid(2), stopped: false },
      "pr-open": { run: rid(3), stopped: true },
    });
  });

  it("is empty and complete without a runs directory", () => {
    const { runs, complete } = runsByThread(tempDir());
    expect(runs.size).toBe(0);
    expect(complete).toBe(true);
  });

  it("is not complete when a run file cannot be read", () => {
    const dataDir = tempDir();
    writeRun(dataDir, rid(1), launched("readable", T0));
    unreadableRun(dataDir, rid(2));
    const { runs, complete } = runsByThread(dataDir);
    expect([...runs.keys()]).toEqual(["readable"]);
    expect(complete).toBe(false);
  });
});
