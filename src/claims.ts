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

/** The file in the data dir that autodeploy.sh writes while a build waits to be installed. */
export const DEPLOY_PENDING_FILE = "deploy-pending";

/**
 * The file in the data dir that snoozes a waiting build: `<epoch seconds> <count>`, the snooze's
 * end and the snoozes so far. Until the end the pass claims as normal and autodeploy.sh installs
 * nothing; the file stays until the build is installed.
 */
const DEPLOY_SNOOZED_FILE = "deploy-snoozed";

/** The file in the data dir that asks autodeploy.sh to install the build `<sha>` on its next tick. */
const DEPLOY_NOW_FILE = "deploy-now";

/** How long one snooze lasts. */
const DEPLOY_SNOOZE_MS = 60 * 60_000;

/** Snoozes one waiting build can have, so snoozing cannot hold an update off for good. */
export const DEPLOY_SNOOZE_LIMIT = 3;

/**
 * Three ticks of the 10-minute autodeploy job: a `deploy-pending` not rewritten in that long
 * belongs to an autodeploy that is not asking about runs, so it holds nothing back.
 * autodeploy.sh's `pending_stale_minutes` is the same span; change both together.
 */
export const PENDING_STALE_MS = 30 * 60_000;

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

/** A build autodeploy has waiting, as the data dir has it. */
export interface PendingDeploy {
  /** When the first build left waiting was found, in Unix epoch milliseconds. */
  readonly sinceMs: number;
  /** The newest build waiting, as a hex sha; null when the file does not name one. */
  readonly commit: string | null;
  /**
   * When autodeploy last wrote the file, in Unix epoch milliseconds: its modification time. The
   * script rewrites it on every tick that reads the status, so an old one has no ticker behind it.
   */
  readonly writtenMs: number;
}

/**
 * The build autodeploy.sh has waiting: `deploy-pending` in the data dir holds `<epoch seconds>
 * <sha>` while one is. A missing file, symlink or FIFO is nothing pending. A first word that is not
 * whole seconds, or a file that cannot be opened, is pending since the file's mtime.
 */
export const loadPendingDeploy = (dataDir: string): PendingDeploy | null => {
  const marker = readMarker(NodePath.join(dataDir, DEPLOY_PENDING_FILE));
  if (marker === null) return null;
  const words = marker.text.trim().split(/\s+/);
  const since = words[0] ?? "";
  const sha = words[1] ?? "";
  return {
    sinceMs: /^[0-9]+$/.test(since) ? Number(since) * 1000 : marker.mtimeMs,
    commit: /^[0-9a-f]{7,40}$/.test(sha) ? sha : null,
    writtenMs: marker.mtimeMs,
  };
};

/** `deploy-snoozed` read: the snooze's end in epoch seconds, and how many snoozes the build has had. */
const readSnooze = (
  dataDir: string,
): { readonly endSecs: number; readonly count: number } | null => {
  const marker = readMarker(NodePath.join(dataDir, DEPLOY_SNOOZED_FILE));
  if (marker === null) return null;
  const [end = "", count = "1"] = marker.text.trim().split(/\s+/);
  if (!/^[0-9]{1,12}$/.test(end)) return null;
  return { endSecs: Number(end), count: /^[0-9]{1,3}$/.test(count) ? Number(count) : 1 };
};

/**
 * The end of the snooze in `deploy-snoozed`, in Unix epoch milliseconds, whether or not it has
 * passed; null when there is no regular file or its text is not whole seconds.
 */
export const loadDeploySnooze = (dataDir: string): number | null => {
  const snooze = readSnooze(dataDir);
  return snooze === null ? null : snooze.endSecs * 1000;
};

/**
 * A build waiting to be installed, as the pass and the status take it: snoozed until
 * `snoozedUntilMs`, or counting `deploy_wait_minutes` from `clockFromMs`, the first wait or the
 * end of a snooze that has ended when that is later.
 */
