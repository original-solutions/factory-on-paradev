/**
 * The events a run ledger can hold, and the fields of each in the order they are written to the
 * file. `docs/reference/ledger.md` in softfac is the spec; the order of the fields is the order
 * of the fields in softfac's `Event` enum, which is the order serde writes them in.
 */

import { isU32 } from "./limits.ts";

/** Which part of the factory wrote a line. */
export type CauseStep =
  | "start"
  | "watch"
  | "forward"
  | "advance"
  | "gate"
  | "pass"
  | "retro"
  | "operator";

/** How a run ended. */
export type Outcome = "pr-open" | "stuck" | "needs-info";

/** How a run's pull request ended, for a run that ended because it did. */
export type PrEnd = "merged" | "closed";

/** The label names without their `factory:` prefix. */
export type StateName =
  | "proposed"
  | "ready"
  | "triage"
  | "needs-info"
  | "building"
  | "pr-open"
  | "stuck";

/** What an `error` line was about. */
export type ErrorKind = "github" | "tracker" | "t3" | "git" | "gate" | "ledger" | "config";

/** One required check in a `checks_read` line. */
export type CheckRead = { readonly name: string; readonly state: string };

/** The earlier run and branch a launch continued from. */
export type ResumedFrom = { readonly run: string; readonly branch: string };

/**
 * Something that happened in a run, as `{ event, data }`. Fields softfac omits when absent are
 * optional and left out of the line when `undefined`; the rest are written, `null` where softfac
 * writes `null`. No event holds a token. `questions` and the `message` of `regate_relaunching`,
 * `feedback_relaunching` and `feedback_forwarding` hold text sent elsewhere, written as given.
 */
export type RunEvent =
  | { readonly event: "claimed"; readonly data: { machine: string; github_user: string } }
  | {
      readonly event: "triage_result";
      readonly data: { passed: boolean; reasons: ReadonlyArray<string> };
    }
  | { readonly event: "questions_posted"; readonly data: { questions: string } }
  | {
      readonly event: "answer_received";
      readonly data: { comment_id: string | null; body_edited: boolean };
    }
  | {
      readonly event: "session_launched";
      readonly data: {
        thread_id: string;
        worktree: string | null;
        branch: string | null;
        model_instance: string | null;
        model: string | null;
        /**
         * The provider options the launch sent with the model (a reasoning effort, say), in T3's
         * `ModelSelection.options` shape; null when it sent none.
         */
        model_options: ReadonlyArray<{
          readonly id: string;
          readonly value: string | boolean;
        }> | null;
        resumed_from: ResumedFrom | null;
        /**
         * The branch the run lands on: the issue's `## Base`, else `factory.base`. Absent on a
         * line written before the run's base was recorded, which reads as `factory.base`.
         */
        base?: string;
        /**
         * The issue's title when the session was launched. Absent on a line written before the
         * title was recorded; the run's title then comes from an earlier launch, or is unknown.
         */
        title?: string;
      };
    }
  | { readonly event: "comment_forwarded"; readonly data: { comment_id: string } }
  | {
      readonly event: "session_interrupted";
      readonly data: {
        resumes: number;
        relaunch: boolean;
        run_ordinal: number | null;
        branch: string | null;
        t3_error: string | null;
        ended_in_pass: number;
      };
    }
  | {
      /** The run ended on a provider rate limit, and the session is resumed once in its thread. */
      readonly event: "session_rate_limited";
      readonly data: {
        run_ordinal: number;
        branch: string | null;
        /** The interruption resumes used so far: this resume leaves them as they are. */
        resumes: number;
        /** The model id the resume moved the session to, on the same provider instance. */
        model?: string;
      };
    }
  | { readonly event: "session_paused"; readonly data: { run_ordinal: number | null } }
  | { readonly event: "stop_requested"; readonly data: { by: string } }
  | { readonly event: "step_changed"; readonly data: { step: string } }
  | { readonly event: "pr_opened"; readonly data: { pr: number; url: string } }
  | { readonly event: "pr_left"; readonly data: { pr: number; url: string } }
  | {
      readonly event: "pr_adopted";
      readonly data: { pr: number; branch: string; run: string };
    }
  | { readonly event: "branch_bound"; readonly data: { pr: number; branch: string } }
  | { readonly event: "pr_set_draft"; readonly data: { pr: number } }
  | { readonly event: "pr_ready_outside"; readonly data: { pr: number; by?: string } }
  | {
      readonly event: "gate_command";
      readonly data: { attempt: number; command: string; exit_code: number; duration_ms: number };
    }
  | {
      readonly event: "gate_sent_back";
      readonly data: { attempt: number; run_ordinal: number };
    }
  | {
      readonly event: "gate_checkout";
      readonly data: { attempt: number; dir: string; sha: string; base_sha: string };
    }
  | {
      /** The attempt ended: `total_ms` from the start of its checkout to the end of its last command, or of its aborted merge. */
      readonly event: "gate_finished";
      readonly data: { attempt: number; total_ms: number };
    }
  | {
      readonly event: "gate_regate";
      readonly data: {
        sha: string;
        base_sha: string;
        previous_base_sha: string;
        /**
         * GitHub said the pull request conflicts with the base branch. Absent on a line written
         * before a moved base stopped starting a gate, whose trigger is then not known.
         */
        conflict?: true;
      };
    }
  | {
      readonly event: "regate_relaunching";
      readonly data: { attempt: number; branch: string; message: string };
    }
  | {
      readonly event: "feedback_relaunching";
      readonly data: { n: number; branch: string; items: ReadonlyArray<string>; message: string };
    }
  | {
      readonly event: "feedback_forwarding";
      readonly data: {
        n: number;
        run_ordinal: number | null;
        items: ReadonlyArray<string>;
        message: string;
      };
    }
  | { readonly event: "gate_cleanup_failed"; readonly data: { dir: string; error: string } }
  | { readonly event: "worktree_removed"; readonly data: { path: string } }
  | { readonly event: "worktree_remove_failed"; readonly data: { path: string; error: string } }
  | {
      readonly event: "checks_read";
      readonly data: { sha: string; checks: ReadonlyArray<CheckRead> };
    }
  | { readonly event: "state_changed"; readonly data: { from: StateName; to: StateName } }
  | {
      readonly event: "stuck";
      readonly data: { reason: string; branch?: string; commits_ahead?: number };
    }
  | {
      readonly event: "error";
      readonly data: { step: CauseStep; kind: ErrorKind; message: string };
    }
  | {
      readonly event: "finished";
      readonly data: {
        outcome: Outcome;
        total_ms: number;
        gate_attempts: number;
        review_cycles: number | null;
        pr_url: string | null;
        pr_end: PrEnd | null;
      };
    };

