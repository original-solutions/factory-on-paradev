import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";

import {
  type ConfigError,
  ConfigErrors,
  formatConfigError,
  factoryOptIn,
  loadMachineConfig,
  loadProjectConfig,
  parseMachineConfig,
  paradevModel,
  parseProjectConfig,
  timeLimitOnlyProjectConfig,
} from "./config.ts";

const PROJECT = `
tracker:
  backend: do-work-io
factory:
  instructors: [tomkaczocha]
  base: main
  provision: [cargo fetch]
  gate:
    - cargo fmt --check
    - cargo test
  limits: { minutes: 90, gate_retries: 2 }
  autonomy: pr
`;

const MACHINE = `
gh_config_dir: /Users/me/.config/softfac/gh
max_concurrent_runs: 1
repos:
  - repo: rawphp/softfac
    path: /Users/me/factory-runner/rawphp/softfac
paradev:
  agent: claude
`;

const PFILE = "/r/.dw/config.yml";
const MFILE = "/m/config.yml";

type Tree = any;

const isIndex = (part: string) => /^\d+$/.test(part);
const step = (cur: Tree, part: string): Tree => cur[isIndex(part) ? Number(part) : part];

/** Parse `base`, apply `f` to the plain tree, and return the edited text. */
const edit = (base: string, f: (tree: Tree) => void): string => {
  const tree = parse(base);
  f(tree);
  return stringify(tree);
};

/** Set a dotted path (numeric segments index lists) to the value of the YAML text `yaml`. */
const set = (tree: Tree, path: string, yaml: string) => {
  const parts = path.split(".");
  const parent = parts.slice(0, -1).reduce(step, tree);
  const last = parts[parts.length - 1]!;
  parent[isIndex(last) ? Number(last) : last] = parse(yaml);
};

const remove = (tree: Tree, path: string) => {
  const parts = path.split(".");
  const parent = parts.slice(0, -1).reduce(step, tree);
  delete parent[parts[parts.length - 1]!];
};

const projectErr = (text: string): ReadonlyArray<ConfigError> => {
  const result = parseProjectConfig(text, PFILE);
  if (Result.isSuccess(result)) throw new Error("expected invalid project config");
  return result.failure;
};

const machineErr = (text: string): ReadonlyArray<ConfigError> => {
  const result = parseMachineConfig(text, MFILE);
  if (Result.isSuccess(result)) throw new Error("expected invalid machine config");
  return result.failure;
};

const project = (text: string) => {
  const result = parseProjectConfig(text, PFILE);
  if (Result.isFailure(result))
    throw new Error(`unexpected errors: ${JSON.stringify(result.failure)}`);
  return result.success;
};

const machineLoaded = (text: string) => {
  const result = parseMachineConfig(text, MFILE);
  if (Result.isFailure(result))
    throw new Error(`unexpected errors: ${JSON.stringify(result.failure)}`);
  return result.success;
};

const machine = (text: string) => machineLoaded(text).config;

/** Assert exactly one error whose field and file are exactly as given. */
const assertOne = (errs: ReadonlyArray<ConfigError>, field: string, file: string) => {
  expect(errs, JSON.stringify(errs)).toHaveLength(1);
  expect(errs[0]!.field).toBe(field);
  expect(errs[0]!.file).toBe(file);
};

/** Assert exactly one file-level error (no field) on `file`. */
const assertFileLevel = (errs: ReadonlyArray<ConfigError>, file: string, messagePart: string) => {
  expect(errs, JSON.stringify(errs)).toHaveLength(1);
  expect(errs[0]!.field).toBeUndefined();
  expect(errs[0]!.file).toBe(file);
  expect(errs[0]!.message).toContain(messagePart);
};

const fields = (errs: ReadonlyArray<ConfigError>) =>
  errs.flatMap((e) => (e.field === undefined ? [] : [e.field]));

const projectMissing = (path: string) => {
  assertOne(projectErr(edit(PROJECT, (t) => remove(t, path))), path, PFILE);
};

const projectBad = (path: string, yaml: string) => {
  assertOne(projectErr(edit(PROJECT, (t) => set(t, path, yaml))), path, PFILE);
};

const machineMissing = (path: string, errorPath = path) => {
  assertOne(machineErr(edit(MACHINE, (t) => remove(t, path))), errorPath, MFILE);
};

/** Set `editPath` (tree address, e.g. `a.0.b`), expect the error at `errorPath` (`a[0].b`). */
const machineBadAt = (editPath: string, errorPath: string, yaml: string) => {
  assertOne(machineErr(edit(MACHINE, (t) => set(t, editPath, yaml))), errorPath, MFILE);
};

const machineBad = (path: string, yaml: string) => machineBadAt(path, path, yaml);

