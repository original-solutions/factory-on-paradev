// @effect-diagnostics nodeBuiltinImport:off - Tests make real git repositories, lock files and fake `git` scripts in temp dirs, and probe process groups with kill(pid, 0).
import { assert, it, vi } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe } from "vitest";

import {
  FactoryGate,
  GateCommandSpawnError,
  GateRecordError,
  WorkspaceCleanupError,
  WorkspaceFailedError,
  WorkspaceIoError,
  WorkspaceSpawnError,
  WorkspaceUnexpectedError,
  clearGateLocks,
  gateLockFile,
  gateLocksHeld,
  gateLockTimes,
  gateLogPath,
  gateResultsComment,
  gateRoot,
  layer as gateLayer,
  makeWorkspace,
  regateResultsComment,
  type CommandResult,
  type GateError,
  type GateInput,
  type GateOptions,
} from "./gate.ts";
import { sanitize } from "./text.ts";
import type { AppendIo } from "./ledger/appendFile.ts";
import { LedgerIoError } from "./ledger/errors.ts";
import { Ledger } from "./ledger/ledger.ts";
import { readRun } from "./ledger/read.ts";
import { newRunId, runIdToString } from "./ledger/runId.ts";
import { T0, ticking, useTempDirs } from "./ledger/testSupport.ts";
import { FactoryProcess, RunSpawnError, layer as processLayer } from "./process.ts";

const tempDir = useTempDirs();

const REPO = "rawphp/softfac";
const SOME_SHA = "0123456789abcdef0123456789abcdef01234567";
const BASE = "89abcdef0123456789abcdef0123456789abcdef";
const SHORT = "0123456";
const BASE_SHORT = "89abcde";

const isRoot = globalThis.process.getuid?.() === 0;

