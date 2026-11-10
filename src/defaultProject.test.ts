import * as Result from "effect/Result";
import { describe, expect, it } from "vitest";

import {
  type DefaultProject,
  type RepoFiles,
  inferCommands,
  resolveDefault,
} from "./defaultProject.ts";

const pkg = (...scripts: Array<string>) =>
  JSON.stringify({ name: "x", scripts: Object.fromEntries(scripts.map((s) => [s, `run ${s}`])) });

const composer = (...scripts: Array<string>) =>
  JSON.stringify({ name: "a/b", scripts: Object.fromEntries(scripts.map((s) => [s, "phpunit"])) });

const files = (over: Partial<RepoFiles>): RepoFiles => ({
  packageJson: null,
  composerJson: null,
  lockfiles: [],
  ...over,
});

const ALL = ["test", "format:check", "build", "lint", "typecheck", "dev"] as const;

describe("inferCommands", () => {
  it("npm with all five scripts runs them in the table's order", () => {
    expect(
      inferCommands(files({ packageJson: pkg(...ALL), lockfiles: ["package-lock.json"] })),
    ).toEqual({
      provision: ["npm ci"],
      gate: [
        "npm run typecheck",
        "npm run lint",
        "npm run build",
        "npm run test",
        "npm run format:check",
      ],
    });
  });

  it("npm with only test", () => {
    expect(
      inferCommands(files({ packageJson: pkg("test"), lockfiles: ["package-lock.json"] })),
    ).toEqual({
      provision: ["npm ci"],
      gate: ["npm run test"],
    });
  });

  it("pnpm", () => {
    expect(
      inferCommands(files({ packageJson: pkg("lint", "test"), lockfiles: ["pnpm-lock.yaml"] })),
    ).toEqual({
      provision: ["pnpm install --frozen-lockfile"],
      gate: ["pnpm run lint", "pnpm run test"],
    });
  });

  it("bun, by either lockfile", () => {
    for (const lock of ["bun.lock", "bun.lockb"]) {
      expect(inferCommands(files({ packageJson: pkg("build"), lockfiles: [lock] }))).toEqual({
        provision: ["bun install --frozen-lockfile"],
        gate: ["bun run build"],
      });
    }
  });

  it("yarn", () => {
    expect(inferCommands(files({ packageJson: pkg("test"), lockfiles: ["yarn.lock"] }))).toEqual({
      provision: ["yarn install --frozen-lockfile"],
      gate: ["yarn run test"],
    });
  });

  it("composer with check prefers check over test", () => {
    expect(inferCommands(files({ composerJson: composer("check", "test") }))).toEqual({
      provision: ["composer install --no-interaction --no-progress"],
      gate: ["composer check"],
    });
  });

  it("composer with only test", () => {
    expect(inferCommands(files({ composerJson: composer("test") }))).toEqual({
      provision: ["composer install --no-interaction --no-progress"],
      gate: ["composer test"],
    });
  });

  it("a repo with both manifests lists composer first", () => {
    expect(
      inferCommands(
        files({
          composerJson: composer("test"),
          packageJson: pkg("build", "test"),
          lockfiles: ["package-lock.json"],
        }),
      ),
    ).toEqual({
      provision: ["composer install --no-interaction --no-progress", "npm ci"],
      gate: ["composer test", "npm run build", "npm run test"],
    });
  });

  it("a repo with no manifest infers nothing", () => {
    expect(inferCommands(files({}))).toEqual({ provision: [], gate: [] });
  });

  it("a lockfile with no package.json infers nothing", () => {
    expect(inferCommands(files({ lockfiles: ["package-lock.json"] }))).toEqual({
      provision: [],
      gate: [],
    });
  });

  it("a package.json with no lockfile, or one that is not JSON, infers nothing", () => {
    expect(inferCommands(files({ packageJson: pkg("test") }))).toEqual({ provision: [], gate: [] });
    expect(
      inferCommands(files({ packageJson: "{ not json", lockfiles: ["package-lock.json"] })),
    ).toEqual({ provision: ["npm ci"], gate: [] });
  });

  it("agent-doctor: package-lock with build, test and format:check", () => {
    expect(
      inferCommands(
        files({
          packageJson: pkg("build", "test", "format:check"),
          lockfiles: ["package-lock.json"],
        }),
      ),
    ).toEqual({
      provision: ["npm ci"],
      gate: ["npm run build", "npm run test", "npm run format:check"],
    });
  });
});

const DEFAULT: DefaultProject = {
  instructors: ["tomkaczocha", "rawphp"],
  limits: { minutes: 180, gateRetries: 2, checksMinutes: 30, interruptionResumes: 2 },
};

/** What the checkout's origin/HEAD names, with its files. */
const on = (branch: string, found: RepoFiles) => ({ branch, files: found });

describe("resolveDefault", () => {
  it("resolves the default block on the repo's default branch", () => {
    const resolved = resolveDefault(
      DEFAULT,
      "trunk",
      on("trunk", files({ packageJson: pkg("test"), lockfiles: ["package-lock.json"] })),
    );
    expect(Result.isSuccess(resolved) && resolved.success).toEqual({
      instructors: ["tomkaczocha", "rawphp"],
      base: "trunk",
      provision: ["npm ci"],
      gate: ["npm run test"],
      requiredChecks: [],
      limits: DEFAULT.limits,
      autonomy: "pr",
      owner: null,
    });
  });

  it("follows the files it is given, so a script added between two reads joins the gate", () => {
    const before = resolveDefault(
      DEFAULT,
      "main",
      on("main", files({ packageJson: pkg("test"), lockfiles: ["package-lock.json"] })),
    );
    const after = resolveDefault(
      DEFAULT,
      "main",
      on("main", files({ packageJson: pkg("test", "lint"), lockfiles: ["package-lock.json"] })),
    );
    expect(Result.isSuccess(before) && before.success.gate).toEqual(["npm run test"]);
    expect(Result.isSuccess(after) && after.success.gate).toEqual(["npm run lint", "npm run test"]);
  });

  it("a checkout with no origin/HEAD is one error saying how to set it", () => {
    const resolved = resolveDefault(DEFAULT, "main", null);
    expect(Result.isFailure(resolved) && resolved.failure).toEqual([
      {
        file: ".dw/config.yml",
        message:
          "the checkout has no origin/HEAD, so its files cannot be read: run `git remote set-head origin --auto` in it",
      },
    ]);
  });

  it("an origin/HEAD that names another branch than GitHub's default is one error", () => {
    const resolved = resolveDefault(
      DEFAULT,
      "main",
      on("master", files({ packageJson: pkg("test"), lockfiles: ["package-lock.json"] })),
    );
    expect(Result.isFailure(resolved) && resolved.failure).toEqual([
      {
        file: ".dw/config.yml",
        message:
          "the checkout's origin/HEAD is master, but the default branch on GitHub is main: run `git remote set-head origin --auto` in it",
      },
    ]);
  });

  it("no inferred gate is one error saying a factory block is needed", () => {
    const resolved = resolveDefault(DEFAULT, "main", on("main", files({})));
    expect(Result.isFailure(resolved)).toBe(true);
    if (Result.isFailure(resolved)) {
      expect(resolved.failure).toHaveLength(1);
      expect(resolved.failure[0]!.message).toContain("no gate could be inferred");
      expect(resolved.failure[0]!.message).toContain("factory block in .dw/config.yml");
    }
  });
});
