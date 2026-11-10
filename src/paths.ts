import * as NodeOS from "node:os";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

/**
 * Where the runner keeps and finds things on this machine. Its data dir is
 * `FACTORY_RUNNER_HOME` when set, else `~/.config/factory-runner`. The factory's data and its
 * machine config, `<data>/config.yml`, live there together (the softfac ledger layout, so its
 * retro can read it). `worktreesDir` is where Paradev puts a local worktree by default,
 * `~/.paradev/worktrees`.
 */
export class FactoryPaths extends Context.Service<
  FactoryPaths,
  {
    readonly baseDir: string;
    readonly worktreesDir: string;
    readonly factoryDir: string;
    readonly machineConfigPath: string;
  }
>()("factory-runner/paths/FactoryPaths") {}

/** The data dir from `env` and the home dir: `FACTORY_RUNNER_HOME`, else `<home>/.config/factory-runner`. */
export const dataDirOf = (
  env: { readonly FACTORY_RUNNER_HOME?: string | undefined },
  home: string,
  path: Path.Path,
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
    };
  }),
);
