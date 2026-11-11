/**
 * The Paradev projects on this Mac, from `projects list --local`: a watched repo's clone is the
 * project whose `path` is the same folder.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { type CliError, SupersetCli } from "./cli.ts";
import { callWithRetry, decodeAnswer } from "./call.ts";

const Projects = Schema.Array(
  Schema.Struct({ id: Schema.String, name: Schema.String, path: Schema.String, repo: Schema.String }),
);
export type ParadevProject = (typeof Projects.Type)[number];

/** `projects list --local`: 30 s, one retry after 2 s. */
export const listProjects: Effect.Effect<ReadonlyArray<ParadevProject>, CliError, SupersetCli> =
  Effect.gen(function* () {
    const cli = yield* SupersetCli;
    const argv = ["projects", "list", "--local"];
    const answer = yield* callWithRetry(cli, argv, 30_000);
    return yield* decodeAnswer(Projects, answer, argv);
  });

/** `path` with its symlinks resolved; the path itself, resolved, when it does not exist. */
const realPath = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    return yield* fs.realPath(path).pipe(Effect.orElseSucceed(() => paths.resolve(path)));
  });

/** The project whose path is the same folder as `root`, compared by realpath; null when none. */
export const projectAt = Effect.fn("ParadevProjects.projectAt")(function* (
  projects: ReadonlyArray<ParadevProject>,
  root: string,
) {
  const want = yield* realPath(root);
  for (const project of projects) {
    if ((yield* realPath(project.path)) === want) return project;
  }
  return null;
});
