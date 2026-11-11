// @effect-diagnostics nodeBuiltinImport:off - a run file is read the way softfac reads it: lstat first, then the bytes.
import * as NodeFS from "node:fs";

import { LedgerNotFoundError, LedgerIoError, errnoCode, isLedgerError } from "./errors.ts";
import { NEWLINE, isU32 } from "./limits.ts";
import { runPath, type RunId } from "./runId.ts";

/**
 * A cause as read back. Its step and reason are the words in the file, not the ones this build
 * knows, so a cause from a newer build is read as it was written, extra keys included.
 */
export type ReadCause = { step: string; reason: string; [key: string]: unknown };

/** `key` of a ledger line's `data`, or undefined when that is not an object with it. */
export const field = (data: unknown, key: string): unknown =>
  typeof data === "object" && data !== null ? (data as Record<string, unknown>)[key] : undefined;

/** One line of a run, as read back: the event and its data are as written. */
export type Entry = {
  /** RFC 3339 UTC, as written in the file. */
  readonly ts: string;
  /** Unix epoch milliseconds. */
  readonly ms: number;
  readonly event: string;
  /** `null` when the line has no `data`. */
  readonly data: unknown;
  /** `null` for a line from before causes existed, and for a cause that is not an object with a step and a reason. */
  readonly cause: ReadCause | null;
};

/** A run read back from its file. */
export type RunRecord = {
  readonly id: RunId;
  readonly entries: ReadonlyArray<Entry>;
  /** The last line was incomplete or not valid JSON, and was dropped. */
  readonly truncated: boolean;
  /** Invalid lines that were not the last, and so were skipped. */
  readonly skipped: number;
};

const CARRIAGE_RETURN = 0x0d;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The value at `key` of an entry's data; undefined when the data is not an object. */
export const dataField = (data: unknown, key: string): unknown =>
  typeof data === "object" && data !== null ? (data as Record<string, unknown>)[key] : undefined;

/** The string at `key` of an entry's data, or null when it is not a string. */
export const dataText = (data: unknown, key: string): string | null => {
  const value = dataField(data, key);
  return typeof value === "string" ? value : null;
};

/**
 * An empty line: nothing, or just the `\r` of a CRLF ending. The repair after a failed write
 * leaves one, and nothing was lost, so it is neither an entry nor damage.
 */
export const isBlankLine = (line: Uint8Array): boolean =>
  line.length === 0 || (line.length === 1 && line[0] === CARRIAGE_RETURN);

