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
import { FactoryProcess, layer as processLayer } from "../process.ts";
import { MessageRejectedError, ThreadNotFoundError, type LaunchRequest } from "../sessions.ts";
import { layer as cliLayer } from "./cli.ts";
import { fakeSuperset, readFixture, type Step } from "./fake-superset.ts";
import {
  AgentProcess,
  agentProcessLayer,
  make,
  type ParadevSessions,
  type ParadevSessionsConfig,
} from "./sessions.ts";
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
      yield* t.run((s) => s.launch(request({ baseRef: "main", startFromOrigin: false })));
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
        const filler = Array.from({ length: 1500 }, (_, i) => `[filter "pad${i}"]\n\tsmudge =\n`).join("");
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
      // No paradev.model or paradev.effort: the agent's defaults, so no --model and no --effort.
      assert.deepStrictEqual(project?.model, { instanceId: "claude", model: "" });
      assert.isNull(yield* t.run((s) => s.findProject(root)));
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
      assert.deepStrictEqual(yield* savedL1(t.data), record());
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
      assert.deepStrictEqual(yield* savedL1(t.data), record());
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
