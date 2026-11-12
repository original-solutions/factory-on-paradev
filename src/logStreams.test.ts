// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - the guard patches real Node streams, which a Node Console writes to, and a child process proves it.
import * as NodeChildProcess from "node:child_process";
import * as NodeConsole from "node:console";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";
import * as NodeURL from "node:url";

import { assert } from "@effect/vitest";
import { describe, it } from "vitest";

import { useTempDirs } from "./ledger/testSupport.ts";
import { guardLogStream } from "./logStreams.ts";

const factoryDir = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
/** The module bin.ts imports for FactoryLayer. */
const factoryModule = NodeURL.pathToFileURL(NodePath.join(factoryDir, "main.ts")).href;
const tempDir = useTempDirs();

const enospc = () =>
  Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });

/** A stream that records what reaches it and fails every write while `full` says so. */
const fakeLog = () => {
  const state = { full: false, streamed: [] as Array<string>, fd: [] as Array<string> };
  const stream = new NodeStream.Writable({
    write(chunk, _encoding, callback) {
      if (state.full) return callback(enospc());
      state.streamed.push(String(chunk));
      callback();
    },
  });
  guardLogStream(stream, 1, (_fd, data) => {
    if (state.full) throw enospc();
    state.fd.push(String(data));
  });
  return { state, stream, log: new NodeConsole.Console(stream) };
};

/**
 * Runs a child that imports the factory, as bin.ts does, then logs on every turn of the event
 * loop with a stdout whose every write fails, and answers how it ended.
 */
const runChild = async (stdout: "closed pipe" | "read-only file") => {
  const script = [
    `await import(${JSON.stringify(factoryModule)});`,
    `for (let i = 0; i < 20; i++) {`,
    `  console.log("line " + i);`,
    `  await new Promise((resolve) => setImmediate(resolve));`,
    `}`,
    `process.stderr.write("alive\\n");`,
  ].join("\n");
  const file = NodePath.join(tempDir("log"), "runner.log");
  NodeFS.writeFileSync(file, "");
  // A file opened for reading fails every write with EBADF: stdout is then the same kind of
  // stream as the log file launchd gives the runner.
  const fd = stdout === "read-only file" ? NodeFS.openSync(file, "r") : "pipe";
  const child = NodeChildProcess.spawn(
    process.execPath,
    ["--input-type=module", "--no-warnings", "-e", script],
    { cwd: NodePath.resolve(factoryDir, ".."), stdio: ["ignore", fd, "pipe"], timeout: 30_000 },
  );
  if (typeof fd === "number") NodeFS.closeSync(fd);
  // Nobody reads a closed pipe, so every write the child makes to it fails with EPIPE.
  child.stdout?.destroy();
  let stderr = "";
  child.stderr!.setEncoding("utf8").on("data", (text: string) => (stderr += text));
  const [status, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) =>
    child.on("close", (code, killed) => resolve([code, killed])),
  );
  return { status, signal, stderr };
};

describe("guardLogStream", () => {
  it("drops lines while the disk is full and says how many on the first write that succeeds", async () => {
    const { state, stream, log } = fakeLog();
    log.log("zero");
    assert.notExists(await new Promise((resolve) => stream.write("ok\n", resolve)));
    assert.notExists(await new Promise((resolve) => stream.write("6f6b320a", "hex", resolve)));
    assert.deepEqual(state.streamed, ["zero\n", "ok\n", "ok2\n"]);

    // The failed write destroys the stream: "close" is its last event, after the queued error.
    const closed = new Promise<void>((resolve) => stream.once("close", () => resolve()));
    state.full = true;
    const failed = new Promise<unknown>((resolve) => stream.write("one\n", resolve));
    log.log("two");
    assert.propertyVal(await failed, "code", "ENOSPC");
    await closed;
    log.log("three");
    // A writer that waits on its callback is not left hanging by a dropped line.
    const written = await new Promise((resolve) => stream.write("four\n", resolve));
    assert.isUndefined(written);
    const encoded = await new Promise((resolve) => stream.write("five\n", "utf8", resolve));
    assert.isUndefined(encoded);
    assert.deepEqual(state.fd, []);

    state.full = false;
    log.log("back");
    stream.write("616761696e0a", "hex");
    assert.deepEqual(state.streamed, ["zero\n", "ok\n", "ok2\n"]);
    assert.deepEqual(state.fd, ["5 log lines dropped (ENOSPC)\n", "back\n", "again\n"]);
  });

  it("writes the lines of a stream that was destroyed to its file descriptor", () => {
    const { state, stream, log } = fakeLog();
    stream.destroy();
    log.log("after");
    assert.deepEqual(state.fd, ["after\n"]);
  });

  // The guard is in place as soon as bin.ts imports the factory, before any layer builds, so a
  // full disk during startup cannot end the runner either.
  it.each(["read-only file", "closed pipe"] as const)(
    "keeps a process that imported the factory alive when its stdout is a %s",
    async (stdout) => {
      const child = await runChild(stdout);
      assert.deepStrictEqual([child.status, child.signal], [0, null], child.stderr);
      assert.strictEqual(child.stderr, "alive\n");
    },
  );

  it("writes stdout to fd 1 and stderr to fd 2 once each stream has failed a write", () => {
    const dir = tempDir("log");
    const files = [NodePath.join(dir, "out.log"), NodePath.join(dir, "err.log")];
    const fds = files.map((file) => NodeFS.openSync(file, "w"));
    // Each stream fails one write the way a full disk fails it; fd 1 and 2 still have room.
    const script = [
      `await import(${JSON.stringify(factoryModule)});`,
      `const full = (_chunk, _encoding, callback) =>`,
      `  callback(Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" }));`,
      `process.stdout._write = full;`,
      `process.stderr._write = full;`,
      `console.log("lost");`,
      `console.error("lost");`,
      `await new Promise((resolve) => setImmediate(resolve));`,
      `console.log("out");`,
      `console.error("err");`,
    ].join("\n");
    const child = NodeChildProcess.spawnSync(
      process.execPath,
      ["--input-type=module", "--no-warnings", "-e", script],
      { cwd: NodePath.resolve(factoryDir, ".."), stdio: ["ignore", ...fds], timeout: 30_000 },
    );
    for (const fd of fds) NodeFS.closeSync(fd);
    const [out, err] = files.map((file) => NodeFS.readFileSync(file, "utf8"));
    assert.strictEqual(child.status, 0, err);
    assert.strictEqual(out, "1 log lines dropped (ENOSPC)\nout\n");
    assert.strictEqual(err, "1 log lines dropped (ENOSPC)\nerr\n");
  });
});
