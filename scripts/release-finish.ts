// `make release-finish VERSION=x`: the end of a release, after `npm version` made the commit and the
// local tag vX (docs/specs/P3-plugin.md, "Release", steps 3 to 5). It is the only place that syncs the
// organization's plugin source and the only place that pushes a tag, and a person can run it again.
//
// 3. Push main without its tag, then stop unless origin/main is the commit vX points at.
// 4. Sync the organization's source, and stop when it reports a problem, synced another commit,
//    or does not list factory at X.
// 5. Push the tag, last, so no runner's self-update sees a release the organization does not hold.
import { spawnSync } from "node:child_process";

const SOURCE = "original-solutions/factory-on-paradev";

const version = process.argv[2] ?? "";
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error("usage: make release-finish VERSION=0.1.0");
  process.exit(2);
}
const tag = `v${version}`;

const fail = (message: string, rerun = true): never => {
  console.error(`release-finish: ${message}`);
  if (rerun) console.error(`Fix the cause, then run: make release-finish VERSION=${version}`);
  process.exit(1);
};

const run = (command: string, ...args: Array<string>) => spawnSync(command, args, { encoding: "utf8" });

const must = (command: string, ...args: Array<string>): string => {
  const out = run(command, ...args);
  if (out.status !== 0) {
    fail(`${command} ${args.join(" ")} exited ${out.status ?? out.signal}: ${(out.stderr || out.stdout).trim()}`);
  }
  return out.stdout.trim();
};

const json = (command: string, ...args: Array<string>): any => {
  const text = must(command, ...args);
  try {
    return JSON.parse(text);
  } catch {
    return fail(`${command} ${args.join(" ")} did not answer JSON: ${text}`);
  }
};

const isAncestor = (commit: string, of: string) => {
  const out = run("git", "merge-base", "--is-ancestor", commit, of);
  if (out.status !== 0 && out.status !== 1) fail(`git merge-base exited ${out.status}: ${out.stderr.trim()}`);
  return out.status === 0;
};

// 3. main, without the tag.
const commit = must("git", "rev-parse", "--verify", `${tag}^{commit}`);
must("git", "fetch", "--quiet", "origin", "main");
if (!isAncestor(commit, "origin/main")) {
  must("git", "push", "--no-follow-tags", "origin", "main");
  must("git", "fetch", "--quiet", "origin", "main");
}
const head = must("git", "rev-parse", "origin/main");
if (head !== commit) {
  if (isAncestor(commit, head)) {
    fail(`origin/main has moved past ${tag} (${commit}) to ${head}. Nothing was synced and no tag was pushed; the next release carries this change.`, false);
  }
  fail(`origin/main is ${head}, not ${tag} (${commit}). Nothing was synced and no tag was pushed.`);
}

// 4. The organization's source.
must("superset", "plugins", "organization", "sources", "sync", SOURCE, "--json");
const sources = json("superset", "plugins", "organization", "sources", "list", "--json");
const source = Array.isArray(sources) ? sources.find((s: { repo?: string }) => s.repo === SOURCE) : undefined;
if (!source) fail(`the organization has no plugin source ${SOURCE}`);
if (source.syncError) fail(`the sync of ${SOURCE} failed: ${source.syncError}`);
const problems: Array<{ name?: string; reason?: string }> = source.syncProblems ?? [];
if (problems.length > 0) {
  fail(`the sync of ${SOURCE} has problems: ${problems.map((p) => `${p.name}: ${p.reason}`).join("; ")}`);
}
if (source.syncedSha !== commit) {
  fail(
    `the organization synced ${source.syncedSha}, not ${tag} (${commit}): a merge reached main before the sync. ` +
      `No tag was pushed; the next release replaces that text under a new version.`,
    false,
  );
}
const plugins = json("superset", "plugins", "organization", "list", "--json");
const factory = Array.isArray(plugins) ? plugins.find((p: { name?: string }) => p.name === "factory") : undefined;
if (factory?.version !== version) {
  fail(`the organization's factory is at ${factory?.version ?? "nothing"}, not ${version}`);
}

// 5. The tag, last.
must("git", "push", "origin", tag);
console.log(`release-finish: ${tag} is on origin, and the organization's factory is at ${version}`);
