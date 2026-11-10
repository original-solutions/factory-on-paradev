// @effect-diagnostics nodeBuiltinImport:off - softfac's write rules need raw fds: O_NOFOLLOW, one write per line and fsync.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { LedgerNotFoundError, LedgerIoError, errnoCode } from "./errors.ts";
import { NEWLINE } from "./limits.ts";

/**
 * The two file operations an append performs. A seam so a test can make them fail the way a full
 * or failing disk does; the real implementation is `node:fs`. `writeSync` may write less than the
 * whole buffer and returns how many bytes it wrote.
 */
export type AppendIo = {
  writeSync(fd: number, buffer: Uint8Array): number;
  fsyncSync(fd: number): void;
};

export const nodeIo: AppendIo = {
  writeSync: (fd, buffer) => NodeFS.writeSync(fd, buffer),
  fsyncSync: (fd) => NodeFS.fsyncSync(fd),
};

/** Flush a directory's entries to disk, so a file created in it survives a crash. */
export type SyncDir = (dir: string) => void;

export const syncDir: SyncDir = (dir) => {
  const fd = NodeFS.openSync(dir, "r");
  try {
    NodeFS.fsyncSync(fd);
  } finally {
    NodeFS.closeSync(fd);
  }
};

/**
 * Create `path` if it is missing, owner-only (`0o700`). Missing parents are made the ordinary
 * way, and a directory that already exists is left as it is, whatever its mode. Throws what
 * `node:fs` throws.
 */
export const ensureDir = (path: string): void => {
  try {
    NodeFS.statSync(path);
    return;
  } catch (error) {
    if (errnoCode(error) !== "ENOENT") throw error;
  }
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  try {
    NodeFS.mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    // Someone else made it between the check and here.
    if (errnoCode(error) !== "EEXIST") throw error;
  }
};

/** `sync` of `dir` with its failure reported as an `Io` error for `dir`. */
export const syncAt = (sync: SyncDir, dir: string): void => {
  try {
    sync(dir);
  } catch (error) {
    throw new LedgerIoError({ path: dir, cause: error });
  }
};

/** True when the file is empty or its last byte is a newline. Throws what `node:fs` throws. */
const endsInNewline = (fd: number): boolean => {
  const size = NodeFS.fstatSync(fd).size;
  if (size === 0) return true;
  const last = Buffer.alloc(1);
  NodeFS.readSync(fd, last, 0, 1, size - 1);
  return last[0] === NEWLINE;
};

/**
 * A last line with no newline is a write that was cut off: end it with one `\n` write and an
 * fsync through `io`, so the next event starts on its own line, and return true. The fragment
 * stays in the file. Throws what `io` or `node:fs` throws.
 */
const endCutOffLine = (fd: number, io: AppendIo): boolean => {
  if (endsInNewline(fd)) return false;
  if (io.writeSync(fd, Buffer.from("\n")) !== 1) throw new Error("failed to write the line break");
  io.fsyncSync(fd);
  return true;
};

/**
 * Open an existing regular file for append, never creating it and never following a symlink
 * (`O_RDWR | O_APPEND | O_NOFOLLOW`: the read access is needed, since an append looks at how
 * the file ends and what other handles wrote). A line cut off at the end is ended first. A
 * missing file is `NotFound`; anything else that goes wrong is `Io`.
 */
export const openForAppend = (path: string, io: AppendIo = nodeIo): AppendFile => {
  let fd: number;
  try {
    fd = NodeFS.openSync(
      path,
      NodeFS.constants.O_RDWR | NodeFS.constants.O_APPEND | NodeFS.constants.O_NOFOLLOW,
    );
  } catch (error) {
    if (errnoCode(error) === "ENOENT") throw new LedgerNotFoundError({ path });
    throw new LedgerIoError({ path, cause: error });
  }
  try {
    endCutOffLine(fd, io);
  } catch (error) {
    NodeFS.closeSync(fd);
    throw new LedgerIoError({ path, cause: error });
  }
  return new AppendFile(path, fd, io);
};

