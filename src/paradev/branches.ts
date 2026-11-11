// @effect-diagnostics nodeBuiltinImport:off - Hashes a command id, synchronously.
/**
 * The branch a launch asks Paradev for, derived from its command id, so a retried launch asks
 * for the same branch and `workspaces create` answers the same workspace. Paradev puts a local
 * worktree at `~/.paradev/worktrees/<project name>/<branch>`, the branch's slashes kept as
 * folders, and never renames the branch after create.
 */
import * as NodeCrypto from "node:crypto";

import { parseRunId, type RunId } from "../ledger/runId.ts";

/** The sha256 of `text`, as lowercase hex. */
export const sha256 = (text: string): string =>
  NodeCrypto.createHash("sha256").update(text).digest("hex");

/** A run's command id, `softfac:<run id>:<what>`. A run id holds no `:`. */
const RUN_COMMAND = /^softfac:([^:]+):(.+)$/;

const runOf = (runId: string): RunId | null => {
  try {
    return parseRunId(runId);
  } catch {
    return null;
  }
};

/**
 * `softfac:<owner>__<repo>__<issue>__<attempt>:launch` gives `fac/<issue>-<attempt>`. Any other id
 * of a run adds the first 8 hex of its sha256. An id that does not parse, or names an issue that
 * is not a number, gives `fac/x-` and the first 12 hex of its sha256.
 */
export const launchBranch = (commandId: string): string => {
  const match = RUN_COMMAND.exec(commandId);
  const run = match === null ? null : runOf(match[1]!);
  if (run === null || !/^\d+$/.test(run.issue)) return `fac/x-${sha256(commandId).slice(0, 12)}`;
  const branch = `fac/${run.issue}-${run.attempt}`;
  return match![2] === "launch" ? branch : `${branch}-${sha256(commandId).slice(0, 8)}`;
};

const LAUNCH_BRANCH = /^fac\/(\d+|x)-[0-9a-f-]+$/;

/**
 * Whether `branch` is a branch {@link launchBranch} makes and `worktreePath` is a Paradev worktree
 * on it: the path ends with `/<branch>`.
 */
export const isLaunchBranch = (branch: string, worktreePath: string | null): boolean =>
  worktreePath !== null && LAUNCH_BRANCH.test(branch) && worktreePath.endsWith(`/${branch}`);

/** The launch branch read back from a Paradev worktree path (the inverse of `isLaunchBranch`). */
export const launchBranchOf = (worktreePath: string | null): string | null => {
  const parts = worktreePath?.split("/") ?? [];
  if (parts.length < 2 || parts.at(-2) !== "fac") return null;
  const branch = `fac/${parts.at(-1)}`;
  return isLaunchBranch(branch, worktreePath) ? branch : null;
};

/**
 * The folder Paradev makes worktrees under, from one worktree's path: `/<project>/<branch>` cut
 * off. Null when the path does not end that way.
 */
export const worktreesRootOf = (worktreePath: string, branch: string): string | null => {
  const suffix = `/${branch}`;
  if (!worktreePath.endsWith(suffix)) return null;
  const project = worktreePath.slice(0, -suffix.length);
  const cut = project.lastIndexOf("/");
  return cut <= 0 ? null : project.slice(0, cut);
};
