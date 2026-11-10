/**
 * The status report `softfac status --json` carries, from the data dir and facts the caller has;
 * `GET /api/factory/status` serves it. It writes nothing and reads no network, so it answers when
 * GitHub and T3 do not. Left out: softfac's `commit`, `self_update_repo`, `disk`, `claims_paused`,
 * `t3_env_holds` and `t3_logs`; `min_free_gib` shows as the `low-disk` item.
 */
import type { AttentionItem } from "./attention.ts";
import type { MachineHealth } from "./health.ts";
import { deployWait, loadDeploySnooze, loadHandPause, loadPendingDeploy } from "./claims.ts";
import { DEFAULT_DEPLOY_WAIT_MINUTES } from "./config.ts";
import { scanMachineLogBack, type MachineEntry } from "./ledger/machineLog.ts";
import { dataText } from "./ledger/read.ts";
import {
  holdsSlot,
  readRuns,
  runInfoOf,
  type RunRead,
  type RunReadCache,
} from "./ledger/listRuns.ts";
import { asciiLower, runIdToString } from "./ledger/runId.ts";
import { formatTs } from "./ledger/time.ts";

/** The settings of the machine config the status report shows. */
export interface StatusSettings {
  readonly pollSeconds: number;
  readonly maxConcurrentRuns: number;
  /** Minutes a waiting build waits for the runs in progress before autodeploy installs it anyway. */
  readonly deployWaitMinutes: number;
  /** The `repo` of every repo the last pass listed as watched, `owner/name`; empty before the first pass lists them. */
  readonly repos: ReadonlyArray<string>;
}

/**
 * What the factory is doing: running, or idle for a reason (no config, or one it cannot read).
 * `running` means the pass loop started; it says nothing about whether passes succeed, which the
 * server log records. The reason names no path and no error, as every reading client gets it;
 * the log has the detail.
 */
export type FactoryStatus =
  | { readonly state: "running"; readonly settings: StatusSettings }
  | { readonly state: "idle"; readonly reason: string };

export interface StatusReport {
  readonly state: "running" | "idle";
  /** Why the factory is idle; null when it is running. */
  readonly reason: string | null;
  /** The version of the server. */
  readonly version: string;
  readonly machine_config: string;
  readonly machine: string;
  readonly data_dir: string;
  readonly passes: {
    /** When the last pass ended, or failed its checks. */
    readonly at: string | null;
    readonly ago_ms: number | null;
    readonly result: "ok" | "preflight_failed" | null;
    /** For a failed preflight, `<check>: <why>`. */
    readonly reason: string | null;
    readonly poll_seconds: number | null;
    /** A pass is running now. */
    readonly running: boolean;
    /** How long the running pass has been running, when the machine log says when it began. */
    readonly running_for_ms: number | null;
    readonly stale: boolean;
  };
  readonly slots: { readonly used: number; readonly max: number | null };
  /**
   * Threads with an agent at work, a person's or the factory's; null when T3 could not say.
   * Autodeploy waits for none, as installing restarts the server under them.
   */
  readonly threads: { readonly running: number | null };
  /** Claims held back by a person, or null. */
  readonly paused_by_hand: { readonly since: string; readonly for_ms: number } | null;
  /**
   * The build autodeploy has waiting, which holds claims back unless snoozed; null when there is
   * none or its marker is stale.
   */
  readonly deploy_pending: {
    /** The newest build waiting, as a hex sha, when the marker names one. */
    readonly commit: string | null;
    /** When the first build left waiting was found. */
    readonly since: string;
    readonly waited_ms: number;
    /**
     * When autodeploy installs it over the runs in progress: `deploy_wait_minutes` after the first
     * wait or the end of the last snooze, whichever is later. Null while snoozed.
     */
    readonly deploy_by: string | null;
    /** When the snooze in force ends, or null. */
    readonly snoozed_until: string | null;
  } | null;
  /** The runs that are not finished, oldest first. */
  readonly runs: ReadonlyArray<{
    readonly id: string;
    readonly state: string | null;
    /** The event of the run's last readable ledger line; null for none, or an unreadable file. */
    readonly last_event: string | null;
    /** The issue title its first launch recorded; null when that launch has none, or there is none. */
    readonly title: string | null;
    /** The GitHub user the run was claimed as, from its `claimed` line. */
    readonly user: string | null;
    readonly for_ms: number | null;
    readonly pr_url: string | null;
    readonly thread_id: string | null;
    /** Its session reported a pull request since it last entered `building`: it waits for the gate. */
    readonly pr_reported: boolean;
    readonly unreadable: boolean;
  }>;
  /** The unfinished runs, also in `runs`, whose repo is not in the machine config. */
  readonly left_out: ReadonlyArray<{
    readonly id: string;
    readonly state: string;
    readonly pr_url: string | null;
  }>;
  readonly problems: ReadonlyArray<{
    readonly at: string;
    readonly event: "error" | "attention";
    readonly run: string | null;
    readonly step: string | null;
    readonly kind: string | null;
    readonly reason: string | null;
    readonly message: string | null;
  }>;
  /** The disk, load and gates the pass holds claims on, read with the report; null while idle. */
  readonly health: MachineHealth | null;
  /** What the factory needs a person for, from the open attention items. */
  readonly attention: ReadonlyArray<ReportedAttention>;
  /** Open items a person dismissed: still true, so a hold one causes still holds claims. */
  readonly dismissed: ReadonlyArray<ReportedAttention>;
}

