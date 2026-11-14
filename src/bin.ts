#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - the command line writes to the terminal and exits with a code.
/**
 * `factory-runner`: the command line. `run` is the factory loop in the foreground. The other
 * commands (`install`, `uninstall`, `status`, `runs stop`, `claims`, `hosts check`, `retro`) are in `cli.ts`.
 */
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { runCli, USAGE } from "./cli.ts";
import type { InstallEnv } from "./install.ts";
import { FactoryLayer, FactoryLoop } from "./main.ts";
import * as Paths from "./paths.ts";
import { runCommand } from "./runCommand.ts";
import { takeRunnerLock } from "./runnerLock.ts";

/** The data dir of this process: `FACTORY_RUNNER_HOME`, else `~/.config/factory-runner`. */
const realDataDir = (): string => Paths.dataDirOf(process.env, NodeOS.homedir(), NodePath);

/** The folder holding `package.json`. */
const packageRoot = NodePath.resolve(import.meta.dirname, "..");

/** What install touches on this machine: the real HOME, commands (30 s each), clock and terminal. */
const realInstallEnv = (): InstallEnv => {
  const set = process.env["FACTORY_RUNNER_HOME"];
  const dataDir = realDataDir();
  return {
    home: NodeOS.homedir(),
    dataDir,
    machineConfigPath: NodePath.join(dataDir, "config.yml"),
    factoryRunnerHome: set !== undefined && set !== "" ? set : undefined,
    uid: process.getuid?.() ?? 0,
    execPath: process.execPath,
    pathEnv: process.env["PATH"] ?? "/usr/bin:/bin",
    packageRoot,
    run: (command, args, timeoutMs = 30_000, inheritEnv) => runCommand(command, args, timeoutMs, inheritEnv),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: Date.now,
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  };
};

/** Takes the runner lock, then runs the factory until the process is told to stop or restarts into an update. */
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
  const factory = yield* Layer.build(FactoryLayer);
  // Ends when the runner has staged an update and a pass ended with no gate running: the scope
  // closes, the lock is released and the process exits 0, and launchd starts `current` again.
  return yield* Context.get(factory, FactoryLoop).stopped;
}).pipe(Effect.scoped, Effect.provide(Paths.layer), Effect.provide(NodeServices.layer));

const [command, ...rest] = process.argv.slice(2);
if (command === "run") {
  if (rest.length === 0) {
    NodeRuntime.runMain(run);
  } else {
    console.error(USAGE);
    process.exitCode = 2;
  }
} else {
  const dataDir = realDataDir();
  void runCli(process.argv.slice(2), {
    dataDir,
    machineConfigPath: NodePath.join(dataDir, "config.yml"),
    packageRoot,
    now: Date.now,
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    installEnv: realInstallEnv,
    gh: (args) => runCommand("gh", args, 60_000),
    run: runCommand,
  }).then((code) => {
    process.exitCode = code;
  });
}
