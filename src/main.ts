// @effect-diagnostics nodeBuiltinImport:off - the host name goes on every `claimed` line, as softfac writes it; a gate lock is a file.
// @effect-diagnostics globalDate:off - the ledger stamps lines with the wall clock, as softfac does.
/**
 * The runner: the layer graph over local Paradev, and the pass world the loop runs on. The only
 * module outside `paradev/` that imports from it.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Result from "effect/Result";

import * as AttentionService from "./attention.ts";
import { Attention, CONFIG_ITEM_ID, type NewItem, type PassOutcome } from "./attention.ts";
import { loadHandPause } from "./claims.ts";
import {
  DEFAULT_POLL_SECONDS,
  factoryOptIn,
  formatConfigError,
  loadMachineConfig,
  paradevModel,
  parseProjectConfig,
  PROJECT_CONFIG_PATH,
  type ConfigError,
  type MachineConfig,
  type ProjectConfig,
  type RepoConfigReading,
  type WatchedListing,
  type WatchedProject,
  type WatchedRepo,
} from "./config.ts";
import { launchModel, type Cooldown } from "./cooldown.ts";
import {
  type Defaulted,
  type DefaultProject,
  LOCKFILES,
  resolveDefault,
} from "./defaultProject.ts";
import { readLowestFreeSpace, type FreeSpace } from "./disk.ts";
import { overload, readLoad, type Load } from "./load.ts";
import { checkHost, type CliCall } from "./paradev/hostsCheck.ts";
import { liveSshSpawn, type SshSpawn } from "./paradev/ssh.ts";
import * as Gate from "./gate.ts";
import { guardLogStreams } from "./logStreams.ts";
import { FactoryGate, clearGateLocks, gateLockFile } from "./gate.ts";
import type { State } from "./domain/lifecycle.ts";
import { ledgerCall as ledger } from "./ledger/errors.ts";
import { makeCause, type CauseStep, type ErrorKind, type MachineEvent } from "./ledger/events.ts";
import { Ledger } from "./ledger/ledger.ts";
import { listUnfinishedRuns, runsByThread, type RunReadCache } from "./ledger/listRuns.ts";
import { readRun } from "./ledger/read.ts";
import { asciiLower, runIdToString, type RunId } from "./ledger/runId.ts";
import { MachineLog, t3TroubleSince } from "./ledger/machineLog.ts";
import { runLoop, type Loop } from "./loop.ts";
import {
  GATE_PASSED_LINE,
  abandonedItem,
  errorKind,
  gateQueued,
  checkHosts,
  lastGoodCopy,
  plain,
  runPass,
  stuckItem,
  stuckLine,
  type BrokenThreadMemo,
  type LastGood,
  type ParadevDown,
  type PassError,
  type PassWorld,
  type Repo,
  type Report,
} from "./pass.ts";
import * as Process from "./process.ts";
import { FactoryProcess } from "./process.ts";
import { readProgress, type Moved } from "./runner/progress.ts";
import type { FactoryStatus } from "./status.ts";
import {
  advance,
  forward,
  gateSendPending,
  interrupted,
  resumeAfterCooldown,
  timeLimit,
  watch,
  type BuildingContext,
  type InterruptContext,
} from "./runner/building.ts";
import { feedback, type FeedbackContext } from "./runner/feedback.ts";
import { isOtherRepoProject } from "./runner/launchTarget.ts";
import {
  gate as gateStep,
  lastPass,
  regate,
  type GateStep,
  type GateStepError,
} from "./runner/gating.ts";
import { CUT_SHORT_COMMENT } from "./runner/messages.ts";
import { runProject } from "./runner/run.ts";
import {
  isOurs,
  newestSays,
  resume,
  start,
  utcSecond,
  yieldToClaim,
  type StartContext,
} from "./runner/start.ts";
import { takeStopRequest } from "./runner/stop.ts";
import * as Paths from "./paths.ts";
import { isNoTargetHasRoom, NO_TARGET_HAS_ROOM, type FactorySessions, type Model } from "./sessions.ts";
import { type CliError, layer as cliLayer, SupersetCli } from "./paradev/cli.ts";
import { afterPass as writeBeltAfterPass, newBeltMemo } from "./paradev/belt.ts";
import { makePlacer } from "./paradev/placer.ts";
import { addProjectCommand } from "./paradev/projects.ts";
import { checkProxy, liveProxyGet, type ProxyAnswer, type ProxyGet } from "./paradev/proxy.ts";
import { check as checkCli, describeFailure } from "./paradev/schema.ts";
import {
  AgentProcess,
  agentProcessLayer,
  make as makeParadevSessions,
  type ParadevSessionsConfig,
  type TargetCount,
} from "./paradev/sessions.ts";
import {
  bindProcess,
  ClaimMemo,
  makeGitHub,
  type GitHubError,
  type IssueSummary,
  isTransientRead,
} from "./tracker/github.ts";

// bin.ts imports this module before it builds a layer, so from here on a full disk under
// launchd drops log lines instead of ending the runner, during startup too.
guardLogStreams();

/** The runner's version, as `package.json` has it. */
export const version = Paths.packageVersion(NodePath.resolve(import.meta.dirname, ".."));

/**
 * The running factory, for the code that wakes it. Its `status` follows `reload`.
 */
export class FactoryLoop extends Context.Service<
  FactoryLoop,
  Loop & {
    readonly status: FactoryStatus;
    /**
     * Reads the machine config again and applies it: the next pass runs on it, and a pass under
     * way finishes on the config it started with. A config that is missing or does not load
     * leaves the factory idle.
     */
    readonly reload: Effect.Effect<void>;
  }
>()("factory-runner/main/FactoryLoop") {}

const idle = (reason: string): FactoryStatus => ({ state: "idle", reason });

/**
 * How long an issue must have sat in `factory:triage` or `factory:building` with no assignee
 * before the pass treats it as a claim that was cut short: long enough that a claim in flight
 * (the label is swapped and the assignee follows within seconds) is never raced.
 */
const CLAIM_GRACE_MS = 15 * 60 * 1000;

const asPassError =
  (kind: PassError["kind"], prefix = "") =>
  (error: { readonly message: string }): PassError => ({
    kind,
    message: `${prefix}${error.message}`,
  });

/** The pass error of a failed tracker read, marked transient when another try may well succeed. */
const asTrackerPassError = (error: GitHubError): PassError => ({
  kind: "tracker",
  message: error.message,
  transient: isTransientRead(error),
});

const byNumber = (a: number, b: number) => a - b;

/** The issues nobody is assigned to, with their label names, by number. */
const unassignedByNumber = (items: ReadonlyArray<IssueSummary>) =>
  items
    .filter((item) => item.assignees.length === 0)
    .map((item) => ({ number: item.number, labels: item.labels }))
    .sort((a, b) => byNumber(a.number, b.number));

/** The numbers of the issues `user` is the only assignee of, by number. */
const assignedOnlyTo = (items: ReadonlyArray<IssueSummary>, user: string) =>
  items
    .filter((item) => isOurs(item.assignees, user))
    .map((item) => item.number)
    .sort(byNumber);

