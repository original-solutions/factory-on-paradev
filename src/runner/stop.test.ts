// @effect-diagnostics nodeBuiltinImport:off - the tests lay out the request files and read the bytes of real run files.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe } from "vitest";

import { makeCause, type RunEvent } from "../ledger/events.ts";
import { Ledger } from "../ledger/ledger.ts";
import { readRun } from "../ledger/read.ts";
import { runPath, type RunId } from "../ledger/runId.ts";
import { LedgerIoError, LedgerNotFoundError } from "../ledger/errors.ts";
import { T0, catchLedgerError, useTempDirs } from "../ledger/testSupport.ts";
import { readProgress } from "./progress.ts";
import {
  STOP_REQUESTS_DIR,
  leaveStopRequest,
  notBuildingMessage,
  requestStop,
  stopRequestPath,
  takeStopRequest,
} from "./stop.ts";

const tempDir = useTempDirs();

const run10: RunId = { repo: "rawphp/softfac", issue: "10", attempt: 1 };

const BUILDING: ReadonlyArray<RunEvent> = [
  { event: "claimed", data: { machine: "mac-mini", github_user: "rawphp" } },
  { event: "state_changed", data: { from: "ready", to: "triage" } },
  { event: "state_changed", data: { from: "triage", to: "building" } },
];

const FINISHED: RunEvent = {
  event: "finished",
  data: {
    outcome: "stuck",
    total_ms: 0,
    gate_attempts: 0,
    review_cycles: null,
    pr_url: null,
    pr_end: null,
  },
};

const seed = (dataDir: string, events: ReadonlyArray<RunEvent>) => {
  const ledger = Ledger.create(dataDir, run10, { clock: () => T0 });
  try {
    for (const event of events) ledger.append(event, makeCause("start", "seed"));
  } finally {
    ledger.close();
  }
};

/** What `stop-run.sh` leaves: the word `operator` and a newline. */
const request = (dataDir: string) => {
  const path = stopRequestPath(dataDir, run10);
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  NodeFS.writeFileSync(path, "operator\n");
  return path;
};

const bytesOf = (dataDir: string) => NodeFS.readFileSync(runPath(dataDir, run10), "utf8");

