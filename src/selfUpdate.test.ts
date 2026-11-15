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

import type { NewItem } from "./attention.ts";
import { installPathsOf, UPDATE_PENDING_FILE, UPDATE_REFUSED_FILE } from "./paths.ts";
import { landedPluginPath } from "./plugin.ts";
import { FactoryProcess, type RunInput, type RunResult } from "./process.ts";
import { clearAfterPass, makeSelfUpdate, repositoryOf } from "./selfUpdate.ts";
import { CONFIG_NOT_LOADED_REASON } from "./status.ts";

const EXEC_PATH = "/opt/node/bin/node";
const GH_DIR = "/gh/factory";
const TEN_MINUTES = 10 * 60 * 1000;
const TAG_JQ = '.[] | "\\(.ref) \\(.object.sha) \\(.object.type)"';
const LS_REFS = ["api", "repos/o/r/git/matching-refs/tags/v", "--jq", TAG_JQ];
/** The commit a tag of `version` names; `tagObjectSha` is its annotated tag object. */
const commitSha = (version: string) => `${version.replace(/\./g, "")}c`.padEnd(40, "0");
const tagObjectSha = (version: string) => `${version.replace(/\./g, "")}a`.padEnd(40, "0");
const OTHER_SHA = "f".repeat(40);
/** The version of a `refs/tags/vX.Y.Z`; another ref shape keeps its text as a stand-in. */
const versionOfRef = (ref: string) => ref.replace(/^refs\/tags\/v/, "");

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
  /** The tag refs, or a failed read, a read cut short, or a spawn that throws. */
  refs: ReadonlyArray<string> | "fail" | "too-long" | "throw";
  npm: "ok" | "fail" | "timeout" | "throw";
  /** The version the staged tree's `status --json` reports, or a failed run. */
  smoke: string | "fail";
  /** What else that report says: an idle reason, or output longer than the tail kept. */
  smokeReason: string | null;
  smokeTruncated: boolean;
  /** Whether the clone's HEAD is the tag's commit; false is a moved tag or a branch of its name. */
  tagAtHead: boolean;
  /** Whether each tag ref names its commit or an annotated tag object to peel. */
  tagObject: "commit" | "tag";
  /** What reading an annotated tag object answers. */
  peel: "ok" | "fail" | "garbage";
  /** Gate calls this process is running now. */
  gates: number;
  /** `self_update` of the config loaded now. */
  enabled: boolean;
  /** What `gh api repos/o/r` says the default branch is, or a failed read. */
  defaultBranch: string | "fail";
  /** What GitHub's compare of the tag with the default branch says, or a failed read. */
  compare: string | "fail";
  /** Whether a file of the clone cannot be read, so copying it into `versions/` fails. */
  cloneUnreadable: boolean;
  /** The clone's `factory.minPluginVersion`; null for a package.json with none. */
  minPlugin: string | null;
  /** How `git clone` ends: a clone, an exit 128 with nothing cloned, or a spawn that throws. */
  clone: "ok" | "fail" | "throw";
  /** Whether the clone's commit check (`rev-parse HEAD`) answers. */
  head: "ok" | "fail";
}

interface Fixture {
  readonly home: string;
  readonly dataDir: string;
  readonly packageRoot: string;
  readonly calls: Array<RunInput>;
  readonly answers: Answers;
  readonly logs: Array<{ readonly level: string; readonly text: string }>;
  /** The open attention items, one per id. */
  items: Array<NewItem>;
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
      tagObject: "commit",
      peel: "ok",
      gates: 0,
      enabled: true,
      defaultBranch: "main",
      compare: "ahead",
      cloneUnreadable: false,
      minPlugin: null,
      clone: "ok",
      head: "ok",
    },
    logs: [],
    items: [],
  };
};

/** A clone of the tag: what `git clone` would leave, with entries install does not carry. */
const fakeClone = (dir: string, version: string, minPlugin: string | null) => {
  write(
    NodePath.join(dir, "package.json"),
    JSON.stringify({
      version,
      repository: "github:o/r",
      ...(minPlugin === null ? {} : { factory: { minPluginVersion: minPlugin } }),
    }),
  );
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
          const path = input.args?.[1] ?? "";
          if (path === "repos/o/r") {
            return f.answers.defaultBranch === "fail"
              ? result(1, "", "HTTP 502: Bad Gateway")
              : result(0, `${f.answers.defaultBranch}\n`);
          }
          if (path.includes("/compare/")) {
            return f.answers.compare === "fail"
              ? result(1, "", "HTTP 404: Not Found")
              : result(0, `${f.answers.compare}\n`);
          }
          if (path.includes("/git/tags/")) {
            if (f.answers.peel === "fail") return result(1, "", "HTTP 404: Not Found");
            if (f.answers.peel === "garbage") return result(0, "null\n");
            const version = (f.answers.refs as ReadonlyArray<string>)
              .map(versionOfRef)
              .find((candidate) => tagObjectSha(candidate) === path.slice(path.lastIndexOf("/") + 1))!;
            return result(0, `${commitSha(version)}\n`);
          }
          if (f.answers.refs === "fail") return result(1, "", "HTTP 502: Bad Gateway");
          if (f.answers.refs === "throw") throw new Error("EMFILE: too many open files");
          if (f.answers.refs === "too-long") {
            return { ...result(0, `refs/tags/v0.2.0 ${commitSha("0.2.0")} commit\n`), truncated: true, tailTruncated: true };
          }
          const object = (version: string) =>
            f.answers.tagObject === "tag" ? `${tagObjectSha(version)} tag` : `${commitSha(version)} commit`;
          return result(0, f.answers.refs.map((ref) => `${ref} ${object(versionOfRef(ref))}\n`).join(""));
        }
        if (input.command === "git") {
          const args = input.args ?? [];
          if (args.includes("rev-parse")) {
            if (f.answers.head === "fail") return result(128, "", "fatal: not a git repository");
            const dir = args[args.indexOf("-C") + 1]!;
            const { version } = JSON.parse(NodeFS.readFileSync(NodePath.join(dir, "package.json"), "utf8")) as {
              version: string;
            };
            return result(0, `${f.answers.tagAtHead ? commitSha(version) : OTHER_SHA}\n`);
          }
          if (f.answers.clone === "throw") throw new Error("EMFILE: too many open files");
          if (f.answers.clone === "fail") return result(128, "", "fatal: unable to access 'https://github.com/o/r.git/'");
          const tag = args[args.indexOf("--branch") + 1]!;
          fakeClone(args.at(-1)!, tag.slice(1), f.answers.minPlugin);
          if (f.answers.cloneUnreadable) NodeFS.chmodSync(NodePath.join(args.at(-1)!, "src", "bin.ts"), 0o000);
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

/** The updater over `f`, its loop forked with `enabled` as the config's `self_update` to start; the body runs beside it. */
const withUpdater = <A, E>(
  f: Fixture,
  enabled: boolean,
  body: (update: Effect.Success<ReturnType<typeof makeSelfUpdate>>) => Effect.Effect<A, E>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      f.answers.enabled = enabled;
      const update = yield* makeSelfUpdate({
        home: f.home,
        dataDir: f.dataDir,
        packageRoot: f.packageRoot,
        execPath: EXEC_PATH,
        ghConfigDir: () => GH_DIR,
        gatesRunning: () => f.answers.gates,
        attention: {
          raise: (item) =>
            Effect.sync(() => {
              if (!f.items.some((open) => open.id === item.id)) f.items.push(item);
            }),
          clear: (matches) =>
            Effect.sync(() => {
              f.items = f.items.filter((item) => !matches({ ...item, firstSeenMs: 0 }));
            }),
        },
      });
      yield* Effect.forkScoped(update.run(() => f.answers.enabled), { startImmediately: true });
      return yield* body(update);
    }),
  ).pipe(Effect.provideService(FactoryProcess, fakeProcess(f)), Effect.provide(capture(f)));

