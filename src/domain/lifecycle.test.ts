import * as Result from "effect/Result";
import { describe, expect, it } from "vitest";

import {
  InvalidTransition,
  STATES,
  stateColor,
  stateDescription,
  stateFromLabel,
  stateLabel,
  transition,
  type Action,
  type Event,
  type State,
  type Transition,
} from "./lifecycle.ts";

/** The label table of softfac's docs/lifecycle.md, pinned: the first two columns of each row. */
const LABEL_TABLE_ROWS = [
  "| `factory:proposed` | A bot filed it. The factory ignores it until a person sets `factory:ready`. |",
  "| `factory:ready` | Approved for the factory. |",
  "| `factory:triage` | Claimed. The session is being launched. |",
  "| `factory:needs-info` | The factory asked questions on the issue. Answer them, then set `factory:ready`. |",
  "| `factory:building` | A session is building it. |",
  "| `factory:pr-open` | The PR is open and has passed the gate. |",
  "| `factory:stuck` | The factory gave up and said why in a comment. |",
];

const ok = (state: State, event: Event): Transition => {
  const result = transition(state, event);
  if (Result.isFailure(result)) throw new Error(result.failure.message);
  return result.success;
};

const invalid = (state: State, event: Event): InvalidTransition | undefined => {
  const result = transition(state, event);
  return Result.isFailure(result) ? result.failure : undefined;
};

const stuckActions = (reason: string): Array<Action> => [
  { kind: "post-stuck-comment", reason },
  { kind: "set-label", state: "stuck" },
  { kind: "unassign" },
  { kind: "update-status-comment" },
];

const questionsActions = (questions: string): Array<Action> => [
  { kind: "post-questions", questions },
  { kind: "set-label", state: "needs-info" },
  { kind: "unassign" },
  { kind: "update-status-comment" },
];

describe("lifecycle states", () => {
  it("every state has a distinct six digit colour", () => {
    const seen: Array<string> = [];
    for (const state of STATES) {
      const color = stateColor(state);
      expect(color, color).toMatch(/^[0-9a-f]{6}$/);
      expect(seen, `${color} is used twice`).not.toContain(color);
      seen.push(color);
    }
  });

  it("the descriptions are the meanings in the lifecycle label table", () => {
    expect(LABEL_TABLE_ROWS).toHaveLength(STATES.length);
    for (const state of STATES) {
      const row = `| \`${stateLabel(state)}\` | ${stateDescription(state)} |`;
      expect(LABEL_TABLE_ROWS, `the label table has no row ${row}`).toContain(row);
      // GitHub cuts a label description at 100 characters.
      expect([...stateDescription(state)].length).toBeLessThanOrEqual(100);
    }
  });

  it("labels round trip", () => {
    const expected = [
      ["proposed", "factory:proposed"],
      ["ready", "factory:ready"],
      ["triage", "factory:triage"],
      ["needs-info", "factory:needs-info"],
      ["building", "factory:building"],
      ["pr-open", "factory:pr-open"],
      ["stuck", "factory:stuck"],
    ] as const;
    expect(expected).toHaveLength(STATES.length);
    expect(STATES).toEqual(expected.map(([state]) => state));
    for (const [state, label] of expected) {
      expect(stateLabel(state)).toBe(label);
      expect(stateFromLabel(label)).toBe(state);
    }
  });

  it("unknown labels are rejected", () => {
    expect(stateFromLabel("factory:nope")).toBeUndefined();
    expect(stateFromLabel("ready")).toBeUndefined();
    expect(stateFromLabel("")).toBeUndefined();
    expect(stateFromLabel("Factory:ready")).toBeUndefined();
  });
});

