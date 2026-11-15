// @effect-diagnostics nodeBuiltinImport:off
// A release gives the plugin the runner's version and syncs the organization's source
// (docs/specs/P3-plugin.md, V4 and "Release"). None of this calls Paradev: `release-finish`
// runs against a stubbed `git` and `superset`.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = NodePath.resolve(import.meta.dirname, "..");
const fixtures = NodePath.join(root, "spike/fixtures/2.0.8");
const SKILL = "plugins/factory/skills/build";

const readJson = (path: string): any => JSON.parse(NodeFS.readFileSync(path, "utf8"));

/** Three numbers, so 0.3.10 is newer than 0.3.9. */
const compareVersions = (a: string, b: string): number => {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number));
  for (let i = 0; i < 3; i++) if (x![i] !== y![i]) return x![i]! - y![i]!;
  return 0;
};

let tmp: string;

beforeAll(() => {
  tmp = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3fac-release-")));
});

afterAll(() => {
  NodeFS.rmSync(tmp, { recursive: true, force: true });
});

describe("the plugin's version fields", () => {
  it("compares versions as three numbers", () => {
    expect(compareVersions("0.3.10", "0.3.9")).toBeGreaterThan(0);
    expect(compareVersions("0.3.9", "0.3.10")).toBeLessThan(0);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  });

  it("are the runner's version, and factory.minPluginVersion is no newer", () => {
    const pkg = readJson(NodePath.join(root, "package.json"));
    const plugin = readJson(NodePath.join(root, "plugins/factory/plugin.json"));
    const marketplace = readJson(NodePath.join(root, ".agent-marketplace.json"));
    const row = marketplace.plugins.find((p: { name: string }) => p.name === "factory");
    const file = NodeFS.readFileSync(NodePath.join(root, SKILL, "VERSION"), "utf8");

    expect(plugin.version).toBe(pkg.version);
    expect(row?.version).toBe(pkg.version);
    expect(file).toBe(`${pkg.version}\n`);
    expect(pkg.factory?.minPluginVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(compareVersions(pkg.factory.minPluginVersion, pkg.version)).toBeLessThanOrEqual(0);
  });
});

describe("npm version", () => {
  const git = (cwd: string, ...args: Array<string>) =>
    NodeChildProcess.execFileSync("git", args, { cwd, encoding: "utf8", env: gitEnv }).trim();
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.com",
  };

  /** A repo with this one's version script and plugin files at 0.3.4, tagged v0.3.4 when `tag`. */
  const repo = (name: string, tag = true) => {
    const dir = NodePath.join(tmp, name);
    const real = readJson(NodePath.join(root, "package.json"));
    const put = (path: string, text: string) => {
      NodeFS.mkdirSync(NodePath.dirname(NodePath.join(dir, path)), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(dir, path), text);
    };
    const pkg = { name: "t", version: "0.3.4", private: true, scripts: { version: real.scripts?.version }, factory: real.factory };
    put("package.json", `${JSON.stringify(pkg, null, 2)}\n`);
    for (const path of ["scripts/release-version.ts", "plugins/factory/plugin.json", ".agent-marketplace.json"]) {
      if (NodeFS.existsSync(NodePath.join(root, path))) put(path, NodeFS.readFileSync(NodePath.join(root, path), "utf8"));
    }
    put(`${SKILL}/SKILL.md`, "---\nname: build\n---\n");
    put(`${SKILL}/VERSION`, "0.3.4\n");
    put("README.md", "readme\n");
    git(dir, "init", "-q");
    git(dir, "add", ".");
    git(dir, "commit", "-qm", "init");
    if (tag) git(dir, "tag", "-a", "v0.3.4", "-m", "v0.3.4");
    return dir;
  };

  const change = (dir: string, path: string) => {
    NodeFS.appendFileSync(NodePath.join(dir, path), "more\n");
    git(dir, "commit", "-qam", `change ${path}`);
  };

  const npmVersion = (dir: string, version: string) =>
    NodeChildProcess.spawnSync("npm", ["version", version, "-m", "release: v%s"], { cwd: dir, encoding: "utf8", env: gitEnv });

  /** Every version field as the release commit holds it. */
  const committed = (dir: string) => {
    const show = (path: string) => git(dir, "show", `HEAD:${path}`);
    return {
      pkg: JSON.parse(show("package.json")),
      plugin: JSON.parse(show("plugins/factory/plugin.json")).version,
      marketplace: JSON.parse(show(".agent-marketplace.json")).plugins.find((p: { name: string }) => p.name === "factory").version,
      file: show(`${SKILL}/VERSION`),
    };
  };

  it("commits the new version in every field and keeps the minimum when the skill did not change", () => {
    const dir = repo("no-skill-change");
    change(dir, "README.md");

    const out = npmVersion(dir, "0.3.5");

    expect(out.status, out.stderr).toBe(0);
    const c = committed(dir);
    expect(c.pkg.version).toBe("0.3.5");
    expect(c.plugin).toBe("0.3.5");
    expect(c.marketplace).toBe("0.3.5");
    expect(c.file).toBe("0.3.5");
    expect(c.pkg.factory.minPluginVersion).toBe("0.3.4");
    expect(git(dir, "log", "-1", "--format=%s")).toBe("release: v0.3.5");
    expect(git(dir, "rev-parse", "v0.3.5^{commit}")).toBe(git(dir, "rev-parse", "HEAD"));
    expect(git(dir, "status", "--porcelain")).toBe("");
  });

  it("sets the minimum to the new version when the skill changed since the previous tag", () => {
    const dir = repo("skill-change");
    change(dir, `${SKILL}/SKILL.md`);

    const out = npmVersion(dir, "0.3.5");

    expect(out.status, out.stderr).toBe(0);
    const c = committed(dir);
    expect(c.file).toBe("0.3.5");
    expect(c.pkg.factory.minPluginVersion).toBe("0.3.5");
    expect(git(dir, "status", "--porcelain")).toBe("");
  });

  it("fails the release, with no commit, when there is no previous tag to compare the skill with", () => {
    const dir = repo("no-tag", false);
    const before = git(dir, "rev-parse", "HEAD");

    const out = npmVersion(dir, "0.3.5");

    expect(out.status).not.toBe(0);
    expect(git(dir, "rev-parse", "HEAD")).toBe(before);
    expect(git(dir, "tag", "--list")).toBe("");
  });
});

