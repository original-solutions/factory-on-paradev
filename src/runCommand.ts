// @effect-diagnostics nodeBuiltinImport:off - a synchronous command runner for the command line.
/**
 * The command line's synchronous runner: `install`, `retro` and `hosts check` spawn through it.
 */
import * as NodeChildProcess from "node:child_process";

import type { CommandResult } from "./install.ts";
import { buildEnv } from "./process.ts";

/**
 * Runs a command to the end, or until `timeoutMs`. With `inheritEnv`, the command gets only those
 * names from this process's environment, so a secret exported in the shell does not reach it;
 * without, it gets the whole environment.
 */
export const runCommand = (
  command: string,
  args: ReadonlyArray<string>,
  timeoutMs: number,
  inheritEnv?: ReadonlyArray<string>,
): CommandResult => {
  const done = NodeChildProcess.spawnSync(command, [...args], {
    encoding: "utf8",
    timeout: timeoutMs,
    ...(inheritEnv !== undefined && { env: buildEnv(undefined, inheritEnv) }),
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
};