describe("takeStopRequest", () => {
  it("keeps its requests in a directory of the data dir, one file per run", () => {
    assert.strictEqual(STOP_REQUESTS_DIR, "stop-requests");
    assert.strictEqual(
      stopRequestPath("/data", run10),
      NodePath.join("/data", "stop-requests", "rawphp__softfac__10__1"),
    );
  });

  it.effect("is none, and writes nothing, when no one asked", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      seed(dataDir, BUILDING);
      const bytes = bytesOf(dataDir);
      assert.strictEqual(yield* takeStopRequest(dataDir, run10, () => T0 + 5), "none");
      assert.strictEqual(bytesOf(dataDir), bytes);
    }),
  );

  it.effect("records the request in the ledger and removes the file", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      seed(dataDir, BUILDING);
      const path = request(dataDir);
      assert.strictEqual(yield* takeStopRequest(dataDir, run10, () => T0 + 5), "recorded");
      const last = readRun(dataDir, run10).entries.at(-1)!;
      assert.strictEqual(last.event, "stop_requested");
      assert.deepStrictEqual(last.data, { by: "operator" });
      assert.strictEqual(last.ms, T0 + 5);
      assert.deepStrictEqual(last.cause, makeCause("operator", "stop-requested"));
      assert.strictEqual(NodeFS.existsSync(path), false);
    }),
  );

  it.effect("finds the line already there, as after a crash before the file was removed", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      seed(dataDir, [...BUILDING, { event: "stop_requested", data: { by: "operator" } }]);
      const path = request(dataDir);
      const bytes = bytesOf(dataDir);
      assert.strictEqual(yield* takeStopRequest(dataDir, run10, () => T0 + 5), "already-requested");
      assert.strictEqual(bytesOf(dataDir), bytes);
      assert.strictEqual(NodeFS.existsSync(path), false);
    }),
  );

  it.effect("writes nothing to a run that finished, and removes the file", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      seed(dataDir, [...BUILDING, FINISHED]);
      const path = request(dataDir);
      const bytes = bytesOf(dataDir);
      assert.strictEqual(yield* takeStopRequest(dataDir, run10, () => T0 + 5), "finished");
      assert.strictEqual(bytesOf(dataDir), bytes);
      assert.strictEqual(NodeFS.existsSync(path), false);
    }),
  );

  it.effect.each<{ name: string; events: ReadonlyArray<RunEvent> }>([
    {
      name: "pr-open",
      events: [...BUILDING, { event: "state_changed", data: { from: "building", to: "pr-open" } }],
    },
    {
      name: "needs-info",
      events: [
        ...BUILDING,
        { event: "state_changed", data: { from: "building", to: "needs-info" } },
      ],
    },
    { name: "no state yet", events: [BUILDING[0]!] },
  ])("drops a request for a run at $name: no line, the file removed", ({ events }) =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      seed(dataDir, events);
      const path = request(dataDir);
      const bytes = bytesOf(dataDir);
      assert.strictEqual(yield* takeStopRequest(dataDir, run10, () => T0 + 5), "not-building");
      assert.strictEqual(bytesOf(dataDir), bytes);
      assert.strictEqual(NodeFS.existsSync(path), false);
    }),
  );

  it.effect("is an error when the run has no ledger, and the file is kept", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      const path = request(dataDir);
      const error = yield* Effect.flip(takeStopRequest(dataDir, run10, () => T0));
      assert.strictEqual(error._tag, "LedgerNotFoundError");
      assert.strictEqual(NodeFS.existsSync(path), true);
    }),
  );
});

describe("requestStop", () => {
  it("records a stop for a building run, once", () => {
    const dataDir = tempDir();
    seed(dataDir, BUILDING);
    assert.strictEqual(requestStop(dataDir, run10, () => T0 + 5).outcome, "recorded");
    const lines = readRun(dataDir, run10).entries;
    const last = lines.at(-1)!;
    assert.strictEqual(last.event, "stop_requested");
    assert.deepStrictEqual(last.data, { by: "operator" });
    assert.strictEqual(last.ms, T0 + 5);
    assert.deepStrictEqual(last.cause, { step: "operator", reason: "stop-requested" });
    const bytes = bytesOf(dataDir);
    assert.strictEqual(requestStop(dataDir, run10, () => T0 + 9).outcome, "already-requested");
    assert.strictEqual(bytesOf(dataDir), bytes);
  });

  it("writes nothing to a run that finished", () => {
    const dataDir = tempDir();
    seed(dataDir, [...BUILDING, FINISHED]);
    const bytes = bytesOf(dataDir);
    assert.strictEqual(requestStop(dataDir, run10, () => T0 + 5).outcome, "finished");
    assert.strictEqual(bytesOf(dataDir), bytes);
  });

  it.each(["triage", "needs-info", "pr-open"] as const)(
    "writes nothing to a run in %s",
    (state) => {
      const dataDir = tempDir();
      seed(dataDir, [
        { event: "claimed", data: { machine: "mac-mini", github_user: "rawphp" } },
        { event: "state_changed", data: { from: "ready", to: state } },
      ]);
      const bytes = bytesOf(dataDir);
      assert.strictEqual(requestStop(dataDir, run10, () => T0 + 5).outcome, "not-building");
      assert.strictEqual(bytesOf(dataDir), bytes);
    },
  );

  it("writes nothing to a run with no state yet", () => {
    const dataDir = tempDir();
    seed(dataDir, [BUILDING[0]!]);
    assert.strictEqual(requestStop(dataDir, run10, () => T0 + 5).outcome, "not-building");
  });

  it("fails for a run with no ledger", () => {
    catchLedgerError(() => requestStop(tempDir(), run10, () => T0), LedgerNotFoundError);
  });

  it("returns the progress it read, so a refusal needs no second read", () => {
    const dataDir = tempDir();
    seed(dataDir, [
      ...BUILDING,
      { event: "state_changed", data: { from: "building", to: "pr-open" } },
    ]);
    const { outcome, seen } = requestStop(dataDir, run10, () => T0 + 5);
    assert.strictEqual(outcome, "not-building");
    assert.strictEqual(seen.state, "pr-open");
    assert.match(notBuildingMessage("id", seen), /its state is pr-open/);
  });
});