describe("project config", () => {
  it("the config of a repo that never loaded has the default time limit and no base", () => {
    const config = timeLimitOnlyProjectConfig();
    expect(config.limits.minutes).toBe(180);
    expect(config.limits.gateRetries).toBe(0);
    expect(config.limits.checksMinutes).toBe(30);
    expect(config.limits.interruptionResumes).toBe(2);
    expect(config.base).toBe("");
    expect(config.autonomy).toBe("pr");
    expect(config.instructors).toEqual([]);
    expect(config.provision).toEqual([]);
    expect(config.gate).toEqual([]);
    expect(config.requiredChecks).toEqual([]);
  });

  describe("valid", () => {
    it("project valid resolves all fields", () => {
      const c = project(PROJECT);
      expect(c.instructors).toEqual(["tomkaczocha"]);
      expect(c.base).toBe("main");
      expect(c.provision).toEqual(["cargo fetch"]);
      expect(c.gate).toEqual(["cargo fmt --check", "cargo test"]);
      expect(c.limits.minutes).toBe(90);
      expect(c.limits.gateRetries).toBe(2);
      expect(c.requiredChecks).toEqual([]);
      expect(c.limits.checksMinutes).toBe(30);
      expect(c.autonomy).toBe("pr");
    });
  });

  describe("the retired regates key", () => {
    it("is accepted and ignored, set as a block key or inline", () => {
      const c = project(edit(PROJECT, (t) => set(t, "factory.limits.regates", "12")));
      expect(c.limits).toEqual({
        minutes: 90,
        gateRetries: 2,
        checksMinutes: 30,
        interruptionResumes: 2,
      });
      const inline = PROJECT.replace(
        "limits: { minutes: 90, gate_retries: 2 }",
        "limits: { minutes: 90, gate_retries: 2, regates: 3 }",
      );
      expect(project(inline).limits).toEqual(c.limits);
    });

    it("is ignored whatever its value", () => {
      const without = project(PROJECT).limits;
      for (const value of ["5", "0", "-1", '"many"', "[1]", "null"]) {
        const c = project(edit(PROJECT, (t) => set(t, "factory.limits.regates", value)));
        expect(c.limits).toEqual(without);
      }
    });
  });

  describe("the required checks", () => {
    const CHECKS = "factory.required_checks";
    const CHECKS_MINUTES = "factory.limits.checks_minutes";

    it("project required checks are kept as given", () => {
      const c = project(edit(PROJECT, (t) => set(t, CHECKS, '[gate, "build (linux)"]')));
      expect(c.requiredChecks).toEqual(["gate", "build (linux)"]);
    });

    it("project required checks may be an empty list", () => {
      const c = project(edit(PROJECT, (t) => set(t, CHECKS, "[]")));
      expect(c.requiredChecks).toEqual([]);
    });

    it("project required checks must be a list of non-empty strings", () => {
      for (const bad of ["gate", "5", "null", "[1]", '[""]', '[gate, ""]']) {
        const errs = projectErr(edit(PROJECT, (t) => set(t, CHECKS, bad)));
        expect(errs.length, bad).toBeGreaterThan(0);
        for (const e of errs) expect(e.field?.startsWith(CHECKS), `${bad}: ${e.field}`).toBe(true);
      }
      const errs = projectErr(edit(PROJECT, (t) => set(t, CHECKS, '[gate, ""]')));
      assertOne(errs, "factory.required_checks[1]", PFILE);
    });

    it("project checks minutes defaults to 30 and can be set", () => {
      expect(project(edit(PROJECT, (t) => set(t, CHECKS_MINUTES, "45"))).limits.checksMinutes).toBe(
        45,
      );
      expect(project(edit(PROJECT, (t) => set(t, CHECKS_MINUTES, "1"))).limits.checksMinutes).toBe(
        1,
      );
    });

    it("project checks minutes must be an integer of at least one", () => {
      for (const bad of ['"soon"', "0", "-1", "1.5", "[1]", "null", "true"]) {
        const errs = projectErr(edit(PROJECT, (t) => set(t, CHECKS_MINUTES, bad)));
        assertOne(errs, CHECKS_MINUTES, PFILE);
      }
    });
  });

  describe("the owner", () => {
    const OWNER = "factory.owner";

    it("project owner is kept as given", () => {
      expect(project(edit(PROJECT, (t) => set(t, OWNER, "T3fac"))).owner).toBe("T3fac");
    });

    it("project owner is null when the key is absent", () => {
      expect(project(PROJECT).owner).toBeNull();
      expect(timeLimitOnlyProjectConfig().owner).toBeNull();
    });

    it("project owner must be a non-empty string", () => {
      for (const bad of ['""', "5", "null", "[t3fac]", "{ name: t3fac }", "true"]) {
        assertOne(projectErr(edit(PROJECT, (t) => set(t, OWNER, bad))), OWNER, PFILE);
      }
    });
  });

  it("project ignores the needs-info limits an older version read", () => {
    const t = PROJECT.replace(
      "limits: { minutes: 90, gate_retries: 2 }",
      "limits: { minutes: 90, gate_retries: 2, needs_info_nudge_hours: 5, needs_info_timeout_hours: 3, needs_info_rounds: 0 }",
    );
    expect(project(t)).toEqual(project(PROJECT));
  });

  describe("the interruption resumes", () => {
    const RESUMES = "factory.limits.interruption_resumes";
    const withResumes = (resumes: string) => edit(PROJECT, (t) => set(t, RESUMES, resumes));

    it("project interruption resumes default to 2", () => {
      expect(project(PROJECT).limits.interruptionResumes).toBe(2);
    });

    it("project interruption resumes can be set and can be zero", () => {
      for (const [text, want] of [
        ["0", 0],
        ["1", 1],
        ["2", 2],
        ["10", 10],
      ] as const) {
        expect(project(withResumes(text)).limits.interruptionResumes).toBe(want);
      }
    });

    it("project interruption resumes are read from a limits block written inline", () => {
      const t = PROJECT.replace(
        "limits: { minutes: 90, gate_retries: 2 }",
        "limits: { minutes: 90, gate_retries: 2, interruption_resumes: 4 }",
      );
      expect(project(t).limits.interruptionResumes).toBe(4);
    });

    it("project interruption resumes must be an integer of at least zero", () => {
      for (const bad of ['"many"', "-1", "1.5", "[1]", "null", "true"]) {
        assertOne(projectErr(withResumes(bad)), RESUMES, PFILE);
      }
      expect(projectErr(withResumes("-1"))[0]!.message).toBe("must be an integer of at least 0");
    });
  });

  it("project ignores other top level keys", () => {
    const t =
      "tracker: 5\nmodels: [a]\nfactory:\n  instructors: [a]\n  base: main\n  provision: []\n  gate: [make]\n  limits: { minutes: 1, gate_retries: 0 }\n  autonomy: pr\n";
    const c = project(t);
    expect(c.provision).toEqual([]);
    expect(c.limits.gateRetries).toBe(0);
  });

  it("project ignores unknown keys inside the factory block", () => {
    const t = edit(PROJECT, (tree) => set(tree, "factory.something_else", "5"));
    expect(project(t)).toEqual(project(PROJECT));
  });

  describe("missing fields", () => {
    it("project missing factory block", () => {
      assertOne(projectErr("tracker: x\n"), "factory", PFILE);
    });
    it("project missing instructors", () => projectMissing("factory.instructors"));
    it("project missing base", () => projectMissing("factory.base"));
    it("project missing provision", () => projectMissing("factory.provision"));
    it("project missing gate", () => projectMissing("factory.gate"));
    it("project missing limits", () => projectMissing("factory.limits"));
    it("project limits minutes defaults to 180 when missing", () => {
      const t = edit(PROJECT, (tree) => remove(tree, "factory.limits.minutes"));
      expect(project(t).limits.minutes).toBe(180);
    });
    it("project missing limits gate retries", () => projectMissing("factory.limits.gate_retries"));
    it("project missing autonomy", () => projectMissing("factory.autonomy"));
  });

  describe("wrong types and values", () => {
    it("project factory not a mapping", () => {
      assertOne(projectErr("factory: 3\n"), "factory", PFILE);
    });
    it("project instructors not a list", () => projectBad("factory.instructors", "tomkaczocha"));
    it("project instructors empty", () => projectBad("factory.instructors", "[]"));
    it("project instructors item not a string", () => {
      const t = edit(PROJECT, (tree) => set(tree, "factory.instructors", "[a, 5]"));
      assertOne(projectErr(t), "factory.instructors[1]", PFILE);
    });
    it("project instructors empty item", () => {
      const t = edit(PROJECT, (tree) => set(tree, "factory.instructors", '[""]'));
      assertOne(projectErr(t), "factory.instructors[0]", PFILE);
    });
    it("project gate empty item", () => {
      const t = edit(PROJECT, (tree) => set(tree, "factory.gate", '[""]'));
      assertOne(projectErr(t), "factory.gate[0]", PFILE);
    });
    it("project base not a string", () => projectBad("factory.base", "[main]"));
    it("project base empty", () => projectBad("factory.base", '""'));
    it("project provision not a list", () => projectBad("factory.provision", "cargo fetch"));
    it("project provision item not a string", () => {
      const t = edit(PROJECT, (tree) => set(tree, "factory.provision", "[{a: b}]"));
      assertOne(projectErr(t), "factory.provision[0]", PFILE);
    });
    it("project gate not a list", () => projectBad("factory.gate", "cargo test"));
    it("project gate empty", () => projectBad("factory.gate", "[]"));
    it("project limits not a mapping", () => projectBad("factory.limits", "90"));
    it("project minutes not an integer", () => projectBad("factory.limits.minutes", '"ninety"'));
    it("project minutes zero", () => projectBad("factory.limits.minutes", "0"));
    it("project minutes negative", () => projectBad("factory.limits.minutes", "-5"));
    it("project minutes fractional", () => projectBad("factory.limits.minutes", "1.5"));
    it("project minutes written as 90.0 is fractional", () => {
      const errs = projectErr(PROJECT.replace("minutes: 90", "minutes: 90.0"));
      assertOne(errs, "factory.limits.minutes", PFILE);
      expect(errs[0]!.message).toBe("must be an integer of at least 1");
    });
    it("project gate retries not an integer", () =>
      projectBad("factory.limits.gate_retries", "many"));
    it("project gate retries negative", () => projectBad("factory.limits.gate_retries", "-1"));
    it("project autonomy merge is rejected with phase note", () => {
      const errs = projectErr(edit(PROJECT, (tree) => set(tree, "factory.autonomy", "merge")));
      assertOne(errs, "factory.autonomy", PFILE);
      expect(errs[0]!.message).toBe("unsupported value `merge`; only `pr` is accepted in phase 1");
    });
    it("project autonomy deploy is rejected", () => projectBad("factory.autonomy", "deploy"));
    it("project autonomy not a string", () => {
      const errs = projectErr(edit(PROJECT, (tree) => set(tree, "factory.autonomy", "7")));
      assertOne(errs, "factory.autonomy", PFILE);
      expect(errs[0]!.message).toBe("must be a string; only `pr` is accepted in phase 1");
    });
    it("project key present with null is a type error, not absent", () => {
      const errs = projectErr(edit(PROJECT, (tree) => set(tree, "factory.base", "null")));
      assertOne(errs, "factory.base", PFILE);
      expect(errs[0]!.message).toBe("must be a string");
    });
  });

  it("project reports all errors not just the first", () => {
    const t = edit(PROJECT, (tree) => {
      remove(tree, "factory.base");
      set(tree, "factory.limits.minutes", "0");
      set(tree, "factory.autonomy", "merge");
    });
    const errs = projectErr(t);
    expect(errs).toHaveLength(3);
    expect(fields(errs)).toEqual(["factory.base", "factory.limits.minutes", "factory.autonomy"]);
  });

  it("project invalid yaml names the file", () => {
    assertFileLevel(projectErr("factory: [unclosed\n"), PFILE, "not valid YAML");
  });

  it("project document not a mapping", () => {
    assertFileLevel(projectErr("- a\n- b\n"), PFILE, "top level must be a mapping");
    assertFileLevel(projectErr(""), PFILE, "top level must be a mapping");
    assertFileLevel(projectErr("5\n"), PFILE, "top level must be a mapping");
  });

  effectIt.effect("project missing file names the file", () =>
    Effect.gen(function* () {
      const file = "/definitely/not/here/.dw/config.yml";
      const failure = yield* Effect.flip(loadProjectConfig(file));
      expect(failure).toBeInstanceOf(ConfigErrors);
      assertFileLevel(failure.errors, file, "cannot read");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("formatConfigError", () => {
  it("names the file, the field and the message", () => {
    expect(formatConfigError({ file: "/m/c.yml", field: "model", message: "is missing" })).toBe(
      "/m/c.yml: model: is missing",
    );
  });
  it("leaves the field out of a file-level error", () => {
    expect(formatConfigError({ file: "/m/c.yml", message: "top level must be a mapping" })).toBe(
      "/m/c.yml: top level must be a mapping",
    );
  });
});

describe("factoryOptIn", () => {
  it('is "yes" when the root has a factory mapping', () => {
    expect(factoryOptIn(PROJECT)).toBe("yes");
    expect(factoryOptIn("factory: {}\n")).toBe("yes");
  });
  it('is "yes" for a block that would not validate: it only decides the opt-in', () => {
    expect(factoryOptIn("factory:\n  base: 5\n")).toBe("yes");
  });
  it('is "no" when there is no factory key', () => {
    expect(factoryOptIn("tracker:\n  backend: do-work-io\n")).toBe("no");
  });
  it('is "no" when factory is not a mapping', () => {
    expect(factoryOptIn("factory: 1\n")).toBe("no");
    expect(factoryOptIn("factory: [a]\n")).toBe("no");
    expect(factoryOptIn("factory:\n")).toBe("no");
  });
  it('is "unparsed" for invalid YAML, which is a read that did not finish', () => {
    expect(factoryOptIn("factory: [unclosed\n")).toBe("unparsed");
    expect(factoryOptIn("<<<<<<< HEAD\nfactory: {}\n=======\nfactory: {}\n>>>>>>> main\n")).toBe(
      "unparsed",
    );
  });
  it('is "no" when the document is not a mapping', () => {
    expect(factoryOptIn("- factory\n")).toBe("no");
    expect(factoryOptIn("")).toBe("no");
  });
});

describe("machine config", () => {
  it("machine valid resolves every field and the defaults", () => {
    expect(machine(MACHINE)).toEqual({
      ghConfigDir: "/Users/me/.config/softfac/gh",
      pollSeconds: 60,
      maxConcurrentRuns: 1,
      maxConcurrentGates: 2,
      feedbackSeconds: 600,
      notify: true,
      minFreeGib: 10,
      maxLoadPerCore: 1,
      modelFallbacks: {},
      repos: [{ repo: "rawphp/softfac", path: "/Users/me/factory-runner/rawphp/softfac" }],
      paradev: {
        cli: "/Applications/Superset.app/Contents/Resources/resources/bin/superset",
        agent: "claude",
        belt: { enabled: true, visibility: "just_me" },
      },
    });
    expect(machineLoaded(MACHINE).warnings).toEqual([]);
  });

  describe("repos", () => {
    it("is read in file order, and may be empty", () => {
      const t = edit(MACHINE, (tree) => {
        tree.repos = [
          { repo: "a/b", path: "/c/a-b" },
          { repo: "c/d", path: "/c/c-d" },
        ];
      });
      expect(machine(t).repos).toEqual([
        { repo: "a/b", path: "/c/a-b" },
        { repo: "c/d", path: "/c/c-d" },
      ]);
      expect(machine(edit(MACHINE, (tree) => set(tree, "repos", "[]"))).repos).toEqual([]);
    });

    it("is required", () => {
      assertOne(
        machineErr(edit(MACHINE, (tree) => remove(tree, "repos"))),
        "repos",
        MFILE,
      );
    });

    it("must be a list of entries with an owner/name repo and an absolute path", () => {
      for (const [yaml, field] of [
        ["nope", "repos"],
        ["{a: 1}", "repos"],
        ["[x]", "repos[0]"],
        ["[{path: /c/x}]", "repos[0].repo"],
        ["[{repo: a/b}]", "repos[0].path"],
        ["[{repo: ab, path: /c/x}]", "repos[0].repo"],
        ["[{repo: a/b, path: c/x}]", "repos[0].path"],
        ["[{repo: a/b, path: /c/x, pathh: y}]", "repos[0].pathh"],
        ["[{repo: a/b, path: /c/x}, {repo: A/B, path: /c/y}]", "repos[1].repo"],
      ] as const) {
        assertOne(machineErr(edit(MACHINE, (tree) => set(tree, "repos", yaml))), field, MFILE);
      }
    });
  });

  describe("paradev", () => {
    it("reads cli, agent, model, effort and the belt", () => {
      const t = edit(MACHINE, (tree) =>
        set(
          tree,
          "paradev",
          "{cli: /opt/superset, agent: claude, model: opus, effort: high, belt: {enabled: false, visibility: just_me}}",
        ),
      );
      expect(machine(t).paradev).toEqual({
        cli: "/opt/superset",
        agent: "claude",
        model: "opus",
        effort: "high",
        belt: { enabled: false, visibility: "just_me" },
      });
    });

    it("is required, and so is its agent", () => {
      assertOne(machineErr(edit(MACHINE, (tree) => remove(tree, "paradev"))), "paradev", MFILE);
      assertOne(
        machineErr(edit(MACHINE, (tree) => set(tree, "paradev", "{cli: /opt/superset}"))),
        "paradev.agent",
        MFILE,
      );
    });

    it("refuses an unknown key, naming its path", () => {
      assertOne(
        machineErr(edit(MACHINE, (tree) => set(tree, "paradev.belt", "{visibilty: org}"))),
        "paradev.belt.visibilty",
        MFILE,
      );
      assertOne(
        machineErr(edit(MACHINE, (tree) => set(tree, "paradev.location", "cloud"))),
        "paradev.location",
        MFILE,
      );
    });

    it("refuses belt.visibility everyone, naming the key's path", () => {
      const errs = machineErr(
        edit(MACHINE, (tree) => set(tree, "paradev.belt", "{visibility: everyone}")),
      );
      assertOne(errs, "paradev.belt.visibility", MFILE);
      expect(errs[0]!.message).toContain("everyone is refused");
    });

    it("loads belt.visibility org with one warning naming the key's path", () => {
      const loaded = machineLoaded(
        edit(MACHINE, (tree) => set(tree, "paradev.belt", "{visibility: org}")),
      );
      expect(loaded.config.paradev.belt.visibility).toBe("org");
      expect(loaded.warnings.map((w) => w.field)).toEqual(["paradev.belt.visibility"]);
    });

    it("refuses any other belt.visibility", () => {
      assertOne(
        machineErr(edit(MACHINE, (tree) => set(tree, "paradev.belt", "{visibility: public}"))),
        "paradev.belt.visibility",
        MFILE,
      );
    });

    it("builds the launch model with effort as its one option, and none without effort", () => {
      const withEffort = machine(
        edit(MACHINE, (tree) => set(tree, "paradev", "{agent: claude, model: opus, effort: high}")),
      ).paradev;
      expect(paradevModel(withEffort)).toEqual({
        instanceId: "claude",
        model: "opus",
        options: [{ id: "effort", value: "high" }],
      });
      expect(paradevModel(machine(MACHINE).paradev)).toEqual({ instanceId: "claude", model: "" });
    });
  });

  it("machine refuses a control_plane block, naming its path", () => {
    const errs = machineErr(
      edit(MACHINE, (tree) => set(tree, "control_plane", "{url: https://example.com}")),
    );
    assertOne(errs, "control_plane", MFILE);
    expect(errs[0]!.message).toBe("the control plane arrives in phase 4");
  });

  it("machine retired keys are one warning each, in the order of the retired list, never an error", () => {
    const loaded = machineLoaded(
      edit(MACHINE, (tree) => {
        set(tree, "keep_versions", '"3"');
        set(tree, "deploy_wait_minutes", "0");
        set(tree, "prune_branches_dry_run", "maybe");
        set(tree, "prune_branches_after_days", "14");
        set(tree, "model", "[x]");
        set(tree, "model_instance", "y");
      }),
    );
    expect(loaded.warnings.map((w) => w.field)).toEqual([
      "model_instance",
      "model",
      "prune_branches_after_days",
      "prune_branches_dry_run",
      "deploy_wait_minutes",
      "keep_versions",
    ]);
    expect(loaded.config).not.toHaveProperty("deployWaitMinutes");
    expect(loaded.warnings[4]).toEqual({
      file: MFILE,
      field: "deploy_wait_minutes",
      message: "is no longer used: the runner has no autodeploy",
    });
  });

  it("machine min_free_gib defaults to 10 and can be zero or more", () => {
    expect(machine(MACHINE).minFreeGib).toBe(10);
    for (const given of [0, 1, 25]) {
      expect(machine(edit(MACHINE, (t) => set(t, "min_free_gib", String(given)))).minFreeGib).toBe(
        given,
      );
    }
  });

  it("machine min_free_gib must be an integer of at least zero", () => {
    for (const bad of ['"ten"', "-1", "1.5"]) {
      const errs = machineErr(edit(MACHINE, (t) => set(t, "min_free_gib", bad)));
      assertOne(errs, "min_free_gib", MFILE);
    }
  });

  it("machine model_fallbacks may be absent or empty", () => {
    expect(machine(MACHINE).modelFallbacks).toEqual({});
    for (const empty of ["{}", "null"]) {
      expect(machine(edit(MACHINE, (t) => set(t, "model_fallbacks", empty))).modelFallbacks).toEqual(
        {},
      );
    }
  });

  it("machine refuses a non-empty model_fallbacks, naming the key", () => {
    for (const bad of ["{claude-fable-5-1: claude-opus-5-5}", "claude-opus-5-5", "[a]"]) {
      const errs = machineErr(edit(MACHINE, (t) => set(t, "model_fallbacks", bad)));
      assertOne(errs, "model_fallbacks", MFILE);
      expect(errs[0]!.message).toBe(
        "must be empty: Paradev cannot move a running session to another model through the CLI",
      );
    }
  });

  it("machine max_load_per_core defaults to 1 and can be zero or more", () => {
    expect(machine(MACHINE).maxLoadPerCore).toBe(1);
    for (const given of [0, 1, 4]) {
      expect(
        machine(edit(MACHINE, (t) => set(t, "max_load_per_core", String(given)))).maxLoadPerCore,
      ).toBe(given);
    }
  });

  it("machine max_load_per_core must be an integer of at least zero", () => {
    for (const bad of ['"one"', "-1", "1.5"]) {
      const errs = machineErr(edit(MACHINE, (t) => set(t, "max_load_per_core", bad)));
      assertOne(errs, "max_load_per_core", MFILE);
    }
  });

  it("machine feedback_seconds defaults to 600 and can be zero or more", () => {
    expect(machine(MACHINE).feedbackSeconds).toBe(600);
    for (const given of [0, 120]) {
      expect(
        machine(edit(MACHINE, (t) => set(t, "feedback_seconds", String(given)))).feedbackSeconds,
      ).toBe(given);
    }
  });

  it("machine feedback_seconds must be an integer of at least zero", () => {
    for (const bad of ["-1", "1.5"]) {
      const errs = machineErr(edit(MACHINE, (t) => set(t, "feedback_seconds", bad)));
      assertOne(errs, "feedback_seconds", MFILE);
      expect(errs[0]!.message).toBe("must be an integer of at least 0");
    }
  });

  it("machine notify can be turned off", () => {
    expect(machine(edit(MACHINE, (t) => set(t, "notify", "false"))).notify).toBe(false);
  });

  it("machine notify that is not a boolean is rejected", () => {
    const errs = machineErr(edit(MACHINE, (t) => set(t, "notify", '"no"')));
    assertOne(errs, "notify", MFILE);
    expect(errs[0]!.message).toBe("must be true or false");
  });

  it("machine every key can be set", () => {
    const t = edit(MACHINE, (tree) => {
      set(tree, "poll_seconds", "10");
      set(tree, "max_concurrent_runs", "3");
      set(tree, "max_concurrent_gates", "4");
    });
    const c = machine(t);
    expect(c.pollSeconds).toBe(10);
    expect(c.maxConcurrentRuns).toBe(3);
    expect(c.maxConcurrentGates).toBe(4);
  });

  describe("required keys", () => {
    it("machine missing gh config dir", () => machineMissing("gh_config_dir"));
    it("machine missing max concurrent runs", () => machineMissing("max_concurrent_runs"));
  });

  describe("integers", () => {
    it("machine poll seconds below 10 is rejected", () => {
      machineBad("poll_seconds", "9");
      expect(machineErr(edit(MACHINE, (t) => set(t, "poll_seconds", "9")))[0]!.message).toBe(
        "must be an integer of at least 10",
      );
    });
    it("machine poll seconds as a string is not an integer", () => {
      machineBad("poll_seconds", '"60"');
      expect(machineErr(edit(MACHINE, (t) => set(t, "poll_seconds", '"60"')))[0]!.message).toBe(
        "must be an integer",
      );
    });
    it("machine max concurrent runs of 0 is rejected", () => {
      machineBad("max_concurrent_runs", "0");
      expect(machineErr(edit(MACHINE, (t) => set(t, "max_concurrent_runs", "0")))[0]!.message).toBe(
        "must be an integer of at least 1",
      );
    });
    it("machine max concurrent gates of 0 is rejected", () => {
      machineBad("max_concurrent_gates", "0");
      expect(
        machineErr(edit(MACHINE, (t) => set(t, "max_concurrent_gates", "0")))[0]!.message,
      ).toBe("must be an integer of at least 1");
    });
  });

  describe("strings", () => {
    const KEYS = ["gh_config_dir"];
    it.each(KEYS)("machine %s empty", (key) => {
      machineBad(key, '""');
      expect(machineErr(edit(MACHINE, (t) => set(t, key, '""')))[0]!.message).toBe(
        "must not be empty",
      );
    });
    it.each(KEYS)("machine %s not a string", (key) => {
      machineBad(key, "[x]");
      expect(machineErr(edit(MACHINE, (t) => set(t, key, "[x]")))[0]!.message).toBe(
        "must be a string",
      );
    });
  });

  describe("unknown keys", () => {
    it("machine unknown top-level key is one file-level error", () => {
      const errs = machineErr(edit(MACHINE, (t) => set(t, "self_updte", "1")));
      assertFileLevel(errs, MFILE, "unknown key self_updte");
      expect(formatConfigError(errs[0]!)).toBe(`${MFILE}: unknown key self_updte`);
    });
    it("machine two unknown keys are two errors, after the field errors", () => {
      const t = edit(MACHINE, (tree) => {
        set(tree, "zzz", "1");
        remove(tree, "gh_config_dir");
        set(tree, "yyy", "2");
      });
      const errs = machineErr(t);
      expect(errs.map(formatConfigError)).toEqual([
        `${MFILE}: gh_config_dir: is missing`,
        `${MFILE}: unknown key zzz`,
        `${MFILE}: unknown key yyy`,
      ]);
    });
  });

  it("machine reports all errors together", () => {
    const t = edit(MACHINE, (tree) => {
      remove(tree, "gh_config_dir");
      set(tree, "poll_seconds", "1");
      set(tree, "max_concurrent_runs", "0");
    });
    expect(fields(machineErr(t))).toEqual(["gh_config_dir", "poll_seconds", "max_concurrent_runs"]);
  });

  it("machine invalid yaml names the file", () => {
    assertFileLevel(machineErr("repos: [unclosed\n"), MFILE, "not valid YAML");
  });

  it("machine document not a mapping", () => {
    assertFileLevel(machineErr("- a\n"), MFILE, "top level must be a mapping");
    assertFileLevel(machineErr(""), MFILE, "top level must be a mapping");
  });
});

describe("loaders", () => {
  const withTempDir = <A, E>(
    body: (
      dir: string,
      fs: FileSystem.FileSystem,
      path: Path.Path,
    ) => Effect.Effect<A, E, FileSystem.FileSystem>,
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "factory-config-" });
        return yield* body(dir, fs, path);
      }),
    ).pipe(Effect.provide(NodeServices.layer));

  effectIt.effect("loadMachineConfig on a missing path is none", () =>
    withTempDir((dir, _fs, path) =>
      Effect.gen(function* () {
        const loaded = yield* loadMachineConfig(path.join(dir, "nope.yml"));
        expect(Option.isNone(loaded)).toBe(true);
      }),
    ),
  );

  effectIt.effect("loadMachineConfig reads the file on every call", () =>
    withTempDir((dir, fs, path) =>
      Effect.gen(function* () {
        const file = path.join(dir, "config.yml");
        yield* fs.writeFileString(file, MACHINE);
        const first = yield* loadMachineConfig(file);
        expect(Option.map(first, (c) => c.config.maxConcurrentRuns)).toEqual(Option.some(1));

        yield* fs.writeFileString(
          file,
          MACHINE.replace("max_concurrent_runs: 1", "max_concurrent_runs: 3"),
        );
        const second = yield* loadMachineConfig(file);
        expect(Option.map(second, (c) => c.config.maxConcurrentRuns)).toEqual(Option.some(3));
      }),
    ),
  );

  effectIt.effect("loadMachineConfig fails with every error of an invalid file", () =>
    withTempDir((dir, fs, path) =>
      Effect.gen(function* () {
        const file = path.join(dir, "config.yml");
        yield* fs.writeFileString(file, MACHINE.replace("max_concurrent_runs: 1\n", ""));
        const failure = yield* Effect.flip(loadMachineConfig(file));
        expect(failure.errors.map(formatConfigError)).toEqual([
          `${file}: max_concurrent_runs: is missing`,
        ]);
      }),
    ),
  );

  effectIt.effect("loadMachineConfig on a directory fails with cannot read file", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const failure = yield* Effect.flip(loadMachineConfig(dir));
        assertFileLevel(failure.errors, dir, "cannot read file: ");
      }),
    ),
  );

  effectIt.effect("loadProjectConfig reads the file on every call", () =>
    withTempDir((dir, fs, path) =>
      Effect.gen(function* () {
        const file = path.join(dir, "config.yml");
        yield* fs.writeFileString(file, PROJECT);
        expect((yield* loadProjectConfig(file)).base).toBe("main");
        yield* fs.writeFileString(file, PROJECT.replace("base: main", "base: develop"));
        expect((yield* loadProjectConfig(file)).base).toBe("develop");
      }),
    ),
  );
});

