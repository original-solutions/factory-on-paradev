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

function scan(): { status: number | null; output: string } {
  const run = spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
  return { status: run.status, output: run.stdout + run.stderr };
}

test("passes when spike/fixtures does not exist", () => {
  expect(scan()).toEqual({ status: 0, output: "" });
});

test("passes a clean folder", () => {
  fixture("a.json", '{ "ok": true, "token": "short" }\n');
  fixture("nested/deep/b.txt", "Bearer short\nsk_live_\nnothing here\n");
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
