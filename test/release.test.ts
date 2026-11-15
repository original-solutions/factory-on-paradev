// @effect-diagnostics nodeBuiltinImport:off
// A release gives the plugin the runner's version and syncs the organization's source
// (docs/specs/P3-plugin.md, V4 and "Release"). None of this calls Paradev: `release-finish`
// runs against a stubbed `git` and `superset`.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { compareVersions, parseVersion } from "../src/version.ts";

const root = NodePath.resolve(import.meta.dirname, "..");
const fixtures = NodePath.join(root, "spike/fixtures/2.0.8");
const SKILL = "plugins/factory/skills/build";

const readJson = (path: string): any => JSON.parse(NodeFS.readFileSync(path, "utf8"));

/** The runner's own comparison, so 0.3.10 is newer than 0.3.9. */
const compare = (a: string, b: string): number => compareVersions(parseVersion(a)!, parseVersion(b)!);

let tmp: string;

beforeAll(() => {
  tmp = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3fac-release-")));
});

afterAll(() => {
  NodeFS.rmSync(tmp, { recursive: true, force: true });
});

describe("the plugin's version fields", () => {
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
    expect(compare(pkg.factory.minPluginVersion, pkg.version)).toBeLessThanOrEqual(0);
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

  /**
   * A repo with this one's version script and plugin files at 0.3.4, minimum 0.3.4, tagged v0.3.4
   * when `tag`. Only the script comes from this repo, so a release here does not move the fixture.
   */
  const repo = (name: string, tag = true) => {
    const dir = NodePath.join(tmp, name);
    const real = readJson(NodePath.join(root, "package.json"));
    const put = (path: string, text: string) => {
      NodeFS.mkdirSync(NodePath.dirname(NodePath.join(dir, path)), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(dir, path), text);
    };
    const pkg = {
      name: "t",
      version: "0.3.4",
      private: true,
      scripts: { version: real.scripts?.version },
      factory: { minPluginVersion: "0.3.4" },
    };
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

  const npmVersion = (dir: string, version: string, env: NodeJS.ProcessEnv = gitEnv) =>
    NodeChildProcess.spawnSync("npm", ["version", version, "-m", "release: v%s"], { cwd: dir, encoding: "utf8", env });

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

  it("fails the release, with no commit, when the skill diff exits above 1", () => {
    const dir = repo("diff-error");
    change(dir, "README.md");
    const before = git(dir, "rev-parse", "HEAD");
    // A git that answers 128 to `diff --quiet`, as on a damaged object, and is the real git otherwise.
    const bin = NodePath.join(tmp, "diff-error-bin");
    NodeFS.mkdirSync(bin, { recursive: true });
    const real = NodeChildProcess.execFileSync("bash", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    NodeFS.writeFileSync(
      NodePath.join(bin, "git"),
      `#!/usr/bin/env bash\n[ "$1 $2" = "diff --quiet" ] && { echo "fatal: bad object" >&2; exit 128; }\nexec ${JSON.stringify(real)} "$@"\n`,
      { mode: 0o755 },
    );

    const out = npmVersion(dir, "0.3.5", { ...gitEnv, PATH: `${bin}:${process.env.PATH}` });

    expect(out.status).not.toBe(0);
    expect(out.stderr).toContain("exited 128");
    expect(git(dir, "rev-parse", "HEAD")).toBe(before);
    expect(git(dir, "tag", "--list", "v0.3.5")).toBe("");
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

  /** Runs the real recipe in a folder of its own, with every command it calls stubbed, and returns the calls. */
  const release = (name: string, version: string, git: { branch?: string; head?: string; origin?: string } = {}) => {
    const dir = NodePath.join(tmp, `make-${name}`);
    const bin = NodePath.join(dir, "bin");
    NodeFS.mkdirSync(bin, { recursive: true });
    NodeFS.copyFileSync(NodePath.join(root, "Makefile"), NodePath.join(dir, "Makefile"));
    const log = `printf '%s ' "$(basename "$0")" "$@" >> ${JSON.stringify(NodePath.join(dir, "calls"))}; printf '\\n' >> ${JSON.stringify(NodePath.join(dir, "calls"))}`;
    for (const command of ["npm", "superset", "node"]) {
      NodeFS.writeFileSync(NodePath.join(bin, command), `#!/usr/bin/env bash\n${log}\n`, { mode: 0o755 });
    }
    NodeFS.writeFileSync(
      NodePath.join(bin, "git"),
      `#!/usr/bin/env bash
${log}
case "$*" in
  "rev-parse --abbrev-ref HEAD") echo ${git.branch ?? "main"} ;;
  "rev-parse HEAD") echo ${git.head ?? "aaaa"} ;;
  "rev-parse origin/main") echo ${git.origin ?? "aaaa"} ;;
  "fetch --quiet origin main") ;;
  *) echo "unexpected git $*" >&2; exit 99 ;;
esac
`,
      { mode: 0o755 },
    );
    // npm sets NODE to its own node for the scripts it runs, and the Makefile's `NODE ?= node` would take it.
    const { NODE: _node, ...env } = process.env;
    const out = NodeChildProcess.spawnSync("make", ["release", `VERSION=${version}`], {
      cwd: dir,
      encoding: "utf8",
      env: { ...env, PATH: `${bin}:${process.env.PATH}`, MAKEFLAGS: "", MAKELEVEL: "" },
    });
    const calls = NodeFS.existsSync(NodePath.join(dir, "calls"))
      ? NodeFS.readFileSync(NodePath.join(dir, "calls"), "utf8").split("\n").filter(Boolean).map((l) => l.trim())
      : [];
    return { status: out.status, output: out.stdout + out.stderr, calls };
  };
  const bumped = (calls: Array<string>) => calls.some((c) => c.startsWith("npm version"));

  it("runs the gate, checks main against origin, validates, bumps, then finishes", () => {
    const out = release("ok", "0.1.1");

    expect(out.status, out.output).toBe(0);
    expect(out.calls).toEqual([
      "npm ci",
      "npm run check",
      "git rev-parse --abbrev-ref HEAD",
      "git fetch --quiet origin main",
      "git rev-parse HEAD",
      "git rev-parse origin/main",
      "superset plugins validate .",
      "npm version 0.1.1 -m release: v%s",
      "node scripts/release-finish.ts 0.1.1",
    ]);
  });

  it.each(["1.2", "v0.1.1", "0.1.1-rc.1", "0.1"])("refuses VERSION=%s, which is not three numbers, before npm version", (version) => {
    const out = release(`version-${version}`, version);

    expect(out.status).not.toBe(0);
    expect(out.output).toContain("VERSION is three numbers");
    expect(bumped(out.calls)).toBe(false);
  });

  it("refuses a branch that is not main before npm version", () => {
    const out = release("branch", "0.1.1", { branch: "fix/x" });

    expect(out.status).not.toBe(0);
    expect(out.output).toContain("release from main");
    expect(bumped(out.calls)).toBe(false);
  });

  it("refuses a main that is not origin/main, after a fetch and before npm version", () => {
    const out = release("stale", "0.1.1", { head: "aaaa", origin: "bbbb" });

    expect(out.status).not.toBe(0);
    expect(out.output).toContain("main is not origin/main");
    expect(out.calls).toContain("git fetch --quiet origin main");
    expect(bumped(out.calls)).toBe(false);
    expect(out.calls.some((c) => c.startsWith("superset") || c.startsWith("node"))).toBe(false);
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

  // The source's last sync, before and after the release's own sync lands.
  const BEFORE = "2026-11-15T10:23:55.578Z";
  const AFTER = "2026-11-15T10:24:01.758Z";

  type Case = {
    /** origin/main before the script pushes. */
    origin: string;
    /** Whether the release commit is in origin/main's history. */
    ancestor: boolean;
    /** The push of main is refused as not a fast-forward. */
    rejected?: boolean;
    /** `sources list` before the release's sync has landed. */
    before?: unknown;
    /** `sources list` once it has. */
    sources?: unknown;
    /** How many `sources list` reads after the sync still answer `before`. */
    lag?: number;
    org?: unknown;
    /** `sources list` never answers once the sync was asked for. */
    hang?: boolean;
    env?: NodeJS.ProcessEnv;
  };

  /** Runs the script with `git` and `superset` stubbed, and returns every call each one got. */
  const finish = (name: string, c: Case) => {
    const state = NodePath.join(tmp, `finish-${name}`);
    const bin = NodePath.join(state, "bin");
    NodeFS.mkdirSync(bin, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(state, "origin"), c.origin);
    if (c.ancestor) NodeFS.writeFileSync(NodePath.join(state, "ancestor"), "");
    if (c.rejected) NodeFS.writeFileSync(NodePath.join(state, "rejected"), "");
    if (c.hang) NodeFS.writeFileSync(NodePath.join(state, "hang"), "");
    NodeFS.writeFileSync(NodePath.join(state, "before.json"), JSON.stringify(c.before ?? sources({ syncedSha: OLD, syncedAt: BEFORE })));
    NodeFS.writeFileSync(NodePath.join(state, "after.json"), JSON.stringify(c.sources ?? sources({ syncedSha: RELEASE, syncedAt: AFTER })));
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
  "push "*)
    case " $* " in
      *":refs/heads/main "*)
        [ -f "$S/rejected" ] && { echo " ! [rejected]        ${RELEASE} -> main (non-fast-forward)" >&2; exit 1; }
        printf ${RELEASE} > "$S/origin" ;;
    esac ;;
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
  "plugins organization sources sync original-solutions/factory-on-paradev"*)
    touch "$S/synced"; cat ${JSON.stringify(NodePath.join(fixtures, "plugins-org-sources-sync.json"))} ;;
  "plugins organization sources list"*)
    if [ -f "$S/synced" ]; then
      [ -f "$S/hang" ] && exec sleep 30
      n=$(( $(cat "$S/reads" 2>/dev/null || echo 0) + 1 )); echo $n > "$S/reads"
      [ $n -gt ${c.lag ?? 0} ] && cat "$S/after.json" || cat "$S/before.json"
    else
      cat "$S/before.json"
    fi ;;
  "plugins organization list"*) cat "$S/org.json" ;;
  *) echo "unexpected superset $*" >&2; exit 99 ;;
esac
`,
      { mode: 0o755 },
    );
    const out = NodeChildProcess.spawnSync(process.execPath, [script, VERSION], {
      cwd: state,
      encoding: "utf8",
      env: { ...process.env, ...c.env, PATH: `${bin}:${process.env.PATH}` },
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
  const pushMain = ["git", "push", "--no-follow-tags", "origin", `${RELEASE}:refs/heads/main`];

  /** No push names the tag or sends tags, and the push of main carries --no-follow-tags. */
  const expectNoTagPush = (calls: Array<Array<string>>) => {
    for (const push of pushes(calls)) {
      expect(push).not.toContain(TAG);
      expect(push.some((a) => a.includes("refs/tags"))).toBe(false);
      expect(push).not.toContain("--tags");
      expect(push).not.toContain("--follow-tags");
      if (push.some((a) => a.endsWith("refs/heads/main"))) expect(push).toContain("--no-follow-tags");
    }
  };

  it("pushes the release commit to main without its tag, syncs, and pushes the tag last when the organization holds the release", () => {
    const out = finish("ok", { origin: OLD, ancestor: false });

    expect(out.status, out.stderr).toBe(0);
    const p = pushes(out.calls);
    expect(p).toEqual([pushMain, ["git", "push", "origin", TAG]]);
    expectNoTagPush(p.slice(0, 1));
    expect(out.calls.at(-1)).toEqual(["git", "push", "origin", TAG]);
    const sync = out.calls.findIndex((c) => c[0] === "superset" && c.includes("sync"));
    expect(sync).toBeGreaterThan(out.calls.findIndex((c) => c[1] === "push"));
  });

  it("does not push main again when origin/main already holds the release commit", () => {
    const out = finish("rerun", { origin: RELEASE, ancestor: true });

    expect(out.status, out.stderr).toBe(0);
    expect(pushes(out.calls)).toEqual([["git", "push", "origin", TAG]]);
  });

  it("waits for the sync to land before it judges the source", () => {
    const out = finish("late", { origin: OLD, ancestor: false, lag: 1 });

    expect(out.status, out.stderr).toBe(0);
    expect(out.calls.at(-1)).toEqual(["git", "push", "origin", TAG]);
  });

  it("fails, with the rerun command and no tag push, when the sync does not land in time", () => {
    const out = finish("never", { origin: OLD, ancestor: false, lag: 999, env: { RELEASE_FINISH_SYNC_WAIT_MS: "1500" } });

    expect(out.status).not.toBe(0);
    expect(out.stderr).toContain("had not landed");
    expect(out.stderr).toContain(`make release-finish VERSION=${VERSION}`);
    expectNoTagPush(out.calls);
  });

  it("fails, with the rerun command and no tag push, when a superset call never answers", () => {
    const started = Date.now();
    const out = finish("hang", { origin: OLD, ancestor: false, hang: true, env: { RELEASE_FINISH_CALL_TIMEOUT_MS: "500" } });

    expect(out.status).toBe(1);
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(synced(out.calls)).toBe(true);
    expect(out.stderr).toContain("superset plugins organization sources list --json did not answer within 0.5 s");
    expect(out.stderr).toContain(`make release-finish VERSION=${VERSION}`);
    expectNoTagPush(out.calls);
  });

  it("names the last sync's error when a sync that fails the same way again does not move the source", () => {
    const failed = sources({ syncedSha: OLD, syncedAt: BEFORE, syncError: "repository not found" });
    const out = finish("same-error", {
      origin: OLD,
      ancestor: false,
      before: failed,
      sources: failed,
      env: { RELEASE_FINISH_SYNC_WAIT_MS: "1500" },
    });

    expect(out.status).not.toBe(0);
    expect(out.stderr).toContain("repository not found");
    expectNoTagPush(out.calls);
  });

  it("fails with Paradev's text and pushes no tag when the sync has a problem", () => {
    const out = finish("problem", {
      origin: OLD,
      ancestor: false,
      sources: sources({ syncedSha: RELEASE, syncedAt: AFTER, syncProblems: problem }),
    });

    expect(out.status).not.toBe(0);
    expect(out.stderr).toContain("its content changed but its version is still 0.1.1; bump the version");
    expect(out.stderr).toContain(`make release-finish VERSION=${VERSION}`);
    expectNoTagPush(out.calls);
  });

  it("fails with Paradev's text and pushes no tag when the sync reports an error", () => {
    const out = finish("sync-error", {
      origin: OLD,
      ancestor: false,
      sources: sources({ syncedSha: OLD, syncedAt: BEFORE, syncError: "repository not found" }),
    });

    expect(out.status).not.toBe(0);
    expect(out.stderr).toContain("repository not found");
    expect(out.stderr).toContain(`make release-finish VERSION=${VERSION}`);
    expectNoTagPush(out.calls);
  });

  it("fails and pushes no tag when the organization synced another commit", () => {
    const out = finish("other-sha", { origin: OLD, ancestor: false, sources: sources({ syncedSha: LATER, syncedAt: AFTER }) });

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

  it("fails before the sync when the organization has no source for this repo", () => {
    const out = finish("no-source", { origin: OLD, ancestor: false, before: sources({ repo: "someone/else" }) });

    expect(out.status).not.toBe(0);
    expect(out.stderr).toContain("no plugin source original-solutions/factory-on-paradev");
    expect(synced(out.calls)).toBe(false);
    expectNoTagPush(out.calls);
  });

  it("stops before the sync, and says how to redo the release, when origin refuses the push of main", () => {
    const out = finish("rejected", { origin: LATER, ancestor: false, rejected: true });

    expect(out.status).not.toBe(0);
    expect(synced(out.calls)).toBe(false);
    expect(pushes(out.calls)).toEqual([pushMain]);
    expect(out.stderr).toContain(`git tag -d ${TAG} && git fetch origin main && git reset --hard origin/main`);
    expect(out.stderr).toContain(`make release VERSION=${VERSION}`);
  });

  it("stops before the sync when main has moved past the release commit", () => {
    const out = finish("moved", { origin: LATER, ancestor: true });

    expect(out.status).not.toBe(0);
    expect(synced(out.calls)).toBe(false);
    expect(pushes(out.calls)).toEqual([]);
    expect(out.stderr).toContain("next release");
  });
});