describe("lifecycle transitions", () => {
  it("proposed approved", () => {
    const t = ok("proposed", { kind: "approved" });
    expect(t.next).toBe("ready");
    expect(t.actions).toEqual([]);
  });

  it("ready unapproved", () => {
    const t = ok("ready", { kind: "unapproved", reason: "edited" });
    expect(t.next).toBe("proposed");
    expect(t.actions).toEqual([
      { kind: "post-unapproved", reason: "edited" },
      { kind: "set-label", state: "proposed" },
    ]);
  });

  it("ready claimed", () => {
    const t = ok("ready", { kind: "claimed" });
    expect(t.next).toBe("triage");
    expect(t.actions).toEqual([
      { kind: "assign-to-machine" },
      { kind: "set-label", state: "triage" },
    ]);
  });

  it("triage session starting", () => {
    const t = ok("triage", { kind: "session-starting" });
    expect(t.next).toBe("building");
    expect(t.actions).toEqual([
      { kind: "set-label", state: "building" },
      { kind: "launch-session" },
      { kind: "update-status-comment" },
    ]);
  });

  it("triage questions raised", () => {
    const t = ok("triage", { kind: "questions-raised", questions: "why?" });
    expect(t.next).toBe("needs-info");
    expect(t.actions).toEqual(questionsActions("why?"));
  });

  it("triage failed", () => {
    const t = ok("triage", { kind: "failed", reason: "boom" });
    expect(t.next).toBe("stuck");
    expect(t.actions).toEqual(stuckActions("boom"));
  });

  it("building instructor commented", () => {
    const t = ok("building", { kind: "instructor-commented", commentId: "42" });
    expect(t.next).toBe("building");
    expect(t.actions).toEqual([{ kind: "forward-comment", commentId: "42" }]);
  });

  it("building body edited", () => {
    const t = ok("building", { kind: "body-edited" });
    expect(t.next).toBe("building");
    expect(t.actions).toEqual([{ kind: "forward-body-edit" }]);
  });

  it("building gate failed", () => {
    const t = ok("building", { kind: "gate-failed", output: "red" });
    expect(t.next).toBe("building");
    expect(t.actions).toEqual([{ kind: "send-gate-failure", output: "red" }]);
  });

  it("building pr ready", () => {
    const t = ok("building", { kind: "pr-ready", pr: 9 });
    expect(t.next).toBe("pr-open");
    expect(t.actions).toEqual([
      { kind: "mark-pr-ready", pr: 9 },
      { kind: "post-gate-results", pr: 9 },
      { kind: "set-label", state: "pr-open" },
      { kind: "update-status-comment" },
    ]);
  });

  it("pr open failed", () => {
    const t = ok("pr-open", { kind: "failed", reason: "r" });
    expect(t.next).toBe("stuck");
    expect(t.actions).toEqual(stuckActions("r"));
  });

  it("pr open regate failed puts the pr back to draft and the issue back to building", () => {
    const t = ok("pr-open", { kind: "regate-failed", pr: 12, output: "boom" });
    expect(t.next).toBe("building");
    expect(t.actions).toEqual([
      { kind: "mark-pr-draft", pr: 12 },
      { kind: "assign-to-machine" },
      { kind: "set-label", state: "building" },
      { kind: "send-gate-failure", output: "boom" },
      { kind: "update-status-comment" },
    ]);
  });

  it("pr open instructor feedback puts the pr back to draft and the issue straight to building", () => {
    const t = ok("pr-open", { kind: "instructor-feedback", pr: 12 });
    expect(t.next).toBe("building");
    expect(t.actions).toEqual([
      { kind: "mark-pr-draft", pr: 12 },
      { kind: "assign-to-machine" },
      { kind: "set-label", state: "building" },
      { kind: "update-status-comment" },
    ]);
  });

  it("building questions raised", () => {
    const t = ok("building", { kind: "questions-raised", questions: "which?" });
    expect(t.next).toBe("needs-info");
    expect(t.actions).toEqual(questionsActions("which?"));
  });

  it("building failed", () => {
    const t = ok("building", { kind: "failed", reason: "timeout" });
    expect(t.next).toBe("stuck");
    expect(t.actions).toEqual(stuckActions("timeout"));
  });

  it("needs info approved", () => {
    const t = ok("needs-info", { kind: "approved" });
    expect(t.next).toBe("ready");
    expect(t.actions).toEqual([]);
  });

  it("stuck approved", () => {
    const t = ok("stuck", { kind: "approved" });
    expect(t.next).toBe("ready");
    expect(t.actions).toEqual([]);
  });
});

/** Every event kind. Typed as a record so adding an `Event` kind fails typecheck until listed. */
const EVENT_KINDS = {
  approved: true,
  claimed: true,
  "session-starting": true,
  "questions-raised": true,
  failed: true,
  "instructor-commented": true,
  "body-edited": true,
  "gate-failed": true,
  "pr-ready": true,
  unapproved: true,
  "regate-failed": true,
  "instructor-feedback": true,
} as const satisfies Record<Event["kind"], true>;

/** Every event kind with a sample value and its hand-written expected name. */
const everyEvent: ReadonlyArray<readonly [Event, string]> = [
  [{ kind: "approved" }, "approved"],
  [{ kind: "claimed" }, "claimed"],
  [{ kind: "session-starting" }, "session-starting"],
  [{ kind: "questions-raised", questions: "q" }, "questions-raised"],
  [{ kind: "failed", reason: "r" }, "failed"],
  [{ kind: "instructor-commented", commentId: "1" }, "instructor-commented"],
  [{ kind: "body-edited" }, "body-edited"],
  [{ kind: "gate-failed", output: "o" }, "gate-failed"],
  [{ kind: "pr-ready", pr: 2 }, "pr-ready"],
  [{ kind: "unapproved", reason: "r" }, "unapproved"],
  [{ kind: "regate-failed", pr: 3, output: "o" }, "regate-failed"],
  [{ kind: "instructor-feedback", pr: 4 }, "instructor-feedback"],
];

