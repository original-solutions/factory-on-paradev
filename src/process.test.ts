// @effect-diagnostics nodeBuiltinImport:off - Tests write pid files to a temp dir and probe process liveness with kill(pid, 0).
import { assert, it, vi } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Logger from "effect/Logger";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { FactoryProcess, type RunInput, RunSpawnError, layer } from "./process.ts";

// Every test goes through the service, the way a caller does.
const run = (input: RunInput) =>
  Effect.gen(function* () {
    const factoryProcess = yield* FactoryProcess;
    return yield* factoryProcess.run(input);
  }).pipe(Effect.provide(layer));

// The factory process reads the real environment, so the tests set it there.
const applyEnv = (vars: Record<string, string | undefined>) => {
  const saved = Object.keys(vars).map((k) => [k, globalThis.process.env[k]] as const);
  restoreEnv(Object.entries(vars));
  return saved;
};
const restoreEnv = (entries: ReadonlyArray<readonly [string, string | undefined]>) => {
  for (const [k, v] of entries) {
    if (v === undefined) delete globalThis.process.env[k];
    else globalThis.process.env[k] = v;
  }
};
const pathEnv = () => globalThis.process.env.PATH ?? "";

// `undefined` deletes the variable for the body, so a test can run without one the session has.
const withEnv = <A, E, R>(
  vars: Record<string, string | undefined>,
  body: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    Effect.sync(() => applyEnv(vars)),
    () => body,
    (saved) => Effect.sync(() => restoreEnv(saved)),
  );

const isAlive = (pid: number): boolean => {
  try {
    globalThis.process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// A temp dir that is removed however the test ends.
const withTempDir = <A, E, R>(body: (dir: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "factory-process-"))),
    body,
    (dir) => Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
  );

const readPids = (file: string): ReadonlyArray<number> =>
  NodeFS.readFileSync(file, "utf8").trim().split(/\s+/).map(Number);

// Nothing signals a file a subprocess writes, or the death of a pid that is not our child, so
// these retry the check itself.
const waitForFile = (file: string) =>
  Effect.promise(() =>
    vi.waitFor(() => assert.isTrue(NodeFS.existsSync(file)), { timeout: 2_000, interval: 20 }),
  );

const waitForDeath = (pid: number) =>
  Effect.promise(() =>
    vi.waitFor(() => assert.strictEqual(isAlive(pid), false), { timeout: 2_000, interval: 50 }),
  );

// 16384 lines of 65 bytes each, about 1 MiB, with a counter so the tail is checkable.
const COUNTER_SCRIPT = `i=0; while [ $i -lt 16384 ]; do printf '%064d\\n' $i; i=$((i+1)); done`;
const counterOutput = (): string => {
  let out = "";
  for (let i = 0; i < 16384; i++) out += `${String(i).padStart(64, "0")}\n`;
  return out;
};

it.live("does not pass variables outside the allowlist", () =>
  withEnv(
    { FACTORY_PROCESS_TEST_SECRET: "leak" },
    Effect.gen(function* () {
      const result = yield* run({
        command: `printf %s "\${FACTORY_PROCESS_TEST_SECRET-unset}"`,
        shell: true,
      });
      assert.strictEqual(result.tail, "unset");
    }),
  ),
);

it.live("passes PATH, LC_* and the env argument through", () =>
  withEnv(
    { LC_FACTORY_TEST: "lc", T3FAC_LAUNCH_PATH: undefined },
    Effect.gen(function* () {
      const path = yield* run({ command: `printf %s "$PATH"`, shell: true });
      assert.strictEqual(path.tail, pathEnv());
      const lc = yield* run({ command: `printf %s "$LC_FACTORY_TEST"`, shell: true });
      assert.strictEqual(lc.tail, "lc");
      const extra = yield* run({
        command: `printf %s "$FACTORY_PROCESS_TEST_EXTRA"`,
        shell: true,
        env: { FACTORY_PROCESS_TEST_EXTRA: "yes" },
      });
      assert.strictEqual(extra.tail, "yes");
      const home = yield* run({
        command: `printf %s "$HOME"`,
        shell: true,
        env: { HOME: "/factory-test-home" },
      });
      assert.strictEqual(home.tail, "/factory-test-home");
    }),
  ),
);

