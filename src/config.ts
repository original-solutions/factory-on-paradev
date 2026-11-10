import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { parse } from "yaml";

import type { Defaulted, DefaultProject } from "./defaultProject.ts";
import { asciiLower } from "./ledger/runId.ts";

export const ConfigErrorSchema = Schema.Struct({
  file: Schema.String,
  field: Schema.optionalKey(Schema.String),
  message: Schema.String,
});
export type ConfigError = typeof ConfigErrorSchema.Type;

/** `<file>: <field>: <message>`, or `<file>: <message>` with no field. */
export const formatConfigError = (error: ConfigError): string =>
  error.field === undefined
    ? `${error.file}: ${error.message}`
    : `${error.file}: ${error.field}: ${error.message}`;

/** The typed failure of the loaders: every problem found in one file. */
export class ConfigErrors extends Schema.TaggedError<ConfigErrors>()("FactoryConfigErrors", {
  file: Schema.String,
  errors: Schema.Array(ConfigErrorSchema),
}) {
  override get message(): string {
    return this.errors.map(formatConfigError).join("\n");
  }
}

export interface Limits {
  readonly minutes: number;
  readonly gateRetries: number;
  readonly checksMinutes: number;
  readonly interruptionResumes: number;
}

export type Autonomy = "pr";

export interface ProjectConfig {
  readonly instructors: ReadonlyArray<string>;
  readonly base: string;
  readonly provision: ReadonlyArray<string>;
  readonly gate: ReadonlyArray<string>;
  readonly requiredChecks: ReadonlyArray<string>;
  readonly limits: Limits;
  readonly autonomy: Autonomy;
  /**
   * `factory.owner`: the one machine, by its host name, that may claim the repo's issues,
   * matched ignoring ASCII case. Null when the key is absent: every watching machine may claim.
   */
  readonly owner: string | null;
}

const DEFAULT_MINUTES = 180;
const DEFAULT_CHECKS_MINUTES = 30;
const DEFAULT_INTERRUPTION_RESUMES = 2;
export const DEFAULT_POLL_SECONDS = 60;
export const DEFAULT_MAX_CONCURRENT_GATES = 2;
/**
 * How often, at most, the feedback of one `pr-open` run is read, in seconds. A read costs about 3
 * GraphQL points and the pass runs every `poll_seconds`, so 40 runs at a 60 second poll would spend
 * 7,200 of the 5,000 points an hour a login has. One read in 10 minutes is about 720.
 */
export const DEFAULT_FEEDBACK_SECONDS = 600;
/**
 * Installed versions autodeploy.sh keeps besides `current`. The script reads the key itself and
 * has its own copy of this default in `prune_versions`; change both together.
 */
const DEFAULT_KEEP_VERSIONS = 3;
export const DEFAULT_MIN_FREE_GIB = 10;

/** Minutes a waiting autodeploy build may hold claims back; see {@link MachineConfig.deployWaitMinutes}. */
export const DEFAULT_DEPLOY_WAIT_MINUTES = 120;
export const DEFAULT_MAX_LOAD_PER_CORE = 1;
const DEFAULT_PRUNE_BRANCHES_AFTER_DAYS = 14;

/** What a repo's runs are timed by when none of its project configs has loaded. */
export const timeLimitOnlyProjectConfig = (): ProjectConfig => ({
  instructors: [],
  base: "",
  provision: [],
  gate: [],
  requiredChecks: [],
  limits: {
    minutes: DEFAULT_MINUTES,
    gateRetries: 0,
    checksMinutes: DEFAULT_CHECKS_MINUTES,
    interruptionResumes: DEFAULT_INTERRUPTION_RESUMES,
  },
  autonomy: "pr",
  owner: null,
});

export const PROJECT_CONFIG_PATH = ".dw/config.yml";