const spawnGit = (cwd: string, args: ReadonlyArray<string>) =>
  NodeChildProcess.spawnSync(
    "git",
    [
      "-c",
      "user.name=softfac-test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      "-C",
      cwd,
      ...args,
    ],
    {
      encoding: "utf8",
      env: { ...globalThis.process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    },
  );

/** Runs the real `git` in `dir` for a test and returns what it printed. */
const git = (dir: string, ...args: Array<string>): string => {
  const result = spawnGit(dir, args);
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
};

type Files = ReadonlyArray<readonly [string, string]>;

/**
 * A bare "remote" at `<root>/rawphp/softfac.git`, the primary checkout (a clone of it) and a
 * second clone that pushes commits the primary has not fetched, all in one temp dir.
 */
const makeRemote = (name: string) => {
  const root = tempDir(name);
  NodeFS.mkdirSync(NodePath.join(root, "rawphp"));
  git(root, "init", "-q", "--bare", "rawphp/softfac.git");
  for (const clone of ["primary", "other"]) git(root, "clone", "-q", "rawphp/softfac.git", clone);
  const primary = NodePath.join(root, "primary");
  const other = NodePath.join(root, "other");
  NodeFS.writeFileSync(NodePath.join(primary, "README"), "hello\n");
  git(primary, "add", "README");
  git(primary, "commit", "-q", "-m", "first");
  git(primary, "push", "-q", "origin", "HEAD:refs/heads/main");

  const writeAndAdd = (files: Files) => {
    for (const [file, text] of files) {
      const full = NodePath.join(other, file);
      NodeFS.mkdirSync(NodePath.dirname(full), { recursive: true });
      NodeFS.writeFileSync(full, text);
      git(other, "add", "--", file);
    }
  };

  return {
    root,
    primary,
    /** The remote's URL base: `<base>/rawphp/softfac.git` is the bare repository. */
    base: `file://${root}`,
    /** Where a checkout goes: a directory that does not exist yet. */
    checkoutDir: (dirName: string) => NodePath.join(root, "gate", dirName),
    /** Pushes a commit with these files from the second clone, so the primary does not have it. */
    push: (files: Files): string => {
      git(other, "fetch", "-q", "origin");
      git(other, "checkout", "-q", "-B", "main", "origin/main");
      writeAndAdd(files);
      git(other, "commit", "-q", "-m", "change");
      git(other, "push", "-q", "origin", "HEAD:refs/heads/main");
      return git(other, "rev-parse", "HEAD").trim();
    },
    /** Pushes a commit on `branch`, starting from the remote's branch `from`. */
    pushOn: (branch: string, from: string, files: Files, removed: ReadonlyArray<string> = []) => {
      git(other, "fetch", "-q", "origin");
      git(other, "checkout", "-q", "-B", "work", `origin/${from}`);
      writeAndAdd(files);
      for (const file of removed) git(other, "rm", "-q", "--", file);
      git(other, "commit", "-q", "-m", "change");
      git(other, "push", "-q", "-f", "origin", `HEAD:refs/heads/${branch}`);
      return git(other, "rev-parse", "HEAD").trim();
    },
    /** Pushes a commit that shares no history with anything on the remote, on `branch`. */
    pushOrphan: (branch: string, files: Files) => {
      git(other, "checkout", "-q", "--orphan", "orphan");
      git(other, "rm", "-rfq", "--ignore-unmatch", ".");
      writeAndAdd(files);
      git(other, "commit", "-q", "-m", "orphan");
      git(other, "push", "-q", "-f", "origin", `HEAD:refs/heads/${branch}`);
      return git(other, "rev-parse", "HEAD").trim();
    },
    /** A local commit in the primary that the remote does not have, with `README` as given. */
    localCommit: (readme: string) => {
      NodeFS.writeFileSync(NodePath.join(primary, "README"), readme);
      git(primary, "commit", "-q", "-am", "local");
      return git(primary, "rev-parse", "HEAD").trim();
    },
  };
};

type Remote = ReturnType<typeof makeRemote>;

const testLayer = gateLayer.pipe(Layer.provide(processLayer));

const provided = <A, E>(self: Effect.Effect<A, E, FactoryGate>) =>
  self.pipe(Effect.provide(testLayer));

const withProcess = <A, E>(self: Effect.Effect<A, E, FactoryProcess>) =>
  self.pipe(Effect.provide(processLayer));

/** `checkout` of the workspace the gate uses, over the real process layer. */
const checkout = (options: GateOptions, repo: string, sha: string, base: string, dir: string) =>
  withProcess(
    Effect.gen(function* () {
      const proc = yield* FactoryProcess;
      return yield* makeWorkspace(proc, options).checkout(repo, sha, base, dir);
    }),
  );

const remoteOptions = (remote: Remote, extra: Partial<GateOptions> = {}): GateOptions => ({
  remoteBase: remote.base,
  ...extra,
});

const read = (file: string) => NodeFS.readFileSync(file, "utf8");

const expectFailed = (error: GateError): WorkspaceFailedError => {
  if (error._tag !== "WorkspaceFailedError")
    throw new Error(`expected a failed git call, got ${error._tag}`);
  return error;
};

const applyEnv = (vars: Record<string, string>) => {
  const saved = Object.keys(vars).map((k) => [k, globalThis.process.env[k]] as const);
  for (const [k, v] of Object.entries(vars)) globalThis.process.env[k] = v;
  return saved;
};
const restoreEnv = (saved: ReadonlyArray<readonly [string, string | undefined]>) => {
  for (const [k, v] of saved) {
    if (v === undefined) delete globalThis.process.env[k];
    else globalThis.process.env[k] = v;
  }
};
const pathEnv = () => globalThis.process.env.PATH ?? "";

const withEnv = <A, E, R>(
  vars: Record<string, string>,
  body: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    Effect.sync(() => applyEnv(vars)),
    () => body,
    (saved) => Effect.sync(() => restoreEnv(saved)),
  );

/** The id of a `git log` field of the checkout's HEAD. */
const headField = (dir: string, format: string) =>
  git(dir, "log", "-1", `--format=${format}`).trim();

/**
 * A directory with a script that stands in for `git`. The script first writes its pid to
 * `self.pid`, which is the id of its process group too; `kill` signals that group, so a test
 * that fails halfway leaves no sleeper behind.
 */
const makeFakeGit = (name: string, body: string) => {
  const dir = tempDir(name);
  const script = NodePath.join(dir, "git");
  NodeFS.writeFileSync(
    script,
    `#!/bin/sh\necho $$ > ${NodePath.join(dir, "self.pid")}\n${body}\n`,
    { mode: 0o755 },
  );
  const pid = (): number | undefined => {
    try {
      return Number(read(NodePath.join(dir, "self.pid")).trim());
    } catch {
      return undefined;
    }
  };
  return {
    dir,
    /** The options that put this git first on PATH. */
    options: (extra: Partial<GateOptions> = {}): GateOptions => ({
      env: { PATH: `${dir}:${globalThis.process.env.PATH ?? ""}` },
      ...extra,
    }),
    file: (fileName: string) => read(NodePath.join(dir, fileName)),
    groupAlive: (): boolean => {
      const id = pid();
      if (id === undefined) return false;
      try {
        globalThis.process.kill(-id, 0);
        return true;
      } catch {
        return false;
      }
    },
    kill: () => {
      const id = pid();
      if (id === undefined) return;
      try {
        globalThis.process.kill(-id, "SIGKILL");
      } catch {
        // Already gone.
      }
    },
  };
};

type FakeGit = ReturnType<typeof makeFakeGit>;

const usingFakeGit = <A, E, R>(
  name: string,
  body: string,
  use: (fake: FakeGit) => Effect.Effect<A, E, R>,
) => {
  const fake = makeFakeGit(name, body);
  return Effect.ensuring(
    Effect.suspend(() => use(fake)),
    Effect.sync(() => fake.kill()),
  );
};

/** A fake `git` that logs every call and prints a commit id for `rev-parse`. */
const LOGGING_GIT = `d="$(dirname "$0")"\necho "CALL $*" >> "$d/log"\nenv | sort >> "$d/log"\ncase "$*" in\n*rev-parse*) echo ${SOME_SHA};;\nesac`;

/** The calls a fake `git` saw, one block per call: `CALL <arguments>` and then its environment. */
const recordedCalls = (fake: FakeGit): Array<string> => fake.file("log").split("CALL ").slice(1);

/** `checkout` on a script that stands in for `git`, in a directory of its own. */
const checkoutWithFake = (fake: FakeGit, options: GateOptions) =>
  checkout(options, REPO, SOME_SHA, BASE, NodePath.join(fake.dir, "wt"));

it("a workspace error says what failed", () => {
  assert.strictEqual(
    new WorkspaceFailedError({
      args: "rev-parse HEAD",
      status: 128,
      stderr: "fatal: not a git repository\n",
    }).message,
    "`git rev-parse HEAD` exited with status 128: fatal: not a git repository",
  );
  assert.strictEqual(
    new WorkspaceFailedError({ args: "status --porcelain", status: null, stderr: "" }).message,
    "`git status --porcelain` was killed by a signal: ",
  );
  assert.strictEqual(
    new WorkspaceUnexpectedError({ what: "not a commit id" }).message,
    "unexpected output from git: not a commit id",
  );
  assert.strictEqual(
    new WorkspaceCleanupError({ what: "/data/gate/x: permission denied" }).message,
    "could not remove the checkout: /data/gate/x: permission denied",
  );
  assert.strictEqual(
    new WorkspaceIoError({ path: "/data/gate", cause: new Error("disk full") }).message,
    "cannot make /data/gate: disk full",
  );
  assert.strictEqual(
    new WorkspaceSpawnError({ cause: new Error("spawn git ENOENT") }).message,
    "cannot start `git`: spawn git ENOENT",
  );
  assert.strictEqual(
    new GateCommandSpawnError({ command: "cargo test", cause: new Error("no shell") }).message,
    "could not start `cargo test`: no shell",
  );
  assert.strictEqual(
    new GateRecordError({ attempt: 2, cause: new Error("disk full") }).message,
    "attempt 2 is used: the ledger failed while its gate_command lines were written: disk full",
  );
});

it.live("the local workspace runs the gate commands in the directory", () =>
  Effect.gen(function* () {
    const remote = makeRemote("ws-gate");
    const dataDir = tempDir("ws-gate-data");
    const run = newRunId(REPO, "10", 1);
    const head = remote.push([["README", "pushed\n"]]);
    Ledger.create(dataDir, run, { clock: ticking(T0, 1000) }).close();
    const gate = yield* FactoryGate;
    const result = yield* gate.run({
      ...baseInput(remote, dataDir, run, head, head),
      gate: ["test -f README", "test -f MISSING", "true"],
    });
    assert.strictEqual(result._tag, "fail");
    if (result._tag !== "fail") return;
    assert.deepStrictEqual(
      result.commands.map((c) => c.exitCode),
      [0, 1],
    );
    assert.strictEqual(result.failure.command, "test -f MISSING");
  }).pipe(provided),
);

it.live("a gate command that cannot start is an error and not a failed command", () =>
  Effect.gen(function* () {
    const remote = makeRemote("ws-gone");
    const dataDir = tempDir("ws-gone-data");
    const run = newRunId(REPO, "10", 1);
    const head = remote.push([["README", "pushed\n"]]);
    Ledger.create(dataDir, run, { clock: ticking(T0, 1000) }).close();
    const gate = yield* FactoryGate;
    const dir = NodePath.join(gateRoot(dataDir, run), "1");
    // The first command removes the directory it runs in, so the second cannot start there.
    const error = yield* gate
      .run({
        ...baseInput(remote, dataDir, run, head, head),
        gate: [`cd .. && rm -rf '${dir}'`, "true"],
      })
      .pipe(Effect.flip);
    assert.strictEqual(error._tag, "GateCommandSpawnError");
    assert.isFalse(
      NodeFS.existsSync(NodePath.join(dataDir, "gates", `${runIdToString(run)}.lock`)),
    );
  }).pipe(provided),
);

it.live("a checkout is a standalone repository at the fetched commit", () =>
  Effect.gen(function* () {
    const remote = makeRemote("co-standalone");
    const sha = remote.push([
      ["README", "pushed\n"],
      ["new.txt", "new\n"],
    ]);
    const dir = remote.checkoutDir("standalone");
    const made = yield* checkout(remoteOptions(remote), REPO, sha, sha, dir);
    assert.strictEqual(made.head, sha);
    assert.strictEqual(git(dir, "rev-parse", "HEAD").trim(), sha);
    assert.strictEqual(read(NodePath.join(dir, "README")), "pushed\n");
    assert.strictEqual(read(NodePath.join(dir, "new.txt")), "new\n");
    // Detached, with no remote, and its own `.git` directory: not a worktree of anything.
    assert.strictEqual(git(dir, "branch", "--show-current").trim(), "");
    assert.strictEqual(git(dir, "remote").trim(), "");
    assert.isTrue(NodeFS.statSync(NodePath.join(dir, ".git")).isDirectory());
    // The primary checkout was not used: it still lacks the commit, and has no new worktree.
    assert.notStrictEqual(spawnGit(remote.primary, ["cat-file", "-e", sha]).status, 0);
    assert.strictEqual(
      git(remote.primary, "worktree", "list", "--porcelain").split("worktree ").length - 1,
      1,
    );
  }),
);

it.live("a checkout holds nothing of the primary's working files", () =>
  Effect.gen(function* () {
    const remote = makeRemote("co-clean");
    NodeFS.writeFileSync(NodePath.join(remote.primary, "untracked.txt"), "x");
    NodeFS.writeFileSync(NodePath.join(remote.primary, ".git/info/exclude"), "secret.env\n");
    NodeFS.writeFileSync(NodePath.join(remote.primary, "secret.env"), "TOKEN=1\n");
    const sha = remote.push([["README", "pushed\n"]]);
    const dir = remote.checkoutDir("clean");
    yield* checkout(remoteOptions(remote), REPO, sha, sha, dir);
    assert.isFalse(NodeFS.existsSync(NodePath.join(dir, "untracked.txt")));
    assert.isFalse(NodeFS.existsSync(NodePath.join(dir, "secret.env")));
    assert.strictEqual(git(dir, "status", "--porcelain", "--ignored"), "");
  }),
);

it.live("a replace ref in the primary does not change what is checked out", () =>
  Effect.gen(function* () {
    const remote = makeRemote("co-replace");
    const x = remote.push([["README", "pushed\n"]]);
    // The session commits other content locally and replaces the pushed commit with it.
    git(remote.primary, "fetch", "-q", "origin", x);
    git(remote.primary, "checkout", "-q", "--detach", x);
    const y = remote.localCommit("replaced\n");
    git(remote.primary, "replace", "-f", x, y);
    // The test has teeth: through the primary's object store, X now reads as Y.
    assert.strictEqual(git(remote.primary, "show", `${x}:README`), "replaced\n");
    const dir = remote.checkoutDir("replace");
    assert.strictEqual((yield* checkout(remoteOptions(remote), REPO, x, x, dir)).head, x);
    assert.strictEqual(read(NodePath.join(dir, "README")), "pushed\n");
  }),
);

it.live("a sparse checkout in the primary does not thin out the checkout", () =>
  Effect.gen(function* () {
    const remote = makeRemote("co-sparse");
    git(remote.primary, "config", "core.sparseCheckout", "true");
    NodeFS.writeFileSync(
      NodePath.join(remote.primary, ".git/info/sparse-checkout"),
      "/nothing-matches\n",
    );
    const sha = remote.push([
      ["a.txt", "a\n"],
      ["b.txt", "b\n"],
    ]);
    const dir = remote.checkoutDir("sparse");
    yield* checkout(remoteOptions(remote), REPO, sha, sha, dir);
    for (const name of ["README", "a.txt", "b.txt"]) {
      assert.isTrue(NodeFS.existsSync(NodePath.join(dir, name)), name);
    }
  }),
);

it.live("info/attributes in the primary do not change the files", () =>
  Effect.gen(function* () {
    const remote = makeRemote("co-attributes");
    NodeFS.mkdirSync(NodePath.join(remote.primary, ".git/info"), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(remote.primary, ".git/info/attributes"),
      "* text eol=crlf\n",
    );
    git(remote.primary, "config", "core.autocrlf", "true");
    const sha = remote.push([["README", "pushed\n"]]);
    // The test has teeth: a checkout that shares the primary's `.git` writes CRLF.
    git(remote.primary, "fetch", "-q", "origin", sha);
    const shared = remote.checkoutDir("shared");
    git(remote.primary, "worktree", "add", "-q", "--detach", shared, sha);
    assert.strictEqual(read(NodePath.join(shared, "README")), "pushed\r\n");
    const dir = remote.checkoutDir("attributes");
    yield* checkout(remoteOptions(remote), REPO, sha, sha, dir);
    assert.strictEqual(read(NodePath.join(dir, "README")), "pushed\n");
  }),
);

it.live("a redirected remote in the primary does not redirect the fetch", () =>
  Effect.gen(function* () {
    const remote = makeRemote("co-redirect");
    const sha = remote.push([["README", "pushed\n"]]);
    const url = `${remote.base}/rawphp/softfac.git`;
    git(remote.primary, "config", "remote.origin.url", "file:///nowhere/at/all.git");
    git(remote.primary, "config", "url.file:///nowhere/.insteadOf", `${remote.base}/`);
    git(remote.primary, "config", "core.sshCommand", "false");
    // The test has teeth: the primary's own fetch of the same URL is redirected and fails.
    assert.notStrictEqual(spawnGit(remote.primary, ["fetch", "-q", url, sha]).status, 0);
    const dir = remote.checkoutDir("redirect");
    assert.strictEqual((yield* checkout(remoteOptions(remote), REPO, sha, sha, dir)).head, sha);
  }),
);

it.live("the user's global git config cannot change a checkout", () =>
  Effect.gen(function* () {
    const remote = makeRemote("co-global");
    const home = NodePath.join(remote.root, "home");
    const hooks = NodePath.join(remote.root, "hooks");
    NodeFS.mkdirSync(home, { recursive: true });
    NodeFS.mkdirSync(hooks, { recursive: true });
    const hookMarker = NodePath.join(remote.root, "hook-ran");
    const filterMarker = NodePath.join(remote.root, "filter-ran");
    NodeFS.writeFileSync(
      NodePath.join(hooks, "post-checkout"),
      `#!/bin/sh\ntouch '${hookMarker}'\n`,
      { mode: 0o755 },
    );
    NodeFS.writeFileSync(
      NodePath.join(home, ".gitconfig"),
      `[core]\n\thooksPath = ${hooks}\n\tautocrlf = true\n[filter "evil"]\n\tsmudge = touch '${filterMarker}'; cat\n\trequired = true\n`,
    );
    const sha = remote.push([
      [".gitattributes", "a.txt filter=evil\n"],
      ["a.txt", "filtered\n"],
      ["b.txt", "plain\n"],
    ]);
    // The test has teeth: plain git with that HOME runs the hook and the filter, and converts
    // line endings.
    const plain = remote.checkoutDir("plain");
    // Without the suite's pinned settings (gitConfig.setup.ts), which outrank that HOME's file.
    const ambient = Object.fromEntries(
      Object.entries(globalThis.process.env).filter(([name]) => !name.startsWith("GIT_CONFIG_")),
    );
    const cloned = NodeChildProcess.spawnSync(
      "git",
      ["clone", "-q", "--branch", "main", NodePath.join(remote.root, "rawphp/softfac.git"), plain],
      {
        encoding: "utf8",
        env: { ...ambient, HOME: home, GIT_CONFIG_NOSYSTEM: "1" },
      },
    );
    assert.strictEqual(cloned.status, 0, cloned.stderr);
    assert.isTrue(NodeFS.existsSync(hookMarker) && NodeFS.existsSync(filterMarker));
    assert.strictEqual(read(NodePath.join(plain, "b.txt")), "plain\r\n");
    NodeFS.rmSync(hookMarker);
    NodeFS.rmSync(filterMarker);
    const dir = remote.checkoutDir("global");
    yield* checkout(remoteOptions(remote, { env: { HOME: home } }), REPO, sha, sha, dir);
    assert.isFalse(NodeFS.existsSync(hookMarker), "a hook ran");
    assert.isFalse(NodeFS.existsSync(filterMarker), "a filter ran");
    assert.strictEqual(read(NodePath.join(dir, "a.txt")), "filtered\n");
    assert.strictEqual(read(NodePath.join(dir, "b.txt")), "plain\n");
  }),
);

it.live("the default attributes and ignore files in the user's config dir change nothing", () =>
  Effect.gen(function* () {
    const remote = makeRemote("co-xdg");
    // `GIT_CONFIG_GLOBAL=/dev/null` clears the config keys, but git still reads
    // `~/.config/git/attributes` and `~/.config/git/ignore`.
    const home = NodePath.join(remote.root, "home");
    NodeFS.mkdirSync(NodePath.join(home, ".config/git"), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(home, ".config/git/attributes"),
      "* text eol=crlf\nREADME merge=union\n",
    );
    NodeFS.writeFileSync(NodePath.join(home, ".config/git/ignore"), "*.log\n");
    const pr = remote.pushOn("pr", "main", [
      ["README", "pr\n"],
      ["b.txt", "b\n"],
      ["a.log", "l\n"],
    ]);
    const base = remote.pushOn("main", "main", [["README", "base\n"]]);
    const plainEnv = {
      PATH: pathEnv(),
      HOME: home,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    };
    // The test has teeth: with the config keys cleared the same way, plain git still converts
    // line endings and still resolves the README conflict through `union`.
    const plain = remote.checkoutDir("plain");
    const cloned = NodeChildProcess.spawnSync(
      "git",
      [
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@t",
        "clone",
        "-q",
        "--branch",
        "pr",
        NodePath.join(remote.root, "rawphp/softfac.git"),
        plain,
      ],
      { encoding: "utf8", env: plainEnv },
    );
    assert.strictEqual(cloned.status, 0, cloned.stderr);
    assert.strictEqual(read(NodePath.join(plain, "b.txt")), "b\r\n");
    const pulled = NodeChildProcess.spawnSync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@t", "-C", plain].concat([
        "pull",
        "-q",
        "--no-rebase",
        "--no-edit",
        "origin",
        "main",
      ]),
      { encoding: "utf8", env: plainEnv },
    );
    assert.strictEqual(pulled.status, 0, `plain git should merge through union: ${pulled.stderr}`);
    // Ours reads neither: LF files, and the README conflict is a conflict.
    const dir = remote.checkoutDir("xdg");
    const made = yield* checkout(
      remoteOptions(remote, {
        env: { HOME: home, XDG_CONFIG_HOME: NodePath.join(home, ".config") },
      }),
      REPO,
      pr,
      base,
      dir,
    );
    assert.strictEqual(made.head, pr);
    assert.deepStrictEqual(made.merge, { _tag: "conflict", paths: ["README"] });
    assert.strictEqual(read(NodePath.join(dir, "b.txt")), "b\n");
    assert.strictEqual(read(NodePath.join(dir, "README")), "pr\n");
    assert.strictEqual(git(dir, "status", "--porcelain"), "");
  }),
);

it.live("a checkout of a commit the remote does not have fails and leaves no directory", () =>
  Effect.gen(function* () {
    const remote = makeRemote("co-missing");
    const dir = remote.checkoutDir("missing");
    const error = yield* checkout(remoteOptions(remote), REPO, SOME_SHA, SOME_SHA, dir).pipe(
      Effect.flip,
    );
    assert.strictEqual(error._tag, "WorkspaceFailedError");
    assert.isFalse(NodeFS.existsSync(dir));
  }),
);

it.live("a checkout from a remote that is not there fails", () =>
  Effect.gen(function* () {
    const remote = makeRemote("co-no-remote");
    const error = yield* checkout(
      { remoteBase: "file:///nowhere/at/all" },
      REPO,
      SOME_SHA,
      SOME_SHA,
      remote.checkoutDir("none"),
    ).pipe(Effect.flip);
    assert.strictEqual(error._tag, "WorkspaceFailedError");
  }),
);

