import { assert, describe, it } from "@effect/vitest";

import { LAST_ERROR, type AttentionItem } from "../attention.ts";
import { beltBytes, type BeltV1 } from "../belt.ts";
import type { RunSummary } from "../ledger/listRuns.ts";
import { BELT_MAX_BYTES, beltPayload, type BeltRun } from "./belt.ts";

const NOW = Date.UTC(2026, 10, 12, 9, 0, 0);

const RUNNER: BeltV1["runner"] = {
  host: "mac",
  version: "0.0.0",
  paradevCli: "2.0.8",
  claimsPaused: false,
  paradevOnline: true,
  lastPassAt: "2026-11-12T09:00:00.000Z",
};

const summary = (issue: number, over: Partial<RunSummary> = {}): RunSummary => ({
  id: { repo: "acme/widgets", issue: String(issue), attempt: 1 },
  startedTs: new Date(NOW - (1000 - issue) * 60_000).toISOString(),
  lastEvent: "step_changed",
  title: `feat: widget ${issue}`,
  reason: null,
  state: "building",
  step: "Make",
  prUrl: null,
  prEnd: null,
  finished: false,
  totalMs: null,
  unreadable: false,
  ...over,
});

const run = (issue: number, over: Partial<RunSummary> = {}, threadId: string | null = null): BeltRun => ({
  summary: summary(issue, over),
  threadId,
});

const finished = (issue: number): BeltRun =>
  run(issue, {
    state: "pr-open",
    step: null,
    finished: true,
    totalMs: 900_000,
    prUrl: `https://github.com/acme/widgets/pull/${issue}`,
    // Long titles, so 500 runs are well over the cap.
    title: `feat: ${"x".repeat(200)} ${issue}`,
  });

const payload = (runs: ReadonlyArray<BeltRun>, attention: ReadonlyArray<AttentionItem> = []) =>
  beltPayload({ nowMs: NOW, runner: RUNNER, runs, attention });

