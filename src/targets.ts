// @effect-diagnostics nodeBuiltinImport:off - status reads the rows the runner wrote to the data dir.
/**
 * Where runs go, as `status` and the belt show it (#56): one row per target, and the target a run's
 * thread id names. The runner writes the rows to `<data>/targets.json` after each pass, so
 * `status`, which reads only the data dir, can show them.
 */
import * as NodePath from "node:path";

import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { isPlainId } from "./sessions.ts";
import { readTextOrNull } from "./syncFiles.ts";

/** One place runs go: this Mac, a host or cloud, as the last pass read it. */
const TargetRowSchema = Schema.Struct({
  kind: Schema.Literals(["local", "host", "cloud"]),
  /** "local", the host's name, or "cloud". */
  name: Schema.String,
  /** Its running agents were counted this pass: its snapshot answered, and the thread records read. */
  online: Schema.Boolean,
  /** Its 1-minute load and cores; null for cloud, and for a host whose load was not read. */
  load: Schema.NullOr(Schema.Struct({ oneMinute: Schema.Number, cores: Schema.Number })),
  /** The runs on it and its `max_runs`; `used` is null when they could not be counted. */
  slots: Schema.Struct({ used: Schema.NullOr(Schema.Number), max: Schema.Number }),
  /** Its own check passed: P1's load and disk checks for this Mac, `hosts check` for a host, the proxy check for cloud. */
  ready: Schema.Boolean,
  /** Why placement would not use it now; null when it would. */
  reason: Schema.NullOr(Schema.String),
});
export type TargetRow = typeof TargetRowSchema.Type;

const decodeRows = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(TargetRowSchema)));

/** The file the runner writes the rows to, in the data dir. */
export const TARGETS_FILE = "targets.json";

/** The rows as the runner writes them. */
export const targetsText = (rows: ReadonlyArray<TargetRow>): string => `${JSON.stringify(rows)}\n`;

/** The rows the runner last wrote; none when there is no file, or one that does not read back as rows. */
export const readTargetRows = (dataDir: string): ReadonlyArray<TargetRow> => {
  let text: string | null;
  try {
    text = readTextOrNull(NodePath.join(dataDir, TARGETS_FILE));
  } catch {
    return [];
  }
  return text === null ? [] : Option.getOrElse(decodeRows(text), () => []);
};

/** A target as its thread id names it: the host's name and the cloud environment are not in it. */
export type ThreadTarget =
  | { readonly kind: "local" }
  | { readonly kind: "host"; readonly machineId: string }
  | { readonly kind: "cloud" };

/** Parses `local:<ws>`, `host:<machineId>:<ws>` or `cloud:<ws>`; null for an id of any other form or with an id that is not plain. */
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

/**
 * Where the run of `threadId` is: "local", the name `hostNames` gives its host (its machine id when
 * the config no longer lists it), or "cloud"; null for no thread, or one of no target's form.
 */
export const targetNameOf = (
  threadId: string | null,
  hostNames: ReadonlyMap<string, string>,
): string | null => {
  const parsed = threadId === null ? null : targetOf(threadId);
  if (parsed === null) return null;
  const { target } = parsed;
  return target.kind === "host" ? (hostNames.get(target.machineId) ?? target.machineId) : target.kind;
};

/** Each configured host's name by its machine id. */
export const hostNamesOf = (hosts: ReadonlyArray<{ readonly id: string; readonly name: string }>): ReadonlyMap<string, string> =>
  new Map(hosts.map((host) => [host.id, host.name]));
