// @effect-diagnostics nodeBuiltinImport:off - the pause file is read and written the way softfac does it.
/**
 * Claims paused by hand: the file `claims-paused` in the data directory. While it is there a pass
 * claims no ready issue of any repo, and everything else in the pass goes on. `pauseClaims`
 * writes it and `resumeClaims` removes it.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { errnoCode } from "./ledger/errors.ts";
import { formatTs, parseTs } from "./ledger/time.ts";

/** The file in the data dir that holds claims back by hand. */
export const PAUSE_FILE = "claims-paused";

/** Claims held back by a person, as the data dir has it. */
export interface HandPause {
  /**
   * When the pause was made, in Unix epoch milliseconds: the time in the file, or the file's
   * modification time when a person wrote it by hand and the text is not a time.
   */
  readonly sinceMs: number;
}

/** What a marker file holds: its text (empty when unreadable) and its modification time. */
interface Marker {
  readonly text: string;
  readonly mtimeMs: number;
}

/**
 * Reads a marker file in the data dir: a regular file only; a missing file, symlink or FIFO is
 * null. A file that exists but cannot be opened has no text and the mtime `lstat` gives (0 when
 * even that fails).
 */
const readMarker = (path: string): Marker | null => {
  let fd: number;
  try {
    // Without following a symlink and without blocking, so a FIFO put there cannot hang the pass.
    fd = NodeFS.openSync(
      path,
      NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW | NodeFS.constants.O_NONBLOCK,
    );
  } catch (error) {
    // ELOOP is a symlink refused by O_NOFOLLOW.
    const code = errnoCode(error);
    if (code === "ENOENT" || code === "ELOOP") return null;
    const unopened = unopenedMarker(path);
    return unopened === null ? null : { text: "", mtimeMs: unopened.mtimeMs };
  }
  try {
    const stat = NodeFS.fstatSync(fd);
    if (!stat.isFile()) return null;
    let text = "";
    try {
      text = NodeFS.readFileSync(fd, "utf8");
    } catch {
      text = "";
    }
    return { text, mtimeMs: Math.floor(stat.mtimeMs) };
  } finally {
    NodeFS.closeSync(fd);
  }
};

/** A marker file that is there but could not be opened, by what `lstat` says of it. */
const unopenedMarker = (path: string): { readonly mtimeMs: number } | null => {
  let stat: NodeFS.Stats;
  try {
    stat = NodeFS.lstatSync(path);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return null;
    return { mtimeMs: 0 };
  }
  return stat.isFile() ? { mtimeMs: Math.floor(stat.mtimeMs) } : null;
};

/**
 * The pause on disk: any regular file is a pause, whatever it holds; a missing file, symlink or
 * FIFO is none. Unparseable text falls back to the mtime, then to 0. A file that exists but cannot
 * be opened is still a pause: a person made it to stop claims.
 */
export const loadHandPause = (dataDir: string): HandPause | null => {
  const marker = readMarker(NodePath.join(dataDir, PAUSE_FILE));
  if (marker === null) return null;
  return { sinceMs: parseTs(marker.text.trim()) ?? marker.mtimeMs };
};

/** Writes `text` to `path` whole or not at all, private to the owner, replacing what is there. */
const writeMarker = (path: string, text: string) => {
  const temp = `${path}.${process.pid}.tmp`;
  const fd = NodeFS.openSync(
    temp,
    NodeFS.constants.O_WRONLY | NodeFS.constants.O_CREAT | NodeFS.constants.O_EXCL,
    0o600,
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

/** What {@link pauseClaims} found. */
export type Paused =
  /** Claims were not paused, and now are. */
  | { readonly kind: "now" }
  /** Claims were already paused since `sinceMs`, and the file is as it was. */
  | { readonly kind: "already"; readonly sinceMs: number };

/**
 * Pauses claims at `nowMs` by writing `<data dir>/claims-paused`, whole or not at all and
 * private to the owner. A pause that is already there keeps its time and nothing is written.
 * The data directory is not made: one that is not there is an error.
 */
export const pauseClaims = (dataDir: string, nowMs: number): Paused => {
  const pause = loadHandPause(dataDir);
  if (pause !== null) return { kind: "already", sinceMs: pause.sinceMs };
  writeMarker(NodePath.join(dataDir, PAUSE_FILE), `${formatTs(nowMs)}\n`);
  return { kind: "now" };
};

/**
 * Lets the passes claim again by removing the file: `true` when it was there, `false` when claims
 * were not paused.
 */
export const resumeClaims = (dataDir: string): boolean => {
  try {
    NodeFS.unlinkSync(NodePath.join(dataDir, PAUSE_FILE));
    return true;
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return false;
    throw error;
  }
};