/** A project config that could not be had: the pass's error, and the same problems per field. */
interface ProjectReadError extends PassError {
  readonly errors: ReadonlyArray<ConfigError>;
  /** Set once the read knows whether the repo runs on the default or on its own block. */
  readonly onDefault?: boolean;
}

/** The checkout's own `.dw/config.yml`, for a repo whose default branch `branch` has none on GitHub. */
const fromCheckout = Effect.fn("Factory.fromCheckout")(function* (
  checkout: string,
  branch: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(checkout, PROJECT_CONFIG_PATH);
  const text = yield* fs.readFileString(file).pipe(
    Effect.mapError((error): ProjectReadError => {
      const message = `${PROJECT_CONFIG_PATH} is not on ${branch} on GitHub, and cannot read ${file}: ${error.message}`;
      return { kind: "config", message, errors: [{ file, message }] };
    }),
  );
  return { file, text };
});

/**
 * `.dw/config.yml` from GitHub's default branch, or the checkout's copy only when GitHub has none
 * (some gates hold machine-specific commands); its `base` must be the default branch. A `defaulted`
 * repo runs on the machine's default unless GitHub's copy has a `factory` block; `onDefault` says
 * which.
 */
const projectFromBase = Effect.fn("Factory.projectFromBase")(function* (
  github: ReturnType<typeof makeGitHub>,
  checkout: string,
  defaulted?: Defaulted,
  defaultProject?: DefaultProject,
) {
  const found = yield* github.baseConfig().pipe(
    Effect.mapError((error): ProjectReadError => ({
      kind: "config",
      message: `cannot read ${PROJECT_CONFIG_PATH} from GitHub: ${error.message}`,
      transient: isTransientRead(error),
      errors: [
        {
          file: PROJECT_CONFIG_PATH,
          message: `cannot read ${PROJECT_CONFIG_PATH} from GitHub: ${error.message}`,
        },
      ],
    })),
  );
  if (defaulted !== undefined && (found.text === null || factoryOptIn(found.text) === "no")) {
    const resolved: Result.Result<ProjectConfig, ReadonlyArray<ConfigError>> = defaultProject ===
    undefined
      ? Result.fail([
          {
            file: PROJECT_CONFIG_PATH,
            message: "the machine config has no default_project, and the repo has no factory block",
          },
        ])
      : resolveDefault(defaultProject, found.branch, defaulted.head);
    if (Result.isSuccess(resolved)) return { project: resolved.success, onDefault: true };
    return yield* Effect.fail<ProjectReadError>({
      kind: "config",
      message: resolved.failure.map(formatConfigError).join("; "),
      errors: resolved.failure,
      onDefault: true,
    });
  }
  return yield* ownBlock(found, checkout).pipe(
    Effect.mapError((error): ProjectReadError => ({ ...error, onDefault: false })),
  );
});

/** The repo's own `factory` block: GitHub's copy, else the checkout's, naming the default branch. */
const ownBlock = Effect.fn("Factory.ownBlock")(function* (
  found: { readonly branch: string; readonly text: string | null },
  checkout: string,
) {
  const { file, text } =
    found.text !== null
      ? { file: `${found.branch}:${PROJECT_CONFIG_PATH}`, text: found.text }
      : yield* fromCheckout(checkout, found.branch);
  const parsed = parseProjectConfig(text, file);
  if (Result.isFailure(parsed)) {
    return yield* Effect.fail<ProjectReadError>({
      kind: "config",
      message: parsed.failure.map(formatConfigError).join("; "),
      errors: parsed.failure,
    });
  }
  if (parsed.success.base !== found.branch) {
    const rule =
      found.text !== null
        ? "the config must be committed on its own base branch"
        : "a checkout's config must name the default branch as its base";
    const message = `${file} names base \`${parsed.success.base}\`, but the repo's default branch is \`${found.branch}\`: ${rule}`;
    return yield* Effect.fail<ProjectReadError>({
      kind: "config",
      message,
      errors: [{ file, field: "factory.base", message }],
    });
  }
  return { project: parsed.success, onDefault: false };
});

/** What the live world runs its gates with, and what it does when one ends. */
export interface LiveGate {
  readonly gate: FactoryGate["Service"];
  /** Run when a gate ends with a decision (`gateDecided`), so the next pass carries on at once. */
  readonly wake: Effect.Effect<void>;
  /** The factory's scope: a gate still running when it closes is interrupted, and its cleanup runs. */
  readonly scope: Scope.Scope;
  /** How the machine's load is read. Default `os.loadavg`; a test passes the load it needs. */
  readonly readLoad?: () => Load;
  /** How a host is read over ssh. Default the `ssh` binary; a test passes the answers it needs. */
  readonly ssh?: SshSpawn;
  /** How the cloud proxy is asked with no key. Default `fetch`; a test passes the answers it needs. */
  readonly proxyGet?: ProxyGet;
  /** Asks the Paradev CLI (with --json) for the host checks: the parsed answer, or the error text. */
  readonly superset?: CliCall;
}

/** The run's line when its gate, started in the background, has ended. */
const gateWords = (run: string, step: GateStep): string => {
  switch (step.kind) {
    case "passed":
      return GATE_PASSED_LINE;
    case "sent-back":
      return `the gate failed on attempt ${step.attempt} and was sent back into the session`;
    case "stuck":
      return stuckLine(run);
    case "not-ready":
      return "nothing to gate";
    case "ended":
      return "the pull request was merged or closed, the run is finished";
    case "abandoned":
      return "the issue is closed, the run is closed";
    case "running":
      return "gate running";
    case "checks-pending":
      return "gate passed, waiting for the required checks to finish";
    case "queued":
      return gateQueued(step);
    case "unchanged":
      return "nothing moved";
  }
};

/** What started a re-gate, in the run's line. */
const MOVED_WORDS: Record<Moved, string> = {
  head: "the pull request's head moved",
  both: "the pull request's head and the base branch moved",
  conflict: "GitHub says the pull request conflicts with the base branch",
  earlier: "an earlier version of the factory began this re-gate",
};

/**
 * The run's line when the background re-gate of its `pr-open` pull request has ended; null for a
 * quiet one. A pass or failure starts with what started the re-gate: the head moved, the head and
 * base, a reported conflict, a re-gate an earlier version began, or no pass on record to compare
 * with.
 */
export const regateWords = (
  run: string,
  repo: string,
  step: GateStep,
  moved: Moved | null,
): string | null => {
  const said = moved === null ? "no pass was on record" : MOVED_WORDS[moved];
  switch (step.kind) {
    case "unchanged":
      return null;
    case "passed":
      return `${said}, the gate passed again, PR https://github.com/${repo}/pull/${step.pr} stays ready for review`;
    case "sent-back":
      return `${said}, the gate failed on attempt ${step.attempt}, the PR is a draft again and the session was told`;
    case "not-ready":
      return "the gate waits for the session";
    default:
      return gateWords(run, step);
  }
};

/**
 * The attention item for a gate that ended, or null: a gate that ended `stuck` or `abandoned`
 * needs a person, the same item `pass.ts` raises when `advance` finds the run so.
 */