it.live(
  "a checkout takes only a full commit id and an owner and name so nothing else reaches git",
  () =>
    Effect.gen(function* () {
      const remote = makeRemote("co-bad-input");
      const dir = remote.checkoutDir("bad");
      for (const bad of [
        "",
        "main",
        "--upload-pack=touch /tmp/x",
        "-n",
        "0123456789abcdef0123456789abcdef0123456",
        "0123456789abcdef0123456789abcdef012345678",
        "0123456789abcdef0123456789abcdef0123456g",
        `${SOME_SHA}\n`,
      ]) {
        const error = yield* checkout(remoteOptions(remote), REPO, bad, bad, dir).pipe(Effect.flip);
        assert.strictEqual(error._tag, "WorkspaceUnexpectedError", JSON.stringify(bad));
        // The base is held to the same rule.
        const baseError = yield* checkout(remoteOptions(remote), REPO, SOME_SHA, bad, dir).pipe(
          Effect.flip,
        );
        assert.strictEqual(
          baseError._tag,
          "WorkspaceUnexpectedError",
          `base ${JSON.stringify(bad)}`,
        );
      }
      for (const bad of [
        "",
        "rawphp",
        "rawphp/",
        "/softfac",
        "a/b/c",
        "../x",
        "x/..",
        "x/.",
        "a b/c",
        "a/b c",
        "a/b?x=1",
        "a/b#x",
        "a@b/c",
        "a/b\nc",
        "-a/b",
        "a/-b",
      ]) {
        const error = yield* checkout(remoteOptions(remote), bad, SOME_SHA, SOME_SHA, dir).pipe(
          Effect.flip,
        );
        assert.strictEqual(error._tag, "WorkspaceUnexpectedError", JSON.stringify(bad));
      }
      assert.isFalse(NodeFS.existsSync(dir));
    }),
);

it.live("the base is merged into the head with the daemon's identity", () =>
  Effect.gen(function* () {
    const remote = makeRemote("mg-clean");
    const pr = remote.pushOn("pr", "main", [["pr.txt", "pr\n"]]);
    const base = remote.pushOn("main", "main", [["base.txt", "base\n"]]);
    const dir = remote.checkoutDir("merged");
    const made = yield* checkout(remoteOptions(remote), REPO, pr, base, dir);
    assert.strictEqual(made.head, pr);
    assert.deepStrictEqual(made.merge, { _tag: "merged" });
    // The merged tree: the head's files and the base's.
    for (const name of ["README", "pr.txt", "base.txt"]) {
      assert.isTrue(NodeFS.existsSync(NodePath.join(dir, name)), name);
    }
    // A merge commit whose first parent is the PR head and second the base tip.
    assert.strictEqual(git(dir, "rev-parse", "HEAD^1").trim(), pr);
    assert.strictEqual(git(dir, "rev-parse", "HEAD^2").trim(), base);
    assert.strictEqual(
      headField(dir, "%an|%ae|%cn|%ce"),
      "softfac|softfac@localhost|softfac|softfac@localhost",
    );
    assert.strictEqual(git(dir, "status", "--porcelain", "--ignored"), "");
    assert.strictEqual(git(dir, "branch", "--show-current").trim(), "");
  }),
);

it.live("a base that is already in the head is not merged", () =>
  Effect.gen(function* () {
    const remote = makeRemote("mg-contained");
    // The head is ahead of the base tip.
    const base = remote.pushOn("main", "main", [["base.txt", "base\n"]]);
    const pr = remote.pushOn("pr", "main", [["pr.txt", "pr\n"]]);
    const dir = remote.checkoutDir("contained");
    const made = yield* checkout(remoteOptions(remote), REPO, pr, base, dir);
    assert.strictEqual(made.head, pr);
    assert.deepStrictEqual(made.merge, { _tag: "contained" });
    assert.strictEqual(git(dir, "rev-parse", "HEAD").trim(), pr);
    assert.strictEqual(git(dir, "rev-list", "--merges", "HEAD"), "");
    // The head is the base itself.
    const same = remote.checkoutDir("same");
    const out = yield* checkout(remoteOptions(remote), REPO, base, base, same);
    assert.deepStrictEqual(out.merge, { _tag: "contained" });
    assert.strictEqual(out.head, base);
  }),
);

it.live("a head that is behind the base gets a merge commit and not a fast-forward", () =>
  Effect.gen(function* () {
    const remote = makeRemote("mg-behind");
    const old = git(remote.primary, "rev-parse", "HEAD").trim();
    const base = remote.pushOn("main", "main", [["base.txt", "base\n"]]);
    const dir = remote.checkoutDir("behind");
    const made = yield* checkout(remoteOptions(remote), REPO, old, base, dir);
    assert.strictEqual(made.head, old);
    assert.deepStrictEqual(made.merge, { _tag: "merged" });
    // The first parent is still the PR head, as the gate checks, and the second is the base:
    // a fast-forward would leave HEAD at the base with no second parent.
    assert.strictEqual(git(dir, "rev-parse", "HEAD^1").trim(), old);
    assert.strictEqual(git(dir, "rev-parse", "HEAD^2").trim(), base);
    assert.isTrue(NodeFS.existsSync(NodePath.join(dir, "base.txt")));
  }),
);

it.live("a conflict with the base is reported with its paths and the merge is aborted", () =>
  Effect.gen(function* () {
    const remote = makeRemote("mg-conflict");
    const odd = "odd\u001b[31m name.txt";
    const long = `${"x".repeat(200)}.txt`;
    remote.push([
      ["a.txt", "a\n"],
      [odd, "o\n"],
      [long, "l\n"],
    ]);
    const pr = remote.pushOn("pr", "main", [
      ["README", "pr\n"],
      ["a.txt", "pr\n"],
      [odd, "pr\n"],
      [long, "pr\n"],
    ]);
    const base = remote.pushOn("main", "main", [
      ["README", "base\n"],
      ["a.txt", "base\n"],
      [odd, "base\n"],
      [long, "base\n"],
      ["clean.txt", "c\n"],
    ]);
    const dir = remote.checkoutDir("conflict");
    const made = yield* checkout(remoteOptions(remote), REPO, pr, base, dir);
    assert.strictEqual(made.head, pr);
    assert.strictEqual(made.merge._tag, "conflict");
    if (made.merge._tag !== "conflict") return;
    assert.deepStrictEqual([...made.merge.paths].sort(), ["README", "a.txt", odd, long].sort());
    // The merge was aborted: no merge in progress, the head's files, no stray file.
    assert.isFalse(NodeFS.existsSync(NodePath.join(dir, ".git/MERGE_HEAD")));
    assert.strictEqual(git(dir, "rev-parse", "HEAD").trim(), pr);
    assert.strictEqual(read(NodePath.join(dir, "README")), "pr\n");
    assert.isFalse(NodeFS.existsSync(NodePath.join(dir, "clean.txt")));
    assert.strictEqual(git(dir, "status", "--porcelain"), "");
  }),
);

it.live("a merge that fails for another reason is an error and not a conflict", () =>
  Effect.gen(function* () {
    const remote = makeRemote("mg-unrelated");
    const pr = remote.pushOn("pr", "main", [["pr.txt", "pr\n"]]);
    const base = remote.pushOrphan("unrelated", [["other.txt", "o\n"]]);
    const dir = remote.checkoutDir("unrelated");
    const error = yield* checkout(remoteOptions(remote), REPO, pr, base, dir).pipe(Effect.flip);
    assert.strictEqual(error._tag, "WorkspaceFailedError");
    assert.isFalse(NodeFS.existsSync(dir));
  }),
);

it.live("a base the remote does not have fails the fetch", () =>
  Effect.gen(function* () {
    const remote = makeRemote("mg-no-base");
    const pr = remote.pushOn("pr", "main", [["pr.txt", "pr\n"]]);
    const error = yield* checkout(
      remoteOptions(remote),
      REPO,
      pr,
      SOME_SHA,
      remote.checkoutDir("no-base"),
    ).pipe(Effect.flip);
    assert.strictEqual(error._tag, "WorkspaceFailedError");
    assert.match(expectFailed(error).args, /^fetch /);
  }),
);

it.live("the merge runs with the daemon's identity and no signing and nothing else gets them", () =>
  usingFakeGit(
    "mg-args",
    // `merge-base` says no (exit 1), `merge` works, and the parents are right.
    `d="$(dirname "$0")"\necho "CALL $*" >> "$d/log"\ncase "$*" in\n*merge-base*) exit 1;;\n*HEAD^1*) echo ${SOME_SHA}; echo ${BASE};;\n*rev-parse*) echo ${SOME_SHA};;\nesac`,
    (fake) =>
      Effect.gen(function* () {
        const made = yield* checkoutWithFake(fake, fake.options());
        assert.deepStrictEqual(made.merge, { _tag: "merged" });
        const log = fake.file("log");
        const merge = log.split("\n").filter((l) => l.includes(" --no-ff "));
        assert.strictEqual(merge.length, 1, log);
        for (const flag of [
          "-c user.name=softfac",
          "-c user.email=softfac@localhost",
          "-c commit.gpgsign=false",
          "merge --no-ff --no-edit",
          BASE,
        ]) {
          assert.include(merge[0], flag);
        }
        assert.notInclude(merge[0], "origin");
        for (const line of log.split("\n").filter((l) => l !== "" && !l.includes(" --no-ff "))) {
          assert.notInclude(line, "user.name");
        }
        // The tree is looked at again after the merge.
        assert.strictEqual(log.split("\n").filter((l) => l.includes(" status ")).length, 2, log);
      }),
  ),
);

it.live("a merge whose parents are not the head and the base is refused", () =>
  usingFakeGit(
    "mg-parents",
    `case "$*" in\n*merge-base*) exit 1;;\n*HEAD^1*) echo bbbbbbb0123456789abcdef0123456789abcdef0; echo ${BASE};;\n*rev-parse*) echo ${SOME_SHA};;\nesac`,
    (fake) =>
      Effect.gen(function* () {
        const error = yield* checkoutWithFake(fake, fake.options()).pipe(Effect.flip);
        assert.strictEqual(error._tag, "WorkspaceUnexpectedError");
        assert.include(error.message, "not the head and the base");
      }),
  ),
);

it.live("a merge that exits 1 and names no conflicted file is an error and not a conflict", () =>
  usingFakeGit(
    "mg-no-paths",
    `d="$(dirname "$0")"\necho "CALL $*" >> "$d/log"\ncase "$*" in\n*merge-base*) exit 1;;\n*" merge "*) echo "merge failed" >&2; exit 1;;\n*rev-parse*) echo ${SOME_SHA};;\nesac`,
    (fake) =>
      Effect.gen(function* () {
        const error = yield* checkoutWithFake(fake, fake.options()).pipe(Effect.flip);
        const failed = expectFailed(error);
        assert.strictEqual(failed.args, `merge --no-ff --no-edit ${BASE}`);
        assert.strictEqual(failed.status, 1);
        assert.strictEqual(failed.stderr, "merge failed\n");
        assert.isFalse(recordedCalls(fake).some((call) => call.includes("--abort")));
      }),
  ),
);

it.live("a merge-base that fails is an error and no merge is tried", () =>
  usingFakeGit(
    "mg-base-fails",
    `d="$(dirname "$0")"\necho "CALL $*" >> "$d/log"\ncase "$*" in\n*merge-base*) echo "fatal: bad object" >&2; exit 128;;\n*rev-parse*) echo ${SOME_SHA};;\nesac`,
    (fake) =>
      Effect.gen(function* () {
        const error = yield* checkoutWithFake(fake, fake.options()).pipe(Effect.flip);
        const failed = expectFailed(error);
        assert.strictEqual(failed.args, `merge-base --is-ancestor ${BASE} HEAD`);
        assert.strictEqual(failed.status, 128);
        assert.isFalse(recordedCalls(fake).some((call) => call.includes(" merge --")));
      }),
  ),
);

it.live("a merge that prints more than the cap still merges", () =>
  usingFakeGit(
    "mg-loud",
    `case "$*" in\n*merge-base*) exit 1;;\n*HEAD^1*) echo ${SOME_SHA}; echo ${BASE};;\n*rev-parse*) echo ${SOME_SHA};;\n*" merge "*) printf '%0200d\\n' 0; printf '%0200d\\n' 0 >&2;;\nesac`,
    (fake) =>
      Effect.gen(function* () {
        const made = yield* checkoutWithFake(fake, fake.options({ gitTailBytes: 100 }));
        assert.strictEqual(made.merge._tag, "merged");
      }),
  ),
);

it.live("removing a checkout deletes the directory", () =>
  Effect.gen(function* () {
    const remote = makeRemote("rm-plain");
    const dataDir = tempDir("rm-plain-data");
    const run = newRunId(REPO, "10", 1);
    const sha = remote.push([["README", "pushed\n"]]);
    Ledger.create(dataDir, run, { clock: ticking(T0, 1000) }).close();
    const gate = yield* FactoryGate;
    // Project code leaves files of every kind behind.
    const result = yield* gate.run({
      ...baseInput(remote, dataDir, run, sha, sha),
      gate: ["echo x > untracked.txt && mkdir -p target/debug && echo x > target/debug/out"],
    });
    assert.strictEqual(result._tag, "pass");
    if (result._tag !== "pass") return;
    assert.isFalse(NodeFS.existsSync(result.dir));
    // Nothing else of the primary changed.
    assert.strictEqual(git(remote.primary, "status", "--porcelain"), "");
  }).pipe(provided),
);

