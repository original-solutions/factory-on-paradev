// Writes two sample belts for the spike, next to this file:
//   belt.json          about 40 KiB, under Paradev's 64 KiB storage limit
//   belt-oversize.json about 70 KiB, over it
// Everything comes from fixed demo data, so a rerun writes the same bytes.
// Run with: node spike/belt-probe/make-samples.ts

import { writeFileSync } from "node:fs";
import { beltBytes, type BeltV1 } from "../../src/belt.ts";

type Run = BeltV1["runs"][number];

const KiB = 1024;
const START = Date.UTC(2026, 0, 5, 9, 0, 0);
const iso = (minutes: number) => new Date(START + minutes * 60_000).toISOString();

const repos = ["example-org/widgets", "example-org/billing", "demo-labs/website", "sample-co/api"];
const titles = [
  "feat: export the order list as CSV",
  "fix: date picker skips the last day of the month",
  "chore: pin the build image to a fixed version",
  "feat: dark mode for the settings page",
  "fix: retry webhook delivery after a timeout",
  "docs: explain how to rotate the signing key",
];
const states: Run["state"][] = ["building", "pr-open", "triage", "needs-info", "stuck", "ready", "proposed"];
const steps = ["Read", "Isolate", "Contract", "Make", "Check: review cycle 2", "Gate", "Ship"];
const reasons = [
  "Waiting on an answer about which time zone the export should use.",
  "Gate failed three times on the same flaky browser test; the branch has the work so far.",
];

function run(i: number): Run {
  const state = states[i % states.length]!;
  const repo = repos[i % repos.length]!;
  const issue = 100 + i;
  const finished = state === "pr-open" || state === "stuck";
  return {
    id: `run-${String(i + 1).padStart(4, "0")}`,
    repo,
    issue,
    title: titles[i % titles.length]!,
    state,
    step: steps[i % steps.length]!,
    reason: state === "needs-info" ? reasons[0]! : state === "stuck" ? reasons[1]! : null,
    prUrl: state === "pr-open" ? `https://github.com/${repo}/pull/${issue + 7}` : null,
    startedTs: iso(i * 7),
    finished,
    totalMs: finished ? 600_000 + i * 1_000 : null,
    workspaceId: `ws-${String(i + 1).padStart(4, "0")}`,
  };
}

const ref = (r: Run) => `${r.repo}#${r.issue}`;
// Both are among the first runs, so every sample holds them.
const waiting = run(3);
const stuck = run(4);

function belt(runs: Run[]): BeltV1 {
  const count = (s: Run["state"]) => runs.filter((r) => r.state === s).length;
  return {
    v: 1,
    updatedAt: iso(24 * 60),
    runner: {
      host: "demo-host",
      version: "0.0.0",
      paradevCli: "2.0.7",
      claimsPaused: false,
      paradevOnline: true,
      lastPassAt: iso(24 * 60 - 1),
    },
    counts: {
      triage: count("triage"),
      building: count("building"),
      prOpen: count("pr-open"),
      needsInfo: count("needs-info"),
      stuck: count("stuck"),
      finished7d: runs.filter((r) => r.finished).length,
    },
    runs,
    attention: [
      { id: "att-1", kind: "stuck", text: `${ref(stuck)} is stuck at ${stuck.step}.`, since: iso(60) },
      { id: "att-2", kind: "needs-info", text: `${ref(waiting)} is waiting on an answer at ${waiting.step}.`, since: iso(90) },
    ],
  };
}

/** The smallest belt, adding runs in order, whose stored size reaches `target` bytes. */
function beltOfSize(target: number): BeltV1 {
  const runs: Run[] = [];
  let payload = belt(runs);
  while (beltBytes(payload) < target) {
    runs.push(run(runs.length));
    payload = belt(runs);
  }
  return payload;
}

const write = (name: string, payload: BeltV1) =>
  writeFileSync(new URL(name, import.meta.url), `${JSON.stringify(payload)}\n`);

write("belt.json", beltOfSize(40 * KiB));
write("belt-oversize.json", beltOfSize(70 * KiB));
