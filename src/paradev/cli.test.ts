// @effect-diagnostics nodeBuiltinImport:off - Writes fake `superset` binaries to a temp dir and probes their pids.
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as Process from "../process.ts";
import { FactoryProcess, type RunInput, type RunResult } from "../process.ts";
import { CLI_ENV, type CliErrorKind, classify, DEFAULT_CLI, layer, SupersetCli } from "./cli.ts";

const done = (exitCode: number | null, stdout: string, stderr = ""): RunResult => ({
  exitCode,
  timedOut: false,
  tail: stdout,
  stderrTail: stderr,
  truncated: false,
});

/** A FactoryProcess that records each call and answers with `reply`. */
const recorder = (reply: RunResult) => {
  const calls: Array<RunInput> = [];
  const process = FactoryProcess.of({
    run: (input) => {
      calls.push(input);
      return Effect.succeed(reply);
    },
  });
  return { calls, layer: Layer.succeed(FactoryProcess, process) };
};

const call = (
  processLayer: Layer.Layer<FactoryProcess>,
  argv: ReadonlyArray<string>,
  config: { cli?: string } = {},
  timeoutMs?: number,
) =>
  Effect.gen(function* () {
    const cli = yield* SupersetCli;
    return yield* cli.run(argv, timeoutMs === undefined ? undefined : { timeoutMs });
  }).pipe(Effect.provide(layer(config).pipe(Layer.provide(processLayer))));

it.effect("runs the default binary with --json added, the five-name env and stderr apart", () =>
  Effect.gen(function* () {
    const fake = recorder(done(0, '{"ok":true}\n'));
    const answer = yield* call(fake.layer, ["projects", "list", "--local"]);
    assert.deepStrictEqual(answer, { ok: true });
    const [input] = fake.calls;
    assert.strictEqual(input!.command, DEFAULT_CLI);
    assert.strictEqual(
      DEFAULT_CLI,
      "/Applications/Superset.app/Contents/Resources/resources/bin/superset",
    );
    assert.deepStrictEqual(input!.args, ["projects", "list", "--local", "--json"]);
    assert.deepStrictEqual([...input!.inheritEnv!], ["HOME", "PATH", "USER", "LANG", "TMPDIR"]);
    assert.strictEqual(input!.env, undefined);
    assert.isTrue(input!.separateStderr);
  }),
);

it.effect("runs the binary the config names", () =>
  Effect.gen(function* () {
    const fake = recorder(done(0, "[]"));
    yield* call(fake.layer, ["snapshot"], { cli: "/opt/superset" });
    assert.strictEqual(fake.calls[0]!.command, "/opt/superset");
  }),
);

it.effect("stdout that is not JSON on exit 0 is PARADEV_SHAPE", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(call(recorder(done(0, "Workspace created\n")).layer, ["x"]));
    assert.strictEqual(error.kind, "PARADEV_SHAPE");
    assert.deepStrictEqual(error.argv, ["x", "--json"]);
  }),
);

it.effect("stdout cut at the cap on exit 0 is PARADEV_SHAPE", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      call(recorder({ ...done(0, "{}"), truncated: true }).layer, ["x"]),
    );
    assert.strictEqual(error.kind, "PARADEV_SHAPE");
  }),
);

it.effect("a failed call maps its Error line, whatever the exit code", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      call(recorder(done(2, "", "Error: Not logged in\n")).layer, ["x"]),
    );
    assert.strictEqual(error.kind, "PARADEV_SIGNED_OUT");
  }),
);

const UNSEEN: ReadonlyArray<readonly [string, CliErrorKind]> = [
  ["Host service manifest is stale", "PARADEV_OFFLINE"],
  ["No active organization", "PARADEV_SIGNED_OUT"],
  ["Could not connect to API", "TRANSIENT"],
  ["Needs the Pro plan", "PARADEV_PLAN"],
  ["No agent is running in terminal 7f3c", "AGENT_EXITED"],
  ["No transcript for that terminal", "NO_TRANSCRIPT"],
  ["Something new went wrong", "UNKNOWN"],
];

for (const [text, kind] of UNSEEN) {
  it(`"${text}" is ${kind}`, () => {
    assert.deepStrictEqual(classify(`Error: ${text}\nHint: try again\n`), {
      kind,
      text,
      hint: "try again",
    });
  });
}

it("a message that only contains a known one is not matched", () => {
  assert.strictEqual(classify("Error: Retry: Not logged in\n").kind, "UNKNOWN");
});

