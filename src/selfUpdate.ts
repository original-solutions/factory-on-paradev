// @effect-diagnostics nodeBuiltinImport:off - the updater reads package.json and places a staged tree under versions/, as install does.
/**
 * The runner installs a newer release of itself. Ten minutes after start, and every ten minutes
 * after, it reads its repo's `v*` tags. A tag higher than the running version, and on the repo's
 * default branch, is cloned, given its runtime dependencies and smoke-run under `versions/`, then
 * placed with install's own `stage` and `place`, so `versions/X.Y.Z` holds it while `current` still
 * points at the running version. From then on no gate starts. After the next pass that ends with no
 * gate running, the updater points `current` at the new version and completes
 * {@link SelfUpdate.stopped}; `run` in `bin.ts` waits on it, so the runner exits 0 by the normal
 * path and launchd's `KeepAlive` starts it again on `current/src/bin.ts`.
 *
 * Only a runner that `install` placed under `versions/` updates itself: a checkout run by hand is
 * never replaced under a developer. `self_update` is read from the loaded config before each tag
 * read and before the restart, so a reload that turns it off stops the update where it is.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

import { gateLocksHeld } from "./gate.ts";
import {
  FETCH_CREDENTIAL_FLAGS,
  HARDENED_GIT_ENV,
  fetchCredentialEnv,
} from "./gitHardening.ts";
import { place, pointCurrent, stage } from "./install.ts";
import { installPathsOf, packageVersion } from "./paths.ts";
import { FactoryProcess, type RunInput } from "./process.ts";

/** How long after start the first tag read waits, and the wait between reads. */
export const CHECK_INTERVAL = Duration.minutes(10);
/** The limit of each staging step: the clone, `npm ci` and the smoke. */
const STEP_TIMEOUT_MS = 10 * 60 * 1000;
/** The limit of each `gh` call, as the tracker gives one. */
const GH_TIMEOUT_MS = 60_000;
/** Enough for thousands of tag names; a longer list is a failed read, not a short one. */
const REFS_BYTES = 1024 * 1024;
/** Room for the whole `status --json` of a busy data dir; a longer report fails the smoke. */
const SMOKE_BYTES = 16 * 1024 * 1024;
/** How much of a failed step's output its warning carries. */
const WARN_TAIL_CHARS = 2_000;
/** The temp clone of a tag being staged: `versions/.clone-<version>-<random>`. */
const CLONE_PREFIX = ".clone-";
/** What GitHub's compare of the tag with the default branch says when the tag is on it. */
const ON_BRANCH = new Set(["identical", "ahead"]);
/** How the tag read prints each ref: `refs/tags/vX.Y.Z <object sha> <object type>`. */
const TAG_JQ = '.[] | "\\(.ref) \\(.object.sha) \\(.object.type)"';
const TAG_LINE = /^refs\/tags\/v(\d+)\.(\d+)\.(\d+) ([0-9a-f]{40}) (commit|tag)$/;
const SHA = /^[0-9a-f]{40}$/;
const REPOSITORY = /^github:([^/\s]+)\/([^/\s]+)$/;
const OFF_LINE = "self-update off: self_update is false";

type Version = readonly [number, number, number];

const compare = (a: Version, b: Version): number => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

const parseVersion = (text: string): Version | null => {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(text);
  return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])];
};

/** A `vX.Y.Z` tag and the object its ref names: a commit, or an annotated tag to peel. */
interface Candidate {
  readonly version: Version;
  readonly sha: string;
  readonly annotated: boolean;
}

/** The highest `vX.Y.Z` among the tag read's lines; any other shape is not a release. */
const highestTag = (lines: ReadonlyArray<string>): Candidate | null => {
  let best: Candidate | null = null;
  for (const line of lines) {
    const match = TAG_LINE.exec(line.trim());
    if (match === null) continue;
    const version: Version = [Number(match[1]), Number(match[2]), Number(match[3])];
    if (best === null || compare(version, best.version) > 0) {
      best = { version, sha: match[4]!, annotated: match[5] === "tag" };
    }
  }
  return best;
};

