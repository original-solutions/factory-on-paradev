// @effect-diagnostics globalDate:off - the belt carries the pass's times as ISO 8601 text.
/**
 * The belt page and its storage writer. The first pass publishes `belt.html` as a Paradev page
 * and saves its id in `<data>/belt.json`; a runner whose HTML differs publishes it again to that
 * page. After each pass the writer puts the belt, a {@link BeltV1}, in the page's shared storage
 * under `belt`, when it changed or the last write is 10 minutes old. Nothing here is session
 * trouble: a failed publish or write is a warning in the log, and the next pass tries again.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import type { AttentionItem } from "../attention.ts";
import { beltBytes, type BeltV1 } from "../belt.ts";
import type { BeltVisibility } from "../config.ts";
import { writeFileAtomically } from "../files.ts";
import { readRuns, type RunReadCache, type RunSummary } from "../ledger/listRuns.ts";
import { runIdToString } from "../ledger/runId.ts";
import { sha256 } from "../text.ts";
import { decodeAnswer } from "./call.ts";
import type { SupersetCli } from "./cli.ts";
import { workspaceIdOf } from "./state.ts";

/** The page the runner publishes: one static file, beside this one. */
export const BELT_HTML = `${import.meta.dirname}/belt.html`;
/** Paradev caps one stored value at 64 KiB; the belt keeps under 60. */
export const BELT_MAX_BYTES = 60 * 1024;
/** An unchanged belt is written again this long after the last write, so a stopped runner shows. */
export const HEARTBEAT_MS = 10 * 60_000;
/** One storage write's timeout. No retry: the next pass writes again. */
const WRITE_TIMEOUT_MS = 20_000;
/** How far back the belt lists finished runs. */
const FINISHED_WINDOW_MS = 7 * 24 * 60 * 60_000;

const TITLE_MAX = 120;
const STEP_MAX = 120;
const REASON_MAX = 300;

type Run = BeltV1["runs"][number];

/** A run as the ledger has it, and the session thread it launched, if any. */
export interface BeltRun {
  readonly summary: RunSummary;
  readonly threadId: string | null;
}

/** Every unfinished run, and the finished runs of the last 7 days, oldest first. */
export const readBeltRuns = (
  dataDir: string,
  nowMs: number,
  cache?: RunReadCache,
): ReadonlyArray<BeltRun> =>
  readRuns(dataDir, {
    skipFinishedBefore: nowMs - FINISHED_WINDOW_MS,
    ...(cache === undefined ? {} : { cache }),
  }).map(({ summary, seen }) => ({ summary, threadId: seen?.threadId ?? null }));

/** `text` in at most `max` UTF-16 units, ending in an ellipsis when cut; never splits a character. */
const cut = (text: string | null, max: number): string | null => {
  if (text === null || text.length <= max) return text;
  let kept = "";
  for (const char of text) {
    if (kept.length + char.length > max - 1) break;
    kept += char;
  }
  return `${kept}…`;
};

const runOf = ({ summary, threadId }: BeltRun): Run => {
  const issue = Number(summary.id.issue);
  return {
    id: runIdToString(summary.id),
    repo: summary.id.repo,
    issue: Number.isSafeInteger(issue) ? issue : 0,
    title: cut(summary.title, TITLE_MAX),
    state: summary.state,
    step: cut(summary.step, STEP_MAX),
    reason: cut(summary.reason, REASON_MAX),
    prUrl: summary.prUrl,
    startedTs: summary.startedTs,
    finished: summary.finished,
    totalMs: summary.totalMs,
    workspaceId: threadId === null ? null : workspaceIdOf(threadId),
  };
};

/**
 * `payload` with finished runs dropped, oldest first, until its JSON is at most
 * {@link BELT_MAX_BYTES}. Unfinished runs are never dropped.
 */
const fit = (payload: BeltV1): BeltV1 => {
  let size = beltBytes(payload);
  if (size <= BELT_MAX_BYTES) return payload;
  const dropped = new Set<number>();
  let left = payload.runs.length;
  for (const [index, run] of payload.runs.entries()) {
    if (size <= BELT_MAX_BYTES) break;
    if (!run.finished) continue;
    dropped.add(index);
    // The run's JSON, and the comma before or after it while another run is left.
    size -= Buffer.byteLength(JSON.stringify(run), "utf8") + (left > 1 ? 1 : 0);
    left -= 1;
  }
  return { ...payload, runs: payload.runs.filter((_, index) => !dropped.has(index)) };
};

export interface BeltInput {
  readonly nowMs: number;
  readonly runner: BeltV1["runner"];
  /** Oldest first, as {@link readBeltRuns} lists them. */
  readonly runs: ReadonlyArray<BeltRun>;
  readonly attention: ReadonlyArray<AttentionItem>;
}

/**
 * The belt to write: the counts from every run given, the runs cut to fit
 * {@link BELT_MAX_BYTES}. It carries titles, states, steps and reasons, never gate output or logs.
 */
export const beltPayload = (input: BeltInput): BeltV1 => {
  const runs = input.runs.map(runOf);
  const open = runs.filter((run) => !run.finished);
  const count = (state: Run["state"]) => open.filter((run) => run.state === state).length;
  return fit({
    v: 1,
    updatedAt: new Date(input.nowMs).toISOString(),
    runner: input.runner,
    counts: {
      triage: count("triage"),
      building: count("building"),
      prOpen: count("pr-open"),
      needsInfo: count("needs-info"),
      stuck: count("stuck"),
      finished7d: runs.length - open.length,
    },
    runs,
    attention: input.attention.map((item) => ({
      id: item.id,
      kind: item.kind,
      text: item.message,
      since: new Date(item.firstSeenMs).toISOString(),
    })),
  });
};