/** What the last pass found when it read a repo's project config. */
export type RepoConfigReading =
  | {
      readonly kind: "ok";
      readonly project: ProjectConfig;
      /** The project config is the machine's `default_project`, resolved for the repo. */
      readonly onDefault?: true;
    }
  | {
      readonly kind: "errors";
      readonly errors: ReadonlyArray<ConfigError>;
      /** Whether the errors are the default's or the repo's own block's; absent when neither was read. */
      readonly onDefault?: boolean;
    };

export interface WatchedRepo {
  readonly repo: string;
  readonly path: string;
  /**
   * Set when the checkout has no `factory` block and the machine has a `default_project`: the
   * repo runs on that default, with what the reader found on its default branch.
   */
  readonly defaulted?: Defaulted;
}

/** A watched repo with the title of the T3 project it comes from, for the settings page. */
export interface WatchedProject extends WatchedRepo {
  readonly title: string;
}

/**
 * The repos that two or more watched projects name, by the repo folded with `asciiLower`, each
 * with the paths of its projects in order. A repo like that is watched from none of them: the
 * factory cannot tell which checkout is its own. The pass and the settings report both ask here.
 */
export const ambiguousRepos = (
  watched: ReadonlyArray<WatchedRepo>,
): ReadonlyMap<string, ReadonlyArray<string>> => {
  const byRepo = new Map<string, Array<string>>();
  for (const { repo, path } of watched) {
    const key = asciiLower(repo);
    const paths = byRepo.get(key);
    if (paths === undefined) byRepo.set(key, [path]);
    else paths.push(path);
  }
  return new Map([...byRepo].filter(([, paths]) => paths.length > 1));
};

/** The one sentence the pass and the settings report say about a repo in `ambiguousRepos`. */
export const ambiguousMessage = (paths: ReadonlyArray<string>): string =>
  `${paths.length} T3 projects have this repo as their origin (${paths.join(", ")}); the factory watches none of them`;

/** What the reader found: the watched projects, the repos that departed, and the checkouts it could not settle this time. */
export interface WatchedListing {
  /** The projects that opted in and resolved to a GitHub `owner/name`, in T3's order. A repo two projects name appears once per project. */
  readonly repos: ReadonlyArray<WatchedProject>;
  /**
   * Repos, folded with `asciiLower`, that the factory watched before and watches no more, every
   * T3 project they were watched from having been deleted since. Only these have left: a repo
   * whose project stays (a branch without the opt-in, an unreadable checkout) is not here.
   */
  readonly departed: ReadonlyArray<string>;
  /** Workspace roots of projects the reader could not settle: a `.dw/config.yml` that could not be read for a reason other than its absence, or that does not parse, an opted-in checkout T3 could not name (a null identity, or a GitHub one with no owner or name), or a git that could not run. They are skipped; the list may be short. */
  readonly unresolved: ReadonlyArray<string>;
}

export interface MachineConfig {
  readonly ghConfigDir: string;
  readonly pollSeconds: number;
  /**
   * Runs that may hold a slot at once, over every repo: from claim until the session reports its
   * pull request or the run ends. The gate and the wait for checks take no slot. A session
   * relaunched for a failed re-gate is not held back, so relaunches can exceed the limit.
   */
  readonly maxConcurrentRuns: number;
  readonly maxConcurrentGates: number;
  /** Seconds between reads of a `pr-open` run's feedback; 0 reads on every pass. */
  readonly feedbackSeconds: number;
  /** Whether a new attention item posts a macOS notification. The list is kept either way. */
  readonly notify: boolean;
  /**
   * The free GiB the volumes of the worktrees and of the factory's data must have for a pass to
   * claim an issue or start a gate. 0 turns the check off.
   */
  readonly minFreeGib: number;
  /**
   * The 1-minute load per core above which a pass claims no issue and a second gate does not
   * start. 0 turns the check off.
   */
  readonly maxLoadPerCore: number;
  /**
   * The minutes a build autodeploy has waiting may hold claims back before it installs with runs
   * in progress. autodeploy.sh reads the key itself with its own copy of the default: change both
   * together.
   */
  readonly deployWaitMinutes: number;
  /**
   * The model a session moves to while its own model's provider rate limit cools down, by model
   * id, on the same provider instance: `model_fallbacks`. Empty keeps the plain backoff.
   */
  readonly modelFallbacks: Readonly<Record<string, string>>;
  /** Days after its last commit an unmerged `t3/*` branch with no pull request is pruned. */
  readonly pruneBranchesAfterDays: number;
  /** The branch prune only logs what it would delete. */
  readonly pruneBranchesDryRun: boolean;
  /**
   * `default_project`: the block a T3 project with no `factory` block of its own is watched with.
   * Absent, such a project is not watched.
   */
  readonly defaultProject?: DefaultProject;
}

