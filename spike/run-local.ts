// Drives the local half of the phase 0 spike: steps L1 to L4 and probes X5, X6 and X7,
// every call through the recorder. It touches only the workspace and terminals it creates.
//
//   SUPERSET=<cli> FIX=<fixture dir> SPIKE_CLONE=<abs path> SPIKE_REPO=<owner/name> node spike/run-local.ts
//   ... node spike/run-local.ts --cleanup     archive the WS_L* workspace ids in spike/ids.env
//
// Writes spike/ids.env (appended) and spike/RESULTS.md under the current directory.
// Exit 2 on missing input, 1 when a call fails or a check refuses.
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { record } from "./rec.ts";

const VERSIONS = ["2.0.7", "2.0.8"];
const INPUTS = ["SUPERSET", "FIX", "SPIKE_CLONE", "SPIKE_REPO"] as const;

type Chunk = { role: "User" | "Assistant"; body: string };

/** Splits a transcript into its `User: ` and `Assistant: ` turns, which are joined by blank lines. */
export function chunks(text: string): Chunk[] {
  const starts = [...text.matchAll(/(?:^|\n\n)(User|Assistant): /g)];
  return starts.map((m, i) => ({
    role: m[1] as Chunk["role"],
    body: text.slice(m.index + m[0].length, starts[i + 1]?.index ?? text.length),
  }));
}

/** The last non-empty line of the last assistant turn, when it is a factory result line. */
export function lastResultLine(text: string): string | null {
  const last = chunks(text).findLast((c) => c.role === "Assistant");
  const line = last?.body
    .split("\n")
    .map((l) => l.trimEnd())
    .findLast((l) => l.trim() !== "");
  return line && /^FACTORY-(DONE|STOP): /.test(line) ? line : null;
}

class Stop extends Error {}

type Answer = { name: string; exit: number; json: any; startedAt: number; durationMs: number };