describe("beltPayload", () => {
  it("has the spec's fields for each run and nothing else", () => {
    const belt = payload([
      run(
        7,
        { state: "stuck", reason: "r".repeat(400), title: "t".repeat(130), step: "s".repeat(130) },
        "local:ws-7",
      ),
    ]);
    assert.strictEqual(belt.v, 1);
    assert.strictEqual(belt.updatedAt, new Date(NOW).toISOString());
    assert.deepStrictEqual(belt.runner, RUNNER);
    assert.deepStrictEqual(Object.keys(belt).sort(), ["attention", "counts", "runner", "runs", "updatedAt", "v"]);
    const [only] = belt.runs;
    assert.deepStrictEqual(Object.keys(only!).sort(), [
      "finished",
      "id",
      "issue",
      "prUrl",
      "reason",
      "repo",
      "startedTs",
      "state",
      "step",
      "title",
      "totalMs",
      "workspaceId",
    ]);
    assert.strictEqual(only!.id, "acme__widgets__7__1");
    assert.strictEqual(only!.repo, "acme/widgets");
    assert.strictEqual(only!.issue, 7);
    assert.strictEqual(only!.state, "stuck");
    assert.strictEqual(only!.workspaceId, "ws-7");
    assert.isAtMost(only!.title!.length, 120);
    assert.isAtMost(only!.step!.length, 120);
    assert.isAtMost(only!.reason!.length, 300);
    assert.isTrue(only!.title!.endsWith("…"));
  });

  it("cuts a long title without splitting a character", () => {
    const belt = payload([run(1, { title: "\u{1F600}".repeat(100) })]);
    const title = belt.runs[0]!.title!;
    assert.isAtMost(title.length, 120);
    assert.isTrue(title.endsWith("…"));
    assert.isFalse(/[\uD800-\uDBFF]…$/.test(title));
  });

  it("counts the unfinished runs by state, and the finished ones", () => {
    const belt = payload([
      run(1, { state: "triage" }),
      run(2, { state: "building" }),
      run(3, { state: "building" }),
      run(4, { state: "pr-open" }),
      run(5, { state: "needs-info" }),
      run(6, { state: "stuck" }),
      finished(7),
      finished(8),
    ]);
    assert.deepStrictEqual(belt.counts, {
      triage: 1,
      building: 2,
      prOpen: 1,
      needsInfo: 1,
      stuck: 1,
      finished7d: 2,
    });
  });

  it("carries the attention items as id, kind, text and since", () => {
    const belt = payload(
      [],
      [
        {
          id: "paradev-offline",
          kind: "attention",
          repo: null,
          issue: null,
          run: null,
          message: "Paradev is offline",
          firstSeenMs: NOW - 60_000,
        },
      ],
    );
    assert.deepStrictEqual(belt.attention, [
      {
        id: "paradev-offline",
        kind: "attention",
        text: "Paradev is offline",
        since: new Date(NOW - 60_000).toISOString(),
      },
    ]);
  });

  it("puts no log line or error text from an attention item on the belt", () => {
    const item = (id: string, kind: AttentionItem["kind"], message: string): AttentionItem => ({
      id,
      kind,
      repo: null,
      issue: null,
      run: null,
      message,
      firstSeenMs: NOW,
    });
    const belt = payload(
      [],
      [
        item("pass-errors", "pass-errors", "the pass has failed 3 times in a row, last: error: gh: secret-repo not found"),
        item("config", "config", "machine config not loaded: /Users/x/.config/factory-runner/config.yml: repos: is missing"),
        item(
          "config-not-loaded:a/b",
          "attention",
          `a/b: project config not loaded for 3 passes in a row, issues are not being picked up${LAST_ERROR}fatal: could not read Username`,
        ),
        item("long", "attention", "w".repeat(400)),
      ],
    );
    const text = JSON.stringify(belt.attention);
    for (const leak of ["error: gh", "secret-repo", "config.yml", "fatal:", "Username"]) {
      assert.notInclude(text, leak);
    }
    assert.include(belt.attention[0]!.text, "runner log");
    assert.include(belt.attention[1]!.text, "runner log");
    assert.strictEqual(
      belt.attention[2]!.text,
      "a/b: project config not loaded for 3 passes in a row, issues are not being picked up",
    );
    assert.isAtMost(belt.attention[3]!.text.length, 300);
  });

  it("keeps every run when the payload fits", () => {
    const runs = [run(1), finished(2), finished(3)];
    assert.strictEqual(payload(runs).runs.length, 3);
  });

  it("with 500 runs stays under 60 KiB by dropping finished runs oldest first", () => {
    // 20 unfinished runs among 480 finished ones, oldest first as the ledger lists them.
    const runs = Array.from({ length: 500 }, (_, i) => (i % 25 === 0 ? run(i + 1) : finished(i + 1)));
    const unfinished = runs.filter((entry) => !entry.summary.finished).length;
    const all = runs.length - unfinished;
    const belt = payload(runs);
    assert.isAtMost(beltBytes(belt), BELT_MAX_BYTES);
    assert.strictEqual(BELT_MAX_BYTES, 60 * 1024);
    // finished7d counts the full list, not what is left after the trim.
    assert.strictEqual(belt.counts.finished7d, all);
    assert.strictEqual(belt.runs.filter((entry) => !entry.finished).length, unfinished);
    const kept = belt.runs.filter((entry) => entry.finished).map((entry) => entry.issue);
    assert.isBelow(kept.length, all);
    assert.isAbove(kept.length, 0);
    // The ones kept are the newest finished runs.
    const newest = runs
      .filter((entry) => entry.summary.finished)
      .map((entry) => Number(entry.summary.id.issue))
      .slice(-kept.length);
    assert.deepStrictEqual(kept, newest);
    // One more finished run would not have fitted.
    const oneMore = runs
      .filter((entry) => entry.summary.finished)
      .map((entry) => Number(entry.summary.id.issue))
      .at(-kept.length - 1)!;
    const withOneMore: BeltV1 = {
      ...belt,
      runs: [...payload([finished(oneMore)]).runs, ...belt.runs],
    };
    assert.isAbove(beltBytes(withOneMore), BELT_MAX_BYTES);
  });

  it("holds no gate output or log text", () => {
    const runs = Array.from({ length: 500 }, (_, i) => (i % 25 === 0 ? run(i + 1) : finished(i + 1)));
    const text = JSON.stringify(payload(runs));
    for (const word of ["gate_output", "stdout", "stderr", "log", "output"]) {
      assert.notInclude(text, `"${word}"`);
    }
  });
});
