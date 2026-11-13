/**
 * Reads a host over SSH. Every command the runner sends goes through `runSsh`, which refuses any
 * text that is not one of the shapes below: the read-only commands of the host readings and
 * `hosts check`, and the two writing commands #53 uses to fetch and reset a worktree. Nothing
 * else is ever sent, so a bad path or a bug cannot become a shell on a host. The runner writes
 * nothing in a host's dotfiles (decision U4).
 */
import * as Effect from "effect/Effect";

import type { FactoryProcess } from "../process.ts";

/** What one `ssh` call came to: how it ended and what it printed. */
export interface SshAnswer {
  /** The process's exit code; null when it ended by a signal or never started. */
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs the `ssh` binary with these arguments. Never fails: a spawn error is a null exit code and its text. */
export type SshRunner = (
  args: ReadonlyArray<string>,
  timeoutMs: number,
) => Effect.Effect<SshAnswer>;

/** How long one ssh call may take, connect included. */
export const SSH_TIMEOUT_MS = 10_000;

/** The arguments of one ssh call: no prompts, a 10 s connect, the destination, then the command. */
export const sshArgs = (destination: string, command: string): ReadonlyArray<string> => [
  "-o",
  "BatchMode=yes",
  "-o",
  "ConnectTimeout=10",
  destination,
  command,
];

/** Why a call gave no answer: the command was refused, ssh did not answer in time, or it failed. */
export interface SshError {
  readonly kind: "refused" | "timeout" | "failed";
  readonly message: string;
}

/** `text` as one word of a POSIX shell command line. */
export const shellQuote = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`;

/** The host's load and core count: the text the spec gives, macOS first and Linux as the fallback. */
export const LOAD_COMMAND = "sysctl -n vm.loadavg hw.ncpu 2>/dev/null || (cat /proc/loadavg; nproc)";
/** Whether the host answers over ssh at all. */
export const TRUE_COMMAND = "true";
/** The pids of the host's running Claude processes. */
export const PGREP_CLAUDE = "pgrep -x claude";
/** The working directory of one process. */
export const lsofCwd = (pid: number): string => `lsof -a -d cwd -p ${pid}`;

/** The session files Claude Code keeps for a worktree, newest first. */
export const sessionListing = (worktreePath: string): string =>
  `ls -t ~/.claude/projects/${worktreePath.replaceAll(/[^A-Za-z0-9]/g, "-")}/*.jsonl`;

/** The `origin` URL of the clone at `path`. */
export const remoteUrl = (path: string): string => `git -C ${shellQuote(path)} remote get-url origin`;

/** Prints `yes` when `~/.claude.json` has the folder's trust dialog accepted, else `no`. */
const TRUST_SCRIPT =
  'import json,os,sys;d=json.load(open(os.path.expanduser("~/.claude.json")));' +
  'p=d.get("projects",{}).get(sys.argv[1],{});' +
  'print("yes" if p.get("hasTrustDialogAccepted") is True else "no")';

/** Whether Claude Code trusts the folder at `path` on the host. */
export const trustRead = (path: string): string => `python3 -c '${TRUST_SCRIPT}' ${shellQuote(path)}`;

/** Prints, one per line, the proxy env names that are missing or empty in `~/.claude/settings.json`. Never a value. */
const PROXY_ENV_SCRIPT =
  'import json,os;e=json.load(open(os.path.expanduser("~/.claude/settings.json"))).get("env",{});' +
  '[print(k) for k in ("ANTHROPIC_BASE_URL","ANTHROPIC_AUTH_TOKEN") if not e.get(k)]';

/** The proxy env names the host lacks. */
export const PROXY_ENV_READ = `python3 -c '${PROXY_ENV_SCRIPT}'`;

/** The host's git identity email. */
export const GIT_EMAIL = "git config --global user.email";
/** Whether the host's `gh` is logged in. */
export const GH_AUTH_STATUS = "gh auth status";
/** Whether Claude Code is installed on the host. */
export const CLAUDE_VERSION = "claude --version";

/** Fetches `ref` from `origin` in the worktree. One of the two commands that write (#53). */
export const fetchBase = (worktree: string, ref: string): string =>
  `git -C ${shellQuote(worktree)} fetch origin ${shellQuote(ref)}`;

/** Resets the worktree to a full commit id. One of the two commands that write (#53). */
export const resetToCommit = (worktree: string, commit: string): string => {
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`not a full commit id: ${commit}`);
  return `git -C ${shellQuote(worktree)} reset --hard ${commit}`;
};

