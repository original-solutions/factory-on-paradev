/**
 * softfac's tick tests for the claims (`src/tick/tests.rs`: claiming new issues, which repo gets
 * a free slot, claims with no run, the limit, the blockers, the hand pause, and what the pass
 * records), ported over a scripted world. Lines that softfac's launch wrote are adapted to the
 * claim this issue stops at.
 */
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe } from "vitest";

import type { Attention, AttentionItem } from "./attention.ts";
import type { HandPause } from "./claims.ts";
import {
  timeLimitOnlyProjectConfig,
  type HostConfig,
  type MachineConfig,
  type ProjectConfig,
  type WatchedProject,
} from "./config.ts";
import { COOLDOWN_QUIET_MS, type Cooldown } from "./cooldown.ts";
import { readFreeSpace } from "./disk.ts";
import type { State } from "./domain/lifecycle.ts";
import type { Load } from "./load.ts";
import { LedgerIoError } from "./ledger/errors.ts";
import type { CauseStep, ErrorKind, MachineEvent } from "./ledger/events.ts";
import type { RunInfo } from "./ledger/listRuns.ts";
import {
  MachineLog,
  serverStartsSince,
  serverStopsForStartsSince,
  t3TroubleSince,
} from "./ledger/machineLog.ts";
import { newRunId, runIdToString, type RunId } from "./ledger/runId.ts";
import { useTempDirs } from "./ledger/testSupport.ts";
import { formatTs } from "./ledger/time.ts";
import {
  HOST_UNREACHABLE_PASSES,
  HOST_UNREACHABLE_PREFIX,
  PARADEV_OFFLINE_ITEM_ID,
  PARADEV_WAIT,
  PRUNE_EVERY_MS,
  STUCK_READ_EVERY_MS,
  UNSETTLED_READ_EVERY_MS,
  runPass,
  type BrokenThreadMemo,
  type LastGood,
  type Loaded,
  type PassError,
  type GateStart,
  type ParadevDown,
  type PassWorld,
  type PruneReport,
  type Repo,
  type Report,
  type ThreadOnBrokenWorktree,
} from "./pass.ts";
import {
  NotBuildingError,
  type AdvanceOutcome,
  type BuildingError,
  type CooldownOutcome,
  type Evidence,
  type ForwardOutcome,
  type InterruptOutcome,
  type LimitOutcome,
  type WatchOutcome,
} from "./runner/building.ts";
import type { FeedbackStep } from "./runner/feedback.ts";
import type { LastPass } from "./runner/gating.ts";
import {
  CLAIM_GAVE_WAY,
  GateRunningError,
  type StartError,
  type StartOutcome,
} from "./runner/start.ts";
import type { StopRequestOutcome } from "./runner/stop.ts";
import {
  MessageRejectedError,
  SessionsError,
  type Model,
} from "./sessions.ts";
import type { SshAnswer, SshRunner } from "./paradev/ssh.ts";
import { GitHubFailed, type Blocker, type Mergeable } from "./tracker/github.ts";

const REPO = "rawphp/softfac";
const OTHER = "rawphp/other";
/** What the fake's clock reads until a test moves it. */
const T0 = 1_791_380_000_000;
const BUILDING: State = "building";
/** The head a pr-open run's pass ran on, and where it moves to. */
const HEAD = "4f1c2d3e4a5b60718293a4b5c6d7e8f901234567";
const PUSHED = "7e6d5c4b3a291807f6e5d4c3b2a190817263a4b5";
const MOVED = "9f8e7d6c5b4a39281706f5e4d3c2b1a098765432";

const rid = (issue: number, repo = REPO): RunId => newRunId(repo, String(issue), 1);

const machine = (max: number): MachineConfig => ({
  ghConfigDir: "/gh/rawphp",
  pollSeconds: 60,
  maxConcurrentRuns: max,
  maxConcurrentGates: 2,
  feedbackSeconds: 600,
  notify: true,
  minFreeGib: 10,
  maxLoadPerCore: 1,
  modelFallbacks: {},
  repos: [],
  hosts: [],
  local: { maxRuns: max },
  paradev: {
    cli: "/opt/superset",
    agent: "claude",
    belt: { enabled: false, visibility: "just_me" },
  },
});

const GIB = 1024 ** 3;
const MINUTE = 60_000;

/** The model the repos' T3 projects run on unless a test says otherwise, and its fallback. */
const FABLE: Model = { instanceId: "claudeAgent", model: "claude-fable-5-1" };
const OPUS: Model = { instanceId: "claudeAgent", model: "claude-opus-5-5" };

/** What the T3 projects list as watched, for the repos a test names. */
const watchedOf = (repos: ReadonlyArray<string>): Array<WatchedProject> =>
  repos.map((repo) => ({ repo, path: `/p/${repo.replace("/", "-")}`, title: repo }));

const project = (): ProjectConfig => ({
  ...timeLimitOnlyProjectConfig(),
  instructors: ["tomkaczocha"],
  base: "main",
  gate: ["cargo test"],
});

const trackerFailure = (): PassError => ({
  kind: "tracker",
  message: "`gh issue list` exited with status 1: boom",
});

const githubFailure = (): StartError =>
  new GitHubFailed({ args: ["issue", "list"], status: 1, stderr: "boom" });

const started = (issue: number, repo = REPO): StartOutcome => ({
  kind: "started",
  run: rid(issue, repo),
  threadId: "thread-1",
});

type Answers<T> = Record<string, T | "error">;

/** What `forward` answers when the instructors said nothing new. */
const NOTHING_SENT: ForwardOutcome = {
  comments: 0,
  bodyEdit: false,
  skipped: null,
};

/** Everything the pass can touch, scripted. `calls` logs each call in order. */
class Fake implements PassWorld {
  projects: Record<string, ProjectConfig | string> = {};
  trackerUsers: Record<string, string | { error: string }> = {};
  /** Repos whose project config or tracker login failure is one GitHub never received. */
  transient = new Set<string>();
  /** A login failure is never transient, whatever `transient` says for the config. */
  loginHard = false;
  runs: Array<RunInfo> = [];
  runsError = false;
  ready: Answers<Array<number>> = {};
  readyCut: Array<string> = [];
  /** The label names a ready issue is listed with, by `<repo>#<n>`; none when absent. */
  labels: Record<string, Array<string>> = {};
  triage: Answers<Array<number>> = {};
  triageCut: Array<string> = [];
  unassigned: Answers<Array<{ issue: number; state: State }>> = {};
  releaseFails = false;
  blockers: Answers<Array<Blocker>> = {};
  depends: Answers<Array<Blocker>> = {};
  starts: Record<string, Array<StartOutcome | StartError>> = {};
  /** Issues whose `start` leaves a `triage` run behind, whatever it answers. */
  startLeavesRun: Array<number> = [];
  /** Scripted answers per `"<repo>#<issue>"`, popped per call; an exhausted script answers the default. */
  timeLimits: Record<string, Array<LimitOutcome | BuildingError>> = {};
  watches: Record<string, Array<WatchOutcome | BuildingError>> = {};
  forwards: Record<string, Array<ForwardOutcome | BuildingError>> = {};
  advances: Record<string, Array<AdvanceOutcome | BuildingError>> = {};
  /** What `feedback` answers per run id, popped per call; `none` once exhausted. */
  feedbackSteps: Record<string, Array<FeedbackStep | BuildingError>> = {};
  /** The run ids `feedback` was called for, in order. */
  feedbacks: Array<string> = [];
  /** What `takeStopRequest` answers per `"<repo>#<issue>"`; `none` otherwise. */
  stopRequests: Record<string, StopRequestOutcome | LedgerIoError> = {};
  pause: HandPause | null = null;
  /** What failed in Paradev this pass, if anything. */
  down: ParadevDown | null = null;
  paradevHold = { passes: 0 };
  /** The hosts of the machine config for the passes `pass` runs. */
  hosts: Array<HostConfig> = [];
  /** What each host answers over ssh, by destination: an answer, or `"fail"` for one that cannot be reached. A host not listed fails. */
  sshAnswers: Record<string, SshAnswer | "fail"> = {};
  /** `ssh <destination> <command>`, in the order the pass made them; also in `calls`. */
  sshCalls: Array<string> = [];
  ssh: SshRunner = (args) =>
    Effect.sync(() => {
      const destination = args[args.length - 2] ?? "";
      this.sshCalls.push(`${destination} ${args[args.length - 1] ?? ""}`);
      this.calls.push(`ssh ${destination}`);
      const answer = this.sshAnswers[destination] ?? "fail";
      return answer === "fail"
        ? { exitCode: 255, timedOut: false, stdout: "", stderr: "Connection refused\n" }
        : answer;
    });
  hostMisses = new Map<string, number>();
  hostLoads = new Map<string, Load | null>();
  hostsNotReady = new Map<string, string>();
  /** The free bytes `freeSpace` reports; `"error"` is a probe that fails. */
  free: number | "error" = 100 * GIB;
  /** The machine's `min_free_gib` for the passes `pass` runs. */
  minFreeGib = 10;
  /** The 1-minute load and the cores `load` reports. */
  loadAvg = { oneMinute: 2, cores: 12 };
  /** The machine's `max_load_per_core` for the passes `pass` runs. */
  maxLoadPerCore = 1;
  machineLogFails = false;
  /** When set, `record` appends to the real machine log in this dir and `t3Trouble` reads it, as the live world does. */
  machineLogDir: string | null = null;
  /** The server starts and stops `t3Starts` and `t3Stops` answer when there is no real machine log. */
  t3Starts_: ReadonlyArray<number> = [];
  t3Stops_: ReadonlyArray<number> = [];
  /** The evidence of the last `interrupted` call. */
  lastEvidence: Evidence | null = null;
  /** What the pass wrote to a run's ledger as an `error` line. */
  runErrors: Array<{ run: RunId; step: string; kind: ErrorKind; message: string }> = [];
  /** The next run ledger writes fail: the run's ledger is finished, or cannot be written. */
  runErrorFails = false;
  /** The runs whose gate lock is held, by run id. */
  gateLocks: Array<string> = [];
  /** The runs with a gate send pending in their ledger, by run id. */
  pendingSends: Array<string> = [];
  /** Reading a run's ledger for a pending gate send fails. */
  pendingSendFails = false;
  /** What `gate` answers per `"<repo>#<issue>"`; started otherwise. */
  gateStarts: Record<string, GateStart> = {};
  /** What the machine log says of T3 trouble in the last ten minutes: the newest message, or why it cannot be read. */
  t3Trouble_: string | null | { error: string } = null;
  /** What deciding about a session that ended badly answers per `"<repo>#<issue>"`; a resume otherwise. */
  interrupts: Record<string, Array<InterruptOutcome | BuildingError>> = {};
  /** What `lastPass` answers per `"<repo>#<issue>"`: a pass on `HEAD` unless scripted; `"error"` is a ledger that cannot be read. */
  lastPasses: Record<string, LastPass | null | "error"> = {};
  /** The head of each open pull request per `"<repo>#<pr>"`: `HEAD` unless scripted; `null` is one that ended, `"error"` a read that fails. */
  openHeads: Record<string, string | null | "error"> = {};
  /** GitHub's mergeable state of each open pull request per `"<repo>#<pr>"`: `mergeable` unless scripted. */
  mergeables: Record<string, Mergeable> = {};
  /** The issues GitHub has closed, per `"<repo>#<issue>"`; `"error"` is a read that fails. Open otherwise. */
  closedIssues: Record<string, boolean | "error"> = {};
  stuckReads = new Map<string, number>();
  /** What `pruneBranches` answers per repo; nothing pruned otherwise. */
  prunes: Record<string, PruneReport | PassError> = {};
  prunedAt = new Map<string, number>();
  /** The repos the T3 projects list as watched; set per pass by `pass`. */
  watched: Array<WatchedProject> = [];
  /** The repos whose every T3 project was deleted since the reader watched them. */
  departed: Array<string> = [];
  /** Workspace roots the reader could not settle this pass; they are not in `watched`. */
  unresolved: Array<string> = [];
  /** Listing the watched repos fails, as the project store being down does. */
  watchedFails = false;
  /** The repos `project` was called for, in order. */
  projected: Array<string> = [];
  /** The name `hostName` gives this machine, which a repo's `factory.owner` is matched with. */
  machineName = "t3fac";
  now = T0;
  calls: Array<string> = [];
  events: Array<MachineEvent> = [];

  /** The open attention items, as the service keeps them: one per id. */
  items: Array<AttentionItem> = [];
  attention: Pick<Attention["Service"], "list" | "raise" | "clear"> = {
    list: () => Effect.sync(() => [...this.items]),
    raise: (item) =>
      Effect.sync(() => {
        if (!this.items.some((open) => open.id === item.id)) {
          this.items.push({ ...item, firstSeenMs: this.now });
        }
      }),
    clear: (matches) =>
      Effect.sync(() => {
        this.items = this.items.filter((item) => !matches(item));
      }),
  };

  runIn(
    issue: number,
    state: State | null,
    repo = REPO,
    session = false,
    base: string | null = null,
  ) {
    this.runs.push({
      id: rid(issue, repo),
      state,
      unreadable: false,
      confirmed: true,
      session,
      prReported: false,
      base,
    });
  }

  /** A step called for a run on its own base says so: `<step> <run> on <base>`. */
  private onBase(step: string, run: RunId, base: string | null) {
    if (base !== null) this.calls.push(`${step} ${runIdToString(run)} on ${base}`);
  }

  pushStart(key: string, answer: StartOutcome | StartError) {
    (this.starts[key] ??= []).push(answer);
  }

  watchedRepos = Effect.suspend(() => {
    this.calls.push("watched");
    return this.watchedFails
      ? Effect.fail<PassError>({
          kind: "t3",
          message: "cannot list the T3 projects: project store down",
        })
      : Effect.succeed({
          repos: this.watched,
          departed: this.departed,
          unresolved: this.unresolved,
        });
  });

  project(watched: { repo: string }) {
    this.calls.push("project");
    this.projected.push(watched.repo);
    const found = this.projects[watched.repo];
    if (typeof found === "string") {
      return Effect.fail<PassError>({
        kind: "config",
        message: found,
        transient: this.transient.has(watched.repo),
      });
    }
    return Effect.succeed(found ?? project());
  }

  trackerUser(watched: { repo: string }) {
    this.calls.push("tracker_user");
    const found = this.trackerUsers[watched.repo];
    if (typeof found === "object") {
      return Effect.fail<PassError>({
        kind: "tracker",
        message: found.error,
        transient: this.transient.has(watched.repo) && !this.loginHard,
      });
    }
    return Effect.succeed(found ?? "rawphp");
  }

  unfinishedRuns(only?: { repo: string; issue: number }) {
    this.calls.push(only === undefined ? "runs" : `runs ${only.repo}#${only.issue}`);
    if (this.runsError) {
      return Effect.fail(new LedgerIoError({ path: "/data/runs", cause: new Error("unreadable") }));
    }
    return Effect.succeed(
      this.runs.filter(
        (run) =>
          only === undefined ||
          (run.id.issue === String(only.issue) &&
            run.id.repo.toLowerCase() === only.repo.toLowerCase()),
      ),
    );
  }

  private listing(answers: Answers<Array<number>>, cut: Array<string>, repo: Repo) {
    const found = answers[repo.watched.repo];
    if (found === "error") return Effect.fail(trackerFailure());
    return Effect.succeed({ items: found ?? [], cut: cut.includes(repo.watched.repo) });
  }

  readyIssues(repo: Repo) {
    const name = repo.watched.repo;
    this.calls.push(`ready ${name}`);
    const found = this.ready[name];
    if (found === "error") return Effect.fail(trackerFailure());
    return Effect.succeed({
      items: (found ?? []).map((number) => ({
        number,
        labels: this.labels[`${name}#${number}`] ?? [],
      })),
      cut: this.readyCut.includes(name),
    });
  }

  triageIssues(repo: Repo) {
    this.calls.push(`triage ${repo.watched.repo}`);
    return this.listing(this.triage, this.triageCut, repo);
  }

  /** Issues whose label history cannot be read, by repo. */
  unreadHistory: Record<string, Array<{ issue: number; message: string }>> = {};

  unassignedClaims(repo: Repo, known: ReadonlySet<number>) {
    this.calls.push(`unassigned ${repo.watched.repo} known=${[...known].sort().join(",")}`);
    const found = this.unassigned[repo.watched.repo];
    if (found === "error") return Effect.fail(trackerFailure());
    return Effect.succeed({
      claims: found ?? [],
      unread: this.unreadHistory[repo.watched.repo] ?? [],
    });
  }

  releaseClaim(repo: Repo, issue: number, from: State) {
    this.calls.push(`release ${repo.watched.repo}#${issue} ${from}`);
    return this.releaseFails ? Effect.fail(trackerFailure()) : Effect.void;
  }

  private blockerRead(answers: Answers<Array<Blocker>>, name: string, repo: Repo, issue: number) {
    const key = `${repo.watched.repo}#${issue}`;
    this.calls.push(`${name} ${key}`);
    const found = answers[key];
    if (found === "error") return Effect.fail(trackerFailure());
    return Effect.succeed(found ?? []);
  }

  openBlockers(repo: Repo, issue: number) {
    return this.blockerRead(this.blockers, "blockers", repo, issue);
  }

  dependsOnBlockers(repo: Repo, issue: number) {
    return this.blockerRead(this.depends, "depends", repo, issue);
  }

  start(repo: Repo, issue: number) {
    return this.answerStart("start", repo, issue);
  }

  /** The `factory:triage` and `factory:building` issues per repo; a repo not here lists none and records no call. */
  claimed: Record<string, Record<number, State> | "error"> = {};
  /** The states whose claimed listing was cut, per repo. */
  claimedCut: Record<string, Array<State>> = {};
  /** What `yieldToClaim` answers per `"<repo>#<issue>"`; null (this machine's claim won) otherwise. */
  yields: Record<string, { machine: string; finished: Array<RunId> } | StartError> = {};

  claimedIssues(repo: Repo) {
    const found = this.claimed[repo.watched.repo];
    if (found === undefined) return Effect.succeed({ states: new Map<number, State>(), cut: [] });
    this.calls.push(`claimed ${repo.watched.repo}`);
    if (found === "error") return Effect.fail(trackerFailure());
    return Effect.succeed({
      states: new Map(
        Object.entries(found).map(([issue, state]) => [Number(issue), state] as const),
      ),
      cut: this.claimedCut[repo.watched.repo] ?? [],
    });
  }

  yieldToClaim(repo: Repo, issue: number) {
    const key = `${repo.watched.repo}#${issue}`;
    this.calls.push(`yield ${key}`);
    const answer = this.yields[key] ?? null;
    if (answer !== null && "_tag" in answer) return Effect.fail(answer);
    if (answer !== null) {
      const gone = new Set(answer.finished.map(runIdToString));
      this.runs = this.runs.filter((run) => !gone.has(runIdToString(run.id)));
    }
    return Effect.succeed(answer);
  }

  resume(repo: Repo, issue: number) {
    return this.answerStart("resume", repo, issue);
  }

  /** Both calls share one script per issue; `calls` says which was made. */
  private answerStart(call: "start" | "resume", repo: Repo, issue: number) {
    const key = `${repo.watched.repo}#${issue}`;
    this.calls.push(`${call} ${key}`);
    const answer = this.starts[key]?.shift() ?? { kind: "skipped", reason: "scripted" };
    if (this.startLeavesRun.includes(issue)) {
      this.runs.push({
        id: rid(issue, repo.watched.repo),
        state: "triage",
        unreadable: false,
        confirmed: true,
        session: false,
        prReported: false,
        base: null,
      });
    }
    if ("kind" in answer && answer.kind === "started") {
      const existing = this.runs.find((r) => runIdToString(r.id) === runIdToString(answer.run));
      // A run the pass already knew moves on to building; a new claim leaves a triage run.
      if (existing !== undefined)
        this.runs[this.runs.indexOf(existing)] = { ...existing, state: "building" };
      else
        this.runs.push({
          id: answer.run,
          state: "triage",
          unreadable: false,
          confirmed: true,
          session: false,
          prReported: false,
          base: null,
        });
      return Effect.succeed(answer);
    }
    if ("kind" in answer) return Effect.succeed(answer);
    return Effect.fail(answer);
  }

  private scripted<T extends { readonly kind: string }>(
    table: Record<string, Array<T | BuildingError>>,
    call: string,
    repo: Repo,
    issue: number,
    fallback: T,
  ) {
    const key = `${repo.watched.repo}#${issue}`;
    this.calls.push(`${call} ${key}`);
    const answer = table[key]?.shift() ?? fallback;
    return "kind" in answer ? Effect.succeed(answer as T) : Effect.fail(answer);
  }

  takeStopRequest(run: RunId) {
    const key = `${run.repo}#${run.issue}`;
    this.calls.push(`stop_request ${key}`);
    const answer = this.stopRequests[key] ?? "none";
    return typeof answer === "string" ? Effect.succeed(answer) : Effect.fail(answer);
  }

  timeLimit(repo: Repo, run: RunId, base: string | null) {
    this.onBase("time_limit", run, base);
    return this.scripted(this.timeLimits, "time_limit", repo, Number(run.issue), {
      kind: "within",
    });
  }

  watch(repo: Repo, run: RunId, base: string | null) {
    this.onBase("watch", run, base);
    return this.scripted(this.watches, "watch", repo, Number(run.issue), { kind: "unchanged" });
  }

  /** A forward of a run whose issue a person closed ends the run, as the ledger does. */
  forward(repo: Repo, run: RunId, base: string | null) {
    this.onBase("forward", run, base);
    const key = `${repo.watched.repo}#${run.issue}`;
    this.calls.push(`forward ${key}`);
    const answer = this.forwards[key]?.shift() ?? NOTHING_SENT;
    if (!("comments" in answer)) return Effect.fail(answer);
    if (answer.skipped === "abandoned") {
      this.runs = this.runs.filter((r) => runIdToString(r.id) !== runIdToString(run));
    }
    return Effect.succeed(answer);
  }

  feedback(repo: Repo, run: RunId, base: string | null) {
    this.onBase("feedback", run, base);
    const id = runIdToString(run);
    this.feedbacks.push(id);
    this.calls.push(`feedback ${repo.watched.repo}#${run.issue}`);
    const answer = this.feedbackSteps[id]?.shift() ?? ({ kind: "none" } as const);
    return "kind" in answer ? Effect.succeed(answer) : Effect.fail(answer);
  }

  /** An advance that ends the run (`needs-info`, `stuck`) takes it off the list, as the ledger does. */
  advance(repo: Repo, run: RunId, base: string | null) {
    this.onBase("advance", run, base);
    const answered = this.scripted(this.advances, "advance", repo, Number(run.issue), {
      kind: "running",
    });
    return Effect.tap(answered, (outcome) =>
      Effect.sync(() => {
        if (
          outcome.kind === "needs-info" ||
          outcome.kind === "stuck" ||
          outcome.kind === "ended" ||
          outcome.kind === "abandoned"
        ) {
          this.runs = this.runs.filter((r) => runIdToString(r.id) !== runIdToString(run));
        }
      }),
    );
  }

  t3Starts() {
    this.calls.push("t3_starts");
    if (this.machineLogDir !== null) {
      return Effect.succeed(serverStartsSince(this.machineLogDir, this.now - 24 * 60 * 60_000));
    }
    return Effect.succeed(this.t3Starts_);
  }

  t3Stops() {
    this.calls.push("t3_stops");
    if (this.machineLogDir !== null) {
      return Effect.succeed(
        serverStopsForStartsSince(this.machineLogDir, this.now - 24 * 60 * 60_000),
      );
    }
    return Effect.succeed(this.t3Stops_);
  }

  t3Trouble() {
    this.calls.push("t3_trouble");
    if (this.machineLogDir !== null)
      return Effect.succeed(t3TroubleSince(this.machineLogDir, this.now));
    const answer = this.t3Trouble_;
    return typeof answer === "object" && answer !== null
      ? Effect.fail(
          new LedgerIoError({ path: "/data/events.jsonl", cause: new Error(answer.error) }),
        )
      : Effect.succeed(answer);
  }

  /** A decision that sends the run to `stuck` or relaunches it takes it off the list, as the ledger does. */
  interrupted(repo: Repo, run: RunId, base: string | null, evidence: Evidence) {
    this.onBase("interrupted", run, base);
    this.calls.push(
      `interrupted ${runIdToString(run)} t3=${evidence.t3Error ?? "none"} ended=${evidence.endedInPass}`,
    );
    this.lastEvidence = evidence;
    const answer = this.interrupts[`${repo.watched.repo}#${run.issue}`]?.shift() ?? {
      kind: "resumed" as const,
      resumes: 1,
      limit: 2,
      status: "failed" as const,
    };
    if (!("kind" in answer)) return Effect.fail(answer);
    if (answer.kind === "stuck" || answer.kind === "relaunched") {
      this.runs = this.runs.filter((r) => runIdToString(r.id) !== runIdToString(run));
    }
    return Effect.succeed(answer);
  }

  handPause() {
    return this.pause;
  }

  paradevDown() {
    return Effect.succeed(this.down);
  }

  /** Each model's cooldown, kept from pass to pass as the live world keeps it. */
  cooldowns = new Map<string, Cooldown>();
  /** The machine's `model_fallbacks` for the passes `pass` runs. */
  modelFallbacks: Record<string, string> = {};
  /** The model of each repo's T3 project: `FABLE` unless scripted; `"error"` is a lookup that fails. */
  projectModels: Record<string, Model | null | "error"> = {};
  /** What resuming a rate-limited session answers per `"<repo>#<issue>"`; a resume otherwise. */
  cooledResumes: Record<string, Array<CooldownOutcome | BuildingError>> = {};

  projectModel(repo: Repo) {
    this.calls.push(`project_model ${repo.watched.repo}`);
    const found = this.projectModels[repo.watched.repo];
    if (found === "error") return Effect.fail<PassError>({ kind: "t3", message: "store down" });
    return Effect.succeed(found === undefined ? FABLE : found);
  }

  resumeAfterCooldown(repo: Repo, run: RunId, base: string | null, model: Model | null) {
    this.onBase("cooled_resume", run, base);
    const key = `${repo.watched.repo}#${run.issue}`;
    this.calls.push(`cooled_resume ${key}${model === null ? "" : ` on ${model.model}`}`);
    const answer = this.cooledResumes[key]?.shift() ?? { kind: "resumed" as const };
    return "kind" in answer ? Effect.succeed(answer) : Effect.fail(answer);
  }

  /** The live threads on a broken worktree; an archived thread leaves the list. */
  onBroken: Array<ThreadOnBrokenWorktree> = [];
  brokenFails = false;
  /** The ledger's sessions, by thread id. */
  sessions = new Map<string, { run: RunId; stopped: boolean }>();
  /** False when a run file cannot be read; `"error"` is a ledger that cannot be read at all. */
  sessionsRead: boolean | "error" = true;
  /** How often `sessionRuns` read the ledger. */
  sessionReads = 0;
  brokenThreads: BrokenThreadMemo = { notFactory: new Set(), unsettled: new Map() };
  configSkips = new Map<string, number>();
  lastGood = new Map<string, LastGood>();
  /** Threads T3 refuses to archive. */
  archiveRefused: Array<string> = [];
  /** Each thread `archiveThread` archived, in order. */
  archived: Array<string> = [];

  threadsOnBrokenWorktrees() {
    return this.brokenFails
      ? Effect.fail<PassError>({ kind: "t3", message: "the projection is locked" })
      : Effect.succeed([...this.onBroken]);
  }

  sessionRuns() {
    this.sessionReads += 1;
    return this.sessionsRead === "error"
      ? Effect.fail<PassError>({ kind: "ledger", message: "runs is not a folder" })
      : Effect.succeed({ runs: new Map(this.sessions), complete: this.sessionsRead });
  }

  archiveThread(threadId: string) {
    if (this.archiveRefused.includes(threadId)) {
      return Effect.fail<PassError>({ kind: "t3", message: "T3 refused the archive" });
    }
    this.archived.push(threadId);
    this.onBroken = this.onBroken.filter((thread) => thread.threadId !== threadId);
    return Effect.void;
  }

  freeSpace() {
    this.calls.push("free_space");
    return this.free === "error"
      ? Effect.fail<PassError>({ kind: "ledger", message: "statfs /data/worktrees: EIO" })
      : Effect.succeed({
          path: "/data/worktrees",
          freeBytes: this.free,
          totalBytes: this.free * 2,
        });
  }

  load() {
    this.calls.push("load");
    return this.loadAvg;
  }

  nowMs() {
    return this.now;
  }

  pruneBranches(repo: Repo) {
    this.calls.push(`prune ${repo.watched.repo}`);
    const answer = this.prunes[repo.watched.repo] ?? {
      pruned: [],
      left: [],
      failed: [],
      waiting: 0,
    };
    return "kind" in answer ? Effect.fail(answer) : Effect.succeed(answer);
  }

  recordError(run: RunId, step: CauseStep, kind: ErrorKind, message: string) {
    if (this.runErrorFails) {
      return Effect.fail(
        new LedgerIoError({ path: "/data/runs/x.jsonl", cause: new Error("finished") }),
      );
    }
    this.runErrors.push({ run, step, kind, message });
    return Effect.void;
  }

  gateRunning(run: RunId) {
    return this.gateLocks.includes(runIdToString(run));
  }

  hasPendingGateSend(run: RunId) {
    if (this.pendingSendFails) {
      return Effect.fail(
        new LedgerIoError({ path: "/data/runs/x.jsonl", cause: new Error("disk") }),
      );
    }
    return Effect.succeed(this.pendingSends.includes(runIdToString(run)));
  }

  lastPass(run: RunId) {
    const key = `${run.repo}#${run.issue}`;
    this.calls.push(`last_pass ${key}`);
    const found =
      this.lastPasses[key] === undefined ? { pr: 12, head: HEAD } : this.lastPasses[key];
    if (found === "error") {
      return Effect.fail(
        new LedgerIoError({ path: "/data/runs/x.jsonl", cause: new Error("unreadable") }),
      );
    }
    return Effect.succeed(found);
  }

  issueClosed(repo: Repo, issue: number) {
    const key = `${repo.watched.repo}#${issue}`;
    this.calls.push(`issue_closed ${key}`);
    const found = this.closedIssues[key] ?? false;
    return found === "error" ? Effect.fail(trackerFailure()) : Effect.succeed(found);
  }

  openPull(repo: Repo, pr: number) {
    const key = `${repo.watched.repo}#${pr}`;
    this.calls.push(`open_pull ${key}`);
    const found = this.openHeads[key] === undefined ? HEAD : this.openHeads[key];
    if (found === "error") return Effect.fail(trackerFailure());
    return Effect.succeed(
      found === null ? null : { head: found, mergeable: this.mergeables[key] ?? "mergeable" },
    );
  }