export type RunEventName = RunEvent["event"];

type RunDataKeys<N extends RunEventName> = keyof Extract<RunEvent, { event: N }>["data"];

/**
 * The 33 event types a run file can hold, each with the names of its `data` fields in the order
 * they are written.
 */
export const RUN_EVENT_FIELDS = {
  claimed: ["machine", "github_user"],
  triage_result: ["passed", "reasons"],
  questions_posted: ["questions"],
  answer_received: ["comment_id", "body_edited"],
  session_launched: [
    "thread_id",
    "worktree",
    "branch",
    "model_instance",
    "model",
    "model_options",
    "resumed_from",
    "base",
    "title",
  ],
  comment_forwarded: ["comment_id"],
  session_interrupted: [
    "resumes",
    "relaunch",
    "run_ordinal",
    "branch",
    "t3_error",
    "ended_in_pass",
  ],
  session_rate_limited: ["run_ordinal", "branch", "resumes", "model"],
  session_paused: ["run_ordinal"],
  stop_requested: ["by"],
  step_changed: ["step"],
  pr_opened: ["pr", "url"],
  pr_left: ["pr", "url"],
  pr_adopted: ["pr", "branch", "run"],
  branch_bound: ["pr", "branch"],
  pr_set_draft: ["pr"],
  pr_ready_outside: ["pr", "by"],
  gate_command: ["attempt", "command", "exit_code", "duration_ms"],
  gate_sent_back: ["attempt", "run_ordinal"],
  gate_checkout: ["attempt", "dir", "sha", "base_sha"],
  gate_finished: ["attempt", "total_ms"],
  gate_regate: ["sha", "base_sha", "previous_base_sha", "conflict"],
  regate_relaunching: ["attempt", "branch", "message"],
  feedback_relaunching: ["n", "branch", "items", "message"],
  feedback_forwarding: ["n", "run_ordinal", "items", "message"],
  gate_cleanup_failed: ["dir", "error"],
  worktree_removed: ["path"],
  worktree_remove_failed: ["path", "error"],
  checks_read: ["sha", "checks"],
  state_changed: ["from", "to"],
  stuck: ["reason", "branch", "commits_ahead"],
  error: ["step", "kind", "message"],
  finished: ["outcome", "total_ms", "gate_attempts", "review_cycles", "pr_url", "pr_end"],
} as const satisfies { readonly [N in RunEventName]: ReadonlyArray<RunDataKeys<N>> };

