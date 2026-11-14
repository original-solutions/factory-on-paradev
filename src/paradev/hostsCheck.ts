/**
 * `factory-runner hosts check`: the ten checks a host must pass before it gets runs, read over SSH
 * and through the Superset CLI, each with the fix the person runs when it fails. It writes nothing
 * on the host (decision U4). The same checks run at `install`, and beside the pass: every host
 * right after each config load, then a host that is not ready every 5 minutes and a ready one
 * every hour. A host that fails raises one `host-not-ready` attention item and is not a launch
 * candidate until a check passes.
 */
import * as Effect from "effect/Effect";

import type { NewItem } from "../attention.ts";
import type { HostConfig, MachineConfig } from "../config.ts";
import { CLI_ENV, classify } from "./cli.ts";
import {
  CLAUDE_VERSION,
  fromCommandRunner,
  GH_AUTH_STATUS,
  GIT_EMAIL,
  PROXY_ENV_READ,
  remoteUrl,
  runSsh,
  shellQuote,
  trustRead,
  TRUE_COMMAND,
  type SshReadError,
  type SshSpawn,
  type SyncCommandResult,
  type SyncCommandRun,
} from "./ssh.ts";

/** What the checks read from: a host over ssh, and the Superset CLI. */
export interface HostCheckIo {
  readonly ssh: SshSpawn;
  /** Runs `superset <argv> --json`: the parsed answer, or the error text. */
  readonly superset: (argv: ReadonlyArray<string>) => Effect.Effect<unknown, string>;
}

/** How the checks ask the Paradev CLI: the parsed answer, or the error text. */
export type CliCall = HostCheckIo["superset"];

/**
 * One check's result: `text` is `ok` or the fix; the line printed is `<check>: <text>`, then
 * ` (<detail>)` when there is a cause to show. The detail is volatile (an error's wording), so
 * the attention item is built from the check and text alone.
 */
export interface CheckLine {
  readonly check: string;
  readonly ok: boolean;
  readonly text: string;
  readonly detail?: string;
}

/** The id prefix of a host's `host-not-ready` attention item; the host id follows. */
export const HOST_NOT_READY_PREFIX = "host-not-ready:";

const PROXY_KEYS = ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"] as const;
const SSH_SKIPPED = "not checked: ssh failed";
const CLI_SKIPPED = "not checked: superset projects list --host failed";

/** The fix when the host is not in `hosts list` or is offline. */
const addHostFix = (host: HostConfig): string =>
  `add it with superset hosts add ${host.ssh} --name ${host.name}, or start its host service (sh.superset.host)`;

/** Sets `hasTrustDialogAccepted` for the folder in `~/.claude.json`. Printed for the person to run on the host, never sent. */
const TRUST_FIX_SCRIPT =
  'import json,os,sys;f=os.path.expanduser("~/.claude.json");d=json.load(open(f));' +
  'd.setdefault("projects",{}).setdefault(sys.argv[1],{})["hasTrustDialogAccepted"]=True;' +
  'json.dump(d,open(f,"w"),indent=2)';

/** The cause to show after the fix when `tool` is not on a non-interactive ssh shell's PATH (exit 127); else none. */
const missingFrom = (
  answer: { readonly _tag: "Failure"; readonly failure: SshReadError } | { readonly _tag: "Success" },
  tool: string,
): string | undefined =>
  answer._tag === "Failure" && answer.failure.message.startsWith("exit 127")
    ? `${tool} is not on the PATH of a non-interactive ssh shell; add its folder (e.g. /opt/homebrew/bin or ~/.local/bin) to PATH in ~/.zshenv on the host`
    : undefined;

/** The one-liner the trusted fix prints for `path`. */
export const trustFixCommand = (path: string): string =>
  `python3 -c '${TRUST_FIX_SCRIPT}' ${shellQuote(path)}`;

/** The last folder of a path: the project name `projects create` is given. */
const lastFolder = (path: string): string => path.split("/").filter((part) => part !== "").at(-1) ?? path;

/** Whether `url` is `repo`'s GitHub URL, over https or ssh, with or without `.git`, in any case. */
const isRepoUrl = (url: string, repo: string): boolean => {
  const found = /^(?:https:\/\/github\.com\/|git@github\.com:)(.+?)(?:\.git)?$/.exec(url.trim());
  return found !== null && found[1]!.toLowerCase() === repo.toLowerCase();
};