function main(args: string[]): number {
  const missing = INPUTS.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    process.stderr.write(`run-local: set ${missing.join(", ")} (needs ${INPUTS.join(", ")})\n`);
    return 2;
  }
  const { SUPERSET: binary, FIX: fix, SPIKE_CLONE: clone, SPIKE_REPO: repo } = process.env as Record<string, string>;
  const spikeDir = join(process.cwd(), "spike");
  const idsFile = join(spikeDir, "ids.env");

  const cells: Record<string, string> = { repo, version: "", date: new Date().toISOString().slice(0, 10) };
  const errors: string[] = [];
  const eventTypes = new Set<string>();
  const states = new Set<string>();

  const call = (name: string, argv: string[]): Answer => {
    const exit = record(name, argv, { binary, fixtureDir: fix });
    const meta = JSON.parse(readFileSync(join(fix, `${name}.meta.json`), "utf8"));
    const out = join(fix, `${name}.json`);
    let json: any = null;
    if (existsSync(out)) {
      try {
        json = JSON.parse(readFileSync(out, "utf8"));
      } catch {
        json = null;
      }
    }
    if (exit !== 0) errors.push(`| ${cell(`superset ${meta.argv.join(" ")}`)} | ${name} | ${cell(meta.stderr)} |`);
    if (typeof json?.lastEventType === "string") eventTypes.add(json.lastEventType);
    if (typeof json?.state === "string" && name.startsWith("agents-explain")) states.add(json.state);
    return { name, exit, json, startedAt: meta.startedAt, durationMs: meta.durationMs };
  };

  const fail = (step: string, name: string, why: string): never => {
    if (step) cells[step] = cell(`fail, ${name}, ${why}`);
    throw new Stop(`${name}: ${why}`);
  };
  const must = (step: string, name: string, argv: string[]): Answer => {
    const a = call(name, argv);
    if (a.exit !== 0) fail(step, name, `exit ${a.exit}`);
    return a;
  };
  const need = <T>(step: string, a: Answer, path: string, value: T | undefined | null): T => {
    if (value === undefined || value === null) fail(step, a.name, `the answer has no ${path}`);
    return value as T;
  };
  const appendIds = (ids: Record<string, string>) => {
    mkdirSync(spikeDir, { recursive: true });
    appendFileSync(idsFile, Object.entries(ids).map(([k, v]) => `export ${k}=${v}\n`).join(""));
  };

  if (args.includes("--cleanup")) {
    const env = existsSync(idsFile) ? readFileSync(idsFile, "utf8") : "";
    const ids = [...new Set([...env.matchAll(/^export WS_L\w*=(\S+)$/gm)].map((m) => m[1]!))];
    if (ids.length === 0) {
      process.stderr.write(`run-local: no WS_L workspace ids in ${idsFile}; nothing to archive\n`);
      return 1;
    }
    return call("ws-archive-local", ["workspaces", "archive", ...ids, "--local"]).exit;
  }

  const resultsFile = join(spikeDir, "RESULTS.md");
  if (existsSync(resultsFile)) {
    process.stderr.write(`run-local: ${resultsFile} exists; move it aside before a new run, so its notes are kept\n`);
    return 2;
  }
  const prompts: string[] = [];
  for (const file of ["1.txt", "gate-failure.txt"]) {
    const path = join(clone, "prompts", file);
    if (!existsSync(path)) {
      process.stderr.write(`run-local: missing ${path}; scaffold the spike clone first\n`);
      return 2;
    }
    prompts.push(readFileSync(path, "utf8").replace(/\n+$/, ""));
  }
  const [prompt1, gateText] = prompts as [string, string];

  try {
    // X5: the schema, which also gates every write call.
    const schema = must("", "schema", ["schema"]);
    const version: unknown = schema.json?.version;
    cells.version = String(version ?? "");
    cells.x5 = cell(`version ${version ?? "missing"}`);
    cells["x5-fixtures"] = "schema.json";
    if (typeof version !== "string" || !VERSIONS.includes(version)) {
      throw new Stop(`schema version is ${version ?? "missing"}; this driver needs ${VERSIONS.join(" or ")}`);
    }

    const projects = must("", "projects-list-local", ["projects", "list", "--local"]);
    if (!Array.isArray(projects.json)) fail("", projects.name, "the answer is not a list of projects");
    const project = projects.json.find((p: any) => p?.path === clone);
    if (!project) {
      throw new Stop(
        `no Paradev project has path ${clone}. Create it, then run again:\n` +
          `  node spike/rec.ts projects-create-local projects create --local --name factory-paradev-spike --import '${clone}'`,
      );
    }
    const projectId = need("", projects, ".id of the project", project.id as string | undefined);

    // L1: create the workspace and start the agent.
    const createArgs = [
      "workspaces", "create", "--local", "--project", projectId, "--name", "fac #1 multiply",
      "--branch", "fac/1-1", "--skip-branch-prefix", "--base-branch", "main",
      "--tag", "factory", "--agent", "claude", "--prompt", prompt1,
    ];
    const created = must("step1", "ws-create-local", createArgs);
    const ws = need<string>("step1", created, ".workspace.id", created.json?.workspace?.id);
    appendIds({ WS_L: ws });
    const term = need<string>("step1", created, ".agents[0].sessionId", created.json?.agents?.[0]?.sessionId);
    appendIds({ TERM_L: term });
    const on = ["--local", "--workspace", ws, "--terminal", term];
    const got = must("step1", "ws-get-local", ["workspaces", "get", ws, "--local"]);
    must("step1", "agents-explain-local-starting", ["agents", "explain", ...on]);
    cells.worktree = cell(`local: ${got.json?.worktreePath ?? "?"}`);
    const step1Problems = [
      created.json?.agents?.[0]?.ok !== true && "agents[0].ok is not true",
      created.json?.workspace?.branch !== "fac/1-1" && `branch is ${created.json?.workspace?.branch}`,
      got.json?.worktreeExists !== true && "worktreeExists is not true",
    ].filter(Boolean);
    cells.step1 = cell(
      step1Problems.length === 0 ? `pass, ws-create-local, branch fac/1-1` : `fail, ws-create-local, ${step1Problems.join("; ")}`,
    );

    // L2: wait for the turn to settle.
    must("step2", "agents-explain-local-working", ["agents", "explain", ...on]);
    const waited = must("step2", "agents-wait-local", ["agents", "wait", ...on, "--until", "settled", "--timeout", "3600"]);
    must("step2", "agents-explain-local-idle", ["agents", "explain", ...on]);
    const took = `${Math.round(waited.durationMs / 1000)}s`;
    cells.step2 = cell(
      waited.json?.state === "idle"
        ? `pass, agents-wait-local, idle after ${took}`
        : `fail, agents-wait-local, state ${waited.json?.state}`,
    );

    // L3: read the result line.
    const read = must("step3", "agents-read-local", ["agents", "read", ...on]);
    const text = need<string>("step3", read, ".text", read.json?.text);
    const line = lastResultLine(text);
    const harness = read.json?.harness;
    cells.step3 = cell(
      line && harness === "claude"
        ? `pass, agents-read-local, ${line}`
        : `fail, agents-read-local, ${line ? `harness ${harness}` : "no result line"}`,
    );
    const turns = chunks(text);
    const lastAssistant = turns.findLastIndex((c) => c.role === "Assistant");
    cells.userChunks = String(turns.filter((c) => c.role === "User").length);
    cells.afterAssistant = cell(
      lastAssistant < 0 ? "no Assistant chunk" : turns.slice(lastAssistant + 1).map((c) => `${c.role}: ${c.body}`).join(" / ") || "none",
    );
    cells.runTime = `local: ${Math.round((read.startedAt + read.durationMs - created.startedAt) / 1000)}s`;

    // L4: send a fake gate failure into the same session.
    must("step4", "terminals-send-local", [
      "terminals", "send", "--local", "--workspace", ws, "--terminal", term,
      "--text", gateText, "--wait", "--until", "settled", "--timeout", "3600",
    ]);
    must("step4", "agents-explain-local-after-gate", ["agents", "explain", ...on]);
    const after = must("step4", "agents-read-local-after-gate", ["agents", "read", ...on]);
    const afterText = need<string>("step4", after, ".text", after.json?.text);
    const afterLine = lastResultLine(afterText);
    const afterTurns = chunks(afterText);
    const reply = afterTurns.findLastIndex((c) => c.role === "Assistant");
    const oneUser = reply > 0 && afterTurns[reply - 1]!.role === "User" && afterTurns[reply - 1]!.body.includes(gateText);
    cells.step4 = cell(
      afterLine && oneUser
        ? `pass, agents-read-local-after-gate, ${afterLine}`
        : `fail, agents-read-local-after-gate, ${afterLine ? "the gate failure is not one User chunk" : "no result line"}`,
    );

    // X7: the L1 create again, unchanged.
    const repeat = call("ws-create-local-repeat", createArgs);
    const x7Fixtures = ["ws-create-local-repeat"];
    const repeatWs: unknown = repeat.json?.workspace?.id;
    const extra: string[] = (repeat.json?.agents ?? [])
      .map((a: any) => a?.sessionId)
      .filter((id: unknown) => typeof id === "string" && id !== term);
    if (repeat.exit !== 0) {
      cells.x7 = `exit ${repeat.exit}`;
    } else if (typeof repeatWs !== "string") {
      cells.x7 = cell(`the answer has no .workspace.id; second agent: ${extra.join(", ") || "none"}, not closed`);
      if (extra.length > 0) {
        process.stderr.write(`run-local: ws-create-local-repeat has no .workspace.id; close ${extra.join(", ")} by hand\n`);
      }
    } else {
      if (repeatWs !== ws) appendIds({ WS_L_REPEAT: repeatWs });
      const closed = extra.map((id, i) => {
        const name = `terminals-close-local-repeat${i === 0 ? "" : `-${i + 1}`}`;
        x7Fixtures.push(name);
        const argv = ["terminals", "close", "--local", "--workspace", repeatWs, "--terminal", id];
        const { exit } = call(name, argv);
        if (exit === 0) return `${id} (closed)`;
        process.stderr.write(`run-local: ${name} exit ${exit}; ${id} is still running. Close it by hand: superset ${argv.join(" ")}\n`);
        return `${id} (close failed, exit ${exit}, still running)`;
      });
      cells.x7 = cell(
        `alreadyExists: ${repeat.json?.alreadyExists}, second agent: ${closed.join(", ") || "none"}` +
          (repeatWs !== ws ? `, new workspace ${repeatWs}` : ""),
      );
    }
    cells["x7-fixtures"] = x7Fixtures.join(", ");

    // X6: the default target with no flag.
    const rows = (a: Answer) => (Array.isArray(a.json) ? `${a.json.length} rows` : "not a list");
    const noflag = call("ws-list-noflag", ["workspaces", "list"]);
    const local = call("ws-list-local", ["workspaces", "list", "--local"]);
    cells.x6 = cell(`before C0: no flag exit ${noflag.exit}, ${rows(noflag)}; --local exit ${local.exit}, ${rows(local)}`);
    cells["x6-fixtures"] = "ws-list-noflag, ws-list-local";

    process.stdout.write(l5Steps(projectId, clone, repo));
    return 0;
  } catch (error) {
    if (!(error instanceof Stop)) throw error;
    process.stderr.write(`run-local: ${error.message}\n`);
    return 1;
  } finally {
    cells.lastEventTypes = [...eventTypes].join(", ");
    cells.states = [...states].join(", ");
    cells.errors = errors.join("\n");
    writeResults(resultsFile, cells);
  }
}

