// @effect-diagnostics nodeBuiltinImport:off - the tests lay out real run files and read the pause file back.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vitest";

import { pauseClaimsNow, resumeClaimsNow, showRun, stopRun } from "./control.ts";
import { makeCause, type RunEvent } from "./ledger/events.ts";
import { Ledger } from "./ledger/ledger.ts";
import { runPath, type RunId } from "./ledger/runId.ts";
import { T0, useTempDirs } from "./ledger/testSupport.ts";
import { formatTs } from "./ledger/time.ts";
import { stopRequestPath } from "./runner/stop.ts";

const tempDir = useTempDirs();

const run10: RunId = { repo: "rawphp/softfac", issue: "10", attempt: 1 };
const ID = "rawphp__softfac__10__1";

const moved = (from: string, to: string): RunEvent =>
  ({ event: "state_changed", data: { from, to } }) as RunEvent;
const CLAIMED: RunEvent = {
  event: "claimed",
  data: { machine: "mac-mini", github_user: "rawphp" },
};
const BUILDING: ReadonlyArray<RunEvent> = [
  CLAIMED,
  moved("ready", "triage"),
  moved("triage", "building"),
];
const FINISHED: RunEvent = {
  event: "finished",
  data: {
    outcome: "pr-open",
    total_ms: 0,
    gate_attempts: 0,
    review_cycles: null,
    pr_url: null,
    pr_end: null,
  },
};

/** Writes the ledger of run 10, one second apart from `T0`. */
const seed = (dir: string, events: ReadonlyArray<RunEvent>) => {
  let now = T0;
  const ledger = Ledger.create(dir, run10, { clock: () => (now += 1000) });
  try {
    for (const event of events) ledger.append(event, makeCause("start", "seed"));
  } finally {
    ledger.close();
  }
};

const bytesOf = (dir: string) => NodeFS.readFileSync(runPath(dir, run10), "utf8");

describe("showRun", () => {
  it("gives each entry with its time, event, data and cause", () => {
    const dir = tempDir();
    seed(dir, BUILDING);
    const shown = showRun(dir, ID);
    expect(shown).toMatchObject({ kind: "ok", id: ID, truncated: false, skipped: 0 });
    if (shown.kind !== "ok") return;
    expect(shown.entries.map((entry) => entry.event)).toEqual([
      "claimed",
      "state_changed",
      "state_changed",
    ]);
    expect(shown.entries[0]).toEqual({
      ts: formatTs(T0 + 1000),
      ms: T0 + 1000,
      event: "claimed",
      data: { machine: "mac-mini", github_user: "rawphp" },
      cause: { step: "start", reason: "seed" },
    });
  });

  it("counts the damaged lines it skips", () => {
    const dir = tempDir();
    seed(dir, BUILDING);
    const path = runPath(dir, run10);
    const lines = NodeFS.readFileSync(path, "utf8").split("\n");
    NodeFS.writeFileSync(path, [lines[0], "not json", lines[1], lines[2], '{"ts":"cut'].join("\n"));
    expect(showRun(dir, ID)).toMatchObject({ kind: "ok", truncated: true, skipped: 1 });
  });

  it("is not-found for a run with no ledger, and for a symlink named like a run", () => {
    const dir = tempDir();
    expect(showRun(dir, ID)).toEqual({ kind: "not-found", id: ID });
    const target = NodePath.join(dir, "secret.txt");
    NodeFS.writeFileSync(target, '{"ts":"x","ms":1,"event":"leaked","data":null}\n');
    NodeFS.mkdirSync(NodePath.join(dir, "runs"));
    NodeFS.symlinkSync(target, runPath(dir, run10));
    expect(showRun(dir, ID)).toEqual({ kind: "not-found", id: ID });
  });

  it.each(["../../etc/passwd", "a/b", "not-a-run", "x__y__1__01", ""])(
    "is invalid for %j, and reads no file",
    (id) => {
      const dir = tempDir();
      expect(showRun(dir, id)).toEqual({ kind: "invalid", message: expect.any(String) });
      expect(NodeFS.existsSync(NodePath.join(dir, "runs"))).toBe(false);
    },
  );
});

