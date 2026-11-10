import { assert, it } from "@effect/vitest";
import { describe } from "vitest";

import type { Entry } from "../ledger/read.ts";
import {
  attemptsSincePass,
  committingFeedback,
  movedSince,
  nextGateAttempt,
  pendingRelaunch,
  readProgress,
  regateAttempt,
  regateBranch,
  relaunchCommandId,
} from "./progress.ts";

const MINUTE = 60_000;

const line = (ms: number, event: string, data: unknown): Entry => ({
  ts: "2026-10-04T10:00:00Z",
  ms,
  event,
  data,
  cause: null,
});

const step = (ms: number, text: string) => line(ms, "step_changed", { step: text });
const moved = (ms: number, from: string, to: string) => line(ms, "state_changed", { from, to });
const launched = (ms: number) =>
  line(ms, "session_launched", {
    thread_id: "thread-1",
    worktree: "/t3/wt",
    branch: "t3code/abc",
    model_instance: null,
    model: null,
    resumed_from: null,
  });

describe("readProgress: the pull request", () => {
  it("keeps every pull request the run reported and the newest one with its url", () => {
    const seen = readProgress([
      line(1, "pr_opened", { pr: 12, url: "https://github.com/rawphp/softfac/pull/12" }),
      line(2, "pr_opened", { pr: 14, url: "https://github.com/rawphp/softfac/pull/14" }),
    ]);
    assert.deepStrictEqual(seen.opened, [12, 14]);
    assert.deepStrictEqual(seen.lastPr, {
      pr: 14,
      url: "https://github.com/rawphp/softfac/pull/14",
    });
  });

  it("has none before the first", () => {
    const seen = readProgress([]);
    assert.deepStrictEqual(seen.opened, []);
    assert.strictEqual(seen.lastPr, null);
    assert.strictEqual(seen.prReported, false);
  });

  it("keeps a pull request a stopping session left apart from the ones the run reported", () => {
    // A `pr_left` line is written by a stuck exit, for the next attempt to continue: the session
    // did not report it for the gate, so the run still holds its slot and its time limit.
    const url = "https://github.com/rawphp/softfac/pull/12";
    const seen = readProgress([line(1, "pr_left", { pr: 12, url })]);
    assert.deepStrictEqual(seen.left, [{ pr: 12, url }]);
    assert.deepStrictEqual(seen.opened, []);
    assert.strictEqual(seen.lastPr, null);
    assert.strictEqual(seen.prReported, false);
  });

  it("reports a pull request the session reports after a stuck exit recorded it as left", () => {
    const url = "https://github.com/rawphp/softfac/pull/12";
    const seen = readProgress([
      line(1, "pr_left", { pr: 12, url }),
      line(2, "pr_opened", { pr: 12, url }),
    ]);
    assert.deepStrictEqual(seen.opened, [12]);
    assert.deepStrictEqual(seen.lastPr, { pr: 12, url });
    assert.strictEqual(seen.prReported, true);
  });

  it("keeps a pull request reported again after a send-back once, and reported", () => {
    const url = "https://github.com/rawphp/softfac/pull/12";
    const seen = readProgress([
      line(1, "pr_opened", { pr: 12, url }),
      line(2, "gate_sent_back", { attempt: 1, run_ordinal: 1 }),
      line(3, "pr_opened", { pr: 12, url }),
    ]);
    assert.deepStrictEqual(seen.opened, [12]);
    assert.strictEqual(seen.prReported, true);
  });

  it("is reported from pr_opened until the run is building again", () => {
    const opened = line(1, "pr_opened", {
      pr: 12,
      url: "https://github.com/rawphp/softfac/pull/12",
    });
    assert.strictEqual(readProgress([opened]).prReported, true);
    assert.strictEqual(readProgress([opened, moved(2, "building", "pr-open")]).prReported, true);
    assert.strictEqual(
      readProgress([opened, moved(2, "building", "pr-open"), moved(3, "pr-open", "building")])
        .prReported,
      false,
    );
  });
});

describe("readProgress: the questions", () => {
  it("are posted from questions_posted until the run is building again", () => {
    assert.strictEqual(
      readProgress([line(1, "questions_posted", { questions: "q" })]).questionsPosted,
      true,
    );
    assert.strictEqual(
      readProgress([
        line(1, "questions_posted", { questions: "q" }),
        moved(2, "needs-info", "building"),
      ]).questionsPosted,
      false,
    );
    assert.strictEqual(
      readProgress([
        line(1, "questions_posted", { questions: "q" }),
        moved(2, "building", "needs-info"),
      ]).questionsPosted,
      true,
    );
  });
});

describe("readProgress: the reminder and the wait for a newer run", () => {
  it("reads the ordinal of a reminder that was started, and that it was sent", () => {
    const started = readProgress([step(1, "result-line-reminding 3")]);
    assert.strictEqual(started.reminding, 3);
    assert.strictEqual(started.reminded, false);
    const sent = readProgress([
      step(1, "result-line-reminding 3"),
      step(2, "result-line-reminded"),
    ]);
    assert.strictEqual(sent.reminding, 3);
    assert.strictEqual(sent.reminded, true);
  });

  it("waits for a run newer than the reminder's, or a forward's", () => {
    assert.strictEqual(readProgress([step(1, "result-line-reminding 3")]).waitingAfter, 3);
    assert.strictEqual(readProgress([step(1, "forward-wait 2")]).waitingAfter, 2);
    assert.strictEqual(readProgress([]).waitingAfter, null);
  });

  it("never waits for an older run than before", () => {
    assert.strictEqual(
      readProgress([step(1, "forward-wait 4"), step(2, "result-line-reminding 2")]).waitingAfter,
      4,
    );
    assert.strictEqual(
      readProgress([step(1, "forward-wait 2"), step(2, "result-line-reminding 2")]).waitingAfter,
      2,
    );
  });

  it("does not read a forward's wait as a reminder", () => {
    const seen = readProgress([step(1, "forward-wait 1")]);
    assert.strictEqual(seen.reminding, null);
    assert.strictEqual(seen.reminded, false);
  });

  it("ignores steps whose number is not one", () => {
    const seen = readProgress([
      step(1, "result-line-reminding"),
      step(2, "result-line-reminding x"),
      step(3, "result-line-reminding 01"),
      step(4, "result-line-reminding 1 2"),
    ]);
    assert.strictEqual(seen.reminding, null);
    assert.strictEqual(seen.waitingAfter, null);
  });

  it("starts again for a new session: each thread has one reminder and its own run numbers", () => {
    const seen = readProgress([
      step(1, "result-line-reminding 3"),
      step(2, "result-line-reminded"),
      line(3, "session_paused", { run_ordinal: 3 }),
      launched(4),
    ]);
    assert.strictEqual(seen.reminding, null);
    assert.strictEqual(seen.reminded, false);
    assert.strictEqual(seen.waitingAfter, null);
    assert.strictEqual(seen.paused, null);
  });
});

