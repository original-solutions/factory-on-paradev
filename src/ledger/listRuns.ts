// @effect-diagnostics nodeBuiltinImport:off - the runs directory is listed the way softfac lists it.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Schema from "effect/Schema";

import { isState, type State } from "../domain/lifecycle.ts";
import { readProgress, type Seen } from "../runner/progress.ts";
import { errnoCode, LedgerIoError, LedgerNotFoundError } from "./errors.ts";
import type { PrEnd } from "./events.ts";
import {
  dataField,
  dataText,
  firstEntry,
  lastLineIsFinished,
  parseLine,
  readRun,
  scanLinesBack,
  withRunFile,
  type Entry,
  type RunRecord,
} from "./read.ts";
import { asciiLower, RUNS_DIR, runIdFromFileName, runPath, type RunId } from "./runId.ts";

/** One unfinished run as the pass sees it: its id, its last state, and whether its file could be read. */
export interface RunInfo {
  readonly id: RunId;
  /** The `to` of the last `state_changed`; null before any, or for one this build does not know. */
  readonly state: State | null;
  /** The file could not be read, so the state is unknown. */
  readonly unreadable: boolean;
  /**
   * The run records what approved it or the session it launched. A run without either can never
   * launch one: `start` sends it to `stuck` when it is called for the issue again.
   */
  readonly confirmed: boolean;
  /**
   * A session may be running for it: the run records a launched session, or a launch that was
   * sent. False for a file that cannot be read.
   */
  readonly session: boolean;
  /**
   * The session reported its pull request since the run last entered `building`: its work is
   * done and waits for the gate. False for a file that cannot be read.
   */
  readonly prReported: boolean;
  /**
   * The base branch the run's launch recorded (`Seen.base`): what the pass hands each step of the
   * run, so no step reads the ledger again for it. Null for none, or for a file that cannot be read.
   */
  readonly base: string | null;
}

/**
 * Whether a run holds one of the machine's `max_concurrent_runs` slots: it is confirmed, not
 * finished and not waiting on a pull request (`pr-open`, or reported and waiting for the gate).
 * A run whose file cannot be read counts. The caller has already left out finished runs.
 */
export const holdsSlot = (run: RunInfo): boolean =>
  run.unreadable || (run.confirmed && run.state !== "pr-open" && !run.prReported);

/**
 * The slot facts of a run from its progress; `null` is a run whose file could not be read. The one
 * place they are worked out, for the pass and for the status report.
 */
export const runInfoOf = (id: RunId, seen: Seen | null): RunInfo =>
  seen === null
    ? {
        id,
        state: null,
        unreadable: true,
        confirmed: false,
        session: false,
        prReported: false,
        base: null,
      }
    : {
        id,
        state: seen.state,
        unreadable: false,
        confirmed: seen.approvedAt !== null || seen.threadId !== null,
        session: seen.threadId !== null || seen.launchSent,
        prReported: seen.prReported,
        base: seen.base,
      };

/** One run file as the scanner read it. `read` is null for a file that could not be read. */
interface Scanned<T> {
  readonly id: RunId;
  /** The first line's time; null for a file with no readable line. */
  readonly firstMs: number | null;
  readonly read: T | null;
}

/** What a scanner's reader makes of one file: the first line's time, and what it read. */
interface FileRead<T> {
  readonly firstMs: number | null;
  readonly read: T;
}

const isLedgerNotFound = Schema.is(LedgerNotFoundError);

const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Issues that are both numbers compare as numbers (`9` before `10`), else as text. */
const compareIssue = (a: string, b: string) => {
  if (!/^[0-9]+$/.test(a) || !/^[0-9]+$/.test(b)) return compareText(a, b);
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
};

/**
 * The order softfac lists runs in: a run with a readable first line by its time, then one with no
 * readable line, then unreadable ones; ties by repo (code units), issue (numerically when both
 * are numbers) and attempt.
 */
const byAge = <T>(a: Scanned<T>, b: Scanned<T>) => {
  const rank = (run: Scanned<T>) => (run.read === null ? 2 : run.firstMs === null ? 1 : 0);
  return (
    rank(a) - rank(b) ||
    (a.firstMs ?? 0) - (b.firstMs ?? 0) ||
    compareText(a.id.repo, b.id.repo) ||
    compareIssue(a.id.issue, b.id.issue) ||
    a.id.attempt - b.id.attempt
  );
};

/** A run file read whole: its record and progress. */
interface WholeRead {
  readonly record: RunRecord;
  readonly seen: Seen;
}