it.live(
  "puts the launch PATH first, then the rest of the server PATH, without duplicates or empty entries",
  () =>
    withEnv(
      {
        T3FAC_LAUNCH_PATH: "/launch/python/bin::/opt/homebrew/bin:/usr/bin:",
        PATH: "/usr/bin:/login/bin:/opt/homebrew/bin:/usr/bin:/bin",
      },
      Effect.gen(function* () {
        const path = yield* run({ command: `printf %s "$PATH"`, shell: true });
        assert.strictEqual(
          path.tail,
          "/launch/python/bin:/opt/homebrew/bin:/usr/bin:/login/bin:/bin",
        );
        const launch = yield* run({
          command: `printf %s "\${T3FAC_LAUNCH_PATH-unset}"`,
          shell: true,
        });
        assert.strictEqual(launch.tail, "unset");
      }),
    ),
);

it.live("passes the server PATH unchanged when no launch PATH is set", () =>
  withEnv(
    { T3FAC_LAUNCH_PATH: undefined, PATH: "/usr/bin:/login/bin:/usr/bin:/bin" },
    Effect.gen(function* () {
      const path = yield* run({ command: `printf %s "$PATH"`, shell: true });
      assert.strictEqual(path.tail, "/usr/bin:/login/bin:/usr/bin:/bin");
    }),
  ),
);

it.live("a timeout kills the whole process group, grandchild included", () =>
  withTempDir((dir) =>
    Effect.gen(function* () {
      const pidFile = NodePath.join(dir, "pid");
      const started = yield* Clock.currentTimeMillis;
      const result = yield* run({
        command: `sleep 100 & echo $! > "$0"; sleep 100`,
        args: [pidFile],
        shell: true,
        timeoutMs: 300,
      });
      assert.strictEqual(result.timedOut, true);
      assert.strictEqual(result.exitCode, null);
      assert.isBelow((yield* Clock.currentTimeMillis) - started, 5000);

      const [pid] = readPids(pidFile);
      assert.isAbove(pid!, 0);
      yield* waitForDeath(pid!);
    }),
  ),
);

it.live("kills what a finished command left behind, without waiting", () =>
  withTempDir((dir) =>
    Effect.gen(function* () {
      const pidFile = NodePath.join(dir, "pid");
      const started = yield* Clock.currentTimeMillis;
      const result = yield* run({
        command: `sleep 100 & echo $! > "$0"; echo done`,
        args: [pidFile],
        shell: true,
      });
      assert.strictEqual(result.tail, "done\n");
      assert.strictEqual(result.exitCode, 0);
      assert.strictEqual(result.timedOut, false);
      // Well under the 10 s grace a timeout would give; waitForDeath proves the kill.
      assert.isBelow((yield* Clock.currentTimeMillis) - started, 5000);

      const [pid] = readPids(pidFile);
      assert.isAbove(pid!, 0);
      yield* waitForDeath(pid!);
    }),
  ),
);

it.live("escalates to SIGKILL when SIGTERM is ignored", () =>
  Effect.gen(function* () {
    const started = yield* Clock.currentTimeMillis;
    const result = yield* run({
      command: `trap '' TERM; sleep 100`,
      shell: true,
      timeoutMs: 200,
      termGraceMs: 300,
    });
    assert.strictEqual(result.timedOut, true);
    assert.isBelow((yield* Clock.currentTimeMillis) - started, 5000);
  }),
);

it.live("keeps only the last tailBytes of a 1 MB output", () =>
  Effect.gen(function* () {
    const expected = counterOutput();
    const small = yield* run({ command: COUNTER_SCRIPT, shell: true, tailBytes: 4096 });
    assert.strictEqual(small.tail, expected.slice(-4096));
    assert.strictEqual(small.tail.length, 4096);

    const dflt = yield* run({ command: COUNTER_SCRIPT, shell: true });
    assert.strictEqual(dflt.tail, expected.slice(-16384));
    assert.strictEqual(dflt.tail.length, 16384);
  }),
);

it.live("passes the exit code through", () =>
  Effect.gen(function* () {
    const failed = yield* run({ command: "exit 3", shell: true });
    assert.strictEqual(failed.exitCode, 3);
    assert.strictEqual(failed.timedOut, false);
    const ok = yield* run({ command: "true" });
    assert.strictEqual(ok.exitCode, 0);
  }),
);

it.live("interleaves stdout and stderr in order", () =>
  Effect.gen(function* () {
    const result = yield* run({ command: "echo out1; echo err1 >&2; echo out2", shell: true });
    assert.strictEqual(result.tail, "out1\nerr1\nout2\n");
  }),
);

