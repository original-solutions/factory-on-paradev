// @effect-diagnostics nodeBuiltinImport:off - a stop request is a file `factory/scripts/stop-run.sh` leaves, taken the way the gate takes its locks.
/**
 * A stop by hand, ported from softfac's `runs stop`. `factory/scripts/stop-run.sh <run id>`
 * leaves a file in `<dataDir>/stop-requests/`, and the pass takes it into the run's ledger as a
 * `stop_requested` line (`takeStopRequest`), so only the server writes the ledger. The run goes
 * `stuck` on that pass. The HTTP API leaves the same file (`leaveStopRequest`).
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";

import {
  errnoCode,
  LedgerIoError,
  ledgerCall as ledger,
  type LedgerError,
} from "../ledger/errors.ts";
import { makeCause } from "../ledger/events.ts";
import { Ledger } from "../ledger/ledger.ts";
import { readRun } from "../ledger/read.ts";
import { runIdToString, type RunId } from "../ledger/runId.ts";
import { readProgress, type Seen } from "./progress.ts";

/** The directory of the data dir that holds the requests, one file per run. */
export const STOP_REQUESTS_DIR = "stop-requests";

/** Where the request for `run` is: the script writes it and the pass takes it. */
export const stopRequestPath = (dataDir: string, run: RunId): string =>
  NodePath.join(dataDir, STOP_REQUESTS_DIR, runIdToString(run));

/**
 * What `takeStopRequest` found. `recorded`: the line is now in the ledger. `already-requested`
 * and `finished`: the request is stale (the line is there, or the run is over) and is dropped.
 * `not-building`: the run left `building` (or has no state yet) after the script checked, so
 * the request is dropped and no line is written.
 */
export type StopRequestOutcome =
  | "recorded"
  | "already-requested"
  | "none"
  | "finished"
  | "not-building";

/**
 * Records a stop by hand for `run`, as `takeStopRequest` does: when the run is building and no
 * stop was asked for, appends the `stop_requested` line. Throws the ledger's errors; a caller
 * runs it through `ledgerCall`. `none` is not an outcome here: the caller asked. `seen` is the
 * progress the decision was made from.
 */
export const requestStop = (
  dataDir: string,
  run: RunId,
  clock: () => number,
): { readonly outcome: Exclude<StopRequestOutcome, "none">; readonly seen: Seen } => {
  const seen = readProgress(readRun(dataDir, run).entries);
  if (seen.finished) return { outcome: "finished", seen };
  if (seen.stopRequested) return { outcome: "already-requested", seen };
  if (seen.state !== "building") return { outcome: "not-building", seen };
  const out = Ledger.open(dataDir, run, { clock });
  try {
    out.append(
      { event: "stop_requested", data: { by: "operator" } },
      makeCause("operator", "stop-requested"),
    );
  } finally {
    out.close();
  }
  return { outcome: "recorded", seen };
};

/**
 * Asks for `run` to be stopped by hand, as the API does: leaves the file `stop-run.sh` leaves and
 * never writes the ledger. The pass takes it only when the gate does not have the run and drops it
 * once the gate passed, so the gate's result decides first. `finished` and `not-building` are
 * checked before the stop line; `already-requested` is a waiting request or a line in the ledger.
 */
export const leaveStopRequest = (
  dataDir: string,
  run: RunId,
): {
  readonly outcome: Exclude<StopRequestOutcome, "none">;
  readonly seen: Seen;
} => {
  const seen = readProgress(readRun(dataDir, run).entries);
  if (seen.finished) return { outcome: "finished", seen };
  if (seen.state !== "building") return { outcome: "not-building", seen };
  const path = stopRequestPath(dataDir, run);
  if (seen.stopRequested || NodeFS.existsSync(path)) return { outcome: "already-requested", seen };
  const dir = NodePath.dirname(path);
  try {
    NodeFS.mkdirSync(dir, { recursive: true });
  } catch (error) {
    // Its own catch: the EEXIST of a file where the directory belongs is not a request.
    throw new LedgerIoError({ path: dir, cause: error });
  }
  try {
    // `wx`: a request left by a call racing this one is that call's, and this one is `already`.
    NodeFS.writeFileSync(path, "operator\n", { flag: "wx" });
  } catch (error) {
    if (errnoCode(error) === "EEXIST") return { outcome: "already-requested", seen };
    throw new LedgerIoError({ path, cause: error });
  }
  return { outcome: "recorded", seen };
};

/**
 * Why a stop by hand is refused for a run that is not building, in the words of
 * `factory/scripts/stop-run.sh`: `seen` is the run's progress, and the tail says how the run ends
 * instead.
 */
export const notBuildingMessage = (id: string, seen: Seen): string => {
  const why = seen.finished
    ? "it is finished"
    : seen.state === null
      ? "it has no state yet"
      : `its state is ${seen.state}`;
  const tail = seen.finished
    ? ""
    : seen.state === null || seen.state === "triage" || seen.state === "needs-info"
      ? " To end it, close its issue."
      : seen.state === "pr-open"
        ? " It ends when its pull request is merged or closed."
        : "";
  return `run ${id} is not building: ${why}. Only a building run is stopped this way.${tail}`;
};

/**
 * Takes the stop request for `run`, if there is one. The file is removed after the ledger line is
 * written, so a crash between the two leaves the file and the line, and the next pass finds the
 * line and only removes the file. A run that is finished, or no longer building, gets no line. A ledger that cannot be
 * read or written is an error and the file is kept for the next pass.
 */
export const takeStopRequest = (
  dataDir: string,
  run: RunId,
  clock: () => number,
): Effect.Effect<StopRequestOutcome, LedgerError> =>
  ledger((): StopRequestOutcome => {
    const path = stopRequestPath(dataDir, run);
    if (!NodeFS.existsSync(path)) return "none";
    const drop = (outcome: StopRequestOutcome): StopRequestOutcome => {
      try {
        NodeFS.rmSync(path, { force: true });
      } catch (error) {
        throw new LedgerIoError({ path, cause: error });
      }
      return outcome;
    };
    return drop(requestStop(dataDir, run, clock).outcome);
  });