/**
 * Whole reads kept between calls of {@link readRuns}, by path. A run file is only appended to, so
 * one whose size, mtime and ctime are unchanged reads the same, and is not read again. A call drops
 * the paths it did not read, so the cache holds no more than the last call read.
 */
export type RunReadCache = Map<
  string,
  { readonly stamp: string; readonly read: FileRead<WholeRead> }
>;

const readWhole = (dataDir: string, id: RunId): FileRead<WholeRead> => {
  const record = readRun(dataDir, id);
  return {
    firstMs: record.entries[0]?.ms ?? null,
    read: { record, seen: readProgress(record.entries) },
  };
};

/**
 * Reads the runs directory once for every caller: regular files named like a run (a symlink or
 * directory is not a run), each read by `read`, oldest first. An unreadable file is still a row,
 * with nothing read. A file `skip` answers true for, asked with its mtime, is not read.
 */
const scanRuns = <T>(
  dataDir: string,
  options: {
    readonly read: (id: RunId, path: string, stat: NodeFS.Stats) => FileRead<T>;
    readonly only?: { readonly repo: string; readonly issue: number } | undefined;
    readonly skip?: ((path: string, mtimeMs: number) => boolean) | undefined;
  },
): Array<Scanned<T>> => {
  const runsDir = NodePath.join(dataDir, RUNS_DIR);
  let names: Array<string>;
  try {
    names = NodeFS.readdirSync(runsDir);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return [];
    throw new LedgerIoError({ path: runsDir, cause: error });
  }
  const { read, only, skip } = options;
  const runs: Array<Scanned<T>> = [];
  for (const name of names) {
    const id = runIdFromFileName(name);
    if (id === null) continue;
    if (
      only !== undefined &&
      (id.repo !== asciiLower(only.repo) || id.issue !== String(only.issue))
    ) {
      continue;
    }
    const path = runPath(dataDir, id);
    try {
      const stat = NodeFS.lstatSync(path);
      if (!stat.isFile()) continue;
      if (skip?.(path, stat.mtimeMs) === true) continue;
      runs.push({ id, ...read(id, path, stat) });
    } catch (error) {
      // Gone between the listing and the read (the lstat's ENOENT, or the read's not-found): not
      // a run any more.
      if (errnoCode(error) === "ENOENT" || isLedgerNotFound(error)) continue;
      runs.push({ id, firstMs: null, read: null });
    }
  }
  return runs.sort(byAge);
};

/**
 * Every run under `<dir>/runs/` that is not finished, oldest first by the first line's time; with
 * `only`, just that issue's runs. A finished file is skipped by reading only its tail. An
 * unreadable run is still listed, flagged `unreadable`, and sorts last; runs with no readable line
 * sort after the started ones; ties go as {@link readRuns} has them.
 */
export const listUnfinishedRuns = (
  dataDir: string,
  only?: { readonly repo: string; readonly issue: number },
): Array<RunInfo> =>
  scanRuns(dataDir, {
    read: (id) => readWhole(dataDir, id),
    only,
    skip: (path) => lastLineIsFinished(path),
  })
    .filter((run) => run.read === null || !run.read.seen.finished)
    .map((run) => runInfoOf(run.id, run.read?.seen ?? null));

/** A run in one row, as `softfac runs list` shows it. */
export interface RunSummary {
  readonly id: RunId;
  /** The first line's `ts`; null for a file with no readable line. */
  readonly startedTs: string | null;
  /** The event of the last readable line; null for a file with no readable line. */
  readonly lastEvent: string | null;
  /**
   * The issue title recorded on the run's first `session_launched` line; null when that line has
   * none (a run launched before titles were recorded), when the run has not launched, and for a
   * file that could not be read.
   */
  readonly title: string | null;
  /**
   * Why the run waits for a person: the `reason` of the newest `stuck` line while its last state
   * is `stuck`, the `questions` of the newest `questions_posted` line while it is `needs-info`;
   * null otherwise. Cut to {@link REASON_MAX_CHARS} characters.
   */
  readonly reason: string | null;
  /** The `to` of the last `state_changed`; null before any, or for one this build does not know. */
  readonly state: State | null;
  /**
   * The `step` of the last `step_changed`; null before any, for a finished run (its last step is
   * over, and `lastEvent` says so), and for a file that could not be read.
   */
  readonly step: string | null;
  /** The `finished` line's pull request URL, else the last `pr_opened` URL. */
  readonly prUrl: string | null;
  /** How the run's pull request ended, from the `finished` line; its last state predates that. */
  readonly prEnd: PrEnd | null;
  readonly finished: boolean;
  readonly totalMs: number | null;
  /** The file could not be read; every other field is empty. */
  readonly unreadable: boolean;
}