interface ReportedAttention {
  readonly id: string;
  readonly kind: string;
  readonly repo: string | null;
  readonly issue: number | null;
  readonly run: string | null;
  readonly message: string;
  readonly first_seen: string;
}

const reported = (item: AttentionItem): ReportedAttention => ({
  id: item.id,
  kind: item.kind,
  repo: item.repo,
  issue: item.issue,
  run: item.run,
  message: item.message,
  first_seen: formatTs(item.firstSeenMs),
});

/** How far back a problem still counts as recent. */
const PROBLEM_WINDOW_MS = 24 * 60 * 60 * 1000;
/** The most problems the report lists. */
const PROBLEM_LIMIT = 10;
/** The last pass is stale when it is older than this many polls. */
const STALE_POLLS = 3;

const recent = (ms: number, nowMs: number) => ms + PROBLEM_WINDOW_MS >= nowMs;

type Problem = StatusReport["problems"][number] & { readonly ms: number };

const machineProblem = (entry: MachineEntry): Problem => ({
  at: formatTs(entry.ms),
  event: entry.event === "error" ? "error" : "attention",
  run: dataText(entry.data, "run"),
  step: dataText(entry.data, "step"),
  kind: dataText(entry.data, "kind"),
  reason: dataText(entry.data, "reason"),
  message: dataText(entry.data, "message"),
  ms: entry.ms,
});

/** What the report takes from the machine log. */
export interface MachineRead {
  /** The last pass that ended or failed its checks. */
  readonly lastPass: MachineEntry | null;
  /** When the last pass began. */
  readonly lastStart: number | null;
  /** The recent `error` and `attention` lines, in file order. */
  readonly problems: ReadonlyArray<MachineEntry>;
  /** How much of the file was read; a test checks the log is not read to its start. */
  readonly bytesRead: number;
}

/**
 * Reads the machine log from its end, which is all the report shows of it: the last pass, the
 * last start and the problems in the window. The log is never rotated, so the read stops once it
 * has a pass and a start and has read a line from before the window; a log with no pass in it is
 * read to the start. It takes the lines to be in time order.
 */
export const readMachineLog = (dataDir: string, nowMs: number): MachineRead => {
  let lastPass: MachineEntry | null = null;
  let lastStart: number | null = null;
  const problems: Array<MachineEntry> = [];
  const bytesRead = scanMachineLogBack(dataDir, (entry) => {
    if (entry.event === "pass_started") lastStart ??= entry.ms;
    else if (entry.event === "pass_finished" || entry.event === "preflight_failed") {
      lastPass ??= entry;
    } else if (
      (entry.event === "error" || entry.event === "attention") &&
      recent(entry.ms, nowMs)
    ) {
      problems.push(entry);
    }
    return lastPass !== null && lastStart !== null && !recent(entry.ms, nowMs)
      ? "stop"
      : "continue";
  });
  // Collected newest first; the report takes them in file order.
  problems.reverse();
  return { lastPass, lastStart, problems, bytesRead };
};

const passesOf = (
  log: Pick<MachineRead, "lastPass" | "lastStart">,
  settings: StatusSettings | null,
  running: boolean,
  nowMs: number,
): StatusReport["passes"] => {
  const { lastPass: last, lastStart } = log;
  const pollSeconds = settings === null ? null : settings.pollSeconds;
  // The running pass began after the last one ended, so a start that `last` came after is not it.
  const runningForMs =
    running && lastStart !== null && (last === null || lastStart > last.ms)
      ? Math.max(0, nowMs - lastStart)
      : null;
  if (last === null) {
    return {
      at: null,
      ago_ms: null,
      result: null,
      reason: null,
      poll_seconds: pollSeconds,
      running,
      running_for_ms: runningForMs,
      stale: false,
    };
  }
  const ago = Math.max(0, nowMs - last.ms);
  const ok = last.event === "pass_finished";
  return {
    at: formatTs(last.ms),
    ago_ms: ago,
    result: ok ? "ok" : "preflight_failed",
    reason: ok
      ? null
      : `${dataText(last.data, "check") ?? ""}: ${dataText(last.data, "why") ?? ""}`,
    poll_seconds: pollSeconds,
    running,
    running_for_ms: runningForMs,
    stale: settings !== null && !running && ago > STALE_POLLS * settings.pollSeconds * 1000,
  };
};

const runRow = (read: RunRead, nowMs: number): StatusReport["runs"][number] => {
  const { summary, seen } = read;
  const lastChange = read.record?.entries.findLast((entry) => entry.event === "state_changed");
  return {
    id: runIdToString(summary.id),
    state: summary.state,
    last_event: summary.lastEvent,
    title: summary.title,
    user: seen?.githubUser ?? null,
    for_ms: lastChange === undefined ? null : Math.max(0, nowMs - lastChange.ms),
    pr_url: summary.prUrl,
    thread_id: seen?.threadId ?? null,
    pr_reported: seen?.prReported ?? false,
    unreadable: summary.unreadable,
  };
};