describe("leaveStopRequest", () => {
  const STOP_LINE: RunEvent = { event: "stop_requested", data: { by: "operator" } };
  const PR_OPEN: RunEvent = { event: "state_changed", data: { from: "building", to: "pr-open" } };

  it("leaves the request stop-run.sh leaves for a building run, and writes no ledger line", () => {
    const dataDir = tempDir();
    seed(dataDir, BUILDING);
    const bytes = bytesOf(dataDir);
    assert.strictEqual(leaveStopRequest(dataDir, run10).outcome, "recorded");
    assert.strictEqual(NodeFS.readFileSync(stopRequestPath(dataDir, run10), "utf8"), "operator\n");
    assert.strictEqual(bytesOf(dataDir), bytes);
  });

  it("is already-requested when a request waits, and leaves it as it was", () => {
    const dataDir = tempDir();
    seed(dataDir, BUILDING);
    const path = request(dataDir);
    NodeFS.writeFileSync(path, "by the script\n");
    assert.strictEqual(leaveStopRequest(dataDir, run10).outcome, "already-requested");
    assert.strictEqual(NodeFS.readFileSync(path, "utf8"), "by the script\n");
  });

  it("is already-requested when a building run's ledger has the stop line, and leaves no file", () => {
    const dataDir = tempDir();
    seed(dataDir, [...BUILDING, STOP_LINE]);
    assert.strictEqual(leaveStopRequest(dataDir, run10).outcome, "already-requested");
    assert.strictEqual(NodeFS.existsSync(stopRequestPath(dataDir, run10)), false);
  });

  it("refuses a pr-open run with a stale stop line, as not building", () => {
    const dataDir = tempDir();
    seed(dataDir, [...BUILDING, STOP_LINE, PR_OPEN]);
    const { outcome, seen } = leaveStopRequest(dataDir, run10);
    assert.strictEqual(outcome, "not-building");
    assert.match(notBuildingMessage("id", seen), /its state is pr-open/);
    assert.strictEqual(NodeFS.existsSync(stopRequestPath(dataDir, run10)), false);
  });

  it("refuses a finished run and a run with no state yet, and leaves no file", () => {
    const finished = tempDir();
    seed(finished, [...BUILDING, FINISHED]);
    assert.strictEqual(leaveStopRequest(finished, run10).outcome, "finished");
    assert.strictEqual(NodeFS.existsSync(stopRequestPath(finished, run10)), false);
    const fresh = tempDir();
    seed(fresh, [BUILDING[0]!]);
    assert.strictEqual(leaveStopRequest(fresh, run10).outcome, "not-building");
    assert.strictEqual(NodeFS.existsSync(stopRequestPath(fresh, run10)), false);
  });

  it("fails for a run with no ledger, and leaves no file", () => {
    const dataDir = tempDir();
    catchLedgerError(() => leaveStopRequest(dataDir, run10), LedgerNotFoundError);
    assert.strictEqual(NodeFS.existsSync(stopRequestPath(dataDir, run10)), false);
  });

  it("is already-requested when a request appears between the check and the write, and keeps it", () => {
    const dataDir = tempDir();
    seed(dataDir, BUILDING);
    // A dangling symlink is missing to the existence check, but the exclusive write meets it.
    const path = stopRequestPath(dataDir, run10);
    NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
    NodeFS.symlinkSync(NodePath.join(dataDir, "nowhere"), path);
    assert.strictEqual(leaveStopRequest(dataDir, run10).outcome, "already-requested");
    assert.strictEqual(NodeFS.readlinkSync(path), NodePath.join(dataDir, "nowhere"));
    assert.strictEqual(NodeFS.existsSync(NodePath.join(dataDir, "nowhere")), false);
  });

  it("fails with LedgerIoError when the request cannot be written, and writes no ledger line", () => {
    const dataDir = tempDir();
    seed(dataDir, BUILDING);
    const bytes = bytesOf(dataDir);
    // A file where the requests directory belongs: the request cannot be made under it.
    NodeFS.writeFileSync(NodePath.join(dataDir, STOP_REQUESTS_DIR), "");
    catchLedgerError(() => leaveStopRequest(dataDir, run10), LedgerIoError);
    assert.strictEqual(bytesOf(dataDir), bytes);
  });

  // Root writes into a read-only directory, so the failure cannot be set up that way as root.
  it.skipIf(process.getuid?.() === 0)(
    "fails with LedgerIoError when the requests directory exists but cannot be written, and leaves no request",
    () => {
      const dataDir = tempDir();
      seed(dataDir, BUILDING);
      const dir = NodePath.join(dataDir, STOP_REQUESTS_DIR);
      NodeFS.mkdirSync(dir);
      NodeFS.chmodSync(dir, 0o500);
      try {
        catchLedgerError(() => leaveStopRequest(dataDir, run10), LedgerIoError);
        assert.strictEqual(NodeFS.existsSync(stopRequestPath(dataDir, run10)), false);
      } finally {
        NodeFS.chmodSync(dir, 0o700);
      }
    },
  );

  it.effect("leaves a request the pass takes into the ledger", () =>
    Effect.gen(function* () {
      const dataDir = tempDir();
      seed(dataDir, BUILDING);
      leaveStopRequest(dataDir, run10);
      assert.strictEqual(yield* takeStopRequest(dataDir, run10, () => T0 + 5), "recorded");
      assert.strictEqual(readRun(dataDir, run10).entries.at(-1)!.event, "stop_requested");
    }),
  );
});

