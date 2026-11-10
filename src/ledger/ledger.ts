// @effect-diagnostics nodeBuiltinImport:off - softfac's write rules need raw fds: O_EXCL, O_NOFOLLOW and fsync.
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
import {
  LedgerAlreadyExistsError,
  LedgerAlreadyFinishedError,
  LedgerUnknownEventError,
  LedgerIoError,
  errnoCode,
} from "./errors.ts";
import { isU32 } from "./limits.ts";
import {
  RUN_EVENT_FIELDS,
  causeObject,
  runEventData,
  type Cause,
  type Outcome,
  type PrEnd,
  type RunEvent,
} from "./events.ts";
import { parseLines, requireRegularFile } from "./read.ts";
import { RUNS_DIR, feedbackReadFile, runPath, type RunId } from "./runId.ts";
import { formatTs } from "./time.ts";

// The largest u64 reads as 2^64 once JSON.parse has made it a double.
const U64_MAX = 2 ** 64;
const I32_MIN = -2147483648;
const I32_MAX = 2147483647;

const isIntegerIn = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;

export type LedgerOptions = {
  /** Returns the current time as Unix epoch milliseconds. Defaults to the system clock. */
  readonly clock?: () => number;
  /** The write and fsync an append performs. Defaults to `node:fs`; a test injects failures. */
  readonly io?: AppendIo;
  /** Flushes a directory to disk after `create` makes the file. Defaults to an fsync. */
  readonly syncDir?: SyncDir;
};

/** An open run file that events are appended to. */
export class Ledger {
  private readonly out: AppendFile;
  private readonly clock: () => number;
  /** The `ms` of the first line, which `finished` measures total time from. */
  private firstMs: number | null = null;
  /** The distinct `attempt` values among the `gate_command` lines. */
  private readonly gateAttempts = new Set<number>();
  private finished = false;
  /** The run's feedback read file, which the `finished` line makes useless. */
  private readonly readFile: string;

  private constructor(out: AppendFile, clock: () => number, readFile: string) {
    this.out = out;
    this.clock = clock;
    this.readFile = readFile;
  }

  /** The run file. */
  get path(): string {
    return this.out.path;
  }

  /**
   * Start a new run file. Throws `AlreadyExists`, leaving the file alone, if there is one.
   * Directories this makes are `0o700` and the file `0o600`; the file's directory entry is
   * synced, and the file removed again if that fails, so a retry does not meet an orphan.
   */
  static create(dataDir: string, id: RunId, options: LedgerOptions = {}): Ledger {
    const path = runPath(dataDir, id);
    const runs = NodePath.join(dataDir, RUNS_DIR);
    const sync = options.syncDir ?? syncDir;
    ensureDirAt(dataDir);
    ensureDirAt(runs);
    let fd: number;
    try {
      // The ledger holds issue and PR details, so keep it to the owner. Read access lets an
      // append see what other handles wrote; O_EXCL never follows a symlink.
      fd = NodeFS.openSync(
        path,
        NodeFS.constants.O_RDWR |
          NodeFS.constants.O_APPEND |
          NodeFS.constants.O_CREAT |
          NodeFS.constants.O_EXCL,
        0o600,
      );
    } catch (error) {
      if (errnoCode(error) === "EEXIST") throw new LedgerAlreadyExistsError({ path });
      throw new LedgerIoError({ path, cause: error });
    }
    // The new file's directory entry must be durable too, or a crash could lose the whole file
    // and the events synced into it. Every directory on the way is synced each time, not only
    // the ones this call made: a call that made them and then failed to sync leaves them for
    // the retry to sync.
    try {
      syncAt(sync, runs);
      syncAt(sync, dataDir);
      syncAt(sync, parentOf(dataDir));
    } catch (error) {
      NodeFS.closeSync(fd);
      try {
        NodeFS.unlinkSync(path);
      } catch {
        // The sync error is the one to report.
      }
      throw error;
    }
    return new Ledger(
      new AppendFile(path, fd, options.io ?? nodeIo),
      options.clock ?? Date.now,
      feedbackReadFile(dataDir, id),
    );
  }

