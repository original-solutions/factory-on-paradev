// @effect-diagnostics nodeBuiltinImport:off - the tests lay out a fake package and a fake HOME in a temp dir and read back what install wrote.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DEFAULT_PARADEV_CLI } from "./config.ts";
import { install, LABEL, LOGROTATE_LABEL, uninstall, type InstallEnv } from "./install.ts";
import { installPathsOf } from "./paths.ts";

const EXAMPLE = NodeFS.readFileSync(
  NodePath.resolve(import.meta.dirname, "../config.example.yml"),
  "utf8",
);
const PLUTIL = "/usr/bin/plutil";
const UID = 501;

let tmp: string;

beforeAll(() => {
  tmp = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "factory-install-")));
});

afterAll(() => {
  NodeFS.rmSync(tmp, { recursive: true, force: true });
});

const write = (path: string, text: string) => {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  NodeFS.writeFileSync(path, text);
};

/** One fake package root, shared by the cases: it is only read. */
const makePackage = (): string => {
  const root = NodeFS.mkdtempSync(NodePath.join(tmp, "pkg-"));
  write(NodePath.join(root, "package.json"), JSON.stringify({ version: "1.2.3" }));
  write(NodePath.join(root, "src", "bin.ts"), "// bin\n");
  write(NodePath.join(root, "scripts", "rotate-log.sh"), "#!/bin/bash\n");
  write(NodePath.join(root, "config.example.yml"), "example: config\n");
  write(NodePath.join(root, "node_modules", "x", "index.js"), "module.exports = 1;\n");
  return root;
};

interface Fixture {
  readonly env: InstallEnv;
  readonly home: string;
  readonly calls: Array<ReadonlyArray<string>>;
  readonly errs: Array<string>;
  readonly outs: Array<string>;
  readonly log: string;
  readonly dataDir: string;
  /** Milliseconds the fake clock has moved since the fixture was made. */
  readonly elapsed: () => number;
}

const makeFixture = (
  options: {
    readonly home?: string;
    readonly loggedIn?: boolean;
    readonly startsRunner?: boolean;
    readonly packageRoot?: string;
    /** Appends `runner started` to the log on this sleep call, instead of on a runner start. */
    readonly startsOnSleep?: number;
    /** This launchctl verb exits 1. */
    readonly failVerb?: string;
  } = {},
): Fixture => {
  const home = options.home ?? NodeFS.mkdtempSync(NodePath.join(tmp, "home-"));
  const packageRoot = options.packageRoot ?? makePackage();
  const log = NodePath.join(home, "Library", "Logs", "factory-runner", "runner.log");
  const dataDir = NodePath.join(home, ".config", "factory-runner");
  const calls: Array<ReadonlyArray<string>> = [];
  const loaded = new Set<string>();
  const start = 1_000_000;
  let clock = start;
  let sleeps = 0;
  const labelOf = (target: string) => target.slice(target.lastIndexOf("/") + 1);
  const env: InstallEnv = {
    home,
    dataDir,
    machineConfigPath: NodePath.join(dataDir, "config.yml"),
    factoryRunnerHome: undefined,
    uid: UID,
    execPath: "/opt/node/bin/node",
    pathEnv: "/usr/bin:/bin",
    packageRoot,
    run: (command, args) => {
      calls.push([command, ...args]);
      const ok = { status: 0, stdout: "", stderr: "" };
      if (command !== "/bin/launchctl") {
        // The superset CLI.
        return options.loggedIn === false
          ? { status: 1, stdout: "", stderr: "Error: Not logged in\n" }
          : ok;
      }
      const [verb, target = ""] = args;
      if (verb === options.failVerb) return { status: 1, stdout: "", stderr: "boom\n" };
      if (verb === "print") {
        return loaded.has(labelOf(target)) ? ok : { status: 113, stdout: "", stderr: "not found" };
      }
      if (verb === "bootout") {
        loaded.delete(labelOf(target));
        return ok;
      }
      if (verb === "bootstrap" || verb === "kickstart") {
        const name =
          verb === "bootstrap"
            ? NodePath.basename(args[2] ?? "", ".plist")
            : labelOf(args[2] ?? "");
        loaded.add(name);
        if (name === LABEL && options.startsRunner !== false && options.startsOnSleep === undefined) {
          NodeFS.mkdirSync(NodePath.dirname(log), { recursive: true });
          NodeFS.appendFileSync(log, "2026-11-12 runner started\n");
        }
        return ok;
      }
      return ok;
    },
    sleep: async (ms) => {
      clock += ms;
      sleeps += 1;
      if (sleeps === options.startsOnSleep) {
        NodeFS.mkdirSync(NodePath.dirname(log), { recursive: true });
        NodeFS.appendFileSync(log, "2026-11-12 runner started\n");
      }
    },
    now: () => clock,
    out: (line) => outs.push(line),
    err: (line) => errs.push(line),
  };
  const outs: Array<string> = [];
  const errs: Array<string> = [];
  return { env, home, calls, errs, outs, log, dataDir, elapsed: () => clock - start };
};

