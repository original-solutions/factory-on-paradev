// @effect-diagnostics nodeBuiltinImport:off - stdout and stderr are written through their file descriptors once their streams break.
/**
 * Keeps a failed write to stdout or stderr from ending the server. A failed stream emits `error`,
 * which with no listener is an uncaught exception (under launchd a full disk killed the server).
 * Node never writes to a failed stream again, so later lines go straight to its file descriptor.
 * Dropped lines are counted and reported in one `N log lines dropped (<code>)` line on recovery.
 */
import * as NodeFS from "node:fs";
import type * as NodeStream from "node:stream";

type WriteFd = (fd: number, data: Uint8Array) => void;

/** A nearly full disk can take part of a line without an error, so the rest is written again. */
const writeAll: WriteFd = (fd, data) => {
  let offset = 0;
  while (offset < data.length) offset += NodeFS.writeSync(fd, data, offset);
};

const guarded = new WeakSet<NodeStream.Writable>();

const errorCode = (error: unknown): string =>
  typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : "unknown";

/** Guards `stream`, whose file descriptor is `fd`. A stream already guarded is left as it is. */
export const guardLogStream = (
  stream: NodeStream.Writable,
  fd: number,
  writeFd: WriteFd = writeAll,
): void => {
  if (guarded.has(stream)) return;
  guarded.add(stream);
  let broken = false;
  let dropped = 0;
  let code = "unknown";
  const drop = (error: unknown) => {
    dropped += 1;
    code = errorCode(error);
  };
  // Without a listener the error ends the process. Each failed line is counted by its own write
  // callback instead, once, whether the stream reports it before or after this event.
  stream.on("error", () => {
    broken = true;
  });
  const write = stream.write.bind(stream);
  stream.write = ((
    chunk: string | Uint8Array,
    encodingOrDone?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ) => {
    const encoding = typeof encodingOrDone === "function" ? undefined : encodingOrDone;
    const done = typeof encodingOrDone === "function" ? encodingOrDone : callback;
    if (!broken && !stream.destroyed && !stream.errored) {
      const counted = (error?: Error | null) => {
        if (error) {
          broken = true;
          drop(error);
        }
        done?.(error);
      };
      return encoding === undefined ? write(chunk, counted) : write(chunk, encoding, counted);
    }
    broken = true;
    try {
      if (dropped > 0) {
        writeFd(fd, Buffer.from(`${dropped} log lines dropped (${code})\n`));
        dropped = 0;
      }
      writeFd(fd, typeof chunk === "string" ? Buffer.from(chunk, encoding) : chunk);
    } catch (error) {
      drop(error);
    }
    if (done !== undefined) process.nextTick(done);
    return true;
  }) as NodeStream.Writable["write"];
};

/** Guards the process's stdout and stderr. `index.ts` calls it when server.ts imports it. */
export const guardLogStreams = (): void => {
  guardLogStream(process.stdout, 1);
  guardLogStream(process.stderr, 2);
};
