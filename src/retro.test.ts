// @effect-diagnostics nodeBuiltinImport:off - the tests lay out a data dir with real ledger files.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vitest";

import { runCli, type CliIo, type CommandResult } from "./cli.ts";
import { makeCause, type RunEvent } from "./ledger/events.ts";
import { Ledger } from "./ledger/ledger.ts";
import { parseTs } from "./ledger/time.ts";
import { useTempDirs } from "./ledger/testSupport.ts";

const tempDir = useTempDirs();

const MINUTE = 60_000;
/** The window every test asks for: 2026-10-04, the whole UTC day. */
const SINCE = parseTs("2026-10-04T00:00:00Z")!;
const UNTIL = parseTs("2026-10-05T00:00:00Z")!;
const cause = makeCause("start", "seed");

const moved = (from: string, to: string): RunEvent =>
  ({ event: "state_changed", data: { from, to } }) as RunEvent;
const claimed: RunEvent = { event: "claimed", data: { machine: "m", github_user: "u" } };
const stuck = (reason: string): RunEvent => ({ event: "stuck", data: { reason } });
const approved: RunEvent = { event: "step_changed", data: { step: "approved" } };

type Line = readonly [minutes: number, event: RunEvent];

/**
 * A run of issue `issue` whose lines are written `minutes` after `startMs`; finished with `end`
 * when given.
 */
const seedRun = (
  dataDir: string,
  issue: number,
  startMs: number,
  lines: ReadonlyArray<Line>,
  end?: { readonly prUrl: string; readonly prEnd: "merged" | "closed" | null },
) => {
  let now = startMs;
  const ledger = Ledger.create(
    dataDir,
    { repo: "rawphp/softfac", issue: String(issue), attempt: 1 },
    { clock: () => now },
  );
  try {
    for (const [minutes, event] of lines) {
      now = startMs + minutes * MINUTE;
      ledger.append(event, cause);
    }
    if (end !== undefined) {
      now += MINUTE;
      ledger.finish("pr-open", null, end.prUrl, cause, end.prEnd);
    }
  } finally {
    ledger.close();
  }
};

const PR = (n: number) => `https://github.com/rawphp/softfac/pull/${n}`;

/**
 * One run per rule, and one outside the window:
 * - #1 claimed 5 min in, pr-open 30 min after the claim, merged with an approval: reached without a person.
 * - #2 asked for info before pr-open (90 min after the claim), merged after a change request.
 * - #3 stuck twice; its first stuck line says why. Never reached pr-open.
 * - #4 and #5 stuck once each.
 * - #7 reached pr-open 10 min after the claim, then got stuck: still reached without a person.
 * - #8 started at the window's first instant and is still building.
 * - #6 started at the window's end, so it is not in it; its merged PR has no reviews.
 */
const fixture = (dataDir: string) => {
  const start = SINCE + 10 * 60 * MINUTE;
  seedRun(
    dataDir,
    1,
    start,
    [
      [0, approved],
      [5, claimed],
      [6, moved("ready", "triage")],
      [7, moved("triage", "building")],
      [35, moved("building", "pr-open")],
    ],
    { prUrl: PR(1), prEnd: "merged" },
  );
  seedRun(
    dataDir,
    2,
    start + MINUTE,
    [
      [0, claimed],
      [1, moved("ready", "needs-info")],
      [20, moved("needs-info", "building")],
      [90, moved("building", "pr-open")],
    ],
    { prUrl: PR(2), prEnd: "merged" },
  );
  seedRun(dataDir, 3, start + 2 * MINUTE, [
    [0, claimed],
    [1, moved("ready", "building")],
    [2, stuck("gate red")],
    [3, moved("building", "stuck")],
    [4, moved("stuck", "building")],
    [5, stuck("review cap")],
    [6, moved("building", "stuck")],
  ]);
  seedRun(dataDir, 4, start + 3 * MINUTE, [
    [0, claimed],
    [1, moved("ready", "building")],
    [2, stuck("gate red")],
    [3, moved("building", "stuck")],
  ]);
  seedRun(dataDir, 5, start + 4 * MINUTE, [
    [0, claimed],
    [1, moved("ready", "building")],
    [2, stuck("no PR")],
    [3, moved("building", "stuck")],
  ]);
  seedRun(
    dataDir,
    6,
    UNTIL,
    [
      [0, claimed],
      [1, moved("ready", "building")],
      [2, moved("building", "pr-open")],
    ],
    { prUrl: PR(6), prEnd: "merged" },
  );
  seedRun(dataDir, 7, start + 5 * MINUTE, [
    [0, claimed],
    [1, moved("ready", "building")],
    [10, moved("building", "pr-open")],
    [20, stuck("review cap")],
    [21, moved("pr-open", "stuck")],
  ]);
  seedRun(dataDir, 8, SINCE, [
    [0, claimed],
    [1, moved("ready", "building")],
  ]);
};

