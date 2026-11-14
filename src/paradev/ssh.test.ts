// @effect-diagnostics nodeBuiltinImport:off - runs the host scripts for real, under a temp HOME.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

import { trustFixCommand } from "./hostsCheck.ts";
import { useTempDirs } from "../ledger/testSupport.ts";
import { FactoryProcess, type RunInput, type RunResult } from "../process.ts";

import {
  CLAUDE_VERSION,
  fromCommandRunner,
  GH_AUTH_STATUS,
  GIT_EMAIL,
  isAllowed,
  liveSshSpawn,
  LOAD_COMMAND,
  PROXY_ENV_READ,
  PROXY_ENV_SCRIPT,
  remoteUrl,
  runSsh,
  SSH_TIMEOUT_MS,
  shellQuote,
  sshArgs,
  SshError,
  sshRunner,
  TRUE_COMMAND,
  trustRead,
  TRUST_SCRIPT,
  type SshAnswer,
  type SshSpawn,
} from "./ssh.ts";

const answer = (over: Partial<SshAnswer> = {}): SshAnswer => ({
  exitCode: 0,
  timedOut: false,
  stdout: "",
  stderr: "",
  ...over,
});

/** A runner that records each call and answers with `reply`. */
const recorder = (reply: SshAnswer) => {
  const calls: Array<{ args: ReadonlyArray<string>; timeoutMs: number }> = [];
  const run: SshSpawn = (args, timeoutMs) => {
    calls.push({ args, timeoutMs });
    return Effect.succeed(reply);
  };
  return { calls, run };
};

const SHA = "0123456789abcdef0123456789abcdef01234567";

describe("sshArgs", () => {
  it("is BatchMode, a 10 s connect timeout, `--`, the destination, then the command", () => {
    assert.deepStrictEqual(sshArgs("me@host", "true"), [
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=10",
      "--",
      "me@host",
      "true",
    ]);
  });
});

/** Every command the runner may send, one of each shape. */
const ALLOWED: ReadonlyArray<string> = [
  LOAD_COMMAND,
  TRUE_COMMAND,
  remoteUrl("/Users/me/code/repo"),
  trustRead("/Users/me/code/repo"),
  PROXY_ENV_READ,
  GIT_EMAIL,
  GH_AUTH_STATUS,
  CLAUDE_VERSION,
];

describe("isAllowed", () => {
  it("accepts the constant read-only commands and every builder's output", () => {
    for (const command of ALLOWED) assert.isTrue(isAllowed(command), command);
  });

  it("refuses every allowed command with a second command before, after or on the next line", () => {
    for (const command of ALLOWED) {
      for (const bad of [`${command}; id`, `id; ${command}`, `${command}\nid`, `${command} && id`, `${command} | id`]) {
        assert.isFalse(isAllowed(bad), bad);
      }
    }
  });

  it("refuses the unquoted and quote-breaking forms of each shape that takes a word", () => {
    const refused = [
      "git -C /wt remote get-url origin",
      "git -C 'a'b' remote get-url origin",
      `python3 -c '${TRUST_SCRIPT}' /Users/me/repo`,
      `python3 -c '${TRUST_SCRIPT}' 'a'b'`,
      `python3 -c '${TRUST_SCRIPT}' 'a' 'b'`,
    ];
    for (const command of refused) assert.isFalse(isAllowed(command), command);
  });

  it("refuses a path with a backslash, which the allowlist cannot tell from an escape", () => {
    const path = "/Users/me/a\\b";
    assert.isFalse(isAllowed(remoteUrl(path)));
    assert.isFalse(isAllowed(trustRead(path)));
  });

  it("the load command is the spec's text", () => {
    assert.strictEqual(
      LOAD_COMMAND,
      "sysctl -n vm.loadavg hw.ncpu 2>/dev/null || (cat /proc/loadavg; nproc)",
    );
  });

  it("refuses anything else", () => {
    const refused = [
      "rm -rf ~",
      "true; rm -rf /",
      "git -C 'a' remote get-url origin; rm x",
      "git -C a remote get-url origin",
      "git -C 'a' remote get-url origin && true",
      `git -C '/wt' fetch origin 'main'`,
      `git -C '/wt' reset --hard ${SHA}`,
      "pgrep -x claude",
      "lsof -a -d cwd -p 12",
      "ls -t ~/.claude/projects/a/*.jsonl",
      `${TRUE_COMMAND} `,
      `${GIT_EMAIL} foo`,
      "",
    ];
    for (const command of refused) assert.isFalse(isAllowed(command), command);
  });

  it("a quoted word with a single quote in it stays one word", () => {
    const path = "/Users/o'brien/repo";
    assert.strictEqual(shellQuote(path), "'/Users/o'\\''brien/repo'");
    assert.isTrue(isAllowed(remoteUrl(path)));
    assert.isTrue(isAllowed(trustRead(path)));
    // A word that closes its quote and goes on is not one word.
    assert.isFalse(isAllowed("git -C 'a' 'b' remote get-url origin"));
    assert.isFalse(isAllowed("git -C 'a'; echo 'b' remote get-url origin"));
  });
});

