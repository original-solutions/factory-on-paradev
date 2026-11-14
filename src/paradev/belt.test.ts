import { assert, describe, it } from "@effect/vitest";

import type { AttentionItem } from "../attention.ts";
import { beltBytes, type BeltV2 } from "../belt.ts";
import type { RunSummary } from "../ledger/listRuns.ts";
import { BELT_MAX_BYTES, beltPayload, type BeltRun } from "./belt.ts";

const NOW = Date.UTC(2026, 10, 12, 9, 0, 0);

const RUNNER: BeltV2["runner"] = {
  host: "mac",
  version: "0.0.0",
  paradevCli: "2.0.8",
  claimsPaused: false,
  paradevOnline: true,
  lastPassAt: "2026-11-12T09:00:00.000Z",
  targets: [
    {
      kind: "local",
      name: "local",
      online: true,
      load: { oneMinute: 2.5, cores: 10 },
      slots: { used: 1, max: 1 },
      ready: true,
      reason: "slots full: 1 of 1 running",
    },
    {
      kind: "host",
      name: "trilogy-mac",
      online: true,
      load: { oneMinute: 1, cores: 8 },
      slots: { used: 0, max: 2 },
      ready: true,
      reason: null,
    },
    {
      kind: "cloud",
      name: "cloud",
      online: true,
      load: null,
      slots: { used: 0, max: 1 },
      ready: false,
      reason: "the proxy check failed: down",
    },
  ],
};

const HOST_NAMES = new Map([["h1", "trilogy-mac"]]);

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
  beltPayload({ nowMs: NOW, runner: RUNNER, runs, attention, hostNames: HOST_NAMES });

