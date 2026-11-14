// @effect-diagnostics nodeBuiltinImport:off - the tests build real git repos and read the adapter's files.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as TestClock from "effect/testing/TestClock";

import { useTempDirs } from "../ledger/testSupport.ts";
import { FactoryPaths } from "../paths.ts";
import { FactoryProcess, layer as processLayer, type RunResult } from "../process.ts";
import { MessageRejectedError, SessionsError, ThreadNotFoundError, type LaunchRequest } from "../sessions.ts";
import { layer as cliLayer } from "./cli.ts";
import { fakeSuperset, readFixture, type Step } from "./fake-superset.ts";
import {
  AgentProcess,
  agentProcessLayer,
  make,
  type ParadevSessions,
  type ParadevSessionsConfig,
} from "./sessions.ts";
import { SshError, type SshRunner } from "./ssh.ts";
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
 * made, so the clone has never seen it (X8). The origin lives at `<remoteBase>/<owner>/<repo>.git`
 * for the spike project's repo, so the adapter fetches it by URL as it fetches GitHub. `worktree`
 * is where `workspaces get` will say the workspace lives; the test makes it from the clone on
 * `startAt`, as Paradev would. `seed` pushes to the origin.
 */
const repos = () => {
  const root = tempDir("repos");
  const remote = NodePath.join(root, "remote");
  const origin = NodePath.join(remote, "original-solutions", "factory-paradev-spike.git");
  NodeFS.mkdirSync(NodePath.dirname(origin), { recursive: true });
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
  return { clone, seed, main, originOnly, worktree, addWorktree, remoteBase: `file://${remote}` };
};

/** The reflog of the worktree's HEAD, newest first: a reset shows as `reset: moving to …`. */
const reflog = (worktree: string): string => git(worktree, "reflog", "--format=%gs");

// ---- the adapter over fake-superset ---------------------------------------------------------

const CONFIG: ParadevSessionsConfig = { agent: "claude", agentCommand: "claude" };

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
  message: "/factory original-solutions/factory-paradev-spike#1",
  model: MODEL,
  ...over,
});

interface Rig {
  readonly data: string;
  readonly calls: Array<ReadonlyArray<string>>;
  readonly unused: () => ReadonlyArray<Step>;
  readonly lookups: Array<readonly [string, string]>;
  /** Every git call the adapter made, with the environment it added. */
  readonly gitCalls: Array<{ readonly args: ReadonlyArray<string>; readonly env: Readonly<Record<string, string>> }>;
  readonly run: <A, E>(
    body: (sessions: ParadevSessions) => Effect.Effect<A, E, never>,
  ) => Effect.Effect<A, E, never>;
}

