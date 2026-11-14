// @effect-diagnostics nodeBuiltinImport:off - install copies the package and writes LaunchAgent files, then asks launchctl to load them.
/**
 * `factory-runner install` and `uninstall`: the runner as a LaunchAgent on this Mac, with a second
 * agent that rotates its log. Everything outside the machine is reached through {@link InstallEnv},
 * so a test runs it on a temp HOME with `launchctl` and `superset` faked.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Result from "effect/Result";

import {
  DEFAULT_PARADEV_CLI,
  formatConfigError,
  parseMachineConfig,
  type MachineConfig,
} from "./config.ts";
import { printHostChecks } from "./paradev/hostsCheck.ts";
import { lstatOrNull, readTextOrNull, writeFileWhole } from "./syncFiles.ts";
import { installPathsOf, LABEL, LOGROTATE_LABEL, packageVersion } from "./paths.ts";

export { LABEL, LOGROTATE_LABEL };

const LAUNCHCTL = "/bin/launchctl";
const STARTED_TEXT = "runner started";
const WAIT_MS = 60_000;
const POLL_MS = 1_000;
const TAIL_LINES = 40;
/** What of the package an install carries into `versions/<version>/`. */
const PACKAGE_ENTRIES = [
  "package.json",
  "package-lock.json",
  "src",
  "scripts",
  "config.example.yml",
  "node_modules",
];

export interface CommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Everything install touches outside its own code: the machine's paths, commands, clock and terminal. */
export interface InstallEnv {
  /** HOME; every path below derives from it. */
  readonly home: string;
  /** The data dir. */
  readonly dataDir: string;
  /** The machine config, `<dataDir>/config.yml`. */
  readonly machineConfigPath: string;
  /** `FACTORY_RUNNER_HOME` when set and not empty; the runner agent gets it too. */
  readonly factoryRunnerHome: string | undefined;
  readonly uid: number;
  readonly execPath: string;
  /** PATH, written into the runner agent. */
  readonly pathEnv: string;
  /** The folder holding this package's `package.json`. */
  readonly packageRoot: string;
  /**
   * Runs a command to the end or `timeoutMs` (default 30 s), with only the `inheritEnv` names of
   * the environment when given; the host checks give ssh 10 s and its own names.
   */
  readonly run: (
    command: string,
    args: ReadonlyArray<string>,
    timeoutMs?: number,
    inheritEnv?: ReadonlyArray<string>,
  ) => CommandResult;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

const xml = (text: string): string =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

const plistOf = (entries: {
  readonly label: string;
  readonly program: ReadonlyArray<string>;
  readonly workingDirectory?: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly runAtLoad?: boolean;
  readonly keepAlive?: boolean;
  readonly throttleInterval?: number;
  readonly startInterval?: number;
  readonly logPath: string;
}): string => {
  const lines: Array<string> = [
    `  <key>Label</key>`,
    `  <string>${xml(entries.label)}</string>`,
    `  <key>ProgramArguments</key>`,
    `  <array>`,
    ...entries.program.map((arg) => `    <string>${xml(arg)}</string>`),
    `  </array>`,
  ];
  if (entries.workingDirectory !== undefined) {
    lines.push(
      `  <key>WorkingDirectory</key>`,
      `  <string>${xml(entries.workingDirectory)}</string>`,
    );
  }
  if (entries.environment !== undefined) {
    lines.push(`  <key>EnvironmentVariables</key>`, `  <dict>`);
    for (const [key, value] of Object.entries(entries.environment)) {
      lines.push(
        `    <key>${xml(key)}</key>`,
        `    <string>${xml(value)}</string>`,
      );
    }
    lines.push(`  </dict>`);
  }
  if (entries.runAtLoad === true)
    lines.push(`  <key>RunAtLoad</key>`, `  <true/>`);
  if (entries.keepAlive === true)
    lines.push(`  <key>KeepAlive</key>`, `  <true/>`);
  if (entries.throttleInterval !== undefined) {
    lines.push(
      `  <key>ThrottleInterval</key>`,
      `  <integer>${entries.throttleInterval}</integer>`,
    );
  }
  if (entries.startInterval !== undefined) {
    lines.push(
      `  <key>StartInterval</key>`,
      `  <integer>${entries.startInterval}</integer>`,
    );
  }
  lines.push(
    `  <key>StandardOutPath</key>`,
    `  <string>${xml(entries.logPath)}</string>`,
    `  <key>StandardErrorPath</key>`,
    `  <string>${xml(entries.logPath)}</string>`,
  );
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    ...lines,
    `</dict>`,
    `</plist>`,
    ``,
  ].join("\n");
};

const exists = (path: string): boolean => lstatOrNull(path) !== null;

const firstLine = (text: string): string => text.trim().split("\n")[0] ?? "";

/**
 * The superset CLI: the machine config's `paradev.cli`, or the bundled one when there is no config
 * yet. A config that is there but does not load is a failure, with every reason: the runner could
 * not start on it either, and its `paradev.cli` may name another CLI than the bundled one.
 */