const loud = (f: Fixture) => f.logs.filter((log) => log.level !== "Debug" && log.level !== "Trace");
const commands = (f: Fixture) => f.calls.map((call) => call.command);
const versionDirs = (f: Fixture) => NodeFS.readdirSync(installPathsOf(f.home).versions).sort();
const currentTarget = (f: Fixture) => NodeFS.readlinkSync(installPathsOf(f.home).current);
const versionPath = (f: Fixture, version: string) => NodePath.join(installPathsOf(f.home).versions, version);
/** The three `gh` reads of a staging (the tags, the default branch, the compare) and its clone, tag check, install and smoke. */
const STAGING = ["gh", "gh", "gh", "git", "git", "npm", EXEC_PATH];
const OFF_LINE = "self-update off: self_update is false";
const pendingOf = (f: Fixture) => JSON.parse(NodeFS.readFileSync(NodePath.join(f.dataDir, UPDATE_PENDING_FILE), "utf8"));
/** Lands the factory plugin at `version` in the fixture's HOME, as Paradev copies the skill. */
const landPlugin = (f: Fixture, version: string) => write(landedPluginPath(f.home), `${version}\n`);
/** This Mac's fix, as the refusal prints it. */
const FIX = "on this Mac run superset plugins install factory@organization, then restart the Paradev app";
const updateItems = (f: Fixture) => f.items.filter((item) => item.id === "plugin-update-needed");
/** The clone, tag check: the staging stops before npm ci. */
const REFUSED = ["gh", "gh", "gh", "git", "git"];