  gate(repo: Repo, run: RunId) {
    const key = `${repo.watched.repo}#${run.issue}`;
    this.calls.push(`gate ${key}`);
    return Effect.succeed(this.gateStarts[key] ?? ({ kind: "started" } as const));
  }

  record(event: MachineEvent) {
    if (this.machineLogFails) {
      return Effect.fail(
        new LedgerIoError({ path: "/data/events.jsonl", cause: new Error("disk full") }),
      );
    }
    this.events.push(event);
    if (this.machineLogDir !== null) {
      const log = MachineLog.open(this.machineLogDir, { clock: () => this.now });
      try {
        log.append(event);
      } finally {
        log.close();
      }
    }
    return Effect.void;
  }
}

/** One pass over the T3 projects that list `repos` as watched, with `max` run slots. */
const pass = (
  fake: Fake,
  repos: ReadonlyArray<string>,
  max: number,
): Effect.Effect<{ report: Report; lines: Array<string> }> => {
  fake.watched = watchedOf(repos);
  return Effect.gen(function* () {
    const lines: Array<string> = [];
    const report = yield* runPass(
      fake,
      {
        ...machine(max),
        minFreeGib: fake.minFreeGib,
        maxLoadPerCore: fake.maxLoadPerCore,
        modelFallbacks: fake.modelFallbacks,
        hosts: fake.hosts,
      },
      (line) => lines.push(line),
    );
    return { report, lines };
  });
};

/** The `start` and `resume` calls, in order. */
const starts = (fake: Fake) =>
  fake.calls.filter((c) => c.startsWith("start ") || c.startsWith("resume "));
const releases = (fake: Fake) => fake.calls.filter((c) => c.startsWith("release "));

const runLine = (lines: ReadonlyArray<string>, prefix: string): string => {
  const line = lines.find((l) => l.startsWith(prefix));
  assert.ok(line !== undefined, `no line starting ${prefix} in ${JSON.stringify(lines, null, 2)}`);
  return line;
};

const blockerList = (by: ReadonlyArray<readonly [string, number]>): Array<Blocker> =>
  by.map(([repo, number]) => ({ repo, number }));

const claimSkipped = (issue: number, reason: string, repo = REPO): MachineEvent => ({
  event: "claim_skipped",
  data: { repo, issue: String(issue), reason },
});

/** The machine events the Queue reads: skips and the claim step's `ready_listed`. */
const queueEvents = (fake: Fake) =>
  fake.events.filter((e) => e.event === "claim_skipped" || e.event === "ready_listed");

const errorEvents = (fake: Fake) => fake.events.filter((e) => e.event === "error");
const recordedErrorKinds = (fake: Fake): Array<ErrorKind> =>
  errorEvents(fake).map((e) => (e.data as { kind: ErrorKind }).kind);

const FROM_TEXT = " (from Depends on, add the GitHub link)";

describe("claiming new issues", () => {
  it.effect("ready issues are claimed oldest first", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      // By number, not by text: 10 comes after 9.
      fake.ready[REPO] = [10, 9, 3, 5];
      for (const issue of [3, 5, 9, 10]) fake.pushStart(`${REPO}#${issue}`, started(issue));
      const { report } = yield* pass(fake, [REPO], 5);
      assert.deepEqual(starts(fake), [
        `start ${REPO}#3`,
        `start ${REPO}#5`,
        `start ${REPO}#9`,
        `start ${REPO}#10`,
      ]);
      assert.equal(report.claimed, 4);
    }),
  );

  it.effect("no more issues are claimed than max_concurrent_runs allows", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.ready[REPO] = [1, 2, 3];
      for (const issue of [1, 2, 3]) fake.pushStart(`${REPO}#${issue}`, started(issue));
      yield* pass(fake, [REPO], 2);
      assert.deepEqual(starts(fake), [`start ${REPO}#1`, `start ${REPO}#2`]);
    }),
  );

  it.effect("runs that are already active use up the slots", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(40, BUILDING);
      fake.ready[REPO] = [1];
      yield* pass(fake, [REPO], 1);
      assert.deepEqual(starts(fake), []);
    }),
  );

  it.effect("a building run whose pull request waits for the gate uses no slot", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runs.push({
        id: rid(40),
        state: BUILDING,
        unreadable: false,
        confirmed: true,
        session: true,
        prReported: true,
        base: null,
      });
      fake.ready[REPO] = [1];
      fake.pushStart(`${REPO}#1`, started(1));
      yield* pass(fake, [REPO], 1);
      assert.deepEqual(starts(fake), [`start ${REPO}#1`]);
    }),
  );

  it.effect("a run in any watched repo uses a slot", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(8, BUILDING, OTHER);
      fake.ready[REPO] = [1];
      yield* pass(fake, [REPO, OTHER], 1);
      assert.deepEqual(starts(fake), []);
    }),
  );

  it.effect("an issue that was not claimed does not use a slot", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.ready[REPO] = [1, 2];
      // Issue 1 gets the default skipped.
      fake.pushStart(`${REPO}#2`, started(2));
      const { report, lines } = yield* pass(fake, [REPO], 1);
      assert.equal(starts(fake).length, 2);
      assert.equal(report.claimed, 1);
      assert.equal(runLine(lines, "rawphp/softfac#1 "), "rawphp/softfac#1 ready: not claimed");
    }),
  );

  it.effect("a claimed issue gets a line naming its run", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.ready[REPO] = [2];
      fake.pushStart(`${REPO}#2`, started(2));
      const { lines } = yield* pass(fake, [REPO], 1);
      assert.equal(
        runLine(lines, "rawphp/softfac#2 "),
        "rawphp/softfac#2 ready: claimed, session started in run rawphp__softfac__2__1",
      );
    }),
  );

  it.effect("a failed start is an error line and the next issue is tried", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.ready[REPO] = [1, 2];
      fake.pushStart(`${REPO}#1`, githubFailure());
      fake.pushStart(`${REPO}#2`, started(2));
      const { report, lines } = yield* pass(fake, [REPO], 5);
      assert.equal(starts(fake).length, 2);
      assert.deepEqual([report.errors, report.claimed], [1, 1]);
      assert.ok(
        lines.some((l) => l.startsWith("error: rawphp/softfac#1 start:")),
        lines.join("\n"),
      );
      // Every call `start` makes is a tracker call, whatever host the tracker runs on.
      assert.deepEqual(recordedErrorKinds(fake), ["tracker"]);
      assert.deepEqual((errorEvents(fake)[0]!.data as { step: string }).step, "start");
    }),
  );

  it.effect("a claimed issue that went stuck says so and names the run", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.ready[REPO] = [12];
      fake.pushStart(`${REPO}#12`, { kind: "stuck", run: rid(12), reason: "secret detail" });
      const { report, lines } = yield* pass(fake, [REPO], 1);
      assert.equal(report.claimed, 0);
      const line = runLine(lines, "rawphp/softfac#12 ");
      assert.ok(line.includes("stuck"), line);
      assert.ok(line.includes("claimed, but the launch failed"), line);
      assert.ok(line.includes("rawphp__softfac__12__1"), line);
      assert.ok(!line.includes("secret detail"), line);
    }),
  );

  it.effect("a repo whose ready issues cannot be listed is an error and the others go on", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.ready[REPO] = "error";
      fake.ready[OTHER] = [4];
      fake.pushStart(`${OTHER}#4`, started(4, OTHER));
      const { report, lines } = yield* pass(fake, [REPO, OTHER], 3);
      assert.deepEqual(starts(fake), [`start ${OTHER}#4`]);
      assert.equal(report.errors, 1);
      assert.ok(
        lines.some((l) => l.startsWith("error: rawphp/softfac: cannot list the ready issues")),
        lines.join("\n"),
      );
      assert.deepEqual(recordedErrorKinds(fake), ["tracker"]);
      // The Queue keeps that repo's waits from before, and counts the pass as one that listed.
      assert.deepEqual(queueEvents(fake), [
        { event: "claim_skipped", data: { repo: REPO, reason: "list-failed" } },
        { event: "ready_listed", data: { repos: 1 } },
      ]);
    }),
  );

  it.effect("a pass that lists no repo's ready issues writes no ready_listed", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.ready[REPO] = "error";
      yield* pass(fake, [REPO], 3);
      assert.deepEqual(queueEvents(fake), [
        { event: "claim_skipped", data: { repo: REPO, reason: "list-failed" } },
      ]);
    }),
  );

  it.effect("a cut ready listing is said once and the issues read are still claimed", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.ready[REPO] = [1];
      fake.readyCut = [REPO];
      fake.pushStart(`${REPO}#1`, started(1));
      const { lines } = yield* pass(fake, [REPO], 5);
      assert.deepEqual(
        lines.filter((l) => l.includes("more than")),
        ["rawphp/softfac: more than 200 open factory:ready issues, so the oldest were not read"],
      );
      assert.deepEqual(starts(fake), [`start ${REPO}#1`]);
    }),
  );

  it.effect(
    "a repo whose tracker login cannot be read is logged and skipped, and the others still run",
    () =>
      Effect.gen(function* () {
        const fake = new Fake();
        fake.trackerUsers[REPO] = { error: "cannot read the login: boom" };
        fake.runIn(12, BUILDING);
        fake.ready[REPO] = [1];
        fake.ready[OTHER] = [4];
        fake.pushStart(`${OTHER}#4`, started(4, OTHER));
        const { report } = yield* pass(fake, [REPO, OTHER], 3);
        assert.equal(report.errors, 1);
        assert.deepEqual(starts(fake), [`start ${OTHER}#4`]);
        const errors = errorEvents(fake);
        assert.equal(errors.length, 1);
        assert.deepEqual(errors[0]!.data, {
          step: "pass",
          kind: "tracker",
          message: "rawphp/softfac: cannot read the tracker's login: cannot read the login: boom",
        });
      }),
  );

  it.effect("a repo whose config cannot be loaded is reported and skipped while others go on", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.projects[REPO] = "no .dw/config.yml on main";
      fake.runIn(12, BUILDING);
      fake.ready[REPO] = [1];
      fake.ready[OTHER] = [4];
      fake.pushStart(`${OTHER}#4`, started(4, OTHER));
      const { report, lines } = yield* pass(fake, [REPO, OTHER], 3);
      assert.equal(report.errors, 1);
      assert.ok(
        lines.some(
          (l) =>
            l.startsWith("error: rawphp/softfac: project config not loaded") &&
            l.includes("no .dw/config.yml on main"),
        ),
        lines.join("\n"),
      );
      assert.deepEqual(starts(fake), [`start ${OTHER}#4`]);
      assert.ok(
        fake.events.some(
          (e) =>
            e.event === "repo_skipped" &&
            e.data.repo === REPO &&
            e.data.reason === "config-not-loaded" &&
            e.data.message === "no .dw/config.yml on main",
        ),
        JSON.stringify(fake.events),
      );
    }),
  );

  describe("a repo whose config or login could not be re-read", () => {
    const ITEM_ID = "config-not-loaded:rawphp/softfac";
    const items = (fake: Fake) => fake.items.filter((item) => item.id === ITEM_ID);
    const stale = (fake: Fake) => fake.events.filter((e) => e.event === "repo_config_stale");
    const skipped = (fake: Fake) => fake.events.filter((e) => e.event === "repo_skipped");
    const TLS = "net/http: TLS handshake timeout";

    it.effect("a transient config failure after a good load runs on the last good copy", () =>
      Effect.gen(function* () {
        const fake = new Fake();
        fake.ready[REPO] = [1];
        fake.pushStart(`${REPO}#1`, started(1));
        fake.pushStart(`${REPO}#2`, started(2));
        yield* pass(fake, [REPO], 3);
        fake.ready[REPO] = [2];
        fake.projects[REPO] = TLS;
        fake.transient.add(REPO);
        const { lines } = yield* pass(fake, [REPO], 3);
        // The second pass started issue 2 on the config and login of the first.
        assert.include(starts(fake), `start ${REPO}#2`);
        assert.deepEqual(
          stale(fake).map((e) => e.data),
          [{ repo: REPO, what: "config", message: TLS }],
        );
        assert.deepEqual(skipped(fake), []);
        assert.ok(
          lines.some((l) =>
            l.includes(`${REPO}: project config could not be re-read, using the last good copy`),
          ),
          lines.join("\n"),
        );
      }),
    );

    it.effect("a transient login failure after a good load runs on the last good login", () =>
      Effect.gen(function* () {
        const fake = new Fake();
        fake.ready[REPO] = [1];
        fake.pushStart(`${REPO}#1`, started(1));
        fake.pushStart(`${REPO}#2`, started(2));
        yield* pass(fake, [REPO], 3);
        fake.ready[REPO] = [2];
        fake.trackerUsers[REPO] = { error: TLS };
        fake.transient.add(REPO);
        const { report } = yield* pass(fake, [REPO], 3);
        assert.equal(report.errors, 0);
        // The second pass started issue 2 on the config and login of the first.
        assert.include(starts(fake), `start ${REPO}#2`);
        assert.deepEqual(
          stale(fake).map((e) => e.data),
          [{ repo: REPO, what: "login", message: TLS }],
        );
        assert.deepEqual(skipped(fake), []);
      }),
    );

    it.effect("a failure that is not transient skips the repo", () =>
      Effect.gen(function* () {
        const fake = new Fake();
        yield* pass(fake, [REPO], 3);
        fake.projects[REPO] = "invalid .dw/config.yml";
        yield* pass(fake, [REPO], 3);
        assert.deepEqual(stale(fake), []);
        assert.equal(skipped(fake).length, 1);
      }),
    );

    it.effect("a config that fails for real is not brought back by a later blip", () =>
      Effect.gen(function* () {
        const fake = new Fake();
        yield* pass(fake, [REPO], 3);
        fake.projects[REPO] = "no .dw/config.yml on main";
        yield* pass(fake, [REPO], 3);
        assert.equal(skipped(fake).length, 1);
        assert.equal(skipped(fake)[0]!.data.reason, "config-not-loaded");
        fake.ready[REPO] = [2];
        fake.pushStart(`${REPO}#2`, started(2));
        fake.transient.add(REPO);
        fake.projects[REPO] = TLS;
        yield* pass(fake, [REPO], 3);
        assert.equal(skipped(fake).length, 2);
        assert.deepEqual(stale(fake), []);
        assert.notInclude(starts(fake), `start ${REPO}#2`);
      }),
    );

    it.effect("a login that fails for real is not brought back by a later blip", () =>
      Effect.gen(function* () {
        const fake = new Fake();
        yield* pass(fake, [REPO], 3);
        fake.trackerUsers[REPO] = { error: "HTTP 401: Bad credentials" };
        const second = yield* pass(fake, [REPO], 3);
        assert.equal(second.report.errors, 1);
        assert.equal(errorEvents(fake).length, 1);
        fake.transient.add(REPO);
        fake.trackerUsers[REPO] = { error: TLS };
        const third = yield* pass(fake, [REPO], 3);
        assert.equal(third.report.errors, 1);
        assert.equal(errorEvents(fake).length, 2);
        assert.deepEqual(stale(fake), []);
      }),
    );

    it.effect("three passes on a stale login raise the item on the third", () =>
      Effect.gen(function* () {
        const fake = new Fake();
        yield* pass(fake, [REPO], 3);
        fake.trackerUsers[REPO] = { error: TLS };
        fake.transient.add(REPO);
        yield* pass(fake, [REPO], 3);
        yield* pass(fake, [REPO], 3);
        assert.deepEqual(items(fake), []);
        const { report } = yield* pass(fake, [REPO], 3);
        assert.equal(report.attention, 1);
        assert.equal(stale(fake).length, 3);
        assert.deepEqual(
          items(fake).map((item) => item.message),
          [
            `${REPO}: project config or tracker login could not be re-read for 3 passes in a row, running on the last good copy; last error: ${TLS}`,
          ],
        );
      }),
    );

    it.effect("a pass with both the config and the login stale counts once", () =>
      Effect.gen(function* () {
        const fake = new Fake();
        yield* pass(fake, [REPO], 3);
        fake.projects[REPO] = TLS;
        fake.trackerUsers[REPO] = { error: TLS };
        fake.transient.add(REPO);
        yield* pass(fake, [REPO], 3);
        assert.deepEqual(
          stale(fake).map((e) => e.data.what),
          ["config", "login"],
        );
        yield* pass(fake, [REPO], 3);
        assert.deepEqual(items(fake), []);
        yield* pass(fake, [REPO], 3);
        assert.equal(stale(fake).length, 6);
        assert.equal(items(fake).length, 1);
      }),
    );

    it.effect(
      "a stale config followed by a login that fails for real still counts toward the attention item",
      () =>
        Effect.gen(function* () {
          const fake = new Fake();
          yield* pass(fake, [REPO], 3);
          fake.projects[REPO] = TLS;
          fake.trackerUsers[REPO] = { error: "HTTP 401: Bad credentials" };
          fake.transient.add(REPO);
          fake.loginHard = true;
          for (let i = 0; i < 3; i += 1) {
            const { report } = yield* pass(fake, [REPO], 3);
            assert.equal(report.errors, 1);
          }
          assert.equal(stale(fake).length, 3);
          assert.equal(errorEvents(fake).length, 3);
          assert.equal(items(fake).length, 1);
          assert.equal(
            items(fake)[0]!.message,
            `${REPO}: project config not loaded for 3 passes in a row, issues are not being picked up; last error: cannot read the tracker's login: HTTP 401: Bad credentials`,
          );
        }),
    );

    it.effect("a fresh config with a login that fails for real clears the item", () =>
      Effect.gen(function* () {
        const fake = new Fake();
        yield* pass(fake, [REPO], 3);
        fake.projects[REPO] = TLS;
        fake.transient.add(REPO);
        for (let i = 0; i < 3; i += 1) yield* pass(fake, [REPO], 3);
        assert.equal(items(fake).length, 1);
        delete fake.projects[REPO];
        fake.transient.delete(REPO);
        fake.trackerUsers[REPO] = { error: "HTTP 401: Bad credentials" };
        const { report } = yield* pass(fake, [REPO], 3);
        assert.equal(report.errors, 1);
        assert.deepEqual(items(fake), []);
      }),
    );

    it.effect("a transient failure with no earlier load skips the repo", () =>
      Effect.gen(function* () {
        const fake = new Fake();
        fake.projects[REPO] = TLS;
        fake.transient.add(REPO);
        yield* pass(fake, [REPO], 3);
        assert.deepEqual(stale(fake), []);
        assert.equal(skipped(fake).length, 1);
        // A login with no earlier load fails the repo as it does today.
        const other = new Fake();
        other.trackerUsers[REPO] = { error: TLS };
        other.transient.add(REPO);
        const { report } = yield* pass(other, [REPO], 3);
        assert.equal(report.errors, 1);
        assert.deepEqual(stale(other), []);
      }),
    );

    it.effect("three stale passes in a row raise the item, and the next good load clears it", () =>
      Effect.gen(function* () {
        const fake = new Fake();
        yield* pass(fake, [REPO], 3);
        fake.projects[REPO] = TLS;
        fake.transient.add(REPO);
        yield* pass(fake, [REPO], 3);
        yield* pass(fake, [REPO], 3);
        assert.deepEqual(items(fake), []);
        const { report } = yield* pass(fake, [REPO], 3);
        assert.equal(report.attention, 1);
        assert.equal(items(fake).length, 1);
        assert.equal(
          items(fake)[0]!.message,
          `${REPO}: project config or tracker login could not be re-read for 3 passes in a row, running on the last good copy; last error: ${TLS}`,
        );
        delete fake.projects[REPO];
        yield* pass(fake, [REPO], 3);
        assert.deepEqual(items(fake), []);
        // The count starts over.
        fake.projects[REPO] = TLS;
        yield* pass(fake, [REPO], 3);
        yield* pass(fake, [REPO], 3);
        assert.deepEqual(items(fake), []);
      }),
    );

    it.effect("a fresh config with a stale login keeps the fresh config for later", () =>
      Effect.gen(function* () {
        const fake = new Fake();
        yield* pass(fake, [REPO], 3);
        const changed = project();
        fake.projects[REPO] = changed;
        fake.trackerUsers[REPO] = { error: TLS };
        fake.transient.add(REPO);
        yield* pass(fake, [REPO], 3);
        assert.strictEqual(fake.lastGood.get(REPO)?.project, changed);
        assert.equal(stale(fake).length, 1);
      }),
    );

    it.effect("a repo no longer watched loses its last good copy", () =>
      Effect.gen(function* () {
        const fake = new Fake();
        yield* pass(fake, [REPO], 3);
        assert.ok(fake.lastGood.has(REPO));
        yield* pass(fake, [OTHER], 3);
        assert.ok(!fake.lastGood.has(REPO));
      }),
    );
  });

  describe("a repo whose config is not loaded pass after pass", () => {
    const ITEM_ID = "config-not-loaded:rawphp/softfac";
    const items = (fake: Fake) => fake.items.filter((item) => item.id === ITEM_ID);

    it.effect("two skips in a row raise nothing; the third raises one attention item", () =>
      Effect.gen(function* () {
        const fake = new Fake();
        fake.projects[REPO] = "no .dw/config.yml on main";
        yield* pass(fake, [REPO], 3);
        yield* pass(fake, [REPO], 3);
        assert.deepEqual(items(fake), []);
        const { report } = yield* pass(fake, [REPO], 3);
        assert.equal(report.attention, 1);
        assert.deepEqual(items(fake), [
          {
            id: ITEM_ID,
            kind: "attention",
            repo: REPO,
            issue: null,
            run: null,
            message:
              "rawphp/softfac: project config not loaded for 3 passes in a row, issues are not being picked up; last error: no .dw/config.yml on main",
            firstSeenMs: T0,
          },
        ]);
        // Later skips keep the one item and still record each skip as before.
        yield* pass(fake, [REPO], 3);
        assert.equal(items(fake).length, 1);
        assert.equal(
          fake.events.filter(
            (e) => e.event === "repo_skipped" && e.data.reason === "config-not-loaded",
          ).length,
          4,
        );
      }),
    );

    it.effect("a successful load clears the item and the count starts over", () =>
      Effect.gen(function* () {
        const fake = new Fake();
        fake.projects[REPO] = "boom";
        yield* pass(fake, [REPO], 3);
        yield* pass(fake, [REPO], 3);
        yield* pass(fake, [REPO], 3);
        assert.equal(items(fake).length, 1);
        delete fake.projects[REPO];
        yield* pass(fake, [REPO], 3);
        assert.deepEqual(items(fake), []);
        fake.projects[REPO] = "boom again";
        yield* pass(fake, [REPO], 3);
        yield* pass(fake, [REPO], 3);
        assert.deepEqual(items(fake), []);
        yield* pass(fake, [REPO], 3);
        assert.equal(items(fake).length, 1);
        assert.ok(items(fake)[0]!.message.endsWith("last error: boom again"));
      }),
    );

    it.effect("a load that succeeds between two skips keeps the count from reaching three", () =>
      Effect.gen(function* () {
        const fake = new Fake();
        fake.projects[REPO] = "boom";
        yield* pass(fake, [REPO], 3);
        yield* pass(fake, [REPO], 3);
        delete fake.projects[REPO];
        yield* pass(fake, [REPO], 3);
        fake.projects[REPO] = "boom";
        yield* pass(fake, [REPO], 3);
        yield* pass(fake, [REPO], 3);
        assert.deepEqual(items(fake), []);
      }),
    );

    it.effect("each repo is counted on its own, under its lower-cased name", () =>
      Effect.gen(function* () {
        const fake = new Fake();
        const spelled = "RawPHP/Softfac";
        fake.projects[spelled] = "boom";
        yield* pass(fake, [spelled, OTHER], 3);
        yield* pass(fake, [spelled, OTHER], 3);
        fake.projects[OTHER] = "other boom";
        yield* pass(fake, [spelled, OTHER], 3);
        assert.deepEqual(
          fake.items.map((item) => [item.id, item.repo]),
          [[ITEM_ID, spelled]],
        );
      }),
    );

    it.effect("a successful load clears an item raised before this process started", () =>
      Effect.gen(function* () {
        const fake = new Fake();
        fake.items.push({
          id: ITEM_ID,
          kind: "attention",
          repo: REPO,
          issue: null,
          run: null,
          message: "stale",
          firstSeenMs: T0 - 60_000,
        });
        yield* pass(fake, [REPO], 3);
        assert.deepEqual(items(fake), []);
      }),
    );

    it.effect("a pass in which two T3 projects name the repo starts its count over", () =>
      Effect.gen(function* () {
        const fake = new Fake();
        fake.projects[REPO] = "boom";
        yield* pass(fake, [REPO], 3);
        yield* pass(fake, [REPO], 3);
        // Named twice, so skipped as ambiguous: the config is not tried.
        yield* pass(fake, [REPO, REPO.toUpperCase()], 3);
        yield* pass(fake, [REPO], 3);
        yield* pass(fake, [REPO], 3);
        assert.deepEqual(items(fake), []);
        yield* pass(fake, [REPO], 3);
        assert.equal(items(fake).length, 1);
      }),
    );

    it.effect("a pass that does not watch the repo starts its count over", () =>
      Effect.gen(function* () {
        const fake = new Fake();
        fake.projects[REPO] = "boom";
        yield* pass(fake, [REPO], 3);
        yield* pass(fake, [REPO], 3);
        yield* pass(fake, [OTHER], 3);
        yield* pass(fake, [REPO], 3);
        assert.deepEqual(items(fake), []);
        // A listing that cannot be read says nothing about the repo, so the count stays.
        yield* pass(fake, [REPO], 3);
        fake.watchedFails = true;
        yield* pass(fake, [REPO], 3);
        fake.watchedFails = false;
        yield* pass(fake, [REPO], 3);
        assert.equal(items(fake).length, 1);
      }),
    );
  });

  it.effect(
    "a repo two T3 projects name is watched from neither: one error line, one event, the rest go on",
    () =>
      Effect.gen(function* () {
        const fake = new Fake();
        // The same repo in a different case, from two checkouts, and a third repo of its own.
        fake.watched = [
          { repo: REPO, path: "/p/one", title: "One" },
          { repo: OTHER, path: "/p/other", title: "Other" },
          { repo: REPO.toUpperCase(), path: "/p/two", title: "Two" },
        ];
        fake.ready[REPO] = [1];
        fake.ready[OTHER] = [4];
        fake.pushStart(`${REPO}#1`, started(1));
        fake.pushStart(`${OTHER}#4`, started(4, OTHER));
        const lines: Array<string> = [];
        const report = yield* runPass(fake, machine(5), (line) => lines.push(line));
        const said = lines.filter((l) => l.startsWith("error: "));
        assert.equal(report.errors, 1);
        assert.deepEqual(said, [
          `error: ${REPO}: 2 T3 projects have this repo as their origin (/p/one, /p/two); the factory watches none of them`,
        ]);
        const skipped = fake.events.filter((e) => e.event === "repo_skipped");
        assert.deepEqual(skipped, [
          {
            event: "repo_skipped",
            data: {
              repo: REPO,
              reason: "ambiguous-project",
              message: `${REPO}: 2 T3 projects have this repo as their origin (/p/one, /p/two); the factory watches none of them`,
            },
          },
        ]);
        // Neither checkout was loaded or claimed from; the other repo was.
        assert.deepEqual(fake.projected, [OTHER]);
        assert.deepEqual(starts(fake), [`start ${OTHER}#4`]);
      }),
  );

  it.effect("a ledger that cannot be listed is an error and nothing is claimed", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runsError = true;
      fake.ready[REPO] = [1];
      fake.pushStart(`${REPO}#1`, started(1));
      const { report, lines } = yield* pass(fake, [REPO], 3);
      assert.deepEqual(starts(fake), []);
      assert.equal(report.errors, 1);
      assert.ok(
        lines.some((l) => l.startsWith("error: cannot read the run ledger")),
        lines.join("\n"),
      );
      assert.deepEqual(recordedErrorKinds(fake), ["ledger"]);
    }),
  );

  it.effect("a run whose file cannot be read is an error line and counts as active", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runs.push({
        id: rid(40),
        state: null,
        unreadable: true,
        confirmed: false,
        session: false,
        prReported: false,
        base: null,
      });
      fake.ready[REPO] = [1];
      fake.pushStart(`${REPO}#1`, started(1));
      const { report, lines } = yield* pass(fake, [REPO], 1);
      assert.deepEqual(starts(fake), []);
      assert.equal(report.runs, 1);
      assert.equal(report.errors, 1);
      assert.ok(
        lines.some((l) =>
          l.startsWith("error: run rawphp__softfac__40__1: its ledger file cannot be read"),
        ),
        lines.join("\n"),
      );
      assert.deepEqual(
        errorEvents(fake).map((e) => (e.data as { run?: string }).run),
        ["rawphp__softfac__40__1"],
      );
    }),
  );
});

describe("a ready issue whose older run is gating", () => {
  it.effect("is not claimed again, says gate running, and is neither blocked nor held back", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(14, BUILDING);
      fake.gateLocks = [runIdToString(rid(14))];
      fake.ready[REPO] = [14, 15];
      fake.blockers[`${REPO}#14`] = blockerList([[REPO, 13]]);
      const { report, lines } = yield* pass(fake, [REPO], 1);
      assert.deepEqual(starts(fake), []);
      assert.equal(
        runLine(lines, "rawphp/softfac#14 ready"),
        "rawphp/softfac#14 ready: gate running",
      );
      assert.ok(!fake.calls.includes("blockers rawphp/softfac#14"), fake.calls.join("\n"));
      assert.deepEqual(
        fake.events.filter((e) => e.event === "claim_skipped"),
        [claimSkipped(15, "limit")],
      );
      assert.ok(
        lines.includes("limit reached: 1 ready issue was not claimed, max_concurrent_runs is 1"),
      );
      assert.equal(report.errors, 0);
    }),
  );

  it.effect("a start that finds a gate running says so and is no error", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.ready[REPO] = [14];
      fake.pushStart(`${REPO}#14`, new GateRunningError({ run: rid(14) }));
      const { report, lines } = yield* pass(fake, [REPO], 1);
      assert.equal(runLine(lines, "rawphp/softfac#14 "), "rawphp/softfac#14 ready: gate running");
      assert.equal(report.errors, 0);
    }),
  );
});

