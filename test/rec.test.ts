import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, test } from "vitest";

const rec = fileURLToPath(new URL("../spike/rec.ts", import.meta.url));
const fake = fileURLToPath(new URL("./fixtures/fake-superset.mjs", import.meta.url));

let fix: string;

beforeEach(() => {
  fix = mkdtempSync(join(tmpdir(), "rec-test-"));
});

afterEach(() => {
  rmSync(fix, { recursive: true, force: true });
});

function run(args: string[], fakeEnv: Record<string, string> = {}, fixtureDir = fix) {
  return spawnSync(process.execPath, [rec, ...args], {
    encoding: "utf8",
    env: { ...process.env, SUPERSET: fake, FIX: fixtureDir, ...fakeEnv },
  });
}

function meta(name: string, dir = fix) {
  return JSON.parse(readFileSync(join(dir, `${name}.meta.json`), "utf8"));
}

test("success saves stdout and a meta sidecar, appending --json", () => {
  const before = Date.now();
  const out = '{"agents":[]}\n';
  const r = run(["agents-read-local", "agents", "read"], { FAKE_STDOUT: out, FAKE_DELAY_MS: "50" });

  expect(r.status).toBe(0);
  expect(r.stdout).toBe("rec agents-read-local exit=0\n");
  expect(readFileSync(join(fix, "agents-read-local.json"), "utf8")).toBe(out);

  const raw = readFileSync(join(fix, "agents-read-local.meta.json"), "utf8");
  const m = JSON.parse(raw);
  expect(raw).toContain('\n  "argv": [');
  expect(Object.keys(m)).toEqual(["argv", "exit", "startedAt", "durationMs", "stderr"]);
  expect(m.argv).toEqual(["agents", "read", "--json"]);
  expect(m.exit).toBe(0);
  expect(m.startedAt).toBeGreaterThanOrEqual(before);
  expect(Number.isInteger(m.durationMs)).toBe(true);
  expect(m.durationMs).toBeGreaterThanOrEqual(50);
  expect(m.stderr).toBe('argv=["agents","read","--json"]\n');
});

test("failure keeps exit code and stderr, writes no stdout fixture", () => {
  const r = run(["agents-read-missing", "agents", "read", "nope"], {
    FAKE_STDERR: "error: no such agent\n",
    FAKE_EXIT: "1",
  });

  expect(r.status).toBe(1);
  expect(r.stdout).toBe("rec agents-read-missing exit=1\n");
  expect(existsSync(join(fix, "agents-read-missing.json"))).toBe(false);
  const m = meta("agents-read-missing");
  expect(m.exit).toBe(1);
  expect(m.stderr).toBe('argv=["agents","read","nope","--json"]\nerror: no such agent\n');
});

test("empty stdout removes an older fixture of that name", () => {
  writeFileSync(join(fix, "agents-list-empty.json"), '{"old":true}\n');

  const r = run(["agents-list-empty", "agents", "list"]);

  expect(r.status).toBe(0);
  expect(existsSync(join(fix, "agents-list-empty.json"))).toBe(false);
  expect(meta("agents-list-empty").exit).toBe(0);
});

test("--json is not doubled when already given", () => {
  run(["agents-read-local", "agents", "--json", "read"], { FAKE_STDOUT: "{}" });

  expect(meta("agents-read-local").argv).toEqual(["agents", "--json", "read"]);
});

test("creates the fixture folder when missing", () => {
  const nested = join(fix, "a", "b");
  const r = run(["hosts-list", "hosts", "list"], { FAKE_STDOUT: "[]" }, nested);

  expect(r.status).toBe(0);
  expect(readFileSync(join(nested, "hosts-list.json"), "utf8")).toBe("[]");
});

test.each(["../escape", "a/b", "a\\b", "a..b", "Upper", "-lead", ""])(
  "rejects name %j with exit 2 and runs nothing",
  (name) => {
    const marker = join(fix, "ran");
    const r = run([name, "agents", "list"], { FAKE_STDOUT: "{}", FAKE_MARKER: marker });

    expect(r.status).toBe(2);
    expect(r.stderr).not.toBe("");
    expect(r.stdout).toBe("");
    expect(existsSync(marker)).toBe(false);
    expect(readdirSync(fix)).toEqual([]);
  },
);

test("record() is exported and returns the CLI's exit code", async () => {
  const { record } = await import("../spike/rec.ts");
  const prev = { ...process.env };
  process.env.FAKE_EXIT = "3";
  try {
    const code = await record("direct-call", ["x"], { binary: fake, fixtureDir: fix });
    expect(code).toBe(3);
    expect(meta("direct-call").argv).toEqual(["x", "--json"]);
  } finally {
    process.env = prev;
  }
});
