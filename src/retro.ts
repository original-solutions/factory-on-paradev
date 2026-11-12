// @effect-diagnostics nodeBuiltinImport:off - retro checks that the data dir it is pointed at exists.
/**
 * `factory-runner retro`: the four numbers that compare this runner with t3fac, read from any
 * softfac-format data dir (spec T5). It reads the runs and asks `gh` for merged PRs' reviews; it
 * never writes to the data dir.
 */
import * as NodeFS from "node:fs";

import type { CommandResult } from "./install.ts";
import { readRuns } from "./ledger/listRuns.ts";
import { dataField, dataText, type Entry } from "./ledger/read.ts";
import { runIdFileName } from "./ledger/runId.ts";
import { parseTs } from "./ledger/time.ts";

export const RETRO_USAGE =
  "retro --data-dir <dir> [--since <date>] [--until <date>] [--json]";

export interface RetroIo {
  /** Runs `gh` with these arguments. */
  readonly gh: (args: ReadonlyArray<string>) => CommandResult;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

/** A part of the runs in the window: how many, and their share of the window's runs (null for none). */
interface Share {
  readonly runs: number;
  readonly share: number | null;
}

export interface RetroReport {
  readonly data_dir: string;
  readonly since: string | null;
  readonly until: string | null;
  readonly runs: number;
  readonly reached_pr_open_without_person: Share;
  readonly stuck: Share & {
    readonly by_reason: ReadonlyArray<{ readonly reason: string | null; readonly runs: number }>;
  };
  readonly claim_to_pr_open_minutes: {
    readonly runs: number;
    readonly median: number | null;
    readonly p90: number | null;
  };
  readonly merged_without_change_requests: {
    readonly merged: number;
    readonly without_change_requests: number;
    readonly share: number | null;
  };
}

/** A bound as Unix epoch ms: `YYYY-MM-DD` (UTC midnight) or an RFC 3339 UTC time. */
const parseBound = (text: string): number | null =>
  parseTs(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(text) ? `${text}T00:00:00Z` : text);

interface Args {
  readonly dataDir: string;
  readonly since: { readonly text: string; readonly ms: number } | null;
  readonly until: { readonly text: string; readonly ms: number } | null;
  readonly json: boolean;
}

const parseArgs = (argv: ReadonlyArray<string>): Args | string => {
  let dataDir: string | null = null;
  let since: Args["since"] = null;
  let until: Args["until"] = null;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--json") {
      json = true;
      continue;
    }
    const value = argv[i + 1];
    if (flag !== "--data-dir" && flag !== "--since" && flag !== "--until") {
      return `unknown argument ${flag}`;
    }
    if (value === undefined || value === "") return `${flag} needs a value`;
    i++;
    if (flag === "--data-dir") {
      dataDir = value;
      continue;
    }
    const ms = parseBound(value);
    if (ms === null) return `${flag} ${value} is not an ISO date`;
    if (flag === "--since") since = { text: value, ms };
    else until = { text: value, ms };
  }
  if (dataDir === null) return "--data-dir is required";
  return { dataDir, since, until, json };
};

/** Reasons in code-unit order, with no reason last. */
const byReason = (a: string | null, b: string | null) =>
  a === b ? 0 : a === null ? 1 : b === null ? -1 : a < b ? -1 : 1;

const share = (part: number, whole: number): number | null => (whole === 0 ? null : part / whole);

/** The first line whose state changed to one of `to`. */
const firstMoveTo = (entries: ReadonlyArray<Entry>, ...to: ReadonlyArray<string>) =>
  entries.find(
    (entry) => entry.event === "state_changed" && to.includes(String(dataField(entry.data, "to"))),
  );

