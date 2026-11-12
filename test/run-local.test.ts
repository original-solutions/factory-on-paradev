import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { FIXTURES, lastResultLine } from "../spike/run-local.ts";

// Each run spawns the fake binary once per call, about 17 node processes, so a
// loaded machine takes far longer than the ~3 s a quiet one does: these tests use
// the suite's own timeout from vitest.config.ts, not a tighter one of their own.

const driver = fileURLToPath(new URL("../spike/run-local.ts", import.meta.url));
const fake = fileURLToPath(new URL("./fixtures/fake-superset.mjs", import.meta.url));

const prompt1 = "/factory acme/spike#1\n\nThe factory launched this session unattended.";
const gateText = "The factory gate failed. Fix the cause.\n\nCommand: npm test\n| not ok 3 - multiply\n| # fail 1";
const done = "FACTORY-DONE: https://github.com/acme/spike/pull/7";

let root: string;
let work: string;
let clone: string;
let fix: string;
let log: string;

type Answer = { stdout?: unknown; stderr?: string; exit?: number };
type Script = Record<string, Answer | Answer[]>;

function happyScript(): Script {
  const created = (sessionId: string, alreadyExists: boolean) => ({
    stdout: {
      workspace: { id: "ws-1", branch: "fac/1-1" },
      terminals: [{ terminalId: sessionId, label: "claude" }],
      agents: [{ ok: true, kind: "terminal", sessionId, label: "claude" }],
      alreadyExists,
    },
  });
  const explain = (state: string, lastEventType: string) => ({
    stdout: { terminalId: "term-1", state, agentId: "claude", headline: "", because: "", details: [], lastEventType, lastEventAt: 1 },
  });
  const firstTurn = `User: ${prompt1}\n\nAssistant: Built it.\n\nAll green.\n${done}`;
  return {
    schema: { stdout: { version: "2.0.7", commands: [] } },
    "projects list": { stdout: [{ id: "proj-other", path: "/elsewhere" }, { id: "proj-1", path: clone }] },
    "workspaces create": [created("term-1", false), created("term-2", true)],
    "workspaces get": { stdout: { id: "ws-1", worktreePath: "/wt/fac-1-1", worktreeExists: true } },
    "agents explain": [
      explain("working", "Start"),
      explain("working", "PreToolUse"),
      explain("idle", "Stop"),
      explain("idle", "Stop"),
    ],
    "agents wait": { stdout: { terminalId: "term-1", state: "idle", lastEventType: "Stop" } },
    "agents read": [
      { stdout: { text: firstTurn, harness: "claude" } },
      { stdout: { text: `${firstTurn}\n\nUser: ${gateText}\n\nAssistant: Nothing to fix.\n${done}`, harness: "claude" } },
    ],
    "terminals send": { stdout: { terminalId: "term-1", submitted: true, state: "idle" } },
    "terminals close": { stdout: { ok: true } },
    "workspaces list": { stdout: [] },
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "run-local-test-"));
  work = join(root, "work");
  clone = join(root, "clone");
  fix = join(root, "fix");
  log = join(root, "argv.log");
  mkdirSync(work);
  mkdirSync(join(clone, "prompts"), { recursive: true });
  writeFileSync(join(clone, "prompts", "1.txt"), `${prompt1}\n`);
  writeFileSync(join(clone, "prompts", "gate-failure.txt"), `${gateText}\n`);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function run(script: Script, args: string[] = [], envOverride: Record<string, string | undefined> = {}) {
  const scriptPath = join(root, "script.json");
  writeFileSync(scriptPath, JSON.stringify(script));
  const env: Record<string, string | undefined> = {
    ...process.env,
    SUPERSET: fake,
    FIX: fix,
    SPIKE_CLONE: clone,
    SPIKE_REPO: "acme/spike",
    FAKE_SCRIPT: scriptPath,
    FAKE_LOG: log,
    ...envOverride,
  };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];
  return spawnSync(process.execPath, [driver, ...args], { cwd: work, encoding: "utf8", env });
}

function calls(): string[][] {
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));
}

function fixtureNames() {
  return readdirSync(fix)
    .filter((f) => f.endsWith(".meta.json"))
    .map((f) => f.replace(/\.meta\.json$/, ""));
}