export type DeployWait =
  | {
      readonly pending: PendingDeploy;
      readonly snoozedUntilMs: number;
      readonly clockFromMs: null;
    }
  | {
      readonly pending: PendingDeploy;
      readonly snoozedUntilMs: null;
      readonly clockFromMs: number;
    };

/**
 * The waiting build from the two markers as of `nowMs`: null when nothing is pending or the marker
 * is older than {@link PENDING_STALE_MS}.
 */
export const deployWait = (
  pending: PendingDeploy | null,
  snoozeEndMs: number | null,
  nowMs: number,
): DeployWait | null => {
  if (pending === null || nowMs - pending.writtenMs > PENDING_STALE_MS) return null;
  if (snoozeEndMs !== null && snoozeEndMs > nowMs) {
    return { pending, snoozedUntilMs: snoozeEndMs, clockFromMs: null };
  }
  return {
    pending,
    snoozedUntilMs: null,
    clockFromMs: Math.max(pending.sinceMs, snoozeEndMs ?? pending.sinceMs),
  };
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

/** Removes a marker file; one that is not there is fine. */
const removeMarker = (path: string) => {
  try {
    NodeFS.unlinkSync(path);
  } catch (error) {
    if (errnoCode(error) !== "ENOENT") throw error;
  }
};

/** The sha in `deploy-now`, the build a person asked to install; null when there is none. */
const loadDeployNow = (dataDir: string): string | null => {
  const marker = readMarker(NodePath.join(dataDir, DEPLOY_NOW_FILE));
  if (marker === null) return null;
  const sha = marker.text.trim();
  return /^[0-9a-f]{7,40}$/.test(sha) ? sha : null;
};

/** What {@link snoozeDeploy} did. */
export type Snoozed =
  /** Snoozed until `untilMs`, whole seconds. */
  | { readonly kind: "snoozed"; readonly untilMs: number }
  /** The build has had {@link DEPLOY_SNOOZE_LIMIT} snoozes; nothing was written. */
  | { readonly kind: "limit" }
  /** A person asked to install this build now, which a snooze does not undo; nothing was written. */
  | { readonly kind: "deploy_now" };

/**
 * Snoozes the waiting build `commit` for {@link DEPLOY_SNOOZE_MS} from `nowMs`, replacing any
 * snooze. The file keeps the count until autodeploy installs the build, so the waiting build gets
 * at most {@link DEPLOY_SNOOZE_LIMIT}. An update now asked for an older build is withdrawn.
 */
export const snoozeDeploy = (dataDir: string, nowMs: number, commit: string | null): Snoozed => {
  const asked = loadDeployNow(dataDir);
  if (asked !== null && asked === commit) return { kind: "deploy_now" };
  const count = readSnooze(dataDir)?.count ?? 0;
  if (count >= DEPLOY_SNOOZE_LIMIT) return { kind: "limit" };
  const endSecs = Math.floor((nowMs + DEPLOY_SNOOZE_MS) / 1000);
  writeMarker(NodePath.join(dataDir, DEPLOY_SNOOZED_FILE), `${endSecs} ${count + 1}\n`);
  removeMarker(NodePath.join(dataDir, DEPLOY_NOW_FILE));
  return { kind: "snoozed", untilMs: endSecs * 1000 };
};

/**
 * Asks autodeploy.sh to install build `commit` on its next tick; it drops the request when main
 * has moved past it. A snooze in force ends at `nowMs` and keeps its count.
 */
export const requestDeployNow = (dataDir: string, nowMs: number, commit: string) => {
  writeMarker(NodePath.join(dataDir, DEPLOY_NOW_FILE), `${commit}\n`);
  const snooze = readSnooze(dataDir);
  const nowSecs = Math.floor(nowMs / 1000);
  if (snooze !== null && snooze.endSecs > nowSecs) {
    writeMarker(NodePath.join(dataDir, DEPLOY_SNOOZED_FILE), `${nowSecs} ${snooze.count}\n`);
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
