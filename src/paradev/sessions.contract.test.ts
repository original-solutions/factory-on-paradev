// @effect-diagnostics nodeBuiltinImport:off - the tests build real git repos and read the adapter's files.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import { useTempDirs } from "../ledger/testSupport.ts";
import { FactoryPaths } from "../paths.ts";
import { layer as processLayer } from "../process.ts";
import { ThreadNotFoundError, type LaunchRequest } from "../sessions.ts";
import { layer as cliLayer } from "./cli.ts";
import { fakeSuperset, readFixture, type Step } from "./fake-superset.ts";
import { AgentProcess, agentProcessLayer, make, type ParadevSessions } from "./sessions.ts";
import { readLaunch, readThread, type ThreadRecord, writeLaunch, writeThread } from "./state.ts";

const tempDir = useTempDirs();

const SPIKE_PROJECT = "e9ab7dc2-e7f6-42d9-94ed-82d6d623aabd";
/** The x8 workspace: created without `--agent`, on a base the clone did not have. */
const X8_WS = "f7631c1d-214c-4a35-98b8-fd0cba008887";
/** The L5b workspace, whose agent was killed and resumed. */
const L5_WS = "9a9a5fef-ec66-4036-9bf0-d8302e8bb39f";
const L5_DEAD = "5e3b1255-4f81-40c6-b003-e42416740258";
const L5_RESUMED = "58426e6d-e788-40de-8ba1-ab6a4e752482";
/** The L1 workspace and its first agent's terminal. */
const L1_WS = "be47b9e8-7687-4c3c-8791-5fd7f04ba5fe";
const L1_TERM = "27446599-a510-4df8-989b-45938576d96b";
const LAUNCH_ID = "softfac:original-solutions__factory-paradev-spike__1__1:launch";
const MINUTE = 60_000;

// ---- real git -------------------------------------------------------------------------------

const git = (cwd: string, ...args: ReadonlyArray<string>): string =>
  NodeChildProcess.execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  }).trim();

const commit = (cwd: string, file: string): string => {
  NodeFS.writeFileSync(NodePath.join(cwd, file), file);
  git(cwd, "add", file);
  git(cwd, "commit", "-q", "-m", file);
  return git(cwd, "rev-parse", "HEAD");
};

/**
 * An origin with `main` at `main`, and `x8-origin-only` one commit on, pushed after the clone was
 * made, so the clone has never seen it (X8). `worktree` is where `workspaces get` will say the
 * workspace lives; the test makes it from the clone on `startAt`, as Paradev would.
 */
const repos = () => {
  const root = tempDir("repos");
  const origin = NodePath.join(root, "origin.git");
  const seed = NodePath.join(root, "seed");
  const clone = NodePath.join(root, "clone");
  NodeChildProcess.execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  NodeChildProcess.execFileSync("git", ["clone", "-q", origin, seed], { stdio: "ignore" });
  git(seed, "checkout", "-q", "-b", "main");
  const main = commit(seed, "a.txt");
  git(seed, "push", "-q", "origin", "main");
  NodeChildProcess.execFileSync("git", ["clone", "-q", origin, clone]);
  git(seed, "checkout", "-q", "-b", "x8-origin-only");
  const originOnly = commit(seed, "b.txt");
  git(seed, "push", "-q", "origin", "x8-origin-only");
  const worktree = NodePath.join(root, "paradev", "worktrees", "factory-paradev-spike", "fac", "1-1");
  const addWorktree = (branch: string, startAt: string) =>
    git(clone, "worktree", "add", "-q", "-b", branch, worktree, startAt);
  return { clone, main, originOnly, worktree, addWorktree };
};

/** The reflog of the worktree's HEAD, newest first: a reset shows as `reset: moving to …`. */
const reflog = (worktree: string): string => git(worktree, "reflog", "--format=%gs");

// ---- the adapter over fake-superset ---------------------------------------------------------

const CONFIG = { agent: "claude", agentCommand: "claude" } as const;

const MODEL = {
  instanceId: "claude",
  model: "opus",
  options: [
    { id: "effort", value: "high" },
    { id: "thinking", value: true },
  ],
} as const;

const request = (over: Partial<LaunchRequest> = {}): LaunchRequest => ({
  commandId: LAUNCH_ID,
  projectId: SPIKE_PROJECT,
  title: "fac #1 multiply",
  baseRef: "main",
  startFromOrigin: true,
  message: "/factory original-solutions/factory-paradev-spike#1",
  model: MODEL,
  ...over,
});

