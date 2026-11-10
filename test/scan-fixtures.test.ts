import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";

const script = resolve(import.meta.dirname, "../spike/scan-fixtures.ts");

// Built at run time so this file holds no literal secret for GitHub's scanner.
const samples: [label: string, pattern: string, secret: string][] = [
  ["Stripe live key", "Stripe key", "sk_" + "live_" + "a1".repeat(12)],
  ["Stripe test key", "Stripe key", "sk_" + "test_" + "b2".repeat(12)],
  ["Anthropic key", "Anthropic key", "sk-" + "ant-" + "api03-" + "c3".repeat(20)],
  ["ghp_ token", "GitHub token", "gh" + "p_" + "x".repeat(36)],
  ["gho_ token", "GitHub token", "gh" + "o_" + "x".repeat(36)],
  ["ghu_ token", "GitHub token", "gh" + "u_" + "x".repeat(36)],
  ["ghs_ token", "GitHub token", "gh" + "s_" + "x".repeat(36)],
  ["ghr_ token", "GitHub token", "gh" + "r_" + "x".repeat(36)],
  ["github_pat_ token", "GitHub token", "github" + "_pat_" + "y".repeat(40)],
  ["Slack token", "Slack token", "xo" + "xb-" + "1234567890-" + "z".repeat(24)],
  ["Bearer token", "Bearer token", "Bear" + "er " + "t".repeat(20)],
  ["JWT", "JWT", "ey" + "J" + "a".repeat(20) + "." + "b".repeat(20) + "." + "c".repeat(20)],
  ["personal email", "email address", "jane.doe" + "@" + "gmail.com"],
];
const secret = (label: string): string => samples.find(([l]) => l === label)![2];

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "scan-fixtures-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function fixture(path: string, content: string): void {
  const file = join(root, "spike/fixtures", path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

// Keeps git inside the temp folder and clear of this machine's git config.
function env(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_CEILING_DIRECTORIES: dirname(root),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    XDG_CONFIG_HOME: root,
  };
}

function git(...args: string[]): void {
  const run = spawnSync("git", args, { cwd: root, encoding: "utf8", env: env() });
  expect(run.status, run.stderr).toBe(0);
}

function scan(): { status: number | null; output: string } {
  const run = spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8", env: env() });
  return { status: run.status, output: run.stdout + run.stderr };
}

test("passes when spike/fixtures does not exist", () => {
  expect(scan()).toEqual({ status: 0, output: "" });
});

test("passes a clean folder", () => {
  fixture("a.json", '{ "ok": true, "token": "short" }\n');
  fixture("nested/deep/b.txt", "Bear" + "er short\n" + "Bear" + "er " + "t".repeat(19) + "\nsk_live_\nnothing here\n");
  fixture("keys.json", '{ "laughs_count": 3, "graphs_total": 2, "sighs_per_minute": 1 }\n');
  expect(scan()).toEqual({ status: 0, output: "" });
});

test("passes the allowed email domains", () => {
  fixture("emails.txt", ["dev" + "@example.com", "123+dev" + "@users.noreply.github.com"].join("\n"));
  expect(scan()).toEqual({ status: 0, output: "" });
});

test.each(samples)("catches a %s without printing it", (_label, pattern, secret) => {
  fixture("nested/sample.json", `{\n  "value": "${secret}"\n}\n`);
  expect(scan()).toEqual({ status: 1, output: `spike/fixtures/nested/sample.json:2: ${pattern}\n` });
});

// Recorded responses glue tokens to word characters: a JSON "\n" escape, a
// URL-encoded "%3D", a snake_case prefix.
test.each(
  samples.flatMap(([label, pattern, secret]) =>
    ["\\n", "%3D", "key_"].map((before) => [label, before, pattern, secret]),
  ),
)("catches a %s right after %s", (_label, before, pattern, secret) => {
  fixture("glued.json", `{ "body": "line${before}${secret}" }\n`);
  expect(scan()).toEqual({ status: 1, output: `spike/fixtures/glued.json:1: ${pattern}\n` });
});