describe("builders", () => {
  it("quotes each path", () => {
    assert.strictEqual(remoteUrl("/a b"), "git -C '/a b' remote get-url origin");
  });

  it("the trust read passes the quoted path as its argument and names ~/.claude.json", () => {
    const command = trustRead("/Users/me/repo");
    assert.include(command, ".claude.json");
    assert.include(command, "hasTrustDialogAccepted");
    assert.isTrue(command.endsWith(" '/Users/me/repo'"));
  });

  it("the proxy env read names the two keys and ~/.claude/settings.json", () => {
    assert.include(PROXY_ENV_READ, "ANTHROPIC_BASE_URL");
    assert.include(PROXY_ENV_READ, "ANTHROPIC_AUTH_TOKEN");
    assert.include(PROXY_ENV_READ, ".claude/settings.json");
  });

  it("neither script has a single quote in it, so each stays one quoted word", () => {
    assert.notInclude(TRUST_SCRIPT, "'");
    assert.notInclude(PROXY_ENV_SCRIPT, "'");
  });
});

describe("runSsh", () => {
  it.effect("runs allowed commands with BatchMode, ConnectTimeout=10 and the 10 s timeout", () =>
    Effect.gen(function* () {
      const fake = recorder(answer({ stdout: "hello\n" }));
      const out = yield* runSsh(fake.run, "me@host", TRUE_COMMAND);
      assert.strictEqual(out, "hello\n");
      assert.strictEqual(SSH_TIMEOUT_MS, 10_000);
      assert.deepStrictEqual(fake.calls, [
        { args: sshArgs("me@host", TRUE_COMMAND), timeoutMs: 10_000 },
      ]);
      assert.include(fake.calls[0]!.args, "BatchMode=yes");
      assert.include(fake.calls[0]!.args, "ConnectTimeout=10");
    }),
  );

  it.effect("refuses a command outside the allowlist without calling the runner", () =>
    Effect.gen(function* () {
      const fake = recorder(answer());
      const result = yield* Effect.result(runSsh(fake.run, "me@host", "rm -rf ~"));
      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) assert.strictEqual(result.failure.kind, "refused");
      assert.strictEqual(fake.calls.length, 0);
    }),
  );

  it.effect("a timeout is `timeout`", () =>
    Effect.gen(function* () {
      const fake = recorder(answer({ exitCode: null, timedOut: true }));
      const result = yield* Effect.result(runSsh(fake.run, "me@host", TRUE_COMMAND));
      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.strictEqual(result.failure.kind, "timeout");
        assert.strictEqual(result.failure.message, "no answer within 10 s");
      }
    }),
  );

  it.effect("a non-zero exit is `failed` with the first non-empty stderr line", () =>
    Effect.gen(function* () {
      const fake = recorder(answer({ exitCode: 255, stderr: "\nPermission denied (publickey).\nmore\n" }));
      const result = yield* Effect.result(runSsh(fake.run, "me@host", TRUE_COMMAND));
      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.strictEqual(result.failure.kind, "failed");
        assert.strictEqual(result.failure.message, "exit 255: Permission denied (publickey).");
      }
    }),
  );

  it.effect("a process with no exit code that did not time out says it did not finish", () =>
    Effect.gen(function* () {
      const fake = recorder(answer({ exitCode: null, stderr: "spawn ssh ENOENT\n" }));
      const result = yield* Effect.result(runSsh(fake.run, "me@host", TRUE_COMMAND));
      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.strictEqual(result.failure.message, "did not finish: spawn ssh ENOENT");
      }
    }),
  );
});