function cell(text: string): string {
  return text.replaceAll("|", "\\|").replace(/\r?\n/g, "<br>");
}

function writeResults(path: string, cells: Record<string, string>) {
  const template = readFileSync(new URL("./RESULTS.template.md", import.meta.url), "utf8");
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, template.replace(/\{\{([\w-]+)\}\}/g, (_, key: string) => cells[key] ?? ""));
}

function l5Steps(projectId: string, clone: string, repo: string): string {
  const on = `--local --workspace "$WS_L4" --terminal "$TERM_L4"`;
  return `
L5 is manual. The driver stops here and quits, stops or kills nothing.
Keep SUPERSET and FIX exported, run from this folder, with the Paradev app open:

  gh pr list --repo ${repo} --json number,headRefName,isDraft
  node spike/rec.ts ws-create-local-4 workspaces create --local --project ${projectId} --name "fac #4 stats" --branch fac/4-1 --skip-branch-prefix --base-branch main --tag factory --agent claude --prompt "$(cat '${join(clone, "prompts", "4.txt")}')"
  echo "export WS_L4=$(jq -r .workspace.id "$FIX/ws-create-local-4.json")" >> spike/ids.env
  echo "export TERM_L4=$(jq -r '.agents[0].sessionId' "$FIX/ws-create-local-4.json")" >> spike/ids.env
  source spike/ids.env
  node spike/rec.ts agents-wait-local-4-working agents wait ${on} --until working --timeout 300

While that agent works, quit the Paradev app with Cmd+Q. Then:

  node spike/rec.ts agents-explain-local-appquit agents explain ${on}

Open the app again, then:

  node spike/rec.ts agents-explain-local-reopened agents explain ${on}
  node spike/rec.ts snapshot-local-reopened snapshot --workspace "$WS_L4"

Write the error and the state after reopening into row 5, Local, of spike/RESULTS.md.
`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