  /**
   * Reopen an existing run for append after a restart. If the last line is incomplete (a crash
   * mid-write), it is terminated with a newline first, so the next event starts on its own
   * line. The fragment stays in the file and readers skip it. A symlink or anything else that
   * is not a regular file is `NotFound`.
   */
  static open(dataDir: string, id: RunId, options: LedgerOptions = {}): Ledger {
    const path = runPath(dataDir, id);
    requireRegularFile(path);
    return new Ledger(
      openForAppend(path, options.io),
      options.clock ?? Date.now,
      feedbackReadFile(dataDir, id),
    );
  }

  /**
   * Fold the lines written since the last append, by this handle or another one, into what the
   * summary needs, so `finished` and the counts are what the file says.
   */
  private catchUp(): void {
    for (const entry of parseLines(this.out.readNewLines()).entries) {
      this.observe(entry.ms, entry.event, entry.data);
    }
  }

  /** Fold a line that is in the file into what the summary needs. */
  private observe(ms: number, event: string, data: unknown): void {
    this.firstMs ??= ms;
    // Only a `gate_command` that softfac would read as a whole counts: it falls back to an
    // unknown event, which is not counted, when any field is missing or the wrong type.
    if (event === "gate_command" && typeof data === "object" && data !== null) {
      const { attempt, command, exit_code, duration_ms } = data as Record<string, unknown>;
      if (
        isU32(attempt) &&
        typeof command === "string" &&
        isIntegerIn(exit_code, I32_MIN, I32_MAX) &&
        isIntegerIn(duration_ms, 0, U64_MAX)
      ) {
        this.gateAttempts.add(attempt);
      }
    }
    // A `finished` line ends the run even if its data cannot be read.
    if (event === "finished") this.finished = true;
  }

  /**
   * Append one event as one line: a single write, then a sync, so a crash loses at most the
   * event in flight. A `finished` event gets the ledger's own `total_ms` and `gate_attempts`;
   * use `finish`. Throws `UnknownEvent` for an event ledger.md does not list, and
   * `AlreadyFinished` after a `finished` line; a cut-off last line is ended before that check.
   */
  append(event: RunEvent, cause: Cause): void {
    if (!Object.hasOwn(RUN_EVENT_FIELDS, event.event)) {
      throw new LedgerUnknownEventError({ event: String(event.event) });
    }
    this.out.endCutOffLine();
    this.catchUp();
    if (this.finished) throw new LedgerAlreadyFinishedError({ path: this.out.path });
    const ms = this.clock();
    const data = runEventData(
      event,
      event.event === "finished"
        ? {
            total_ms: Math.max(0, ms - (this.firstMs ?? ms)),
            gate_attempts: this.gateAttempts.size,
          }
        : {},
    );
    let line: string;
    try {
      line = `${JSON.stringify({ ts: formatTs(ms), ms, event: event.event, data, cause: causeObject(cause) })}\n`;
    } catch (error) {
      throw new LedgerIoError({ path: this.out.path, cause: error });
    }
    // A line whose sync fails is still in the file, so the next append's catch-up counts it: a
    // failed sync on `finished` does not allow a second `finished` line.
    try {
      this.out.writeLine(line);
    } finally {
      // The run has ended: its feedback read time has no use. A file that is not there, or that
      // cannot be removed, does not fail the finish.
      if (event.event === "finished") {
        try {
          NodeFS.rmSync(this.readFile, { force: true });
        } catch {
          // Left behind; the next run id never reuses it.
        }
      }
    }
  }

  /**
   * Write the summary line that ends the run. The ledger fills in the total time since the
   * first line and the number of distinct gate attempts; later appends fail. `prEnd` is how the
   * pull request ended, for a run that ended because it did.
   */
  finish(
    outcome: Outcome,
    reviewCycles: number | null,
    prUrl: string | null,
    cause: Cause,
    prEnd: PrEnd | null = null,
  ): void {
    this.append(
      {
        event: "finished",
        data: {
          outcome,
          total_ms: 0,
          gate_attempts: 0,
          review_cycles: reviewCycles,
          pr_url: prUrl,
          pr_end: prEnd,
        },
      },
      cause,
    );
  }

  /** Release the file handle. Appending after this fails with `Io`. */
  close(): void {
    this.out.close();
  }
}

/** `ensureDir` with its failure reported as an `Io` error for `dir`. */
const ensureDirAt = (dir: string): void => {
  try {
    ensureDir(dir);
  } catch (error) {
    throw new LedgerIoError({ path: dir, cause: error });
  }
};
