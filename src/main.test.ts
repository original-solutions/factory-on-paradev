// @effect-diagnostics nodeBuiltinImport:off - the stop request is a file in the data dir.
// @effect-diagnostics globalDate:off - the waits for a pass use the wall clock, as the loop does.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { describe, vi } from "vitest";

import { Attention, type NewItem } from "./attention.ts";
import { pauseClaims } from "./claims.ts";
import {
  timeLimitOnlyProjectConfig,
  type MachineConfig,
  type RepoConfigReading,
} from "./config.ts";
import { cooldownKey, recordRateLimit, type Cooldown } from "./cooldown.ts";
import type { Defaulted } from "./defaultProject.ts";
import type { State } from "./domain/lifecycle.ts";
import { FactoryGate, MERGE_COMMAND } from "./gate.ts";
import { isLedgerError } from "./ledger/errors.ts";
import { makeCause } from "./ledger/events.ts";
import { Ledger } from "./ledger/ledger.ts";
import { MachineLog, scanMachineLog } from "./ledger/machineLog.ts";
import { readRun } from "./ledger/read.ts";
import { newRunId, runIdToString, runPath, type RunId } from "./ledger/runId.ts";
import { T0, ticking, useTempDirs } from "./ledger/testSupport.ts";
import {
  defaultedFiles,
  factoryRuntime,
  FactoryLoop,
  gateDecided,
  gateItem,
  liveWorld,
  newShared,
  regateWords,
  type LiveShared,
  type RuntimeOptions,
} from "./main.ts";
import { readFixture } from "./paradev/fake-superset.ts";
import { AgentProcess } from "./paradev/sessions.ts";
import { writeThread } from "./paradev/state.ts";
import * as Paths from "./paths.ts";
import { LOAD_COMMAND, PROXY_ENV_READ, type SshSpawn } from "./paradev/ssh.ts";
import { PARADEV_HOLD_PASSES, PARADEV_OFFLINE_ITEM_ID, type PassWorld, type Repo } from "./pass.ts";
import {
  FactoryProcess,
  layer as processLayer,
  RunSpawnError,
  type RunInput,
  type RunResult,
} from "./process.ts";
import { CUT_SHORT_COMMENT } from "./runner/messages.ts";
import { utcSecond, type StartContext } from "./runner/start.ts";
import { stopRequestPath } from "./runner/stop.ts";
import {
  NoTargetHasRoom,
  SessionsError,
  ThreadNotFoundError,
  type FactorySessions,
} from "./sessions.ts";
import { MARKER } from "./tracker/github.ts";

/**
 * The mocks of liveWorldBase.test.ts, hoisted for the whole file: each wrapped function calls
 * through to the real one, unless the test that wants to see a step's context has `stub.on` set.
 */
const { bases, startContexts, stub, wrapped } = vi.hoisted(() => {
  const stub = { on: false };
  const bases: Array<string> = [];
  const wrapped = <F>(name: string, actual: F, stubbed: () => unknown): F =>
    ((ctx: { readonly project: { readonly base: string } }, ...rest: Array<unknown>) => {
      if (!stub.on) return (actual as unknown as (...args: Array<unknown>) => unknown)(ctx, ...rest);
      bases.push(`${name} ${ctx.project.base}`);
      return stubbed();
    }) as unknown as F;
  return { bases, startContexts: [] as Array<unknown>, stub, wrapped };
});

vi.mock("./runner/building.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./runner/building.ts")>();
  const { Effect: E } = await import("effect");
  const done = () => E.void;
  return {
    ...actual,
    timeLimit: wrapped("timeLimit", actual.timeLimit, done),
    watch: wrapped("watch", actual.watch, done),
    forward: wrapped("forward", actual.forward, done),
    advance: wrapped("advance", actual.advance, done),
    interrupted: wrapped("interrupted", actual.interrupted, done),
    resumeAfterCooldown: wrapped("resumeAfterCooldown", actual.resumeAfterCooldown, done),
  };
});

// The claim is not run when `stub.on`: the test is about the context `liveWorld` builds for it.
vi.mock("./runner/start.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./runner/start.ts")>();
  const { Effect: E } = await import("effect");
  const start = (ctx: unknown, issue: number) => {
    if (!stub.on) return actual.start(ctx as StartContext, issue);
    startContexts.push(ctx);
    return E.succeed({ kind: "skipped", reason: "not run" });
  };
  return { ...actual, start: start as unknown as typeof actual.start };
});

vi.mock("./runner/feedback.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./runner/feedback.ts")>();
  const { Effect: E } = await import("effect");
  return { ...actual, feedback: wrapped("feedback", actual.feedback, () => E.void) };
});

/** A process runner on a machine with no `gh`: every call fails to start. */
const noGhProcess = FactoryProcess.of({
  run: () => Effect.fail(new RunSpawnError({ shell: false, cause: new Error("gh not found") })),
});

/** A FactorySessions that finds no Paradev project and dies on anything else. */
const stubSessions: FactorySessions["Service"] = {
  findProject: () => Effect.succeed(null),
  launch: () => Effect.die("not launched"),
  status: () => Effect.die("no status"),
  thread: () => Effect.die("no thread"),
  send: () => Effect.die("not sent"),
  archive: () => Effect.die("not archived"),
  showGateLog: () => Effect.void,
  removeWorktree: () => Effect.die("not removed"),
  worktreeCheckout: () => Effect.die("no worktree head"),
  runningThreads: Effect.succeed(0),
  lastActivity: () => Effect.succeed(null),
  worktreesDirectory: (defaultDir) => Effect.succeed(defaultDir),
};

/** The stub sessions with some methods replaced. */
const sessionsOf = (over: Partial<FactorySessions["Service"]>): FactorySessions["Service"] => ({
  ...stubSessions,
  ...over,
});

/** A gate that never runs: the runtime is built without one. */
const noGate = Layer.succeed(
  FactoryGate,
  FactoryGate.of({ run: () => Effect.succeed({ _tag: "running" as const }) }),
);

/** No agent process is ever found. */
const noAgents = Layer.succeed(AgentProcess, AgentProcess.of({ find: () => Effect.succeed(null) }));

/** Attention that keeps nothing: a world whose items are not under test. */
const noAttention: Pick<Attention["Service"], "list" | "raise" | "clear"> = {
  list: () => Effect.succeed([]),
  raise: () => Effect.void,
  clear: () => Effect.void,
};

/**
 * Shared state whose `gating` offers each run it frees to `freed`: the milestone of a background
 * gate that neither wakes the loop nor raises an item.
 */
const freeingShared = (freed: Queue.Queue<string>): LiveShared => {
  class Gating extends Set<string> {
    override delete(id: string): boolean {
      const had = super.delete(id);
      Queue.offerUnsafe(freed, id);
      return had;
    }
  }
  return { ...newShared(), gating: new Gating() };
};

const messageText = (message: unknown): string => {
  const first = Array.isArray(message) ? message[0] : message;
  return typeof first === "string" ? first : String(first);
};

/** A building run whose session reported its pull request: the gate reads the issue, then the thread. */
const seedReportedRun = (dataDir: string, repo: string): RunId => {
  const run = newRunId(repo, "10", 1);
  const ledger = Ledger.create(dataDir, run, { clock: () => 1_000 });
  ledger.append(
    {
      event: "session_launched",
      data: {
        thread_id: "thread-1",
        worktree: null,
        branch: null,
        model_instance: null,
        model: null,
        model_options: null,
        resumed_from: null,
      },
    },
    makeCause("start", "seed"),
  );
  ledger.append(
    { event: "state_changed", data: { from: "triage", to: "building" } },
    makeCause("start", "seed"),
  );
  ledger.append(
    { event: "pr_opened", data: { pr: 12, url: `https://github.com/${repo}/pull/12` } },
    makeCause("advance", "seed"),
  );
  ledger.close();
  return run;
};

// ---- the scripted Paradev CLI ---------------------------------------------------------------

/** The Paradev CLI as the config names it: the runtime runs it through `FactoryProcess`. */
const CLI = "/test/bin/superset";

/** The machine config's `paradev` block as `liveWorld` is given it. */
const PARADEV = {
  cli: CLI,
  agent: "claude",
  belt: { enabled: false, visibility: "just_me" as const },
};

/** The machine config `liveWorld` is given, with no repo; a test that needs another spreads it. */
const baseMachine: MachineConfig = {
  ghConfigDir: "/gh/rawphp",
  pollSeconds: 60,
  maxConcurrentRuns: 1,
  maxConcurrentGates: 1,
  feedbackSeconds: 600,
  notify: true,
  minFreeGib: 0,
  maxLoadPerCore: 0,
  modelFallbacks: {},
  repos: [],
  hosts: [],
  local: { maxRuns: 1 },
  paradev: PARADEV,
};

interface FakeProject {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly repo: string;
}

/** What the scripted CLI answers, and every call it saw (argv without `--json`). */
interface FakeParadev {
  /** `projects list --local`. */
  projects: Array<FakeProject>;
  /** The `Error:` line `status` fails with; null when Paradev answers. */
  down: string | null;
  /** The `Error:` line `projects list` fails with; absent when it answers. */
  listDown?: string;
  /** What `hosts list` answers; absent, it fails with an `Error:` line. */
  hostsList?: ReadonlyArray<unknown>;
  /** Rewrites the recorded `schema` answer. */
  schema: (answer: unknown) => unknown;
  /** Answers the `pages` commands; absent, they are unexpected. */
  pages?: (argv: ReadonlyArray<string>) => RunResult;
  /** A call this is true for is recorded and never answers, as against a hung Paradev. */
  hangs?: (argv: ReadonlyArray<string>) => boolean;
  readonly calls: Array<ReadonlyArray<string>>;
}

const projectAt = (repo: string, path: string): FakeProject => ({
  id: `project-${repo}`,
  name: path.split("/").at(-1)!,
  path,
  repo: `https://github.com/${repo}`,
});

const A_B_PROJECT = projectAt("a/b", "/b");
const C_D_PROJECT = projectAt("c/d", "/d");

/** A Paradev that knows `a/b` at `/b` and `c/d` at `/d`, answers `status`, and has the recorded schema. */
const newParadev = (projects: ReadonlyArray<FakeProject> = [A_B_PROJECT, C_D_PROJECT]): FakeParadev => ({
  projects: [...projects],
  down: null,
  schema: (answer) => answer,
  calls: [],
});

const reply = (exitCode: number, tail: string, stderrTail = ""): RunResult => ({
  exitCode,
  timedOut: false,
  tail,
  stderrTail,
  truncated: false,
  tailTruncated: false,
});

const paradevAnswer = (paradev: FakeParadev, argv: ReadonlyArray<string>): RunResult => {
  paradev.calls.push(argv);
  switch (argv.join(" ")) {
    case "schema":
      return reply(0, JSON.stringify(paradev.schema(JSON.parse(readFixture("schema").stdout))));
    case "status":
      return paradev.down === null
        ? reply(0, '{"running":true}')
        : reply(1, "", `Error: ${paradev.down}\n`);
    case "projects list --local":
      return paradev.listDown === undefined
        ? reply(0, JSON.stringify(paradev.projects))
        : reply(1, "", `Error: ${paradev.listDown}\n`);
    case "hosts list":
      return paradev.hostsList === undefined
        ? reply(1, "", "Error: PARADEV_OFFLINE: host service is not running\n")
        : reply(0, JSON.stringify(paradev.hostsList));
    // The orphan sweep's listing: no cloud workspace.
    case "workspaces list --host cloud":
      return reply(0, "[]");
    default:
      if (argv[0] === "pages" && paradev.pages !== undefined) return paradev.pages(argv);
      if (argv[0] === "projects" && argv.includes("--host")) return reply(0, "[]");
      throw new Error(`the scripted superset got an unexpected call: ${argv.join(" ")}`);
  }
};

/** `other` for every command but the Paradev CLI, which `paradev` answers. */
const withParadev = (
  paradev: FakeParadev,
  other: FactoryProcess["Service"] = noGhProcess,
): FactoryProcess["Service"] =>
  FactoryProcess.of({
    run: (input) => {
      if (input.command !== CLI) return other.run(input);
      const args = input.args ?? [];
      const argv = args.at(-1) === "--json" ? args.slice(0, -1) : args;
      if (paradev.hangs?.(argv) === true) {
        paradev.calls.push(argv);
        return Effect.never;
      }
      return Effect.sync(() => paradevAnswer(paradev, argv));
    },
  });

// ---- the machine config ---------------------------------------------------------------------

// The belt is off, so a pass makes no `pages` call; `the belt page` turns it on.
const PARADEV_BLOCK = `paradev:\n  belt:\n    enabled: false\n  agent: claude\n  cli: ${CLI}\n`;

const configFor = (
  repos: ReadonlyArray<readonly [string, string]> = [["a/b", "/b"]],
  ghDir = "/gh",
  extra = "",
  paradev = PARADEV_BLOCK,
) =>
  `gh_config_dir: ${ghDir}\nmax_concurrent_runs: 1\nmin_free_gib: 0\n${extra}repos:\n${repos
    .map(([repo, path]) => `  - repo: ${repo}\n    path: ${path}\n`)
    .join("")}${paradev}`;

// The free-space check is off, so a pass does not depend on the disk of the machine running it.
const VALID = configFor();

/** `VALID` with the one required key a file cannot do without taken out. */
const INVALID = VALID.replace("max_concurrent_runs: 1\n", "");
const MISSING = "max_concurrent_runs: is missing";

// The host's own load would hold claims on a busy machine, such as the gate's.
const idleLoad = () => ({ oneMinute: 0, cores: 1 });

// ---- building the runtime -------------------------------------------------------------------

type FactoryPathsService = Paths.FactoryPaths["Service"];

const pathsIn = (baseDir: string): FactoryPathsService => ({
  baseDir,
  worktreesDir: NodePath.join(baseDir, "worktrees"),
  factoryDir: NodePath.join(baseDir, "factory"),
  machineConfigPath: NodePath.join(baseDir, "factory", "config.yml"),
  claudeProjectsDir: NodePath.join(baseDir, "claude"),
});

/** The runtime over `paths`, with `process` as the machine's commands. */
const runtimeLayer = (
  paths: FactoryPathsService,
  process: FactoryProcess["Service"],
  options: RuntimeOptions = {},
) =>
  factoryRuntime({ readLoad: idleLoad, ...options }).pipe(
    Layer.provide(Layer.succeed(Paths.FactoryPaths, paths)),
    Layer.provide(Layer.succeed(FactoryProcess, process)),
    Layer.provide(noAgents),
    Layer.provide(noGate),
  );

/** A base dir whose factory dir holds `config` (or no file). */
const dirWith = (config: string | undefined, prefix = "factory-main-") =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = pathsIn(yield* fs.makeTempDirectoryScoped({ prefix }));
    yield* fs.makeDirectory(paths.factoryDir);
    if (config !== undefined) yield* fs.writeFileString(paths.machineConfigPath, config);
    return paths;
  });

/** Builds the runtime over `paths` in the caller's scope; what its loop logs is kept in `logs`. */
const runtimeOver = (
  paths: FactoryPathsService,
  process: FactoryProcess["Service"],
  options: RuntimeOptions = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const logs: Array<string> = [];
    const capture = Logger.make(({ message }) => {
      logs.push(messageText(message));
    });
    const logLayer = Logger.layer([capture], { mergeWithExisting: false });
    const context = yield* Layer.build(runtimeLayer(paths, process, options)).pipe(
      Effect.provide(logLayer),
    );
    return {
      /** For a `reload` run from the test: the loop it starts logs here too. */
      logLayer,
      loop: Context.get(context, FactoryLoop),
      attention: Context.get(context, Attention),
      logs,
      paths,
      factoryDir: paths.factoryDir,
      file: paths.machineConfigPath,
      write: (text: string) => fs.writeFileString(paths.machineConfigPath, text),
    };
  });

/**
 * The runtime over a temp base dir holding `config` (or no file), in the caller's scope, with a
 * scripted Paradev and `other` for gh, git and osascript.
 */
const started = (
  config: string | undefined,
  other: FactoryProcess["Service"] = noGhProcess,
  options: RuntimeOptions = {},
  paradev: FakeParadev = newParadev(),
  seed: (
    paths: FactoryPathsService,
  ) => Effect.Effect<
    void,
    PlatformError.PlatformError,
    FileSystem.FileSystem | Path.Path
  > = () => Effect.void,
) =>
  Effect.gen(function* () {
    const paths = yield* dirWith(config);
    yield* seed(paths);
    return { ...(yield* runtimeOver(paths, withParadev(paradev, other), options)), paradev };
  });

const realDelay = (ms: number) =>
  Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

/** Waits in real time until `done`, and fails the test, not the run, when it never is. */
const waitUntil = (what: string, done: () => boolean, ms = 30_000) =>
  Effect.gen(function* () {
    const until = Date.now() + ms;
    while (!done()) {
      if (Date.now() > until) return yield* Effect.die(new Error(`timed out waiting for ${what}`));
      yield* realDelay(5);
    }
  });

const finishedPasses = (factoryDir: string) =>
  scanMachineLog(factoryDir).filter((entry) => entry.event === "pass_finished").length;

/** Waits until `n` passes have finished and none is running: the loop is waiting for its next wake. */
const idleAfter = (loop: FactoryLoop["Service"], factoryDir: string, n: number) =>
  Effect.gen(function* () {
    yield* waitUntil(`pass ${n} to finish`, () => finishedPasses(factoryDir) >= n);
    while (yield* loop.passRunning) yield* realDelay(5);
    yield* realDelay(5);
  });

/** Wakes an idle loop and waits for the one pass that follows. */
const onePassMore = (loop: FactoryLoop["Service"], factoryDir: string) =>
  Effect.gen(function* () {
    const before = finishedPasses(factoryDir);
    yield* loop.wake;
    yield* idleAfter(loop, factoryDir, before + 1);
  });

const eventsOf = (factoryDir: string, event: string) =>
  scanMachineLog(factoryDir).filter((entry) => entry.event === event);

const A_B = { repo: "a/b", path: "/b" };

/** Builds the factory runtime over a temp base dir whose factory dir holds `config` (or no file) and returns the log lines. */
const logsFor = (
  config: string | undefined,
  setup: (
    factoryDir: string,
  ) => Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem> = () => Effect.void,
  other: FactoryProcess["Service"] = noGhProcess,
  paradev: FakeParadev = newParadev(),
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const paths = yield* dirWith(config);
      yield* setup(paths.factoryDir);
      const { loop, logs } = yield* runtimeOver(paths, withParadev(paradev, other));
      // A valid config starts a pass at once: its log lines are complete once it has ended.
      if (loop.status.state === "running") {
        yield* waitUntil(
          "the first pass to end",
          () =>
            finishedPasses(paths.factoryDir) > 0 || logs.includes("factory pass failed"),
        );
      }
      const gates = yield* fs
        .readDirectory(NodePath.join(paths.factoryDir, "gates"))
        .pipe(Effect.orElseSucceed(() => []));
      const events = scanMachineLog(paths.factoryDir).map((entry) => entry.event);
      return {
        logs,
        machineConfigPath: paths.machineConfigPath,
        gates,
        events,
        status: loop.status,
      };
    }),
  ).pipe(Effect.provide(NodeServices.layer));