type Mapping = Record<string, unknown>;

const isMapping = (value: unknown): value is Mapping =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const join = (path: string, key: string) => (path === "" ? key : `${path}.${key}`);

/**
 * A machine config as it loaded: the config, and one warning per key the file still has that
 * the factory no longer reads. A warning never stops the load.
 */
export interface LoadedMachineConfig {
  readonly config: MachineConfig;
  readonly warnings: ReadonlyArray<ConfigError>;
}

/**
 * Collects every problem of one file. A value of `undefined` stands for "no value": YAML never
 * produces it, so it marks an absent key or a parent that was already reported.
 */
const makeChecker = (file: string) => {
  const errors: Array<ConfigError> = [];
  const warnings: Array<ConfigError> = [];

  const err = (field: string, message: string) => {
    errors.push(field === "" ? { file, message } : { file, field, message });
  };

  const warn = (field: string, message: string) => {
    warnings.push({ file, field, message });
  };

  const child = (parent: Mapping | undefined, path: string, key: string): unknown => {
    if (parent === undefined) return undefined;
    if (!Object.hasOwn(parent, key)) {
      err(join(path, key), "is missing");
      return undefined;
    }
    return parent[key];
  };

  const mapping = (value: unknown, path: string): Mapping | undefined => {
    if (value === undefined) return undefined;
    if (isMapping(value)) return value;
    err(path, "must be a mapping");
    return undefined;
  };

  const nonEmptyString = (value: unknown, path: string): string | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== "string") {
      err(path, "must be a string");
      return undefined;
    }
    if (value === "") {
      err(path, "must not be empty");
      return undefined;
    }
    return value;
  };

  /** An integer at or above `min`. YAML integers arrive as bigint, floats as number. */
  const uint = (value: unknown, path: string, min: number): number | undefined => {
    if (value === undefined) return undefined;
    if (typeof value === "bigint" && value >= BigInt(min)) return Number(value);
    if (typeof value === "bigint" || typeof value === "number") {
      err(path, `must be an integer of at least ${min}`);
      return undefined;
    }
    err(path, "must be an integer");
    return undefined;
  };

  /** Like `uint` for `key` under `parent`, but an absent key takes `fallback`. */
  const optionalUint = (
    parent: Mapping | undefined,
    path: string,
    key: string,
    fallback: number,
    min: number,
  ): number | undefined => {
    if (parent === undefined) return undefined;
    if (!Object.hasOwn(parent, key)) return fallback;
    return uint(parent[key], join(path, key), min);
  };

  /** A boolean under `key` of `parent`; an absent key takes `fallback`. */
  const optionalBoolean = (
    parent: Mapping | undefined,
    path: string,
    key: string,
    fallback: boolean,
  ): boolean | undefined => {
    if (parent === undefined) return undefined;
    if (!Object.hasOwn(parent, key)) return fallback;
    const value = parent[key];
    if (typeof value === "boolean") return value;
    err(join(path, key), "must be true or false");
    return undefined;
  };

  const optionalNonEmptyString = (
    parent: Mapping | undefined,
    path: string,
    key: string,
    fallback: string,
  ): string | undefined => {
    if (parent === undefined) return undefined;
    if (!Object.hasOwn(parent, key)) return fallback;
    return nonEmptyString(parent[key], join(path, key));
  };

  const stringList = (
    value: unknown,
    path: string,
    allowEmpty: boolean,
  ): ReadonlyArray<string> | undefined => {
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) {
      err(path, "must be a list of strings");
      return undefined;
    }
    if (value.length === 0 && !allowEmpty) {
      err(path, "must not be empty");
      return undefined;
    }
    const before = errors.length;
    const out: Array<string> = [];
    value.forEach((item, i) => {
      const text = nonEmptyString(item, `${path}[${i}]`);
      if (text !== undefined) out.push(text);
    });
    return errors.length === before ? out : undefined;
  };

  const autonomy = (value: unknown, path: string): Autonomy | undefined => {
    if (value === undefined) return undefined;
    if (value === "pr") return "pr";
    if (typeof value === "string") {
      err(path, `unsupported value \`${value}\`; only \`pr\` is accepted in phase 1`);
    } else {
      err(path, "must be a string; only `pr` is accepted in phase 1");
    }
    return undefined;
  };

  /** One file-level error per key of `value` that is not in `known`, in document order. */
  const unknownKeys = (value: Mapping, known: ReadonlyArray<string>, prefix: string) => {
    for (const key of Object.keys(value)) {
      if (!known.includes(key)) err("", `unknown key ${prefix}${key}`);
    }
  };

  /** One error per key of `value` that is not in `known`, on the key's own field. */
  const unknownFields = (value: Mapping, known: ReadonlyArray<string>, path: string) => {
    for (const key of Object.keys(value)) {
      if (!known.includes(key)) err(join(path, key), "unknown key");
    }
  };

  /** Parse the text into a YAML mapping, or the single file-level error. */
  const root = (text: string): Result.Result<Mapping, ReadonlyArray<ConfigError>> => {
    let value: unknown;
    try {
      value = parse(text, { intAsBigInt: true });
    } catch (cause) {
      err("", `not valid YAML: ${cause instanceof Error ? cause.message : String(cause)}`);
      return Result.fail(errors);
    }
    if (!isMapping(value)) {
      err("", "top level must be a mapping");
      return Result.fail(errors);
    }
    return Result.succeed(value);
  };

  const finish = <T>(value: T | undefined): Result.Result<T, ReadonlyArray<ConfigError>> =>
    value !== undefined && errors.length === 0 ? Result.succeed(value) : Result.fail(errors);

  return {
    err,
    warn,
    warnings,
    child,
    mapping,
    nonEmptyString,
    uint,
    optionalUint,
    optionalNonEmptyString,
    optionalBoolean,
    stringList,
    autonomy,
    unknownKeys,
    unknownFields,
    root,
    finish,
  };
};