describe("beltPayload", () => {
  it("has the spec's fields for each run and nothing else", () => {
    const belt = payload([
      run(
        7,
        { state: "stuck", reason: "r".repeat(400), title: "t".repeat(130), step: "s".repeat(130) },
        "local:ws-7",
      ),
    ]);
    assert.strictEqual(belt.v, 2);
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
      "target",
      "title",
      "totalMs",
      "workspaceId",
    ]);
    assert.strictEqual(only!.id, "acme__widgets__7__1");
    assert.strictEqual(only!.repo, "acme/widgets");
    assert.strictEqual(only!.issue, 7);
    assert.strictEqual(only!.state, "stuck");
    assert.strictEqual(only!.workspaceId, "ws-7");
    assert.strictEqual(only!.target, "local");
    assert.isAtMost(only!.title!.length, 120);
    assert.isAtMost(only!.step!.length, 120);
    assert.isAtMost(only!.reason!.length, 300);
    assert.isTrue(only!.title!.endsWith("…"));
  });

  it("carries the runner's target rows, and says where each run is and which workspace it has", () => {
    const belt = payload([
      run(1, {}, "local:ws-1"),
      run(2, {}, "host:h1:ws-2"),
      run(3, {}, "cloud:ws-3"),
      run(4, {}, "host:gone:ws-4"),
      run(5),
    ]);
    assert.deepStrictEqual(belt.runner.targets.slice(0, 2), RUNNER.targets.slice(0, 2));
    assert.deepStrictEqual(
      belt.runs.map((entry) => [entry.target, entry.workspaceId]),
      [
        ["local", "ws-1"],
        ["trilogy-mac", "ws-2"],
        ["cloud", "ws-3"],
        // A host the config no longer lists shows by its id.
        ["gone", "ws-4"],
        [null, null],
      ],
    );
  });

  it("says only which check failed for a target that is not ready: its line can quote paths, users and addresses", () => {
    const row = (kind: "local" | "host" | "cloud", reason: string) => ({
      kind,
      name: kind,
      online: true,
      load: null,
      slots: { used: 0, max: 1 },
      ready: false,
      reason,
    });
    const belt = beltPayload({
      nowMs: NOW,
      runner: {
        ...RUNNER,
        targets: [
          row("local", "this Mac holds claims: low disk"),
          row("host", "not ready: clone /Users/tomk/app: clone it on the host: git clone https://github.com/acme/app /Users/tomk/app"),
          row("cloud", "the proxy check failed: getaddrinfo ENOTFOUND trilogy-mac.tail459612.ts.net"),
        ],
      },
      runs: [],
      attention: [],
      hostNames: HOST_NAMES,
    });
    assert.deepStrictEqual(
      belt.runner.targets.map((target) => target.reason),
      [
        "this Mac's load or disk check holds claims; factory-runner status says why",
        "its hosts check failed; factory-runner status says why",
        "its proxy check did not pass; factory-runner status says why",
      ],
    );
    const text = JSON.stringify(belt.runner.targets);
    for (const leak of ["/Users/", "git clone", "ENOTFOUND", "ts.net"]) assert.notInclude(text, leak);
  });

  it("keeps the reason of a target that is ready: placement's own words, with no outside text", () => {
    const belt = payload([]);
    assert.deepStrictEqual(
      belt.runner.targets.map((target) => target.reason),
      ["slots full: 1 of 1 running", null, "its proxy check did not pass; factory-runner status says why"],
    );
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
        text: "The runner needs a person; the runner log says why.",
        since: new Date(NOW - 60_000).toISOString(),
      },
    ]);
  });

  it("puts no part of an attention item's message on the belt, only a line for its kind", () => {
    const item = (
      id: string,
      kind: AttentionItem["kind"],
      message: string,
      repo: string | null = null,
      issue: number | null = null,
    ): AttentionItem => ({ id, kind, repo, issue, run: null, message, firstSeenMs: NOW });
    const belt = payload(
      [],
      [
        item("pass-errors", "pass-errors", "the pass has failed 3 times in a row, last: error: gh: secret-repo not found"),
        item("config", "config", "machine config not loaded: /Users/x/.config/factory-runner/config.yml: repos: is missing"),
        item(
          "config-not-loaded:a/b",
          "attention",
          "a/b: project config not loaded for 3 passes in a row; last error: fatal: could not read Username",
          "a/b",
        ),
        item(
          "paradev-project-repo:a/b",
          "attention",
          "a/b: its clone /Users/alice/src/b is the Paradev project of c/d; point its path at a clone of a/b",
          "a/b",
        ),
        item("paradev-offline", "attention", "the Paradev CLI check failed: superset at /Users/alice/bin/superset: EACCES"),
        item("run:a__b__7__1:stuck", "stuck", "a/b#7 stuck, the reason is in the ledger of run a__b__7__1", "a/b", 7),
        item("run:a__b__8__1:needs-info", "needs-info", "a/b#8 asked: is /Users/alice/.ssh/id_rsa the key?", "a/b", 8),
      ],
    );
    assert.deepStrictEqual(
      belt.attention.map((entry) => entry.text),
      [
        "The last passes failed; the runner log says why.",
        "The machine config did not load; the runner log says why.",
        "a/b needs a person; the runner log says why.",
        "a/b needs a person; the runner log says why.",
        "The runner needs a person; the runner log says why.",
        "a/b#7 is stuck.",
        "a/b#8 needs information from a person.",
      ],
    );
    const text = JSON.stringify(belt.attention);
    for (const leak of ["error: gh", "secret-repo", "config.yml", "fatal:", "Username", "/Users/", "EACCES", "id_rsa"]) {
      assert.notInclude(text, leak);
    }
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
    const withOneMore: BeltV2 = {
      ...belt,
      runs: [...payload([finished(oneMore)]).runs, ...belt.runs],
    };
    assert.isAbove(beltBytes(withOneMore), BELT_MAX_BYTES);
  });

  it("with target rows and a target on every run, still drops only finished runs, oldest first", () => {
    const runs = Array.from({ length: 500 }, (_, i) =>
      i % 25 === 0 ? run(i + 1, {}, `host:h1:ws-${i}`) : { ...finished(i + 1), threadId: `cloud:ws-${i}` },
    );
    const belt = payload(runs);
    assert.isAtMost(beltBytes(belt), BELT_MAX_BYTES);
    assert.strictEqual(belt.runner.targets.length, 3);
    const open = belt.runs.filter((entry) => !entry.finished);
    assert.strictEqual(open.length, 20);
    assert.isTrue(open.every((entry) => entry.target === "trilogy-mac"));
    const kept = belt.runs.filter((entry) => entry.finished).map((entry) => entry.issue);
    assert.isAbove(kept.length, 0);
    const newest = runs
      .filter((entry) => entry.summary.finished)
      .map((entry) => Number(entry.summary.id.issue))
      .slice(-kept.length);
    assert.deepStrictEqual(kept, newest);
  });

  it("cuts a belt that is only a little over 60 KiB", () => {
    const runs = Array.from({ length: 200 }, (_, i) => (i % 25 === 0 ? run(i + 1) : finished(i + 1)));
    const whole: BeltV2 = { ...payload([]), runs: runs.map((entry) => payload([entry]).runs[0]!) };
    // Between the cap and twice it.
    assert.isAbove(beltBytes(whole), BELT_MAX_BYTES);
    assert.isBelow(beltBytes(whole), 2 * BELT_MAX_BYTES);
    const belt = payload(runs);
    assert.isAtMost(beltBytes(belt), BELT_MAX_BYTES);
    assert.isBelow(belt.runs.length, runs.length);
  });

  it("holds no gate output or log text", () => {
    const runs = Array.from({ length: 500 }, (_, i) => (i % 25 === 0 ? run(i + 1) : finished(i + 1)));
    const text = JSON.stringify(payload(runs));
    for (const word of ["gate_output", "stdout", "stderr", "log", "output"]) {
      assert.notInclude(text, `"${word}"`);
    }
  });
});
