import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

/**
 * Where the runner keeps and finds things on this machine. Its data dir is
 * `FACTORY_RUNNER_HOME` when set, else `~/.config/factory-runner`. The factory's data and its
 * machine config, `<data>/config.yml`, live there together (the softfac ledger layout, so its
 * retro can read it). `worktreesDir` is where Paradev puts a local worktree by default,
 * `~/.paradev/worktrees`. `claudeProjectsDir` is Claude's session store, `~/.claude/projects`.
 */
export class FactoryPaths extends Context.Service<
  FactoryPaths,
  {
    readonly baseDir: string;
    readonly worktreesDir: string;
    readonly factoryDir: string;
    readonly machineConfigPath: string;
    readonly claudeProjectsDir: string;
  }
>()("factory-runner/paths/FactoryPaths") {}

/** The data dir from `env` and the home dir: `FACTORY_RUNNER_HOME`, else `<home>/.config/factory-runner`. */
export const dataDirOf = (
  env: { readonly FACTORY_RUNNER_HOME?: string | undefined },
  home: string,
  path: Pick<Path.Path, "resolve" | "join">,
): string => {
  const set = env.FACTORY_RUNNER_HOME;
  return set !== undefined && set !== ""
    ? path.resolve(set)
    : path.join(home, ".config", "factory-runner");
};

/** Reads `FACTORY_RUNNER_HOME` and the home dir from the process. */
export const layer = Layer.effect(
  FactoryPaths,
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const home = NodeOS.homedir();
    const dataDir = dataDirOf(process.env, home, path);
    return {
      baseDir: dataDir,
      worktreesDir: path.join(home, ".paradev", "worktrees"),
      factoryDir: dataDir,
      machineConfigPath: path.join(dataDir, "config.yml"),
      claudeProjectsDir: path.join(home, ".claude", "projects"),
    };
  }),
);

/** The launchd label of the runner agent. */
export const LABEL = "io.github.original-solutions.factory-runner";
/** The launchd label of the agent that rotates the runner's log. */
export const LOGROTATE_LABEL = "io.github.original-solutions.factory-runner.logrotate";

/**
 * Where `install` puts things under `home`: the share folder with its `versions/` and the
 * `current` link, the two LaunchAgent files, and the log folder with the runner's log and the
 * rotation agent's own.
 */
export const installPathsOf = (home: string) => {
  const share = NodePath.join(home, ".local", "share", "factory-runner");
  const launchAgents = NodePath.join(home, "Library", "LaunchAgents");
  const logDir = NodePath.join(home, "Library", "Logs", "factory-runner");
  return {
    share,
    versions: NodePath.join(share, "versions"),
    current: NodePath.join(share, "current"),
    launchAgents,
    runnerPlist: NodePath.join(launchAgents, `${LABEL}.plist`),
    rotatePlist: NodePath.join(launchAgents, `${LOGROTATE_LABEL}.plist`),
    logDir,
    log: NodePath.join(logDir, "runner.log"),
    rotateLog: NodePath.join(logDir, "logrotate.log"),
  };
};

/** The `version` of the `package.json` in `packageRoot`. */
export const packageVersion = (packageRoot: string): string =>
  (
    JSON.parse(NodeFS.readFileSync(NodePath.join(packageRoot, "package.json"), "utf8")) as {
      version: string;
    }
  ).version;