interface Rig {
  readonly data: string;
  readonly calls: Array<ReadonlyArray<string>>;
  readonly unused: () => ReadonlyArray<Step>;
  readonly lookups: Array<readonly [string, string]>;
  readonly run: <A, E>(
    body: (sessions: ParadevSessions) => Effect.Effect<A, E, never>,
  ) => Effect.Effect<A, E, never>;
}

const rig = (script: ReadonlyArray<Step>, options: { readonly agentRunning?: boolean } = {}): Rig => {
  const fake = fakeSuperset(script);
  const data = tempDir("data");
  const lookups: Array<readonly [string, string]> = [];
  const layer = Layer.mergeAll(
    cliLayer({ cli: "superset" }).pipe(Layer.provide(fake.layer)),
    processLayer,
    NodeServices.layer,
    Layer.succeed(FactoryPaths, {
      baseDir: data,
      worktreesDir: "/default/worktrees",
      factoryDir: data,
      machineConfigPath: NodePath.join(data, "config.yml"),
    }),
    Layer.succeed(
      AgentProcess,
      AgentProcess.of({
        find: (command, cwd) =>
          Effect.sync(() => {
            lookups.push([command, cwd]);
            return options.agentRunning === true ? 4242 : null;
          }),
      }),
    ),
  );
  return {
    data,
    calls: fake.calls,
    unused: fake.unused,
    lookups,
    run: (body) =>
      Effect.gen(function* () {
        return yield* body(yield* make(CONFIG));
      }).pipe(Effect.provide(layer)),
  };
};

const argvIs =
  (...prefix: ReadonlyArray<string>) =>
  (argv: ReadonlyArray<string>): boolean =>
    prefix.every((arg, i) => argv[i] === arg);

/** The value after `flag` in `argv`. */
const flag = (argv: ReadonlyArray<string> | undefined, name: string): string | undefined => {
  const at = argv?.indexOf(name) ?? -1;
  return at === -1 ? undefined : argv![at + 1];
};

const withPath = (path: string) => (answer: unknown) => ({ ...(answer as object), worktreePath: path });
const withProjectPath = (path: string) => (answer: unknown) =>
  (answer as ReadonlyArray<{ readonly id: string }>).map((p) =>
    p.id === SPIKE_PROJECT ? { ...p, path } : p,
  );
/** A snapshot of one workspace, renamed to `id`, with `terminals` as given (or as recorded). */
const snapshotOf =
  (id: string, terminals?: ReadonlyArray<unknown>) =>
  (answer: unknown) => {
    const [ws] = (answer as { readonly workspaces: ReadonlyArray<Record<string, unknown>> }).workspaces;
    return { workspaces: [{ ...ws, id, terminals: terminals ?? ws!.terminals }] };
  };

const record = (over: Partial<ThreadRecord> = {}): ThreadRecord => ({
  v: 1,
  threadId: `local:${L1_WS}`,
  location: "local",
  workspaceId: L1_WS,
  projectId: SPIKE_PROJECT,
  branch: "fac/1-1",
  worktreePath: "/Users/me/.paradev/worktrees/factory-paradev-spike/fac/1-1",
  launchCommandId: LAUNCH_ID,
  agent: "claude",
  terminals: [L1_TERM],
  turns: [{ commandId: LAUNCH_ID, at: 1794329708000, kind: "launch" }],
  archivedAt: null,
  ...over,
});

const seed = (data: string, ...records: ReadonlyArray<ThreadRecord>) =>
  Effect.forEach(records, (r) => writeThread(data, r)).pipe(Effect.provide(NodeServices.layer));

const lastEventAt = (fixture: string): number =>
  (JSON.parse(readFixture(fixture).stdout) as { readonly lastEventAt: number }).lastEventAt;

// ---- launch ---------------------------------------------------------------------------------

/** Every step of a first launch, from `projects list` to `agents create`. */
const launchScript = (r: ReturnType<typeof repos>): ReadonlyArray<Step> => [
  { argv: ["projects", "list", "--local"], fixture: "projects-list-local", edit: withProjectPath(r.clone) },
  { argv: argvIs("workspaces", "create"), fixture: "ws-create-local-x8" },
  { argv: ["workspaces", "get", X8_WS, "--local"], fixture: "ws-get-local-x8", edit: withPath(r.worktree) },
  { argv: ["snapshot", "--workspace", X8_WS], fixture: "snapshot-local-before-kill", edit: snapshotOf(X8_WS, []) },
  { argv: argvIs("agents", "create"), fixture: "agents-create-local-resume" },
];

