// @effect-diagnostics nodeBuiltinImport:off - the tests lay out a fake HOME and data dir, and start bin.ts against them.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import { afterAll, beforeAll, describe } from "vitest";

import { installPathsOf, packageVersion } from "./paths.ts";
import { LOCK_FILE } from "./runnerLock.ts";
import { countStart, PENDING_FILE, REFUSED_FILE, refusedRow, type Start } from "./updateState.ts";

const NOW = Date.parse("2026-11-15T09:30:00.000Z");
const BIN = NodePath.resolve(import.meta.dirname, "bin.ts");
/** The version this checkout runs, which `bin.ts run` counts starts of. */
const RUNNING = packageVersion(NodePath.resolve(import.meta.dirname, ".."));

let tmp: string;

beforeAll(() => {
  tmp = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "factory-update-state-")));
});

afterAll(() => {
  NodeFS.rmSync(tmp, { recursive: true, force: true });
});

interface Fixture {
  /** HOME, with `versions/0.1.0` and `versions/0.2.0` installed and `current` on 0.2.0. */
  readonly home: string;
  readonly dataDir: string;
  readonly logs: Array<{ readonly level: string; readonly text: string }>;
}

const fixture = (): Fixture => {
  const home = NodeFS.mkdtempSync(NodePath.join(tmp, "home-"));
  const { versions, current } = installPathsOf(home);
  for (const version of ["0.1.0", "0.2.0"]) {
    NodeFS.mkdirSync(NodePath.join(versions, version, "src"), { recursive: true });
  }
  NodeFS.symlinkSync(NodePath.join(versions, "0.2.0"), current);
  const dataDir = NodePath.join(home, "data");
  NodeFS.mkdirSync(dataDir);
  return { home, dataDir, logs: [] };
};

const pendingFile = (f: Fixture) => NodePath.join(f.dataDir, PENDING_FILE);
const refusedFile = (f: Fixture) => NodePath.join(f.dataDir, REFUSED_FILE);
const writePendingFile = (f: Fixture, pending: object) => NodeFS.writeFileSync(pendingFile(f), JSON.stringify(pending));
const pendingOf = (f: Fixture) => JSON.parse(NodeFS.readFileSync(pendingFile(f), "utf8"));
const currentTarget = (f: Fixture) => NodeFS.readlinkSync(installPathsOf(f.home).current);
const versionPath = (f: Fixture, version: string) => NodePath.join(installPathsOf(f.home).versions, version);
const loud = (f: Fixture) => f.logs.filter((log) => log.level !== "Debug" && log.level !== "Trace");

const start = (f: Fixture, version = "0.2.0"): Effect.Effect<Start> =>
  countStart({ home: f.home, dataDir: f.dataDir, version, nowMs: () => NOW }).pipe(
    Effect.provide(
      Logger.layer(
        [
          Logger.make(({ message, logLevel }) => {
            const first = Array.isArray(message) ? message[0] : message;
            f.logs.push({ level: logLevel, text: typeof first === "string" ? first : String(first) });
          }),
        ],
        { mergeWithExisting: false },
      ),
    ),
  );

const GONE_BACK = "went back to v0.1.0 from v0.2.0: 3 starts without a pass";