describe("which repo gets a free slot", () => {
  it.effect("a free slot goes to the repo with the fewest runs, not the one listed first", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      for (const issue of [40, 41, 42, 43, 44]) fake.runIn(issue, BUILDING);
      fake.ready[REPO] = [1, 2, 3];
      fake.ready[OTHER] = [7];
      for (const issue of [1, 2, 3]) fake.pushStart(`${REPO}#${issue}`, started(issue));
      fake.pushStart(`${OTHER}#7`, started(7, OTHER));
      yield* pass(fake, [REPO, OTHER], 6);
      assert.deepEqual(starts(fake), [`start ${OTHER}#7`]);
    }),
  );

  it.effect("repos with as many runs each get their oldest issue, the first listed first", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.ready[REPO] = [2, 1];
      fake.ready[OTHER] = [4, 3];
      for (const [repo, issue] of [
        [REPO, 1],
        [REPO, 2],
        [OTHER, 3],
        [OTHER, 4],
      ] as const) {
        fake.pushStart(`${repo}#${issue}`, started(issue, repo));
      }
      yield* pass(fake, [REPO, OTHER], 2);
      assert.deepEqual(starts(fake), [`start ${REPO}#1`, `start ${OTHER}#3`]);
    }),
  );

  it.effect("the runs are counted again after every claim, so the slots spread", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.ready[REPO] = [1, 2, 3];
      fake.ready[OTHER] = [4, 5];
      for (const [repo, issue] of [
        [REPO, 1],
        [REPO, 2],
        [REPO, 3],
        [OTHER, 4],
        [OTHER, 5],
      ] as const) {
        fake.pushStart(`${repo}#${issue}`, started(issue, repo));
      }
      yield* pass(fake, [REPO, OTHER], 3);
      assert.deepEqual(starts(fake), [`start ${REPO}#1`, `start ${OTHER}#4`, `start ${REPO}#2`]);
    }),
  );

  it.effect(
    "a blocked issue lets the next of its repo be tried, and a pr-open run is not counted",
    () =>
      Effect.gen(function* () {
        const fake = new Fake();
        fake.runIn(40, BUILDING);
        fake.runIn(41, "pr-open", OTHER);
        fake.ready[REPO] = [1];
        fake.ready[OTHER] = [4, 5];
        fake.blockers[`${OTHER}#4`] = blockerList([[OTHER, 3]]);
        fake.pushStart(`${REPO}#1`, started(1));
        fake.pushStart(`${OTHER}#5`, started(5, OTHER));
        yield* pass(fake, [REPO, OTHER], 3);
        assert.deepEqual(starts(fake), [`start ${OTHER}#5`, `start ${REPO}#1`]);
      }),
  );

  it.effect("the runs of a repo listed in mixed case count against it", () =>
    Effect.gen(function* () {
      // A run id holds the repo in lowercase; the machine config may not.
      const other = "RawPhp/Other";
      const fake = new Fake();
      fake.runIn(40, BUILDING, other);
      fake.runIn(41, BUILDING, other);
      fake.runIn(42, BUILDING);
      fake.ready[other] = [7];
      fake.ready[REPO] = [1];
      fake.pushStart(`${other}#7`, started(7, other));
      fake.pushStart(`${REPO}#1`, started(1));
      yield* pass(fake, [other, REPO], 4);
      assert.deepEqual(starts(fake), [`start ${REPO}#1`]);
    }),
  );
});

describe("runs that are confirmed and still in triage", () => {
  it.effect("a confirmed triage run is resumed on the next pass, and the line says so", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(12, "triage");
      fake.pushStart(`${REPO}#12`, started(12));
      const { report, lines } = yield* pass(fake, [REPO], 3);
      assert.deepEqual(starts(fake), [`resume ${REPO}#12`]);
      const line = runLine(lines, "rawphp/softfac#12 triage:");
      assert.ok(line.includes("session started, the issue is building"), line);
      assert.equal(report.claimed, 0);
    }),
  );

  it.effect("a confirmed run with no state yet is resumed too", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runs.push({
        id: rid(13),
        state: null,
        unreadable: false,
        confirmed: true,
        session: false,
        prReported: false,
        base: null,
      });
      fake.pushStart(`${REPO}#13`, started(13));
      yield* pass(fake, [REPO], 3);
      assert.deepEqual(starts(fake), [`resume ${REPO}#13`]);
    }),
  );

  it.effect("a triage run whose start fails records the error on that run", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(12, "triage");
      fake.pushStart(`${REPO}#12`, githubFailure());
      const { report } = yield* pass(fake, [REPO], 3);
      assert.equal(report.errors, 1);
      assert.equal(fake.runErrors.length, 1);
      assert.deepEqual(fake.runErrors[0]!.run, rid(12));
      assert.equal(fake.runErrors[0]!.step, "start");
    }),
  );

  it.effect("a triage run that went stuck says so and names the run", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(12, "triage");
      fake.pushStart(`${REPO}#12`, { kind: "stuck", run: rid(12), reason: "secret detail" });
      const { lines } = yield* pass(fake, [REPO], 3);
      const line = runLine(lines, "rawphp/softfac#12 ");
      assert.ok(line.includes("stuck"), line);
      assert.ok(line.includes("rawphp__softfac__12__1"), line);
      assert.ok(!line.includes("secret detail"), line);
    }),
  );

  it.effect("a triage run is worked before new issues are claimed", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(12, "triage");
      fake.ready[REPO] = [3];
      fake.pushStart(`${REPO}#12`, started(12));
      fake.pushStart(`${REPO}#3`, started(3));
      yield* pass(fake, [REPO], 5);
      assert.deepEqual(starts(fake), [`resume ${REPO}#12`, `start ${REPO}#3`]);
    }),
  );

  it.effect(
    "a ready-again issue whose own run has no session is claimed past that run's slot",
    () =>
      Effect.gen(function* () {
        const fake = new Fake();
        fake.runIn(12, "triage");
        fake.ready[REPO] = [12];
        fake.pushStart(`${REPO}#12`, { kind: "skipped", reason: "ready again", moved: "ready" });
        const { report, lines } = yield* pass(fake, [REPO], 1);
        // The claim finishes the old run, which left nothing running, before it claims.
        assert.deepEqual(starts(fake), [`resume ${REPO}#12`, `start ${REPO}#12`]);
        assert.ok(runLine(lines, "rawphp/softfac#12 triage:").includes("left to the claim step"));
        assert.equal(report.attention, 0);
      }),
  );

  it.effect("a ready-again issue's freed slot does not beat the limit other runs fill", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(40, BUILDING);
      fake.runIn(12, "triage");
      fake.ready[REPO] = [12];
      fake.pushStart(`${REPO}#12`, { kind: "skipped", reason: "ready again", moved: "ready" });
      yield* pass(fake, [REPO], 1);
      assert.deepEqual(starts(fake), [`resume ${REPO}#12`]);
      assert.deepEqual(
        fake.events.filter((e) => e.event === "claim_skipped").map((e) => e.data),
        [{ repo: REPO, issue: "12", reason: "limit" }],
      );
    }),
  );

  it.effect("a ready-again issue claimed past its own run takes the slot from the next issue", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(12, "triage");
      fake.ready[REPO] = [12, 13];
      fake.pushStart(`${REPO}#12`, { kind: "skipped", reason: "ready again", moved: "ready" });
      fake.pushStart(`${REPO}#12`, started(12));
      yield* pass(fake, [REPO], 1);
      assert.deepEqual(starts(fake), [`resume ${REPO}#12`, `start ${REPO}#12`]);
      assert.deepEqual(
        fake.events.filter((e) => e.event === "claim_skipped").map((e) => e.data),
        [{ repo: REPO, issue: "13", reason: "limit" }],
      );
    }),
  );

  it.effect("a ready-again issue whose own run's session holds the only slot is attention", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(12, "triage", REPO, true);
      fake.ready[REPO] = [12];
      fake.pushStart(`${REPO}#12`, { kind: "skipped", reason: "ready again", moved: "ready" });
      const { report, lines } = yield* pass(fake, [REPO], 1);
      // A second session would run past the limit, so the claim waits.
      assert.deepEqual(starts(fake), [`resume ${REPO}#12`]);
      assert.equal(report.attention, 1);
      const line = runLine(lines, "ATTENTION: rawphp/softfac#12 ");
      assert.ok(line.includes("the new claim waits for a slot this run holds"), line);
      assert.deepEqual(
        fake.events.filter((e) => e.event === "attention"),
        [
          {
            event: "attention",
            data: { run: "rawphp__softfac__12__1", reason: "not-progressing" },
          },
        ],
      );
    }),
  );

  it.effect("a ready-again issue that waits on another run's slot too raises no attention", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(40, BUILDING);
      fake.runIn(12, "triage", REPO, true);
      fake.ready[REPO] = [12];
      fake.pushStart(`${REPO}#12`, { kind: "skipped", reason: "ready again", moved: "ready" });
      const { report } = yield* pass(fake, [REPO], 2);
      assert.deepEqual(starts(fake), [`resume ${REPO}#12`]);
      assert.equal(report.attention, 0);
    }),
  );

  it.effect("a ready issue the limit holds back by other runs raises no attention", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(40, BUILDING);
      fake.ready[REPO] = [3];
      const { report } = yield* pass(fake, [REPO], 1);
      assert.deepEqual(starts(fake), []);
      assert.equal(report.attention, 0);
    }),
  );

  it.effect("a triage run whose issue is ready again is claimed afresh when a slot is free", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(12, "triage");
      fake.ready[REPO] = [12];
      fake.pushStart(`${REPO}#12`, { kind: "skipped", reason: "ready again", moved: "ready" });
      const { report } = yield* pass(fake, [REPO], 2);
      assert.deepEqual(starts(fake), [`resume ${REPO}#12`, `start ${REPO}#12`]);
      assert.equal(report.attention, 0);
    }),
  );

  it.effect("a triage run whose issue a person moved is an attention line, logged, with why", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(12, "triage");
      fake.pushStart(`${REPO}#12`, { kind: "skipped", reason: "issue #12 is assigned to bob" });
      const { report, lines } = yield* pass(fake, [REPO], 1);
      assert.equal(report.attention, 1);
      const line = runLine(lines, "ATTENTION: rawphp/softfac#12 ");
      assert.ok(
        line.includes(
          "run rawphp__softfac__12__1 is not progressing and holds a slot: issue #12 is assigned to bob. If you moved the issue by hand",
        ),
        line,
      );
      assert.deepEqual(
        fake.events.filter((e) => e.event === "attention"),
        [
          {
            event: "attention",
            data: { run: "rawphp__softfac__12__1", reason: "not-progressing" },
          },
        ],
      );
    }),
  );

  it.effect("a triage run whose issue was closed says to reopen it", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(12, "triage");
      fake.pushStart(`${REPO}#12`, {
        kind: "skipped",
        reason: "issue #12 is closed",
        moved: "closed",
      });
      const { report, lines } = yield* pass(fake, [REPO], 1);
      assert.equal(report.attention, 1);
      const line = runLine(lines, "ATTENTION: rawphp/softfac#12 ");
      assert.ok(
        line.includes("holds a slot: issue #12 is closed. If it was closed by mistake, reopen it"),
        line,
      );
    }),
  );

  it.effect("a building run is worked: time limit, watch, advance, in that order", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(40, BUILDING, REPO, true);
      const { lines } = yield* pass(fake, [REPO], 3);
      const calls = fake.calls.filter((c) =>
        /^(time_limit|watch|forward|advance|start|resume|gate) /.test(c),
      );
      assert.deepEqual(calls, [
        `time_limit ${REPO}#40`,
        `watch ${REPO}#40`,
        `forward ${REPO}#40`,
        `advance ${REPO}#40`,
      ]);
      assert.equal(
        runLine(lines, `${REPO}#40 building:`),
        `${REPO}#40 building: session still running`,
      );
    }),
  );

  it.effect("every step of a run gets the base its launch recorded, as the listing read it", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(40, BUILDING, REPO, true, "feature/x");
      fake.runIn(41, BUILDING, REPO, true, "feature/y");
      fake.advances[`${REPO}#41`] = [{ kind: "ended-badly", what: "cancelled" }];
      fake.runIn(42, "pr-open", REPO, false, "feature/z");
      fake.feedbackSteps[runIdToString(rid(42))] = [{ kind: "relaunched", pr: 7, items: 1 }];
      yield* pass(fake, [REPO], 3);
      assert.deepEqual(
        fake.calls.filter((c) => c.includes(" on feature/")),
        [
          `time_limit ${runIdToString(rid(40))} on feature/x`,
          `watch ${runIdToString(rid(40))} on feature/x`,
          `forward ${runIdToString(rid(40))} on feature/x`,
          `advance ${runIdToString(rid(40))} on feature/x`,
          `time_limit ${runIdToString(rid(41))} on feature/y`,
          `watch ${runIdToString(rid(41))} on feature/y`,
          `forward ${runIdToString(rid(41))} on feature/y`,
          `advance ${runIdToString(rid(41))} on feature/y`,
          `interrupted ${runIdToString(rid(41))} on feature/y`,
          `feedback ${runIdToString(rid(42))} on feature/z`,
        ],
      );
    }),
  );

  it.effect("a run that is not confirmed is never time-limited, watched or advanced", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      for (const [issue, state] of [
        [12, "triage"],
        [40, BUILDING],
        [41, "stuck"],
      ] as const) {
        fake.runs.push({
          id: rid(issue),
          state,
          unreadable: false,
          confirmed: false,
          session: true,
          prReported: false,
          base: null,
        });
      }
      const { lines } = yield* pass(fake, [REPO], 3);
      const calls = fake.calls.filter((c) =>
        /^(time_limit|watch|forward|advance|start|resume|gate) /.test(c),
      );
      assert.deepEqual(calls, []);
      for (const issue of [12, 40, 41]) {
        assert.ok(!lines.some((l) => l.startsWith(`${REPO}#${issue} `)), lines.join("\n"));
      }
    }),
  );

  it.effect("a run of a repo that is not loaded is left alone", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(12, "triage", "acme/other");
      const { report } = yield* pass(fake, [REPO], 3);
      assert.deepEqual(starts(fake), []);
      assert.equal(report.errors, 0);
    }),
  );

  it.effect("a start that fails at T3 is recorded as a t3 error", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(12, "triage");
      fake.pushStart(
        `${REPO}#12`,
        new SessionsError({ operation: "find-project", cause: new Error("down") }),
      );
      yield* pass(fake, [REPO], 3);
      assert.equal(fake.runErrors[0]!.kind, "t3");
    }),
  );
});

describe("claims that have no run in the ledger", () => {
  it.effect("a triage issue of ours with no run is resumed, and is not a new claim", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.triage[REPO] = [7];
      fake.pushStart(`${REPO}#7`, { kind: "stuck", run: rid(7), reason: "could not confirm" });
      const { report, lines } = yield* pass(fake, [REPO], 1);
      assert.deepEqual(starts(fake), [`resume ${REPO}#7`]);
      const line = runLine(lines, "rawphp/softfac#7 ");
      assert.ok(line.startsWith("rawphp/softfac#7 triage: no run on record, stuck"), line);
      assert.ok(line.includes("rawphp__softfac__7__1"), line);
      assert.equal(report.claimed, 0);
    }),
  );

  it.effect("a triage issue that has an unfinished run is resumed by the run step alone", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(12, "triage");
      fake.triage[REPO] = [12];
      yield* pass(fake, [REPO], 3);
      assert.deepEqual(starts(fake), [`resume ${REPO}#12`]);
    }),
  );

  it.effect("a triage issue whose only run is not confirmed is resumed again", () =>
    Effect.gen(function* () {
      // A stuck path that failed half way leaves a run with no approval behind; start finishes it.
      const fake = new Fake();
      fake.runs.push({
        id: rid(12),
        state: "triage",
        unreadable: false,
        confirmed: false,
        session: false,
        prReported: false,
        base: null,
      });
      fake.triage[REPO] = [12];
      fake.pushStart(`${REPO}#12`, { kind: "stuck", run: rid(12), reason: "could not confirm" });
      const { lines } = yield* pass(fake, [REPO], 3);
      assert.deepEqual(starts(fake), [`resume ${REPO}#12`]);
      assert.ok(runLine(lines, "rawphp/softfac#12 ").includes("stuck"), lines.join("\n"));
    }),
  );

  it.effect("a run that is not confirmed takes no slot", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runs.push({
        id: rid(12),
        state: "triage",
        unreadable: false,
        confirmed: false,
        session: false,
        prReported: false,
        base: null,
      });
      fake.ready[REPO] = [3];
      fake.pushStart(`${REPO}#3`, started(3));
      yield* pass(fake, [REPO], 1);
      assert.deepEqual(starts(fake), [`start ${REPO}#3`]);
    }),
  );

  it.effect("a triage issue with no run is resumed even when every slot is taken", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(40, BUILDING);
      fake.triage[REPO] = [7];
      yield* pass(fake, [REPO], 1);
      assert.deepEqual(starts(fake), [`resume ${REPO}#7`]);
    }),
  );

  it.effect("a triage issue is resumed before new issues are claimed", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.triage[REPO] = [7];
      fake.ready[REPO] = [3];
      fake.pushStart(`${REPO}#7`, started(7));
      fake.pushStart(`${REPO}#3`, started(3));
      yield* pass(fake, [REPO], 5);
      assert.deepEqual(starts(fake), [`resume ${REPO}#7`, `start ${REPO}#3`]);
    }),
  );

  it.effect("a triage issue that start leaves alone or fails on is said so", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.triage[REPO] = [7, 8];
      fake.pushStart(`${REPO}#8`, githubFailure());
      const { report, lines } = yield* pass(fake, [REPO], 1);
      assert.equal(starts(fake).length, 2);
      assert.ok(runLine(lines, "rawphp/softfac#7 ").includes("not ours to resume"));
      assert.ok(
        lines.some((l) => l.startsWith("error: rawphp/softfac#8 start:")),
        lines.join("\n"),
      );
      assert.equal(report.errors, 1);
    }),
  );

  it.effect("triage issues that cannot be listed are an error and the others go on", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.triage[REPO] = "error";
      fake.triage[OTHER] = [4];
      const { report, lines } = yield* pass(fake, [REPO, OTHER], 1);
      assert.deepEqual(starts(fake), [`resume ${OTHER}#4`]);
      assert.equal(report.errors, 1);
      assert.ok(
        lines.some((l) => l.startsWith("error: rawphp/softfac: cannot list the triage issues")),
        lines.join("\n"),
      );
    }),
  );

  it.effect("a cut triage listing is said once", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.triage[REPO] = [7];
      fake.triageCut = [REPO];
      const { lines } = yield* pass(fake, [REPO], 1);
      assert.deepEqual(
        lines.filter((l) => l.includes("more than")),
        ["rawphp/softfac: more than 200 open factory:triage issues, so the oldest were not read"],
      );
    }),
  );

  it.effect("a repo whose config is broken has its triage issues left alone", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.projects[REPO] = "bad";
      fake.triage[REPO] = [7];
      yield* pass(fake, [REPO], 1);
      assert.deepEqual(starts(fake), []);
    }),
  );
});

describe("claims with no run and no assignee", () => {
  const reconciled = (issue: number): MachineEvent => ({
    event: "claim_repaired",
    data: { repo: REPO, issue: String(issue), outcome: "reconciled" },
  });

  it.effect("a triage or building issue with no run and no assignee is moved to proposed", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.unassigned[REPO] = [
        { issue: 7, state: "triage" },
        { issue: 8, state: "building" },
      ];
      const { report, lines } = yield* pass(fake, [REPO], 1);
      assert.equal(report.errors, 0);
      assert.deepEqual(releases(fake), [`release ${REPO}#7 triage`, `release ${REPO}#8 building`]);
      assert.equal(
        runLine(lines, "rawphp/softfac#7 "),
        "rawphp/softfac#7 triage: no run on record and no assignee, moved to proposed",
      );
      assert.equal(
        runLine(lines, "rawphp/softfac#8 "),
        "rawphp/softfac#8 building: no run on record and no assignee, moved to proposed",
      );
      assert.deepEqual(
        fake.events.filter((e) => e.event === "claim_repaired"),
        [reconciled(7), reconciled(8)],
      );
    }),
  );

  it.effect("an unassigned issue that has a run is left alone", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(7, "triage");
      fake.unassigned[REPO] = [
        { issue: 7, state: "triage" },
        { issue: 8, state: "building" },
      ];
      yield* pass(fake, [REPO], 1);
      assert.deepEqual(releases(fake), [`release ${REPO}#8 building`]);
      assert.deepEqual(
        fake.events.filter((e) => e.event === "claim_repaired"),
        [reconciled(8)],
      );
    }),
  );

  it.effect("the issues with runs are handed to the scan so their history is not read", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(7, "triage");
      fake.runIn(8, "triage", OTHER);
      yield* pass(fake, [REPO], 1);
      assert.ok(fake.calls.includes(`unassigned ${REPO} known=7`), fake.calls.join("\n"));
    }),
  );

  it.effect(
    "an issue whose label history cannot be read is one error line and the others are still moved",
    () =>
      Effect.gen(function* () {
        const fake = new Fake();
        fake.unreadHistory[REPO] = [{ issue: 5, message: "boom" }];
        fake.unassigned[REPO] = [{ issue: 7, state: "triage" }];
        const { report, lines } = yield* pass(fake, [REPO], 1);
        assert.equal(report.errors, 1);
        const errors = lines.filter((l) => l.startsWith("error: "));
        assert.equal(errors.length, 1, lines.join("\n"));
        assert.ok(
          errors[0]!.startsWith("error: rawphp/softfac#5: cannot read its label history: boom"),
          errors[0],
        );
        assert.deepEqual(releases(fake), [`release ${REPO}#7 triage`]);
        assert.deepEqual(recordedErrorKinds(fake), ["tracker"]);
      }),
  );

  it.effect("a repo whose config is broken has its unassigned issues left alone", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.projects[REPO] = "bad";
      fake.unassigned[REPO] = [{ issue: 7, state: "triage" }];
      yield* pass(fake, [REPO], 1);
      assert.deepEqual(releases(fake), []);
    }),
  );

  it.effect("unassigned issues that cannot be listed are an error and the pass goes on", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.unassigned[REPO] = "error";
      fake.unassigned[OTHER] = [{ issue: 4, state: "triage" }];
      const { report, lines } = yield* pass(fake, [REPO, OTHER], 1);
      assert.equal(report.errors, 1);
      assert.deepEqual(releases(fake), [`release ${OTHER}#4 triage`]);
      const errors = lines.filter((l) => l.startsWith("error: "));
      assert.equal(errors.length, 1, lines.join("\n"));
      assert.ok(
        errors[0]!.startsWith("error: rawphp/softfac: cannot list the unassigned claims: "),
      );
      assert.deepEqual(recordedErrorKinds(fake), ["tracker"]);
    }),
  );

  it.effect("a release that fails is an error and records no repair", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.releaseFails = true;
      fake.unassigned[REPO] = [
        { issue: 7, state: "triage" },
        { issue: 8, state: "triage" },
      ];
      const { report, lines } = yield* pass(fake, [REPO], 1);
      assert.equal(report.errors, 2);
      assert.equal(releases(fake).length, 2, "the pass goes on to the next");
      assert.ok(
        lines.some((l) => l.startsWith("error: rawphp/softfac#7 ")),
        lines.join("\n"),
      );
      assert.ok(!fake.events.some((e) => e.event === "claim_repaired"));
    }),
  );
});

describe("several machines on one repo", () => {
  const claimedBy = (machine: string): StartOutcome => ({
    kind: "skipped",
    reason: `claimed by machine ${machine}`,
    claimedBy: machine,
  });

  it.effect("a ready issue another machine's claim comment won is said so, and takes no slot", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.ready[REPO] = [7, 8];
      fake.pushStart(`${REPO}#7`, claimedBy("trilogy-mac"));
      fake.pushStart(`${REPO}#8`, started(8));
      const { report, lines } = yield* pass(fake, [REPO], 1);
      assert.equal(runLine(lines, `${REPO}#7 `), `${REPO}#7 ready: claimed by machine trilogy-mac`);
      assert.deepEqual(starts(fake), [`start ${REPO}#7`, `start ${REPO}#8`]);
      assert.equal(report.claimed, 1);
    }),
  );

  it.effect("a triage issue with no run that another machine won is left, naming it", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.triage[REPO] = [7];
      fake.pushStart(`${REPO}#7`, claimedBy("trilogy-mac"));
      const { lines } = yield* pass(fake, [REPO], 1);
      assert.equal(
        runLine(lines, `${REPO}#7 `),
        `${REPO}#7 triage: claimed by machine trilogy-mac`,
      );
      assert.deepEqual(fake.items, []);
    }),
  );

  it.effect("a known triage run whose issue another machine won raises no stalled item", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(7, "triage");
      fake.pushStart(`${REPO}#7`, claimedBy("trilogy-mac"));
      const { lines } = yield* pass(fake, [REPO], 1);
      assert.ok(runLine(lines, `${REPO}#7 `).includes("claimed by machine trilogy-mac"));
      assert.deepEqual(fake.items, []);
    }),
  );

  it.effect(
    "a pr-open run whose issue another machine now builds is finished and no longer worked",
    () =>
      Effect.gen(function* () {
        const fake = new Fake();
        fake.runIn(7, "pr-open");
        fake.claimed[REPO] = { 7: "building" };
        fake.yields[`${REPO}#7`] = { machine: "trilogy-mac", finished: [rid(7)] };
        const { lines } = yield* pass(fake, [REPO], 1);
        assert.equal(
          runLine(lines, `${REPO}#7 `),
          `${REPO}#7 building: claimed by machine trilogy-mac, finished run ${runIdToString(rid(7))}`,
        );
        assert.ok(fake.calls.includes(`yield ${REPO}#7`));
        // Not regated: the run is over.
        assert.ok(!fake.calls.some((c) => c.startsWith(`gate ${REPO}#7`)), fake.calls.join("\n"));
        assert.ok(!fake.calls.includes(`last_pass ${REPO}#7`));
      }),
  );

  it.effect("a run whose issue's label is the run's own state reads no claim comments", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(7, BUILDING);
      fake.claimed[REPO] = { 7: "building" };
      yield* pass(fake, [REPO], 1);
      assert.ok(fake.calls.includes(`claimed ${REPO}`));
      assert.ok(!fake.calls.includes(`yield ${REPO}#7`));
    }),
  );

  it.effect("a repo pinned with factory.owner is not checked for claims elsewhere", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.projects[REPO] = { ...project(), owner: "t3fac" };
      fake.runIn(7, "pr-open");
      fake.claimed[REPO] = { 7: "building" };
      yield* pass(fake, [REPO], 1);
      assert.ok(!fake.calls.includes(`claimed ${REPO}`));
      assert.ok(!fake.calls.includes(`yield ${REPO}#7`));
    }),
  );

  it.effect("a run whose gate is running is not checked for a claim elsewhere", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(7, "pr-open");
      fake.claimed[REPO] = { 7: "building" };
      fake.gateLocks = [runIdToString(rid(7))];
      yield* pass(fake, [REPO], 1);
      assert.ok(fake.calls.includes(`claimed ${REPO}`));
      assert.ok(!fake.calls.includes(`yield ${REPO}#7`), fake.calls.join("\n"));
    }),
  );

  it.effect(
    "a claim check that finds the gate running, or fails, finishes nothing and the runs go on",
    () =>
      Effect.gen(function* () {
        const fake = new Fake();
        fake.runIn(7, "needs-info");
        fake.runIn(8, "needs-info");
        fake.claimed[REPO] = { 7: "building", 8: "building" };
        fake.yields[`${REPO}#7`] = new GateRunningError({ run: rid(7) });
        fake.yields[`${REPO}#8`] = githubFailure();
        const { report, lines } = yield* pass(fake, [REPO], 1);
        assert.ok(
          lines.some((l) => l.startsWith(`${REPO}#7 building: gate running`)),
          lines.join("\n"),
        );
        assert.ok(
          lines.includes(
            `error: ${REPO}#8 claim check: \`gh issue list\` exited with status 1: boom`,
          ),
          lines.join("\n"),
        );
        assert.equal(report.errors, 1);
        for (const issue of [7, 8]) {
          assert.ok(
            fake.calls.some((c) => c.startsWith(`advance ${REPO}#${issue}`)),
            fake.calls.join("\n"),
          );
        }
      }),
  );

  it.effect("a cut claimed listing is said, as the other listings say it", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(7, BUILDING);
      fake.claimed[REPO] = { 7: "building" };
      fake.claimedCut[REPO] = ["building"];
      const { lines } = yield* pass(fake, [REPO], 1);
      assert.ok(
        lines.includes(
          `${REPO}: more than 200 open factory:building issues, so the oldest were not read`,
        ),
        lines.join("\n"),
      );
    }),
  );

  it.effect("a ready issue whose claim gave way is said so", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.ready[REPO] = [7];
      fake.pushStart(`${REPO}#7`, { kind: "skipped", reason: CLAIM_GAVE_WAY, gaveWay: true });
      const { report, lines } = yield* pass(fake, [REPO], 1);
      assert.equal(runLine(lines, `${REPO}#7 `), `${REPO}#7 ready: ${CLAIM_GAVE_WAY}`);
      assert.equal(report.claimed, 0);
    }),
  );

  it.effect("claimed issues that cannot be listed are an error and the runs go on", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(7, BUILDING);
      fake.claimed[REPO] = "error";
      const { report, lines } = yield* pass(fake, [REPO], 1);
      assert.ok(
        lines.some((l) => l.includes("cannot list the claimed issues")),
        lines.join("\n"),
      );
      assert.equal(report.errors, 1);
      assert.ok(
        fake.calls.some((c) => c.startsWith(`advance ${REPO}#7`)),
        fake.calls.join("\n"),
      );
    }),
  );
});