describe("launch", () => {
  it.live("creates the workspace with no --agent, starts the agent with agents create, records the thread", () =>
    Effect.gen(function* () {
      const r = repos();
      r.addWorktree("fac/x8", "main");
      const before = reflog(r.worktree);
      const t = rig([
        ...launchScript(r),
        { argv: argvIs("agents", "explain"), fixture: "agents-explain-local-starting" },
      ]);
      const launched = yield* t.run((s) => s.launch(request()));
      assert.deepStrictEqual(launched, { threadId: `local:${X8_WS}`, worktreePath: r.worktree, branch: "fac/x8" });

      assert.deepStrictEqual(
        t.calls.map((argv) => argv.slice(0, 2).join(" ")),
        ["projects list", "workspaces create", "workspaces get", "snapshot --workspace", "agents create"],
      );
      assert.deepStrictEqual(t.calls[1], [
        "workspaces", "create", "--local", "--project", SPIKE_PROJECT, "--name", "fac #1 multiply",
        "--branch", "fac/1-1", "--skip-branch-prefix", "--base-branch", "main", "--tag", "factory",
      ]);
      assert.deepStrictEqual(t.calls[4], [
        "agents", "create", "--local", "--workspace", X8_WS, "--agent", "claude",
        "--model", "opus", "--effort", "high", "--prompt", "/factory original-solutions/factory-paradev-spike#1",
      ]);
      // The worktree was already at main: the base check reset nothing.
      assert.strictEqual(git(r.worktree, "rev-parse", "HEAD"), r.main);
      assert.strictEqual(reflog(r.worktree), before);

      const saved = yield* readThread(t.data, X8_WS).pipe(Effect.provide(NodeServices.layer));
      assert.deepInclude(saved, {
        threadId: `local:${X8_WS}`,
        location: "local",
        workspaceId: X8_WS,
        projectId: SPIKE_PROJECT,
        branch: "fac/x8",
        worktreePath: r.worktree,
        launchCommandId: LAUNCH_ID,
        agent: "claude",
        terminals: [L5_RESUMED],
        archivedAt: null,
      });
      assert.deepStrictEqual(saved!.turns.map((turn) => [turn.commandId, turn.kind]), [[LAUNCH_ID, "launch"]]);
      assert.strictEqual(
        yield* readLaunch(t.data, LAUNCH_ID).pipe(Effect.provide(NodeServices.layer)),
        `local:${X8_WS}`,
      );

      // Right after the start, explain says `none` until the agent's first hook.
      const status = yield* t.run((s) => s.status(`local:${X8_WS}`));
      assert.deepInclude(status, { run: "starting", runOrdinal: 1, archived: false, branch: "fac/x8" });
      assert.deepStrictEqual(t.unused(), []);
    }),
  );

  it.live("fetches the base into the repo clone before it creates the workspace", () =>
    Effect.gen(function* () {
      const r = repos();
      r.addWorktree("fac/x8", "main");
      const t = rig(launchScript(r));
      yield* t.run((s) => s.launch(request({ baseRef: "x8-origin-only" })));
      assert.strictEqual(git(r.clone, "rev-parse", "origin/x8-origin-only"), r.originOnly);
    }),
  );

  it.live("passes no --model when the model is empty, and only the effort entry of the options", () =>
    Effect.gen(function* () {
      const r = repos();
      r.addWorktree("fac/x8", "main");
      const t = rig(launchScript(r));
      yield* t.run((s) =>
        s.launch(request({ model: { instanceId: "claude", model: "", options: [{ id: "thinking", value: "on" }] } })),
      );
      const create = t.calls.find(argvIs("agents", "create"));
      assert.deepStrictEqual(create, [
        "agents", "create", "--local", "--workspace", X8_WS, "--agent", "claude",
        "--prompt", "/factory original-solutions/factory-paradev-spike#1",
      ]);
    }),
  );

  it.live("cuts the workspace name to 80 characters", () =>
    Effect.gen(function* () {
      const r = repos();
      r.addWorktree("fac/x8", "main");
      const t = rig(launchScript(r));
      yield* t.run((s) => s.launch(request({ title: "t".repeat(200) })));
      assert.strictEqual(flag(t.calls.find(argvIs("workspaces", "create")), "--name"), "t".repeat(80));
    }),
  );

  it.live("resets a worktree that Paradev built from the wrong base before the agent starts", () =>
    Effect.gen(function* () {
      const r = repos();
      // X8: Paradev fell back to the project default, main, for a base the clone did not have.
      r.addWorktree("fac/x8", "main");
      const t = rig(launchScript(r));
      yield* t.run((s) => s.launch(request({ baseRef: "x8-origin-only" })));
      assert.strictEqual(git(r.worktree, "rev-parse", "HEAD"), r.originOnly);
      assert.include(reflog(r.worktree).split("\n")[0], "reset: moving to origin/x8-origin-only");
      assert.strictEqual(git(r.worktree, "symbolic-ref", "--short", "HEAD"), "fac/x8");
      assert.strictEqual(flag(t.calls.find(argvIs("workspaces", "create")), "--base-branch"), "x8-origin-only");
    }),
  );

  it.live("without startFromOrigin the base check compares with the local ref", () =>
    Effect.gen(function* () {
      const r = repos();
      git(r.clone, "fetch", "-q", "origin", "x8-origin-only");
      r.addWorktree("fac/x8", "origin/x8-origin-only");
      const t = rig(launchScript(r));
      yield* t.run((s) => s.launch(request({ baseRef: "main", startFromOrigin: false })));
      assert.strictEqual(git(r.worktree, "rev-parse", "HEAD"), r.main);
      assert.include(reflog(r.worktree).split("\n")[0], "reset: moving to main");
    }),
  );

  it.live("a second launch with the same command id starts nothing", () =>
    Effect.gen(function* () {
      const r = repos();
      r.addWorktree("fac/x8", "main");
      const t = rig(launchScript(r));
      const first = yield* t.run((s) => s.launch(request()));
      const calls = t.calls.length;
      const second = yield* t.run((s) => s.launch(request()));
      assert.deepStrictEqual(second, first);
      assert.strictEqual(t.calls.length, calls);
    }),
  );

  it.live("a launch that died before its launch file adopts the agent it finds instead of starting one", () =>
    Effect.gen(function* () {
      const r = repos();
      r.addWorktree("fac/1-1", "main");
      const t = rig([
        { argv: ["projects", "list", "--local"], fixture: "projects-list-local", edit: withProjectPath(r.clone) },
        // X7: create on a branch that already has a workspace answers it with alreadyExists.
        { argv: argvIs("workspaces", "create"), fixture: "ws-create-local-repeat" },
        { argv: ["workspaces", "get", L1_WS, "--local"], fixture: "ws-get-local", edit: withPath(r.worktree) },
        { argv: ["snapshot", "--workspace", L1_WS], fixture: "snapshot-local-before-kill", edit: snapshotOf(L1_WS) },
      ]);
      const launched = yield* t.run((s) => s.launch(request()));
      assert.strictEqual(launched.threadId, `local:${L1_WS}`);
      assert.isUndefined(t.calls.find(argvIs("agents", "create")));
      const saved = yield* readThread(t.data, L1_WS).pipe(Effect.provide(NodeServices.layer));
      assert.deepStrictEqual(saved!.terminals, [L5_DEAD]);
      assert.deepStrictEqual(saved!.turns.map((turn) => turn.kind), ["launch"]);
      assert.deepStrictEqual(t.unused(), []);
    }),
  );
});