it.live("removing a symlink removes the link and never what it points at", () =>
  Effect.gen(function* () {
    const remote = makeRemote("rm-symlink");
    const dataDir = tempDir("rm-symlink-data");
    const run = newRunId(REPO, "10", 1);
    const sha = remote.push([["README", "pushed\n"]]);
    Ledger.create(dataDir, run, { clock: ticking(T0, 1000) }).close();
    const target = NodePath.join(remote.root, "precious");
    NodeFS.mkdirSync(target);
    NodeFS.writeFileSync(NodePath.join(target, "keep"), "x");
    const root = gateRoot(dataDir, run);
    // A leftover that is a link to a directory: unlinked, never followed.
    NodeFS.mkdirSync(root, { recursive: true });
    NodeFS.symlinkSync(target, NodePath.join(root, "stale"));
    NodeFS.symlinkSync(target, NodePath.join(root, "1"));
    const gate = yield* FactoryGate;
    // And a link inside a checkout is unlinked too.
    const result = yield* gate.run({
      ...baseInput(remote, dataDir, run, sha, sha),
      gate: [`ln -s '${target}' escape`],
    });
    assert.strictEqual(result._tag, "pass");
    assert.isTrue(NodeFS.existsSync(NodePath.join(target, "keep")));
    assert.isFalse(NodeFS.existsSync(root));
  }).pipe(provided),
);

it.live(
  "a checkout inits, fetches, checks out, reads its head and checks the tree in that order",
  () =>
    usingFakeGit("co-order", LOGGING_GIT, (fake) =>
      Effect.gen(function* () {
        const made = yield* checkoutWithFake(
          fake,
          fake.options({ remoteBase: "https://example.test" }),
        );
        assert.strictEqual(made.head, SOME_SHA);
        const calls = recordedCalls(fake);
        const heads = calls.map((c) => c.split("\n")[0]!);
        const at = (what: string) => {
          const index = heads.findIndex((c) => c.includes(` ${what}`));
          assert.isAtLeast(index, 0, `no ${what} in ${heads.join("\n")}`);
          return index;
        };
        const order = [
          at("init"),
          at("fetch"),
          at("checkout"),
          at("rev-parse"),
          at("status"),
          at("merge-base"),
        ];
        assert.isTrue(
          order.every((value, i) => i === 0 || order[i - 1]! < value),
          heads.join("\n"),
        );
        // The base is an ancestor for this `git` (exit 0), so there is no merge.
        assert.strictEqual(heads.length, 6, heads.join("\n"));
        // The remote is the URL the daemon builds from the repo, and no remote name or git
        // config names it.
        const fetch = heads[at("fetch")]!;
        assert.include(fetch, ` https://example.test/${REPO}.git ${SOME_SHA} ${BASE}`);
        for (const flag of ["--no-tags", "--no-recurse-submodules", "--no-write-fetch-head"]) {
          assert.include(fetch, flag);
        }
        assert.notInclude(fetch, "origin");
        // HTTP/1.1, after the credential settings: HTTP/2 framing errors are what a flaky link gives.
        assert.include(fetch, "-c http.version=HTTP/1.1");
        assert.isAbove(
          fetch.indexOf("-c http.version=HTTP/1.1"),
          fetch.indexOf("credential.helper"),
        );
        assert.include(heads[at("init")]!, "--template=");
        const checkoutCall = heads[at("checkout")]!;
        for (const flag of ["--detach", "--no-recurse-submodules", SOME_SHA]) {
          assert.include(checkoutCall, flag);
        }
        const status = heads[at("status")]!;
        for (const flag of ["--porcelain", "--ignored", "--untracked-files=all"]) {
          assert.include(status, flag);
        }
        // The hardening is on every call: no hooks, no fsmonitor, no line-ending conversion, no
        // `ext` transport, and no `file` transport when the remote is not a local path.
        for (const head of heads) {
          for (const setting of [
            "core.hooksPath=/dev/null",
            "core.fsmonitor=false",
            "core.autocrlf=false",
            "core.attributesFile=/dev/null",
            "core.excludesFile=/dev/null",
            "protocol.ext.allow=never",
            "protocol.file.allow=never",
          ]) {
            assert.include(head, setting);
          }
        }
        // Only the fetch carries credentials, and they come from gh, never from git config.
        heads.forEach((head, i) => {
          assert.strictEqual(
            head.includes("credential.helper=!gh auth git-credential"),
            i === at("fetch"),
            head,
          );
        });
        assert.include(fetch, "-c credential.helper= -c credential.helper=!gh auth git-credential");
      }),
    ),
);

it.live("a local remote allows the file transport and nothing else does", () =>
  usingFakeGit("co-file-allow", LOGGING_GIT, (fake) =>
    Effect.gen(function* () {
      yield* checkoutWithFake(fake, fake.options({ remoteBase: "file:///srv/remotes" }));
      const calls = recordedCalls(fake);
      assert.isAbove(calls.length, 1);
      for (const call of calls) {
        const head = call.split("\n")[0]!;
        assert.include(head, "protocol.file.allow=always");
        assert.include(head, "protocol.ext.allow=never");
      }
    }),
  ),
);

it.live("a gh config dir reaches the fetch and no other git call", () =>
  usingFakeGit("co-gh-config-dir", LOGGING_GIT, (fake) =>
    Effect.gen(function* () {
      yield* checkoutWithFake(fake, fake.options({ ghConfigDir: "/factory/gh" }));
      const calls = recordedCalls(fake);
      assert.isAbove(calls.length, 1);
      for (const call of calls) {
        const head = call.split("\n")[0]!;
        const has = call.split("\n").some((l) => l === "GH_CONFIG_DIR=/factory/gh");
        assert.strictEqual(has, head.includes(" fetch"), call);
      }
    }),
  ),
);

it.live("the fetch inherits the login variables and no other call and no other variable does", () =>
  usingFakeGit("co-login-env", LOGGING_GIT, (fake) =>
    withEnv(
      {
        GH_TOKEN: "tok-a",
        GITHUB_TOKEN: "tok-b",
        XDG_CONFIG_HOME: "/xdg",
        GH_CONFIG_DIR: "/gh-config",
        SSH_AUTH_SOCK: "/agent",
        T3_TOKEN: "tok-d",
        GIT_ASKPASS: "askpass",
      },
      Effect.gen(function* () {
        yield* checkoutWithFake(fake, fake.options());
        for (const call of recordedCalls(fake)) {
          const head = call.split("\n")[0]!;
          const lines = call.split("\n");
          const isFetch = head.includes(" fetch");
          for (const line of [
            "GH_TOKEN=tok-a",
            "GITHUB_TOKEN=tok-b",
            "XDG_CONFIG_HOME=/xdg",
            "GH_CONFIG_DIR=/gh-config",
          ]) {
            assert.strictEqual(lines.includes(line), isFetch, `${line} in ${head}`);
          }
          for (const name of ["SSH_AUTH_SOCK=", "T3_TOKEN=", "GIT_ASKPASS="]) {
            assert.isFalse(
              lines.some((l) => l.startsWith(name)),
              `${name} in ${head}`,
            );
          }
        }
      }),
    ),
  ),
);

it.live(
  "every git call gets no global or system config, no replace objects and no lfs smudge",
  () =>
    usingFakeGit("co-env", LOGGING_GIT, (fake) =>
      withEnv(
        { SSH_AUTH_SOCK: "/agent" },
        Effect.gen(function* () {
          yield* checkoutWithFake(fake, fake.options());
          const calls = recordedCalls(fake);
          assert.strictEqual(calls.length, 6);
          for (const call of calls) {
            const lines = call.split("\n");
            for (const line of [
              "GIT_CONFIG_NOSYSTEM=1",
              "GIT_CONFIG_GLOBAL=/dev/null",
              "GIT_NO_REPLACE_OBJECTS=1",
              "GIT_LFS_SKIP_SMUDGE=1",
              "GIT_TERMINAL_PROMPT=0",
              "LC_ALL=C",
            ]) {
              assert.include(lines, line, `${line} missing from ${call}`);
            }
            assert.isFalse(
              lines.some((l) => l.startsWith("SSH_AUTH_SOCK=")),
              call,
            );
          }
        }),
      ),
    ),
);

it.live("a checkout whose files are not the commit is refused", () =>
  Effect.gen(function* () {
    // The fake `git` finds the head right and `git status` finds something.
    const dirty = yield* usingFakeGit(
      "co-dirty",
      `case "$*" in\n*rev-parse*) echo ${SOME_SHA};;\n*status*) printf ' M README\\n?? stray\\n';;\nesac`,
      (fake) => checkoutWithFake(fake, fake.options()).pipe(Effect.flip),
    );
    assert.strictEqual(dirty._tag, "WorkspaceUnexpectedError");
    assert.include(dirty.message, "the checkout is not exactly the commit: ");
    assert.include(dirty.message, " M README; ?? stray");
    // And a head that is not the commit asked for.
    const wrong = yield* usingFakeGit(
      "co-wrong-head",
      `case "$*" in\n*rev-parse*) echo bbbbbbb0123456789abcdef0123456789abcdef0;;\nesac`,
      (fake) => checkoutWithFake(fake, fake.options()).pipe(Effect.flip),
    );
    assert.strictEqual(wrong._tag, "WorkspaceUnexpectedError");
    assert.strictEqual(
      wrong.message,
      `unexpected output from git: the checkout is at bbbbbbb0123456789abcdef0123456789abcdef0 but the pull request's head is ${SOME_SHA}`,
    );
    // And a `rev-parse` that does not print a commit id.
    const noId = yield* usingFakeGit(
      "co-no-id",
      `case "$*" in\n*rev-parse*) echo not-a-commit;;\nesac`,
      (fake) => checkoutWithFake(fake, fake.options()).pipe(Effect.flip),
    );
    assert.strictEqual(
      noId.message,
      "unexpected output from git: `rev-parse HEAD` did not print a commit id",
    );
  }),
);

it.live("a git that is not on PATH fails the call and leaves no directory", () =>
  Effect.gen(function* () {
    const dir = tempDir("co-no-git");
    const error = yield* checkout(
      // A PATH with no git on it.
      { env: { PATH: NodePath.join(dir, "empty") } },
      REPO,
      SOME_SHA,
      BASE,
      NodePath.join(dir, "wt"),
    ).pipe(Effect.flip);
    assert.strictEqual(error._tag, "WorkspaceFailedError");
    assert.isFalse(NodeFS.existsSync(NodePath.join(dir, "wt")));
  }),
);

it.live("a checkout that runs past its limit is killed with everything it started", () =>
  usingFakeGit("co-hang", "sleep 3032 &\nsleep 3032", (fake) =>
    Effect.gen(function* () {
      const started = yield* Clock.currentTimeMillis;
      const error = yield* checkoutWithFake(fake, fake.options({ checkoutTimeoutMs: 300 })).pipe(
        Effect.flip,
      );
      assert.isBelow((yield* Clock.currentTimeMillis) - started, 10_000);
      assert.strictEqual(error._tag, "WorkspaceFailedError");
      const failed = expectFailed(error);
      assert.strictEqual(failed.status, null);
      assert.include(failed.stderr, "did not finish within 300ms");
      // The script's own process group, not a search by name: another run of this suite on the
      // same machine has a `sleep 3032` of its own.
      yield* Effect.promise(() =>
        vi.waitFor(() => assert.isFalse(fake.groupAlive(), "a sleeper outlived the call"), {
          timeout: 3_000,
          interval: 30,
        }),
      );
      assert.isFalse(NodeFS.existsSync(NodePath.join(fake.dir, "wt")));
    }),
  ),
);

/** The input of a gate with the defaults the tests share; each test overrides what it needs. */
function baseInput(
  remote: Remote,
  dataDir: string,
  run: GateInput["run"],
  head: string,
  base: string,
): GateInput {
  return {
    dataDir,
    run,
    attempt: 1,
    repo: REPO,
    head,
    base,
    provision: [],
    gate: [],
    maxConcurrentGates: 2,
    options: { remoteBase: remote.base, clock: ticking(T0, 1000) },
  };
}

const result = (command: string, exitCode: number, durationMs: number): CommandResult => ({
  command,
  exitCode,
  durationMs,
  timedOut: false,
  output: "",
});

it("the results comment says the commands ran in a fresh checkout of the pr head", () => {
  assert.strictEqual(
    gateResultsComment([result("cargo test", 0, 1_000)], 2, SOME_SHA, BASE),
    `**Factory gate: passed** (attempt 2, run by the factory in a fresh checkout of the pull request's head \`${SHORT}\` merged with the base branch tip \`${BASE_SHORT}\`)\n\n| Command | Exit | Time |\n|---|---|---|\n| \`cargo test\` | 0 | 1.0 s |`,
  );
});

