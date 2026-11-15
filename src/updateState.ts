// @effect-diagnostics nodeBuiltinImport:off - the start count is read and written before the runner lock, before any layer builds.
/**
 * What a self-installed version carries across its restart, in two files of the data dir.
 *
 * `update-pending.json` is written by the updater just before it points `current` at a staged
 * version: `from` the running version, `to` the staged one, `starts` 0. Each start of `to` adds 1
 * before it takes the runner lock, and the first finished pass of `to` removes the file. A start
 * that finds `starts` at {@link START_BUDGET} has seen that many starts with no pass finished: it
 * goes back to `from` and exits 0, so launchd starts `current` again.
 *
 * `update-refused.json` names the tag gone back from, so the version gone back to does not stage
 * it again. A finished pass of a higher version removes it, and so does `install`. What a finished
 * pass removes is `clearAfterPass` in `selfUpdate.ts`, beside the version compare it needs.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";

import { pointCurrent } from "./install.ts";
import { formatTs, parseTs } from "./ledger/time.ts";
import { installPathsOf, UPDATE_PENDING_FILE, UPDATE_REFUSED_FILE } from "./paths.ts";
import type { ReportedAttention } from "./status.ts";
import { readTextOrNull, writeFileWhole } from "./syncFiles.ts";
/** Starts of a self-installed version with no pass finished; the next start goes back. */
export const START_BUDGET = 3;

const VERSION = /^\d+\.\d+\.\d+$/;
const TAG = /^v\d+\.\d+\.\d+$/;

/** A restart into a version the updater installed, until that version finishes a pass. */
export interface Pending {
  /** The version that restarted, `X.Y.Z`. */
  readonly from: string;
  /** The version it restarted into, `X.Y.Z`. */
  readonly to: string;
  /** Starts of `to` since the restart. */
  readonly starts: number;
}

/** The tag a runner went back from, which the updater does not stage again. */
export interface Refused {
  /** `vX.Y.Z`. */
  readonly tag: string;
  /** The version gone back to, `X.Y.Z`. */
  readonly from: string;
  /** When it went back, as the ledger writes a time. */
  readonly at: string;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The file's JSON object, or null when there is no file; throws when it cannot be read or is no object. */
const readObject = (path: string): Record<string, unknown> | null => {
  const text = readTextOrNull(path);
  if (text === null) return null;
  const json = JSON.parse(text) as unknown;
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new Error(`${path} is not a JSON object`);
  }
  return json as Record<string, unknown>;
};

const writeJson = (dataDir: string, file: string, value: object): void => {
  NodeFS.mkdirSync(dataDir, { recursive: true });
  writeFileWhole(NodePath.join(dataDir, file), `${JSON.stringify(value, null, 2)}\n`);
};

export const pendingPath = (dataDir: string): string => NodePath.join(dataDir, UPDATE_PENDING_FILE);
export const refusedPath = (dataDir: string): string => NodePath.join(dataDir, UPDATE_REFUSED_FILE);

/** The pending restart, or null when there is none; throws when the file cannot be read or is not one. */
export const readPending = (dataDir: string): Pending | null => {
  const path = pendingPath(dataDir);
  const json = readObject(path);
  if (json === null) return null;
  const { from, to, starts } = json;
  if (
    typeof from !== "string" ||
    !VERSION.test(from) ||
    typeof to !== "string" ||
    !VERSION.test(to) ||
    typeof starts !== "number" ||
    !Number.isInteger(starts) ||
    starts < 0
  ) {
    throw new Error(`${path} needs X.Y.Z "from" and "to" and a whole "starts"`);
  }
  return { from, to, starts };
};

/** Writes the pending file whole, by an atomic replace. Throws. */
export const writePending = (dataDir: string, pending: Pending): void =>
  writeJson(dataDir, UPDATE_PENDING_FILE, pending);

/** Removes the pending file; none is fine. Throws. */
export const removePending = (dataDir: string): void => NodeFS.rmSync(pendingPath(dataDir), { force: true });

/** The refused tag, or null when there is none; throws when the file cannot be read or is not one. */
export const readRefused = (dataDir: string): Refused | null => {
  const path = refusedPath(dataDir);
  const json = readObject(path);
  if (json === null) return null;
  const { tag, from, at } = json;
  if (
    typeof tag !== "string" ||
    !TAG.test(tag) ||
    typeof from !== "string" ||
    !VERSION.test(from) ||
    typeof at !== "string" ||
    parseTs(at) === null
  ) {
    throw new Error(`${path} needs a vX.Y.Z "tag", an X.Y.Z "from" and a time "at"`);
  }
  return { tag, from, at };
};

/** Removes the refused file; none is fine. Throws. */
export const removeRefused = (dataDir: string): void => NodeFS.rmSync(refusedPath(dataDir), { force: true });

/** What `run` does after the start count: run the factory, or exit with the code. */
export type Start =
  /** Run. `giveBack` takes this start's count back, for a start that ends on a held lock. Never fails. */
  | { readonly kind: "run"; readonly giveBack: Effect.Effect<void> }
  /** Do not run: exit with `code`. */
  | { readonly kind: "exit"; readonly code: number };

