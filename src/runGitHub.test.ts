import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  FRESH_RUNS_PER_WINDOW,
  FRESH_WINDOW_MS,
  KEEP_MS,
  ledgerPullRequest,
  makeRunGitHubReader,
  TEXT_LIMIT,
} from "./runGitHub.ts";
import { GitHubFailed, type IssueDetail, type PullRequestSummary } from "./tracker/github.ts";

const ISSUE: IssueDetail = {
  number: 158,
  title: "the watch page shows who else is watching",
  body: "## Ask\nShow avatars.",
  labels: ["factory:building", "ui"],
  assignees: ["rawphp"],
  author: "tomkaczocha",
  state: "building",
  closed: false,
};

const PR: PullRequestSummary = {
  number: 160,
  title: "feat: watchers on the watch page",
  body: "Adds avatars.",
  state: "draft",
  additions: 120,
  deletions: 8,
  changedFiles: 2,
  reviewDecision: null,
  files: [{ path: "app/Watch.php", additions: 100, deletions: 8 }],
};

const signedOut = new GitHubFailed({
  args: ["issue", "view"],
  status: 4,
  stderr: "To get started with GitHub CLI, please run:  gh auth login",
});

const opened = (pr: number) => ({ event: "pr_opened", data: { pr, url: "u" } });
const RUN = "original-solutions__watchalong__158__1";

const reader = (reads: { issue?: () => Effect.Effect<IssueDetail, GitHubFailed> } = {}) => {
  const calls: Array<string> = [];
  const clock = { now: 0 };
  const read = makeRunGitHubReader({
    nowMs: () => clock.now,
    readsFor: (repo) => {
      calls.push(`reads ${repo}`);
      return {
        issue: (n) => {
          calls.push(`issue ${n}`);
          return reads.issue ? reads.issue() : Effect.succeed(ISSUE);
        },
        pullRequestSummary: (n) => {
          calls.push(`pr ${n}`);
          return Effect.succeed(PR);
        },
      };
    },
  });
  return { read, calls, clock };
};

it("ledgerPullRequest is the last pull request the run opened", () => {
  assert.strictEqual(ledgerPullRequest([]), null);
  assert.strictEqual(ledgerPullRequest([opened(46), { event: "finished", data: {} }]), 46);
  assert.strictEqual(ledgerPullRequest([opened(46), opened(52)]), 52);
  assert.strictEqual(ledgerPullRequest([{ event: "pr_opened", data: { pr: "46" } }]), null);
});

it.effect("reads the issue and pull request, without the factory's labels", () =>
  Effect.gen(function* () {
    const t = reader();
    const answer = yield* t.read({ id: RUN, entries: [opened(160)] });
    assert.deepStrictEqual(t.calls, ["reads original-solutions/watchalong", "issue 158", "pr 160"]);
    assert.deepStrictEqual(answer.issue, {
      kind: "ok",
      number: 158,
      title: ISSUE.title,
      body: ISSUE.body,
      body_cut: false,
      author: "tomkaczocha",
      labels: ["ui"],
      closed: false,
    });
    assert.strictEqual(answer.pr?.kind === "ok" && answer.pr.changed_files, 2);
  }),
);

it.effect("a run with no pull request reads only the issue", () =>
  Effect.gen(function* () {
    const t = reader();
    const answer = yield* t.read({ id: RUN, entries: [] });
    assert.strictEqual(answer.pr, null);
    assert.deepStrictEqual(t.calls, ["reads original-solutions/watchalong", "issue 158"]);
  }),
);

it.effect("keeps an answer for KEEP_MS, then asks GitHub again", () =>
  Effect.gen(function* () {
    const t = reader();
    yield* t.read({ id: RUN, entries: [] });
    t.clock.now = KEEP_MS - 1;
    yield* t.read({ id: RUN, entries: [] });
    assert.strictEqual(t.calls.filter((call) => call.startsWith("issue")).length, 1);
    t.clock.now = KEEP_MS;
    yield* t.read({ id: RUN, entries: [] });
    assert.strictEqual(t.calls.filter((call) => call.startsWith("issue")).length, 2);
  }),
);

it.effect("a signed-out gh is told apart from other failures", () =>
  Effect.gen(function* () {
    const t = reader({ issue: () => Effect.fail(signedOut) });
    const answer = yield* t.read({ id: RUN, entries: [] });
    assert.strictEqual(answer.issue?.kind, "signed-out");

    const other = reader({
      issue: () =>
        Effect.fail(new GitHubFailed({ args: [], status: 1, stderr: "HTTP 502: Bad Gateway\nx" })),
    });
    assert.deepStrictEqual((yield* other.read({ id: RUN, entries: [] })).issue, {
      kind: "failed",
      message: "HTTP 502: Bad Gateway",
    });
  }),
);

it.effect("a failed or signed-out answer is not kept, so Try again asks GitHub again", () =>
  Effect.gen(function* () {
    const t = reader({ issue: () => Effect.fail(signedOut) });
    yield* t.read({ id: RUN, entries: [] });
    yield* t.read({ id: RUN, entries: [] });
    assert.strictEqual(t.calls.filter((call) => call.startsWith("issue")).length, 2);
  }),
);

it.effect("past the fresh-read budget a run is refused without asking GitHub", () =>
  Effect.gen(function* () {
    const t = reader();
    const runAt = (n: number) => ({ id: `original-solutions__watchalong__${n}__1`, entries: [] });
    for (let n = 1; n <= FRESH_RUNS_PER_WINDOW; n += 1) yield* t.read(runAt(n));
    const asked = t.calls.filter((call) => call.startsWith("issue")).length;
    assert.strictEqual(asked, FRESH_RUNS_PER_WINDOW);

    const refused = yield* t.read(runAt(999));
    assert.strictEqual(refused.issue?.kind, "failed");
    assert.strictEqual(t.calls.filter((call) => call.startsWith("issue")).length, asked);
    assert.strictEqual((yield* t.read(runAt(1))).issue?.kind, "ok");

    t.clock.now = FRESH_WINDOW_MS;
    assert.strictEqual((yield* t.read(runAt(999))).issue?.kind, "ok");
  }),
);

it.effect("cuts a long issue text and says so", () =>
  Effect.gen(function* () {
    const t = reader({
      issue: () => Effect.succeed({ ...ISSUE, body: "x".repeat(TEXT_LIMIT + 5) }),
    });
    const answer = yield* t.read({ id: RUN, entries: [] });
    assert.strictEqual(answer.issue?.kind === "ok" && answer.issue.body.length, TEXT_LIMIT);
    assert.strictEqual(answer.issue?.kind === "ok" && answer.issue.body_cut, true);
  }),
);

it.effect("a Linear issue is not read from GitHub, and no config reads nothing", () =>
  Effect.gen(function* () {
    const t = reader();
    const linear = yield* t.read({ id: "acme__app__eng-42__1", entries: [] });
    assert.strictEqual(linear.issue, null);
    assert.ok(!t.calls.some((call) => call.startsWith("issue")));

    const none = makeRunGitHubReader({ nowMs: () => 0, readsFor: () => null });
    const answer = yield* none({ id: RUN, entries: [opened(3)] });
    assert.strictEqual(answer.issue?.kind, "failed");
    assert.strictEqual(answer.pr?.kind, "failed");
  }),
);