describe("notBuildingMessage", () => {
  const messageFor = (events: ReadonlyArray<RunEvent>) => {
    const dataDir = tempDir();
    seed(dataDir, events);
    return notBuildingMessage("ID", readProgress(readRun(dataDir, run10).entries));
  };
  const moved = (to: string): RunEvent =>
    ({ event: "state_changed", data: { from: "ready", to } }) as RunEvent;

  it("says a finished run is finished, with no way out", () => {
    assert.strictEqual(
      messageFor([...BUILDING, FINISHED]),
      "run ID is not building: it is finished. Only a building run is stopped this way.",
    );
  });

  it("says how a run in another state ends instead", () => {
    const base = "run ID is not building: its state is";
    const tail = "Only a building run is stopped this way.";
    assert.strictEqual(
      messageFor([BUILDING[0]!, moved("pr-open")]),
      `${base} pr-open. ${tail} It ends when its pull request is merged or closed.`,
    );
    assert.strictEqual(
      messageFor([BUILDING[0]!, moved("triage")]),
      `${base} triage. ${tail} To end it, close its issue.`,
    );
    assert.strictEqual(
      messageFor([BUILDING[0]!, moved("needs-info")]),
      `${base} needs-info. ${tail} To end it, close its issue.`,
    );
    assert.strictEqual(messageFor([BUILDING[0]!, moved("stuck")]), `${base} stuck. ${tail}`);
  });

  it("says a run with no state has none yet", () => {
    assert.strictEqual(
      messageFor([BUILDING[0]!]),
      "run ID is not building: it has no state yet. Only a building run is stopped this way. To end it, close its issue.",
    );
  });
});