const supersetCli = (
  env: InstallEnv,
): { readonly cli: string; readonly config: MachineConfig | null } | { readonly problems: ReadonlyArray<string> } => {
  let text: string | null;
  try {
    text = readTextOrNull(env.machineConfigPath);
  } catch (error) {
    return { problems: [`cannot read ${env.machineConfigPath}: ${String(error)}`] };
  }
  if (text === null) return { cli: DEFAULT_PARADEV_CLI, config: null };
  const parsed = parseMachineConfig(text, env.machineConfigPath);
  return Result.isSuccess(parsed)
    ? { cli: parsed.success.config.paradev.cli, config: parsed.success.config }
    : { problems: parsed.failure.map(formatConfigError) };
};

/**
 * Copies the package beside `versions/<version>` and returns the copy, or null when the package
 * is that folder already. Nothing a loaded agent runs from changes until {@link swapIn}.
 */
const stage = (env: InstallEnv, version: string): string | null => {
  const { versions } = installPathsOf(env.home);
  const target = NodePath.join(versions, version);
  NodeFS.mkdirSync(versions, { recursive: true });
  if (exists(target) && NodeFS.realpathSync(target) === NodeFS.realpathSync(env.packageRoot)) {
    return null;
  }
  const temp = NodePath.join(versions, `.${version}.${process.pid}.tmp`);
  NodeFS.rmSync(temp, { recursive: true, force: true });
  NodeFS.mkdirSync(temp);
  for (const entry of PACKAGE_ENTRIES) {
    const from = NodePath.join(env.packageRoot, entry);
    if (!exists(from)) continue;
    NodeFS.cpSync(from, NodePath.join(temp, entry), {
      recursive: true,
      verbatimSymlinks: true,
    });
  }
  return temp;
};

/** Puts the staged copy (when there is one) at `versions/<version>` and points `current` at it. */
const swapIn = (env: InstallEnv, version: string, staged: string | null): void => {
  const { versions, current } = installPathsOf(env.home);
  const target = NodePath.join(versions, version);
  if (staged !== null) {
    NodeFS.rmSync(target, { recursive: true, force: true });
    NodeFS.renameSync(staged, target);
  }
  const link = `${current}.${process.pid}.tmp`;
  NodeFS.rmSync(link, { force: true });
  NodeFS.symlinkSync(target, link);
  NodeFS.renameSync(link, current);
};

/** The log from `offset` on; all of it when the file is now shorter, as after a rotation. */
const readFrom = (path: string, offset: number): string => {
  const text = readTextOrNull(path) ?? "";
  const bytes = Buffer.from(text, "utf8");
  return bytes.length < offset ? text : bytes.subarray(offset).toString("utf8");
};

const lastLines = (path: string): string =>
  (readTextOrNull(path) ?? "").trimEnd().split("\n").slice(-TAIL_LINES).join("\n");

/** Runs `launchctl`; a failure is written to the terminal with launchctl's own words. */
const launchctl = (env: InstallEnv, args: ReadonlyArray<string>): boolean => {
  const done = env.run(LAUNCHCTL, args);
  if (done.status === 0) return true;
  env.err(`factory-runner: launchctl ${args.join(" ")} failed: ${done.stderr.trim()}`);
  return false;
};

/** Whether launchd has the agent loaded: `launchctl print` finds its label. */
const isLoaded = (env: InstallEnv, label: string): boolean =>
  env.run(LAUNCHCTL, ["print", `gui/${env.uid}/${label}`]).status === 0;

/** Polls `done` every second until it holds or {@link WAIT_MS} has passed; whether it held. */
const waitFor = async (env: InstallEnv, done: () => boolean): Promise<boolean> => {
  const deadline = env.now() + WAIT_MS;
  for (;;) {
    if (done()) return true;
    if (env.now() >= deadline) return false;
    await env.sleep(POLL_MS);
  }
};

const WAIT_TEXT = `${WAIT_MS / 1000} s`;

/**
 * Installs the runner as a LaunchAgent and returns the exit code. It checks the machine config and
 * the Superset login first (a LaunchAgent has no Paradev host login of its own) and writes nothing
 * when either fails. Then it copies this package beside `versions/<version>`, writes both agent
 * files, copies `config.example.yml` to the data dir when there is no config (an existing config is
 * never touched), loads the agents, and waits up to 60 s for a new `runner started` line in the log.
 *
 * An agent that is not loaded is bootstrapped. A loaded one is always booted out and bootstrapped
 * again, so launchd reads the plist just written: `kickstart -k` would restart the definition it
 * loaded earlier, with the old node, PATH or data dir. Bootout returns before launchd lets go of the
 * label, and a bootstrap that early fails, so install polls `launchctl print` until the label is
 * gone, for up to 60 s. The log rotation agent comes up first, so a failure there never leaves a
 * runner running behind an exit code of 1. The copy replaces `versions/<version>` and `current`
 * moves to it only once the old runner is gone, so a running runner's code is never removed under
 * it; the log's length is taken at that point too, so only the new runner's `runner started` counts.
 * Between the login check and the copy it prints `hosts check` for each configured host.
 */