const rig = (
  script: ReadonlyArray<Step>,
  options: {
    readonly agentRunning?: boolean;
    readonly config?: Partial<ParadevSessionsConfig>;
    /** Changes what a git call answers, from its argv; the call still runs. */
    readonly gitResult?: (
      args: ReadonlyArray<string>,
    ) => { readonly tailTruncated?: boolean; readonly exitCode?: number; readonly stderrTail?: string } | undefined;
  } = {},
): Rig => {
  const fake = fakeSuperset(script);
  const data = tempDir("data");
  const lookups: Array<readonly [string, string]> = [];
  const gitCalls: Rig["gitCalls"] = [];
  const recording = Layer.effect(
    FactoryProcess,
    Effect.gen(function* () {
      const real = yield* FactoryProcess;
      return FactoryProcess.of({
        // Recorded and changed each time the call runs: a retry runs the same effect again.
        run: (input) =>
          Effect.suspend(() => {
            if (input.command === "git") gitCalls.push({ args: input.args ?? [], env: input.env ?? {} });
            const changed = input.command === "git" ? options.gitResult?.(input.args ?? []) : undefined;
            return changed === undefined
              ? real.run(input)
              : Effect.map(real.run(input), (result) => ({ ...result, ...changed }));
          }),
      });
    }),
  ).pipe(Layer.provide(processLayer));
  const layer = Layer.mergeAll(
    cliLayer({ cli: "superset" }).pipe(Layer.provide(fake.layer)),
    recording,
    NodeServices.layer,
    Layer.succeed(FactoryPaths, {
      baseDir: data,
      worktreesDir: "/default/worktrees",
      factoryDir: data,
      machineConfigPath: NodePath.join(data, "config.yml"),
      claudeProjectsDir: "/default/claude-projects",
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
    gitCalls,
    run: (body) =>
      Effect.gen(function* () {
        return yield* body(yield* make({ ...CONFIG, ...options.config }));
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
  v: 2,
  threadId: `local:${L1_WS}`,
  target: { kind: "local" },
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
      const t = rig(
        [...launchScript(r), { argv: argvIs("agents", "explain"), fixture: "agents-explain-local-starting" }],
        { config: { remoteBase: r.remoteBase } },
      );
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
        target: { kind: "local" },
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
      const t = rig(launchScript(r), { config: { remoteBase: r.remoteBase } });
      yield* t.run((s) => s.launch(request({ baseRef: "x8-origin-only" })));
      assert.strictEqual(git(r.clone, "rev-parse", "origin/x8-origin-only"), r.originOnly);
      assert.strictEqual(flag(t.calls.find(argvIs("workspaces", "create")), "--base-branch"), "x8-origin-only");
    }),
  );

  it.live("passes no --model when the model is empty, and only the effort entry of the options", () =>
    Effect.gen(function* () {
      const r = repos();
      r.addWorktree("fac/x8", "main");
      const t = rig(launchScript(r), { config: { remoteBase: r.remoteBase } });
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
      const t = rig(launchScript(r), { config: { remoteBase: r.remoteBase } });
      yield* t.run((s) => s.launch(request({ title: "t".repeat(200) })));
      assert.strictEqual(flag(t.calls.find(argvIs("workspaces", "create")), "--name"), "t".repeat(80));
    }),
  );

  it.live("resets a worktree that Paradev built from the wrong base before the agent starts", () =>
    Effect.gen(function* () {
      const r = repos();
      // X8: Paradev fell back to the project default, main, for a base the clone did not have.
      r.addWorktree("fac/x8", "main");
      const seen: Array<string> = [];
      // Probes: what git shows at the moment each CLI call is answered.
      const probe = (what: string, read: () => string) => (answer: unknown) => {
        seen.push(`${what} ${read()}`);
        return answer;
      };
      const script = launchScript(r).map((step) =>
        typeof step.argv === "function" && step.argv(["workspaces", "create"])
          ? { ...step, edit: probe("create: clone has base", () => git(r.clone, "rev-parse", "origin/x8-origin-only")) }
          : typeof step.argv === "function" && step.argv(["agents", "create"])
            ? { ...step, edit: probe("agents create: worktree at", () => git(r.worktree, "rev-parse", "HEAD")) }
            : step,
      );
      const t = rig(script, { config: { remoteBase: r.remoteBase } });
      yield* t.run((s) => s.launch(request({ baseRef: "x8-origin-only" })));
      // The base was fetched before create, and the reset done before the agent started.
      assert.deepStrictEqual(seen, [
        `create: clone has base ${r.originOnly}`,
        `agents create: worktree at ${r.originOnly}`,
      ]);
      assert.strictEqual(git(r.worktree, "rev-parse", "HEAD"), r.originOnly);
      assert.include(reflog(r.worktree).split("\n")[0], `reset: moving to ${r.originOnly}`);
      assert.strictEqual(git(r.worktree, "symbolic-ref", "--short", "HEAD"), "fac/x8");
      assert.strictEqual(flag(t.calls.find(argvIs("workspaces", "create")), "--base-branch"), "x8-origin-only");
    }),
  );

  it.live("the base check's status and reset do not recurse into submodules or take optional locks", () =>
    Effect.gen(function* () {
      const r = repos();
      r.addWorktree("fac/x8", "main");
      const t = rig(launchScript(r), { config: { remoteBase: r.remoteBase } });
      yield* t.run((s) => s.launch(request({ baseRef: "x8-origin-only" })));
      const status = t.gitCalls.find((c) => c.args.includes("status"))!;
      // `dirty`, not `all`: a changed submodule commit is still work, and no status runs inside it.
      assert.include(status.args, "--ignore-submodules=dirty");
      assert.include(status.args, "--no-optional-locks");
      const reset = t.gitCalls.find((c) => c.args.includes("reset"))!;
      assert.include(reset.args, "--no-recurse-submodules");
      assert.isTrue(reset.args.some((arg, i) => arg === "-c" && reset.args[i + 1] === "submodule.recurse=false"));
    }),
  );

  it.live("starts from the fetched base even when the clone's own branch is behind", () =>
    Effect.gen(function* () {
      const r = repos();
      // origin's main moves on after the clone was made; nothing moves the clone's local main.
      git(r.seed, "checkout", "-q", "main");
      const ahead = commit(r.seed, "c.txt");
      git(r.seed, "push", "-q", "origin", "main");
      // Paradev builds the worktree from the clone's local, stale main.
      r.addWorktree("fac/x8", "main");
      const t = rig(launchScript(r), { config: { remoteBase: r.remoteBase } });
      yield* t.run((s) => s.launch(request({ baseRef: "main" })));
      assert.strictEqual(git(r.worktree, "rev-parse", "HEAD"), ahead);
    }),
  );

  it.live("fetches by URL and ignores remote, transport and filter config a session wrote in the clone", () =>
    Effect.gen(function* () {
      const r = repos();
      r.addWorktree("fac/x8", "main");
      const marks = tempDir("marks");
      // A session can write the clone's config: every worktree of the project shares it.
      git(r.clone, "config", "remote.origin.url", NodePath.join(marks, "nowhere.git"));
      git(r.clone, "config", "remote.origin.uploadpack", `touch ${marks}/uploadpack; git-upload-pack`);
      git(r.clone, "config", "filter.x.smudge", `sh -c 'touch ${marks}/smudge; cat'`);
      git(r.clone, "config", "filter.x.process", `sh -c 'touch ${marks}/process'`);
      git(r.clone, "config", "core.alternateRefsCommand", `sh -c 'touch ${marks}/alternate-refs'`);
      NodeFS.writeFileSync(
        NodePath.join(r.clone, ".git", "objects", "info", "alternates"),
        `${NodePath.join(r.seed, ".git", "objects")}\n`,
      );
      NodeFS.writeFileSync(NodePath.join(r.clone, ".git", "info", "attributes"), "* filter=x\n");
      const t = rig(launchScript(r), { config: { remoteBase: r.remoteBase } });
      yield* t.run((s) => s.launch(request({ baseRef: "x8-origin-only" })));
      assert.strictEqual(git(r.worktree, "rev-parse", "HEAD"), r.originOnly);
      assert.strictEqual(NodeFS.readFileSync(NodePath.join(r.worktree, "b.txt"), "utf8"), "b.txt");
      assert.deepStrictEqual(NodeFS.readdirSync(marks), []);
    }),
  );

  // The invariant: no git call the adapter runs in the clone or a worktree runs a command the
  // repo's config names. Each case plants one exec-capable shape a session could write, and says
  // what the launch comes to: it starts at the fetched base, or it is refused and touches nothing.
  const planted: ReadonlyArray<{
    readonly name: string;
    readonly outcome: "launches" | "refuses";
    readonly plant: (clone: string, scratch: string, marks: string) => void;
  }> = [
    {
      name: "remote.<scratch>.uploadpack",
      outcome: "launches",
      plant: (clone, scratch, marks) =>
        git(clone, "config", `remote.${scratch}.uploadpack`, `touch ${marks}/uploadpack; git-upload-pack`),
    },
    {
      name: "protocol.ssh.allow with an ssh insteadOf of the scratch path and core.sshCommand",
      outcome: "refuses",
      plant: (clone, scratch, marks) => {
        git(clone, "config", "protocol.ssh.allow", "always");
        git(clone, "config", "url.ssh://x/y.insteadOf", scratch);
        git(clone, "config", "core.sshCommand", `touch ${marks}/ssh; false`);
      },
    },
    {
      name: "a filter driver listed before more than 16 KiB of other filter keys",
      outcome: "launches",
      plant: (clone, _scratch, marks) => {
        git(clone, "config", "filter.evil.smudge", `sh -c 'touch ${marks}/smudge; cat'`);
        git(clone, "config", "filter.evil.clean", `sh -c 'touch ${marks}/clean; cat'`);
        // Long names, not many: each name is four pins in every git call's environment, and
        // thousands of pins make each call take seconds. 120 names of ~220 bytes list ~26 KiB.
        const filler = Array.from({ length: 120 }, (_, i) => `[filter "pad${i}-${"x".repeat(200)}"]\n\tsmudge =\n`).join("");
        NodeFS.appendFileSync(NodePath.join(clone, ".git", "config"), filler);
        NodeFS.writeFileSync(NodePath.join(clone, ".git", "info", "attributes"), "* filter=evil\n");
      },
    },
    {
      name: "a config hook on reference-transaction and post-index-change",
      outcome: "launches",
      plant: (clone, _scratch, marks) => {
        git(clone, "config", "hook.x.event", "reference-transaction");
        git(clone, "config", "--add", "hook.x.event", "post-index-change");
        git(clone, "config", "hook.x.command", `touch ${marks}/hook`);
      },
    },
    {
      name: "a partial clone whose promisor remote has an uploadpack, and a ref to a missing object",
      outcome: "refuses",
      plant: (clone, _scratch, marks) => {
        git(clone, "config", "core.repositoryformatversion", "1");
        git(clone, "config", "extensions.partialClone", "origin");
        git(clone, "config", "remote.origin.promisor", "true");
        git(clone, "config", "remote.origin.url", clone);
        git(clone, "config", "remote.origin.uploadpack", `touch ${marks}/promisor; git-upload-pack`);
        NodeFS.writeFileSync(NodePath.join(clone, ".git", "refs", "heads", "zzz"), `${"1".repeat(40)}\n`);
      },
    },
  ];
  for (const { name, outcome, plant } of planted) {
    it.live(`runs nothing the clone's config names: ${name}`, () =>
      Effect.gen(function* () {
        const r = repos();
        r.addWorktree("fac/x8", "main");
        const marks = tempDir("marks");
        const t = rig(launchScript(r).filter((step) => outcome === "launches" || step.fixture !== "agents-create-local-resume"), {
          config: { remoteBase: r.remoteBase },
        });
        plant(r.clone, `${t.data}/paradev/fetch/${SPIKE_PROJECT}.git`, marks);
        const exit = yield* Effect.exit(t.run((s) => s.launch(request({ baseRef: "x8-origin-only" }))));
        assert.deepStrictEqual(NodeFS.readdirSync(marks), []);
        if (outcome === "launches") {
          assert.isTrue(exit._tag === "Success");
          assert.strictEqual(git(r.worktree, "rev-parse", "HEAD"), r.originOnly);
        } else {
          assert.isTrue(exit._tag === "Failure");
          assert.strictEqual(git(r.worktree, "rev-parse", "HEAD"), r.main);
          assert.isUndefined(t.calls.find(argvIs("agents", "create")));
        }
      }),
    );
  }

  // Fetch ends with `maintenance run --auto`, which repacks when the clone holds several packs and
  // reads `gc.recentObjectsHook` and the like from the clone's config. Git 2.54 never ran that
  // hook in any case this test could set up, so the observable is the repack itself: the packs
  // the clone held before the launch are the packs it holds after. Maintenance detaches by
  // default, so the clone turns that off: a repack would finish before the fetch returns.
  it.live("starts no automatic maintenance in the clone", () =>
    Effect.gen(function* () {
      const r = repos();
      r.addWorktree("fac/x8", "main");
      const marks = tempDir("marks");
      git(r.clone, "config", "gc.recentObjectsHook", `touch ${marks}/gc`);
      git(r.clone, "config", "gc.auto", "1");
      git(r.clone, "config", "gc.autoPackLimit", "1");
      git(r.clone, "config", "maintenance.auto", "true");
      git(r.clone, "config", "maintenance.autoDetach", "false");
      git(r.clone, "config", "gc.autoDetach", "false");
      // Several packs make a repack due.
      for (const name of ["a", "b", "c", "d"]) {
        const oid = NodeChildProcess.execFileSync("git", ["-C", r.clone, "hash-object", "-w", "--stdin"], {
          input: `orphan ${name}`,
        })
          .toString()
          .trim();
        NodeChildProcess.execFileSync("git", ["-C", r.clone, "pack-objects", "-q", ".git/objects/pack/pack"], {
          input: `${oid}\n`,
        });
      }
      git(r.clone, "prune-packed");
      const packs = () => NodeFS.readdirSync(NodePath.join(r.clone, ".git", "objects", "pack")).sort();
      const before = packs();
      assert.isAbove(before.filter((file) => file.endsWith(".pack")).length, 1);
      const t = rig(launchScript(r), { config: { remoteBase: r.remoteBase } });
      yield* t.run((s) => s.launch(request({ baseRef: "x8-origin-only" })));
      assert.strictEqual(git(r.worktree, "rev-parse", "HEAD"), r.originOnly);
      assert.deepStrictEqual(packs(), before);
      assert.deepStrictEqual(NodeFS.readdirSync(marks), []);
    }),
  );

  // The config listing that decides which filters and hooks are blanked must be complete.
  const listing = (args: ReadonlyArray<string>) => args.includes("--get-regexp") && args.includes("-z");
  const listingFailures: ReadonlyArray<readonly [string, { readonly tailTruncated?: boolean; readonly exitCode?: number }]> = [
    ["overflows its tail", { tailTruncated: true }],
    ["exits 128", { exitCode: 128 }],
  ];
  for (const [name, answer] of listingFailures) {
    it.live(`refuses the launch when the filter and hook listing ${name}`, () =>
      Effect.gen(function* () {
        const r = repos();
        r.addWorktree("fac/x8", "main");
        const marks = tempDir("marks");
        git(r.clone, "config", "filter.evil.smudge", `sh -c 'touch ${marks}/smudge; cat'`);
        NodeFS.writeFileSync(NodePath.join(r.clone, ".git", "info", "attributes"), "* filter=evil\n");
        const t = rig(launchScript(r).filter((step) => step.fixture !== "agents-create-local-resume"), {
          config: { remoteBase: r.remoteBase },
          gitResult: (args) => (listing(args) ? answer : undefined),
        });
        const error = yield* Effect.flip(t.run((s) => s.launch(request({ baseRef: "x8-origin-only" }))));
        assert.strictEqual(error._tag, "FactorySessionsError");
        assert.strictEqual(git(r.worktree, "rev-parse", "HEAD"), r.main);
        assert.deepStrictEqual(NodeFS.readdirSync(marks), []);
        assert.isUndefined(t.calls.find(argvIs("agents", "create")));
      }),
    );
  }

  it.live("refuses a filter driver whose name is not plain, and touches the worktree not at all", () =>
    Effect.gen(function* () {
      const r = repos();
      r.addWorktree("fac/x8", "main");
      const marks = tempDir("marks");
      // A name outside `[A-Za-z0-9._-]` is refused rather than blanked.
      git(r.clone, "config", "filter.x=y.smudge", `sh -c 'touch ${marks}/smudge; cat'`);
      git(r.clone, "config", "filter.x=y.clean", `sh -c 'touch ${marks}/clean; cat'`);
      NodeFS.writeFileSync(NodePath.join(r.clone, ".git", "info", "attributes"), "* filter=x=y\n");
      const t = rig(launchScript(r).filter((step) => step.fixture !== "agents-create-local-resume"), {
        config: { remoteBase: r.remoteBase },
      });
      const error = yield* Effect.flip(t.run((s) => s.launch(request({ baseRef: "x8-origin-only" }))));
      assert.strictEqual(error._tag, "FactorySessionsError");
      assert.strictEqual(git(r.worktree, "rev-parse", "HEAD"), r.main);
      assert.deepStrictEqual(NodeFS.readdirSync(marks), []);
      assert.isUndefined(t.calls.find(argvIs("agents", "create")));
    }),
  );

  it.live("refuses a config hook whose name is not plain, and touches the worktree not at all", () =>
    Effect.gen(function* () {
      const r = repos();
      r.addWorktree("fac/x8", "main");
      const marks = tempDir("marks");
      // A name outside `[A-Za-z0-9._-]` is refused rather than turned off.
      git(r.clone, "config", "hook.x=y.event", "reference-transaction");
      git(r.clone, "config", "hook.x=y.command", `touch ${marks}/hook`);
      const t = rig(launchScript(r).filter((step) => step.fixture !== "agents-create-local-resume"), {
        config: { remoteBase: r.remoteBase },
      });
      const error = yield* Effect.flip(t.run((s) => s.launch(request({ baseRef: "x8-origin-only" }))));
      assert.strictEqual(error._tag, "FactorySessionsError");
      assert.strictEqual(git(r.worktree, "rev-parse", "HEAD"), r.main);
      assert.deepStrictEqual(NodeFS.readdirSync(marks), []);
      assert.isUndefined(t.calls.find(argvIs("agents", "create")));
    }),
  );

  it.live("refuses a project whose repo is not a GitHub URL, before it creates anything", () =>
    Effect.gen(function* () {
      const r = repos();
      const t = rig(
        [
          {
            argv: ["projects", "list", "--local"],
            fixture: "projects-list-local",
            edit: (answer) =>
              (answer as ReadonlyArray<{ readonly id: string }>).map((p) =>
                p.id === SPIKE_PROJECT ? { ...p, path: r.clone, repo: "-" } : p,
              ),
          },
        ],
        { config: { remoteBase: r.remoteBase } },
      );
      const error = yield* Effect.flip(t.run((s) => s.launch(request())));
      assert.strictEqual(error._tag, "FactorySessionsError");
      assert.deepStrictEqual(t.calls, [["projects", "list", "--local"]]);
    }),
  );

  it.live("a second launch with the same command id starts nothing", () =>
    Effect.gen(function* () {
      const r = repos();
      r.addWorktree("fac/x8", "main");
      const t = rig(launchScript(r), { config: { remoteBase: r.remoteBase } });
      const first = yield* t.run((s) => s.launch(request()));
      const calls = t.calls.length;
      const second = yield* t.run((s) => s.launch(request()));
      assert.deepStrictEqual(second, first);
      assert.strictEqual(t.calls.length, calls);
    }),
  );

  it.live("a transient failure of a step is retried once, and Workspace not found is not retried", () =>
    Effect.gen(function* () {
      const r = repos();
      r.addWorktree("fac/x8", "main");
      const flaky = launchScript(r).flatMap((step): ReadonlyArray<Step> =>
        step.fixture === "ws-get-local-x8" ? [{ argv: step.argv, fail: "Could not connect to API" }, step] : [step],
      );
      const t = rig(flaky, { config: { remoteBase: r.remoteBase } });
      yield* t.run((s) => s.launch(request()));
      assert.strictEqual(t.calls.filter(argvIs("workspaces", "get")).length, 2);
      assert.deepStrictEqual(t.unused(), []);

      const r2 = repos();
      r2.addWorktree("fac/x8", "main");
      const gone = launchScript(r2).map((step): Step =>
        step.fixture === "ws-get-local-x8" ? { argv: step.argv, fail: `Workspace not found on host ${X8_WS}` } : step,
      );
      const t2 = rig(gone, { config: { remoteBase: r2.remoteBase } });
      const error = yield* Effect.flip(t2.run((s) => s.launch(request())));
      assert.strictEqual(error._tag, "FactorySessionsError");
      assert.strictEqual(t2.calls.filter(argvIs("workspaces", "get")).length, 1);
    }),
  );

  it.live("agents create that cannot connect is not retried, and the record keeps no terminal", () =>
    Effect.gen(function* () {
      const r = repos();
      r.addWorktree("fac/x8", "main");
      const script = [
        ...launchScript(r).map((step): Step =>
          step.fixture === "agents-create-local-resume" ? { argv: step.argv, fail: "Could not connect to API" } : step,
        ),
        // The look after the failed create finds no terminal: nothing was started.
        { argv: ["snapshot", "--workspace", X8_WS], fixture: "snapshot-local-before-kill", edit: snapshotOf(X8_WS, []) },
      ];
      const t = rig(script, { config: { remoteBase: r.remoteBase } });
      const error = yield* Effect.flip(t.run((s) => s.launch(request())));
      assert.strictEqual(error._tag, "FactorySessionsError");
      assert.include(String(error.cause), "Could not connect to API");
      assert.strictEqual(t.calls.filter(argvIs("agents", "create")).length, 1);
      const saved = yield* readThread(t.data, X8_WS).pipe(Effect.provide(NodeServices.layer));
      assert.deepStrictEqual(saved!.terminals, []);
      assert.deepStrictEqual(t.unused(), []);
    }),
  );

  it.live("agents create that fails after starting the agent takes that agent, and starts no second one", () =>
    Effect.gen(function* () {
      const r = repos();
      r.addWorktree("fac/x8", "main");
      const script = [
        ...launchScript(r).map((step): Step =>
          step.fixture === "agents-create-local-resume" ? { argv: step.argv, fail: "Request timed out" } : step,
        ),
        // Paradev started the agent before the call gave up.
        {
          argv: ["snapshot", "--workspace", X8_WS],
          fixture: "snapshot-local-before-kill",
          edit: snapshotOf(X8_WS, [{ id: "t-late", title: "", agent: { id: "claude", state: "working" } }]),
        },
      ];
      const t = rig(script, { config: { remoteBase: r.remoteBase } });
      const launched = yield* t.run((s) => s.launch(request()));
      assert.strictEqual(launched.threadId, `local:${X8_WS}`);
      assert.strictEqual(t.calls.filter(argvIs("agents", "create")).length, 1);
      const saved = yield* readThread(t.data, X8_WS).pipe(Effect.provide(NodeServices.layer));
      assert.deepStrictEqual(saved!.terminals, ["t-late"]);
      assert.deepStrictEqual(saved!.turns.map((turn) => turn.kind), ["launch"]);
      assert.deepStrictEqual(t.unused(), []);
    }),
  );

  it.live("agents create that fails beside a terminal with no agent names that terminal, and records none", () =>
    Effect.gen(function* () {
      const r = repos();
      r.addWorktree("fac/x8", "main");
      // Paradev opened the terminal before the call gave up, and claude has not hooked in yet.
      const starting: Step = {
        argv: ["snapshot", "--workspace", X8_WS],
        fixture: "snapshot-local-before-kill",
        edit: snapshotOf(X8_WS, [{ id: "t-late", title: "", agent: null }]),
      };
      const script = [
        ...launchScript(r).map((step): Step =>
          step.fixture === "agents-create-local-resume" ? { argv: step.argv, fail: "Request timed out" } : step,
        ),
        starting,
        starting,
        starting,
      ];
      const t = rig(script, { config: { remoteBase: r.remoteBase, agentPollDelaysMs: [0, 0] } });
      const error = yield* Effect.flip(t.run((s) => s.launch(request())));
      assert.strictEqual(error._tag, "FactorySessionsError");
      assert.include(String(error.cause), "Request timed out");
      assert.include(String(error.cause), "t-late");
      assert.strictEqual(t.calls.filter(argvIs("agents", "create")).length, 1);
      const saved = yield* readThread(t.data, X8_WS).pipe(Effect.provide(NodeServices.layer));
      assert.deepStrictEqual(saved!.terminals, []);
      assert.deepStrictEqual(t.unused(), []);
    }),
  );

  it.live("agents create that fails, with the look after it failing too, keeps the create's error", () =>
    Effect.gen(function* () {
      const r = repos();
      r.addWorktree("fac/x8", "main");
      const script = [
        ...launchScript(r).map((step): Step =>
          step.fixture === "agents-create-local-resume" ? { argv: step.argv, fail: "Could not connect to API" } : step,
        ),
        { argv: ["snapshot", "--workspace", X8_WS], fail: `Workspace not found on host h: ${X8_WS}` },
      ];
      const t = rig(script, { config: { remoteBase: r.remoteBase } });
      const error = yield* Effect.flip(t.run((s) => s.launch(request())));
      assert.strictEqual(error._tag, "FactorySessionsError");
      assert.include(String(error.cause), "Could not connect to API");
      assert.include(String(error.cause), "Workspace not found");
      assert.deepStrictEqual(t.unused(), []);
    }),
  );

  it.live("a project id that is not plain stops the launch before any git call", () =>
    Effect.gen(function* () {
      const r = repos();
      const t = rig(
        [
          {
            argv: ["projects", "list", "--local"],
            fixture: "projects-list-local",
            edit: (answer) =>
              (answer as ReadonlyArray<{ readonly id: string }>).map((p) =>
                p.id === SPIKE_PROJECT ? { ...p, id: "../x", path: r.clone } : p,
              ),
          },
        ],
        { config: { remoteBase: r.remoteBase } },
      );
      const error = yield* Effect.flip(t.run((s) => s.launch(request({ projectId: "../x" }))));
      assert.strictEqual(error._tag, "FactorySessionsError");
      assert.deepStrictEqual(t.calls, [["projects", "list", "--local"]]);
      assert.deepStrictEqual(t.gitCalls, []);
    }),
  );

  it.live("a launch that died before its launch file adopts the agent it finds instead of starting one", () =>
    Effect.gen(function* () {
      const r = repos();
      r.addWorktree("fac/1-1", "main");
      // The agent the lost attempt started has already committed on its branch.
      const work = commit(r.worktree, "agent.txt");
      const t = rig(
        [
          { argv: ["projects", "list", "--local"], fixture: "projects-list-local", edit: withProjectPath(r.clone) },
          // X7: create on a branch that already has a workspace answers it with alreadyExists.
          { argv: argvIs("workspaces", "create"), fixture: "ws-create-local-repeat" },
          { argv: ["workspaces", "get", L1_WS, "--local"], fixture: "ws-get-local", edit: withPath(r.worktree) },
          { argv: ["snapshot", "--workspace", L1_WS], fixture: "snapshot-local-before-kill", edit: snapshotOf(L1_WS) },
        ],
        { config: { remoteBase: r.remoteBase } },
      );
      const launched = yield* t.run((s) => s.launch(request()));
      assert.strictEqual(launched.threadId, `local:${L1_WS}`);
      assert.isUndefined(t.calls.find(argvIs("agents", "create")));
      // A worktree holding a commit is kept: its work was not reset away.
      assert.strictEqual(git(r.worktree, "rev-parse", "HEAD"), work);
      const saved = yield* readThread(t.data, L1_WS).pipe(Effect.provide(NodeServices.layer));
      assert.deepStrictEqual(saved!.terminals, [L5_DEAD]);
      assert.deepStrictEqual(saved!.turns.map((turn) => turn.kind), ["launch"]);
      assert.deepStrictEqual(t.unused(), []);
    }),
  );

  it.live("a terminal that shows no agent after every look stops the launch, and nothing is reset or started", () =>
    Effect.gen(function* () {
      const r = repos();
      r.addWorktree("fac/x8", "main");
      const before = reflog(r.worktree);
      // An agent before its first hook may show no agent; so may a person's shell. Neither is
      // taken, and no agent is started beside it, after the snapshot is read three times.
      const starting = snapshotOf(X8_WS, [{ id: "t-starting", title: "", agent: null }]);
      const snapshot = { argv: ["snapshot", "--workspace", X8_WS], fixture: "snapshot-local-before-kill", edit: starting };
      const script = [
        ...launchScript(r).filter(
          (step) => step.fixture !== "agents-create-local-resume" && step.fixture !== "snapshot-local-before-kill",
        ),
        snapshot,
        snapshot,
        snapshot,
      ];
      const t = rig(script, { config: { remoteBase: r.remoteBase, agentPollDelaysMs: [0, 0] } });
      const error = yield* Effect.flip(t.run((s) => s.launch(request({ baseRef: "x8-origin-only" }))));
      assert.strictEqual(error._tag, "FactorySessionsError");
      assert.strictEqual(t.calls.filter(argvIs("snapshot")).length, 3);
      assert.isUndefined(t.calls.find(argvIs("agents", "create")));
      // The base was behind, but the reset waits for an answer on the agent.
      assert.strictEqual(git(r.worktree, "rev-parse", "HEAD"), r.main);
      assert.strictEqual(reflog(r.worktree), before);
      const saved = yield* readThread(t.data, X8_WS).pipe(Effect.provide(NodeServices.layer));
      assert.deepStrictEqual(saved!.terminals, []);
      assert.deepStrictEqual(t.unused(), []);
    }),
  );

  it.live("takes the agent that hooks in while the launch looks again, and starts none beside it", () =>
    Effect.gen(function* () {
      const r = repos();
      r.addWorktree("fac/x8", "main");
      const script = [
        ...launchScript(r).filter(
          (step) => step.fixture !== "agents-create-local-resume" && step.fixture !== "snapshot-local-before-kill",
        ),
        {
          argv: ["snapshot", "--workspace", X8_WS],
          fixture: "snapshot-local-before-kill",
          edit: snapshotOf(X8_WS, [{ id: "t-starting", title: "", agent: null }]),
        },
        {
          argv: ["snapshot", "--workspace", X8_WS],
          fixture: "snapshot-local-before-kill",
          edit: snapshotOf(X8_WS, [{ id: "t-starting", title: "", agent: { id: "claude", state: "working" } }]),
        },
      ];
      const t = rig(script, { config: { remoteBase: r.remoteBase, agentPollDelaysMs: [0, 0] } });
      const launched = yield* t.run((s) => s.launch(request()));
      assert.strictEqual(launched.threadId, `local:${X8_WS}`);
      assert.isUndefined(t.calls.find(argvIs("agents", "create")));
      const saved = yield* readThread(t.data, X8_WS).pipe(Effect.provide(NodeServices.layer));
      assert.deepStrictEqual(saved!.terminals, ["t-starting"]);
      assert.deepStrictEqual(t.unused(), []);
    }),
  );

  it.live("takes no terminal of another preset as its agent", () =>
    Effect.gen(function* () {
      const r = repos();
      r.addWorktree("fac/x8", "main");
      const script = launchScript(r).map((step) =>
        step.fixture === "snapshot-local-before-kill"
          ? { ...step, edit: snapshotOf(X8_WS, [{ id: "t-codex", title: "", agent: { id: "codex", state: "working" } }]) }
          : step,
      );
      // One look: another preset reads as no agent of this one, however often it is looked at.
      const t = rig(script, { config: { remoteBase: r.remoteBase, agentPollDelaysMs: [] } });
      const error = yield* Effect.flip(t.run((s) => s.launch(request())));
      assert.strictEqual(error._tag, "FactorySessionsError");
      assert.isUndefined(t.calls.find(argvIs("agents", "create")));
    }),
  );

  it.live("a repeat create never resets the worktree under the agent an earlier attempt started", () =>
    Effect.gen(function* () {
      const r = repos();
      // The lost attempt's agent works on a clean worktree at the old base; the base moved since.
      r.addWorktree("fac/1-1", "main");
      const before = reflog(r.worktree);
      const t = rig(
        [
          { argv: ["projects", "list", "--local"], fixture: "projects-list-local", edit: withProjectPath(r.clone) },
          // X7: create on a branch that already has a workspace answers it with alreadyExists.
          { argv: argvIs("workspaces", "create"), fixture: "ws-create-local-repeat" },
          { argv: ["workspaces", "get", L1_WS, "--local"], fixture: "ws-get-local", edit: withPath(r.worktree) },
          { argv: ["snapshot", "--workspace", L1_WS], fixture: "snapshot-local-before-kill", edit: snapshotOf(L1_WS) },
        ],
        { config: { remoteBase: r.remoteBase } },
      );
      const launched = yield* t.run((s) => s.launch(request({ baseRef: "x8-origin-only" })));
      assert.strictEqual(launched.threadId, `local:${L1_WS}`);
      assert.isUndefined(t.calls.find(argvIs("agents", "create")));
      assert.strictEqual(git(r.worktree, "rev-parse", "HEAD"), r.main);
      assert.strictEqual(reflog(r.worktree), before);
      assert.deepStrictEqual(t.unused(), []);
    }),
  );

  it.live("the base check keeps a worktree whose own branch was pushed, and resets nothing", () =>
    Effect.gen(function* () {
      const r = repos();
      r.addWorktree("fac/1-1", "main");
      // The earlier agent committed and pushed: the clone's origin/fac/1-1 has the commit too,
      // and the worktree is clean.
      const work = commit(r.worktree, "agent.txt");
      git(r.worktree, "push", "-q", "origin", "fac/1-1");
      assert.strictEqual(git(r.clone, "rev-parse", "refs/remotes/origin/fac/1-1"), work);
      const before = reflog(r.worktree);
      const t = rig(
        [
          { argv: ["projects", "list", "--local"], fixture: "projects-list-local", edit: withProjectPath(r.clone) },
          { argv: argvIs("workspaces", "create"), fixture: "ws-create-local-repeat" },
          { argv: ["workspaces", "get", L1_WS, "--local"], fixture: "ws-get-local", edit: withPath(r.worktree) },
          { argv: ["snapshot", "--workspace", L1_WS], fixture: "snapshot-local-before-kill", edit: snapshotOf(L1_WS, []) },
        ],
        { config: { remoteBase: r.remoteBase } },
      );
      const error = yield* Effect.flip(t.run((s) => s.launch(request({ baseRef: "x8-origin-only" }))));
      assert.strictEqual(error._tag, "FactorySessionsError");
      assert.strictEqual(git(r.worktree, "rev-parse", "HEAD"), work);
      assert.strictEqual(reflog(r.worktree), before);
      assert.isUndefined(t.calls.find(argvIs("agents", "create")));
      assert.deepStrictEqual(t.unused(), []);
    }),
  );

  it.live("a base fetch the network dropped is tried again, and one the server refused is not", () =>
    Effect.gen(function* () {
      for (const [stderr, outcome] of [
        ["fatal: unable to access 'https://github.com/x/y.git/': Could not resolve host: github.com\n", "launches"],
        ["fatal: couldn't find remote ref refs/heads/x8-origin-only\n", "refuses"],
      ] as const) {
        const r = repos();
        r.addWorktree("fac/x8", "main");
        const url = `${r.remoteBase}/original-solutions/factory-paradev-spike.git`;
        let failed = false;
        const t = rig(outcome === "launches" ? launchScript(r) : launchScript(r).slice(0, 1), {
          config: { remoteBase: r.remoteBase, fetchRetryDelaysMs: [0, 0] },
          gitResult: (args) => {
            if (failed || !args.includes(url)) return undefined;
            failed = true;
            return { exitCode: 128, stderrTail: stderr };
          },
        });
        const exit = yield* Effect.exit(t.run((s) => s.launch(request({ baseRef: "x8-origin-only" }))));
        const fetches = t.gitCalls.filter((c) => c.args.includes(url)).length;
        if (outcome === "launches") {
          assert.isTrue(exit._tag === "Success", stderr);
          assert.strictEqual(fetches, 2, stderr);
          assert.strictEqual(git(r.worktree, "rev-parse", "HEAD"), r.originOnly);
        } else {
          assert.isTrue(exit._tag === "Failure", stderr);
          assert.strictEqual(fetches, 1, stderr);
          assert.isUndefined(t.calls.find(argvIs("workspaces", "create")), stderr);
        }
      }
    }),
  );

  it.live("the base check keeps a worktree with work in it, and the launch stops when no agent is there", () =>
    Effect.gen(function* () {
      for (const leave of ["commit", "edit", "untracked"] as const) {
        const r = repos();
        r.addWorktree("fac/x8", "main");
        const work = leave === "commit" ? commit(r.worktree, "work.txt") : r.main;
        if (leave === "edit") NodeFS.writeFileSync(NodePath.join(r.worktree, "a.txt"), "edited");
        // The base adds b.txt, so a reset would write over this file.
        if (leave === "untracked") NodeFS.writeFileSync(NodePath.join(r.worktree, "b.txt"), "mine");
        const t = rig(launchScript(r).filter((step) => step.fixture !== "agents-create-local-resume"), {
          config: { remoteBase: r.remoteBase },
        });
        const error = yield* Effect.flip(t.run((s) => s.launch(request({ baseRef: "x8-origin-only" }))));
        assert.strictEqual(error._tag, "FactorySessionsError", leave);
        assert.strictEqual(git(r.worktree, "rev-parse", "HEAD"), work, leave);
        if (leave === "edit") assert.strictEqual(NodeFS.readFileSync(NodePath.join(r.worktree, "a.txt"), "utf8"), "edited");
        if (leave === "untracked") assert.strictEqual(NodeFS.readFileSync(NodePath.join(r.worktree, "b.txt"), "utf8"), "mine");
        assert.isUndefined(t.calls.find(argvIs("agents", "create")), leave);
      }
    }),
  );

  it.live("resets to the commit it fetched, whatever the shared origin ref says by then", () =>
    Effect.gen(function* () {
      const r = repos();
      r.addWorktree("fac/x8", "main");
      // Between the fetch and the base check another worktree's session moves the shared ref.
      const script = launchScript(r).map((step) =>
        step.fixture === "ws-get-local-x8"
          ? {
              ...step,
              edit: (answer: unknown) => {
                git(r.clone, "update-ref", "refs/remotes/origin/x8-origin-only", r.main);
                return withPath(r.worktree)(answer);
              },
            }
          : step,
      );
      const t = rig(script, { config: { remoteBase: r.remoteBase } });
      yield* t.run((s) => s.launch(request({ baseRef: "x8-origin-only" })));
      assert.strictEqual(git(r.worktree, "rev-parse", "HEAD"), r.originOnly);
    }),
  );

  it.live("only the fetch into the adapter's own repository carries credentials", () =>
    Effect.gen(function* () {
      const r = repos();
      r.addWorktree("fac/x8", "main");
      const token = process.env.GH_TOKEN;
      process.env.GH_TOKEN = "test-token";
      const t = rig(launchScript(r), { config: { remoteBase: r.remoteBase, ghConfigDir: "/factory/gh" } });
      try {
        yield* t.run((s) => s.launch(request({ baseRef: "x8-origin-only" })));
      } finally {
        if (token === undefined) delete process.env.GH_TOKEN;
        else process.env.GH_TOKEN = token;
      }
      const helper = "credential.helper=!gh auth git-credential";
      const credentialed = t.gitCalls.filter((c) => c.args.includes(helper) || "GH_CONFIG_DIR" in c.env);
      assert.strictEqual(credentialed.length, 1);
      const [fetch] = credentialed;
      assert.isTrue(fetch!.args.includes(helper));
      assert.strictEqual(fetch!.env.GH_CONFIG_DIR, "/factory/gh");
      assert.strictEqual(fetch!.env.GH_TOKEN, "test-token");
      assert.include(fetch!.args, `${r.remoteBase}/original-solutions/factory-paradev-spike.git`);
      const dir = fetch!.args[fetch!.args.indexOf("-C") + 1]!;
      assert.isTrue(dir.startsWith(NodePath.join(t.data, "paradev")), dir);
      // Every call in the clone or the worktree runs with no credentials.
      for (const call of t.gitCalls.filter((c) => c !== fetch)) {
        assert.notInclude(call.args, helper);
        assert.notProperty(call.env, "GH_TOKEN");
        assert.notProperty(call.env, "GH_CONFIG_DIR");
      }
    }),
  );

  it.live("refuses a base that is not a plain branch name, before it fetches or creates", () =>
    Effect.gen(function* () {
      for (const baseRef of ["main:refs/heads/evil", "-x", "x8-origin-only:refs/remotes/origin/main"]) {
        const r = repos();
        const before = git(r.clone, "for-each-ref");
        const t = rig(
          [{ argv: ["projects", "list", "--local"], fixture: "projects-list-local", edit: withProjectPath(r.clone) }],
          { config: { remoteBase: r.remoteBase } },
        );
        const error = yield* Effect.flip(t.run((s) => s.launch(request({ baseRef }))));
        assert.strictEqual(error._tag, "FactorySessionsError", baseRef);
        assert.deepStrictEqual(t.calls, [["projects", "list", "--local"]], baseRef);
        assert.strictEqual(git(r.clone, "for-each-ref"), before, baseRef);
      }
    }),
  );

  it.live("a lost launch file with its thread record whole starts nothing and is written again", () =>
    Effect.gen(function* () {
      const r = repos();
      const t = rig(
        [
          { argv: ["projects", "list", "--local"], fixture: "projects-list-local", edit: withProjectPath(r.clone) },
          { argv: argvIs("workspaces", "create"), fixture: "ws-create-local-repeat" },
        ],
        { config: { remoteBase: r.remoteBase } },
      );
      yield* seed(t.data, record());
      const launched = yield* t.run((s) => s.launch(request()));
      assert.deepStrictEqual(launched, { threadId: `local:${L1_WS}`, worktreePath: record().worktreePath, branch: "fac/1-1" });
      assert.deepStrictEqual(t.unused(), []);
      assert.strictEqual(t.calls.length, 2);
      assert.isUndefined(t.calls.find(argvIs("agents", "create")));
      assert.strictEqual(
        yield* readLaunch(t.data, LAUNCH_ID).pipe(Effect.provide(NodeServices.layer)),
        `local:${L1_WS}`,
      );
    }),
  );
});

describe("launch after a crash between the launch file and the agent's start", () => {
  it.live("an earlier attempt's work with no agent left stops the launch, and nothing is reset", () =>
    Effect.gen(function* () {
      const r = repos();
      r.addWorktree("fac/2-1", "main");
      const work = commit(r.worktree, "agent.txt");
      const t = rig(
        [
          { argv: ["snapshot", "--workspace", L5_WS], fixture: "snapshot-local-before-kill", edit: snapshotOf(L5_WS, []) },
          { argv: ["projects", "list", "--local"], fixture: "projects-list-local", edit: withProjectPath(r.clone) },
          { argv: ["workspaces", "get", L5_WS, "--local"], fixture: "ws-get-local-x8", edit: withPath(r.worktree) },
        ],
        { config: { remoteBase: r.remoteBase } },
      );
      yield* Effect.gen(function* () {
        yield* writeThread(t.data, record({ threadId: `local:${L5_WS}`, workspaceId: L5_WS, branch: "fac/2-1", worktreePath: null, terminals: [], turns: [] }));
        yield* writeLaunch(t.data, LAUNCH_ID, `local:${L5_WS}`);
      }).pipe(Effect.provide(NodeServices.layer));
      const error = yield* Effect.flip(t.run((s) => s.launch(request({ baseRef: "x8-origin-only" }))));
      assert.strictEqual(error._tag, "FactorySessionsError");
      assert.strictEqual(git(r.worktree, "rev-parse", "HEAD"), work);
      assert.isUndefined(t.calls.find(argvIs("agents", "create")));
    }),
  );

  const crashed = (data: string, worktreePath: string | null) =>
    Effect.gen(function* () {
      yield* writeThread(data, record({ threadId: `local:${L5_WS}`, workspaceId: L5_WS, branch: "fac/2-1", worktreePath, terminals: [], turns: [] }));
      yield* writeLaunch(data, LAUNCH_ID, `local:${L5_WS}`);
    }).pipe(Effect.provide(NodeServices.layer));

  it.live("a terminal with no agent after every look stops the launch, with nothing fetched, reset or started", () =>
    Effect.gen(function* () {
      const r = repos();
      // The earlier attempt's agent starts on a worktree behind the base, before its first hook.
      r.addWorktree("fac/2-1", "main");
      const before = reflog(r.worktree);
      const starting = {
        argv: ["snapshot", "--workspace", L5_WS],
        fixture: "snapshot-local-before-kill",
        edit: snapshotOf(L5_WS, [{ id: "t-starting", title: "", agent: null }]),
      };
      const t = rig([starting, starting, starting], {
        config: { remoteBase: r.remoteBase, agentPollDelaysMs: [0, 0] },
      });
      yield* crashed(t.data, r.worktree);
      const error = yield* Effect.flip(t.run((s) => s.launch(request({ baseRef: "x8-origin-only" }))));
      assert.strictEqual(error._tag, "FactorySessionsError");
      assert.deepStrictEqual(t.calls, [
        ["snapshot", "--workspace", L5_WS],
        ["snapshot", "--workspace", L5_WS],
        ["snapshot", "--workspace", L5_WS],
      ]);
      assert.deepStrictEqual(t.gitCalls, []);
      assert.strictEqual(git(r.worktree, "rev-parse", "HEAD"), r.main);
      assert.strictEqual(reflog(r.worktree), before);
      const saved = yield* readThread(t.data, L5_WS).pipe(Effect.provide(NodeServices.layer));
      assert.deepStrictEqual(saved!.terminals, []);
    }),
  );

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
      const t = rig(
        [
          { argv: ["snapshot", "--workspace", L5_WS], fixture: "snapshot-local-before-kill", edit: snapshotOf(L5_WS, []) },
          { argv: ["projects", "list", "--local"], fixture: "projects-list-local", edit: withProjectPath(r.clone) },
          { argv: ["workspaces", "get", L5_WS, "--local"], fixture: "ws-get-local-x8", edit: withPath(r.worktree) },
          { argv: argvIs("agents", "create", "--local", "--workspace", L5_WS), fixture: "agents-create-local-resume" },
        ],
        { config: { remoteBase: r.remoteBase } },
      );
      yield* crashed(t.data, null);
      yield* t.run((s) => s.launch(request({ baseRef: "x8-origin-only" })));
      assert.deepStrictEqual(
        t.calls.map((argv) => argv.slice(0, 2).join(" ")),
        ["snapshot --workspace", "projects list", "workspaces get", "agents create"],
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

describe("status: the rest of the mapping table", () => {
  const IDLE_AT = lastEventAt("agents-explain-local-idle");
  /** `agents-explain-local-idle` with `state` and `lastEventType` set as given. */
  const explained = (state: string, lastEventType: string | null): Step => ({
    ...explainAt("agents-explain-local-idle"),
    edit: (answer) => ({ ...(answer as object), state, lastEventType }),
  });
  const statusWith = (steps: ReadonlyArray<Step>) =>
    Effect.gen(function* () {
      const t = rig(steps);
      yield* seed(t.data, record());
      return yield* t.run((s) => s.status(`local:${L1_WS}`));
    });
  const read = { argv: argvIs("agents", "read"), fixture: "agents-read-local" } as const;

  it.effect("starting is starting", () =>
    Effect.gen(function* () {
      assert.deepInclude(yield* statusWith([explained("starting", "Attached")]), { run: "starting", runCompletedAt: null });
    }),
  );

  it.effect("blocked on a permission request is waiting", () =>
    Effect.gen(function* () {
      const status = yield* statusWith([explained("blocked", "PermissionRequest")]);
      assert.deepInclude(status, { run: "waiting", runCompletedAt: null, lastAssistantMessage: null });
    }),
  );

  it.effect("idle after Failed is failed at the last hook", () =>
    Effect.gen(function* () {
      const status = yield* statusWith([explained("idle", "Failed"), read]);
      assert.deepInclude(status, { run: "failed", runCompletedAt: IDLE_AT });
    }),
  );

  it.effect("exited is interrupted at the last hook", () =>
    Effect.gen(function* () {
      const status = yield* statusWith([explained("exited", "Stop"), read]);
      assert.deepInclude(status, { run: "interrupted", runCompletedAt: IDLE_AT });
    }),
  );

  it.effect("No agent is running in terminal is treated as exited", () =>
    Effect.gen(function* () {
      const status = yield* statusWith([
        { argv: argvIs("agents", "explain"), fail: `No agent is running in terminal ${L1_TERM}` },
        read,
      ]);
      assert.deepInclude(status, { run: "interrupted", runCompletedAt: null });
    }),
  );

  it.effect("a state the table does not know is a SessionsError", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(statusWith([explained("dreaming", null)]));
      assert.strictEqual(error._tag, "FactorySessionsError");
    }),
  );

  it.effect("an ended run with no transcript has no last assistant message", () =>
    Effect.gen(function* () {
      const status = yield* statusWith([
        explainAt("agents-explain-local-idle"),
        { argv: argvIs("agents", "read"), fail: "No transcript for that terminal" },
      ]);
      assert.deepInclude(status, { run: "completed", lastAssistantMessage: null });
    }),
  );

  it.effect("Workspace not found on the transcript read is ThreadNotFoundError", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        statusWith([
          explainAt("agents-explain-local-idle"),
          { argv: argvIs("agents", "read"), fixture: "agents-read-local-archived" },
        ]),
      );
      assert.instanceOf(error, ThreadNotFoundError);
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
        { agentRunning, config: { agentCommand: "claude-bin" } },
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
      assert.deepStrictEqual(lookups, [["claude-bin", worktreePath]]);
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
      assert.strictEqual(project?.repo, "original-solutions/factory-paradev-spike");
      // No paradev.model or paradev.effort: the agent's defaults, so no --model and no --effort.
      assert.deepStrictEqual(project?.model, { instanceId: "claude", model: "" });
      assert.isNull(yield* t.run((s) => s.findProject(root)));
    }),
  );

  it.live("findProjects answers each root, in order, from one projects list", () =>
    Effect.gen(function* () {
      const root = tempDir("project");
      const t = rig([
        { argv: ["projects", "list", "--local"], fixture: "projects-list-local", edit: withProjectPath(root) },
      ]);
      const found = yield* t.run((s) => s.findProjects([tempDir("none"), root, root]));
      assert.deepStrictEqual(
        found.map((project) => project?.id ?? null),
        [null, SPIKE_PROJECT, SPIKE_PROJECT],
      );
    }),
  );

  it.live("carries paradev.model and paradev.effort as the model launch passes on", () =>
    Effect.gen(function* () {
      const root = tempDir("project");
      const t = rig(
        [{ argv: ["projects", "list", "--local"], fixture: "projects-list-local", edit: withProjectPath(root) }],
        { config: { model: "opus", effort: "high" } },
      );
      const project = yield* t.run((s) => s.findProject(root));
      assert.deepStrictEqual(project?.model, {
        instanceId: "claude",
        model: "opus",
        options: [{ id: "effort", value: "high" }],
      });
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

  it.live("still answers when the clone's config holds a filter name the pins refuse", () =>
    Effect.gen(function* () {
      const r = repos();
      r.addWorktree("fac/1-1", "main");
      git(r.clone, "config", "filter.x=y.smudge", "false");
      const t = rig([]);
      assert.deepStrictEqual(yield* t.run((s) => s.worktreeCheckout(r.worktree)), { head: r.main, branch: "fac/1-1" });
    }),
  );
});

describe("the real process lookup", () => {
  it.live("finds a process by name whose working directory is the folder, through a symlink", () =>
    Effect.gen(function* () {
      const dir = tempDir("cwd");
      const link = NodePath.join(tempDir("link"), "wt");
      NodeFS.symlinkSync(dir, link);
      // An unusual duration marks this child as the test's own.
      const child = NodeChildProcess.spawn("sleep", ["4207"], { cwd: dir, stdio: "ignore" });
      try {
        const processes = yield* AgentProcess;
        assert.strictEqual(yield* processes.find("sleep", link), child.pid);
        assert.isNull(yield* processes.find("sleep", tempDir("elsewhere")));
      } finally {
        child.kill("SIGKILL");
      }
    }).pipe(
      Effect.provide(agentProcessLayer.pipe(Layer.provide(Layer.mergeAll(processLayer, NodeServices.layer)))),
    ),
  );

  it.live("answers null when no process has the name", () =>
    Effect.gen(function* () {
      const processes = yield* AgentProcess;
      assert.isNull(yield* processes.find("fac-none-zq", process.cwd()));
    }).pipe(
      Effect.provide(agentProcessLayer.pipe(Layer.provide(Layer.mergeAll(processLayer, NodeServices.layer)))),
    ),
  );
});

// ---- send, resume -----------------------------------------------------------------------------

const GATE_TEXT = (readFixture("terminals-send-local").argv[7] as string);
const SEND_ID = "softfac:original-solutions__factory-paradev-spike__1__1:gate-1";
const AFTER_GATE_AT = lastEventAt("agents-explain-local-after-gate");
/** The after-gate explain with its last hook moved by `ms`. */
const hookedAt = (ms: number) => (answer: unknown) => ({ ...(answer as object), lastEventAt: AFTER_GATE_AT + ms });
/** Two reaction polls after the text, one after Enter: the 20 s and 10 s windows, scaled down. */
const FAST_POLL: Partial<ParadevSessionsConfig> = { sendPollMs: 1, sendWaitsMs: [2, 1] };
const textSend = ["terminals", "send", "--local", "--workspace", L1_WS, "--terminal", L1_TERM, "--text", GATE_TEXT];
const enterSend = ["terminals", "send", "--local", "--workspace", L1_WS, "--terminal", L1_TERM, "--keys", "enter"];
const quiet = (): Step => ({ ...explainAt("agents-explain-local-after-gate") });
const reacted = (): Step => ({ ...explainAt("agents-explain-local-after-gate"), edit: hookedAt(1) });
/** The L1 workspace with its recorded agent's terminal, and a shell a person opened beside it. */
const l1Snapshot = (): Step => ({
  argv: ["snapshot", "--workspace", L1_WS],
  fixture: "snapshot-local-killed",
  edit: snapshotOf(L1_WS, [
    { id: L1_TERM, title: "", agent: { id: "claude", state: "idle" } },
    { id: "t-shell", title: "zsh", agent: null },
  ]),
});
const savedL1 = (data: string) => readThread(data, L1_WS).pipe(Effect.provide(NodeServices.layer));

describe("send", () => {
  it.live("delivers the text, sees the agent react, and counts a send turn", () =>
    Effect.gen(function* () {
      const t = rig(
        [l1Snapshot(), quiet(), { argv: textSend, fixture: "terminals-send-local" }, quiet(), reacted()],
        { agentRunning: true, config: FAST_POLL },
      );
      yield* seed(t.data, record());
      yield* t.run((s) => s.send(`local:${L1_WS}`, SEND_ID, GATE_TEXT));
      assert.deepStrictEqual(t.unused(), []);
      assert.isFalse(t.calls.some((argv) => argv.includes("--wait") || argv.includes("--keys")));
      assert.deepStrictEqual(t.lookups, [["claude", record().worktreePath!]]);
      const saved = yield* savedL1(t.data);
      assert.deepStrictEqual(saved!.terminals, [L1_TERM]);
      assert.deepStrictEqual(saved!.turns.map((turn) => [turn.commandId, turn.kind]), [
        [LAUNCH_ID, "launch"],
        [SEND_ID, "send"],
      ]);
      assert.isNull(saved!.pendingResume);
      assert.isNull(saved!.pendingSend);
    }),
  );

  it.live("returns at once for a command id already in the record's turns", () =>
    Effect.gen(function* () {
      const t = rig([], { agentRunning: true });
      yield* seed(t.data, record({ turns: [...record().turns, { commandId: SEND_ID, at: 1, kind: "send" }] }));
      yield* t.run((s) => s.send(`local:${L1_WS}`, SEND_ID, GATE_TEXT));
      assert.deepStrictEqual(t.calls, []);
      assert.deepStrictEqual(t.lookups, []);
    }),
  );

  it.live("with no reaction presses Enter once, and a reaction then counts the turn", () =>
    Effect.gen(function* () {
      const t = rig(
        [
          l1Snapshot(),
          quiet(),
          { argv: textSend, fixture: "terminals-send-local" },
          quiet(),
          quiet(),
          { argv: enterSend, fixture: "terminals-send-local" },
          reacted(),
        ],
        { agentRunning: true, config: FAST_POLL },
      );
      yield* seed(t.data, record());
      yield* t.run((s) => s.send(`local:${L1_WS}`, SEND_ID, GATE_TEXT));
      assert.deepStrictEqual(t.unused(), []);
      assert.strictEqual((yield* savedL1(t.data))!.turns.at(-1)!.kind, "send");
    }),
  );

  it.live("still no reaction after Enter is MessageRejectedError, and no turn is counted", () =>
    Effect.gen(function* () {
      const t = rig(
        [
          l1Snapshot(),
          quiet(),
          { argv: textSend, fixture: "terminals-send-local" },
          quiet(),
          quiet(),
          { argv: enterSend, fixture: "terminals-send-local" },
          quiet(),
        ],
        { agentRunning: true, config: FAST_POLL },
      );
      yield* seed(t.data, record());
      const error = yield* Effect.flip(t.run((s) => s.send(`local:${L1_WS}`, SEND_ID, GATE_TEXT)));
      assert.instanceOf(error, MessageRejectedError);
      assert.deepInclude(error, { threadId: `local:${L1_WS}`, commandId: SEND_ID });
      assert.deepStrictEqual(t.unused(), []);
      // The idle agent dropped the text: a repeat may type it again.
      assert.deepStrictEqual(yield* savedL1(t.data), record({ pendingSend: null }));
    }),
  );

  it.live("still no reaction after Enter from a busy agent is a SessionsError that keeps the send pending", () =>
    Effect.gen(function* () {
      // In a long tool call the agent queues the text and sends no hook until the call ends.
      const working = (answer: unknown) => ({ ...(answer as object), state: "working", lastEventType: "PreToolUse" });
      const t = rig(
        [
          l1Snapshot(),
          quiet(),
          { argv: textSend, fixture: "terminals-send-local" },
          quiet(),
          quiet(),
          { argv: enterSend, fixture: "terminals-send-local" },
          { ...quiet(), edit: working },
        ],
        { agentRunning: true, config: FAST_POLL },
      );
      yield* seed(t.data, record());
      const error = yield* Effect.flip(t.run((s) => s.send(`local:${L1_WS}`, SEND_ID, GATE_TEXT)));
      assert.notInstanceOf(error, MessageRejectedError);
      assert.deepInclude(error, { _tag: "FactorySessionsError", operation: "send" });
      assert.deepStrictEqual(t.unused(), []);
      assert.deepStrictEqual(
        yield* savedL1(t.data),
        record({ pendingSend: { commandId: SEND_ID, before: AFTER_GATE_AT } }),
      );
    }),
  );

  it.live("a repeat after a crash right after typing types nothing and counts the turn on a newer hook", () =>
    Effect.gen(function* () {
      const t = rig([l1Snapshot(), reacted()], { agentRunning: true, config: FAST_POLL });
      yield* seed(t.data, record({ pendingSend: { commandId: SEND_ID, before: AFTER_GATE_AT } }));
      yield* t.run((s) => s.send(`local:${L1_WS}`, SEND_ID, GATE_TEXT));
      assert.deepStrictEqual(t.unused(), []);
      assert.isFalse(t.calls.some(argvIs("terminals", "send")));
      assert.strictEqual(t.calls.filter(argvIs("agents", "explain")).length, 1);
      const saved = yield* savedL1(t.data);
      assert.deepStrictEqual(saved!.turns.map((turn) => [turn.commandId, turn.kind]), [
        [LAUNCH_ID, "launch"],
        [SEND_ID, "send"],
      ]);
      assert.isNull(saved!.pendingSend);
    }),
  );

  it.live("a repeat that typed before an agent's first hook counts any hook as the reaction", () =>
    Effect.gen(function* () {
      const t = rig([l1Snapshot(), quiet()], { agentRunning: true, config: FAST_POLL });
      yield* seed(t.data, record({ pendingSend: { commandId: SEND_ID, before: null } }));
      yield* t.run((s) => s.send(`local:${L1_WS}`, SEND_ID, GATE_TEXT));
      assert.deepStrictEqual(t.unused(), []);
      assert.isFalse(t.calls.some(argvIs("terminals", "send")));
      assert.strictEqual((yield* savedL1(t.data))!.turns.at(-1)!.commandId, SEND_ID);
    }),
  );

  it.live("a repeat with no hook since the text was typed is a SessionsError, types nothing and keeps the send pending", () =>
    Effect.gen(function* () {
      const pending = record({ pendingSend: { commandId: SEND_ID, before: AFTER_GATE_AT } });
      const t = rig([l1Snapshot(), quiet()], { agentRunning: true, config: FAST_POLL });
      yield* seed(t.data, pending);
      const error = yield* Effect.flip(t.run((s) => s.send(`local:${L1_WS}`, SEND_ID, GATE_TEXT)));
      assert.notInstanceOf(error, MessageRejectedError);
      assert.deepInclude(error, { _tag: "FactorySessionsError", operation: "send" });
      assert.deepStrictEqual(t.unused(), []);
      assert.isFalse(t.calls.some(argvIs("terminals", "send")));
      assert.strictEqual(t.calls.filter(argvIs("agents", "explain")).length, 1);
      assert.deepStrictEqual(yield* savedL1(t.data), pending);
    }),
  );

  it.live("a repeat to an agent now at a permission prompt counts the turn of the text that landed", () =>
    Effect.gen(function* () {
      const blockedSince = (answer: unknown) => ({
        ...(answer as object),
        state: "blocked",
        lastEventType: "PermissionRequest",
        lastEventAt: AFTER_GATE_AT + 1,
      });
      const t = rig([l1Snapshot(), { ...quiet(), edit: blockedSince }], { agentRunning: true, config: FAST_POLL });
      yield* seed(t.data, record({ pendingSend: { commandId: SEND_ID, before: AFTER_GATE_AT } }));
      yield* t.run((s) => s.send(`local:${L1_WS}`, SEND_ID, GATE_TEXT));
      assert.deepStrictEqual(t.unused(), []);
      assert.isFalse(t.calls.some(argvIs("terminals", "send")));
      const saved = yield* savedL1(t.data);
      assert.strictEqual(saved!.turns.at(-1)!.commandId, SEND_ID);
      assert.isNull(saved!.pendingSend);
    }),
  );

  it.live("a repeat that typed before an agent's first hook, to an agent with still none, keeps the send pending", () =>
    Effect.gen(function* () {
      const pending = record({ pendingSend: { commandId: SEND_ID, before: null } });
      const noHook = (answer: unknown) => ({ ...(answer as object), lastEventAt: null });
      const t = rig([l1Snapshot(), { ...quiet(), edit: noHook }], { agentRunning: true, config: FAST_POLL });
      yield* seed(t.data, pending);
      const error = yield* Effect.flip(t.run((s) => s.send(`local:${L1_WS}`, SEND_ID, GATE_TEXT)));
      assert.deepInclude(error, { _tag: "FactorySessionsError", operation: "send" });
      assert.deepStrictEqual(t.unused(), []);
      assert.isFalse(t.calls.some(argvIs("terminals", "send")));
      assert.deepStrictEqual(yield* savedL1(t.data), pending);
    }),
  );

  const refusals: ReadonlyArray<readonly [string, string, boolean]> = [
    ["the host service is not running", "Host service for this machine isn't running", true],
    ["the agent exited", `No agent is running in terminal ${L1_TERM}`, true],
    ["a failure Paradev does not name", "something Paradev never said", false],
  ];
  for (const [what, stderr, untyped] of refusals) {
    it.live(`a terminals send that fails as ${what} ${untyped ? "clears the send, so a repeat types it" : "keeps the send pending"}`, () =>
      Effect.gen(function* () {
        const t = rig([l1Snapshot(), quiet(), { argv: textSend, fail: stderr }], { agentRunning: true, config: FAST_POLL });
        yield* seed(t.data, record());
        const error = yield* Effect.flip(t.run((s) => s.send(`local:${L1_WS}`, SEND_ID, GATE_TEXT)));
        assert.deepInclude(error, { _tag: "FactorySessionsError", operation: "send" });
        assert.deepStrictEqual(t.unused(), []);
        assert.deepStrictEqual(
          yield* savedL1(t.data),
          record({ pendingSend: untyped ? null : { commandId: SEND_ID, before: AFTER_GATE_AT } }),
        );
      }),
    );
  }

  it.live("a send under another command id clears the pending one and types as a fresh send", () =>
    Effect.gen(function* () {
      const t = rig(
        [l1Snapshot(), quiet(), { argv: textSend, fixture: "terminals-send-local" }, quiet(), reacted()],
        { agentRunning: true, config: FAST_POLL },
      );
      yield* seed(t.data, record({ pendingSend: { commandId: `${SEND_ID}-old`, before: AFTER_GATE_AT - 1 } }));
      yield* t.run((s) => s.send(`local:${L1_WS}`, SEND_ID, GATE_TEXT));
      assert.deepStrictEqual(t.unused(), []);
      assert.strictEqual(t.calls.filter(argvIs("terminals", "send")).length, 1);
      const saved = yield* savedL1(t.data);
      assert.deepStrictEqual(saved!.turns.map((turn) => turn.commandId), [LAUNCH_ID, SEND_ID]);
      assert.isNull(saved!.pendingSend);
    }),
  );

  it.live("a send under another command id clears the pending one even when it types nothing", () =>
    Effect.gen(function* () {
      const blocked = (answer: unknown) => ({ ...(answer as object), state: "blocked", lastEventType: "PermissionRequest" });
      const t = rig([l1Snapshot(), { ...quiet(), edit: blocked }], { agentRunning: true, config: FAST_POLL });
      yield* seed(t.data, record({ pendingSend: { commandId: `${SEND_ID}-old`, before: AFTER_GATE_AT - 1 } }));
      assert.instanceOf(yield* Effect.flip(t.run((s) => s.send(`local:${L1_WS}`, SEND_ID, GATE_TEXT))), MessageRejectedError);
      assert.deepStrictEqual(t.unused(), []);
      assert.deepStrictEqual(yield* savedL1(t.data), record({ pendingSend: null }));
    }),
  );

  it.live("an agent with no hook yet counts its first hook as the reaction", () =>
    Effect.gen(function* () {
      const t = rig(
        [
          l1Snapshot(),
          { ...quiet(), edit: (answer) => ({ ...(answer as object), lastEventAt: null }) },
          { argv: textSend, fixture: "terminals-send-local" },
          reacted(),
        ],
        { agentRunning: true, config: FAST_POLL },
      );
      yield* seed(t.data, record());
      yield* t.run((s) => s.send(`local:${L1_WS}`, SEND_ID, GATE_TEXT));
      assert.deepStrictEqual(t.unused(), []);
      assert.isFalse(t.calls.some((argv) => argv.includes("--keys")));
      assert.strictEqual((yield* savedL1(t.data))!.turns.at(-1)!.kind, "send");
    }),
  );

  it.live("the text is not sent again when its terminals send cannot connect", () =>
    Effect.gen(function* () {
      const t = rig(
        [l1Snapshot(), quiet(), { argv: textSend, fail: "Could not connect to API" }],
        { agentRunning: true, config: FAST_POLL },
      );
      yield* seed(t.data, record());
      const error = yield* Effect.flip(t.run((s) => s.send(`local:${L1_WS}`, SEND_ID, GATE_TEXT)));
      assert.deepInclude(error, { _tag: "FactorySessionsError", operation: "send" });
      assert.strictEqual(t.calls.filter(argvIs("terminals", "send")).length, 1);
      // Written before the text: a repeat of this command id types nothing.
      assert.deepStrictEqual(
        yield* savedL1(t.data),
        record({ pendingSend: { commandId: SEND_ID, before: AFTER_GATE_AT } }),
      );
    }),
  );

  it.live("an agent at a permission prompt is MessageRejectedError, with nothing typed and no Enter", () =>
    Effect.gen(function* () {
      // Text and Enter would answer the prompt: Enter picks its focused option.
      const blocked = (answer: unknown) => ({ ...(answer as object), state: "blocked", lastEventType: "PermissionRequest" });
      const t = rig([l1Snapshot(), { ...quiet(), edit: blocked }], { agentRunning: true, config: FAST_POLL });
      yield* seed(t.data, record());
      const error = yield* Effect.flip(t.run((s) => s.send(`local:${L1_WS}`, SEND_ID, GATE_TEXT)));
      assert.instanceOf(error, MessageRejectedError);
      assert.deepInclude(error, { threadId: `local:${L1_WS}`, commandId: SEND_ID });
      assert.deepStrictEqual(t.unused(), []);
      assert.isFalse(t.calls.some(argvIs("terminals", "send")));
      assert.deepStrictEqual(yield* savedL1(t.data), record());
    }),
  );

  it.live("a typed send clears a stale pendingResume, so a later agent of the preset is not adopted under it", () =>
    Effect.gen(function* () {
      const recordedOnly: Step = {
        ...l1Snapshot(),
        edit: snapshotOf(L1_WS, [{ id: L1_TERM, title: "", agent: { id: "claude", state: "idle" } }]),
      };
      const t = rig(
        [recordedOnly, quiet(), { argv: textSend, fixture: "terminals-send-local" }, quiet(), reacted()],
        { agentRunning: true, config: FAST_POLL },
      );
      yield* seed(t.data, record({ pendingResume: "softfac:original-solutions__factory-paradev-spike__1__1:resume-1" }));
      yield* t.run((s) => s.send(`local:${L1_WS}`, SEND_ID, GATE_TEXT));
      assert.deepStrictEqual(t.unused(), []);
      assert.strictEqual(t.calls.filter(argvIs("terminals", "send")).length, 1);
      const saved = yield* savedL1(t.data);
      assert.deepStrictEqual(saved!.terminals, [L1_TERM]);
      assert.deepStrictEqual(saved!.turns.map((turn) => [turn.commandId, turn.kind]), [
        [LAUNCH_ID, "launch"],
        [SEND_ID, "send"],
      ]);
      assert.isNull(saved!.pendingResume);
    }),
  );

  it.live("a thread with no record, archived, or a workspace gone, is ThreadNotFoundError", () =>
    Effect.gen(function* () {
      const t = rig(
        [{ argv: ["snapshot", "--workspace", L5_WS], fail: `Workspace not found on host abc: ${L5_WS}` }],
        { agentRunning: true },
      );
      yield* seed(
        t.data,
        record({ threadId: `local:${L5_WS}`, workspaceId: L5_WS, terminals: [L5_RESUMED] }),
        record({ archivedAt: 1 }),
      );
      assert.instanceOf(yield* Effect.flip(t.run((s) => s.send(`local:${L5_WS}`, SEND_ID, "x"))), ThreadNotFoundError);
      assert.instanceOf(yield* Effect.flip(t.run((s) => s.send(`local:${X8_WS}`, SEND_ID, "x"))), ThreadNotFoundError);
      assert.instanceOf(yield* Effect.flip(t.run((s) => s.send(`local:${L1_WS}`, SEND_ID, "x"))), ThreadNotFoundError);
      assert.deepStrictEqual(t.unused(), []);
      assert.strictEqual(t.calls.length, 1);
    }),
  );

  it.live("an offline Paradev is a SessionsError for send", () =>
    Effect.gen(function* () {
      const t = rig([{ argv: argvIs("snapshot"), fixture: "agents-explain-local-appquit" }], { agentRunning: true });
      yield* seed(t.data, record());
      const error = yield* Effect.flip(t.run((s) => s.send(`local:${L1_WS}`, SEND_ID, "x")));
      assert.deepInclude(error, { _tag: "FactorySessionsError", operation: "send" });
    }),
  );
});

describe("send to a dead agent resumes it", () => {
  const WORKTREE = "/Users/me/.paradev/worktrees/factory-paradev-spike/fac/2-1";
  const CLAUDE_FOLDER = "-Users-me--paradev-worktrees-factory-paradev-spike-fac-2-1";
  const RESUME_TEXT = readFixture("agents-create-local-resume").argv.at(-1)!;
  // Sorts after the newest by name, so only the mtime picks the newest.
  const OLD_SESSION = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  const NEWEST_SESSION = "fc58908c-4c0b-4fc1-abd1-77bac050ee83";
  const deadRecord = (over: Partial<ThreadRecord> = {}) =>
    record({ threadId: `local:${L5_WS}`, workspaceId: L5_WS, branch: "fac/2-1", worktreePath: WORKTREE, terminals: [L5_DEAD], ...over });

  /** Claude's projects folder with two sessions for the worktree; the newest is NEWEST_SESSION. */
  const claudeProjects = (sessions = true) => {
    const dir = tempDir("claude-projects");
    if (!sessions) return dir;
    const folder = NodePath.join(dir, CLAUDE_FOLDER);
    NodeFS.mkdirSync(folder, { recursive: true });
    const old = NodePath.join(folder, `${OLD_SESSION}.jsonl`);
    NodeFS.writeFileSync(old, "{}\n");
    NodeFS.utimesSync(old, 1_000, 1_000);
    NodeFS.writeFileSync(NodePath.join(folder, `${NEWEST_SESSION}.jsonl`), "{}\n");
    NodeFS.writeFileSync(NodePath.join(folder, "notes.txt"), "not a session\n");
    return dir;
  };

  const resumeArgv = [
    "agents", "create", "--local", "--workspace", L5_WS, "--agent", "claude",
    "--resume-session", NEWEST_SESSION, "--prompt", RESUME_TEXT,
  ];
  const closeArgv = ["terminals", "close", "--local", "--workspace", L5_WS, "--terminal", L5_DEAD];
  const killed = explainAt("agents-explain-local-killed", L5_WS, L5_DEAD);
  const snap = (fixture: string, edit?: (answer: unknown) => unknown): Step => ({
    argv: ["snapshot", "--workspace", L5_WS],
    fixture,
    ...(edit === undefined ? {} : { edit }),
  });

  const saved = (data: string) => readThread(data, L5_WS).pipe(Effect.provide(NodeServices.layer));

  it.live("closes the dead terminal and resumes the newest session in a new one, typing nothing", () =>
    Effect.gen(function* () {
      const t = rig(
        [
          snap("snapshot-local-killed"),
          killed,
          { argv: closeArgv, fixture: "terminals-close-local-killed" },
          { argv: resumeArgv, fixture: "agents-create-local-resume" },
        ],
        { agentRunning: false, config: { claudeProjectsDir: claudeProjects() } },
      );
      yield* seed(t.data, deadRecord());
      yield* t.run((s) => s.send(`local:${L5_WS}`, SEND_ID, RESUME_TEXT));
      assert.deepStrictEqual(t.unused(), []);
      assert.isFalse(t.calls.some(argvIs("terminals", "send")));
      assert.deepStrictEqual(t.lookups, [["claude", WORKTREE]]);
      const after = yield* saved(t.data);
      assert.deepStrictEqual(after!.terminals, [L5_DEAD, L5_RESUMED]);
      assert.deepStrictEqual(after!.turns.at(-1)!.commandId, SEND_ID);
      assert.strictEqual(after!.turns.at(-1)!.kind, "resume");
      assert.isNull(after!.pendingResume);
    }),
  );

  it.live("a repeat of a pending send to an agent that died since still resumes it, and the resume clears the send", () =>
    Effect.gen(function* () {
      const t = rig(
        [
          snap("snapshot-local-killed"),
          killed,
          { argv: closeArgv, fixture: "terminals-close-local-killed" },
          { argv: resumeArgv, fixture: "agents-create-local-resume" },
        ],
        { agentRunning: false, config: { claudeProjectsDir: claudeProjects() } },
      );
      yield* seed(t.data, deadRecord({ pendingSend: { commandId: SEND_ID, before: 1 } }));
      yield* t.run((s) => s.send(`local:${L5_WS}`, SEND_ID, RESUME_TEXT));
      assert.deepStrictEqual(t.unused(), []);
      assert.isFalse(t.calls.some(argvIs("terminals", "send")));
      const after = yield* saved(t.data);
      assert.deepStrictEqual(after!.terminals, [L5_DEAD, L5_RESUMED]);
      assert.deepStrictEqual(after!.turns.at(-1), { ...after!.turns.at(-1)!, commandId: SEND_ID, kind: "resume" });
      assert.isNull(after!.pendingSend);
    }),
  );

  it.live("finds the session of a worktree path with `_` in it, which Claude's folder name turns into `-`", () =>
    Effect.gen(function* () {
      // Claude names the folder with every character other than a letter or digit as `-`.
      const underscored = "/Users/me/.paradev/worktrees/factory_paradev-spike/fac/2-1";
      const t = rig(
        [
          snap("snapshot-local-killed"),
          killed,
          { argv: closeArgv, fixture: "terminals-close-local-killed" },
          { argv: resumeArgv, fixture: "agents-create-local-resume" },
        ],
        { agentRunning: false, config: { claudeProjectsDir: claudeProjects() } },
      );
      yield* seed(t.data, deadRecord({ worktreePath: underscored }));
      yield* t.run((s) => s.send(`local:${L5_WS}`, SEND_ID, RESUME_TEXT));
      assert.deepStrictEqual(t.unused(), []);
      assert.deepStrictEqual((yield* saved(t.data))!.terminals, [L5_DEAD, L5_RESUMED]);
    }),
  );

  it.live("resumes even when explain still says working with a recent hook, since the process is gone", () =>
    Effect.gen(function* () {
      // A killed agent's state never changes, so its recency says nothing: only the process does.
      const t = rig(
        [
          snap("snapshot-local-killed"),
          { ...killed, edit: (answer) => ({ ...(answer as object), lastEventAt: Date.now() }) },
          { argv: closeArgv, fixture: "terminals-close-local-killed" },
          { argv: resumeArgv, fixture: "agents-create-local-resume" },
        ],
        { agentRunning: false, config: { claudeProjectsDir: claudeProjects() } },
      );
      yield* seed(t.data, deadRecord());
      yield* t.run((s) => s.send(`local:${L5_WS}`, SEND_ID, RESUME_TEXT));
      assert.deepStrictEqual(t.unused(), []);
    }),
  );

  it.live("a terminal the snapshot no longer lists is not closed again, nor asked about", () =>
    Effect.gen(function* () {
      const t = rig(
        [snap("snapshot-local-killed", snapshotOf(L5_WS, [])), { argv: resumeArgv, fixture: "agents-create-local-resume" }],
        { agentRunning: false, config: { claudeProjectsDir: claudeProjects() } },
      );
      yield* seed(t.data, deadRecord());
      yield* t.run((s) => s.send(`local:${L5_WS}`, SEND_ID, RESUME_TEXT));
      assert.deepStrictEqual(t.unused(), []);
      assert.isFalse(t.calls.some((argv) => argvIs("terminals", "close")(argv) || argvIs("agents", "explain")(argv)));
    }),
  );

  it.live("after a crash between agents create and the record, adopts the resumed agent and starts nothing", () =>
    Effect.gen(function* () {
      // The resumed agent lives in the worktree, so the process lookup would find it.
      const t = rig([snap("snapshot-local-after-resume")], {
        agentRunning: true,
        config: { claudeProjectsDir: claudeProjects() },
      });
      yield* seed(t.data, deadRecord({ pendingResume: SEND_ID }));
      yield* t.run((s) => s.send(`local:${L5_WS}`, SEND_ID, RESUME_TEXT));
      assert.deepStrictEqual(t.unused(), []);
      assert.strictEqual(t.calls.length, 1);
      const after = yield* saved(t.data);
      assert.deepStrictEqual(after!.terminals, [L5_DEAD, L5_RESUMED]);
      assert.deepStrictEqual([after!.turns.at(-1)!.commandId, after!.turns.at(-1)!.kind], [SEND_ID, "resume"]);
      assert.isNull(after!.pendingResume);
    }),
  );

  it.live("an adopted resume of another command id is recorded under that id, and this text is then typed", () =>
    Effect.gen(function* () {
      const RESUME_ID = "softfac:original-solutions__factory-paradev-spike__2__1:resume-1";
      const toResumed = ["terminals", "send", "--local", "--workspace", L5_WS, "--terminal", L5_RESUMED, "--text", GATE_TEXT];
      const t = rig(
        [
          snap("snapshot-local-after-resume"),
          snap("snapshot-local-after-resume"),
          { ...explainAt("agents-explain-local-after-gate", L5_WS, L5_RESUMED) },
          { argv: toResumed, fixture: "terminals-send-local" },
          { ...explainAt("agents-explain-local-after-gate", L5_WS, L5_RESUMED), edit: hookedAt(1) },
        ],
        { agentRunning: true, config: { ...FAST_POLL, claudeProjectsDir: claudeProjects() } },
      );
      yield* seed(t.data, deadRecord({ pendingResume: RESUME_ID }));
      yield* t.run((s) => s.send(`local:${L5_WS}`, SEND_ID, GATE_TEXT));
      assert.deepStrictEqual(t.unused(), []);
      const after = yield* saved(t.data);
      assert.deepStrictEqual(after!.turns.slice(-2).map((turn) => [turn.commandId, turn.kind]), [
        [RESUME_ID, "resume"],
        [SEND_ID, "send"],
      ]);
    }),
  );

  it.live("an agent of the preset in a terminal the thread did not start, with no resume pending, stops the send with nothing typed", () =>
    Effect.gen(function* () {
      const t = rig([snap("snapshot-local-after-resume")], {
        agentRunning: true,
        config: { claudeProjectsDir: claudeProjects() },
      });
      yield* seed(t.data, deadRecord());
      const error = yield* Effect.flip(t.run((s) => s.send(`local:${L5_WS}`, SEND_ID, GATE_TEXT)));
      assert.deepInclude(error, { _tag: "FactorySessionsError", operation: "send" });
      assert.strictEqual(t.calls.length, 1);
      assert.deepStrictEqual(yield* saved(t.data), deadRecord());
    }),
  );

  it.live("a pending resume beside a terminal with no agent yet, and an agent process, starts nothing", () =>
    Effect.gen(function* () {
      const t = rig(
        [snap("snapshot-local-after-resume", (answer) => {
          const ws = (answer as { workspaces: ReadonlyArray<{ terminals: ReadonlyArray<Record<string, unknown>> }> }).workspaces[0]!;
          return snapshotOf(L5_WS, ws.terminals.map((term) => (term.id === L5_RESUMED ? { ...term, agent: null } : term)))(answer);
        })],
        { agentRunning: true, config: { claudeProjectsDir: claudeProjects() } },
      );
      const pending = deadRecord({ pendingResume: SEND_ID });
      yield* seed(t.data, pending);
      const error = yield* Effect.flip(t.run((s) => s.send(`local:${L5_WS}`, SEND_ID, RESUME_TEXT)));
      assert.deepInclude(error, { _tag: "FactorySessionsError", operation: "send" });
      assert.strictEqual(t.calls.length, 1);
      assert.deepStrictEqual(yield* saved(t.data), pending);
    }),
  );

  it.live("a pending resume beside a terminal with no agent and no agent process started nothing, so it resumes again", () =>
    Effect.gen(function* () {
      // The dead terminal was closed before the resume went pending; a create that failed left a bare terminal.
      const t = rig(
        [
          snap("snapshot-local-killed", snapshotOf(L5_WS, [{ id: L5_RESUMED, title: "zsh", agent: null }])),
          { argv: resumeArgv, fixture: "agents-create-local-resume" },
        ],
        { agentRunning: false, config: { claudeProjectsDir: claudeProjects() } },
      );
      yield* seed(t.data, deadRecord({ pendingResume: SEND_ID }));
      yield* t.run((s) => s.send(`local:${L5_WS}`, SEND_ID, RESUME_TEXT));
      assert.deepStrictEqual(t.unused(), []);
      const after = yield* saved(t.data);
      assert.deepStrictEqual(after!.terminals, [L5_DEAD, L5_RESUMED]);
      assert.isNull(after!.pendingResume);
    }),
  );

  it.live("a pending resume whose create started nothing resumes again on the next send", () =>
    Effect.gen(function* () {
      const t = rig(
        [
          snap("snapshot-local-killed"),
          killed,
          { argv: closeArgv, fixture: "terminals-close-local-killed" },
          { argv: resumeArgv, fixture: "agents-create-local-resume" },
        ],
        { agentRunning: false, config: { claudeProjectsDir: claudeProjects() } },
      );
      yield* seed(t.data, deadRecord({ pendingResume: SEND_ID }));
      yield* t.run((s) => s.send(`local:${L5_WS}`, SEND_ID, RESUME_TEXT));
      assert.deepStrictEqual(t.unused(), []);
      assert.strictEqual(t.calls.filter(argvIs("agents", "create")).length, 1);
      const after = yield* saved(t.data);
      assert.deepStrictEqual(after!.terminals, [L5_DEAD, L5_RESUMED]);
      assert.isNull(after!.pendingResume);
    }),
  );

  it.live("a resume whose agents create cannot connect is not retried, and stays pending", () =>
    Effect.gen(function* () {
      const t = rig(
        [
          snap("snapshot-local-killed"),
          killed,
          { argv: closeArgv, fixture: "terminals-close-local-killed" },
          { argv: resumeArgv, fail: "Could not connect to API" },
        ],
        { agentRunning: false, config: { claudeProjectsDir: claudeProjects() } },
      );
      yield* seed(t.data, deadRecord());
      const error = yield* Effect.flip(t.run((s) => s.send(`local:${L5_WS}`, SEND_ID, RESUME_TEXT)));
      assert.deepInclude(error, { _tag: "FactorySessionsError", operation: "send" });
      assert.strictEqual(t.calls.filter(argvIs("agents", "create")).length, 1);
      const after = yield* saved(t.data);
      assert.deepStrictEqual(after!.terminals, [L5_DEAD]);
      assert.strictEqual(after!.pendingResume, SEND_ID);
    }),
  );

  it.live("no session file is ThreadNotFoundError, and nothing is created", () =>
    Effect.gen(function* () {
      const t = rig(
        [snap("snapshot-local-killed"), killed, { argv: closeArgv, fixture: "terminals-close-local-killed" }],
        { agentRunning: false, config: { claudeProjectsDir: claudeProjects(false) } },
      );
      yield* seed(t.data, deadRecord());
      const error = yield* Effect.flip(t.run((s) => s.send(`local:${L5_WS}`, SEND_ID, RESUME_TEXT)));
      assert.instanceOf(error, ThreadNotFoundError);
      assert.deepStrictEqual(t.unused(), []);
      assert.deepStrictEqual((yield* saved(t.data))!.terminals, [L5_DEAD]);
    }),
  );

  it.live("an agent that exited resumes too", () =>
    Effect.gen(function* () {
      const t = rig(
        [
          snap("snapshot-local-killed"),
          { argv: killed.argv, fail: `No agent is running in terminal ${L5_DEAD}` },
          { argv: closeArgv, fixture: "terminals-close-local-killed" },
          { argv: resumeArgv, fixture: "agents-create-local-resume" },
        ],
        { agentRunning: true, config: { claudeProjectsDir: claudeProjects() } },
      );
      yield* seed(t.data, deadRecord());
      yield* t.run((s) => s.send(`local:${L5_WS}`, SEND_ID, RESUME_TEXT));
      assert.deepStrictEqual(t.unused(), []);
      assert.isFalse(t.calls.some(argvIs("terminals", "send")));
    }),
  );
});

// ---- archive, removeWorktree ------------------------------------------------------------------

describe("archive", () => {
  const archived = () => record({ threadId: `local:${L5_WS}`, workspaceId: L5_WS, branch: "fac/2-1", worktreePath: "/w/p/fac/2-1", terminals: [L5_DEAD, L5_RESUMED] });
  const archiveArgv = ["workspaces", "archive", L5_WS, "--local"];
  const saved = (data: string) => readThread(data, L5_WS).pipe(Effect.provide(NodeServices.layer));

  it.live("archives the workspace and sets archivedAt; status and thread then answer archived, and again is fine", () =>
    Effect.gen(function* () {
      const t = rig([
        { argv: archiveArgv, fixture: "ws-archive-local-2" },
        { argv: archiveArgv, fixture: "ws-archive-local-again" },
      ]);
      yield* seed(t.data, archived());
      yield* t.run((s) => s.archive(`local:${L5_WS}`));
      const at = (yield* saved(t.data))!.archivedAt;
      assert.isNumber(at);
      const status = yield* t.run((s) => s.status(`local:${L5_WS}`));
      assert.deepInclude(status, { archived: true, run: null });
      const thread = yield* t.run((s) => s.thread(`local:${L5_WS}`));
      assert.deepStrictEqual(thread, { worktreePath: "/w/p/fac/2-1", branch: "fac/2-1", archived: true });
      yield* t.run((s) => s.archive(`local:${L5_WS}`));
      assert.deepStrictEqual(t.unused(), []);
      assert.strictEqual((yield* saved(t.data))!.archivedAt, at);
    }),
  );

  it.live("a workspace archived in Paradev is gone to status and archived to thread", () =>
    Effect.gen(function* () {
      const t = rig([
        explainAt("agents-explain-local-archived", L5_WS, L5_RESUMED),
        { argv: ["workspaces", "get", L5_WS, "--local"], fixture: "ws-get-local-archived" },
        { argv: archiveArgv, fixture: "ws-archive-local-again", edit: () => ({ deleted: [], notFound: [L5_WS], failed: [], warnings: [] }) },
      ]);
      yield* seed(t.data, archived());
      assert.instanceOf(yield* Effect.flip(t.run((s) => s.status(`local:${L5_WS}`))), ThreadNotFoundError);
      assert.deepInclude(yield* t.run((s) => s.thread(`local:${L5_WS}`)), { archived: true });
      yield* t.run((s) => s.archive(`local:${L5_WS}`));
      assert.isNumber((yield* saved(t.data))!.archivedAt);
    }),
  );

  it.live("Workspace not found on archive counts as archived", () =>
    Effect.gen(function* () {
      const t = rig([{ argv: archiveArgv, fail: `Workspace not found on host abc: ${L5_WS}` }]);
      yield* seed(t.data, archived());
      yield* t.run((s) => s.archive(`local:${L5_WS}`));
      assert.isNumber((yield* saved(t.data))!.archivedAt);
    }),
  );

  it.live("an id under failed is a SessionsError, and archivedAt stays unset", () =>
    Effect.gen(function* () {
      const t = rig([
        {
          argv: archiveArgv,
          fixture: "ws-archive-local-2",
          edit: () => ({ deleted: [], notFound: [], failed: [{ id: L5_WS, error: "busy" }], warnings: [] }),
        },
      ]);
      yield* seed(t.data, archived());
      const error = yield* Effect.flip(t.run((s) => s.archive(`local:${L5_WS}`)));
      assert.deepInclude(error, { _tag: "FactorySessionsError", operation: "archive" });
      assert.isNull((yield* saved(t.data))!.archivedAt);
    }),
  );

  it.live("a thread the adapter has no record of changes nothing", () =>
    Effect.gen(function* () {
      const t = rig([]);
      yield* t.run((s) => s.archive(`local:${X8_WS}`));
      yield* t.run((s) => s.archive("t3-thread-1"));
      assert.deepStrictEqual(t.calls, []);
    }),
  );
});

describe("removeWorktree", () => {
  it.live("does nothing when the path is gone", () =>
    Effect.gen(function* () {
      const t = rig([]);
      yield* t.run((s) => s.removeWorktree(NodePath.join(tempDir("gone"), "fac", "1-1")));
      assert.deepStrictEqual(t.gitCalls, []);
    }),
  );

  it.live("removes a worktree holding changes with git in the repo clone, and keeps its branch", () =>
    Effect.gen(function* () {
      const r = repos();
      r.addWorktree("fac/1-1", r.main);
      const work = commit(r.worktree, "work.txt");
      NodeFS.writeFileSync(NodePath.join(r.worktree, "untracked.txt"), "x");
      NodeFS.writeFileSync(NodePath.join(r.worktree, "a.txt"), "edited");
      const t = rig([]);
      yield* t.run((s) => s.removeWorktree(r.worktree));
      assert.isFalse(NodeFS.existsSync(r.worktree));
      assert.notInclude(git(r.clone, "worktree", "list"), r.worktree);
      assert.strictEqual(git(r.clone, "rev-parse", "--verify", "refs/heads/fac/1-1"), work);
      const removal = t.gitCalls.find((c) => c.args.includes("remove"));
      assert.include(removal!.args.join(" "), `-C ${NodeFS.realpathSync(r.clone)} worktree remove --force ${r.worktree}`);
    }),
  );
});

describe("showGateLog", () => {
  const threadId = `local:${L1_WS}`;
  const logPath = "/data/gate-logs/o__r__1__1/1.log";
  const createArgv = (path: string) => [
    "terminals",
    "create",
    "--local",
    "--workspace",
    L1_WS,
    "--command",
    `tail -n +1 -F '${path}'`,
  ];
  const saved = (data: string) => readThread(data, L1_WS).pipe(Effect.provide(NodeServices.layer));
  // No fixture of `terminals create` was recorded: the adapter reads only the exit code.
  const created = (path: string): Step => ({ argv: createArgv(path), answer: { id: "t-new" } });

  /** The warnings the body logged, as text. */
  const warned = <A, E>(body: Effect.Effect<A, E, never>) =>
    Effect.gen(function* () {
      const logs: Array<string> = [];
      const capture = Logger.make(({ logLevel, message }) => {
        logs.push(`${logLevel} ${(Array.isArray(message) ? message : [message]).join(" ")}`);
      });
      yield* body.pipe(Effect.provide(Logger.layer([capture], { mergeWithExisting: false })));
      return logs;
    });

  it.live("creates one terminal that follows the log, and records the attempt, terminals untouched", () =>
    Effect.gen(function* () {
      const t = rig([created(logPath)]);
      yield* seed(t.data, record());
      const logs = yield* warned(t.run((s) => s.showGateLog(threadId, 1, logPath)));
      assert.deepStrictEqual(t.calls, [createArgv(logPath)]);
      assert.deepStrictEqual(logs, []);
      const after = (yield* saved(t.data))!;
      assert.deepStrictEqual(after.gateLogAttempts, [1]);
      assert.deepStrictEqual(after.terminals, [L1_TERM]);
      assert.deepStrictEqual(t.unused(), []);
    }),
  );

  it.live("a repeat for the same attempt creates nothing; the next attempt creates another", () =>
    Effect.gen(function* () {
      const second = "/data/gate-logs/o__r__1__1/2.log";
      const t = rig([created(logPath), created(second)]);
      yield* seed(t.data, record());
      yield* t.run((s) => s.showGateLog(threadId, 1, logPath));
      yield* t.run((s) => s.showGateLog(threadId, 1, logPath));
      assert.strictEqual(t.calls.length, 1);
      yield* t.run((s) => s.showGateLog(threadId, 2, second));
      assert.strictEqual(t.calls.length, 2);
      assert.deepStrictEqual((yield* saved(t.data))!.gateLogAttempts, [1, 2]);
    }),
  );

  it.live("shell-quotes the path", () =>
    Effect.gen(function* () {
      const t = rig([
        {
          argv: [...createArgv("").slice(0, 6), `tail -n +1 -F '/data/it'\\''s here/1.log'`],
          answer: {},
        },
      ]);
      yield* seed(t.data, record());
      yield* t.run((s) => s.showGateLog(threadId, 1, "/data/it's here/1.log"));
      assert.deepStrictEqual(t.unused(), []);
    }),
  );

  it.live("a terminals create that fails does not fail the effect, warns once and records nothing", () =>
    Effect.gen(function* () {
      const t = rig([{ argv: createArgv(logPath), fail: "Could not connect to API" }]);
      yield* seed(t.data, record());
      const logs = yield* warned(t.run((s) => s.showGateLog(threadId, 1, logPath)));
      assert.strictEqual(logs.length, 1, logs.join("\n"));
      assert.match(logs[0]!, /^Warn /);
      assert.include(logs[0]!, threadId);
      assert.include(logs[0]!, "Could not connect to API");
      assert.isUndefined((yield* saved(t.data))!.gateLogAttempts);
      // One call, though this failure is TRANSIENT: a retry could make a second terminal.
      assert.strictEqual(t.calls.length, 1);
    }),
  );

  it.live("reads only the exit code: exit 0 with stdout that is not JSON counts as created", () =>
    Effect.gen(function* () {
      const t = rig([{ argv: createArgv(logPath), stdout: "created terminal\n" }]);
      yield* seed(t.data, record());
      const logs = yield* warned(t.run((s) => s.showGateLog(threadId, 1, logPath)));
      assert.deepStrictEqual(logs, []);
      assert.deepStrictEqual((yield* saved(t.data))!.gateLogAttempts, [1]);
      yield* t.run((s) => s.showGateLog(threadId, 1, logPath));
      assert.strictEqual(t.calls.length, 1);
    }),
  );

  it.live("a thread with no record warns once and runs nothing", () =>
    Effect.gen(function* () {
      const t = rig([]);
      const logs = yield* warned(t.run((s) => s.showGateLog(threadId, 1, logPath)));
      assert.strictEqual(logs.length, 1, logs.join("\n"));
      assert.deepStrictEqual(t.calls, []);
    }),
  );
});

// ---- targets: a Paradev host and Paradev Cloud ----------------------------------------------

const HOST = "c9c39956e0c1756e30d6bb9f4f907ff1";
const HOST_SSH = "tomk@trilogy-mac";
const HOSTS = [{ id: HOST, name: "trilogy-mac", ssh: HOST_SSH }] as const;
const HOST_PROJECT = "380b9715-2ff5-4d8b-8e97-616b218ae450";
const HOST_CLONE = "/Users/tomk/factory-runner/original-solutions/factory-paradev-spike";
/** The host spike's fac #5 workspace, made by `ws-create-host-5`. */
const H5_WS = "80b50ae5-efab-4a32-a7b6-ed78a1ff94fd";
const H5_TERM = "57be9902-cd2c-4c58-b5fa-46d77355336b";
const H5_PATH = "/Users/tomk/.paradev/worktrees/factory-paradev-spike/fac/5-1";
/** The host spike's fac #11 attempt 2, whose agent failed on the proxy's 401 and was resumed. */
const H11_WS = "4cfac496-5143-4598-a385-41086ef5bd65";
const H11_DEAD = "99cf7fb4-1892-4237-9196-a28c7751fc12";
const H11_RESUMED = "6c823b93-58a9-4741-8c46-db2ae4646450";
const H11_PATH = "/Users/tomk/.paradev/worktrees/factory-paradev-spike/fac/11-2";
/** The trust-dialog workspace of the host spike. */
const HT_WS = "f0f5d9c4-965a-4cc0-a503-f9d998a8cc92";
const HT_TERM = "4d901aa2-6514-4e01-812f-a002fba1335d";
const ENV = "edad9805-e48d-40f3-a06c-e19a4105f974";
/** The cloud spike's fac #3 and fac #6 workspaces. */
const C3_WS = "a2bc69cb-10d6-4c73-adf9-a9efae0372a2";
const C3_TERM = "c66509a3-aea9-40f5-b34d-f9a40170963e";
const C3_BRANCH = "superset/fac-3-divide-a2bc69cb";
const C6_WS = "b4b0e881-16c4-48b5-afbc-dc146d7fee7f";
const C6_DEAD = "0d7e1d5a-6c1a-4f43-8b4f-6a1b2c3d4e5f";
const C6_RESUMED = "aeec4149-6f09-40cd-85bd-b93cbe72b264";
const C6_SESSION = "a02764cc-54fe-4a88-968a-b5fb3e45f24f";
/** The helper terminal `terminals-create-cloud-gate` made. */
const HELPER = "506a60d3-6dd2-4c12-b67d-dfd20151f16f";

/** The argv a fixture was recorded with: the adapter must make the very same call. */
const recorded = (fixture: string): Step => ({ argv: readFixture(fixture).argv, fixture });

/** An ssh runner that answers each command from `answer`, and keeps every call. */
const fakeSsh = (answer: (command: string) => Partial<RunResult> | "unreachable") => {
  const calls: Array<readonly [string, string]> = [];
  const runner: SshRunner = {
    run: (destination, command) =>
      Effect.suspend(() => {
        calls.push([destination, command]);
        const answered = answer(command);
        if (answered === "unreachable") {
          return Effect.fail(new SshError({ destination, what: "Connection timed out" }));
        }
        return Effect.succeed({
          exitCode: 0,
          timedOut: false,
          tail: "",
          stderrTail: "",
          truncated: false,
          tailTruncated: false,
          ...answered,
        } satisfies RunResult);
      }),
  };
  return { calls, runner };
};

const hostRecord = (over: Partial<ThreadRecord> = {}): ThreadRecord =>
  record({
    threadId: `host:${HOST}:${H5_WS}`,
    target: { kind: "host", machineId: HOST, name: "trilogy-mac" },
    workspaceId: H5_WS,
    projectId: HOST_PROJECT,
    branch: "fac/5-1",
    worktreePath: H5_PATH,
    terminals: [H5_TERM],
    ...over,
  });

const cloudRecord = (over: Partial<ThreadRecord> = {}): ThreadRecord =>
  record({
    threadId: `cloud:${C3_WS}`,
    target: { kind: "cloud", environmentId: ENV },
    workspaceId: C3_WS,
    projectId: ENV,
    branch: C3_BRANCH,
    worktreePath: "/workspace",
    terminals: [C3_TERM],
    ...over,
  });

/** The four calls of a helper terminal in `ws`: create, wait for `mark`, read 5 lines, close. */
const helperSteps = (
  ws: string,
  mark: string,
  text: string | ((recorded: string) => string),
  create = "terminals-create-cloud-gate",
  read = "terminals-read-cloud-gate-long",
): ReadonlyArray<Step> => {
  const where = ["--host", "cloud", "--workspace", ws, "--terminal", HELPER];
  const screen = (answer: unknown) => {
    const recorded = (answer as { readonly text: string }).text;
    return { ...(answer as object), text: typeof text === "string" ? text : text(recorded) };
  };
  return [
    { argv: argvIs("terminals", "create", "--host", "cloud", "--workspace", ws, "--command"), fixture: create, edit: (a) => ({ ...(a as object), terminalId: HELPER }) },
    { argv: ["terminals", "wait", ...where, "--match", mark, "--timeout", "30"], fixture: "terminals-wait-cloud-gate-pass" },
    { argv: ["terminals", "read", ...where, "--max-lines", "5"], fixture: read, edit: screen },
    { argv: ["terminals", "close", ...where], answer: { terminalId: HELPER, status: "disposed" } },
  ];
};

/** The host lookup's command for `path`: one `sh -c` line. */
const lookupCommand = (path: string): string =>
  `sh -c 'command -v lsof >/dev/null || exit 3; pids=$(pgrep -x '\\''claude'\\''); [ $? -le 1 ] || exit 3; ` +
  `printf '\\''W%s\\n'\\'' "$(cd '\\''${path}'\\'' 2>/dev/null && pwd -P)"; ` +
  `for p in $pids; do lsof -a -d cwd -p "$p" -Fn 2>/dev/null; done; echo FACTORY-LOOKUP-DONE'`;
/** What the host lookup prints: the resolved worktree, the `lsof` lines, the end mark. */
const lookupAnswer = (resolved: string, ...cwds: ReadonlyArray<string>): string =>
  [`W${resolved}`, ...cwds.flatMap((cwd) => ["p4242", "fcwd", cwd]), "FACTORY-LOOKUP-DONE", ""].join("\n");
const H11_FOLDER = "-Users-tomk--paradev-worktrees-factory-paradev-spike-fac-11-2";

/** What the liveness helper's screen shows with `count` agent processes. */
const aliveScreen = (count: number) =>
  `❯ pgrep -c 'claude'; echo FACTORY-ALIVE-''DONE\n${count}\nFACTORY-ALIVE-DONE\n❯ `;

/** The logs the body wrote, as `<level> <text>`. */
const logged = <A, E>(body: Effect.Effect<A, E, never>) =>
  Effect.gen(function* () {
    const logs: Array<string> = [];
    const capture = Logger.make(({ logLevel, message }) => {
      logs.push(`${logLevel} ${(Array.isArray(message) ? message : [message]).join(" ")}`);
    });
    const result = yield* body.pipe(Effect.provide(Logger.layer([capture], { mergeWithExisting: false })));
    return { logs, result };
  });

describe("every call carries the record's target", () => {
  it("only the one helper that maps a target to its flag writes --local", () => {
    const source = NodeFS.readFileSync(NodePath.join(import.meta.dirname, "sessions.ts"), "utf8");
    const lines = source.split("\n").filter((line) => line.includes('"--local"'));
    assert.strictEqual(lines.length, 1, lines.join("\n"));
    assert.include(lines[0], '["--local"] : ["--host"');
  });

  it.effect("a thread id naming another target than its record is ThreadNotFoundError", () =>
    Effect.gen(function* () {
      const t = rig([]);
      yield* seed(t.data, hostRecord());
      const error = yield* t.run((s) => s.status(`local:${H5_WS}`)).pipe(Effect.flip);
      assert.instanceOf(error, ThreadNotFoundError);
      assert.deepStrictEqual(t.calls, []);
    }),
  );
});

describe("launch on a host", () => {
  const hostScript = (r: ReturnType<typeof repos>, terminals: ReadonlyArray<unknown> = []): ReadonlyArray<Step> => [
    { argv: ["projects", "list", "--local"], fixture: "projects-list-local", edit: withProjectPath(r.clone) },
    {
      argv: ["projects", "list", "--host", HOST],
      answer: [
        { id: HOST_PROJECT, name: "factory-paradev-spike", path: `${HOST_CLONE}/`, repo: "https://github.com/original-solutions/factory-paradev-spike" },
      ],
    },
    { argv: argvIs("workspaces", "create"), fixture: "ws-create-host-5" },
    { argv: ["workspaces", "get", H5_WS, "--host", HOST], fixture: "ws-get-host", edit: (a) => ({ ...(a as object), id: H5_WS, branch: "fac/5-1", worktreePath: H5_PATH }) },
    { argv: ["snapshot", "--host", HOST, "--workspace", H5_WS], fixture: "snapshot-host-after-restart", edit: snapshotOf(H5_WS, terminals) },
    { argv: argvIs("agents", "create", "--host", HOST, "--workspace", H5_WS), fixture: "agents-create-host-resume" },
  ];
  const onHost = { place: () => Effect.succeed({ kind: "host", machineId: HOST, path: HOST_CLONE } as const), hosts: HOSTS };

  it.live("creates with --host <id> on the host's project, checks the host worktree's HEAD over SSH, and records a host: thread", () =>
    Effect.gen(function* () {
      const r = repos();
      const ssh = fakeSsh((command) => (command.includes("'rev-parse'") ? { tail: `${r.main}\n` } : { exitCode: 1 }));
      const t = rig(hostScript(r), { config: { remoteBase: r.remoteBase, ssh: ssh.runner, ...onHost } });
      const launched = yield* t.run((s) => s.launch(request()));
      assert.deepStrictEqual(launched, { threadId: `host:${HOST}:${H5_WS}`, worktreePath: H5_PATH, branch: "fac/5-1" });
      assert.deepStrictEqual(t.unused(), []);
      assert.deepStrictEqual(t.calls.find(argvIs("workspaces", "create")), [
        "workspaces", "create", "--host", HOST, "--project", HOST_PROJECT, "--name", "fac #1 multiply",
        "--branch", "fac/1-1", "--skip-branch-prefix", "--base-branch", "main", "--tag", "factory",
      ]);
      assert.deepStrictEqual(t.calls.find(argvIs("agents", "create")), [
        "agents", "create", "--host", HOST, "--workspace", H5_WS, "--agent", "claude",
        "--model", "opus", "--effort", "high", "--prompt", "/factory original-solutions/factory-paradev-spike#1",
      ]);
      // The HEAD is the base fetched on this Mac: nothing is fetched or reset on the host.
      assert.deepStrictEqual(ssh.calls, [[HOST_SSH, `'git' '-C' '${H5_PATH}' 'rev-parse' '--verify' 'HEAD^{commit}'`]]);
      const saved = yield* readThread(t.data, H5_WS).pipe(Effect.provide(NodeServices.layer));
      assert.deepInclude(saved, {
        threadId: `host:${HOST}:${H5_WS}`,
        target: { kind: "host", machineId: HOST, name: "trilogy-mac" },
        projectId: HOST_PROJECT,
        branch: "fac/5-1",
        worktreePath: H5_PATH,
        terminals: [H11_RESUMED],
      });
      assert.strictEqual(
        yield* readLaunch(t.data, LAUNCH_ID).pipe(Effect.provide(NodeServices.layer)),
        `host:${HOST}:${H5_WS}`,
      );
    }),
  );

  it.live("resets a host worktree off the base over SSH, after the snapshot shows no agent and before the agent starts", () =>
    Effect.gen(function* () {
      const r = repos();
      const seen: Array<string> = [];
      const ssh = fakeSsh((command) =>
        command.includes("'rev-parse'")
          ? { tail: `${"0".repeat(40)}\n` }
          : command.includes("'symbolic-ref'")
            ? { tail: "refs/heads/fac/5-1\n" }
            : {},
      );
      const script = hostScript(r).map((step) =>
        typeof step.argv === "function" && step.argv(["agents", "create", "--host", HOST, "--workspace", H5_WS])
          ? { ...step, edit: (a: unknown) => (seen.push(`agents create after ${ssh.calls.length} ssh calls`), a) }
          : Array.isArray(step.argv) && step.argv[0] === "snapshot"
            ? { ...step, edit: (a: unknown) => (seen.push(`snapshot after ${ssh.calls.length} ssh calls`), snapshotOf(H5_WS, [])(a)) }
            : step,
      );
      const t = rig(script, { config: { remoteBase: r.remoteBase, ssh: ssh.runner, ...onHost } });
      yield* t.run((s) => s.launch(request()));
      const commands = ssh.calls.map(([, command]) => command);
      assert.deepStrictEqual(commands.slice(4), [
        `'git' '-C' '${H5_PATH}' 'fetch' '--quiet' 'origin' 'main'`,
        `'git' '-c' 'submodule.recurse=false' '-C' '${H5_PATH}' 'reset' '--hard' '--no-recurse-submodules' '-q' '${r.main}'`,
      ]);
      assert.deepStrictEqual(seen, ["snapshot after 4 ssh calls", "agents create after 6 ssh calls"]);
      assert.isTrue(ssh.calls.every(([destination]) => destination === HOST_SSH));
    }),
  );

  it.live("takes an agent of the preset already in the host worktree and resets nothing", () =>
    Effect.gen(function* () {
      const r = repos();
      const ssh = fakeSsh((command) => (command.includes("'rev-parse'") ? { tail: `${"0".repeat(40)}\n` } : {}));
      const t = rig(hostScript(r, readSnapshotTerminals("snapshot-host-after-restart")).slice(0, -1), {
        config: { remoteBase: r.remoteBase, ssh: ssh.runner, ...onHost },
      });
      const launched = yield* t.run((s) => s.launch(request()));
      assert.strictEqual(launched.threadId, `host:${HOST}:${H5_WS}`);
      assert.isFalse(t.calls.some(argvIs("agents", "create")));
      assert.isFalse(ssh.calls.some(([, command]) => command.includes("'reset'") || command.includes("'fetch'")));
      const saved = yield* readThread(t.data, H5_WS).pipe(Effect.provide(NodeServices.layer));
      assert.deepStrictEqual(saved!.terminals, [H5_TERM]);
    }),
  );

  it.live("a host that is not in the config's hosts fails before anything is created", () =>
    Effect.gen(function* () {
      const r = repos();
      const t = rig(hostScript(r).slice(0, 1), {
        config: { remoteBase: r.remoteBase, ssh: fakeSsh(() => ({})).runner, ...onHost, hosts: [] },
      });
      const error = yield* t.run((s) => s.launch(request())).pipe(Effect.flip);
      assert.include(String(error.cause), `host ${HOST} is not in the config's hosts`);
      assert.isFalse(t.calls.some(argvIs("workspaces", "create")));
    }),
  );
});

/** The terminals a recorded snapshot shows in its one workspace. */
function readSnapshotTerminals(fixture: string): ReadonlyArray<unknown> {
  const answer = JSON.parse(readFixture(fixture).stdout) as { readonly workspaces: ReadonlyArray<{ readonly terminals: ReadonlyArray<unknown> }> };
  return answer.workspaces[0]!.terminals;
}

describe("launch in the cloud", () => {
  const onCloud = {
    place: () => Effect.succeed({ kind: "cloud", environmentId: ENV, machineSize: "small" } as const),
    cloudReadyPollMs: 1,
  };
  const createArgv = [
    "workspaces", "create", "--host", "cloud", "--environment", ENV, "--machine-size", "small",
    "--name", "fac/1-1", "--base-branch", "main", "--tag", "factory",
  ];
  const getArgv = ["workspaces", "get", C3_WS, "--host", "cloud"];

  it.live("creates with no --branch or --agent, records before the ready poll, starts the agent once ready, keeps Paradev's branch", () =>
    Effect.gen(function* () {
      const recordedFirst: Array<string> = [];
      const t: Rig = rig(
        [
          { argv: createArgv, fixture: "ws-create-cloud" },
          {
            argv: getArgv,
            fixture: "ws-get-cloud-provisioning",
            edit: (answer) => {
              const thread = NodePath.join(t.data, "paradev", "threads", `${C3_WS}.json`);
              const launchDir = NodePath.join(t.data, "paradev", "launches");
              recordedFirst.push(`record ${NodeFS.existsSync(thread)}, launch file ${NodeFS.existsSync(launchDir) && NodeFS.readdirSync(launchDir).length === 1}`);
              return answer;
            },
          },
          { argv: getArgv, fixture: "ws-get-cloud-ready" },
          { argv: argvIs("agents", "create", "--host", "cloud"), fixture: "agents-create-cloud-resume" },
        ],
        { config: onCloud },
      );
      const launched = yield* t.run((s) => s.launch(request()));
      assert.deepStrictEqual(launched, { threadId: `cloud:${C3_WS}`, worktreePath: "/workspace", branch: C3_BRANCH });
      assert.deepStrictEqual(t.unused(), []);
      assert.deepStrictEqual(recordedFirst, ["record true, launch file true"]);
      assert.deepStrictEqual(t.calls.at(-1), [
        "agents", "create", "--host", "cloud", "--workspace", C3_WS, "--agent", "claude",
        "--model", "opus", "--effort", "high", "--prompt", "/factory original-solutions/factory-paradev-spike#1",
      ]);
      // No base fetch and no git at all: Paradev cuts the branch on GitHub.
      assert.deepStrictEqual(t.gitCalls, []);
      const saved = yield* readThread(t.data, C3_WS).pipe(Effect.provide(NodeServices.layer));
      assert.deepInclude(saved, {
        threadId: `cloud:${C3_WS}`,
        target: { kind: "cloud", environmentId: ENV },
        projectId: ENV,
        branch: C3_BRANCH,
        worktreePath: "/workspace",
        terminals: [C6_RESUMED],
        archivedAt: null,
      });
      assert.strictEqual(yield* readLaunch(t.data, LAUNCH_ID).pipe(Effect.provide(NodeServices.layer)), `cloud:${C3_WS}`);
    }),
  );

  it.live("a workspace not ready in time is archived and the launch fails, with no agent started", () =>
    Effect.gen(function* () {
      const t = rig(
        [
          { argv: createArgv, fixture: "ws-create-cloud" },
          { argv: getArgv, fixture: "ws-get-cloud-provisioning" },
          { argv: ["workspaces", "archive", C3_WS, "--host", "cloud"], fixture: "ws-archive-cloud" },
        ],
        { config: { ...onCloud, cloudReadyMaxMs: 0 } },
      );
      const error = yield* t.run((s) => s.launch(request())).pipe(Effect.flip);
      assert.strictEqual(error.operation, "launch");
      assert.include(String(error.cause), "was not ready within 0 s (still provisioning); the workspace was archived");
      assert.deepStrictEqual(t.unused(), []);
      const saved = yield* readThread(t.data, C3_WS).pipe(Effect.provide(NodeServices.layer));
      assert.isNotNull(saved!.archivedAt);
      assert.deepStrictEqual(saved!.terminals, []);
    }),
  );

  it.live("a create that cannot connect is not tried again, and nothing is recorded", () =>
    Effect.gen(function* () {
      const t = rig([{ argv: createArgv, fail: "Could not connect to API" }], { config: onCloud });
      yield* t.run((s) => s.launch(request())).pipe(Effect.flip);
      assert.strictEqual(t.calls.length, 1);
      assert.isNull(yield* readLaunch(t.data, LAUNCH_ID).pipe(Effect.provide(NodeServices.layer)));
    }),
  );

  it.live("a retry after the record waits for ready and takes the agent an earlier attempt started, with no create", () =>
    Effect.gen(function* () {
      const t = rig(
        [
          { argv: getArgv, fixture: "ws-get-cloud-ready" },
          recorded("snapshot-cloud"),
        ],
        { config: { place: () => Effect.die("placed again") } },
      );
      yield* seed(t.data, cloudRecord({ terminals: [], turns: [] }));
      yield* writeLaunch(t.data, LAUNCH_ID, `cloud:${C3_WS}`).pipe(Effect.provide(NodeServices.layer));
      const launched = yield* t.run((s) => s.launch(request()));
      assert.strictEqual(launched.threadId, `cloud:${C3_WS}`);
      assert.deepStrictEqual(t.unused(), []);
      const saved = yield* readThread(t.data, C3_WS).pipe(Effect.provide(NodeServices.layer));
      assert.deepStrictEqual(saved!.terminals, [C3_TERM]);
    }),
  );
});

describe("status on a host", () => {
  const trustRecord = hostRecord({ threadId: `host:${HOST}:${HT_WS}`, workspaceId: HT_WS, terminals: [HT_TERM] });
  const screenArgv = ["terminals", "read", "--host", HOST, "--workspace", HT_WS, "--terminal", HT_TERM, "--max-lines", "40"];
  const attachedAt = lastEventAt("agents-explain-host-working");

  it.effect("starting at Attached for over 5 minutes with the trust dialog on screen fails, and the screen is read once", () =>
    Effect.gen(function* () {
      const t = rig([
        recorded("agents-explain-host-working"),
        { argv: screenArgv, fixture: "terminals-read-host-starting" },
        recorded("agents-explain-host-working"),
      ]);
      yield* seed(t.data, trustRecord);
      yield* TestClock.setTime(attachedAt + 6 * MINUTE);
      // One adapter for both reads: what it read of the screen is kept in it.
      const errors = yield* t.run((s) =>
        Effect.all([s.status(trustRecord.threadId).pipe(Effect.flip), s.status(trustRecord.threadId).pipe(Effect.flip)]),
      );
      for (const error of errors) {
        assert.instanceOf(error, SessionsError);
        assert.strictEqual((error as SessionsError).operation, "status");
        assert.strictEqual(
          ((error as SessionsError).cause as Error).message,
          "the host's clone is not trusted by Claude Code; run factory-runner hosts check trilogy-mac",
        );
      }
      assert.deepStrictEqual(t.unused(), []);
      assert.isFalse(t.calls.some(argvIs("terminals", "send")));
    }),
  );

  it.effect("starting at Attached within 5 minutes is starting, with no screen read", () =>
    Effect.gen(function* () {
      const t = rig([recorded("agents-explain-host-working")]);
      yield* seed(t.data, trustRecord);
      yield* TestClock.setTime(attachedAt + 4 * MINUTE);
      assert.strictEqual((yield* t.run((s) => s.status(trustRecord.threadId))).run, "starting");
    }),
  );

  it.effect("a screen with no trust dialog is starting, and is not read again", () =>
    Effect.gen(function* () {
      const t = rig([
        recorded("agents-explain-host-working"),
        { argv: screenArgv, fixture: "terminals-read-host-starting", edit: (a) => ({ ...(a as object), text: "❯ " }) },
        recorded("agents-explain-host-working"),
      ]);
      yield* seed(t.data, trustRecord);
      yield* TestClock.setTime(attachedAt + 6 * MINUTE);
      const both = yield* t.run((s) => Effect.all([s.status(trustRecord.threadId), s.status(trustRecord.threadId)]));
      assert.deepStrictEqual(both.map((status) => status.run), ["starting", "starting"]);
      assert.deepStrictEqual(t.unused(), []);
    }),
  );

  it.effect("idle after Failed is failed, with the proxy's error text as the last assistant message", () =>
    Effect.gen(function* () {
      const t = rig([recorded("agents-explain-host-proxy-401"), recorded("agents-read-host-proxy")]);
      const proxied = hostRecord({ threadId: `host:${HOST}:${H11_WS}`, workspaceId: H11_WS, terminals: [H11_DEAD] });
      yield* seed(t.data, proxied);
      const status = yield* t.run((s) => s.status(proxied.threadId));
      assert.strictEqual(status.run, "failed");
      assert.strictEqual(status.runCompletedAt, lastEventAt("agents-explain-host-proxy-401"));
      assert.strictEqual(status.lastAssistantMessage, 'Please run /login · API Error: 401 {"error":"Invalid API key"}');
    }),
  );

  it.effect("exited is interrupted", () =>
    Effect.gen(function* () {
      const t = rig([recorded("agents-explain-host-working-2"), { argv: argvIs("agents", "read"), answer: { text: "" } }]);
      yield* seed(t.data, trustRecord);
      assert.strictEqual((yield* t.run((s) => s.status(trustRecord.threadId))).run, "interrupted");
      assert.deepStrictEqual(t.calls[1], ["agents", "read", "--host", HOST, "--workspace", HT_WS, "--terminal", HT_TERM]);
    }),
  );

  const silent = (answer: Partial<RunResult> | "unreachable") =>
    Effect.gen(function* () {
      const ssh = fakeSsh(() => answer);
      const t = rig(
        [recorded("agents-explain-host-5-working"), { argv: argvIs("agents", "read"), answer: { text: "" } }],
        { config: { ssh: ssh.runner, hosts: HOSTS } },
      );
      yield* seed(t.data, hostRecord());
      yield* TestClock.setTime(lastEventAt("agents-explain-host-5-working") + 11 * MINUTE);
      const status = yield* t.run((s) => s.status(`host:${HOST}:${H5_WS}`));
      return { run: status.run, ssh: ssh.calls, lookups: t.lookups };
    });

  it.effect("working with no hook for 10 minutes looks for the agent process on the host over SSH, in sh", () =>
    Effect.gen(function* () {
      const found = yield* silent({ tail: lookupAnswer(H5_PATH, `n${H5_PATH}`) });
      assert.strictEqual(found.run, "running");
      assert.deepStrictEqual(found.ssh, [[HOST_SSH, lookupCommand(H5_PATH)]]);
      assert.deepStrictEqual(found.lookups, []);
      assert.strictEqual((yield* silent({ tail: lookupAnswer(H5_PATH, `n${H5_PATH}-other`) })).run, "interrupted");
    }),
  );

  it.effect("an agent whose working directory is the worktree as the host resolves it is running", () =>
    Effect.gen(function* () {
      const resolved = `/System/Volumes/Data${H5_PATH}`;
      assert.strictEqual((yield* silent({ tail: lookupAnswer(resolved, `n${resolved}`) })).run, "running");
    }),
  );

  it.effect("a lookup that SSH cannot reach, that exits non-zero, or that does not finish keeps the run running", () =>
    Effect.gen(function* () {
      assert.strictEqual((yield* silent("unreachable")).run, "running");
      const { logs, result } = yield* logged(silent({ exitCode: 3, tail: "" }));
      assert.strictEqual(result.run, "running");
      assert.isTrue(logs.some((line) => line.startsWith("Warn ") && line.includes("did not finish (exit 3)")), logs.join("\n"));
      assert.strictEqual((yield* silent({ tail: `W${H5_PATH}\n` })).run, "running");
    }),
  );
});

describe("status in the cloud (the liveness check through a helper terminal)", () => {
  const workingAt = lastEventAt("agents-explain-cloud-working");
  const readCloud = recorded("agents-read-cloud");

  it.effect("working with no hook for 10 minutes and no agent process is interrupted; the next look waits 10 minutes", () =>
    Effect.gen(function* () {
      const t = rig([
        recorded("agents-explain-cloud-working"),
        ...helperSteps(C3_WS, "FACTORY-ALIVE-DONE", aliveScreen(0)),
        readCloud,
        recorded("agents-explain-cloud-working"),
        readCloud,
        recorded("agents-explain-cloud-working"),
        ...helperSteps(C3_WS, "FACTORY-ALIVE-DONE", aliveScreen(1)),
      ]);
      yield* seed(t.data, cloudRecord());
      yield* TestClock.setTime(workingAt + 11 * MINUTE);
      // One adapter for every read: the time of its last look is kept in it.
      yield* t.run((s) =>
        Effect.gen(function* () {
          assert.strictEqual((yield* s.status(`cloud:${C3_WS}`)).run, "interrupted");
          assert.strictEqual(
            flag(t.calls.find(argvIs("terminals", "create")), "--command"),
            "pgrep -c 'claude'; echo FACTORY-ALIVE-''DONE",
          );
          // Within 10 minutes of the look: no second helper terminal.
          yield* TestClock.setTime(workingAt + 20 * MINUTE);
          assert.strictEqual((yield* s.status(`cloud:${C3_WS}`)).run, "interrupted");
          assert.strictEqual(t.calls.filter(argvIs("terminals", "create")).length, 1);
          yield* TestClock.setTime(workingAt + 22 * MINUTE);
          assert.strictEqual((yield* s.status(`cloud:${C3_WS}`)).run, "running");
        }),
      );
      assert.deepStrictEqual(t.unused(), []);
      assert.deepStrictEqual(t.lookups, []);
    }),
  );

  it.effect("a helper read that shows no count keeps the run running, and the terminal is still closed", () =>
    Effect.gen(function* () {
      const t = rig([
        recorded("agents-explain-cloud-working"),
        ...helperSteps(C3_WS, "FACTORY-ALIVE-DONE", "❯ pgrep -c 'claude'; echo FACTORY-ALIVE-''DONE\n"),
      ]);
      yield* seed(t.data, cloudRecord());
      yield* TestClock.setTime(workingAt + 11 * MINUTE);
      assert.strictEqual((yield* t.run((s) => s.status(`cloud:${C3_WS}`))).run, "running");
      assert.deepStrictEqual(t.unused(), []);
    }),
  );
});

describe("resume on a host and in the cloud", () => {
  const RESUME_TEXT = readFixture("agents-create-host-resume").argv.at(-1)!;

  it.live("a host's dead agent: its terminal closed, the session id read over SSH with ls -t, then agents create --resume-session", () =>
    Effect.gen(function* () {
      const ssh = fakeSsh((command) =>
        command.includes("ls -t ")
          ? { tail: `/Users/tomk/.claude/projects/${H11_FOLDER}/8b68fab9-97bd-4a02-b4a7-ea4dd1e14556.jsonl\n` }
          : { tail: lookupAnswer(H11_PATH) },
      );
      const t = rig(
        [
          {
            argv: ["snapshot", "--host", HOST, "--workspace", H11_WS],
            fixture: "snapshot-host-after-close",
            edit: snapshotOf(H11_WS, [{ id: H11_DEAD, title: null, agent: { id: "claude", state: "idle" } }]),
          },
          recorded("agents-explain-host-proxy-401"),
          recorded("terminals-close-host-proxy-failed"),
          recorded("agents-create-host-resume"),
          recorded("agents-explain-host-resume-idle"),
          recorded("agents-read-host-resume"),
        ],
        { config: { ssh: ssh.runner, hosts: HOSTS } },
      );
      const dead = hostRecord({
        threadId: `host:${HOST}:${H11_WS}`, workspaceId: H11_WS, branch: "fac/11-2", worktreePath: H11_PATH, terminals: [H11_DEAD],
      });
      yield* seed(t.data, dead);
      yield* t.run((s) => s.send(dead.threadId, SEND_ID, RESUME_TEXT));
      assert.deepStrictEqual(ssh.calls.map(([, command]) => command), [
        lookupCommand(H11_PATH),
        `sh -c 'ls -t $HOME/.claude/projects/${H11_FOLDER}/*.jsonl 2>/dev/null | head -1'`,
      ]);
      const status = yield* t.run((s) => s.status(dead.threadId));
      assert.strictEqual(status.run, "completed");
      assert.isTrue(status.lastAssistantMessage!.endsWith("FACTORY-STOP: needs-info"));
      assert.deepStrictEqual(t.unused(), []);
      const after = yield* readThread(t.data, H11_WS).pipe(Effect.provide(NodeServices.layer));
      assert.deepStrictEqual(after!.terminals, [H11_DEAD, H11_RESUMED]);
      assert.strictEqual(after!.turns.at(-1)!.kind, "resume");
    }),
  );

  it.live("a host session folder with no session is ThreadNotFoundError, and nothing is created", () =>
    Effect.gen(function* () {
      const ssh = fakeSsh(() => ({ tail: "" }));
      const t = rig(
        [{ argv: ["snapshot", "--host", HOST, "--workspace", H11_WS], fixture: "snapshot-host-after-close" }],
        { config: { ssh: ssh.runner, hosts: HOSTS } },
      );
      const dead = hostRecord({ threadId: `host:${HOST}:${H11_WS}`, workspaceId: H11_WS, worktreePath: H11_PATH, terminals: [H11_DEAD] });
      yield* seed(t.data, dead);
      const error = yield* t.run((s) => s.send(dead.threadId, SEND_ID, RESUME_TEXT)).pipe(Effect.flip);
      assert.instanceOf(error, ThreadNotFoundError);
      assert.isFalse(t.calls.some(argvIs("agents", "create")));
    }),
  );

  it.live("a cloud agent the helper counts dead: its terminal closed, the session id read through a helper terminal, then resumed", () =>
    Effect.gen(function* () {
      const where = ["--host", "cloud", "--workspace", C6_WS];
      const sessionLine = `${"/home/ubuntu/.claude/projects/-workspace"}/${C6_SESSION}.jsonl`;
      const cloudText = readFixture("agents-create-cloud-resume").argv.at(-1)!;
      const t = rig([
        {
          argv: ["snapshot", ...where],
          fixture: "snapshot-cloud",
          edit: snapshotOf(C6_WS, [{ id: C6_DEAD, title: "◑ Claude Code", agent: { id: "claude", state: "working" } }]),
        },
        { argv: ["agents", "explain", ...where, "--terminal", C6_DEAD], fixture: "agents-explain-cloud-working" },
        ...helperSteps(C6_WS, "FACTORY-ALIVE-DONE", aliveScreen(0)),
        { argv: ["terminals", "close", ...where, "--terminal", C6_DEAD], answer: { terminalId: C6_DEAD, status: "disposed" } },
        ...helperSteps(
          C6_WS,
          "FACTORY-SESSION-DONE",
          // The recorded listing's session line, under this helper's command and end mark.
          (recorded) => {
            const line = recorded.split("\n").find((l) => l.startsWith("/home/ubuntu/.claude/projects/-workspace/"))!;
            assert.strictEqual(line, sessionLine);
            return `❯ ls -t /home/ubuntu/.claude/projects/-workspace/*.jsonl | head -1; echo FACTORY-SESSION-''DONE\n${line}\nFACTORY-SESSION-DONE\n❯ `;
          },
          "terminals-create-cloud-6-sessions",
          "terminals-read-cloud-6-sessions",
        ),
        recorded("agents-create-cloud-resume"),
      ]);
      const dead = cloudRecord({ threadId: `cloud:${C6_WS}`, workspaceId: C6_WS, branch: "superset/fac-6-range-b4b0e881", terminals: [C6_DEAD] });
      yield* seed(t.data, dead);
      yield* t.run((s) => s.send(dead.threadId, SEND_ID, cloudText));
      assert.deepStrictEqual(t.unused(), []);
      assert.strictEqual(
        flag(t.calls.filter(argvIs("terminals", "create"))[1], "--command"),
        "ls -t /home/ubuntu/.claude/projects/-workspace/*.jsonl | head -1; echo FACTORY-SESSION-''DONE",
      );
      const after = yield* readThread(t.data, C6_WS).pipe(Effect.provide(NodeServices.layer));
      assert.deepStrictEqual(after!.terminals, [C6_DEAD, C6_RESUMED]);
      assert.isFalse(t.calls.some(argvIs("terminals", "send")));
    }),
  );
});

describe("archive, removeWorktree and showGateLog off this Mac", () => {
  const c6 = cloudRecord({ threadId: `cloud:${C6_WS}`, workspaceId: C6_WS, branch: "superset/fac-6-range-b4b0e881" });
  const saved = (data: string) => readThread(data, C6_WS).pipe(Effect.provide(NodeServices.layer));

  it.live("archives a cloud workspace with --host cloud", () =>
    Effect.gen(function* () {
      const t = rig([recorded("ws-archive-cloud-6")]);
      yield* seed(t.data, c6);
      yield* t.run((s) => s.archive(c6.threadId));
      assert.isNotNull((yield* saved(t.data))!.archivedAt);
    }),
  );

  it.live("a cloud archive that answers failed is archived when a later workspaces get reads deleted", () =>
    Effect.gen(function* () {
      const t = rig([
        { argv: readFixture("ws-archive-cloud-6").argv, answer: { deleted: [], notFound: [], failed: [{ id: C6_WS }], warnings: [] } },
        recorded("ws-get-cloud-6-archived"),
      ]);
      yield* seed(t.data, c6);
      yield* t.run((s) => s.archive(c6.threadId));
      assert.isNotNull((yield* saved(t.data))!.archivedAt);
      assert.deepStrictEqual(t.unused(), []);
    }),
  );

  it.live("thread reads a cloud workspace that workspaces get says is deleted as archived", () =>
    Effect.gen(function* () {
      const t = rig([recorded("ws-get-cloud-6-archived")]);
      yield* seed(t.data, c6);
      assert.deepStrictEqual(yield* t.run((s) => s.thread(c6.threadId)), {
        worktreePath: "/workspace",
        branch: "superset/fac-6-range-b4b0e881",
        archived: true,
      });
    }),
  );

  it.live("thread reads a ready cloud workspace's branch, and its worktree from the record", () =>
    Effect.gen(function* () {
      const t = rig([{ argv: ["workspaces", "get", C3_WS, "--host", "cloud"], fixture: "ws-get-cloud-ready" }]);
      yield* seed(t.data, cloudRecord());
      assert.deepStrictEqual(yield* t.run((s) => s.thread(`cloud:${C3_WS}`)), {
        worktreePath: "/workspace",
        branch: C3_BRANCH,
        archived: false,
      });
    }),
  );

  it.live("removeWorktree is a no-op for a host's and a cloud sandbox's worktree", () =>
    Effect.gen(function* () {
      for (const over of [{ target: hostRecord().target }, { target: cloudRecord().target }]) {
        const t = rig([]);
        const r = repos();
        r.addWorktree("fac/1-1", "main");
        yield* seed(t.data, record({ ...over, worktreePath: r.worktree }));
        yield* t.run((s) => s.removeWorktree(r.worktree));
        assert.isTrue(NodeFS.existsSync(NodePath.join(r.worktree, ".git")));
        assert.deepStrictEqual(t.gitCalls, []);
      }
    }),
  );

  it.live("showGateLog is a no-op with one log line for a host and for the cloud", () =>
    Effect.gen(function* () {
      for (const seeded of [hostRecord(), cloudRecord()]) {
        const t = rig([]);
        yield* seed(t.data, seeded);
        const { logs } = yield* logged(t.run((s) => s.showGateLog(seeded.threadId, 1, "/data/gate.log")));
        assert.strictEqual(logs.length, 1, logs.join("\n"));
        assert.include(logs[0], "stays on this Mac, at /data/gate.log");
        assert.deepStrictEqual(t.calls, []);
      }
    }),
  );
});

describe("the orphan sweep", () => {
  const NOW = Date.parse("2026-11-13T12:00:00.000Z");
  const ago = (ms: number) => new Date(NOW - ms).toISOString();
  const OBJECT_TAG = "f1e2d3c4-0000-4000-8000-000000000001";
  const NO_AGENT = "c1e2d3c4-0000-4000-8000-000000000005";
  const TORN = "b1e2d3c4-0000-4000-8000-000000000006";
  const listArgv = ["workspaces", "list", "--host", "cloud"];
  /** The recorded row, as each case of the sweep: only C6 and OBJECT_TAG are orphans. */
  const rows = (answer: unknown) => {
    const [row] = answer as ReadonlyArray<Record<string, unknown>>;
    const tagged = { ...row, tags: ["factory"], createdAt: ago(60 * MINUTE) };
    return [
      { ...tagged, id: C6_WS, name: "fac/6-1", createdAt: ago(11 * MINUTE) },
      { ...tagged, id: C3_WS }, // a live run's record
      { ...tagged, id: NO_AGENT }, // a record whose agent never started: still the core's
      { ...tagged, id: TORN }, // a record file that does not read back
      { ...tagged, id: "d1e2d3c4-0000-4000-8000-000000000002", tags: [] },
      { ...tagged, id: "e1e2d3c4-0000-4000-8000-000000000003", createdAt: ago(9 * MINUTE) },
      { ...tagged, id: "a1e2d3c4-0000-4000-8000-000000000004", status: "deleted" },
      { ...tagged, id: OBJECT_TAG, tags: [{ name: "factory" }] },
    ];
  };
  const seedSweep = (data: string) =>
    Effect.gen(function* () {
      yield* seed(data, cloudRecord(), cloudRecord({ threadId: `cloud:${NO_AGENT}`, workspaceId: NO_AGENT, terminals: [], turns: [] }));
      NodeFS.writeFileSync(NodePath.join(data, "paradev", "threads", `${TORN}.json`), '{"v":2,"thre');
    });

  it.effect("archives each cloud workspace tagged factory, with no thread record, created over 10 minutes ago, one line each", () =>
    Effect.gen(function* () {
      const t = rig([
        { argv: listArgv, fixture: "ws-list-noflag-after-cloud", edit: rows },
        recorded("ws-archive-cloud-6"),
        { argv: ["workspaces", "archive", OBJECT_TAG, "--host", "cloud"], answer: { deleted: [OBJECT_TAG], notFound: [], failed: [], warnings: [] } },
      ]);
      yield* seedSweep(t.data);
      yield* TestClock.setTime(NOW);
      const { logs } = yield* logged(t.run((s) => s.sweepOrphans));
      assert.deepStrictEqual(t.unused(), []);
      assert.strictEqual(t.calls.length, 3);
      assert.strictEqual(logs.length, 2, logs.join("\n"));
      assert.include(logs[0], `archived cloud workspace ${C6_WS} (fac/6-1)`);
      assert.include(logs[1], `archived cloud workspace ${OBJECT_TAG}`);
      const untouched = yield* readThread(t.data, NO_AGENT).pipe(Effect.provide(NodeServices.layer));
      assert.isNull(untouched!.archivedAt);
    }),
  );

  it.effect("an orphan that fails to archive is one warning, and the next is still archived", () =>
    Effect.gen(function* () {
      const t = rig([
        { argv: listArgv, fixture: "ws-list-noflag-after-cloud", edit: rows },
        { argv: readFixture("ws-archive-cloud-6").argv, fail: "Workspace is busy" },
        { argv: ["workspaces", "archive", OBJECT_TAG, "--host", "cloud"], answer: { deleted: [OBJECT_TAG], notFound: [], failed: [], warnings: [] } },
      ]);
      yield* seedSweep(t.data);
      yield* TestClock.setTime(NOW);
      const { logs } = yield* logged(t.run((s) => s.sweepOrphans));
      assert.deepStrictEqual(t.unused(), []);
      assert.strictEqual(logs.length, 2, logs.join("\n"));
      assert.match(logs[0]!, /^Warn could not archive the orphaned cloud workspace /);
    }),
  );
});

describe("cycle 1: liveness a send can trust, and what a failed cloud launch leaves", () => {
  const workingAt = lastEventAt("agents-explain-cloud-working");

  it.effect("a cloud send reads liveness afresh, not from status's look: an agent dead since is resumed, and nothing is typed", () =>
    Effect.gen(function* () {
      const where = ["--host", "cloud", "--workspace", C3_WS];
      const cloudText = readFixture("agents-create-cloud-resume").argv.at(-1)!;
      const session = `/home/ubuntu/.claude/projects/-workspace/${C6_SESSION}.jsonl`;
      const t = rig([
        recorded("agents-explain-cloud-working"),
        ...helperSteps(C3_WS, "FACTORY-ALIVE-DONE", aliveScreen(1)),
        recorded("snapshot-cloud"),
        recorded("agents-explain-cloud-working"),
        ...helperSteps(C3_WS, "FACTORY-ALIVE-DONE", aliveScreen(0)),
        { argv: ["terminals", "close", ...where, "--terminal", C3_TERM], answer: { terminalId: C3_TERM, status: "disposed" } },
        ...helperSteps(C3_WS, "FACTORY-SESSION-DONE", `${session}\nFACTORY-SESSION-DONE\n❯ `, "terminals-create-cloud-6-sessions"),
        { argv: ["agents", "create", ...where, "--agent", "claude", "--resume-session", C6_SESSION, "--prompt", cloudText], fixture: "agents-create-cloud-resume" },
        { argv: ["agents", "explain", ...where, "--terminal", C6_RESUMED], fixture: "agents-explain-cloud-working" },
        ...helperSteps(C3_WS, "FACTORY-ALIVE-DONE", aliveScreen(1)),
      ]);
      yield* seed(t.data, cloudRecord());
      yield* TestClock.setTime(workingAt + 11 * MINUTE);
      yield* t.run((s) =>
        Effect.gen(function* () {
          assert.strictEqual((yield* s.status(`cloud:${C3_WS}`)).run, "running");
          yield* TestClock.adjust(2 * MINUTE);
          yield* s.send(`cloud:${C3_WS}`, SEND_ID, cloudText);
          // The new terminal's first silent look is its own: the dead terminal's 0 does not answer it.
          yield* TestClock.adjust(MINUTE);
          assert.strictEqual((yield* s.status(`cloud:${C3_WS}`)).run, "running");
        }),
      );
      assert.deepStrictEqual(t.unused(), []);
      assert.isFalse(t.calls.some(argvIs("terminals", "send")));
      const after = yield* readThread(t.data, C3_WS).pipe(Effect.provide(NodeServices.layer));
      assert.deepStrictEqual(after!.terminals, [C3_TERM, C6_RESUMED]);
    }),
  );

  it.effect("a cloud send whose fresh liveness read fails types nothing and closes nothing", () =>
    Effect.gen(function* () {
      const where = ["--host", "cloud", "--workspace", C3_WS, "--terminal", HELPER];
      const t = rig([
        recorded("snapshot-cloud"),
        recorded("agents-explain-cloud-working"),
        { argv: argvIs("terminals", "create", "--host", "cloud"), fixture: "terminals-create-cloud-gate" },
        { argv: argvIs("terminals", "wait"), fail: "Timed out waiting for a match" },
        { argv: ["terminals", "close", ...where], answer: { terminalId: HELPER, status: "disposed" } },
      ]);
      yield* seed(t.data, cloudRecord());
      yield* TestClock.setTime(workingAt + 11 * MINUTE);
      const { logs, result } = yield* logged(t.run((s) => s.send(`cloud:${C3_WS}`, SEND_ID, "text").pipe(Effect.flip)));
      assert.include(String((result as SessionsError).cause), "could not be read; nothing was typed");
      assert.deepStrictEqual(t.unused(), []);
      assert.isFalse(t.calls.some((argv) => argvIs("terminals", "send")(argv) || argvIs("agents", "create")(argv)));
      assert.isTrue(logs.some((line) => line.startsWith("Warn could not read whether")), logs.join("\n"));
    }),
  );

  it.effect("a helper terminal whose wait fails is still closed, and the run stays running", () =>
    Effect.gen(function* () {
      const t = rig([
        recorded("agents-explain-cloud-working"),
        { argv: argvIs("terminals", "create", "--host", "cloud"), fixture: "terminals-create-cloud-gate" },
        { argv: argvIs("terminals", "wait"), fail: "Timed out waiting for a match" },
        { argv: ["terminals", "close", "--host", "cloud", "--workspace", C3_WS, "--terminal", HELPER], answer: { terminalId: HELPER, status: "disposed" } },
      ]);
      yield* seed(t.data, cloudRecord());
      yield* TestClock.setTime(workingAt + 11 * MINUTE);
      assert.strictEqual((yield* t.run((s) => s.status(`cloud:${C3_WS}`))).run, "running");
      assert.deepStrictEqual(t.unused(), []);
    }),
  );

  it.live("a host send whose lookup does not finish types nothing, closes nothing and starts nothing", () =>
    Effect.gen(function* () {
      const ssh = fakeSsh(() => ({ exitCode: 3, tail: "" }));
      const t = rig([recorded("snapshot-host-after-restart"), recorded("agents-explain-host-5-working")], {
        config: { ssh: ssh.runner, hosts: HOSTS },
      });
      yield* seed(t.data, hostRecord());
      const error = yield* t.run((s) => s.send(`host:${HOST}:${H5_WS}`, SEND_ID, "text")).pipe(Effect.flip);
      assert.include(String((error as SessionsError).cause), "could not be read; nothing was typed");
      assert.isFalse(t.calls.some((argv) => argv[0] === "terminals" || argvIs("agents", "create")(argv)));
    }),
  );

  const cloudLaunch = (after: ReadonlyArray<Step>) =>
    rig(
      [
        { argv: argvIs("workspaces", "create", "--host", "cloud"), fixture: "ws-create-cloud" },
        ...after,
      ],
      { config: { place: () => Effect.succeed({ kind: "cloud", environmentId: ENV, machineSize: "small" } as const), cloudReadyPollMs: 1 } },
    );
  const getC3 = ["workspaces", "get", C3_WS, "--host", "cloud"];
  const archiveC3 = ["workspaces", "archive", C3_WS, "--host", "cloud"];

  it.live("a cloud launch whose agents create fails after ready archives the workspace before it fails", () =>
    Effect.gen(function* () {
      const t = cloudLaunch([
        { argv: getC3, fixture: "ws-get-cloud-ready" },
        { argv: argvIs("agents", "create"), fail: "Workspace not found on host cloud" },
        { argv: ["snapshot", "--host", "cloud", "--workspace", C3_WS], fixture: "snapshot-cloud", edit: snapshotOf(C3_WS, []) },
        { argv: archiveC3, fixture: "ws-archive-cloud" },
      ]);
      const error = yield* t.run((s) => s.launch(request())).pipe(Effect.flip);
      assert.include(String(error.cause), "; the workspace was archived");
      assert.deepStrictEqual(t.unused(), []);
      const saved = yield* readThread(t.data, C3_WS).pipe(Effect.provide(NodeServices.layer));
      assert.isNotNull(saved!.archivedAt);
    }),
  );

  it.live("a cloud launch whose ready poll fails archives the workspace, and says so when the archive fails too", () =>
    Effect.gen(function* () {
      const t = cloudLaunch([
        { argv: getC3, fail: "No active organization" },
        { argv: archiveC3, fail: "No active organization" },
      ]);
      const error = yield* t.run((s) => s.launch(request())).pipe(Effect.flip);
      assert.include(String(error.cause), "archiving the workspace failed too");
      const saved = yield* readThread(t.data, C3_WS).pipe(Effect.provide(NodeServices.layer));
      assert.isNull(saved!.archivedAt);
    }),
  );

  it.live("a cloud workspace deleted while it provisions fails the launch", () =>
    Effect.gen(function* () {
      const t = cloudLaunch([
        { argv: getC3, fixture: "ws-get-cloud-6-archived", edit: (a) => ({ ...(a as object), id: C3_WS }) },
        { argv: archiveC3, answer: { deleted: [], notFound: [C3_WS], failed: [], warnings: [] } },
      ]);
      const error = yield* t.run((s) => s.launch(request())).pipe(Effect.flip);
      assert.include(String(error.cause), "was deleted while it provisioned");
    }),
  );

  it.live("a retry of a cloud launch whose workspace was archived starts nothing", () =>
    Effect.gen(function* () {
      const t = rig([]);
      yield* seed(t.data, cloudRecord({ terminals: [], turns: [], archivedAt: 1 }));
      yield* writeLaunch(t.data, LAUNCH_ID, `cloud:${C3_WS}`).pipe(Effect.provide(NodeServices.layer));
      const error = yield* t.run((s) => s.launch(request())).pipe(Effect.flip);
      assert.include(String(error.cause), "was archived before its agent started");
      assert.deepStrictEqual(t.calls, []);
    }),
  );

  it.live("a cloud archive that answers failed, with workspaces get still ready, fails and keeps archivedAt unset", () =>
    Effect.gen(function* () {
      const t = rig([
        { argv: archiveC3, answer: { deleted: [], notFound: [], failed: [{ id: C3_WS }], warnings: [] } },
        { argv: getC3, fixture: "ws-get-cloud-ready" },
      ]);
      yield* seed(t.data, cloudRecord());
      const error = yield* t.run((s) => s.archive(`cloud:${C3_WS}`)).pipe(Effect.flip);
      assert.strictEqual(error.operation, "archive");
      assert.include(String(error.cause), `workspaces archive did not archive ${C3_WS}`);
      const saved = yield* readThread(t.data, C3_WS).pipe(Effect.provide(NodeServices.layer));
      assert.isNull(saved!.archivedAt);
    }),
  );
});

describe("cycle 1: a host worktree read and retried where it lives", () => {
  it.live("worktreeCheckout reads a host worktree over SSH, a missing one as null, and a cloud one as null with no call", () =>
    Effect.gen(function* () {
      const head = "a".repeat(40);
      let present = true;
      const ssh = fakeSsh((command) =>
        command.startsWith("test -e ")
          ? { exitCode: present ? 0 : 1 }
          : command.includes("'rev-parse'")
            ? { tail: `${head}\n` }
            : { tail: "fac/5-1\n" },
      );
      const t = rig([], { config: { ssh: ssh.runner, hosts: HOSTS } });
      yield* seed(t.data, hostRecord(), cloudRecord());
      assert.deepStrictEqual(yield* t.run((s) => s.worktreeCheckout(H5_PATH)), { head, branch: "fac/5-1" });
      assert.deepStrictEqual(ssh.calls.map(([, command]) => command), [
        `test -e '${H5_PATH}/.git'`,
        `'git' '-C' '${H5_PATH}' 'rev-parse' '--verify' 'HEAD^{commit}'`,
        `'git' '-C' '${H5_PATH}' 'symbolic-ref' '-q' '--short' 'HEAD'`,
      ]);
      present = false;
      assert.isNull(yield* t.run((s) => s.worktreeCheckout(H5_PATH)));
      const before = ssh.calls.length;
      assert.isNull(yield* t.run((s) => s.worktreeCheckout("/workspace")));
      assert.strictEqual(ssh.calls.length, before);
      assert.deepStrictEqual(t.gitCalls, []);
    }),
  );

  const onHost = { place: () => Effect.die("placed again"), hosts: HOSTS };

  it.live("a host launch retried after its record finds no agent, fetches the base through this Mac's project, and starts one", () =>
    Effect.gen(function* () {
      const r = repos();
      const ssh = fakeSsh((command) => (command.includes("'rev-parse'") ? { tail: `${r.main}\n` } : {}));
      const t = rig(
        [
          { argv: ["snapshot", "--host", HOST, "--workspace", H5_WS], fixture: "snapshot-host-after-restart", edit: snapshotOf(H5_WS, []) },
          { argv: ["projects", "list", "--local"], fixture: "projects-list-local", edit: withProjectPath(r.clone) },
          { argv: ["workspaces", "get", H5_WS, "--host", HOST], fixture: "ws-get-host", edit: (a) => ({ ...(a as object), branch: "fac/5-1", worktreePath: H5_PATH }) },
          { argv: argvIs("agents", "create", "--host", HOST, "--workspace", H5_WS), fixture: "agents-create-host-resume" },
        ],
        { config: { remoteBase: r.remoteBase, ssh: ssh.runner, ...onHost } },
      );
      yield* seed(t.data, hostRecord({ terminals: [], turns: [], worktreePath: null }));
      yield* writeLaunch(t.data, LAUNCH_ID, `host:${HOST}:${H5_WS}`).pipe(Effect.provide(NodeServices.layer));
      yield* t.run((s) => s.launch(request()));
      assert.deepStrictEqual(t.unused(), []);
      assert.isFalse(t.calls.some(argvIs("workspaces", "create")));
      const saved = yield* readThread(t.data, H5_WS).pipe(Effect.provide(NodeServices.layer));
      assert.deepStrictEqual(saved!.terminals, [H11_RESUMED]);
      assert.isFalse(ssh.calls.some(([, command]) => command.includes("'reset'")));
    }),
  );

  it.live("a host worktree with work in it is kept: the launch fails and nothing is fetched or reset over SSH", () =>
    Effect.gen(function* () {
      const r = repos();
      const ssh = fakeSsh((command) =>
        command.includes("'rev-parse'") ? { tail: `${"0".repeat(40)}\n` } : command.includes("'status'") ? { tail: " M a.txt\n" } : {},
      );
      const t = rig(
        [
          { argv: ["projects", "list", "--local"], fixture: "projects-list-local", edit: withProjectPath(r.clone) },
          { argv: ["projects", "list", "--host", HOST], answer: [{ id: HOST_PROJECT, name: "spike", path: HOST_CLONE, repo: "https://github.com/original-solutions/factory-paradev-spike" }] },
          { argv: argvIs("workspaces", "create"), fixture: "ws-create-host-5" },
          { argv: ["workspaces", "get", H5_WS, "--host", HOST], fixture: "ws-get-host", edit: (a) => ({ ...(a as object), branch: "fac/5-1", worktreePath: H5_PATH }) },
          { argv: ["snapshot", "--host", HOST, "--workspace", H5_WS], fixture: "snapshot-host-after-restart", edit: snapshotOf(H5_WS, []) },
        ],
        {
          config: {
            remoteBase: r.remoteBase,
            ssh: ssh.runner,
            hosts: HOSTS,
            place: () => Effect.succeed({ kind: "host", machineId: HOST, path: HOST_CLONE } as const),
          },
        },
      );
      const error = yield* t.run((s) => s.launch(request())).pipe(Effect.flip);
      assert.include(String(error.cause), "holds work off the base");
      assert.isFalse(ssh.calls.some(([, command]) => command.includes("'reset'") || command.includes("'fetch'")));
      assert.isFalse(t.calls.some(argvIs("agents", "create")));
    }),
  );

  it.live("a host with no Paradev project at the repo's clone fails before anything is created", () =>
    Effect.gen(function* () {
      const r = repos();
      const t = rig(
        [
          { argv: ["projects", "list", "--local"], fixture: "projects-list-local", edit: withProjectPath(r.clone) },
          { argv: ["projects", "list", "--host", HOST], answer: [] },
        ],
        {
          config: {
            remoteBase: r.remoteBase,
            ssh: fakeSsh(() => ({})).runner,
            hosts: HOSTS,
            place: () => Effect.succeed({ kind: "host", machineId: HOST, path: HOST_CLONE } as const),
          },
        },
      );
      const error = yield* t.run((s) => s.launch(request())).pipe(Effect.flip);
      assert.include(String(error.cause), `no Paradev project at ${HOST_CLONE} on host ${HOST}`);
      assert.isFalse(t.calls.some(argvIs("workspaces", "create")));
    }),
  );
});
