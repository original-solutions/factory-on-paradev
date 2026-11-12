#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - the command line writes to the terminal and exits with a code.
/**
 * `factory-runner`: the command line. `run` is the factory loop in the foreground. The other
 * commands (`install`, `uninstall`, `status`, `runs stop`, `claims`, `retro`) are in `cli.ts`.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { runCli, USAGE } from "./cli.ts";
import type { InstallEnv } from "./install.ts";
import { FactoryLayer } from "./main.ts";
import * as Paths from "./paths.ts";
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
    run: (command, args) => {
      const done = NodeChildProcess.spawnSync(command, [...args], {
        encoding: "utf8",
        timeout: 30_000,
      });
      return {
        status: done.status,
        stdout: done.stdout ?? "",
        // A timeout or a missing CLI sets `error` and leaves stderr empty; say so.
        stderr:
          done.error !== undefined
            ? `${done.error.message}\n${done.stderr ?? ""}`
            : (done.stderr ?? ""),
      };
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: Date.now,
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  };
};

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
    gh: (args) => {
      const done = NodeChildProcess.spawnSync("gh", [...args], {
        encoding: "utf8",
        timeout: 60_000,
      });
      return {
        status: done.status,
        stdout: done.stdout ?? "",
        stderr:
          done.error !== undefined
            ? `${done.error.message}\n${done.stderr ?? ""}`
            : (done.stderr ?? ""),
      };
    },
  }).then((code) => {
    process.exitCode = code;
  });
}