function metaArgv(name: string) {
  return JSON.parse(readFileSync(join(fix, `${name}.meta.json`), "utf8")).argv;
}

function results() {
  return readFileSync(join(work, "spike", "RESULTS.md"), "utf8");
}

function localCell(md: string, step: string) {
  const row = md.split("\n").find((line) => line.startsWith(`| ${step}`));
  if (!row) throw new Error(`no row ${step}`);
  return row.split("|").map((cell) => cell.trim()).slice(2, 5);
}

const on = ["--local", "--workspace", "ws-1", "--terminal", "term-1", "--json"];
const create = [
  "workspaces", "create", "--local", "--project", "proj-1", "--name", "fac #1 multiply", "--branch", "fac/1-1",
  "--skip-branch-prefix", "--base-branch", "main", "--tag", "factory", "--agent", "claude", "--prompt", prompt1, "--json",
];

const happyPath: [string, string[]][] = [
  ["schema", ["schema", "--json"]],
  ["projects-list-local", ["projects", "list", "--local", "--json"]],
  ["ws-create-local", create],
  ["ws-get-local", ["workspaces", "get", "ws-1", "--local", "--json"]],
  ["agents-explain-local-starting", ["agents", "explain", ...on]],
  ["agents-explain-local-working", ["agents", "explain", ...on]],
  ["agents-wait-local", ["agents", "wait", "--local", "--workspace", "ws-1", "--terminal", "term-1", "--until", "settled", "--timeout", "3600", "--json"]],
  ["agents-explain-local-idle", ["agents", "explain", ...on]],
  ["agents-read-local", ["agents", "read", ...on]],
  [
    "terminals-send-local",
    ["terminals", "send", "--local", "--workspace", "ws-1", "--terminal", "term-1", "--text", gateText, "--wait", "--until", "settled", "--timeout", "3600", "--json"],
  ],
  ["agents-explain-local-after-gate", ["agents", "explain", ...on]],
  ["agents-read-local-after-gate", ["agents", "read", ...on]],
  ["ws-create-local-repeat", create],
  ["terminals-close-local-repeat", ["terminals", "close", "--local", "--workspace", "ws-1", "--terminal", "term-2", "--json"]],
  ["ws-list-noflag", ["workspaces", "list", "--json"]],
  ["ws-list-local", ["workspaces", "list", "--local", "--json"]],
];