describe("a repo whose factory.owner is another machine", () => {
  const owned = (owner: string | null): ProjectConfig => ({ ...project(), owner });
  const notOwnerLine = (repo: string, owner: string) =>
    `not owner: ${repo}: factory.owner is ${owner}, this machine is t3fac; no issue is claimed`;
  const notOwnerEvent = (repo: string): MachineEvent => ({
    event: "claim_skipped",
    data: { repo, reason: "not-owner" },
  });
  /** The calls the pass made that name the repo, but for the branch prune, which writes to no issue. */
  const callsOn = (fake: Fake, repo: string) =>
    fake.calls.filter(
      (c) =>
        !c.startsWith("prune ") &&
        c.split(" ").some((word) => word === repo || word.startsWith(`${repo}#`)),
    );

  it.effect("claims no issue there and touches none, while a repo it owns claims as normal", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.projects[REPO] = owned("trilogy-mac");
      fake.ready[REPO] = [7];
      fake.pushStart(`${REPO}#7`, started(7));
      fake.projects[OTHER] = owned("t3fac");
      fake.ready[OTHER] = [8];
      fake.pushStart(`${OTHER}#8`, started(8, OTHER));
      const { report, lines } = yield* pass(fake, [REPO, OTHER], 5);
      assert.deepEqual(starts(fake), [`start ${OTHER}#8`]);
      assert.deepEqual(callsOn(fake, REPO), []);
      assert.ok(fake.calls.includes(`ready ${OTHER}`), fake.calls.join("\n"));
      assert.equal(report.claimed, 1);
      assert.deepEqual(
        lines.filter((l) => l.startsWith("not owner:")),
        [notOwnerLine(REPO, "trilogy-mac")],
      );
      assert.deepEqual(
        fake.events.filter((e) => e.event === "claim_skipped"),
        [notOwnerEvent(REPO)],
      );
      assert.equal(report.attention, 0);
      assert.deepEqual(fake.items, []);
    }),
  );

  it.effect("resumes no claim there and moves no cut-short claim to proposed", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.projects[REPO] = owned("trilogy-mac");
      // Another machine on the same login claimed #7, and cut short a claim of #9.
      fake.triage[REPO] = [7];
      fake.unassigned[REPO] = [{ issue: 9, state: "triage" }];
      const { lines } = yield* pass(fake, [REPO], 5);
      assert.deepEqual(callsOn(fake, REPO), []);
      assert.deepEqual(starts(fake), []);
      assert.deepEqual(releases(fake), []);
      assert.deepEqual(
        lines.filter((l) => l.startsWith("not owner:")),
        [notOwnerLine(REPO, "trilogy-mac")],
      );
    }),
  );

  it.effect("a repo with no owner is claimed from by any machine", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.projects[REPO] = owned(null);
      fake.ready[REPO] = [7];
      fake.pushStart(`${REPO}#7`, started(7));
      const { lines } = yield* pass(fake, [REPO], 5);
      assert.deepEqual(starts(fake), [`start ${REPO}#7`]);
      assert.ok(!lines.some((l) => l.startsWith("not owner:")), lines.join("\n"));
    }),
  );

  it.effect("an owner that names this machine in another case claims", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.projects[REPO] = owned("T3FAC");
      fake.ready[REPO] = [7];
      fake.pushStart(`${REPO}#7`, started(7));
      const { lines } = yield* pass(fake, [REPO], 5);
      assert.deepEqual(starts(fake), [`start ${REPO}#7`]);
      assert.ok(!lines.some((l) => l.startsWith("not owner:")), lines.join("\n"));
      assert.deepEqual(
        fake.events.filter((e) => e.event === "claim_skipped"),
        [],
      );
    }),
  );

  it.effect("a run this machine holds there goes on after the owner changed", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.projects[REPO] = owned("trilogy-mac");
      fake.runIn(40, BUILDING, REPO, true);
      fake.ready[REPO] = [7];
      yield* pass(fake, [REPO], 5);
      const steps = callsOn(fake, REPO).filter(
        (c) => !c.startsWith("runs ") && !c.startsWith("stop_request "),
      );
      assert.deepEqual(steps, [
        `time_limit ${REPO}#40`,
        `watch ${REPO}#40`,
        `forward ${REPO}#40`,
        `advance ${REPO}#40`,
      ]);
    }),
  );

  it.effect("a pr-open run this machine holds there still has its feedback read and is gated", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.projects[REPO] = owned("trilogy-mac");
      fake.runIn(41, "pr-open", REPO, false);
      fake.openHeads[`${REPO}#12`] = PUSHED;
      yield* pass(fake, [REPO], 5);
      assert.deepEqual(fake.feedbacks, [runIdToString(rid(41))]);
      assert.ok(fake.calls.includes(`gate ${REPO}#41`), fake.calls.join("\n"));
    }),
  );

  it.effect("an owner with control characters is printed plain", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.projects[REPO] = owned("x\u001b[2K\rclaimed #412\nATTENTION");
      const { lines } = yield* pass(fake, [REPO], 5);
      const line = runLine(lines, "not owner:");
      assert.ok(!/[\u0000-\u001f\u007f]/.test(line), JSON.stringify(line));
    }),
  );
});

describe("issues labelled postponed", () => {
  const POSTPONED_LINE = `${REPO}#14 ready: postponed, not claimed`;

  it.effect("a ready issue labelled postponed is not claimed and its blockers are not read", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.ready[REPO] = [14];
      fake.labels[`${REPO}#14`] = ["factory:ready", "postponed"];
      const { report, lines } = yield* pass(fake, [REPO], 5);
      assert.deepEqual(starts(fake), []);
      assert.ok(
        !fake.calls.some((c) => c.endsWith(`${REPO}#14`) && /^(blockers|depends) /.test(c)),
      );
      assert.equal(runLine(lines, `${REPO}#14 `), POSTPONED_LINE);
      assert.deepEqual([report.claimed, report.errors, report.attention], [0, 0, 0]);
      const skipped = fake.events.filter((e) => e.event === "claim_skipped");
      assert.deepEqual(skipped, [claimSkipped(14, "postponed")]);
    }),
  );

  it.effect("the same issue without the label is claimed", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.ready[REPO] = [14];
      fake.labels[`${REPO}#14`] = ["factory:ready"];
      fake.pushStart(`${REPO}#14`, started(14));
      yield* pass(fake, [REPO], 5);
      assert.deepEqual(starts(fake), [`start ${REPO}#14`]);
      assert.ok(!fake.events.some((e) => e.event === "claim_skipped"));
    }),
  );

  it.effect("the label matches in any case, and only as the whole name", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.ready[REPO] = [14, 15, 16, 17];
      fake.labels[`${REPO}#14`] = ["Postponed"];
      fake.labels[`${REPO}#15`] = ["POSTPONED"];
      fake.labels[`${REPO}#16`] = ["postponed-q4"];
      fake.labels[`${REPO}#17`] = ["not-postponed"];
      fake.pushStart(`${REPO}#16`, started(16));
      fake.pushStart(`${REPO}#17`, started(17));
      const { lines } = yield* pass(fake, [REPO], 5);
      assert.deepEqual(starts(fake), [`start ${REPO}#16`, `start ${REPO}#17`]);
      assert.equal(runLine(lines, `${REPO}#14 `), POSTPONED_LINE);
      assert.equal(runLine(lines, `${REPO}#15 `), `${REPO}#15 ready: postponed, not claimed`);
      assert.deepEqual(
        fake.events.filter((e) => e.event === "claim_skipped"),
        [claimSkipped(14, "postponed"), claimSkipped(15, "postponed")],
      );
    }),
  );

  it.effect("a postponed issue takes no slot and is not counted against the limit", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.ready[REPO] = [14, 20];
      fake.labels[`${REPO}#14`] = ["postponed"];
      fake.pushStart(`${REPO}#20`, started(20));
      const { lines } = yield* pass(fake, [REPO], 1);
      assert.deepEqual(starts(fake), [`start ${REPO}#20`]);
      assert.ok(!fake.events.some((e) => JSON.stringify(e).includes('"reason":"limit"')));
      assert.ok(!lines.some((l) => l.startsWith("limit reached")), lines.join("\n"));
    }),
  );

  it.effect("a building run on an issue that is now postponed goes on as before", () =>
    Effect.gen(function* () {
      // Listed as ready too, so the label reaches the pass while the run is building.
      const fake = new Fake();
      fake.runIn(14, BUILDING, REPO, true);
      fake.ready[REPO] = [14];
      fake.labels[`${REPO}#14`] = ["postponed"];
      const before = new Fake();
      before.runIn(14, BUILDING, REPO, true);
      yield* pass(fake, [REPO], 5);
      yield* pass(before, [REPO], 5);
      const following = (f: Fake) =>
        f.calls.filter((c) => !/^(ready|start|blockers|depends) /.test(c));
      assert.deepEqual(following(fake), following(before));
      assert.deepEqual(starts(fake), []);
    }),
  );

  it.effect("while claims are paused a postponed issue gets no line and no event of its own", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.ready[REPO] = [14];
      fake.labels[`${REPO}#14`] = ["postponed"];
      fake.pause = { sinceMs: T0 - 60 * 60 * 1000 };
      const { lines } = yield* pass(fake, [REPO], 5);
      assert.ok(!lines.some((l) => l.startsWith(`${REPO}#14 `)), lines.join("\n"));
      assert.deepEqual(
        fake.events.filter((e) => e.event === "claim_skipped"),
        [{ event: "claim_skipped", data: { reason: "paused" } }],
      );
    }),
  );
});

describe("issues blocked by an open issue", () => {
  it.effect("an issue blocked by an open issue is not claimed", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.ready[REPO] = [14];
      fake.blockers[`${REPO}#14`] = blockerList([[REPO, 13]]);
      const { report, lines } = yield* pass(fake, [REPO], 5);
      assert.deepEqual(starts(fake), []);
      assert.ok(lines.includes("rawphp/softfac#14 ready: blocked by #13"), lines.join("\n"));
      assert.deepEqual([report.claimed, report.errors], [0, 0]);
      assert.ok(
        fake.events.some((e) => JSON.stringify(e) === JSON.stringify(claimSkipped(14, "blocked"))),
      );
    }),
  );

  it.effect("several blockers are joined, and one in another repo names its repo", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.ready[REPO] = [14];
      fake.blockers[`${REPO}#14`] = blockerList([
        [REPO, 13],
        ["acme/widgets", 7],
        ["RawPHP/Softfac", 9],
      ]);
      const { lines } = yield* pass(fake, [REPO], 5);
      assert.ok(
        lines.includes("rawphp/softfac#14 ready: blocked by #13, acme/widgets#7, #9"),
        lines.join("\n"),
      );
    }),
  );

  it.effect("a blocked issue uses no slot and the pass goes on to the next", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.ready[REPO] = [14, 15];
      fake.blockers[`${REPO}#14`] = blockerList([[REPO, 13]]);
      fake.pushStart(`${REPO}#15`, started(15));
      const { report } = yield* pass(fake, [REPO], 1);
      assert.deepEqual(starts(fake), [`start ${REPO}#15`]);
      assert.equal(report.claimed, 1);
    }),
  );

  it.effect("with no slot free no blockers are read and every issue left is counted", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(40, BUILDING);
      fake.ready[REPO] = [14, 15];
      fake.blockers[`${REPO}#14`] = blockerList([[REPO, 13]]);
      const { lines } = yield* pass(fake, [REPO], 1);
      assert.ok(
        lines.includes("limit reached: 2 ready issues were not claimed, max_concurrent_runs is 1"),
        lines.join("\n"),
      );
      assert.deepEqual(
        fake.calls.filter((c) => c.startsWith("blockers ") || c.startsWith("depends ")),
        [],
      );
      assert.deepEqual(
        fake.events.filter((e) => e.event === "claim_skipped"),
        [claimSkipped(14, "limit"), claimSkipped(15, "limit")],
      );
    }),
  );

  it.effect("blockers are read only until the last slot is taken", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.ready[REPO] = [14, 15, 16];
      fake.blockers[`${REPO}#14`] = blockerList([[REPO, 13]]);
      fake.pushStart(`${REPO}#15`, started(15));
      yield* pass(fake, [REPO], 1);
      assert.deepEqual(
        fake.calls.filter((c) => c.startsWith("blockers ")),
        [`blockers ${REPO}#14`, `blockers ${REPO}#15`],
      );
      assert.deepEqual(starts(fake), [`start ${REPO}#15`]);
    }),
  );

  it.effect("an issue whose blockers cannot be read is not claimed and the pass goes on", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.ready[REPO] = [14, 15];
      fake.blockers[`${REPO}#14`] = "error";
      fake.pushStart(`${REPO}#15`, started(15));
      const { report, lines } = yield* pass(fake, [REPO], 5);
      assert.deepEqual(starts(fake), [`start ${REPO}#15`]);
      assert.equal(report.errors, 1);
      assert.ok(
        lines.some((l) =>
          l.startsWith("error: rawphp/softfac#14 cannot read the issue's dependencies: "),
        ),
        lines.join("\n"),
      );
      assert.deepEqual(
        fake.events.filter((e) => e.event === "claim_skipped"),
        [{ event: "claim_skipped", data: { repo: REPO, issue: "14", reason: "read-failed" } }],
      );
    }),
  );

  it.effect("blockers are read only when an issue is about to be claimed", () =>
    Effect.gen(function* () {
      // Runs that have started are not looked at again, and untracked triage claims are already made.
      const fake = new Fake();
      fake.runIn(14, BUILDING);
      fake.triage[REPO] = [7];
      fake.blockers[`${REPO}#14`] = blockerList([[REPO, 13]]);
      fake.blockers[`${REPO}#7`] = blockerList([[REPO, 13]]);
      fake.depends[`${REPO}#14`] = blockerList([[REPO, 13]]);
      fake.depends[`${REPO}#7`] = blockerList([[REPO, 13]]);
      yield* pass(fake, [REPO], 5);
      assert.ok(!fake.calls.some((c) => c.startsWith("blockers")), fake.calls.join("\n"));
      assert.equal(
        fake.calls.filter((c) => c.startsWith("depends")).length,
        0,
        fake.calls.join("\n"),
      );
    }),
  );
});

describe("issues whose Depends on text names an open issue", () => {
  it.effect("an issue whose depends on names an open issue is not claimed", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.ready[REPO] = [14];
      fake.depends[`${REPO}#14`] = blockerList([[REPO, 13]]);
      const { report, lines } = yield* pass(fake, [REPO], 5);
      assert.deepEqual(starts(fake), []);
      assert.ok(
        lines.includes(`rawphp/softfac#14 ready: blocked by #13${FROM_TEXT}`),
        lines.join("\n"),
      );
      assert.deepEqual([report.claimed, report.errors], [0, 0]);
    }),
  );

  it.effect(
    "each blocker from the text carries the suffix, and one in another repo names its repo",
    () =>
      Effect.gen(function* () {
        const fake = new Fake();
        fake.ready[REPO] = [14];
        fake.depends[`${REPO}#14`] = blockerList([
          [REPO, 13],
          ["acme/widgets", 7],
        ]);
        const { lines } = yield* pass(fake, [REPO], 5);
        assert.ok(
          lines.includes(
            `rawphp/softfac#14 ready: blocked by #13${FROM_TEXT}, acme/widgets#7${FROM_TEXT}`,
          ),
          lines.join("\n"),
        );
      }),
  );

  it.effect("an issue whose depends on names nothing open is claimed as normal", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.ready[REPO] = [14];
      fake.depends[`${REPO}#14`] = [];
      fake.pushStart(`${REPO}#14`, started(14));
      const { report } = yield* pass(fake, [REPO], 5);
      assert.deepEqual(starts(fake), [`start ${REPO}#14`]);
      assert.equal(report.claimed, 1);
    }),
  );

  it.effect("an issue blocked by a link does not have its depends on read", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.ready[REPO] = [14];
      fake.blockers[`${REPO}#14`] = blockerList([[REPO, 13]]);
      fake.depends[`${REPO}#14`] = blockerList([[REPO, 12]]);
      yield* pass(fake, [REPO], 5);
      assert.equal(fake.calls.filter((c) => c.startsWith("depends")).length, 0);
    }),
  );

  it.effect("an issue whose depends on cannot be read is not claimed and the pass goes on", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.ready[REPO] = [14, 15];
      fake.depends[`${REPO}#14`] = "error";
      fake.pushStart(`${REPO}#15`, started(15));
      const { report, lines } = yield* pass(fake, [REPO], 5);
      assert.deepEqual(starts(fake), [`start ${REPO}#15`]);
      assert.equal(report.errors, 1);
      assert.ok(
        lines.some((l) =>
          l.startsWith("error: rawphp/softfac#14 cannot read the issue's Depends on: "),
        ),
        lines.join("\n"),
      );
      assert.deepEqual(recordedErrorKinds(fake), ["tracker"]);
      assert.deepEqual(
        fake.events.filter((e) => e.event === "claim_skipped"),
        [{ event: "claim_skipped", data: { repo: REPO, issue: "14", reason: "read-failed" } }],
      );
    }),
  );

  it.effect("an issue blocked by its text is recorded as a skipped claim", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.ready[REPO] = [14];
      fake.depends[`${REPO}#14`] = blockerList([[REPO, 13]]);
      yield* pass(fake, [REPO], 5);
      assert.ok(
        fake.events.some((e) => JSON.stringify(e) === JSON.stringify(claimSkipped(14, "blocked"))),
      );
    }),
  );
});

describe("the limit, said out loud", () => {
  const LIMIT_1 = "limit reached: 1 ready issue was not claimed, max_concurrent_runs is 1";

  it.effect("issues left unclaimed because the limit is reached are counted in one line", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(40, BUILDING);
      fake.ready[REPO] = [1, 2];
      const { lines } = yield* pass(fake, [REPO], 1);
      assert.ok(
        lines.includes("limit reached: 2 ready issues were not claimed, max_concurrent_runs is 1"),
        lines.join("\n"),
      );
      assert.equal(lines.filter((l) => l.startsWith("limit reached")).length, 1);
    }),
  );

  it.effect("the count covers what is left after the slots fill, and the repos after it", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.ready[REPO] = [1, 2, 3];
      fake.ready[OTHER] = [4];
      fake.pushStart(`${REPO}#1`, started(1));
      const { lines } = yield* pass(fake, [REPO, OTHER], 1);
      assert.ok(
        lines.includes("limit reached: 3 ready issues were not claimed, max_concurrent_runs is 1"),
        lines.join("\n"),
      );
    }),
  );

  it.effect("an issue start skipped before the limit is not counted as left over", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.ready[REPO] = [1, 2, 3];
      // 1 is skipped (the default), 2 is claimed, 3 is left.
      fake.pushStart(`${REPO}#2`, started(2));
      const { lines } = yield* pass(fake, [REPO], 1);
      assert.ok(lines.includes(LIMIT_1), lines.join("\n"));
    }),
  );

  it.effect("no limit line when every ready issue was tried", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.ready[REPO] = [1, 2];
      const { lines } = yield* pass(fake, [REPO], 5);
      assert.ok(!lines.some((l) => l.startsWith("limit reached")), lines.join("\n"));
    }),
  );
});

describe("a pass that has run long", () => {
  /** A fake whose ready listing takes `ms`, so claiming starts that far into the pass. */
  const slowListing = (ms: number) => {
    const fake = new Fake();
    fake.ready[REPO] = [1];
    fake.pushStart(`${REPO}#1`, started(1));
    const list = fake.readyIssues.bind(fake);
    fake.readyIssues = (repo: Repo) => {
      fake.now += ms;
      return list(repo);
    };
    return fake;
  };

  it.effect("twenty minutes in, no claim is started and one line says so", () =>
    Effect.gen(function* () {
      const fake = slowListing(20 * 60_000);
      const { report, lines } = yield* pass(fake, [REPO], 3);
      assert.deepEqual(starts(fake), []);
      assert.equal(report.claimed, 0);
      assert.deepEqual(
        lines.filter((l) => l.startsWith("claims stopped")),
        ["claims stopped: the pass has run for 20m; the ready issues left wait for the next pass"],
      );
      assert.deepEqual(
        fake.events.filter((e) => e.event === "claim_skipped"),
        [{ event: "claim_skipped", data: { reason: "late" } }],
      );
    }),
  );

  it.effect("just short of twenty minutes, the claim is started", () =>
    Effect.gen(function* () {
      const fake = slowListing(20 * 60_000 - 1);
      const { lines } = yield* pass(fake, [REPO], 3);
      assert.deepEqual(starts(fake), [`start ${REPO}#1`]);
      assert.ok(!lines.some((l) => l.startsWith("claims stopped")), lines.join("\n"));
    }),
  );
});

describe("the hand pause", () => {
  /** A person paused claims two hours before the clock of the fake. */
  const pausedByHand = (fake: Fake) => {
    fake.pause = { sinceMs: T0 - 2 * 60 * 60 * 1000 };
  };

  /** The one line of a pass that finds the pause, two hours old. */
  const HAND_PAUSE_LINE = `claims paused: by hand since ${formatTs(T0 - 2 * 60 * 60 * 1000)}, for 2h00m; no ready issue claimed`;

  const handLines = (lines: ReadonlyArray<string>) =>
    lines.filter((l) => l.startsWith("claims paused: by hand"));

  const claimSkippedEvents = (fake: Fake) => fake.events.filter((e) => e.event === "claim_skipped");

  it.effect("with the pause no ready issue of any repo is claimed, and one line says so", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.ready[REPO] = [1, 2];
      fake.ready[OTHER] = [4];
      pausedByHand(fake);
      const { report, lines } = yield* pass(fake, [REPO, OTHER], 5);
      assert.deepEqual(starts(fake), []);
      assert.ok(!fake.calls.some((c) => c.startsWith("blockers")), fake.calls.join("\n"));
      assert.deepEqual(handLines(lines), [HAND_PAUSE_LINE]);
      assert.deepEqual(claimSkippedEvents(fake), [
        { event: "claim_skipped", data: { reason: "paused" } },
      ]);
      // No line for each issue, no limit.
      assert.ok(!lines.some((l) => l.includes(" ready:")), lines.join("\n"));
      assert.ok(!lines.some((l) => l.startsWith("limit reached")));
      assert.deepEqual([report.claimed, report.attention, report.errors], [0, 0, 0]);
    }),
  );

  it.effect("with the pause a pass with nothing ready still says it once", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      pausedByHand(fake);
      const { lines } = yield* pass(fake, [REPO], 5);
      assert.deepEqual(handLines(lines), [HAND_PAUSE_LINE]);
      assert.equal(claimSkippedEvents(fake).length, 1);
    }),
  );

  it.effect("with the pause an untracked claim is still handled", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.triage[REPO] = [7];
      fake.unassigned[REPO] = [{ issue: 8, state: "triage" }];
      pausedByHand(fake);
      yield* pass(fake, [REPO], 5);
      assert.deepEqual(starts(fake), [`resume ${REPO}#7`]);
      assert.deepEqual(releases(fake), [`release ${REPO}#8 triage`]);
    }),
  );

  it.effect(
    "without the pause the same ready issue is claimed and nothing is said of a pause",
    () =>
      Effect.gen(function* () {
        const fake = new Fake();
        fake.ready[REPO] = [1];
        fake.pushStart(`${REPO}#1`, started(1));
        const { report, lines } = yield* pass(fake, [REPO], 5);
        assert.equal(starts(fake).length, 1, fake.calls.join("\n"));
        assert.deepEqual(handLines(lines), []);
        assert.deepEqual(claimSkippedEvents(fake), []);
        assert.equal(report.claimed, 1);
      }),
  );
});

describe("the Paradev hold", () => {
  const OFFLINE: ParadevDown = {
    reason: "offline",
    message:
      "superset status --json failed (PARADEV_OFFLINE): Host service for this machine isn't running",
  };
  const holdLines = (lines: ReadonlyArray<string>) =>
    lines.filter((l) => l.startsWith("paradev offline:"));
  const holdItems = (fake: Fake) =>
    fake.items.filter((item) => item.id === PARADEV_OFFLINE_ITEM_ID);
  const skipped = (fake: Fake) => fake.events.filter((e) => e.event === "claim_skipped");

  it.effect("superset status failing claims nothing, records paradev-offline, and raises one item on the third pass", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.ready[REPO] = [1, 2];
      fake.down = OFFLINE;
      for (const n of [1, 2]) {
        const { report, lines } = yield* pass(fake, [REPO], 5);
        assert.deepEqual(starts(fake), []);
        assert.deepEqual(holdLines(lines), [
          `paradev offline: ${OFFLINE.message}; no issue claimed or resumed until Paradev answers`,
        ]);
        assert.equal(skipped(fake).length, n);
        assert.deepEqual(holdItems(fake), []);
        assert.deepEqual([report.claimed, report.attention], [0, 0]);
        fake.now += 60_000;
      }
      const third = yield* pass(fake, [REPO], 5);
      assert.deepEqual(starts(fake), []);
      assert.deepEqual(skipped(fake), [
        { event: "claim_skipped", data: { reason: "paradev-offline" } },
        { event: "claim_skipped", data: { reason: "paradev-offline" } },
        { event: "claim_skipped", data: { reason: "paradev-offline" } },
      ]);
      assert.deepEqual(
        holdItems(fake).map(({ kind, repo, issue, run, message }) => ({
          kind,
          repo,
          issue,
          run,
          message,
        })),
        [
          {
            kind: "attention",
            repo: null,
            issue: null,
            run: null,
            message:
              "Paradev is offline: no issue has been claimed for 3 passes; open the Paradev app, or start its host service (superset status fails)",
          },
        ],
      );
      assert.equal(third.report.attention, 1);
      fake.now += 60_000;
      yield* pass(fake, [REPO], 5);
      assert.equal(holdItems(fake).length, 1);
      assert.equal(holdItems(fake)[0]!.firstSeenMs, T0 + 2 * 60_000);
    }),
  );

  it.effect("a building run is still followed, and no claim is resumed until Paradev answers", () =>
    Effect.gen(function* () {
      // A resume may launch a session, which fails while Paradev is down and sends the run stuck.
      const fake = new Fake();
      fake.runIn(40, BUILDING, REPO, true);
      fake.runIn(8, "triage");
      fake.triage[REPO] = [7, 8];
      fake.down = OFFLINE;
      const { report, lines } = yield* pass(fake, [REPO], 5);
      assert.ok(fake.calls.includes(`advance ${REPO}#40`), fake.calls.join("\n"));
      assert.deepEqual(starts(fake), []);
      assert.equal(runLine(lines, `${REPO}#8 `), `${REPO}#8 triage: ${PARADEV_WAIT}`);
      assert.isUndefined(lines.find((l) => l.startsWith(`${REPO}#7 `)));
      assert.deepEqual([report.errors, report.attention], [0, 0]);
      fake.down = null;
      yield* pass(fake, [REPO], 5);
      assert.deepEqual(starts(fake).toSorted(), [`resume ${REPO}#7`, `resume ${REPO}#8`]);
    }),
  );

  it.effect("signed out and a failed CLI check each say what to do", () =>
    Effect.gen(function* () {
      for (const [down, message] of [
        [
          { reason: "signed-out", message: "Not logged in" },
          "Paradev is signed out: no issue has been claimed for 3 passes; run superset auth login",
        ],
        [
          { reason: "cli-check", message: "superset 2.0.9 lacks what the runner uses: agents explain" },
          "the Paradev CLI check failed: no issue has been claimed for 3 passes; superset 2.0.9 lacks what the runner uses: agents explain",
        ],
      ] as const) {
        const fake = new Fake();
        fake.down = down;
        for (let i = 0; i < 3; i++) yield* pass(fake, [REPO], 5);
        assert.deepEqual(
          holdItems(fake).map((item) => item.message),
          [message],
        );
      }
    }),
  );

  it.effect("once Paradev answers the item clears, claiming resumes, and the count starts over", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.ready[REPO] = [1];
      fake.down = OFFLINE;
      for (let i = 0; i < 3; i++) yield* pass(fake, [REPO], 5);
      assert.equal(holdItems(fake).length, 1);
      fake.down = null;
      fake.pushStart(`${REPO}#1`, started(1));
      const { report, lines } = yield* pass(fake, [REPO], 5);
      assert.deepEqual(starts(fake), [`start ${REPO}#1`]);
      assert.deepEqual(holdLines(lines), []);
      assert.deepEqual(holdItems(fake), []);
      assert.equal(report.claimed, 1);
      fake.down = OFFLINE;
      for (let i = 0; i < 2; i++) yield* pass(fake, [REPO], 5);
      assert.deepEqual(holdItems(fake), []);
    }),
  );
});

describe("low disk space", () => {
  /** The one line of a pass that finds 5 GiB free under a floor of 10. */
  const LOW_LINE =
    "low disk: 5.0 GiB free on /data/worktrees, below min_free_gib 10; no issue is claimed and no gate starts until there is more";
  /** The item leaves out the figure and the path: an open item is not raised again, so they would go stale. */
  const LOW_ITEM =
    "low disk: free space is below min_free_gib 10; no issue is claimed and no gate starts until there is more";
  const lowLines = (lines: ReadonlyArray<string>) => lines.filter((l) => l.startsWith("low disk:"));
  const lowItems = (fake: Fake) => fake.items.filter((item) => item.id === "low-disk");
  const gates = (fake: Fake) => fake.calls.filter((c) => c.startsWith("gate "));
  const readyForGate = (fake: Fake, issue: number) => {
    fake.advances[`${REPO}#${issue}`] = [
      { kind: "ready-for-gate", pr: 3, prUrl: "https://github.com/rawphp/softfac/pull/3" },
    ];
  };

  it.effect(
    "below the floor no ready issue is claimed, one line says so, and one item is raised",
    () =>
      Effect.gen(function* () {
        const fake = new Fake();
        fake.ready[REPO] = [1, 2];
        fake.ready[OTHER] = [4];
        fake.free = 5 * GIB;
        const { report, lines } = yield* pass(fake, [REPO, OTHER], 5);
        assert.deepEqual(starts(fake), []);
        assert.deepEqual(lowLines(lines), [LOW_LINE]);
        assert.deepEqual(
          lowItems(fake).map(({ kind, repo, issue, run, message }) => ({
            kind,
            repo,
            issue,
            run,
            message,
          })),
          [{ kind: "attention", repo: null, issue: null, run: null, message: LOW_ITEM }],
        );
        assert.deepEqual(
          fake.events.filter((e) => e.event === "claim_skipped"),
          [{ event: "claim_skipped", data: { reason: "low-disk" } }],
        );
        assert.deepEqual(queueEvents(fake), [
          { event: "claim_skipped", data: { reason: "low-disk" } },
        ]);
        assert.equal(report.attention, 1);
        assert.equal(report.errors, 0);
      }),
  );

  it.effect("a second pass below the floor keeps the one item", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.free = 5 * GIB;
      yield* pass(fake, [REPO], 5);
      fake.now += 60_000;
      const { lines } = yield* pass(fake, [REPO], 5);
      assert.deepEqual(lowLines(lines), [LOW_LINE]);
      assert.equal(lowItems(fake).length, 1);
      assert.equal(lowItems(fake)[0]!.firstSeenMs, T0);
    }),
  );

  it.effect("once space is back the item clears and claiming resumes", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.ready[REPO] = [1];
      fake.free = 5 * GIB;
      yield* pass(fake, [REPO], 5);
      assert.deepEqual(starts(fake), []);
      fake.free = 10 * GIB;
      fake.pushStart(`${REPO}#1`, started(1));
      const { report, lines } = yield* pass(fake, [REPO], 5);
      assert.deepEqual(starts(fake), [`start ${REPO}#1`]);
      assert.deepEqual(lowLines(lines), []);
      assert.deepEqual(lowItems(fake), []);
      assert.equal(report.claimed, 1);
    }),
  );

  // The gate counts an attempt only once it runs (`runner/gating.ts`), so a gate that is never
  // started leaves the attempt count where it was.
  it.effect(
    "a building run's gate is not started below the floor, and starts once space is back",
    () =>
      Effect.gen(function* () {
        const fake = new Fake();
        fake.runIn(40, BUILDING, REPO, true);
        fake.free = 5 * GIB;
        readyForGate(fake, 40);
        const { lines } = yield* pass(fake, [REPO], 3);
        assert.deepEqual(gates(fake), []);
        assert.equal(
          runLine(lines, `${REPO}#40 `),
          `${REPO}#40 building: session finished, the gate waits for more free disk space`,
        );
        fake.free = 50 * GIB;
        readyForGate(fake, 40);
        yield* pass(fake, [REPO], 3);
        assert.deepEqual(gates(fake), [`gate ${REPO}#40`]);
      }),
  );

  it.effect("a pending gate send waits below the floor too", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(40, BUILDING, REPO, true);
      fake.pendingSends = [runIdToString(fake.runs[0]!.id)];
      fake.advances[`${REPO}#40`] = [{ kind: "running" }];
      fake.free = 5 * GIB;
      yield* pass(fake, [REPO], 3);
      assert.deepEqual(gates(fake), []);
    }),
  );

  it.effect("a pr-open run is not gated again below the floor", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(41, "pr-open", REPO, false);
      fake.openHeads[`${REPO}#12`] = PUSHED;
      fake.free = 5 * GIB;
      const { lines } = yield* pass(fake, [REPO], 3);
      assert.deepEqual(gates(fake), []);
      assert.equal(
        runLine(lines, `${REPO}#41 `),
        `${REPO}#41 pr-open: the gate waits for more free disk space`,
      );
    }),
  );

  it.effect("min_free_gib 0 reads no free space and holds nothing back", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.ready[REPO] = [1];
      fake.pushStart(`${REPO}#1`, started(1));
      fake.free = 0;
      fake.minFreeGib = 0;
      const { lines } = yield* pass(fake, [REPO], 5);
      assert.ok(!fake.calls.includes("free_space"));
      assert.deepEqual(starts(fake), [`start ${REPO}#1`]);
      assert.deepEqual(lowLines(lines), []);
    }),
  );

  it.effect("min_free_gib 0 clears an item a higher floor raised", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.free = 5 * GIB;
      yield* pass(fake, [REPO], 5);
      assert.equal(lowItems(fake).length, 1);
      fake.minFreeGib = 0;
      yield* pass(fake, [REPO], 5);
      assert.deepEqual(lowItems(fake), []);
    }),
  );

  it.effect("a free space that cannot be read is an error line, and the pass claims as usual", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.ready[REPO] = [1];
      fake.pushStart(`${REPO}#1`, started(1));
      fake.free = "error";
      const { report, lines } = yield* pass(fake, [REPO], 5);
      assert.ok(
        lines.includes("error: cannot read the free disk space: statfs /data/worktrees: EIO"),
        lines.join("\n"),
      );
      assert.deepEqual(starts(fake), [`start ${REPO}#1`]);
      assert.equal(report.errors, 1);
    }),
  );

  it.effect("a free space that cannot be read clears the item, since claims go on", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.free = 5 * GIB;
      yield* pass(fake, [REPO], 5);
      assert.equal(lowItems(fake).length, 1);
      fake.free = "error";
      yield* pass(fake, [REPO], 5);
      assert.deepEqual(lowItems(fake), []);
    }),
  );

  it.effect("a floor above the real free space of a directory holds back claims and gates", () =>
    Effect.gen(function* () {
      const dir = passTempDir("free");
      const fake = new Fake();
      fake.freeSpace = () => Effect.sync(() => readFreeSpace(dir));
      fake.minFreeGib = Math.ceil(readFreeSpace(dir).freeBytes / GIB) + 1;
      fake.ready[REPO] = [1];
      fake.runIn(40, BUILDING, REPO, true);
      readyForGate(fake, 40);
      const { report, lines } = yield* pass(fake, [REPO], 5);
      assert.deepEqual(starts(fake), []);
      assert.deepEqual(gates(fake), []);
      const [low, ...more] = lowLines(lines);
      assert.deepEqual(more, []);
      assert.match(
        low ?? "",
        new RegExp(
          `^low disk: [\\d.]+ GiB free on .+, below min_free_gib ${fake.minFreeGib}; no issue is claimed`,
        ),
      );
      assert.equal(lowItems(fake).length, 1);
      assert.equal(report.attention, 1);
    }),
  );
});