describe("readProgress: a stop by hand", () => {
  it("keeps the newest pause with the run it stopped", () => {
    assert.strictEqual(readProgress([]).paused, null);
    assert.deepStrictEqual(readProgress([line(1, "session_paused", { run_ordinal: 2 })]).paused, {
      runOrdinal: 2,
    });
    assert.deepStrictEqual(
      readProgress([
        line(1, "session_paused", { run_ordinal: 2 }),
        line(2, "session_paused", { run_ordinal: null }),
      ]).paused,
      { runOrdinal: null },
    );
  });
});

describe("readProgress: the time worked", () => {
  it("counts from the first line while the run is in triage or building", () => {
    const seen = readProgress([line(1000, "claimed", {}), moved(1000, "ready", "triage")]);
    assert.strictEqual(seen.workedMs, 0);
    assert.strictEqual(seen.workingSince, 1000);
  });

  it("is zero and not counting for a ledger with no lines", () => {
    const seen = readProgress([]);
    assert.strictEqual(seen.workedMs, 0);
    assert.strictEqual(seen.workingSince, null);
  });

  it("adds each stint when the state changes, and starts the next in triage or building", () => {
    const seen = readProgress([
      line(0, "claimed", {}),
      moved(0, "ready", "triage"),
      moved(MINUTE, "triage", "building"),
      moved(10 * MINUTE, "building", "needs-info"),
    ]);
    assert.strictEqual(seen.workedMs, 10 * MINUTE);
    assert.strictEqual(seen.workingSince, null);
  });

  it("stops counting when the run is finished", () => {
    const seen = readProgress([
      line(0, "claimed", {}),
      moved(0, "ready", "triage"),
      line(5 * MINUTE, "finished", {}),
    ]);
    assert.strictEqual(seen.workingSince, null);
  });

  it("does not charge the build again when a pull request that was open comes back to building", () => {
    const seen = readProgress([
      line(0, "claimed", {}),
      moved(0, "ready", "triage"),
      moved(MINUTE, "triage", "building"),
      moved(30 * MINUTE, "building", "pr-open"),
      moved(500 * MINUTE, "pr-open", "building"),
    ]);
    assert.strictEqual(seen.workedMs, 0);
    assert.strictEqual(seen.workingSince, 500 * MINUTE);
  });

  const opened = (ms: number) =>
    line(ms, "pr_opened", { pr: 12, url: "https://github.com/rawphp/softfac/pull/12" });
  const sentBack = (ms: number) => line(ms, "gate_sent_back", { attempt: 1, run_ordinal: 1 });

  it("does not charge the factory's gate, from the reported pull request until it is sent back", () => {
    const toPr = [
      line(0, "claimed", {}),
      moved(0, "ready", "triage"),
      moved(MINUTE, "triage", "building"),
      opened(20 * MINUTE),
    ];
    const held = readProgress(toPr);
    assert.strictEqual(held.workedMs, 20 * MINUTE);
    assert.strictEqual(held.workingSince, null);
    const back = readProgress([...toPr, sentBack(90 * MINUTE)]);
    assert.strictEqual(back.workedMs, 20 * MINUTE);
    assert.strictEqual(back.workingSince, 90 * MINUTE);
  });

  it("charges only the session's stints across two gates", () => {
    const seen = readProgress([
      line(0, "claimed", {}),
      moved(0, "triage", "building"),
      opened(10 * MINUTE),
      sentBack(50 * MINUTE),
      opened(60 * MINUTE),
      sentBack(100 * MINUTE),
    ]);
    assert.strictEqual(seen.workedMs, 20 * MINUTE);
    assert.strictEqual(seen.workingSince, 100 * MINUTE);
  });

  it("keeps counting through a pr_opened line it does not accept", () => {
    const seen = readProgress([
      line(0, "claimed", {}),
      moved(0, "triage", "building"),
      line(20 * MINUTE, "pr_opened", { pr: "12" }),
    ]);
    assert.strictEqual(seen.workingSince, 0);
  });

  it("restarts a clock already running at a gate sent back, keeping the time before it", () => {
    const seen = readProgress([
      line(0, "claimed", {}),
      moved(0, "triage", "building"),
      sentBack(10 * MINUTE),
    ]);
    assert.strictEqual(seen.workedMs, 10 * MINUTE);
    assert.strictEqual(seen.workingSince, 10 * MINUTE);
  });

  it("never counts a pull request reported before the stint began", () => {
    const seen = readProgress([
      line(0, "claimed", {}),
      moved(30 * MINUTE, "triage", "building"),
      opened(10 * MINUTE),
    ]);
    assert.strictEqual(seen.workedMs, 30 * MINUTE);
  });

  it("leaves a gate sent back while the pull request is open to the next state change", () => {
    const seen = readProgress([
      line(0, "claimed", {}),
      moved(0, "triage", "building"),
      opened(10 * MINUTE),
      moved(30 * MINUTE, "building", "pr-open"),
      sentBack(50 * MINUTE),
    ]);
    assert.strictEqual(seen.workingSince, null);
  });

  it("never counts a backwards clock", () => {
    const seen = readProgress([
      line(10 * MINUTE, "claimed", {}),
      moved(5 * MINUTE, "ready", "triage"),
    ]);
    assert.strictEqual(seen.workedMs, 0);
  });
});

describe("readProgress: a stop by hand", () => {
  it("is requested from the stop_requested line on, whatever follows", () => {
    assert.strictEqual(readProgress([]).stopRequested, false);
    const requested = line(1, "stop_requested", { by: "operator" });
    assert.strictEqual(readProgress([requested]).stopRequested, true);
    assert.strictEqual(
      readProgress([requested, step(2, "launch-sending"), moved(3, "triage", "building")])
        .stopRequested,
      true,
    );
  });
});