test.each([
  ["lowercase", "authorization: " + "bear" + "er " + "t".repeat(20)],
  ["JSON-escaped slash", '"Bear' + 'er abc\\/' + "t".repeat(20) + '"'],
])("catches a %s Bearer token", (_label, line) => {
  fixture("header.txt", line + "\n");
  expect(scan()).toEqual({ status: 1, output: "spike/fixtures/header.txt:1: Bearer token\n" });
});

test("flags lookalikes of the allowed email domains", () => {
  fixture("lookalike.txt", "dev" + "@example.community\n" + "dev" + "@example.com.evil.io\n");
  expect(scan()).toEqual({
    status: 1,
    output: "spike/fixtures/lookalike.txt:1: email address\nspike/fixtures/lookalike.txt:2: email address\n",
  });
});

test("reports each match by path, line and pattern name", () => {
  fixture("a.txt", "clean\n" + secret("ghp_ token") + "\n");
  fixture("b/c.txt", secret("personal email") + " " + secret("JWT") + "\n");
  const { status, output } = scan();
  expect(status).toBe(1);
  expect(output.trim().split("\n")).toEqual([
    "spike/fixtures/a.txt:2: GitHub token",
    "spike/fixtures/b/c.txt:1: JWT",
    "spike/fixtures/b/c.txt:1: email address",
  ]);
  for (const [, , value] of samples) expect(output).not.toContain(value);
});

test("flags a personal email next to an allowed one", () => {
  fixture("mixed.txt", "dev" + "@example.com, " + secret("personal email") + "\n");
  expect(scan()).toEqual({ status: 1, output: "spike/fixtures/mixed.txt:1: email address\n" });
});

// Recorded URLs and JSON encode separators: "%40" or "\u0040" for "@",
// "%20" or "+" for the space after Bearer.
test.each([
  ["URL-encoded @", "email address", "jane.doe" + "%40" + "gmail.com"],
  ["JSON-escaped @", "email address", "jane.doe" + "\\u0040" + "gmail.com"],
  ["URL-encoded space after Bearer", "Bearer token", "Bear" + "er%20" + "t".repeat(20)],
  ["plus after Bearer", "Bearer token", "Bear" + "er+" + "t".repeat(20)],
  ["JSON-escaped space after Bearer", "Bearer token", "Bear" + "er\\u0020" + "t".repeat(20)],
  ["URL-encoded dot after an allowed domain", "email address", "dev" + "@example.com" + "%2E" + "evil.io"],
])("catches a %s", (_label, pattern, line) => {
  fixture("encoded.txt", line + "\n");
  expect(scan()).toEqual({ status: 1, output: `spike/fixtures/encoded.txt:1: ${pattern}\n` });
});

test("passes the allowed email domains behind an encoded @", () => {
  fixture("emails.txt", ["dev" + "%40" + "example.com", "123+dev" + "\\u0040" + "users.noreply.github.com"].join("\n"));
  expect(scan()).toEqual({ status: 0, output: "" });
});

// The repo's .gitignore keeps spike/fixtures/**/secrets* out of git.
test("skips fixtures git ignores but scans ones forced into the index", () => {
  git("init", "-q");
  writeFileSync(join(root, ".gitignore"), "spike/fixtures/**/secrets*\n");
  fixture("2.0.7/secrets.json", secret("ghp_ token") + "\n");
  fixture("secrets/token.txt", secret("JWT") + "\n");
  fixture("2.0.7/forced/secrets.json", secret("personal email") + "\n");
  fixture("2.0.7/answer.json", secret("ghp_ token") + "\n");
  git("add", "-f", "spike/fixtures/2.0.7/forced/secrets.json");
  expect(scan()).toEqual({
    status: 1,
    output: "spike/fixtures/2.0.7/answer.json:1: GitHub token\nspike/fixtures/2.0.7/forced/secrets.json:1: email address\n",
  });
});

test("scans every fixture outside a git repo", () => {
  writeFileSync(join(root, ".gitignore"), "spike/fixtures/**/secrets*\n");
  fixture("secrets.json", secret("ghp_ token") + "\n");
  expect(scan()).toEqual({ status: 1, output: "spike/fixtures/secrets.json:1: GitHub token\n" });
});