export const gateItem = (
  repo: string,
  issue: number,
  run: string,
  step: GateStep | null,
): NewItem | null => {
  switch (step?.kind) {
    case "stuck":
      return stuckItem(repo, issue, run);
    case "abandoned":
      return abandonedItem(repo, issue, run);
    default:
      return null;
  }
};

/**
 * Whether a gate that ended changed something the next pass should act on at once. A gate that
 * decided nothing (the session still at work, another gate running, an error such as a rate
 * limit) waits for the normal poll, so the loop does not spin on it.
 */
export const gateDecided = (step: GateStep | null): boolean =>
  step !== null &&
  (step.kind === "passed" ||
    step.kind === "sent-back" ||
    step.kind === "stuck" ||
    step.kind === "ended" ||
    step.kind === "abandoned");

/**
 * What a world keeps for as long as the factory runs, however often a reload builds a new one:
 * the claim judgements, the runs whose gate this process is running now (a gate holds the
 * run's lock file only while an attempt runs; this covers the whole call), when each stuck
 * item's issue was last read, and which threads on a broken worktree are ruled out or waiting.
 */
export interface LiveShared {
  readonly gating: Set<string>;
  readonly claimMemo: ClaimMemo;
  readonly stuckReads: Map<string, number>;
  readonly brokenThreads: BrokenThreadMemo;
  readonly configSkips: Map<string, number>;
  readonly lastGood: Map<string, LastGood>;
  readonly cooldowns: Map<string, Cooldown>;
  readonly prunedAt: Map<string, number>;
  readonly paradevHold: { passes: number };
  /** Failed load reads in a row per host id: see `PassWorld.hostMisses`. */
  readonly hostMisses: Map<string, number>;
  /** Each host's load reading this pass: see `PassWorld.hostLoads`. */
  readonly hostLoads: Map<string, Load | null>;
  /** Passes in a row the cloud proxy has not answered 401: see `PassWorld.proxyMisses`. */
  readonly proxyMisses: { passes: number };
}

/** A fresh `LiveShared`, made once per process. */
export const newShared = (): LiveShared => ({
  gating: new Set(),
  claimMemo: new ClaimMemo(),
  stuckReads: new Map(),
  brokenThreads: { notFactory: new Set(), unsettled: new Map() },
  configSkips: new Map(),
  lastGood: new Map(),
  cooldowns: new Map(),
  prunedAt: new Map(),
  paradevHold: { passes: 0 },
  hostMisses: new Map(),
  hostLoads: new Map(),
  proxyMisses: { passes: 0 },
});

/** What the pass's branch prune answers: P1 prunes no branch. */
const NOTHING_PRUNED = { pruned: [], left: [], failed: [], waiting: 0 } as const;

/**
 * The pass over this machine: GitHub through `gh`, the ledger under `dataDir`, the wall clock.
 * It does not know which repos are watched, where the worktrees are or whether Paradev answers:
 * `startFactory` adds `watchedRepos`, `freeSpace`, `paradevDown` and `beginPlacement`.
 */