describe("readProgress: forwarded comments and body edits", () => {
  it("keeps the id of every comment_forwarded line", () => {
    assert.deepStrictEqual([...readProgress([]).forwarded], []);
    const seen = readProgress([
      line(1, "comment_forwarded", { comment_id: "102" }),
      line(2, "comment_forwarded", { comment_id: "101" }),
      line(3, "comment_forwarded", { comment_id: "102" }),
    ]);
    assert.deepStrictEqual([...seen.forwarded].sort(), ["101", "102"]);
  });

  it("keeps the time of every body-edit-forwarded step, whatever follows the space", () => {
    const seen = readProgress([
      step(1, "body-edit-forwarded 2026-10-04T10:15:00Z"),
      step(2, "body-edit-forwarded x"),
    ]);
    assert.deepStrictEqual([...seen.bodyEdits].sort(), ["2026-10-04T10:15:00Z", "x"]);
  });

  it("keeps the time of every body-edit-dropped step with the forwarded ones", () => {
    const seen = readProgress([
      step(1, "body-edit-forwarded A"),
      step(2, "body-edit-dropped B"),
      step(3, "body-edit-droppedC"),
    ]);
    assert.deepStrictEqual([...seen.bodyEdits].sort(), ["A", "B"]);
  });

  it("does not count a step that only looks like a forwarded edit", () => {
    const seen = readProgress([
      step(1, "body-edit-forwarded2026-10-04T10:15:00Z"),
      step(2, "body-edit-forward 2026-10-04T10:15:00Z"),
      step(3, "Body-edit-forwarded 2026-10-04T10:15:00Z"),
      step(4, "xbody-edit-forwarded 2026-10-04T10:15:00Z"),
    ]);
    assert.deepStrictEqual([...seen.bodyEdits], []);
  });

  it("keeps the id of every comment-dropped step", () => {
    assert.deepStrictEqual([...readProgress([]).dropped], []);
    const seen = readProgress([
      step(1, "comment-dropped 8"),
      step(2, "comment-dropped IC_kwDO1"),
      step(3, "comment-dropped 8"),
    ]);
    assert.deepStrictEqual([...seen.dropped].sort(), ["8", "IC_kwDO1"]);
  });

  it("a comment-dropped id is one plain token", () => {
    const seen = readProgress(
      [
        "comment-dropped ",
        "comment-dropped a b",
        "comment-dropped a\tb",
        "comment-dropped a\u0007b",
        "comment-dropped a\n",
        "comment-dropped7",
      ].map((text, index) => step(index + 1, text)),
    );
    assert.deepStrictEqual([...seen.dropped], []);
  });
});

describe("readProgress: the last wait marker", () => {
  const sentBack = (ms: number, ordinal: number) =>
    line(ms, "gate_sent_back", { attempt: 1, run_ordinal: ordinal });
  const command = (ms: number) =>
    line(ms, "gate_command", { attempt: 1, command: "cargo test", exit_code: 0, duration_ms: 5 });

  it("is none before any marker", () => {
    assert.strictEqual(readProgress([launched(1)]).lastWait, null);
  });

  it("is the ordinal of a forward-wait, a reminder or a send-back, whichever is the newest", () => {
    assert.strictEqual(readProgress([step(1, "forward-wait 3")]).lastWait, 3);
    assert.strictEqual(readProgress([step(1, "result-line-reminding 2")]).lastWait, 2);
    assert.strictEqual(readProgress([sentBack(1, 4)]).lastWait, 4);
    assert.strictEqual(readProgress([step(1, "forward-wait 1"), sentBack(2, 2)]).lastWait, 2);
  });

  it("never goes down when a marker for an older run is written later", () => {
    const seen = readProgress([step(1, "forward-wait 3"), sentBack(2, 2)]);
    assert.strictEqual(seen.lastWait, 3);
    assert.strictEqual(seen.waitingAfter, 3);
  });

  it("is kept after a gate_command drops a send-back's marker", () => {
    const seen = readProgress([sentBack(1, 2), command(2)]);
    assert.strictEqual(seen.waitingAfter, null);
    assert.strictEqual(seen.lastWait, 2);
  });

  it("starts again with a new session", () => {
    const seen = readProgress([step(1, "forward-wait 5"), launched(2)]);
    assert.strictEqual(seen.lastWait, null);
    assert.strictEqual(seen.waitingAfter, null);
  });

  it("ignores a step that only looks like a wait marker", () => {
    for (const bad of [
      "forward-wait 007",
      "forward-wait -1",
      "forward-wait 1 ",
      "forward-wait x",
    ]) {
      const seen = readProgress([step(1, bad)]);
      assert.strictEqual(seen.lastWait, null, bad);
      assert.strictEqual(seen.waitingAfter, null, bad);
    }
  });
});

describe("readProgress: an interruption", () => {
  const interrupted = (ms: number, over: Record<string, unknown> = {}) =>
    line(ms, "session_interrupted", {
      resumes: 1,
      relaunch: false,
      run_ordinal: 2,
      branch: "t3code/abc",
      t3_error: null,
      ended_in_pass: 2,
      ...over,
    });

  it("is none before the first line", () => {
    const seen = readProgress([launched(1)]);
    assert.strictEqual(seen.interruption, null);
    assert.strictEqual(seen.lastBranch, "t3code/abc");
  });

  it("keeps the newest line, owed its send until the matching step", () => {
    const owed = readProgress([launched(1), interrupted(2)]);
    assert.deepStrictEqual(owed.interruption, {
      resumes: 1,
      relaunch: false,
      runOrdinal: 2,
      branch: "t3code/abc",
      sent: false,
      rateLimited: false,
      model: null,
    });
    const sent = readProgress([launched(1), interrupted(2), step(3, "interruption-sent 1")]);
    assert.strictEqual(sent.interruption?.sent, true);
    // A step for another count is not this line's.
    const other = readProgress([launched(1), interrupted(2), step(3, "interruption-sent 2")]);
    assert.strictEqual(other.interruption?.sent, false);
  });

  it("is a wait marker for the run that ended, as a forward's is", () => {
    const seen = readProgress([launched(1), interrupted(2)]);
    assert.strictEqual(seen.waitingAfter, 2);
    assert.strictEqual(seen.lastWait, 2);
    // A relaunch waits for nothing: the thread is gone.
    const relaunch = readProgress([
      launched(1),
      interrupted(2, { relaunch: true, run_ordinal: null }),
    ]);
    assert.strictEqual(relaunch.waitingAfter, null);
    assert.strictEqual(relaunch.interruption?.relaunch, true);
  });

  it("names the newest branch a launch or an interruption line carries", () => {
    const seen = readProgress([
      launched(1),
      interrupted(2, { branch: "t3code/def" }),
      interrupted(3, { branch: null }),
    ]);
    assert.strictEqual(seen.lastBranch, "t3code/def");
    // The line's own branch is kept apart: this one names none.
    assert.strictEqual(seen.interruption?.branch, null);
  });

  it("carries a relaunch's branch and count, which the next attempt reads", () => {
    const seen = readProgress([
      launched(1),
      interrupted(2, { resumes: 2, relaunch: true, run_ordinal: null, branch: "t3code/def" }),
    ]);
    assert.deepStrictEqual(seen.interruption, {
      resumes: 2,
      relaunch: true,
      runOrdinal: null,
      branch: "t3code/def",
      sent: false,
      rateLimited: false,
      model: null,
    });
    // A count that is not a number is no line at all, so the older decision stands.
    const odd = readProgress([
      launched(1),
      interrupted(2, { relaunch: true, run_ordinal: null }),
      interrupted(3, { resumes: "two", relaunch: true, run_ordinal: null, branch: "t3code/x" }),
    ]);
    assert.strictEqual(odd.interruption?.resumes, 1);
    assert.strictEqual(odd.interruption?.branch, "t3code/abc");
    assert.strictEqual(odd.lastBranch, "t3code/x");
  });

  it("owes nothing to a new session: its thread has its own runs", () => {
    const seen = readProgress([launched(1), interrupted(2), launched(3)]);
    assert.strictEqual(seen.interruption?.sent, true);
    assert.strictEqual(seen.waitingAfter, null);
  });
});