/** A run's summary and, when its file could be read, the lines and progress it was made from. */
export interface RunRead {
  readonly summary: RunSummary;
  readonly record: RunRecord | null;
  readonly seen: Seen | null;
}

/** The summary of a file that could not be read: every other field is empty. */
const unreadableSummary = (id: RunId): RunSummary => ({
  id,
  startedTs: null,
  lastEvent: null,
  title: null,
  reason: null,
  state: null,
  step: null,
  prUrl: null,
  prEnd: null,
  finished: false,
  totalMs: null,
  unreadable: true,
});

/** The `total_ms` of a `finished` line, when it is a number. */
const totalMsOf = (end: Entry | undefined): number | null => {
  const total = dataField(end?.data, "total_ms");
  return typeof total === "number" ? total : null;
};

/** The `pr_end` of a `finished` line, when it is one this build knows. */
const prEndOf = (end: Entry | undefined): PrEnd | null => {
  const prEnd = dataField(end?.data, "pr_end");
  return prEnd === "merged" || prEnd === "closed" ? prEnd : null;
};

/** The event and field whose text says why a run in `state` waits for a person; null for any other. */
const REASON_SOURCE = {
  stuck: { event: "stuck", key: "reason" },
  "needs-info": { event: "questions_posted", key: "questions" },
} as const;

const reasonSource = (state: State | null) =>
  state === "stuck" || state === "needs-info" ? REASON_SOURCE[state] : null;

/** The longest `reason` a summary carries: the rows are polled, and a reader shows a line or two. */
const REASON_MAX_CHARS = 300;

/** A reason cut to {@link REASON_MAX_CHARS} characters, ending in an ellipsis; never splits a character. */
const capReason = (reason: string | null): string | null => {
  if (reason === null || reason.length <= REASON_MAX_CHARS) return reason;
  const chars = Array.from(reason);
  return chars.length <= REASON_MAX_CHARS
    ? reason
    : `${chars.slice(0, REASON_MAX_CHARS - 1).join("")}\u2026`;
};

const isLaunch = (entry: Entry) => entry.event === "session_launched";

/** The summary of a run read whole: its progress, plus what the progress does not carry. */
const summarise = (id: RunId, { record, seen }: WholeRead): RunSummary => {
  const end = record.entries.findLast((entry) => entry.event === "finished");
  const launch = record.entries.find(isLaunch);
  const source = reasonSource(seen.state);
  const reason =
    source === null
      ? null
      : dataText(
          record.entries.findLast((entry) => entry.event === source.event)?.data,
          source.key,
        );
  return {
    id,
    startedTs: record.entries[0]?.ts ?? null,
    lastEvent: record.entries.at(-1)?.event ?? null,
    title: dataText(launch?.data, "title"),
    reason: capReason(reason),
    state: seen.state,
    step: seen.finished
      ? null
      : dataText(record.entries.findLast((entry) => entry.event === "step_changed")?.data, "step"),
    prUrl: (end === undefined ? null : dataText(end.data, "pr_url")) ?? seen.lastPr?.url ?? null,
    prEnd: prEndOf(end),
    finished: seen.finished,
    totalMs: totalMsOf(end),
    unreadable: false,
  };
};

/**
 * The summary of a finished run file without reading it whole, equal to {@link summarise} of the
 * whole read. A finished file is never appended to, so the first line, the first launch, the
 * `finished` line, the last `state_changed`, the newest reason line and (if `finished` has no PR
 * URL) the last `pr_opened` say everything. The first launch is read forwards, the rest backwards.
 */
const summariseFinished = (id: RunId, path: string): FileRead<RunSummary> =>
  withRunFile(path, (fd) => {
    const first = firstEntry(fd);
    const title = dataText(firstEntry(fd, undefined, isLaunch)?.data, "title");
    let end: Entry | undefined;
    let state: State | null | undefined;
    let prUrl: string | null = null;
    // The text of the newest line of each reason source, by event; absent until one is seen.
    const reasons = new Map<string, string | null>();
    scanLinesBack(fd, (line) => {
      const entry = parseLine(line);
      if (entry === null) return "continue";
      if (entry.event === "finished") {
        end ??= entry;
        prUrl ??= dataText(entry.data, "pr_url");
      } else if (entry.event === "state_changed" && state === undefined) {
        const to = dataField(entry.data, "to");
        state = isState(to) ? to : null;
      } else if (entry.event === "pr_opened" && prUrl === null) {
        const url = dataField(entry.data, "url");
        if (typeof dataField(entry.data, "pr") === "number" && typeof url === "string") prUrl = url;
      }
      for (const { event, key } of Object.values(REASON_SOURCE)) {
        if (entry.event === event && !reasons.has(event))
          reasons.set(event, dataText(entry.data, key));
      }
      // The reason is only wanted for a run whose last state has a reason source.
      const source = reasonSource(state ?? null);
      const reasonFound = source === null || reasons.has(source.event);
      return state !== undefined && prUrl !== null && reasonFound ? "stop" : "continue";
    });
    const source = reasonSource(state ?? null);
    return {
      firstMs: first?.ms ?? null,
      read: {
        id,
        startedTs: first?.ts ?? null,
        lastEvent: "finished",
        title,
        reason: capReason(source === null ? null : (reasons.get(source.event) ?? null)),
        state: state ?? null,
        step: null,
        prUrl,
        prEnd: prEndOf(end),
        finished: true,
        totalMs: totalMsOf(end),
        unreadable: false,
      },
    };
  });

