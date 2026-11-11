import * as Result from "effect/Result";

import type { FactoryProject, Model } from "../sessions.ts";
import { NO_DEFAULT_MODEL, NO_PROJECT } from "./messages.ts";

/** A project a session can be launched on: it has a model. */
export interface LaunchableProject {
  readonly id: string;
  readonly model: Model;
}

/**
 * What `findProject` answered as a launch target, or the ledger detail that refuses it: no
 * project, or a project with no model. Both are refused the same way, before anything is sent
 * to T3, with the detail in the ledger for the person to act on. `start` and `relaunch` share
 * this so the two launch paths cannot drift on what they refuse.
 */
export const launchable = (
  project: FactoryProject | null,
): Result.Result<LaunchableProject, string> =>
  project === null
    ? Result.fail(NO_PROJECT)
    : project.model === null
      ? Result.fail(NO_DEFAULT_MODEL)
      : Result.succeed({ id: project.id, model: project.model });