const rowsOf = (answer: unknown): ReadonlyArray<Record<string, unknown>> =>
  Array.isArray(answer)
    ? answer.filter((row): row is Record<string, unknown> => typeof row === "object" && row !== null)
    : [];

const line = (check: string, fix: string | null, detail?: string): CheckLine =>
  fix === null
    ? { check, ok: true, text: "ok" }
    : { check, ok: false, text: fix, ...(detail !== undefined && { detail }) };

/**
 * The proxy env fix: the missing names when the host printed only names, else both. What the host
 * printed is never echoed, since a wrong script or file could put the token's value there.
 */
const proxyFix = (stdout: string): string | null => {
  const names = stdout.split("\n").map((name) => name.trim()).filter((name) => name !== "");
  if (names.length === 0) return null;
  const known = names.every((name) => (PROXY_KEYS as ReadonlyArray<string>).includes(name));
  return `add ${(known ? names : PROXY_KEYS).join(" and ")} to env in ~/.claude/settings.json on the host`;
};

/**
 * Runs the ten checks of the spec's table for one host, in its order: online, ssh, cli, then clone,
 * project and trusted for each repo that lists the host, then proxy env, git identity, gh and
 * claude. `hosts list` and `projects list --host` are read once. When ssh fails the later ssh
 * lines are `not checked`; when the CLI fails the project lines are.
 */
export const checkHost = (
  io: HostCheckIo,
  machine: MachineConfig,
  host: HostConfig,
): Effect.Effect<ReadonlyArray<CheckLine>> =>
  Effect.gen(function* () {
    const ssh = (command: string) => Effect.result(runSsh(io.ssh, host.ssh, command));
    const repos = machine.repos.flatMap((entry) =>
      (entry.hosts ?? [])
        .filter((on) => on.id === host.id)
        .map((on) => ({ repo: entry.repo, path: on.path })),
    );
    const lines: Array<CheckLine> = [];

    const hostsList = yield* Effect.result(io.superset(["hosts", "list"]));
    const online =
      hostsList._tag === "Success" &&
      rowsOf(hostsList.success).some((row) => row["id"] === host.id && row["online"] === "yes");
    lines.push(
      line(
        "online",
        online
          ? null
          : addHostFix(host),
        hostsList._tag === "Failure" ? `superset hosts list failed: ${hostsList.failure}` : undefined,
      ),
    );

    const reached = yield* ssh(TRUE_COMMAND);
    const sshOk = reached._tag === "Success";
    lines.push(
      line(
        "ssh",
        sshOk
          ? null
          : `install this Mac's ssh key on the host: ssh-copy-id ${host.ssh}`,
        sshOk ? undefined : `ssh -o BatchMode=yes ${host.ssh} true failed: ${reached.failure.message}`,
      ),
    );

    const projects = yield* Effect.result(io.superset(["projects", "list", "--host", host.id]));
    lines.push(
      line(
        "cli",
        projects._tag === "Success"
          ? null
          : addHostFix(host),
        projects._tag === "Failure"
          ? `superset projects list --host ${host.id} failed: ${projects.failure}`
          : undefined,
      ),
    );

    const skipped = (check: string, text: string): CheckLine => ({ check, ok: false, text });
    for (const { repo, path } of repos) {
      const check = `clone ${repo}`;
      if (!sshOk) {
        lines.push(skipped(check, SSH_SKIPPED));
        continue;
      }
      const url = yield* ssh(remoteUrl(path));
      const matches = url._tag === "Success" && isRepoUrl(url.success, repo);
      lines.push(line(check, matches ? null : `clone it on the host: git clone https://github.com/${repo} ${path}`));
    }
    for (const { repo, path } of repos) {
      const check = `project ${repo}`;
      if (projects._tag === "Failure") {
        lines.push(skipped(check, CLI_SKIPPED));
        continue;
      }
      const has = rowsOf(projects.success).some((row) => row["path"] === path);
      lines.push(
        line(check, has ? null : `superset projects create --host ${host.id} --name ${lastFolder(path)} --import ${path}`),
      );
    }
    for (const { repo, path } of repos) {
      const check = `trusted ${repo}`;
      if (!sshOk) {
        lines.push(skipped(check, SSH_SKIPPED));
        continue;
      }
      const trust = yield* ssh(trustRead(path));
      const trusted = trust._tag === "Success" && trust.success.trim() === "yes";
      lines.push(
        line(
          check,
          trusted
            ? null
            : `open Claude Code once in ${path} on the host and accept the trust dialog, or run this on the host: ${trustFixCommand(path)}`,
        ),
      );
    }

    if (!sshOk) {
      for (const check of ["proxy env", "git identity", "gh", "claude"]) lines.push(skipped(check, SSH_SKIPPED));
      return lines;
    }
    const proxy = yield* ssh(PROXY_ENV_READ);
    lines.push(line("proxy env", proxy._tag === "Success" ? proxyFix(proxy.success) : proxyFix(PROXY_KEYS.join("\n"))));
    const email = yield* ssh(GIT_EMAIL);
    lines.push(
      line(
        "git identity",
        email._tag === "Success" && email.success.trim() !== ""
          ? null
          : "git config --global user.email <your GitHub email> on the host",
      ),
    );
    const gh = yield* ssh(GH_AUTH_STATUS);
    lines.push(
      line(
        "gh",
        gh._tag === "Success" ? null : "gh auth login on the host",
        missingFrom(gh, "gh"),
      ),
    );
    const claude = yield* ssh(CLAUDE_VERSION);
    lines.push(
      line(
        "claude",
        claude._tag === "Success"
          ? null
          : "install Claude Code on the host",
        missingFrom(claude, "claude"),
      ),
    );
    return lines;
  });

