// @effect-diagnostics nodeBuiltinImport:off - the lock is a real file, and a real process holds it.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vitest";

import { useTempDirs } from "./ledger/testSupport.ts";
import { isAlive, isRunner, isRunnerCommand, LOCK_FILE, takeRunnerLock } from "./runnerLock.ts";

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

  it("knows a runner by its invocation, not by a path that names factory-runner", () => {
    for (const command of [
      "/usr/local/bin/node /Users/me/.local/share/factory-runner/current/src/bin.ts run",
      "node /usr/local/bin/factory-runner run",
      "node src/bin.ts run",
    ]) {
      expect(isRunnerCommand(command), command).toBe(true);
    }
    for (const command of [
      "node /Users/me/factory-runner/acme/widgets/node_modules/.bin/vitest run",
      "git -C /Users/me/factory-runner/acme/widgets fetch",
      "node /Users/me/other/bin.ts serve",
      "node /Users/me/factory-runner/src/bin.ts status",
    ]) {
      expect(isRunnerCommand(command), command).toBe(false);
    }
  });

  it("counts a live pid as a runner when ps cannot say, and a dead one as none", () => {
    expect(isRunner(process.pid, () => null)).toBe(true);
    expect(isRunner(deadPid(), () => null)).toBe(false);
    expect(isRunner(process.pid, () => "node /x/src/bin.ts run")).toBe(true);
    expect(isRunner(process.pid, () => "node /x/vitest.mjs run")).toBe(false);
  });

  it("counts this process as alive, and as no runner, since it does not run bin.ts", () => {
    expect(isAlive(process.pid)).toBe(true);
    expect(isRunner(process.pid)).toBe(false);
  });

  it("knows a live runner whose command line is longer than any terminal width", async () => {
    // A LaunchAgent's runner: an absolute node and an install path, well past 80 columns.
    const deep = NodePath.join(tempDir(), "x".repeat(200), "factory-runner", "current", "src", "bin.ts");
    const child = NodeChildProcess.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", deep, "run"], {
      stdio: "ignore",
    });
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      expect(isRunner(child.pid!)).toBe(true);
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("is taken over from a live pid that is no runner: the dead runner's pid, reused", () => {
    const dir = tempDir();
    NodeFS.writeFileSync(NodePath.join(dir, LOCK_FILE), `${process.pid}\n`);
    expect(takeRunnerLock(dir, 4242).kind).toBe("taken");
    expect(NodeFS.readFileSync(NodePath.join(dir, LOCK_FILE), "utf8")).toBe("4242\n");
  });

  it("is refused to a holder that is a runner", () => {
    const dir = tempDir();
    const holder = runnerLike();
    try {
      NodeFS.writeFileSync(NodePath.join(dir, LOCK_FILE), `${holder.pid}\n`);
      expect(isRunner(holder.pid!)).toBe(true);
      expect(takeRunnerLock(dir, 4242)).toMatchObject({ kind: "held", pid: holder.pid });
    } finally {
      holder.kill();
    }
  });

  it("puts back a lock another runner took over between the stale read and the takeover", () => {
    const dir = tempDir();
    const file = NodePath.join(dir, LOCK_FILE);
    NodeFS.writeFileSync(file, "1111\n");
    // While this taker judges 1111 stale, runner 2222 takes the lock over first.
    const lock = takeRunnerLock(dir, 4242, (pid) => {
      if (pid === 1111) {
        NodeFS.writeFileSync(file, "2222\n");
        return false;
      }
      return pid === 2222;
    });
    expect(lock).toEqual({ kind: "held", path: file, pid: 2222 });
    expect(NodeFS.readFileSync(file, "utf8")).toBe("2222\n");
    expect(NodeFS.readdirSync(dir)).toEqual([LOCK_FILE]);
  });

  it("leaves no file of its own behind but the lock", () => {
    const dir = tempDir();
    takeRunnerLock(dir, 4242, () => false);
    expect(NodeFS.readdirSync(dir)).toEqual([LOCK_FILE]);
  });
});

/** A live process whose command line runs `bin.ts run`, as a runner's does. Kill it when done. */
const runnerLike = () =>
  NodeChildProcess.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "/x/src/bin.ts", "run"], {
    stdio: "ignore",
  });

describe("factory-runner run", () => {
  it("exits 1 naming the pid when a live runner holds the lock", () => {
    const dir = tempDir();
    const holder = runnerLike();
    try {
      NodeFS.writeFileSync(NodePath.join(dir, LOCK_FILE), `${holder.pid}\n`);
      const child = NodeChildProcess.spawnSync(
        process.execPath,
        [NodePath.join(import.meta.dirname, "bin.ts"), "run"],
        { env: { ...process.env, FACTORY_RUNNER_HOME: dir }, timeout: 30_000 },
      );
      expect(child.status).toBe(1);
      expect(child.stderr.toString()).toContain(`(pid ${holder.pid})`);
    } finally {
      holder.kill();
    }
  });

  it("answers anything but run with the usage and exit 2", () => {
    const child = NodeChildProcess.spawnSync(
      process.execPath,
      [NodePath.join(import.meta.dirname, "bin.ts"), "frobnicate"],
      { timeout: 30_000 },
    );
    expect(child.status).toBe(2);
    expect(child.stderr.toString()).toContain("usage: factory-runner run");
  });
});
