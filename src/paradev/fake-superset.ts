// @effect-diagnostics nodeBuiltinImport:off - Reads the recorded fixtures synchronously, once per answer.
/**
 * A scripted `superset` for tests. It stands in for {@link FactoryProcess}, so `cli.ts` runs as it
 * does for real, and answers each call from `spike/fixtures/2.0.8/`: the fixture's stdout, and the
 * exit code and stderr from its `.meta.json`. A call no step of the script expects is a defect,
 * which fails the test.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { FactoryProcess, type RunInput, type RunResult } from "../process.ts";

export const FIXTURES_DIR = NodePath.resolve(import.meta.dirname, "../../spike/fixtures/2.0.8");

/** The argv without the `--json` the CLI runner adds, or a test of it. */
export type ArgvMatch = ReadonlyArray<string> | ((argv: ReadonlyArray<string>) => boolean);

export interface Step {
  readonly argv: ArgvMatch;
  /** A fixture's name without `.json`, e.g. `ws-get-local-archived`. */
  readonly fixture: string;
  /**
   * Rewrites the fixture's parsed stdout before it is answered: to point a recorded path at a
   * test's own repo, say, or to empty a list. Only for a fixture recorded with stdout.
   */
  readonly edit?: (answer: unknown) => unknown;
}

export interface Answer {
  /** The argv the spike ran, without `--json`. */
  readonly argv: ReadonlyArray<string>;
  readonly exit: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** A fixture as recorded. A failed call has a `.meta.json` and no stdout file. */
export const readFixture = (name: string): Answer => {
  const meta = JSON.parse(
    NodeFS.readFileSync(NodePath.join(FIXTURES_DIR, `${name}.meta.json`), "utf8"),
  ) as { readonly argv: ReadonlyArray<string>; readonly exit: number; readonly stderr: string };
  const stdoutPath = NodePath.join(FIXTURES_DIR, `${name}.json`);
  const stdout = NodeFS.existsSync(stdoutPath) ? NodeFS.readFileSync(stdoutPath, "utf8") : "";
  const argv = meta.argv.filter((arg) => arg !== "--json");
  return { argv, exit: meta.exit, stdout, stderr: meta.stderr };
};

const stripJson = (args: ReadonlyArray<string>): ReadonlyArray<string> =>
  args.at(-1) === "--json" ? args.slice(0, -1) : args;

const matches = (match: ArgvMatch, argv: ReadonlyArray<string>): boolean =>
  typeof match === "function"
    ? match(argv)
    : match.length === argv.length && match.every((arg, i) => arg === argv[i]);

/**
 * Each call takes the first step not yet used whose argv matches; a step answers once.
 * `calls` holds every argv seen, `--json` stripped; `unused` the steps no call took.
 */
export const fakeSuperset = (script: ReadonlyArray<Step>) => {
  const left = [...script];
  const calls: Array<ReadonlyArray<string>> = [];
  const run = (input: RunInput) =>
    Effect.suspend(() => {
      const argv = stripJson(input.args ?? []);
      calls.push(argv);
      const at = left.findIndex((step) => matches(step.argv, argv));
      if (at === -1) {
        return Effect.die(new Error(`fake superset: unexpected argv ${JSON.stringify(argv)}`));
      }
      const [step] = left.splice(at, 1);
      const answer = readFixture(step!.fixture);
      const stdout =
        step!.edit === undefined
          ? answer.stdout
          : `${JSON.stringify(step!.edit(JSON.parse(answer.stdout) as unknown))}\n`;
      return Effect.succeed({
        exitCode: answer.exit,
        timedOut: false,
        tail: stdout,
        stderrTail: answer.stderr,
        truncated: false,
        tailTruncated: false,
      } satisfies RunResult);
    });
  return {
    layer: Layer.succeed(FactoryProcess, FactoryProcess.of({ run })),
    calls,
    unused: (): ReadonlyArray<Step> => [...left],
  };
};