/** `owner` and `repo` of the package's `"repository": "github:<owner>/<repo>"`. */
interface Repository {
  readonly owner: string;
  readonly repo: string;
}

export const repositoryOf = (packageRoot: string): Repository | null => {
  const json = JSON.parse(
    NodeFS.readFileSync(NodePath.join(packageRoot, "package.json"), "utf8"),
  ) as { repository?: unknown };
  const match = typeof json.repository === "string" ? REPOSITORY.exec(json.repository) : null;
  return match === null ? null : { owner: match[1]!, repo: match[2]! };
};

/** Whether `child` is a folder somewhere under `parent`, both resolved through their links. */
const isUnder = (child: string, parent: string): boolean => {
  try {
    const relative = NodePath.relative(NodeFS.realpathSync(parent), NodeFS.realpathSync(child));
    return relative !== "" && !relative.startsWith("..") && !NodePath.isAbsolute(relative);
  } catch {
    return false;
  }
};

const tailOf = (text: string): string => {
  const trimmed = text.trim();
  return trimmed.length > WARN_TAIL_CHARS ? `…${trimmed.slice(-WARN_TAIL_CHARS)}` : trimmed;
};

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export interface SelfUpdateOptions {
  /** HOME: `versions/` and `current` are under it, as `install` put them. */
  readonly home: string;
  /** The data dir: the smoke's `FACTORY_RUNNER_HOME`, and where gate lock files are. */
  readonly dataDir: string;
  /** The running package: the folder holding its `package.json`. */
  readonly packageRoot: string;
  /** The node running the runner: it runs the smoke, and its folder leads PATH for `npm ci`. */
  readonly execPath: string;
  /** The `gh` login directory of the current machine config. */
  readonly ghConfigDir: () => string;
  /**
   * Gate calls this process is running now. A gate holds its lock file only while an attempt
   * runs, so the restart waits on both.
   */
  readonly gatesRunning: () => number;
}

export interface SelfUpdate {
  /**
   * The check loop, forked once per start. `enabled` is `self_update` of the config loaded now,
   * read before each tag read and before the restart. With a package root that is not an
   * installed version, it logs one line and ends.
   */
  readonly run: (enabled: () => boolean) => Effect.Effect<void, never, FactoryProcess>;
  /**
   * Run after every pass: once an update is staged, `enabled` still holds and no gate runs, it
   * points `current` at the update and completes `stopped`.
   */
  readonly afterPass: Effect.Effect<void>;
  /** Completed once, when the runner should end so launchd starts the staged version. */
  readonly stopped: Deferred.Deferred<void>;
  /**
   * Whether an update is staged and `enabled` holds: no gate starts then, so the restart is not put
   * off. With the key off the restart cannot fire, so gates start as before.
   */
  readonly staged: () => boolean;
}