// `satisfies` rejects a listed field the type lacks. This rejects the other mistake: a field the
// type has and the table omits, which `buildData` would silently drop from the file.
type RunFieldsOmitted = {
  [N in RunEventName]: Exclude<RunDataKeys<N>, (typeof RUN_EVENT_FIELDS)[N][number]>;
}[RunEventName];
const _runFieldsComplete: [RunFieldsOmitted] extends [never] ? true : RunFieldsOmitted = true;
void _runFieldsComplete;

const NESTED_FIELDS = {
  resumed_from: ["run", "branch"],
  check: ["name", "state"],
} as const;

const inOrder = (value: unknown, keys: ReadonlyArray<string>): unknown => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const given = value as Record<string, unknown>;
  const ordered: Record<string, unknown> = {};
  for (const key of keys) if (given[key] !== undefined) ordered[key] = given[key];
  return ordered;
};

/**
 * The `data` object of a line: the event's fields in the order of `fields`, leaving out any that
 * are `undefined` and anything that is not a field. `overrides` replace a field's value in place.
 */
export const buildData = (
  fields: ReadonlyArray<string>,
  data: object,
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> => {
  const given = data as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const value = Object.hasOwn(overrides, field) ? overrides[field] : given[field];
    if (value !== undefined) out[field] = value;
  }
  return out;
};

/**
 * `buildData` for a run event, with the two nested shapes (`resumed_from` and the entries of
 * `checks`) also written in softfac's field order.
 */