it("the comment for a pass on a pull request that was ready already says it passed again", () => {
  assert.strictEqual(
    regateResultsComment([result("cargo test", 0, 1_000)], 2, SOME_SHA, BASE),
    `**Factory gate: passed again** (attempt 2, run by the factory in a fresh checkout of the pull request's head \`${SHORT}\` merged with the base branch tip \`${BASE_SHORT}\`)\n\n| Command | Exit | Time |\n|---|---|---|\n| \`cargo test\` | 0 | 1.0 s |`,
  );
  // The same table as the first pass's comment: only the verdict differs.
  const first = gateResultsComment([result("a | b", 1, 12_345)], 1, SOME_SHA, "");
  assert.strictEqual(
    regateResultsComment([result("a | b", 1, 12_345)], 1, SOME_SHA, ""),
    first.replace("passed**", "passed again**"),
  );
});

it("the results comment rounds the time to a tenth and says unknown for a missing base", () => {
  const comment = gateResultsComment(
    [result("a", 0, 49), result("b", 0, 50), result("c", 1, 12_345), result("d", -1, 0)],
    1,
    SOME_SHA,
    "",
  );
  assert.include(comment, "merged with the base branch tip `unknown`)");
  assert.deepStrictEqual(comment.split("\n").slice(-4), [
    "| `a` | 0 | 0.0 s |",
    "| `b` | 0 | 0.1 s |",
    "| `c` | 1 | 12.3 s |",
    "| `d` | -1 | 0.0 s |",
  ]);
});

it("the results comment keeps a command inside its code span", () => {
  const comment = gateResultsComment(
    [
      result("echo a | cat", 0, 0),
      result("echo `date`", 0, 0),
      result("`lead", 0, 0),
      result("x".repeat(400), 0, 0),
      result("two\nlines\tand tab", 0, 0),
      result("hidden‮text", 0, 0),
    ],
    1,
    SOME_SHA,
    BASE,
  );
  const rows = comment.split("\n").slice(-6);
  assert.strictEqual(rows[0], "| `echo a \\| cat` | 0 | 0.0 s |");
  assert.strictEqual(rows[1], "| `` echo `date` `` | 0 | 0.0 s |");
  assert.strictEqual(rows[2], "| `` `lead `` | 0 | 0.0 s |");
  assert.strictEqual(rows[3], `| \`${"x".repeat(300)}…\` | 0 | 0.0 s |`);
  assert.strictEqual(rows[4], "| `two lines and tab` | 0 | 0.0 s |");
  assert.strictEqual(rows[5], "| `hidden text` | 0 | 0.0 s |");
});

it("sanitize turns control and hidden-text characters into spaces", () => {
  assert.strictEqual(sanitize("a\u001bb\u0000c\u007fd\u0085e", false), "a b c d e");
  assert.strictEqual(sanitize("a\nb\tc", false), "a b c");
  assert.strictEqual(sanitize("a\nb\tc", true), "a\nb\tc");
  assert.strictEqual(sanitize("x y z​w‏‪⁩﻿v", true), "x y z w    v");
});

/** The ledger's lines of the run, as read back. */
const entries = (dataDir: string, run: GateInput["run"]) => readRun(dataDir, run).entries;

/**
 * A `git` first on PATH that waits `seconds` before handing over to the real one, so every git
 * call of a checkout takes at least that long and the checkout's share of an attempt's time is
 * known. The gate commands do not see it: only git calls get `options.env`.
 */
const slowGit = (name: string, seconds: number): Pick<GateOptions, "env"> => {
  const dir = tempDir(name);
  NodeFS.writeFileSync(
    NodePath.join(dir, "git"),
    `#!/bin/sh\nsleep ${seconds}\nPATH="\${PATH#*:}" exec git "$@"\n`,
    { mode: 0o755 },
  );
  return { env: { PATH: `${dir}:${globalThis.process.env.PATH ?? ""}` } };
};

/** The `total_ms` of the run's one `gate_finished` line. */
const totalMs = (dataDir: string, run: GateInput["run"]): number => {
  const finished = entries(dataDir, run).filter((l) => l.event === "gate_finished");
  assert.strictEqual(finished.length, 1);
  return (finished[0]!.data as { total_ms: number }).total_ms;
};

it.live("the attempt's time covers the checkout, not only the commands", () =>
  Effect.gen(function* () {
    // A checkout of a head that holds the base makes six git calls, each at least 0.3 s here:
    // what the commands took cannot account for the total on its own.
    const remote = makeRemote("gate-timing");
    const dataDir = tempDir("gate-timing-data");
    const run = newRunId(REPO, "10", 1);
    const sha = remote.push([["README", "pushed\n"]]);
    Ledger.create(dataDir, run, { clock: ticking(T0, 1000) }).close();
    const input = baseInput(remote, dataDir, run, sha, sha);
    const out = yield* (yield* FactoryGate).run({
      ...input,
      gate: ["true"],
      options: { ...input.options, ...slowGit("gate-timing-git", 0.3) },
    });
    assert.strictEqual(out._tag, "pass");
    if (out._tag !== "pass") return;
    const commands = out.commands.reduce((sum, c) => sum + c.durationMs, 0);
    assert.isAtLeast(totalMs(dataDir, run), commands + 1_500);
  }).pipe(provided),
);

it.live(
  "the gate runs in a fresh checkout of the pr head and never in the session's worktree",
  () =>
    Effect.gen(function* () {
      const remote = makeRemote("gate-fresh");
      const dataDir = tempDir("gate-fresh-data");
      const run = newRunId(REPO, "10", 1);
      const sha = remote.push([["README", "pushed\n"]]);
      Ledger.create(dataDir, run, { clock: ticking(T0, 1000) }).close();
      const gate = yield* FactoryGate;
      const out = yield* gate.run({
        ...baseInput(remote, dataDir, run, sha, sha),
        gate: ["test -f README", "cat README"],
      });
      const dir = NodePath.join(dataDir, "gate/rawphp__softfac__10__1/1");
      assert.strictEqual(out._tag, "pass");
      if (out._tag !== "pass") return;
      assert.strictEqual(out.dir, dir);
      assert.strictEqual(out.gateCount, 2);
      assert.deepStrictEqual(
        out.commands.map((c) => [c.command, c.exitCode, c.timedOut]),
        [
          ["test -f README", 0, false],
          ["cat README", 0, false],
        ],
      );
      assert.strictEqual(out.commands[1]!.output, "pushed\n");
      // The ledger says where the gate ran and on which commit, before the commands' lines.
      const lines = entries(dataDir, run);
      assert.deepStrictEqual(
        lines.map((l) => l.event),
        ["gate_checkout", "gate_command", "gate_command", "gate_finished"],
      );
      assert.deepStrictEqual(lines[0]!.data, { attempt: 1, dir, sha, base_sha: sha });
      assert.deepStrictEqual(lines[0]!.cause, {
        step: "gate",
        reason: "gate-checkout-made",
        attempt: 1,
      });
      out.commands.forEach((c, i) => {
        assert.deepStrictEqual(lines[i + 1]!.data, {
          attempt: 1,
          command: c.command,
          exit_code: 0,
          duration_ms: c.durationMs,
        });
        assert.deepStrictEqual(lines[i + 1]!.cause, {
          step: "gate",
          reason: "gate-command-ran",
          command: c.command,
          attempt: 1,
        });
      });
      // The attempt ends with how long it took, from the start of the checkout to the end of
      // the last command: at least what the commands themselves took.
      const finished = lines.at(-1)!;
      const total = (finished.data as { attempt: number; total_ms: number }).total_ms;
      assert.strictEqual((finished.data as { attempt: number }).attempt, 1);
      assert.isTrue(Number.isInteger(total), String(total));
      assert.isAtLeast(
        total,
        out.commands.reduce((sum, c) => sum + c.durationMs, 0),
      );
      assert.deepStrictEqual(finished.cause, { step: "gate", reason: "gate-finished", attempt: 1 });
      // The primary checkout was not used: no new worktree, and the commit is not in its object
      // store.
      assert.notStrictEqual(spawnGit(remote.primary, ["cat-file", "-e", sha]).status, 0);
      assert.strictEqual(
        git(remote.primary, "worktree", "list", "--porcelain").split("worktree ").length - 1,
        1,
      );
      // Nothing is left under the run's gate directory, and no lock.
      assert.isFalse(NodeFS.existsSync(dir));
      assert.isFalse(NodeFS.existsSync(NodePath.join(dataDir, "gate", runIdToString(run))));
      assert.strictEqual(gateLocksHeld(dataDir), 0);
    }).pipe(provided),
);

it.live("provision runs before the gate and a failing provision command stops the attempt", () =>
  Effect.gen(function* () {
    const remote = makeRemote("gate-provision");
    const dataDir = tempDir("gate-provision-data");
    const run = newRunId(REPO, "10", 1);
    const sha = remote.push([["README", "pushed\n"]]);
    Ledger.create(dataDir, run, { clock: ticking(T0, 1000) }).close();
    const marker = NodePath.join(dataDir, "gate-ran");
    const gate = yield* FactoryGate;
    // Provision runs first and in order: the gate command sees the file provision made.
    const ok = yield* gate.run({
      ...baseInput(remote, dataDir, run, sha, sha),
      provision: ["touch provisioned"],
      gate: ["test -f provisioned"],
    });
    assert.strictEqual(ok._tag, "pass");
    if (ok._tag !== "pass") return;
    assert.strictEqual(ok.gateCount, 1);
    assert.strictEqual(ok.commands.length, 2);

    const run2 = newRunId(REPO, "10", 2);
    Ledger.create(dataDir, run2, { clock: ticking(T0, 1000) }).close();
    const failed = yield* gate.run({
      ...baseInput(remote, dataDir, run2, sha, sha),
      provision: ["test -f README", "exit 3"],
      gate: [`touch '${marker}'`],
    });
    assert.strictEqual(failed._tag, "fail");
    if (failed._tag !== "fail") return;
    assert.strictEqual(failed.gateCount, 0);
    assert.strictEqual(failed.failure.command, "exit 3");
    assert.strictEqual(failed.failure.exitCode, 3);
    assert.isFalse(NodeFS.existsSync(marker));
    // Each command's line is in the ledger, the failed one included.
    const lines = entries(dataDir, run2);
    assert.deepStrictEqual(
      lines.map((l) => l.event),
      ["gate_checkout", "gate_command", "gate_command", "gate_finished"],
    );
    assert.deepStrictEqual(
      lines
        .filter((l) => l.event === "gate_command")
        .map((l) => [
          (l.data as { command: string }).command,
          (l.data as { exit_code: number }).exit_code,
        ]),
      [
        ["test -f README", 0],
        ["exit 3", 3],
      ],
    );
  }).pipe(provided),
);

it.live("provision and gate commands, and what they start, run at niceness 10", () =>
  Effect.gen(function* () {
    const remote = makeRemote("gate-nice");
    const dataDir = tempDir("gate-nice-data");
    const run = newRunId(REPO, "10", 1);
    const sha = remote.push([["README", "pushed\n"]]);
    Ledger.create(dataDir, run, { clock: ticking(T0, 1000) }).close();
    const own = NodeOS.getPriority();
    const gate = yield* FactoryGate;
    // The trailing `true` stops dash from exec'ing the inner sh in place of the wrapper, so the
    // inner sh is a process the command forked: its parent is the wrapper.
    const result = yield* gate.run({
      ...baseInput(remote, dataDir, run, sha, sha),
      provision: ["ps -o nice= -p $$"],
      gate: ["ps -o nice= -p $$", "echo $$; sh -c 'echo $PPID; ps -o nice= -p $$'; true"],
    });
    assert.strictEqual(result._tag, "pass");
    if (result._tag !== "pass") return;
    // A host whose server already runs above 10 keeps its own floor.
    const expected = String(Math.max(10, own));
    const [provisioned, gated, forked] = result.commands.map((c) => c.output.trim());
    assert.strictEqual(provisioned, expected);
    assert.strictEqual(gated, expected);
    const [wrapper, parent, inner] = forked!.split(/\s+/);
    assert.strictEqual(parent, wrapper);
    assert.strictEqual(inner, expected);
    assert.strictEqual(NodeOS.getPriority(), own);
  }).pipe(provided),
);

it.live("a failing gate command ends the attempt and the later commands do not run", () =>
  Effect.gen(function* () {
    const remote = makeRemote("gate-fail");
    const dataDir = tempDir("gate-fail-data");
    const run = newRunId(REPO, "10", 1);
    const sha = remote.push([["README", "pushed\n"]]);
    Ledger.create(dataDir, run, { clock: ticking(T0, 1000) }).close();
    const marker = NodePath.join(dataDir, "third-ran");
    const gate = yield* FactoryGate;
    const out = yield* gate.run({
      ...baseInput(remote, dataDir, run, sha, sha),
      gate: ["true", "echo boom; exit 4", `touch '${marker}'`],
    });
    assert.strictEqual(out._tag, "fail");
    if (out._tag !== "fail") return;
    assert.strictEqual(out.commands.length, 2);
    assert.strictEqual(out.gateCount, 2);
    assert.strictEqual(out.failure, out.commands[1]);
    assert.strictEqual(out.failure.exitCode, 4);
    assert.strictEqual(out.failure.output, "boom\n");
    assert.isFalse(NodeFS.existsSync(marker));
    assert.isFalse(NodeFS.existsSync(out.dir));
    const lines = entries(dataDir, run);
    assert.deepStrictEqual(
      lines.map((l) => l.event),
      ["gate_checkout", "gate_command", "gate_command", "gate_finished"],
    );
    assert.strictEqual((lines[2]!.data as { exit_code: number }).exit_code, 4);
  }).pipe(provided),
);