describe("the happy path", () => {
  let result: ReturnType<typeof run>;

  beforeEach(() => {
    result = run(happyScript());
  });

  test("exits 0", () => {
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  test("makes every call in order, each through the recorder under its fixture name", () => {
    expect(calls()).toEqual(happyPath.map(([, argv]) => argv));
    expect(fixtureNames().sort()).toEqual(happyPath.map(([name]) => name).sort());
    for (const [name, argv] of happyPath) expect(metaArgv(name)).toEqual(argv);
  });

  test("passes --local on every call but schema and the no-flag list", () => {
    const all = calls();
    expect(all.length).toBe(happyPath.length);
    for (const argv of all) {
      const exempt = argv[0] === "schema" || (argv[0] === "workspaces" && argv[1] === "list" && !argv.includes("--local"));
      if (!exempt) expect(argv).toContain("--local");
    }
    expect(all.filter((argv) => !argv.includes("--local"))).toEqual([
      ["schema", "--json"],
      ["workspaces", "list", "--json"],
    ]);
  });

  test("saves the schema as schema.json", () => {
    expect(JSON.parse(readFileSync(join(fix, "schema.json"), "utf8")).version).toBe("2.0.7");
  });

  test("appends the workspace and terminal ids to spike/ids.env", () => {
    expect(readFileSync(join(work, "spike", "ids.env"), "utf8")).toBe("export WS_L=ws-1\nexport TERM_L=term-1\n");
  });

  test("appends to an ids.env that already exists", () => {
    rmSync(fix, { recursive: true, force: true });
    rmSync(log);
    rmSync(join(work, "spike", "RESULTS.md"));
    writeFileSync(join(work, "spike", "ids.env"), "export KEEP=1\n");
    expect(run(happyScript()).status).toBe(0);
    expect(readFileSync(join(work, "spike", "ids.env"), "utf8")).toBe("export KEEP=1\nexport WS_L=ws-1\nexport TERM_L=term-1\n");
  });

  test("prints the manual L5 steps after L4", () => {
    expect(result.stdout).toContain("L5");
    expect(result.stdout).toContain("Cmd+Q");
    expect(result.stdout).toContain("ws-create-local-4");
    expect(result.stdout).toContain("agents-explain-local-appquit");
    expect(result.stdout).toContain(join(clone, "prompts", "4.txt"));
    expect(result.stdout.indexOf("L5")).toBeGreaterThan(result.stdout.indexOf("rec ws-list-local"));
  });

  test("fills the Local cells it can decide and leaves the rest empty", () => {
    const md = results();
    for (const step of ["1 ", "2 ", "3 ", "4 "]) {
      const [local, host, cloud] = localCell(md, step);
      expect(local).toMatch(/^pass/);
      expect(host).toBe("");
      expect(cloud).toBe("");
    }
    expect(localCell(md, "3 ")[0]).toContain(done);
    expect(localCell(md, "5 ")).toEqual(["", "", ""]);
    expect(md).toContain("| X7 ");
    expect(md).toMatch(/\| X7 [^\n]*alreadyExists: true[^\n]*term-2/);
    expect(md).toMatch(/\| X5 [^\n]*2\.0\.7/);
    expect(md).not.toContain("{{");
  });

  test("writes the observed values it saw", () => {
    const md = results();
    expect(md).toContain("- lastEventType values seen: Start, PreToolUse, Stop\n");
    expect(md).toContain("- explain states seen: working, idle\n");
    expect(md).toMatch(/- Run time per location, create to first result line: local: \d+s\n/);
    expect(md).toContain("- Worktree folder pattern (local, host): local: /wt/fac-1-1\n");
    expect(md).toContain("- User: chunks per /factory prompt: 1\n");
    expect(md).toContain("- Text after the last Assistant: chunk: none\n");
  });

  test("RESULTS.md keeps the template's sections", () => {
    const md = results();
    for (const heading of ["## Steps", "## Probes", "## Observed values", "## Errors, verbatim"]) expect(md).toContain(heading);
    for (let n = 1; n <= 11; n++) expect(md).toContain(`| X${n} `);
  });
});

function observed(label: string) {
  return results().split("\n").find((line) => line.startsWith(`- ${label}`)) ?? "";
}

test("explain states count only agents explain answers", () => {
  const script = happyScript();
  script["agents wait"] = { stdout: { terminalId: "term-1", state: "idle", lastEventType: "Notification" } };
  script["terminals send"] = { stdout: { terminalId: "term-1", submitted: true, state: "submitted" } };
  expect(run(script).status).toBe(0);
  expect(observed("explain states seen")).toBe("- explain states seen: working, idle");
  expect(observed("lastEventType values seen")).toBe("- lastEventType values seen: Start, PreToolUse, Notification, Stop");
});

test("text after the last Assistant chunk is recorded, with the User chunk count", () => {
  const script = happyScript();
  const first = reads(script)[0]!.stdout;
  first.text = `${first.text}\n\nUser: hook output`;
  expect(run(script).status).toBe(0);
  expect(observed("User: chunks")).toBe("- User: chunks per /factory prompt: 2");
  expect(observed("Text after the last Assistant")).toBe("- Text after the last Assistant: chunk: User: hook output");
});

test("an error whose stderr holds a | and a newline stays one table row", () => {
  const script = happyScript();
  script["workspaces list"] = [{ stderr: "Error: a | b\nmore\n", exit: 1 }, { stdout: [] }];
  expect(run(script).status).toBe(0);
  const rows = results().split("\n").filter((line) => line.includes("Error: a"));
  expect(rows).toEqual([
    '| superset workspaces list --json | ws-list-noflag | argv=["workspaces","list","--json"]<br>Error: a \\| b<br>more<br> |',
  ]);
});

test("a repeat create with no new terminal closes nothing", () => {
  const script = happyScript();
  const [first] = script["workspaces create"] as Answer[];
  script["workspaces create"] = [first!, first!];
  const r = run(script);
  expect(r.status).toBe(0);
  expect(calls().some((argv) => argv[0] === "terminals" && argv[1] === "close")).toBe(false);
});

function x7Row() {
  return results().split("\n").find((line) => line.startsWith("| X7 ")) ?? "";
}

test("a repeat create in a new workspace records its id and closes the terminal there", () => {
  const script = happyScript();
  const [first] = script["workspaces create"] as Answer[];
  script["workspaces create"] = [
    first!,
    { stdout: { workspace: { id: "ws-2" }, agents: [{ ok: true, sessionId: "term-2" }], alreadyExists: false } },
  ];
  expect(run(script).status).toBe(0);
  expect(readFileSync(join(work, "spike", "ids.env"), "utf8")).toBe(
    "export WS_L=ws-1\nexport TERM_L=term-1\nexport WS_L_REPEAT=ws-2\n",
  );
  expect(calls().find((argv) => argv[0] === "terminals" && argv[1] === "close")).toEqual([
    "terminals", "close", "--local", "--workspace", "ws-2", "--terminal", "term-2", "--json",
  ]);
  expect(x7Row()).toContain("new workspace ws-2");
});

test("a repeat create with two new terminals closes both under their own fixture names", () => {
  const script = happyScript();
  const [first] = script["workspaces create"] as Answer[];
  script["workspaces create"] = [
    first!,
    {
      stdout: {
        workspace: { id: "ws-1" },
        agents: [{ ok: true, sessionId: "term-1" }, { ok: true, sessionId: "term-2" }, { ok: true, sessionId: "term-3" }],
        alreadyExists: true,
      },
    },
  ];
  expect(run(script).status).toBe(0);
  const close = (term: string) => ["terminals", "close", "--local", "--workspace", "ws-1", "--terminal", term, "--json"];
  expect(calls().filter((argv) => argv[0] === "terminals" && argv[1] === "close")).toEqual([close("term-2"), close("term-3")]);
  expect(metaArgv("terminals-close-local-repeat")).toEqual(close("term-2"));
  expect(metaArgv("terminals-close-local-repeat-2")).toEqual(close("term-3"));
  expect(x7Row()).toContain("second agent: term-2 (closed), term-3 (closed)");
  expect(x7Row()).toContain("ws-create-local-repeat, terminals-close-local-repeat, terminals-close-local-repeat-2");
});

test("a repeat create that exits 1 still keeps its new workspace and closes its terminal", () => {
  const script = happyScript();
  const [first] = script["workspaces create"] as Answer[];
  script["workspaces create"] = [
    first!,
    { stdout: { workspace: { id: "ws-2" }, agents: [{ ok: false, sessionId: "term-2" }] }, stderr: "Error: agent failed\n", exit: 1 },
  ];
  const r = run(script);
  expect(r.status).toBe(0);
  expect(readFileSync(join(work, "spike", "ids.env"), "utf8")).toBe(
    "export WS_L=ws-1\nexport TERM_L=term-1\nexport WS_L_REPEAT=ws-2\n",
  );
  expect(calls().find((argv) => argv[0] === "terminals" && argv[1] === "close")).toEqual([
    "terminals", "close", "--local", "--workspace", "ws-2", "--terminal", "term-2", "--json",
  ]);
  expect(x7Row()).toContain("exit 1, alreadyExists: undefined, second agent: term-2 (closed), new workspace ws-2");
});

test("a repeat create that exits 1 with no workspace id names its agent to close by hand", () => {
  const script = happyScript();
  const [first] = script["workspaces create"] as Answer[];
  script["workspaces create"] = [first!, { stdout: { agents: [{ ok: true, sessionId: "term-2" }] }, exit: 1 }];
  const r = run(script);
  expect(r.status).toBe(0);
  expect(calls().some((argv) => argv[0] === "terminals" && argv[1] === "close")).toBe(false);
  expect(x7Row()).toContain("exit 1, the answer has no .workspace.id; second agent: term-2, not closed");
  expect(r.stderr).toContain("close term-2 by hand");
});

test("a repeat create with no workspace id closes nothing and says why", () => {
  const script = happyScript();
  const [first] = script["workspaces create"] as Answer[];
  script["workspaces create"] = [first!, { stdout: { agents: [{ ok: true, sessionId: "term-2" }] } }];
  const r = run(script);
  expect(r.status).toBe(0);
  expect(calls().some((argv) => argv[0] === "terminals" && argv[1] === "close")).toBe(false);
  expect(x7Row()).toContain("no .workspace.id");
  expect(r.stderr).toContain("term-2");
});

test("a failed close is reported as still running, not closed", () => {
  const script = happyScript();
  script["terminals close"] = { stderr: "Error: terminal not found\n", exit: 1 };
  const r = run(script);
  expect(r.status).toBe(0);
  expect(x7Row()).toContain("term-2 (close failed, exit 1, still running)");
  expect(x7Row()).not.toContain("(closed)");
  expect(r.stderr).toContain("terminals close --local --workspace ws-1 --terminal term-2");
  expect(r.stdout).toContain("Cmd+Q");
});

test("a failed probe is recorded and the run goes on", () => {
  const script = happyScript();
  const [first] = script["workspaces create"] as Answer[];
  script["workspaces create"] = [first!, { stderr: "Error: branch already checked out\n", exit: 1 }];
  script["workspaces list"] = [{ stderr: "Error: no default target\n", exit: 1 }, { stdout: [] }];
  const r = run(script);

  expect(r.status).toBe(0);
  expect(calls().at(-1)).toEqual(["workspaces", "list", "--local", "--json"]);
  expect(r.stdout).toContain("Cmd+Q");
  const md = results();
  expect(x7Row()).toContain("exit 1");
  expect(md).toMatch(/\| X6 [^\n]*no flag exit 1/);
  expect(md).toContain("Error: branch already checked out");
  expect(md).toContain("Error: no default target");
});

test("a created workspace is kept in ids.env even when its answer has no agent", () => {
  const script = happyScript();
  script["workspaces create"] = { stdout: { workspace: { id: "ws-1", branch: "fac/1-1" }, agents: [] } };
  const r = run(script);
  expect(r.status).toBe(1);
  expect(r.stderr).toContain(".agents[0].sessionId");
  expect(readFileSync(join(work, "spike", "ids.env"), "utf8")).toBe("export WS_L=ws-1\n");
});

test("a create that exits 1 keeps the workspace it made in ids.env and stops", () => {
  const script = happyScript();
  script["workspaces create"] = {
    stdout: { workspace: { id: "ws-1", branch: "fac/1-1" }, agents: [{ ok: false }] },
    stderr: "Error: agent failed to launch\n",
    exit: 1,
  };
  const r = run(script);
  expect(r.status).toBe(1);
  expect(r.stderr).toContain("ws-create-local: exit 1");
  expect(calls().length).toBe(3);
  expect(readFileSync(join(work, "spike", "ids.env"), "utf8")).toBe("export WS_L=ws-1\n");
  expect(localCell(results(), "1 ")[0]).toBe("fail, ws-create-local, exit 1");
});

test("the fixture list is every fixture the happy path writes", () => {
  expect([...FIXTURES, "terminals-close-local-repeat"].sort()).toEqual(happyPath.map(([name]) => name).sort());
});

test.each([...FIXTURES, "terminals-close-local-repeat", "terminals-close-local-repeat-2"])(
  "a FIX that already holds %s is refused before any call and left alone",
  (name) => {
    mkdirSync(fix);
    writeFileSync(join(fix, `${name}.meta.json`), "earlier\n");
    const r = run(happyScript());
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(`${name}.meta.json`);
    expect(r.stderr).toContain("fresh folder");
    expect(calls()).toEqual([]);
    expect(readFileSync(join(fix, `${name}.meta.json`), "utf8")).toBe("earlier\n");
    expect(existsSync(join(work, "spike", "RESULTS.md"))).toBe(false);
  },
);

test("a FIX holding other fixtures is used as it is", () => {
  mkdirSync(fix);
  writeFileSync(join(fix, "ws-create-local-4.meta.json"), "{}\n");
  writeFileSync(join(fix, "schema-host.meta.json"), "{}\n");
  expect(run(happyScript()).status).toBe(0);
});

test("an existing RESULTS.md is refused before any call and left alone", () => {
  mkdirSync(join(work, "spike"));
  writeFileSync(join(work, "spike", "RESULTS.md"), "hand notes\n");
  const r = run(happyScript());
  expect(r.status).toBe(2);
  expect(r.stderr).toContain("RESULTS.md");
  expect(calls()).toEqual([]);
  expect(readFileSync(join(work, "spike", "RESULTS.md"), "utf8")).toBe("hand notes\n");
});

test("a missing prompt file exits 2 before any call", () => {
  rmSync(join(clone, "prompts", "1.txt"));
  const r = run(happyScript());
  expect(r.status).toBe(2);
  expect(r.stderr).toContain(join(clone, "prompts", "1.txt"));
  expect(calls()).toEqual([]);
  expect(existsSync(join(work, "spike", "RESULTS.md"))).toBe(false);
});

type Tweak = (s: Script) => void;
const reads = (s: Script) => s["agents read"] as { stdout: { text: string; harness: string } }[];
const failCases: [string, string, string, Tweak][] = [
  ["agent not ok", "1 ", "agents[0].ok", (s) => {
    const list = s["workspaces create"] as { stdout: any }[];
    list[0] = { stdout: { ...list[0]!.stdout, agents: [{ ok: false, sessionId: "term-1" }] } };
  }],
  ["wrong branch", "1 ", "branch is fac/other", (s) => {
    const list = s["workspaces create"] as { stdout: any }[];
    list[0] = { stdout: { ...list[0]!.stdout, workspace: { id: "ws-1", branch: "fac/other" } } };
  }],
  ["no worktree", "1 ", "worktreeExists", (s) => {
    s["workspaces get"] = { stdout: { id: "ws-1", worktreeExists: false } };
  }],
  ["not idle", "2 ", "state working", (s) => {
    s["agents wait"] = { stdout: { terminalId: "term-1", state: "working", lastEventType: "PreToolUse" } };
  }],
  ["other harness", "3 ", "harness codex", (s) => {
    reads(s)[0]!.stdout.harness = "codex";
  }],
  ["no result line", "3 ", "no result line", (s) => {
    reads(s)[0]!.stdout.text = "User: go\n\nAssistant: Still going.";
  }],
  ["gate text split", "4 ", "one User chunk", (s) => {
    reads(s)[1]!.stdout.text = `User: go\n\nAssistant: x\n${done}\n\nUser: The factory gate failed.\n\nUser: | # fail 1\n\nAssistant: ok\n${done}`;
  }],
  ["gate text quoted by the agent", "4 ", "one User chunk", (s) => {
    reads(s)[1]!.stdout.text = `User: go\n\nAssistant: ${gateText}\n\nAssistant: ok\n${done}`;
  }],
  ["no result line after the gate", "4 ", "no result line", (s) => {
    reads(s)[1]!.stdout.text = `User: ${gateText}\n\nAssistant: Looking.`;
  }],
];

test.each(failCases)("%s fails its Local cell and the run goes on", (_, step, why, tweak) => {
  const script = happyScript();
  tweak(script);
  const r = run(script);
  expect(r.status).toBe(0);
  const [local] = localCell(results(), step);
  expect(local).toMatch(/^fail/);
  expect(local).toContain(why);
});

test("a User chunk after the gate reply still passes step 4", () => {
  const script = happyScript();
  const second = reads(script)[1]!.stdout;
  second.text = `${second.text}\n\nUser: hook output`;
  expect(run(script).status).toBe(0);
  expect(localCell(results(), "4 ")[0]).toMatch(/^pass/);
});

test("a wait timeout is recorded and stops the run", () => {
  const script = happyScript();
  script["agents wait"] = { stderr: "Error: timed out after 3600s\n", exit: 1 };
  const r = run(script);

  expect(r.status).toBe(1);
  expect(r.stderr).toContain("agents-wait-local");
  const all = calls();
  expect(all.at(-1)?.slice(0, 2)).toEqual(["agents", "wait"]);
  expect(all.length).toBe(7);
  expect(JSON.parse(readFileSync(join(fix, "agents-wait-local.meta.json"), "utf8")).exit).toBe(1);
  expect(existsSync(join(fix, "agents-explain-local-idle.meta.json"))).toBe(false);
  expect(r.stdout).not.toContain("Cmd+Q");

  const md = results();
  expect(localCell(md, "1 ")[0]).toMatch(/^pass/);
  expect(localCell(md, "2 ")[0]).toMatch(/^fail/);
  expect(localCell(md, "3 ")[0]).toBe("");
  expect(md).toContain("Error: timed out after 3600s");
});

test("a missing project refuses and tells the person to create it", () => {
  const script = happyScript();
  script["projects list"] = { stdout: [{ id: "proj-other", path: "/elsewhere" }] };
  const r = run(script);

  expect(r.status).toBe(1);
  expect(r.stderr).toContain("projects create");
  expect(r.stderr).toContain(clone);
  expect(calls().map((argv) => argv.slice(0, 2))).toEqual([["schema", "--json"], ["projects", "list"]]);
  expect(existsSync(join(work, "spike", "ids.env"))).toBe(false);
});

test.each(["2.0.6", "2.0.9", undefined])("schema version %s is refused before any other call", (version) => {
  const script = happyScript();
  script.schema = { stdout: version === undefined ? {} : { version } };
  const r = run(script);

  expect(r.status).toBe(1);
  expect(r.stderr).toContain("2.0.7");
  if (version) expect(r.stderr).toContain(version);
  expect(calls()).toEqual([["schema", "--json"]]);
});

test("schema version 2.0.8 is accepted", () => {
  const script = happyScript();
  script.schema = { stdout: { version: "2.0.8" } };
  expect(run(script).status).toBe(0);
});

test("a missing field in an answer fails with a clear message", () => {
  const script = happyScript();
  script["workspaces create"] = { stdout: { workspace: {}, agents: [] } };
  const r = run(script);

  expect(r.status).toBe(1);
  expect(r.stderr).toContain(".workspace.id");
  expect(r.stderr).toContain("ws-create-local");
  expect(calls().length).toBe(3);
  expect(existsSync(join(work, "spike", "ids.env"))).toBe(false);
});

test.each(["SUPERSET", "FIX", "SPIKE_CLONE", "SPIKE_REPO"])("a missing %s exits 2 before any call", (name) => {
  const r = run(happyScript(), [], { [name]: undefined });
  expect(r.status).toBe(2);
  expect(r.stderr).toContain(name);
  expect(calls()).toEqual([]);
});

test("--cleanup archives only the local workspace ids in ids.env", () => {
  mkdirSync(join(work, "spike"));
  writeFileSync(
    join(work, "spike", "ids.env"),
    "export WS_L=ws-1\nexport TERM_L=term-1\nexport WS_L_REPEAT=ws-2\nexport WS_L4=ws-4\nexport WS_H=host-ws\nexport PROJECT_L=proj-1\n",
  );
  const r = run({ "workspaces archive": { stdout: { archived: 3 } } }, ["--cleanup"]);

  expect(r.status).toBe(0);
  expect(calls()).toEqual([["workspaces", "archive", "ws-1", "ws-2", "ws-4", "--local", "--json"]]);
  expect(fixtureNames()).toEqual(["ws-archive-local"]);
});

test("--cleanup with no workspace ids makes no call", () => {
  const r = run({}, ["--cleanup"]);
  expect(r.status).toBe(1);
  expect(r.stderr).toContain("ids.env");
  expect(calls()).toEqual([]);
});

describe("lastResultLine", () => {
  test("returns the result line of a clean transcript", () => {
    expect(lastResultLine(`User: /factory a/b#1\n\nAssistant: Done.\n${done}`)).toBe(done);
  });

  test("reads the last Assistant chunk when a User chunk follows it", () => {
    const text = `User: go\n\nAssistant: Stopped.\nFACTORY-STOP: stuck\n\nUser: hook output`;
    expect(lastResultLine(text)).toBe("FACTORY-STOP: stuck");
  });

  test("returns null when the last assistant message has no result line", () => {
    expect(lastResultLine(`User: go\n\nAssistant: ${done}\n\nUser: again\n\nAssistant: Still working.`)).toBeNull();
    expect(lastResultLine("User: go")).toBeNull();
    expect(lastResultLine("")).toBeNull();
  });

  test("takes the last non-empty line of a multi-line final message", () => {
    const text = `User: go\n\nAssistant: Summary.\n\n- one\n- two\n\nFACTORY-STOP: needs-info\n\n`;
    expect(lastResultLine(text)).toBe("FACTORY-STOP: needs-info");
  });

  test("a result line in the middle of the final message does not count", () => {
    expect(lastResultLine(`User: go\n\nAssistant: ${done}\nthen more`)).toBeNull();
  });

  test("a result line with leading whitespace does not count", () => {
    expect(lastResultLine(`User: go\n\nAssistant: Done.\n   ${done}`)).toBeNull();
  });

  test("a one-line final message is read past its Assistant prefix", () => {
    expect(lastResultLine(`User: go\n\nAssistant: ${done}`)).toBe(done);
  });
});
