import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { FactoryProcess, type RunInput, type RunResult } from "../process.ts";
import { shellQuote, SshError, sshRunner } from "./ssh.ts";

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