describe("readProgress: the approval", () => {
  const approved = (ms: number, actor?: string): Entry => ({
    ...step(ms, "approved 2026-10-04T10:00:00Z"),
    cause: { step: "start", reason: "approved", ...(actor === undefined ? {} : { actor }) },
  });

  it("names the moment and the instructor on the first approved step", () => {
    const seen = readProgress([approved(1, "tomkaczocha"), approved(2, "other")]);
    assert.strictEqual(seen.approvedAt, "2026-10-04T10:00:00Z");
    assert.strictEqual(seen.approvedBy, "tomkaczocha");
  });

  it("names no instructor when the cause has none, or has an empty one", () => {
    assert.strictEqual(readProgress([approved(1)]).approvedBy, null);
    assert.strictEqual(readProgress([approved(1, "")]).approvedBy, null);
    assert.strictEqual(readProgress([]).approvedBy, null);
  });
});

describe("readProgress: the branch a launch resumed from", () => {
  const RUN = { repo: "rawphp/softfac", issue: "10", attempt: 2 };
  const resumedLaunch = (ms: number, run: string, branch: string) =>
    line(ms, "session_launched", {
      thread_id: "thread-2",
      worktree: "/t3/wt2",
      branch: "t3code/own",
      model_instance: null,
      model: null,
      resumed_from: { run, branch },
    });

  it("is none for a plain launch", () => {
    const seen = readProgress([launched(1)]);
    assert.strictEqual(seen.resumedFrom, null);
    assert.strictEqual(seen.resumedFromRun, null);
    assert.strictEqual(regateBranch(seen, RUN), null);
  });

  it("names the run and the branch of the launch line's resumed_from", () => {
    const seen = readProgress([resumedLaunch(1, "rawphp__softfac__10__1", "t3code/old")]);
    assert.strictEqual(seen.resumedFrom, "t3code/old");
    assert.strictEqual(seen.resumedFromRun, "rawphp__softfac__10__1");
    assert.strictEqual(seen.lastBranch, "t3code/own");
  });

  it("is the pull request's branch only for a re-gate session, which resumed from the run itself", () => {
    // A re-gate of run 2 launched a session from its pull request's branch: that is where it pushes.
    const regate = readProgress([resumedLaunch(1, "rawphp__softfac__10__2", "feat/pr-12")]);
    assert.strictEqual(regateBranch(regate, RUN), "feat/pr-12");
    // A session resumed from attempt 1's branch works on T3's own branch.
    const resumed = readProgress([resumedLaunch(1, "rawphp__softfac__10__1", "t3code/old")]);
    assert.strictEqual(regateBranch(resumed, RUN), null);
  });

  it("is the newest launch line's", () => {
    const seen = readProgress([
      resumedLaunch(1, "rawphp__softfac__10__2", "feat/pr-12"),
      launched(2),
    ]);
    assert.strictEqual(seen.resumedFrom, null);
    assert.strictEqual(seen.resumedFromRun, null);
    assert.strictEqual(regateBranch(seen, RUN), null);
  });
});

describe("readProgress: the launch-sending step of a resume", () => {
  it("reads the branch of a resume from an earlier run's branch, with no pull request", () => {
    const seen = readProgress([step(1, "launch-sending resumed-from t3code/abc")]);
    assert.isTrue(seen.launchSent);
    assert.strictEqual(seen.launchResumedFrom, "t3code/abc");
    assert.strictEqual(seen.launchResumedPr, null);
  });

  it("reads the pull request of a resume onto an open pull request from the step before", () => {
    const seen = readProgress([
      step(1, "launch-pull-request t3code/abc https://github.com/rawphp/softfac/pull/12"),
      step(2, "launch-sending resumed-from t3code/abc"),
    ]);
    assert.strictEqual(seen.launchResumedFrom, "t3code/abc");
    assert.strictEqual(seen.launchResumedPr, "https://github.com/rawphp/softfac/pull/12");
  });

  it("takes no pull request decided for another branch, or with no launch-sending step after it", () => {
    // A decision a crash cut short before its `launch-sending` step, then another decision.
    const other = readProgress([
      step(1, "launch-pull-request t3code/abc https://github.com/rawphp/softfac/pull/12"),
      step(2, "launch-sending resumed-from t3code/def"),
    ]);
    assert.strictEqual(other.launchResumedFrom, "t3code/def");
    assert.strictEqual(other.launchResumedPr, null);
    const unsent = readProgress([
      step(1, "launch-pull-request t3code/abc https://github.com/rawphp/softfac/pull/12"),
    ]);
    assert.isFalse(unsent.launchSent);
    assert.strictEqual(unsent.launchResumedPr, null);
  });

  it("is none for a plain launch", () => {
    const seen = readProgress([step(1, "launch-sending")]);
    assert.isTrue(seen.launchSent);
    assert.strictEqual(seen.launchResumedFrom, null);
    assert.strictEqual(seen.launchResumedPr, null);
  });
});

