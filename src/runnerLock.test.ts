// @effect-diagnostics nodeBuiltinImport:off - the lock is a real file, and a real process holds it.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vitest";

import { useTempDirs } from "./ledger/testSupport.ts";
import { isAlive, LOCK_FILE, takeRunnerLock } from "./runnerLock.ts";

const tempDir = useTempDirs();

/** A pid no process has: a child that has exited. */
const deadPid = (): number => {
  const child = NodeChildProcess.spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"]);
  const pid = Number(child.stdout.toString());
  expect(isAlive(pid)).toBe(false);
  return pid;
};

describe("the runner lock", () => {
  it("is taken with this pid, making the data dir, and released", () => {
    const dir = NodePath.join(tempDir(), "data");
    const lock = takeRunnerLock(dir, 4242, () => true);
    expect(lock.kind).toBe("taken");
    const file = NodePath.join(dir, LOCK_FILE);
    expect(NodeFS.readFileSync(file, "utf8")).toBe("4242\n");
    if (lock.kind === "taken") lock.release();
    expect(NodeFS.existsSync(file)).toBe(false);
  });

  it("is refused while another live runner holds it, naming its pid", () => {
    const dir = tempDir();
    takeRunnerLock(dir, 4242, () => true);
    const second = takeRunnerLock(dir, 5151, (pid) => pid === 4242);
    expect(second).toEqual({ kind: "held", path: NodePath.join(dir, LOCK_FILE), pid: 4242 });
    expect(NodeFS.readFileSync(NodePath.join(dir, LOCK_FILE), "utf8")).toBe("4242\n");
  });

  it("is taken over from a runner that is dead", () => {
    const dir = tempDir();
    const stale = deadPid();
    NodeFS.writeFileSync(NodePath.join(dir, LOCK_FILE), `${stale}\n`);
    const lock = takeRunnerLock(dir);
    expect(lock.kind).toBe("taken");
    expect(NodeFS.readFileSync(NodePath.join(dir, LOCK_FILE), "utf8")).toBe(`${process.pid}\n`);
  });

  it("is taken over when the file holds no pid", () => {
    const dir = tempDir();
    NodeFS.writeFileSync(NodePath.join(dir, LOCK_FILE), "garbage\n");
    expect(takeRunnerLock(dir, 4242, () => true).kind).toBe("taken");
  });

  it("a release leaves a lock another runner has taken since", () => {
    const dir = tempDir();
    const lock = takeRunnerLock(dir, 4242, () => false);
    NodeFS.writeFileSync(NodePath.join(dir, LOCK_FILE), "5151\n");
    if (lock.kind === "taken") lock.release();
    expect(NodeFS.readFileSync(NodePath.join(dir, LOCK_FILE), "utf8")).toBe("5151\n");
  });

  it("counts this process as alive", () => {
    expect(isAlive(process.pid)).toBe(true);
  });
});

describe("factory-runner run", () => {
  it("exits 1 naming the pid when a live runner holds the lock", () => {
    const dir = tempDir();
    NodeFS.writeFileSync(NodePath.join(dir, LOCK_FILE), `${process.pid}\n`);
    const child = NodeChildProcess.spawnSync(
      process.execPath,
      [NodePath.join(import.meta.dirname, "bin.ts"), "run"],
      { env: { ...process.env, FACTORY_RUNNER_HOME: dir }, timeout: 30_000 },
    );
    expect(child.status).toBe(1);
    expect(child.stderr.toString()).toContain(`(pid ${process.pid})`);
  });

  it("answers anything but run with the usage and exit 2", () => {
    const child = NodeChildProcess.spawnSync(
      process.execPath,
      [NodePath.join(import.meta.dirname, "bin.ts"), "status"],
      { timeout: 30_000 },
    );
    expect(child.status).toBe(2);
    expect(child.stderr.toString()).toContain("usage: factory-runner run");
  });
});