type Checker = ReturnType<typeof makeChecker>;

const projectFrom = (c: Checker, root: Mapping): ProjectConfig | undefined => {
  const factory = c.mapping(c.child(root, "", "factory"), "factory");
  const instructors = c.stringList(
    c.child(factory, "factory", "instructors"),
    "factory.instructors",
    false,
  );
  const base = c.nonEmptyString(c.child(factory, "factory", "base"), "factory.base");
  const provision = c.stringList(
    c.child(factory, "factory", "provision"),
    "factory.provision",
    true,
  );
  const gate = c.stringList(c.child(factory, "factory", "gate"), "factory.gate", false);

  let requiredChecks: ReadonlyArray<string> | undefined;
  if (factory !== undefined) {
    if (Object.hasOwn(factory, "required_checks")) {
      requiredChecks = c.stringList(factory["required_checks"], "factory.required_checks", true);
    } else {
      requiredChecks = [];
    }
  }

  const limits = limitsFrom(
    c,
    c.mapping(c.child(factory, "factory", "limits"), "factory.limits"),
    "factory.limits",
    undefined,
  );
  const autonomy = c.autonomy(c.child(factory, "factory", "autonomy"), "factory.autonomy");
  const owner =
    factory === undefined || !Object.hasOwn(factory, "owner")
      ? null
      : c.nonEmptyString(factory["owner"], "factory.owner");

  if (
    instructors === undefined ||
    base === undefined ||
    provision === undefined ||
    gate === undefined ||
    requiredChecks === undefined ||
    limits === undefined ||
    autonomy === undefined ||
    owner === undefined
  ) {
    return undefined;
  }
  return {
    instructors,
    base,
    provision,
    gate,
    requiredChecks,
    limits,
    autonomy,
    owner,
  };
};