const escapeRegExp = (text: string): string => text.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** One shell word in single quotes, where `'\''` is a quote inside it. */
const QUOTED = "'(?:[^']|'\\\\'')*'";

const CONSTANTS: ReadonlySet<string> = new Set([
  LOAD_COMMAND,
  TRUE_COMMAND,
  PGREP_CLAUDE,
  PROXY_ENV_READ,
  GIT_EMAIL,
  GH_AUTH_STATUS,
  CLAUDE_VERSION,
]);

const SHAPES: ReadonlyArray<RegExp> = [
  /^lsof -a -d cwd -p [1-9][0-9]*$/,
  /^ls -t ~\/\.claude\/projects\/[A-Za-z0-9-]+\/\*\.jsonl$/,
  new RegExp(`^git -C ${QUOTED} remote get-url origin$`),
  new RegExp(`^python3 -c '${escapeRegExp(TRUST_SCRIPT)}' ${QUOTED}$`),
  new RegExp(`^git -C ${QUOTED} fetch origin ${QUOTED}$`),
  new RegExp(`^git -C ${QUOTED} reset --hard [0-9a-f]{40}$`),
];

/** Whether `command` is one of the shapes the runner may send to a host. */
export const isAllowed = (command: string): boolean =>
  CONSTANTS.has(command) || SHAPES.some((shape) => shape.test(command));

const firstLine = (text: string): string =>
  text.split("\n").map((line) => line.trim()).find((line) => line !== "") ?? "";

/**
 * Runs one allowed command on `destination` and answers its stdout. A command outside the
 * allowlist is refused before `run` is called.
 */
export const runSsh = (
  run: SshRunner,
  destination: string,
  command: string,
): Effect.Effect<string, SshError> =>
  Effect.gen(function* () {
    if (!isAllowed(command)) {
      return yield* Effect.fail<SshError>({ kind: "refused", message: "the command is not one the runner may send to a host" });
    }
    const done = yield* run(sshArgs(destination, command), SSH_TIMEOUT_MS);
    if (done.timedOut) {
      return yield* Effect.fail<SshError>({ kind: "timeout", message: "no answer within 10 s" });
    }
    if (done.exitCode !== 0) {
      const why = firstLine(done.stderr);
      return yield* Effect.fail<SshError>({
        kind: "failed",
        message:
          done.exitCode === null
            ? `ended by a signal${why === "" ? "" : `: ${why}`}`
            : `exit ${done.exitCode}${why === "" ? "" : `: ${why}`}`,
      });
    }
    return done.stdout;
  });

/** The real runner: the `ssh` binary through the factory's process runner, with the agent socket kept in its environment. */
export const liveSshRunner =
  (process: FactoryProcess["Service"]): SshRunner =>
  (args, timeoutMs) =>
    process
      .run({
        command: "ssh",
        args,
        timeoutMs,
        separateStderr: true,
        termGraceMs: 2_000,
        inheritEnv: ["PATH", "HOME", "USER", "LOGNAME", "LANG", "TMPDIR", "SSH_AUTH_SOCK"],
      })
      .pipe(
        Effect.map(
          (done): SshAnswer => ({
            exitCode: done.exitCode,
            timedOut: done.timedOut,
            stdout: done.tail,
            stderr: done.stderrTail,
          }),
        ),
        Effect.catch((error) =>
          Effect.succeed<SshAnswer>({
            exitCode: null,
            timedOut: false,
            stdout: "",
            stderr: `${error.message}: ${String(error.cause)}`,
          }),
        ),
      );

/** A synchronous command runner (the CLI's and install's) as an `SshRunner`; the command is always `ssh`. */
export const fromCommandRunner =
  (
    run: (
      command: string,
      args: ReadonlyArray<string>,
      timeoutMs: number,
    ) => { readonly status: number | null; readonly stdout: string; readonly stderr: string },
  ): SshRunner =>
  (args, timeoutMs) =>
    Effect.sync(() => {
      const done = run("ssh", args, timeoutMs);
      return {
        exitCode: done.status,
        timedOut: done.status === null && done.stderr.includes("ETIMEDOUT"),
        stdout: done.stdout,
        stderr: done.stderr,
      };
    });