describe("stopRun", () => {
  it("leaves a stop request for a building run once, and writes no ledger line", () => {
    const dir = tempDir();
    seed(dir, BUILDING);
    const bytes = bytesOf(dir);
    expect(stopRun(dir, ID)).toEqual({
      kind: "stopped",
      id: ID,
      already: false,
      message: `stop requested: ${ID}; the issue goes to factory:stuck on the next pass`,
    });
    expect(NodeFS.readFileSync(stopRequestPath(dir, run10), "utf8")).toBe("operator\n");
    expect(bytesOf(dir)).toBe(bytes);

    expect(stopRun(dir, ID)).toEqual({
      kind: "stopped",
      id: ID,
      already: true,
      message: `stop already requested: ${ID}; the issue goes to factory:stuck on the next pass`,
    });
    expect(bytesOf(dir)).toBe(bytes);
  });

  it("refuses a run that left building with a stale stop line, instead of answering already", () => {
    const dir = tempDir();
    seed(dir, [
      ...BUILDING,
      { event: "stop_requested", data: { by: "operator" } },
      moved("building", "pr-open"),
    ]);
    expect(stopRun(dir, ID)).toMatchObject({
      kind: "refused",
      message: expect.stringContaining("its state is pr-open"),
    });
  });

  it("refuses a run waiting on its pull request, and says how it ends", () => {
    const dir = tempDir();
    seed(dir, [...BUILDING, moved("building", "pr-open")]);
    const bytes = bytesOf(dir);
    expect(stopRun(dir, ID)).toEqual({
      kind: "refused",
      id: ID,
      message: `run ${ID} is not building: its state is pr-open. Only a building run is stopped this way. It ends when its pull request is merged or closed.`,
    });
    expect(bytesOf(dir)).toBe(bytes);
  });

  it("refuses a finished run, and a run in triage with the way to end it", () => {
    const finished = tempDir();
    seed(finished, [...BUILDING, FINISHED]);
    expect(stopRun(finished, ID)).toEqual({
      kind: "refused",
      id: ID,
      message: `run ${ID} is not building: it is finished. Only a building run is stopped this way.`,
    });
    const triage = tempDir();
    seed(triage, [CLAIMED, moved("ready", "triage")]);
    expect(stopRun(triage, ID)).toMatchObject({
      kind: "refused",
      message: expect.stringContaining("To end it, close its issue."),
    });
  });

  it("is not-found for an unknown run and invalid for a bad id", () => {
    const dir = tempDir();
    expect(stopRun(dir, ID)).toEqual({ kind: "not-found", id: ID });
    expect(stopRun(dir, "../../etc/passwd")).toEqual({
      kind: "invalid",
      message: expect.any(String),
    });
  });
});

describe("pauseClaimsNow and resumeClaimsNow", () => {
  const pauseFile = (dir: string) => NodePath.join(dir, "claims-paused");

  it("pause writes the time privately, and again keeps the first", () => {
    const dir = tempDir();
    const since = formatTs(T0);
    expect(pauseClaimsNow(dir, T0)).toEqual({
      paused: true,
      already: false,
      since,
      message: "claims paused",
    });
    expect(NodeFS.readFileSync(pauseFile(dir), "utf8")).toBe(`${since}\n`);
    expect(NodeFS.statSync(pauseFile(dir)).mode & 0o777).toBe(0o600);
    expect(pauseClaimsNow(dir, T0 + 5000)).toEqual({
      paused: true,
      already: true,
      since,
      message: `claims already paused since ${since}`,
    });
    expect(NodeFS.readFileSync(pauseFile(dir), "utf8")).toBe(`${since}\n`);
  });

  it("resume removes the pause, and says already when there was none", () => {
    const dir = tempDir();
    pauseClaimsNow(dir, T0);
    expect(resumeClaimsNow(dir)).toEqual({
      paused: false,
      already: false,
      message: "claims resumed",
    });
    expect(NodeFS.existsSync(pauseFile(dir))).toBe(false);
    expect(resumeClaimsNow(dir)).toEqual({
      paused: false,
      already: true,
      message: "claims were not paused",
    });
  });
});