/** The keys a `limits` block reads. */
const LIMITS_KEYS = ["minutes", "gate_retries", "checks_minutes", "interruption_resumes"] as const;

/**
 * A `limits` mapping at `path`. `gate_retries` is required when `gateRetriesDefault` is undefined
 * (a repo's block), else optional with that default (the machine's `default_project`).
 */
const limitsFrom = (
  c: Checker,
  limits: Mapping | undefined,
  path: string,
  gateRetriesDefault: number | undefined,
): Limits | undefined => {
  const minutes = c.optionalUint(limits, path, "minutes", DEFAULT_MINUTES, 1);
  const gateRetries =
    gateRetriesDefault === undefined
      ? c.uint(c.child(limits, path, "gate_retries"), `${path}.gate_retries`, 0)
      : c.optionalUint(limits, path, "gate_retries", gateRetriesDefault, 0);
  const checksMinutes = c.optionalUint(limits, path, "checks_minutes", DEFAULT_CHECKS_MINUTES, 1);
  const interruptionResumes = c.optionalUint(
    limits,
    path,
    "interruption_resumes",
    DEFAULT_INTERRUPTION_RESUMES,
    0,
  );
  if (
    minutes === undefined ||
    gateRetries === undefined ||
    checksMinutes === undefined ||
    interruptionResumes === undefined
  ) {
    return undefined;
  }
  return { minutes, gateRetries, checksMinutes, interruptionResumes };
};

const MACHINE_KEYS = [
  "gh_config_dir",
  "poll_seconds",
  "max_concurrent_runs",
  "max_concurrent_gates",
  "feedback_seconds",
  "notify",
  "keep_versions",
  "min_free_gib",
  "max_load_per_core",
  "deploy_wait_minutes",
  "model_fallbacks",
  "prune_branches_after_days",
  "prune_branches_dry_run",
  "default_project",
] as const;

/**
 * Keys the factory reads no more: the model keys (the model comes from the T3 project's default,
 * then the T3 settings default) and `repos` (the factory watches the T3 projects). A file with
 * them still loads with a warning per key, and a settings save keeps them (`settings.ts`) so a
 * rollback still loads. Remove them by hand once no rollback is possible.
 */
export const RETIRED_MACHINE_KEYS = ["model_instance", "model", "repos"] as const;

const RETIRED_KEY_MESSAGES: Record<(typeof RETIRED_MACHINE_KEYS)[number], string> = {
  model_instance:
    "is no longer used: the model comes from the T3 project's default model, then the T3 settings default",
  model:
    "is no longer used: the model comes from the T3 project's default model, then the T3 settings default",
  repos:
    "is no longer used: the factory watches the T3 projects of this environment whose checkout has a .dw/config.yml with a factory block",
};

/** Unknown keys at the top level, after the known-field errors; a retired key is a warning. */
const checkUnknownKeys = (c: Checker, root: Mapping) => {
  for (const key of RETIRED_MACHINE_KEYS) {
    if (Object.hasOwn(root, key)) c.warn(key, RETIRED_KEY_MESSAGES[key]);
  }
  c.unknownKeys(root, [...MACHINE_KEYS, ...RETIRED_MACHINE_KEYS], "");
};

