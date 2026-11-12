import * as Result from "effect/Result";

import { asciiLower } from "../ledger/runId.ts";
import type { FactoryProject, Model } from "../sessions.ts";
import { NO_DEFAULT_MODEL, NO_PROJECT, otherRepoProject } from "./messages.ts";

/** A project a session can be launched on: it has a model. */
export interface LaunchableProject {
  readonly id: string;
  readonly model: Model;
}

/** Whether `project` names a GitHub repo other than `repo`, or none; false when it does not say. */
export const isOtherRepoProject = (project: FactoryProject, repo: string): boolean =>
  project.repo !== undefined &&
  (project.repo === null || asciiLower(project.repo) !== asciiLower(repo));

/**
 * What `findProject` answered as a launch target for `repo`, or the ledger detail that refuses
 * it: no project, a project that names another GitHub repo (or none) than `repo`, or a project
 * with no model. All are refused the same way, before anything is sent, with the detail in the
 * ledger for the person to act on. `start` and `relaunch` share this so the two launch paths
 * cannot drift on what they refuse. The repo check runs here, at the launch, so it holds in a
 * pass whose watched-repo listing could not read the projects.
 */
export const launchable = (
  project: FactoryProject | null,
  repo: string,
): Result.Result<LaunchableProject, string> =>
  project === null
    ? Result.fail(NO_PROJECT)
    : isOtherRepoProject(project, repo)
      ? Result.fail(otherRepoProject(repo, project.repo ?? null))
      : project.model === null
        ? Result.fail(NO_DEFAULT_MODEL)
        : Result.succeed({ id: project.id, model: project.model });