describe("readProgress: a cancelled forward wait", () => {
  const sentBack = (ms: number, ordinal: number) =>
    line(ms, "gate_sent_back", { attempt: 1, run_ordinal: ordinal });

  it("a forward-wait no send follows is idle", () => {
    assert.strictEqual(readProgress([step(1, "forward-wait 2")]).idleForwardWait, 2);
    assert.strictEqual(
      readProgress([step(1, "forward-wait 2"), line(2, "comment_forwarded", { comment_id: "5" })])
        .idleForwardWait,
      null,
    );
    assert.strictEqual(
      readProgress([step(1, "forward-wait 2"), step(2, "body-edit-forwarded x")]).idleForwardWait,
      null,
    );
    assert.strictEqual(
      readProgress([step(1, "forward-wait 2"), step(2, "comment-dropped 7")]).idleForwardWait,
      2,
    );
  });

  it("a cancel for the idle marker clears the wait and restores the last wait", () => {
    const seen = readProgress([step(1, "forward-wait 2"), step(2, "forward-wait-cancelled 2")]);
    assert.strictEqual(seen.waitingAfter, null);
    assert.strictEqual(seen.lastWait, null);
    assert.strictEqual(seen.idleForwardWait, null);

    const after = readProgress([
      sentBack(1, 1),
      step(2, "forward-wait 2"),
      step(3, "forward-wait-cancelled 2"),
    ]);
    assert.strictEqual(after.waitingAfter, null);
    assert.strictEqual(after.lastWait, 1);
  });

  it("a cancel does not undo a marker a send used", () => {
    const seen = readProgress([
      step(1, "forward-wait 2"),
      line(2, "comment_forwarded", { comment_id: "5" }),
      step(3, "forward-wait-cancelled 2"),
    ]);
    assert.strictEqual(seen.waitingAfter, 2);
    assert.strictEqual(seen.lastWait, 2);
  });

  it("a cancel for another ordinal, or one that only looks like one, changes nothing", () => {
    const other = readProgress([step(1, "forward-wait 2"), step(2, "forward-wait-cancelled 3")]);
    assert.strictEqual(other.waitingAfter, 2);
    for (const bad of [
      "forward-wait-cancelled 02",
      "forward-wait-cancelled x",
      "forward-wait-cancelled 2 ",
    ]) {
      const seen = readProgress([step(1, "forward-wait 2"), step(2, bad)]);
      assert.strictEqual(seen.waitingAfter, 2, bad);
      assert.strictEqual(seen.lastWait, 2, bad);
    }
  });

  it("an idle marker is proven refused only when every send under it has a refused line", () => {
    // Each line as `forward` writes it: the step, and the T3 command id of the send in its cause.
    const sending = (text: string, command: string | null): Entry => ({
      ...step(1, text),
      cause: command === null ? null : { step: "forward", reason: "seed", command },
    });
    const A = "softfac:rawphp/softfac#10:comment:7";
    const B = "softfac:rawphp/softfac#10:body:x";
    const proven = (...entries: ReadonlyArray<Entry>) => readProgress(entries).refusedForwardWait;
    // The one send under it has no outcome yet: it may have gone in.
    assert.strictEqual(proven(sending("forward-wait 2", A)), null);
    assert.strictEqual(proven(sending("forward-wait 2", A), sending("comment-refused 7", A)), 2);
    assert.strictEqual(proven(sending("forward-wait 2", B), sending("body-edit-refused x", B)), 2);
    // Each further send writes the marker again before it goes out.
    assert.strictEqual(
      proven(
        sending("forward-wait 2", A),
        sending("comment-refused 7", A),
        sending("forward-wait 2", B),
      ),
      null,
    );
    assert.strictEqual(
      proven(
        sending("forward-wait 2", A),
        sending("comment-refused 7", A),
        sending("forward-wait 2", B),
        sending("body-edit-refused x", B),
      ),
      2,
    );
    // A send with no outcome stays open until a refusal names its command id: T3 keeps one result
    // per command id, so refusing the resend proves the lost send never went in.
    assert.strictEqual(
      proven(
        sending("forward-wait 2", A),
        sending("forward-wait 2", B),
        sending("body-edit-refused x", B),
      ),
      null,
    );
    assert.strictEqual(
      proven(
        sending("forward-wait 2", A),
        sending("forward-wait 2", A),
        sending("comment-refused 7", A),
      ),
      2,
    );
    assert.strictEqual(proven(sending("forward-wait 2", A), sending("comment-refused 7", B)), null);
    // A marker that names no send (an older build's) or a refusal that names none proves nothing.
    assert.strictEqual(
      proven(sending("forward-wait 2", null), sending("comment-refused 7", A)),
      null,
    );
    assert.strictEqual(
      proven(
        sending("forward-wait 2", null),
        sending("forward-wait 2", A),
        sending("comment-refused 7", A),
      ),
      null,
    );
    assert.strictEqual(
      proven(sending("forward-wait 2", A), sending("comment-refused 7", null)),
      null,
    );
    // A drop notice is not an outcome of a send.
    assert.strictEqual(proven(sending("forward-wait 2", A), sending("comment-dropped 7", A)), null);
    assert.strictEqual(
      proven(
        sending("forward-wait 2", A),
        line(2, "comment_forwarded", { comment_id: "5" }),
        sending("comment-refused 7", A),
      ),
      null,
    );
    assert.strictEqual(
      proven(
        sending("forward-wait 2", A),
        sending("comment-refused 7", A),
        step(3, "forward-wait-cancelled 2"),
      ),
      null,
    );
    assert.strictEqual(proven(sending("comment-refused 7", A)), null);
  });

  it("a cancel after markers written again restores the wait from before the first", () => {
    const seen = readProgress([
      sentBack(1, 1),
      step(2, "forward-wait 2"),
      step(3, "comment-refused 7"),
      step(4, "forward-wait 2"),
      step(5, "body-edit-refused x"),
      step(6, "forward-wait-cancelled 2"),
    ]);
    assert.strictEqual(seen.waitingAfter, null);
    assert.strictEqual(seen.lastWait, 1);
    assert.strictEqual(seen.idleForwardWait, null);
  });

  it("a new session forgets an idle marker", () => {
    const seen = readProgress([step(1, "forward-wait 2"), launched(2)]);
    assert.strictEqual(seen.idleForwardWait, null);
  });
});