const VALID: ReadonlyArray<readonly [State, string]> = [
  ["proposed", "approved"],
  ["ready", "claimed"],
  ["ready", "unapproved"],
  ["triage", "session-starting"],
  ["triage", "questions-raised"],
  ["triage", "failed"],
  ["building", "instructor-commented"],
  ["building", "body-edited"],
  ["building", "gate-failed"],
  ["building", "pr-ready"],
  ["building", "questions-raised"],
  ["building", "failed"],
  ["pr-open", "failed"],
  ["pr-open", "regate-failed"],
  ["pr-open", "instructor-feedback"],
  ["needs-info", "approved"],
  ["stuck", "approved"],
];

describe("lifecycle transition table", () => {
  it("every event is listed", () => {
    expect(everyEvent.map(([event]) => event.kind)).toEqual(Object.keys(EVENT_KINDS));
  });

  it("event names are pinned", () => {
    for (const [event, name] of everyEvent) {
      expect(event.kind).toBe(name);
    }
  });

  it("exactly the table pairs succeed", () => {
    let validSeen = 0;
    for (const state of STATES) {
      for (const [event, name] of everyEvent) {
        const error = invalid(state, event);
        if (VALID.some(([s, n]) => s === state && n === name)) {
          expect(error, `${state} / ${name} should be valid`).toBeUndefined();
          validSeen += 1;
        } else {
          expect(error, `${state} / ${name} should be invalid`).toBeInstanceOf(InvalidTransition);
          expect(error?.state).toBe(state);
          expect(error?.event).toBe(name);
        }
      }
    }
    expect(validSeen).toBe(17);
    expect(VALID).toHaveLength(17);
  });

  it("pr open accepts only failed, regate failed and instructor feedback", () => {
    for (const [event, name] of everyEvent) {
      if (name === "failed" || name === "regate-failed" || name === "instructor-feedback") {
        continue;
      }
      const error = invalid("pr-open", event);
      expect(error).toBeInstanceOf(InvalidTransition);
      expect(error?.state).toBe("pr-open");
      expect(error?.event).toBe(name);
    }
  });

  it("an invalid pair is a typed failure, not a throw", () => {
    const result = transition("building", { kind: "claimed" });
    expect(Result.isFailure(result) && result.failure._tag).toBe("InvalidTransition");
  });

  it("invalid transition display", () => {
    expect(invalid("building", { kind: "claimed" })?.message).toBe(
      "event `claimed` is not valid in state `building`",
    );
    expect(invalid("pr-open", { kind: "pr-ready", pr: 1 })?.message).toBe(
      "event `pr-ready` is not valid in state `pr-open`",
    );
  });

  it("set label always matches next state", () => {
    for (const state of STATES) {
      for (const [event] of everyEvent) {
        if (invalid(state, event)) continue;
        const t = ok(state, event);
        const labels = t.actions.flatMap((action) =>
          action.kind === "set-label" ? [action.state] : [],
        );
        if (labels.length === 0) {
          // Self-loops keep their label; a person already moved proposed/needs-info/stuck to ready.
          expect(
            t.next === state || state === "proposed" || state === "needs-info" || state === "stuck",
            `${state} -> ${t.next} must set a label`,
          ).toBe(true);
        } else {
          expect(labels).toEqual([t.next]);
        }
      }
    }
  });

  it("assignment follows the state entered", () => {
    for (const state of STATES) {
      for (const [event] of everyEvent) {
        if (invalid(state, event)) continue;
        const t = ok(state, event);
        const unassigns = t.actions.filter((action) => action.kind === "unassign").length;
        const assigns = t.actions.filter((action) => action.kind === "assign-to-machine").length;
        // Only entering a state counts: a comment forwarded to the session is a self-loop.
        const entered = t.next !== state;
        // Taking an issue (from `ready`) assigns it; giving it up releases it.
        let want: readonly [number, number] = [0, 0];
        if ((t.next === "needs-info" || t.next === "stuck") && entered) want = [1, 0];
        else if (state === "ready" && t.next === "triage") want = [0, 1];
        // A ready pull request whose gate failed again: the issue is ours again.
        else if (state === "pr-open" && t.next === "building") want = [0, 1];
        expect([unassigns, assigns], `${state} -> ${t.next}`).toEqual(want);
      }
    }
  });
});