/** The middle value; the mean of the two middle ones for an even count. */
export const median = (sorted: ReadonlyArray<number>): number | null => {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

/** The nearest-rank 90th percentile: the smallest value at least 90% of the values are at or below. */
export const p90 = (sorted: ReadonlyArray<number>): number | null =>
  sorted.length === 0 ? null : sorted[Math.ceil(sorted.length * 0.9) - 1]!;

/** Whether a merged PR had no review asking for changes, per `gh pr view <url> --json reviews`. */
const noChangeRequests = (url: string, io: RetroIo): boolean => {
  const done = io.gh(["pr", "view", url, "--json", "reviews"]);
  if (done.status !== 0) {
    throw new Error(`gh pr view ${url} failed: ${done.stderr.trim()}`);
  }
  let reviews: unknown;
  try {
    reviews = dataField(JSON.parse(done.stdout), "reviews");
  } catch {
    reviews = undefined;
  }
  if (!Array.isArray(reviews)) throw new Error(`gh pr view ${url} gave no reviews list`);
  return !reviews.some((review) => dataField(review, "state") === "CHANGES_REQUESTED");
};

/** The report for the runs of `args.dataDir` that started in the window. Throws on a `gh` failure. */
const buildRetro = (args: Args, io: RetroIo): RetroReport => {
  const { dataDir, since, until } = args;
  // A run that started in the window wrote its last line in it too, so a finished file last
  // written before `--since` holds none of the window's runs and is not read.
  const runs = readRuns(dataDir, { skipFinishedBefore: since?.ms }).filter(({ summary }) => {
    if (summary.unreadable) {
      io.err(`factory-runner: warning: ${runIdFileName(summary.id)} could not be read`);
      return false;
    }
    const started = summary.startedTs === null ? null : parseTs(summary.startedTs);
    return (
      started !== null &&
      (since === null || started >= since.ms) &&
      (until === null || started < until.ms)
    );
  });

  let reached = 0;
  let stuck = 0;
  const reasons = new Map<string | null, number>();
  const minutes: Array<number> = [];
  const merged: Array<string> = [];
  for (const { record, summary } of runs) {
    const entries = record?.entries ?? [];
    const prOpen = firstMoveTo(entries, "pr-open");
    if (prOpen !== undefined) {
      const person = firstMoveTo(entries, "needs-info", "stuck");
      if (person === undefined || entries.indexOf(person) > entries.indexOf(prOpen)) reached++;
      const claim = entries.find((entry) => entry.event === "claimed");
      if (claim !== undefined) minutes.push((prOpen.ms - claim.ms) / 60_000);
    }
    if (firstMoveTo(entries, "stuck") !== undefined) {
      stuck++;
      // The stop's code (the line's cause), not its text: the text carries counts and command
      // output, so it would split one cause into a row per run. A line from before causes
      // existed falls back to its text.
      const line = entries.find((entry) => entry.event === "stuck");
      const reason =
        line === undefined ? null : (line.cause?.reason ?? dataText(line.data, "reason"));
      reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    }
    if (summary.prEnd === "merged") {
      if (summary.prUrl === null) {
        io.err(`factory-runner: warning: ${runIdFileName(summary.id)} merged with no PR URL`);
      } else {
        merged.push(summary.prUrl);
      }
    }
  }
  minutes.sort((a, b) => a - b);
  const clean = merged.filter((url) => noChangeRequests(url, io)).length;

  return {
    data_dir: dataDir,
    since: since?.text ?? null,
    until: until?.text ?? null,
    runs: runs.length,
    reached_pr_open_without_person: { runs: reached, share: share(reached, runs.length) },
    stuck: {
      runs: stuck,
      share: share(stuck, runs.length),
      by_reason: [...reasons]
        .map(([reason, count]) => ({ reason, runs: count }))
        .sort((a, b) => b.runs - a.runs || byReason(a.reason, b.reason)),
    },
    claim_to_pr_open_minutes: { runs: minutes.length, median: median(minutes), p90: p90(minutes) },
    merged_without_change_requests: {
      merged: merged.length,
      without_change_requests: clean,
      share: share(clean, merged.length),
    },
  };
};

const percent = (part: number, whole: number) =>
  whole === 0 ? "n/a" : `${part}/${whole} (${Math.round((part / whole) * 100)}%)`;

/** Minutes to one decimal place, without a trailing `.0`. */
const mins = (value: number) => `${Math.round(value * 10) / 10} min`;

const lines = (report: RetroReport): Array<string> => {
  const window = [
    ...(report.since === null ? [] : [`since ${report.since}`]),
    ...(report.until === null ? [] : [`until ${report.until}`]),
  ];
  const { median: mid, p90: high, runs: timed } = report.claim_to_pr_open_minutes;
  const merged = report.merged_without_change_requests;
  return [
    `runs: ${report.runs}${window.length === 0 ? "" : ` (${window.join(", ")})`}`,
    `reached pr-open without a person: ${percent(report.reached_pr_open_without_person.runs, report.runs)}`,
    `stuck: ${percent(report.stuck.runs, report.runs)}`,
    ...report.stuck.by_reason.map(
      ({ reason, runs }) => `  ${reason ?? "(no reason)"}: ${runs}`,
    ),
    mid === null || high === null
      ? "claim to pr-open: n/a"
      : `claim to pr-open: median ${mins(mid)}, p90 ${mins(high)} (${timed} runs)`,
    `merged without change requests: ${percent(merged.without_change_requests, merged.merged)}`,
  ];
};

/** `factory-runner retro`: 0 printed, 1 failed, 2 a wrong command line. */
export const retro = (argv: ReadonlyArray<string>, io: RetroIo, usage: string): number => {
  const args = parseArgs(argv);
  if (typeof args === "string") {
    io.err(`factory-runner: ${args}`);
    io.err(usage);
    return 2;
  }
  if (!NodeFS.statSync(args.dataDir, { throwIfNoEntry: false })?.isDirectory()) {
    io.err(`factory-runner: no data dir at ${args.dataDir}`);
    return 1;
  }
  const report = buildRetro(args, io);
  if (args.json) io.out(JSON.stringify(report, null, 2));
  else for (const line of lines(report)) io.out(line);
  return 0;
};
