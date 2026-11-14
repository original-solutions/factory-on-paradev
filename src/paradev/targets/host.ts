/** The target of a thread that runs on a Paradev host: reached with `--host <id>` and, for git and the agent, over SSH. */
import * as Effect from "effect/Effect";

import { callWithRetry, decodeAnswer } from "../call.ts";
import type { ParadevHost } from "../sessions.ts";
import { agentLookup, hostGit, LOOKUP_MARK, newestSessionList, pathExists, type SshRunner } from "../ssh.ts";
import type { ThreadRecord } from "../state.ts";
import {
  archiveWorkspaceAt,
  claudeProjectFolder,
  type Cli,
  type GitOptions,
  type GitRepo,
  gitOkOf,
  type ParadevAdapterError,
  type ParadevTarget,
  readWorktreeWorkspace,
  Screen,
  SESSION_ID,
  STARTING_GRACE_MS,
} from "./target.ts";

/** What Claude Code's trust dialog shows, the one answer the adapter never gives (U4). */
const TRUST_DIALOG = "Yes, I trust this folder";

/** What the module needs of the adapter. */
export interface HostDeps {
  readonly cli: Cli;
  /** The location flag of a host, by machine id. */
  readonly at: (machineId: string) => ReadonlyArray<string>;
  readonly ssh: SshRunner;
  /** The configured host of a machine id; one the config lacks fails. */
  readonly hostOf: (machineId: string) => Effect.Effect<ParadevHost, ParadevAdapterError>;
  /** The process a record's preset runs. */
  readonly commandOf: (record: ThreadRecord) => string;
  /** Each host terminal whose screen was read for the trust dialog, and whether it showed. */
  readonly trustReads: Map<string, boolean>;
}