/**
 * Every run under `<dir>/runs/`, finished ones included, oldest first, in the order of
 * {@link listUnfinishedRuns}. An unreadable file is still listed, flagged `unreadable`. With
 * `skipFinishedBefore` (Unix epoch ms), a finished file last written before it is neither read nor
 * returned: a finished file is never appended to, so an old mtime means no line is in the window.
 */
export const readRuns = (
  dataDir: string,
  options: { readonly skipFinishedBefore?: number; readonly cache?: RunReadCache } = {},
): Array<RunRead> => {
  const { cache } = options;
  const visited = new Set<string>();
  const runs = scanRuns(dataDir, {
    read: (id, path, stat) => {
      if (cache === undefined) return readWhole(dataDir, id);
      visited.add(path);
      const stamp = `${stat.size} ${stat.mtimeMs} ${stat.ctimeMs}`;
      const kept = cache.get(path);
      if (kept?.stamp === stamp) return kept.read;
      const read = readWhole(dataDir, id);
      cache.set(path, { stamp, read });
      return read;
    },
    skip: finishedBefore(options.skipFinishedBefore),
  });
  if (cache !== undefined) {
    for (const path of cache.keys()) if (!visited.has(path)) cache.delete(path);
  }
  return runs.map((run) => ({
    summary: run.read === null ? unreadableSummary(run.id) : summarise(run.id, run.read),
    record: run.read?.record ?? null,
    seen: run.read?.seen ?? null,
  }));
};

/** The `skip` of a scan with a `skipFinishedBefore` cutoff: a finished file last written before it. */
const finishedBefore = (cutoffMs: number | undefined) =>
  cutoffMs === undefined
    ? undefined
    : (path: string, mtimeMs: number) => mtimeMs < cutoffMs && lastLineIsFinished(path);

/**
 * `softfac runs list`: one summary per run under `<dir>/runs/`, in the order of {@link readRuns}.
 * A finished file is summarised from its ends and never read whole. `skipFinishedBefore` (Unix
 * epoch ms) works as in {@link readRuns}.
 */
export const listRuns = (
  dataDir: string,
  options: { readonly skipFinishedBefore?: number } = {},
): Array<RunSummary> =>
  scanRuns(dataDir, {
    read: (id, path): FileRead<RunSummary> => {
      if (lastLineIsFinished(path)) return summariseFinished(id, path);
      const whole = readWhole(dataDir, id);
      return { firstMs: whole.firstMs, read: summarise(id, whole.read) };
    },
    skip: finishedBefore(options.skipFinishedBefore),
  }).map((run) => run.read ?? unreadableSummary(run.id));

/**
 * The run each session thread was launched for, and whether that session is stopped: its run is
 * finished, a later session replaced it, or its worktree step is written. `complete` is false when
 * a run file could not be read, so a thread missing from the map may still be a session's.
 */
export const runsByThread = (
  dataDir: string,
): {
  readonly runs: Map<string, { readonly run: RunId; readonly stopped: boolean }>;
  readonly complete: boolean;
} => {
  const runs = new Map<string, { readonly run: RunId; readonly stopped: boolean }>();
  let complete = true;
  for (const { record, seen, summary } of readRuns(dataDir)) {
    if (summary.unreadable) complete = false;
    for (const entry of record?.entries ?? []) {
      if (entry.event !== "session_launched") continue;
      const threadId = dataText(entry.data, "thread_id");
      if (threadId === null) continue;
      const current = seen?.threadId === threadId && seen.worktreeDone !== true;
      runs.set(threadId, { run: summary.id, stopped: summary.finished || !current });
    }
  }
  return { runs, complete };
};