it("stderr with no Error line is UNKNOWN with the stderr as text", () => {
  assert.deepStrictEqual(classify("sh: superset: not found\n"), {
    kind: "UNKNOWN",
    text: "sh: superset: not found",
    hint: null,
  });
  assert.strictEqual(classify("").text, "no error message");
});

// Real processes from here on.

const withTempDir = <A, E, R>(body: (dir: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "factory-paradev-cli-"))),
    body,
    (dir) => Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
  );

const writeBinary = (dir: string, script: string): string => {
  const path = NodePath.join(dir, "superset");
  NodeFS.writeFileSync(path, `#!/bin/sh\n${script}`, { mode: 0o755 });
  return path;
};

const isAlive = (pid: number): boolean => {
  try {
    globalThis.process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

it.live("the CLI sees only HOME, PATH, USER, LANG and TMPDIR", () =>
  withTempDir((dir) =>
    Effect.gen(function* () {
      const saved = globalThis.process.env.SUPERSET_API_KEY;
      globalThis.process.env.SUPERSET_API_KEY = "sk_live_factory_test";
      // Prints the names it sees as one JSON string; sh sets PWD, SHLVL and _ itself.
      const binary = writeBinary(
        dir,
        `names=$(env | cut -d= -f1 | grep -v -x -e PWD -e SHLVL -e _ -e OLDPWD | tr '\\n' ' ')\n` +
          `printf '"%s"' "\${names% }"\n`,
      );
      const answer = yield* call(Process.layer, [], { cli: binary }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (saved === undefined) delete globalThis.process.env.SUPERSET_API_KEY;
            else globalThis.process.env.SUPERSET_API_KEY = saved;
          }),
        ),
      );
      const names = String(answer).split(" ");
      for (const name of names) assert.include(CLI_ENV, name);
      assert.include(names, "PATH");
      assert.include(names, "HOME");
    }),
  ),
);

it.live("a call past its timeout kills the CLI and its grandchild, and fails TIMEOUT", () =>
  withTempDir((dir) =>
    Effect.gen(function* () {
      const pids = NodePath.join(dir, "pids");
      // The grandchild sleeps an unusual time so a stray is easy to find by its marker.
      const binary = writeBinary(
        dir,
        `sleep 3011 &\necho "$$ $!" > "${pids}"\nwait\n`,
      );
      const error = yield* Effect.flip(call(Process.layer, ["snapshot"], { cli: binary }, 500));
      assert.strictEqual(error.kind, "TIMEOUT");
      const [cliPid, grandchildPid] = NodeFS.readFileSync(pids, "utf8")
        .trim()
        .split(" ")
        .map(Number);
      assert.isTrue(cliPid! > 0 && grandchildPid! > 0);
      // A killed process can take a moment to be reaped.
      for (let i = 0; i < 40 && (isAlive(cliPid!) || isAlive(grandchildPid!)); i++) {
        yield* Effect.sleep("50 millis");
      }
      assert.isFalse(isAlive(cliPid!), "the CLI is still running");
      assert.isFalse(isAlive(grandchildPid!), "the CLI's grandchild is still running");
    }),
  ),
);

it.effect("the error message cuts a long argument, so a payload does not reach the log", () =>
  Effect.gen(function* () {
    const fake = recorder(done(1, "", "Error: A stored value is at most 65536 bytes\n"));
    const payload = "x".repeat(70_000);
    const error = yield* Effect.flip(call(fake.layer, ["pages", "storage", "--set", payload]));
    assert.strictEqual(error.argv[3], payload);
    assert.isBelow(error.message.length, 500);
    assert.include(error.message, "pages storage --set xxx");
    assert.include(error.message, "70000 chars");
  }),
);

it.effect("a CLI killed by a signal says so", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(call(recorder(done(null, "")).layer, ["snapshot"]));
    assert.strictEqual(error.kind, "UNKNOWN");
    assert.include(error.text, "signal");
  }),
);

it.effect("a binary that cannot start keeps the cause", () =>
  Effect.gen(function* () {
    const process = FactoryProcess.of({
      run: () =>
        Effect.fail(new Process.RunSpawnError({ shell: false, cause: new Error("EACCES /x") })),
    });
    const error = yield* Effect.flip(call(Layer.succeed(FactoryProcess, process), ["snapshot"]));
    assert.strictEqual(error.kind, "UNKNOWN");
    assert.include(error.text, "EACCES /x");
  }),
);
