// npm runs this as the `version` script of `npm version`: after it writes the new version to
// package.json and before it commits. It gives the plugin the runner's version and stages the files,
// so the release commit and its v* tag hold one number in all four places (docs/specs/P3-plugin.md, V4).
// When the skill changed since the previous v* tag, the new version is also the plugin a target needs:
// factory.minPluginVersion. Any failure exits 1, and npm then makes no commit and no tag.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const SKILLS = "plugins/factory/skills";
const VERSION_FILE = `${SKILLS}/build/VERSION`;
const PLUGIN = "plugins/factory/plugin.json";
const MARKETPLACE = ".agent-marketplace.json";

const fail = (message: string): never => {
  console.error(`release-version: ${message}`);
  process.exit(1);
};

const git = (...args: Array<string>) => spawnSync("git", args, { encoding: "utf8" });

const readJson = (path: string): any => JSON.parse(readFileSync(path, "utf8"));
const writeJson = (path: string, value: unknown, indent: string) =>
  writeFileSync(path, `${JSON.stringify(value, null, indent)}\n`);

const pkg = readJson("package.json");
const version: string = pkg.version;

const plugin = readJson(PLUGIN);
plugin.version = version;
writeJson(PLUGIN, plugin, "\t");

const marketplace = readJson(MARKETPLACE);
const row = marketplace.plugins?.find((p: { name?: string }) => p.name === "factory");
if (!row) fail(`${MARKETPLACE} has no factory row`);
row.version = version;
writeJson(MARKETPLACE, marketplace, "\t");

writeFileSync(VERSION_FILE, `${version}\n`);

// The previous release: the nearest v* tag behind HEAD, which npm has not tagged yet.
const described = git("describe", "--tags", "--abbrev=0", "--match", "v*");
if (described.status !== 0) fail(`no previous v* tag to compare the skill with: ${described.stderr.trim()}`);
const previous = described.stdout.trim();

const diff = git("diff", "--quiet", previous, "--", SKILLS, `:!${VERSION_FILE}`);
if (diff.status === 1) {
  pkg.factory = { ...pkg.factory, minPluginVersion: version };
  writeJson("package.json", pkg, "  ");
  console.log(`release-version: the skill changed since ${previous}; factory.minPluginVersion is ${version}`);
} else if (diff.status !== 0) {
  fail(`git diff against ${previous} exited ${diff.status ?? diff.signal}: ${diff.stderr.trim()}`);
}

const add = git("add", "--", "package.json", PLUGIN, MARKETPLACE, VERSION_FILE);
if (add.status !== 0) fail(`git add failed: ${add.stderr.trim()}`);
