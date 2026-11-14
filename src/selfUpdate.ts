// @effect-diagnostics nodeBuiltinImport:off - the updater reads package.json and places a staged tree under versions/, as install does.
/**
 * The runner installs a newer release of itself. Ten minutes after start, and every ten minutes
 * after, it reads its repo's `v*` tags. A tag higher than the running version is cloned, given its
 * runtime dependencies and smoke-run under `versions/`, then placed with install's own `stage` and
 * `swapIn`, so `current` points at it. After the next pass that ends with no gate running, the
 * updater completes {@link SelfUpdate.stopped}; `run` in `bin.ts` waits on it, so the runner exits
 * 0 by the normal path and launchd's `KeepAlive` starts it again on `current/src/bin.ts`.
 *
 * Only a runner that `install` placed under `versions/` updates itself: a checkout run by hand is
 * never replaced under a developer.
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
import { stage, swapIn } from "./install.ts";
import { installPathsOf, packageVersion } from "./paths.ts";
import { FactoryProcess, type RunInput } from "./process.ts";

/** How long after start the first tag read waits, and the wait between reads. */
export const CHECK_INTERVAL = Duration.minutes(10);
/** The limit of each staging step: the clone, `npm ci` and the smoke. */
const STEP_TIMEOUT_MS = 10 * 60 * 1000;
/** The limit of the tag read, as the tracker gives a `gh` call. */
const GH_TIMEOUT_MS = 60_000;
/** Enough for thousands of tag names; a longer list is a failed read, not a short one. */
const REFS_BYTES = 1024 * 1024;
/** How much of a failed step's output its warning carries. */
const WARN_TAIL_CHARS = 2_000;
const TAG = /^refs\/tags\/v(\d+)\.(\d+)\.(\d+)$/;
const REPOSITORY = /^github:([^/\s]+)\/([^/\s]+)$/;

type Version = readonly [number, number, number];

const compare = (a: Version, b: Version): number => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

const parseVersion = (text: string): Version | null => {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(text);
  return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])];
};

/** The highest `refs/tags/vX.Y.Z` among `refs`; any other shape is not a release. */
const highestTag = (refs: ReadonlyArray<string>): Version | null => {
  let best: Version | null = null;
  for (const ref of refs) {
    const match = TAG.exec(ref.trim());
    if (match === null) continue;
    const version: Version = [Number(match[1]), Number(match[2]), Number(match[3])];
    if (best === null || compare(version, best) > 0) best = version;
  }
  return best;
};

/** `owner` and `repo` of the package's `"repository": "github:<owner>/<repo>"`. */
const repositoryOf = (packageRoot: string): { readonly owner: string; readonly repo: string } | null => {
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
}

export interface SelfUpdate {
  /**
   * The check loop, forked once per start. With `enabled` false, or a package root that is not an
   * installed version, it logs one line and ends.
   */
  readonly run: (enabled: boolean) => Effect.Effect<void, never, FactoryProcess>;
  /** Run after every pass: once an update is staged and no gate lock is held, completes `stopped`. */
  readonly afterPass: Effect.Effect<void>;
  /** Completed once, when the runner should end so launchd starts the staged version. */
  readonly stopped: Deferred.Deferred<void>;
}