describe("launch after a crash between the launch file and the agent's start", () => {
  const crashed = (data: string, worktreePath: string | null) =>
    Effect.gen(function* () {
      yield* writeThread(data, record({ threadId: `local:${L5_WS}`, workspaceId: L5_WS, branch: "fac/2-1", worktreePath, terminals: [], turns: [] }));
      yield* writeLaunch(data, LAUNCH_ID, `local:${L5_WS}`);
    }).pipe(Effect.provide(NodeServices.layer));

  it.live("adopts the agent the earlier attempt started, with no create call", () =>
    Effect.gen(function* () {
      const t = rig([{ argv: ["snapshot", "--workspace", L5_WS], fixture: "snapshot-local-before-kill" }]);
      yield* crashed(t.data, null);
      const launched = yield* t.run((s) => s.launch(request()));
      assert.strictEqual(launched.threadId, `local:${L5_WS}`);
      assert.deepStrictEqual(t.calls, [["snapshot", "--workspace", L5_WS]]);
      const saved = yield* readThread(t.data, L5_WS).pipe(Effect.provide(NodeServices.layer));
      assert.deepStrictEqual(saved!.terminals, [L5_DEAD]);
      assert.deepStrictEqual(saved!.turns.map((turn) => [turn.commandId, turn.kind]), [[LAUNCH_ID, "launch"]]);
    }),
  );

  it.live("starts the agent, after get and the base check, when none is there", () =>
    Effect.gen(function* () {
      const r = repos();
      r.addWorktree("fac/2-1", "main");
      const t = rig([
        { argv: ["snapshot", "--workspace", L5_WS], fixture: "snapshot-local-before-kill", edit: snapshotOf(L5_WS, []) },
        { argv: ["workspaces", "get", L5_WS, "--local"], fixture: "ws-get-local-x8", edit: withPath(r.worktree) },
        { argv: ["snapshot", "--workspace", L5_WS], fixture: "snapshot-local-before-kill", edit: snapshotOf(L5_WS, []) },
        { argv: argvIs("agents", "create", "--local", "--workspace", L5_WS), fixture: "agents-create-local-resume" },
      ]);
      yield* crashed(t.data, null);
      yield* t.run((s) => s.launch(request({ baseRef: "x8-origin-only" })));
      assert.deepStrictEqual(
        t.calls.map((argv) => argv.slice(0, 2).join(" ")),
        ["snapshot --workspace", "workspaces get", "snapshot --workspace", "agents create"],
      );
      // The base check ran on the resumed path too, against the base fetched now.
      assert.strictEqual(git(r.worktree, "rev-parse", "HEAD"), r.originOnly);
      const saved = yield* readThread(t.data, L5_WS).pipe(Effect.provide(NodeServices.layer));
      assert.deepStrictEqual(saved!.terminals, [L5_RESUMED]);
      assert.strictEqual(saved!.worktreePath, r.worktree);
      assert.deepStrictEqual(t.unused(), []);
    }),
  );
});

