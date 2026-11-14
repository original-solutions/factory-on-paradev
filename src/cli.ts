// @effect-diagnostics nodeBuiltinImport:off - status reads the lock and the package file; the operator commands write control files in the data dir.
/**
 * The operator commands of `factory-runner`: everything but `run`. None of `status`, `runs stop`,
 * `claims` and `retro` talks to the running process; they read the data dir, or leave a file the next
 * pass reads.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as Result from "effect/Result";

import { readAttentionFile } from "./attention.ts";
import { formatConfigError, parseMachineConfig } from "./config.ts";
import { pauseClaimsNow, resumeClaimsNow, stopRun } from "./control.ts";
import { install, uninstall, type CommandResult, type InstallEnv } from "./install.ts";
import { printHostChecks } from "./paradev/hostsCheck.ts";
import { packageVersion } from "./paths.ts";
import { isRunner, lockHolder } from "./runnerLock.ts";
import { retro, RETRO_USAGE } from "./retro.ts";
import { readTextOrNull } from "./syncFiles.ts";
import { hostNamesOf } from "./targets.ts";
import {
  buildStatus,
  type FactoryStatus,
  type StatusReport,
} from "./status.ts";

export const USAGE = `usage: factory-runner run | install | uninstall | status [--json] | runs stop <run id> | claims pause|resume | hosts check [<name>] | ${RETRO_USAGE}`;

/** What the commands read and write, so a test passes a fixture data dir and captures the output. */
export interface CliIo {
  readonly dataDir: string;
  readonly machineConfigPath: string;
  /** The folder holding `package.json`. */
  readonly packageRoot: string;
  readonly now: () => number;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  /** Whether a pid is a runner; defaults to the lock's own check. */
  readonly isRunner?: (pid: number) => boolean;
  readonly installEnv: () => InstallEnv;
  /** Runs `gh` with these arguments; `retro` reads merged PRs' reviews with it. */
  readonly gh: (args: ReadonlyArray<string>) => CommandResult;
  /**
   * Runs a command to the end or `timeoutMs`, with only the `inheritEnv` names of the environment
   * when given; `hosts check` reads hosts with `ssh` and the Superset CLI through it.
   */
  readonly run: (
    command: string,
    args: ReadonlyArray<string>,
    timeoutMs: number,
    inheritEnv?: ReadonlyArray<string>,
  ) => CommandResult;
}

/** Running when a live runner holds the lock and the config loads; else idle, with the reason. */
const factoryStatus = (io: CliIo): FactoryStatus => {
  const pid = lockHolder(io.dataDir);
  if (pid === null || !(io.isRunner ?? isRunner)(pid)) {
    return { state: "idle", reason: "the runner is not running" };
  }
  const text = readTextOrNull(io.machineConfigPath);
  if (text === null) return { state: "idle", reason: "no factory config" };
  const parsed = parseMachineConfig(text, io.machineConfigPath);
  if (Result.isFailure(parsed)) {
    return { state: "idle", reason: "the machine config does not load" };
  }
  const { config } = parsed.success;
  return {
    state: "running",
    settings: {
      pollSeconds: config.pollSeconds,
      maxConcurrentRuns: config.maxConcurrentRuns,
      repos: config.repos.map((repo) => repo.repo),
      hostNames: hostNamesOf(config.hosts),
    },
  };
};

const summary = (report: StatusReport): Array<string> => [
  report.reason === null
    ? `state: ${report.state}`
    : `state: ${report.state} (${report.reason})`,
  `last pass: ${report.passes.at === null ? "none" : `${report.passes.at} ${report.passes.result ?? ""}`.trim()}`,
  `slots: ${report.slots.used}/${report.slots.max ?? "?"}`,
  ...(report.paused_by_hand === null
    ? []
    : [`claims paused since ${report.paused_by_hand.since}`]),
  ...report.targets.map(
    (target) =>
      `target ${target.name}: ${target.slots.used ?? "?"}/${target.slots.max}${target.reason === null ? "" : ` (${target.reason})`}`,
  ),
  ...report.runs.map(
    (run) => `${run.id}  ${run.state ?? "starting"}  ${run.target ?? "-"}  ${run.pr_url ?? "-"}`,
  ),
  ...report.attention.map((item) => `attention: ${item.message}`),
];

