/** The issue lifecycle as a pure function: state and event in, next state and actions out. */

import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

/** The `factory:` label that currently holds an issue, without its `factory:` prefix. */
export type State =
  | "proposed"
  | "ready"
  | "triage"
  | "needs-info"
  | "building"
  | "pr-open"
  | "stuck";

/** Every state, in lifecycle order. */
export const STATES = [
  "proposed",
  "ready",
  "triage",
  "needs-info",
  "building",
  "pr-open",
  "stuck",
] as const satisfies ReadonlyArray<State>;

/** The GitHub label for a state, e.g. `factory:needs-info`. */
export const stateLabel = (state: State): string => `factory:${state}`;

/** Whether `value` is one of the seven state names. */
export const isState = (value: unknown): value is State =>
  typeof value === "string" && (STATES as ReadonlyArray<string>).includes(value);

/** The state for a `factory:` label (exact, case-sensitive), or undefined if it is not ours. */
export const stateFromLabel = (label: string): State | undefined =>
  STATES.find((state) => stateLabel(state) === label);

const COLORS: Record<State, string> = {
  proposed: "c5def5",
  ready: "0e8a16",
  triage: "fbca04",
  "needs-info": "d93f0b",
  building: "1d76db",
  "pr-open": "5319e7",
  stuck: "b60205",
};

/** The label's colour on GitHub: six lowercase hex digits without the `#`. */
export const stateColor = (state: State): string => COLORS[state];

const DESCRIPTIONS: Record<State, string> = {
  proposed: "A bot filed it. The factory ignores it until a person sets `factory:ready`.",
  ready: "Approved for the factory.",
  triage: "Claimed. The session is being launched.",
  "needs-info": "The factory asked questions on the issue. Answer them, then set `factory:ready`.",
  building: "A session is building it.",
  "pr-open": "The PR is open and has passed the gate.",
  stuck: "The factory gave up and said why in a comment.",
};

/** What the label means: the label table's text in the lifecycle docs and the label's GitHub description. */
export const stateDescription = (state: State): string => DESCRIPTIONS[state];

/**
 * Something that happened to an issue. The caller decides which one; this module only reacts.
 * `kind` is the event's kebab-case name, as used in error messages.
 */
export type Event =
  | { readonly kind: "approved" }
  | { readonly kind: "claimed" }
  | { readonly kind: "session-starting" }
  | { readonly kind: "questions-raised"; readonly questions: string }
  | { readonly kind: "failed"; readonly reason: string }
  | { readonly kind: "instructor-commented"; readonly commentId: string }
  | { readonly kind: "body-edited" }
  | { readonly kind: "gate-failed"; readonly output: string }
  | { readonly kind: "pr-ready"; readonly pr: number }
  /** The factory refused to build a `ready` issue: it was not approved by an instructor. */
  | { readonly kind: "unapproved"; readonly reason: string }
  /**
   * A pull request that was ready for review failed the gate again on the moved base branch.
   * `output` is what goes into the session.
   */
  | { readonly kind: "regate-failed"; readonly pr: number; readonly output: string }
  /**
   * An instructor left feedback on a pull request that was ready for review, or on its issue.
   * The feedback goes to a new session, not through the lifecycle.
   */
  | { readonly kind: "instructor-feedback"; readonly pr: number };

/** A side effect for the caller to perform, in order. */
export type Action =
  | { readonly kind: "assign-to-machine" }
  | { readonly kind: "unassign" }
  | { readonly kind: "set-label"; readonly state: State }
  | { readonly kind: "launch-session" }
  | { readonly kind: "update-status-comment" }
  | { readonly kind: "post-questions"; readonly questions: string }
  | { readonly kind: "post-stuck-comment"; readonly reason: string }
  | { readonly kind: "forward-comment"; readonly commentId: string }
  | { readonly kind: "forward-body-edit" }
  | { readonly kind: "send-gate-failure"; readonly output: string }
  | { readonly kind: "mark-pr-ready"; readonly pr: number }
  | { readonly kind: "mark-pr-draft"; readonly pr: number }
  | { readonly kind: "post-gate-results"; readonly pr: number }
  | { readonly kind: "post-unapproved"; readonly reason: string };