const writeRefused = (f: Fixture, tag: string) =>
  write(
    NodePath.join(f.dataDir, UPDATE_REFUSED_FILE),
    JSON.stringify({ tag, from: "0.1.0", at: "2026-11-15T08:00:00.000Z" }),
  );

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

  it.effect("does nothing but say so when package.json has no github repository or no X.Y.Z version", () =>
    Effect.gen(function* () {
      const cases = [
        { version: "0.1.0" },
        { version: "0.1.0", repository: { type: "git", url: "https://github.com/o/r.git" } },
        { version: "0.1.0", repository: "https://github.com/o/r" },
        { version: "0.1.0", repository: "o/r" },
        { version: "0.1.0-rc.1", repository: "github:o/r" },
      ];
      for (const manifest of cases) {
        const f = fixture();
        f.answers.refs = ["refs/tags/v0.2.0"];
        write(NodePath.join(f.packageRoot, "package.json"), JSON.stringify(manifest));
        yield* withUpdater(f, true, () =>
          Effect.gen(function* () {
            yield* TestClock.adjust("30 minutes");
            expect(f.calls).toEqual([]);
            expect(loud(f)).toEqual([
              {
                level: "Info",
                text: `self-update off: ${f.packageRoot}/package.json needs a "github:<owner>/<repo>" repository and an X.Y.Z version`,
              },
            ]);
          }),
        );
      }
    }),
  );

  it("reads this package's repository, so the shipped runner updates from its own repo", () => {
    expect(repositoryOf(NodePath.resolve(import.meta.dirname, ".."))).toEqual({
      owner: "original-solutions",
      repo: "factory-on-paradev",
    });
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
    return withUpdater(f, true, (update) =>
      Effect.gen(function* () {
        yield* TestClock.adjust(TEN_MINUTES);
        const clone = f.calls[3]!;
        expect(clone.command).toBe("git");
        expect(clone.args).toEqual(
          expect.arrayContaining(["clone", "--depth", "1", "--branch", "v0.10.0", "https://github.com/o/r.git"]),
        );
        expect(versionDirs(f)).toEqual(["0.1.0", "0.10.0"]);
        expect(currentTarget(f)).toBe(versionPath(f, "0.1.0"));
        yield* update.afterPass;
        expect(currentTarget(f)).toBe(versionPath(f, "0.10.0"));
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
        expect(commands(f)).toEqual(["gh", ...STAGING]);
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

  it.effect("a tag read that throws is one warning, and the next period reads again", () => {
    const f = fixture();
    f.answers.refs = "throw";
    return withUpdater(f, true, () =>
      Effect.gen(function* () {
        yield* TestClock.adjust(TEN_MINUTES);
        expect(commands(f)).toEqual(["gh"]);
        expect(loud(f)).toHaveLength(1);
        expect(loud(f)[0]!.level).toBe("Warn");
        expect(loud(f)[0]!.text).toContain("self-update check failed");
        expect(loud(f)[0]!.text).toContain("EMFILE");
        f.answers.refs = ["refs/tags/v0.2.0"];
        yield* TestClock.adjust(TEN_MINUTES);
        expect(commands(f)).toEqual(["gh", ...STAGING]);
        expect(versionDirs(f)).toEqual(["0.1.0", "0.2.0"]);
      }),
    );
  });

  it.effect("a step that throws is a failed step: one warning, the clone removed, the tag not tried again", () => {
    const f = fixture();
    f.answers.refs = ["refs/tags/v0.2.0"];
    f.answers.npm = "throw";
    return withUpdater(f, true, () =>
      Effect.gen(function* () {
        yield* TestClock.adjust(TEN_MINUTES);
        expect(loud(f).map((log) => log.level)).toEqual(["Warn"]);
        expect(loud(f)[0]!.text).toContain("update v0.2.0 not staged");
        expect(loud(f)[0]!.text).toContain("EMFILE");
        expect(versionDirs(f)).toEqual(["0.1.0"]);
        yield* TestClock.adjust(TEN_MINUTES);
        expect(commands(f)).toEqual(["gh", "gh", "gh", "git", "git", "npm", "gh"]);
        expect(versionDirs(f)).toEqual(["0.1.0"]);
        expect(loud(f)).toHaveLength(1);
      }),
    );
  });

  it.effect("clones with the gh login, installs with this node first on PATH, and smokes the tree", () => {
    const f = fixture();
    f.answers.refs = ["refs/tags/v0.2.0"];
    return withUpdater(f, true, () =>
      Effect.gen(function* () {
        yield* TestClock.adjust(TEN_MINUTES);
        const [, branch, compared, clone, tagCheck, npm, smoke] = f.calls;
        for (const read of [branch, compared]) {
          expect(read).toMatchObject({ command: "gh", env: { GH_CONFIG_DIR: GH_DIR }, timeoutMs: 60_000 });
        }
        expect(branch!.args).toEqual(["api", "repos/o/r", "--jq", ".default_branch"]);
        expect(compared!.args).toEqual(["api", `repos/o/r/compare/${commitSha("0.2.0")}...main`, "--jq", ".status"]);
        const dir = clone!.args!.at(-1)!;
        expect(NodePath.dirname(dir)).toBe(installPathsOf(f.home).versions);
        expect(clone!.env).toMatchObject({ GH_CONFIG_DIR: GH_DIR });
        expect(clone!.args).toEqual(expect.arrayContaining(["credential.helper=!gh auth git-credential"]));
        expect(tagCheck).toMatchObject({ command: "git", args: ["-C", dir, "rev-parse", "HEAD"] });
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
        expect(commands(f)).toEqual(["gh", "gh", "gh", "git", "git", "npm", "gh"]);
        expect(currentTarget(f)).toBe(versionPath(f, "0.1.0"));
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
        expect(commands(f)).toEqual([...STAGING, ...STAGING, "gh"]);
      }),
    );
  });

  it.effect("a staged update holds exactly the install's entries and says so; current moves at the restart", () => {
    const f = fixture();
    f.answers.refs = ["refs/tags/v0.2.0"];
    return withUpdater(f, true, (update) =>
      Effect.gen(function* () {
        expect(update.staged()).toBe(false);
        yield* TestClock.adjust(TEN_MINUTES);
        const { versions } = installPathsOf(f.home);
        expect(update.staged()).toBe(true);
        expect(versionDirs(f)).toEqual(["0.1.0", "0.2.0"]);
        expect(NodeFS.readdirSync(NodePath.join(versions, "0.2.0")).sort()).toEqual([
          "config.example.yml",
          "node_modules",
          "package-lock.json",
          "package.json",
          "scripts",
          "src",
        ]);
        // The running version stays what `current` names until the restart.
        expect(currentTarget(f)).toBe(NodePath.join(versions, "0.1.0"));
        expect(loud(f)).toEqual([
          { level: "Info", text: "update staged: v0.2.0 (running 0.1.0); restarting when no gate runs" },
        ]);
        expect(yield* Deferred.isDone(update.stopped)).toBe(false);
        // Staged once: later periods read nothing more.
        yield* TestClock.adjust(TEN_MINUTES);
        expect(commands(f)).toEqual(STAGING);
        yield* update.afterPass;
        expect(currentTarget(f)).toBe(NodePath.join(versions, "0.2.0"));
        expect(loud(f).at(-1)).toEqual({ level: "Info", text: "restarting into v0.2.0" });
        expect(yield* Deferred.isDone(update.stopped)).toBe(true);
      }),
    );
  });

  it.effect("a clone whose HEAD is not the checked commit (a moved tag, a branch of its name) is removed and not tried again", () => {
    const f = fixture();
    f.answers.refs = ["refs/tags/v0.2.0"];
    f.answers.tagAtHead = false;
    return withUpdater(f, true, () =>
      Effect.gen(function* () {
        yield* TestClock.adjust(TEN_MINUTES);
        expect(versionDirs(f)).toEqual(["0.1.0"]);
        expect(loud(f).map((log) => log.level)).toEqual(["Warn"]);
        expect(loud(f)[0]!.text).toContain(`the clone's HEAD ${OTHER_SHA} is not the checked commit ${commitSha("0.2.0")} of v0.2.0`);
        yield* TestClock.adjust(TEN_MINUTES);
        expect(commands(f)).toEqual(["gh", "gh", "gh", "git", "git", "gh"]);
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

  it.effect("a tag that needs a newer plugin than this Mac's is not staged, raises one item, and is staged once the plugin is new enough", () => {
    const f = fixture();
    f.answers.refs = ["refs/tags/v0.2.0"];
    f.answers.minPlugin = "0.2.0";
    landPlugin(f, "0.1.9");
    const line = `update v0.2.0 not staged: it needs the factory plugin 0.2.0 or newer, and this Mac has 0.1.9; ${FIX}; the runner stays on 0.1.0 and tries again every 10 minutes`;
    return withUpdater(f, true, (update) =>
      Effect.gen(function* () {
        yield* TestClock.adjust(TEN_MINUTES);
        // Stopped after the commit check, before npm ci: the clone is gone and current stays.
        expect(commands(f)).toEqual(REFUSED);
        expect(versionDirs(f)).toEqual(["0.1.0"]);
        expect(currentTarget(f)).toBe(versionPath(f, "0.1.0"));
        expect(update.staged()).toBe(false);
        expect(loud(f)).toEqual([{ level: "Warn", text: line }]);
        expect(updateItems(f)).toEqual([
          { id: "plugin-update-needed", kind: "attention", repo: null, issue: null, run: null, message: line },
        ]);
        // The tag is not marked: the next check tries it again, and says nothing new.
        yield* TestClock.adjust(TEN_MINUTES);
        expect(commands(f)).toEqual([...REFUSED, ...REFUSED]);
        expect(loud(f)).toHaveLength(1);
        expect(updateItems(f)).toHaveLength(1);
        // A person updates the plugin: the next check stages the tag and the item goes.
        landPlugin(f, "0.2.0");
        yield* TestClock.adjust(TEN_MINUTES);
        expect(commands(f)).toEqual([...REFUSED, ...REFUSED, ...STAGING]);
        expect(versionDirs(f)).toEqual(["0.1.0", "0.2.0"]);
        expect(updateItems(f)).toEqual([]);
        yield* update.afterPass;
        expect(currentTarget(f)).toBe(versionPath(f, "0.2.0"));
      }),
    );
  });

  it.effect("a failed read of this Mac's plugin or the tag's minimum skips the stage the same way, and says what the read said", () => {
    const f = fixture();
    f.answers.refs = ["refs/tags/v0.2.0"];
    f.answers.minPlugin = "0.2.0";
    const missing = `update v0.2.0 not staged: it needs the factory plugin 0.2.0 or newer, and the factory plugin is not on this Mac: ${landedPluginPath(f.home)} is missing; ${FIX}; the runner stays on 0.1.0 and tries again every 10 minutes`;
    const garbled = `update v0.2.0 not staged: its package.json has factory.minPluginVersion "two", not a version; ${FIX}; the runner stays on 0.1.0 and tries again every 10 minutes`;
    return withUpdater(f, true, () =>
      Effect.gen(function* () {
        yield* TestClock.adjust(TEN_MINUTES);
        expect(commands(f)).toEqual(REFUSED);
        expect(versionDirs(f)).toEqual(["0.1.0"]);
        expect(loud(f)).toEqual([{ level: "Warn", text: missing }]);
        expect(updateItems(f).map((item) => item.message)).toEqual([missing]);
        // Another reason for the same tag is a new line, and replaces the item.
        landPlugin(f, "0.2.0");
        f.answers.minPlugin = "two";
        yield* TestClock.adjust(TEN_MINUTES);
        expect(commands(f)).toEqual([...REFUSED, ...REFUSED]);
        expect(versionDirs(f)).toEqual(["0.1.0"]);
        expect(loud(f).map((log) => log.text)).toEqual([missing, garbled]);
        expect(updateItems(f).map((item) => item.message)).toEqual([garbled]);
      }),
    );
  });

  it.effect("a tag that needs no newer plugin than this Mac's is staged as before, compared as three numbers", () => {
    const f = fixture();
    f.answers.refs = ["refs/tags/v0.2.0"];
    // As text 0.1.10 sorts below 0.1.9.
    f.answers.minPlugin = "0.1.9";
    landPlugin(f, "0.1.10");
    return withUpdater(f, true, () =>
      Effect.gen(function* () {
        yield* TestClock.adjust(TEN_MINUTES);
        expect(commands(f)).toEqual(STAGING);
        expect(versionDirs(f)).toEqual(["0.1.0", "0.2.0"]);
        expect(f.items).toEqual([]);
      }),
    );
  });

  it.effect("a tag whose package.json has no factory.minPluginVersion is staged as today, with no plugin on this Mac", () => {
    const f = fixture();
    f.answers.refs = ["refs/tags/v0.2.0"];
    f.answers.minPlugin = null;
    return withUpdater(f, true, () =>
      Effect.gen(function* () {
        yield* TestClock.adjust(TEN_MINUTES);
        expect(NodeFS.existsSync(landedPluginPath(f.home))).toBe(false);
        expect(commands(f)).toEqual(STAGING);
        expect(versionDirs(f)).toEqual(["0.1.0", "0.2.0"]);
        expect(f.items).toEqual([]);
      }),
    );
  });

  it.effect("the item goes once the tag passes the plugin step, and does not come back when npm ci then fails", () => {
    const f = fixture();
    f.answers.refs = ["refs/tags/v0.2.0"];
    f.answers.minPlugin = "0.2.0";
    landPlugin(f, "0.1.0");
    return withUpdater(f, true, () =>
      Effect.gen(function* () {
        yield* TestClock.adjust(TEN_MINUTES);
        expect(updateItems(f)).toHaveLength(1);
        landPlugin(f, "0.2.0");
        f.answers.npm = "fail";
        yield* TestClock.adjust(TEN_MINUTES);
        expect(commands(f)).toEqual([...REFUSED, ...REFUSED, "npm"]);
        expect(updateItems(f)).toEqual([]);
        expect(loud(f).at(-1)!.text).toContain("npm ci");
        // A failed npm ci marks the tag as before: it is not tried again, and the item stays gone.
        yield* TestClock.adjust(TEN_MINUTES);
        expect(commands(f)).toEqual([...REFUSED, ...REFUSED, "npm", "gh"]);
        expect(updateItems(f)).toEqual([]);
      }),
    );
  });

  it.effect("a held tag that then fails a step before the plugin step is not marked, and is tried again", () => {
    const f = fixture();
    f.answers.refs = ["refs/tags/v0.2.0"];
    f.answers.minPlugin = "0.2.0";
    landPlugin(f, "0.1.0");
    return withUpdater(f, true, () =>
      Effect.gen(function* () {
        yield* TestClock.adjust(TEN_MINUTES);
        expect(commands(f)).toEqual(REFUSED);
        f.answers.compare = "fail";
        yield* TestClock.adjust(TEN_MINUTES);
        expect(commands(f)).toEqual([...REFUSED, "gh", "gh", "gh"]);
        expect(loud(f).at(-1)!.text).toContain("HTTP 404: Not Found");
        // Still held: the item stays, and the next period tries the tag again with no new line.
        expect(updateItems(f)).toHaveLength(1);
        const lines = loud(f).length;
        yield* TestClock.adjust(TEN_MINUTES);
        expect(commands(f)).toEqual([...REFUSED, "gh", "gh", "gh", "gh", "gh", "gh"]);
        expect(loud(f)).toHaveLength(lines);
        f.answers.compare = "ahead";
        landPlugin(f, "0.2.0");
        yield* TestClock.adjust(TEN_MINUTES);
        expect(commands(f)).toEqual([...REFUSED, "gh", "gh", "gh", "gh", "gh", "gh", ...STAGING]);
        expect(versionDirs(f)).toEqual(["0.1.0", "0.2.0"]);
        expect(updateItems(f)).toEqual([]);
      }),
    );
  });

  describe("a held tag waits through every read that did not answer, and is tried again", () => {
    const reads: ReadonlyArray<readonly [string, (a: Answers) => void, (a: Answers) => void]> = [
      ["the tag object read", (a) => void (a.peel = "fail"), (a) => void (a.peel = "ok")],
      ["the default branch read", (a) => void (a.defaultBranch = "fail"), (a) => void (a.defaultBranch = "main")],
      ["the compare", (a) => void (a.compare = "fail"), (a) => void (a.compare = "ahead")],
      ["the clone", (a) => void (a.clone = "fail"), (a) => void (a.clone = "ok")],
      ["a clone whose spawn throws", (a) => void (a.clone = "throw"), (a) => void (a.clone = "ok")],
      ["the commit check", (a) => void (a.head = "fail"), (a) => void (a.head = "ok")],
    ];
    for (const [name, breakIt, mendIt] of reads) {
      it.effect(name, () => {
        const f = fixture();
        f.answers.refs = ["refs/tags/v0.2.0"];
        f.answers.tagObject = "tag";
        f.answers.minPlugin = "0.2.0";
        landPlugin(f, "0.1.0");
        return withUpdater(f, true, () =>
          Effect.gen(function* () {
            yield* TestClock.adjust(TEN_MINUTES);
            expect(updateItems(f)).toHaveLength(1);
            breakIt(f.answers);
            yield* TestClock.adjust(TEN_MINUTES);
            expect(versionDirs(f)).toEqual(["0.1.0"]);
            expect(updateItems(f)).toHaveLength(1);
            mendIt(f.answers);
            landPlugin(f, "0.2.0");
            yield* TestClock.adjust(TEN_MINUTES);
            expect(versionDirs(f)).toEqual(["0.1.0", "0.2.0"]);
            expect(updateItems(f)).toEqual([]);
          }),
        );
      });
    }
  });

  describe("a held tag that fails a check, not a read, is marked like any other, and its item goes", () => {
    const checks: ReadonlyArray<readonly [string, (a: Answers) => void, string]> = [
      ["a clone that is not the checked commit", (a) => void (a.tagAtHead = false), "is not the checked commit"],
      ["a tag object that names no commit", (a) => void (a.peel = "garbage"), "names no commit"],
    ];
    for (const [name, breakIt, said] of checks) {
      it.effect(name, () => {
        const f = fixture();
        f.answers.refs = ["refs/tags/v0.2.0"];
        f.answers.tagObject = "tag";
        f.answers.minPlugin = "0.2.0";
        landPlugin(f, "0.1.0");
        return withUpdater(f, true, () =>
          Effect.gen(function* () {
            yield* TestClock.adjust(TEN_MINUTES);
            expect(updateItems(f)).toHaveLength(1);
            breakIt(f.answers);
            yield* TestClock.adjust(TEN_MINUTES);
            expect(loud(f).at(-1)!.text).toContain(said);
            expect(updateItems(f)).toEqual([]);
            // Marked: the next period reads the tags and nothing else.
            const before = f.calls.length;
            yield* TestClock.adjust(TEN_MINUTES);
            expect(commands(f).slice(before)).toEqual(["gh"]);
          }),
        );
      });
    }
  });

  it.effect("an item an earlier start left goes when the highest tag is the refused one", () => {
    const f = fixture();
    f.answers.refs = ["refs/tags/v0.2.0"];
    writeRefused(f, "v0.2.0");
    f.items.push({ id: "plugin-update-needed", kind: "attention", repo: null, issue: null, run: null, message: "update v0.2.0 not staged: ..." });
    return withUpdater(f, true, () =>
      Effect.gen(function* () {
        yield* TestClock.adjust(TEN_MINUTES);
        expect(commands(f)).toEqual(["gh"]);
        expect(updateItems(f)).toEqual([]);
      }),
    );
  });

  it.effect("a held tag found not on the default branch is marked like any other, and its item goes", () => {
    const f = fixture();
    f.answers.refs = ["refs/tags/v0.2.0"];
    f.answers.minPlugin = "0.2.0";
    landPlugin(f, "0.1.0");
    return withUpdater(f, true, () =>
      Effect.gen(function* () {
        yield* TestClock.adjust(TEN_MINUTES);
        expect(updateItems(f)).toHaveLength(1);
        f.answers.compare = "diverged";
        yield* TestClock.adjust(TEN_MINUTES);
        expect(loud(f).at(-1)!.text).toContain("is not on main");
        expect(updateItems(f)).toEqual([]);
        // Marked: not tried again until a restart.
        yield* TestClock.adjust(TEN_MINUTES);
        expect(commands(f)).toEqual([...REFUSED, "gh", "gh", "gh", "gh"]);
      }),
    );
  });

  it.effect("a newer tag that fails before its plugin step takes the held tag's item with it", () => {
    const f = fixture();
    f.answers.refs = ["refs/tags/v0.2.0"];
    f.answers.minPlugin = "0.2.0";
    landPlugin(f, "0.1.0");
    return withUpdater(f, true, () =>
      Effect.gen(function* () {
        yield* TestClock.adjust(TEN_MINUTES);
        expect(updateItems(f)).toHaveLength(1);
        // v0.3.0 is now the highest tag, and its compare fails: it is marked, and v0.2.0 is no longer tried.
        f.answers.refs = ["refs/tags/v0.2.0", "refs/tags/v0.3.0"];
        f.answers.compare = "fail";
        yield* TestClock.adjust(TEN_MINUTES);
        expect(updateItems(f)).toEqual([]);
        yield* TestClock.adjust(TEN_MINUTES);
        expect(commands(f)).toEqual([...REFUSED, "gh", "gh", "gh", "gh"]);
        expect(updateItems(f)).toEqual([]);
      }),
    );
  });

  it.effect("the item goes when no tag is newer than the running version any more", () => {
    const f = fixture();
    f.answers.refs = ["refs/tags/v0.2.0"];
    f.answers.minPlugin = "0.2.0";
    landPlugin(f, "0.1.0");
    return withUpdater(f, true, () =>
      Effect.gen(function* () {
        yield* TestClock.adjust(TEN_MINUTES);
        expect(updateItems(f)).toHaveLength(1);
        // The tag was deleted, or this version was installed another way.
        f.answers.refs = ["refs/tags/v0.1.0"];
        yield* TestClock.adjust(TEN_MINUTES);
        expect(updateItems(f)).toEqual([]);
      }),
    );
  });

  it.effect("the item goes when self_update is turned off: no tag is tried again", () => {
    const f = fixture();
    f.answers.refs = ["refs/tags/v0.2.0"];
    f.answers.minPlugin = "0.2.0";
    landPlugin(f, "0.1.0");
    return withUpdater(f, true, () =>
      Effect.gen(function* () {
        yield* TestClock.adjust(TEN_MINUTES);
        expect(updateItems(f)).toHaveLength(1);
        f.answers.enabled = false;
        yield* TestClock.adjust(TEN_MINUTES);
        expect(commands(f)).toEqual(REFUSED);
        expect(updateItems(f)).toEqual([]);
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
        expect(currentTarget(f)).toBe(versionPath(f, "0.1.0"));
        f.answers.gates = 0;
        yield* update.afterPass;
        expect(yield* Deferred.isDone(update.stopped)).toBe(true);
        expect(currentTarget(f)).toBe(versionPath(f, "0.2.0"));
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

  it.effect("a tag that is not on the default branch is one warning, never cloned, and not tried again", () => {
    const f = fixture();
    f.answers.refs = ["refs/tags/v0.2.0"];
    f.answers.compare = "diverged";
    return withUpdater(f, true, () =>
      Effect.gen(function* () {
        yield* TestClock.adjust(TEN_MINUTES);
        expect(commands(f)).toEqual(["gh", "gh", "gh"]);
        expect(f.calls[2]!.args).toEqual(["api", `repos/o/r/compare/${commitSha("0.2.0")}...main`, "--jq", ".status"]);
        expect(loud(f)).toEqual([
          {
            level: "Warn",
            text: `update v0.2.0 not staged: v0.2.0 (${commitSha("0.2.0")}) is not on main: GitHub compares them as diverged`,
          },
        ]);
        expect(versionDirs(f)).toEqual(["0.1.0"]);
        yield* TestClock.adjust(TEN_MINUTES);
        expect(commands(f)).toEqual(["gh", "gh", "gh", "gh"]);
        // A tag ahead of the branch is not on it either; a tag the branch is ahead of is.
        f.answers.refs = ["refs/tags/v0.3.0"];
        f.answers.compare = "behind";
        yield* TestClock.adjust(TEN_MINUTES);
        expect(loud(f)).toHaveLength(2);
        expect(loud(f)[1]!.text).toContain(`v0.3.0 (${commitSha("0.3.0")}) is not on main: GitHub compares them as behind`);
        f.answers.refs = ["refs/tags/v0.4.0"];
        f.answers.defaultBranch = "trunk";
        f.answers.compare = "identical";
        f.answers.smoke = "0.4.0";
        yield* TestClock.adjust(TEN_MINUTES);
        expect(f.calls.at(-5)!.args).toEqual(["api", `repos/o/r/compare/${commitSha("0.4.0")}...trunk`, "--jq", ".status"]);
        expect(versionDirs(f)).toEqual(["0.1.0", "0.4.0"]);
      }),
    );
  });

  it.effect("a default branch or compare read that fails is one warning, and that tag is not tried again", () => {
    const f = fixture();
    f.answers.refs = ["refs/tags/v0.2.0"];
    f.answers.defaultBranch = "fail";
    return withUpdater(f, true, () =>
      Effect.gen(function* () {
        yield* TestClock.adjust(TEN_MINUTES);
        expect(commands(f)).toEqual(["gh", "gh"]);
        expect(loud(f).map((log) => log.level)).toEqual(["Warn"]);
        expect(loud(f)[0]!.text).toContain("default branch read exited 1");
        f.answers.refs = ["refs/tags/v0.3.0"];
        f.answers.defaultBranch = "main";
        f.answers.compare = "fail";
        yield* TestClock.adjust(TEN_MINUTES);
        expect(commands(f)).toEqual(["gh", "gh", "gh", "gh", "gh"]);
        expect(loud(f)).toHaveLength(2);
        expect(loud(f)[1]!.text).toContain("branch check exited 1");
        expect(loud(f)[1]!.text).toContain("HTTP 404");
        yield* TestClock.adjust(TEN_MINUTES);
        expect(commands(f)).toEqual(["gh", "gh", "gh", "gh", "gh", "gh"]);
      }),
    );
  });

  it.effect("a smoke whose report is idle for any reason fails: the new tree must see this runner and its config", () => {
    const f = fixture();
    f.answers.refs = ["refs/tags/v0.2.0"];
    f.answers.smokeReason = "the runner is not running";
    return withUpdater(f, true, () =>
      Effect.gen(function* () {
        yield* TestClock.adjust(TEN_MINUTES);
        expect(loud(f).map((log) => log.level)).toEqual(["Warn"]);
        expect(loud(f)[0]!.text).toContain("says the runner is idle (the runner is not running) under v0.2.0");
        f.answers.refs = ["refs/tags/v0.3.0"];
        f.answers.smoke = "0.3.0";
        f.answers.smokeReason = "no factory config";
        yield* TestClock.adjust(TEN_MINUTES);
        expect(loud(f).map((log) => log.level)).toEqual(["Warn", "Warn"]);
        expect(loud(f)[1]!.text).toContain("(no factory config)");
        expect(versionDirs(f)).toEqual(["0.1.0"]);
        expect(currentTarget(f)).toBe(versionPath(f, "0.1.0"));
      }),
    );
  });

  it.effect("self_update is read from the config loaded now: off holds the reads and the restart, on resumes them", () => {
    const f = fixture();
    f.answers.refs = ["refs/tags/v0.2.0"];
    return withUpdater(f, false, (update) =>
      Effect.gen(function* () {
        yield* TestClock.adjust(TEN_MINUTES);
        expect(f.calls).toEqual([]);
        expect(loud(f)).toEqual([{ level: "Info", text: OFF_LINE }]);
        // The key is now on (a reload, which no production path triggers yet, or a restart): the
        // next period reads the tags and stages.
        f.answers.enabled = true;
        yield* TestClock.adjust(TEN_MINUTES);
        expect(commands(f)).toEqual(STAGING);
        expect(update.staged()).toBe(true);
        // The key is off again: the staged update does not restart the runner, said once.
        f.answers.enabled = false;
        yield* update.afterPass;
        yield* update.afterPass;
        expect(yield* Deferred.isDone(update.stopped)).toBe(false);
        expect(currentTarget(f)).toBe(versionPath(f, "0.1.0"));
        expect(loud(f).filter((log) => log.text === OFF_LINE)).toHaveLength(2);
        // With the key off the restart cannot fire, so gates must start again: nothing is staged to them.
        expect(update.staged()).toBe(false);
        yield* TestClock.adjust(TEN_MINUTES);
        expect(commands(f)).toEqual(STAGING);
        // On again: the restart fires at the next pass end.
        f.answers.enabled = true;
        expect(update.staged()).toBe(true);
        yield* update.afterPass;
        expect(yield* Deferred.isDone(update.stopped)).toBe(true);
        expect(currentTarget(f)).toBe(versionPath(f, "0.2.0"));
      }),
    );
  });

  it.effect("a placement that fails removes the half-made copy and the clone, keeps current, and does not restart", () => {
    const f = fixture();
    f.answers.refs = ["refs/tags/v0.2.0"];
    // A folder already at versions/0.2.0 that cannot be emptied: the rename over it fails.
    const taken = versionPath(f, "0.2.0");
    write(NodePath.join(taken, "keep"), "");
    NodeFS.chmodSync(taken, 0o500);
    return withUpdater(f, true, (update) =>
      Effect.gen(function* () {
        try {
          yield* TestClock.adjust(TEN_MINUTES);
          expect(loud(f).map((log) => log.level)).toEqual(["Warn"]);
          expect(loud(f)[0]!.text).toContain("update v0.2.0 not staged: placing it failed");
          expect(versionDirs(f)).toEqual(["0.1.0", "0.2.0"]);
          expect(currentTarget(f)).toBe(versionPath(f, "0.1.0"));
          expect(update.staged()).toBe(false);
          yield* update.afterPass;
          expect(yield* Deferred.isDone(update.stopped)).toBe(false);
          yield* TestClock.adjust(TEN_MINUTES);
          expect(commands(f)).toEqual([...STAGING, "gh"]);
        } finally {
          NodeFS.chmodSync(taken, 0o755);
        }
      }),
    );
  });

  it.effect("a copy that fails part way leaves no temp folder beside the versions", () => {
    const f = fixture();
    f.answers.refs = ["refs/tags/v0.2.0"];
    f.answers.cloneUnreadable = true;
    return withUpdater(f, true, (update) =>
      Effect.gen(function* () {
        yield* TestClock.adjust(TEN_MINUTES);
        expect(loud(f).map((log) => log.level)).toEqual(["Warn"]);
        expect(loud(f)[0]!.text).toContain("placing it failed");
        expect(loud(f)[0]!.text).toContain("EACCES");
        expect(versionDirs(f)).toEqual(["0.1.0"]);
        expect(currentTarget(f)).toBe(versionPath(f, "0.1.0"));
        expect(update.staged()).toBe(false);
      }),
    );
  });

  it.effect("a restart whose current link cannot be replaced is one warning, no restart, and the reads go on", () => {
    const f = fixture();
    f.answers.refs = ["refs/tags/v0.2.0"];
    const linkDir = NodePath.dirname(installPathsOf(f.home).current);
    return withUpdater(f, true, (update) =>
      Effect.gen(function* () {
        yield* TestClock.adjust(TEN_MINUTES);
        expect(update.staged()).toBe(true);
        NodeFS.chmodSync(linkDir, 0o500);
        try {
          yield* update.afterPass;
        } finally {
          NodeFS.chmodSync(linkDir, 0o755);
        }
        expect(yield* Deferred.isDone(update.stopped)).toBe(false);
        expect(currentTarget(f)).toBe(versionPath(f, "0.1.0"));
        expect(update.staged()).toBe(false);
        expect(loud(f).at(-1)!.level).toBe("Warn");
        expect(loud(f).at(-1)!.text).toContain("update v0.2.0 not placed");
        // The placed tree stays, the tag is marked, and the next period reads the tags again.
        expect(versionDirs(f)).toEqual(["0.1.0", "0.2.0"]);
        // No start runs v0.2.0, so nothing is left to count one.
        expect(NodeFS.existsSync(NodePath.join(f.dataDir, UPDATE_PENDING_FILE))).toBe(false);
        yield* TestClock.adjust(TEN_MINUTES);
        expect(commands(f)).toEqual([...STAGING, "gh"]);
        yield* update.afterPass;
        expect(yield* Deferred.isDone(update.stopped)).toBe(false);
      }),
    );
  });

  it.effect("the restart writes the pending start count just before current moves, and that afterPass leaves it", () => {
    const f = fixture();
    f.answers.refs = ["refs/tags/v0.2.0"];
    return withUpdater(f, true, (update) =>
      Effect.gen(function* () {
        yield* TestClock.adjust(TEN_MINUTES);
        // Not before the restart: a staged update writes nothing to the data dir.
        expect(NodeFS.existsSync(NodePath.join(f.dataDir, UPDATE_PENDING_FILE))).toBe(false);
        yield* update.afterPass;
        expect(currentTarget(f)).toBe(versionPath(f, "0.2.0"));
        expect(pendingOf(f)).toEqual({ from: "0.1.0", to: "0.2.0", starts: 0 });
        expect(yield* Deferred.isDone(update.stopped)).toBe(true);
      }),
    );
  });

  it.effect("a pending start count that cannot be written is one warning, and the restart goes ahead", () => {
    const f = fixture();
    f.answers.refs = ["refs/tags/v0.2.0"];
    // A folder where the file goes: the write's rename over it fails.
    NodeFS.mkdirSync(NodePath.join(f.dataDir, UPDATE_PENDING_FILE), { recursive: true });
    return withUpdater(f, true, (update) =>
      Effect.gen(function* () {
        yield* TestClock.adjust(TEN_MINUTES);
        yield* update.afterPass;
        const warnings = loud(f).filter((log) => log.level === "Warn");
        expect(warnings).toHaveLength(1);
        expect(warnings[0]!.text).toContain("update v0.2.0: the pending start count was not written");
        expect(currentTarget(f)).toBe(versionPath(f, "0.2.0"));
        expect(loud(f).at(-1)).toEqual({ level: "Info", text: "restarting into v0.2.0" });
        expect(yield* Deferred.isDone(update.stopped)).toBe(true);
      }),
    );
  });

  it.effect("the highest tag refused stages nothing, and no lower tag above the running version either", () => {
    const f = fixture();
    f.answers.refs = ["refs/tags/v0.1.5", "refs/tags/v0.2.0"];
    writeRefused(f, "v0.2.0");
    return withUpdater(f, true, (update) =>
      Effect.gen(function* () {
        yield* TestClock.adjust(TEN_MINUTES);
        yield* TestClock.adjust(TEN_MINUTES);
        expect(commands(f)).toEqual(["gh", "gh"]);
        expect(update.staged()).toBe(false);
        expect(loud(f)).toEqual([]);
      }),
    );
  });

  it.effect("a tag above the refused one is staged as usual, compared by number: v0.10.0 is above v0.9.0", () => {
    const f = fixture();
    f.answers.refs = ["refs/tags/v0.9.0", "refs/tags/v0.10.0"];
    f.answers.smoke = "0.10.0";
    writeRefused(f, "v0.9.0");
    return withUpdater(f, true, (update) =>
      Effect.gen(function* () {
        yield* TestClock.adjust(TEN_MINUTES);
        expect(update.staged()).toBe(true);
        expect(versionDirs(f)).toEqual(["0.1.0", "0.10.0"]);
      }),
    );
  });

  it.effect("a refused file that cannot be read is one warning, and nothing is staged", () => {
    const f = fixture();
    f.answers.refs = ["refs/tags/v0.2.0"];
    write(NodePath.join(f.dataDir, UPDATE_REFUSED_FILE), "{not json");
    return withUpdater(f, true, (update) =>
      Effect.gen(function* () {
        yield* TestClock.adjust(TEN_MINUTES);
        expect(commands(f)).toEqual(["gh"]);
        expect(update.staged()).toBe(false);
        expect(loud(f)).toHaveLength(1);
        expect(loud(f)[0]!.level).toBe("Warn");
        expect(loud(f)[0]!.text).toContain(`self-update stages nothing: ${UPDATE_REFUSED_FILE} could not be read`);
      }),
    );
  });

  it.effect("an annotated tag is peeled to its commit, which the compare and the clone check use", () => {
    const f = fixture();
    f.answers.refs = ["refs/tags/v0.2.0"];
    f.answers.tagObject = "tag";
    return withUpdater(f, true, () =>
      Effect.gen(function* () {
        yield* TestClock.adjust(TEN_MINUTES);
        expect(commands(f)).toEqual(["gh", "gh", "gh", "gh", "git", "git", "npm", EXEC_PATH]);
        expect(f.calls[1]).toMatchObject({
          command: "gh",
          args: ["api", `repos/o/r/git/tags/${tagObjectSha("0.2.0")}`, "--jq", ".object.sha"],
          env: { GH_CONFIG_DIR: GH_DIR },
          timeoutMs: 60_000,
        });
        expect(f.calls[3]!.args).toEqual(["api", `repos/o/r/compare/${commitSha("0.2.0")}...main`, "--jq", ".status"]);
        expect(versionDirs(f)).toEqual(["0.1.0", "0.2.0"]);
        expect(loud(f).map((log) => log.level)).toEqual(["Info"]);
      }),
    );
  });

  it.effect("an annotated tag whose object cannot be read, or names no commit, is one warning and not tried again", () => {
    const f = fixture();
    f.answers.refs = ["refs/tags/v0.2.0"];
    f.answers.tagObject = "tag";
    f.answers.peel = "fail";
    return withUpdater(f, true, () =>
      Effect.gen(function* () {
        yield* TestClock.adjust(TEN_MINUTES);
        expect(commands(f)).toEqual(["gh", "gh"]);
        expect(loud(f).map((log) => log.level)).toEqual(["Warn"]);
        expect(loud(f)[0]!.text).toContain("tag read exited 1");
        f.answers.refs = ["refs/tags/v0.3.0"];
        f.answers.peel = "garbage";
        yield* TestClock.adjust(TEN_MINUTES);
        expect(commands(f)).toEqual(["gh", "gh", "gh", "gh"]);
        expect(loud(f)).toHaveLength(2);
        expect(loud(f)[1]!.text).toContain("the tag object of v0.3.0 names no commit");
        yield* TestClock.adjust(TEN_MINUTES);
        expect(commands(f)).toEqual(["gh", "gh", "gh", "gh", "gh"]);
        expect(versionDirs(f)).toEqual(["0.1.0"]);
      }),
    );
  });
});

describe("a finished pass and the self-update's files", () => {
  const dataDirWith = (pending: object | null, refusedTag: string | null) => {
    const dataDir = NodeFS.mkdtempSync(NodePath.join(tmp, "data-"));
    if (pending !== null) write(NodePath.join(dataDir, UPDATE_PENDING_FILE), JSON.stringify(pending));
    if (refusedTag !== null) {
      write(
        NodePath.join(dataDir, UPDATE_REFUSED_FILE),
        JSON.stringify({ tag: refusedTag, from: "0.1.0", at: "2026-11-15T08:00:00.000Z" }),
      );
    }
    return dataDir;
  };
  const has = (dataDir: string, file: string) => NodeFS.existsSync(NodePath.join(dataDir, file));

  it.effect("removes the pending start count only when its to is the running version", () =>
    Effect.gen(function* () {
      const mine = dataDirWith({ from: "0.1.0", to: "0.2.0", starts: 2 }, null);
      yield* clearAfterPass(mine, "0.2.0");
      expect(has(mine, UPDATE_PENDING_FILE)).toBe(false);
      // Written for the next tag, staged during a long first pass: its restart has not happened.
      const next = dataDirWith({ from: "0.2.0", to: "0.3.0", starts: 0 }, null);
      yield* clearAfterPass(next, "0.2.0");
      expect(has(next, UPDATE_PENDING_FILE)).toBe(true);
    }),
  );

  it.effect("removes a refused tag below the running version, by number, and keeps one at or above it", () =>
    Effect.gen(function* () {
      const below = dataDirWith(null, "v0.9.0");
      yield* clearAfterPass(below, "0.10.0");
      expect(has(below, UPDATE_REFUSED_FILE)).toBe(false);
      const same = dataDirWith(null, "v0.2.0");
      yield* clearAfterPass(same, "0.2.0");
      expect(has(same, UPDATE_REFUSED_FILE)).toBe(true);
      const above = dataDirWith(null, "v0.10.0");
      yield* clearAfterPass(above, "0.9.0");
      expect(has(above, UPDATE_REFUSED_FILE)).toBe(true);
    }),
  );

  it.effect("leaves files it cannot read, and says nothing", () => {
    const logs: Array<string> = [];
    const dataDir = NodeFS.mkdtempSync(NodePath.join(tmp, "data-"));
    write(NodePath.join(dataDir, UPDATE_PENDING_FILE), "{not json");
    write(NodePath.join(dataDir, UPDATE_REFUSED_FILE), "{not json");
    return clearAfterPass(dataDir, "0.2.0").pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(has(dataDir, UPDATE_PENDING_FILE)).toBe(true);
          expect(has(dataDir, UPDATE_REFUSED_FILE)).toBe(true);
          expect(logs).toEqual([]);
        }),
      ),
      Effect.provide(
        Logger.layer([Logger.make(({ message }) => logs.push(String(message)))], { mergeWithExisting: false }),
      ),
    );
  });
});