describe("high load", () => {
  const HIGH_LINE =
    "high load: 1-minute load 55.2 is above 12 (12 cores x max_load_per_core 1); no issue is claimed and a second gate waits until it drops";
  const highLines = (lines: ReadonlyArray<string>) =>
    lines.filter((l) => l.startsWith("high load:"));
  const gates = (fake: Fake) => fake.calls.filter((c) => c.startsWith("gate "));

  it.effect(
    "above the limit no ready issue is claimed, one line says so, and no item is raised",
    () =>
      Effect.gen(function* () {
        const fake = new Fake();
        fake.ready[REPO] = [1, 2];
        fake.ready[OTHER] = [4];
        fake.loadAvg = { oneMinute: 55.2, cores: 12 };
        const { report, lines } = yield* pass(fake, [REPO, OTHER], 5);
        assert.deepEqual(starts(fake), []);
        assert.deepEqual(highLines(lines), [HIGH_LINE]);
        assert.deepEqual(
          fake.events.filter((e) => e.event === "claim_skipped"),
          [{ event: "claim_skipped", data: { reason: "high-load" } }],
        );
        assert.deepEqual(queueEvents(fake), [
          { event: "claim_skipped", data: { reason: "high-load" } },
        ]);
        assert.deepEqual(fake.items, []);
        assert.equal(report.attention, 0);
        assert.equal(report.errors, 0);
      }),
  );

  // The world's gate holds a second gate under load; the pass still asks for it.
  it.effect("above the limit a run's gate is still asked for", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(40, BUILDING, REPO, true);
      fake.advances[`${REPO}#40`] = [
        { kind: "ready-for-gate", pr: 3, prUrl: "https://github.com/rawphp/softfac/pull/3" },
      ];
      fake.loadAvg = { oneMinute: 55.2, cores: 12 };
      yield* pass(fake, [REPO], 5);
      assert.deepEqual(gates(fake), [`gate ${REPO}#40`]);
    }),
  );

  it.effect("at the limit or under it the pass claims as before", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.ready[REPO] = [1];
      fake.pushStart(`${REPO}#1`, started(1));
      fake.loadAvg = { oneMinute: 12, cores: 12 };
      const { lines } = yield* pass(fake, [REPO], 5);
      assert.deepEqual(starts(fake), [`start ${REPO}#1`]);
      assert.deepEqual(highLines(lines), []);
      assert.ok(fake.calls.includes("load"));
    }),
  );

  it.effect("max_load_per_core 0 reads no load and holds nothing back", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.ready[REPO] = [1];
      fake.pushStart(`${REPO}#1`, started(1));
      fake.loadAvg = { oneMinute: 55.2, cores: 12 };
      fake.maxLoadPerCore = 0;
      const { lines } = yield* pass(fake, [REPO], 5);
      assert.ok(!fake.calls.includes("load"));
      assert.deepEqual(starts(fake), [`start ${REPO}#1`]);
      assert.deepEqual(highLines(lines), []);
    }),
  );
});

describe("threads on a broken worktree", () => {
  const WHAT =
    "rawphp/softfac#42: worktree /wt/t3-abc of run rawphp__softfac__42__1 is gone or no longer a git checkout";
  const ITEM = `${WHAT}; the factory archived the threads still on it`;
  const lineFor = (n: number) =>
    `${WHAT}; archived ${n} thread(s) still on it, so T3 stops looking up their branch there`;
  /** `threadIds` live on run 42's worktree, beside its archived session. */
  const onStopped = (fake: Fake, threadIds: Array<string>) => {
    fake.sessions.set("session-42", { run: rid(42), stopped: true });
    const threadsOnPath = [...threadIds, "session-42"];
    fake.onBroken.push(
      ...threadIds.map((threadId) => ({ threadId, worktreePath: "/wt/t3-abc", threadsOnPath })),
    );
  };
  const worktreeLines = (lines: ReadonlyArray<string>) =>
    lines.filter((l) => l.includes("no longer a git checkout"));
  const worktreeItems = (fake: Fake) =>
    fake.items.filter((item) => item.id.startsWith("worktree:"));

  it.effect(
    "are archived once, with one line and one item per worktree naming the run and its issue",
    () =>
      Effect.gen(function* () {
        const fake = new Fake();
        onStopped(fake, ["child-1", "child-2"]);
        const { report, lines } = yield* pass(fake, [REPO], 5);
        assert.deepEqual(fake.archived, ["child-1", "child-2"]);
        assert.deepEqual(worktreeLines(lines), [lineFor(2)]);
        assert.deepEqual(
          worktreeItems(fake).map(({ id, kind, repo, issue, run, message }) => ({
            id,
            kind,
            repo,
            issue,
            run,
            message,
          })),
          [
            {
              id: "worktree:/wt/t3-abc",
              kind: "attention",
              repo: REPO,
              issue: 42,
              run: null,
              message: ITEM,
            },
          ],
        );
        assert.equal(report.attention, 1);
        assert.equal(report.errors, 0);

        fake.now += 60_000;
        const again = yield* pass(fake, [REPO], 5);
        assert.deepEqual(fake.archived, ["child-1", "child-2"]);
        assert.deepEqual(worktreeLines(again.lines), []);
        assert.equal(worktreeItems(fake).length, 1);
      }),
  );

  it.effect("the item clears when its issue is claimed again", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      onStopped(fake, ["child-1"]);
      yield* pass(fake, [REPO], 5);
      assert.equal(worktreeItems(fake).length, 1);
      fake.now += 60_000;
      fake.ready[REPO] = [42];
      fake.pushStart(`${REPO}#42`, started(42));
      yield* pass(fake, [REPO], 5);
      assert.deepEqual(starts(fake), [`start ${REPO}#42`]);
      assert.deepEqual(worktreeItems(fake), []);
    }),
  );

  it.effect("only threads on a stopped session's worktree are archived, once it stops", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      onStopped(fake, ["child-1"]);
      // The session of a run still going: its own stop archives what is on its worktree.
      fake.sessions.set("session-43", { run: rid(43), stopped: false });
      fake.onBroken.push({
        threadId: "session-43",
        worktreePath: "/wt/t3-b",
        threadsOnPath: ["session-43"],
      });
      // A person's thread.
      fake.onBroken.push({ threadId: "someone", worktreePath: "/wt/t3-c", threadsOnPath: [] });
      yield* pass(fake, [REPO], 5);
      assert.deepEqual(fake.archived, ["child-1"]);

      fake.sessions.set("session-43", { run: rid(43), stopped: true });
      fake.now += UNSETTLED_READ_EVERY_MS;
      yield* pass(fake, [REPO], 5);
      assert.deepEqual(fake.archived, ["child-1", "session-43"]);
      assert.deepEqual(
        worktreeItems(fake).map((item) => item.id),
        ["worktree:/wt/t3-abc", "worktree:/wt/t3-b"],
      );
    }),
  );

  it.effect("reads the ledger once for a thread that is not the factory's", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.onBroken.push({ threadId: "someone", worktreePath: "/wt/t3-c", threadsOnPath: [] });
      yield* pass(fake, [REPO], 5);
      fake.now += UNSETTLED_READ_EVERY_MS;
      yield* pass(fake, [REPO], 5);
      assert.equal(fake.sessionReads, 1);
      assert.deepEqual(fake.archived, []);
    }),
  );

  it.effect("rules no thread out while a run file cannot be read", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.onBroken.push({
        threadId: "child-1",
        worktreePath: "/wt/t3-abc",
        threadsOnPath: ["child-1", "session-42"],
      });
      fake.sessionsRead = false;
      yield* pass(fake, [REPO], 5);
      assert.deepEqual(fake.archived, []);

      fake.sessionsRead = true;
      fake.sessions.set("session-42", { run: rid(42), stopped: true });
      fake.now += UNSETTLED_READ_EVERY_MS;
      yield* pass(fake, [REPO], 5);
      assert.deepEqual(fake.archived, ["child-1"]);
    }),
  );

  it.effect("reads the ledger again for an unsettled thread only every five minutes", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.sessions.set("session-43", { run: rid(43), stopped: false });
      fake.onBroken.push({
        threadId: "session-43",
        worktreePath: "/wt/t3-b",
        threadsOnPath: ["session-43"],
      });
      const start = fake.now;
      yield* pass(fake, [REPO], 5);
      fake.now = start + UNSETTLED_READ_EVERY_MS - 1;
      yield* pass(fake, [REPO], 5);
      assert.equal(fake.sessionReads, 1);
      fake.now = start + UNSETTLED_READ_EVERY_MS;
      yield* pass(fake, [REPO], 5);
      assert.equal(fake.sessionReads, 2);
    }),
  );

  it.effect("reads the ledger at once when a new thread turns up beside an unsettled one", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.sessions.set("session-43", { run: rid(43), stopped: false });
      fake.onBroken.push({
        threadId: "session-43",
        worktreePath: "/wt/t3-b",
        threadsOnPath: ["session-43"],
      });
      yield* pass(fake, [REPO], 5);
      onStopped(fake, ["child-1"]);
      fake.now += 60_000;
      yield* pass(fake, [REPO], 5);
      assert.equal(fake.sessionReads, 2);
      assert.deepEqual(fake.archived, ["child-1"]);
    }),
  );

  it.effect("reads no ledger while no thread is on a broken worktree", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      yield* pass(fake, [REPO], 5);
      assert.equal(fake.sessionReads, 0);
    }),
  );

  it.effect("a thread T3 refuses to archive is an error line and is tried again", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      onStopped(fake, ["child-1", "child-2"]);
      fake.archiveRefused = ["child-2"];
      const { report, lines } = yield* pass(fake, [REPO], 5);
      assert.equal(report.errors, 1);
      assert.ok(lines.some((l) => l.startsWith("error: cannot archive thread child-2")));
      assert.deepEqual(worktreeLines(lines), [lineFor(1)]);
      assert.equal(worktreeItems(fake).length, 1);

      fake.archiveRefused = [];
      fake.now += 60_000;
      const again = yield* pass(fake, [REPO], 5);
      assert.deepEqual(fake.archived, ["child-1", "child-2"]);
      assert.deepEqual(worktreeLines(again.lines), [lineFor(1)]);
      assert.equal(worktreeItems(fake).length, 1);
    }),
  );

  it.effect("a worktree whose every archive fails raises nothing", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      onStopped(fake, ["child-1"]);
      fake.archiveRefused = ["child-1"];
      const { report, lines } = yield* pass(fake, [REPO], 5);
      assert.equal(report.errors, 1);
      assert.deepEqual(worktreeLines(lines), []);
      assert.deepEqual(worktreeItems(fake), []);
    }),
  );

  it.effect("a check that cannot read the threads is an error line, and the pass claims on", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.brokenFails = true;
      fake.ready[REPO] = [1];
      const { report, lines } = yield* pass(fake, [REPO], 5);
      assert.equal(report.errors, 1);
      assert.ok(lines.some((l) => l.startsWith("error: cannot check the sessions' worktrees: ")));
      assert.deepEqual(starts(fake), [`start ${REPO}#1`]);
    }),
  );

  it.effect("a ledger that cannot be read is an error line, and the next pass reads it again", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      onStopped(fake, ["child-1"]);
      fake.sessionsRead = "error";
      const { report, lines } = yield* pass(fake, [REPO], 5);
      assert.equal(report.errors, 1);
      assert.ok(lines.some((l) => l.startsWith("error: cannot check the sessions' worktrees: ")));
      fake.sessionsRead = true;
      fake.now += 60_000;
      yield* pass(fake, [REPO], 5);
      assert.deepEqual(fake.archived, ["child-1"]);
    }),
  );
});

describe("what the pass records", () => {
  it.effect("a pass records its start and the counts it prints", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(12, BUILDING);
      fake.runs.push({
        id: rid(13),
        state: null,
        unreadable: true,
        confirmed: false,
        session: false,
        prReported: false,
        base: null,
      });
      const { report, lines } = yield* pass(fake, [REPO], 1);
      assert.deepEqual(fake.events[0], { event: "pass_started", data: {} });
      assert.deepEqual(fake.events.at(-1), {
        event: "pass_finished",
        data: {
          runs: report.runs,
          claimed: report.claimed,
          errors: report.errors,
          attention: report.attention,
        },
      });
      assert.deepEqual([report.runs, report.errors, report.attention], [2, 1, 0]);
      assert.ok(lines.at(-1)!.startsWith("pass done:"), lines.join("\n"));
    }),
  );

  it.effect("the pass ends with a summary line", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(12, BUILDING);
      fake.ready[REPO] = [1];
      fake.pushStart(`${REPO}#1`, started(1));
      const { lines } = yield* pass(fake, [REPO], 5);
      assert.equal(lines.at(-1), "pass done: 1 runs, 1 claimed, 0 errors, 0 need attention");
    }),
  );

  it.effect("an issue held back by the limit is recorded with its repo and number", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(12, BUILDING);
      fake.ready[REPO] = [5, 6];
      yield* pass(fake, [REPO], 1);
      assert.deepEqual(
        fake.events.filter((e) => e.event === "claim_skipped"),
        [claimSkipped(5, "limit"), claimSkipped(6, "limit")],
      );
    }),
  );

  it.effect("an issue start refused as unapproved is recorded", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.ready[REPO] = [5];
      fake.pushStart(`${REPO}#5`, {
        kind: "refused",
        reason: "issue #5 was not approved: factory:ready was not applied by an instructor",
      });
      const { report, lines } = yield* pass(fake, [REPO], 1);
      assert.equal(report.claimed, 0);
      assert.deepEqual(
        fake.events.filter((e) => e.event === "claim_skipped"),
        [claimSkipped(5, "unapproved")],
      );
      assert.ok(
        lines.some((l) => l.includes("rawphp/softfac#5")),
        lines.join("\n"),
      );
    }),
  );

  it.effect("an issue start skipped for another reason is not recorded as a skipped claim", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.ready[REPO] = [5];
      yield* pass(fake, [REPO], 1);
      assert.ok(!fake.events.some((e) => e.event === "claim_skipped"));
    }),
  );

  it.effect("a machine log that cannot be written is an error line once and the pass goes on", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.machineLogFails = true;
      fake.runIn(12, BUILDING);
      fake.ready[REPO] = [5, 6];
      const { report, lines } = yield* pass(fake, [REPO], 1);
      assert.equal(
        lines.filter((l) => l.startsWith("error: machine log:")).length,
        1,
        lines.join("\n"),
      );
      assert.equal(report.errors, 1);
      assert.ok(lines.at(-1)!.startsWith("pass done:"));
    }),
  );

  it.effect(
    "a start that fails after it made a run records the error in that run, with the start step",
    () =>
      Effect.gen(function* () {
        const fake = new Fake();
        fake.ready[REPO] = [1];
        fake.startLeavesRun = [1];
        fake.pushStart(`${REPO}#1`, githubFailure());
        const { report } = yield* pass(fake, [REPO], 1);
        assert.equal(report.errors, 1);
        assert.deepEqual(
          fake.runErrors.map((e) => [runIdToString(e.run), e.step, e.kind]),
          [["rawphp__softfac__1__1", "start", "tracker"]],
        );
        assert.ok(fake.runErrors[0]!.message.includes("boom"));
        assert.deepEqual(errorEvents(fake), []);
      }),
  );

  it.effect(
    "a start that fails before it made a run records the error in the machine log as a start",
    () =>
      Effect.gen(function* () {
        const fake = new Fake();
        fake.ready[REPO] = [1];
        fake.pushStart(`${REPO}#1`, githubFailure());
        yield* pass(fake, [REPO], 1);
        assert.deepEqual(fake.runErrors, []);
        const [error] = errorEvents(fake);
        assert.ok(error !== undefined);
        assert.deepEqual(Object.keys(error.data), ["step", "kind", "message"]);
        assert.equal((error.data as { step: string }).step, "start");
      }),
  );

  it.effect("a start that fails before it made a run does not blame an older unfinished run", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(1, "triage");
      fake.triage[REPO] = [1];
      fake.ready[REPO] = [2];
      fake.pushStart(`${REPO}#2`, githubFailure());
      yield* pass(fake, [REPO], 5);
      assert.deepEqual(fake.runErrors, []);
      assert.equal(errorEvents(fake).length, 1);
      assert.equal((errorEvents(fake)[0]!.data as { run?: string }).run, undefined);
    }),
  );

  it.effect(
    "an error for a run whose ledger takes no line goes to the machine log with the run",
    () =>
      Effect.gen(function* () {
        const fake = new Fake();
        fake.ready[REPO] = [1];
        fake.startLeavesRun = [1];
        fake.runErrorFails = true;
        fake.pushStart(`${REPO}#1`, githubFailure());
        yield* pass(fake, [REPO], 1);
        const [error] = errorEvents(fake);
        assert.ok(error !== undefined);
        assert.equal((error.data as { run?: string }).run, "rawphp__softfac__1__1");
        assert.equal((error.data as { step: string }).step, "start");
      }),
  );

  it.effect("the error of a step that fails names its step, kind and message", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.ready[REPO] = [1];
      fake.pushStart(
        `${REPO}#1`,
        new LedgerIoError({ path: "/data/runs/x.jsonl", cause: new Error("disk full") }),
      );
      yield* pass(fake, [REPO], 1);
      const [error] = errorEvents(fake);
      assert.ok(error !== undefined);
      const data = error.data as { step: string; kind: string; message: string; run?: string };
      assert.equal(data.step, "start");
      assert.equal(data.kind, "ledger");
      assert.ok(data.message.includes("disk full"), data.message);
    }),
  );
});

describe("reading the ledger", () => {
  it.effect(
    "the ledger is listed whole once a pass, and an issue's runs again after its start",
    () =>
      Effect.gen(function* () {
        const fake = new Fake();
        fake.triage[REPO] = [7];
        fake.ready[REPO] = [1, 2, 3];
        fake.pushStart(`${REPO}#7`, started(7));
        fake.pushStart(`${REPO}#1`, started(1));
        fake.pushStart(`${REPO}#2`, started(2));
        fake.pushStart(`${REPO}#3`, started(3));
        yield* pass(fake, [REPO], 5);
        assert.deepEqual(
          fake.calls.filter((c) => c.startsWith("runs")),
          ["runs", `runs ${REPO}#7`, `runs ${REPO}#1`, `runs ${REPO}#2`, `runs ${REPO}#3`],
        );
      }),
  );

  it.effect("a claim read again counts against the limit", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.ready[REPO] = [1, 2];
      fake.pushStart(`${REPO}#1`, started(1));
      fake.pushStart(`${REPO}#2`, started(2));
      const { lines } = yield* pass(fake, [REPO], 1);
      assert.deepEqual(starts(fake), [`start ${REPO}#1`]);
      assert.ok(
        lines.includes("limit reached: 1 ready issue was not claimed, max_concurrent_runs is 1"),
        lines.join("\n"),
      );
    }),
  );

  it.effect("runs that cannot be read again after a start stop the claims, said once", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.triage[REPO] = [7, 8];
      fake.ready[REPO] = [1];
      const listed = fake.unfinishedRuns.bind(fake);
      fake.unfinishedRuns = (only) => {
        if (only !== undefined) fake.runsError = true;
        return listed(only);
      };
      const { report, lines } = yield* pass(fake, [REPO], 5);
      assert.deepEqual(starts(fake), [`resume ${REPO}#7`, `resume ${REPO}#8`]);
      assert.equal(
        lines.filter((l) => l.startsWith("error: cannot read the run ledger")).length,
        1,
        lines.join("\n"),
      );
      assert.equal(report.errors, 1);
    }),
  );
});

describe("text that is printed", () => {
  it.effect("a repo name from the config is escaped where it is printed", () =>
    Effect.gen(function* () {
      const evil = "rawphp/evil\u001b[31m";
      const fake = new Fake();
      fake.ready[evil] = "error";
      const { lines } = yield* pass(fake, [evil], 1);
      const line = runLine(lines, "error: rawphp/evil");
      assert.ok(!line.includes("\u001b"), JSON.stringify(line));
    }),
  );
});

/** The shapes the live world builds, kept in the test so a change to them is seen here. */
const _loaded: Loaded = { kind: "broken", name: REPO };
void _loaded;
void runIdToString;

