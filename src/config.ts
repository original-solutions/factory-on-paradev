import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { parse } from "yaml";

import type { Defaulted, DefaultProject } from "./defaultProject.ts";
import type { Model } from "./sessions.ts";
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
export const DEFAULT_MIN_FREE_GIB = 10;
export const DEFAULT_MAX_LOAD_PER_CORE = 1;
/** `paradev.cli` when the block does not set it: the CLI bundled with the Paradev app. */
export const DEFAULT_PARADEV_CLI =
  "/Applications/Superset.app/Contents/Resources/resources/bin/superset";

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
   * The model a session moves to while its own model's provider rate limit cools down:
   * `model_fallbacks`. Always empty here: Paradev cannot move a running session to another model
   * through the CLI, so a non-empty one is refused at load.
   */
  readonly modelFallbacks: Readonly<Record<string, string>>;
  /** `repos`: the repos this runner builds, each with the runner's own clone, in file order. */
  readonly repos: ReadonlyArray<WatchedRepo>;
  /** `paradev`: how the runner starts sessions in Paradev on this Mac. */
  readonly paradev: ParadevConfig;
  /**
   * `default_project`: the block a T3 project with no `factory` block of its own is watched with.
   * Absent, such a project is not watched.
   */
  readonly defaultProject?: DefaultProject;
}

/** Who can read the belt page: `org` only when every member can read every watched repo. */
export type BeltVisibility = "just_me" | "org";

/** The `paradev` block of the machine config. */
export interface ParadevConfig {
  /** The `superset` binary; default {@link DEFAULT_PARADEV_CLI}. */
  readonly cli: string;
  /** The agent preset id a session runs, e.g. `claude`, from `superset agents list --local`. */
  readonly agent: string;
  /** Passed as `--model`; absent, the agent's default. */
  readonly model?: string;
  /** Passed as `--effort`. */
  readonly effort?: string;
  readonly belt: { readonly enabled: boolean; readonly visibility: BeltVisibility };
}

/**
 * The model a launch runs on: the preset as the instance, `paradev.model` (empty for the agent's
 * default), and `paradev.effort` as the one option when it is set. The options keep the ledger's
 * array shape, so `session_launched.model_options` reads as it did.
 */
export const paradevModel = (
  paradev: Pick<ParadevConfig, "agent" | "model" | "effort">,
): Model => ({
  instanceId: paradev.agent,
  model: paradev.model ?? "",
  ...(paradev.effort === undefined
    ? {}
    : { options: [{ id: "effort", value: paradev.effort }] }),
});

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
  "min_free_gib",
  "max_load_per_core",
  "model_fallbacks",
  "default_project",
  "repos",
  "paradev",
] as const;

/**
 * Keys t3fac read that the runner does not: the model keys (the model comes from `paradev`), the
 * branch prune (P1 prunes no branch), and autodeploy's `deploy_wait_minutes` and `keep_versions`
 * (the runner has no autodeploy). A file with them still loads, with a warning per key, so a
 * t3fac config can be copied over as it stands.
 */
export const RETIRED_MACHINE_KEYS = [
  "model_instance",
  "model",
  "prune_branches_after_days",
  "prune_branches_dry_run",
  "deploy_wait_minutes",
  "keep_versions",
] as const;

const RETIRED_KEY_MESSAGES: Record<(typeof RETIRED_MACHINE_KEYS)[number], string> = {
  model_instance: "is no longer used: the model comes from the paradev block",
  model: "is no longer used: the model comes from the paradev block",
  prune_branches_after_days: "is no longer used: the runner prunes no branch",
  prune_branches_dry_run: "is no longer used: the runner prunes no branch",
  deploy_wait_minutes: "is no longer used: the runner has no autodeploy",
  keep_versions: "is no longer used: the runner has no autodeploy",
};

/** The phase-4 control plane block, which no P1 config may depend on. */
const CONTROL_PLANE_KEY = "control_plane";

/** Unknown keys at the top level, after the known-field errors; a retired key is a warning. */
const checkUnknownKeys = (c: Checker, root: Mapping) => {
  for (const key of RETIRED_MACHINE_KEYS) {
    if (Object.hasOwn(root, key)) c.warn(key, RETIRED_KEY_MESSAGES[key]);
  }
  if (Object.hasOwn(root, CONTROL_PLANE_KEY)) {
    c.err(CONTROL_PLANE_KEY, "the control plane arrives in phase 4");
  }
  c.unknownKeys(root, [...MACHINE_KEYS, ...RETIRED_MACHINE_KEYS, CONTROL_PLANE_KEY], "");
};