describe("fromCommandRunner", () => {
  it.effect("maps a status, and a null status to a null exit code; ssh gets only its env names", () =>
    Effect.gen(function* () {
      const seen: Array<{
        command: string;
        args: ReadonlyArray<string>;
        timeoutMs: number;
        inheritEnv: ReadonlyArray<string> | undefined;
      }> = [];
      const run = fromCommandRunner((command, args, timeoutMs, inheritEnv) => {
        seen.push({ command, args, timeoutMs, inheritEnv });
        return { status: 0, stdout: "x", stderr: "" };
      });
      const ok = yield* run(["a"], 5);
      assert.deepStrictEqual(ok, { exitCode: 0, timedOut: false, stdout: "x", stderr: "" });
      assert.deepStrictEqual(seen, [
        {
          command: "ssh",
          args: ["a"],
          timeoutMs: 5,
          inheritEnv: ["PATH", "HOME", "USER", "LOGNAME", "LANG", "TMPDIR", "SSH_AUTH_SOCK"],
        },
      ]);
      const none = yield* fromCommandRunner(() => ({ status: null, stdout: "", stderr: "boom" }))([], 1);
      assert.strictEqual(none.exitCode, null);
      assert.isFalse(none.timedOut);
    }),
  );

  it.effect("a stderr with ETIMEDOUT is a timeout", () =>
    Effect.gen(function* () {
      const run = fromCommandRunner(() => ({
        status: null,
        stdout: "",
        stderr: "spawnSync ssh ETIMEDOUT\n",
      }));
      assert.isTrue((yield* run([], 1)).timedOut);
    }),
  );
});