describe("following a building run", () => {
  const stopped = (reason = "the reason") => ({ kind: "stopped" as const, reason });
  const callsOf = (fake: Fake) =>
    fake.calls.filter((c) => /^(time_limit|watch|forward|advance|start|resume|gate) /.test(c));

  it.effect("a triage run gets the time limit before resume", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(12, "triage");
      yield* pass(fake, [REPO], 3);
      assert.deepEqual(callsOf(fake), [`time_limit ${REPO}#12`, `resume ${REPO}#12`]);
    }),
  );

  it.effect("a triage run stopped at its limit is not resumed and its line says stuck", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(12, "triage");
      fake.timeLimits[`${REPO}#12`] = [stopped()];
      const { lines } = yield* pass(fake, [REPO], 3);
      assert.deepEqual(callsOf(fake), [`time_limit ${REPO}#12`]);
      assert.equal(
        runLine(lines, `${REPO}#12 `),
        `${REPO}#12 triage: stuck, the reason is in the ledger of run ${runIdToString(rid(12))}`,
      );
    }),
  );

  it.effect(
    "a building run whose pull request waits for the gate is watched and advanced before the gate",
    () =>
      Effect.gen(function* () {
        // `advance` puts a pull request a person took out of draft back to draft and judges the
        // session's latest run (it may have asked questions since), as softfac's pass does.
        const fake = new Fake();
        fake.runs.push({
          id: rid(40),
          state: BUILDING,
          unreadable: false,
          confirmed: true,
          session: true,
          prReported: true,
          base: null,
        });
        fake.advances[`${REPO}#40`] = [
          { kind: "ready-for-gate", pr: 3, prUrl: "https://github.com/rawphp/softfac/pull/3" },
        ];
        const { lines } = yield* pass(fake, [REPO], 3);
        assert.deepEqual(callsOf(fake), [
          `time_limit ${REPO}#40`,
          `watch ${REPO}#40`,
          `forward ${REPO}#40`,
          `advance ${REPO}#40`,
          `gate ${REPO}#40`,
        ]);
        assert.equal(
          runLine(lines, `${REPO}#40 `),
          `${REPO}#40 building: session finished, gate started in the background`,
        );
      }),
  );

  it.effect("a reported pull request whose session asked questions since gets no gate", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runs.push({
        id: rid(40),
        state: BUILDING,
        unreadable: false,
        confirmed: true,
        session: true,
        prReported: true,
        base: null,
      });
      fake.advances[`${REPO}#40`] = [{ kind: "needs-info" }];
      yield* pass(fake, [REPO], 3);
      assert.deepEqual(callsOf(fake), [
        `time_limit ${REPO}#40`,
        `watch ${REPO}#40`,
        `forward ${REPO}#40`,
        `advance ${REPO}#40`,
      ]);
    }),
  );

  it.effect("a building run whose gate would pass the gate limit says it is queued", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runs.push({
        id: rid(40),
        state: BUILDING,
        unreadable: false,
        confirmed: true,
        session: true,
        prReported: true,
        base: null,
      });
      fake.advances[`${REPO}#40`] = [
        { kind: "ready-for-gate", pr: 3, prUrl: "https://github.com/rawphp/softfac/pull/3" },
      ];
      fake.gateStarts[`${REPO}#40`] = { kind: "queued", running: 2, max: 2 };
      const { lines } = yield* pass(fake, [REPO], 3);
      assert.equal(
        runLine(lines, `${REPO}#40 `),
        `${REPO}#40 building: session finished, gate queued: 2 gates running, max_concurrent_gates is 2`,
      );
    }),
  );

  it.effect("a building run whose gate is held by the load says so, not the gate limit", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(40, BUILDING, REPO, true);
      fake.advances[`${REPO}#40`] = [
        { kind: "ready-for-gate", pr: 3, prUrl: "https://github.com/rawphp/softfac/pull/3" },
      ];
      fake.gateStarts[`${REPO}#40`] = { kind: "high-load", oneMinute: 55.2, limit: 12 };
      const { lines } = yield* pass(fake, [REPO], 3);
      assert.equal(
        runLine(lines, `${REPO}#40 `),
        `${REPO}#40 building: session finished, gate queued: 1-minute load 55.2 is above 12 and a gate is already running`,
      );
    }),
  );

  it.effect("a session that reports its pull request has its gate started in the same pass", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(40, BUILDING, REPO, true);
      fake.advances[`${REPO}#40`] = [
        { kind: "ready-for-gate", pr: 3, prUrl: "https://github.com/rawphp/softfac/pull/3" },
      ];
      const { lines } = yield* pass(fake, [REPO], 3);
      assert.deepEqual(callsOf(fake), [
        `time_limit ${REPO}#40`,
        `watch ${REPO}#40`,
        `forward ${REPO}#40`,
        `advance ${REPO}#40`,
        `gate ${REPO}#40`,
      ]);
      assert.equal(
        runLine(lines, `${REPO}#40 `),
        `${REPO}#40 building: session finished, gate started in the background`,
      );
    }),
  );

  it.effect("a building run stopped by the time limit gets no watch or advance", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(40, BUILDING, REPO, true);
      fake.timeLimits[`${REPO}#40`] = [stopped()];
      const { lines } = yield* pass(fake, [REPO], 3);
      assert.deepEqual(callsOf(fake), [`time_limit ${REPO}#40`]);
      assert.include(runLine(lines, `${REPO}#40 `), "stuck, the reason is in the ledger of run");
    }),
  );

  it.effect("a building run stopped by watch gets no advance", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(40, BUILDING, REPO, true);
      fake.watches[`${REPO}#40`] = [stopped()];
      const { lines } = yield* pass(fake, [REPO], 3);
      assert.deepEqual(callsOf(fake), [`time_limit ${REPO}#40`, `watch ${REPO}#40`]);
      assert.include(runLine(lines, `${REPO}#40 `), "stuck, the reason is in the ledger of run");
    }),
  );

  const sent = (comments: number, bodyEdit: boolean): ForwardOutcome => ({
    comments,
    bodyEdit,
    skipped: null,
  });
  const forwardLine = (fake: Fake) =>
    Effect.gen(function* () {
      const { lines } = yield* pass(fake, [REPO], 3);
      return runLine(lines, `${REPO}#40 `);
    });
  const building = () => {
    const fake = new Fake();
    fake.runIn(40, BUILDING, REPO, true);
    return fake;
  };

  it.effect("a forward that sent something says so before the session's own line", () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<readonly [ForwardOutcome, string]> = [
        [sent(1, false), "forwarded 1 comment"],
        [sent(2, false), "forwarded 2 comments"],
        [sent(0, true), "forwarded the edited issue body"],
        [sent(3, true), "forwarded 3 comments, forwarded the edited issue body"],
      ];
      for (const [outcome, words] of cases) {
        const fake = building();
        fake.forwards[`${REPO}#40`] = [outcome];
        assert.equal(
          yield* forwardLine(fake),
          `${REPO}#40 building: ${words}, session still running`,
        );
        assert.deepEqual(callsOf(fake), [
          `time_limit ${REPO}#40`,
          `watch ${REPO}#40`,
          `forward ${REPO}#40`,
          `advance ${REPO}#40`,
        ]);
      }
    }),
  );

  it.effect("a forward that skipped the run or sent nothing says nothing", () =>
    Effect.gen(function* () {
      for (const outcome of [
        sent(0, false),
        { comments: 0, bodyEdit: false, skipped: "not-building" },
        { comments: 0, bodyEdit: false, skipped: "gate-send-pending" },
        { comments: 0, bodyEdit: false, skipped: "no-thread" },
        { comments: 0, bodyEdit: false, skipped: "pr-merged" },
      ] satisfies ReadonlyArray<ForwardOutcome>) {
        const fake = building();
        fake.forwards[`${REPO}#40`] = [outcome];
        assert.equal(yield* forwardLine(fake), `${REPO}#40 building: session still running`);
      }
    }),
  );

  it.effect("the gate waits for the next pass when a comment was sent", () =>
    Effect.gen(function* () {
      for (const outcome of [sent(1, false), sent(0, true)]) {
        const fake = building();
        fake.forwards[`${REPO}#40`] = [outcome];
        fake.advances[`${REPO}#40`] = [
          { kind: "ready-for-gate", pr: 3, prUrl: "https://github.com/rawphp/softfac/pull/3" },
        ];
        const line = yield* forwardLine(fake);
        assert.ok(
          line.endsWith(
            "session finished, the gate waits for the next pass because a comment was sent",
          ),
          line,
        );
        assert.deepEqual(callsOf(fake), [
          `time_limit ${REPO}#40`,
          `watch ${REPO}#40`,
          `forward ${REPO}#40`,
          `advance ${REPO}#40`,
        ]);
      }
    }),
  );

  it.effect("a pending gate send starts the gate while the session still runs or is paused", () =>
    Effect.gen(function* () {
      for (const kind of ["running", "reminded", "paused"] as const) {
        for (const pending of [true, false]) {
          const fake = building();
          if (pending) fake.pendingSends = [runIdToString(fake.runs[0]!.id)];
          fake.advances[`${REPO}#40`] = [{ kind }];
          yield* pass(fake, [REPO], 3);
          assert.equal(
            callsOf(fake).includes(`gate ${REPO}#40`),
            pending,
            `${kind} pending=${pending}`,
          );
        }
      }
    }),
  );

  it.effect("a pending gate send wins over the gate waiting for a sent comment", () =>
    Effect.gen(function* () {
      const fake = building();
      fake.pendingSends = [runIdToString(fake.runs[0]!.id)];
      fake.forwards[`${REPO}#40`] = [sent(1, false)];
      fake.advances[`${REPO}#40`] = [
        { kind: "ready-for-gate", pr: 3, prUrl: "https://github.com/rawphp/softfac/pull/3" },
      ];
      const line = yield* forwardLine(fake);
      assert.ok(!line.includes("the gate waits"), line);
      assert.ok(callsOf(fake).includes(`gate ${REPO}#40`));
    }),
  );

  it.effect("a run that ended or needs a person never starts the gate for a pending send", () =>
    Effect.gen(function* () {
      for (const outcome of [{ kind: "stuck", reason: "x" }, { kind: "needs-info" }] as const) {
        const kind = outcome.kind;
        const fake = building();
        fake.pendingSends = [runIdToString(fake.runs[0]!.id)];
        fake.advances[`${REPO}#40`] = [outcome];
        yield* pass(fake, [REPO], 3);
        assert.ok(!callsOf(fake).includes(`gate ${REPO}#40`), kind);
      }
    }),
  );

  it.effect(
    "a ledger that cannot be read for a pending gate send starts no gate and is recorded",
    () =>
      Effect.gen(function* () {
        const fake = building();
        fake.pendingSendFails = true;
        fake.advances[`${REPO}#40`] = [{ kind: "running" }];
        const { report } = yield* pass(fake, [REPO], 3);
        assert.equal(report.errors, 1);
        assert.ok(!callsOf(fake).includes(`gate ${REPO}#40`));
      }),
  );

  it.effect(
    "a finished session whose ledger cannot be read for a pending gate send is not gated this pass",
    () =>
      Effect.gen(function* () {
        // As softfac's `advance_and_gate`: the read comes before the gate, and its failure ends the
        // run's turn in the pass, so the next pass gates it.
        const fake = building();
        fake.pendingSendFails = true;
        fake.advances[`${REPO}#40`] = [
          { kind: "ready-for-gate", pr: 3, prUrl: "https://github.com/rawphp/softfac/pull/3" },
        ];
        const { report, lines } = yield* pass(fake, [REPO], 3);
        assert.equal(report.errors, 1);
        assert.deepEqual(callsOf(fake), [
          `time_limit ${REPO}#40`,
          `watch ${REPO}#40`,
          `forward ${REPO}#40`,
          `advance ${REPO}#40`,
        ]);
        assert.deepEqual(
          fake.runErrors.map((e) => `${e.step} ${e.kind}`),
          ["pass ledger"],
        );
        assert.ok(
          lines.some((line) => line.includes("gate send check")),
          lines.join("\n"),
        );
      }),
  );

  it.effect("a run whose issue a person closed is over after the forward", () =>
    Effect.gen(function* () {
      const fake = building();
      fake.forwards[`${REPO}#40`] = [{ comments: 0, bodyEdit: false, skipped: "abandoned" }];
      const { report, lines } = yield* pass(fake, [REPO], 3);
      assert.equal(
        runLine(lines, `${REPO}#40 `),
        `${REPO}#40 building: the issue is closed, the run is closed`,
      );
      assert.deepEqual(callsOf(fake), [
        `time_limit ${REPO}#40`,
        `watch ${REPO}#40`,
        `forward ${REPO}#40`,
      ]);
      assert.equal(report.attention, 1);
    }),
  );

  it.effect("a failing forward is recorded with step forward, and counts as having sent", () =>
    Effect.gen(function* () {
      const fake = building();
      fake.forwards[`${REPO}#40`] = [
        new SessionsError({ operation: "send", cause: new Error("x") }),
      ];
      fake.advances[`${REPO}#40`] = [
        { kind: "ready-for-gate", pr: 3, prUrl: "https://github.com/rawphp/softfac/pull/3" },
      ];
      const { report, lines } = yield* pass(fake, [REPO], 3);
      assert.equal(report.errors, 1);
      assert.equal(fake.runErrors.length, 1);
      assert.equal(fake.runErrors[0]?.step, "forward");
      assert.equal(fake.runErrors[0]?.kind, "t3");
      // The message may have gone in before the failure, so the gate is not started this pass.
      assert.deepEqual(callsOf(fake), [
        `time_limit ${REPO}#40`,
        `watch ${REPO}#40`,
        `forward ${REPO}#40`,
        `advance ${REPO}#40`,
      ]);
      assert.ok(
        lines.some((l) => l.includes("the gate waits for the next pass")),
        lines.join("\n"),
      );
    }),
  );

  it.effect("a forward that cannot write the ledger leaves the run alone for the pass", () =>
    Effect.gen(function* () {
      const fake = yield* failing(
        "forwards",
        new LedgerIoError({ path: "/data/runs/x.jsonl", cause: new Error("disk") }),
        "forward",
        "ledger",
      );
      assert.deepEqual(callsOf(fake), [
        `time_limit ${REPO}#40`,
        `watch ${REPO}#40`,
        `forward ${REPO}#40`,
      ]);
    }),
  );

  const advanceLines: ReadonlyArray<readonly [AdvanceOutcome, string]> = [
    [{ kind: "running" }, "session still running"],
    [{ kind: "reminded" }, "session ended without a result line, sent it a reminder"],
    [
      { kind: "paused" },
      "session stopped by hand, waiting for an instructor's comment on the pull request or the issue",
    ],
    [
      { kind: "ready-for-gate", pr: 3, prUrl: "https://github.com/rawphp/softfac/pull/3" },
      "session finished, gate started in the background",
    ],
    [{ kind: "passed", pr: 3 }, "the gate passed and the pull request is ready for review"],
    [
      { kind: "needs-info" },
      "session asked questions, the issue is now needs-info and the run is finished",
    ],
    [
      { kind: "stuck", reason: "r" },
      `stuck, the reason is in the ledger of run ${runIdToString(rid(40))}`,
    ],
    [{ kind: "ended" }, "its pull request was merged or closed, the run is finished"],
    [{ kind: "abandoned" }, "the issue is closed, the run is closed"],
  ];

  it.effect("each advance outcome has its line", () =>
    Effect.gen(function* () {
      for (const [outcome, words] of advanceLines) {
        const fake = new Fake();
        fake.runIn(40, BUILDING, REPO, true);
        fake.advances[`${REPO}#40`] = [outcome];
        const { lines } = yield* pass(fake, [REPO], 3);
        assert.equal(runLine(lines, `${REPO}#40 `), `${REPO}#40 building: ${words}`);
      }
    }),
  );

  const failing = (
    script: "advances" | "watches" | "timeLimits" | "forwards",
    error: BuildingError,
    step: string,
    kind: ErrorKind,
  ) =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(40, BUILDING, REPO, true);
      fake[script][`${REPO}#40`] = [error];
      const { report, lines } = yield* pass(fake, [REPO], 3);
      assert.equal(report.errors, 1);
      assert.ok(
        lines.some((l) => l.startsWith("error: ")),
        lines.join("\n"),
      );
      assert.equal(fake.runErrors.length, 1);
      assert.equal(fake.runErrors[0]?.step, step);
      assert.equal(fake.runErrors[0]?.kind, kind);
      return fake;
    });

  it.effect("a failing advance is an error line on the run, its kind by the error", () =>
    Effect.gen(function* () {
      yield* failing(
        "advances",
        new NotBuildingError({ run: { repo: REPO, issue: "40", attempt: 1 } }),
        "advance",
        "ledger",
      );
      yield* failing(
        "advances",
        new SessionsError({ operation: "status", cause: new Error("x") }),
        "advance",
        "t3",
      );
      yield* failing(
        "advances",
        new GitHubFailed({ args: ["pr", "view"], status: 1, stderr: "boom" }),
        "advance",
        "tracker",
      );
    }),
  );

  it.effect("a failing watch is recorded with step watch", () =>
    Effect.gen(function* () {
      const fake = yield* failing(
        "watches",
        new GitHubFailed({ args: ["issue", "view"], status: 1, stderr: "boom" }),
        "watch",
        "tracker",
      );
      assert.ok(!fake.calls.some((c) => c.startsWith("advance ")));
    }),
  );

  it.effect(
    "a failing time limit is recorded with step pass and the run is left for the pass",
    () =>
      Effect.gen(function* () {
        const fake = yield* failing(
          "timeLimits",
          new SessionsError({ operation: "status", cause: new Error("x") }),
          "pass",
          "t3",
        );
        assert.deepEqual(callsOf(fake), [`time_limit ${REPO}#40`]);
      }),
  );

  it.effect("a building run that goes stuck in the pass frees its slot for a claim", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(40, BUILDING, REPO, true);
      fake.advances[`${REPO}#40`] = [{ kind: "stuck", reason: "r" }];
      fake.ready[REPO] = [7];
      fake.pushStart(`${REPO}#7`, started(7));
      const { report } = yield* pass(fake, [REPO], 1);
      assert.deepEqual(starts(fake), [`start ${REPO}#7`]);
      assert.equal(report.claimed, 1);
    }),
  );

  it.effect("a needs-info run is advanced, with no watch and no resume", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(42, "needs-info", REPO, true);
      fake.advances[`${REPO}#42`] = [{ kind: "needs-info" }];
      const { lines } = yield* pass(fake, [REPO], 5);
      assert.deepEqual(callsOf(fake), [`time_limit ${REPO}#42`, `advance ${REPO}#42`]);
      assert.equal(
        runLine(lines, `${REPO}#42 `),
        `${REPO}#42 needs-info: session asked questions, the issue is now needs-info and the run is finished`,
      );
    }),
  );

  it.effect("a stuck run is advanced, with no watch and no resume", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(43, "stuck", REPO, true);
      fake.advances[`${REPO}#43`] = [{ kind: "stuck", reason: "r" }];
      const { lines } = yield* pass(fake, [REPO], 5);
      assert.deepEqual(callsOf(fake), [`time_limit ${REPO}#43`, `advance ${REPO}#43`]);
      assert.equal(
        runLine(lines, `${REPO}#43 `),
        `${REPO}#43 stuck: stuck, the reason is in the ledger of run ${runIdToString(rid(43))}`,
      );
    }),
  );

  it.effect("a failing advance of a needs-info run is recorded with step advance", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(42, "needs-info", REPO, true);
      fake.advances[`${REPO}#42`] = [
        new SessionsError({ operation: "archive", cause: new Error("x") }),
      ];
      const { report } = yield* pass(fake, [REPO], 5);
      assert.equal(report.errors, 1);
      assert.equal(fake.runErrors[0]?.step, "advance");
    }),
  );

  it.effect("an abandoned run says so, raises an attention line and is recorded", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(40, BUILDING, REPO, true);
      fake.advances[`${REPO}#40`] = [{ kind: "abandoned" }];
      const { report, lines } = yield* pass(fake, [REPO], 3);
      assert.equal(
        runLine(lines, `${REPO}#40 `),
        `${REPO}#40 building: the issue is closed, the run is closed`,
      );
      assert.equal(
        runLine(lines, "ATTENTION: "),
        `ATTENTION: ${REPO}#40 Abandoned: the issue was closed, so the factory stopped the session and closed the run`,
      );
      assert.equal(report.attention, 1);
      assert.deepEqual(
        fake.events.filter((e) => e.event === "attention"),
        [{ event: "attention", data: { run: runIdToString(rid(40)), reason: "abandoned" } }],
      );
    }),
  );

  it.effect("a triage run that start abandons says so, and where a session may be", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(12, "triage");
      fake.pushStart(`${REPO}#12`, { kind: "abandoned", mayHaveSession: [rid(12)] });
      const { report, lines } = yield* pass(fake, [REPO], 3);
      const run = runIdToString(rid(12));
      assert.equal(
        runLine(lines, `${REPO}#12 `),
        `${REPO}#12 triage: the issue is closed, the run is closed`,
      );
      assert.deepEqual(
        lines.filter((l) => l.startsWith("ATTENTION: ")),
        [
          `ATTENTION: ${REPO}#12 Abandoned: the issue was closed, so the factory stopped the session and closed the run`,
          `ATTENTION: ${REPO}#12 the issue was closed, and a session may exist for ${run}: look for launch command id softfac:${run}:launch in T3 Code and archive that thread by hand`,
        ],
      );
      assert.equal(report.attention, 2);
      assert.deepEqual(
        fake.events.filter((e) => e.event === "attention"),
        [
          { event: "attention", data: { run, reason: "abandoned" } },
          { event: "attention", data: { run, reason: "session-may-exist" } },
        ],
      );
    }),
  );

  it.effect("a triage run that start abandons with no session to look for needs one line", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(12, "triage");
      fake.pushStart(`${REPO}#12`, { kind: "abandoned", mayHaveSession: [] });
      const { report } = yield* pass(fake, [REPO], 3);
      assert.equal(report.attention, 1);
    }),
  );

  it.effect(
    "a claim whose start or resume abandons an earlier run says so and claims nothing",
    () =>
      Effect.gen(function* () {
        for (const [listing, call] of [
          ["ready", "start"],
          ["triage", "resume"],
        ] as const) {
          // The earlier run is not confirmed, so the run step leaves it to the claim.
          const fake = new Fake();
          fake.runs.push({
            id: rid(12),
            state: "triage",
            unreadable: false,
            confirmed: false,
            session: false,
            prReported: false,
            base: null,
          });
          fake[listing][REPO] = [12];
          fake.pushStart(`${REPO}#12`, { kind: "abandoned", mayHaveSession: [rid(12)] });
          const { report, lines } = yield* pass(fake, [REPO], 3);
          const run = runIdToString(rid(12));
          assert.deepEqual(starts(fake), [`${call} ${REPO}#12`], listing);
          assert.equal(
            runLine(lines, `${REPO}#12 `),
            `${REPO}#12 ${listing}: the issue is closed, the run is closed`,
          );
          assert.deepEqual(
            lines.filter((l) => l.startsWith("ATTENTION: ")),
            [
              `ATTENTION: ${REPO}#12 Abandoned: the issue was closed, so the factory stopped the session and closed the run`,
              `ATTENTION: ${REPO}#12 the issue was closed, and a session may exist for ${run}: look for launch command id softfac:${run}:launch in T3 Code and archive that thread by hand`,
            ],
            listing,
          );
          assert.deepEqual([report.attention, report.claimed], [2, 0], listing);
          assert.deepEqual(
            fake.items.map((item) => item.id),
            [`attention:${run}:abandoned`, `attention:${run}:session-may-exist`],
            listing,
          );
          assert.deepEqual(
            fake.events.filter((e) => e.event === "attention"),
            [
              { event: "attention", data: { run, reason: "abandoned" } },
              { event: "attention", data: { run, reason: "session-may-exist" } },
            ],
            listing,
          );
        }
      }),
  );

  it.effect("an abandon cut short by an error still says the session that may exist", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(12, "triage");
      fake.pushStart(`${REPO}#12`, {
        kind: "abandoned",
        mayHaveSession: [rid(12)],
        error: githubFailure(),
      });
      const { report, lines } = yield* pass(fake, [REPO], 3);
      const older = runIdToString(rid(12));
      assert.ok(
        lines.some((l) => l.includes(`a session may exist for ${older}`)),
        lines.join("\n"),
      );
      assert.equal(report.attention, 2);
      assert.equal(report.errors, 1);
      assert.ok(
        lines.some((l) => l.startsWith(`error: ${REPO}#12 start:`)),
        lines.join("\n"),
      );
    }),
  );

  it.effect("a stop request is taken for every confirmed run, before the time limit", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(40, BUILDING, REPO, true);
      fake.stopRequests[`${REPO}#40`] = "recorded";
      const { lines } = yield* pass(fake, [REPO], 3);
      assert.deepEqual(
        fake.calls.filter((c) => /^(stop_request|time_limit|watch|advance) /.test(c)),
        [
          `stop_request ${REPO}#40`,
          `time_limit ${REPO}#40`,
          `watch ${REPO}#40`,
          `advance ${REPO}#40`,
        ],
      );
      assert.equal(
        runLine(lines, `${REPO}#40 `),
        `${REPO}#40 building: stop requested by hand, session still running`,
      );
    }),
  );

  it.effect("a stop request found already recorded, finished or absent adds nothing", () =>
    Effect.gen(function* () {
      for (const answer of ["already-requested", "finished", "none"] as const) {
        const fake = new Fake();
        fake.runIn(40, BUILDING, REPO, true);
        fake.stopRequests[`${REPO}#40`] = answer;
        const { lines } = yield* pass(fake, [REPO], 3);
        assert.equal(
          runLine(lines, `${REPO}#40 `),
          `${REPO}#40 building: session still running`,
          answer,
        );
      }
    }),
  );

  it.effect("a stop request is not taken for a run whose gate is running", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(40, BUILDING, REPO, true);
      fake.gateLocks = [runIdToString(rid(40))];
      fake.stopRequests[`${REPO}#40`] = "recorded";
      const { lines } = yield* pass(fake, [REPO], 3);
      assert.ok(!fake.calls.includes(`stop_request ${REPO}#40`), fake.calls.join("\n"));
      assert.equal(runLine(lines, `${REPO}#40 `), `${REPO}#40 building: gate running`);
    }),
  );

  it.effect("a stop request for a run that is not building is dropped, and the pass says so", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(40, BUILDING, REPO, true);
      fake.stopRequests[`${REPO}#40`] = "not-building";
      const { lines } = yield* pass(fake, [REPO], 3);
      assert.equal(
        runLine(lines, `${REPO}#40 `),
        `${REPO}#40 building: stop request dropped: the run is not building, session still running`,
      );
    }),
  );

  it.effect(
    "a stop request that cannot be taken is an error line and the run is still worked",
    () =>
      Effect.gen(function* () {
        const fake = new Fake();
        fake.runIn(40, BUILDING, REPO, true);
        fake.stopRequests[`${REPO}#40`] = new LedgerIoError({
          path: "/data/stop-requests/x",
          cause: new Error("denied"),
        });
        const { report, lines } = yield* pass(fake, [REPO], 3);
        assert.equal(report.errors, 1);
        assert.ok(
          lines.some((l) => l.startsWith(`error: ${REPO}#40 stop request: `)),
          lines.join("\n"),
        );
        assert.equal(fake.runErrors[0]?.step, "pass");
        assert.equal(fake.runErrors[0]?.kind, "ledger");
        assert.ok(fake.calls.includes(`advance ${REPO}#40`));
      }),
  );

  it.effect("a needs-info run that its advance finishes frees its slot for a claim", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(42, "needs-info", REPO, true);
      fake.advances[`${REPO}#42`] = [{ kind: "needs-info" }];
      fake.ready[REPO] = [7];
      fake.pushStart(`${REPO}#7`, started(7));
      const { report } = yield* pass(fake, [REPO], 1);
      assert.deepEqual(starts(fake), [`start ${REPO}#7`]);
      assert.equal(report.claimed, 1);
    }),
  );

  it.effect("a building run whose gate is running is not worked", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(40, BUILDING, REPO, true);
      fake.gateLocks = [runIdToString(rid(40))];
      const { lines } = yield* pass(fake, [REPO], 3);
      assert.deepEqual(callsOf(fake), []);
      assert.equal(runLine(lines, `${REPO}#40 `), `${REPO}#40 building: gate running`);
    }),
  );

  it.effect("a building run of a repo that is not loaded is left alone", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(40, BUILDING, "acme/other", true);
      yield* pass(fake, [REPO], 3);
      assert.deepEqual(callsOf(fake), []);
    }),
  );
});

describe("attention items", () => {
  const open = (overrides: Partial<AttentionItem>): AttentionItem => ({
    id: "seed",
    kind: "attention",
    repo: REPO,
    issue: 12,
    run: null,
    message: "seeded",
    firstSeenMs: T0,
    ...overrides,
  });
  const ids = (fake: Fake) => fake.items.map((item) => item.id);
  const RUN_40 = runIdToString(rid(40));

  it.effect("a run that goes stuck raises a stuck item", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(40, BUILDING, REPO, true);
      fake.advances[`${REPO}#40`] = [{ kind: "stuck", reason: "r" }];
      yield* pass(fake, [REPO], 1);
      assert.deepEqual(
        fake.items.map(({ firstSeenMs: _, ...item }) => item),
        [
          {
            id: `run:${RUN_40}:stuck`,
            kind: "stuck",
            repo: REPO,
            issue: 40,
            run: RUN_40,
            message: `${REPO}#40 stuck, the reason is in the ledger of run ${RUN_40}`,
          },
        ],
      );
    }),
  );

  it.effect("a run that needs info raises a needs-info item", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(42, "needs-info", REPO, true);
      fake.advances[`${REPO}#42`] = [{ kind: "needs-info" }];
      yield* pass(fake, [REPO], 5);
      const run = runIdToString(rid(42));
      assert.deepEqual(
        fake.items.map(({ firstSeenMs: _, ...item }) => item),
        [
          {
            id: `run:${run}:needs-info`,
            kind: "needs-info",
            repo: REPO,
            issue: 42,
            run,
            message: `${REPO}#42 needs-info, the session asked questions on the issue`,
          },
        ],
      );
    }),
  );

  it.effect("an ATTENTION line raises an attention item with the line's text", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(12, "triage", REPO, true);
      fake.ready[REPO] = [12];
      fake.pushStart(`${REPO}#12`, { kind: "skipped", reason: "ready again", moved: "ready" });
      const { lines } = yield* pass(fake, [REPO], 1);
      const line = runLine(lines, "ATTENTION: ");
      const run = runIdToString(rid(12));
      assert.deepEqual(
        fake.items.map(({ firstSeenMs: _, ...item }) => item),
        [
          {
            id: `attention:${run}:not-progressing`,
            kind: "attention",
            repo: REPO,
            issue: 12,
            run,
            message: line.slice("ATTENTION: ".length),
          },
        ],
      );
    }),
  );

  it.effect(
    "a claim whose launch fails clears the issue's earlier items and keeps the new one",
    () =>
      Effect.gen(function* () {
        const fake = new Fake();
        const oldRun = runIdToString(newRunId(REPO, "12", 1));
        const newRun = newRunId(REPO, "12", 2);
        fake.items = [
          open({ id: `run:${oldRun}:stuck`, kind: "stuck", issue: 12, run: oldRun }),
          open({ id: "other", kind: "needs-info", issue: 13 }),
        ];
        fake.ready[REPO] = [12];
        fake.pushStart(`${REPO}#12`, { kind: "stuck", run: newRun, reason: "launch failed" });
        yield* pass(fake, [REPO], 1);
        assert.deepEqual(ids(fake), ["other", `run:${runIdToString(newRun)}:stuck`]);
      }),
  );

  it.effect("claiming an issue again clears every item of that issue and no other", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.items = [
        open({ id: "a", kind: "attention", run: "r" }),
        open({ id: "b", kind: "stuck" }),
        open({ id: "c", kind: "needs-info" }),
        open({ id: "d", kind: "config" }),
        open({ id: "e", kind: "pass-errors" }),
        open({ id: "other", issue: 13 }),
        open({ id: "elsewhere", repo: OTHER }),
      ];
      fake.ready[REPO] = [12];
      fake.pushStart(`${REPO}#12`, started(12));
      yield* pass(fake, [REPO, OTHER], 5);
      assert.deepEqual(ids(fake), ["other", "elsewhere"]);
    }),
  );

  it.effect(
    "an item of a repo whose T3 project was deleted is cleared at the pass start, a machine item stays",
    () =>
      Effect.gen(function* () {
        const fake = new Fake();
        fake.departed = ["rawphp/gone"];
        fake.items = [
          open({ id: "gone", repo: "rawphp/gone" }),
          open({ id: "kept", repo: REPO, issue: 99 }),
          open({ id: "machine", kind: "config", repo: null, issue: null }),
        ];
        yield* pass(fake, [REPO], 5);
        assert.deepEqual(ids(fake), ["kept", "machine"]);
      }),
  );

  it.effect(
    "an item of a repo that is not watched but has not departed is kept: only a deleted project clears",
    () =>
      Effect.gen(function* () {
        const fake = new Fake();
        fake.departed = ["RawPHP/Gone"];
        fake.items = [
          open({ id: "gone", kind: "stuck", repo: "rawphp/gone" }),
          open({ id: "paused", kind: "stuck", repo: "rawphp/paused" }),
          open({ id: "kept", repo: REPO, issue: 99 }),
        ];
        yield* pass(fake, [REPO], 5);
        assert.deepEqual(ids(fake), ["paused", "kept"]);
        // The paused repo is not worked, only kept.
        assert.deepEqual(fake.projected, [REPO]);
      }),
  );

  it.effect(
    "a project the reader could not settle is one plain line, and a departed repo is still cleared",
    () =>
      Effect.gen(function* () {
        const fake = new Fake();
        fake.unresolved = ["/p/a", "/p/b"];
        fake.departed = ["rawphp/gone"];
        fake.items = [
          open({ id: "gone", kind: "stuck", repo: "rawphp/gone" }),
          open({ id: "paused", kind: "stuck", repo: "rawphp/paused" }),
          open({ id: "machine", kind: "config", repo: null, issue: null }),
        ];
        const { report, lines } = yield* pass(fake, [REPO], 5);
        assert.deepEqual(ids(fake), ["paused", "machine"]);
        assert.deepEqual(
          lines.filter((l) => l.startsWith("watched:")),
          ["watched: 2 project(s) could not be settled this pass (/p/a, /p/b)"],
        );
        // A line, not an error: the pass reports none and the machine log has no event for it.
        assert.equal(report.errors, 0);
        assert.deepEqual(errorEvents(fake), []);
        // The repos that were listed are still worked.
        assert.deepEqual(fake.projected, [REPO]);
      }),
  );

  it.effect("a reader that fails is one error line: no repo is worked, no item is cleared", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.watchedFails = true;
      fake.ready[REPO] = [1];
      fake.items = [open({ id: "gone", repo: "rawphp/gone" })];
      const { lines } = yield* pass(fake, [REPO], 5);
      assert.deepEqual(ids(fake), ["gone"]);
      assert.deepEqual(starts(fake), []);
      assert.notInclude(fake.calls, "project");
      assert.deepEqual(
        errorEvents(fake).map((e) => (e.data as { kind: ErrorKind; message: string }).message),
        ["cannot list the T3 projects: project store down"],
      );
      assert.strictEqual(
        lines.filter((l) => l.includes("cannot list the T3 projects: project store down")).length,
        1,
      );
    }),
  );

  it.effect("the watched list is read at the start of every pass", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      yield* pass(fake, [REPO], 5);
      assert.deepEqual(fake.projected, [REPO]);
      // A project added in T3 between the passes is worked on the next one, with no restart.
      yield* pass(fake, [REPO, OTHER], 5);
      assert.deepEqual(fake.projected, [REPO, REPO, OTHER]);
      assert.strictEqual(fake.calls.filter((c) => c === "watched").length, 2);
      assert.strictEqual(fake.calls.indexOf("watched") < fake.calls.indexOf("project"), true);
    }),
  );

  it.effect(
    "an attention item of a run the ledger no longer lists is cleared at the pass end, a stuck item stays",
    () =>
      Effect.gen(function* () {
        const fake = new Fake();
        fake.runIn(40, BUILDING, REPO, true);
        fake.items = [
          open({ id: "live", kind: "attention", issue: 40, run: RUN_40 }),
          open({ id: "finished", kind: "attention", issue: 41, run: runIdToString(rid(41)) }),
          open({ id: "stuck", kind: "stuck", issue: 41, run: runIdToString(rid(41)) }),
          open({ id: "needs-info", kind: "needs-info", issue: 41, run: runIdToString(rid(41)) }),
        ];
        yield* pass(fake, [REPO], 5);
        assert.deepEqual(ids(fake), ["live", "stuck", "needs-info"]);
      }),
  );

  it.effect(
    "a stuck item whose issue is closed is cleared at the pass end, an open one stays",
    () =>
      Effect.gen(function* () {
        const fake = new Fake();
        fake.closedIssues[`${REPO}#41`] = true;
        fake.items = [
          open({ id: "closed", kind: "stuck", issue: 41, run: runIdToString(rid(41)) }),
          open({ id: "open", kind: "stuck", issue: 42, run: runIdToString(rid(42)) }),
          // Only stuck items are asked about.
          open({ id: "asks", kind: "needs-info", issue: 41, run: runIdToString(rid(41)) }),
          // A repo that is not watched is not asked about.
          open({ id: "paused", kind: "stuck", repo: "rawphp/paused", issue: 41 }),
        ];
        yield* pass(fake, [REPO], 5);
        assert.deepEqual(ids(fake), ["open", "asks", "paused"]);
        assert.deepEqual(
          fake.calls.filter((c) => c.startsWith("issue_closed")),
          [`issue_closed ${REPO}#41`, `issue_closed ${REPO}#42`],
        );
      }),
  );

  it.effect("a stuck item's issue is read at most once every ten minutes", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.items = [open({ id: "stuck", kind: "stuck", issue: 41, run: runIdToString(rid(41)) })];
      const reads = () => fake.calls.filter((c) => c.startsWith("issue_closed")).length;
      yield* pass(fake, [REPO], 5);
      fake.now += STUCK_READ_EVERY_MS - 1;
      yield* pass(fake, [REPO], 5);
      assert.strictEqual(reads(), 1);
      fake.now += 1;
      fake.closedIssues[`${REPO}#41`] = true;
      yield* pass(fake, [REPO], 5);
      assert.strictEqual(reads(), 2);
      assert.deepEqual(ids(fake), []);
      // The read time of a cleared item is not kept.
      assert.strictEqual(fake.stuckReads.size, 0);
    }),
  );

  it.effect("a stuck item whose issue could not be read is read again ten minutes later", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.closedIssues[`${REPO}#41`] = "error";
      fake.items = [open({ id: "stuck", kind: "stuck", issue: 41, run: runIdToString(rid(41)) })];
      const reads = () => fake.calls.filter((c) => c.startsWith("issue_closed")).length;
      yield* pass(fake, [REPO], 5);
      fake.now += STUCK_READ_EVERY_MS - 1;
      yield* pass(fake, [REPO], 5);
      assert.strictEqual(reads(), 1);
      fake.now += 1;
      yield* pass(fake, [REPO], 5);
      assert.strictEqual(reads(), 2);
    }),
  );

  it.effect(
    "a stuck item whose issue cannot be read stays, said in a line that is not an error",
    () =>
      Effect.gen(function* () {
        const fake = new Fake();
        fake.closedIssues[`${REPO}#41`] = "error";
        fake.items = [open({ id: "stuck", kind: "stuck", issue: 41, run: runIdToString(rid(41)) })];
        const { report, lines } = yield* pass(fake, [REPO], 5);
        assert.deepEqual(ids(fake), ["stuck"]);
        // An issue that can never be read again (deleted, transferred) must not fail every pass.
        assert.equal(report.errors, 0);
        assert.deepEqual(errorEvents(fake), []);
        assert.deepEqual(
          lines.filter((l) => l.includes("cannot read whether the issue is closed")),
          [`${REPO}#41: cannot read whether the issue is closed: ${trackerFailure().message}`],
        );
      }),
  );

  it.effect("no item is cleared at the pass end when the ledger cannot be read", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runsError = true;
      fake.items = [open({ id: "a", kind: "attention", run: RUN_40 })];
      yield* pass(fake, [REPO], 5);
      assert.deepEqual(ids(fake), ["a"]);
    }),
  );
});