/** The directory that holds `dir`, which the sync after making `dir` has to reach. */
export const parentOf = (dir: string): string => NodePath.dirname(dir);

/**
 * An open file that lines are appended to, one write each: the part a run file and the machine
 * log have in common. The fd must be open for reading too. Several handles may append to one
 * file; nothing locks it, so two appends made at the same instant are not ordered.
 */
export class AppendFile {
  readonly path: string;
  private fd: number | null;
  private readonly io: AppendIo;
  /**
   * An earlier write or sync failed, so the file may end in a partial line with no newline. The
   * next append starts with a `\n` so it cannot be glued onto that fragment.
   */
  private dirty = false;
  /** How far `readNewLines` has read: always the end of a whole line. */
  private seen = 0;

  constructor(path: string, fd: number, io: AppendIo = nodeIo) {
    this.path = path;
    this.fd = fd;
    this.io = io;
  }

  private openFd(): number {
    if (this.fd === null)
      throw new LedgerIoError({ path: this.path, cause: new Error("the file is closed") });
    return this.fd;
  }

  /**
   * End a line cut off at the end of the file, by this handle or another one, as opening the
   * file does, so a whole line that only lacked its newline counts before the next append.
   */
  endCutOffLine(): void {
    const fd = this.openFd();
    let ended: boolean;
    try {
      ended = endCutOffLine(fd, this.io);
    } catch (error) {
      throw new LedgerIoError({ path: this.path, cause: error });
    }
    // That newline is the break an earlier failed write owed, so it is not written twice.
    if (ended) this.dirty = false;
  }

  /**
   * The whole lines added to the file since the last call, by this handle or any other, and on
   * the first call every whole line. A last line with no newline yet is left for a later call.
   */
  readNewLines(): Buffer {
    const fd = this.openFd();
    try {
      const size = NodeFS.fstatSync(fd).size;
      if (size <= this.seen) return Buffer.alloc(0);
      const bytes = Buffer.alloc(size - this.seen);
      let offset = 0;
      while (offset < bytes.length) {
        const count = NodeFS.readSync(fd, bytes, offset, bytes.length - offset, this.seen + offset);
        if (count === 0) break;
        offset += count;
      }
      const whole = bytes.subarray(0, bytes.subarray(0, offset).lastIndexOf(NEWLINE) + 1);
      this.seen += whole.length;
      return whole;
    } catch (error) {
      throw new LedgerIoError({ path: this.path, cause: error });
    }
  }

  /**
   * Append `line` (which ends in a newline) as one write of the whole line, then sync, so a
   * crash loses at most the line in flight. When the file does not end in a newline (a write of
   * this handle or another one was cut off), the write starts with one.
   */
  writeLine(line: string): void {
    const fd = this.openFd();
    let breakFirst: boolean;
    try {
      breakFirst = this.dirty || !endsInNewline(fd);
    } catch (error) {
      throw new LedgerIoError({ path: this.path, cause: error });
    }
    const bytes = Buffer.from(breakFirst ? `\n${line}` : line, "utf8");
    try {
      let offset = 0;
      while (offset < bytes.length) {
        const count = this.io.writeSync(fd, bytes.subarray(offset));
        if (!(count > 0)) throw new Error("failed to write the whole line");
        offset += count;
      }
    } catch (error) {
      this.dirty = true;
      throw new LedgerIoError({ path: this.path, cause: error });
    }
    try {
      this.io.fsyncSync(fd);
    } catch (error) {
      this.dirty = true;
      throw new LedgerIoError({ path: this.path, cause: error });
    }
    this.dirty = false;
  }

  close(): void {
    if (this.fd === null) return;
    const fd = this.fd;
    this.fd = null;
    NodeFS.closeSync(fd);
  }
}
