// @effect-diagnostics nodeBuiltinImport:off - small files read and written before or outside any layer: the pause file, the LaunchAgent files, the machine config.
/**
 * The synchronous whole-file write and the missing-is-null read that the pause file, `install` and
 * the operator commands share. The Effect code writes through `files.ts`.
 */
import * as NodeFS from "node:fs";

import { errnoCode } from "./ledger/errors.ts";

/**
 * Writes `text` to `path` whole or not at all, with `mode` (default private to the owner): a temp
 * file made only by this call, synced, then renamed over `path`. A failed rename removes the temp
 * file. The directory is not made.
 */
export const writeFileWhole = (path: string, text: string, mode = 0o600): void => {
  const temp = `${path}.${process.pid}.tmp`;
  const fd = NodeFS.openSync(
    temp,
    NodeFS.constants.O_WRONLY | NodeFS.constants.O_CREAT | NodeFS.constants.O_EXCL,
    mode,
  );
  try {
    NodeFS.writeFileSync(fd, text);
    NodeFS.fsyncSync(fd);
  } finally {
    NodeFS.closeSync(fd);
  }
  try {
    NodeFS.renameSync(temp, path);
  } catch (error) {
    NodeFS.rmSync(temp, { force: true });
    throw error;
  }
};

/** The file's text, or null when it does not exist. Any other failure throws. */
export const readTextOrNull = (path: string): string | null => {
  try {
    return NodeFS.readFileSync(path, "utf8");
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return null;
    throw error;
  }
};