it.live("a command that runs past its limit is killed and counts as a failure", () =>
  Effect.gen(function* () {
    const remote = makeRemote("gate-timeout");
    const dataDir = tempDir("gate-timeout-data");
    const run = newRunId(REPO, "10", 1);
    const sha = remote.push([["README", "pushed\n"]]);
    Ledger.create(dataDir, run, { clock: ticking(T0, 1000) }).close();
    const gate = yield* FactoryGate;
    const out = yield* gate.run({
      ...baseInput(remote, dataDir, run, sha, sha),
      gate: ["sleep 60"],
      options: { remoteBase: remote.base, clock: ticking(T0, 1000), commandTimeoutMs: 300 },
    });
    assert.strictEqual(out._tag, "fail");
    if (out._tag !== "fail") return;
    assert.strictEqual(out.failure.timedOut, true);
    assert.strictEqual(out.failure.exitCode, -1);
    // The failure message tells the session the limit the command ran into.
    assert.strictEqual(out.failure.timeoutMs, 300);
    const line = entries(dataDir, run)[1]!;
    assert.strictEqual((line.data as { exit_code: number }).exit_code, -1);
  }).pipe(provided),
);

it.live("a command whose output is longer than the tail says it was cut", () =>
  Effect.gen(function* () {
    const remote = makeRemote("gate-truncated");
    const dataDir = tempDir("gate-truncated-data");
    const run = newRunId(REPO, "10", 1);
    const sha = remote.push([["README", "pushed\n"]]);
    Ledger.create(dataDir, run, { clock: ticking(T0, 1000) }).close();
    const gate = yield* FactoryGate;
    const out = yield* gate.run({
      ...baseInput(remote, dataDir, run, sha, sha),
      gate: ["head -c 40000 /dev/zero | tr '\\0' a; exit 3", "true"],
    });
    assert.strictEqual(out._tag, "fail");
    if (out._tag !== "fail") return;
    assert.strictEqual(out.failure.truncated, true);
    assert.strictEqual(out.failure.timeoutMs, undefined);
    assert.ok(out.failure.output.length < 40_000);
  }).pipe(provided),
);

it.live("a command whose output fits in the tail is not marked cut", () =>
  Effect.gen(function* () {
    const remote = makeRemote("gate-whole");
    const dataDir = tempDir("gate-whole-data");
    const run = newRunId(REPO, "10", 1);
    const sha = remote.push([["README", "pushed\n"]]);
    Ledger.create(dataDir, run, { clock: ticking(T0, 1000) }).close();
    const gate = yield* FactoryGate;
    const out = yield* gate.run({
      ...baseInput(remote, dataDir, run, sha, sha),
      gate: ["cat README; exit 3"],
    });
    assert.strictEqual(out._tag, "fail");
    if (out._tag !== "fail") return;
    assert.strictEqual(out.failure.truncated, undefined);
    assert.strictEqual(out.failure.output, "pushed\n");
  }).pipe(provided),
);

it.live("the lock file exists while a command runs and is gone after", () =>
  Effect.gen(function* () {
    const remote = makeRemote("gate-lock");
    const dataDir = tempDir("gate-lock-data");
    const run = newRunId(REPO, "10", 1);
    const sha = remote.push([["README", "pushed\n"]]);
    Ledger.create(dataDir, run, { clock: ticking(T0, 1000) }).close();
    const lock = gateLockFile(dataDir, run);
    assert.strictEqual(lock, NodePath.join(dataDir, "gates", "rawphp__softfac__10__1.lock"));
    const gate = yield* FactoryGate;
    const out = yield* gate.run({
      ...baseInput(remote, dataDir, run, sha, sha),
      gate: [`test -f '${lock}'`],
    });
    assert.strictEqual(out._tag, "pass");
    assert.isFalse(NodeFS.existsSync(lock));
    assert.strictEqual(NodeFS.statSync(NodePath.join(dataDir, "gates")).mode & 0o777, 0o700);
  }).pipe(provided),
);

it.live("the lock is released when the gate fails with an error", () =>
  Effect.gen(function* () {
    const remote = makeRemote("gate-lock-error");
    const dataDir = tempDir("gate-lock-error-data");
    const run = newRunId(REPO, "10", 1);
    Ledger.create(dataDir, run, { clock: ticking(T0, 1000) }).close();
    const gate = yield* FactoryGate;
    // A head the remote does not have: the fetch fails, no attempt is used.
    const error = yield* gate
      .run(baseInput(remote, dataDir, run, SOME_SHA, SOME_SHA))
      .pipe(Effect.flip);
    assert.strictEqual(error._tag, "WorkspaceFailedError");
    assert.strictEqual(gateLocksHeld(dataDir), 0);
    assert.deepStrictEqual(entries(dataDir, run), []);
    assert.isFalse(NodeFS.existsSync(NodePath.join(dataDir, "gate", runIdToString(run))));
  }).pipe(provided),
);

it.live("a head that is not a full commit id is refused before any directory is made", () =>
  Effect.gen(function* () {
    const remote = makeRemote("gate-bad-head");
    const dataDir = tempDir("gate-bad-head-data");
    const run = newRunId(REPO, "10", 1);
    Ledger.create(dataDir, run, { clock: ticking(T0, 1000) }).close();
    const gate = yield* FactoryGate;
    const error = yield* gate.run(baseInput(remote, dataDir, run, "main", BASE)).pipe(Effect.flip);
    assert.strictEqual(error._tag, "WorkspaceUnexpectedError");
    assert.strictEqual(
      error.message,
      "unexpected output from git: the commits to check out are not full commit ids",
    );
    assert.isFalse(NodeFS.existsSync(NodePath.join(dataDir, "gate", runIdToString(run), "1")));
    assert.strictEqual(gateLocksHeld(dataDir), 0);
  }).pipe(provided),
);

it.live("a second run for the same run while one is running returns running", () =>
  Effect.gen(function* () {
    const remote = makeRemote("gate-running");
    const dataDir = tempDir("gate-running-data");
    const run = newRunId(REPO, "10", 1);
    const sha = remote.push([["README", "pushed\n"]]);
    Ledger.create(dataDir, run, { clock: ticking(T0, 1000) }).close();
    const started = NodePath.join(dataDir, "started");
    const release = NodePath.join(dataDir, "release");
    const gate = yield* FactoryGate;
    const input = {
      ...baseInput(remote, dataDir, run, sha, sha),
      gate: [`touch '${started}'; while [ ! -f '${release}' ]; do sleep 0.05; done`],
    };
    const first = yield* Effect.forkChild(gate.run(input));
    yield* Effect.gen(function* () {
      yield* Effect.promise(() =>
        vi.waitFor(
          () =>
            assert.isTrue(NodeFS.existsSync(started), "the first gate never started its command"),
          { timeout: 10_000, interval: 25 },
        ),
      );
      const before = entries(dataDir, run).length;
      const second = yield* gate.run(input);
      assert.deepStrictEqual(second, { _tag: "running" });
      // The second call wrote nothing and left the first one's checkout and lock alone.
      assert.strictEqual(entries(dataDir, run).length, before);
      assert.strictEqual(gateLocksHeld(dataDir), 1);
      assert.isTrue(NodeFS.existsSync(NodePath.join(dataDir, "gate/rawphp__softfac__10__1/1")));
    }).pipe(Effect.ensuring(Effect.sync(() => NodeFS.writeFileSync(release, ""))));
    const done = yield* Fiber.join(first);
    assert.strictEqual(done._tag, "pass");
    assert.strictEqual(gateLocksHeld(dataDir), 0);
  }).pipe(provided),
);

it.live("a gate is queued while max_concurrent_gates other locks are held", () =>
  Effect.gen(function* () {
    const remote = makeRemote("gate-queued");
    const dataDir = tempDir("gate-queued-data");
    const run = newRunId(REPO, "10", 1);
    const sha = remote.push([["README", "pushed\n"]]);
    Ledger.create(dataDir, run, { clock: ticking(T0, 1000) }).close();
    NodeFS.mkdirSync(NodePath.join(dataDir, "gates"), { recursive: true });
    const other = NodePath.join(dataDir, "gates", "someone__else__1__1.lock");
    NodeFS.writeFileSync(other, "");
    const gate = yield* FactoryGate;
    const queued = yield* gate.run({
      ...baseInput(remote, dataDir, run, sha, sha),
      maxConcurrentGates: 1,
    });
    assert.deepStrictEqual(queued, { _tag: "queued", running: 1, max: 1 });
    assert.deepStrictEqual(entries(dataDir, run), []);
    assert.isTrue(NodeFS.existsSync(other));
    assert.isFalse(NodeFS.existsSync(gateLockFile(dataDir, run)));
    // With room for a second gate, it runs.
    const out = yield* gate.run({
      ...baseInput(remote, dataDir, run, sha, sha),
      maxConcurrentGates: 2,
    });
    assert.strictEqual(out._tag, "pass");
    assert.isTrue(NodeFS.existsSync(other));
  }).pipe(provided),
);

it.live(
  "gateLockTimes dates each lock; clearGateLocks removes every lock file and nothing else",
  () =>
    Effect.gen(function* () {
      const dataDir = tempDir("gate-clear");
      // No gates directory yet.
      assert.strictEqual(yield* clearGateLocks(dataDir), 0);
      const gates = NodePath.join(dataDir, "gates");
      NodeFS.mkdirSync(gates, { recursive: true });
      NodeFS.writeFileSync(NodePath.join(gates, "a.lock"), "");
      NodeFS.writeFileSync(NodePath.join(gates, "b.lock"), "");
      NodeFS.writeFileSync(NodePath.join(gates, "notes.txt"), "keep");
      assert.strictEqual(gateLocksHeld(dataDir), 2);
      NodeFS.utimesSync(NodePath.join(gates, "a.lock"), 1_000, 1_000);
      assert.include(gateLockTimes(dataDir), 1_000_000);
      assert.strictEqual(gateLockTimes(dataDir).length, 2);
      assert.strictEqual(yield* clearGateLocks(dataDir), 2);
      assert.deepStrictEqual(NodeFS.readdirSync(gates), ["notes.txt"]);
      assert.strictEqual(gateLocksHeld(dataDir), 0);
    }),
);

it("the gate's paths are built from the validated run id", () => {
  const run = newRunId(REPO, "10", 1);
  assert.strictEqual(gateRoot("/data", run), "/data/gate/rawphp__softfac__10__1");
  assert.strictEqual(gateLockFile("/data", run), "/data/gates/rawphp__softfac__10__1.lock");
  assert.throws(() => gateRoot("/data", { repo: "../x/y", issue: "1", attempt: 1 }));
  assert.throws(() => gateLockFile("/data", { repo: "a/b", issue: "1", attempt: -1 }));
  // The log is outside the checkout and outside `<data>/gate/`.
  assert.strictEqual(gateLogPath("/data", run, 2), "/data/gate-logs/rawphp__softfac__10__1/2.log");
  assert.throws(() => gateLogPath("/data", { repo: "../x/y", issue: "1", attempt: 1 }, 1));
});

/**
 * The ledger's write and sync on the real file, except that the `write`th write fails having
 * written nothing and the `sync`th sync fails after its write landed (counting from one).
 */
const failingLedgerIo = (fail: { readonly write?: number; readonly sync?: number }): AppendIo => {
  let writes = 0;
  let syncs = 0;
  return {
    writeSync: (fd, buffer) => {
      writes += 1;
      if (writes === fail.write) throw new Error("injected disk error");
      return NodeFS.writeSync(fd, buffer);
    },
    fsyncSync: (fd) => {
      syncs += 1;
      if (syncs === fail.sync) throw new Error("injected disk error");
      NodeFS.fsyncSync(fd);
    },
  };
};

/** Runs `gate` commands on a fresh head with the ledger's io replaced; returns the error and the ledger's events. */
const gateWithLedgerIo = (name: string, gate: ReadonlyArray<string>, io: AppendIo) =>
  Effect.gen(function* () {
    const remote = makeRemote(name);
    const dataDir = tempDir(`${name}-data`);
    const run = newRunId(REPO, "10", 1);
    const sha = remote.push([["README", "pushed\n"]]);
    Ledger.create(dataDir, run, { clock: ticking(T0, 1000) }).close();
    const input = baseInput(remote, dataDir, run, sha, sha);
    const error = yield* (yield* FactoryGate)
      .run({ ...input, gate, options: { ...input.options, ledgerIo: io } })
      .pipe(Effect.flip);
    assert.strictEqual(gateLocksHeld(dataDir), 0);
    return { error, events: entries(dataDir, run).map((l) => l.event) };
  });