it.live("runs argv without a shell", () =>
  Effect.gen(function* () {
    const result = yield* run({ command: "printf", args: ["%s-%s", "a", "b"] });
    assert.strictEqual(result.tail, "a-b");
  }),
);

it.live("merges stderr into the tail without a shell", () =>
  Effect.gen(function* () {
    const result = yield* run({ command: "sh", args: ["-c", "echo e >&2"] });
    assert.strictEqual(result.tail, "e\n");
  }),
);

it.live("fails with RunSpawnError when the cwd does not exist", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      run({ command: "true", cwd: "/nonexistent/factory-process-test" }),
    );
    assert.instanceOf(error, RunSpawnError);
  }),
);

it.live("gives a TERM-trapping grandchild its grace before SIGKILL", () =>
  Effect.gen(function* () {
    const started = yield* Clock.currentTimeMillis;
    // The wrapper sh dies on SIGTERM at once; the inner sh keeps the group
    // alive while its trap runs, and the marker only appears if SIGKILL waits.
    const result = yield* run({
      command: `sh -c 'trap "sleep 0.3; printf caught; exit 0" TERM; sleep 100 & wait $!'; printf %s leader`,
      shell: true,
      timeoutMs: 300,
      termGraceMs: 3000,
    });
    assert.strictEqual(result.timedOut, true);
    assert.include(result.tail, "caught");
    assert.isBelow((yield* Clock.currentTimeMillis) - started, 5000);
  }),
);

it.live("fails with RunSpawnError when spawn throws synchronously", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(run({ command: "true", env: { BAD: "a\u0000b" } }));
    assert.instanceOf(error, RunSpawnError);
  }),
);

it.live("an interrupted run kills the whole process group", () =>
  withTempDir((dir) =>
    Effect.gen(function* () {
      const pidFile = NodePath.join(dir, "pids");
      const ready = NodePath.join(dir, "ready");
      const fiber = yield* run({
        command: `sleep 100 & echo $$ $! > "$0"; mv "$0" "$1"; sleep 100`,
        args: [pidFile, ready],
        shell: true,
      }).pipe(Effect.forkChild);
      yield* waitForFile(ready);
      const [leader, grandchild] = readPids(ready);
      yield* Fiber.interrupt(fiber);
      yield* waitForDeath(grandchild!);
      yield* waitForDeath(leader!);
    }),
  ),
);

it.live("does not wait long for a process that left the group and holds the pipe", () =>
  withTempDir((dir) => {
    const pidFile = NodePath.join(dir, "pid");
    return Effect.gen(function* () {
      const started = yield* Clock.currentTimeMillis;
      // The stray writes its pid only after leaving the group, so the group kill cannot reach it.
      const result = yield* run({
        command: `perl -e 'setpgrp(0, 0); open my $f, ">", "$ARGV[0].tmp"; print $f $$; close $f; rename "$ARGV[0].tmp", $ARGV[0]; sleep 100' "$0" & while [ ! -s "$0" ]; do sleep 0.01; done; echo done`,
        args: [pidFile],
        shell: true,
      });
      assert.strictEqual(result.tail, "done\n");
      assert.strictEqual(result.exitCode, 0);
      assert.isBelow((yield* Clock.currentTimeMillis) - started, 4000);
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          const [pid] = NodeFS.existsSync(pidFile) ? readPids(pidFile) : [];
          if (pid !== undefined && pid > 0) {
            try {
              globalThis.process.kill(pid, "SIGKILL");
            } catch {
              // Already gone.
            }
          }
        }),
      ),
    );
  }),
);

it.live("a tail cut inside a UTF-8 character drops the partial character", () =>
  Effect.gen(function* () {
    // 20 000 two-byte characters; an odd cap lands the cut on a continuation byte.
    const result = yield* run({
      command: `perl -e 'print "\\xc3\\xa9" x 20000'`,
      shell: true,
      tailBytes: 4097,
    });
    assert.strictEqual(result.tail, "é".repeat(2048));
  }),
);

it.live("separateStderr keeps stderr out of tail and puts it in stderrTail", () =>
  Effect.gen(function* () {
    const result = yield* run({
      command: "echo out1; echo err1 >&2; echo out2",
      shell: true,
      separateStderr: true,
    });
    assert.strictEqual(result.tail, "out1\nout2\n");
    assert.strictEqual(result.stderrTail, "err1\n");
    assert.strictEqual(result.exitCode, 0);
  }),
);

