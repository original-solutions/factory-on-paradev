// @effect-diagnostics nodeBuiltinImport:off - the tests lay out a fake HOME with an installed version and read back what the updater placed.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as TestClock from "effect/testing/TestClock";
import { afterAll, beforeAll, describe } from "vitest";

import { installPathsOf } from "./paths.ts";
import { FactoryProcess, type RunInput, type RunResult } from "./process.ts";
import { makeSelfUpdate } from "./selfUpdate.ts";
import { CONFIG_NOT_LOADED_REASON } from "./status.ts";

const EXEC_PATH = "/opt/node/bin/node";
const GH_DIR = "/gh/factory";
const TEN_MINUTES = 10 * 60 * 1000;
const LS_REFS = ["api", "repos/o/r/git/matching-refs/tags/v", "--jq", ".[].ref"];

let tmp: string;

beforeAll(() => {
  tmp = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "factory-update-")));
});

afterAll(() => {
  NodeFS.rmSync(tmp, { recursive: true, force: true });
});

const write = (path: string, text: string) => {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  NodeFS.writeFileSync(path, text);
};

const result = (exitCode: number, tail = "", stderrTail = ""): RunResult => ({
  exitCode,
  timedOut: false,
  tail,
  stderrTail,
  truncated: false,
  tailTruncated: false,
});

/** What each faked command does; a test changes it between periods. */
interface Answers {
  refs: ReadonlyArray<string> | "fail" | "too-long";
  npm: "ok" | "fail" | "timeout" | "throw";
  /** The version the staged tree's `status --json` reports, or a failed run. */
  smoke: string | "fail";
  /** What else that report says: an idle reason, or output longer than the tail kept. */
  smokeReason: string | null;
  smokeTruncated: boolean;
  /** Whether the clone's HEAD carries the tag; false is a clone that took a branch of that name. */
  tagAtHead: boolean;
  /** Gate calls this process is running now. */
  gates: number;
}

interface Fixture {
  readonly home: string;
  readonly dataDir: string;
  readonly packageRoot: string;
  readonly calls: Array<RunInput>;
  readonly answers: Answers;
  readonly logs: Array<{ readonly level: string; readonly text: string }>;
}

/**
 * A fresh HOME with version 0.1.0 installed at `versions/0.1.0` and `current` pointing at it. With
 * `underVersions: false` the running package is a checkout beside it instead.
 */
const fixture = (underVersions = true): Fixture => {
  const home = NodeFS.mkdtempSync(NodePath.join(tmp, "home-"));
  const { versions, current } = installPathsOf(home);
  const installed = NodePath.join(versions, "0.1.0");
  const packageRoot = underVersions ? installed : NodePath.join(home, "checkout");
  for (const root of [installed, packageRoot]) {
    write(
      NodePath.join(root, "package.json"),
      JSON.stringify({ version: "0.1.0", repository: "github:o/r" }),
    );
    write(NodePath.join(root, "src", "bin.ts"), "// 0.1.0\n");
  }
  NodeFS.symlinkSync(installed, current);
  return {
    home,
    dataDir: NodePath.join(home, "data"),
    packageRoot,
    calls: [],
    answers: {
      refs: [],
      npm: "ok",
      smoke: "0.2.0",
      smokeReason: null,
      smokeTruncated: false,
      tagAtHead: true,
      gates: 0,
    },
    logs: [],
  };
};

