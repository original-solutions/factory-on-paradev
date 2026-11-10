import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { beltBytes, type BeltV1 } from "../src/belt.ts";

const probeDir = fileURLToPath(new URL("../spike/belt-probe/", import.meta.url));
const script = `${probeDir}make-samples.ts`;
const names = { belt: "belt.json", oversize: "belt-oversize.json" };
const committed = {
  belt: `${probeDir}${names.belt}`,
  oversize: `${probeDir}${names.oversize}`,
};
const KiB = 1024;

// The generator writes into a temp dir, so a test run never rewrites the
// committed samples and a stale sample fails every run, not just the first.
let outDir = "";
const generated = { belt: "", oversize: "" };

beforeAll(() => {
  outDir = mkdtempSync(join(tmpdir(), "belt-samples-"));
  execFileSync(process.execPath, [script, outDir], { stdio: "pipe" });
  generated.belt = join(outDir, names.belt);
  generated.oversize = join(outDir, names.oversize);
});

afterAll(() => {
  if (outDir) rmSync(outDir, { recursive: true, force: true });
});

function readBelt(path: string): BeltV1 {
  return JSON.parse(readFileSync(path, "utf8")) as BeltV1;
}

const states = new Set([
  "proposed", "ready", "triage", "needs-info", "building", "pr-open", "stuck", null,
]);

function expectValidBelt(belt: BeltV1): void {
  expect(belt.v).toBe(1);
  expect(Number.isNaN(Date.parse(belt.updatedAt))).toBe(false);
  expect(typeof belt.runner.host).toBe("string");
  expect(typeof belt.runner.claimsPaused).toBe("boolean");
  expect(typeof belt.runner.paradevOnline).toBe("boolean");
  for (const key of ["triage", "building", "prOpen", "needsInfo", "stuck", "finished7d"] as const) {
    expect(Number.isInteger(belt.counts[key])).toBe(true);
  }
  expect(belt.runs.length).toBeGreaterThan(0);
  for (const run of belt.runs) {
    expect(typeof run.id).toBe("string");
    expect(run.repo).toMatch(/^[\w.-]+\/[\w.-]+$/);
    expect(Number.isInteger(run.issue)).toBe(true);
    expect(states.has(run.state)).toBe(true);
    expect((run.title ?? "").length).toBeLessThanOrEqual(120);
    expect((run.step ?? "").length).toBeLessThanOrEqual(120);
    expect((run.reason ?? "").length).toBeLessThanOrEqual(300);
    expect(typeof run.finished).toBe("boolean");
  }
  for (const item of belt.attention) {
    expect(typeof item.id).toBe("string");
    expect(typeof item.text).toBe("string");
  }
}

describe("beltBytes", () => {
  test("is the UTF-8 byte length of the JSON", () => {
    const belt = readBelt(committed.belt);
    expect(beltBytes(belt)).toBe(Buffer.byteLength(JSON.stringify(belt), "utf8"));
  });

  test("counts multi-byte characters as bytes, not code units", () => {
    const base = readBelt(committed.belt);
    const ascii = { ...base, runner: { ...base.runner, host: "aa" } };
    const accented = { ...base, runner: { ...base.runner, host: "éé" } };
    // "é" is one UTF-16 unit but two UTF-8 bytes.
    expect(beltBytes(accented) - beltBytes(ascii)).toBe(2);
  });
});

describe("make-samples", () => {
  test("writes a belt between 38 and 42 KiB and an oversize belt between 68 and 72 KiB", () => {
    const size = statSync(generated.belt).size;
    const oversize = statSync(generated.oversize).size;
    expect(size).toBeGreaterThanOrEqual(38 * KiB);
    expect(size).toBeLessThanOrEqual(42 * KiB);
    expect(oversize).toBeGreaterThanOrEqual(68 * KiB);
    expect(oversize).toBeLessThanOrEqual(72 * KiB);
    // The oversize sample must cross Paradev's 64 KiB value limit as stored.
    expect(beltBytes(readBelt(generated.oversize))).toBeGreaterThan(64 * KiB);
  });

  test("writes valid BeltV1 payloads", () => {
    expectValidBelt(readBelt(generated.belt));
    expectValidBelt(readBelt(generated.oversize));
  });

  test("counts summarise the runs in the same payload", () => {
    for (const path of [generated.belt, generated.oversize]) {
      const { counts, runs } = readBelt(path);
      const tally = (state: BeltV1["runs"][number]["state"]) =>
        runs.filter((r) => r.state === state).length;
      expect(counts).toEqual({
        triage: tally("triage"),
        building: tally("building"),
        prOpen: tally("pr-open"),
        needsInfo: tally("needs-info"),
        stuck: tally("stuck"),
        finished7d: runs.filter((r) => r.finished).length,
      });
    }
  });

  test("attention items point at runs in the same payload", () => {
    for (const path of [generated.belt, generated.oversize]) {
      const belt = readBelt(path);
      for (const item of belt.attention) {
        const ref = /^([\w.-]+\/[\w.-]+)#(\d+) /.exec(item.text);
        expect(ref).not.toBeNull();
        const run = belt.runs.find((r) => r.repo === ref![1] && r.issue === Number(ref![2]));
        expect(run, item.text).toBeDefined();
        expect(item.kind).toBe(run!.state);
        if (run!.step) expect(item.text).toContain(run!.step);
      }
    }
  });

  test("a rerun writes the committed files byte for byte", () => {
    expect(readFileSync(generated.belt).equals(readFileSync(committed.belt))).toBe(true);
    expect(readFileSync(generated.oversize).equals(readFileSync(committed.oversize))).toBe(true);
  });
});

describe("belt probe page", () => {
  const html = readFileSync(`${probeDir}index.html`, "utf8");

  test("points no src, href or fetch at http: or https:", () => {
    expect(html).not.toMatch(/\b(?:src|href)\s*=\s*["']?\s*https?:/i);
    expect(html).not.toMatch(/\bfetch\s*\(\s*["'`]\s*https?:/i);
    expect(html).not.toMatch(/https?:/i);
    // Protocol-relative URLs reach outside too.
    expect(html).not.toMatch(/\b(?:src|href)\s*=\s*["']?\s*\/\//i);
    expect(html).not.toMatch(/\bfetch\s*\(\s*["'`]\s*\/\//i);
  });

  test("loads no external script or stylesheet", () => {
    expect(html).not.toMatch(/<script[^>]*\ssrc\s*=/i);
    expect(html).not.toMatch(/<link\b/i);
  });
});