export const install = async (env: InstallEnv): Promise<number> => {
  const config = supersetCli(env);
  if ("problems" in config) {
    env.err(
      `factory-runner: the machine config does not load, so install stops before writing anything:`,
    );
    for (const problem of config.problems) env.err(problem);
    return 1;
  }
  const { cli } = config;
  const whoami = env.run(cli, ["auth", "whoami", "--json"]);
  if (whoami.status !== 0) {
    env.err(
      `factory-runner: superset is not logged in (${firstLine(whoami.stderr) || "no output"}); run \`superset auth login\` (the CLI at ${cli}) in a terminal, then install again`,
    );
    return 1;
  }

  // A host that fails does not stop the install: the runner starts either way and gives that
  // host no run until a check passes.
  if (config.config !== null) {
    await printHostChecks(env.run, config.config, config.config.hosts, env.out);
  }

  const version = packageVersion(env.packageRoot);
  const staged = stage(env, version);
  try {
    return await placeAndLoad(env, version, staged);
  } finally {
    if (staged !== null) NodeFS.rmSync(staged, { recursive: true, force: true });
  }
};

/** Writes the agents and the config, swaps the staged copy in and (re)loads both agents. */
const placeAndLoad = async (
  env: InstallEnv,
  version: string,
  staged: string | null,
): Promise<number> => {
  const paths = installPathsOf(env.home);
  NodeFS.mkdirSync(paths.logDir, { recursive: true });
  const agents = [
    {
      label: LOGROTATE_LABEL,
      file: paths.rotatePlist,
      text: plistOf({
        label: LOGROTATE_LABEL,
        program: [
          "/bin/bash",
          NodePath.join(paths.current, "scripts", "rotate-log.sh"),
          paths.log,
        ],
        startInterval: 600,
        logPath: paths.rotateLog,
      }),
    },
    {
      label: LABEL,
      file: paths.runnerPlist,
      text: plistOf({
        label: LABEL,
        program: [env.execPath, NodePath.join(paths.current, "src", "bin.ts"), "run"],
        workingDirectory: env.home,
        environment: {
          PATH: env.pathEnv,
          // The resolved dir: a relative `FACTORY_RUNNER_HOME` means nothing to launchd.
          ...(env.factoryRunnerHome === undefined ? {} : { FACTORY_RUNNER_HOME: env.dataDir }),
        },
        runAtLoad: true,
        keepAlive: true,
        throttleInterval: 10,
        logPath: paths.log,
      }),
    },
  ];
  for (const agent of agents) {
    NodeFS.mkdirSync(NodePath.dirname(agent.file), { recursive: true });
    writeFileWhole(agent.file, agent.text, 0o644);
  }

  if (!exists(env.machineConfigPath)) {
    NodeFS.mkdirSync(NodePath.dirname(env.machineConfigPath), { recursive: true });
    writeFileWhole(
      env.machineConfigPath,
      NodeFS.readFileSync(NodePath.join(env.packageRoot, "config.example.yml"), "utf8"),
      0o600,
    );
    env.out(`factory-runner: wrote ${env.machineConfigPath} from config.example.yml; edit it`);
  }

  const domain = `gui/${env.uid}`;
  let offset = 0;
  for (const { label, file } of agents) {
    if (isLoaded(env, label)) {
      if (!launchctl(env, ["bootout", `${domain}/${label}`])) return 1;
      if (!(await waitFor(env, () => !isLoaded(env, label)))) {
        env.err(
          `factory-runner: ${domain}/${label} is still loaded ${WAIT_TEXT} after launchctl bootout; not bootstrapping it`,
        );
        return 1;
      }
    }
    if (label === LABEL) {
      offset = lstatOrNull(paths.log)?.size ?? 0;
      swapIn(env, version, staged);
    }
    if (!launchctl(env, ["bootstrap", domain, file])) return 1;
  }

  if (await waitFor(env, () => readFrom(paths.log, offset).includes(STARTED_TEXT))) {
    env.out(`factory-runner ${version} installed and running`);
    return 0;
  }
  env.err(
    `factory-runner: no "${STARTED_TEXT}" in ${paths.log} after ${WAIT_TEXT}; its last ${TAIL_LINES} lines:`,
  );
  env.err(lastLines(paths.log));
  return 1;
};

/**
 * Boots out both agents and removes their files. The config, the data and the installed versions
 * stay. A file whose agent would not boot out stays too, so the loaded job still has its plist.
 * Returns 1 when a bootout failed.
 */
export const uninstall = async (env: InstallEnv): Promise<number> => {
  let code = 0;
  const domain = `gui/${env.uid}`;
  const paths = installPathsOf(env.home);
  for (const [label, plist] of [
    [LABEL, paths.runnerPlist],
    [LOGROTATE_LABEL, paths.rotatePlist],
  ] as const) {
    if (isLoaded(env, label)) {
      if (!launchctl(env, ["bootout", `${domain}/${label}`])) {
        code = 1;
        continue;
      }
      env.out(`factory-runner: stopped ${label}`);
    }
    if (exists(plist)) {
      NodeFS.rmSync(plist, { force: true });
      env.out(`factory-runner: removed ${plist}`);
    }
  }
  return code;
};