const REPO_KEYS = ["repo", "path"] as const;
/** `owner/name` as GitHub allows them. */
const REPO_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** `repos`: a list of `{ repo: owner/name, path: <absolute clone path> }`, no repo twice. */
const reposFrom = (c: Checker, root: Mapping): ReadonlyArray<WatchedRepo> | undefined => {
  const value = c.child(root, "", "repos");
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    c.err("repos", "must be a list of `repo` and `path` entries");
    return undefined;
  }
  let ok = true;
  const out: Array<WatchedRepo> = [];
  const seen = new Set<string>();
  value.forEach((item, i) => {
    const path = `repos[${i}]`;
    const entry = c.mapping(item, path);
    if (entry === undefined) {
      ok = false;
      return;
    }
    const repo = c.nonEmptyString(c.child(entry, path, "repo"), `${path}.repo`);
    const clone = c.nonEmptyString(c.child(entry, path, "path"), `${path}.path`);
    c.unknownFields(entry, REPO_KEYS, path);
    if (repo === undefined || clone === undefined) {
      ok = false;
      return;
    }
    if (!REPO_NAME.test(repo)) {
      c.err(`${path}.repo`, "must be `owner/name`");
      ok = false;
      return;
    }
    if (!clone.startsWith("/")) {
      c.err(`${path}.path`, "must be an absolute path");
      ok = false;
      return;
    }
    if (seen.has(asciiLower(repo))) {
      c.err(`${path}.repo`, `${repo} is listed twice; one clone per repo`);
      ok = false;
      return;
    }
    seen.add(asciiLower(repo));
    out.push({ repo, path: clone });
  });
  return ok ? out : undefined;
};

const PARADEV_KEYS = ["cli", "agent", "model", "effort", "belt"] as const;
const BELT_KEYS = ["enabled", "visibility"] as const;

/** `paradev`: required, with `agent`; `cli`, `model`, `effort` and `belt` are optional. */
const paradevFrom = (c: Checker, root: Mapping): ParadevConfig | undefined => {
  const block = c.mapping(c.child(root, "", "paradev"), "paradev");
  if (block === undefined) return undefined;
  const cli = c.optionalNonEmptyString(block, "paradev", "cli", DEFAULT_PARADEV_CLI);
  const agent = c.nonEmptyString(c.child(block, "paradev", "agent"), "paradev.agent");
  const model = Object.hasOwn(block, "model")
    ? c.nonEmptyString(block["model"], "paradev.model")
    : null;
  const effort = Object.hasOwn(block, "effort")
    ? c.nonEmptyString(block["effort"], "paradev.effort")
    : null;
  c.unknownFields(block, PARADEV_KEYS, "paradev");
  const beltBlock = Object.hasOwn(block, "belt") ? c.mapping(block["belt"], "paradev.belt") : {};
  const enabled = c.optionalBoolean(beltBlock, "paradev.belt", "enabled", true);
  const visibility = beltVisibility(c, beltBlock);
  if (beltBlock !== undefined) c.unknownFields(beltBlock, BELT_KEYS, "paradev.belt");
  if (
    cli === undefined ||
    agent === undefined ||
    model === undefined ||
    effort === undefined ||
    enabled === undefined ||
    visibility === undefined
  ) {
    return undefined;
  }
  return {
    cli,
    agent,
    ...(model !== null && { model }),
    ...(effort !== null && { effort }),
    belt: { enabled, visibility },
  };
};

/** `paradev.belt.visibility`: `just_me` (default) or `org`, which warns; `everyone` is refused. */
const beltVisibility = (c: Checker, belt: Mapping | undefined): BeltVisibility | undefined => {
  if (belt === undefined) return undefined;
  const path = "paradev.belt.visibility";
  if (!Object.hasOwn(belt, "visibility")) return "just_me";
  const value = belt["visibility"];
  if (value === "just_me") return value;
  if (value === "org") {
    c.warn(
      path,
      "org lets every member of the Paradev org read the belt: set it only when each of them can read every watched repo",
    );
    return value;
  }
  if (value === "everyone") {
    c.err(path, "everyone is refused: the belt names private repos and issues; use just_me or org");
    return undefined;
  }
  c.err(path, "must be just_me or org");
  return undefined;
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
  const minFreeGib = c.optionalUint(root, "", "min_free_gib", DEFAULT_MIN_FREE_GIB, 0);
  const maxLoadPerCore = c.optionalUint(
    root,
    "",
    "max_load_per_core",
    DEFAULT_MAX_LOAD_PER_CORE,
    0,
  );
  const modelFallbacks = fallbacksFrom(c, root);
  const defaultProject = defaultProjectFrom(c, root);
  const repos = reposFrom(c, root);
  const paradev = paradevFrom(c, root);
  checkUnknownKeys(c, root);

  if (
    ghConfigDir === undefined ||
    pollSeconds === undefined ||
    maxConcurrentRuns === undefined ||
    maxConcurrentGates === undefined ||
    feedbackSeconds === undefined ||
    notify === undefined ||
    minFreeGib === undefined ||
    maxLoadPerCore === undefined ||
    modelFallbacks === undefined ||
    defaultProject === undefined ||
    repos === undefined ||
    paradev === undefined
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
    modelFallbacks,
    repos,
    paradev,
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

/**
 * `model_fallbacks`: absent or empty. Paradev cannot move a running session to another model
 * through the CLI, so a fallback could never be followed.
 */
const fallbacksFrom = (c: Checker, root: Mapping): Readonly<Record<string, string>> | undefined => {
  if (!Object.hasOwn(root, "model_fallbacks")) return {};
  const value = root["model_fallbacks"];
  if (value === null || (isMapping(value) && Object.keys(value).length === 0)) return {};
  c.err(
    "model_fallbacks",
    "must be empty: Paradev cannot move a running session to another model through the CLI",
  );
  return undefined;
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
