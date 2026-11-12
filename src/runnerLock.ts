// @effect-diagnostics nodeBuiltinImport:off - the lock is a file in the data dir, taken before any layer builds.
/**
 * One runner per data dir: `<data>/runner.lock` holds the pid of the runner that has it. A lock
 * whose pid is no longer alive is stale, and the next runner takes it over.
 */
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

/** The pid in the lock file, or null when the file is gone or holds no pid. */
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
 * Takes `<dataDir>/runner.lock` for `pid`, making the data dir when it is not there. A lock held
 * by a live pid other than `pid` is `held`; one whose pid is dead, or that holds no pid, is taken
 * over.
 */
export const takeRunnerLock = (
  dataDir: string,
  pid: number = process.pid,
  alive: (pid: number) => boolean = isAlive,
): Lock => {
  NodeFS.mkdirSync(dataDir, { recursive: true });
  const path = NodePath.join(dataDir, LOCK_FILE);
  const release = () => {
    if (readPid(path) === pid) NodeFS.rmSync(path, { force: true });
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      NodeFS.writeFileSync(path, `${pid}\n`, { flag: "wx", mode: 0o600 });
      return { kind: "taken", path, release };
    } catch (error) {
      if (errnoCode(error) !== "EEXIST") throw error;
    }
    const holder = readPid(path);
    if (holder === pid) return { kind: "taken", path, release };
    if (holder !== null && alive(holder)) return { kind: "held", path, pid: holder };
    // Stale: its runner is gone. Another runner taking it over at the same moment wins the
    // `wx` write after this removal, and this one then reads it as held.
    NodeFS.rmSync(path, { force: true });
  }
  const holder = readPid(path);
  return { kind: "held", path, pid: holder ?? 0 };
};