export const makeSelfUpdate = Effect.fn("SelfUpdate.make")(function* (options: SelfUpdateOptions) {
  const stopped = yield* Deferred.make<void>();
  const { versions } = installPathsOf(options.home);
  let staged: string | null = null;
  /** Tags whose staging failed; not tried again until the runner restarts. */
  const failed = new Set<string>();

  /** One staging step: its output when it exited 0, else what the warning says of it. */
  const step = (
    name: string,
    input: RunInput,
  ): Effect.Effect<{ readonly ok: string } | { readonly failed: string }, never, FactoryProcess> =>
    Effect.gen(function* () {
      const process = yield* FactoryProcess;
      const done = yield* Effect.result(
        process.run({ timeoutMs: STEP_TIMEOUT_MS, ...input }),
      );
      if (done._tag === "Failure") return { failed: `${name} did not start: ${String(done.failure.cause)}` };
      const output = `${done.success.tail}\n${done.success.stderrTail}`;
      if (done.success.timedOut) {
        return { failed: `${name} timed out after ${STEP_TIMEOUT_MS / 60_000} minutes: ${tailOf(output)}` };
      }
      if (done.success.exitCode !== 0) {
        return { failed: `${name} exited ${done.success.exitCode ?? "by a signal"}: ${tailOf(output)}` };
      }
      return { ok: done.success.tail };
    });

  /** Clones `tag`, installs and smokes it, and places it; a failure warns once and marks it. */
  const stageTag = (
    repository: { readonly owner: string; readonly repo: string },
    version: string,
    running: string,
  ) =>
    Effect.gen(function* () {
      const tag = `v${version}`;
      NodeFS.mkdirSync(versions, { recursive: true });
      const clone = NodeFS.mkdtempSync(NodePath.join(versions, `.clone-${version}-`));
      const fail = (why: string) =>
        Effect.sync(() => {
          failed.add(tag);
          NodeFS.rmSync(clone, { recursive: true, force: true });
        }).pipe(Effect.andThen(Effect.logWarning(`update ${tag} not staged: ${why}`)));

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
      if ("failed" in cloned) return yield* fail(cloned.failed);

      const nodeDir = NodePath.dirname(options.execPath);
      const installed = yield* step("npm ci", {
        command: "npm",
        args: ["ci", "--omit=dev"],
        cwd: clone,
        env: { PATH: [nodeDir, globalThis.process.env["PATH"] ?? "/usr/bin:/bin"].join(":") },
      });
      if ("failed" in installed) return yield* fail(installed.failed);

      const smoked = yield* step("smoke", {
        command: options.execPath,
        args: [NodePath.join(clone, "src", "bin.ts"), "status", "--json"],
        env: { FACTORY_RUNNER_HOME: options.dataDir },
        separateStderr: true,
      });
      if ("failed" in smoked) return yield* fail(smoked.failed);
      let reported: unknown = null;
      try {
        reported = (JSON.parse(smoked.ok) as { version?: unknown }).version;
      } catch {
        // Not JSON: the check below says so.
      }
      if (reported !== version) {
        return yield* fail(`smoke: status --json reported version ${JSON.stringify(reported)}, not ${version}`);
      }

      try {
        const copy = stage({ home: options.home, packageRoot: clone }, version);
        swapIn({ home: options.home }, version, copy);
      } catch (error) {
        return yield* fail(`placing it failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      NodeFS.rmSync(clone, { recursive: true, force: true });
      staged = tag;
      yield* Effect.logInfo(`update staged: ${tag} (running ${running}); restarting when no gate runs`);
    });

  /** One period: read the tags and stage the highest when it is newer than the running version. */
  const check = (repository: { readonly owner: string; readonly repo: string }, running: Version, runningText: string) =>
    Effect.gen(function* () {
      const process = yield* FactoryProcess;
      const read = yield* Effect.result(
        process.run({
          command: "gh",
          args: ["api", `repos/${repository.owner}/${repository.repo}/git/matching-refs/tags/v`, "--jq", ".[].ref"],
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
      if (candidate === null || compare(candidate, running) <= 0) return;
      const version = candidate.join(".");
      if (failed.has(`v${version}`)) return;
      yield* stageTag(repository, version, runningText);
    });

  const run = Effect.fn("SelfUpdate.run")(function* (enabled: boolean) {
    if (!enabled) return yield* Effect.logInfo("self-update off: self_update is false");
    if (!isUnder(options.packageRoot, versions)) {
      return yield* Effect.logInfo(
        `self-update off: ${options.packageRoot} is not an installed version under ${versions}`,
      );
    }
    let repository: { readonly owner: string; readonly repo: string } | null = null;
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
    while (staged === null) {
      yield* Effect.sleep(CHECK_INTERVAL);
      yield* check(repository, running, runningText).pipe(
        Effect.catchDefect((defect) =>
          Effect.logWarning(`self-update check failed: ${defect instanceof Error ? defect.message : String(defect)}`),
        ),
      );
    }
  });

  const afterPass = Effect.suspend(() => {
    if (staged === null || gateLocksHeld(options.dataDir) > 0) return Effect.void;
    const tag = staged;
    return Deferred.isDone(stopped).pipe(
      Effect.flatMap((done) =>
        done
          ? Effect.void
          : Effect.logInfo(`restarting into ${tag}`).pipe(Effect.andThen(Deferred.succeed(stopped, undefined))),
      ),
    );
  });

  return { run, afterPass, stopped } satisfies SelfUpdate;
});
