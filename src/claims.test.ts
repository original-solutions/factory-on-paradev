// @effect-diagnostics globalDate:off - one test sets a file's mtime with the wall clock type node wants.
// @effect-diagnostics nodeBuiltinImport:off - the tests read and lay out real files.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vitest";

import {
  PAUSE_FILE,
  loadHandPause,
  pauseClaims,
  resumeClaims,
} from "./claims.ts";
import { formatTs } from "./ledger/time.ts";
import { T0, useTempDirs } from "./ledger/testSupport.ts";

const tempDir = useTempDirs();

const pauseFile = (dataDir: string) => NodePath.join(dataDir, PAUSE_FILE);

const WHOLE_SECOND = T0 - (T0 % 1000);

describe("claims paused by hand", () => {
  it("pause writes the time privately", () => {
    const dataDir = tempDir();
    expect(pauseClaims(dataDir, T0)).toEqual({ kind: "now" });
    expect(NodeFS.readFileSync(pauseFile(dataDir), "utf8")).toBe(`${formatTs(T0)}\n`);
    expect(NodeFS.statSync(pauseFile(dataDir)).mode & 0o777).toBe(0o600);
    expect(loadHandPause(dataDir)).toEqual({ sinceMs: T0 });
  });

  it("a second pause keeps the first time", () => {
    const dataDir = tempDir();
    pauseClaims(dataDir, T0);
    expect(pauseClaims(dataDir, T0 + 60_000)).toEqual({ kind: "already", sinceMs: T0 });
    expect(NodeFS.readFileSync(pauseFile(dataDir), "utf8")).toBe(`${formatTs(T0)}\n`);
  });

  it("resume removes the file and says when there was none", () => {
    const dataDir = tempDir();
    expect(resumeClaims(dataDir)).toBe(false);
    pauseClaims(dataDir, T0);
    expect(resumeClaims(dataDir)).toBe(true);
    expect(NodeFS.existsSync(pauseFile(dataDir))).toBe(false);
    expect(loadHandPause(dataDir)).toBeNull();
  });

  it("a file a person wrote is still a pause, since its mtime", () => {
    const dataDir = tempDir();
    NodeFS.writeFileSync(pauseFile(dataDir), "paused by tom\n");
    // A whole second: `utimes` takes seconds as a float, which cannot hold every millisecond.
    NodeFS.utimesSync(pauseFile(dataDir), new Date(WHOLE_SECOND), new Date(WHOLE_SECOND));
    expect(loadHandPause(dataDir)).toEqual({ sinceMs: WHOLE_SECOND });
  });

  it("the time in the file is trimmed and parsed", () => {
    const dataDir = tempDir();
    NodeFS.writeFileSync(pauseFile(dataDir), `  ${formatTs(T0 + 5)}  \n\n`);
    expect(loadHandPause(dataDir)).toEqual({ sinceMs: T0 + 5 });
  });

  it("a missing file and a symlink are no pause", () => {
    const dataDir = tempDir();
    expect(loadHandPause(dataDir)).toBeNull();
    const target = NodePath.join(dataDir, "elsewhere");
    NodeFS.writeFileSync(target, formatTs(T0));
    NodeFS.symlinkSync(target, pauseFile(dataDir));
    expect(loadHandPause(dataDir)).toBeNull();
  });

  it("a file that cannot be opened is still a pause, since its mtime", () => {
    const dataDir = tempDir();
    NodeFS.writeFileSync(pauseFile(dataDir), formatTs(T0 + 5));
    NodeFS.utimesSync(pauseFile(dataDir), new Date(WHOLE_SECOND), new Date(WHOLE_SECOND));
    NodeFS.chmodSync(pauseFile(dataDir), 0o000);
    try {
      expect(() => NodeFS.readFileSync(pauseFile(dataDir))).toThrow();
      expect(loadHandPause(dataDir)).toEqual({ sinceMs: WHOLE_SECOND });
    } finally {
      NodeFS.chmodSync(pauseFile(dataDir), 0o600);
    }
  });

  it("a FIFO is no pause, and does not block the read", () => {
    const dataDir = tempDir();
    NodeChildProcess.execFileSync("mkfifo", [pauseFile(dataDir)]);
    expect(loadHandPause(dataDir)).toBeNull();
  });

  it("pausing in a data dir that is not there is an error", () => {
    const dataDir = NodePath.join(tempDir(), "missing");
    expect(() => pauseClaims(dataDir, T0)).toThrow();
    expect(NodeFS.existsSync(dataDir)).toBe(false);
  });
});