/** A process runner that records each call: osascript succeeds and every other command fails to start. */
const recordingProcess = () => {
  const calls: Array<RunInput> = [];
  const process = FactoryProcess.of({
    run: (input) => {
      calls.push(input);
      return input.command === "osascript"
        ? Effect.succeed(reply(0, ""))
        : Effect.fail(new RunSpawnError({ shell: false, cause: new Error("gh not found") }));
    },
  });
  return { calls, process };
};

it.effect("logs that there is no config when the machine file does not exist", () =>
  Effect.gen(function* () {
    const { logs, machineConfigPath, events } = yield* logsFor(undefined);
    assert.deepStrictEqual(logs, [`no factory config at ${machineConfigPath}`]);
    assert.deepStrictEqual(events, []);
  }),
);

// The status goes to every client that can read, so its reason names no path and no error:
// those stay in the server log.
it.effect("reports itself idle, and why, when there is no config", () =>
  Effect.gen(function* () {
    const { status } = yield* logsFor(undefined);
    assert.deepStrictEqual(status, { state: "idle", reason: "no factory config" });
  }),
);

it.effect("logs runner started once for a valid machine file, then runs the first pass", () =>
  Effect.gen(function* () {
    const { logs, events, status } = yield* logsFor(VALID);
    assert.strictEqual(logs[0], "runner started");
    // The pass found no gh: the repo's config could not be read, and the pass said so and ended.
    assert.ok(
      logs.some((line) => line.startsWith("error: a/b: project config not loaded")),
      logs.join("\n"),
    );
    assert.strictEqual(logs.at(-1), "pass done: 0 runs, 0 claimed, 1 errors, 0 need attention");
    assert.deepStrictEqual(status, {
      state: "running",
      settings: { pollSeconds: 60, maxConcurrentRuns: 1, repos: ["a/b"] },
    });
    assert.deepStrictEqual(events, ["pass_started", "repo_skipped", "pass_finished"]);
  }),
);

// A file from before the move to Paradev still names the model: the runner starts on it and says,
// once per key, that the key does nothing now.
it.effect("logs one warning per retired model key and still starts", () =>
  Effect.gen(function* () {
    const { logs, machineConfigPath, status } = yield* logsFor(
      `${VALID}model_instance: claudeAgent\nmodel: claude-sonnet-5-5\n`,
    );
    const retired = "is no longer used: the model comes from the paradev block";
    assert.deepStrictEqual(logs.slice(0, 3), [
      `${machineConfigPath}: model_instance: ${retired}`,
      `${machineConfigPath}: model: ${retired}`,
      "runner started",
    ]);
    assert.strictEqual(status.state, "running");
  }),
);

it.effect("logs one warning for each other retired key and still starts", () =>
  Effect.gen(function* () {
    const { logs, machineConfigPath, status } = yield* logsFor(
      `${VALID}prune_branches_after_days: 14\nprune_branches_dry_run: false\ndeploy_wait_minutes: 120\nkeep_versions: 3\n`,
    );
    const noPrune = "is no longer used: the runner prunes no branch";
    const noDeploy = "is no longer used: the runner has no autodeploy";
    assert.deepStrictEqual(logs.slice(0, 5), [
      `${machineConfigPath}: prune_branches_after_days: ${noPrune}`,
      `${machineConfigPath}: prune_branches_dry_run: ${noPrune}`,
      `${machineConfigPath}: deploy_wait_minutes: ${noDeploy}`,
      `${machineConfigPath}: keep_versions: ${noDeploy}`,
      "runner started",
    ]);
    assert.strictEqual(status.state, "running");
  }),
);

it.effect("logs each config error and does not start for an invalid machine file", () =>
  Effect.gen(function* () {
    // The notification for the config item goes to a runner that accepts it, so it logs nothing.
    const { logs, machineConfigPath } = yield* logsFor(
      INVALID,
      () => Effect.void,
      recordingProcess().process,
    );
    assert.deepStrictEqual(logs, [`${machineConfigPath}: ${MISSING}`]);
  }),
);

it.effect("reports itself idle, without the config errors, when the machine file is invalid", () =>
  Effect.gen(function* () {
    const { status } = yield* logsFor(INVALID);
    assert.deepStrictEqual(status, { state: "idle", reason: "factory config failed to load" });
  }),
);