/** The last belt written, without its `updatedAt`, and when. Kept across reloads, not restarts. */
export interface BeltMemo {
  written: string | null;
  atMs: number;
}

export const newBeltMemo = (): BeltMemo => ({ written: null, atMs: 0 });

export interface BeltTarget {
  readonly cli: SupersetCli["Service"];
  readonly dataDir: string;
  readonly host: string;
  /** The runner's version, the label of a page published again. */
  readonly version: string;
  readonly visibility: BeltVisibility;
  readonly memo: BeltMemo;
}

const SavedPage = Schema.Struct({ pageId: Schema.String, htmlSha256: Schema.String });
const decodeSaved = Schema.decodeUnknownOption(Schema.fromJsonString(SavedPage));
const Published = Schema.Struct({ id: Schema.String });

/**
 * The page to write to: the one `<data>/belt.json` names when its HTML is this runner's, else
 * `belt.html` published again (to the saved page) or for the first time. A publish that fails is a
 * warning; the saved page, if any, is still written to, and the next pass publishes again.
 */
const pageOf = Effect.fn("Belt.pageOf")(function* (target: BeltTarget) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const html = yield* fs.readFileString(BELT_HTML);
  const htmlSha256 = sha256(html);
  const savedFile = path.join(target.dataDir, "belt.json");
  const saved = yield* fs.readFileString(savedFile).pipe(
    Effect.map((text) => Option.getOrNull(decodeSaved(text))),
    Effect.orElseSucceed(() => null),
  );
  if (saved?.htmlSha256 === htmlSha256) return saved.pageId;
  const file = path.join(target.dataDir, "belt-page", "index.html");
  yield* writeFileAtomically(file, html);
  const argv =
    saved === null
      ? ["pages", "publish", file, "--title", `Factory belt (${target.host})`, "--visibility", target.visibility, "--no-watch"]
      : ["pages", "publish", file, "--page", saved.pageId, "--label", `runner ${target.version}`, "--no-watch"];
  const published = yield* Effect.result(
    target.cli.run(argv).pipe(Effect.flatMap((answer) => decodeAnswer(Published, answer, argv))),
  );
  if (Result.isFailure(published)) {
    yield* Effect.logWarning(`belt page not published: ${published.failure.message}`);
    return saved?.pageId ?? null;
  }
  const pageId = published.success.id;
  yield* writeFileAtomically(savedFile, `${JSON.stringify({ pageId, htmlSha256 })}\n`);
  return pageId;
});

/**
 * Puts `payload` in the page's shared storage, publishing the page first when it has to. An
 * unchanged belt, `updatedAt` and `runner.lastPassAt` aside, is not written again until
 * {@link HEARTBEAT_MS} after the last write. Never fails: what goes wrong is a warning in the log.
 */
export const writeBelt = (target: BeltTarget, payload: BeltV1, nowMs: number) =>
  Effect.gen(function* () {
    const pageId = yield* pageOf(target);
    if (pageId === null) return;
    // Each pass moves both times, so a belt that only they changed is unchanged.
    const written = JSON.stringify({
      ...payload,
      updatedAt: null,
      runner: { ...payload.runner, lastPassAt: null },
    });
    if (written === target.memo.written && nowMs - target.memo.atMs < HEARTBEAT_MS) return;
    const argv = ["pages", "storage", pageId, "--key", "belt", "--scope", "shared", "--set", JSON.stringify(payload)];
    const result = yield* Effect.result(target.cli.run(argv, { timeoutMs: WRITE_TIMEOUT_MS }));
    if (Result.isFailure(result)) {
      yield* Effect.logWarning(`belt not written: ${result.failure.message}`);
      return;
    }
    target.memo.written = written;
    target.memo.atMs = nowMs;
  }).pipe(
    Effect.catch((error) => Effect.logWarning(`belt not written: ${error.message}`)),
    Effect.withSpan("Belt.write"),
  );

/** What the runner knows after a pass, besides the ledger and the attention items. */
export interface PassFacts {
  readonly nowMs: number;
  readonly paradevCli: string;
  readonly claimsPaused: boolean;
  readonly paradevOnline: boolean;
  readonly attention: ReadonlyArray<AttentionItem>;
}

/**
 * After a pass: the belt from the ledger and `facts`, written by {@link writeBelt}. Never fails.
 */
export const afterPass = (target: BeltTarget, facts: PassFacts, cache?: RunReadCache) =>
  Effect.gen(function* () {
    const runs = yield* Effect.try({
      try: () => readBeltRuns(target.dataDir, facts.nowMs, cache),
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    });
    const payload = beltPayload({
      nowMs: facts.nowMs,
      runner: {
        host: target.host,
        version: target.version,
        paradevCli: facts.paradevCli,
        claimsPaused: facts.claimsPaused,
        paradevOnline: facts.paradevOnline,
        lastPassAt: new Date(facts.nowMs).toISOString(),
      },
      runs,
      attention: facts.attention,
    });
    yield* writeBelt(target, payload, facts.nowMs);
  }).pipe(Effect.catch((error) => Effect.logWarning(`belt not written: ${error.message}`)));