/** What a host's check prints: its name and ssh destination, then one indented `<check>: <text>` per line, with ` (<detail>)` after a fix that has a cause. */
export const formatHostCheck = (
  host: HostConfig,
  lines: ReadonlyArray<CheckLine>,
): ReadonlyArray<string> => [
  `${host.name} (${host.ssh})`,
  ...lines.map(
    (entry) =>
      `  ${entry.check}: ${entry.text}${entry.detail === undefined ? "" : ` (${entry.detail})`}`,
  ),
];

/** `<check>: <text>` of the first failing line; null when every line is ok. */
export const firstFailure = (lines: ReadonlyArray<CheckLine>): string | null => {
  const failed = lines.find((entry) => !entry.ok);
  return failed === undefined ? null : `${failed.check}: ${failed.text}`;
};

/** The attention item of a host that failed its check, naming its first failing line. */
export const hostNotReadyItem = (host: HostConfig, failing: string): NewItem => ({
  id: `${HOST_NOT_READY_PREFIX}${host.id}`,
  kind: "attention",
  repo: null,
  issue: null,
  run: null,
  message: `host ${host.name} is not ready: ${failing}; it takes no run until its check passes (checked again every 5 minutes; factory-runner hosts check ${host.name} prints every line)`,
});

/** The error text of a failed CLI call: its `Error:` line, else the stderr's own text, else how it ended. */
const cliErrorText = (done: SyncCommandResult): string =>
  done.stderr.trim() === ""
    ? done.status === null
      ? "did not run"
      : `exit ${done.status}`
    : classify(done.stderr).text.split("\n")[0]!;

/**
 * The checks' io over a synchronous command runner: ssh by `ssh`, the CLI at `cli` with `--json`
 * for 30 s. Each gets only its own environment names (`SSH_ENV`, and the CLI's `CLI_ENV`), so a
 * token exported in the shell reaches neither.
 */
export const hostCheckIoFromCommands = (run: SyncCommandRun, cli: string): HostCheckIo => ({
  ssh: fromCommandRunner(run),
  superset: (argv) =>
    Effect.suspend(() => {
      const done = run(cli, [...argv, "--json"], 30_000, CLI_ENV);
      if (done.status !== 0) return Effect.fail(cliErrorText(done));
      return Effect.try({
        try: (): unknown => JSON.parse(done.stdout),
        catch: (error) => `the answer is not JSON: ${error instanceof Error ? error.message : String(error)}`,
      });
    }),
});

/**
 * Runs and prints `hosts check` for each of `hosts`, one after another, as the CLI and install do:
 * each host's lines, then for a host that fails, that it gets no run. True when every line is ok.
 */
export const printHostChecks = async (
  run: SyncCommandRun,
  config: MachineConfig,
  hosts: ReadonlyArray<HostConfig>,
  out: (line: string) => void,
): Promise<boolean> => {
  const io = hostCheckIoFromCommands(run, config.paradev.cli);
  let ok = true;
  for (const host of hosts) {
    const lines = await Effect.runPromise(checkHost(io, config, host));
    for (const text of formatHostCheck(host, lines)) out(text);
    if (firstFailure(lines) !== null) {
      ok = false;
      out(`host ${host.name} is not ready; the runner gives it no run until its check passes`);
    }
  }
  return ok;
};
