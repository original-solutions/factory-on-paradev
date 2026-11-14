/** The target of a thread that runs on this Mac: the worktree, its agent and its sessions are all here. */
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

import type { RunResult, RunSpawnError } from "../../process.ts";
import type { AgentProcess } from "../sessions.ts";
import type { ThreadRecord } from "../state.ts";
import {
  archiveWorkspaceAt,
  claudeProjectFolder,
  type Cli,
  type GitOptions,
  type GitRepo,
  type ParadevAdapterError,
  type ParadevTarget,
  readWorktreeWorkspace,
  SESSION_ID,
} from "./target.ts";

/** What the module needs of the adapter. */
export interface LocalDeps {
  readonly cli: Cli;
  /** The location flag of this target. */
  readonly at: ReadonlyArray<string>;
  readonly fs: FileSystem.FileSystem;
  readonly processes: AgentProcess["Service"];
  /** The process a record's preset runs. */
  readonly commandOf: (record: ThreadRecord) => string;
  /** Claude's own session store. */
  readonly claudeProjectsDir: string;
  /** The hardened repository of a directory a session can write. */
  readonly sessionRepo: (dir: string) => Effect.Effect<GitRepo, ParadevAdapterError | RunSpawnError>;
  /** Plain `git` and `git` that must exit 0, in a directory. */
  readonly git: (dir: string, args: ReadonlyArray<string>, options?: GitOptions) => Effect.Effect<RunResult, RunSpawnError>;
  readonly gitOk: (
    dir: string,
    args: ReadonlyArray<string>,
    options?: GitOptions,
  ) => Effect.Effect<string, RunSpawnError | ParadevAdapterError>;
}

export const makeLocalTarget = (deps: LocalDeps): ParadevTarget => {
  const { cli, at, fs, processes, commandOf, claudeProjectsDir, sessionRepo, git, gitOk } = deps;

  /**
   * The id of the newest session Claude keeps for `worktreePath`: the newest `*.jsonl` under its
   * projects folder, named as Claude names it: the path with every character other than a letter or
   * digit as `-`. Null when there is none.
   */
  const newestSession = (worktreePath: string) =>
    Effect.gen(function* () {
      const folder = `${claudeProjectsDir}/${claudeProjectFolder(worktreePath)}`;
      const names = yield* fs.readDirectory(folder).pipe(
        Effect.catchIf((error) => error.reason._tag === "NotFound", () => Effect.succeed([] as ReadonlyArray<string>)),
      );
      let newest: { readonly id: string; readonly at: number } | null = null;
      for (const name of names) {
        const id = name.endsWith(".jsonl") ? name.slice(0, -".jsonl".length) : "";
        if (!SESSION_ID.test(id)) continue;
        const info = yield* fs.stat(`${folder}/${name}`);
        const at = Option.getOrUndefined(info.mtime)?.getTime() ?? 0;
        if (info.type === "File" && (newest === null || at > newest.at)) newest = { id, at };
      }
      return newest?.id ?? null;
    });

  return {
    at,
    snapshotAt: [],
    onThisMac: true,
    label: "local",
    worktreeRepo: (dir) =>
      sessionRepo(dir).pipe(Effect.map((repo) => ({ ...repo, fetchBase: () => Effect.void }))),
    checkoutRepo: (path) =>
      Effect.gen(function* () {
        if (!(yield* fs.exists(`${path}/.git`))) return null;
        return {
          git: (args: ReadonlyArray<string>, options?: GitOptions) => git(path, args, options),
          gitOk: (args: ReadonlyArray<string>, options?: GitOptions) => gitOk(path, args, options),
        } satisfies GitRepo;
      }),
    agentAlive: (record) =>
      Effect.gen(function* () {
        const path = record.worktreePath;
        return path !== null && (yield* processes.find(commandOf(record), path)) !== null;
      }),
    newestSession: (_record, worktreePath) => newestSession(worktreePath),
    readWorkspace: readWorktreeWorkspace(cli, at),
    archiveWorkspace: archiveWorkspaceAt(cli, at),
    startingHeld: () => Effect.succeed(null),
  };
};