const machineFrom = (c: Checker, root: Mapping): MachineConfig | undefined => {
  const ghConfigDir = c.nonEmptyString(c.child(root, "", "gh_config_dir"), "gh_config_dir");
  const pollSeconds = c.optionalUint(root, "", "poll_seconds", DEFAULT_POLL_SECONDS, 10);
  const maxConcurrentRuns = c.uint(
    c.child(root, "", "max_concurrent_runs"),
    "max_concurrent_runs",
    1,
  );
  const maxConcurrentGates = c.optionalUint(
    root,
    "",
    "max_concurrent_gates",
    DEFAULT_MAX_CONCURRENT_GATES,
    1,
  );
  const feedbackSeconds = c.optionalUint(root, "", "feedback_seconds", DEFAULT_FEEDBACK_SECONDS, 0);
  const notify = c.optionalBoolean(root, "", "notify", true);
  // Only checked here, so a bad value fails the load where a person sees it: autodeploy.sh reads
  // keep_versions from the file and the server has no use for it.
  const keepVersions = c.optionalUint(root, "", "keep_versions", DEFAULT_KEEP_VERSIONS, 0);
  const minFreeGib = c.optionalUint(root, "", "min_free_gib", DEFAULT_MIN_FREE_GIB, 0);
  const maxLoadPerCore = c.optionalUint(
    root,
    "",
    "max_load_per_core",
    DEFAULT_MAX_LOAD_PER_CORE,
    0,
  );
  const deployWaitMinutes = c.optionalUint(
    root,
    "",
    "deploy_wait_minutes",
    DEFAULT_DEPLOY_WAIT_MINUTES,
    1,
  );
  const modelFallbacks = fallbacksFrom(c, root);
  const pruneBranchesAfterDays = c.optionalUint(
    root,
    "",
    "prune_branches_after_days",
    DEFAULT_PRUNE_BRANCHES_AFTER_DAYS,
    1,
  );
  const pruneBranchesDryRun = c.optionalBoolean(root, "", "prune_branches_dry_run", false);
  const defaultProject = defaultProjectFrom(c, root);
  checkUnknownKeys(c, root);

  if (
    ghConfigDir === undefined ||
    pollSeconds === undefined ||
    maxConcurrentRuns === undefined ||
    maxConcurrentGates === undefined ||
    feedbackSeconds === undefined ||
    notify === undefined ||
    keepVersions === undefined ||
    minFreeGib === undefined ||
    maxLoadPerCore === undefined ||
    deployWaitMinutes === undefined ||
    modelFallbacks === undefined ||
    pruneBranchesAfterDays === undefined ||
    pruneBranchesDryRun === undefined ||
    defaultProject === undefined
  ) {
    return undefined;
  }
  return {
    ghConfigDir,
    pollSeconds,
    maxConcurrentRuns,
    maxConcurrentGates,
    feedbackSeconds,
    notify,
    minFreeGib,
    maxLoadPerCore,
    deployWaitMinutes,
    modelFallbacks,
    pruneBranchesAfterDays,
    pruneBranchesDryRun,
    ...(defaultProject !== null && { defaultProject }),
  };
};

const DEFAULT_PROJECT_KEYS = ["instructors", "limits"] as const;
const DEFAULT_GATE_RETRIES = 2;

/** `default_project`: null when absent, undefined when it has errors. */
const defaultProjectFrom = (c: Checker, root: Mapping): DefaultProject | null | undefined => {
  if (!Object.hasOwn(root, "default_project")) return null;
  const path = "default_project";
  const block = c.mapping(root[path], path);
  if (block === undefined) return undefined;
  const instructors = c.stringList(
    c.child(block, path, "instructors"),
    `${path}.instructors`,
    false,
  );
  const limitsPath = `${path}.limits`;
  const limitsBlock = Object.hasOwn(block, "limits") ? c.mapping(block["limits"], limitsPath) : {};
  const limits = limitsFrom(c, limitsBlock, limitsPath, DEFAULT_GATE_RETRIES);
  c.unknownFields(block, DEFAULT_PROJECT_KEYS, path);
  if (limitsBlock !== undefined) c.unknownFields(limitsBlock, LIMITS_KEYS, limitsPath);
  if (instructors === undefined || limits === undefined) return undefined;
  return { instructors, limits };
};