export const runEventData = (
  event: RunEvent,
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> => {
  const out = buildData(RUN_EVENT_FIELDS[event.event], event.data, overrides);
  if (event.event === "session_launched") {
    out.resumed_from = inOrder(out.resumed_from, NESTED_FIELDS.resumed_from);
  } else if (event.event === "checks_read" && Array.isArray(out.checks)) {
    out.checks = out.checks.map((check) => inOrder(check, NESTED_FIELDS.check));
  }
  return out;
};

/**
 * Why a line was written: the part of the factory that wrote it, a reason code from the lists in
 * ledger.md, and, only when they apply, who did something, which gate command, which attempt
 * and which label. None of it is text from a comment, a prompt or a session.
 */
export type Cause = {
  readonly step: CauseStep;
  readonly reason: string;
  readonly actor?: string;
  readonly command?: string;
  readonly attempt?: number;
  readonly label?: string;
};

export type CauseExtras = {
  readonly actor?: string;
  readonly command?: string;
  readonly attempt?: number;
  readonly label?: string;
};

const CAUSE_FIELD_LIMIT = 100;
const CAUSE_COMMAND_LIMIT = 1_000;

/**
 * A character that must not reach a terminal as itself: C0 and C1 controls, DEL, and the bidi
 * controls that can make text read in a different order than it is stored.
 */
const isUnsafeCodePoint = (cp: number) =>
  cp <= 0x1f ||
  (cp >= 0x7f && cp <= 0x9f) ||
  (cp >= 0x202a && cp <= 0x202e) ||
  (cp >= 0x2066 && cp <= 0x2069);

/** `text` on one line with no control or bidi characters, cut at `limit` characters. */
const cleanCauseText = (text: string, limit: number): string => {
  let out = "";
  let count = 0;
  for (const char of text) {
    if (isUnsafeCodePoint(char.codePointAt(0)!)) continue;
    if (count === limit) break;
    out += char;
    count += 1;
  }
  return out;
};

/**
 * A cause. `actor` and `label` are cleaned and cut at 100 characters, `command` is cleaned and
 * cut at 1000, and an `attempt` that is not a u32 is left out, since softfac would read the
 * whole cause as none; the keys come in the order step, reason, actor, command, attempt, label,
 * and only when set.
 */
export const makeCause = (step: CauseStep, reason: string, extras: CauseExtras = {}): Cause => ({
  step,
  reason,
  ...(extras.actor !== undefined && { actor: cleanCauseText(extras.actor, CAUSE_FIELD_LIMIT) }),
  ...(extras.command !== undefined && {
    command: cleanCauseText(extras.command, CAUSE_COMMAND_LIMIT),
  }),
  ...(isU32(extras.attempt) && { attempt: extras.attempt }),
  ...(extras.label !== undefined && { label: cleanCauseText(extras.label, CAUSE_FIELD_LIMIT) }),
});

/**
 * The cause as written to a line: the keys in softfac's order, whatever order they were built in,
 * with the text fields cleaned and cut here too, so a `Cause` built by hand cannot put session
 * or comment text in the file. `reason`, `actor` and `label` are cut at 100, `command` at 1000,
 * and an `attempt` that is not a u32 is left out.
 */
export const causeObject = (cause: Cause): Record<string, unknown> => {
  const clean = (text: string | undefined, limit: number) =>
    text === undefined ? undefined : cleanCauseText(text, limit);
  return buildData(["step", "reason", "actor", "command", "attempt", "label"], cause, {
    reason: clean(cause.reason, CAUSE_FIELD_LIMIT),
    actor: clean(cause.actor, CAUSE_FIELD_LIMIT),
    command: clean(cause.command, CAUSE_COMMAND_LIMIT),
    attempt: isU32(cause.attempt) ? cause.attempt : undefined,
    label: clean(cause.label, CAUSE_FIELD_LIMIT),
  });
};

/** How a retro ended. */
export type RetroResult =
  | "thread-gone"
  | "done"
  | "stopped"
  | "failed"
  | "interrupted"
  | "cancelled"
  | "rolled_back"
  | "timed-out";

/** How a half-made claim was put right. */
export type ClaimRepair = "finished" | "released" | "reconciled";

/** Where a self-update failed. */
export type UpdateStep = "check" | "checkout" | "install" | "verify" | "config";

/** Which report to the fleet app failed. */
export type FleetCall = "token" | "heartbeat" | "events" | "desired";

/** What the fleet app asked this machine for. */
export type DesiredWhat = "target-commit" | "config";

/** What came of a request from the fleet app. */
export type DesiredState = "applied" | "refused" | "failed";

/**
 * Something that happened that belongs to no run, as `{ event, data }`. `reason` is a code from
 * ledger.md; it is not checked here. An issue is the issue key string (`"8"`, `"ENG-42"`), written
 * by `issueKeyJson`. A `claim_skipped` for the whole machine has only a `reason`, one for a repo
 * another machine owns has no `issue`, and an `attention` for the machine has no `run`.
 */
export type MachineEvent =
  | { readonly event: "pass_started"; readonly data: Record<never, never> }
  | {
      readonly event: "pass_finished";
      readonly data: { runs: number; claimed: number; errors: number; attention: number };
    }
  | { readonly event: "preflight_failed"; readonly data: { check: string; why: string } }
  | {
      readonly event: "repo_skipped";
      readonly data: { repo: string; reason: string; message: string };
    }
  | {
      /** A repo's config or login could not be re-read, so the pass ran on the last good copy. */
      readonly event: "repo_config_stale";
      readonly data: { repo: string; what: "config" | "login"; message: string };
    }
  | {
      readonly event: "claim_skipped";
      readonly data:
        | { repo: string; issue: string; reason: string }
        | { repo: string; reason: string }
        | { reason: string };
    }
  | {
      /** The claim step read the ready lists of `repos` repos, so its skips are the whole queue. */
      readonly event: "ready_listed";
      readonly data: { repos: number };
    }
  | {
      readonly event: "claim_repaired";
      readonly data: { repo: string; issue: string; outcome: ClaimRepair };
    }
  | {
      readonly event: "attention";
      readonly data:
        | { run: string; reason: string }
        | { reason: string; volume: string; free_bytes: number; floor_gb: number; held: number }
        | { reason: string; url: string; user: string; gh_config_dir: string };
    }
  | { readonly event: "self_update_started"; readonly data: { from: string; to: string } }
  | {
      readonly event: "self_update_installed";
      readonly data: { from: string; to: string; duration_ms: number };
    }
  | {
      readonly event: "self_update_failed";
      readonly data: { from: string; to: string; step: UpdateStep; reason: string };
    }
  | { readonly event: "self_update_rolled_back"; readonly data: { from: string; to: string } }
  | {
      readonly event: "fleet_failed";
      readonly data: { call: FleetCall; reason: string; message: string };
    }
  | {
      readonly event: "fleet_desired";
      readonly data: {
        what: DesiredWhat;
        asked: string;
        state: DesiredState;
        reason: string;
        detail?: string;
      };
    }
  | {
      readonly event: "retro_started";
      readonly data: {
        n: number;
        thread_id: string;
        runs: number;
        since_ms: number | null;
        model_instance: string;
        model: string;
      };
    }
  | {
      readonly event: "retro_finished";
      readonly data: { n: number; thread_id: string; result: RetroResult; duration_ms: number };
    }
  | { readonly event: "worktrees_swept"; readonly data: { paths: ReadonlyArray<string> } }
  /** This server started, at `started_at` (epoch ms, its process start). Written once at boot; `interrupted` weighs a session that ended badly against the starts in the last day. */
  | { readonly event: "server_started"; readonly data: { started_at: number } }
  /** This server is shutting down, at `stopping_at` (epoch ms): its shutdown marks every running turn `cancelled` about then. */
  | { readonly event: "server_stopping"; readonly data: { stopping_at: number } }
  | {
      readonly event: "error";
      readonly data: { run?: string; step: CauseStep; kind: ErrorKind; message: string };
    };

export type MachineEventName = MachineEvent["event"];

/**
 * An issue key as softfac's `IssueKey` serialises it: a GitHub number as a JSON number, a Linear
 * identifier as its capitalised string. The key is the canonical form `parseIssueKey` returns.
 * The number is written from its digits, so a key above 2^53 is not rounded.
 */
export const issueKeyJson = (key: string): unknown => (/^\d+$/.test(key) ? JSON.rawJSON(key) : key);

type KeysOfEach<T> = T extends unknown ? keyof T : never;
type MachineDataKeys<N extends MachineEventName> = KeysOfEach<
  Extract<MachineEvent, { event: N }>["data"]
>;

/**
 * The 21 event types the machine log can hold, each with the names of its `data` fields in the
 * order they are written. A type with more than one shape lists the fields of all of them: the
 * ones that are absent are left out, and the shapes share no field that is ordered differently.
 */
export const MACHINE_EVENT_FIELDS = {
  pass_started: [],
  pass_finished: ["runs", "claimed", "errors", "attention"],
  preflight_failed: ["check", "why"],
  repo_skipped: ["repo", "reason", "message"],
  repo_config_stale: ["repo", "what", "message"],
  claim_skipped: ["repo", "issue", "reason"],
  ready_listed: ["repos"],
  claim_repaired: ["repo", "issue", "outcome"],
  attention: [
    "run",
    "reason",
    "volume",
    "free_bytes",
    "floor_gb",
    "held",
    "url",
    "user",
    "gh_config_dir",
  ],
  self_update_started: ["from", "to"],
  self_update_installed: ["from", "to", "duration_ms"],
  self_update_failed: ["from", "to", "step", "reason"],
  self_update_rolled_back: ["from", "to"],
  fleet_failed: ["call", "reason", "message"],
  fleet_desired: ["what", "asked", "state", "reason", "detail"],
  retro_started: ["n", "thread_id", "runs", "since_ms", "model_instance", "model"],
  retro_finished: ["n", "thread_id", "result", "duration_ms"],
  worktrees_swept: ["paths"],
  server_started: ["started_at"],
  server_stopping: ["stopping_at"],
  error: ["run", "step", "kind", "message"],
} as const satisfies { readonly [N in MachineEventName]: ReadonlyArray<MachineDataKeys<N>> };

// As for the run table: a field of any shape that the table omits fails the type check.
type MachineFieldsOmitted = {
  [N in MachineEventName]: Exclude<MachineDataKeys<N>, (typeof MACHINE_EVENT_FIELDS)[N][number]>;
}[MachineEventName];
const _machineFieldsComplete: [MachineFieldsOmitted] extends [never] ? true : MachineFieldsOmitted =
  true;
void _machineFieldsComplete;