export const makeHostTarget = (deps: HostDeps, machineId: string): ParadevTarget => {
  const { cli, ssh, hostOf, commandOf, trustReads } = deps;
  const at = deps.at(machineId);

  /**
   * `git` and `gitOk` in a worktree on a host, over SSH with the host's own git and credentials.
   * The pins of `sessionRepo` do not reach a host: what a session there could run, it runs
   * as the same user that runs it.
   */
  const hostRepo = (dir: string) =>
    Effect.gen(function* () {
      const destination = (yield* hostOf(machineId)).ssh;
      const run = (args: ReadonlyArray<string>, given: GitOptions = {}) =>
        ssh.run(destination, hostGit(dir, args, given.pre), { timeoutMs: given.timeoutMs ?? 30_000 });
      return {
        git: run,
        gitOk: (args: ReadonlyArray<string>, given?: GitOptions) => run(args, given).pipe(Effect.flatMap(gitOkOf(args))),
      } satisfies GitRepo;
    });

  /**
   * Whether a host run's agent is alive: the local lookup's `pgrep -x` and `lsof` over SSH, in `sh`
   * whatever the host's login shell, comparing each working directory with the worktree's path as
   * given and as the host resolves it. Null when SSH did not answer, or the lookup did not finish:
   * no `lsof`, a `pgrep` error, no end mark.
   */
  const hostAgentAlive = (record: ThreadRecord, worktreePath: string) =>
    Effect.gen(function* () {
      const destination = (yield* hostOf(machineId)).ssh;
      return yield* ssh.run(destination, agentLookup(commandOf(record), worktreePath)).pipe(
        Effect.map((result) => {
          const lines = result.tail.split("\n").map((line) => line.trim());
          const last = lines.filter((line) => line !== "").at(-1) ?? "";
          if (result.exitCode !== 0 || last !== LOOKUP_MARK) return { unfinished: result.exitCode, last } as const;
          const resolved = lines.find((line) => line.startsWith("W"))?.slice(1) ?? "";
          return lines.some((line) => line === `n${worktreePath}` || (resolved !== "" && line === `n${resolved}`));
        }),
        // Exit 3: no `lsof` on the host's PATH, or `pgrep` failed. Said each time, as nothing else shows it.
        Effect.flatMap((answer) =>
          typeof answer === "boolean"
            ? Effect.succeed(answer)
            : Effect.logWarning(
                `the agent lookup of ${record.threadId} on host ${machineId} did not finish (exit ${answer.unfinished}${
                  answer.last === "" ? "" : `, last line ${answer.last}`
                }); is lsof on the PATH of a non-interactive ssh?`,
              ).pipe(Effect.as(null)),
        ),
        Effect.catch((error) =>
          Effect.logWarning(`could not read whether ${record.threadId}'s agent is alive: ${error.message}`).pipe(
            Effect.as(null),
          ),
        ),
      );
    });

  /**
   * {@link ParadevTarget.newestSession} on a host: `ls -t` of Claude's folder for the worktree under
   * the host's `~/.claude/projects`, over SSH, never through a Paradev terminal, whose read wraps at
   * the terminal's width.
   */
  const newestHostSession = (worktreePath: string) =>
    Effect.gen(function* () {
      const destination = (yield* hostOf(machineId)).ssh;
      const listed = yield* ssh.run(destination, newestSessionList(claudeProjectFolder(worktreePath)));
      const newest = listed.tail.trim().split("/").at(-1) ?? "";
      const id = newest.endsWith(".jsonl") ? newest.slice(0, -".jsonl".length) : "";
      return listed.exitCode === 0 && SESSION_ID.test(id) ? id : null;
    });

  /**
   * Whether the host terminal's screen shows Claude Code's trust dialog. The screen is read once
   * per terminal; a read that failed is tried again next time.
   */
  const trustDialogShown = (record: ThreadRecord, terminal: string) =>
    Effect.gen(function* () {
      const key = `${record.workspaceId}/${terminal}`;
      const known = trustReads.get(key);
      if (known !== undefined) return known;
      const argv = ["terminals", "read", ...at, "--workspace", record.workspaceId, "--terminal", terminal, "--max-lines", "40"];
      const shown = yield* callWithRetry(cli, argv, 30_000).pipe(
        Effect.flatMap((answer) => decodeAnswer(Screen, answer, argv)),
        Effect.map(({ text }) => text.includes(TRUST_DIALOG)),
        Effect.catch((error) =>
          Effect.logWarning(`could not read the screen of ${record.threadId}: ${error.message}`).pipe(Effect.as(null)),
        ),
      );
      if (shown !== null) trustReads.set(key, shown);
      return shown === true;
    });

  return {
    at,
    snapshotAt: at,
    onThisMac: false,
    label: "host",
    worktreeRepo: (dir) =>
      Effect.gen(function* () {
        const repo = yield* hostRepo(dir);
        return {
          ...repo,
          // The base was fetched on this Mac; a host's clone fetches it for itself, with its own
          // credentials, before the reset to the commit fetched here.
          fetchBase: (baseRef: string) =>
            repo.gitOk(["fetch", "--quiet", "origin", baseRef], { timeoutMs: 120_000 }).pipe(Effect.asVoid),
        };
      }),
    checkoutRepo: (path) =>
      Effect.gen(function* () {
        const repo = yield* hostRepo(path);
        const destination = (yield* hostOf(machineId)).ssh;
        if ((yield* ssh.run(destination, pathExists(`${path}/.git`))).exitCode !== 0) return null;
        return repo;
      }),
    agentAlive: (record) => {
      const path = record.worktreePath;
      return path === null ? Effect.succeed(false) : hostAgentAlive(record, path);
    },
    newestSession: (_record, worktreePath) => newestHostSession(worktreePath),
    readWorkspace: readWorktreeWorkspace(cli, at),
    archiveWorkspace: archiveWorkspaceAt(cli, at),
    startingHeld: (record, terminal, explained, now) =>
      Effect.gen(function* () {
        // Held at `Attached` this long on a host: Claude Code's trust dialog may hold the prompt.
        // `targetFor` hands this module only host records; the kind test narrows the type for `name`.
        if (
          record.target.kind === "host" &&
          explained.lastEventType === "Attached" &&
          explained.lastEventAt !== null &&
          now - explained.lastEventAt > STARTING_GRACE_MS &&
          (yield* trustDialogShown(record, terminal))
        ) {
          return `the host's clone is not trusted by Claude Code; run factory-runner hosts check ${record.target.name}`;
        }
        return null;
      }),
  };
};