/** `model_fallbacks`: model id to another model id; absent is none. */
const fallbacksFrom = (c: Checker, root: Mapping): Readonly<Record<string, string>> | undefined => {
  if (!Object.hasOwn(root, "model_fallbacks")) return {};
  const value = c.mapping(root["model_fallbacks"], "model_fallbacks");
  if (value === undefined) return undefined;
  const out: Record<string, string> = {};
  let ok = true;
  for (const [from, raw] of Object.entries(value)) {
    const path = join("model_fallbacks", from);
    const to = c.nonEmptyString(raw, path);
    if (to === undefined) ok = false;
    else if (to === from) {
      c.err(path, "must name another model");
      ok = false;
    } else out[from] = to;
  }
  return ok ? out : undefined;
};

export const parseProjectConfig = (
  text: string,
  file: string,
): Result.Result<ProjectConfig, ReadonlyArray<ConfigError>> => {
  const c = makeChecker(file);
  const parsed = c.root(text);
  if (Result.isFailure(parsed)) return Result.fail(parsed.failure);
  return c.finish(projectFrom(c, parsed.success));
};

/**
 * Whether a checkout's `.dw/config.yml` opts the repo into the factory: `"yes"` when the root and
 * its `factory` are mappings, `"no"` when it parses but they are not, `"unparsed"` when the text
 * is not YAML (a read that did not finish, not an answer). The block is not validated here;
 * `world.project` does that.
 */
export const factoryOptIn = (text: string): "yes" | "no" | "unparsed" => {
  let value: unknown;
  try {
    value = parse(text, { intAsBigInt: true });
  } catch {
    return "unparsed";
  }
  return isMapping(value) && isMapping(value["factory"]) ? "yes" : "no";
};

export const parseMachineConfig = (
  text: string,
  file: string,
): Result.Result<LoadedMachineConfig, ReadonlyArray<ConfigError>> => {
  const c = makeChecker(file);
  const parsed = c.root(text);
  if (Result.isFailure(parsed)) return Result.fail(parsed.failure);
  const config = machineFrom(c, parsed.success);
  return c.finish(config === undefined ? undefined : { config, warnings: c.warnings });
};

const cannotRead = (file: string, cause: { readonly message: string }) =>
  new ConfigErrors({ file, errors: [{ file, message: `cannot read file: ${cause.message}` }] });

const toConfigErrors = <A>(
  file: string,
  parsed: Result.Result<A, ReadonlyArray<ConfigError>>,
): Effect.Effect<A, ConfigErrors> =>
  Result.isSuccess(parsed)
    ? Effect.succeed(parsed.success)
    : Effect.fail(new ConfigErrors({ file, errors: parsed.failure }));

/** Reads the file on every call. Nothing is cached. */
export const loadProjectConfig = Effect.fn("FactoryConfig.loadProjectConfig")(function* (
  file: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs
    .readFileString(file)
    .pipe(Effect.mapError((cause) => cannotRead(file, cause)));
  return yield* toConfigErrors(file, parseProjectConfig(text, file));
});

/** Reads the file on every call. A file that does not exist is `Option.none()`. */
export const loadMachineConfig = Effect.fn("FactoryConfig.loadMachineConfig")(function* (
  file: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs.readFileString(file).pipe(
    Effect.asSome,
    Effect.catch((cause) =>
      cause.reason._tag === "NotFound"
        ? Effect.succeed(Option.none<string>())
        : Effect.fail(cannotRead(file, cause)),
    ),
  );
  if (Option.isNone(text)) return Option.none<LoadedMachineConfig>();
  return Option.some(yield* toConfigErrors(file, parseMachineConfig(text.value, file)));
});
