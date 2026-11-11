// @effect-diagnostics nodeBuiltinImport:off - softfac's write rules need raw fds: O_NOFOLLOW, O_NONBLOCK and fsync.
// @effect-diagnostics globalDate:off - the default clock is the wall clock softfac stamps lines with.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  AppendFile,
  ensureDir,
  nodeIo,
  openForAppend,
  parentOf,
  syncAt,
  syncDir,
  type AppendIo,
  type SyncDir,
} from "./appendFile.ts";
import { LedgerUnknownEventError, LedgerIoError, errnoCode, isLedgerError } from "./errors.ts";
import { MACHINE_EVENT_FIELDS, buildData, issueKeyJson, type MachineEvent } from "./events.ts";
import { NEWLINE } from "./limits.ts";
import { decodeLine, field, isBlankLine, lineHead, scanLinesBack } from "./read.ts";
import { formatTs } from "./time.ts";

/** The file in the data dir that takes the events that belong to no run. */
export const MACHINE_LOG = "events.jsonl";

const NOT_REGULAR = "not a regular file, so it is not followed";

export type MachineLogOptions = {
  /** Returns the current time as Unix epoch milliseconds. Defaults to the system clock. */
  readonly clock?: () => number;
  /** The write and fsync an append performs. Defaults to `node:fs`; a test injects failures. */
  readonly io?: AppendIo;
  /** Flushes a directory to disk after the log is made. Defaults to an fsync. */
  readonly syncDir?: SyncDir;
};

/**
 * The machine log: `<data dir>/events.jsonl`, one line per event in the ledger's line format
 * without a cause, with the ledger's write rules (owner-private, one write plus sync per
 * event, a cut-off line ended before the next, a non-regular file refused). Append-only.
 */
export class MachineLog {
  private readonly out: AppendFile;
  private readonly clock: () => number;

  private constructor(out: AppendFile, clock: () => number) {
    this.out = out;
    this.clock = clock;
  }

  /**
   * Open the log for append, making it (and the data dir) if they are missing. The data dir and
   * its parent are synced on every open, not only when this call made them, so an open that
   * made them and then failed to sync leaves them for the retry to sync.
   */
  static open(dataDir: string, options: MachineLogOptions = {}): MachineLog {
    const path = NodePath.join(dataDir, MACHINE_LOG);
    const sync = options.syncDir ?? syncDir;
    try {
      ensureDir(dataDir);
    } catch (error) {
      throw new LedgerIoError({ path: dataDir, cause: error });
    }
    const io = options.io ?? nodeIo;
    const file = existingRegularFile(path) ? openForAppend(path, io) : createLog(path, io);
    try {
      syncAt(sync, dataDir);
      syncAt(sync, parentOf(dataDir));
    } catch (error) {
      file.close();
      throw error;
    }
    return new MachineLog(file, options.clock ?? Date.now);
  }

  /**
   * Append one event as one line: a single write of the whole line, then a sync. Throws
   * `UnknownEvent`, writing nothing, for an event name that ledger.md does not list.
   */
  append(event: MachineEvent): void {
    if (!Object.hasOwn(MACHINE_EVENT_FIELDS, event.event)) {
      throw new LedgerUnknownEventError({ event: String(event.event) });
    }
    const ms = this.clock();
    let line: string;
    try {
      // An issue key is written the way softfac's `IssueKey` serialises: a number or a string.
      const issue = "issue" in event.data ? { issue: issueKeyJson(event.data.issue) } : {};
      const data = buildData(MACHINE_EVENT_FIELDS[event.event], event.data, issue);
      line = `${JSON.stringify({ ts: formatTs(ms), ms, event: event.event, data })}\n`;
    } catch (error) {
      throw new LedgerIoError({ path: this.out.path, cause: error });
    }
    this.out.writeLine(line);
  }

  /** Release the file handle. Appending after this fails with `Io`. */
  close(): void {
    this.out.close();
  }
}