// Strict UTF-8, and a byte order mark is a syntax error as it is for any JSON reader.
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** One line as a JSON object, or `null` when it is not UTF-8, not JSON or not an object. */
export const decodeLine = (line: Uint8Array): Record<string, unknown> | null => {
  try {
    const value: unknown = JSON.parse(decoder.decode(line));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
};

/**
 * The keys every line has: a string `ts`, a whole non-negative number `ms` and a string `event`.
 * A missing `data` reads as `null`.
 */
export const lineHead = (
  object: Record<string, unknown>,
): { ts: string; ms: number; event: string; data: unknown } | null => {
  const { ts, ms, event, data } = object;
  if (typeof ts !== "string" || typeof event !== "string") return null;
  if (typeof ms !== "number" || !Number.isSafeInteger(ms) || ms < 0) return null;
  return { ts, ms, event, data: data === undefined ? null : data };
};

const readCause = (value: unknown): ReadCause | null => {
  if (!isRecord(value)) return null;
  const { step, reason, actor, command, attempt, label } = value;
  if (typeof step !== "string" || typeof reason !== "string") return null;
  for (const text of [actor, command, label]) {
    if (text !== undefined && text !== null && typeof text !== "string") return null;
  }
  if (attempt !== undefined && attempt !== null && !isU32(attempt)) return null;
  return value as ReadCause;
};

/** One line (without its newline) as an entry, or `null` for a blank or invalid line. */
export const parseLine = (line: Uint8Array): Entry | null => {
  const object = decodeLine(line);
  const head = object === null ? null : lineHead(object);
  if (object === null || head === null) return null;
  return { ...head, cause: readCause(object.cause) };
};

/**
 * Read a run file's bytes into entries. Never fails on a bad line: an incomplete or invalid last
 * line is dropped and flagged, and any other invalid line is skipped and counted. Empty lines
 * are ignored.
 */
export const parseLines = (
  bytes: Uint8Array,
): { entries: Array<Entry>; truncated: boolean; skipped: number } => {
  const completeLength = bytes.lastIndexOf(NEWLINE) + 1;
  const lines: Array<Entry | null> = [];
  let start = 0;
  while (start < completeLength) {
    const end = bytes.indexOf(NEWLINE, start);
    const line = bytes.subarray(start, end);
    if (!isBlankLine(line)) lines.push(parseLine(line));
    start = end + 1;
  }

  let truncated = false;
  if (!isBlankLine(bytes.subarray(completeLength))) {
    truncated = true;
  } else if (lines.length > 0 && lines[lines.length - 1] === null) {
    truncated = true;
    lines.pop();
  }
  const skipped = lines.filter((line) => line === null).length;
  return { entries: lines.filter((line) => line !== null), truncated, skipped };
};

/**
 * Refuse anything at a run's path that is not a regular file: a symlink or directory named like
 * a run is reported as not found, so nothing ever reads (or appends to) some other file. The
 * check and what follows are separate calls, so a swap in between is not caught; the data
 * directory is private to its owner, which is who could make that swap.
 */
export const requireRegularFile = (path: string): void => {
  let isFile: boolean;
  try {
    isFile = NodeFS.lstatSync(path).isFile();
  } catch (error) {
    if (errnoCode(error) === "ENOENT") throw new LedgerNotFoundError({ path });
    throw new LedgerIoError({ path, cause: error });
  }
  if (!isFile) throw new LedgerNotFoundError({ path });
};

/** Read a run file's bytes, once `requireRegularFile` accepts it. */
const readRunBytes = (path: string): Buffer => {
  requireRegularFile(path);
  try {
    return NodeFS.readFileSync(path);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") throw new LedgerNotFoundError({ path });
    throw new LedgerIoError({ path, cause: error });
  }
};

/** Read a run back. A damaged line never fails the read; see `RunRecord`. */
export const readRun = (dataDir: string, id: RunId): RunRecord => {
  const bytes = readRunBytes(runPath(dataDir, id));
  return { id, ...parseLines(bytes) };
};

/** How much of a file's end `lastLineIsFinished` reads; a `finished` line is a few hundred bytes. */
const TAIL_BYTES = 8192;

/**
 * Whether the last complete line of a run file is a valid `finished` event, read from at most
 * `TAIL_BYTES` at the end; `finish` writes it last, so true means the run is over. False for
 * anything it cannot be sure of: a cut-off or invalid last line, or one longer than the tail.
 */
export const lastLineIsFinished = (path: string): boolean => {
  requireRegularFile(path);
  let tail: Buffer;
  let fromStart: boolean;
  try {
    const fd = NodeFS.openSync(path, NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW);
    try {
      const size = NodeFS.fstatSync(fd).size;
      const offset = Math.max(0, size - TAIL_BYTES);
      tail = Buffer.alloc(size - offset);
      let filled = 0;
      while (filled < tail.length) {
        const n = NodeFS.readSync(fd, tail, filled, tail.length - filled, offset + filled);
        if (n === 0) break;
        filled += n;
      }
      tail = tail.subarray(0, filled);
      fromStart = offset === 0;
    } finally {
      NodeFS.closeSync(fd);
    }
  } catch (error) {
    if (errnoCode(error) === "ENOENT") throw new LedgerNotFoundError({ path });
    throw new LedgerIoError({ path, cause: error });
  }

  // Bytes after the last newline are a write that was cut off, as `parseLines` reads them.
  let end = tail.lastIndexOf(NEWLINE) + 1;
  if (end === 0 || !isBlankLine(tail.subarray(end))) return false;
  // Step back over blank lines to the last line that holds something.
  for (;;) {
    const lineEnd = end - 1;
    // A negative offset would count from the end of the buffer, so the first line has no earlier one.
    const start = lineEnd === 0 ? 0 : tail.lastIndexOf(NEWLINE, lineEnd - 1) + 1;
    const line = tail.subarray(start, lineEnd);
    if (isBlankLine(line)) {
      if (start === 0) return false;
      end = start;
      continue;
    }
    // A line that starts the chunk of a longer file may have begun before it.
    if (start === 0 && !fromStart) return false;
    const object = decodeLine(line);
    return object !== null && lineHead(object)?.event === "finished";
  }
};

/** Reads into `buffer` from `position` until it is full or the file ends; returns the bytes read. */
const readAt = (fd: number, buffer: Buffer, position: number): number => {
  let filled = 0;
  while (filled < buffer.length) {
    const n = NodeFS.readSync(fd, buffer, filled, buffer.length - filled, position + filled);
    if (n === 0) break;
    filled += n;
  }
  return filled;
};

/**
 * Opens a run file for reading, without following a symlink, and runs `use` on the handle,
 * closing it after. Errors map as `readRun` maps them: a missing file or anything that is not a
 * regular file is `LedgerNotFoundError`, any other failure (in `use` too) `LedgerIoError`.
 */
export const withRunFile = <A>(path: string, use: (fd: number) => A): A => {
  requireRegularFile(path);
  let fd: number;
  try {
    fd = NodeFS.openSync(path, NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") throw new LedgerNotFoundError({ path });
    throw new LedgerIoError({ path, cause: error });
  }
  try {
    return use(fd);
  } catch (error) {
    throw isLedgerError(error) ? error : new LedgerIoError({ path, cause: error });
  } finally {
    NodeFS.closeSync(fd);
  }
};

/** How much of a file `scanLinesBack` reads first; each read after it doubles. */
const FIRST_CHUNK_BYTES = 64 * 1024;

/**
 * Calls `visit` with the lines of an open JSONL file, newest first, until it answers `"stop"`,
 * and returns how many bytes it read. Read backwards in chunks (each twice the one before);
 * a line cut by a chunk edge is completed by the next. The bytes after the last newline
 * come first, as a line; a caller that wants only complete lines skips them.
 */
export const scanLinesBack = (
  fd: number,
  visit: (line: Uint8Array) => "continue" | "stop",
  firstChunk: number = FIRST_CHUNK_BYTES,
): number => {
  let pos = NodeFS.fstatSync(fd).size;
  let bytesRead = 0;
  let chunk = Math.max(1, firstChunk);
  // The start of a line whose beginning is in an earlier chunk.
  let head: Buffer = Buffer.alloc(0);
  while (pos > 0) {
    const size = Math.min(pos, chunk);
    pos -= size;
    const bytes = Buffer.alloc(size + head.length);
    readAt(fd, bytes.subarray(0, size), pos);
    head.copy(bytes, size);
    bytesRead += size;
    chunk *= 2;
    let end = bytes.length;
    while (end > 0) {
      const newline = bytes.lastIndexOf(NEWLINE, end - 1);
      if (newline === -1) break;
      if (visit(bytes.subarray(newline + 1, end)) === "stop") return bytesRead;
      end = newline;
    }
    head = bytes.subarray(0, end);
  }
  // What is left has no line before it: it is the first line of the file.
  visit(head);
  return bytesRead;
};

/**
 * The first entry of an open run file, as `readRun` would have it first: the file is read forwards
 * in chunks (the first `firstChunk` bytes, each after it twice the one before) until a complete
 * line parses and `wanted` accepts it (any entry, by default). Null when no complete line does;
 * a `wanted` that nothing satisfies reads the whole file.
 */
export const firstEntry = (
  fd: number,
  firstChunk = 4096,
  wanted: (entry: Entry) => boolean = () => true,
): Entry | null => {
  const size = NodeFS.fstatSync(fd).size;
  let bytes: Buffer = Buffer.alloc(0);
  let pos = 0;
  let start = 0;
  let chunk = Math.max(1, firstChunk);
  while (pos < size) {
    const more = Buffer.alloc(Math.min(chunk, size - pos));
    const n = readAt(fd, more, pos);
    if (n === 0) break;
    pos += n;
    chunk *= 2;
    bytes = Buffer.concat([bytes, more.subarray(0, n)]);
    for (let end = bytes.indexOf(NEWLINE, start); end !== -1; end = bytes.indexOf(NEWLINE, start)) {
      const entry = parseLine(bytes.subarray(start, end));
      if (entry !== null && wanted(entry)) return entry;
      start = end + 1;
    }
  }
  return null;
};