export const liveWorld = (
  machine: MachineConfig,
  dataDir: string,
  process: FactoryProcess["Service"],
  // What a pass reads a checkout's project config through.
  files: Layer.Layer<FileSystem.FileSystem | Path.Path>,
  sessions: FactorySessions["Service"],
  clock: () => number,
  host: string,
  attention: Pick<Attention["Service"], "list" | "raise" | "clear">,
  live: LiveGate,
  gateRemoteBase?: string,
  onProject?: (repo: string, reading: RepoConfigReading) => void,
  // Built once per process by the factory, so a reload's new world goes on from the old one's.
  {
    gating,
    claimMemo,
    stuckReads,
    brokenThreads,
    configSkips,
    lastGood,
    cooldowns,
    prunedAt,
    paradevHold,
    hostMisses,
    hostLoads,
    proxyMisses,
  }: LiveShared = newShared(),
): Omit<PassWorld, "watchedRepos" | "freeSpace" | "paradevDown" | "beginPlacement"> => {
  const load = live.readLoad ?? readLoad;
  const ssh = live.ssh ?? liveSshSpawn(process);
  const proxyGet = live.proxyGet ?? liveProxyGet;
  // Every host is not ready until its check has passed: a new world is a new config load.
  const hostsNotReady = new Map(
    machine.hosts.map((host) => [host.id, "not checked yet since the config load"] as const),
  );
  const withProcess = <A, E>(effect: Effect.Effect<A, E, FactoryProcess>) =>
    Effect.provideService(effect, FactoryProcess, process);
  const githubFor = (watched: WatchedRepo) =>
    makeGitHub({ repo: watched.repo, ghConfigDir: machine.ghConfigDir });
  const trackerFor = (watched: WatchedRepo) => bindProcess(githubFor(watched), process);
  const tracker = (effect: Effect.Effect<unknown, GitHubError, FactoryProcess>) =>
    withProcess(effect).pipe(Effect.mapError(asPassError("tracker")));
  // A claim made while its model cools down from a rate limit launches on the model's fallback.
  const modelNow = (model: Model) =>
    launchModel(cooldowns, machine.modelFallbacks, model, clock()) ?? model;
  const startContext = (repo: Repo): StartContext => ({
    repo: repo.watched.repo,
    trackerUser: repo.trackerUser,
    machine: host,
    project: repo.project,
    dataDir,
    tracker: trackerFor(repo.watched),
    repoPath: repo.watched.path,
    ghConfigDir: machine.ghConfigDir,
    sessions,
    clock,
    launchModel: modelNow,
  });
  // A run's steps get the repo's project with the run's own base: the one its launch recorded.
  const buildingContext = (repo: Repo, project: ProjectConfig): BuildingContext => ({
    repo: repo.watched.repo,
    trackerUser: repo.trackerUser,
    machine: host,
    project,
    dataDir,
    tracker: trackerFor(repo.watched),
    sessions,
    clock,
  });
  // The steps of a building run that can also start the next attempt: `advance` finishes a
  // relaunch, `interrupted` decides one. The tracker and the sessions are the same for both.
  const interruptContext = (repo: Repo, project: ProjectConfig): InterruptContext => ({
    ...buildingContext(repo, project),
    repoProject: repo.project,
    repoPath: repo.watched.path,
    ghConfigDir: machine.ghConfigDir,
    tracker: trackerFor(repo.watched),
    sessions,
  });
  const gateContext = (repo: Repo, project: ProjectConfig): FeedbackContext => ({
    ...buildingContext(repo, project),
    tracker: trackerFor(repo.watched),
    repoPath: repo.watched.path,
    ghConfigDir: machine.ghConfigDir,
    sessions,
    gate: live.gate,
    maxConcurrentGates: machine.maxConcurrentGates,
    feedbackSeconds: machine.feedbackSeconds,
    gateOptions: {
      ghConfigDir: machine.ghConfigDir,
      clock,
      ...(gateRemoteBase !== undefined && { remoteBase: gateRemoteBase }),
    },
  });
  const recordError = (run: RunId, step: CauseStep, kind: ErrorKind, message: string) =>
    ledger(() => {
      const out = Ledger.open(dataDir, run, { clock });
      try {
        out.append(
          { event: "error", data: { step, kind, message } },
          makeCause(step, "step-failed"),
        );
      } finally {
        out.close();
      }
    });
  /**
   * Whether GitHub says the run's pull request conflicts with its base. The gate of such a run
   * takes no slot (it records the conflict without a checkout), so it starts even when every slot
   * is taken. A run with no pull request on record, or a read that fails, is no conflict.
   */
  const conflicting = Effect.fn("Factory.conflicting")(
    function* (repo: Repo, run: RunId) {
      const last = (yield* ledger(() => readProgress(readRun(dataDir, run).entries))).lastPr;
      if (last === null) return false;
      const pull = yield* trackerFor(repo.watched).pullRequest(last.pr);
      return pull !== null && pull.open && pull.mergeable === "conflicting";
    },
    Effect.orElseSucceed(() => false),
  );
  /**
   * The gate as a background fiber: its line is logged when it ends, as the pass's lines are, an
   * error goes to the run's ledger, a `stuck` or `abandoned` end raises its attention item, and the loop is
   * woken so the next pass carries on at once.
   */
  const startGate = Effect.fn("Factory.startGate")(function* (repo: Repo, run: RunId) {
    const id = runIdToString(run);
    if (gating.size >= machine.maxConcurrentGates && !(yield* conflicting(repo, run))) {
      return { kind: "queued", running: gating.size, max: machine.maxConcurrentGates } as const;
    }
    // Under load one gate runs at a time; the only gate always starts, so no run waits on a
    // machine busy with work that is not the factory's. Like a queued gate, nothing is written.
    if (gating.size > 0) {
      const over = overload(machine.maxLoadPerCore, load);
      if (over !== null) {
        return { kind: "high-load", oneMinute: over.oneMinute, limit: over.limit } as const;
      }
    }
    gating.add(id);
    const label = plain(`${repo.watched.repo}#${run.issue}`);
    /** The run's gate: a re-gate for a `pr-open` run, the gate of a building run otherwise. */
    const decide: Effect.Effect<
      { readonly state: State; readonly step: GateStep; readonly moved: Moved | null },
      GateStepError
    > = Effect.gen(function* () {
      const seen = yield* ledger(() => readProgress(readRun(dataDir, run).entries));
      const context = gateContext(repo, runProject(repo.project, seen.base));
      const state = seen.state;
      if (state === "pr-open") {
        const regated = yield* regate(context, run);
        return { state, step: regated.step, moved: regated.moved };
      }
      return { state: state ?? "building", step: yield* gateStep(context, run), moved: null };
    });
    yield* decide.pipe(
      Effect.matchEffect({
        onSuccess: ({ state, step, moved }) => {
          const words =
            state === "pr-open"
              ? regateWords(id, repo.watched.repo, step, moved)
              : gateWords(id, step);
          return (
            words === null ? Effect.void : Effect.logInfo(`${label} ${state}: ${words}`)
          ).pipe(Effect.as(step));
        },
        // No room for a relaunch is a wait, not an error: the next call sends it again.
        onFailure: (error) =>
          isNoTargetHasRoom(error)
            ? Effect.logInfo(`${label} pr-open: waits: ${NO_TARGET_HAS_ROOM}`).pipe(Effect.as(null))
            : Effect.logError(`error: ${label} gate: ${plain(error.message)}`).pipe(
            Effect.andThen(
              recordError(run, "gate", errorKind(error), error.message).pipe(
                Effect.catch((failed) =>
                  Effect.logError(
                    `error: ${label} gate: cannot record the error: ${plain(failed.message)}`,
                  ),
                ),
              ),
            ),
            Effect.as(null),
          ),
      }),
      Effect.ensuring(Effect.sync(() => gating.delete(id))),
      Effect.tap((step) => {
        const item = gateItem(repo.watched.repo, Number(run.issue), id, step);
        return item === null ? Effect.void : attention.raise(item);
      }),
      Effect.flatMap((step) => (gateDecided(step) ? live.wake : Effect.void)),
      Effect.forkIn(live.scope),
    );
    return { kind: "started" } as const;
  });
  return {
    project: (watched) =>
      withProcess(
        projectFromBase(
          githubFor(watched),
          watched.path,
          watched.defaulted,
          machine.defaultProject,
        ).pipe(Effect.provide(files)),
      ).pipe(
        Effect.tap(({ project, onDefault }) =>
          Effect.sync(() =>
            onProject?.(watched.repo, { kind: "ok", project, ...(onDefault && { onDefault }) }),
          ),
        ),
        Effect.map(({ project }) => project),
        Effect.tapError((error) =>
          // A transient failure with a last good copy says nothing new about the config: the
          // pass runs on that copy and the last reading stands. Without a copy the repo is
          // skipped, and the reading says why.
          lastGoodCopy(lastGood, watched.repo, "project", error) !== undefined
            ? Effect.void
            : Effect.sync(() =>
                onProject?.(watched.repo, {
                  kind: "errors",
                  errors: error.errors,
                  ...(error.onDefault !== undefined && { onDefault: error.onDefault }),
                }),
              ),
        ),
        Effect.mapError((error): PassError => ({
          kind: error.kind,
          message: error.message,
          ...(error.transient === undefined ? {} : { transient: error.transient }),
        })),
      ),
    trackerUser: (watched) =>
      withProcess(githubFor(watched).login()).pipe(Effect.mapError(asTrackerPassError)),
    unfinishedRuns: (only) => ledger(() => listUnfinishedRuns(dataDir, only)),
    readyIssues: (repo: Repo) =>
      withProcess(githubFor(repo.watched).listIssues("ready")).pipe(
        Effect.map((listing) => ({ items: unassignedByNumber(listing.items), cut: listing.cut })),
        Effect.mapError(asPassError("tracker")),
      ),
    triageIssues: (repo: Repo) =>
      withProcess(githubFor(repo.watched).listIssues("triage")).pipe(
        Effect.map((listing) => ({
          items: assignedOnlyTo(listing.items, repo.trackerUser),
          cut: listing.cut,
        })),
        Effect.mapError(asPassError("tracker")),
      ),
    unassignedClaims: (repo: Repo, known: ReadonlySet<number>) =>
      withProcess(
        githubFor(repo.watched).unassignedClaims(
          utcSecond(clock() - CLAIM_GRACE_MS),
          repo.trackerUser,
          known,
          claimMemo,
        ),
      ).pipe(
        Effect.map((scan) => ({
          claims: scan.claims,
          unread: scan.unread.map((u) => ({ issue: u.issue, message: u.error.message })),
        })),
        Effect.mapError(asPassError("tracker")),
      ),
    // Comment first, then label, as a refusal does: a failed label call leaves the issue where a
    // later pass finds it again. The comment counts as already posted only when it is the issue's
    // newest factory comment and newer than the label event that began this claim. An unreadable
    // label time posts it: at-least-once beats an unexplained move.
    releaseClaim: (repo: Repo, issue: number, from: State) => {
      const gh = githubFor(repo.watched);
      return tracker(
        Effect.gen(function* () {
          const newest = yield* gh.newestFactoryComment(issue);
          let explained = false;
          if (newestSays(newest, CUT_SHORT_COMMENT)) {
            const labeled = yield* Effect.result(gh.labeledAt(issue, from));
            explained =
              Result.isSuccess(labeled) &&
              labeled.success !== null &&
              newest.createdAt > labeled.success;
          }
          if (!explained) yield* gh.postComment(issue, CUT_SHORT_COMMENT);
          yield* gh.setState(issue, "proposed");
        }),
      ).pipe(Effect.asVoid);
    },
    openBlockers: (repo: Repo, issue: number) =>
      withProcess(githubFor(repo.watched).openBlockers(issue)).pipe(
        Effect.mapError(asPassError("tracker")),
      ),
    dependsOnBlockers: (repo: Repo, issue: number) =>
      withProcess(githubFor(repo.watched).textBlockers(issue)).pipe(
        Effect.mapError(asPassError("tracker")),
      ),
    start: (repo: Repo, issue: number) => start(startContext(repo), issue),
    resume: (repo: Repo, issue: number) => resume(startContext(repo), issue),
    claimedIssues: (repo: Repo) =>
      withProcess(githubFor(repo.watched).claimedIssues()).pipe(
        Effect.mapError(asPassError("tracker")),
      ),
    yieldToClaim: (repo: Repo, issue: number) => yieldToClaim(startContext(repo), issue),
    takeStopRequest: (run) => takeStopRequest(dataDir, run, clock),
    timeLimit: (repo, run, base) =>
      timeLimit(buildingContext(repo, runProject(repo.project, base)), run),
    watch: (repo, run, base) => watch(buildingContext(repo, runProject(repo.project, base)), run),
    forward: (repo, run, base) =>
      forward(buildingContext(repo, runProject(repo.project, base)), run),
    advance: (repo, run, base) =>
      advance(interruptContext(repo, runProject(repo.project, base)), run),
    t3Trouble: () => ledger(() => t3TroubleSince(dataDir, clock())),
    // A runner restart does not stop a Paradev agent, so no start or stop is evidence.
    t3Starts: () => Effect.succeed([]),
    t3Stops: () => Effect.succeed([]),
    interrupted: (repo, run, base, evidence) =>
      interrupted(interruptContext(repo, runProject(repo.project, base)), run, evidence),
    resumeAfterCooldown: (repo, run, base, model) =>
      resumeAfterCooldown(interruptContext(repo, runProject(repo.project, base)), run, model),
    cooldowns,
    // Every Paradev session launches on the paradev block's model, whatever the project, so no
    // CLI call is needed to read it.
    projectModel: () => Effect.succeed(paradevModel(machine.paradev)),
    gateRunning: (run) =>
      gating.has(runIdToString(run)) || NodeFS.existsSync(gateLockFile(dataDir, run)),
    hasPendingGateSend: (run) =>
      ledger(() => gateSendPending(readProgress(readRun(dataDir, run).entries))),
    lastPass: (run) => lastPass(dataDir, run),
    issueClosed: (repo, issue) =>
      withProcess(githubFor(repo.watched).issue(issue)).pipe(
        Effect.map((detail) => detail.closed),
        Effect.mapError(asPassError("tracker")),
      ),
    stuckReads,
    openPull: (repo, pr) =>
      trackerFor(repo.watched)
        .pullRequest(pr)
        .pipe(
          Effect.map((pull) =>
            pull === null || !pull.open
              ? null
              : { head: pull.headSha.toLowerCase(), mergeable: pull.mergeable },
          ),
          Effect.mapError(asPassError("tracker")),
        ),
    gate: startGate,
    load,
    feedback: (repo, run, base) => feedback(gateContext(repo, runProject(repo.project, base)), run),
    recordError,
    handPause: () => loadHandPause(dataDir),
    paradevHold,
    ssh,
    hostMisses,
    hostLoads,
    proxyMisses,
    checkProxy: () =>
      machine.cloud === undefined
        ? Effect.succeed<ProxyAnswer>({ kind: "down", reason: "no cloud block in the machine config" })
        : checkProxy(proxyGet, machine.cloud.proxy),
    hostsNotReady,
    hostCheckedAt: new Map(),
    checkHost: (host) =>
      checkHost(
        { ssh, superset: live.superset ?? (() => Effect.fail("no Paradev CLI to ask")) },
        machine,
        host,
      ),
    // Paradev removes a workspace's worktree when it archives it, so no thread is left on one.
    threadsOnBrokenWorktrees: () => Effect.succeed([]),
    sessionRuns: () =>
      ledger(() => runsByThread(dataDir)).pipe(Effect.mapError(asPassError("ledger"))),
    brokenThreads,
    configSkips,
    lastGood,
    archiveThread: (threadId) =>
      sessions.archive(threadId).pipe(Effect.mapError(asPassError("t3"))),
    pruneBranches: () => Effect.succeed(NOTHING_PRUNED),
    prunedAt,
    nowMs: clock,
    machineName: host,
    attention,
    record: (event: MachineEvent) =>
      ledger(() => {
        const log = MachineLog.open(dataDir, { clock });
        try {
          log.append(event);
        } finally {
          log.close();
        }
      }),
  };
};