describe("readProgress: the checks read", () => {
  const sha = "0123456789ABCDEF0123456789abcdef01234567";
  const checksRead = (ms: number, checks: ReadonlyArray<{ name: string; state: string }>) =>
    line(ms, "checks_read", { sha, checks });

  it("checksPassed is the newest all-passed checks_read's lower-case sha and null for any other read", () => {
    const mixed = checksRead(1, [
      { name: "gate", state: "passed" },
      { name: "lint", state: "failed" },
    ]);
    const allPassed = checksRead(2, [
      { name: "gate", state: "passed" },
      { name: "lint", state: "passed" },
    ]);
    const laterMixed = checksRead(3, [
      { name: "gate", state: "passed" },
      { name: "lint", state: "pending" },
    ]);
    assert.strictEqual(readProgress([mixed]).checksPassed, null);
    assert.strictEqual(readProgress([mixed, allPassed]).checksPassed, sha.toLowerCase());
    assert.strictEqual(readProgress([mixed, allPassed, laterMixed]).checksPassed, null);
    assert.strictEqual(readProgress([allPassed, checksRead(4, [])]).checksPassed, null);
  });

  it("a pass recorded after a read clears it: the new pass's checks are read afresh", () => {
    const allPassed = checksRead(1, [{ name: "gate", state: "passed" }]);
    const failed = checksRead(1, [{ name: "gate", state: "failed" }]);
    const passedAgain = step(2, `gate-passed ${sha.toLowerCase()} 2`);
    const seen = readProgress([allPassed, passedAgain]);
    assert.strictEqual(seen.checksPassed, null);
    assert.strictEqual(readProgress([failed, passedAgain]).checksFailed, null);
  });

  it("checksFailed names the failed checks of the newest failing read, and a later read keeps it", () => {
    const failing = checksRead(1, [
      { name: "gate", state: "failed" },
      { name: "lint", state: "pending" },
      { name: "docs", state: "failed" },
    ]);
    const want = {
      sha: sha.toLowerCase(),
      failed: ["gate", "docs"].map((name) => ({
        name,
        state: "failed" as const,
        conclusion: "",
        url: null,
      })),
    };
    assert.deepStrictEqual(readProgress([failing]).checksFailed, want);
    const laterPassed = checksRead(2, [
      { name: "gate", state: "passed" },
      { name: "lint", state: "passed" },
      { name: "docs", state: "passed" },
    ]);
    assert.deepStrictEqual(readProgress([failing, laterPassed]).checksFailed, want);
    assert.strictEqual(
      readProgress([checksRead(1, [{ name: "gate", state: "pending" }])]).checksFailed,
      null,
    );
  });

  it("checksTimedOut is the read the wait running out wrote, and no other unfinished read", () => {
    const pending = [
      { name: "gate", state: "passed" },
      { name: "lint", state: "pending" },
    ];
    const timedOut = (checks: ReadonlyArray<{ name: string; state: string }>) => ({
      ...checksRead(1, checks),
      cause: { step: "gate", reason: "checks-timed-out", attempt: 1 },
    });
    assert.deepStrictEqual(readProgress([timedOut(pending)]).checksTimedOut, {
      sha: sha.toLowerCase(),
      missing: false,
    });
    assert.deepStrictEqual(
      readProgress([timedOut([{ name: "gate", state: "missing" }])]).checksTimedOut,
      {
        sha: sha.toLowerCase(),
        missing: true,
      },
    );
    // A read with checks still running that the wait did not end decides nothing.
    assert.strictEqual(readProgress([checksRead(1, pending)]).checksTimedOut, null);
    const recorded = { ...checksRead(1, pending), cause: { step: "gate", reason: "progress" } };
    assert.strictEqual(readProgress([recorded]).checksTimedOut, null);
  });
});