/**
 * softfac's `tick/tests/interruption.rs`: `advance` says a session ended `failed` or `cancelled`
 * (or lost its thread) and writes nothing; the pass decides about every such run together after
 * it has been through all of them, with what the machine log says of T3. Left out: the dry run
 * and the `triage` run `start` skips, which this pass has no counterpart for.
 */
const passTempDir = useTempDirs();

describe("sessions that ended badly", () => {
  const T3_ERROR = "T3 Code is not reachable: the request timed out";
  const badEnd = (what: "failed" | "cancelled" | "thread-gone"): AdvanceOutcome => ({
    kind: "ended-badly",
    what,
  });
  const decisions = (fake: Fake) =>
    fake.calls.filter((c) => /^(advance |interrupted |t3_trouble$)/.test(c));
  const lineFor = (lines: ReadonlyArray<string>, issue: number) =>
    runLine(lines, `rawphp/softfac#${issue} `);
  const twoRuns = () => {
    const fake = new Fake();
    fake.runIn(12, BUILDING, REPO, true);
    fake.runIn(13, BUILDING, REPO, true);
    return fake;
  };

  it.effect("is decided with the T3 error from the machine log", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(12, BUILDING, REPO, true);
      fake.t3Trouble_ = T3_ERROR;
      fake.advances[`${REPO}#12`] = [badEnd("failed")];
      const { report, lines } = yield* pass(fake, [REPO], 1);
      assert.equal(report.errors, 0);
      assert.deepEqual(decisions(fake), [
        `advance ${REPO}#12`,
        "t3_trouble",
        `interrupted ${runIdToString(rid(12))} t3=${T3_ERROR} ended=1`,
      ]);
      assert.equal(
        lineFor(lines, 12),
        "rawphp/softfac#12 building: session ended as failed; interrupted, sent it a resume (1 of 2)",
      );
      // The gate is not started for a session that ended badly.
      assert.ok(!fake.calls.some((c) => c.startsWith("gate ")));
    }),
  );

  const t3Failure = () => new SessionsError({ operation: "status", cause: "connection refused" });
  const T3_LINE = `${runIdToString(rid(12))}`;

  it.effect(
    "a status read T3 did not answer is a t3 error in the machine log as well as the run's ledger",
    () =>
      Effect.gen(function* () {
        // softfac records T3 trouble from its own T3 call per repo; this factory's project lookup is
        // in-process, so the sessions calls that fail are the sign `t3Trouble` reads.
        const fake = new Fake();
        fake.runIn(12, BUILDING, REPO, true);
        fake.advances[`${REPO}#12`] = [t3Failure()];
        const { report, lines } = yield* pass(fake, [REPO], 1);
        assert.equal(report.errors, 1);
        assert.ok(
          lines.some((l) => l.startsWith("error: rawphp/softfac#12 advance: ")),
          lines.join("\n"),
        );
        assert.deepEqual(
          fake.runErrors.map((e) => [runIdToString(e.run), e.step, e.kind]),
          [[T3_LINE, "advance", "t3"]],
        );
        assert.deepEqual(
          errorEvents(fake).map((e) => e.data),
          [
            {
              run: T3_LINE,
              step: "advance",
              kind: "t3",
              message: "Factory sessions status failed.",
            },
          ],
        );
        assert.ok(!fake.calls.includes("t3_trouble"));
      }),
  );

  it.effect("every call on T3 itself that fails is a t3 error in the machine log", () =>
    Effect.gen(function* () {
      for (const operation of ["find-project", "status", "thread", "send", "archive"] as const) {
        const fake = new Fake();
        fake.runIn(12, BUILDING, REPO, true);
        fake.advances[`${REPO}#12`] = [new SessionsError({ operation, cause: "timed out" })];
        yield* pass(fake, [REPO], 1);
        assert.deepEqual(recordedErrorKinds(fake), ["t3"], operation);
        assert.deepEqual(
          errorEvents(fake).map((e) => (e.data as { run: string }).run),
          [T3_LINE],
          operation,
        );
      }
    }),
  );

  it.effect("a run's error of another kind stays in its ledger alone", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(12, BUILDING, REPO, true);
      fake.advances[`${REPO}#12`] = [githubFailure()];
      yield* pass(fake, [REPO], 1);
      assert.deepEqual(
        fake.runErrors.map((e) => e.kind),
        ["tracker"],
      );
      assert.deepEqual(errorEvents(fake), []);
    }),
  );

  it.effect("the t3 error is recorded when the one run holds the only slot, paused or not", () =>
    Effect.gen(function* () {
      for (const paused of [false, true]) {
        const fake = new Fake();
        fake.runIn(12, BUILDING, REPO, true);
        fake.ready[REPO] = [1];
        if (paused) fake.pause = { sinceMs: T0 - 2 * 60 * 60 * 1000 };
        fake.advances[`${REPO}#12`] = [t3Failure()];
        const { report } = yield* pass(fake, [REPO], 1);
        assert.equal(report.errors, 1, `paused=${paused}`);
        assert.deepEqual(starts(fake), [], `paused=${paused}`);
        assert.deepEqual(
          errorEvents(fake).map((e) => (e.data as { kind: string; run: string }).run),
          [T3_LINE],
          `paused=${paused}`,
        );
        assert.deepEqual(recordedErrorKinds(fake), ["t3"], `paused=${paused}`);
      }
    }),
  );

  it.effect(
    "a lone run cut off by a T3 restart is resumed on the next pass from the log the first wrote",
    () =>
      Effect.gen(function* () {
        // The real machine log joins the two passes: the first pass's `fail` writes the t3 error,
        // the second pass's `t3Trouble` reads it, and the cancelled run is an interruption.
        const fake = new Fake();
        fake.machineLogDir = passTempDir();
        fake.runIn(12, BUILDING, REPO, true);
        fake.advances[`${REPO}#12`] = [t3Failure(), badEnd("cancelled")];
        const first = yield* pass(fake, [REPO], 1);
        assert.equal(first.report.errors, 1);
        assert.ok(!fake.calls.includes("t3_trouble"));
        fake.calls.length = 0;
        fake.now = T0 + 60_000;
        const second = yield* pass(fake, [REPO], 1);
        assert.equal(second.report.errors, 0);
        assert.deepEqual(decisions(fake), [
          `advance ${REPO}#12`,
          "t3_trouble",
          `interrupted ${T3_LINE} t3=Factory sessions status failed. ended=1`,
        ]);
        assert.equal(
          lineFor(second.lines, 12),
          "rawphp/softfac#12 building: session ended as cancelled; interrupted, sent it a resume (1 of 2)",
        );
        assert.ok(!fake.items.some((item) => item.kind === "stuck"));
      }),
  );

  it.effect(
    "a lone run cancelled by a T3 restart is decided with the server's start as evidence, with no failure before it",
    () =>
      Effect.gen(function* () {
        // The restart ends the turn as `cancelled` and the next pass's status read answers fine:
        // nothing fails and no error reaches the machine log. The pass hands `interrupted` the
        // server's start, which decides it against the run's own times.
        const fake = new Fake();
        fake.machineLogDir = passTempDir();
        // What the old server wrote as it stopped, and the new one when it started two minutes ago.
        yield* fake.record({ event: "server_stopping", data: { stopping_at: T0 - 3 * 60_000 } });
        yield* fake.record({ event: "server_started", data: { started_at: T0 - 2 * 60_000 } });
        fake.runIn(12, BUILDING, REPO, true);
        fake.advances[`${REPO}#12`] = [badEnd("cancelled")];
        fake.events.length = 0;
        const { report } = yield* pass(fake, [REPO], 1);
        assert.equal(report.errors, 0);
        assert.deepEqual(errorEvents(fake), []);
        assert.deepEqual(decisions(fake), [
          `advance ${REPO}#12`,
          "t3_trouble",
          `interrupted ${T3_LINE} t3=none ended=1`,
        ]);
        assert.deepEqual(fake.lastEvidence, {
          t3Error: null,
          endedInPass: 1,
          t3Starts: [T0 - 2 * 60_000],
          t3Stops: [T0 - 3 * 60_000],
        });
      }),
  );

  /** A t3-kind error of a run that is not T3 failing to answer, then a cancel the next pass. */
  const notT3Down = (error: BuildingError, label: string) =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.machineLogDir = passTempDir();
      fake.runIn(12, BUILDING, REPO, true);
      fake.advances[`${REPO}#12`] = [error, badEnd("cancelled")];
      fake.interrupts[`${REPO}#12`] = [
        { kind: "stuck", reason: "the session run ended as cancelled" },
      ];
      const first = yield* pass(fake, [REPO], 1);
      assert.equal(first.report.errors, 1, label);
      // The run's ledger has it as t3, and the machine log has nothing: it is not T3 trouble.
      assert.deepEqual(
        fake.runErrors.map((e) => [runIdToString(e.run), e.step, e.kind]),
        [[T3_LINE, "advance", "t3"]],
        label,
      );
      assert.deepEqual(errorEvents(fake), [], label);
      fake.calls.length = 0;
      fake.now = T0 + 60_000;
      yield* pass(fake, [REPO], 1);
      assert.deepEqual(
        decisions(fake),
        [`advance ${REPO}#12`, "t3_trouble", `interrupted ${T3_LINE} t3=none ended=1`],
        label,
      );
    });

  it.effect(
    "a worktree removal that fails is not T3 trouble, so a later cancel still goes stuck",
    () =>
      notT3Down(
        new SessionsError({ operation: "remove-worktree", cause: "Directory not empty" }),
        "remove-worktree",
      ),
  );

  it.effect(
    "a launch that fails is not T3 trouble: the worktree, origin or the ids can be at fault",
    () =>
      notT3Down(
        new SessionsError({ operation: "launch", cause: "fetch from origin failed" }),
        "launch",
      ),
  );

  it.effect("a message T3 refused is not T3 trouble, so a later cancel still goes stuck", () =>
    notT3Down(
      new MessageRejectedError({ threadId: "thread-1", commandId: "softfac:x", cause: "refused" }),
      "rejected",
    ),
  );

  it.effect("says nothing about it before the decision", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(12, BUILDING, REPO, true);
      fake.advances[`${REPO}#12`] = [badEnd("failed")];
      const { lines } = yield* pass(fake, [REPO], 1);
      assert.equal(
        lines.filter((l) => l.startsWith("rawphp/softfac#12")).length,
        1,
        lines.join("\n"),
      );
    }),
  );

  it.effect("is decided together with the others after the loop, each with the count", () =>
    Effect.gen(function* () {
      const fake = twoRuns();
      fake.advances[`${REPO}#12`] = [badEnd("failed")];
      fake.advances[`${REPO}#13`] = [badEnd("cancelled")];
      const { report } = yield* pass(fake, [REPO], 2);
      assert.equal(report.errors, 0);
      // Every run has been advanced before the log is read, once, and each is decided with the
      // number of sessions that ended badly.
      assert.deepEqual(decisions(fake), [
        `advance ${REPO}#12`,
        `advance ${REPO}#13`,
        "t3_trouble",
        `interrupted ${runIdToString(rid(12))} t3=none ended=2`,
        `interrupted ${runIdToString(rid(13))} t3=none ended=2`,
      ]);
    }),
  );

  it.effect("leaves the machine log unread when no session ended badly", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(12, BUILDING, REPO, true);
      const { report } = yield* pass(fake, [REPO], 1);
      assert.equal(report.errors, 0);
      assert.ok(!fake.calls.includes("t3_trouble"));
      assert.ok(!fake.calls.some((c) => c.startsWith("interrupted ")));
    }),
  );

  it.effect("decides nothing for a lone session when the machine log cannot be read", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(12, BUILDING, REPO, true);
      fake.t3Trouble_ = { error: "cannot read events.jsonl" };
      fake.advances[`${REPO}#12`] = [badEnd("failed")];
      const { report, lines } = yield* pass(fake, [REPO], 1);
      assert.equal(report.errors, 1);
      assert.ok(
        lines.some((l) => l.startsWith("error: ") && l.includes("cannot read events.jsonl")),
        lines.join("\n"),
      );
      // Nothing is written and nothing is said of the run: `advance` reports it again next pass.
      assert.ok(!fake.calls.some((c) => c.startsWith("interrupted ")));
      assert.ok(!lines.some((l) => l.startsWith("rawphp/softfac#12")), lines.join("\n"));
    }),
  );

  it.effect("still decides two sessions when the machine log cannot be read", () =>
    Effect.gen(function* () {
      const fake = twoRuns();
      fake.t3Trouble_ = { error: "cannot read events.jsonl" };
      fake.advances[`${REPO}#12`] = [badEnd("failed")];
      fake.advances[`${REPO}#13`] = [badEnd("failed")];
      const { report, lines } = yield* pass(fake, [REPO], 2);
      assert.equal(report.errors, 1);
      assert.ok(
        lines.some((l) => l.includes("cannot read events.jsonl")),
        lines.join("\n"),
      );
      for (const issue of [12, 13]) {
        assert.ok(
          fake.calls.includes(`interrupted ${runIdToString(rid(issue))} t3=none ended=2`),
          fake.calls.join("\n"),
        );
      }
    }),
  );

  it.effect("sent to stuck by the decision is printed as stuck", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(12, BUILDING, REPO, true);
      fake.advances[`${REPO}#12`] = [badEnd("failed")];
      fake.interrupts[`${REPO}#12`] = [
        { kind: "stuck", reason: "the session run ended as failed" },
      ];
      const { report, lines } = yield* pass(fake, [REPO], 1);
      assert.equal(report.errors, 0);
      assert.equal(
        lineFor(lines, 12),
        `rawphp/softfac#12 building: stuck, the reason is in the ledger of run ${runIdToString(rid(12))}`,
      );
      assert.ok(
        fake.items.some((item) => item.kind === "stuck" && item.run === runIdToString(rid(12))),
      );
    }),
  );

  it.effect("relaunched is printed with the run that took over", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(12, BUILDING, REPO, true);
      fake.advances[`${REPO}#12`] = [badEnd("thread-gone")];
      const next = newRunId(REPO, "12", 2);
      fake.interrupts[`${REPO}#12`] = [
        {
          kind: "relaunched",
          resumes: 1,
          limit: 2,
          start: { kind: "started", run: next, threadId: "thread-2" },
        },
      ];
      const { report, lines } = yield* pass(fake, [REPO], 1);
      assert.equal(report.errors, 0);
      assert.equal(
        lineFor(lines, 12),
        `rawphp/softfac#12 building: the T3 thread is gone; interrupted, relaunched as run ${runIdToString(next)} (1 of 2)`,
      );
    }),
  );

  it.effect("relaunched whose start went stuck names the run that went stuck", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(12, BUILDING, REPO, true);
      fake.advances[`${REPO}#12`] = [badEnd("thread-gone")];
      const next = newRunId(REPO, "12", 2);
      fake.interrupts[`${REPO}#12`] = [
        {
          kind: "relaunched",
          resumes: 1,
          limit: 2,
          start: { kind: "stuck", run: next, reason: "the factory could not launch a session" },
        },
      ];
      const { lines } = yield* pass(fake, [REPO], 1);
      const line = lineFor(lines, 12);
      assert.ok(line.includes("relaunched (1 of 2)"), line);
      assert.ok(
        line.includes(`stuck, the reason is in the ledger of run ${runIdToString(next)}`),
        line,
      );
    }),
  );

  it.effect("relaunched whose new attempt waits is printed as relaunching", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(12, BUILDING, REPO, true);
      fake.advances[`${REPO}#12`] = [badEnd("thread-gone")];
      fake.interrupts[`${REPO}#12`] = [
        {
          kind: "relaunched",
          resumes: 2,
          limit: 2,
          start: { kind: "skipped", reason: "scripted" },
        },
      ];
      const { lines } = yield* pass(fake, [REPO], 1);
      assert.equal(
        lineFor(lines, 12),
        "rawphp/softfac#12 building: the T3 thread is gone; interrupted, relaunching (2 of 2), the new attempt starts on the next pass",
      );
    }),
  );

  it.effect(
    "relaunched whose start found the issue closed says so, and where a session may be",
    () =>
      Effect.gen(function* () {
        const fake = new Fake();
        fake.runIn(12, BUILDING, REPO, true);
        fake.advances[`${REPO}#12`] = [badEnd("thread-gone")];
        const next = newRunId(REPO, "12", 2);
        fake.interrupts[`${REPO}#12`] = [
          {
            kind: "relaunched",
            resumes: 1,
            limit: 2,
            start: { kind: "abandoned", mayHaveSession: [next] },
          },
        ];
        const { report, lines } = yield* pass(fake, [REPO], 1);
        assert.equal(report.errors, 0);
        assert.equal(
          lineFor(lines, 12),
          "rawphp/softfac#12 building: the T3 thread is gone; interrupted, relaunching (1 of 2), the issue is closed, the run is closed",
        );
        // The orphaned T3 thread of the next attempt is a person's to archive.
        const run = runIdToString(next);
        assert.deepEqual(
          lines.filter((l) => l.startsWith("ATTENTION: ")),
          [
            `ATTENTION: ${REPO}#12 the issue was closed, and a session may exist for ${run}: look for launch command id softfac:${run}:launch in T3 Code and archive that thread by hand`,
          ],
        );
        assert.equal(report.attention, 1);
        assert.deepEqual(
          fake.events.filter((e) => e.event === "attention"),
          [{ event: "attention", data: { run, reason: "session-may-exist" } }],
        );
      }),
  );

  it.effect("relaunched whose start was refused is printed as relaunching for the next pass", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(12, BUILDING, REPO, true);
      fake.advances[`${REPO}#12`] = [badEnd("thread-gone")];
      fake.interrupts[`${REPO}#12`] = [
        {
          kind: "relaunched",
          resumes: 1,
          limit: 2,
          start: { kind: "refused", reason: "the issue is not approved" },
        },
      ];
      const { report, lines } = yield* pass(fake, [REPO], 1);
      assert.equal(report.errors, 0);
      assert.equal(report.attention, 0);
      assert.equal(
        lineFor(lines, 12),
        "rawphp/softfac#12 building: the T3 thread is gone; interrupted, relaunching (1 of 2), the new attempt starts on the next pass",
      );
    }),
  );

  it.effect("a relaunch advance finishes whose start was abandoned with an error says both", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(12, BUILDING, REPO, true);
      const next = newRunId(REPO, "12", 2);
      const error = new SessionsError({ operation: "archive", cause: "timeout" });
      fake.advances[`${REPO}#12`] = [
        {
          kind: "relaunched",
          start: { kind: "abandoned", mayHaveSession: [next], error },
        },
      ];
      const { report, lines } = yield* pass(fake, [REPO], 1);
      assert.equal(
        lineFor(lines, 12),
        "rawphp/softfac#12 building: the T3 thread is gone; interrupted, relaunching, the issue is closed, the run is closed",
      );
      const run = runIdToString(next);
      assert.deepEqual(
        lines.filter((l) => l.startsWith("ATTENTION: ")),
        [
          `ATTENTION: ${REPO}#12 the issue was closed, and a session may exist for ${run}: look for launch command id softfac:${run}:launch in T3 Code and archive that thread by hand`,
        ],
      );
      assert.equal(report.attention, 1);
      // The error of the run `start` could not end is this run's error line.
      assert.equal(report.errors, 1);
      assert.ok(
        lines.some((l) => l.startsWith("error: rawphp/softfac#12 start: ")),
        lines.join("\n"),
      );
      assert.deepEqual(
        fake.runErrors.map((e) => [runIdToString(e.run), e.step, e.kind]),
        [[runIdToString(rid(12)), "start", "t3"]],
      );
      assert.ok(!fake.calls.includes("t3_trouble"));
    }),
  );

  it.effect("that moved on before the decision is left alone and said so", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(12, BUILDING, REPO, true);
      fake.advances[`${REPO}#12`] = [badEnd("failed")];
      fake.interrupts[`${REPO}#12`] = [{ kind: "unchanged", why: "its thread has a newer run" }];
      const { report, lines } = yield* pass(fake, [REPO], 1);
      assert.equal(report.errors, 0);
      assert.equal(
        lineFor(lines, 12),
        "rawphp/softfac#12 building: session ended as failed, but its thread has a newer run; left alone",
      );
    }),
  );

  it.effect(
    "whose decision fails is an error line for that run and the others are still decided",
    () =>
      Effect.gen(function* () {
        const fake = twoRuns();
        fake.advances[`${REPO}#12`] = [badEnd("failed")];
        fake.advances[`${REPO}#13`] = [badEnd("failed")];
        fake.interrupts[`${REPO}#12`] = [
          new SessionsError({ operation: "send", cause: "timeout" }),
        ];
        const { report, lines } = yield* pass(fake, [REPO], 2);
        assert.equal(report.errors, 1);
        assert.ok(
          lines.some((l) => l.startsWith("error: rawphp/softfac#12 interrupted: ")),
          lines.join("\n"),
        );
        assert.ok(
          fake.calls.includes(`interrupted ${runIdToString(rid(13))} t3=none ended=2`),
          fake.calls.join("\n"),
        );
        assert.equal(fake.runErrors[0]?.step, "advance");
        assert.equal(fake.runErrors[0]?.kind, "t3");
      }),
  );

  it.effect("a relaunch that advance finishes is printed too, with no evidence read", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(12, BUILDING, REPO, true);
      const next = newRunId(REPO, "12", 2);
      fake.advances[`${REPO}#12`] = [
        { kind: "relaunched", start: { kind: "started", run: next, threadId: "thread-2" } },
      ];
      const { report, lines } = yield* pass(fake, [REPO], 1);
      assert.equal(report.errors, 0);
      assert.equal(
        lineFor(lines, 12),
        `rawphp/softfac#12 building: the T3 thread is gone; interrupted, relaunched as run ${runIdToString(next)}`,
      );
      // It was decided in an earlier pass: no evidence is read for it now.
      assert.ok(!fake.calls.includes("t3_trouble"));
    }),
  );

  it.effect("a session stopped by hand is printed as paused and never decided", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(12, BUILDING, REPO, true);
      fake.t3Trouble_ = T3_ERROR;
      fake.advances[`${REPO}#12`] = [{ kind: "paused" }];
      const { report, lines } = yield* pass(fake, [REPO], 1);
      assert.equal(report.errors, 0);
      assert.deepEqual(decisions(fake), [`advance ${REPO}#12`]);
      assert.equal(
        lineFor(lines, 12),
        "rawphp/softfac#12 building: session stopped by hand, waiting for an instructor's comment on the pull request or the issue",
      );
    }),
  );
});

describe("pr-open runs: gated again only when something moved", () => {
  const pr = (fake: Fake, issue: number, repo = REPO) => fake.runIn(issue, "pr-open", repo, false);
  const gated = (fake: Fake) => fake.calls.filter((c) => c.startsWith("gate "));
  const reads = (fake: Fake, name: string) => fake.calls.filter((c) => c.startsWith(`${name} `));
  const lineOf = (lines: ReadonlyArray<string>, issue: number) =>
    lines.filter((l) => l.startsWith(`${REPO}#${issue} `));

  it.effect("a quiet run prints nothing and starts nothing", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      pr(fake, 41);
      const { lines, report } = yield* pass(fake, [REPO], 5);
      assert.deepEqual(gated(fake), []);
      assert.deepEqual(lineOf(lines, 41), []);
      assert.equal(report.errors, 0);
      // The comparison reads the ledger and the pull request's head, and not the base tip.
      assert.deepEqual(
        fake.calls.filter((c) => /^(last_pass|open_pull) /.test(c)),
        [`last_pass ${REPO}#41`, `open_pull ${REPO}#12`],
      );
    }),
  );

  it.effect("a pr-open run is not worked as a building run: no limit or advance", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      pr(fake, 41);
      yield* pass(fake, [REPO], 5);
      assert.deepEqual(
        fake.calls.filter((c) => /^(time_limit|watch|forward|advance|start|resume) /.test(c)),
        [],
      );
    }),
  );

  // A stop asked for while a building run's gate ran waits for the gate; once the gate passed the
  // run is pr-open, and the request is dropped before a re-gate could relaunch a session it stops.
  it.effect("a stop request left from before the gate passed is dropped before the gate", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      pr(fake, 41);
      fake.openHeads[`${REPO}#12`] = PUSHED;
      fake.stopRequests[`${REPO}#41`] = "not-building";
      const { lines } = yield* pass(fake, [REPO], 5);
      assert.deepEqual(
        fake.calls.filter((c) => /^(stop_request|last_pass|gate) /.test(c)),
        [`stop_request ${REPO}#41`, `last_pass ${REPO}#41`, `gate ${REPO}#41`],
      );
      assert.deepEqual(lineOf(lines, 41), [
        `${REPO}#41 pr-open: stop request dropped: the run is not building, gate started in the background`,
      ]);
    }),
  );

  it.effect("a stop request is not taken while the run's gate is running", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      pr(fake, 41);
      fake.gateLocks = [runIdToString(rid(41))];
      fake.stopRequests[`${REPO}#41`] = "not-building";
      yield* pass(fake, [REPO], 5);
      assert.ok(!fake.calls.includes(`stop_request ${REPO}#41`), fake.calls.join("\n"));
    }),
  );

  it.effect("a head that moved starts the gate", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      pr(fake, 41);
      fake.openHeads[`${REPO}#12`] = PUSHED;
      const { lines } = yield* pass(fake, [REPO], 5);
      assert.deepEqual(gated(fake), [`gate ${REPO}#41`]);
      assert.deepEqual(lineOf(lines, 41), [`${REPO}#41 pr-open: gate started in the background`]);
    }),
  );

  it.effect("a pull request GitHub says conflicts starts the gate with nothing moved", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      pr(fake, 41);
      fake.mergeables[`${REPO}#12`] = "conflicting";
      const { lines } = yield* pass(fake, [REPO], 5);
      assert.deepEqual(gated(fake), [`gate ${REPO}#41`]);
      assert.deepEqual(lineOf(lines, 41), [`${REPO}#41 pr-open: gate started in the background`]);
    }),
  );

  it.effect(
    "a pull request GitHub calls mergeable or unknown, with nothing moved, is not gated",
    () =>
      Effect.gen(function* () {
        for (const mergeable of ["mergeable", "unknown"] as const) {
          const fake = new Fake();
          pr(fake, 41);
          fake.mergeables[`${REPO}#12`] = mergeable;
          yield* pass(fake, [REPO], 5);
          assert.deepEqual(gated(fake), [], mergeable);
        }
      }),
  );

  it.effect("a head in a different case is the same head", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      pr(fake, 41);
      fake.openHeads[`${REPO}#12`] = HEAD.toUpperCase();
      yield* pass(fake, [REPO], 5);
      assert.deepEqual(gated(fake), []);
    }),
  );

  it.effect("a pull request that ended starts the gate, which ends the run", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      pr(fake, 41);
      fake.openHeads[`${REPO}#12`] = null;
      yield* pass(fake, [REPO], 5);
      assert.deepEqual(gated(fake), [`gate ${REPO}#41`]);
    }),
  );

  it.effect("a run with no last pass is left to the gate", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      pr(fake, 41);
      fake.lastPasses[`${REPO}#41`] = null;
      yield* pass(fake, [REPO], 5);
      assert.deepEqual(gated(fake), [`gate ${REPO}#41`]);
      // Nothing is read from GitHub for a run the gate will look at anyway.
      assert.deepEqual(reads(fake, "open_pull"), []);
    }),
  );

  it.effect("a ledger that cannot be read for the comparison is left to the gate", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      pr(fake, 41);
      fake.lastPasses[`${REPO}#41`] = "error";
      yield* pass(fake, [REPO], 5);
      assert.deepEqual(gated(fake), [`gate ${REPO}#41`]);
    }),
  );

  it.effect(
    "a failed read of the pull request starts the gate and the repo is not read again",
    () =>
      Effect.gen(function* () {
        const fake = new Fake();
        pr(fake, 41);
        pr(fake, 42);
        fake.openHeads[`${REPO}#12`] = "error";
        yield* pass(fake, [REPO], 5);
        assert.deepEqual(gated(fake), [`gate ${REPO}#41`, `gate ${REPO}#42`]);
        assert.equal(reads(fake, "open_pull").length, 1);
      }),
  );

  it.effect("a run whose gate is running says so and reads nothing", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      pr(fake, 41);
      fake.gateLocks.push(runIdToString(rid(41)));
      const { lines } = yield* pass(fake, [REPO], 5);
      assert.deepEqual(lineOf(lines, 41), [`${REPO}#41 pr-open: gate running`]);
      assert.deepEqual(gated(fake), []);
      assert.deepEqual(reads(fake, "last_pass"), []);
    }),
  );

  it.effect("a gate that cannot start because gates are running says it is queued", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      pr(fake, 41);
      fake.openHeads[`${REPO}#12`] = PUSHED;
      fake.gateStarts[`${REPO}#41`] = { kind: "queued", running: 2, max: 2 };
      const { lines } = yield* pass(fake, [REPO], 5);
      assert.deepEqual(lineOf(lines, 41), [
        `${REPO}#41 pr-open: gate queued: 2 gates running, max_concurrent_gates is 2`,
      ]);
    }),
  );

  it.effect("a re-gate held by the load says so, not the gate limit", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      pr(fake, 41);
      fake.openHeads[`${REPO}#12`] = PUSHED;
      fake.gateStarts[`${REPO}#41`] = { kind: "high-load", oneMinute: 55.2, limit: 12 };
      const { lines } = yield* pass(fake, [REPO], 5);
      assert.deepEqual(lineOf(lines, 41), [
        `${REPO}#41 pr-open: gate queued: 1-minute load 55.2 is above 12 and a gate is already running`,
      ]);
    }),
  );

  it.effect("a pr-open run of a repo that did not load is left alone", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      pr(fake, 41, OTHER);
      fake.projects[OTHER] = "bad config";
      fake.openHeads[`${OTHER}#12`] = PUSHED;
      yield* pass(fake, [REPO, OTHER], 5);
      assert.deepEqual(gated(fake), []);
      assert.deepEqual(reads(fake, "last_pass"), []);
    }),
  );

  it.effect("a pr-open run does not hold a slot, and its gate does not stop a claim", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      pr(fake, 41);
      fake.openHeads[`${REPO}#12`] = PUSHED;
      fake.ready[REPO] = [1];
      fake.pushStart(`${REPO}#1`, started(1));
      const { report } = yield* pass(fake, [REPO], 1);
      assert.equal(report.claimed, 1);
      assert.deepEqual(gated(fake), [`gate ${REPO}#41`]);
    }),
  );

  it.effect("a pr-open run is gated again last, after the claims", () =>
    Effect.gen(function* () {
      // A claim of an issue a person relabelled `factory:ready` ends that issue's older pr-open
      // run, and a re-gate takes a gate slot: so the claims go first, as softfac orders it.
      const fake = new Fake();
      fake.runIn(40, BUILDING);
      pr(fake, 41);
      fake.openHeads[`${REPO}#12`] = PUSHED;
      fake.ready[REPO] = [1];
      fake.pushStart(`${REPO}#1`, started(1));
      yield* pass(fake, [REPO], 2);
      const order = fake.calls.filter((c) => /^(advance|start|gate) /.test(c));
      assert.deepEqual(order, [`advance ${REPO}#40`, `start ${REPO}#1`, `gate ${REPO}#41`]);
    }),
  );
});

