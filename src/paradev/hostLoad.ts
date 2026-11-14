/**
 * A host's load over SSH: the 1-minute figure and the core count the pass reads once for every
 * configured host, before any launch.
 */
import * as Effect from "effect/Effect";

import type { HostConfig } from "../config.ts";
import type { Load } from "../load.ts";
import { LOAD_COMMAND, runSsh, type SshSpawn } from "./ssh.ts";

/**
 * The host's answer to the load command: macOS prints `{ 1.52 1.73 1.80 }` then the core count,
 * Linux prints `/proc/loadavg` then the core count. The 1-minute load is the second field of the
 * first line on macOS and its first field on Linux; the cores are the last line. Null for any
 * other text.
 */
export const parseLoad = (text: string): Load | null => {
  const lines = text.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  if (lines.length < 2) return null;
  const first = lines[0]!.split(/\s+/);
  const field = lines[0]!.startsWith("{") ? first[1] : first[0];
  const coresText = lines[lines.length - 1]!;
  if (field === undefined || !/^[0-9]+$/.test(coresText)) return null;
  const cores = Number(coresText);
  const oneMinute = /^[0-9]+(?:\.[0-9]+)?$/.test(field) ? Number(field) : Number.NaN;
  if (!Number.isInteger(cores) || cores < 1 || !Number.isFinite(oneMinute)) return null;
  return { oneMinute, cores };
};

/** Reads the host's load over ssh; fails with a plain reason when it cannot be read. */
export const readHostLoad = (run: SshSpawn, host: HostConfig): Effect.Effect<Load, string> =>
  runSsh(run, host.ssh, LOAD_COMMAND).pipe(
    Effect.mapError((error) => error.message),
    Effect.flatMap((text) => {
      const load = parseLoad(text);
      return load === null
        ? Effect.fail("the load answer is not one the runner reads")
        : Effect.succeed(load);
    }),
  );
