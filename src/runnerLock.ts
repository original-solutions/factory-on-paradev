// @effect-diagnostics nodeBuiltinImport:off - the lock is a file in the data dir, taken before any layer builds.
/**
 * One runner per data dir: `<data>/runner.lock` holds the pid of the runner that has it. A lock
 * whose pid is no longer a runner is stale, and the next runner takes it over.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { errnoCode } from "./ledger/errors.ts";

export const LOCK_FILE = "runner.lock";

export type Lock =
  /** This process holds the lock; `release` removes it while it still names this pid. */
  | { readonly kind: "taken"; readonly path: string; readonly release: () => void }
  /** Another live runner holds it. */
  | { readonly kind: "held"; readonly path: string; readonly pid: number };

/** Whether a process with `pid` is alive: one this user may not signal is alive too. */
export const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errnoCode(error) === "EPERM";
  }
};

/**
 * Whether `pid` is a runner: alive, and running `bin.ts`, as `factory-runner run` and the
 * LaunchAgent both do. After a crash or a reboot the dead runner's pid can belong to another
 * process, which does not hold the lock. When `ps` cannot say, a live pid counts as a runner.
 */
export const isRunner = (pid: number): boolean => {
  if (!isAlive(pid)) return false;
  const shown = NodeChildProcess.spawnSync("ps", ["-p", String(pid), "-o", "command="], {
    encoding: "utf8",
    timeout: 5_000,
  });
  if (shown.error !== undefined || shown.status === null) return true;
  return shown.status === 0 && /\bbin\.ts\b|\bfactory-runner\b/.test(shown.stdout);
};

/** The pid in a lock file, or null when the file is gone or holds no pid. */
const readPid = (path: string): number | null => {
  try {
    const text = NodeFS.readFileSync(path, "utf8").trim();
    return /^[1-9][0-9]*$/.test(text) ? Number(text) : null;
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return null;
    throw error;
  }
};

/**
 * Takes `<dataDir>/runner.lock` for `pid`, making the data dir when it is not there. The lock is
 * made whole by a hard link from a file that already holds the pid, so no runner reads it empty.
 * A lock held by a runner other than `pid` is `held`. One whose pid is no runner is stale: it is
 * renamed aside, which only one taker can do, and taken over; a lock that turns out to have been
 * taken over by another runner in the meantime is put back.
 */
export const takeRunnerLock = (
  dataDir: string,
  pid: number = process.pid,
  runner: (pid: number) => boolean = isRunner,
): Lock => {
  NodeFS.mkdirSync(dataDir, { recursive: true });
  const path = NodePath.join(dataDir, LOCK_FILE);
  const mine = `${path}.${pid}.tmp`;
  const aside = `${path}.${pid}.stale`;
  const release = () => {
    if (readPid(path) === pid) NodeFS.rmSync(path, { force: true });
  };
  NodeFS.writeFileSync(mine, `${pid}\n`, { mode: 0o600 });
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        NodeFS.linkSync(mine, path);
        return { kind: "taken", path, release };
      } catch (error) {
        if (errnoCode(error) !== "EEXIST") throw error;
      }
      const holder = readPid(path);
      if (holder === pid) return { kind: "taken", path, release };
      if (holder !== null && runner(holder)) return { kind: "held", path, pid: holder };
      try {
        NodeFS.renameSync(path, aside);
      } catch (error) {
        // Another taker moved it first: look again.
        if (errnoCode(error) === "ENOENT") continue;
        throw error;
      }
      if (readPid(aside) !== holder) {
        // Not the stale lock read above: a runner took it over since. Put it back.
        try {
          NodeFS.linkSync(aside, path);
        } catch (error) {
          if (errnoCode(error) !== "EEXIST") throw error;
        }
      }
      NodeFS.rmSync(aside, { force: true });
    }
    return { kind: "held", path, pid: readPid(path) ?? 0 };
  } finally {
    NodeFS.rmSync(mine, { force: true });
  }
};