export const makeSelfUpdate = Effect.fn("SelfUpdate.make")(function* (options: SelfUpdateOptions) {
  const stopped = yield* Deferred.make<void>();
  const { versions } = installPathsOf(options.home);
  let staged: { readonly tag: string; readonly version: string } | null = null;
  /** Tags whose staging failed; not tried again until the runner restarts. */
  const failed = new Set<string>();
  let enabled: () => boolean = () => false;
  /** Whether the off line was logged since the key was last seen on. */
  let offSaid = false;

  /** `self_update` now; the first read that finds it off logs one line, until it is on again. */
  const enabledNow = Effect.suspend(() => {
    if (enabled()) {
      offSaid = false;
      return Effect.succeed(true);
    }
    if (offSaid) return Effect.succeed(false);
    offSaid = true;
    return Effect.logInfo(OFF_LINE).pipe(Effect.as(false));
  });

  /** One staging step: its output when it exited 0, else what the warning says of it. */
  const step = (
    name: string,
    input: RunInput,
  ): Effect.Effect<
    { readonly ok: string; readonly truncated: boolean } | { readonly failed: string },
    never,
    FactoryProcess
  > =>
    Effect.gen(function* () {
      const process = yield* FactoryProcess;
      const done = yield* Effect.result(
        process.run({ timeoutMs: STEP_TIMEOUT_MS, ...input }),
      );
      if (done._tag === "Failure") return { failed: `${name} did not start: ${String(done.failure.cause)}` };
      const output = `${done.success.tail}\n${done.success.stderrTail}`;
      const minutes = (input.timeoutMs ?? STEP_TIMEOUT_MS) / 60_000;
      if (done.success.timedOut) {
        return { failed: `${name} timed out after ${minutes} minute${minutes === 1 ? "" : "s"}: ${tailOf(output)}` };
      }
      if (done.success.exitCode !== 0) {
        return { failed: `${name} exited ${done.success.exitCode ?? "by a signal"}: ${tailOf(output)}` };
      }
      return { ok: done.success.tail, truncated: done.success.tailTruncated };
    });

  /** A `gh api` read as the factory's login, within the tracker's limit. */
  const ghApi = (name: string, path: string, jq: string) =>
    step(name, {
      command: "gh",
      args: ["api", path, "--jq", jq],
      env: { GH_CONFIG_DIR: options.ghConfigDir() },
      timeoutMs: GH_TIMEOUT_MS,
      separateStderr: true,
    });

  /**
   * Pins the tag to the commit its ref named at the read, checks that commit is on the default
   * branch, clones the tag and checks the clone is that commit, installs and smokes it, and places
   * it under `versions/`; a failure warns once and marks the tag. A runner stopped part way leaves
   * its clone for the next start.
   */
  const stageTag = (repository: Repository, candidate: Candidate, version: string, running: string) =>
    Effect.gen(function* () {
      const tag = `v${version}`;
      const repo = `repos/${repository.owner}/${repository.repo}`;
      const fail = (why: string) =>
        Effect.sync(() => {
          failed.add(tag);
        }).pipe(Effect.andThen(Effect.logWarning(`update ${tag} not staged: ${why}`)));

      // One commit, by sha, from here on: a tag moved between the check and the clone, or a branch
      // of the tag's name, is not what was checked. An annotated tag's ref names the tag object.
      let sha = candidate.sha;
      if (candidate.annotated) {
        const peeled = yield* ghApi("tag read", `${repo}/git/tags/${sha}`, ".object.sha");
        if ("failed" in peeled) return yield* fail(peeled.failed);
        sha = peeled.ok.trim();
        if (!SHA.test(sha)) return yield* fail(`tag read: the tag object of ${tag} names no commit: ${tailOf(peeled.ok)}`);
      }
      // A release is a tag on the default branch: whoever can push a tag could otherwise run any
      // commit on every runner, with the factory's login.
      const branch = yield* ghApi("default branch read", repo, ".default_branch");
      if ("failed" in branch) return yield* fail(branch.failed);
      const defaultBranch = branch.ok.trim();
      const compared = yield* ghApi("branch check", `${repo}/compare/${sha}...${defaultBranch}`, ".status");
      if ("failed" in compared) return yield* fail(compared.failed);
      const status = compared.ok.trim();
      if (!ON_BRANCH.has(status)) {
        return yield* fail(`${tag} (${sha}) is not on ${defaultBranch}: GitHub compares them as ${status || "nothing"}`);
      }

      NodeFS.mkdirSync(versions, { recursive: true });
      const clone = NodeFS.mkdtempSync(NodePath.join(versions, `${CLONE_PREFIX}${version}-`));
      const failClone = (why: string) =>
        Effect.sync(() => {
          NodeFS.rmSync(clone, { recursive: true, force: true });
        }).pipe(Effect.andThen(fail(why)));

      return yield* Effect.gen(function* () {
        const cloned = yield* step("git clone", {
          command: "git",
          args: [
            ...FETCH_CREDENTIAL_FLAGS,
            "clone",
            "--quiet",
            "--depth",
            "1",
            "--branch",
            tag,
            `https://github.com/${repository.owner}/${repository.repo}.git`,
            clone,
          ],
          env: { ...HARDENED_GIT_ENV, ...fetchCredentialEnv(options.ghConfigDir()) },
        });
        if ("failed" in cloned) return yield* failClone(cloned.failed);
        // The clone is the checked commit, or nothing of it runs: `--branch` takes a branch of the
        // same name over the tag, and a tag can be moved between the check and the clone.
        const head = yield* step("commit check", {
          command: "git",
          args: ["-C", clone, "rev-parse", "HEAD"],
          env: HARDENED_GIT_ENV,
          separateStderr: true,
        });
        if ("failed" in head) return yield* failClone(head.failed);
        if (head.ok.trim() !== sha) {
          return yield* failClone(
            `the clone's HEAD ${head.ok.trim()} is not the checked commit ${sha} of ${tag}: the tag moved, or a branch of its name was cloned`,
          );
        }

        const nodeDir = NodePath.dirname(options.execPath);
        const installed = yield* step("npm ci", {
          command: "npm",
          args: ["ci", "--omit=dev"],
          cwd: clone,
          env: { PATH: [nodeDir, globalThis.process.env["PATH"] ?? "/usr/bin:/bin"].join(":") },
        });
        if ("failed" in installed) return yield* failClone(installed.failed);

        const smoked = yield* step("smoke", {
          command: options.execPath,
          args: [NodePath.join(clone, "src", "bin.ts"), "status", "--json"],
          env: { FACTORY_RUNNER_HOME: options.dataDir },
          separateStderr: true,
          tailBytes: SMOKE_BYTES,
        });
        if ("failed" in smoked) return yield* failClone(smoked.failed);
        if (smoked.truncated) return yield* failClone(`smoke: status --json printed longer than ${SMOKE_BYTES} bytes`);
        let report: { state?: unknown; version?: unknown; reason?: unknown } = {};
        try {
          report = JSON.parse(smoked.ok) as typeof report;
        } catch {
          // Not JSON: the version check below says so.
        }
        if (report.version !== version) {
          return yield* failClone(`smoke: status --json did not report version ${version}: ${tailOf(smoked.ok)}`);
        }
        // The staged tree must see this runner (it holds the lock) and read this machine's config,
        // as `status` under the running version does: a tree that reports idle would stay idle
        // after the restart, and an idle runner runs no pass, so it would never update past itself.
        if (report.state !== "running") {
          const reason = typeof report.reason === "string" ? ` (${report.reason})` : "";
          return yield* failClone(`smoke: status --json says the runner is ${String(report.state)}${reason} under ${tag}`);
        }

        let copy: string | null = null;
        try {
          copy = stage({ home: options.home, packageRoot: clone }, version);
          place({ home: options.home }, version, copy);
        } catch (error) {
          if (copy !== null) NodeFS.rmSync(copy, { recursive: true, force: true });
          return yield* failClone(`placing it failed: ${messageOf(error)}`);
        }
        NodeFS.rmSync(clone, { recursive: true, force: true });
        staged = { tag, version };
        yield* Effect.logInfo(`update staged: ${tag} (running ${running}); restarting when no gate runs`);
      }).pipe(
        // A step that throws (an EMFILE from the spawn) is a failed step, not a clone left behind.
        Effect.catchDefect((defect) => failClone(`a step threw: ${messageOf(defect)}`)),
      );
    });

  /** One period: read the tags and stage the highest when it is newer than the running version. */
  const check = (repository: Repository, running: Version, runningText: string) =>
    Effect.gen(function* () {
      const process = yield* FactoryProcess;
      const read = yield* Effect.result(
        process.run({
          command: "gh",
          args: ["api", `repos/${repository.owner}/${repository.repo}/git/matching-refs/tags/v`, "--jq", TAG_JQ],
          env: { GH_CONFIG_DIR: options.ghConfigDir() },
          timeoutMs: GH_TIMEOUT_MS,
          tailBytes: REFS_BYTES,
          separateStderr: true,
        }),
      );
      const why =
        read._tag === "Failure"
          ? `gh did not start: ${String(read.failure.cause)}`
          : read.success.timedOut
            ? `gh timed out after ${GH_TIMEOUT_MS / 1000} s`
            : read.success.tailTruncated
              ? `gh printed more than ${REFS_BYTES} bytes`
              : read.success.exitCode !== 0
                ? `gh exited ${read.success.exitCode ?? "by a signal"}: ${tailOf(read.success.stderrTail)}`
                : null;
      if (why !== null || read._tag === "Failure") {
        return yield* Effect.logWarning(`self-update could not read the tags of ${repository.owner}/${repository.repo}: ${why}`);
      }
      const candidate = highestTag(read.success.tail.split("\n"));
      if (candidate === null || compare(candidate.version, running) <= 0) return;
      const version = candidate.version.join(".");
      if (failed.has(`v${version}`)) return;
      yield* stageTag(repository, candidate, version, runningText);
    });

  const run = Effect.fn("SelfUpdate.run")(function* (isEnabled: () => boolean) {
    enabled = isEnabled;
    if (!isUnder(options.packageRoot, versions)) {
      return yield* Effect.logInfo(
        `self-update off: ${options.packageRoot} is not an installed version under ${versions}`,
      );
    }
    // A clone a stopped runner left part way through staging.
    for (const entry of NodeFS.readdirSync(versions)) {
      if (entry.startsWith(CLONE_PREFIX)) {
        NodeFS.rmSync(NodePath.join(versions, entry), { recursive: true, force: true });
      }
    }
    let repository: Repository | null = null;
    let runningText = "";
    try {
      repository = repositoryOf(options.packageRoot);
      runningText = packageVersion(options.packageRoot);
    } catch {
      // Unreadable: the line below says what it needs.
    }
    const running = parseVersion(runningText);
    if (repository === null || running === null) {
      return yield* Effect.logInfo(
        `self-update off: ${options.packageRoot}/package.json needs a "github:<owner>/<repo>" repository and an X.Y.Z version`,
      );
    }
    yield* enabledNow;
    // The loop outlives a staged update: a placement that fails at the restart clears it, and the
    // next period reads the tags again.
    while (true) {
      yield* Effect.sleep(CHECK_INTERVAL);
      if (staged !== null || !(yield* enabledNow)) continue;
      yield* check(repository, running, runningText).pipe(
        Effect.catchDefect((defect) =>
          Effect.logWarning(`self-update check failed: ${messageOf(defect)}`),
        ),
      );
    }
  });

  const afterPass = Effect.gen(function* () {
    if (staged === null) return;
    const { tag, version } = staged;
    if (!(yield* enabledNow)) return;
    if (options.gatesRunning() > 0 || gateLocksHeld(options.dataDir) > 0) return;
    if (yield* Deferred.isDone(stopped)) return;
    try {
      pointCurrent({ home: options.home }, version);
    } catch (error) {
      // The placed tree stays under versions/; the tag is not tried again until a restart.
      staged = null;
      failed.add(tag);
      return yield* Effect.logWarning(`update ${tag} not placed: pointing current at it failed: ${messageOf(error)}`);
    }
    yield* Effect.logInfo(`restarting into ${tag}`);
    yield* Deferred.succeed(stopped, undefined);
  });

  return { run, afterPass, stopped, staged: () => staged !== null && enabled() } satisfies SelfUpdate;
});