describe("readProgress: gating again", () => {
  const HEAD = "4f1c2d3e4a5b60718293a4b5c6d7e8f901234567";
  const PUSHED = "7e6d5c4b3a291807f6e5d4c3b2a190817263a4b5";
  const BASE = "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d";
  const MOVED = "9f8e7d6c5b4a39281706f5e4d3c2b1a098765432";
  const RUN = { repo: "rawphp/softfac", issue: "10", attempt: 1 };

  const checkout = (ms: number, base: string) =>
    line(ms, "gate_checkout", { attempt: 1, dir: "/d", sha: HEAD, base_sha: base });
  const command = (ms: number) =>
    line(ms, "gate_command", { attempt: 1, command: "cargo test", exit_code: 0, duration_ms: 5 });
  const passed = (ms: number) => ({
    ...step(ms, `gate-passed ${HEAD} 1`),
    cause: { step: "gate", reason: "gate-passed", attempt: 1 },
  });
  /** A pass on `HEAD` against `BASE`, then `pr-open`. */
  const PASS: ReadonlyArray<Entry> = [
    launched(1),
    line(2, "pr_opened", { pr: 12, url: "https://github.com/rawphp/softfac/pull/12" }),
    checkout(3, BASE),
    command(4),
    passed(5),
    step(6, "gate-results-posted"),
    moved(7, "building", "pr-open"),
  ];
  const regated = (ms: number, sha: string, base: string, previous: string) =>
    line(ms, "gate_regate", { sha, base_sha: base, previous_base_sha: previous, conflict: true });
  /** A line an older factory wrote: no `conflict` field, whatever started it. */
  const regatedBefore = (ms: number, sha: string, base: string, previous: string) =>
    line(ms, "gate_regate", { sha, base_sha: base, previous_base_sha: previous });
  const relaunching = (ms: number) =>
    line(ms, "regate_relaunching", { attempt: 2, branch: "t3code/abc", message: "boom" });

  it("has no re-gate under way before a gate_regate line", () => {
    const seen = readProgress(PASS);
    assert.strictEqual(seen.regating, false);
    assert.strictEqual(seen.regateMoved, null);
    assert.strictEqual(seen.regatePassed, false);
    assert.strictEqual(seen.regateSentBack, false);
    assert.strictEqual(seen.relaunch, null);
  });

  it("is under way from a gate_regate line, and says what started it", () => {
    const seen = readProgress([...PASS, regated(8, HEAD, MOVED, BASE)]);
    assert.strictEqual(seen.regating, true);
    // The head did not move: the base alone starts no gate, so only a conflict is left.
    assert.strictEqual(seen.regateMoved, "conflict");
    assert.strictEqual(readProgress([...PASS, regated(8, PUSHED, BASE, BASE)]).regateMoved, "head");
    assert.strictEqual(
      readProgress([...PASS, regated(8, PUSHED, MOVED, BASE)]).regateMoved,
      "both",
    );
  });

  it("says a conflict when a pass is on record and nothing moved, and nothing with no pass", () => {
    assert.strictEqual(
      readProgress([...PASS, regated(8, HEAD, BASE, BASE)]).regateMoved,
      "conflict",
    );
    assert.strictEqual(readProgress([launched(1), regated(2, HEAD, BASE, BASE)]).regateMoved, null);
  });

  it("says an earlier factory began it for an older line with the head unchanged", () => {
    // A base move or a conflict under the older rule: the line does not say which.
    assert.strictEqual(
      readProgress([...PASS, regatedBefore(8, HEAD, MOVED, BASE)]).regateMoved,
      "earlier",
    );
    assert.strictEqual(
      readProgress([...PASS, regatedBefore(8, HEAD, BASE, BASE)]).regateMoved,
      "earlier",
    );
    // A moved head is read from the shas, marker or not.
    assert.strictEqual(
      readProgress([...PASS, regatedBefore(8, PUSHED, MOVED, BASE)]).regateMoved,
      "both",
    );
    assert.strictEqual(
      readProgress([launched(1), regatedBefore(2, HEAD, BASE, BASE)]).regateMoved,
      null,
    );
  });

  it("keeps the newest line's answer when another line follows", () => {
    const seen = readProgress([
      ...PASS,
      regated(8, HEAD, MOVED, BASE),
      regated(9, PUSHED, BASE, BASE),
    ]);
    assert.strictEqual(seen.regateMoved, "head");
  });

  it("records a pass of the re-gate, and drops it with the posted results", () => {
    const again = [...PASS, regated(8, HEAD, MOVED, BASE), command(9), passed(10)];
    assert.strictEqual(readProgress(again).regatePassed, true);
    assert.strictEqual(readProgress(again).regating, true);
    const posted = readProgress([...again, step(11, "gate-results-posted")]);
    assert.strictEqual(posted.regating, false);
    assert.strictEqual(posted.regatePassed, false);
    // A pass that is not a re-gate's is not a regate pass.
    assert.strictEqual(readProgress([launched(1), command(2), passed(3)]).regatePassed, false);
  });

  it("a re-gate pass owes the ready state again unless its cause says it is clean", () => {
    const before = [...PASS, regated(8, HEAD, MOVED, BASE), command(9)];
    const clean = {
      ...passed(10),
      cause: { step: "gate", reason: "gate-passed-clean", attempt: 1 },
    };
    assert.strictEqual(readProgress([...before, clean]).regatePassReassert, false);
    // `gate-passed` is what a resumed call writes, and what every pass said before the clean
    // reason existed, when every resumed pass set the ready state again.
    assert.strictEqual(readProgress([...before, passed(10)]).regatePassReassert, true);
    assert.strictEqual(
      readProgress([...before, { ...passed(10), cause: null }]).regatePassReassert,
      true,
    );
  });

  it("records a failure of the re-gate as sent back, until the state changes", () => {
    const sent = [
      ...PASS,
      regated(8, HEAD, MOVED, BASE),
      line(9, "gate_sent_back", { attempt: 2, run_ordinal: 0 }),
    ];
    assert.strictEqual(readProgress(sent).regateSentBack, true);
    const back = readProgress([...sent, moved(10, "pr-open", "building")]);
    assert.strictEqual(back.regateSentBack, false);
    assert.strictEqual(back.regating, false);
    assert.strictEqual(
      readProgress([...PASS, line(8, "gate_sent_back", { attempt: 2, run_ordinal: 3 })])
        .regateSentBack,
      false,
    );
  });

  it("holds a relaunch from its decision until the state changes", () => {
    const seen = readProgress([...PASS, regated(8, HEAD, MOVED, BASE), relaunching(9)]);
    assert.deepStrictEqual(seen.relaunch, {
      fixes: { kind: "regate", attempt: 2 },
      branch: "t3code/abc",
      message: "boom",
    });
    assert.deepStrictEqual(seen.sending, { attempt: 2, runOrdinal: 0 });
    assert.strictEqual(seen.launchedSinceSending, false);
    assert.strictEqual(pendingRelaunch(seen), seen.relaunch);
    assert.strictEqual(
      readProgress([...PASS, relaunching(9), moved(10, "pr-open", "building")]).relaunch,
      null,
    );
  });

  it("is no longer pending once a session is launched after the decision", () => {
    const seen = readProgress([...PASS, relaunching(9), launched(10)]);
    assert.strictEqual(seen.launchedSinceSending, true);
    assert.strictEqual(pendingRelaunch(seen), null);
    assert.notStrictEqual(seen.relaunch, null);
    assert.strictEqual(pendingRelaunch(readProgress(PASS)), null);
  });

  it("forgets a launch when a later gate-sending step or relaunch decision comes", () => {
    const launchedAfter = [launched(1), step(2, "gate-sending 1 1"), launched(3)];
    assert.strictEqual(readProgress(launchedAfter).launchedSinceSending, true);
    assert.strictEqual(
      readProgress([...launchedAfter, step(4, "gate-sending 2 1")]).launchedSinceSending,
      false,
    );
    assert.strictEqual(
      readProgress([...launchedAfter, relaunching(4)]).launchedSinceSending,
      false,
    );
  });

  it("reads a feedback relaunch, which is no attempt and no gate-sending", () => {
    const seen = readProgress([
      ...PASS,
      line(8, "feedback_relaunching", {
        n: 3,
        branch: "t3code/abc",
        items: ["review:1"],
        message: "fix it",
      }),
    ]);
    assert.deepStrictEqual(seen.relaunch, {
      fixes: { kind: "feedback", n: 3 },
      branch: "t3code/abc",
      message: "fix it",
    });
    assert.strictEqual(seen.sending, null);
    assert.strictEqual(regateAttempt(seen.relaunch!), null);
    assert.strictEqual(
      relaunchCommandId(seen.relaunch!, RUN),
      "softfac:rawphp__softfac__10__1:feedback:3",
    );
  });

  it("names a re-gate relaunch's attempt and command id", () => {
    const seen = readProgress([...PASS, relaunching(8)]);
    assert.strictEqual(regateAttempt(seen.relaunch!), 2);
    assert.strictEqual(
      relaunchCommandId(seen.relaunch!, RUN),
      "softfac:rawphp__softfac__10__1:regate:2",
    );
  });

  describe("instructor feedback", () => {
    const deciding = (ms: number, n: number, items: ReadonlyArray<string>) =>
      line(ms, "feedback_relaunching", {
        n,
        branch: "t3code/abc",
        items,
        message: "Feedback 1 of 1",
      });

    it("is a relaunch that is pending until the session is recorded, then only the transition is left", () => {
      const decided = readProgress([...PASS, deciding(8, 1, ["review:11", "issue-comment:42"])]);
      assert.deepStrictEqual(pendingRelaunch(decided), {
        fixes: { kind: "feedback", n: 1 },
        branch: "t3code/abc",
        message: "Feedback 1 of 1",
      });
      assert.strictEqual(committingFeedback(decided), null);
      // The items are named for good, and the relaunch is counted.
      assert.deepStrictEqual([...decided.feedbackSent].sort(), ["issue-comment:42", "review:11"]);
      assert.strictEqual(decided.feedbackRelaunches, 1);
      assert.strictEqual(decided.feedbackLastItems, 2);

      const launchedSeen = readProgress([
        ...PASS,
        deciding(8, 1, ["review:11", "issue-comment:42"]),
        launched(9),
      ]);
      assert.strictEqual(pendingRelaunch(launchedSeen), null);
      assert.notStrictEqual(committingFeedback(launchedSeen), null);

      const committed = readProgress([
        ...PASS,
        deciding(8, 1, ["review:11", "issue-comment:42"]),
        launched(9),
        moved(10, "pr-open", "building"),
      ]);
      assert.strictEqual(pendingRelaunch(committed), null);
      assert.strictEqual(committingFeedback(committed), null);
      assert.strictEqual(committed.feedbackRelaunches, 1);
      assert.strictEqual(committed.feedbackSent.size, 2);
    });

    it("is not committing for a re-gate relaunch", () => {
      const seen = readProgress([...PASS, relaunching(8), launched(9)]);
      assert.strictEqual(committingFeedback(seen), null);
    });

    it("counts the highest relaunch and takes the item count of the newest", () => {
      const seen = readProgress([
        ...PASS,
        deciding(8, 1, ["review:1", "review:2"]),
        deciding(9, 2, ["review:3"]),
      ]);
      assert.strictEqual(seen.feedbackRelaunches, 2);
      assert.strictEqual(seen.feedbackLastItems, 1);
      assert.strictEqual(seen.feedbackSent.size, 3);
      assert.strictEqual(readProgress(PASS).feedbackRelaunches, 0);
      assert.strictEqual(readProgress(PASS).feedbackLastItems, 0);
    });

    it("names the items a forward sent into a paused session as sent too", () => {
      const seen = readProgress([
        ...PASS,
        line(8, "feedback_forwarding", {
          n: 1,
          run_ordinal: 2,
          items: ["issue-comment:7"],
          message: "m",
        }),
      ]);
      assert.deepStrictEqual([...seen.feedbackSent], ["issue-comment:7"]);
      assert.strictEqual(seen.feedbackRelaunches, 0);
    });

    it("is no gate attempt and no re-gate", () => {
      const before = readProgress(PASS);
      const seen = readProgress([
        ...PASS,
        deciding(8, 1, ["review:11"]),
        launched(9),
        moved(10, "pr-open", "building"),
      ]);
      assert.deepStrictEqual(seen.sending, before.sending);
      assert.deepStrictEqual(seen.sentBackAttempts, before.sentBackAttempts);
      assert.deepStrictEqual(seen.commandAttempts, before.commandAttempts);
      assert.strictEqual(nextGateAttempt(seen), nextGateAttempt(before));
      assert.strictEqual(seen.regating || seen.regatePassed || seen.regateSentBack, false);
    });

    it("closes a passed attempt, so the next gate is a new attempt", () => {
      const seen = readProgress(PASS);
      assert.strictEqual(seen.pass?.attempt, 1);
      assert.strictEqual(nextGateAttempt(seen), 2);
    });

    it("counts the retry budget from the last pass before the attempt", () => {
      const seen = readProgress(PASS);
      assert.strictEqual(attemptsSincePass(seen, 1), 1);
      assert.strictEqual(attemptsSincePass(seen, 2), 1);
      assert.strictEqual(attemptsSincePass(seen, 3), 2);
    });

    it("reads feedback from the pass the run reached pr-open on", () => {
      const seen = readProgress(PASS);
      assert.strictEqual(seen.pass?.atMs, 5);
      assert.strictEqual(seen.prOpenSince, 5);
      assert.strictEqual(readProgress([]).prOpenSince, null);
      // A pr-open with no pass on record is the line's own time.
      assert.strictEqual(readProgress([moved(40, "triage", "pr-open")]).prOpenSince, 40);
    });

    it("keeps the cursor through a re-gate on a moved base and through a trip via building", () => {
      const regated = [
        ...PASS,
        line(8, "gate_regate", { sha: HEAD, base_sha: MOVED, previous_base_sha: BASE }),
        command(9),
        passed(10),
        step(11, "gate-results-posted"),
      ];
      assert.strictEqual(readProgress(regated).prOpenSince, 5);
      const tripped = [
        ...regated,
        moved(12, "pr-open", "building"),
        moved(13, "building", "pr-open"),
      ];
      assert.strictEqual(readProgress(tripped).prOpenSince, 5);
    });

    it("resets the cursor on a feedback relaunch, and the next pr-open sets it again", () => {
      const decided = [...PASS, deciding(8, 1, ["review:11"])];
      assert.strictEqual(readProgress(decided).prOpenSince, null);
      const building = [...decided, launched(9), moved(10, "pr-open", "building")];
      assert.strictEqual(readProgress(building).prOpenSince, null);
      const back = [...building, moved(5_000, "building", "pr-open")];
      assert.strictEqual(readProgress(back).prOpenSince, 5_000);
      // Later trips through building and back (a failed re-gate) do not move it.
      const tripped = [
        ...back,
        moved(9_000, "pr-open", "building"),
        moved(12_000, "building", "pr-open"),
      ];
      assert.strictEqual(readProgress(tripped).prOpenSince, 5_000);
    });

    it("launches under a command id of what the relaunch fixes", () => {
      const regate = {
        fixes: { kind: "regate", attempt: 2 },
        branch: "t3code/abc",
        message: "boom",
      } as const;
      const feedback = { ...regate, fixes: { kind: "feedback", n: 3 } } as const;
      assert.strictEqual(relaunchCommandId(regate, RUN), "softfac:rawphp__softfac__10__1:regate:2");
      assert.strictEqual(
        relaunchCommandId(feedback, RUN),
        "softfac:rawphp__softfac__10__1:feedback:3",
      );
    });
  });
});