/** Make the log, owner-only. Read access lets an append check how the file ends. */
const createLog = (path: string, io: AppendIo): AppendFile => {
  try {
    // The check before this and the open are two calls, so the open refuses a symlink itself.
    const fd = NodeFS.openSync(
      path,
      NodeFS.constants.O_RDWR |
        NodeFS.constants.O_APPEND |
        NodeFS.constants.O_CREAT |
        NodeFS.constants.O_NOFOLLOW,
      0o600,
    );
    return new AppendFile(path, fd, io);
  } catch (error) {
    throw new LedgerIoError({ path, cause: error });
  }
};

/** True when `path` is a regular file, false when it is missing; anything else is refused. */
const existingRegularFile = (path: string): boolean => {
  let isFile: boolean;
  try {
    isFile = NodeFS.lstatSync(path).isFile();
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return false;
    throw new LedgerIoError({ path, cause: error });
  }
  if (!isFile) throw new LedgerIoError({ path, cause: new Error(NOT_REGULAR) });
  return true;
};

/** One line of the machine log as read back. The event and its data are as written. */
export type MachineEntry = {
  /** RFC 3339 UTC, as written in the file. */
  readonly ts: string;
  /** Unix epoch milliseconds. */
  readonly ms: number;
  readonly event: string;
  /** `null` when the line has no `data`. */
  readonly data: unknown;
};

/**
 * Opens the log for reading and runs `use` on the handle, closing it after. A missing file is
 * `empty`. A symlink or anything else that is not a regular file is refused: the file is opened
 * without following a symlink and without blocking, and checked on the open handle, so a swap
 * after the check is not followed.
 */
const withLogFd = <A>(dataDir: string, empty: A, use: (fd: number, path: string) => A): A => {
  const path = NodePath.join(dataDir, MACHINE_LOG);
  let fd: number;
  try {
    fd = NodeFS.openSync(
      path,
      NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW | NodeFS.constants.O_NONBLOCK,
    );
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return empty;
    throw new LedgerIoError({ path, cause: error });
  }
  try {
    if (!NodeFS.fstatSync(fd).isFile()) throw new Error(NOT_REGULAR);
    return use(fd, path);
  } catch (error) {
    throw isLedgerError(error) ? error : new LedgerIoError({ path, cause: error });
  } finally {
    NodeFS.closeSync(fd);
  }
};

/** The entry on one line (without its newline), or `null` for a blank or invalid line. */
const entryOfLine = (line: Uint8Array): MachineEntry | null => {
  if (isBlankLine(line)) return null;
  const object = decodeLine(line);
  return object === null ? null : lineHead(object);
};

/**
 * Every line of the machine log, oldest first. A line that is not valid (such as the last one,
 * when a crash cut it off) is skipped, and a last line with no newline is still read if it
 * parses. A missing file is an empty log. A symlink or anything else that is not a regular file
 * is refused, as the log refuses to append to one.
 */
export const scanMachineLog = (dataDir: string): Array<MachineEntry> => {
  const bytes = withLogFd(dataDir, Buffer.alloc(0), (fd) => NodeFS.readFileSync(fd));
  const entries: Array<MachineEntry> = [];
  let start = 0;
  while (start < bytes.length) {
    const newline = bytes.indexOf(NEWLINE, start);
    const end = newline === -1 ? bytes.length : newline;
    const entry = entryOfLine(bytes.subarray(start, end));
    start = end + 1;
    if (entry !== null) entries.push(entry);
  }
  return entries;
};

/**
 * Calls `visit` with the lines of the machine log, newest first, until it answers `"stop"`, and
 * returns how many bytes it read. The log is never rotated, so it is read backwards in chunks.
 * Opens the file and skips lines exactly as {@link scanMachineLog} does.
 */
export const scanMachineLogBack = (
  dataDir: string,
  visit: (entry: MachineEntry) => "continue" | "stop",
  firstChunk?: number,
): number =>
  withLogFd(dataDir, 0, (fd) =>
    scanLinesBack(
      fd,
      (line) => {
        const entry = entryOfLine(line);
        return entry === null ? "continue" : visit(entry);
      },
      firstChunk,
    ),
  );

/**
 * The entries of the machine log at or after `sinceMs`, oldest first: `scanMachineLogBack` read
 * until the first entry older than `sinceMs`, so the months before it are never decoded. A missing
 * log is an empty one. `firstChunk` is passed on, for a test of the chunking.
 */