it.live(
  "a ledger failure after a command line went in is a GateRecordError: the attempt is used",
  () =>
    Effect.gen(function* () {
      // Write 1 is gate_checkout, 2 the first command's line, 3 the second's.
      const { error, events } = yield* gateWithLedgerIo(
        "gate-record-partial",
        ["true", "true", "true"],
        failingLedgerIo({ write: 3 }),
      );
      assert.strictEqual(error._tag, "GateRecordError");
      if (error._tag !== "GateRecordError") return;
      assert.strictEqual(error.attempt, 1);
      assert.instanceOf(error.cause, LedgerIoError);
      assert.deepStrictEqual(events, ["gate_checkout", "gate_command"]);
    }).pipe(provided),
);

it.live("a command line whose sync fails is in the ledger, so the attempt is used", () =>
  Effect.gen(function* () {
    const { error, events } = yield* gateWithLedgerIo(
      "gate-record-sync",
      ["true"],
      failingLedgerIo({ sync: 2 }),
    );
    assert.instanceOf(error, GateRecordError);
    assert.deepStrictEqual(events, ["gate_checkout", "gate_command"]);
  }).pipe(provided),
);

it.live("a timing line that cannot be written leaves the attempt's result as it is", () =>
  Effect.gen(function* () {
    // Write 1 is gate_checkout, 2 the command's line, 3 the timing line.
    const remote = makeRemote("gate-record-timing");
    const dataDir = tempDir("gate-record-timing-data");
    const run = newRunId(REPO, "10", 1);
    const sha = remote.push([["README", "pushed\n"]]);
    Ledger.create(dataDir, run, { clock: ticking(T0, 1000) }).close();
    const input = baseInput(remote, dataDir, run, sha, sha);
    const out = yield* (yield* FactoryGate).run({
      ...input,
      gate: ["true"],
      options: { ...input.options, ledgerIo: failingLedgerIo({ write: 3 }) },
    });
    assert.strictEqual(out._tag, "pass");
    assert.strictEqual(gateLocksHeld(dataDir), 0);
    assert.deepStrictEqual(
      entries(dataDir, run).map((l) => l.event),
      ["gate_checkout", "gate_command"],
    );
  }).pipe(provided),
);

it.live("a ledger failure before any command line went in uses no attempt", () =>
  Effect.gen(function* () {
    const { error, events } = yield* gateWithLedgerIo(
      "gate-record-none",
      ["true"],
      failingLedgerIo({ write: 2 }),
    );
    assert.instanceOf(error, LedgerIoError);
    assert.deepStrictEqual(events, ["gate_checkout"]);
  }).pipe(provided),
);

it.live("a conflict line whose sync fails is in the ledger, so the attempt is used", () =>
  Effect.gen(function* () {
    const remote = makeRemote("gate-record-conflict");
    const dataDir = tempDir("gate-record-conflict-data");
    const run = newRunId(REPO, "10", 1);
    const pr = remote.pushOn("pr", "main", [["README", "pr\n"]]);
    const base = remote.pushOn("main", "main", [["README", "base\n"]]);
    Ledger.create(dataDir, run, { clock: ticking(T0, 1000) }).close();
    const input = baseInput(remote, dataDir, run, pr, base);
    const error = yield* (yield* FactoryGate)
      .run({ ...input, options: { ...input.options, ledgerIo: failingLedgerIo({ sync: 2 }) } })
      .pipe(Effect.flip);
    assert.instanceOf(error, GateRecordError);
    assert.deepStrictEqual(
      entries(dataDir, run).map((l) => l.event),
      ["gate_checkout", "gate_command"],
    );
  }).pipe(provided),
);

it.live("a conflict with the base is a failed attempt with no command run", () =>
  Effect.gen(function* () {
    const remote = makeRemote("gate-conflict");
    const dataDir = tempDir("gate-conflict-data");
    const run = newRunId(REPO, "10", 1);
    const pr = remote.pushOn("pr", "main", [["README", "pr\n"]]);
    const base = remote.pushOn("main", "main", [["README", "base\n"]]);
    Ledger.create(dataDir, run, { clock: ticking(T0, 1000) }).close();
    const marker = NodePath.join(dataDir, "ran");
    const gate = yield* FactoryGate;
    const input = baseInput(remote, dataDir, run, pr, base);
    const out = yield* gate.run({
      ...input,
      provision: [`touch '${marker}'`],
      gate: [`touch '${marker}'`],
      options: { ...input.options, ...slowGit("gate-conflict-git", 0.3) },
    });
    const dir = NodePath.join(dataDir, "gate/rawphp__softfac__10__1/1");
    assert.deepStrictEqual(out, { _tag: "conflict", dir, paths: ["README"] });
    assert.isFalse(NodeFS.existsSync(marker));
    const lines = entries(dataDir, run);
    assert.deepStrictEqual(
      lines.map((l) => l.event),
      ["gate_checkout", "gate_command", "gate_finished"],
    );
    assert.deepStrictEqual(lines[0]!.data, { attempt: 1, dir, sha: pr, base_sha: base });
    assert.deepStrictEqual(lines[1]!.data, {
      attempt: 1,
      command: "softfac: merge the base branch into the head",
      exit_code: 1,
      duration_ms: 0,
    });
    assert.strictEqual((lines[2]!.data as { attempt: number }).attempt, 1);
    // Nine git calls at 0.3 s or more each, up to and including the aborted merge.
    assert.isAtLeast((lines[2]!.data as { total_ms: number }).total_ms, 2_000);
    assert.deepStrictEqual(lines[1]!.cause, {
      step: "gate",
      reason: "gate-merge-conflict",
      attempt: 1,
    });
    // The checkout is removed.
    assert.isFalse(NodeFS.existsSync(dir));
    assert.strictEqual(gateLocksHeld(dataDir), 0);
  }).pipe(provided),
);

it.live("a head behind the base is gated on the merged tree", () =>
  Effect.gen(function* () {
    const remote = makeRemote("gate-merged");
    const dataDir = tempDir("gate-merged-data");
    const run = newRunId(REPO, "10", 1);
    const old = git(remote.primary, "rev-parse", "HEAD").trim();
    const base = remote.pushOn("main", "main", [["base.txt", "base\n"]]);
    Ledger.create(dataDir, run, { clock: ticking(T0, 1000) }).close();
    const gate = yield* FactoryGate;
    const out = yield* gate.run({
      ...baseInput(remote, dataDir, run, old, base),
      gate: ["test -f base.txt", "test -f README"],
    });
    assert.strictEqual(out._tag, "pass");
    const first = entries(dataDir, run)[0]!;
    assert.deepStrictEqual((first.data as { sha: string }).sha, old);
    assert.deepStrictEqual((first.data as { base_sha: string }).base_sha, base);
  }).pipe(provided),
);