export interface StartOptions {
  /** HOME: `versions/` and `current` are under it. */
  readonly home: string;
  readonly dataDir: string;
  /** The running `packageVersion`, `X.Y.Z`. */
  readonly version: string;
  readonly nowMs: () => number;
}

const RUN: Start = { kind: "run", giveBack: Effect.void };

/**
 * The first step of `run`, before the runner lock and before any layer: counts this start of a
 * version the updater restarted into, or goes back from it when {@link START_BUDGET} starts
 * finished no pass. Never fails: a file it cannot read or write is a warning and the start goes on.
 */
export const countStart = Effect.fn("UpdateState.countStart")(function* (options: StartOptions) {
  const { dataDir, version } = options;
  let pending: Pending | null;
  try {
    pending = readPending(dataDir);
  } catch (error) {
    yield* Effect.logWarning(`the pending update could not be read, so this start is not counted: ${messageOf(error)}`);
    return RUN;
  }
  if (pending === null || pending.to !== version) return RUN;
  if (pending.starts >= START_BUDGET) return yield* goBack(options, pending);
  try {
    writePending(dataDir, { ...pending, starts: pending.starts + 1 });
  } catch (error) {
    yield* Effect.logWarning(`this start of v${version} was not counted: ${messageOf(error)}`);
    return RUN;
  }
  // Read again at the give-back: a pass of another runner may have cleared the file since.
  const giveBack = Effect.suspend(() => {
    try {
      const now = readPending(dataDir);
      if (now === null || now.to !== version || now.starts === 0) return Effect.void;
      writePending(dataDir, { ...now, starts: now.starts - 1 });
      return Effect.void;
    } catch (error) {
      return Effect.logWarning(`this start of v${version} could not take its count back: ${messageOf(error)}`);
    }
  });
  return { kind: "run", giveBack } satisfies Start;
});

/**
 * Points `current` back at `versions/<from>`, after the refused file is written, and exits 0. A
 * `versions/<from>` that is gone leaves `current` alone: the pending file is removed and the start
 * goes on. A `current` that cannot be moved removes the refused file it wrote and the start goes
 * on, with the pending file still at its count, so the next start tries again: it never exits with
 * `current` still on `to`.
 */
const goBack = (options: StartOptions, pending: Pending) =>
  Effect.gen(function* () {
    const { dataDir } = options;
    const from = `v${pending.from}`;
    const to = `v${pending.to}`;
    const removeQuietly = Effect.suspend(() => {
      try {
        removePending(dataDir);
        return Effect.void;
      } catch (error) {
        return Effect.logWarning(`the pending update could not be removed: ${messageOf(error)}`);
      }
    });
    // pointCurrent makes the link without looking at its target.
    if (!NodeFS.existsSync(NodePath.join(installPathsOf(options.home).versions, pending.from))) {
      yield* Effect.logWarning(`cannot go back from ${to}: versions/${pending.from} is gone`);
      yield* removeQuietly;
      return RUN;
    }
    let unrefused = "";
    try {
      writeJson(dataDir, UPDATE_REFUSED_FILE, {
        tag: to,
        from: pending.from,
        at: formatTs(options.nowMs()),
      } satisfies Refused);
    } catch (error) {
      unrefused = `; ${to} can be staged again, since ${UPDATE_REFUSED_FILE} was not written: ${messageOf(error)}`;
    }
    try {
      pointCurrent({ home: options.home }, pending.from);
    } catch (error) {
      let refused = unrefused === "" ? `; removed the ${UPDATE_REFUSED_FILE} written for it` : "";
      if (unrefused === "") {
        try {
          removeRefused(dataDir);
        } catch (removeError) {
          refused = `; the ${UPDATE_REFUSED_FILE} written for it could not be removed: ${messageOf(removeError)}`;
        }
      }
      yield* Effect.logWarning(
        `cannot go back from ${to}: pointing current at versions/${pending.from} failed: ${messageOf(error)}${refused}`,
      );
      return RUN;
    }
    yield* removeQuietly;
    yield* Effect.logWarning(`went back to ${from} from ${to}: ${START_BUDGET} starts without a pass${unrefused}`);
    return { kind: "exit", code: 0 } satisfies Start;
  });

/**
 * The attention row `status` shows while a refused tag is on file, built from that file and not
 * from `attention.json`: no row when there is no file. A file that cannot be read gives no row
 * and a warning for `status` to print, as `readAttentionFile` does, since the updater stages
 * nothing while it stays that way.
 */
export const readRefusedRow = (
  dataDir: string,
): { readonly row: ReportedAttention | null; readonly warning: string | null } => {
  let refused: Refused | null;
  try {
    refused = readRefused(dataDir);
  } catch (error) {
    return {
      row: null,
      warning: `${refusedPath(dataDir)} could not be read, so no refused tag is shown and self-update stages nothing: ${messageOf(error)}`,
    };
  }
  if (refused === null) return { row: null, warning: null };
  return {
    row: {
      id: "update-refused",
      kind: "update-refused",
      repo: null,
      issue: null,
      run: null,
      message: `${refused.tag} could not complete a pass after its restart; running v${refused.from}. A newer tag installs as usual.`,
      first_seen: formatTs(parseTs(refused.at)!),
    },
    warning: null,
  };
};