describe("pr-open runs: instructor feedback", () => {
  const RUN12 = runIdToString(rid(12));
  const LINE12 = `${REPO}#12 pr-open: `;
  const lineOf = (lines: ReadonlyArray<string>) => lines.filter((l) => l.startsWith(`${REPO}#12 `));
  const gated = (fake: Fake) => fake.calls.filter((c) => c.startsWith("gate "));

  /** Run 12 waits in `pr-open` with pull request 7, nothing moved. */
  const quiet = (fake: Fake) => {
    fake.runIn(12, "pr-open", REPO, false);
    fake.lastPasses[`${REPO}#12`] = { pr: 7, head: HEAD };
  };
  /** Run 12 as `quiet`, and the feedback step answers `step` for it. */
  const reviewed = (step: FeedbackStep | BuildingError) => {
    const fake = new Fake();
    quiet(fake);
    fake.feedbackSteps[RUN12] = [step];
    return fake;
  };
  const relaunched = (items: number): FeedbackStep => ({ kind: "relaunched", pr: 7, items });

  it.effect(
    "a pr-open run with feedback is relaunched and no gate is started even when the head moved",
    () =>
      Effect.gen(function* () {
        const fake = reviewed(relaunched(2));
        // The head moved too: the feedback wins, and the gate runs when the new
        // session's first run ends.
        fake.openHeads[`${REPO}#7`] = MOVED;
        const { report, lines } = yield* pass(fake, [REPO], 1);
        assert.equal(report.errors, 0);
        assert.deepEqual(gated(fake), []);
        assert.deepEqual(lineOf(lines), [
          `${LINE12}instructor feedback (2 items) on PR https://github.com/rawphp/softfac/pull/7: a new session was launched on its branch, the PR is a draft again`,
        ]);
        // The comparison with the last pass is not made: the run is no longer waiting.
        assert.deepEqual(
          fake.calls.filter((c) => /^open_pull /.test(c)),
          [],
        );
        assert.deepEqual(fake.feedbacks, [RUN12]);
      }),
  );

  it.effect("one item of feedback says item and not items", () =>
    Effect.gen(function* () {
      const { lines } = yield* pass(reviewed(relaunched(1)), [REPO], 1);
      assert.ok(
        runLine(lines, `${REPO}#12`).includes("instructor feedback (1 item) on PR"),
        `${lines}`,
      );
    }),
  );

  it.effect(
    "a pr-open run with no feedback is asked once and prints nothing when nothing moved",
    () =>
      Effect.gen(function* () {
        const fake = new Fake();
        quiet(fake);
        const { report, lines } = yield* pass(fake, [REPO], 1);
        assert.equal(report.errors, 0);
        assert.deepEqual(fake.feedbacks, [RUN12]);
        assert.deepEqual(gated(fake), []);
        assert.deepEqual(lineOf(lines), []);
      }),
  );

  it.effect("a pr-open run with no feedback whose head moved gets its gate as before", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      quiet(fake);
      fake.openHeads[`${REPO}#7`] = MOVED;
      const { lines } = yield* pass(fake, [REPO], 1);
      assert.deepEqual(gated(fake), [`gate ${REPO}#12`]);
      assert.deepEqual(lineOf(lines), [`${LINE12}gate started in the background`]);
    }),
  );

  it.effect("the feedback step is not called for a run whose gate is running", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      quiet(fake);
      fake.gateLocks.push(RUN12);
      const { lines } = yield* pass(fake, [REPO], 1);
      assert.deepEqual(fake.feedbacks, []);
      assert.deepEqual(lineOf(lines), [`${LINE12}gate running`]);
    }),
  );

  it.effect(
    "feedback that sent the run stuck ended or abandoned it is said and the gate waits",
    () =>
      Effect.gen(function* () {
        const stuck: FeedbackStep = {
          kind: "stuck",
          reason: "the issue text was changed during the build by someone who is not an instructor",
        };
        for (const [step, says] of [
          [stuck, `stuck, the reason is in the ledger of run ${RUN12}`],
          [
            { kind: "ended" } as FeedbackStep,
            "its pull request was merged or closed, the run is finished",
          ],
          [{ kind: "abandoned" } as FeedbackStep, "the issue is closed, the run is closed"],
        ] as const) {
          const fake = reviewed(step);
          fake.openHeads[`${REPO}#7`] = MOVED;
          const { report, lines } = yield* pass(fake, [REPO], 1);
          assert.equal(report.errors, 0, says);
          assert.deepEqual(gated(fake), [], says);
          assert.ok(runLine(lines, `${REPO}#12`).includes(says), `${says}: ${lines}`);
        }
      }),
  );

  it.effect("a feedback step that fails is an error of the run and the run is still gated", () =>
    Effect.gen(function* () {
      const fake = reviewed(new GitHubFailed({ args: ["pr", "view"], status: 1, stderr: "boom" }));
      fake.openHeads[`${REPO}#7`] = MOVED;
      const { report, lines } = yield* pass(fake, [REPO], 1);
      assert.equal(report.errors, 1);
      // The head moved: the failure does not hold the gate back.
      assert.deepEqual(gated(fake), [`gate ${REPO}#12`]);
      assert.ok(
        lines.some((l) => l.startsWith(`error: ${REPO}#12 feedback:`)),
        `${lines}`,
      );
      assert.equal(fake.runErrors.length, 1);
      assert.deepEqual([fake.runErrors[0]!.step, fake.runErrors[0]!.kind], ["forward", "tracker"]);
    }),
  );

  it.effect("a feedback step that fails for a run that did not move starts no gate", () =>
    Effect.gen(function* () {
      const fake = reviewed(new GitHubFailed({ args: ["pr", "view"], status: 1, stderr: "boom" }));
      const { report, lines } = yield* pass(fake, [REPO], 1);
      assert.equal(report.errors, 1);
      assert.deepEqual(gated(fake), []);
      assert.ok(lines[0]!.startsWith(`error: ${REPO}#12 feedback:`), `${lines}`);
    }),
  );
});

describe("a provider rate limit", () => {
  const FABLE_KEY = "claudeAgent claude-fable-5-1";
  const limited = (
    endedMs: number,
    model: Model | null = FABLE,
    retryAfterMs: number | null = null,
  ): AdvanceOutcome => ({ kind: "rate-limited", endedMs, retryAfterMs, model });
  const cooledResumes = (fake: Fake) => fake.calls.filter((c) => c.startsWith("cooled_resume "));
  const coolingLines = (lines: ReadonlyArray<string>) =>
    lines.filter((l) => l.startsWith("provider cooling down"));
  const coolingLine = (until: number, key: string, windows: number, tail: string) =>
    `provider cooling down until ${formatTs(until)}: ${key} hit its rate limit (${windows} ${windows === 1 ? "window" : "windows"} in a row); ${tail}`;
  const HELD = "no issue is claimed on it";
  const coolingSkips = (fake: Fake) =>
    fake.events.filter(
      (e) =>
        e.event === "claim_skipped" && (e.data as { reason: string }).reason === "cooling-down",
    );
  const lineFor = (lines: ReadonlyArray<string>, issue: number) =>
    runLine(lines, `rawphp/softfac#${issue} `);

  it.effect(
    "ten sessions that hit it: none is stuck, nothing is claimed in the backoff, and claims resume after it",
    () =>
      Effect.gen(function* () {
        const fake = new Fake();
        for (let issue = 1; issue <= 10; issue++) {
          fake.runIn(issue, BUILDING, REPO, true);
          fake.advances[`${REPO}#${issue}`] = [
            limited(T0 - 1000),
            limited(T0 - 1000),
            limited(T0 - 1000),
          ];
        }
        fake.ready[REPO] = [20];
        fake.pushStart(`${REPO}#20`, started(20));
        const until = T0 + 5 * MINUTE;

        const first = yield* pass(fake, [REPO], 20);
        assert.deepEqual(starts(fake), []);
        assert.deepEqual(cooledResumes(fake), []);
        assert.ok(!fake.calls.some((c) => c.startsWith("interrupted ")));
        assert.deepEqual(fake.items, []);
        assert.equal(first.report.errors, 0);
        assert.deepEqual(coolingLines(first.lines), [coolingLine(until, FABLE_KEY, 1, HELD)]);
        assert.deepEqual(coolingSkips(fake), [
          { event: "claim_skipped", data: { repo: REPO, reason: "cooling-down" } },
        ]);
        assert.equal(
          lineFor(first.lines, 1),
          `rawphp/softfac#1 building: session hit the provider's rate limit on ${FABLE_KEY}; it is resumed once the cooldown ends at ${formatTs(until)}`,
        );

        // Still in the window: the sessions that ended in the same burst do not move it.
        fake.calls = [];
        fake.now = T0 + 4 * MINUTE;
        const during = yield* pass(fake, [REPO], 20);
        assert.deepEqual(starts(fake), []);
        assert.deepEqual(cooledResumes(fake), []);
        assert.deepEqual(coolingLines(during.lines), [coolingLine(until, FABLE_KEY, 1, HELD)]);

        // The window is over: each session is resumed once and claims go on.
        fake.calls = [];
        fake.now = until;
        const after = yield* pass(fake, [REPO], 20);
        assert.deepEqual(
          cooledResumes(fake),
          Array.from({ length: 10 }, (_, i) => `cooled_resume ${REPO}#${i + 1}`),
        );
        assert.deepEqual(starts(fake), [`start ${REPO}#20`]);
        assert.deepEqual(coolingLines(after.lines), []);
        assert.equal(
          lineFor(after.lines, 1),
          `rawphp/softfac#1 building: session hit the provider's rate limit on ${FABLE_KEY}; the cooldown is over, sent it a resume`,
        );
        assert.deepEqual(fake.items, []);
      }),
  );

  /** Five windows in a row on fable, each hit a minute after the last one ended. */
  const fiveWindows = (fake: Fake) =>
    Effect.gen(function* () {
      fake.runIn(12, BUILDING, REPO, true);
      let ended = T0 - 1000;
      const lengths: Array<number> = [];
      for (let window = 1; window <= 5; window++) {
        fake.advances[`${REPO}#12`] = [limited(ended)];
        const { report } = yield* pass(fake, [REPO], 1);
        const cooldown = fake.cooldowns.get(FABLE_KEY)!;
        lengths.push((cooldown.untilMs - fake.now) / MINUTE);
        const items = fake.items.filter((item) => item.id === `cooldown:${FABLE_KEY}`);
        assert.equal(items.length, window > 3 ? 1 : 0, `window ${window}`);
        assert.equal(report.attention, window === 4 ? 1 : 0, `window ${window}`);
        ended = cooldown.untilMs + MINUTE;
        fake.now = ended + MINUTE;
      }
      return lengths;
    });

  it.effect(
    "backs off longer each window it is hit again, raises one item after three, and forgets it once quiet",
    () =>
      Effect.gen(function* () {
        const fake = new Fake();
        assert.deepEqual(yield* fiveWindows(fake), [5, 10, 20, 40, 60]);
        assert.deepEqual(
          fake.items.map((item) => [item.kind, item.repo, item.message]),
          [
            [
              "attention",
              null,
              `${FABLE_KEY} has hit its provider rate limit 4 windows in a row; claims on it wait for each cooldown to end`,
            ],
          ],
        );
        // Quiet past its window: the streak is over and so is the item.
        fake.now = fake.cooldowns.get(FABLE_KEY)!.untilMs + COOLDOWN_QUIET_MS;
        yield* pass(fake, [REPO], 1);
        assert.equal(fake.cooldowns.size, 0);
        assert.deepEqual(fake.items, []);
      }),
  );

  it.effect("with a fallback, the item says the work runs on it", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.modelFallbacks = { "claude-fable-5-1": "claude-opus-5-5" };
      yield* fiveWindows(fake);
      assert.deepEqual(
        fake.items.map((item) => item.message),
        [
          `${FABLE_KEY} has hit its provider rate limit 4 windows in a row; new sessions and rate-limited sessions run on claude-opus-5-5`,
        ],
      );
    }),
  );

  it.effect("an item a restart left behind is cleared", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.items.push({
        id: `cooldown:${FABLE_KEY}`,
        kind: "attention",
        repo: null,
        issue: null,
        run: null,
        message: "old",
        firstSeenMs: T0 - 60 * MINUTE,
      });
      yield* pass(fake, [REPO], 1);
      assert.deepEqual(fake.items, []);
    }),
  );

  it.effect("an item a restart left behind is cleared while the model cools down afresh", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.items.push({
        id: `cooldown:${FABLE_KEY}`,
        kind: "attention",
        repo: null,
        issue: null,
        run: null,
        message: "old",
        firstSeenMs: T0 - 60 * MINUTE,
      });
      fake.runIn(12, BUILDING, REPO, true);
      fake.advances[`${REPO}#12`] = [limited(T0 - 1000)];
      yield* pass(fake, [REPO], 1);
      assert.equal(fake.cooldowns.get(FABLE_KEY)!.windows, 1);
      assert.deepEqual(fake.items, []);
    }),
  );

  it.effect(
    "with a fallback the session moves to it in place, and claims go on while the fallback is free",
    () =>
      Effect.gen(function* () {
        const fake = new Fake();
        fake.modelFallbacks = { "claude-fable-5-1": "claude-opus-5-5" };
        fake.runIn(12, BUILDING, REPO, true);
        fake.advances[`${REPO}#12`] = [limited(T0 - 1000)];
        fake.ready[REPO] = [20];
        fake.pushStart(`${REPO}#20`, started(20));
        const { lines } = yield* pass(fake, [REPO], 5);
        assert.deepEqual(cooledResumes(fake), [`cooled_resume ${REPO}#12 on claude-opus-5-5`]);
        assert.deepEqual(starts(fake), [`start ${REPO}#20`]);
        assert.equal(
          lineFor(lines, 12),
          `rawphp/softfac#12 building: session hit the provider's rate limit on ${FABLE_KEY}; moved it to claude-opus-5-5 and sent it a resume`,
        );
        assert.deepEqual(coolingLines(lines), [
          coolingLine(T0 + 5 * MINUTE, FABLE_KEY, 1, "new sessions run on claude-opus-5-5"),
        ]);
        assert.deepEqual(coolingSkips(fake), []);
      }),
  );

  it.effect("when the fallback cools down too, claims stop and the session waits", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.modelFallbacks = { "claude-fable-5-1": "claude-opus-5-5" };
      fake.runIn(12, BUILDING, REPO, true);
      fake.runIn(13, BUILDING, REPO, true);
      fake.advances[`${REPO}#12`] = [limited(T0 - 1000, OPUS)];
      fake.advances[`${REPO}#13`] = [limited(T0 - 1000)];
      fake.ready[REPO] = [20];
      fake.pushStart(`${REPO}#20`, started(20));
      const { lines } = yield* pass(fake, [REPO], 5);
      assert.deepEqual(starts(fake), []);
      assert.deepEqual(cooledResumes(fake), []);
      const until = T0 + 5 * MINUTE;
      assert.deepEqual(coolingLines(lines), [
        coolingLine(until, "claudeAgent claude-opus-5-5", 1, HELD),
        coolingLine(until, FABLE_KEY, 1, HELD),
      ]);
      assert.equal(coolingSkips(fake).length, 1);
    }),
  );

  it.effect("holds back only the repos whose project runs on a model that cools down", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(12, BUILDING, REPO, true);
      fake.advances[`${REPO}#12`] = [limited(T0 - 1000)];
      fake.projectModels[OTHER] = OPUS;
      fake.ready[REPO] = [20];
      fake.ready[OTHER] = [4];
      fake.pushStart(`${OTHER}#4`, started(4, OTHER));
      yield* pass(fake, [REPO, OTHER], 5);
      assert.deepEqual(starts(fake), [`start ${OTHER}#4`]);
    }),
  );

  it.effect("reads no project model while nothing cools down", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.ready[REPO] = [20];
      fake.pushStart(`${REPO}#20`, started(20));
      yield* pass(fake, [REPO], 5);
      assert.deepEqual(starts(fake), [`start ${REPO}#20`]);
      assert.ok(!fake.calls.some((c) => c.startsWith("project_model ")));
    }),
  );

  it.effect("opens the window the provider's retry-after asks for", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(12, BUILDING, REPO, true);
      fake.advances[`${REPO}#12`] = [limited(T0 - 1000, FABLE, 30 * MINUTE)];
      const { lines } = yield* pass(fake, [REPO], 1);
      assert.equal(fake.cooldowns.get(FABLE_KEY)!.untilMs, T0 + 30 * MINUTE);
      assert.deepEqual(coolingLines(lines), [coolingLine(T0 + 30 * MINUTE, FABLE_KEY, 1, HELD)]);
    }),
  );

  it.effect("records claim_skipped only when a claim is held back", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(12, BUILDING, REPO, true);
      fake.advances[`${REPO}#12`] = [limited(T0 - 1000)];
      fake.projectModels[OTHER] = OPUS;
      fake.ready[OTHER] = [4];
      fake.pushStart(`${OTHER}#4`, started(4, OTHER));
      yield* pass(fake, [REPO, OTHER], 5);
      assert.deepEqual(starts(fake), [`start ${OTHER}#4`]);
      assert.deepEqual(coolingSkips(fake), []);
    }),
  );

  it.effect("a project model that cannot be read holds that repo's claims, with an error", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(12, BUILDING, REPO, true);
      fake.advances[`${REPO}#12`] = [limited(T0 - 1000)];
      fake.projectModels[REPO] = "error";
      fake.ready[REPO] = [20];
      fake.pushStart(`${REPO}#20`, started(20));
      const { report, lines } = yield* pass(fake, [REPO], 5);
      assert.deepEqual(starts(fake), []);
      assert.equal(report.errors, 1);
      assert.ok(
        lines.includes("error: rawphp/softfac: cannot read the T3 project's model: store down"),
        lines.join("\n"),
      );
      assert.deepEqual(
        fake.events.filter((e) => e.event === "claim_skipped"),
        [{ event: "claim_skipped", data: { repo: REPO, reason: "model-unread" } }],
      );
    }),
  );

  it.effect("a project with no model is left to the claim, which says why", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(12, BUILDING, REPO, true);
      fake.advances[`${REPO}#12`] = [limited(T0 - 1000)];
      fake.projectModels[REPO] = null;
      fake.ready[REPO] = [20];
      fake.pushStart(`${REPO}#20`, started(20));
      yield* pass(fake, [REPO], 5);
      assert.deepEqual(starts(fake), [`start ${REPO}#20`]);
    }),
  );

  it.effect("a resume that fails is an error, and one with nothing to resume is left alone", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(12, BUILDING, REPO, true);
      fake.runIn(13, BUILDING, REPO, true);
      fake.modelFallbacks = { "claude-fable-5-1": "claude-opus-5-5" };
      fake.advances[`${REPO}#12`] = [limited(T0 - 1000)];
      fake.advances[`${REPO}#13`] = [limited(T0 - 1000)];
      fake.cooledResumes[`${REPO}#12`] = [new NotBuildingError({ run: rid(12) })];
      fake.cooledResumes[`${REPO}#13`] = [{ kind: "unchanged", why: "its thread is gone" }];
      const { report, lines } = yield* pass(fake, [REPO], 5);
      assert.equal(report.errors, 1);
      assert.ok(
        lines.some((l) => l.startsWith("error: rawphp/softfac#12 resume after the rate limit: ")),
        lines.join("\n"),
      );
      assert.equal(
        lineFor(lines, 13),
        `rawphp/softfac#13 building: session hit the provider's rate limit on ${FABLE_KEY}, but its thread is gone; left alone`,
      );
    }),
  );

  it.effect("a session whose launch named no model waits out a backoff of its own", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runIn(12, BUILDING, REPO, true);
      fake.advances[`${REPO}#12`] = [limited(T0 - 1000, null)];
      fake.ready[REPO] = [20];
      fake.pushStart(`${REPO}#20`, started(20));
      const { lines } = yield* pass(fake, [REPO], 5);
      assert.deepEqual(cooledResumes(fake), []);
      assert.deepEqual(starts(fake), [`start ${REPO}#20`]);
      assert.equal(coolingLines(lines).length, 1);
      assert.ok(coolingLines(lines)[0]!.endsWith("; its sessions wait for it to end"));
    }),
  );
});

describe("pruning t3/* branches", () => {
  const prunes = (fake: Fake) => fake.calls.filter((c) => c.startsWith("prune "));
  const SHA = "a".repeat(40);

  it.effect("prunes each watched repo's branches at most once an hour", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      yield* pass(fake, [REPO, OTHER], 1);
      fake.now += PRUNE_EVERY_MS - 1;
      yield* pass(fake, [REPO, OTHER], 1);
      assert.deepEqual(prunes(fake), [`prune ${REPO}`, `prune ${OTHER}`]);
      fake.now += 1;
      yield* pass(fake, [REPO, OTHER], 1);
      assert.deepEqual(prunes(fake), [
        `prune ${REPO}`,
        `prune ${OTHER}`,
        `prune ${REPO}`,
        `prune ${OTHER}`,
      ]);
    }),
  );

  it.effect("prunes after the pass has claimed and launched", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.ready[REPO] = [3];
      fake.pushStart(`${REPO}#3`, started(3));
      yield* pass(fake, [REPO], 1);
      const start = fake.calls.indexOf(`start ${REPO}#3`);
      assert.isAbove(start, -1);
      assert.isAbove(fake.calls.indexOf(`prune ${REPO}`), start);
    }),
  );

  it.effect("prunes nothing while the ledger cannot be read", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.runsError = true;
      yield* pass(fake, [REPO], 1);
      assert.deepEqual(prunes(fake), []);
    }),
  );

  it.effect("says what it pruned and what it left", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.prunes[REPO] = {
        pruned: [{ ref: "refs/heads/t3/a", sha: SHA, scope: "local", reason: "merged" }],
        left: [{ ref: "refs/remotes/origin/t3/b", why: "it moved on GitHub" }],
        failed: [],
        waiting: 3,
      };
      const { lines, report } = yield* pass(fake, [REPO], 1);
      assert.include(lines, `${REPO}: pruned refs/heads/t3/a at ${SHA} (merged)`);
      assert.include(lines, `${REPO}: left refs/remotes/origin/t3/b: it moved on GitHub`);
      assert.include(lines, `${REPO}: 3 remote branches wait for the next prune`);
      assert.equal(report.errors, 0);
    }),
  );

  it.effect("counts each deletion that failed as an error", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.prunes[REPO] = {
        pruned: [],
        left: [],
        failed: [
          { ref: "refs/remotes/origin/t3/b", kind: "github", why: "GitHub refused: HTTP 403" },
          { ref: "refs/heads/t3/c", kind: "git", why: "cannot lock ref" },
        ],
        waiting: 0,
      };
      const { lines, report } = yield* pass(fake, [REPO], 1);
      assert.include(
        lines,
        `error: ${REPO}: branch prune: refs/remotes/origin/t3/b: GitHub refused: HTTP 403`,
      );
      assert.include(lines, `error: ${REPO}: branch prune: refs/heads/t3/c: cannot lock ref`);
      assert.equal(report.errors, 2);
    }),
  );

  it.effect("a prune that fails is an error line, tried again an hour later", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.prunes[REPO] = { kind: "git", message: "cannot write the prune log" };
      const { lines, report } = yield* pass(fake, [REPO], 1);
      assert.include(lines, `error: ${REPO}: branch prune: cannot write the prune log`);
      assert.equal(report.errors, 1);
      yield* pass(fake, [REPO], 1);
      assert.deepEqual(prunes(fake), [`prune ${REPO}`]);
    }),
  );
});

describe("the host loads", () => {
  const host = (id: string, ssh = `me@${id}`): HostConfig => ({
    id,
    name: `name-${id}`,
    ssh,
    maxRuns: 2,
    maxLoadPerCore: 1,
  });
  const GOOD: SshAnswer = { exitCode: 0, timedOut: false, stdout: "0.5 0.5 0.5 1/2 3\n4\n", stderr: "" };
  const unreachable = (fake: Fake, id: string) =>
    fake.items.filter((item) => item.id === `${HOST_UNREACHABLE_PREFIX}${id}`);
  const sshOf = (fake: Fake) => fake.calls.filter((call) => call.startsWith("ssh "));

  it.effect("reads every host once a pass, before any launch, and keeps the loads", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.hosts = [host("a"), host("b")];
      fake.sshAnswers = { "me@a": GOOD, "me@b": { ...GOOD, stdout: "{ 2.50 1 1 }\n8\n" } };
      fake.ready[REPO] = [1];
      yield* pass(fake, [REPO], 5);
      assert.deepEqual(sshOf(fake).sort(), ["ssh me@a", "ssh me@b"]);
      const lastSsh = Math.max(...fake.calls.flatMap((call, i) => (call.startsWith("ssh ") ? [i] : [])));
      const firstStart = fake.calls.findIndex((call) => call.startsWith("start "));
      assert.isTrue(firstStart > lastSsh, JSON.stringify(fake.calls));
      assert.deepEqual([...fake.hostLoads.entries()], [
        ["a", { oneMinute: 0.5, cores: 4 }],
        ["b", { oneMinute: 2.5, cores: 8 }],
      ]);
      yield* pass(fake, [REPO], 5);
      assert.equal(sshOf(fake).length, 4);
    }),
  );

  it.effect("a failed read is a null load and a line, and takes no item before the third pass", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.hosts = [host("a")];
      for (const n of [1, 2]) {
        const { lines, report } = yield* pass(fake, [REPO], 5);
        assert.strictEqual(fake.hostLoads.get("a"), null);
        assert.deepEqual(
          lines.filter((l) => l.startsWith("host ")),
          ["host name-a: its load was not read over ssh (exit 255: Connection refused); it takes no run this pass"],
        );
        assert.equal(fake.hostMisses.get("a"), n);
        assert.deepEqual(unreachable(fake, "a"), []);
        assert.equal(report.attention, 0);
      }
    }),
  );

  it.effect("three failed passes raise one host-unreachable item; a good read clears it and the count", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.hosts = [host("a")];
      assert.equal(HOST_UNREACHABLE_PASSES, 3);
      for (let n = 0; n < 3; n++) yield* pass(fake, [REPO], 5);
      const items = unreachable(fake, "a");
      assert.equal(items.length, 1);
      assert.deepEqual(
        { kind: items[0]!.kind, repo: items[0]!.repo, issue: items[0]!.issue, run: items[0]!.run },
        { kind: "attention", repo: null, issue: null, run: null },
      );
      assert.equal(
        items[0]!.message,
        "host name-a (me@a) has not answered over ssh for 3 passes; it takes no run until it does",
      );
      const fourth = yield* pass(fake, [REPO], 5);
      assert.equal(unreachable(fake, "a").length, 1);
      assert.equal(fourth.report.attention, 1);
      fake.sshAnswers = { "me@a": GOOD };
      yield* pass(fake, [REPO], 5);
      assert.deepEqual(unreachable(fake, "a"), []);
      assert.equal(fake.hostMisses.has("a"), false);
      assert.deepEqual(fake.hostLoads.get("a"), { oneMinute: 0.5, cores: 4 });
    }),
  );

  it.effect("an answer the runner cannot read counts as a failed read", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.hosts = [host("a")];
      fake.sshAnswers = { "me@a": { ...GOOD, stdout: "hello\n" } };
      const { lines } = yield* pass(fake, [REPO], 5);
      assert.strictEqual(fake.hostLoads.get("a"), null);
      assert.include(lines.join("\n"), "the load answer is not one the runner reads");
    }),
  );

  it.effect("a host that leaves the config is forgotten, and its item cleared", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.hosts = [host("a"), host("b")];
      fake.sshAnswers = { "me@b": GOOD };
      for (let n = 0; n < 3; n++) yield* pass(fake, [REPO], 5);
      assert.equal(unreachable(fake, "a").length, 1);
      fake.hosts = [host("b")];
      yield* pass(fake, [REPO], 5);
      assert.deepEqual(unreachable(fake, "a"), []);
      assert.deepEqual([...fake.hostLoads.keys()], ["b"]);
      assert.deepEqual([...fake.hostMisses.keys()], []);
    }),
  );

  it.effect("with no hosts nothing is read and nothing changes", () =>
    Effect.gen(function* () {
      const fake = new Fake();
      fake.ready[REPO] = [1];
      const { report } = yield* pass(fake, [REPO], 5);
      assert.deepEqual(sshOf(fake), []);
      assert.equal(fake.hostLoads.size, 0);
      assert.equal(report.attention, 0);
    }),
  );
});
