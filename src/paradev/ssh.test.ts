import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

import {
  CLAUDE_VERSION,
  fetchBase,
  fromCommandRunner,
  GH_AUTH_STATUS,
  GIT_EMAIL,
  isAllowed,
  LOAD_COMMAND,
  lsofCwd,
  PGREP_CLAUDE,
  PROXY_ENV_READ,
  remoteUrl,
  resetToCommit,
  runSsh,
  SSH_TIMEOUT_MS,
  sessionListing,
  shellQuote,
  sshArgs,
  TRUE_COMMAND,
  trustRead,
  type SshAnswer,
  type SshRunner,
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
  const run: SshRunner = (args, timeoutMs) => {
    calls.push({ args, timeoutMs });
    return Effect.succeed(reply);
  };
  return { calls, run };
};

const SHA = "0123456789abcdef0123456789abcdef01234567";

describe("sshArgs", () => {
  it("is BatchMode, a 10 s connect timeout, the destination, then the command", () => {
    assert.deepStrictEqual(sshArgs("me@host", "true"), [
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=10",
      "me@host",
      "true",
    ]);
  });
});

describe("isAllowed", () => {
  it("accepts the constant read-only commands and every builder's output", () => {
    const commands = [
      LOAD_COMMAND,
      TRUE_COMMAND,
      PGREP_CLAUDE,
      lsofCwd(4242),
      sessionListing("/Users/me/.paradev/worktrees/proj/fac/1-1"),
      remoteUrl("/Users/me/code/repo"),
      trustRead("/Users/me/code/repo"),
      PROXY_ENV_READ,
      GIT_EMAIL,
      GH_AUTH_STATUS,
      CLAUDE_VERSION,
      fetchBase("/Users/me/wt", "main"),
      resetToCommit("/Users/me/wt", SHA),
    ];
    for (const command of commands) assert.isTrue(isAllowed(command), command);
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
      `git -C 'a' reset --hard ${SHA.slice(0, 7)}`,
      `git -C 'a' reset --hard ${SHA} --force`,
      "lsof -a -d cwd -p 0",
      "lsof -a -d cwd -p 12; id",
      "ls -t ~/.claude/projects/a b/*.jsonl",
      "ls -t ~/.claude/projects/../../*.jsonl",
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
  it("the session folder is the worktree path with every non-alphanumeric turned into -", () => {
    assert.strictEqual(
      sessionListing("/Users/me/.paradev/worktrees/p/fac/1-1"),
      "ls -t ~/.claude/projects/-Users-me--paradev-worktrees-p-fac-1-1/*.jsonl",
    );
  });

  it("quotes each path, and the commit must be 40 hex", () => {
    assert.strictEqual(remoteUrl("/a b"), "git -C '/a b' remote get-url origin");
    assert.strictEqual(fetchBase("/wt", "main"), "git -C '/wt' fetch origin 'main'");
    assert.strictEqual(resetToCommit("/wt", SHA), `git -C '/wt' reset --hard ${SHA}`);
    assert.throws(() => resetToCommit("/wt", "abc123"));
    assert.throws(() => resetToCommit("/wt", `${SHA}; id`));
  });

  it("the trust read names the file, and carries no single quote inside its script", () => {
    const command = trustRead("/Users/me/repo");
    assert.include(command, ".claude.json");
    assert.include(command, "hasTrustDialogAccepted");
    assert.isTrue(command.endsWith(" '/Users/me/repo'"));
  });

  it("the proxy env read names the two keys and never reads a value out", () => {
    assert.include(PROXY_ENV_READ, "ANTHROPIC_BASE_URL");
    assert.include(PROXY_ENV_READ, "ANTHROPIC_AUTH_TOKEN");
    assert.include(PROXY_ENV_READ, ".claude/settings.json");
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

  it.effect("a process ended by a signal says so", () =>
    Effect.gen(function* () {
      const fake = recorder(answer({ exitCode: null }));
      const result = yield* Effect.result(runSsh(fake.run, "me@host", TRUE_COMMAND));
      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) assert.include(result.failure.message, "ended by a signal");
    }),
  );
});

describe("fromCommandRunner", () => {
  it.effect("maps a status, and a null status to a null exit code", () =>
    Effect.gen(function* () {
      const seen: Array<{ command: string; args: ReadonlyArray<string>; timeoutMs: number }> = [];
      const run = fromCommandRunner((command, args, timeoutMs) => {
        seen.push({ command, args, timeoutMs });
        return { status: 0, stdout: "x", stderr: "" };
      });
      const ok = yield* run(["a"], 5);
      assert.deepStrictEqual(ok, { exitCode: 0, timedOut: false, stdout: "x", stderr: "" });
      assert.deepStrictEqual(seen, [{ command: "ssh", args: ["a"], timeoutMs: 5 }]);
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