/** A clone of the tag: what `git clone` would leave, with entries install does not carry. */
const fakeClone = (dir: string, version: string) => {
  write(NodePath.join(dir, "package.json"), JSON.stringify({ version, repository: "github:o/r" }));
  write(NodePath.join(dir, "package-lock.json"), "{}\n");
  write(NodePath.join(dir, "src", "bin.ts"), `// ${version}\n`);
  write(NodePath.join(dir, "scripts", "rotate-log.sh"), "#!/bin/bash\n");
  write(NodePath.join(dir, "config.example.yml"), "notify: true\n");
  write(NodePath.join(dir, "README.md"), "# readme\n");
  write(NodePath.join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
};

const fakeProcess = (f: Fixture) =>
  FactoryProcess.of({
    run: (input) =>
      Effect.sync(() => {
        f.calls.push(input);
        if (input.command === "gh") {
          if (f.answers.refs === "fail") return result(1, "", "HTTP 502: Bad Gateway");
          if (f.answers.refs === "too-long") {
            return { ...result(0, "refs/tags/v0.2.0\n"), truncated: true, tailTruncated: true };
          }
          return result(0, f.answers.refs.map((ref) => `${ref}\n`).join(""));
        }
        if (input.command === "git") {
          const args = input.args ?? [];
          if (args.includes("--points-at")) {
            const dir = args[args.indexOf("-C") + 1]!;
            const { version } = JSON.parse(NodeFS.readFileSync(NodePath.join(dir, "package.json"), "utf8")) as {
              version: string;
            };
            return result(0, f.answers.tagAtHead ? `v${version}\n` : "");
          }
          const tag = args[args.indexOf("--branch") + 1]!;
          fakeClone(args.at(-1)!, tag.slice(1));
          return result(0);
        }
        if (input.command === "npm") {
          if (f.answers.npm === "fail") return result(1, "npm ERR! code ERESOLVE\nnpm ERR! last line");
          // Killed at its limit; npm can still exit 0 on the SIGTERM.
          if (f.answers.npm === "timeout") return { ...result(0, "npm http fetch"), timedOut: true };
          if (f.answers.npm === "throw") throw new Error("EMFILE: too many open files");
          write(NodePath.join(input.cwd!, "node_modules", "yaml", "index.js"), "// yaml\n");
          return result(0, "added 3 packages");
        }
        if (input.command === EXEC_PATH) {
          if (f.answers.smoke === "fail") return result(1, "", "Error: Cannot find module 'yaml'");
          const report =
            f.answers.smokeReason === null
              ? { state: "running", version: f.answers.smoke }
              : { state: "idle", reason: f.answers.smokeReason, version: f.answers.smoke };
          const json = JSON.stringify(report);
          return f.answers.smokeTruncated
            ? { ...result(0, json.slice(json.length / 2)), truncated: true, tailTruncated: true }
            : result(0, json);
        }
        throw new Error(`unexpected command ${input.command}`);
      }),
  });

const capture = (f: Fixture) =>
  Logger.layer(
    [
      Logger.make(({ message, logLevel }) => {
        const first = Array.isArray(message) ? message[0] : message;
        f.logs.push({ level: logLevel, text: typeof first === "string" ? first : String(first) });
      }),
    ],
    { mergeWithExisting: false },
  );

/** The updater over `f`, its loop forked with `enabled`; the body runs beside it. */
const withUpdater = <A, E>(
  f: Fixture,
  enabled: boolean,
  body: (update: Effect.Success<ReturnType<typeof makeSelfUpdate>>) => Effect.Effect<A, E>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const update = yield* makeSelfUpdate({
        home: f.home,
        dataDir: f.dataDir,
        packageRoot: f.packageRoot,
        execPath: EXEC_PATH,
        ghConfigDir: () => GH_DIR,
        gatesRunning: () => f.answers.gates,
      });
      yield* Effect.forkScoped(update.run(enabled), { startImmediately: true });
      return yield* body(update);
    }),
  ).pipe(Effect.provideService(FactoryProcess, fakeProcess(f)), Effect.provide(capture(f)));

const loud = (f: Fixture) => f.logs.filter((log) => log.level !== "Debug" && log.level !== "Trace");
const commands = (f: Fixture) => f.calls.map((call) => call.command);
const versionDirs = (f: Fixture) => NodeFS.readdirSync(installPathsOf(f.home).versions).sort();
const currentTarget = (f: Fixture) => NodeFS.readlinkSync(installPathsOf(f.home).current);

