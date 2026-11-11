// @effect-diagnostics nodeBuiltinImport:off - Hashes a command id, synchronously.
/**
 * The adapter's own records under `<data>/paradev/`: one thread record per workspace, and one
 * launch file per launch command id that points at its thread. Each is written whole through
 * `files.ts`, and a file that does not read back as a whole record is treated as missing.
 */
import * as NodeCrypto from "node:crypto";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { writeFileAtomically } from "../files.ts";

const Turn = Schema.Struct({
  commandId: Schema.String,
  /** Epoch ms. */
  at: Schema.Number,
  kind: Schema.Literals(["launch", "send", "resume"]),
});
export type Turn = typeof Turn.Type;

const ThreadRecordSchema = Schema.Struct({
  v: Schema.Literal(1),
  /** `local:<workspaceId>`. */
  threadId: Schema.String,
  location: Schema.Literal("local"),
  workspaceId: Schema.String,
  projectId: Schema.String,
  /** The branch Paradev reported at create. */
  branch: Schema.String,
  worktreePath: Schema.NullOr(Schema.String),
  launchCommandId: Schema.String,
  /** The agent preset, e.g. `claude`. */
  agent: Schema.String,
  /** Oldest first; the last is the current one. */
  terminals: Schema.Array(Schema.String),
  turns: Schema.Array(Turn),
  archivedAt: Schema.NullOr(Schema.Number),
});
export type ThreadRecord = typeof ThreadRecordSchema.Type;

const LaunchFileSchema = Schema.Struct({ threadId: Schema.String });

const decodeRecord = Schema.decodeUnknownOption(Schema.fromJsonString(ThreadRecordSchema));
const decodeLaunch = Schema.decodeUnknownOption(Schema.fromJsonString(LaunchFileSchema));

/** A workspace id that is safe as a file name: no separator, no dots. */
const WORKSPACE_ID = /^[A-Za-z0-9-]+$/;

export const threadIdOf = (workspaceId: string): string => `local:${workspaceId}`;

/** The workspace of a `local:<workspaceId>` thread id; null for any other id. */
export const workspaceIdOf = (threadId: string): string | null => {
  if (!threadId.startsWith("local:")) return null;
  const id = threadId.slice("local:".length);
  return WORKSPACE_ID.test(id) ? id : null;
};

const threadsDir = (path: Path.Path, dataDir: string) => path.join(dataDir, "paradev", "threads");

const launchFile = (path: Path.Path, dataDir: string, commandId: string) =>
  path.join(
    dataDir,
    "paradev",
    "launches",
    `${NodeCrypto.createHash("sha256").update(commandId).digest("hex")}.json`,
  );

/** The file's text; null when it does not exist. */
const readText = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.readFileString(file).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.succeed(null),
      ),
    );
  });

/** The thread record of `workspaceId`; null when there is none or it is torn. */
export const readThread = Effect.fn("ParadevState.readThread")(function* (
  dataDir: string,
  workspaceId: string,
) {
  const path = yield* Path.Path;
  const text = yield* readText(path.join(threadsDir(path, dataDir), `${workspaceId}.json`));
  return text === null ? null : Option.getOrNull(decodeRecord(text));
});

export const writeThread = Effect.fn("ParadevState.writeThread")(function* (
  dataDir: string,
  record: ThreadRecord,
) {
  const path = yield* Path.Path;
  const file = path.join(threadsDir(path, dataDir), `${record.workspaceId}.json`);
  yield* writeFileAtomically(file, `${JSON.stringify(record)}\n`);
});

/** Every whole thread record; torn files are skipped. */
export const listThreads = Effect.fn("ParadevState.listThreads")(function* (dataDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = threadsDir(path, dataDir);
  const names = yield* fs.readDirectory(dir).pipe(
    Effect.catchIf(
      (error) => error.reason._tag === "NotFound",
      () => Effect.succeed([] as ReadonlyArray<string>),
    ),
  );
  const records: Array<ThreadRecord> = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const text = yield* readText(path.join(dir, name));
    const record = text === null ? null : Option.getOrNull(decodeRecord(text));
    if (record !== null) records.push(record);
  }
  return records;
});

/** The thread a launch command id made; null when none is recorded or the file is torn. */
export const readLaunch = Effect.fn("ParadevState.readLaunch")(function* (
  dataDir: string,
  commandId: string,
) {
  const path = yield* Path.Path;
  const text = yield* readText(launchFile(path, dataDir, commandId));
  return text === null ? null : (Option.getOrNull(decodeLaunch(text))?.threadId ?? null);
});

export const writeLaunch = Effect.fn("ParadevState.writeLaunch")(function* (
  dataDir: string,
  commandId: string,
  threadId: string,
) {
  const path = yield* Path.Path;
  yield* writeFileAtomically(launchFile(path, dataDir, commandId), `${JSON.stringify({ threadId })}\n`);
});
