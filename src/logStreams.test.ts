// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - the guard patches real Node streams, which a Node Console writes to.
import * as NodeConsole from "node:console";
import * as NodeStream from "node:stream";

import { assert } from "@effect/vitest";
import { describe, it } from "vitest";

import { guardLogStream } from "./logStreams.ts";

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
});