describe("the host scripts, run for real", () => {
  const tempDir = useTempDirs();
  const PATH = "/Users/me/repo";

  /** Runs `command` through `/bin/sh -c` with HOME set to `home`, as ssh's shell on a host would. */
  const sh = (command: string, home: string) =>
    NodeChildProcess.spawnSync("/bin/sh", ["-c", command], {
      encoding: "utf8",
      env: { HOME: home, PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
    });

  const writeJson = (home: string, file: string, value: unknown) => {
    const full = NodePath.join(home, file);
    NodeFS.mkdirSync(NodePath.dirname(full), { recursive: true });
    NodeFS.writeFileSync(full, JSON.stringify(value));
  };

  const trusted = (value: unknown): unknown => ({ projects: { [PATH]: { hasTrustDialogAccepted: value } } });

  it("the trust read answers yes only for a real true", () => {
    const answers: Array<readonly [string, unknown, string]> = [
      ["true", trusted(true), "yes"],
      ["false", trusted(false), "no"],
      ['the string "true"', trusted("true"), "no"],
      ["a path that is not listed", { projects: {} }, "no"],
      ["no projects key", {}, "no"],
    ];
    for (const [name, content, expected] of answers) {
      const home = tempDir("trust");
      writeJson(home, ".claude.json", content);
      const done = sh(trustRead(PATH), home);
      assert.strictEqual(done.status, 0, name);
      assert.strictEqual(done.stdout.trim(), expected, name);
    }
  });

  it("the trust read exits non-zero when ~/.claude.json is missing", () => {
    const done = sh(trustRead(PATH), tempDir("trust-missing"));
    assert.notStrictEqual(done.status, 0);
  });

  it("the trust read treats a path with a single quote as one word", () => {
    const odd = "/Users/o'brien/repo";
    const home = tempDir("trust-quote");
    writeJson(home, ".claude.json", { projects: { [odd]: { hasTrustDialogAccepted: true } } });
    assert.strictEqual(sh(trustRead(odd), home).stdout.trim(), "yes");
  });

  it("the printed trust fix, run on the host, makes the trust read answer yes and keeps the file's other keys", () => {
    const home = tempDir("trust-fix");
    writeJson(home, ".claude.json", { theme: "dark", projects: { "/other": { allowedTools: [1] } } });
    const fix = sh(trustFixCommand(PATH), home);
    assert.strictEqual(fix.status, 0, fix.stderr);
    assert.strictEqual(sh(trustRead(PATH), home).stdout.trim(), "yes");
    const after = JSON.parse(NodeFS.readFileSync(NodePath.join(home, ".claude.json"), "utf8"));
    assert.strictEqual(after.theme, "dark");
    assert.deepStrictEqual(after.projects["/other"], { allowedTools: [1] });
    assert.strictEqual(after.projects[PATH].hasTrustDialogAccepted, true);
  });

  const TOKEN = "sk-secret-token-value";

  it("the proxy env read prints the names that are missing or empty, and never a value", () => {
    const cases: Array<readonly [string, unknown, ReadonlyArray<string>]> = [
      ["both set", { env: { ANTHROPIC_BASE_URL: "http://x", ANTHROPIC_AUTH_TOKEN: TOKEN } }, []],
      ["token empty", { env: { ANTHROPIC_BASE_URL: "http://x", ANTHROPIC_AUTH_TOKEN: "" } }, ["ANTHROPIC_AUTH_TOKEN"]],
      ["url missing", { env: { ANTHROPIC_AUTH_TOKEN: TOKEN } }, ["ANTHROPIC_BASE_URL"]],
      ["no env", {}, ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"]],
    ];
    for (const [name, content, expected] of cases) {
      const home = tempDir("proxy");
      writeJson(home, ".claude/settings.json", content);
      const done = sh(PROXY_ENV_READ, home);
      assert.strictEqual(done.status, 0, name);
      assert.deepStrictEqual(done.stdout.split("\n").filter((l) => l !== ""), expected, name);
      assert.notInclude(done.stdout + done.stderr, TOKEN, name);
    }
  });

  it("the proxy env read exits non-zero when ~/.claude/settings.json is missing", () => {
    const done = sh(PROXY_ENV_READ, tempDir("proxy-missing"));
    assert.notStrictEqual(done.status, 0);
    assert.strictEqual(done.stdout, "");
  });
});

describe("liveSshSpawn", () => {
  const reply = (over: Partial<RunResult>): RunResult => ({
    exitCode: 0,
    timedOut: false,
    tail: "",
    stderrTail: "",
    truncated: false,
    tailTruncated: false,
    ...over,
  });

  const recording = (result: RunResult | Error) => {
    const inputs: Array<RunInput> = [];
    const process = FactoryProcess.of({
      run: (input) => {
        inputs.push(input);
        return result instanceof Error
          ? Effect.fail({ _tag: "RunSpawnError", message: "Failed to spawn a command.", cause: result } as never)
          : Effect.succeed(result);
      },
    });
    return { inputs, run: liveSshSpawn(process) };
  };

  it.effect("runs ssh with stderr apart, the agent socket kept, and the caller's timeout", () =>
    Effect.gen(function* () {
      const fake = recording(reply({ exitCode: 3, tail: "out\n", stderrTail: "err\n" }));
      const args = sshArgs("me@host", TRUE_COMMAND);
      const got = yield* fake.run(args, 10_000);
      assert.deepStrictEqual(got, { exitCode: 3, timedOut: false, stdout: "out\n", stderr: "err\n" });
      const [input] = fake.inputs;
      assert.strictEqual(input!.command, "ssh");
      assert.deepStrictEqual(input!.args, args);
      assert.isTrue(input!.separateStderr);
      assert.strictEqual(input!.timeoutMs, 10_000);
      assert.isTrue(input!.inheritEnv?.includes("SSH_AUTH_SOCK"));
    }),
  );

  it.effect("a timeout is carried through", () =>
    Effect.gen(function* () {
      const got = yield* recording(reply({ exitCode: null, timedOut: true })).run([], 5);
      assert.isTrue(got.timedOut);
    }),
  );

  it.effect("a spawn error is a null exit code with the error's text, never a failure", () =>
    Effect.gen(function* () {
      const got = yield* recording(new Error("ENOENT")).run([], 5);
      assert.strictEqual(got.exitCode, null);
      assert.isFalse(got.timedOut);
      assert.include(got.stderr, "Failed to spawn a command.");
      assert.include(got.stderr, "ENOENT");
    }),
  );
});

const result = (over: Partial<RunResult> = {}): RunResult => ({
  exitCode: 0,
  timedOut: false,
  tail: "",
  stderrTail: "",
  truncated: false,
  tailTruncated: false,
  ...over,
});

/** A process service that answers every run with `answer`, and keeps each input. */
const processAnswering = (answer: RunResult) => {
  const inputs: Array<RunInput> = [];
  const process = FactoryProcess.of({
    run: (input) =>
      Effect.sync(() => {
        inputs.push(input);
        return answer;
      }),
  });
  return { inputs, process };
};

describe("sshRunner", () => {
  it.effect("runs ssh in batch mode with a 10 s connect, the destination after --, and the command as one word", () =>
    Effect.gen(function* () {
      const { inputs, process } = processAnswering(result({ tail: "ok\n" }));
      const answered = yield* sshRunner(process).run("tomk@trilogy-mac", "uptime");
      assert.strictEqual(answered.tail, "ok\n");
      assert.deepStrictEqual(inputs.map((input) => [input.command, input.args, input.timeoutMs]), [
        ["ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "--", "tomk@trilogy-mac", "uptime"], 10_000],
      ]);
    }),
  );

  it.effect("answers the command's own non-zero exit, and takes a longer timeout when asked", () =>
    Effect.gen(function* () {
      const { inputs, process } = processAnswering(result({ exitCode: 1, stderrTail: "No such file" }));
      const answered = yield* sshRunner(process).run("tomk@trilogy-mac", "ls x", { timeoutMs: 120_000 });
      assert.strictEqual(answered.exitCode, 1);
      assert.strictEqual(inputs[0]!.timeoutMs, 120_000);
    }),
  );

  it.effect("exit 255 is ssh's own failure, and a timeout is one too", () =>
    Effect.gen(function* () {
      const refused = yield* sshRunner(processAnswering(result({ exitCode: 255, stderrTail: "Permission denied (publickey).\n" })).process)
        .run("tomk@trilogy-mac", "true")
        .pipe(Effect.flip);
      assert.instanceOf(refused, SshError);
      assert.strictEqual(refused.message, "ssh tomk@trilogy-mac: Permission denied (publickey).");
      const slow = yield* sshRunner(processAnswering(result({ timedOut: true })).process)
        .run("tomk@trilogy-mac", "true")
        .pipe(Effect.flip);
      assert.strictEqual(slow.message, "ssh tomk@trilogy-mac: no answer within 10 s");
    }),
  );
});

describe("shellQuote", () => {
  it("quotes a word so the host's shell reads it back as it is", () => {
    assert.strictEqual(shellQuote("plain"), "'plain'");
    assert.strictEqual(shellQuote("it's $HOME"), `'it'\\''s $HOME'`);
  });
});