it.live("separateStderr works without a shell", () =>
  Effect.gen(function* () {
    const result = yield* run({
      command: "sh",
      args: ["-c", "echo o; echo e >&2; exit 2"],
      separateStderr: true,
    });
    assert.strictEqual(result.tail, "o\n");
    assert.strictEqual(result.stderrTail, "e\n");
    assert.strictEqual(result.exitCode, 2);
  }),
);

it.live("separateStderr waits for stderr that is written after stdout closed", () =>
  Effect.gen(function* () {
    // A child leaves the group (so the post-exit kill misses it), closes its stdout and
    // writes to stderr after the leader has exited and stdout has closed.
    const result = yield* run({
      command: `perl -e 'setpgrp(0, 0); close STDOUT; select(undef, undef, undef, 0.5); print STDERR "late\\n"' & sleep 0.2`,
      shell: true,
      separateStderr: true,
    });
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.tail, "");
    assert.strictEqual(result.stderrTail, "late\n");
  }),
);

it.live("separateStderr: a timeout is not held up by a process keeping stderr open", () =>
  Effect.gen(function* () {
    const started = yield* Clock.currentTimeMillis;
    const result = yield* run({
      command: "sleep 100 & echo err >&2; sleep 100",
      shell: true,
      separateStderr: true,
      timeoutMs: 300,
    });
    assert.strictEqual(result.timedOut, true);
    assert.strictEqual(result.stderrTail, "err\n");
    assert.isBelow((yield* Clock.currentTimeMillis) - started, 5000);
  }),
);

it.live("merged mode leaves stderrTail empty", () =>
  Effect.gen(function* () {
    const result = yield* run({ command: "echo out; echo err >&2", shell: true });
    assert.strictEqual(result.tail, "out\nerr\n");
    assert.strictEqual(result.stderrTail, "");
    assert.strictEqual(result.truncated, false);
  }),
);

it.live("truncated is true only when a tail dropped bytes", () =>
  Effect.gen(function* () {
    const within = yield* run({ command: "printf abcd", shell: true, tailBytes: 4 });
    assert.strictEqual(within.tail, "abcd");
    assert.strictEqual(within.truncated, false);

    const stdoutCut = yield* run({ command: "printf abcdefgh", shell: true, tailBytes: 4 });
    assert.strictEqual(stdoutCut.tail, "efgh");
    assert.strictEqual(stdoutCut.truncated, true);

    const stderrCut = yield* run({
      command: "echo ok; printf abcdefgh >&2",
      shell: true,
      tailBytes: 4,
      separateStderr: true,
    });
    assert.strictEqual(stderrCut.tail, "ok\n");
    assert.strictEqual(stderrCut.stderrTail, "efgh");
    assert.strictEqual(stderrCut.truncated, true);
  }),
);

it.live("a priority that cannot be set leaves the command running and logs one warning", () =>
  Effect.gen(function* () {
    const logs: Array<string> = [];
    const capture = Logger.make(({ logLevel, message }) => {
      logs.push(`${logLevel} ${String(Array.isArray(message) ? message[0] : message)}`);
    });
    // 100 is outside the range setPriority accepts, so it throws for root too.
    const result = yield* run({ command: "echo ran", shell: true, niceness: 100 }).pipe(
      Effect.provide(Logger.layer([capture], { mergeWithExisting: false })),
    );
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.tail, "ran\n");
    assert.strictEqual(logs.length, 1, logs.join("\n"));
    assert.match(logs[0]!, /^Warn /);
  }),
);

it.live("a command already nicer than the niceness asked for keeps its own, with no warning", () =>
  Effect.gen(function* () {
    const logs: Array<string> = [];
    const capture = Logger.make(({ message }) => {
      logs.push(String(Array.isArray(message) ? message[0] : message));
    });
    const own = NodeOS.getPriority();
    // Asking for less niceness than the child inherits must not try to raise its priority.
    const result = yield* run({
      command: "ps -o nice= -p $$",
      shell: true,
      niceness: own - 1,
    }).pipe(Effect.provide(Logger.layer([capture], { mergeWithExisting: false })));
    assert.strictEqual(result.tail.trim(), String(own));
    assert.deepStrictEqual(logs, []);
  }),
);
