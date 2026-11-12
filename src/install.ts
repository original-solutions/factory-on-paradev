// @effect-diagnostics nodeBuiltinImport:off - install copies the package and writes LaunchAgent files, then asks launchctl to load them.
/**
 * `factory-runner install` and `uninstall`: the runner as a LaunchAgent on this Mac, with a second
 * agent that rotates its log. Everything outside the machine is reached through {@link InstallEnv},
 * so a test runs it on a temp HOME with `launchctl` and `superset` faked.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Result from "effect/Result";

import { DEFAULT_PARADEV_CLI, parseMachineConfig } from "./config.ts";
import { errnoCode } from "./ledger/errors.ts";
import { readTextOrNull, writeFileWhole } from "./syncFiles.ts";
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
  readonly run: (command: string, args: ReadonlyArray<string>) => CommandResult;
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

const exists = (path: string): boolean => {
  try {
    NodeFS.lstatSync(path);
    return true;
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return false;
    throw error;
  }
};

const firstLine = (text: string): string => text.trim().split("\n")[0] ?? "";

/** The superset CLI: the machine config's `paradev.cli` when that file loads, else the bundled one. */
const supersetCli = (env: InstallEnv): string => {
  try {
    const parsed = parseMachineConfig(
      NodeFS.readFileSync(env.machineConfigPath, "utf8"),
      env.machineConfigPath,
    );
    if (Result.isSuccess(parsed)) return parsed.success.config.paradev.cli;
  } catch {
    // No config, or one that cannot be read: the bundled CLI.
  }
  return DEFAULT_PARADEV_CLI;
};

/** Copies the package to `versions/<version>` and points `current` at it. */
const place = (env: InstallEnv, version: string): string => {
  const { versions, current } = installPathsOf(env.home);
  const target = NodePath.join(versions, version);
  NodeFS.mkdirSync(versions, { recursive: true });
  const installed =
    exists(target) &&
    NodeFS.realpathSync(target) === NodeFS.realpathSync(env.packageRoot);
  if (!installed) {
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
    NodeFS.rmSync(target, { recursive: true, force: true });
    NodeFS.renameSync(temp, target);
  }
  const link = `${current}.${process.pid}.tmp`;
  NodeFS.rmSync(link, { force: true });
  NodeFS.symlinkSync(target, link);
  NodeFS.renameSync(link, current);
  return target;
};

const sizeOf = (path: string): number => {
  try {
    return NodeFS.statSync(path).size;
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return 0;
    throw error;
  }
};

/** The log from `offset` on; all of it when the file is now shorter, as after a rotation. */
const readFrom = (path: string, offset: number): string => {
  let text: string;
  try {
    text = NodeFS.readFileSync(path, "utf8");
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return "";
    throw error;
  }
  const bytes = Buffer.from(text, "utf8");
  return bytes.length < offset ? text : bytes.subarray(offset).toString("utf8");
};

const lastLines = (path: string): string => {
  try {
    return NodeFS.readFileSync(path, "utf8")
      .trimEnd()
      .split("\n")
      .slice(-TAIL_LINES)
      .join("\n");
  } catch {
    return "";
  }
};

/**
 * Installs the runner as a LaunchAgent and returns the exit code. It checks the Superset login
 * first (a LaunchAgent has no Paradev host login of its own) and writes nothing when that fails.
 * Then it copies this package to `versions/<version>`, points `current` at it, writes both agent
 * files, copies `config.example.yml` to the data dir when there is no config (an existing config is
 * never touched), loads the agents, and waits up to 60 s for a new `runner started` line in the log.
 *
 * Loading an agent depends on what launchd holds. Not loaded: `bootstrap`. Loaded, and the plist
 * on disk is what this run wrote: `kickstart -k`. Loaded, and the plist changed (a new node, a new
 * version path): `bootout` then `bootstrap`, because `kickstart` restarts launchd's cached
 * definition and never rereads the file. The log rotation agent comes up first, so a failure there
 * never leaves a runner running behind an exit code of 1.
 */
export const install = async (env: InstallEnv): Promise<number> => {
  const cli = supersetCli(env);
  const whoami = env.run(cli, ["auth", "whoami", "--json"]);
  if (whoami.status !== 0) {
    env.err(
      `factory-runner: superset is not logged in (${firstLine(whoami.stderr) || "no output"}); run \`superset auth login\` (the CLI at ${cli}) in a terminal, then install again`,
    );
    return 1;
  }

  const version = packageVersion(env.packageRoot);
  const placed = place(env, version);

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
  ].map((agent) => {
    const changed = readTextOrNull(agent.file) !== agent.text;
    NodeFS.mkdirSync(NodePath.dirname(agent.file), { recursive: true });
    writeFileWhole(agent.file, agent.text, 0o644);
    return { ...agent, changed };
  });

  if (!exists(env.machineConfigPath)) {
    NodeFS.mkdirSync(NodePath.dirname(env.machineConfigPath), { recursive: true });
    writeFileWhole(
      env.machineConfigPath,
      NodeFS.readFileSync(NodePath.join(placed, "config.example.yml"), "utf8"),
      0o600,
    );
    env.out(`factory-runner: wrote ${env.machineConfigPath} from config.example.yml; edit it`);
  }

  const offset = sizeOf(paths.log);
  const domain = `gui/${env.uid}`;
  const launchctl = (args: ReadonlyArray<string>): boolean => {
    const done = env.run(LAUNCHCTL, args);
    if (done.status === 0) return true;
    env.err(`factory-runner: launchctl ${args.join(" ")} failed: ${done.stderr.trim()}`);
    return false;
  };
  for (const { label, file, changed } of agents) {
    const loaded = env.run(LAUNCHCTL, ["print", `${domain}/${label}`]).status === 0;
    const steps =
      loaded && !changed
        ? [["kickstart", "-k", `${domain}/${label}`]]
        : loaded
          ? [
              ["bootout", `${domain}/${label}`],
              ["bootstrap", domain, file],
            ]
          : [["bootstrap", domain, file]];
    for (const step of steps) if (!launchctl(step)) return 1;
  }

  const deadline = env.now() + WAIT_MS;
  for (;;) {
    if (readFrom(paths.log, offset).includes(STARTED_TEXT)) {
      env.out(`factory-runner ${version} installed and running`);
      return 0;
    }
    if (env.now() >= deadline) break;
    await env.sleep(POLL_MS);
  }
  env.err(
    `factory-runner: no "${STARTED_TEXT}" in ${paths.log} after 60 s; its last ${TAIL_LINES} lines:`,
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
    if (env.run(LAUNCHCTL, ["print", `${domain}/${label}`]).status === 0) {
      const done = env.run(LAUNCHCTL, ["bootout", `${domain}/${label}`]);
      if (done.status !== 0) {
        env.err(
          `factory-runner: launchctl bootout ${domain}/${label} failed: ${done.stderr.trim()}`,
        );
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