/** Makes `dir/sub/f` and takes the write permission off `dir/sub`, so `dir` cannot be removed. */
const lockDown = (dir: string) => {
  NodeFS.mkdirSync(NodePath.join(dir, "sub"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(dir, "sub", "f"), "x");
  NodeFS.chmodSync(NodePath.join(dir, "sub"), 0o500);
};

const unlock = (dir: string) => {
  try {
    NodeFS.chmodSync(NodePath.join(dir, "sub"), 0o700);
  } catch {
    // Not there.
  }
};

it.live("a checkout that cannot be removed leaves a gate_cleanup_failed line", () =>
  Effect.gen(function* () {
    if (isRoot) return; // root ignores the permission that makes this fail
    const remote = makeRemote("gate-stuck");
    const dataDir = tempDir("gate-stuck-data");
    const run = newRunId(REPO, "10", 1);
    const sha = remote.push([["README", "pushed\n"]]);
    Ledger.create(dataDir, run, { clock: ticking(T0, 1000) }).close();
    const dir = NodePath.join(dataDir, "gate/rawphp__softfac__10__1/1");
    const gate = yield* FactoryGate;
    yield* Effect.gen(function* () {
      // A directory nobody can change, as project code can leave one.
      const out = yield* gate.run({
        ...baseInput(remote, dataDir, run, sha, sha),
        gate: ["mkdir sub && echo x > sub/f && chmod 500 sub"],
      });
      assert.strictEqual(out._tag, "pass");
      assert.isTrue(NodeFS.existsSync(NodePath.join(dir, "sub", "f")));
      const lines = entries(dataDir, run);
      assert.deepStrictEqual(
        lines.map((l) => l.event),
        ["gate_checkout", "gate_command", "gate_finished", "gate_cleanup_failed"],
      );
      const failed = lines[3]!;
      const data = failed.data as { dir: string; error: string };
      assert.strictEqual(data.dir, dir);
      assert.isTrue(data.error.startsWith(`could not remove the checkout: ${dir}: `), data.error);
      assert.deepStrictEqual(failed.cause, {
        step: "gate",
        reason: "gate-cleanup-failed",
        attempt: 1,
      });
      assert.strictEqual(gateLocksHeld(dataDir), 0);
    }).pipe(Effect.ensuring(Effect.sync(() => unlock(dir))));
  }).pipe(provided),
);

it.live("a leftover of a call the server died in is removed before the next checkout", () =>
  Effect.gen(function* () {
    const remote = makeRemote("gate-leftover");
    const dataDir = tempDir("gate-leftover-data");
    const run = newRunId(REPO, "10", 1);
    const sha = remote.push([["README", "pushed\n"]]);
    Ledger.create(dataDir, run, { clock: ticking(T0, 1000) }).close();
    const root = gateRoot(dataDir, run);
    // The same attempt's directory, and another attempt's, both with files in them.
    for (const name of ["1", "7"]) {
      NodeFS.mkdirSync(NodePath.join(root, name, "target"), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(root, name, "target", "out"), "x");
    }
    const gate = yield* FactoryGate;
    const out = yield* gate.run({
      ...baseInput(remote, dataDir, run, sha, sha),
      // The leftover's files are not in the fresh checkout, and the other attempt is gone.
      gate: ["test ! -e target", `test ! -e '${NodePath.join(root, "7")}'`],
    });
    assert.strictEqual(out._tag, "pass");
    assert.isFalse(NodeFS.existsSync(root));
    assert.deepStrictEqual(
      entries(dataDir, run).map((l) => l.event),
      ["gate_checkout", "gate_command", "gate_command", "gate_finished"],
    );
  }).pipe(provided),
);

it.live("a leftover that cannot be removed is noted once and the attempt is an error", () =>
  Effect.gen(function* () {
    if (isRoot) return; // root ignores the permission that makes this fail
    const remote = makeRemote("gate-leftover-stuck");
    const dataDir = tempDir("gate-leftover-stuck-data");
    const run = newRunId(REPO, "10", 1);
    const sha = remote.push([["README", "pushed\n"]]);
    Ledger.create(dataDir, run, { clock: ticking(T0, 1000) }).close();
    const dir = NodePath.join(gateRoot(dataDir, run), "1");
    lockDown(dir);
    const gate = yield* FactoryGate;
    yield* Effect.gen(function* () {
      for (let call = 0; call < 2; call++) {
        const error = yield* gate.run(baseInput(remote, dataDir, run, sha, sha)).pipe(Effect.flip);
        assert.strictEqual(error._tag, "WorkspaceCleanupError");
        assert.strictEqual(
          error.message,
          `could not remove the checkout: ${dir} is still there from an earlier call`,
        );
        // One line for the directory, however many calls find it.
        const lines = entries(dataDir, run);
        assert.deepStrictEqual(
          lines.map((l) => l.event),
          ["gate_cleanup_failed"],
        );
        assert.strictEqual((lines[0]!.data as { dir: string }).dir, dir);
        assert.deepStrictEqual(lines[0]!.cause, { step: "gate", reason: "gate-cleanup-failed" });
        assert.strictEqual(gateLocksHeld(dataDir), 0);
      }
    }).pipe(Effect.ensuring(Effect.sync(() => unlock(dir))));
  }).pipe(provided),
);

/** The real process layer, except that the `nth` shell command (1-based) cannot start. */
const failingShellLayer = (nth: number) =>
  Layer.effect(
    FactoryProcess,
    Effect.gen(function* () {
      const real = yield* FactoryProcess;
      let shellCalls = 0;
      return FactoryProcess.of({
        run: (input) => {
          if (input.shell === true && ++shellCalls === nth) {
            return Effect.fail(
              new RunSpawnError({ shell: true, cwd: input.cwd, cause: new Error("no shell") }),
            );
          }
          return real.run(input);
        },
      });
    }),
  ).pipe(Layer.provide(processLayer));

it.live("a gate command that cannot start leaves no gate_command line and uses no attempt", () =>
  Effect.gen(function* () {
    const remote = makeRemote("gate-spawn-error");
    const dataDir = tempDir("gate-spawn-error-data");
    const run = newRunId(REPO, "10", 1);
    const sha = remote.push([["README", "pushed\n"]]);
    Ledger.create(dataDir, run, { clock: ticking(T0, 1000) }).close();
    const gate = yield* FactoryGate;
    const error = yield* gate
      .run({ ...baseInput(remote, dataDir, run, sha, sha), gate: ["true", "true"] })
      .pipe(Effect.flip);
    assert.strictEqual(error._tag, "GateCommandSpawnError");
    assert.deepStrictEqual(
      entries(dataDir, run).map((l) => l.event),
      ["gate_checkout"],
    );
    assert.isFalse(NodeFS.existsSync(gateRoot(dataDir, run)));
    assert.strictEqual(gateLocksHeld(dataDir), 0);
  }).pipe(Effect.provide(gateLayer.pipe(Layer.provide(failingShellLayer(2))))),
);

it.live("a warning git prints on stderr is not part of what the checkout parses", () =>
  usingFakeGit("co-stderr-noise", `echo "warning: something" >&2\n${LOGGING_GIT}`, (fake) =>
    Effect.gen(function* () {
      const made = yield* checkoutWithFake(
        fake,
        fake.options({ remoteBase: "https://example.test" }),
      );
      assert.strictEqual(made.head, SOME_SHA);
      assert.strictEqual(made.merge._tag, "contained");
    }),
  ),
);

it.live("a failed git call carries its stderr and not its stdout", () =>
  usingFakeGit(
    "co-stderr-failed",
    `case "$*" in *fetch*) echo "stdout text"; echo "stderr text" >&2; exit 3;; esac`,
    (fake) =>
      Effect.gen(function* () {
        const error = yield* checkoutWithFake(
          fake,
          fake.options({ remoteBase: "https://example.test" }),
        ).pipe(Effect.flip);
        const failed = expectFailed(error);
        assert.strictEqual(failed.status, 3);
        assert.strictEqual(failed.stderr, "stderr text\n");
      }),
  ),
);

/** A fake `git` whose first `failures` fetches print `stderr` and exit 128; every call is logged. */
const failingFetch = (failures: number, stderr: string) =>
  `d="$(dirname "$0")"
case "$*" in *fetch*)
  n=$(cat "$d/count" 2>/dev/null || echo 0); n=$((n + 1)); echo $n > "$d/count"
  if [ $n -le ${failures} ]; then echo "${stderr}" >&2; exit 128; fi;;
esac
${LOGGING_GIT}`;

const HTTP2_FRAMING = "error: RPC failed; curl 16 Error in the HTTP2 framing layer";

describe("retrying a fetch the network dropped", () => {
  // The waits are the test's to set: a TestClock would race the real process the fetch runs.
  const options = (fake: FakeGit) =>
    fake.options({ remoteBase: "https://example.test", fetchRetryDelaysMs: [0, 0] });
  // What the retry log line names is the first phrase of TRANSIENT_FETCH in the stderr.
  const flaky = [
    { stderr: HTTP2_FRAMING, phrase: "RPC failed; curl 16" },
    {
      stderr:
        "fatal: unable to access 'https://github.com/x/y.git/': Could not resolve host: github.com",
      phrase: "Could not resolve host",
    },
    { stderr: "fatal: early EOF", phrase: "early EOF" },
    {
      stderr: "fatal: unable to access 'https://github.com/x/y.git/': unexpected EOF",
      phrase: "unexpected EOF",
    },
  ];

  it.live.each(flaky)(
    'a fetch that fails once on "$phrase" is tried again, and the retry is logged',
    ({ stderr, phrase }) =>
      usingFakeGit("co-fetch-flaky", failingFetch(1, stderr), (fake) =>
        Effect.gen(function* () {
          const logs: Array<string> = [];
          const capture = Logger.make(({ message }) => {
            logs.push(String(Array.isArray(message) ? message[0] : message));
          });
          const made = yield* checkoutWithFake(fake, options(fake)).pipe(
            Effect.provide(Logger.layer([capture], { mergeWithExisting: false })),
          );
          assert.strictEqual(made.head, SOME_SHA);
          assert.strictEqual(fake.file("count").trim(), "2");
          const retries = logs.filter((line) => line.includes("attempt"));
          assert.strictEqual(retries.length, 1, logs.join("\n"));
          assert.match(
            retries[0]!,
            new RegExp(
              `^\`git fetch .*\` attempt 1 of 3 failed \\(${phrase}\\); trying again in \\d+\\.\\d s$`,
            ),
          );
        }),
      ),
  );

  it.live("the wait before the second fetch is slept", () =>
    usingFakeGit("co-fetch-wait", failingFetch(1, HTTP2_FRAMING), (fake) =>
      Effect.gen(function* () {
        const started = yield* Clock.currentTimeMillis;
        yield* checkoutWithFake(
          fake,
          fake.options({ remoteBase: "https://example.test", fetchRetryDelaysMs: [300, 0] }),
        );
        assert.isAtLeast((yield* Clock.currentTimeMillis) - started, 300);
      }),
    ),
  );

  it.live("a fetch the server refused with an HTTP status is not tried again", () =>
    usingFakeGit(
      "co-fetch-403",
      failingFetch(9, "error: RPC failed; HTTP 403 curl 22 The requested URL returned error: 403"),
      (fake) =>
        Effect.gen(function* () {
          const error = yield* checkoutWithFake(fake, options(fake)).pipe(Effect.flip);
          assert.include(expectFailed(error).stderr, "HTTP 403");
          assert.strictEqual(fake.file("count").trim(), "1");
        }),
    ),
  );

  it.live("a fetch that fails for another reason is not tried again", () =>
    usingFakeGit(
      "co-fetch-ref",
      failingFetch(9, "fatal: remote error: upload-pack: not our ref abc123"),
      (fake) =>
        Effect.gen(function* () {
          const error = yield* checkoutWithFake(fake, options(fake)).pipe(Effect.flip);
          assert.include(expectFailed(error).stderr, "not our ref");
          assert.strictEqual(fake.file("count").trim(), "1");
        }),
    ),
  );

  it.live("three transient failures return the last error after three fetches", () =>
    usingFakeGit("co-fetch-down", failingFetch(9, HTTP2_FRAMING), (fake) =>
      Effect.gen(function* () {
        const error = yield* checkoutWithFake(fake, options(fake)).pipe(Effect.flip);
        const failed = expectFailed(error);
        assert.strictEqual(failed.status, 128);
        assert.include(failed.stderr, "Error in the HTTP2 framing layer");
        assert.strictEqual(fake.file("count").trim(), "3");
      }),
    ),
  );
});

it.live("a git call whose output is parsed and passes the cap fails the checkout", () =>
  usingFakeGit("co-too-much", `case "$*" in *rev-parse*) printf '%0200d\\n' 0;; esac`, (fake) =>
    Effect.gen(function* () {
      const error = yield* checkoutWithFake(
        fake,
        fake.options({ remoteBase: "https://example.test", gitTailBytes: 64 }),
      ).pipe(Effect.flip);
      assert.strictEqual(error._tag, "WorkspaceUnexpectedError");
      assert.strictEqual(
        error.message,
        "unexpected output from git: `git rev-parse HEAD` printed more than 64 bytes",
      );
    }),
  ),
);

const GATE_LOG_SECONDS = "\\d+\\.\\d s";

it.live("a passing attempt writes its commands, their output and the verdict to the gate log", () =>
  Effect.gen(function* () {
    const remote = makeRemote("gate-log-pass");
    const dataDir = tempDir("gate-log-pass-data");
    const run = newRunId(REPO, "10", 1);
    const sha = remote.push([["README", "pushed\n"]]);
    Ledger.create(dataDir, run, { clock: ticking(T0, 1000) }).close();
    const gate = yield* FactoryGate;
    const out = yield* gate.run({
      ...baseInput(remote, dataDir, run, sha, sha),
      provision: ["echo provisioning"],
      gate: ["printf 'no newline'"],
    });
    assert.strictEqual(out._tag, "pass");
    const log = NodeFS.readFileSync(gateLogPath(dataDir, run, 1), "utf8");
    assert.match(
      log,
      new RegExp(
        `^\\$ echo provisioning\\nprovisioning\\nexit 0 after ${GATE_LOG_SECONDS}\\n` +
          `\\$ printf 'no newline'\\nno newline\\nexit 0 after ${GATE_LOG_SECONDS}\\n` +
          `gate attempt 1 passed\\n$`,
      ),
    );
    // Kept after the attempt, and outside the checkout directory.
    assert.isFalse(NodeFS.existsSync(out._tag === "pass" ? out.dir : ""));
    assert.isFalse(gateLogPath(dataDir, run, 1).startsWith(NodePath.join(dataDir, "gate") + "/"));
  }).pipe(provided),
);

it.live("a failing attempt ends its gate log with the failure, and a timeout says so", () =>
  Effect.gen(function* () {
    const remote = makeRemote("gate-log-fail");
    const dataDir = tempDir("gate-log-fail-data");
    const run = newRunId(REPO, "10", 1);
    const sha = remote.push([["README", "pushed\n"]]);
    Ledger.create(dataDir, run, { clock: ticking(T0, 1000) }).close();
    const gate = yield* FactoryGate;
    const failed = yield* gate.run({
      ...baseInput(remote, dataDir, run, sha, sha),
      gate: ["echo boom; exit 1", "echo never"],
    });
    assert.strictEqual(failed._tag, "fail");
    assert.match(
      NodeFS.readFileSync(gateLogPath(dataDir, run, 1), "utf8"),
      new RegExp(
        `^\\$ echo boom; exit 1\\nboom\\nexit 1 after ${GATE_LOG_SECONDS}\\ngate attempt 1 failed\\n$`,
      ),
    );

    const run2 = newRunId(REPO, "10", 2);
    Ledger.create(dataDir, run2, { clock: ticking(T0, 1000) }).close();
    const input = baseInput(remote, dataDir, run2, sha, sha);
    const timedOut = yield* gate.run({
      ...input,
      gate: ["sleep 60"],
      options: { ...input.options, commandTimeoutMs: 300 },
    });
    assert.strictEqual(timedOut._tag, "fail");
    assert.match(
      NodeFS.readFileSync(gateLogPath(dataDir, run2, 1), "utf8"),
      new RegExp(
        `^\\$ sleep 60\\ntimed out after ${GATE_LOG_SECONDS}\\ngate attempt 1 failed\\n$`,
      ),
    );
  }).pipe(provided),
);

it.live("a repeat of an attempt number starts its gate log fresh", () =>
  Effect.gen(function* () {
    const remote = makeRemote("gate-log-repeat");
    const dataDir = tempDir("gate-log-repeat-data");
    const run = newRunId(REPO, "10", 1);
    const sha = remote.push([["README", "pushed\n"]]);
    Ledger.create(dataDir, run, { clock: ticking(T0, 1000) }).close();
    const logPath = gateLogPath(dataDir, run, 1);
    NodeFS.mkdirSync(NodePath.dirname(logPath), { recursive: true });
    NodeFS.writeFileSync(logPath, "left by a dead server\n");
    const gate = yield* FactoryGate;
    yield* gate.run({ ...baseInput(remote, dataDir, run, sha, sha), gate: ["true"] });
    assert.notInclude(NodeFS.readFileSync(logPath, "utf8"), "left by a dead server");
  }).pipe(provided),
);

it.live("onStart runs once, after the checkout and before the first provision command", () =>
  Effect.gen(function* () {
    const remote = makeRemote("gate-onstart");
    const dataDir = tempDir("gate-onstart-data");
    const run = newRunId(REPO, "10", 1);
    const sha = remote.push([["README", "pushed\n"]]);
    Ledger.create(dataDir, run, { clock: ticking(T0, 1000) }).close();
    const marker = NodePath.join(dataDir, "started");
    const seen = NodePath.join(dataDir, "seen");
    let calls = 0;
    const gate = yield* FactoryGate;
    const out = yield* gate.run({
      ...baseInput(remote, dataDir, run, sha, sha),
      provision: [`if test -f '${marker}'; then echo yes; else echo no; fi > '${seen}'`],
      gate: ["true"],
      onStart: Effect.sync(() => {
        calls += 1;
        // The log already exists and the checkout is there when the terminal would open.
        assert.isTrue(NodeFS.existsSync(gateLogPath(dataDir, run, 1)));
        assert.isTrue(NodeFS.existsSync(NodePath.join(gateRoot(dataDir, run), "1", "README")));
        NodeFS.writeFileSync(marker, "");
      }),
    });
    assert.strictEqual(out._tag, "pass");
    assert.strictEqual(calls, 1);
    assert.strictEqual(NodeFS.readFileSync(seen, "utf8"), "yes\n");
  }).pipe(provided),
);

it.live("onStart does not run on a merge conflict or a checkout that fails", () =>
  Effect.gen(function* () {
    const remote = makeRemote("gate-onstart-none");
    const dataDir = tempDir("gate-onstart-none-data");
    const run = newRunId(REPO, "10", 1);
    const pr = remote.pushOn("pr", "main", [["README", "pr\n"]]);
    const base = remote.pushOn("main", "main", [["README", "base\n"]]);
    Ledger.create(dataDir, run, { clock: ticking(T0, 1000) }).close();
    let calls = 0;
    const onStart = Effect.sync(() => {
      calls += 1;
    });
    const gate = yield* FactoryGate;
    const conflict = yield* gate.run({
      ...baseInput(remote, dataDir, run, pr, base),
      gate: ["true"],
      onStart,
    });
    assert.strictEqual(conflict._tag, "conflict");
    const failed = yield* gate
      .run({ ...baseInput(remote, dataDir, run, "main", base), onStart })
      .pipe(Effect.flip);
    assert.strictEqual(failed._tag, "WorkspaceUnexpectedError");
    assert.strictEqual(calls, 0);
  }).pipe(provided),
);