describe("the start count of a self-installed version", () => {
  it.effect("does nothing with no pending file, or one for another version", () =>
    Effect.gen(function* () {
      const f = fixture();
      expect((yield* start(f)).kind).toBe("run");
      expect(NodeFS.existsSync(pendingFile(f))).toBe(false);
      writePendingFile(f, { from: "0.2.0", to: "0.3.0", starts: 0 });
      expect((yield* start(f)).kind).toBe("run");
      expect(pendingOf(f)).toEqual({ from: "0.2.0", to: "0.3.0", starts: 0 });
      expect(loud(f)).toEqual([]);
    }),
  );

  it.effect("counts 1, 2, 3 over three starts, and the fourth goes back to the version before", () =>
    Effect.gen(function* () {
      const f = fixture();
      writePendingFile(f, { from: "0.1.0", to: "0.2.0", starts: 0 });
      for (const starts of [1, 2, 3]) {
        expect((yield* start(f)).kind).toBe("run");
        expect(pendingOf(f)).toEqual({ from: "0.1.0", to: "0.2.0", starts });
      }
      expect(currentTarget(f)).toBe(versionPath(f, "0.2.0"));
      expect(loud(f)).toEqual([]);

      expect(yield* start(f)).toEqual({ kind: "exit", code: 0 });
      expect(currentTarget(f)).toBe(versionPath(f, "0.1.0"));
      expect(NodeFS.existsSync(pendingFile(f))).toBe(false);
      expect(JSON.parse(NodeFS.readFileSync(refusedFile(f), "utf8"))).toEqual({
        tag: "v0.2.0",
        from: "0.1.0",
        at: "2026-11-15T09:30:00.000Z",
      });
      expect(loud(f)).toEqual([{ level: "Warn", text: GONE_BACK }]);
    }),
  );

  it.effect("writes the refused file before it moves current: a current that cannot move exits 1 and tries again next start", () =>
    Effect.gen(function* () {
      const f = fixture();
      writePendingFile(f, { from: "0.1.0", to: "0.2.0", starts: 3 });
      const share = installPathsOf(f.home).share;
      NodeFS.chmodSync(share, 0o500);
      let first: Start;
      try {
        first = yield* start(f);
      } finally {
        NodeFS.chmodSync(share, 0o755);
      }
      expect(first).toEqual({ kind: "exit", code: 1 });
      expect(NodeFS.existsSync(refusedFile(f))).toBe(true);
      expect(currentTarget(f)).toBe(versionPath(f, "0.2.0"));
      expect(pendingOf(f).starts).toBe(3);
      expect(loud(f)).toHaveLength(1);
      expect(loud(f)[0]!.text).toContain("cannot go back from v0.2.0: pointing current at versions/0.1.0 failed");

      expect(yield* start(f)).toEqual({ kind: "exit", code: 0 });
      expect(currentTarget(f)).toBe(versionPath(f, "0.1.0"));
    }),
  );

  it.effect("a refused file that cannot be written still moves current, and the line says the tag can be staged again", () =>
    Effect.gen(function* () {
      const f = fixture();
      writePendingFile(f, { from: "0.1.0", to: "0.2.0", starts: 3 });
      NodeFS.mkdirSync(refusedFile(f));
      expect(yield* start(f)).toEqual({ kind: "exit", code: 0 });
      expect(currentTarget(f)).toBe(versionPath(f, "0.1.0"));
      expect(NodeFS.existsSync(pendingFile(f))).toBe(false);
      expect(loud(f)).toHaveLength(1);
      expect(loud(f)[0]!.text).toMatch(
        new RegExp(`^${GONE_BACK}; v0\\.2\\.0 can be staged again, since ${REFUSED_FILE} was not written: `),
      );
    }),
  );

  it.effect("a versions/<from> that is gone leaves current, removes the pending file and starts as usual", () =>
    Effect.gen(function* () {
      const f = fixture();
      writePendingFile(f, { from: "0.1.0", to: "0.2.0", starts: 3 });
      NodeFS.rmSync(versionPath(f, "0.1.0"), { recursive: true });
      expect((yield* start(f)).kind).toBe("run");
      expect(currentTarget(f)).toBe(versionPath(f, "0.2.0"));
      expect(NodeFS.existsSync(pendingFile(f))).toBe(false);
      expect(NodeFS.existsSync(refusedFile(f))).toBe(false);
      expect(loud(f)).toEqual([{ level: "Warn", text: "cannot go back from v0.2.0: versions/0.1.0 is gone" }]);
    }),
  );

  it.effect("a start that ends on a held lock takes its count back", () =>
    Effect.gen(function* () {
      const f = fixture();
      writePendingFile(f, { from: "0.1.0", to: "0.2.0", starts: 1 });
      const counted = yield* start(f);
      expect(pendingOf(f).starts).toBe(2);
      if (counted.kind !== "run") throw new Error("expected a run");
      yield* counted.giveBack;
      expect(pendingOf(f)).toEqual({ from: "0.1.0", to: "0.2.0", starts: 1 });
      // A pass of the runner holding the lock cleared the file in between: nothing to give back.
      const again = yield* start(f);
      NodeFS.rmSync(pendingFile(f));
      if (again.kind !== "run") throw new Error("expected a run");
      yield* again.giveBack;
      expect(NodeFS.existsSync(pendingFile(f))).toBe(false);
    }),
  );

  it.effect("a count that cannot be written is one warning, and the start goes on", () =>
    Effect.gen(function* () {
      const f = fixture();
      writePendingFile(f, { from: "0.1.0", to: "0.2.0", starts: 1 });
      NodeFS.chmodSync(f.dataDir, 0o500);
      let counted: Start;
      try {
        counted = yield* start(f);
      } finally {
        NodeFS.chmodSync(f.dataDir, 0o755);
      }
      expect(counted.kind).toBe("run");
      expect(pendingOf(f).starts).toBe(1);
      expect(loud(f)).toHaveLength(1);
      expect(loud(f)[0]!.level).toBe("Warn");
      expect(loud(f)[0]!.text).toContain("this start of v0.2.0 was not counted");
    }),
  );

  it.effect("a pending file that cannot be read or parsed is one warning, and the start goes on", () =>
    Effect.gen(function* () {
      const f = fixture();
      for (const text of ["{not json", JSON.stringify({ from: "v0.1.0", to: "0.2.0", starts: 3 })]) {
        f.logs.length = 0;
        NodeFS.writeFileSync(pendingFile(f), text);
        expect((yield* start(f)).kind).toBe("run");
        expect(NodeFS.readFileSync(pendingFile(f), "utf8")).toBe(text);
        expect(currentTarget(f)).toBe(versionPath(f, "0.2.0"));
        expect(loud(f)).toHaveLength(1);
        expect(loud(f)[0]!.text).toContain("the pending update could not be read, so this start is not counted");
      }
    }),
  );
});