export const hostName = (): string => {
  try {
    return NodeOS.hostname() || "unknown";
  } catch {
    return "unknown";
  }
};

/** How a pass ended, for the count of passes that error in a row. */
const outcomeOf = (exit: Exit.Exit<Report>, lastError: () => string | null): PassOutcome => {
  if (Exit.isSuccess(exit)) {
    const errors = exit.value.errors;
    return errors === 0
      ? { ok: true }
      : { ok: false, message: lastError() ?? `${errors} error lines` };
  }
  return {
    ok: false,
    message: Cause.hasInterruptsOnly(exit.cause)
      ? "the pass was stopped before it finished"
      : `the pass died: ${String(Cause.squash(exit.cause))}`,
  };
};

/** What the factory's runtime can be told, for a test that cannot wait. */
export interface RuntimeOptions {
  /** Where the gate fetches `<owner>/<name>.git` from. Default `https://github.com`; a test passes a `file://` base. */
  readonly gateRemoteBase?: string;
  /** Called with each world a start or reload builds, once the world is built: for a test that needs the pass world a reload built. */
  readonly onWorld?: (world: PassWorld) => void;
  /** How a directory's free space is read. Default `statfs`; a test passes the sizes it needs. */
  readonly readFreeSpace?: (path: string) => FreeSpace;
  /** How the machine's load is read. Default `os.loadavg`; a test passes the load it needs. */
  readonly readLoad?: () => Load;
  /** How a host is read over ssh. Default the `ssh` binary; a test passes the answers it needs. */
  readonly ssh?: SshSpawn;
  /** How the cloud proxy is asked with no key. Default `fetch`; a test passes the answers it needs. */
  readonly proxyGet?: ProxyGet;
  /** What the Paradev adapter is built with beyond the `paradev` block: a test's remote base and waits. */
  readonly sessions?: Partial<Omit<ParadevSessionsConfig, "agent" | "model" | "effort">>;
}