// ---- status ---------------------------------------------------------------------------------

const explainAt = (fixture: string, ws = L1_WS, term = L1_TERM): Step => ({
  argv: ["agents", "explain", "--local", "--workspace", ws, "--terminal", term],
  fixture,
});

describe("status", () => {
  it.effect("none within 5 minutes of the newest turn is starting", () =>
    Effect.gen(function* () {
      const t = rig([explainAt("agents-explain-local-starting")]);
      yield* seed(t.data, record());
      yield* TestClock.setTime(1794329708000 + 4 * MINUTE);
      const status = yield* t.run((s) => s.status(`local:${L1_WS}`));
      assert.deepStrictEqual(status, {
        worktreePath: record().worktreePath,
        branch: "fac/1-1",
        archived: false,
        run: "starting",
        runOrdinal: 1,
        runStartedAt: 1794329708000,
        runCompletedAt: null,
        lastAssistantMessage: null,
      });
    }),
  );

  it.effect("none later than that is interrupted", () =>
    Effect.gen(function* () {
      const t = rig([
        explainAt("agents-explain-local-starting"),
        { argv: argvIs("agents", "read"), fixture: "agents-read-local" },
      ]);
      yield* seed(t.data, record());
      yield* TestClock.setTime(1794329708000 + 6 * MINUTE);
      const status = yield* t.run((s) => s.status(`local:${L1_WS}`));
      assert.strictEqual(status.run, "interrupted");
      assert.isNull(status.runCompletedAt);
    }),
  );

  it.effect("working with a recent hook is running, with no process lookup", () =>
    Effect.gen(function* () {
      const t = rig([explainAt("agents-explain-local-killed", L5_WS, L5_DEAD)]);
      yield* seed(t.data, record({ threadId: `local:${L5_WS}`, workspaceId: L5_WS, terminals: [L5_DEAD] }));
      yield* TestClock.setTime(lastEventAt("agents-explain-local-killed") + 9 * MINUTE);
      const status = yield* t.run((s) => s.status(`local:${L5_WS}`));
      assert.strictEqual(status.run, "running");
      assert.isNull(status.lastAssistantMessage);
      assert.deepStrictEqual(t.lookups, []);
    }),
  );

  it.effect("idle after Stop is completed at the last hook, with the last assistant message", () =>
    Effect.gen(function* () {
      const t = rig([
        explainAt("agents-explain-local-idle"),
        { argv: ["agents", "read", "--local", "--workspace", L1_WS, "--terminal", L1_TERM], fixture: "agents-read-local" },
      ]);
      yield* seed(t.data, record());
      yield* TestClock.setTime(lastEventAt("agents-explain-local-idle") + MINUTE);
      const status = yield* t.run((s) => s.status(`local:${L1_WS}`));
      assert.strictEqual(status.run, "completed");
      assert.strictEqual(status.runCompletedAt, lastEventAt("agents-explain-local-idle"));
      assert.isTrue(
        status.lastAssistantMessage!.endsWith(
          "FACTORY-DONE: https://github.com/original-solutions/factory-paradev-spike/pull/7",
        ),
      );
    }),
  );

  it.effect("runOrdinal counts the record's turns and runStartedAt is the newest one's", () =>
    Effect.gen(function* () {
      const t = rig([explainAt("agents-explain-local-after-gate"), { argv: argvIs("agents", "read"), fixture: "agents-read-local-after-gate" }]);
      yield* seed(
        t.data,
        record({
          turns: [
            { commandId: LAUNCH_ID, at: 1794329708000, kind: "launch" },
            { commandId: "softfac:o__r__1__1:gate:1:1", at: 1794330000000, kind: "send" },
          ],
        }),
      );
      yield* TestClock.setTime(lastEventAt("agents-explain-local-after-gate") + MINUTE);
      const status = yield* t.run((s) => s.status(`local:${L1_WS}`));
      assert.deepInclude(status, { run: "completed", runOrdinal: 2, runStartedAt: 1794330000000 });
      assert.isTrue(status.lastAssistantMessage!.startsWith("I couldn't reproduce the gate failure"));
    }),
  );

  it.effect("reads the resumed agent's transcript from the record's current terminal", () =>
    Effect.gen(function* () {
      const t = rig([
        explainAt("agents-explain-local-idle", L5_WS, L5_RESUMED),
        { argv: ["agents", "read", "--local", "--workspace", L5_WS, "--terminal", L5_RESUMED], fixture: "agents-read-local-resume" },
      ]);
      yield* seed(t.data, record({ threadId: `local:${L5_WS}`, workspaceId: L5_WS, terminals: [L5_DEAD, L5_RESUMED] }));
      const status = yield* t.run((s) => s.status(`local:${L5_WS}`));
      assert.isTrue(status.lastAssistantMessage!.endsWith("pull/10"));
    }),
  );

  it.effect("Workspace not found is ThreadNotFoundError, and so is a thread with no record", () =>
    Effect.gen(function* () {
      const t = rig([explainAt("agents-explain-local-archived", L5_WS, L5_RESUMED)]);
      yield* seed(t.data, record({ threadId: `local:${L5_WS}`, workspaceId: L5_WS, terminals: [L5_RESUMED] }));
      const gone = yield* Effect.flip(t.run((s) => s.status(`local:${L5_WS}`)));
      assert.instanceOf(gone, ThreadNotFoundError);
      const unknown = yield* Effect.flip(t.run((s) => s.status(`local:${X8_WS}`)));
      assert.instanceOf(unknown, ThreadNotFoundError);
      const foreign = yield* Effect.flip(t.run((s) => s.status("t3-thread-1")));
      assert.instanceOf(foreign, ThreadNotFoundError);
    }),
  );

  it.effect("an archived record answers archived with no CLI call", () =>
    Effect.gen(function* () {
      const t = rig([]);
      yield* seed(t.data, record({ archivedAt: 1794330100000 }));
      const status = yield* t.run((s) => s.status(`local:${L1_WS}`));
      assert.deepInclude(status, { archived: true, run: null });
      assert.deepStrictEqual(t.calls, []);
    }),
  );

  it.effect("an offline Paradev is a SessionsError, not a missing thread", () =>
    Effect.gen(function* () {
      const t = rig([{ argv: argvIs("agents", "explain"), fixture: "agents-explain-local-appquit" }]);
      yield* seed(t.data, record());
      const error = yield* Effect.flip(t.run((s) => s.status(`local:${L1_WS}`)));
      assert.strictEqual(error._tag, "FactorySessionsError");
      assert.strictEqual((error as { operation: string }).operation, "status");
    }),
  );
});