export const machineLogSince = (
  dataDir: string,
  sinceMs: number,
  firstChunk?: number,
): Array<MachineEntry> => {
  const newestFirst: Array<MachineEntry> = [];
  scanMachineLogBack(
    dataDir,
    (entry) => {
      if (entry.ms < sinceMs) return "stop";
      newestFirst.push(entry);
      return "continue";
    },
    firstChunk,
  );
  return newestFirst.reverse();
};

/** How long T3 trouble in the machine log counts as the cause of a session ending badly: ten minutes, fixed. */
const T3_TROUBLE_WINDOW_MS = 10 * 60 * 1000;

/**
 * The newest sign of T3 trouble in the machine log within the last ten minutes: a
 * `preflight_failed` whose check is `t3`, or an `error` whose kind is `t3`. Only the tail of
 * the machine log is read. A server restart is not trouble here; `interrupted` weighs it.
 */
export const t3TroubleSince = (dataDir: string, nowMs: number): string | null => {
  let newest: { readonly ms: number; readonly text: string } | null = null;
  for (const entry of machineLogSince(dataDir, nowMs - T3_TROUBLE_WINDOW_MS)) {
    const text =
      entry.event === "preflight_failed" && field(entry.data, "check") === "t3"
        ? field(entry.data, "why")
        : entry.event === "error" && field(entry.data, "kind") === "t3"
          ? field(entry.data, "message")
          : undefined;
    if (typeof text === "string" && (newest === null || entry.ms >= newest.ms)) {
      newest = { ms: entry.ms, text };
    }
  }
  return newest === null ? null : newest.text;
};

/**
 * The `started_at` of every `server_started` line at or after `sinceMs`, oldest first: when this
 * server, and the ones before it, started. A line whose `started_at` is not a number is skipped.
 * Only the log's tail is read (`machineLogSince`); a missing log has none.
 */
export const serverStartsSince = (dataDir: string, sinceMs: number): Array<number> => {
  const times: Array<number> = [];
  for (const entry of machineLogSince(dataDir, sinceMs)) {
    if (entry.event !== "server_started") continue;
    const at = field(entry.data, "started_at");
    if (typeof at === "number") times.push(at);
  }
  return times;
};

/**
 * How far before the newest line ahead of a start that start's stop may lie: the old server
 * writes `server_stopping` as it shuts down, so only lines racing the shutdown come after it.
 */
const STOP_SEARCH_MS = 10 * 60 * 1000;

/**
 * The `stopping_at` of each `server_started` line at or after `sinceMs`: the newest
 * `server_stopping` before that start, back to the previous start. Oldest first. A start whose
 * stop is not reached before a line ten minutes older than the line before it followed a
 * crash, and has none. Read backwards so a months-old log is not decoded in full.
 */
export const readServerStopsForStarts = (
  dataDir: string,
  sinceMs: number,
  firstChunk?: number,
): { readonly stops: Array<number>; readonly bytes: number } => {
  const newestFirst: Array<number> = [];
  let needStop = false;
  // The newest line before the start that needs a stop, once read.
  let lastBeforeStart: number | null = null;
  const bytes = scanMachineLogBack(
    dataDir,
    (entry) => {
      if (entry.event === "server_started") {
        if (typeof field(entry.data, "started_at") !== "number") return "continue";
        if (entry.ms < sinceMs) return "stop";
        needStop = true;
        lastBeforeStart = null;
        return "continue";
      }
      if (entry.event === "server_stopping") {
        const at = field(entry.data, "stopping_at");
        if (needStop && typeof at === "number") {
          newestFirst.push(at);
          needStop = false;
        }
        return "continue";
      }
      if (needStop) {
        if (lastBeforeStart === null) lastBeforeStart = entry.ms;
        else if (entry.ms < lastBeforeStart - STOP_SEARCH_MS) needStop = false;
      }
      return entry.ms < sinceMs && !needStop ? "stop" : "continue";
    },
    firstChunk,
  );
  return { stops: newestFirst.reverse(), bytes };
};

/** The stops `readServerStopsForStarts` finds, without the byte count. */
export const serverStopsForStartsSince = (dataDir: string, sinceMs: number): Array<number> =>
  readServerStopsForStarts(dataDir, sinceMs).stops;