/** A pass of a factory with no config to run on. */
const NO_PASS: Report = { runs: 0, claimed: 0, errors: 0, attention: 0 };

/** The config a pass runs on, with the world built for it. */
interface Current {
  readonly machine: MachineConfig;
  readonly world: PassWorld;
  /** Hands the pass's status to the belt writer; does nothing with the belt off. Never fails. */
  readonly afterPass: Effect.Effect<void, never, FileSystem.FileSystem | Path.Path>;
  /** Archives orphaned cloud workspaces; does nothing when no repo names a cloud environment. Never fails. */
  readonly sweep: Effect.Effect<void>;
}

/** What the Paradev hold reads from a failed CLI call. */
const downOf = (error: CliError): ParadevDown => ({
  reason: error.kind === "PARADEV_SIGNED_OUT" ? "signed-out" : "offline",
  message: error.message,
});

/** The item a repo whose clone is no Paradev project on this Mac keeps open, by repo. */
const noProjectItemId = (repo: string) => `no-paradev-project:${asciiLower(repo)}`;

/**
 * The item a repo whose clone is the Paradev project of another GitHub repo (`other`, null for
 * none) keeps open, by repo and that other repo, so a project that changes repo raises a new item.
 */
const otherRepoItemPrefix = (repo: string) => `paradev-project-repo:${asciiLower(repo)}:`;
const otherRepoItemId = (repo: string, other: string | null) =>
  `${otherRepoItemPrefix(repo)}${other === null ? "-" : asciiLower(other)}`;

/** The most of a manifest the default-branch reads take; a longer one is a read that did not finish. */
const MANIFEST_BYTES = 4 * 1024 * 1024;

/**
 * `git -C root <args>` in a runner clone, for the reads of its default branch: its output, null
 * when git ended non-zero, "unresolved" when git did not finish. A read of a blob runs no filter
 * or hook.
 */
const gitOutput = (process: FactoryProcess["Service"], root: string, args: ReadonlyArray<string>) =>
  process
    .run({
      command: "git",
      args: ["-C", root, ...args],
      separateStderr: true,
      timeoutMs: 10_000,
      tailBytes: MANIFEST_BYTES,
    })
    .pipe(
      Effect.option,
      Effect.map((shown) =>
        Option.isNone(shown) || shown.value.timedOut || shown.value.tailTruncated
          ? ("unresolved" as const)
          : shown.value.exitCode === 0
            ? shown.value.tail
            : null,
      ),
    );

/**
 * The branch origin's HEAD names and the manifests committed at its root, for a repo the
 * machine's `default_project` may build: what `resolveDefault` infers the gate from. A clone with
 * no `origin/HEAD` has none to read, and its reading says so. The runner never pulls the clone;
 * each launch fetches its base into the clone's `refs/remotes/origin/<base>`, so these read the
 * default branch as of the last launch on it.
 */