const REVIEWS: Record<string, ReadonlyArray<{ state: string }>> = {
  [PR(1)]: [{ state: "COMMENTED" }, { state: "APPROVED" }],
  [PR(2)]: [{ state: "CHANGES_REQUESTED" }, { state: "APPROVED" }],
  [PR(6)]: [],
};

/** `gh` faked by argv: `pr view <url> --json reviews` for the PRs above; anything else fails. */
const fakeGh =
  (calls: Array<ReadonlyArray<string>>) =>
  (args: ReadonlyArray<string>): CommandResult => {
    calls.push(args);
    const [pr, view, url, json, fields, ...rest] = args;
    const reviews = url === undefined ? undefined : REVIEWS[url];
    if (
      pr !== "pr" ||
      view !== "view" ||
      json !== "--json" ||
      fields !== "reviews" ||
      rest.length > 0 ||
      reviews === undefined
    ) {
      return { status: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
    }
    return { status: 0, stdout: JSON.stringify({ reviews }), stderr: "" };
  };

const setup = (gh?: (args: ReadonlyArray<string>) => CommandResult) => {
  const dataDir = tempDir("retro");
  const outs: Array<string> = [];
  const errs: Array<string> = [];
  const calls: Array<ReadonlyArray<string>> = [];
  const io: CliIo = {
    dataDir: tempDir("not-this-one"),
    machineConfigPath: "/nonexistent/config.yml",
    packageRoot: "/nonexistent",
    now: () => UNTIL,
    out: (line) => outs.push(line),
    err: (line) => errs.push(line),
    installEnv: () => {
      throw new Error("install is not under test here");
    },
    gh: gh ?? fakeGh(calls),
  };
  return { dataDir, outs, errs, calls, io };
};

/** Every file under `dir` with its bytes and mtime, to show a command changed nothing. */
const snapshot = (dir: string): Record<string, string> => {
  const files: Record<string, string> = {};
  for (const name of NodeFS.readdirSync(dir, { recursive: true }) as Array<string>) {
    const path = NodePath.join(dir, name);
    const stat = NodeFS.lstatSync(path);
    files[name] = stat.isFile()
      ? `${stat.mtimeMs} ${NodeFS.readFileSync(path, "utf8")}`
      : `${stat.mtimeMs} dir`;
  }
  return files;
};

const window = ["--since", "2026-10-04", "--until", "2026-10-05"];

describe("factory-runner retro", () => {
  it("reports the four numbers for the runs started in the window, as text", async () => {
    const s = setup();
    fixture(s.dataDir);
    const code = await runCli(["retro", "--data-dir", s.dataDir, ...window], s.io);
    expect(s.errs).toEqual([]);
    expect(code).toBe(0);
    expect(s.outs).toEqual([
      "runs: 7 (since 2026-10-04, until 2026-10-05)",
      "reached pr-open without a person: 2/7 (29%)",
      "stuck: 4/7 (57%)",
      "  gate red: 2",
      "  no PR: 1",
      "  review cap: 1",
      "claim to pr-open: median 30 min, p90 90 min (3 runs)",
      "merged without change requests: 1/2 (50%)",
    ]);
    expect(s.calls).toEqual([
      ["pr", "view", PR(1), "--json", "reviews"],
      ["pr", "view", PR(2), "--json", "reviews"],
    ]);
  });

  it("reports the same numbers with --json", async () => {
    const s = setup();
    fixture(s.dataDir);
    const code = await runCli(["retro", "--data-dir", s.dataDir, ...window, "--json"], s.io);
    expect(s.errs).toEqual([]);
    expect(code).toBe(0);
    expect(JSON.parse(s.outs.join("\n"))).toEqual({
      data_dir: s.dataDir,
      since: "2026-10-04",
      until: "2026-10-05",
      runs: 7,
      reached_pr_open_without_person: { runs: 2, share: 2 / 7 },
      stuck: {
        runs: 4,
        share: 4 / 7,
        by_reason: [
          { reason: "gate red", runs: 2 },
          { reason: "no PR", runs: 1 },
          { reason: "review cap", runs: 1 },
        ],
      },
      claim_to_pr_open_minutes: { runs: 3, median: 30, p90: 90 },
      merged_without_change_requests: { merged: 2, runs: 1, share: 0.5 },
    });
  });

  it("with no window counts every run, and --until alone leaves out runs started at or after it", async () => {
    const all = setup();
    fixture(all.dataDir);
    expect(await runCli(["retro", "--data-dir", all.dataDir, "--json"], all.io)).toBe(0);
    const report = JSON.parse(all.outs.join("\n"));
    expect(report).toMatchObject({ since: null, until: null, runs: 8 });
    expect(report.merged_without_change_requests).toEqual({ merged: 3, runs: 2, share: 2 / 3 });

    const until = setup();
    fixture(until.dataDir);
    const code = await runCli(
      ["retro", "--data-dir", until.dataDir, "--until", "2026-10-04T10:01:00Z"],
      until.io,
    );
    expect(code).toBe(0);
    // #8 (at the window's start) and #1 (10:00) started before 10:01; #2 started at 10:01.
    expect(until.outs[0]).toBe("runs: 2 (until 2026-10-04T10:01:00Z)");
  });

  it("an empty window prints n/a and asks gh nothing", async () => {
    const s = setup();
    fixture(s.dataDir);
    const code = await runCli(
      ["retro", "--data-dir", s.dataDir, "--since", "2027-01-01"],
      s.io,
    );
    expect(code).toBe(0);
    expect(s.outs).toEqual([
      "runs: 0 (since 2027-01-01)",
      "reached pr-open without a person: n/a",
      "stuck: n/a",
      "claim to pr-open: n/a",
      "merged without change requests: n/a",
    ]);
    expect(s.calls).toEqual([]);
  });

  it("never writes to the data dir", async () => {
    const s = setup();
    fixture(s.dataDir);
    const before = snapshot(s.dataDir);
    expect(await runCli(["retro", "--data-dir", s.dataDir, ...window], s.io)).toBe(0);
    expect(await runCli(["retro", "--data-dir", s.dataDir, "--json"], s.io)).toBe(0);
    expect(snapshot(s.dataDir)).toEqual(before);
  });

  it("fails, printing no report, when gh cannot read a merged PR's reviews", async () => {
    const s = setup(() => ({ status: 1, stdout: "", stderr: "HTTP 404" }));
    fixture(s.dataDir);
    const code = await runCli(["retro", "--data-dir", s.dataDir, ...window], s.io);
    expect(code).toBe(1);
    expect(s.outs).toEqual([]);
    expect(s.errs.join("\n")).toContain(PR(1));
    expect(s.errs.join("\n")).toContain("HTTP 404");
  });

  it("refuses a missing --data-dir, a bad date and an unknown flag with the usage", async () => {
    for (const argv of [
      ["retro"],
      ["retro", "--data-dir"],
      ["retro", "--data-dir", "/x", "--since", "yesterday"],
      ["retro", "--data-dir", "/x", "--until", "2026-02-30"],
      ["retro", "--data-dir", "/x", "--verbose"],
    ]) {
      const s = setup();
      expect(await runCli(argv, s.io), argv.join(" ")).toBe(2);
      expect(s.errs.join("\n"), argv.join(" ")).toContain("retro --data-dir <dir>");
    }
  });

  it("fails on a data dir that does not exist", async () => {
    const s = setup();
    const missing = NodePath.join(s.dataDir, "nope");
    expect(await runCli(["retro", "--data-dir", missing], s.io)).toBe(1);
    expect(s.errs.join("\n")).toContain(missing);
    expect(NodeFS.existsSync(missing)).toBe(false);
  });
});