describe("status of a dead agent (the liveness check)", () => {
  const dead = (agentRunning: boolean) =>
    Effect.gen(function* () {
      const t = rig(
        [
          explainAt("agents-explain-local-killed", L5_WS, L5_DEAD),
          { argv: argvIs("agents", "read"), fixture: "agents-read-local-killed" },
        ],
        { agentRunning },
      );
      const worktreePath = "/Users/me/.paradev/worktrees/factory-paradev-spike/fac/2-1";
      yield* seed(t.data, record({ threadId: `local:${L5_WS}`, workspaceId: L5_WS, worktreePath, terminals: [L5_DEAD] }));
      yield* TestClock.setTime(lastEventAt("agents-explain-local-killed") + 11 * MINUTE);
      const status = yield* t.run((s) => s.status(`local:${L5_WS}`));
      return { status, lookups: t.lookups, worktreePath };
    });

  it.effect("working with no hook for 10 minutes and no agent process is interrupted", () =>
    Effect.gen(function* () {
      const { status, lookups, worktreePath } = yield* dead(false);
      assert.strictEqual(status.run, "interrupted");
      assert.deepStrictEqual(lookups, [["claude", worktreePath]]);
    }),
  );

  it.effect("the same with the agent process still there is running", () =>
    Effect.gen(function* () {
      const { status, lookups } = yield* dead(true);
      assert.strictEqual(status.run, "running");
      assert.strictEqual(lookups.length, 1);
    }),
  );
});

