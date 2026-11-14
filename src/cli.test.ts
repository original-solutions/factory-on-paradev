// @effect-diagnostics nodeBuiltinImport:off - the tests lay out a data dir with real ledger files and read the control files back.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vitest";

import { readAttentionFile } from "./attention.ts";
import { runCli, USAGE, type CliIo } from "./cli.ts";
import type { CommandResult } from "./install.ts";
import {
  CLAUDE_VERSION,
  GH_AUTH_STATUS,
  GIT_EMAIL,
  PROXY_ENV_READ,
  remoteUrl,
  trustRead,
  TRUE_COMMAND,
} from "./paradev/ssh.ts";
import { PAUSE_FILE } from "./claims.ts";
import { formatTs } from "./ledger/time.ts";
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

const TRIAGE: ReadonlyArray<RunEvent> = BUILDING.slice(0, 2);

const seed = (dir: string, events: ReadonlyArray<RunEvent> = BUILDING) => {
  let now = T0;
  const ledger = Ledger.create(dir, run10, { clock: () => (now += 1000) });
  try {
    for (const event of events) ledger.append(event, makeCause("start", "seed"));
  } finally {
    ledger.close();
  }
};

const setup = (
  options: {
    isRunner?: (pid: number) => boolean;
    run?: (command: string, args: ReadonlyArray<string>, timeoutMs: number) => CommandResult;
  } = {},
) => {
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
    gh: () => {
      throw new Error("gh is not under test here");
    },
    run:
      options.run ??
      (() => {
        throw new Error("no command is under test here");
      }),
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

  it("lists an open attention item and sets a dismissed one aside", async () => {
    const s = setup();
    const item = (id: string, message: string, dismissed: boolean) => ({
      id,
      kind: "stuck",
      repo: "rawphp/softfac",
      issue: 10,
      run: null,
      message,
      first_seen: "2026-10-06T00:00:00Z",
      ...(dismissed ? { dismissed: true } : {}),
    });
    NodeFS.writeFileSync(
      NodePath.join(s.dataDir, "attention.json"),
      JSON.stringify({
        items: [
          item("a", "rawphp/softfac#10 needs a human", false),
          item("b", "an old thing someone dismissed", true),
        ],
      }),
    );
    expect(await runCli(["status", "--json"], s.io)).toBe(0);
    const report = JSON.parse(s.outs.join("\n"));
    expect(JSON.stringify(report.attention)).toContain("rawphp/softfac#10 needs a human");
    expect(JSON.stringify(report.attention)).not.toContain("an old thing someone dismissed");
    expect(JSON.stringify(report.dismissed)).toContain("an old thing someone dismissed");
    s.outs.length = 0;
    expect(await runCli(["status"], s.io)).toBe(0);
    expect(s.outs.join("\n")).toContain("rawphp/softfac#10 needs a human");
    expect(s.outs.join("\n")).not.toContain("an old thing someone dismissed");
  });

  it("warns on stderr when attention.json cannot be read, so no items is not read as nothing to do", async () => {
    const s = setup();
    const file = NodePath.join(s.dataDir, "attention.json");
    NodeFS.writeFileSync(file, "{not json");
    expect(await runCli(["status", "--json"], s.io)).toBe(0);
    expect(JSON.parse(s.outs.join("\n")).attention).toEqual([]);
    expect(s.errs).toEqual([
      `factory-runner: warning: ${file} is not valid JSON, so no attention item is kept`,
    ]);
    s.outs.length = 0;
    s.errs.length = 0;
    NodeFS.writeFileSync(file, JSON.stringify({ nothing: [] }));
    expect(await runCli(["status"], s.io)).toBe(0);
    expect(s.errs.join("\n")).toContain(`${file} has no items list`);
  });

  it("runs from the command line: data_dir is FACTORY_RUNNER_HOME and version is the package's", () => {
    const dataDir = tempDir("bin");
    const done = NodeChildProcess.spawnSync(
      process.execPath,
      [NodePath.resolve(import.meta.dirname, "bin.ts"), "status", "--json"],
      { encoding: "utf8", env: { ...process.env, FACTORY_RUNNER_HOME: dataDir } },
    );
    expect(done.status).toBe(0);
    const report = JSON.parse(done.stdout);
    expect(report.data_dir).toBe(dataDir);
    expect(report.version).toBe(
      (
        JSON.parse(
          NodeFS.readFileSync(NodePath.resolve(import.meta.dirname, "../package.json"), "utf8"),
        ) as { version: string }
      ).version,
    );
  });

  it("shows the targets the runner last wrote, and each run's target by the host's name", async () => {
    const s = setup({ isRunner: (pid) => pid === 4242 });
    NodeFS.writeFileSync(
      s.machineConfigPath,
      `gh_config_dir: /gh
max_concurrent_runs: 2
repos:
  - repo: rawphp/softfac
    path: /Users/tom/softfac
    hosts:
      - id: h1
        path: /Users/me/softfac
hosts:
  - id: h1
    name: mini
    ssh: me@mini
    max_runs: 2
paradev:
  cli: /opt/superset
  agent: claude
  belt:
    enabled: false
`,
    );
    NodeFS.writeFileSync(NodePath.join(s.dataDir, LOCK_FILE), "4242\n");
    seed(s.dataDir, [...BUILDING, { event: "session_launched", data: { thread_id: "host:h1:ws-1", worktree: null, branch: null } } as RunEvent]);
    const targets = [
      { kind: "local", name: "local", online: true, load: { oneMinute: 1, cores: 10 }, slots: { used: 0, max: 1 }, ready: true, reason: null },
      { kind: "host", name: "mini", online: true, load: { oneMinute: 3, cores: 8 }, slots: { used: 1, max: 2 }, ready: false, reason: "not ready: gh: not logged in" },
    ];
    NodeFS.writeFileSync(NodePath.join(s.dataDir, "targets.json"), `${JSON.stringify(targets)}\n`);
    expect(await runCli(["status", "--json"], s.io)).toBe(0);
    const report = JSON.parse(s.outs.join("\n"));
    expect(report.targets).toEqual(targets);
    expect(report.runs.map((run: { target: string | null }) => run.target)).toEqual(["mini"]);
    s.outs.length = 0;
    expect(await runCli(["status"], s.io)).toBe(0);
    const text = s.outs.join("\n");
    expect(text).toContain("target local: 0/1");
    expect(text).toContain("target mini: 1/2 (not ready: gh: not logged in)");
    expect(text).toContain(`${ID}  building  mini`);
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

  it("refuses a run that is not building, exit 1", async () => {
    const s = setup();
    seed(s.dataDir, TRIAGE);
    expect(await runCli(["runs", "stop", ID], s.io)).toBe(1);
    expect(s.errs.join("\n")).toContain("its state is triage");
    expect(NodeFS.existsSync(stopRequestPath(s.dataDir, run10))).toBe(false);
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
    expect(NodeFS.readFileSync(file, "utf8")).toBe(`${formatTs(NOW)}\n`);
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

describe("hosts check", () => {
  const BASE = `gh_config_dir: /gh
max_concurrent_runs: 2
`;
  const PARADEV = `paradev:
  cli: /opt/superset
  agent: claude
  belt:
    enabled: false
`;
  const CONFIG = `${BASE}repos:
  - repo: acme/app
    path: /Users/tom/app
    hosts:
      - id: h1
        path: /Users/me/app
hosts:
  - id: h1
    name: mini
    ssh: me@mini
    max_runs: 2
  - id: h2
    name: studio
    ssh: me@studio
    max_runs: 2
${PARADEV}`;
  const SECRET = "sk-secret-value";
  const good = (stdout: string): CommandResult => ({ status: 0, stdout, stderr: "" });

  /** A machine where every check passes on both hosts; `answers` replaces what one ssh command prints. */
  const hostsRun = (answers: Record<string, CommandResult> = {}) => {
    const calls: Array<string> = [];
    const ssh: Record<string, CommandResult> = {
      [TRUE_COMMAND]: good(""),
      [remoteUrl("/Users/me/app")]: good("git@github.com:acme/app.git\n"),
      [trustRead("/Users/me/app")]: good("yes\n"),
      [PROXY_ENV_READ]: good(""),
      [GIT_EMAIL]: good("me@example.com\n"),
      [GH_AUTH_STATUS]: good("ok"),
      [CLAUDE_VERSION]: good("2.1.0"),
      ...answers,
    };
    const run = (command: string, args: ReadonlyArray<string>): CommandResult => {
      if (command === "ssh") {
        calls.push(`ssh ${args.at(-2)}`);
        return ssh[args.at(-1) ?? ""] ?? { status: 1, stdout: "", stderr: "no answer" };
      }
      calls.push(`${command} ${args.join(" ")}`);
      const key = args.filter((arg) => arg !== "--json").join(" ");
      if (key === "hosts list") {
        return good(JSON.stringify([{ id: "h1", name: "mini", online: "yes" }, { id: "h2", name: "studio", online: "yes" }]));
      }
      if (key.startsWith("projects list --host")) {
        return good(JSON.stringify([{ id: "p", name: "app", path: "/Users/me/app", repo: "acme/app" }]));
      }
      return { status: 1, stdout: "", stderr: "unknown" };
    };
    return { run, calls };
  };

  const seedConfig = (s: ReturnType<typeof setup>, text = CONFIG) =>
    NodeFS.writeFileSync(s.machineConfigPath, text);

  it("prints ok for every line and exits 0 when each host is ready", async () => {
    const h = hostsRun();
    const s = setup({ run: h.run });
    seedConfig(s);
    expect(await runCli(["hosts", "check"], s.io)).toBe(0);
    expect(s.outs.filter((line) => !line.startsWith("  "))).toEqual(["mini (me@mini)", "studio (me@studio)"]);
    expect(s.outs.filter((line) => line.startsWith("  ")).every((line) => line.endsWith(": ok"))).toBe(true);
    expect(s.outs).toContain("  online: ok");
    expect(s.errs).toEqual([]);
  });

  it("prints the fix of each failing line and exits 1", async () => {
    const h = hostsRun({ [GH_AUTH_STATUS]: { status: 1, stdout: "", stderr: "not logged in" } });
    const s = setup({ run: h.run });
    seedConfig(s);
    expect(await runCli(["hosts", "check"], s.io)).toBe(1);
    expect(s.outs).toContain("  gh: gh auth login on the host");
    // The same lines install prints: one function runs and prints the checks for both.
    expect(s.outs).toContain("host mini is not ready; the runner gives it no run until its check passes");
  });

  it("checks only the host a name picks", async () => {
    const h = hostsRun();
    const s = setup({ run: h.run });
    seedConfig(s);
    expect(await runCli(["hosts", "check", "studio"], s.io)).toBe(0);
    expect(s.outs[0]).toBe("studio (me@studio)");
    expect(s.outs.filter((line) => !line.startsWith("  "))).toEqual(["studio (me@studio)"]);
    expect(h.calls.some((call) => call.startsWith("ssh me@mini"))).toBe(false);
    expect(h.calls.some((call) => call.startsWith("ssh me@studio"))).toBe(true);
  });

  it("says so, and exits 1, for a name that is no host", async () => {
    const h = hostsRun();
    const s = setup({ run: h.run });
    seedConfig(s);
    expect(await runCli(["hosts", "check", "nope"], s.io)).toBe(1);
    expect(s.errs).toEqual(["no host nope in the machine config"]);
    expect(h.calls).toEqual([]);
  });

  it("says there are no hosts, and exits 0, when the config has none", async () => {
    const s = setup();
    seedConfig(s, `${BASE}repos: []\n${PARADEV}`);
    expect(await runCli(["hosts", "check"], s.io)).toBe(0);
    expect(s.outs).toEqual(["no hosts in the machine config"]);
  });

  it("exits 1 when there is no machine config", async () => {
    const s = setup();
    expect(await runCli(["hosts", "check"], s.io)).toBe(1);
    expect(s.errs.length).toBe(1);
  });

  it("prints the add-it fix for a failing hosts list, with the cause in brackets after it", async () => {
    const h = hostsRun();
    const run = (command: string, args: ReadonlyArray<string>, timeoutMs: number): CommandResult =>
      command !== "ssh" && args[0] === "hosts"
        ? { status: 1, stdout: "", stderr: "Error: PARADEV_OFFLINE: not running\n" }
        : h.run(command, args);
    const s = setup({ run });
    seedConfig(s);
    expect(await runCli(["hosts", "check", "mini"], s.io)).toBe(1);
    expect(s.outs).toContain(
      "  online: add it with superset hosts add me@mini --name mini, or start its host service (sh.superset.host) (superset hosts list failed: PARADEV_OFFLINE: not running)",
    );
  });

  it("prints the trust fix when the trust read fails over ssh", async () => {
    const h = hostsRun({ [trustRead("/Users/me/app")]: { status: 1, stdout: "", stderr: "python3: command not found" } });
    const s = setup({ run: h.run });
    seedConfig(s);
    expect(await runCli(["hosts", "check", "mini"], s.io)).toBe(1);
    expect(s.outs.some((line) => line.startsWith("  trusted acme/app: open Claude Code once in /Users/me/app"))).toBe(true);
  });

  it("exits 1 with the errors when the machine config does not load", async () => {
    const s = setup({ run: hostsRun().run });
    seedConfig(s, "hosts: [unclosed\n");
    expect(await runCli(["hosts", "check"], s.io)).toBe(1);
    expect(s.errs.length).toBeGreaterThan(0);
    expect(s.outs).toEqual([]);
  });

  it("is a usage error, exit 2, with two names", async () => {
    const s = setup({ run: hostsRun().run });
    seedConfig(s);
    expect(await runCli(["hosts", "check", "a", "b"], s.io)).toBe(2);
    expect(s.errs).toEqual([USAGE]);
  });

  it("never prints the proxy token's value", async () => {
    for (const answer of [good(SECRET), good(`ANTHROPIC_AUTH_TOKEN\n${SECRET}`), { status: 1, stdout: SECRET, stderr: SECRET }]) {
      const h = hostsRun({ [PROXY_ENV_READ]: answer });
      const s = setup({ run: h.run });
      seedConfig(s);
      expect(await runCli(["hosts", "check"], s.io)).toBe(1);
      expect(s.outs.join("\n") + s.errs.join("\n")).not.toContain(SECRET);
      expect(s.outs).toContain(
        "  proxy env: add ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN to env in ~/.claude/settings.json on the host",
      );
    }
  });
});