export const defaultedFiles = Effect.fn("Factory.defaultedFiles")(function* (
  process: FactoryProcess["Service"],
  root: string,
): Effect.fn.Return<Defaulted | "unresolved"> {
  const head = yield* gitOutput(process, root, ["rev-parse", "--abbrev-ref", "origin/HEAD"]);
  if (head === "unresolved") return head;
  if (head === null) return { head: null };
  const tree = yield* gitOutput(process, root, ["ls-tree", "--name-only", "origin/HEAD"]);
  if (tree === null || tree === "unresolved") return "unresolved";
  const names = new Set(tree.split("\n"));
  const shown = (name: string) =>
    names.has(name) ? gitOutput(process, root, ["show", `origin/HEAD:${name}`]) : Effect.succeed(null);
  const packageJson = yield* shown("package.json");
  const composerJson = yield* shown("composer.json");
  if (
    packageJson === "unresolved" ||
    composerJson === "unresolved" ||
    (packageJson === null && names.has("package.json")) ||
    (composerJson === null && names.has("composer.json"))
  ) {
    return "unresolved";
  }
  return {
    head: {
      branch: head.trim().replace(/^origin\//, ""),
      files: { packageJson, composerJson, lockfiles: LOCKFILES.filter((name) => names.has(name)) },
    },
  };
});

const startFactory = Effect.fn("Factory.startFactory")(function* (options: RuntimeOptions) {
  const paths = yield* Paths.FactoryPaths;
  const { factoryDir, machineConfigPath, worktreesDir } = paths;
  const attention = yield* Attention;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const process = yield* FactoryProcess;
  const agents = yield* AgentProcess;
  const gate = yield* FactoryGate;
  const scope = yield* Effect.scope;
  // Gates run inside this process, so a lock file left from an earlier run belongs to a dead gate.
  const cleared = yield* clearGateLocks(factoryDir);
  if (cleared > 0) yield* Effect.logInfo(`cleared ${cleared} gate lock(s)`);

  // What `reload` changes and the loop reads: a pass takes `current` once, at its start.
  const state: {
    current: Current | null;
    loop: Loop | null;
    status: FactoryStatus;
    watched: ReadonlyArray<string>;
    started: boolean;
  } = {
    current: null,
    loop: null,
    status: idle("no factory config"),
    watched: [],
    started: false,
  };
  const shared = newShared();
  // What the one placer reads from the current start; a reload sets it again, and the placer, with
  // its launches in flight, stays. A gate fiber that outlives a reload places through it too.
  let placing: {
    readonly machine: MachineConfig;
    readonly repoOfProject: (projectId: string) => WatchedRepo | null;
    readonly hostsNotReady: () => ReadonlyMap<string, string>;
    readonly running: Effect.Effect<ReadonlyArray<TargetCount>>;
    readonly record: (event: MachineEvent) => Effect.Effect<void>;
  } | null = null;
  const placingNow = () => {
    if (placing === null) throw new Error("a launch was placed before the factory started");
    return placing;
  };
  const placer = makePlacer({
    get machine() {
      return placingNow().machine;
    },
    repoOfProject: (projectId) => placingNow().repoOfProject(projectId),
    hostLoads: shared.hostLoads,
    hostsNotReady: () => placingNow().hostsNotReady(),
    readLoad: options.readLoad ?? readLoad,
    running: Effect.suspend(() => placingNow().running),
    record: (event) => Effect.suspend(() => placingNow().record(event)),
  });
  // The last belt written, and the run reads it was made from: kept across reloads.
  const beltMemo = newBeltMemo();
  const beltRuns: RunReadCache = new Map();
  let beltWriting = false;
  let sweeping = false;
  let checkingHosts = false;

  const onePass = Effect.gen(function* () {
    const current = state.current;
    if (current === null) return NO_PASS;
    if (!state.started) {
      state.started = true;
      yield* Effect.logInfo("runner started");
    }
    // Each line is logged as it is decided, so a pass that hangs or dies has said what it did.
    const context = yield* Effect.context<never>();
    const log = Effect.runSyncWith(context);
    let lastError: string | null = null;
    // The sweep goes beside the pass, one at a time, as the belt does: a slow cloud holds up no pass.
    if (!sweeping) {
      sweeping = true;
      yield* current.sweep.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            sweeping = false;
          }),
        ),
        Effect.interruptible,
        Effect.forkIn(scope),
      );
    }
    // The host checks go beside the pass the same way: a host that is slow to answer holds up no
    // claim, and a check runs to its real first failing line however long its calls take.
    if (!checkingHosts) {
      checkingHosts = true;
      yield* checkHosts(current.world, current.machine).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            checkingHosts = false;
          }),
        ),
        Effect.interruptible,
        Effect.forkIn(scope),
      );
    }
    // The belt goes to Paradev beside the loop, one write at a time, so a hung Paradev holds up
    // no pass and no shutdown. A pass that ends while a write is still going hands nothing over:
    // the next one does.
    const belt = Effect.suspend(() => {
      if (beltWriting) return Effect.void;
      beltWriting = true;
      return current.afterPass.pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.ensuring(
          Effect.sync(() => {
            beltWriting = false;
          }),
        ),
        Effect.interruptible,
        Effect.forkIn(scope),
        Effect.asVoid,
      );
    });
    return yield* runPass(current.world, current.machine, (line) => {
      if (line.startsWith("error: ")) lastError = line;
      log(Effect.logInfo(line));
    }).pipe(
      Effect.onExit((exit) =>
        attention.passEnded(outcomeOf(exit, () => lastError)).pipe(
          // A pass that died hands the belt over too, so the page shows the failures; a pass
          // stopped by a shutdown or reload does not.
          Effect.andThen(Exit.hasInterrupts(exit) ? Effect.void : belt),
        ),
      ),
    );
  });

  const start = Effect.fn("Factory.start")(function* (machine: MachineConfig) {
    const services = Layer.mergeAll(
      Layer.succeed(FileSystem.FileSystem)(fileSystem),
      Layer.succeed(Path.Path)(path),
      Layer.succeed(FactoryProcess)(process),
      Layer.succeed(AgentProcess)(agents),
      Layer.succeed(Paths.FactoryPaths)(paths),
    );
    const paradev = Layer.provideMerge(cliLayer({ cli: machine.paradev.cli }), services);
    const cli = yield* Effect.provide(
      Effect.gen(function* () {
        return yield* SupersetCli;
      }),
      paradev,
    );
    // The watched repo of each local Paradev project, from the last project listing that answered.
    let repoOfProject = new Map<string, WatchedRepo>();
    // Placement reads the world's host readings and the adapter's counts; both are built after it,
    // and neither is read before a launch, so its dependencies are looked up when it asks.
    placing = {
      machine,
      repoOfProject: (projectId) => repoOfProject.get(projectId) ?? null,
      hostsNotReady: () => base.hostsNotReady,
      running: Effect.suspend(() => sessions.runningByTarget),
      record: (event) =>
        base.record(event).pipe(
          Effect.catch((error) => Effect.logWarning(`the machine log could not take a placement: ${error.message}`)),
        ),
    };
    const sessions = yield* makeParadevSessions({
      ...options.sessions,
      agent: machine.paradev.agent,
      ...(machine.paradev.model === undefined ? {} : { model: machine.paradev.model }),
      ...(machine.paradev.effort === undefined ? {} : { effort: machine.paradev.effort }),
      ghConfigDir: machine.ghConfigDir,
      hosts: machine.hosts,
      cloud: machine.cloud !== undefined,
      place: placer.place,
      launchEnded: placer.launchEnded,
    }).pipe(Effect.provide(paradev));
    // Only a repo that names a cloud environment can have a cloud run, and so an orphan.
    const sweep = machine.repos.some((entry) => entry.cloud !== undefined)
      ? sessions.sweepOrphans.pipe(
          Effect.catch((error) =>
            Effect.logWarning(
              `the cloud orphan sweep failed: ${error.cause instanceof Error ? error.cause.message : String(error.cause)}`,
            ),
          ),
        )
      : Effect.void;
    // The CLI check runs at start and on every reload, and again each pass until it passes.
    let cliChecked = false;
    // What the belt says of Paradev: the version the check read, and the last pass's answer.
    let cliVersion = "unknown";
    let paradevOnline = false;
    const readParadevDown = Effect.fn("Factory.paradevDown")(function* () {
      if (!cliChecked) {
        const checked = yield* Effect.result(checkCli.pipe(Effect.provideService(SupersetCli, cli)));
        if (Result.isFailure(checked)) return downOf(checked.failure);
        cliVersion = checked.success.version;
        const failure = describeFailure(checked.success);
        if (failure !== null) return { reason: "cli-check", message: failure } satisfies ParadevDown;
        cliChecked = true;
      }
      const status = yield* Effect.result(cli.run(["status"]));
      return Result.isFailure(status) ? downOf(status.failure) : null;
    });
    const paradevDown = () =>
      readParadevDown().pipe(
        Effect.tap((down) =>
          Effect.sync(() => {
            paradevOnline = down === null;
          }),
        ),
      );
    const beltTarget = {
      cli,
      dataDir: factoryDir,
      host: hostName(),
      version,
      visibility: machine.paradev.belt.visibility,
      memo: beltMemo,
    };
    const afterPass = machine.paradev.belt.enabled
      ? Effect.gen(function* () {
          const nowMs = Date.now();
          yield* writeBeltAfterPass(
            beltTarget,
            {
              nowMs,
              paradevCli: cliVersion,
              claimsPaused: loadHandPause(factoryDir) !== null,
              paradevOnline,
              attention: yield* attention.list(),
            },
            beltRuns,
          );
        })
      : Effect.void;
    // The loop is made after the world, so a gate that ends wakes whatever loop there is then.
    const base = liveWorld(
      machine,
      factoryDir,
      process,
      Layer.mergeAll(
        Layer.succeed(FileSystem.FileSystem)(fileSystem),
        Layer.succeed(Path.Path)(path),
      ),
      sessions,
      () => Date.now(),
      hostName(),
      attention,
      {
        gate,
        wake: Effect.suspend(() => state.loop?.wake ?? Effect.void),
        scope,
        ...(options.readLoad !== undefined && { readLoad: options.readLoad }),
        ...(options.ssh !== undefined && { ssh: options.ssh }),
        ...(options.proxyGet !== undefined && { proxyGet: options.proxyGet }),
        superset: (argv) => cli.run(argv, { timeoutMs: 30_000 }).pipe(Effect.mapError((e) => e.text.split("\n")[0] ?? e.text)),
      },
      options.gateRemoteBase,
      undefined,
      shared,
    );
    // The repos `repos:` lists, each with its clone a Paradev project on this Mac. A repo whose
    // clone is none, or is the project of another GitHub repo (a `path` copied from another
    // entry), is skipped with one item that says so: a session there would work on the other
    // repo's code; the launch refuses such a project too, for a pass whose lookup failed. A lookup
    // that fails keeps the repo and its items as they are, since the Paradev hold already covers
    // a Paradev that does not answer. A repo that has left `repos:`
    // has departed while it still has an open item: read from the items, so it holds across
    // restarts.
    const listWatched = Effect.gen(function* () {
      const repos: Array<WatchedProject> = [];
      const unresolved: Array<string> = [];
      // One `projects list` answers every repo.
      const listing = yield* Effect.result(sessions.findProjects(machine.repos.map((entry) => entry.path)));
      const projects = Result.isSuccess(listing) ? listing.success : null;
      const byProject = new Map<string, WatchedRepo>();
      for (const [index, entry] of machine.repos.entries()) {
        if (projects !== null) {
          const project = projects[index] ?? null;
          const skip =
            project === null
              ? {
                  reason: "no-paradev-project",
                  id: noProjectItemId(entry.repo),
                  message: `${plain(entry.repo)}: its clone ${plain(entry.path)} is no Paradev project on this Mac; add it once with: ${plain(addProjectCommand(entry.path))}`,
                }
              : isOtherRepoProject(project, entry.repo)
                ? {
                    reason: "paradev-project-repo",
                    id: otherRepoItemId(entry.repo, project.repo ?? null),
                    message: `${plain(entry.repo)}: its clone ${plain(entry.path)} is the Paradev project of ${plain(project.repo ?? "no GitHub repo")}; point its path at a clone of ${plain(entry.repo)}`,
                  }
                : null;
          yield* attention.clear(
            (item) =>
              item.id !== skip?.id &&
              (item.id === noProjectItemId(entry.repo) ||
                item.id.startsWith(otherRepoItemPrefix(entry.repo))),
          );
          if (skip !== null) {
            yield* base.record({
              event: "claim_skipped",
              data: { repo: entry.repo, reason: skip.reason },
            });
            yield* attention.raise({
              id: skip.id,
              kind: "attention",
              repo: entry.repo,
              issue: null,
              run: null,
              message: skip.message,
            });
            continue;
          }
          if (project !== null) byProject.set(project.id, entry);
        }
        if (machine.defaultProject === undefined) {
          repos.push({ ...entry, title: entry.repo });
          continue;
        }
        const defaulted = yield* defaultedFiles(process, entry.path);
        if (defaulted === "unresolved") unresolved.push(entry.path);
        else repos.push({ ...entry, title: entry.repo, defaulted });
      }
      // A lookup that failed keeps the last listing: placement then still knows each project's repo.
      if (projects !== null) repoOfProject = byProject;
      const listed = new Set(machine.repos.map((entry) => asciiLower(entry.repo)));
      const departed = [
        ...new Set(
          (yield* attention.list())
            .flatMap((item) => (item.repo === null ? [] : [asciiLower(item.repo)]))
            .filter((repo) => !listed.has(repo)),
        ),
      ];
      state.watched = repos.map((entry) => entry.repo);
      if (state.status.state === "running") {
        state.status = {
          ...state.status,
          settings: { ...state.status.settings, repos: state.watched },
        };
      }
      return { repos, departed, unresolved } satisfies WatchedListing;
    }).pipe(Effect.catch((error) => Effect.fail(asPassError("ledger")(error))));
    const world: PassWorld = {
      ...base,
      watchedRepos: listWatched,
      beginPlacement: placer.beginPass,
      paradevDown,
      // The sessions write under Paradev's worktrees folder, the gate under the factory dir.
      freeSpace: () =>
        sessions.worktreesDirectory(worktreesDir).pipe(
          Effect.mapError(asPassError("t3")),
          Effect.flatMap((worktrees) =>
            Effect.try({
              try: () =>
                readLowestFreeSpace(
                  [...(worktrees === null ? [] : [worktrees]), factoryDir],
                  options.readFreeSpace,
                ),
              // Local disk, as softfac files it: the kind the machine's own files have.
              catch: (cause): PassError => ({
                kind: "ledger",
                message: cause instanceof Error ? cause.message : String(cause),
              }),
            }),
          ),
        ),
    };
    options.onWorld?.(world);
    state.current = { machine, world, afterPass, sweep };
    state.status = {
      state: "running",
      settings: {
        pollSeconds: machine.pollSeconds,
        maxConcurrentRuns: machine.maxConcurrentRuns,
        repos: state.watched,
      },
    };
    if (state.loop !== null) {
      yield* Effect.logInfo("factory config reloaded");
      return yield* state.loop.wake;
    }
    // The first pass runs at once, on the config just set.
    state.loop = yield* runLoop(
      onePass,
      () => state.current?.machine.pollSeconds ?? DEFAULT_POLL_SECONDS,
    ).pipe(Effect.provideService(Scope.Scope, scope));
  });

  const reloadNow = Effect.gen(function* () {
    const loaded = yield* Effect.result(loadMachineConfig(machineConfigPath));
    if (Result.isFailure(loaded)) {
      for (const error of loaded.failure.errors) {
        yield* Effect.logError(formatConfigError(error));
      }
      yield* attention.raise({
        id: CONFIG_ITEM_ID,
        kind: "config",
        repo: null,
        issue: null,
        run: null,
        message: `machine config not loaded: ${loaded.failure.errors.map(formatConfigError).join("; ")}`,
      });
      state.current = null;
      state.status = idle("factory config failed to load");
      return;
    }
    yield* attention.clear((item) => item.id === CONFIG_ITEM_ID);
    if (Option.isNone(loaded.success)) {
      yield* Effect.logInfo(`no factory config at ${machineConfigPath}`);
      state.current = null;
      state.status = idle("no factory config");
      return;
    }
    const { config: machine, warnings } = loaded.success.value;
    for (const warning of warnings) {
      yield* Effect.logWarning(formatConfigError(warning));
    }
    yield* attention.setNotify(machine.notify);
    yield* start(machine);
  }).pipe(Effect.provideService(FileSystem.FileSystem, fileSystem));

  // One reload at a time, and none cut short half way: two at once from idle would make two loops.
  const lock = yield* Semaphore.make(1);
  const reload = lock.withPermits(1)(Effect.uninterruptible(reloadNow));

  yield* reload;
  return {
    wake: Effect.suspend(() => state.loop?.wake ?? Effect.void),
    awaitPass: Effect.suspend(() => state.loop?.awaitPass ?? Effect.never),
    passRunning: Effect.suspend(() => state.loop?.passRunning ?? Effect.succeed(false)),
    get status() {
      return state.status;
    },
    reload,
  } satisfies FactoryLoop["Service"];
});

/**
 * Gives FactoryLoop and Attention. Needs FactoryPaths, FactoryProcess, AgentProcess, FactoryGate,
 * FileSystem and Path: what main.test.ts builds with a test FactoryPaths, a FactoryProcess that
 * answers the Paradev CLI from the recorded fixtures, a faked process lookup and a gate.
 */
export const factoryRuntime = (options: RuntimeOptions = {}) =>
  Layer.effect(FactoryLoop, startFactory(options)).pipe(
    Layer.provideMerge(AttentionService.layer()),
  );

/** The runner's root layer: what `factory-runner run` launches. */
export const FactoryLayer = factoryRuntime().pipe(
  Layer.provideMerge(Paths.layer),
  Layer.provide(Gate.layer),
  Layer.provide(agentProcessLayer),
  Layer.provide(Process.layer),
);