describe("self-update", () => {
  it.effect("does nothing but say so when self_update is false", () => {
    const f = fixture();
    f.answers.refs = ["refs/tags/v0.2.0"];
    return withUpdater(f, false, () =>
      Effect.gen(function* () {
        yield* TestClock.adjust("30 minutes");
        expect(f.calls).toEqual([]);
        expect(loud(f)).toEqual([{ level: "Info", text: "self-update off: self_update is false" }]);
      }),
    );
  });

  it.effect("does nothing but say so when the running package is not under versions/", () => {
    const f = fixture(false);
    f.answers.refs = ["refs/tags/v0.2.0"];
    return withUpdater(f, true, () =>
      Effect.gen(function* () {
        yield* TestClock.adjust("30 minutes");
        expect(f.calls).toEqual([]);
        expect(loud(f)).toEqual([
          {
            level: "Info",
            text: `self-update off: ${f.packageRoot} is not an installed version under ${installPathsOf(f.home).versions}`,
          },
        ]);
      }),
    );
  });

  it.effect("first reads the tags ten minutes after start, as the factory's gh login", () => {
    const f = fixture();
    return withUpdater(f, true, () =>
      Effect.gen(function* () {
        yield* TestClock.adjust(TEN_MINUTES - 1);
        expect(f.calls).toEqual([]);
        yield* TestClock.adjust(1);
        expect(f.calls).toHaveLength(1);
        expect(f.calls[0]).toMatchObject({ command: "gh", args: LS_REFS, env: { GH_CONFIG_DIR: GH_DIR } });
        yield* TestClock.adjust(TEN_MINUTES);
        expect(f.calls).toHaveLength(2);
      }),
    );
  });

  it.effect("stages the highest vX.Y.Z by number and ignores refs of any other shape", () => {
    const f = fixture();
    f.answers.refs = [
      "refs/tags/v0.1.0",
      "refs/tags/v0.9.9",
      "refs/tags/v0.10.0",
      "refs/tags/v0.11.0-rc.1",
      "refs/tags/v1",
      "refs/tags/release-2",
      "refs/tags/v2.0.0.1",
    ];
    f.answers.smoke = "0.10.0";
    return withUpdater(f, true, () =>
      Effect.gen(function* () {
        yield* TestClock.adjust(TEN_MINUTES);
        const clone = f.calls[1]!;
        expect(clone.command).toBe("git");
        expect(clone.args).toEqual(
          expect.arrayContaining(["clone", "--depth", "1", "--branch", "v0.10.0", "https://github.com/o/r.git"]),
        );
        expect(currentTarget(f)).toBe(NodePath.join(installPathsOf(f.home).versions, "0.10.0"));
      }),
    );
  });

  it.effect("does nothing and logs nothing when the highest tag is the running version or lower", () => {
    const f = fixture();
    f.answers.refs = ["refs/tags/v0.1.0", "refs/tags/v0.0.9"];
    return withUpdater(f, true, () =>
      Effect.gen(function* () {
        yield* TestClock.adjust(TEN_MINUTES);
        f.answers.refs = ["refs/tags/v0.0.9"];
        yield* TestClock.adjust(TEN_MINUTES);
        expect(commands(f)).toEqual(["gh", "gh"]);
        expect(loud(f)).toEqual([]);
        expect(versionDirs(f)).toEqual(["0.1.0"]);
      }),
    );
  });

  it.effect("a failed tag read is one warning, and the next period reads again", () => {
    const f = fixture();
    f.answers.refs = "fail";
    return withUpdater(f, true, () =>
      Effect.gen(function* () {
        yield* TestClock.adjust(TEN_MINUTES);
        expect(loud(f)).toHaveLength(1);
        expect(loud(f)[0]!.level).toBe("Warn");
        expect(loud(f)[0]!.text).toContain("HTTP 502: Bad Gateway");
        f.answers.refs = ["refs/tags/v0.2.0"];
        yield* TestClock.adjust(TEN_MINUTES);
        expect(commands(f)).toEqual(["gh", "gh", "git", "git", "npm", EXEC_PATH]);
      }),
    );
  });

  it.effect("a tag list longer than the read keeps is a failed read, not a shorter list", () => {
    const f = fixture();
    f.answers.refs = "too-long";
    return withUpdater(f, true, () =>
      Effect.gen(function* () {
        yield* TestClock.adjust(TEN_MINUTES);
        expect(f.calls[0]!.tailBytes).toBe(1024 * 1024);
        expect(commands(f)).toEqual(["gh"]);
        expect(loud(f).map((log) => log.level)).toEqual(["Warn"]);
        expect(loud(f)[0]!.text).toContain("printed more than");
      }),
    );
  });

  it.effect("a step that hits its time limit fails even when it exits 0", () => {
    const f = fixture();
    f.answers.refs = ["refs/tags/v0.2.0"];
    f.answers.npm = "timeout";
    return withUpdater(f, true, () =>
      Effect.gen(function* () {
        yield* TestClock.adjust(TEN_MINUTES);
        expect(versionDirs(f)).toEqual(["0.1.0"]);
        expect(loud(f).map((log) => log.level)).toEqual(["Warn"]);
        expect(loud(f)[0]!.text).toContain("npm ci timed out");
      }),
    );
  });

  it.effect("a defect inside a period is one warning, and the next period reads again", () => {
    const f = fixture();
    f.answers.refs = ["refs/tags/v0.2.0"];
    f.answers.npm = "throw";
    return withUpdater(f, true, () =>
      Effect.gen(function* () {
        yield* TestClock.adjust(TEN_MINUTES);
        expect(loud(f).map((log) => log.level)).toEqual(["Warn"]);
        expect(loud(f)[0]!.text).toContain("EMFILE");
        yield* TestClock.adjust(TEN_MINUTES);
        expect(commands(f).filter((command) => command === "gh")).toHaveLength(2);
      }),
    );
  });

  it.effect("clones with the gh login, installs with this node first on PATH, and smokes the tree", () => {
    const f = fixture();
    f.answers.refs = ["refs/tags/v0.2.0"];
    return withUpdater(f, true, () =>
      Effect.gen(function* () {
        yield* TestClock.adjust(TEN_MINUTES);
        const [, clone, tagCheck, npm, smoke] = f.calls;
        const dir = clone!.args!.at(-1)!;
        expect(NodePath.dirname(dir)).toBe(installPathsOf(f.home).versions);
        expect(clone!.env).toMatchObject({ GH_CONFIG_DIR: GH_DIR });
        expect(clone!.args).toEqual(expect.arrayContaining(["credential.helper=!gh auth git-credential"]));
        expect(tagCheck).toMatchObject({ command: "git", args: ["-C", dir, "tag", "--points-at", "HEAD"] });
        expect(npm).toMatchObject({ command: "npm", args: ["ci", "--omit=dev"], cwd: dir });
        expect(npm!.env!["PATH"]!.split(":")[0]).toBe("/opt/node/bin");
        expect(smoke).toMatchObject({
          command: EXEC_PATH,
          args: [NodePath.join(dir, "src", "bin.ts"), "status", "--json"],
          env: { FACTORY_RUNNER_HOME: f.dataDir },
        });
        for (const step of [clone, npm, smoke]) expect(step!.timeoutMs).toBe(TEN_MINUTES);
        // The whole report of a busy data dir, not the default 16 KiB tail.
        expect(smoke!.tailBytes).toBe(16 * 1024 * 1024);
      }),
    );
  });

  it.effect("a failed npm ci removes the clone, warns once, and that tag is not tried again", () => {
    const f = fixture();
    f.answers.refs = ["refs/tags/v0.2.0"];
    f.answers.npm = "fail";
    return withUpdater(f, true, () =>
      Effect.gen(function* () {
        yield* TestClock.adjust(TEN_MINUTES);
        expect(versionDirs(f)).toEqual(["0.1.0"]);
        expect(loud(f)).toHaveLength(1);
        expect(loud(f)[0]!.level).toBe("Warn");
        expect(loud(f)[0]!.text).toContain("npm ci");
        expect(loud(f)[0]!.text).toContain("npm ERR! last line");
        yield* TestClock.adjust(TEN_MINUTES);
        expect(commands(f)).toEqual(["gh", "git", "git", "npm", "gh"]);
        expect(currentTarget(f)).toBe(NodePath.join(installPathsOf(f.home).versions, "0.1.0"));
      }),
    );
  });

  it.effect("a smoke that fails or reports another version removes the clone and is not tried again", () => {
    const f = fixture();
    f.answers.refs = ["refs/tags/v0.2.0", "refs/tags/v0.3.0"];
    f.answers.smoke = "0.2.9";
    return withUpdater(f, true, () =>
      Effect.gen(function* () {
        yield* TestClock.adjust(TEN_MINUTES);
        expect(versionDirs(f)).toEqual(["0.1.0"]);
        expect(loud(f).map((log) => log.level)).toEqual(["Warn"]);
        expect(loud(f)[0]!.text).toContain("v0.3.0");
        expect(loud(f)[0]!.text).toContain("smoke");
        expect(loud(f)[0]!.text).toContain('"version":"0.2.9"');
        f.answers.refs = ["refs/tags/v0.2.0", "refs/tags/v0.3.0", "refs/tags/v0.4.0"];
        f.answers.smoke = "fail";
        yield* TestClock.adjust(TEN_MINUTES);
        expect(versionDirs(f)).toEqual(["0.1.0"]);
        expect(loud(f).map((log) => log.level)).toEqual(["Warn", "Warn"]);
        expect(loud(f)[1]!.text).toContain("Cannot find module 'yaml'");
        yield* TestClock.adjust(TEN_MINUTES);
        expect(commands(f)).toEqual([
          "gh",
          "git",
          "git",
          "npm",
          EXEC_PATH,
          "gh",
          "git",
          "git",
          "npm",
          EXEC_PATH,
          "gh",
        ]);
      }),
    );
  });

  it.effect("a staged update holds exactly the install's entries, moves current, and says so", () => {
    const f = fixture();
    f.answers.refs = ["refs/tags/v0.2.0"];
    return withUpdater(f, true, (update) =>
      Effect.gen(function* () {
        yield* TestClock.adjust(TEN_MINUTES);
        const { versions } = installPathsOf(f.home);
        expect(versionDirs(f)).toEqual(["0.1.0", "0.2.0"]);
        expect(NodeFS.readdirSync(NodePath.join(versions, "0.2.0")).sort()).toEqual([
          "config.example.yml",
          "node_modules",
          "package-lock.json",
          "package.json",
          "scripts",
          "src",
        ]);
        expect(currentTarget(f)).toBe(NodePath.join(versions, "0.2.0"));
        expect(loud(f)).toEqual([
          { level: "Info", text: "update staged: v0.2.0 (running 0.1.0); restarting when no gate runs" },
        ]);
        expect(yield* Deferred.isDone(update.stopped)).toBe(false);
        // Staged once: later periods read nothing more.
        yield* TestClock.adjust(TEN_MINUTES);
        expect(commands(f)).toEqual(["gh", "git", "git", "npm", EXEC_PATH]);
      }),
    );
  });

  it.effect("a clone whose HEAD is not the tag (a branch of the same name) is removed and not tried again", () => {
    const f = fixture();
    f.answers.refs = ["refs/tags/v0.2.0"];
    f.answers.tagAtHead = false;
    return withUpdater(f, true, () =>
      Effect.gen(function* () {
        yield* TestClock.adjust(TEN_MINUTES);
        expect(versionDirs(f)).toEqual(["0.1.0"]);
        expect(loud(f).map((log) => log.level)).toEqual(["Warn"]);
        expect(loud(f)[0]!.text).toContain("not the tag v0.2.0");
        yield* TestClock.adjust(TEN_MINUTES);
        expect(commands(f)).toEqual(["gh", "git", "git", "gh"]);
      }),
    );
  });

  it.effect("a smoke whose report is cut short, or says the machine config does not load, fails", () => {
    const f = fixture();
    f.answers.refs = ["refs/tags/v0.2.0"];
    f.answers.smokeTruncated = true;
    return withUpdater(f, true, () =>
      Effect.gen(function* () {
        yield* TestClock.adjust(TEN_MINUTES);
        expect(loud(f).map((log) => log.level)).toEqual(["Warn"]);
        expect(loud(f)[0]!.text).toContain("longer than");
        f.answers.refs = ["refs/tags/v0.2.0", "refs/tags/v0.3.0"];
        f.answers.smoke = "0.3.0";
        f.answers.smokeTruncated = false;
        f.answers.smokeReason = CONFIG_NOT_LOADED_REASON;
        yield* TestClock.adjust(TEN_MINUTES);
        expect(loud(f).map((log) => log.level)).toEqual(["Warn", "Warn"]);
        expect(loud(f)[1]!.text).toContain("the machine config does not load");
        expect(versionDirs(f)).toEqual(["0.1.0"]);
      }),
    );
  });

  it.effect("removes a clone folder an earlier runner left half done", () => {
    const f = fixture();
    const stale = NodePath.join(installPathsOf(f.home).versions, ".clone-0.2.0-abc123");
    write(NodePath.join(stale, "package.json"), "{}");
    return withUpdater(f, true, () =>
      Effect.gen(function* () {
        expect(versionDirs(f)).toEqual(["0.1.0"]);
      }),
    );
  });

  it.effect("the restart waits while a gate call is in flight with no lock file", () => {
    const f = fixture();
    f.answers.refs = ["refs/tags/v0.2.0"];
    f.answers.gates = 1;
    return withUpdater(f, true, (update) =>
      Effect.gen(function* () {
        yield* TestClock.adjust(TEN_MINUTES);
        yield* update.afterPass;
        expect(yield* Deferred.isDone(update.stopped)).toBe(false);
        f.answers.gates = 0;
        yield* update.afterPass;
        expect(yield* Deferred.isDone(update.stopped)).toBe(true);
      }),
    );
  });

  it.effect("the restart waits while a gate lock is held and fires at the first pass end with none", () => {
    const f = fixture();
    f.answers.refs = ["refs/tags/v0.2.0"];
    const lock = NodePath.join(f.dataDir, "gates", "o~r~1~abc.lock");
    return withUpdater(f, true, (update) =>
      Effect.gen(function* () {
        yield* update.afterPass;
        expect(yield* Deferred.isDone(update.stopped)).toBe(false);
        yield* TestClock.adjust(TEN_MINUTES);
        write(lock, "");
        yield* update.afterPass;
        yield* update.afterPass;
        expect(yield* Deferred.isDone(update.stopped)).toBe(false);
        expect(loud(f).map((log) => log.text)).not.toContain("restarting into v0.2.0");
        NodeFS.rmSync(lock);
        yield* update.afterPass;
        expect(yield* Deferred.isDone(update.stopped)).toBe(true);
        expect(loud(f).at(-1)).toEqual({ level: "Info", text: "restarting into v0.2.0" });
        yield* update.afterPass;
        expect(loud(f).filter((log) => log.text === "restarting into v0.2.0")).toHaveLength(1);
      }),
    );
  });
});