describe("make release", () => {
  const makefile = NodeFS.readFileSync(NodePath.join(root, "Makefile"), "utf8");
  const recipe = (target: string) => {
    const lines = makefile.split("\n");
    const start = lines.findIndex((l) => l.startsWith(`${target}:`));
    expect(start, `no ${target} target`).toBeGreaterThanOrEqual(0);
    const body: Array<string> = [];
    for (const line of lines.slice(start + 1)) {
      if (!line.startsWith("\t")) break;
      body.push(line);
    }
    return body;
  };

  it("holds no git push of its own: release-finish is the only push", () => {
    const body = recipe("release");
    expect(body.filter((l) => /git\s+push/.test(l))).toEqual([]);
  });

  it("validates the plugin before npm version and finishes with release-finish", () => {
    const body = recipe("release").join("\n");
    const validate = body.indexOf("superset plugins validate .");
    const version = body.indexOf("npm version");
    const finish = body.indexOf("release-finish");
    expect(validate).toBeGreaterThanOrEqual(0);
    expect(version).toBeGreaterThan(validate);
    expect(finish).toBeGreaterThan(version);
    expect(recipe("release-finish").join("\n")).toContain("scripts/release-finish.ts");
  });
});

describe("release-finish", () => {
  const VERSION = "0.1.1";
  const TAG = `v${VERSION}`;
  const RELEASE = "1111111111111111111111111111111111111111";
  const OLD = "0000000000000000000000000000000000000000";
  const LATER = "2222222222222222222222222222222222222222";
  const script = NodePath.join(root, "scripts/release-finish.ts");

  const sourcesAfter = readJson(NodePath.join(fixtures, "plugins-org-sources-list-after.json"));
  const problem = readJson(NodePath.join(fixtures, "plugins-org-sources-add-default.json")).syncProblems;
  const orgOld = readJson(NodePath.join(fixtures, "plugins-org-list-after.json"));
  const orgBumped = readJson(NodePath.join(fixtures, "plugins-org-list-after-bump.json"));
  const sources = (patch: Record<string, unknown>) => [{ ...sourcesAfter[0], ...patch }];

  type Case = {
    /** origin/main before the script pushes. */
    origin: string;
    /** Whether the release commit is in origin/main's history. */
    ancestor: boolean;
    sources?: unknown;
    org?: unknown;
  };

  /** Runs the script with `git` and `superset` stubbed, and returns every call each one got. */
  const finish = (name: string, c: Case) => {
    const state = NodePath.join(tmp, `finish-${name}`);
    const bin = NodePath.join(state, "bin");
    NodeFS.mkdirSync(bin, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(state, "origin"), c.origin);
    if (c.ancestor) NodeFS.writeFileSync(NodePath.join(state, "ancestor"), "");
    NodeFS.writeFileSync(NodePath.join(state, "sources.json"), JSON.stringify(c.sources ?? sources({ syncedSha: RELEASE })));
    NodeFS.writeFileSync(NodePath.join(state, "org.json"), JSON.stringify(c.org ?? orgBumped));
    const log = `printf '%s\\037' "$(basename "$0")" "$@" >> "$S/calls"; printf '\\n' >> "$S/calls"`;
    NodeFS.writeFileSync(
      NodePath.join(bin, "git"),
      `#!/usr/bin/env bash
S=${JSON.stringify(state)}
${log}
case "$1 $2" in
  "rev-parse --verify") [ "$3" = "${TAG}^{commit}" ] && echo ${RELEASE} || exit 128 ;;
  "rev-parse origin/main") cat "$S/origin"; echo ;;
  "fetch "*) ;;
  "merge-base --is-ancestor") [ "$(cat "$S/origin")" = ${RELEASE} ] || [ -f "$S/ancestor" ] || exit 1 ;;
  "push "*) case " $* " in *" main "*) printf ${RELEASE} > "$S/origin" ;; esac ;;
  *) echo "unexpected git $*" >&2; exit 99 ;;
esac
`,
      { mode: 0o755 },
    );
    NodeFS.writeFileSync(
      NodePath.join(bin, "superset"),
      `#!/usr/bin/env bash
S=${JSON.stringify(state)}
${log}
case "$*" in
  "plugins organization sources sync original-solutions/factory-on-paradev"*) cat ${JSON.stringify(NodePath.join(fixtures, "plugins-org-sources-sync.json"))} ;;
  "plugins organization sources list"*) cat "$S/sources.json" ;;
  "plugins organization list"*) cat "$S/org.json" ;;
  *) echo "unexpected superset $*" >&2; exit 99 ;;
esac
`,
      { mode: 0o755 },
    );
    const out = NodeChildProcess.spawnSync(process.execPath, [script, VERSION], {
      cwd: state,
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    const calls = NodeFS.existsSync(NodePath.join(state, "calls"))
      ? NodeFS.readFileSync(NodePath.join(state, "calls"), "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => l.split("\x1f").slice(0, -1))
      : [];
    return { status: out.status, stdout: out.stdout, stderr: out.stderr, calls };
  };

  const pushes = (calls: Array<Array<string>>) => calls.filter((c) => c[0] === "git" && c[1] === "push");
  const synced = (calls: Array<Array<string>>) => calls.some((c) => c[0] === "superset" && c.includes("sync"));

  /** No push names the tag or sends tags, and the push of main carries --no-follow-tags. */
  const expectNoTagPush = (calls: Array<Array<string>>) => {
    for (const push of pushes(calls)) {
      expect(push).not.toContain(TAG);
      expect(push.some((a) => a.includes("refs/tags"))).toBe(false);
      expect(push).not.toContain("--tags");
      expect(push).not.toContain("--follow-tags");
      if (push.includes("main")) expect(push).toContain("--no-follow-tags");
    }
  };

  it("pushes main without its tag, syncs, and pushes the tag last when the organization holds the release", () => {
    const out = finish("ok", { origin: OLD, ancestor: false });

    expect(out.status, out.stderr).toBe(0);
    const p = pushes(out.calls);
    expect(p).toHaveLength(2);
    expectNoTagPush(p.slice(0, 1));
    expect(p[0]).toContain("main");
    expect(out.calls.at(-1)).toEqual(["git", "push", "origin", TAG]);
    const sync = out.calls.findIndex((c) => c[0] === "superset" && c.includes("sync"));
    expect(sync).toBeGreaterThan(out.calls.indexOf(p[0]!));
  });

  it("does not push main again when origin/main already holds the release commit", () => {
    const out = finish("rerun", { origin: RELEASE, ancestor: true });

    expect(out.status, out.stderr).toBe(0);
    expect(pushes(out.calls)).toEqual([["git", "push", "origin", TAG]]);
  });

  it("fails with Paradev's text and pushes no tag when the sync has a problem", () => {
    const out = finish("problem", { origin: OLD, ancestor: false, sources: sources({ syncedSha: RELEASE, syncProblems: problem }) });

    expect(out.status).not.toBe(0);
    expect(out.stderr).toContain("its content changed but its version is still 0.1.1; bump the version");
    expect(out.stderr).toContain(`make release-finish VERSION=${VERSION}`);
    expectNoTagPush(out.calls);
  });

  it("fails and pushes no tag when the organization synced another commit", () => {
    const out = finish("other-sha", { origin: OLD, ancestor: false, sources: sources({ syncedSha: LATER }) });

    expect(out.status).not.toBe(0);
    expect(out.stderr).toContain(LATER);
    expectNoTagPush(out.calls);
  });

  it("fails and pushes no tag when the organization's factory is not at the new version", () => {
    const out = finish("old-version", { origin: OLD, ancestor: false, org: orgOld });

    expect(out.status).not.toBe(0);
    expect(out.stderr).toContain("0.1.0");
    expect(out.stderr).toContain(`make release-finish VERSION=${VERSION}`);
    expectNoTagPush(out.calls);
  });

  it("fails and pushes no tag when the organization has no factory", () => {
    const out = finish("no-factory", { origin: OLD, ancestor: false, org: [] });

    expect(out.status).not.toBe(0);
    expectNoTagPush(out.calls);
  });

  it("stops before the sync when main has moved past the release commit", () => {
    const out = finish("moved", { origin: LATER, ancestor: true });

    expect(out.status).not.toBe(0);
    expect(synced(out.calls)).toBe(false);
    expect(pushes(out.calls)).toEqual([]);
    expect(out.stderr).toContain("next release");
  });
});