// ---- the other reads ------------------------------------------------------------------------

describe("thread", () => {
  it.effect("answers the worktree and branch from workspaces get", () =>
    Effect.gen(function* () {
      const t = rig([{ argv: ["workspaces", "get", L1_WS, "--local"], fixture: "ws-get-local" }]);
      yield* seed(t.data, record({ worktreePath: null }));
      const thread = yield* t.run((s) => s.thread(`local:${L1_WS}`));
      assert.deepStrictEqual(thread, {
        worktreePath: "/Users/tomkaczocha/.paradev/worktrees/factory-paradev-spike/fac/1-1",
        branch: "fac/1-1",
        archived: false,
      });
    }),
  );

  it.effect("Workspace not found answers the record's values, archived", () =>
    Effect.gen(function* () {
      const t = rig([{ argv: ["workspaces", "get", L5_WS, "--local"], fixture: "ws-get-local-archived" }]);
      yield* seed(t.data, record({ threadId: `local:${L5_WS}`, workspaceId: L5_WS, branch: "fac/2-1", worktreePath: "/w/p/fac/2-1" }));
      const thread = yield* t.run((s) => s.thread(`local:${L5_WS}`));
      assert.deepStrictEqual(thread, { worktreePath: "/w/p/fac/2-1", branch: "fac/2-1", archived: true });
    }),
  );

  it.effect("no record is ThreadNotFoundError", () =>
    Effect.gen(function* () {
      const t = rig([]);
      assert.instanceOf(yield* Effect.flip(t.run((s) => s.thread(`local:${L1_WS}`))), ThreadNotFoundError);
    }),
  );
});

describe("runningThreads", () => {
  const ws2 = "11111111-2222-4333-8444-555555555555";
  /** The L5b snapshot, plus a person's own workspace with a working agent and no record. */
  const snapshot = (answer: unknown) => {
    const { workspaces } = answer as { readonly workspaces: ReadonlyArray<Record<string, unknown>> };
    const theirs = { ...workspaces[0], id: ws2, terminals: [{ id: "t-own", title: "", agent: { id: "claude", state: "working" } }] };
    return { workspaces: [...workspaces, theirs] };
  };

  it.effect("counts only the factory's current terminals whose agent is starting or working", () =>
    Effect.gen(function* () {
      const t = rig([{ argv: ["snapshot"], fixture: "snapshot-local-after-resume", edit: snapshot }]);
      // The current terminal is the resumed one, idle; the dead one still reads working.
      yield* seed(t.data, record({ threadId: `local:${L5_WS}`, workspaceId: L5_WS, terminals: [L5_DEAD, L5_RESUMED] }));
      assert.strictEqual(yield* t.run((s) => s.runningThreads), 0);
    }),
  );

  it.effect("a dead agent counts until its terminal is closed, and an archived record never does", () =>
    Effect.gen(function* () {
      const t = rig([
        { argv: ["snapshot"], fixture: "snapshot-local-after-resume", edit: snapshot },
        { argv: ["snapshot"], fixture: "snapshot-local-after-resume", edit: snapshot },
      ]);
      yield* seed(t.data, record({ threadId: `local:${L5_WS}`, workspaceId: L5_WS, terminals: [L5_DEAD] }));
      assert.strictEqual(yield* t.run((s) => s.runningThreads), 1);
      yield* seed(t.data, record({ threadId: `local:${L5_WS}`, workspaceId: L5_WS, terminals: [L5_DEAD], archivedAt: 1 }));
      assert.strictEqual(yield* t.run((s) => s.runningThreads), 0);
    }),
  );
});