describe("the example machine config", () => {
  // config.example.yml is what `install` copies to ~/.config/factory-runner/config.yml when there
  // is none, so it must load as it stands.
  effectIt.effect("the example machine config loads as it stands", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const file = yield* path.fromFileUrl(new URL("../config.example.yml", import.meta.url));
      expect(yield* loadMachineConfig(file)).toEqual(
        Option.some({
          warnings: [],
          config: {
            ghConfigDir: "/Users/tomkaczocha/.config/t3fac/gh",
            pollSeconds: 60,
            maxConcurrentRuns: 1,
            maxConcurrentGates: 1,
            feedbackSeconds: 600,
            notify: true,
            minFreeGib: 10,
            maxLoadPerCore: 1,
            modelFallbacks: {},
            repos: [
              {
                repo: "original-solutions/factory-paradev-spike",
                path: "/Users/tomkaczocha/factory-runner/original-solutions/factory-paradev-spike",
              },
            ],
            paradev: {
              cli: "/Applications/Superset.app/Contents/Resources/resources/bin/superset",
              agent: "claude",
              model: "opus",
              effort: "high",
              belt: { enabled: true, visibility: "just_me" },
            },
          },
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("machine default_project", () => {
  it("is absent from the config when the file has no block", () => {
    expect(machine(MACHINE).defaultProject).toBeUndefined();
  });

  it("reads the instructors and fills the limits, gate retries at 2", () => {
    const t = edit(MACHINE, (tree) =>
      set(tree, "default_project", "{instructors: [tomkaczocha, rawphp]}"),
    );
    expect(machine(t).defaultProject).toEqual({
      instructors: ["tomkaczocha", "rawphp"],
      limits: { minutes: 180, gateRetries: 2, checksMinutes: 30, interruptionResumes: 2 },
    });
  });

  it("takes the limits it is given", () => {
    const t = edit(MACHINE, (tree) =>
      set(
        tree,
        "default_project",
        "{instructors: [rawphp], limits: {gate_retries: 0, minutes: 90, checks_minutes: 10, interruption_resumes: 1}}",
      ),
    );
    expect(machine(t).defaultProject?.limits).toEqual({
      minutes: 90,
      gateRetries: 0,
      checksMinutes: 10,
      interruptionResumes: 1,
    });
  });

  it("an empty instructors list is an error naming the field", () => {
    const t = edit(MACHINE, (tree) => set(tree, "default_project", "{instructors: []}"));
    assertOne(machineErr(t), "default_project.instructors", MFILE);
  });

  it("a missing instructors list is an error naming the field", () => {
    const t = edit(MACHINE, (tree) => set(tree, "default_project", "{limits: {gate_retries: 1}}"));
    assertOne(machineErr(t), "default_project.instructors", MFILE);
  });

  it("an unknown key inside it is an error naming the field", () => {
    const t = edit(MACHINE, (tree) =>
      set(tree, "default_project", "{instructors: [rawphp], gate: [npm test]}"),
    );
    const errs = machineErr(t);
    assertOne(errs, "default_project.gate", MFILE);
    expect(formatConfigError(errs[0]!)).toBe(`${MFILE}: default_project.gate: unknown key`);
  });

  it("an unknown key inside its limits is an error naming the field", () => {
    const t = edit(MACHINE, (tree) =>
      set(tree, "default_project", "{instructors: [rawphp], limits: {regates: 3}}"),
    );
    assertOne(machineErr(t), "default_project.limits.regates", MFILE);
  });

  it("a block that is not a mapping is an error naming it", () => {
    const t = edit(MACHINE, (tree) => set(tree, "default_project", "[rawphp]"));
    assertOne(machineErr(t), "default_project", MFILE);
  });
});
