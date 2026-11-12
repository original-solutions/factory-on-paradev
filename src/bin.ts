#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - the command line writes to the terminal and exits with a code.
/**
 * `factory-runner`: the command line. `run` is the factory loop in the foreground. The other
 * commands (`install`, `status`, ...) arrive with #25.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { FactoryLayer } from "./main.ts";
import * as Paths from "./paths.ts";
import { takeRunnerLock } from "./runnerLock.ts";

const USAGE = "usage: factory-runner run";

/** Takes the runner lock, then runs the factory until the process is told to stop. */
const run = Effect.gen(function* () {
  const { baseDir } = yield* Paths.FactoryPaths;
  const lock = yield* Effect.acquireRelease(
    Effect.sync(() => takeRunnerLock(baseDir)),
    (taken) => Effect.sync(() => (taken.kind === "taken" ? taken.release() : undefined)),
  );
  // The effect ends rather than exiting the process, so the scope closes first; runMain leaves a
  // success's exit code to `process.exitCode`.
  if (lock.kind === "held") {
    return yield* Effect.sync(() => {
      console.error(`factory-runner: another runner holds ${lock.path} (pid ${lock.pid})`);
      process.exitCode = 1;
    });
  }
  yield* Layer.build(FactoryLayer);
  return yield* Effect.never;
}).pipe(Effect.scoped, Effect.provide(Paths.layer), Effect.provide(NodeServices.layer));

const [command, ...rest] = process.argv.slice(2);
if (command === "run" && rest.length === 0) {
  NodeRuntime.runMain(run);
} else {
  console.error(USAGE);
  process.exitCode = 2;
}