describe("the status row of a refused tag", () => {
  it("says which tag was refused and what runs, from the refused file", () => {
    const f = fixture();
    NodeFS.writeFileSync(
      refusedFile(f),
      JSON.stringify({ tag: "v0.2.0", from: "0.1.0", at: "2026-11-15T09:30:00Z" }),
    );
    expect(refusedRow(f.dataDir)).toEqual({
      id: "update-refused",
      kind: "update-refused",
      repo: null,
      issue: null,
      run: null,
      message: "v0.2.0 could not complete a pass after its restart; running v0.1.0. A newer tag installs as usual.",
      first_seen: "2026-11-15T09:30:00.000Z",
    });
  });

  it("is none with no file, or one that cannot be read", () => {
    const f = fixture();
    expect(refusedRow(f.dataDir)).toBeNull();
    NodeFS.writeFileSync(refusedFile(f), "{not json");
    expect(refusedRow(f.dataDir)).toBeNull();
  });
});

describe("bin.ts run and the start count", () => {
  /** `bin.ts run` with HOME and the data dir in the fixture, so nothing of this machine is touched. */
  const runBin = (f: Fixture) =>
    NodeChildProcess.spawnSync(process.execPath, [BIN, "run"], {
      encoding: "utf8",
      timeout: 30_000,
      env: { ...process.env, HOME: f.home, FACTORY_RUNNER_HOME: f.dataDir },
    });

  it("goes back before the lock and any layer, and exits 0 so launchd starts current again", () => {
    const f = fixture();
    writePendingFile(f, { from: "0.1.0", to: RUNNING, starts: 3 });
    const done = runBin(f);
    expect(done.status, done.stderr).toBe(0);
    expect(`${done.stdout}${done.stderr}`).toContain(`went back to v0.1.0 from v${RUNNING}: 3 starts without a pass`);
    expect(currentTarget(f)).toBe(versionPath(f, "0.1.0"));
    expect(NodeFS.existsSync(pendingFile(f))).toBe(false);
    expect(NodeFS.existsSync(NodePath.join(f.dataDir, LOCK_FILE))).toBe(false);
  });

  it("a start that finds the lock held exits 1 and is not counted", () => {
    const f = fixture();
    writePendingFile(f, { from: "0.1.0", to: RUNNING, starts: 1 });
    // A live process whose command line is a runner's: the lock is held, not stale.
    const holder = NodeChildProcess.spawn(
      process.execPath,
      ["-e", "setTimeout(() => {}, 120_000)", NodePath.join(f.home, "held-lock-holder", "bin.ts"), "run"],
      { stdio: "ignore" },
    );
    try {
      NodeFS.writeFileSync(NodePath.join(f.dataDir, LOCK_FILE), `${holder.pid}\n`);
      const done = runBin(f);
      expect(done.status).toBe(1);
      expect(done.stderr).toContain("another runner holds");
      expect(pendingOf(f)).toEqual({ from: "0.1.0", to: RUNNING, starts: 1 });
    } finally {
      holder.kill();
    }
  });
});