const status = (args: ReadonlyArray<string>, io: CliIo): number => {
  const json = args[0] === "--json";
  if (args.length > (json ? 1 : 0)) {
    io.err(USAGE);
    return 2;
  }
  const { open, dismissed, warnings } = readAttentionFile(io.dataDir);
  // On stderr in both forms, so `--json` stays the report and a bad file is not read as no items.
  for (const warning of warnings) io.err(`factory-runner: warning: ${warning}`);
  const report = buildStatus({
    status: factoryStatus(io),
    version: packageVersion(io.packageRoot),
    machine: NodeOS.hostname() || "unknown",
    machineConfigPath: io.machineConfigPath,
    dataDir: io.dataDir,
    nowMs: io.now(),
    passRunning: false,
    runningThreads: null,
    attention: open,
    dismissed,
    health: null,
  });
  if (json) io.out(JSON.stringify(report, null, 2));
  else for (const line of summary(report)) io.out(line);
  return 0;
};

/**
 * `hosts check [<name>]`: the checks of each configured host, or the one named, printed one line
 * each: `ok` or the fix. Exits 1 when any line fails, or the config or the name is wrong.
 */
const hostsCheck = async (name: string | undefined, io: CliIo): Promise<number> => {
  const text = readTextOrNull(io.machineConfigPath);
  if (text === null) {
    io.err(`no machine config at ${io.machineConfigPath}`);
    return 1;
  }
  const parsed = parseMachineConfig(text, io.machineConfigPath);
  if (Result.isFailure(parsed)) {
    for (const problem of parsed.failure) io.err(formatConfigError(problem));
    return 1;
  }
  const { config } = parsed.success;
  if (config.hosts.length === 0) {
    io.out("no hosts in the machine config");
    return 0;
  }
  const chosen = name === undefined ? config.hosts : config.hosts.filter((host) => host.name === name);
  if (chosen.length === 0) {
    io.err(`no host ${name} in the machine config`);
    return 1;
  }
  return (await printHostChecks(io.run, config, chosen, io.out)) ? 0 : 1;
};

const command = async (
  argv: ReadonlyArray<string>,
  io: CliIo,
): Promise<number> => {
  const [first, second, third, ...rest] = argv;
  if (first === "install" && argv.length === 1) return install(io.installEnv());
  if (first === "uninstall" && argv.length === 1)
    return uninstall(io.installEnv());
  if (first === "status") return status(argv.slice(1), io);
  if (first === "retro") return retro(argv.slice(1), io, USAGE);
  if (first === "hosts" && second === "check" && rest.length === 0) return hostsCheck(third, io);
  if (
    first === "runs" &&
    second === "stop" &&
    third !== undefined &&
    rest.length === 0
  ) {
    const stopped = stopRun(io.dataDir, third);
    switch (stopped.kind) {
      case "stopped":
        io.out(stopped.message);
        return 0;
      case "refused":
        io.err(stopped.message);
        return 1;
      case "not-found":
        io.err(`no run ${stopped.id}`);
        return 1;
      case "invalid":
        io.err(stopped.message);
        return 2;
    }
  }
  if (first === "claims" && argv.length === 2) {
    if (second === "pause") {
      io.out(pauseClaimsNow(io.dataDir, io.now()).message);
      return 0;
    }
    if (second === "resume") {
      io.out(resumeClaimsNow(io.dataDir).message);
      return 0;
    }
  }
  io.err(USAGE);
  return 2;
};

/** Runs one command and returns the exit code: 0 done, 1 failed or refused, 2 a wrong command line. */
export const runCli = async (
  argv: ReadonlyArray<string>,
  io: CliIo,
): Promise<number> => {
  try {
    return await command(argv, io);
  } catch (error) {
    io.err(
      `factory-runner: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
};