/**
 * Reads the data dir into a report as of `nowMs`. `dataDir` is the factory dir; a missing one
 * reads as an empty one. Throws the ledger's errors like the other ledger reads (a machine log
 * that is a symlink, a runs directory that cannot be listed), so call it through `ledgerCall`.
 * Writes nothing.
 */
export const buildStatus = (input: {
  readonly status: FactoryStatus;
  readonly version: string;
  readonly machine: string;
  readonly machineConfigPath: string;
  readonly dataDir: string;
  readonly nowMs: number;
  /** A pass is running now (the loop's `passRunning`). */
  readonly passRunning: boolean;
  /** The loop's `runningThreads`, or null when it failed. */
  readonly runningThreads: number | null;
  readonly attention: ReadonlyArray<AttentionItem>;
  readonly dismissed?: ReadonlyArray<AttentionItem>;
  /** The loop's `health`; null when idle or not read. */
  readonly health?: MachineHealth | null;
  /** The run files the last report read, kept by the caller between reports. */
  readonly cache?: RunReadCache;
}): StatusReport => {
  const { dataDir, nowMs } = input;
  const settings = input.status.state === "running" ? input.status.settings : null;
  const log = readMachineLog(dataDir, nowMs);
  // One read of the runs gives the rows, the slots and the problems. A finished run last written
  // before the window cannot hold a line inside it, so it is not read.
  const reads = readRuns(dataDir, {
    skipFinishedBefore: nowMs - PROBLEM_WINDOW_MS,
    ...(input.cache === undefined ? {} : { cache: input.cache }),
  });
  const open = reads.filter((read) => !read.summary.finished);

  // The one place the port follows the fork's pass, not softfac's `holds_slot`: a run counts as
  // the pass counts it, so an unconfirmed run and one whose pull request is reported hold none.
  const used = open.filter((read) => holdsSlot(runInfoOf(read.summary.id, read.seen))).length;

  // Oldest first: the machine log, then the runs. Reversed and stably sorted by time, a later
  // line comes before an earlier one of the same time.
  const problems: Array<Problem> = [];
  for (const entry of log.problems) problems.push(machineProblem(entry));
  for (const read of reads) {
    for (const entry of read.record?.entries ?? []) {
      if (entry.event !== "error" || !recent(entry.ms, nowMs)) continue;
      problems.push({
        at: formatTs(entry.ms),
        event: "error",
        run: runIdToString(read.summary.id),
        step: dataText(entry.data, "step"),
        kind: dataText(entry.data, "kind"),
        reason: null,
        message: dataText(entry.data, "message"),
        ms: entry.ms,
      });
    }
  }
  problems.reverse();
  problems.sort((a, b) => b.ms - a.ms);

  const watched = settings === null ? null : settings.repos.map(asciiLower);
  const pause = loadHandPause(dataDir);
  const wait = deployWait(loadPendingDeploy(dataDir), loadDeploySnooze(dataDir), nowMs);
  const waitMinutes = settings === null ? DEFAULT_DEPLOY_WAIT_MINUTES : settings.deployWaitMinutes;
  return {
    state: input.status.state,
    reason: input.status.state === "idle" ? input.status.reason : null,
    version: input.version,
    machine_config: input.machineConfigPath,
    machine: input.machine,
    data_dir: dataDir,
    passes: passesOf(log, settings, input.passRunning, nowMs),
    slots: { used, max: settings === null ? null : settings.maxConcurrentRuns },
    threads: { running: input.runningThreads },
    paused_by_hand:
      pause === null
        ? null
        : { since: formatTs(pause.sinceMs), for_ms: Math.max(0, nowMs - pause.sinceMs) },
    deploy_pending:
      wait === null
        ? null
        : {
            commit: wait.pending.commit,
            since: formatTs(wait.pending.sinceMs),
            waited_ms: Math.max(0, nowMs - wait.pending.sinceMs),
            deploy_by:
              wait.clockFromMs === null ? null : formatTs(wait.clockFromMs + waitMinutes * 60_000),
            snoozed_until: wait.snoozedUntilMs === null ? null : formatTs(wait.snoozedUntilMs),
          },
    runs: open.map((read) => runRow(read, nowMs)),
    left_out:
      watched === null
        ? []
        : open
            .filter((read) => !watched.includes(asciiLower(read.summary.id.repo)))
            .map((read) => ({
              id: runIdToString(read.summary.id),
              state: read.summary.unreadable ? "unreadable" : (read.summary.state ?? "starting"),
              pr_url: read.summary.prUrl,
            })),
    problems: problems.slice(0, PROBLEM_LIMIT).map((problem) => ({
      at: problem.at,
      event: problem.event,
      run: problem.run,
      step: problem.step,
      kind: problem.kind,
      reason: problem.reason,
      message: problem.message,
    })),
    health: input.health ?? null,
    attention: input.attention.map(reported),
    dismissed: (input.dismissed ?? []).map(reported),
  };
};
