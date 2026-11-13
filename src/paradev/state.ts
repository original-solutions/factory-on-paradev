/**
 * The adapter's own records under `<data>/paradev/`: one thread record per workspace, and one
 * launch file per launch command id that points at its thread. Each is written whole through
 * `files.ts`, and a file that does not read back as a whole record is treated as missing.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { writeFileAtomically } from "../files.ts";
import { isPlainId } from "../sessions.ts";
import { sha256 } from "../text.ts";

const Turn = Schema.Struct({
  commandId: Schema.String,
  /** Epoch ms. */
  at: Schema.Number,
  kind: Schema.Literals(["launch", "send", "resume"]),
});
export type Turn = typeof Turn.Type;

const PendingSend = Schema.Struct({
  commandId: Schema.String,
  /** The `lastEventAt` read before the text was typed; null when the agent had no hook yet. */
  before: Schema.NullOr(Schema.Number),
});
export type PendingSend = typeof PendingSend.Type;

/** Where a thread's agent runs. The record keeps the host's name and the cloud environment. */
const TargetSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("local") }),
  Schema.Struct({ kind: Schema.Literal("host"), machineId: Schema.String, name: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("cloud"), environmentId: Schema.String }),
]);
export type Target = typeof TargetSchema.Type;

/** Every field a record has in both versions, after `v`, `threadId` and where it runs. */
const RECORD_FIELDS = {
  workspaceId: Schema.String,
  /** The Paradev project; for cloud, the environment id. */
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
  /**
   * The command id of a resume about to run, or that ran, `agents create`, whose agent is not recorded yet:
   * the next send adopts the agent it started. Absent in records written before it existed.
   */
  pendingResume: Schema.optional(Schema.NullOr(Schema.String)),
  /**
   * The send about to type, or that typed, its text, whose turn is not recorded yet: a repeat of its
   * command id types nothing and counts a hook newer than `before` as the reaction. Absent in
   * records written before it existed.
   */
  pendingSend: Schema.optional(Schema.NullOr(PendingSend)),
  /**
   * The gate attempts that already have a gate terminal in the workspace, so a repeat call for one
   * creates nothing. Not in `terminals`: its last entry stays the agent's. Absent in records
   * written before it existed.
   */
  gateLogAttempts: Schema.optional(Schema.Array(Schema.Number)),
};

/** A record as P1 wrote it: every thread local. */
const ThreadRecordV1Schema = Schema.Struct({
  v: Schema.Literal(1),
  /** `local:<workspaceId>`. */
  threadId: Schema.String,
  location: Schema.Literal("local"),
  ...RECORD_FIELDS,
});

const ThreadRecordSchema = Schema.Struct({
  v: Schema.Literal(2),
  /** `local:<ws>`, `host:<machineId>:<ws>` or `cloud:<ws>`: {@link threadIdOf} of the target. */
  threadId: Schema.String,
  target: TargetSchema,
  ...RECORD_FIELDS,
});
/** The record as the adapter holds and writes it: always v2. */
export type ThreadRecord = typeof ThreadRecordSchema.Type;

const LaunchFileSchema = Schema.Struct({ threadId: Schema.String });

const decodeStored = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Union([ThreadRecordSchema, ThreadRecordV1Schema])),
);
const decodeLaunch = Schema.decodeUnknownOption(Schema.fromJsonString(LaunchFileSchema));

/**
 * The record in a file's text, as v2; null when it is torn or foreign. A v1 record reads as a
 * local target. The file is not rewritten: the next write of the record writes v2.
 */
const decodeRecord = (text: string): ThreadRecord | null => {
  const stored = Option.getOrNull(decodeStored(text));
  if (stored === null || stored.v === 2) return stored;
  const { v: _v, location: _location, ...fields } = stored;
  return { v: 2, target: { kind: "local" }, ...fields };
};

/** A target as its thread id names it: the host's name and the cloud environment are not in it. */
export type ThreadTarget =
  | { readonly kind: "local" }
  | { readonly kind: "host"; readonly machineId: string }
  | { readonly kind: "cloud" };

/** `local:<ws>`, `host:<machineId>:<ws>` or `cloud:<ws>`. */
export const threadIdOf = (target: Target | ThreadTarget, workspaceId: string): string =>
  target.kind === "host" ? `host:${target.machineId}:${workspaceId}` : `${target.kind}:${workspaceId}`;

/** The inverse of {@link threadIdOf}; null for an id of any other form or with an id that is not plain. */
export const targetOf = (
  threadId: string,
): { readonly target: ThreadTarget; readonly workspaceId: string } | null => {
  const parts = threadId.split(":");
  if (!parts.every(isPlainId)) return null;
  const [kind, first, second] = parts;
  if (parts.length === 2 && (kind === "local" || kind === "cloud")) {
    return { target: { kind }, workspaceId: first! };
  }
  if (parts.length === 3 && kind === "host") {
    return { target: { kind, machineId: first! }, workspaceId: second! };
  }
  return null;
};

/** The workspace of a `local:<workspaceId>` thread id; null for any other id. */
export const workspaceIdOf = (threadId: string): string | null => {
  const parsed = targetOf(threadId);
  return parsed?.target.kind === "local" ? parsed.workspaceId : null;
};

const threadsDir = (path: Path.Path, dataDir: string) => path.join(dataDir, "paradev", "threads");

const launchFile = (path: Path.Path, dataDir: string, commandId: string) =>
  path.join(
    dataDir,
    "paradev",
    "launches",
    `${sha256(commandId)}.json`,
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
  return text === null ? null : decodeRecord(text);
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
    const record = text === null ? null : decodeRecord(text);
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