/** The result of a valid transition. */
export type Transition = {
  readonly next: State;
  readonly actions: ReadonlyArray<Action>;
};

/** The failure of {@link transition}: the event is not valid in the current state. */
export class InvalidTransition extends Schema.TaggedError<InvalidTransition>()(
  "InvalidTransition",
  {
    state: Schema.Literals(STATES),
    /** The event's `kind`. */
    event: Schema.String,
  },
) {
  override get message(): string {
    return `event \`${this.event}\` is not valid in state \`${this.state}\``;
  }
}

const setLabel = (state: State): Action => ({ kind: "set-label", state });

/** The table row for the pair, or undefined when the pair is not in the table. */
const tableRow = (state: State, event: Event): Transition | undefined => {
  switch (event.kind) {
    case "approved":
      // softfac's table has no needs-info pair; its docs say an answered issue leaves needs-info
      // when a person sets `factory:ready`. This deliberately follows the docs, not the table.
      if (state === "proposed" || state === "needs-info" || state === "stuck") {
        return { next: "ready", actions: [] };
      }
      break;
    case "unapproved":
      if (state === "ready") {
        return {
          next: "proposed",
          actions: [{ kind: "post-unapproved", reason: event.reason }, setLabel("proposed")],
        };
      }
      break;
    case "claimed":
      if (state === "ready") {
        return {
          next: "triage",
          actions: [{ kind: "assign-to-machine" }, setLabel("triage")],
        };
      }
      break;
    case "session-starting":
      if (state === "triage") {
        return {
          next: "building",
          actions: [
            setLabel("building"),
            { kind: "launch-session" },
            { kind: "update-status-comment" },
          ],
        };
      }
      break;
    case "questions-raised":
      if (state === "triage" || state === "building") {
        return {
          next: "needs-info",
          actions: [
            { kind: "post-questions", questions: event.questions },
            setLabel("needs-info"),
            { kind: "unassign" },
            { kind: "update-status-comment" },
          ],
        };
      }
      break;
    case "failed":
      if (state === "triage" || state === "building" || state === "pr-open") {
        return {
          next: "stuck",
          actions: [
            { kind: "post-stuck-comment", reason: event.reason },
            setLabel("stuck"),
            { kind: "unassign" },
            { kind: "update-status-comment" },
          ],
        };
      }
      break;
    case "instructor-commented":
      if (state === "building") {
        return {
          next: "building",
          actions: [{ kind: "forward-comment", commentId: event.commentId }],
        };
      }
      break;
    case "body-edited":
      if (state === "building") {
        return { next: "building", actions: [{ kind: "forward-body-edit" }] };
      }
      break;
    case "gate-failed":
      if (state === "building") {
        return {
          next: "building",
          actions: [{ kind: "send-gate-failure", output: event.output }],
        };
      }
      break;
    case "pr-ready":
      if (state === "building") {
        return {
          next: "pr-open",
          actions: [
            { kind: "mark-pr-ready", pr: event.pr },
            { kind: "post-gate-results", pr: event.pr },
            setLabel("pr-open"),
            { kind: "update-status-comment" },
          ],
        };
      }
      break;
    case "regate-failed":
      if (state === "pr-open") {
        return {
          next: "building",
          actions: [
            { kind: "mark-pr-draft", pr: event.pr },
            { kind: "assign-to-machine" },
            setLabel("building"),
            { kind: "send-gate-failure", output: event.output },
            { kind: "update-status-comment" },
          ],
        };
      }
      break;
    case "instructor-feedback":
      if (state === "pr-open") {
        return {
          next: "building",
          actions: [
            { kind: "mark-pr-draft", pr: event.pr },
            { kind: "assign-to-machine" },
            setLabel("building"),
            { kind: "update-status-comment" },
          ],
        };
      }
      break;
  }
  return undefined;
};

/**
 * Next state and actions for `event` arriving while an issue is in `state`. Does no I/O. Fails
 * with {@link InvalidTransition} for a pair that is not in the table.
 */
export const transition = (
  state: State,
  event: Event,
): Result.Result<Transition, InvalidTransition> => {
  const row = tableRow(state, event);
  return row === undefined
    ? Result.fail(new InvalidTransition({ state, event: event.kind }))
    : Result.succeed(row);
};