describe("movedSince: whether the head moved since the recorded pass", () => {
  const HEAD = "4f1c2d3e4a5b60718293a4b5c6d7e8f901234567";
  const PUSHED = "7e6d5c4b3a291807f6e5d4c3b2a190817263a4b5";
  const BASE = "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d";
  const MOVED = "9f8e7d6c5b4a39281706f5e4d3c2b1a098765432";

  it("is nothing without a pass on record, whatever the head and tip are", () => {
    assert.strictEqual(movedSince("", "", HEAD, BASE), null);
  });
  it("is nothing when only the tip differs, with or without a head on record", () => {
    assert.strictEqual(movedSince("", BASE, HEAD, MOVED), null);
    assert.strictEqual(movedSince(HEAD, BASE, HEAD, MOVED), null);
  });
  it("is the head when only the head differs and no base is on record", () => {
    assert.strictEqual(movedSince(HEAD, "", PUSHED, BASE), "head");
    assert.strictEqual(movedSince(HEAD, BASE, PUSHED, BASE), "head");
  });
  it("is both when both differ", () => {
    assert.strictEqual(movedSince(HEAD, BASE, PUSHED, MOVED), "both");
  });
  it("is nothing for a pass with a head and no base when the head did not move", () => {
    assert.strictEqual(movedSince(HEAD, "", HEAD, MOVED), null);
    assert.strictEqual(movedSince(HEAD, "", HEAD, BASE), null);
  });
  it("compares commit ids without regard to case", () => {
    assert.strictEqual(movedSince(HEAD, BASE, HEAD.toUpperCase(), BASE.toUpperCase()), null);
  });
});