describe("attention", () => {
  /** Builds the runtime over `dirs`, and reads the open items while it runs. */
  const itemsAfterStart = (dirs: FactoryPathsService, process: FactoryProcess["Service"]) =>
    Effect.scoped(
      runtimeOver(dirs, withParadev(newParadev(), process)).pipe(
        Effect.flatMap(({ attention }) => attention.list()),
      ),
    );

  it.effect("a machine config that does not load raises one config item and one notification", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dirs = yield* dirWith(INVALID);
        const { calls, process } = recordingProcess();
        const items = yield* itemsAfterStart(dirs, process);
        assert.deepStrictEqual(
          items.map((item) => [item.id, item.kind, item.repo]),
          [["config", "config", null]],
        );
        assert.include(items[0]!.message, MISSING);
        assert.strictEqual(calls.length, 1);
        assert.strictEqual(calls[0]!.command, "osascript");
        assert.strictEqual(calls[0]!.args![0], "-e");
        assert.include(calls[0]!.args![1]!, "on run argv");
        assert.strictEqual(calls[0]!.args![2], "factory");
        assert.strictEqual(calls[0]!.args![3], items[0]!.message);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("a config that loads clears the config item an earlier start left", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const seed = JSON.stringify({
          items: [
            {
              id: "config",
              kind: "config",
              repo: null,
              issue: null,
              run: null,
              message: "machine config not loaded: x",
              first_seen: "2026-10-07T13:33:20.000Z",
            },
          ],
        });
        const dirs = yield* dirWith(VALID);
        yield* (yield* FileSystem.FileSystem).writeFileString(
          NodePath.join(dirs.factoryDir, "attention.json"),
          seed,
        );
        const { calls, process } = recordingProcess();
        assert.deepStrictEqual(yield* itemsAfterStart(dirs, process), []);
        assert.strictEqual(calls.filter((call) => call.command === "osascript").length, 0);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("a restart over the same files notifies nothing again and still lists the item", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dirs = yield* dirWith(INVALID);
        const first = recordingProcess();
        const second = recordingProcess();
        yield* itemsAfterStart(dirs, first.process);
        const items = yield* itemsAfterStart(dirs, second.process);
        assert.strictEqual(first.calls.length, 1);
        assert.strictEqual(second.calls.length, 0);
        assert.deepStrictEqual(
          items.map((item) => item.id),
          ["config"],
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  /** Wakes the loop until a `pass-errors` item is open, for a config whose every pass errors (no gh). */
  const untilPassErrors = (config: string) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { calls, process } = recordingProcess();
        const { loop, attention, factoryDir } = yield* started(config, process);
        const open = () =>
          attention
            .list()
            .pipe(Effect.map((items) => items.filter((item) => item.id === "pass-errors")));
        const openIds = () =>
          attention.list().pipe(Effect.map((items) => items.map((item) => item.id).sort()));
        // Each wake is one more pass; the waits for a pass are bounded, so a pass that never ends
        // fails the test instead of hanging it.
        yield* idleAfter(loop, factoryDir, 1);
        let reached = false;
        for (let pass = 0; pass < 10 && !reached; pass++) {
          reached = (yield* open()).length > 0;
          if (!reached) yield* onePassMore(loop, factoryDir);
        }
        assert.isTrue(reached, "no pass-errors item was raised");
        return {
          items: yield* open(),
          openIds: yield* openIds(),
          osascript: calls.filter((c) => c.command === "osascript"),
        };
      }),
    ).pipe(Effect.provide(NodeServices.layer));

  it.effect(
    "passes that keep erroring raise a pass-errors item and one notification per item",
    () =>
      Effect.gen(function* () {
        const { items, openIds, osascript } = yield* untilPassErrors(VALID);
        assert.include(items[0]!.message, "3 times in a row");
        assert.include(items[0]!.message, "a/b: project config not loaded");
        // The same three passes also raise the config-not-loaded item; each posts once.
        assert.deepStrictEqual(openIds, ["config-not-loaded:a/b", "pass-errors"]);
        assert.strictEqual(osascript.length, 2);
      }),
  );

  it.effect("notify: false keeps the item and posts nothing", () =>
    Effect.gen(function* () {
      const { items, osascript } = yield* untilPassErrors(`${VALID}notify: false\n`);
      assert.strictEqual(items.length, 1);
      assert.strictEqual(osascript.length, 0);
    }),
  );
});

it.effect("clears the gate locks a dead server left and nothing else under gates", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { logs, gates } = yield* logsFor(VALID, (factoryDir) =>
      Effect.gen(function* () {
        const gatesDir = NodePath.join(factoryDir, "gates");
        yield* fs.makeDirectory(gatesDir);
        yield* fs.writeFileString(NodePath.join(gatesDir, "a.lock"), "");
        yield* fs.writeFileString(NodePath.join(gatesDir, "b.lock"), "");
        yield* fs.writeFileString(NodePath.join(gatesDir, "notes.txt"), "keep");
      }),
    );
    assert.deepStrictEqual(logs.slice(0, 2), ["cleared 2 gate lock(s)", "runner started"]);
    assert.deepStrictEqual(gates, ["notes.txt"]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("logs each pass line as it is decided, so a pass that dies has said what it did", () =>
  Effect.gen(function* () {
    // The first repo's gh fails, which is a pass line; the second's call is a defect, which ends the pass.
    let calls = 0;
    const dying = FactoryProcess.of({
      run: () => {
        calls += 1;
        return calls === 1
          ? Effect.fail(new RunSpawnError({ shell: false, cause: new Error("gh not found") }))
          : Effect.die(new Error("boom"));
      },
    });
    const { logs } = yield* logsFor(
      configFor([
        ["a/b", "/b"],
        ["c/d", "/d"],
      ]),
      () => Effect.void,
      dying,
    );
    assert.ok(
      logs.some((line) => line.startsWith("error: a/b: project config not loaded")),
      logs.join("\n"),
    );
    assert.ok(logs.includes("factory pass failed"), logs.join("\n"));
  }),
);

describe("on the Paradev CLI", () => {
  it.effect("logs runner started once, at the first pass, and not on later passes or a reload", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { loop, logs, factoryDir, logLayer } = yield* started(VALID);
        const startedLines = () => logs.filter((line) => line === "runner started").length;
        yield* idleAfter(loop, factoryDir, 1);
        assert.strictEqual(startedLines(), 1);
        assert.isBelow(
          logs.indexOf("runner started"),
          logs.findIndex((line) => line.startsWith("pass done:")),
        );
        yield* onePassMore(loop, factoryDir);
        yield* loop.reload.pipe(Effect.provide(logLayer));
        yield* idleAfter(loop, factoryDir, 3);
        assert.strictEqual(finishedPasses(factoryDir), 3);
        assert.ok(logs.includes("factory config reloaded"), logs.join("\n"));
        assert.strictEqual(startedLines(), 1);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("the belt page: the first pass publishes it, and each pass hands the belt to the writer", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const paradev = newParadev();
        const pages: Array<ReadonlyArray<string>> = [];
        paradev.pages = (argv) => {
          pages.push(argv);
          // Paradev answers with the visibility it gave the page: the one asked for.
          return argv[1] === "publish"
            ? reply(0, JSON.stringify({ ...JSON.parse(readFixture("pages-publish-probe-ws").stdout), visibility: "org" }))
            : reply(0, readFixture("pages-storage-set-belt").stdout);
        };
        const belt = `paradev:\n  agent: claude\n  cli: ${CLI}\n  belt:\n    visibility: org\n`;
        const { loop, factoryDir } = yield* started(configFor([["a/b", "/b"]], "/gh", "", belt), noGhProcess, {}, paradev);
        yield* waitUntil("the belt write", () => pages.some((argv) => argv[1] === "storage"));
        const publish = pages[0]!;
        assert.deepStrictEqual(publish.slice(0, 2), ["pages", "publish"]);
        assert.strictEqual(publish[2], NodePath.join(factoryDir, "belt-page", "index.html"));
        assert.notInclude(publish, "--workspace");
        // The visibility the config names.
        assert.deepStrictEqual(publish.slice(publish.indexOf("--visibility"), publish.indexOf("--visibility") + 2), [
          "--visibility",
          "org",
        ]);
        const set = pages.find((argv) => argv[1] === "storage")!;
        assert.deepStrictEqual(set.slice(0, 8), [
          "pages",
          "storage",
          "30c684ae-67ab-41c9-b673-cdacc8d5254e",
          "--key",
          "belt",
          "--scope",
          "shared",
          "--set",
        ]);
        const written = JSON.parse(set[8]!) as {
          v: number;
          runner: { version: string; paradevCli: string; paradevOnline: boolean; claimsPaused: boolean };
        };
        assert.strictEqual(written.v, 1);
        assert.strictEqual(written.runner.paradevCli, "2.0.8");
        assert.isTrue(written.runner.paradevOnline);
        assert.isFalse(written.runner.claimsPaused);
        // A later pass publishes nothing and hands its own belt over: its pass time is new.
        yield* idleAfter(loop, factoryDir, 1);
        const writes = () => pages.filter((argv) => argv[1] === "storage");
        const before = writes().length;
        yield* onePassMore(loop, factoryDir);
        yield* waitUntil("the second belt write", () => writes().length > before);
        assert.strictEqual(pages.filter((argv) => argv[1] === "publish").length, 1);
        const second = JSON.parse(writes().at(-1)![8]!) as { runner: { lastPassAt: string } };
        assert.notStrictEqual(second.runner.lastPassAt, (JSON.parse(set[8]!) as { runner: { lastPassAt: string } }).runner.lastPassAt);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("the belt says when Paradev is offline and when claims are paused by hand", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const paradev = newParadev();
        const writes: Array<{ runner: { paradevOnline: boolean; claimsPaused: boolean } }> = [];
        paradev.pages = (argv) => {
          if (argv[1] === "publish") return reply(0, readFixture("pages-publish-probe-ws").stdout);
          writes.push(JSON.parse(argv[8]!) as (typeof writes)[number]);
          return reply(0, readFixture("pages-storage-set-belt").stdout);
        };
        const belt = `paradev:\n  agent: claude\n  cli: ${CLI}\n`;
        const { loop, factoryDir } = yield* started(configFor([["a/b", "/b"]], "/gh", "", belt), noGhProcess, {}, paradev);
        yield* idleAfter(loop, factoryDir, 1);
        yield* waitUntil("the first belt write", () => writes.length > 0);
        assert.deepStrictEqual(
          { online: writes[0]!.runner.paradevOnline, paused: writes[0]!.runner.claimsPaused },
          { online: true, paused: false },
        );
        paradev.down = "Host service for this machine isn't running";
        pauseClaims(factoryDir, Date.now());
        const before = writes.length;
        yield* onePassMore(loop, factoryDir);
        yield* waitUntil("the next belt write", () => writes.length > before);
        assert.deepStrictEqual(
          { online: writes.at(-1)!.runner.paradevOnline, paused: writes.at(-1)!.runner.claimsPaused },
          { online: false, paused: true },
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("a reload that narrows the belt's visibility moves the page before any belt goes to it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const paradev = newParadev();
        const pages: Array<ReadonlyArray<string>> = [];
        paradev.pages = (argv) => {
          pages.push(argv);
          // Paradev keeps the page at org, whatever a later publish asks for.
          return argv[1] === "publish"
            ? reply(0, JSON.stringify({ ...JSON.parse(readFixture("pages-publish-probe-ws").stdout), visibility: "org" }))
            : reply(0, readFixture("pages-storage-set-belt").stdout);
        };
        const beltAt = (visibility: string) =>
          configFor([["a/b", "/b"]], "/gh", "", `paradev:\n  agent: claude\n  cli: ${CLI}\n  belt:\n    visibility: ${visibility}\n`);
        const { loop, factoryDir, write, logLayer } = yield* started(beltAt("org"), noGhProcess, {}, paradev);
        yield* waitUntil("the first belt write", () => pages.some((argv) => argv[1] === "storage"));
        yield* idleAfter(loop, factoryDir, 1);
        const before = pages.length;
        yield* write(beltAt("just_me"));
        yield* loop.reload.pipe(Effect.provide(logLayer));
        yield* waitUntil("the publish after the reload", () => pages.length > before);
        yield* idleAfter(loop, factoryDir, 2);
        const after = pages.slice(before);
        const publish = after[0]!;
        assert.deepStrictEqual(publish.slice(0, 2), ["pages", "publish"]);
        assert.deepStrictEqual(publish.slice(publish.indexOf("--page"), publish.indexOf("--page") + 2), [
          "--page",
          "30c684ae-67ab-41c9-b673-cdacc8d5254e",
        ]);
        assert.deepStrictEqual(publish.slice(publish.indexOf("--visibility"), publish.indexOf("--visibility") + 2), [
          "--visibility",
          "just_me",
        ]);
        // Paradev answered org: the page gets no belt meant for just_me.
        assert.deepStrictEqual(
          after.filter((argv) => argv[1] === "storage"),
          [],
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("a belt write that hangs holds up no pass, starts no second write, and does not hold the shutdown", () =>
    Effect.gen(function* () {
      const paradev = newParadev();
      paradev.pages = () => reply(0, readFixture("pages-publish-probe-ws").stdout);
      paradev.hangs = (argv) => argv[0] === "pages" && argv[1] === "storage";
      const sets = () => paradev.calls.filter((argv) => argv[0] === "pages" && argv[1] === "storage").length;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const belt = `paradev:\n  agent: claude\n  cli: ${CLI}\n`;
          const { loop, factoryDir } = yield* started(configFor([["a/b", "/b"]], "/gh", "", belt), noGhProcess, {}, paradev);
          yield* waitUntil("the belt write", () => sets() === 1);
          yield* idleAfter(loop, factoryDir, 1);
          yield* onePassMore(loop, factoryDir);
          yield* onePassMore(loop, factoryDir);
          assert.strictEqual(sets(), 1);
        }),
      );
      // The scope closed with the write still hanging: the shutdown did not wait for it.
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("a pass that dies still hands the belt over, and three in a row put pass-errors on it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const paradev = newParadev();
        // The CLI check throws inside the process call, so every pass dies.
        paradev.schema = () => {
          throw new Error("the scripted schema broke");
        };
        const writes: Array<{ attention: Array<{ id: string; text: string }> }> = [];
        paradev.pages = (argv) => {
          if (argv[1] === "publish") return reply(0, readFixture("pages-publish-probe-ws").stdout);
          writes.push(JSON.parse(argv[8]!) as (typeof writes)[number]);
          return reply(0, readFixture("pages-storage-set-belt").stdout);
        };
        const belt = `paradev:\n  agent: claude\n  cli: ${CLI}\n`;
        const { loop, logs } = yield* started(configFor([["a/b", "/b"]], "/gh", "", belt), noGhProcess, {}, paradev);
        for (let n = 1; n <= 3; n++) {
          yield* waitUntil(`belt write ${n}`, () => writes.length >= n);
          if (n < 3) yield* loop.wake;
        }
        // The passes died: none got as far as its last line.
        assert.ok(logs.includes("factory pass failed"), logs.join("\n"));
        assert.notOk(logs.some((line) => line.startsWith("pass done:")), logs.join("\n"));
        assert.deepInclude(writes.at(-1)!.attention.map((item) => [item.id, item.text]), [
          "pass-errors",
          "The last passes failed; the runner log says why.",
        ]);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("a belt write that fails is a warning in the log and no pass error", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const paradev = newParadev();
        paradev.pages = (argv) =>
          argv[1] === "publish"
            ? reply(0, readFixture("pages-publish-probe-ws").stdout)
            : reply(1, "", "Error: A stored value is at most 65536 bytes\n");
        const belt = `paradev:\n  agent: claude\n  cli: ${CLI}\n`;
        const { loop, logs, factoryDir } = yield* started(configFor([["a/b", "/b"]], "/gh", "", belt), noGhProcess, {}, paradev);
        yield* idleAfter(loop, factoryDir, 1);
        yield* waitUntil("the belt warning", () => logs.some((line) => line.includes("65536 bytes")));
        assert.deepStrictEqual(eventsOf(factoryDir, "error"), []);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("with the belt off, no pass publishes or writes a belt", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const paradev = newParadev();
        // Answered, so a call made despite the flag is recorded rather than dying unseen in the belt's fiber.
        paradev.pages = (argv) =>
          argv[1] === "publish"
            ? reply(0, readFixture("pages-publish-probe-ws").stdout)
            : reply(0, readFixture("pages-storage-set-belt").stdout);
        const off = `paradev:\n  agent: claude\n  cli: ${CLI}\n  belt:\n    enabled: false\n`;
        const { loop, factoryDir } = yield* started(configFor([["a/b", "/b"]], "/gh", "", off), noGhProcess, {}, paradev);
        yield* idleAfter(loop, factoryDir, 1);
        yield* onePassMore(loop, factoryDir);
        // Long enough for a forked write to have been made.
        yield* realDelay(200);
        assert.deepStrictEqual(
          paradev.calls.filter((argv) => argv[0] === "pages"),
          [],
        );
        assert.isFalse(NodeFS.existsSync(NodePath.join(factoryDir, "belt.json")));
        assert.isFalse(NodeFS.existsSync(NodePath.join(factoryDir, "belt-page")));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("runner started is not logged for a factory with no config to run on", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { loop, logs, write, factoryDir, logLayer } = yield* started(undefined);
        yield* loop.wake;
        assert.deepStrictEqual(logs.filter((line) => line === "runner started"), []);
        yield* write(VALID);
        yield* loop.reload.pipe(Effect.provide(logLayer));
        yield* idleAfter(loop, factoryDir, 1);
        assert.deepStrictEqual(logs.filter((line) => line === "runner started"), ["runner started"]);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "a superset status that fails holds the claims each pass, and the item comes with the 3rd pass",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const paradev = newParadev();
          paradev.down = "Host service for this machine isn't running";
          const { loop, attention, logs, factoryDir } = yield* started(VALID, noGhProcess, {}, paradev);
          const held = () =>
            eventsOf(factoryDir, "claim_skipped").filter(
              (entry) => (entry.data as { reason?: string }).reason === "paradev-offline",
            ).length;
          const item = () =>
            attention.list().pipe(
              Effect.map((items) => items.filter((open) => open.id === PARADEV_OFFLINE_ITEM_ID)),
            );
          yield* idleAfter(loop, factoryDir, 1);
          for (let pass = 1; pass <= PARADEV_HOLD_PASSES; pass++) {
            if (pass > 1) yield* onePassMore(loop, factoryDir);
            // One held pass is one claim_skipped; nothing is claimed.
            assert.strictEqual(held(), pass);
            assert.strictEqual(eventsOf(factoryDir, "claimed").length, 0);
            assert.strictEqual((yield* item()).length, pass < PARADEV_HOLD_PASSES ? 0 : 1, `pass ${pass}`);
          }
          assert.ok(
            logs.some((line) => line.startsWith("paradev offline: ") && line.includes("isn't running")),
            logs.join("\n"),
          );
          // The hold keeps its one item through more passes, and the pass Paradev answers ends it.
          yield* onePassMore(loop, factoryDir);
          assert.strictEqual((yield* item()).length, 1);
          paradev.down = null;
          yield* onePassMore(loop, factoryDir);
          assert.strictEqual((yield* item()).length, 0);
          assert.strictEqual(held(), PARADEV_HOLD_PASSES + 1);
          // The schema check passed once, so no later pass ran it again.
          assert.strictEqual(paradev.calls.filter((argv) => argv[0] === "schema").length, 1);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );

  for (const [error, message] of [
    [
      "Host service for this machine isn't running",
      "Paradev is offline: no issue has been claimed for 3 passes; open the Paradev app, or start its host service (superset status fails)",
    ],
    [
      "Not logged in",
      "Paradev is signed out: no issue has been claimed for 3 passes; run superset auth login",
    ],
    [
      "No active organization",
      "Paradev is signed out: no issue has been claimed for 3 passes; run superset auth login",
    ],
  ] as const) {
    it.effect(`superset status failing with "${error}" raises the item that says what to do`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const paradev = newParadev();
          paradev.down = error;
          const { loop, attention, factoryDir } = yield* started(VALID, noGhProcess, {}, paradev);
          yield* idleAfter(loop, factoryDir, 1);
          for (let pass = 2; pass <= PARADEV_HOLD_PASSES; pass++) yield* onePassMore(loop, factoryDir);
          assert.deepStrictEqual(
            (yield* attention.list())
              .filter((open) => open.id === PARADEV_OFFLINE_ITEM_ID)
              .map((open) => open.message),
            [message],
          );
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  }

  it.effect("a project lookup that fails keeps the repo and its open no-paradev-project item", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const paradev = newParadev([C_D_PROJECT]);
        const { loop, attention, factoryDir } = yield* started(VALID, noGhProcess, {}, paradev);
        const items = () =>
          attention
            .list()
            .pipe(Effect.map((open) => open.filter((item) => item.id === "no-paradev-project:a/b")));
        yield* idleAfter(loop, factoryDir, 1);
        const before = yield* items();
        assert.strictEqual(before.length, 1);
        const skipped = () =>
          eventsOf(factoryDir, "claim_skipped").filter(
            (entry) => (entry.data as { reason?: string }).reason === "no-paradev-project",
          ).length;
        assert.strictEqual(skipped(), 1);
        assert.deepStrictEqual(loop.status, {
          state: "running",
          settings: { pollSeconds: 60, maxConcurrentRuns: 1, repos: [] },
        });
        paradev.listDown = "Host service for this machine isn't running";
        yield* onePassMore(loop, factoryDir);
        assert.deepStrictEqual(yield* items(), before);
        // The repo is kept on the pass, not skipped again as no project.
        assert.strictEqual(skipped(), 1);
        assert.deepStrictEqual(loop.status, {
          state: "running",
          settings: { pollSeconds: 60, maxConcurrentRuns: 1, repos: ["a/b"] },
        });
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("a repo taken out of repos: has departed: its items clear, after a reload or a restart", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const paradev = newParadev([C_D_PROJECT]);
        const both = configFor([
          ["a/b", "/b"],
          ["c/d", "/d"],
        ]);
        const { loop, attention, factoryDir, write, logLayer, paths } = yield* started(
          both,
          noGhProcess,
          {},
          paradev,
        );
        const aItems = () =>
          attention.list().pipe(Effect.map((open) => open.filter((item) => item.repo === "a/b")));
        yield* idleAfter(loop, factoryDir, 1);
        assert.strictEqual((yield* aItems()).length, 1);
        // Taken out and reloaded: the next pass clears a/b's item.
        yield* write(configFor([["c/d", "/d"]]));
        yield* loop.reload.pipe(Effect.provide(logLayer));
        yield* idleAfter(loop, factoryDir, 2);
        assert.deepStrictEqual(yield* aItems(), []);
        // A restart with a/b gone from the file finds an item a/b left behind and clears it too.
        yield* attention.raise({
          id: "run:a__b__1__1:stuck",
          kind: "stuck",
          repo: "A/B",
          issue: 1,
          run: "a__b__1__1",
          message: "a/b#1 stuck",
        });
        yield* Effect.scoped(
          Effect.gen(function* () {
            const again = yield* runtimeOver(paths, withParadev(paradev, noGhProcess), {});
            yield* idleAfter(again.loop, factoryDir, 3);
            assert.deepStrictEqual(
              (yield* again.attention.list()).filter((item) => item.repo?.toLowerCase() === "a/b"),
              [],
            );
          }),
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("a schema with no `agents explain` holds the claims, naming the version and the command", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const paradev = newParadev();
        const without = (list: unknown): unknown =>
          Array.isArray(list)
            ? list
                .filter(
                  (command: { path?: ReadonlyArray<string> }) =>
                    command.path?.join(" ") !== "agents explain",
                )
                .map((command: { commands?: unknown }) => ({
                  ...command,
                  ...(command.commands === undefined ? {} : { commands: without(command.commands) }),
                }))
            : list;
        paradev.schema = (answer) => ({
          ...(answer as object),
          commands: without((answer as { commands: unknown }).commands),
        });
        const { loop, attention, logs, factoryDir } = yield* started(VALID, noGhProcess, {}, paradev);
        yield* idleAfter(loop, factoryDir, 1);
        yield* onePassMore(loop, factoryDir);
        yield* onePassMore(loop, factoryDir);
        const hold = logs.find((line) => line.startsWith("paradev offline: "));
        assert.ok(hold?.includes("2.0.8") && hold.includes("agents explain"), logs.join("\n"));
        assert.strictEqual(
          eventsOf(factoryDir, "claim_skipped").filter(
            (entry) => (entry.data as { reason?: string }).reason === "paradev-offline",
          ).length,
          3,
        );
        const items = (yield* attention.list()).filter((item) => item.id === PARADEV_OFFLINE_ITEM_ID);
        assert.strictEqual(items.length, 1);
        assert.include(items[0]!.message, "2.0.8");
        assert.include(items[0]!.message, "agents explain");
        // A check that fails is run again each pass, and `status` waits for it to pass.
        assert.strictEqual(paradev.calls.filter((argv) => argv[0] === "schema").length, 3);
        assert.strictEqual(paradev.calls.filter((argv) => argv[0] === "status").length, 0);
        // The CLI is upgraded: the next pass runs on, and the item goes.
        paradev.schema = (answer) => answer;
        yield* onePassMore(loop, factoryDir);
        assert.strictEqual(paradev.calls.filter((argv) => argv[0] === "status").length, 1);
        assert.deepStrictEqual(
          (yield* attention.list()).filter((item) => item.id === PARADEV_OFFLINE_ITEM_ID),
          [],
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("a repo whose path is no Paradev project is skipped with one item, until the project appears", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const paradev = newParadev([C_D_PROJECT]);
        const { loop, attention, factoryDir } = yield* started(VALID, recordingProcess().process, {}, paradev);
        const itemId = "no-paradev-project:a/b";
        const skips = () =>
          eventsOf(factoryDir, "claim_skipped").filter(
            (entry) => (entry.data as { reason?: string }).reason === "no-paradev-project",
          );
        const items = () =>
          attention.list().pipe(Effect.map((open) => open.filter((item) => item.id === itemId)));
        yield* idleAfter(loop, factoryDir, 1);
        assert.deepStrictEqual(
          skips().map((entry) => entry.data),
          [{ repo: "a/b", reason: "no-paradev-project" }],
        );
        let open = yield* items();
        assert.strictEqual(open.length, 1);
        assert.strictEqual(open[0]!.repo, "a/b");
        assert.include(
          open[0]!.message,
          "superset projects create --local --name b --import /b",
        );
        // Another pass keeps the one item.
        yield* onePassMore(loop, factoryDir);
        assert.strictEqual(skips().length, 2);
        assert.strictEqual((yield* items()).length, 1);
        // The person adds the project: the repo is worked, and the item clears.
        paradev.projects.push(A_B_PROJECT);
        yield* onePassMore(loop, factoryDir);
        assert.strictEqual(skips().length, 2);
        assert.deepStrictEqual(yield* items(), []);
        assert.deepStrictEqual(loop.status, {
          state: "running",
          settings: { pollSeconds: 60, maxConcurrentRuns: 1, repos: ["a/b"] },
        });
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("a repo whose path is another GitHub repo's Paradev project is skipped with one item, until the path is fixed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // `/b` is the clone of c/d: a session for a/b there would work on c/d's code.
        const paradev = newParadev([projectAt("c/d", "/b")]);
        const { loop, attention, factoryDir } = yield* started(VALID, recordingProcess().process, {}, paradev);
        const skips = () =>
          eventsOf(factoryDir, "claim_skipped").filter(
            (entry) => (entry.data as { reason?: string }).reason === "paradev-project-repo",
          );
        const items = () =>
          attention.list().pipe(
            Effect.map((open) => open.filter((item) => item.id.startsWith("paradev-project-repo:a/b:"))),
          );
        yield* idleAfter(loop, factoryDir, 1);
        assert.deepStrictEqual(
          skips().map((entry) => entry.data),
          [{ repo: "a/b", reason: "paradev-project-repo" }],
        );
        let open = yield* items();
        assert.strictEqual(open.length, 1);
        assert.strictEqual(open[0]!.repo, "a/b");
        assert.include(open[0]!.message, "/b is the Paradev project of c/d");
        assert.deepStrictEqual(
          loop.status.state === "running" ? loop.status.settings.repos : null,
          [],
        );
        assert.strictEqual(open[0]!.id, "paradev-project-repo:a/b:c/d");
        // A project that names no GitHub repo is skipped the same way; its item replaces the first.
        paradev.projects = [{ ...projectAt("a/b", "/b"), repo: "-" }];
        yield* onePassMore(loop, factoryDir);
        assert.strictEqual(skips().length, 2);
        open = yield* items();
        assert.strictEqual(open.length, 1);
        assert.strictEqual(open[0]!.id, "paradev-project-repo:a/b:-");
        assert.include(open[0]!.message, "/b is the Paradev project of no GitHub repo");
        // The clone is a/b's, in another case: the repo is worked, and the item clears.
        paradev.projects = [projectAt("A/B", "/b")];
        yield* onePassMore(loop, factoryDir);
        assert.strictEqual(skips().length, 2);
        assert.deepStrictEqual(yield* items(), []);
        assert.deepStrictEqual(
          loop.status.state === "running" ? loop.status.settings.repos : null,
          ["a/b"],
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("a repo whose project is gone, then another repo's, swaps its item", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const paradev = newParadev([C_D_PROJECT]);
        const { loop, attention, factoryDir } = yield* started(VALID, recordingProcess().process, {}, paradev);
        const ids = () =>
          attention.list().pipe(
            Effect.map((open) => open.filter((item) => item.repo === "a/b").map((item) => item.id)),
          );
        yield* idleAfter(loop, factoryDir, 1);
        assert.deepStrictEqual(yield* ids(), ["no-paradev-project:a/b"]);
        paradev.projects.push(projectAt("c/d", "/b"));
        yield* onePassMore(loop, factoryDir);
        assert.deepStrictEqual(yield* ids(), ["paradev-project-repo:a/b:c/d"]);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("one projects list a pass answers every repo in repos:", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { loop, factoryDir, paradev } = yield* started(
          configFor([
            ["a/b", "/b"],
            ["c/d", "/d"],
          ]),
        );
        const lists = () => paradev.calls.filter((argv) => argv.join(" ") === "projects list --local").length;
        yield* idleAfter(loop, factoryDir, 1);
        assert.strictEqual(lists(), 1);
        yield* onePassMore(loop, factoryDir);
        assert.strictEqual(lists(), 2);
        assert.deepStrictEqual(
          loop.status.state === "running" ? loop.status.settings.repos : null,
          ["a/b", "c/d"],
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("each pass sweeps the cloud for orphans beside the pass while a repo names an environment, and never otherwise", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const sweeps = (calls: ReadonlyArray<ReadonlyArray<string>>) =>
          calls.filter((argv) => argv.join(" ") === "workspaces list --host cloud").length;
        const cloudBlock = "cloud:\n  proxy: https://proxy.example\n";
        const named = `gh_config_dir: /gh\nmax_concurrent_runs: 1\nmin_free_gib: 0\n${cloudBlock}repos:\n  - repo: a/b\n    path: /b\n    cloud: edad9805-e48d-40f3-a06c-e19a4105f974\n${PARADEV_BLOCK}`;
        const cloud = yield* started(named);
        yield* idleAfter(cloud.loop, cloud.factoryDir, 1);
        yield* waitUntil("the first sweep", () => sweeps(cloud.paradev.calls) === 1);
        yield* onePassMore(cloud.loop, cloud.factoryDir);
        yield* waitUntil("the second sweep", () => sweeps(cloud.paradev.calls) === 2);
        // A cloud block with no repo naming an environment has nothing of its own to sweep.
        const none = yield* started(configFor([["a/b", "/b"]], "/gh", cloudBlock));
        yield* idleAfter(none.loop, none.factoryDir, 1);
        yield* onePassMore(none.loop, none.factoryDir);
        assert.strictEqual(sweeps(none.paradev.calls), 0);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("a repo that is not a Paradev project is left out of the status's repos", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { loop, factoryDir } = yield* started(
          configFor([
            ["a/b", "/b"],
            ["c/d", "/d"],
          ]),
          noGhProcess,
          {},
          newParadev([C_D_PROJECT]),
        );
        yield* idleAfter(loop, factoryDir, 1);
        assert.deepStrictEqual(
          loop.status.state === "running" ? loop.status.settings.repos : null,
          ["c/d"],
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  describe("the pass world's projectModel", () => {
    const modelFor = (paradevBlock: string) =>
      Effect.scoped(
        Effect.gen(function* () {
          const worlds: Array<PassWorld> = [];
          const config = configFor([["a/b", "/b"]], "/gh", "", paradevBlock);
          const { loop, factoryDir, paradev } = yield* started(config, noGhProcess, {
            onWorld: (world) => worlds.push(world),
          });
          yield* idleAfter(loop, factoryDir, 1);
          const calls = paradev.calls.length;
          const model = yield* worlds[0]!.projectModel({
            watched: A_B,
            project: timeLimitOnlyProjectConfig(),
            trackerUser: "rawphp",
          });
          // The model is the paradev block's, whatever the project: no CLI call reads it.
          assert.strictEqual(paradev.calls.length, calls);
          return model;
        }),
      ).pipe(Effect.provide(NodeServices.layer));

    it.effect("is the agent, model and effort of the paradev block", () =>
      Effect.gen(function* () {
        assert.deepStrictEqual(
          yield* modelFor(`${PARADEV_BLOCK}  model: opus\n  effort: high\n`),
          { instanceId: "claude", model: "opus", options: [{ id: "effort", value: "high" }] },
        );
      }),
    );

    it.effect("is the agent with an empty model when the block has no model or effort", () =>
      Effect.gen(function* () {
        assert.deepStrictEqual(yield* modelFor(PARADEV_BLOCK), { instanceId: "claude", model: "" });
      }),
    );
  });
});

describe("the default-branch reads of a runner clone", () => {
  const cloneDirs = useTempDirs();
  const git = (cwd: string, ...args: Array<string>) =>
    NodeChildProcess.execFileSync("git", args, { cwd, encoding: "utf8" });
  const PACKAGE_JSON = '{"scripts":{"test":"vitest"}}\n';

  /** A clone of a repo whose `main` holds a package.json and an npm lockfile, with `origin/HEAD`. */
  const cloneWithManifests = () => {
    const origin = cloneDirs("origin");
    git(origin, "init", "-q", "-b", "main");
    NodeFS.writeFileSync(NodePath.join(origin, "package.json"), PACKAGE_JSON);
    NodeFS.writeFileSync(NodePath.join(origin, "package-lock.json"), "{}\n");
    git(origin, "add", ".");
    git(origin, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "manifests");
    const clone = NodePath.join(cloneDirs("clone"), "repo");
    git(origin, "clone", "-q", origin, clone);
    return clone;
  };

  const readsOf = (root: string) =>
    defaultedFiles(Effect.runSync(Effect.provide(FactoryProcess, processLayer)), root);

  it.effect("reads origin/HEAD's branch and root manifests, not the working tree's", () =>
    Effect.gen(function* () {
      const clone = cloneWithManifests();
      // A session's edit in the clone's working tree is not the default branch.
      NodeFS.writeFileSync(NodePath.join(clone, "package.json"), "{}\n");
      NodeFS.writeFileSync(NodePath.join(clone, "composer.json"), "{}\n");
      assert.deepStrictEqual(yield* readsOf(clone), {
        head: {
          branch: "main",
          files: { packageJson: PACKAGE_JSON, composerJson: null, lockfiles: ["package-lock.json"] },
        },
      });
    }),
  );

  it.effect("a clone with no origin/HEAD has no default branch to read", () =>
    Effect.gen(function* () {
      const root = cloneDirs("no-origin");
      git(root, "init", "-q", "-b", "main");
      assert.deepStrictEqual(yield* readsOf(root), { head: null });
    }),
  );

  /** git answers by its argv after `-C <root>`; anything unscripted fails to start. */
  const scriptedGit = (answers: Record<string, Partial<RunResult>>) =>
    FactoryProcess.of({
      run: (input) => {
        const answer = answers[(input.args ?? []).slice(2).join(" ")];
        return answer === undefined
          ? Effect.fail(new RunSpawnError({ shell: false, cause: new Error("not scripted") }))
          : Effect.succeed({ ...reply(0, ""), ...answer });
      },
    });
  const HEAD = { "rev-parse --abbrev-ref origin/HEAD": { tail: "origin/main\n" } };
  const TREE = { "ls-tree --name-only origin/HEAD": { tail: "package.json\npackage-lock.json\n" } };

  for (const [what, answers] of [
    ["the head read does not finish", { "rev-parse --abbrev-ref origin/HEAD": { timedOut: true } }],
    ["the tree read fails", { ...HEAD, "ls-tree --name-only origin/HEAD": { exitCode: 128 } }],
    ["a manifest the tree lists cannot be shown", { ...HEAD, ...TREE, "show origin/HEAD:package.json": { exitCode: 128 } }],
    [
      "a manifest is longer than the read takes",
      { ...HEAD, ...TREE, "show origin/HEAD:package.json": { tail: "{", tailTruncated: true } },
    ],
  ] as const) {
    it.effect(`is unresolved when ${what}`, () =>
      Effect.gen(function* () {
        assert.strictEqual(yield* defaultedFiles(scriptedGit(answers), "/p"), "unresolved");
      }),
    );
  }

  it.effect("a repo whose reads are unresolved is left out of the pass, and the pass says so", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // /b reads whole; /d's package.json cannot be shown this pass.
        const other = FactoryProcess.of({
          run: (input) => {
            const args = input.args ?? [];
            if (input.command !== "git" || args[0] !== "-C") return noGhProcess.run(input);
            const step = args.slice(2).join(" ");
            if (step === "rev-parse --abbrev-ref origin/HEAD") return Effect.succeed(reply(0, "origin/main\n"));
            if (step === "ls-tree --name-only origin/HEAD") return Effect.succeed(reply(0, "package.json\n"));
            if (step === "show origin/HEAD:package.json") {
              return Effect.succeed(args[1] === "/b" ? reply(0, PACKAGE_JSON) : reply(128, "", "fatal: bad object\n"));
            }
            return noGhProcess.run(input);
          },
        });
        const { loop, logs, factoryDir } = yield* started(
          configFor(
            [
              ["a/b", "/b"],
              ["c/d", "/d"],
            ],
            "/gh",
            "default_project:\n  instructors: [rawphp]\n",
          ),
          other,
        );
        yield* idleAfter(loop, factoryDir, 1);
        assert.include(logs, "watched: 1 project(s) could not be settled this pass (/d)");
        assert.deepStrictEqual(
          loop.status.state === "running" ? loop.status.settings.repos : null,
          ["a/b"],
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("liveWorld", () => {
  it.effect("a new world built from the same shared state goes on counting the cloud proxy's misses", () =>
    Effect.gen(function* () {
      const shared = newShared();
      const scope = yield* Scope.make();
      const build = () =>
        liveWorld(
          machine,
          tempDir(),
          {} as never,
          NodeServices.layer,
          {} as never,
          () => NOW,
          "mac-mini",
          noAttention,
          { gate: { run: () => Effect.die("no gate") }, wake: Effect.void, scope },
          undefined,
          undefined,
          shared,
        );
      const first = build();
      first.proxyMisses.passes = 2;
      assert.strictEqual(build().proxyMisses.passes, 2);
    }),
  );

  const REPO = "rawphp/softfac";
  const NOW = Date.UTC(2026, 9, 8, 2, 0, 0);
  const MINUTE = 60 * 1000;
  const tempDir = useTempDirs();

  /** A process that answers gh by its arguments and records every call. */
  const ghWith = (answer: (args: ReadonlyArray<string>) => string | null) => {
    const calls: Array<ReadonlyArray<string>> = [];
    const process = FactoryProcess.of({
      run: (input: RunInput) => {
        const args = input.args ?? [];
        calls.push(args);
        const stdout = answer(args);
        return Effect.succeed({
          exitCode: stdout === null ? 1 : 0,
          timedOut: false,
          tail: stdout ?? "",
          stderrTail: stdout === null ? "gh: Server Error (HTTP 502)" : "",
          truncated: false,
            tailTruncated: false,
        } satisfies RunResult);
      },
    });
    return { process, calls };
  };

  const machine: MachineConfig = baseMachine;

  const worldOf = (process: FactoryProcess["Service"]) =>
    liveWorld(
      machine,
      "/factory-test/data",
      process,
      NodeServices.layer,
      stubSessions,
      () => NOW,
      "mac-mini",
      noAttention,
      {
        gate: { run: () => Effect.succeed({ _tag: "running" as const }) },
        wake: Effect.void,
        scope: Scope.makeUnsafe(),
      },
    );

  const repo: Repo = {
    watched: { repo: REPO, path: "/p" },
    project: timeLimitOnlyProjectConfig(),
    trackerUser: "rawphp",
  };

  const isList = (args: ReadonlyArray<string>, label: string) =>
    args[0] === "issue" && args[1] === "list" && args.includes(label);

  const ago = (ms: number) => utcSecond(NOW - ms);

  const SHA = "4f1c2d3e4a5b60718293a4b5c6d7e8f901234567";
  const pullView = (state: string, head: string, mergeable = "MERGEABLE") =>
    JSON.stringify({
      number: 12,
      isDraft: false,
      state,
      headRefName: "t3code/abc",
      isCrossRepository: false,
      baseRefName: "main",
      headRefOid: head,
      mergeable,
      createdAt: "2026-10-04T10:00:00Z",
    });

  it.effect(
    "a step is built for the base the pass hands it: advance binds the PR to that base",
    () =>
      Effect.gen(function* () {
        const dataDir = tempDir();
        const run = newRunId(REPO, "10", 1);
        const ledger = Ledger.create(dataDir, run, { clock: () => 1_000 });
        ledger.append(
          { event: "state_changed", data: { from: "triage", to: "building" } },
          makeCause("start", "seed"),
        );
        ledger.append(
          {
            event: "session_launched",
            data: {
              thread_id: "thread-1",
              worktree: "/t3/wt",
              branch: "t3code/abc",
              model_instance: null,
              model: null,
              model_options: null,
              resumed_from: null,
              base: "feature/x",
            },
          },
          makeCause("start", "seed"),
        );
        ledger.close();
        // The session is done and reported a pull request against `feature/x`, not `main`.
        const sessions = sessionsOf({
status: () =>
            Effect.succeed({
              worktreePath: "/t3/wt",
              branch: "t3code/abc",
              archived: false,
              run: "completed" as const,
              runOrdinal: 1,
              runStartedAt: null,
              runCompletedAt: null,
              lastAssistantMessage:
                "Built it.\nFACTORY-DONE: https://github.com/rawphp/softfac/pull/12",
            }),
        });
        const { process, calls } = ghWith((args) => {
          if (args[0] === "issue" && args[1] === "view") {
            return JSON.stringify({
              number: 10,
              title: "Build step",
              body: "Build it.\n\n## Base\n\nfeature/x\n",
              labels: [{ name: "factory:building" }],
              assignees: [{ login: "rawphp" }],
              state: "OPEN",
              author: { login: "rawphp" },
            });
          }
          if (args[0] === "pr" && args[1] === "view") {
            return JSON.stringify({
              number: 12,
              isDraft: true,
              state: "OPEN",
              headRefName: "t3code/abc",
              isCrossRepository: false,
              baseRefName: "feature/x",
              headRefOid: SHA,
              mergeable: "MERGEABLE",
              createdAt: "2026-10-04T10:00:00Z",
            });
          }
          return null;
        });
        const world = liveWorld(
          machine,
          dataDir,
          process,
          NodeServices.layer,
          sessions,
          () => NOW,
          "mac-mini",
          noAttention,
          {
            gate: { run: () => Effect.die("no gate") },
            wake: Effect.void,
            scope: yield* Scope.make(),
          },
        );
        // Built with the repo's base, the pull request would not bind and the run would go stuck,
        // which stops the session first: the stub's `archive` would die.
        assert.deepStrictEqual(yield* world.advance(repo, run, "feature/x"), {
          kind: "ready-for-gate",
          pr: 12,
          prUrl: "https://github.com/rawphp/softfac/pull/12",
        });
        assert.deepStrictEqual(
          calls.map((args) => args.slice(0, 2)),
          [
            ["issue", "view"],
            ["pr", "view"],
          ],
        );
      }),
  );

  it.effect(
    "an open pull request is read with its head in lower case and GitHub's mergeable state; one that ended is none",
    () =>
      Effect.gen(function* () {
        const open = ghWith(() => pullView("OPEN", SHA.toUpperCase()));
        assert.deepStrictEqual(yield* worldOf(open.process).openPull(repo, 12), {
          head: SHA,
          mergeable: "mergeable",
        });
        const conflicting = ghWith(() => pullView("OPEN", SHA, "CONFLICTING"));
        assert.deepStrictEqual(yield* worldOf(conflicting.process).openPull(repo, 12), {
          head: SHA,
          mergeable: "conflicting",
        });
        for (const state of ["MERGED", "CLOSED"]) {
          const ended = ghWith(() => pullView(state, SHA));
          assert.strictEqual(yield* worldOf(ended.process).openPull(repo, 12), null, state);
        }
      }),
  );

  it.effect("a pull request GitHub no longer has has no head, and a failed read is an error", () =>
    Effect.gen(function* () {
      const gone: FactoryProcess["Service"] = {
        run: () =>
          Effect.succeed({
            exitCode: 1,
            timedOut: false,
            tail: "",
            stderrTail: "GraphQL: Could not resolve to a PullRequest with the number of 12.",
            truncated: false,
            tailTruncated: false,
          } satisfies RunResult),
      };
      assert.strictEqual(yield* worldOf(gone).openPull(repo, 12), null);
      const broken = ghWith(() => null);
      assert.strictEqual(
        (yield* Effect.flip(worldOf(broken.process).openPull(repo, 12))).kind,
        "tracker",
      );
    }),
  );

  it.effect(
    "a ready issue anyone is assigned to is not listed, and each one keeps its labels",
    () =>
      Effect.gen(function* () {
        const { process } = ghWith((args) =>
          isList(args, "factory:ready")
            ? JSON.stringify([
                { number: 3, title: "c", assignees: [], labels: [{ name: "Postponed" }] },
                { number: 2, title: "b", assignees: [{ login: "eve" }], labels: [] },
                { number: 1, title: "a", assignees: [], labels: [] },
              ])
            : null,
        );
        const listing = yield* worldOf(process).readyIssues(repo);
        assert.deepStrictEqual(listing, {
          items: [
            { number: 1, labels: [] },
            { number: 3, labels: ["Postponed"] },
          ],
          cut: false,
        });
      }),
  );

  it.effect(
    "a triage issue is listed only when the factory's login, in any case, is its only assignee",
    () =>
      Effect.gen(function* () {
        const { process } = ghWith((args) =>
          isList(args, "factory:triage")
            ? JSON.stringify([
                { number: 4, title: "d", assignees: [{ login: "RawPhp" }], labels: [] },
                {
                  number: 5,
                  title: "e",
                  assignees: [{ login: "rawphp" }, { login: "eve" }],
                  labels: [],
                },
                { number: 6, title: "f", assignees: [{ login: "eve" }], labels: [] },
                { number: 7, title: "g", assignees: [], labels: [] },
              ])
            : null,
        );
        const listing = yield* worldOf(process).triageIssues(repo);
        assert.deepStrictEqual(listing, { items: [4], cut: false });
      }),
  );

  /** The unassigned triage issue `updatedAt` ago; its history read fails, so a read shows as a failure. */
  const unassignedUpdated = (updated: number) =>
    Effect.gen(function* () {
      const { process, calls } = ghWith((args) =>
        isList(args, "factory:triage")
          ? JSON.stringify([{ number: 9, assignees: [], updatedAt: ago(updated) }])
          : isList(args, "factory:building")
            ? "[]"
            : null,
      );
      const result = yield* Effect.result(
        worldOf(process).unassignedClaims(repo, new Set<number>()),
      );
      const historyRead = calls.some((args) => args[0] === "api" && args[1] === "graphql");
      return { result, historyRead };
    });

  it.effect("a claim changed within the last 15 minutes is not looked at", () =>
    Effect.gen(function* () {
      const { result, historyRead } = yield* unassignedUpdated(14 * MINUTE);
      assert.ok(result._tag === "Success" && result.success.claims.length === 0);
      assert.isFalse(historyRead);
    }),
  );

  it.effect("a claim unchanged for more than 15 minutes has its history read", () =>
    Effect.gen(function* () {
      const { historyRead } = yield* unassignedUpdated(16 * MINUTE);
      assert.isTrue(historyRead);
    }),
  );

  /** The approval history call, as `readHistory` sends it. */
  const isHistory = (args: ReadonlyArray<string>) => args[0] === "api" && args[1] === "graphql";

  /** A label added to the issue: its name, when, and by whom. */
  type Labeled = { readonly label: string; readonly at: string; readonly by?: string };

  /** A history whose only entries are these label events, oldest first, as the history read answers it. */
  const historyOf = (labeled: ReadonlyArray<Labeled>) =>
    JSON.stringify({
      data: {
        repository: {
          issue: {
            timelineItems: {
              totalCount: labeled.length,
              nodes: labeled.map(({ label, at, by }) => ({
                __typename: "LabeledEvent",
                createdAt: at,
                actor: { __typename: "User", login: by ?? "rawphp" },
                label: { name: label },
              })),
            },
            lastEditedAt: null,
            editor: null,
            userContentEdits: { totalCount: 0, nodes: [] },
          },
        },
      },
    });

  /** A label history in which `by` applied `factory:triage`. */
  const labelledByReply = (by: string) =>
    historyOf([{ label: "factory:triage", at: "2026-10-04T10:00:00Z", by }]);

  it.effect("a judgement that an issue is not the factory's lasts across passes of one world", () =>
    Effect.gen(function* () {
      const { process, calls } = ghWith((args) =>
        isList(args, "factory:triage")
          ? JSON.stringify([{ number: 9, assignees: [], updatedAt: ago(16 * MINUTE) }])
          : isList(args, "factory:building")
            ? "[]"
            : isHistory(args)
              ? labelledByReply("eve")
              : null,
      );
      const world = worldOf(process);
      const first = yield* world.unassignedClaims(repo, new Set<number>());
      const second = yield* world.unassignedClaims(repo, new Set<number>());
      assert.deepStrictEqual(first.claims, []);
      assert.deepStrictEqual(second.claims, []);
      assert.strictEqual(calls.filter(isHistory).length, 1);
    }),
  );

  it.effect(
    "a history read that fails is reported to the pass with the issue and the message",
    () =>
      Effect.gen(function* () {
        const { process } = ghWith((args) =>
          isList(args, "factory:triage")
            ? JSON.stringify([{ number: 9, assignees: [], updatedAt: ago(16 * MINUTE) }])
            : isList(args, "factory:building")
              ? "[]"
              : null,
        );
        const result = yield* worldOf(process).unassignedClaims(repo, new Set<number>());
        assert.deepStrictEqual(result.claims, []);
        assert.strictEqual(result.unread.length, 1);
        const unread = result.unread[0]!;
        assert.strictEqual(unread.issue, 9);
        assert.isTrue(unread.message.length > 0);
      }),
  );

  const OLD = "2026-07-01T01:00:00Z";
  const LABEL_AT = "2026-10-08T00:30:00Z";
  const COMMENT_AT = "2026-10-08T01:00:00Z";

  /**
   * gh for a release from `from`: the issue's comments (its newest factory comment is `newest`,
   * created at `commentAt`), the label history (`labels`, or null when the history cannot be
   * read), and the `from` label, which moves unless `labelFails`.
   */
  const releaseGh = (
    newest: string | null,
    labelFails: boolean,
    commentAt: string = COMMENT_AT,
    labels: ReadonlyArray<Labeled> | null = [{ label: "factory:triage", at: LABEL_AT }],
    from: State = "triage",
  ) =>
    ghWith((args) => {
      if (args[0] === "api" && args[1] === `repos/${REPO}/issues/9/comments`) {
        return JSON.stringify(
          newest === null ? [] : [{ id: 1, body: `${newest}\n\n${MARKER}`, created_at: commentAt }],
        );
      }
      if (isHistory(args)) return labels === null ? null : historyOf(labels);
      if (args[0] === "issue" && args[1] === "comment") return "https://github.com/x/1";
      if (args[0] === "issue" && args[1] === "view") {
        return JSON.stringify({ labels: [{ name: `factory:${from}` }] });
      }
      if (args[0] === "issue" && args[1] === "edit") return labelFails ? null : "";
      return null;
    });

  const steps = (calls: ReadonlyArray<ReadonlyArray<string>>) =>
    calls.map((args) =>
      args[0] === "api"
        ? args[1] === "graphql"
          ? "history"
          : "comments"
        : args[1] === "comment"
          ? "comment"
          : `${args[1]}`,
    );

  it.effect("a cut-short claim is commented on, then moved to proposed", () =>
    Effect.gen(function* () {
      const { process, calls } = releaseGh(null, false);
      yield* worldOf(process).releaseClaim(repo, 9, "triage");
      assert.deepStrictEqual(steps(calls), ["comments", "comment", "view", "edit"]);
    }),
  );

  it.effect("a release whose label fails is tried again without a second comment", () =>
    Effect.gen(function* () {
      const first = releaseGh(null, true);
      const error = yield* Effect.flip(worldOf(first.process).releaseClaim(repo, 9, "triage"));
      assert.strictEqual(error.kind, "tracker");
      assert.deepStrictEqual(steps(first.calls), ["comments", "comment", "view", "edit"]);
      // The next pass finds the issue where it was: the comment is newer than the label event.
      const again = releaseGh(CUT_SHORT_COMMENT, false);
      yield* worldOf(again.process).releaseClaim(repo, 9, "triage");
      assert.deepStrictEqual(steps(again.calls), ["comments", "history", "view", "edit"]);
    }),
  );

  it.effect("an old cut-short comment from before the current label is said again", () =>
    Effect.gen(function* () {
      const { process, calls } = releaseGh(CUT_SHORT_COMMENT, false, OLD);
      yield* worldOf(process).releaseClaim(repo, 9, "triage");
      assert.deepStrictEqual(steps(calls), ["comments", "history", "comment", "view", "edit"]);
    }),
  );

  it.effect(
    "a newest comment that is not the cut-short text is followed by one, unread history",
    () =>
      Effect.gen(function* () {
        const { process, calls } = releaseGh("Something else the factory said.", false);
        yield* worldOf(process).releaseClaim(repo, 9, "triage");
        assert.deepStrictEqual(steps(calls), ["comments", "comment", "view", "edit"]);
      }),
  );

  it.effect("a history that cannot be read still gets the comment, then the move", () =>
    Effect.gen(function* () {
      const { process, calls } = releaseGh(CUT_SHORT_COMMENT, false, COMMENT_AT, null);
      yield* worldOf(process).releaseClaim(repo, 9, "triage");
      assert.deepStrictEqual(steps(calls), ["comments", "history", "comment", "view", "edit"]);
    }),
  );

  it.effect("a history with no label event of the state gets the comment", () =>
    Effect.gen(function* () {
      const { process, calls } = releaseGh(CUT_SHORT_COMMENT, false, COMMENT_AT, []);
      yield* worldOf(process).releaseClaim(repo, 9, "triage");
      assert.deepStrictEqual(steps(calls), ["comments", "history", "comment", "view", "edit"]);
    }),
  );

  it.effect("a cut-short comment made in the label's own second is said again", () =>
    Effect.gen(function* () {
      const { process, calls } = releaseGh(CUT_SHORT_COMMENT, false, LABEL_AT);
      yield* worldOf(process).releaseClaim(repo, 9, "triage");
      assert.deepStrictEqual(steps(calls), ["comments", "history", "comment", "view", "edit"]);
    }),
  );

  /** A claim begun in triage that moved on to building at LABEL_AT. */
  const triageThenBuilding: ReadonlyArray<Labeled> = [
    { label: "factory:triage", at: OLD },
    { label: "factory:building", at: LABEL_AT },
  ];

  it.effect("a release from building compares with the building label, not triage", () =>
    Effect.gen(function* () {
      // Newer than the triage label, older than the building one: it explained the triage claim.
      const between = "2026-07-01T02:00:00Z";
      const old = releaseGh(CUT_SHORT_COMMENT, false, between, triageThenBuilding, "building");
      yield* worldOf(old.process).releaseClaim(repo, 9, "building");
      assert.deepStrictEqual(steps(old.calls), ["comments", "history", "comment", "view", "edit"]);
      const fresh = releaseGh(CUT_SHORT_COMMENT, false, COMMENT_AT, triageThenBuilding, "building");
      yield* worldOf(fresh.process).releaseClaim(repo, 9, "building");
      assert.deepStrictEqual(steps(fresh.calls), ["comments", "history", "view", "edit"]);
    }),
  );

  it.effect(
    "a comment time that is not GitHub's UTC-second form never counts, history unread",
    () =>
      Effect.gen(function* () {
        // Text-sorts after LABEL_AT, so only the form check keeps it from counting.
        const { process, calls } = releaseGh(CUT_SHORT_COMMENT, false, "2026-10-08T09:00:00+10:00");
        yield* worldOf(process).releaseClaim(repo, 9, "triage");
        assert.deepStrictEqual(steps(calls), ["comments", "comment", "view", "edit"]);
      }),
  );

  const configText = (base: string) =>
    `factory:\n  instructors: [tomkaczocha]\n  base: ${base}\n  provision: []\n  gate: [make]\n  limits: { minutes: 1, gate_retries: 0 }\n  autonomy: pr\n`;

  /**
   * gh answers for `.dw/config.yml` on a default branch `main`: the file naming `base`, or the
   * contents call failing with `stderr` (a 404 is GitHub saying the file is not there). `ref`
   * fails the branch's tip call with a 404 instead.
   */
  const baseConfigGh = (
    file: { readonly base: string } | { readonly stderr: string } | { readonly text: string },
    ref: "ok" | "missing" = "ok",
  ) => {
    const sha = "9f8e7d6c5b4a39281706f5e4d3c2b1a098765432";
    const calls: Array<ReadonlyArray<string>> = [];
    const answer = (args: ReadonlyArray<string>): string | { readonly stderr: string } => {
      // The repo is matched in any case, as GitHub matches it, so a test can pass it mixed-case.
      const path = (args[1] ?? "").toLowerCase();
      if (args[0] === "api" && path === `repos/${REPO}`) return '{"default_branch":"main"}';
      if (args[0] === "api" && path === `repos/${REPO}/git/ref/heads/main`) {
        if (ref === "missing") return { stderr: "gh: Not Found (HTTP 404)" };
        return JSON.stringify({ ref: "refs/heads/main", object: { sha, type: "commit" } });
      }
      if (args[0] === "api" && path.startsWith(`repos/${REPO}/contents/`)) {
        if ("stderr" in file) return { stderr: file.stderr };
        const text = "text" in file ? file.text : configText(file.base);
        return JSON.stringify({
          name: "config.yml",
          path: ".dw/config.yml",
          sha: "abc",
          size: text.length,
          type: "file",
          content: Buffer.from(text).toString("base64"),
          encoding: "base64",
        });
      }
      return { stderr: "gh: Server Error (HTTP 502)" };
    };
    const process = FactoryProcess.of({
      run: (input: RunInput) => {
        const args = input.args ?? [];
        calls.push(args);
        const reply = answer(args);
        const failed = typeof reply !== "string";
        return Effect.succeed({
          exitCode: failed ? 1 : 0,
          timedOut: false,
          tail: failed ? "" : reply,
          stderrTail: failed ? reply.stderr : "",
          truncated: false,
            tailTruncated: false,
        } satisfies RunResult);
      },
    });
    return { process, calls };
  };

  const NOT_FOUND = { stderr: "gh: Not Found (HTTP 404)" };
  const projectDirs = useTempDirs();

  /** A checkout whose working tree holds `.dw/config.yml` naming `base`, or none. */
  const checkout = (base: string | null) => {
    const root = projectDirs("checkout");
    if (base !== null) {
      NodeFS.mkdirSync(NodePath.join(root, ".dw"));
      NodeFS.writeFileSync(NodePath.join(root, ".dw", "config.yml"), configText(base));
    }
    return { root, file: NodePath.join(root, ".dw", "config.yml") };
  };

  /** The project config of `REPO` at `root`, and what the settings page was told about it. */
  const readProject = (
    process: FactoryProcess["Service"],
    root: string,
    withLastGood = false,
    repo = REPO,
    onMachine: MachineConfig = machine,
    defaulted?: Defaulted,
  ) => {
    const readings: Array<RepoConfigReading> = [];
    const world = liveWorld(
      onMachine,
      "/factory-test/data",
      process,
      NodeServices.layer,
      stubSessions,
      () => NOW,
      "mac-mini",
      noAttention,
      {
        gate: { run: () => Effect.succeed({ _tag: "running" as const }) },
        wake: Effect.void,
        scope: Scope.makeUnsafe(),
      },
      undefined,
      (_repo, reading) => readings.push(reading),
      {
        ...newShared(),
        lastGood: new Map(
          withLastGood ? [[REPO.toLowerCase(), { project: timeLimitOnlyProjectConfig() }]] : [],
        ),
      },
    );
    return Effect.result(
      world.project({ repo, path: root, ...(defaulted !== undefined && { defaulted }) }),
    ).pipe(Effect.map((result) => ({ result, readings })));
  };

  describe("with the machine's default_project", () => {
    const withDefault: MachineConfig = {
      ...machine,
      defaultProject: {
        instructors: ["rawphp"],
        limits: { minutes: 180, gateRetries: 2, checksMinutes: 30, interruptionResumes: 2 },
      },
    };

    it.effect("a repo with its own factory block runs on that block alone", () =>
      Effect.gen(function* () {
        const { process } = baseConfigGh({ base: "main" });
        const { result } = yield* readProject(process, "/p", false, REPO, withDefault);
        assert.isTrue(Result.isSuccess(result));
        if (Result.isSuccess(result)) {
          assert.deepStrictEqual(result.success, {
            instructors: ["tomkaczocha"],
            base: "main",
            provision: [],
            gate: ["make"],
            requiredChecks: [],
            limits: { minutes: 1, gateRetries: 0, checksMinutes: 30, interruptionResumes: 2 },
            autonomy: "pr",
            owner: null,
          });
        }
      }),
    );

    const npmTest: Defaulted = {
      head: {
        branch: "main",
        files: {
          packageJson: '{"scripts":{"test":"vitest"}}',
          composerJson: null,
          lockfiles: ["package-lock.json"],
        },
      },
    };

    it.effect("a repo on the default runs on it, on GitHub's default branch, and says so", () =>
      Effect.gen(function* () {
        const { process } = baseConfigGh({ stderr: NOT_FOUND.stderr });
        const { result, readings } = yield* readProject(
          process,
          "/p",
          false,
          REPO,
          withDefault,
          npmTest,
        );
        const expected = {
          instructors: ["rawphp"],
          base: "main",
          provision: ["npm ci"],
          gate: ["npm run test"],
          requiredChecks: [],
          limits: { minutes: 180, gateRetries: 2, checksMinutes: 30, interruptionResumes: 2 },
          autonomy: "pr" as const,
          owner: null,
        };
        assert.deepStrictEqual(Result.isSuccess(result) && result.success, expected);
        assert.deepStrictEqual(readings, [{ kind: "ok", project: expected, onDefault: true }]);
      }),
    );

    it.effect("a .dw/config.yml on GitHub with no factory key leaves the repo on the default", () =>
      Effect.gen(function* () {
        const { process } = baseConfigGh({ text: "tracker:\n  backend: github\n" });
        const { result, readings } = yield* readProject(
          process,
          "/p",
          false,
          REPO,
          withDefault,
          npmTest,
        );
        assert.deepStrictEqual(Result.isSuccess(result) && result.success.gate, ["npm run test"]);
        assert.strictEqual(readings[0]?.kind === "ok" && readings[0].onDefault, true);
      }),
    );

    it.effect("a factory block on GitHub wins over a checkout that shows none", () =>
      Effect.gen(function* () {
        const { process } = baseConfigGh({ base: "main" });
        const { result, readings } = yield* readProject(
          process,
          "/p",
          false,
          REPO,
          withDefault,
          npmTest,
        );
        assert.isTrue(Result.isSuccess(result));
        if (Result.isSuccess(result)) {
          assert.deepStrictEqual(result.success.instructors, ["tomkaczocha"]);
          assert.deepStrictEqual(result.success.gate, ["make"]);
        }
        assert.deepStrictEqual(readings.length, 1);
        assert.notProperty(readings[0], "onDefault");
      }),
    );

    const failsWith = (onMachine: MachineConfig, defaulted: Defaulted, part: string) =>
      Effect.gen(function* () {
        const { process } = baseConfigGh({ stderr: NOT_FOUND.stderr });
        const { result, readings } = yield* readProject(
          process,
          "/p",
          false,
          REPO,
          onMachine,
          defaulted,
        );
        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result)) {
          assert.strictEqual(result.failure.kind, "config");
          assert.isUndefined(result.failure.transient);
        }
        assert.strictEqual(readings.length, 1);
        const reading = readings[0];
        assert.strictEqual(reading?.kind, "errors");
        if (reading?.kind === "errors") {
          assert.strictEqual(reading.errors.length, 1);
          assert.include(reading.errors[0]?.message, part);
          assert.strictEqual(reading.onDefault, true);
        }
      });

    it.effect("a broken factory block on GitHub is the repo's own error, not the default's", () =>
      Effect.gen(function* () {
        const { process } = baseConfigGh({ base: "develop" });
        const { result, readings } = yield* readProject(
          process,
          "/p",
          false,
          REPO,
          withDefault,
          npmTest,
        );
        assert.isTrue(Result.isFailure(result));
        const reading = readings[0];
        assert.strictEqual(reading?.kind, "errors");
        if (reading?.kind === "errors") assert.strictEqual(reading.onDefault, false);
      }),
    );

    it.effect("a .dw/config.yml on GitHub that does not parse is the repo's own error", () =>
      Effect.gen(function* () {
        const { process } = baseConfigGh({ text: "factory: [unclosed\n" });
        const { result, readings } = yield* readProject(
          process,
          "/p",
          false,
          REPO,
          withDefault,
          npmTest,
        );
        assert.isTrue(Result.isFailure(result));
        const reading = readings[0];
        assert.strictEqual(reading?.kind, "errors");
        if (reading?.kind === "errors") {
          assert.strictEqual(reading.onDefault, false);
          assert.include(reading.errors[0]?.message, "YAML");
        }
      }),
    );

    it.effect("a GitHub read that fails says nothing of which config the repo runs on", () =>
      Effect.gen(function* () {
        const { process } = baseConfigGh({ stderr: "gh: Server Error (HTTP 502)" });
        const { readings } = yield* readProject(process, "/p", false, REPO, withDefault, npmTest);
        assert.strictEqual(readings[0]?.kind, "errors");
        assert.notProperty(readings[0], "onDefault");
      }),
    );

    it.effect("a repo on the default with no gate to infer is a config error the page shows", () =>
      failsWith(
        withDefault,
        {
          head: { branch: "main", files: { packageJson: null, composerJson: null, lockfiles: [] } },
        },
        "no gate could be inferred",
      ),
    );

    it.effect("a repo on the default whose checkout has no origin/HEAD says how to set it", () =>
      failsWith(withDefault, { head: null }, "git remote set-head origin --auto"),
    );

    it.effect("a repo listed on the default after the machine dropped it is a config error", () =>
      failsWith(machine, npmTest, "no default_project"),
    );
  });

  it.effect("a project config committed on its own base branch is loaded", () =>
    Effect.gen(function* () {
      const { process } = baseConfigGh({ base: "main" });
      const project = yield* worldOf(process).project({ repo: REPO, path: "/p" });
      assert.strictEqual(project.base, "main");
    }),
  );

  it.effect("a project config that names another base is a config error naming both", () =>
    Effect.gen(function* () {
      const { process } = baseConfigGh({ base: "develop" });
      const error = yield* Effect.flip(worldOf(process).project({ repo: REPO, path: "/p" }));
      assert.strictEqual(error.kind, "config");
      assert.include(error.message, "`develop`");
      assert.include(error.message, "`main`");
    }),
  );

  it.effect("the GitHub copy wins over a checkout copy that differs", () =>
    Effect.gen(function* () {
      const { process } = baseConfigGh({ base: "main" });
      // The checkout's copy would be refused: had it been read, the read would fail.
      const local = checkout("develop");
      const { result } = yield* readProject(process, local.root);
      assert.isTrue(Result.isSuccess(result));
      if (Result.isSuccess(result)) assert.strictEqual(result.success.base, "main");
    }),
  );

  it.effect("a config not on GitHub is read from the checkout's working tree", () =>
    Effect.gen(function* () {
      const { process } = baseConfigGh(NOT_FOUND);
      const local = checkout("main");
      const { result, readings } = yield* readProject(process, local.root);
      assert.isTrue(Result.isSuccess(result));
      if (Result.isSuccess(result)) assert.strictEqual(result.success.base, "main");
      assert.deepStrictEqual(
        readings.map((r) => r.kind),
        ["ok"],
      );
    }),
  );

  it.effect("a checkout config that names another base is skipped, naming the local file", () =>
    Effect.gen(function* () {
      const { process } = baseConfigGh(NOT_FOUND);
      const local = checkout("develop");
      const { result, readings } = yield* readProject(process, local.root);
      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.strictEqual(result.failure.kind, "config");
        assert.include(result.failure.message, local.file);
        assert.include(result.failure.message, "`develop`");
        assert.include(result.failure.message, "`main`");
        assert.include(result.failure.message, "a checkout's config must name the default branch");
      }
      const reading = readings[0];
      assert.strictEqual(reading?.kind, "errors");
      if (reading?.kind === "errors") {
        assert.deepStrictEqual(
          reading.errors.map((e) => [e.file, e.field]),
          [[local.file, "factory.base"]],
        );
      }
    }),
  );

  it.effect("no config on GitHub and none in the checkout is one error saying both", () =>
    Effect.gen(function* () {
      const { process } = baseConfigGh(NOT_FOUND);
      const local = checkout(null);
      const { result, readings } = yield* readProject(process, local.root);
      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.strictEqual(result.failure.kind, "config");
        assert.include(
          result.failure.message,
          `.dw/config.yml is not on main on GitHub, and cannot read ${local.file}: `,
        );
      }
      const reading = readings[0];
      assert.strictEqual(reading?.kind, "errors");
      if (reading?.kind === "errors") {
        assert.deepStrictEqual(
          reading.errors.map((e) => e.file),
          [local.file],
        );
      }
    }),
  );

  it.effect("any other GitHub failure is the pass error and the checkout is not read", () =>
    Effect.gen(function* () {
      // A good checkout copy: any fallback to it would load.
      const local = checkout("main");
      for (const gh of [
        baseConfigGh({ stderr: "gh: Server Error (HTTP 502)" }),
        baseConfigGh({ stderr: "API rate limit exceeded" }),
        baseConfigGh({ base: "main" }, "missing"),
      ]) {
        const { result, readings } = yield* readProject(gh.process, local.root);
        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result)) {
          assert.include(result.failure.message, "cannot read .dw/config.yml from GitHub: ");
          assert.notInclude(result.failure.message, local.root);
        }
        const reading = readings[0];
        assert.strictEqual(reading?.kind, "errors");
        if (reading?.kind === "errors") {
          assert.deepStrictEqual(
            reading.errors.map((e) => e.file),
            [".dw/config.yml"],
          );
        }
      }
    }),
  );

  describe("a failed read is transient only when another try may well succeed", () => {
    const TLS = `Get "https://api.github.com/repos/x/y/contents/.dw/config.yml": net/http: TLS handshake timeout`;
    const EOF = `Get "https://api.github.com/repos/x/y/contents/.dw/config.yml": unexpected EOF`;
    // Past every wait between the gh attempts.
    const PAST_RETRIES = 60_000;

    /** A process whose every call fails with `stderr`. */
    const failing = (stderr: string) =>
      FactoryProcess.of({
        run: () =>
          Effect.succeed({
            exitCode: 1,
            timedOut: false,
            tail: "",
            stderrTail: stderr,
            truncated: false,
            tailTruncated: false,
          } satisfies RunResult),
      });

    it.effect("a transient config read with a last good copy leaves the reading", () =>
      Effect.gen(function* () {
        for (const stderr of [TLS, EOF]) {
          const { process } = baseConfigGh({ stderr });
          // The copy is keyed lower-cased, as the pass keys it, whatever case the repo is watched in.
          const fiber = yield* Effect.forkChild(
            readProject(process, checkout("main").root, true, "RawPHP/Softfac"),
            { startImmediately: true },
          );
          yield* TestClock.adjust(PAST_RETRIES);
          const { result, readings } = yield* Fiber.join(fiber);
          assert.isTrue(Result.isFailure(result), stderr);
          if (Result.isFailure(result)) assert.strictEqual(result.failure.transient, true, stderr);
          // The pass runs on the copy, so the settings page is not told the config failed.
          assert.deepStrictEqual(readings, [], stderr);
        }
      }),
    );

    it.effect("a transient config read with no last good copy reports the errors", () =>
      Effect.gen(function* () {
        const { process } = baseConfigGh({ stderr: TLS });
        const fiber = yield* Effect.forkChild(readProject(process, checkout("main").root), {
          startImmediately: true,
        });
        yield* TestClock.adjust(PAST_RETRIES);
        const { result, readings } = yield* Fiber.join(fiber);
        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result)) assert.strictEqual(result.failure.transient, true);
        // The repo is skipped, and the reading says why.
        assert.strictEqual(readings[0]?.kind, "errors");
      }),
    );

    it.effect("a config read GitHub answered with an error is not transient", () =>
      Effect.gen(function* () {
        const { process } = baseConfigGh({ stderr: "gh: Server Error (HTTP 502)" });
        // With a last good copy too: the pass skips the repo on a failure GitHub answered, so
        // the settings page is told.
        const { result, readings } = yield* readProject(process, checkout("main").root, true);
        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result)) assert.notStrictEqual(result.failure.transient, true);
        assert.strictEqual(readings[0]?.kind, "errors");
      }),
    );

    it.effect(
      "a login read that GitHub never received, or that hit an unexpected EOF, is transient",
      () =>
        Effect.gen(function* () {
          for (const stderr of [TLS, `Get "https://api.github.com/user": unexpected EOF`]) {
            const world = worldOf(failing(stderr));
            const fiber = yield* Effect.forkChild(
              Effect.result(world.trackerUser({ repo: REPO, path: "/p" })),
              { startImmediately: true },
            );
            yield* TestClock.adjust(PAST_RETRIES);
            const result = yield* Fiber.join(fiber);
            assert.isTrue(Result.isFailure(result), stderr);
            if (Result.isFailure(result))
              assert.strictEqual(result.failure.transient, true, stderr);
          }
        }),
    );

    it.effect("a login read GitHub refused is not transient", () =>
      Effect.gen(function* () {
        const world = worldOf(failing("gh: Bad credentials (HTTP 401)"));
        const result = yield* Effect.result(world.trackerUser({ repo: REPO, path: "/p" }));
        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result)) assert.notStrictEqual(result.failure.transient, true);
      }),
    );
  });

  it.effect("a checkout config that does not parse names the local file in its errors", () =>
    Effect.gen(function* () {
      const { process } = baseConfigGh(NOT_FOUND);
      const local = checkout(null);
      NodeFS.mkdirSync(NodePath.join(local.root, ".dw"));
      NodeFS.writeFileSync(local.file, "factory:\n  instructors: [tomkaczocha]\n  base: main\n");
      const { result, readings } = yield* readProject(process, local.root);
      assert.isTrue(Result.isFailure(result));
      const reading = readings[0];
      assert.strictEqual(reading?.kind, "errors");
      if (reading?.kind === "errors") {
        assert.isAbove(reading.errors.length, 0);
        for (const error of reading.errors) assert.strictEqual(error.file, local.file);
      }
    }),
  );

  it.effect("a checkout config that cannot be read is one error saying both", () =>
    Effect.gen(function* () {
      const { process } = baseConfigGh(NOT_FOUND);
      const local = checkout(null);
      // A directory where the file should be.
      NodeFS.mkdirSync(local.file, { recursive: true });
      const { result } = yield* readProject(process, local.root);
      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.include(
          result.failure.message,
          `.dw/config.yml is not on main on GitHub, and cannot read ${local.file}: `,
        );
      }
    }),
  );

  it.effect("a config read from GitHub names `<branch>:.dw/config.yml` in its errors", () =>
    Effect.gen(function* () {
      const { process } = baseConfigGh({ base: "develop" });
      const { readings } = yield* readProject(process, checkout(null).root);
      const reading = readings[0];
      assert.strictEqual(reading?.kind, "errors");
      if (reading?.kind === "errors") {
        assert.deepStrictEqual(
          reading.errors.map((e) => e.file),
          ["main:.dw/config.yml"],
        );
      }
    }),
  );

  const tempDirForLogs = useTempDirs();

  it.effect("the server starts, stops and broken worktrees answer none, and no branch is pruned", () =>
    Effect.gen(function* () {
      const dataDir = tempDirForLogs();
      const { process } = ghWith(() => null);
      const world = worldOf(process);
      // Even with the machine log saying the old server started and stopped: a runner restart
      // does not stop a Paradev agent, so neither is evidence.
      for (const [event, at] of [
        ["server_started", NOW - 2 * MINUTE],
        ["server_stopping", NOW - 3 * MINUTE],
      ] as const) {
        const log = MachineLog.open(dataDir, { clock: () => at });
        log.append(
          event === "server_stopping"
            ? { event, data: { stopping_at: at } }
            : { event, data: { started_at: at } },
        );
        log.close();
      }
      const fromLog = liveWorld(
        machine,
        dataDir,
        process,
        NodeServices.layer,
        stubSessions,
        () => NOW,
        "mac-mini",
        noAttention,
        {
          gate: { run: () => Effect.succeed({ _tag: "running" as const }) },
          wake: Effect.void,
          scope: Scope.makeUnsafe(),
        },
      );
      for (const w of [world, fromLog]) {
        assert.deepStrictEqual(yield* w.t3Starts(), []);
        assert.deepStrictEqual(yield* w.t3Stops(), []);
        assert.deepStrictEqual(yield* w.threadsOnBrokenWorktrees(), []);
        assert.deepStrictEqual(yield* w.pruneBranches(repo), {
          pruned: [],
          left: [],
          failed: [],
          waiting: 0,
        });
      }
    }),
  );

  it.effect("T3 trouble is the newest t3 error in the machine log within ten minutes", () =>
    Effect.gen(function* () {
      const dataDir = tempDirForLogs();
      const { process } = ghWith(() => null);
      const world = liveWorld(
        machine,
        dataDir,
        process,
        NodeServices.layer,
        stubSessions,
        () => NOW,
        "mac-mini",
        noAttention,
        {
          gate: { run: () => Effect.succeed({ _tag: "running" as const }) },
          wake: Effect.void,
          scope: Scope.makeUnsafe(),
        },
      );
      // No machine log yet: no trouble.
      assert.strictEqual(yield* world.t3Trouble(), null);
      const log = MachineLog.open(dataDir, { clock: () => NOW - 20 * MINUTE });
      log.append({ event: "error", data: { step: "pass", kind: "t3", message: "too old" } });
      log.close();
      assert.strictEqual(yield* world.t3Trouble(), null);
      const recent = MachineLog.open(dataDir, { clock: () => NOW - 2 * MINUTE });
      recent.append({ event: "error", data: { step: "pass", kind: "t3", message: "timed out" } });
      recent.close();
      assert.strictEqual(yield* world.t3Trouble(), "timed out");
    }),
  );
});

describe("the gate in the background", () => {
  const tempDir = useTempDirs();
  const REPO = "rawphp/softfac";

  /** What `gh pr view` answers for pull request 12 of `REPO`, as `state`, at `head`. */
  const PR_VIEW = (state: "OPEN" | "MERGED", head: string, mergeable = "MERGEABLE") =>
    JSON.stringify({
      number: 12,
      isDraft: false,
      state,
      headRefName: "t3code/abc",
      isCrossRepository: false,
      baseRefName: "main",
      headRefOid: head,
      mergeable,
      createdAt: "2026-10-04T10:00:00Z",
    });
  const HEAD = "4f1c2d3e4a5b60718293a4b5c6d7e8f901234567";
  const BASE = "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d";

  /** A run whose gate passed at `HEAD` against `BASE`, whose worktree is removed and whose issue is `pr-open`. */
  const prOpenRun = (dataDir: string, issue = "10"): RunId => {
    const run = newRunId(REPO, issue, 1);
    const ledger = Ledger.create(dataDir, run, { clock: () => 1_000 });
    const cause = makeCause("gate", "seed", { attempt: 1 });
    for (const event of [
      {
        event: "session_launched",
        data: {
          thread_id: "thread-1",
          worktree: "/t3/wt",
          branch: null,
          model_instance: null,
          model: null,
          model_options: null,
          resumed_from: null,
        },
      },
      { event: "pr_opened", data: { pr: 12, url: "https://github.com/rawphp/softfac/pull/12" } },
      {
        event: "gate_checkout",
        data: { attempt: 1, dir: "/gone", sha: HEAD, base_sha: BASE },
      },
      {
        event: "gate_command",
        data: { attempt: 1, command: "cargo test", exit_code: 0, duration_ms: 5 },
      },
      { event: "step_changed", data: { step: `gate-passed ${HEAD} 1` } },
      { event: "worktree_removed", data: { path: "/t3/wt" } },
      { event: "state_changed", data: { from: "building", to: "pr-open" } },
    ] as const) {
      ledger.append(event, cause);
    }
    ledger.close();
    return run;
  };

  const background = baseMachine;
  const backgroundRepo: Repo = {
    watched: { repo: REPO, path: "/p" },
    project: { ...timeLimitOnlyProjectConfig(), base: "main" },
    trackerUser: "rawphp",
  };

  it.effect("runs the gate step as a background fiber and wakes the loop once it decided", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      // A pr-open run whose pull request was merged: the re-gate ends the run at once, with no
      // command run and nothing written on GitHub.
      const run = prOpenRun(dataDir);
      const seen: Array<ReadonlyArray<string>> = [];
      const gh: FactoryProcess["Service"] = {
        run: (input) => {
          seen.push(input.args ?? []);
          return answered(PR_VIEW("MERGED", HEAD));
        },
      };
      const woken = yield* Deferred.make<void>();
      const archived: Array<string> = [];
      const world = liveWorld(
        background,
        dataDir,
        gh,
        NodeServices.layer,
        sessionsOf({
archive: (threadId) => Effect.sync(() => void archived.push(threadId)),
        }),
        () => 1_000,
        "mac-mini",
        noAttention,
        {
          gate: { run: () => Effect.die("no gate runs for a merged pull request") },
          wake: Deferred.succeed(woken, undefined).pipe(Effect.asVoid),
          scope: yield* Scope.make(),
        },
      );
      assert.deepStrictEqual(yield* world.gate(backgroundRepo, run), { kind: "started" });
      assert.strictEqual(world.gateRunning(run), true);
      // A second start while the first runs is queued at max_concurrent_gates 1.
      assert.deepStrictEqual(yield* world.gate(backgroundRepo, newRunId(REPO, "11", 1)), {
        kind: "queued",
        running: 1,
        max: 1,
      });
      yield* Deferred.await(woken);
      assert.strictEqual(world.gateRunning(run), false);
      assert.deepStrictEqual(archived, ["thread-1"]);
      assert.strictEqual(readRun(dataDir, run).entries.at(-1)?.event, "finished");
      // It read the pull request, for a re-gate; a gate of a pr-open run would have read nothing.
      assert.ok(
        seen.some((args) => args.includes("view")),
        JSON.stringify(seen),
      );
    }),
  );

  it.effect("a re-gate whose relaunch finds no room logs the wait and writes no error to the run", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const run = prOpenRun(dataDir);
      const gh: FactoryProcess["Service"] = { run: () => answered(PR_VIEW("MERGED", HEAD)) };
      const logs: Array<string> = [];
      const logLayer = Logger.layer(
        [Logger.make(({ message }) => void logs.push(messageText(message)))],
        { mergeWithExisting: false },
      );
      const world = liveWorld(
        background,
        dataDir,
        gh,
        NodeServices.layer,
        // The gate step fails as a launch that found no room does.
        sessionsOf({
          archive: () => Effect.fail(new SessionsError({ operation: "launch", cause: new NoTargetHasRoom() })),
        }),
        () => 1_000,
        "mac-mini",
        noAttention,
        {
          gate: { run: () => Effect.die("no gate runs for a merged pull request") },
          wake: Effect.void,
          scope: yield* Scope.make(),
        },
      );
      yield* world.gate(backgroundRepo, run).pipe(Effect.provide(logLayer));
      yield* waitUntil("the gate to end", () => !world.gateRunning(run));
      assert.deepStrictEqual(
        readRun(dataDir, run).entries.filter((entry) => entry.event === "error"),
        [],
      );
      assert.ok(logs.some((line) => line === "rawphp/softfac#10 pr-open: waits: no target has room"), logs.join("\n"));
      assert.ok(!logs.some((line) => line.startsWith("error:")), logs.join("\n"));
    }),
  );

  describe("under high load", () => {
    const loaded = { ...background, maxConcurrentGates: 2, maxLoadPerCore: 1 };
    const overloaded = () => ({ oneMinute: 55.2, cores: 12 });
    const merged: FactoryProcess["Service"] = { run: () => answered(PR_VIEW("MERGED", HEAD)) };
    // The re-gate of a merged pull request archives the run's thread and finishes the run.
    const sessions = sessionsOf({
archive: () => Effect.void });
    const liveGate = (woken: Deferred.Deferred<void>, scope: Scope.Scope) => ({
      gate: { run: () => Effect.die("no gate runs for a merged pull request") },
      wake: Deferred.succeed(woken, undefined).pipe(Effect.asVoid),
      scope,
      readLoad: overloaded,
    });

    it.effect("a second gate answers queued and its run records no gate attempt", () =>
      Effect.gen(function* () {
        const dataDir = tempDir();
        const run = prOpenRun(dataDir);
        const other = prOpenRun(dataDir, "11");
        const before = NodeFS.readFileSync(runPath(dataDir, other), "utf8");
        const woken = yield* Deferred.make<void>();
        const world = liveWorld(
          loaded,
          dataDir,
          merged,
          NodeServices.layer,
          sessions,
          () => 1_000,
          "mac-mini",
          noAttention,
          liveGate(woken, yield* Scope.make()),
        );
        assert.deepStrictEqual(yield* world.gate(backgroundRepo, run), { kind: "started" });
        assert.deepStrictEqual(yield* world.gate(backgroundRepo, other), {
          kind: "high-load",
          oneMinute: 55.2,
          limit: 12,
        });
        assert.strictEqual(world.gateRunning(other), false);
        yield* Deferred.await(woken);
        assert.strictEqual(NodeFS.readFileSync(runPath(dataDir, other), "utf8"), before);
      }),
    );

    // Off the load, max_concurrent_gates is the only limit.
    it.effect.each([
      {
        name: "under the limit",
        machine: loaded,
        readLoad: () => ({ oneMinute: 2, cores: 12 }),
      },
      {
        name: "at max_load_per_core 0, which reads no load",
        machine: { ...loaded, maxLoadPerCore: 0 },
        readLoad: () => assert.fail("the load is not read at max_load_per_core 0"),
      },
    ])("$name a second gate starts", ({ machine, readLoad }) =>
      Effect.gen(function* () {
        const dataDir = tempDir();
        const run = prOpenRun(dataDir);
        const other = prOpenRun(dataDir, "11");
        const wakes = yield* Queue.unbounded<void>();
        const world = liveWorld(
          machine,
          dataDir,
          merged,
          NodeServices.layer,
          sessions,
          () => 1_000,
          "mac-mini",
          noAttention,
          {
            gate: { run: () => Effect.die("no gate runs for a merged pull request") },
            wake: Queue.offer(wakes, undefined).pipe(Effect.asVoid),
            scope: yield* Scope.make(),
            readLoad,
          },
        );
        assert.deepStrictEqual(yield* world.gate(backgroundRepo, run), { kind: "started" });
        assert.deepStrictEqual(yield* world.gate(backgroundRepo, other), { kind: "started" });
        yield* Queue.takeN(wakes, 2);
        assert.isFalse(world.gateRunning(run) || world.gateRunning(other));
      }),
    );

    it.effect("with no gate running the gate starts whatever the load", () =>
      Effect.gen(function* () {
        const dataDir = tempDir();
        const run = prOpenRun(dataDir);
        const woken = yield* Deferred.make<void>();
        const world = liveWorld(
          loaded,
          dataDir,
          merged,
          NodeServices.layer,
          sessions,
          () => 1_000,
          "mac-mini",
          noAttention,
          liveGate(woken, yield* Scope.make()),
        );
        assert.deepStrictEqual(yield* world.gate(backgroundRepo, run), { kind: "started" });
        yield* Deferred.await(woken);
      }),
    );
  });

  it.effect(
    "a pr-open run that nothing moved for is re-gated quietly: no decision, no wake, no write",
    () =>
      Effect.gen(function* () {
        const dataDir = tempDir();
        const run = prOpenRun(dataDir);
        const before = NodeFS.readFileSync(runPath(dataDir, run), "utf8");
        const woken = yield* Ref.make(0);
        const freed = yield* Queue.unbounded<string>();
        const gh: FactoryProcess["Service"] = {
          run: (input) =>
            answered(
              input.args?.includes("view") === true
                ? PR_VIEW("OPEN", HEAD)
                : JSON.stringify({ object: { type: "commit", sha: BASE } }),
            ),
        };
        const world = liveWorld(
          background,
          dataDir,
          gh,
          NodeServices.layer,
          stubSessions,
          () => 1_000,
          "mac-mini",
          noAttention,
          {
            gate: { run: () => Effect.die("nothing moved, so nothing is gated") },
            wake: Ref.update(woken, (n) => n + 1),
            scope: yield* Scope.make(),
          },
          undefined,
          undefined,
          freeingShared(freed),
        );
        assert.deepStrictEqual(yield* world.gate(backgroundRepo, run), { kind: "started" });
        yield* Queue.take(freed);
        assert.isFalse(world.gateRunning(run));
        assert.strictEqual(yield* Ref.get(woken), 0);
        assert.strictEqual(NodeFS.readFileSync(runPath(dataDir, run), "utf8"), before);
      }),
  );

  it.effect(
    "with every slot taken, a run GitHub says conflicts is gated at once and any other is queued",
    () =>
      Effect.gen(function* () {
        const dataDir = tempDir();
        const run = prOpenRun(dataDir);
        let mergeable = "MERGEABLE";
        let prState: "OPEN" | "MERGED" | "fails" = "OPEN";
        const prReads: Array<string> = [];
        const gh: FactoryProcess["Service"] = {
          run: (input) => {
            const args = input.args ?? [];
            if (args.includes("pr") && args.includes("view")) {
              prReads.push(`${prState} ${mergeable}`);
              if (prState === "fails") {
                return Effect.fail(
                  new RunSpawnError({ shell: false, cause: new Error("gh died") }),
                );
              }
              return answered(PR_VIEW(prState, HEAD, mergeable));
            }
            if (readsIssue(input)) return answered(OPEN_ISSUE);
            return answered(JSON.stringify({ object: { type: "commit", sha: BASE } }));
          },
        };
        let gateRuns = 0;
        const freed = yield* Queue.unbounded<string>();
        const shared = freeingShared(freed);
        // Another run's gate holds the only slot.
        shared.gating.add(runIdToString(newRunId(REPO, "99", 1)));
        const world = liveWorld(
          background,
          dataDir,
          gh,
          NodeServices.layer,
          stubSessions,
          () => 1_000,
          "mac-mini",
          noAttention,
          {
            gate: {
              run: () =>
                Effect.sync(() => {
                  gateRuns += 1;
                  return { _tag: "queued", running: 1, max: 1 } as const;
                }),
            },
            wake: Effect.void,
            scope: yield* Scope.make(),
          },
          undefined,
          undefined,
          shared,
        );
        const repo: Repo = {
          ...backgroundRepo,
          project: { ...backgroundRepo.project, gate: ["cargo test"] },
        };
        const before = NodeFS.readFileSync(runPath(dataDir, run), "utf8");
        // Mergeable: it waits for the slot, after one read of its pull request, and nothing is written.
        assert.deepStrictEqual(yield* world.gate(repo, run), {
          kind: "queued",
          running: 1,
          max: 1,
        });
        assert.deepStrictEqual(prReads, ["OPEN MERGEABLE"]);
        assert.isFalse(world.gateRunning(run));
        assert.strictEqual(NodeFS.readFileSync(runPath(dataDir, run), "utf8"), before);
        // A merged pull request that read as conflicting, and a read that fails, wait for the slot too.
        mergeable = "CONFLICTING";
        for (const state of ["MERGED", "fails"] as const) {
          prState = state;
          assert.deepStrictEqual(
            yield* world.gate(repo, run),
            { kind: "queued", running: 1, max: 1 },
            state,
          );
        }
        assert.deepStrictEqual(prReads.slice(1), ["MERGED CONFLICTING", "fails CONFLICTING"]);
        assert.strictEqual(NodeFS.readFileSync(runPath(dataDir, run), "utf8"), before);
        prState = "OPEN";
        // Conflicting: the gate starts though the slot is taken, and records the conflict with no
        // gate run, so no lock.
        mergeable = "CONFLICTING";
        assert.deepStrictEqual(yield* world.gate(repo, run), { kind: "started" });
        yield* Queue.take(freed);
        assert.isFalse(world.gateRunning(run));
        assert.strictEqual(gateRuns, 0);
        const conflictLines = readRun(dataDir, run).entries.filter(
          (e) =>
            e.event === "gate_command" &&
            (e.data as { command?: string }).command === MERGE_COMMAND,
        );
        assert.deepStrictEqual(
          conflictLines.map((e) => e.data),
          [{ attempt: 2, command: MERGE_COMMAND, exit_code: 1, duration_ms: 0 }],
        );
      }),
  );

  /** What `gh issue view` answers for the open `factory:building` issue the gate reads before anything else. */
  const OPEN_ISSUE = JSON.stringify({
    number: 10,
    title: "Build step",
    body: "",
    labels: [{ name: "factory:building" }],
    assignees: [{ login: "rawphp" }],
    state: "OPEN",
    author: { login: "tomkaczocha" },
  });
  const readsIssue = (input: RunInput) =>
    input.args?.includes("number,title,body,labels,assignees,state,author") === true;
  const answered = (tail: string) =>
    Effect.succeed({
      exitCode: 0,
      timedOut: false,
      tail,
      stderrTail: "",
      truncated: false,
            tailTruncated: false,
    } satisfies RunResult);

  /** A building run whose session reported its pull request: the gate reads the issue, then the thread. */
  const reportedRun = (dataDir: string): RunId => seedReportedRun(dataDir, REPO);

  const gateMachine: MachineConfig = baseMachine;
  const gateRepo: Repo = {
    watched: { repo: REPO, path: "/p" },
    project: timeLimitOnlyProjectConfig(),
    trackerUser: "rawphp",
  };
  /** `gh` answers the read of the open issue and is not found for anything else. */
  const deadGh: FactoryProcess["Service"] = {
    run: (input) =>
      readsIssue(input)
        ? answered(OPEN_ISSUE)
        : Effect.fail(new RunSpawnError({ shell: false, cause: new Error("gh not found") })),
  };

  it.effect(
    "a gate that fails records the error by kind, frees the run and does not wake the loop",
    () =>
      Effect.gen(function* () {
        const dataDir = tempDir();
        const run = reportedRun(dataDir);
        const freed = yield* Queue.unbounded<string>();
        const woken = yield* Ref.make(0);
        const sessions = sessionsOf({
status: () =>
            Effect.fail(new SessionsError({ operation: "status", cause: "timeout" })),
        });
        const world = liveWorld(
          gateMachine,
          dataDir,
          deadGh,
          NodeServices.layer,
          sessions,
          () => 1_000,
          "mac-mini",
          noAttention,
          {
            gate: { run: () => Effect.die("the thread read fails first") },
            wake: Ref.update(woken, (n) => n + 1),
            scope: yield* Scope.make(),
          },
          undefined,
          undefined,
          freeingShared(freed),
        );
        assert.deepStrictEqual(yield* world.gate(gateRepo, run), { kind: "started" });
        yield* Queue.take(freed);
        assert.isFalse(world.gateRunning(run));
        const errors = readRun(dataDir, run).entries.filter((e) => e.event === "error");
        assert.strictEqual(errors.length, 1);
        assert.deepInclude(errors[0]!.data as object, { step: "gate", kind: "t3" });
        assert.strictEqual(yield* Ref.get(woken), 0);
        // The run is free for the next pass's gate.
        assert.deepStrictEqual(yield* world.gate(gateRepo, run), { kind: "started" });
      }),
  );

  it.effect("a world built on the same shared state sees the gates another world started", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const run = reportedRun(dataDir);
      const other = newRunId(REPO, "11", 1);
      const held = yield* Deferred.make<void>();
      const entered = yield* Deferred.make<void>();
      const sessions = sessionsOf({
status: () =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(held)),
            Effect.andThen(Effect.die("released")),
          ),
      });
      const live = {
        gate: { run: () => Effect.die("never reached") },
        wake: Effect.void,
        scope: yield* Scope.make(),
      };
      const shared = newShared();
      const build = () =>
        liveWorld(
          gateMachine,
          dataDir,
          deadGh,
          NodeServices.layer,
          sessions,
          () => 1_000,
          "mac-mini",
          noAttention,
          live,
          undefined,
          undefined,
          shared,
        );
      const before = build();
      assert.deepStrictEqual(yield* before.gate(gateRepo, run), { kind: "started" });
      yield* Deferred.await(entered);
      // What a reload does: a new world, on the state the old one shares.
      const after = build();
      assert.strictEqual(after.gateRunning(run), true);
      // Nor does a reload read every stuck item's issue again at once.
      assert.strictEqual(after.stuckReads, before.stuckReads);
      assert.deepStrictEqual(yield* after.gate(gateRepo, other), {
        kind: "queued",
        running: 1,
        max: 1,
      });
      // Without shared state a world starts from nothing: that is the defect this guards.
      assert.strictEqual(
        liveWorld(
          gateMachine,
          dataDir,
          deadGh,
          NodeServices.layer,
          sessions,
          () => 1_000,
          "mac-mini",
          noAttention,
          live,
        ).gateRunning(run),
        false,
      );
      yield* Deferred.succeed(held, undefined);
    }),
  );

  it.effect("a gate that ends in stuck raises the run's stuck item, as a pass would", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const run = reportedRun(dataDir);
      const raised: Array<NewItem> = [];
      const woken = yield* Deferred.make<void>();
      // The thread is gone, so the gate stops the run; GitHub holds the issue as building and
      // answers every write.
      const quietGh: FactoryProcess["Service"] = {
        run: (input) =>
          answered(
            readsIssue(input)
              ? OPEN_ISSUE
              : input.args?.includes("labels")
                ? JSON.stringify({ labels: [{ name: "factory:building" }] })
                : input.args?.some((arg) => arg.endsWith("/comments"))
                  ? "[]"
                  : "",
          ),
      };
      const sessions = sessionsOf({
status: (threadId) => Effect.fail(new ThreadNotFoundError({ threadId })),
        thread: (threadId) => Effect.fail(new ThreadNotFoundError({ threadId })),
        archive: () => Effect.void,
        removeWorktree: () => Effect.void,
      });
      const world = liveWorld(
        gateMachine,
        dataDir,
        quietGh,
        NodeServices.layer,
        sessions,
        () => 1_000,
        "mac-mini",
        {
          list: () => Effect.succeed([]),
          raise: (item) => Effect.sync(() => void raised.push(item)),
          clear: () => Effect.void,
        },
        {
          gate: { run: () => Effect.die("no gate runs for a gone thread") },
          wake: Deferred.succeed(woken, undefined).pipe(Effect.asVoid),
          scope: yield* Scope.make(),
        },
      );
      assert.deepStrictEqual(yield* world.gate(gateRepo, run), { kind: "started" });
      yield* Deferred.await(woken);
      assert.isFalse(world.gateRunning(run));
      const id = runIdToString(run);
      assert.ok(readRun(dataDir, run).entries.some((e) => e.event === "finished"));
      assert.deepStrictEqual(raised, [
        {
          id: `run:${id}:stuck`,
          kind: "stuck",
          repo: REPO,
          issue: Number(run.issue),
          run: id,
          message: `${REPO}#${run.issue} stuck, the reason is in the ledger of run ${id}`,
        },
      ]);
    }),
  );

  it.effect("a gate still running when the factory's scope closes is interrupted", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const run = reportedRun(dataDir);
      const entered = yield* Deferred.make<void>();
      const interrupted = yield* Deferred.make<void>();
      const sessions = sessionsOf({
status: () =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
          ),
      });
      const scope = yield* Scope.make();
      const world = liveWorld(
        gateMachine,
        dataDir,
        deadGh,
        NodeServices.layer,
        sessions,
        () => 1_000,
        "mac-mini",
        noAttention,
        {
          gate: { run: () => Effect.die("the thread read never ends") },
          wake: Effect.void,
          scope,
        },
      );
      assert.deepStrictEqual(yield* world.gate(gateRepo, run), { kind: "started" });
      // The gate is under way, waiting on T3, when the factory stops.
      yield* Deferred.await(entered);
      assert.strictEqual(world.gateRunning(run), true);
      yield* Scope.close(scope, Exit.void);
      yield* Deferred.await(interrupted);
      assert.strictEqual(world.gateRunning(run), false);
      assert.ok(!readRun(dataDir, run).entries.some((e) => e.event === "error"));
    }),
  );

  it("wakes the loop only for a gate that decided something", () => {
    assert.strictEqual(gateDecided({ kind: "passed", pr: 12 }), true);
    assert.strictEqual(gateDecided({ kind: "sent-back", attempt: 1 }), true);
    assert.strictEqual(gateDecided({ kind: "stuck", reason: "r" }), true);
    assert.strictEqual(gateDecided({ kind: "ended" }), true);
    assert.strictEqual(gateDecided({ kind: "abandoned" }), true);
    // Nothing changed: the normal poll carries the next try, so a session still at work or a
    // rate limit does not spin the loop.
    assert.strictEqual(gateDecided({ kind: "not-ready" }), false);
    assert.strictEqual(gateDecided({ kind: "unchanged" }), false);
    assert.strictEqual(gateDecided({ kind: "running" }), false);
    assert.strictEqual(gateDecided({ kind: "checks-pending" }), false);
    assert.strictEqual(gateDecided({ kind: "queued", running: 2, max: 2 }), false);
    assert.strictEqual(gateDecided(null), false);
  });

  it("says what a re-gate did in the words of softfac's run line, and nothing for an unchanged one", () => {
    const words = (
      step: Parameters<typeof regateWords>[2],
      moved: Parameters<typeof regateWords>[3],
    ) => regateWords("run-1", REPO, step, moved);
    assert.strictEqual(words({ kind: "unchanged" }, null), null);
    assert.strictEqual(
      words({ kind: "passed", pr: 12 }, "conflict"),
      "GitHub says the pull request conflicts with the base branch, the gate passed again, PR https://github.com/rawphp/softfac/pull/12 stays ready for review",
    );
    assert.strictEqual(
      words({ kind: "passed", pr: 12 }, "head"),
      "the pull request's head moved, the gate passed again, PR https://github.com/rawphp/softfac/pull/12 stays ready for review",
    );
    assert.strictEqual(
      words({ kind: "sent-back", attempt: 2 }, "both"),
      "the pull request's head and the base branch moved, the gate failed on attempt 2, the PR is a draft again and the session was told",
    );
    assert.strictEqual(
      words({ kind: "passed", pr: 12 }, null),
      "no pass was on record, the gate passed again, PR https://github.com/rawphp/softfac/pull/12 stays ready for review",
    );
    assert.strictEqual(
      words({ kind: "stuck", reason: "r" }, "head"),
      `stuck, the reason is in the ledger of run run-1`,
    );
    assert.strictEqual(
      words({ kind: "ended" }, null),
      "the pull request was merged or closed, the run is finished",
    );
    assert.strictEqual(
      words({ kind: "abandoned" }, null),
      "the issue is closed, the run is closed",
    );
    assert.strictEqual(
      words({ kind: "sent-back", attempt: 2 }, "conflict"),
      "GitHub says the pull request conflicts with the base branch, the gate failed on attempt 2, the PR is a draft again and the session was told",
    );
    assert.strictEqual(
      words({ kind: "passed", pr: 12 }, "earlier"),
      "an earlier version of the factory began this re-gate, the gate passed again, PR https://github.com/rawphp/softfac/pull/12 stays ready for review",
    );
    assert.strictEqual(words({ kind: "not-ready" }, null), "the gate waits for the session");
  });

  it("raises a stuck item for a gate that ended stuck, as the pass does, and nothing else", () => {
    assert.deepStrictEqual(gateItem(REPO, 10, "run-1", { kind: "stuck", reason: "r" }), {
      id: "run:run-1:stuck",
      kind: "stuck",
      repo: REPO,
      issue: 10,
      run: "run-1",
      message: `${REPO}#10 stuck, the reason is in the ledger of run run-1`,
    });
    assert.strictEqual(gateItem(REPO, 10, "run-1", { kind: "passed", pr: 12 }), null);
    assert.strictEqual(gateItem(REPO, 10, "run-1", { kind: "sent-back", attempt: 1 }), null);
    assert.strictEqual(gateItem(REPO, 10, "run-1", { kind: "ended" }), null);
    assert.strictEqual(gateItem(REPO, 10, "run-1", { kind: "checks-pending" }), null);
    assert.strictEqual(gateItem(REPO, 10, "run-1", null), null);
  });

  it("raises the abandoned item for a gate that found the issue closed, as the pass does", () => {
    assert.deepStrictEqual(gateItem(REPO, 10, "run-1", { kind: "abandoned" }), {
      id: "attention:run-1:abandoned",
      kind: "attention",
      repo: REPO,
      issue: 10,
      run: "run-1",
      message: `${REPO}#10 Abandoned: the issue was closed, so the factory stopped the session and closed the run`,
    });
  });

  it.effect("takes a stop request the operator left in the data dir", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const run = newRunId(REPO, "10", 1);
      const ledger = Ledger.create(dataDir, run, { clock: () => 1_000 });
      ledger.append(
        { event: "state_changed", data: { from: "triage", to: "building" } },
        makeCause("start", "seed"),
      );
      ledger.close();
      const machine: MachineConfig = baseMachine;
      const world = liveWorld(
        machine,
        dataDir,
        { run: () => Effect.die("no gh") },
        NodeServices.layer,
        stubSessions,
        () => 2_000,
        "mac-mini",
        noAttention,
        {
          gate: { run: () => Effect.die("no gate") },
          wake: Effect.void,
          scope: yield* Scope.make(),
        },
      );
      assert.strictEqual(yield* world.takeStopRequest(run), "none");
      const path = stopRequestPath(dataDir, run);
      NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
      NodeFS.writeFileSync(path, "operator\n");
      assert.strictEqual(yield* world.takeStopRequest(run), "recorded");
      assert.strictEqual(readRun(dataDir, run).entries.at(-1)?.event, "stop_requested");
      assert.strictEqual(yield* world.takeStopRequest(run), "none");
    }),
  );

  it.effect(
    "says a gate send is pending from the run's ledger until the send-back is recorded",
    () =>
      Effect.gen(function* () {
        const dataDir = tempDir();
        const run = newRunId(REPO, "10", 1);
        const other = newRunId(REPO, "11", 1);
        const seed = (id: RunId, steps: ReadonlyArray<string>) => {
          const ledger = Ledger.create(dataDir, id, { clock: () => 1_000 });
          ledger.append(
            { event: "state_changed", data: { from: "triage", to: "building" } },
            makeCause("start", "seed"),
          );
          for (const step of steps) {
            ledger.append({ event: "step_changed", data: { step } }, makeCause("gate", "seed"));
          }
          ledger.close();
        };
        seed(run, ["gate-sending 1 1"]);
        // Another run with nothing pending: the answer is the asked run's.
        seed(other, []);
        const world = liveWorld(
          baseMachine,
          dataDir,
          { run: () => Effect.die("no gh") },
          NodeServices.layer,
          stubSessions,
          () => 2_000,
          "mac-mini",
          noAttention,
          {
            gate: { run: () => Effect.die("no gate") },
            wake: Effect.void,
            scope: yield* Scope.make(),
          },
        );
        assert.strictEqual(yield* world.hasPendingGateSend(run), true);
        assert.strictEqual(yield* world.hasPendingGateSend(other), false);

        const ledger = Ledger.open(dataDir, run, { clock: () => 1_500 });
        ledger.append(
          { event: "gate_sent_back", data: { attempt: 1, run_ordinal: 1 } },
          makeCause("gate", "seed"),
        );
        ledger.close();
        assert.strictEqual(yield* world.hasPendingGateSend(run), false);

        const missing = yield* Effect.flip(world.hasPendingGateSend(newRunId(REPO, "12", 1)));
        assert.ok(isLedgerError(missing), missing.message);
      }),
  );
});

describe("reloading the machine config", () => {
  /** A fake `gh` that records the argv of every call and holds the first call naming each of `repos` until released. */
  const holdingProcess = (repos: ReadonlyArray<string> = ["a/b"]) => {
    const calls: Array<string> = [];
    /** The `GH_CONFIG_DIR` of each call, in the order of `calls`. */
    const ghDirs: Array<string | undefined> = [];
    const holds = new Map(
      repos.map((repo) => [
        repo,
        { held: false, entered: Deferred.makeUnsafe<void>(), release: Deferred.makeUnsafe<void>() },
      ]),
    );
    const process = FactoryProcess.of({
      run: (input) =>
        Effect.gen(function* () {
          const call = [input.command, ...(input.args ?? [])].join(" ");
          calls.push(call);
          ghDirs.push(input.env?.["GH_CONFIG_DIR"]);
          const hold = [...holds].find(([repo]) => call.includes(repo))?.[1];
          if (hold !== undefined && !hold.held) {
            hold.held = true;
            yield* Deferred.succeed(hold.entered, undefined);
            yield* Deferred.await(hold.release);
          }
          return yield* new RunSpawnError({ shell: false, cause: new Error("gh not found") });
        }),
    });
    const first = holds.get(repos[0]!)!;
    return { calls, ghDirs, process, holds, entered: first.entered, release: first.release };
  };

  const OTHER = configFor([["c/d", "/d"]], "/gh2");

  it.effect("goes from idle to running when a valid file appears and is reloaded", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { calls, process, entered, release } = holdingProcess();
        const { loop, write } = yield* started(undefined, process);
        assert.deepStrictEqual(loop.status, { state: "idle", reason: "no factory config" });
        yield* write(VALID);
        yield* loop.reload;
        yield* Deferred.await(entered);
        const pass = yield* Effect.forkChild(loop.awaitPass, { startImmediately: true });
        yield* Deferred.succeed(release, undefined);
        assert.strictEqual((yield* Fiber.join(pass))?.errors, 1);
        assert.deepStrictEqual(loop.status, {
          state: "running",
          settings: { pollSeconds: 60, maxConcurrentRuns: 1, repos: ["a/b"] },
        });
        assert.ok(
          calls.some((call) => call.startsWith("gh ") && call.includes("a/b")),
          calls.join("\n"),
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("goes idle when the file turns invalid or is removed, and passes do nothing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { calls, process, entered, release } = holdingProcess();
        const { loop, write } = yield* started(VALID, process);
        yield* Deferred.await(entered);
        yield* Deferred.succeed(release, undefined);
        yield* write(INVALID);
        yield* loop.reload;
        assert.deepStrictEqual(loop.status, {
          state: "idle",
          reason: "factory config failed to load",
        });
        const seen = calls.length;
        const pass = yield* Effect.forkChild(loop.awaitPass, { startImmediately: true });
        yield* loop.wake;
        assert.deepStrictEqual(yield* Fiber.join(pass), {
          runs: 0,
          claimed: 0,
          errors: 0,
          attention: 0,
        });
        assert.strictEqual(calls.length, seen);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "a pass under way finishes on the config it started with, the next uses the new one",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { calls, ghDirs, process, holds, entered, release } = holdingProcess([
            "a/b",
            "c/d",
          ]);
          const { loop, write } = yield* started(VALID, process);
          yield* Deferred.await(entered);
          const first = yield* Effect.forkChild(loop.awaitPass, { startImmediately: true });
          yield* write(OTHER);
          yield* loop.reload;
          // The pass under way listed a/b, and what was listed last is what the status reports.
          assert.deepStrictEqual(loop.status, {
            state: "running",
            settings: { pollSeconds: 60, maxConcurrentRuns: 1, repos: ["a/b"] },
          });
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(first);
          // The next pass follows at once, on the new config: it is held at its first call.
          const second = holds.get("c/d")!;
          yield* Deferred.await(second.entered);
          const next = yield* Effect.forkChild(loop.awaitPass, { startImmediately: true });
          yield* Deferred.succeed(second.release, undefined);
          yield* Fiber.join(next);
          assert.deepStrictEqual(loop.status, {
            state: "running",
            settings: { pollSeconds: 60, maxConcurrentRuns: 1, repos: ["c/d"] },
          });
          const lastOld = calls.findLastIndex((call) => call.includes("a/b"));
          const firstNew = calls.findIndex((call) => call.includes("c/d"));
          assert.ok(lastOld >= 0 && firstNew > lastOld, calls.join("\n"));
          // The world follows the config too: the pass under way keeps its login, the next one has the new.
          calls.forEach((call, at) => {
            if (call.includes("a/b")) assert.strictEqual(ghDirs[at], "/gh", call);
            if (call.includes("c/d")) assert.strictEqual(ghDirs[at], "/gh2", call);
          });
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );

  // The sessions write where Paradev made the newest worktree, which can be off the default
  // folder; the gate writes under the factory dir.
  it.effect("free space is read where the sessions' worktrees and the gate's checkouts go", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const elsewhere = yield* fs.makeTempDirectoryScoped({ prefix: "factory-worktrees-" });
        for (const moved of [true, false]) {
          const worlds: Array<PassWorld> = [];
          const read: Array<string> = [];
          const { paths } = yield* started(
            VALID,
            holdingProcess().process,
            {
              onWorld: (world) => worlds.push(world),
              readFreeSpace: (path) => {
                read.push(path);
                return { path, freeBytes: path === elsewhere ? 3 : 7, totalBytes: 20 };
              },
            },
            newParadev(),
            // A thread Paradev made under `<elsewhere>/<project>/fac/<branch>`.
            (made) =>
              moved
                ? writeThread(made.baseDir, {
                    v: 2,
                    threadId: "local:ws1",
                    target: { kind: "local" },
                    workspaceId: "ws1",
                    projectId: "project-a/b",
                    branch: "fac/10-1-abc",
                    worktreePath: NodePath.join(elsewhere, "project", "fac", "10-1-abc"),
                    launchCommandId: "command-1",
                    agent: "claude",
                    terminals: [],
                    turns: [],
                    archivedAt: null,
                  })
                : Effect.void,
          );
          const space = yield* worlds[0]!.freeSpace();
          assert.deepStrictEqual(
            read,
            moved ? [elsewhere, paths.factoryDir] : [paths.worktreesDir, paths.factoryDir],
          );
          assert.deepStrictEqual(
            space,
            moved
              ? { path: elsewhere, freeBytes: 3, totalBytes: 20 }
              : { path: paths.worktreesDir, freeBytes: 7, totalBytes: 20 },
          );
        }
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("a reload's world sees the gates the world before it started", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const hold = yield* Deferred.make<void>();
        const process = FactoryProcess.of({
          run: () =>
            Deferred.await(hold).pipe(
              Effect.andThen(
                Effect.fail(new RunSpawnError({ shell: false, cause: new Error("gh not found") })),
              ),
            ),
        });
        const worlds: Array<PassWorld> = [];
        const oneGate = `${VALID}max_concurrent_gates: 1\n`;
        const { loop, factoryDir, write } = yield* started(oneGate, process, {
          onWorld: (world) => worlds.push(world),
        });
        const repo: Repo = {
          watched: { repo: "a/b", path: "/b" },
          project: timeLimitOnlyProjectConfig(),
          trackerUser: "rawphp",
        };
        const run = seedReportedRun(factoryDir, "a/b");
        const other = newRunId("a/b", "11", 1);
        const worldA = worlds[0]!;
        // The gate holds on its first gh call, so it is running when the file changes.
        assert.deepStrictEqual(yield* worldA.gate(repo, run), { kind: "started" });
        yield* write(oneGate.replace("gh_config_dir", "poll_seconds: 30\ngh_config_dir"));
        yield* loop.reload;
        const worldB = worlds[1]!;
        assert.notStrictEqual(worldB, worldA);
        assert.strictEqual(worldB.gateRunning(run), true);
        assert.deepStrictEqual(yield* worldB.gate(repo, other), {
          kind: "queued",
          running: 1,
          max: 1,
        });
        yield* Deferred.succeed(hold, undefined);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("two reloads at once from idle make one loop", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { process, entered, release } = holdingProcess();
        const { loop, write, logs, factoryDir, logLayer } = yield* started(undefined, process);
        yield* write(VALID);
        yield* Effect.all([loop.reload, loop.reload], { concurrency: 2 }).pipe(
          Effect.provide(logLayer),
        );
        // The one first pass is held at its first call; a second loop would have started a pass of its own.
        yield* Deferred.await(entered);
        for (let i = 0; i < 20; i++) yield* Effect.yieldNow;
        yield* realDelay(50);
        assert.strictEqual(eventsOf(factoryDir, "pass_started").length, 1);
        assert.strictEqual(logs.filter((line) => line === "runner started").length, 1);
        assert.strictEqual(logs.filter((line) => line === "factory config reloaded").length, 1);
        // The second reload's wake is the one more pass that follows the first.
        yield* Deferred.succeed(release, undefined);
        yield* idleAfter(loop, factoryDir, 2);
        assert.strictEqual(eventsOf(factoryDir, "pass_started").length, 2);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});

// ---- liveWorldBase.test.ts ------------------------------------------------------------------

const baseRepo: Repo = {
  watched: { repo: "rawphp/softfac", path: "/p" },
  project: { ...timeLimitOnlyProjectConfig(), base: "main" },
  trackerUser: "rawphp",
};

const noGh = FactoryProcess.of({ run: () => Effect.die("no gh") });

const baseLive = (scope: Scope.Scope) => ({
  gate: { run: () => Effect.die("no gate") },
  wake: Effect.void,
  scope,
});

describe("liveWorld: a step of a run is built for the base the pass hands it", () => {
  it.effect("each step's context has that base, or the repo's when the run recorded none", () =>
    Effect.gen(function* () {
      bases.length = 0;
      stub.on = true;
      yield* Effect.ensuring(
        Effect.gen(function* () {
          const world = liveWorld(
            baseMachine,
            "/factory-test/data",
            noGh,
            NodeServices.layer,
            stubSessions,
            () => 0,
            "mac-mini",
            noAttention,
            baseLive(yield* Scope.make()),
          );
          const run = newRunId("rawphp/softfac", "10", 1);
          const evidence = { t3Error: null, endedInPass: 1, t3Starts: [], t3Stops: [] };
          for (const base of ["feature/x", null]) {
            yield* world.timeLimit(baseRepo, run, base);
            yield* world.watch(baseRepo, run, base);
            yield* world.forward(baseRepo, run, base);
            yield* world.advance(baseRepo, run, base);
            yield* world.interrupted(baseRepo, run, base, evidence);
            yield* world.resumeAfterCooldown(baseRepo, run, base, null);
            yield* world.feedback(baseRepo, run, base);
          }
        }),
        Effect.sync(() => {
          stub.on = false;
        }),
      );
      assert.deepStrictEqual(bases, [
        "timeLimit feature/x",
        "watch feature/x",
        "forward feature/x",
        "advance feature/x",
        "interrupted feature/x",
        "resumeAfterCooldown feature/x",
        "feedback feature/x",
        "timeLimit main",
        "watch main",
        "forward main",
        "advance main",
        "interrupted main",
        "resumeAfterCooldown main",
        "feedback main",
      ]);
    }),
  );
});

describe("liveWorld: a model that cools down", () => {
  const FABLE = { instanceId: "claudeAgent", model: "claude-fable-5-1" };
  const OPUS = { instanceId: "claudeAgent", model: "claude-opus-5-5" };

  it.effect(
    "new claims launch on its fallback until its window ends, from the shared cooldowns",
    () =>
      Effect.gen(function* () {
        const cooldowns = new Map<string, Cooldown>();
        let now = T0;
        const world = liveWorld(
          {
            ...baseMachine,
            modelFallbacks: { "claude-fable-5-1": "claude-opus-5-5" },
            paradev: { ...PARADEV, agent: FABLE.instanceId, model: FABLE.model },
          },
          "/factory-test/data",
          noGh,
          NodeServices.layer,
          stubSessions,
          () => now,
          "mac-mini",
          noAttention,
          baseLive(yield* Scope.make()),
          undefined,
          undefined,
          { ...newShared(), cooldowns },
        );
        assert.strictEqual(world.cooldowns, cooldowns);
        assert.deepStrictEqual(yield* world.projectModel(baseRepo), FABLE);
        recordRateLimit(cooldowns, cooldownKey(FABLE), FABLE, T0, T0, null);
        stub.on = true;
        yield* Effect.ensuring(
          world.start(baseRepo, 7),
          Effect.sync(() => {
            stub.on = false;
          }),
        );
        const ctx = startContexts.at(-1) as StartContext;
        // factory.owner is matched against the name a claim records as its machine.
        assert.strictEqual(ctx.machine, "mac-mini");
        assert.strictEqual(world.machineName, ctx.machine);
        assert.deepStrictEqual(ctx.launchModel?.(FABLE), OPUS);
        now = T0 + 5 * 60_000;
        assert.deepStrictEqual(ctx.launchModel?.(FABLE), FABLE);
      }),
  );
});

describe("liveWorld: the sessions of runs, for threads on a broken worktree", () => {
  const tempDir = useTempDirs();

  const worldOver = (dataDir: string) =>
    Effect.gen(function* () {
      return liveWorld(
        baseMachine,
        dataDir,
        noGh,
        NodeServices.layer,
        stubSessions,
        () => 0,
        "mac-mini",
        noAttention,
        baseLive(yield* Scope.make()),
      );
    });

  /** A run whose session is `threadId`, launched before Paradev had made its worktree. */
  const launched = (dataDir: string, issue: string, threadId: string, finish: boolean) => {
    const run = newRunId("rawphp/softfac", issue, 1);
    const ledger = Ledger.create(dataDir, run, { clock: ticking(T0, 1000) });
    ledger.append(
      {
        event: "session_launched",
        data: {
          thread_id: threadId,
          worktree: null,
          branch: null,
          model_instance: null,
          model: null,
          model_options: null,
          resumed_from: null,
        },
      },
      makeCause("start", "session-launched"),
    );
    if (finish) ledger.finish("stuck", null, null, makeCause("start", "stuck"));
    ledger.close();
    return run;
  };

  it.effect("reads which run each session thread was launched for, and whether it is stopped", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const finished = launched(dataDir, "187", "session-1", true);
      const going = launched(dataDir, "188", "session-2", false);
      const world = yield* worldOver(dataDir);
      const { runs, complete } = yield* world.sessionRuns();
      assert.isTrue(complete);
      assert.deepStrictEqual(
        [...runs],
        [
          ["session-1", { run: finished, stopped: true }],
          ["session-2", { run: going, stopped: false }],
        ],
      );
    }),
  );

  it.effect("fails as a ledger error when the ledger cannot be read", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      NodeFS.writeFileSync(NodePath.join(dataDir, "runs"), "not a folder");
      const world = yield* worldOver(dataDir);
      const error = yield* Effect.flip(world.sessionRuns());
      assert.strictEqual(error.kind, "ledger");
    }),
  );
});

describe("liveWorld: the hosts", () => {
  const HOSTS = "hosts:\n  - id: h1\n    name: mini\n    ssh: me@mini\n    max_runs: 2\n";
  const refused: SshSpawn = () =>
    Effect.succeed({ exitCode: 255, timedOut: false, stdout: "", stderr: "Connection refused\n" });
  /** A host whose every ssh read passes: no proxy name missing, an email, gh and claude there. */
  const healthy: SshSpawn = (args) =>
    Effect.succeed({
      exitCode: 0,
      timedOut: false,
      stdout: args.at(-1) === PROXY_ENV_READ ? "" : "me@example.com\n",
      stderr: "",
    });
  const hostsListed = (paradev: FakeParadev) =>
    paradev.calls.filter((argv) => argv.join(" ") === "hosts list").length;

  it.effect("the first pass's checks find a failing host not ready, with one attention item", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { loop, factoryDir, attention, paradev } = yield* started(
          configFor([["a/b", "/b"]], "/gh", HOSTS),
          noGhProcess,
          { ssh: refused },
          newParadev(),
        );
        yield* idleAfter(loop, factoryDir, 1);
        const notReady = () =>
          Effect.map(attention.list(), (items) => items.filter((item) => item.id === "host-not-ready:h1"));
        // The checks run beside the pass, so they can end after it.
        let items = yield* notReady();
        for (const until = Date.now() + 30_000; items.length === 0 && Date.now() < until; ) {
          yield* realDelay(5);
          items = yield* notReady();
        }
        assert.strictEqual(items.length, 1);
        assert.include(items[0]!.message, "host mini is not ready: online: add it with superset hosts add me@mini --name mini");
        assert.isTrue(hostsListed(paradev) > 0);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("a host check that never answers holds up no pass, and the host stays not ready", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const worlds: Array<PassWorld> = [];
        const { loop, factoryDir, paradev } = yield* started(
          configFor([["a/b", "/b"]], "/gh", HOSTS),
          noGhProcess,
          {
            // The pass's load read answers; every read of the check hangs.
            ssh: (args) =>
              args.at(-1) === LOAD_COMMAND
                ? Effect.succeed({ exitCode: 0, timedOut: false, stdout: "{ 2.11 1.87 1.72 }\n12\n", stderr: "" })
                : Effect.never,
            onWorld: (world) => worlds.push(world),
          },
          newParadev(),
        );
        yield* idleAfter(loop, factoryDir, 1);
        // The check got as far as ssh, which never answers, and the pass ended anyway.
        assert.isTrue(hostsListed(paradev) > 0);
        assert.deepStrictEqual(worlds[0]!.hostLoads.get("h1"), { oneMinute: 2.11, cores: 12 });
        assert.strictEqual(worlds[0]!.hostsNotReady.get("h1"), "not checked yet since the config load");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("a world starts with every host not checked yet, so placement sees none as ready", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const seen: Array<ReadonlyArray<readonly [string, string]>> = [];
        const { loop, factoryDir } = yield* started(
          configFor([["a/b", "/b"]], "/gh", HOSTS),
          noGhProcess,
          { ssh: refused, onWorld: (world) => seen.push([...world.hostsNotReady]) },
          newParadev(),
        );
        yield* idleAfter(loop, factoryDir, 1);
        assert.deepStrictEqual(seen, [[["h1", "not checked yet since the config load"]]]);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("a reload checks a host that passed again, and it is not ready until that check passes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const worlds: Array<PassWorld> = [];
        const paradev = newParadev();
        paradev.hostsList = [{ id: "h1", name: "mini", online: "yes" }];
        const { loop, factoryDir } = yield* started(
          configFor([["a/b", "/b"]], "/gh", HOSTS),
          noGhProcess,
          { ssh: healthy, onWorld: (world) => worlds.push(world) },
          paradev,
        );
        yield* idleAfter(loop, factoryDir, 1);
        yield* waitUntil("the first check to pass", () => worlds[0]!.hostsNotReady.size === 0);
        assert.strictEqual(hostsListed(paradev), 1);
        yield* loop.reload;
        assert.strictEqual(worlds.length, 2);
        assert.strictEqual(worlds[1]!.hostsNotReady.get("h1"), "not checked yet since the config load");
        yield* waitUntil("the check after the reload to pass", () => worlds[1]!.hostsNotReady.size === 0);
        assert.strictEqual(hostsListed(paradev), 2);
        assert.isTrue(worlds[1]!.hostCheckedAt.has("h1"));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});