const runnerPlist = (home: string) => installPathsOf(home).runnerPlist;
const logrotatePlist = (home: string) => installPathsOf(home).rotatePlist;
const launchctl = (f: Fixture) =>
  f.calls.filter((call) => call[0] === "/bin/launchctl").map((call) => call.slice(1));
const verbs = (f: Fixture) => launchctl(f).filter((call) => call[0] !== "print");

/** Every value the agent hands launchd as a path, or as a program argument other than `run`. */
const pathValues = (file: string): Array<string> => {
  if (NodeFS.existsSync(PLUTIL)) {
    const converted = NodeChildProcess.spawnSync(PLUTIL, ["-convert", "json", "-o", "-", file], {
      encoding: "utf8",
    });
    const plist = JSON.parse(converted.stdout) as {
      ProgramArguments: Array<string>;
      WorkingDirectory?: string;
      StandardOutPath: string;
      StandardErrorPath: string;
      EnvironmentVariables?: { FACTORY_RUNNER_HOME?: string };
    };
    return [
      ...plist.ProgramArguments.filter((arg) => arg !== "run"),
      ...(plist.WorkingDirectory === undefined ? [] : [plist.WorkingDirectory]),
      plist.StandardOutPath,
      plist.StandardErrorPath,
      ...(plist.EnvironmentVariables?.FACTORY_RUNNER_HOME === undefined
        ? []
        : [plist.EnvironmentVariables.FACTORY_RUNNER_HOME]),
    ];
  }
  const text = NodeFS.readFileSync(file, "utf8");
  const single = (key: string) =>
    [...text.matchAll(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`, "g"))].map(
      (match) => match[1] ?? "",
    );
  const program = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text)?.[1] ?? "";
  return [
    ...[...program.matchAll(/<string>([^<]*)<\/string>/g)]
      .map((match) => match[1] ?? "")
      .filter((arg) => arg !== "run"),
    ...single("WorkingDirectory"),
    ...single("StandardOutPath"),
    ...single("StandardErrorPath"),
    ...single("FACTORY_RUNNER_HOME"),
  ];
};

describe("install", () => {
  it("copies the package, points current at it, writes both agents and the config, and loads them", async () => {
    const f = makeFixture();
    expect(await install(f.env)).toBe(0);
    const share = NodePath.join(f.home, ".local", "share", "factory-runner");
    expect(NodeFS.existsSync(NodePath.join(share, "versions", "1.2.3", "src", "bin.ts"))).toBe(true);
    expect(
      NodeFS.existsSync(NodePath.join(share, "versions", "1.2.3", "node_modules", "x", "index.js")),
    ).toBe(true);
    expect(NodeFS.lstatSync(NodePath.join(share, "current")).isSymbolicLink()).toBe(true);
    expect(NodeFS.realpathSync(NodePath.join(share, "current"))).toBe(
      NodeFS.realpathSync(NodePath.join(share, "versions", "1.2.3")),
    );

    const runner = NodeFS.readFileSync(runnerPlist(f.home), "utf8");
    const rotate = NodeFS.readFileSync(logrotatePlist(f.home), "utf8");
    for (const file of [runnerPlist(f.home), logrotatePlist(f.home)]) {
      const values = pathValues(file);
      // program (2 or 3 values), working dir (runner only), and the two log paths.
      expect(values.length).toBeGreaterThanOrEqual(4);
      for (const value of values) expect(NodePath.isAbsolute(value)).toBe(true);
    }
    expect(pathValues(runnerPlist(f.home))).toContain(f.home);
    expect(runner).not.toContain("<key>FACTORY_RUNNER_HOME</key>");
    expect(runner).toContain("/opt/node/bin/node");
    expect(runner).toContain(`${share}/current/src/bin.ts`);
    expect(runner).toContain("<string>run</string>");
    expect(runner).toContain("RunAtLoad");
    expect(runner).toContain("KeepAlive");
    expect(runner).toMatch(/<key>ThrottleInterval<\/key>\s*<integer>10<\/integer>/);
    expect(runner).toMatch(new RegExp(`<key>StandardOutPath</key>\\s*<string>${f.log}</string>`));
    expect(rotate).toContain("/bin/bash");
    expect(rotate).toContain(`${share}/current/scripts/rotate-log.sh`);
    expect(rotate).toContain(f.log);
    expect(rotate).toMatch(/<key>StartInterval<\/key>\s*<integer>600<\/integer>/);

    expect(NodeFS.readFileSync(NodePath.join(f.dataDir, "config.yml"), "utf8")).toBe(
      "example: config\n",
    );
    expect(verbs(f)).toEqual([
      ["bootstrap", `gui/${UID}`, logrotatePlist(f.home)],
      ["bootstrap", `gui/${UID}`, runnerPlist(f.home)],
    ]);
    expect(launchctl(f).filter((call) => call[0] === "print")).toEqual([
      ["print", `gui/${UID}/${LOGROTATE_LABEL}`],
      ["print", `gui/${UID}/${LABEL}`],
    ]);
    expect(f.outs.join("\n")).toContain("1.2.3 installed and running");
  });

  it.runIf(NodeFS.existsSync(PLUTIL))("writes plists that plutil accepts", async () => {
    const f = makeFixture();
    expect(await install(f.env)).toBe(0);
    for (const file of [runnerPlist(f.home), logrotatePlist(f.home)]) {
      const linted = NodeChildProcess.spawnSync(PLUTIL, ["-lint", file], { encoding: "utf8" });
      expect(linted.stdout + linted.stderr).toContain("OK");
      expect(linted.status).toBe(0);
    }
  });

  it("leaves an edited config alone and kickstarts the agents a second run finds loaded", async () => {
    const f = makeFixture();
    expect(await install(f.env)).toBe(0);
    const config = NodePath.join(f.dataDir, "config.yml");
    NodeFS.writeFileSync(config, "edited: true\n");
    f.calls.length = 0;
    expect(await install(f.env)).toBe(0);
    expect(NodeFS.readFileSync(config, "utf8")).toBe("edited: true\n");
    expect(verbs(f)).toEqual([
      ["kickstart", "-k", `gui/${UID}/${LOGROTATE_LABEL}`],
      ["kickstart", "-k", `gui/${UID}/${LABEL}`],
    ]);
  });

  it("boots a loaded agent out and in again when its plist changed, since kickstart never rereads it", async () => {
    const f = makeFixture();
    expect(await install(f.env)).toBe(0);
    f.calls.length = 0;
    expect(await install({ ...f.env, execPath: "/other/node/bin/node" })).toBe(0);
    expect(verbs(f)).toEqual([
      ["kickstart", "-k", `gui/${UID}/${LOGROTATE_LABEL}`],
      ["bootout", `gui/${UID}/${LABEL}`],
      ["bootstrap", `gui/${UID}`, runnerPlist(f.home)],
    ]);
    expect(NodeFS.readFileSync(runnerPlist(f.home), "utf8")).toContain("/other/node/bin/node");
  });

  it("writes the resolved data dir into the runner agent when FACTORY_RUNNER_HOME is set", async () => {
    const f = makeFixture();
    const dataDir = NodeFS.mkdtempSync(NodePath.join(tmp, "data-"));
    expect(
      await install({
        ...f.env,
        factoryRunnerHome: "relative/data",
        dataDir,
        machineConfigPath: NodePath.join(dataDir, "config.yml"),
      }),
    ).toBe(0);
    expect(NodeFS.readFileSync(runnerPlist(f.home), "utf8")).toMatch(
      new RegExp(`<key>FACTORY_RUNNER_HOME</key>\\s*<string>${dataDir}</string>`),
    );
    expect(NodeFS.readFileSync(NodePath.join(dataDir, "config.yml"), "utf8")).toBe(
      "example: config\n",
    );
    expect(NodeFS.existsSync(f.dataDir)).toBe(false);
  });

  it("returns 0 when `runner started` shows only after four polls", async () => {
    const f = makeFixture({ startsOnSleep: 5 });
    expect(await install(f.env)).toBe(0);
    expect(f.elapsed()).toBe(5_000);
  });

  it("exits 1 naming the launchctl command when bootstrap fails", async () => {
    const f = makeFixture({ failVerb: "bootstrap" });
    expect(await install(f.env)).toBe(1);
    expect(f.errs.join("\n")).toContain(`launchctl bootstrap gui/${UID}`);
    expect(f.errs.join("\n")).toContain("boom");
    // It stops at the first failure: the runner is never loaded behind an exit code of 1.
    expect(verbs(f)).toEqual([["bootstrap", `gui/${UID}`, logrotatePlist(f.home)]]);
    expect(f.elapsed()).toBe(0);
  });

  it("stops before writing anything when superset is not logged in", async () => {
    const f = makeFixture({ loggedIn: false });
    expect(await install(f.env)).toBe(1);
    expect(f.errs.join("\n")).toContain("superset auth login");
    expect(NodeFS.existsSync(NodePath.join(f.home, ".local"))).toBe(false);
    expect(NodeFS.existsSync(NodePath.join(f.home, "Library"))).toBe(false);
    expect(launchctl(f)).toEqual([]);
  });

  it("checks the superset CLI the machine config names, else the bundled one", async () => {
    const plain = makeFixture();
    await install(plain.env);
    expect(plain.calls[0]).toEqual([DEFAULT_PARADEV_CLI, "auth", "whoami", "--json"]);

    const f = makeFixture();
    const cli = "/custom/bin/superset";
    const changed = EXAMPLE.replace(/^ {2}cli: .*$/m, `  cli: ${cli}`);
    expect(changed).not.toBe(EXAMPLE);
    write(NodePath.join(f.dataDir, "config.yml"), changed);
    expect(await install(f.env)).toBe(0);
    expect(f.calls[0]).toEqual([cli, "auth", "whoami", "--json"]);
  });

  it("fails with the log's last 40 lines when no new `runner started` shows, ignoring an old one", async () => {
    const f = makeFixture({ startsRunner: false });
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`);
    lines[2] = "old runner started";
    write(f.log, `${lines.join("\n")}\n`);
    expect(await install(f.env)).toBe(1);
    const message = f.errs.join("\n");
    expect(message).toContain("no \"runner started\"");
    expect(message).toContain("line 50");
    expect(message).toContain("line 11");
    expect(message).not.toContain("line 10\n");
    expect(message).not.toContain("old runner started");
    expect(f.elapsed()).toBeGreaterThanOrEqual(60_000);
    expect(f.elapsed()).toBeLessThan(62_000);
  });

  it("uninstalls both agents and their plists, keeping config, data and versions", async () => {
    const f = makeFixture();
    expect(await install(f.env)).toBe(0);
    f.calls.length = 0;
    expect(await uninstall(f.env)).toBe(0);
    expect(launchctl(f).filter((call) => call[0] === "bootout")).toEqual([
      ["bootout", `gui/${UID}/${LABEL}`],
      ["bootout", `gui/${UID}/${LOGROTATE_LABEL}`],
    ]);
    expect(f.outs.filter((line) => line.includes("removed"))).toHaveLength(2);
    expect(NodeFS.existsSync(runnerPlist(f.home))).toBe(false);
    expect(NodeFS.existsSync(logrotatePlist(f.home))).toBe(false);
    expect(NodeFS.existsSync(NodePath.join(f.dataDir, "config.yml"))).toBe(true);
    expect(
      NodeFS.existsSync(NodePath.join(f.home, ".local", "share", "factory-runner", "versions", "1.2.3")),
    ).toBe(true);
  });

  it("keeps a plist whose agent would not boot out, and says only what it removed", async () => {
    const f = makeFixture();
    expect(await install(f.env)).toBe(0);
    f.outs.length = 0;
    const env: InstallEnv = {
      ...f.env,
      run: (_command, args) =>
        args[0] === "bootout"
          ? { status: 1, stdout: "", stderr: "boom\n" }
          : { status: 0, stdout: "", stderr: "" },
    };
    expect(await uninstall(env)).toBe(1);
    expect(f.errs.join("\n")).toContain("launchctl bootout");
    expect(NodeFS.existsSync(runnerPlist(f.home))).toBe(true);
    expect(NodeFS.existsSync(logrotatePlist(f.home))).toBe(true);
    expect(f.outs.filter((line) => line.includes("removed"))).toEqual([]);
  });

  it("says nothing was removed when there were no plists", async () => {
    const f = makeFixture();
    expect(await uninstall(f.env)).toBe(0);
    expect(f.outs.filter((line) => line.includes("removed"))).toEqual([]);
  });
});
