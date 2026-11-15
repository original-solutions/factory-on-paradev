// `make release-finish VERSION=x`: the end of a release, after `npm version` made the commit and the
// local tag vX (docs/specs/P3-plugin.md, "Release", steps 3 to 5). It is the only place that syncs the
// organization's plugin source and the only place that pushes a tag, and a person can run it again.
//
// 3. Push the commit vX points at to main, without the tag, then stop unless origin/main is that commit.
// 4. Sync the organization's source, wait for the sync to land, and stop when it reports an error or a
//    problem, synced another commit, or the organization does not list factory at X.
// 5. Push the tag, last, so no runner's self-update sees a release the organization does not hold.
import { spawnSync } from "node:child_process";

const SOURCE = "original-solutions/factory-on-paradev";
// `sources sync` answers before the sync lands: the spike saw the source's syncedAt move 1 to 3 s later.
const SYNC_WAIT_MS = Number(process.env.RELEASE_FINISH_SYNC_WAIT_MS ?? 90_000);
const POLL_MS = 1_000;

const version = process.argv[2] ?? "";
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error("usage: make release-finish VERSION=0.1.0");
  process.exit(2);
}
const tag = `v${version}`;
const rerun = `make release-finish VERSION=${version}`;

/** Exits 1 with the message, and with the rerun command unless `advice` replaces it. */
const fail = (message: string, advice = `Fix the cause, then run: ${rerun}`): never => {
  console.error(`release-finish: ${message}`);
  if (advice) console.error(advice);
  process.exit(1);
};

const run = (command: string, ...args: Array<string>) => spawnSync(command, args, { encoding: "utf8" });

const output = (out: ReturnType<typeof run>) => out.error?.message ?? (out.stderr || out.stdout || "").trim();

const must = (command: string, ...args: Array<string>): string => {
  const out = run(command, ...args);
  if (out.status !== 0) fail(`${command} ${args.join(" ")} exited ${out.status ?? out.signal}: ${output(out)}`);
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
  if (out.status !== 0 && out.status !== 1) fail(`git merge-base exited ${out.status}: ${output(out)}`);
  return out.status === 0;
};

const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

type Source = { repo?: string; syncedSha?: string; syncedAt?: string; syncError?: string | null; syncProblems?: Array<{ name?: string; reason?: string }> };

const readSource = (): Source => {
  const sources = json("superset", "plugins", "organization", "sources", "list", "--json");
  const source = Array.isArray(sources) ? sources.find((s: Source) => s.repo === SOURCE) : undefined;
  return source ?? fail(`the organization has no plugin source ${SOURCE}`);
};

// 3. The release commit to main, without the tag. Pushing the commit and not the branch means a rerun
// never sends a commit made after the release.
const commit = must("git", "rev-parse", "--verify", `${tag}^{commit}`);
must("git", "fetch", "--quiet", "origin", "main");
if (!isAncestor(commit, "origin/main")) {
  const pushed = run("git", "push", "--no-follow-tags", "origin", `${commit}:refs/heads/main`);
  if (pushed.status !== 0) {
    fail(
      `origin refused ${tag} (${commit}) as main: ${output(pushed)}`,
      `If origin/main has moved on, drop the release commit and make the release again: ` +
        `git tag -d ${tag} && git fetch origin main && git reset --hard origin/main, then make release VERSION=${version}. ` +
        `If the push failed for another reason, run: ${rerun}`,
    );
  }
  must("git", "fetch", "--quiet", "origin", "main");
}
const head = must("git", "rev-parse", "origin/main");
if (head !== commit) {
  if (isAncestor(commit, head)) {
    fail(`origin/main has moved past ${tag} (${commit}) to ${head}. Stopped before the sync, and no tag was pushed.`, "The next release carries this change.");
  }
  fail(`origin/main is ${head}, not ${tag} (${commit}). Stopped before the sync, and no tag was pushed.`);
}

// 4. The organization's source.
const before = readSource();
must("superset", "plugins", "organization", "sources", "sync", SOURCE, "--json");
const deadline = Date.now() + SYNC_WAIT_MS;
let source = readSource();
while (source.syncedAt === before.syncedAt && source.syncError === before.syncError) {
  if (Date.now() >= deadline) {
    const last = before.syncError ? `, and it failed: ${before.syncError}` : "";
    fail(`the sync of ${SOURCE} had not landed after ${SYNC_WAIT_MS / 1000} s: its last sync is still ${before.syncedAt}${last}`);
  }
  sleep(POLL_MS);
  source = readSource();
}
if (source.syncError) fail(`the sync of ${SOURCE} failed: ${source.syncError}`);
const problems = source.syncProblems ?? [];
if (problems.length > 0) {
  fail(`the sync of ${SOURCE} has problems: ${problems.map((p) => `${p.name}: ${p.reason}`).join("; ")}`);
}
if (source.syncedSha !== commit) {
  fail(
    `the organization synced ${source.syncedSha}, not ${tag} (${commit}): a merge reached main before the sync. No tag was pushed.`,
    "The next release replaces that text under a new version.",
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
