// @effect-diagnostics nodeBuiltinImport:off - the tests lay out a data dir with real ledger files and read the control files back.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vitest";

import { readAttentionFile } from "./attention.ts";
import { runCli, type CliIo } from "./cli.ts";
import { PAUSE_FILE } from "./claims.ts";
import { makeCause, type RunEvent } from "./ledger/events.ts";
import { Ledger } from "./ledger/ledger.ts";
import type { RunId } from "./ledger/runId.ts";
import { T0, useTempDirs } from "./ledger/testSupport.ts";
import { LOCK_FILE } from "./runnerLock.ts";
import { stopRequestPath } from "./runner/stop.ts";
import { buildStatus } from "./status.ts";

const tempDir = useTempDirs();

const EXAMPLE = NodeFS.readFileSync(
  NodePath.resolve(import.meta.dirname, "../config.example.yml"),
  "utf8",
);
const NOW = T0 + 86_400_000;
const run10: RunId = { repo: "rawphp/softfac", issue: "10", attempt: 1 };
const ID = "rawphp__softfac__10__1";
const moved = (from: string, to: string): RunEvent =>
  ({ event: "state_changed", data: { from, to } }) as RunEvent;
const BUILDING: ReadonlyArray<RunEvent> = [
  { event: "claimed", data: { machine: "mac-mini", github_user: "rawphp" } },
  moved("ready", "triage"),
  moved("triage", "building"),
];

const seed = (dir: string) => {
  let now = T0;
  const ledger = Ledger.create(dir, run10, { clock: () => (now += 1000) });
  try {
    for (const event of BUILDING) ledger.append(event, makeCause("start", "seed"));
  } finally {
    ledger.close();
  }
};

const setup = (options: { isRunner?: (pid: number) => boolean } = {}) => {
  const dataDir = tempDir("cli");
  const packageRoot = tempDir("pkg");
  NodeFS.writeFileSync(NodePath.join(packageRoot, "package.json"), '{"version":"9.9.9"}');
  const outs: Array<string> = [];
  const errs: Array<string> = [];
  const machineConfigPath = NodePath.join(dataDir, "config.yml");
  const io: CliIo = {
    dataDir,
    machineConfigPath,
    packageRoot,
    now: () => NOW,
    out: (line) => outs.push(line),
    err: (line) => errs.push(line),
    ...(options.isRunner === undefined ? {} : { isRunner: options.isRunner }),
    installEnv: () => {
      throw new Error("install is not under test here");
    },
  };
  return { dataDir, packageRoot, machineConfigPath, outs, errs, io };
};

const reportOf = (
  s: ReturnType<typeof setup>,
  status: Parameters<typeof buildStatus>[0]["status"],
) => {
  const { open, dismissed } = readAttentionFile(s.dataDir);
  return buildStatus({
    status,
    version: "9.9.9",
    machine: NodeOS.hostname() || "unknown",
    machineConfigPath: s.machineConfigPath,
    dataDir: s.dataDir,
    nowMs: NOW,
    passRunning: false,
    runningThreads: null,
    attention: open,
    dismissed,
    health: null,
  });
};

describe("status", () => {
  it("prints the report buildStatus gives for the data dir, idle when no runner holds the lock", async () => {
    const s = setup();
    seed(s.dataDir);
    NodeFS.writeFileSync(NodePath.join(s.dataDir, PAUSE_FILE), "2026-10-06T00:00:00.000Z\n");
    expect(await runCli(["status", "--json"], s.io)).toBe(0);
    const expected = reportOf(s, { state: "idle", reason: "the runner is not running" });
    expect(JSON.parse(s.outs.join("\n"))).toEqual(JSON.parse(JSON.stringify(expected)));
    expect(expected.runs.length).toBe(1);
    expect(expected.paused_by_hand).not.toBeNull();

    NodeFS.writeFileSync(s.machineConfigPath, EXAMPLE);
    s.outs.length = 0;
    expect(await runCli(["status", "--json"], s.io)).toBe(0);
    expect(JSON.parse(s.outs.join("\n"))).toMatchObject({
      state: "idle",
      reason: "the runner is not running",
    });
  });

  it("is running with the config's settings when a live runner holds the lock", async () => {
    const s = setup({ isRunner: (pid) => pid === 4242 });
    NodeFS.writeFileSync(s.machineConfigPath, EXAMPLE);
    NodeFS.writeFileSync(NodePath.join(s.dataDir, LOCK_FILE), "4242\n");
    expect(await runCli(["status", "--json"], s.io)).toBe(0);
    const report = JSON.parse(s.outs.join("\n"));
    expect(report).toMatchObject({ state: "running", reason: null });
    expect(report.slots.max).toBe(1);
    expect(report.passes.poll_seconds).toBe(60);
  });

  it("says why when the runner is live but its config does not load, or is missing", async () => {
    const s = setup({ isRunner: () => true });
    NodeFS.writeFileSync(NodePath.join(s.dataDir, LOCK_FILE), "4242\n");
    expect(await runCli(["status", "--json"], s.io)).toBe(0);
    expect(JSON.parse(s.outs.join("\n"))).toMatchObject({
      state: "idle",
      reason: "no factory config",
    });
    NodeFS.writeFileSync(s.machineConfigPath, "not: [valid\n");
    s.outs.length = 0;
    expect(await runCli(["status", "--json"], s.io)).toBe(0);
    expect(JSON.parse(s.outs.join("\n"))).toMatchObject({
      reason: "the machine config does not load",
    });
  });

  it("prints a short summary without --json", async () => {
    const s = setup();
    seed(s.dataDir);
    expect(await runCli(["status"], s.io)).toBe(0);
    const text = s.outs.join("\n");
    expect(text).toContain("idle");
    expect(text).toContain(ID);
  });
});

describe("runs stop", () => {
  it("leaves the stop request for a building run", async () => {
    const s = setup();
    seed(s.dataDir);
    expect(await runCli(["runs", "stop", ID], s.io)).toBe(0);
    expect(NodeFS.existsSync(stopRequestPath(s.dataDir, run10))).toBe(true);
    expect(s.outs.join("\n")).toContain("stop requested");
  });

  it("exits 1 for an unknown run and 2 for a bad id", async () => {
    const s = setup();
    expect(await runCli(["runs", "stop", "rawphp__softfac__99__1"], s.io)).toBe(1);
    expect(s.errs.join("\n")).toContain("no run rawphp__softfac__99__1");
    expect(await runCli(["runs", "stop", "nonsense"], s.io)).toBe(2);
  });
});

describe("claims", () => {
  it("pause writes the pause file and resume removes it", async () => {
    const s = setup();
    const file = NodePath.join(s.dataDir, PAUSE_FILE);
    expect(await runCli(["claims", "pause"], s.io)).toBe(0);
    expect(NodeFS.existsSync(file)).toBe(true);
    expect(await runCli(["claims", "resume"], s.io)).toBe(0);
    expect(NodeFS.existsSync(file)).toBe(false);
  });
});

describe("usage", () => {
  it("exits 2 with the usage for an unknown command", async () => {
    const s = setup();
    expect(await runCli(["frobnicate"], s.io)).toBe(2);
    expect(s.errs.join("\n")).toContain("usage: factory-runner run | install | uninstall");
  });
});