describe("lastActivity", () => {
  it.effect("is the last hook's time, null while explain says none", () =>
    Effect.gen(function* () {
      const t = rig([explainAt("agents-explain-local-idle"), explainAt("agents-explain-local-starting")]);
      yield* seed(t.data, record());
      assert.strictEqual(yield* t.run((s) => s.lastActivity(`local:${L1_WS}`)), lastEventAt("agents-explain-local-idle"));
      assert.isNull(yield* t.run((s) => s.lastActivity(`local:${L1_WS}`)));
    }),
  );
});

describe("worktreesDirectory", () => {
  it.effect("is the newest record's worktree with /<project>/<branch> cut off, else the default", () =>
    Effect.gen(function* () {
      const t = rig([]);
      assert.strictEqual(yield* t.run((s) => s.worktreesDirectory("/default/dir")), "/default/dir");
      yield* seed(
        t.data,
        record({ worktreePath: "/old/worktrees/p/fac/1-1", turns: [{ commandId: LAUNCH_ID, at: 1, kind: "launch" }] }),
        record({
          threadId: `local:${L5_WS}`,
          workspaceId: L5_WS,
          branch: "fac/2-1",
          worktreePath: "/Users/me/.paradev/worktrees/factory-paradev-spike/fac/2-1",
          turns: [{ commandId: "x", at: 2, kind: "launch" }],
        }),
      );
      assert.strictEqual(yield* t.run((s) => s.worktreesDirectory("/default/dir")), "/Users/me/.paradev/worktrees");
    }),
  );
});

describe("findProject", () => {
  it.live("matches the repo path by realpath and answers the configured model", () =>
    Effect.gen(function* () {
      const root = tempDir("project");
      const link = NodePath.join(tempDir("link"), "spike");
      NodeFS.symlinkSync(root, link);
      const t = rig([
        { argv: ["projects", "list", "--local"], fixture: "projects-list-local", edit: withProjectPath(link) },
        { argv: ["projects", "list", "--local"], fixture: "projects-list-local" },
      ]);
      const project = yield* t.run((s) => s.findProject(`${root}/`));
      assert.strictEqual(project?.id, SPIKE_PROJECT);
      assert.strictEqual(project?.model?.instanceId, "claude");
      assert.isNull(yield* t.run((s) => s.findProject(root)));
    }),
  );
});

describe("worktreeCheckout", () => {
  it.live("reads HEAD and its branch, null for a folder with no .git", () =>
    Effect.gen(function* () {
      const r = repos();
      r.addWorktree("fac/1-1", "main");
      const t = rig([]);
      assert.deepStrictEqual(yield* t.run((s) => s.worktreeCheckout(r.worktree)), { head: r.main, branch: "fac/1-1" });
      git(r.worktree, "checkout", "-q", "--detach");
      assert.deepStrictEqual(yield* t.run((s) => s.worktreeCheckout(r.worktree)), { head: r.main, branch: null });
      assert.isNull(yield* t.run((s) => s.worktreeCheckout(tempDir("empty"))));
    }),
  );
});

describe("the real process lookup", () => {
  it.live("answers null when no process has the name", () =>
    Effect.gen(function* () {
      const processes = yield* AgentProcess;
      assert.isNull(yield* processes.find("fac-none-zq", process.cwd()));
    }).pipe(
      Effect.provide(agentProcessLayer.pipe(Layer.provide(Layer.mergeAll(processLayer, NodeServices.layer)))),
    ),
  );
});
