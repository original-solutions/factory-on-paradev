/**
 * The project config of a repo watched on the machine's `default_project`: the default block's
 * instructors and limits, the repo's default branch as `base`, and a `provision` and `gate`
 * inferred from the manifests committed on that branch. Pure: the reader hands over the files.
 */
import * as Result from "effect/Result";

import {
  type ConfigError,
  type Limits,
  PROJECT_CONFIG_PATH,
  type ProjectConfig,
} from "./config.ts";

/** The machine config's `default_project`, for a repo with no `factory` block of its own. */
export interface DefaultProject {
  readonly instructors: ReadonlyArray<string>;
  readonly limits: Limits;
}

/** The files committed at the root of a repo's default branch that the inference reads. */
export interface RepoFiles {
  readonly packageJson: string | null;
  readonly composerJson: string | null;
  /** Which of `LOCKFILES` are present. */
  readonly lockfiles: ReadonlyArray<string>;
}

/** What a checkout's `origin/HEAD` names, and the files committed at its root. */
export interface OriginHead {
  readonly branch: string;
  readonly files: RepoFiles;
}

/** What the reader found of a repo it watches on the default: null for a checkout with no `origin/HEAD`. */
export interface Defaulted {
  readonly head: OriginHead | null;
}

/** The package managers by lockfile, in the order one is chosen when a repo has several. */
const PACKAGE_MANAGERS = [
  { lockfiles: ["package-lock.json"], provision: "npm ci", run: "npm run" },
  { lockfiles: ["pnpm-lock.yaml"], provision: "pnpm install --frozen-lockfile", run: "pnpm run" },
  {
    lockfiles: ["bun.lock", "bun.lockb"],
    provision: "bun install --frozen-lockfile",
    run: "bun run",
  },
  { lockfiles: ["yarn.lock"], provision: "yarn install --frozen-lockfile", run: "yarn run" },
] as const;

/** The lockfile names the reader looks for at the root of the default branch. */
export const LOCKFILES: ReadonlyArray<string> = PACKAGE_MANAGERS.flatMap((pm) => pm.lockfiles);

/** The package scripts the gate runs when they are defined, in this order. */
const PACKAGE_SCRIPTS = ["typecheck", "lint", "build", "test", "format:check"] as const;

const COMPOSER_INSTALL = "composer install --no-interaction --no-progress";

/** The names under a manifest's `scripts`; none for a manifest that is not JSON. */
const scriptsOf = (text: string): ReadonlySet<string> => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return new Set();
  }
  if (typeof value !== "object" || value === null) return new Set();
  const scripts = (value as Record<string, unknown>)["scripts"];
  if (typeof scripts !== "object" || scripts === null || Array.isArray(scripts)) return new Set();
  return new Set(Object.keys(scripts));
};

/** `provision` and `gate` from the manifests: composer first, then the package scripts. */
export const inferCommands = (
  files: RepoFiles,
): { readonly provision: ReadonlyArray<string>; readonly gate: ReadonlyArray<string> } => {
  const provision: Array<string> = [];
  const gate: Array<string> = [];
  if (files.composerJson !== null) {
    provision.push(COMPOSER_INSTALL);
    const scripts = scriptsOf(files.composerJson);
    if (scripts.has("check")) gate.push("composer check");
    else if (scripts.has("test")) gate.push("composer test");
  }
  const manager = PACKAGE_MANAGERS.find((pm) =>
    pm.lockfiles.some((name) => files.lockfiles.includes(name)),
  );
  if (files.packageJson !== null && manager !== undefined) {
    provision.push(manager.provision);
    const scripts = scriptsOf(files.packageJson);
    for (const script of PACKAGE_SCRIPTS) {
      if (scripts.has(script)) gate.push(`${manager.run} ${script}`);
    }
  }
  return { provision, gate };
};

const failure = (message: string): Result.Result<never, ReadonlyArray<ConfigError>> =>
  Result.fail([{ file: PROJECT_CONFIG_PATH, message }]);

/**
 * The project config of a repo on the default, whose default branch on GitHub is `base`; or the
 * one error that the checkout's `origin/HEAD` is missing or names another branch, or that no
 * gate could be inferred from its files.
 */
export const resolveDefault = (
  defaultProject: DefaultProject,
  base: string,
  head: OriginHead | null,
): Result.Result<ProjectConfig, ReadonlyArray<ConfigError>> => {
  if (head === null) {
    return failure(
      "the checkout has no origin/HEAD, so its files cannot be read: run `git remote set-head origin --auto` in it",
    );
  }
  if (head.branch !== base) {
    return failure(
      `the checkout's origin/HEAD is ${head.branch}, but the default branch on GitHub is ${base}: run \`git remote set-head origin --auto\` in it`,
    );
  }
  const { provision, gate } = inferCommands(head.files);
  if (gate.length === 0) {
    return failure(
      `no gate could be inferred from package.json or composer.json on ${base}: a factory block in .dw/config.yml is needed`,
    );
  }
  return Result.succeed({
    instructors: defaultProject.instructors,
    base,
    provision,
    gate,
    requiredChecks: [],
    limits: defaultProject.limits,
    autonomy: "pr",
    owner: null,
  });
};
