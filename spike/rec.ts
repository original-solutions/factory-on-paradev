// Records one answer of Paradev's `superset` CLI as a fixture.
// Usage: node spike/rec.ts <name> <superset args...>
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_BINARY = "/Applications/Superset.app/Contents/Resources/resources/bin/superset";
const DEFAULT_FIXTURE_DIR = "spike/fixtures/2.0.7";
const NAME = /^[a-z0-9][a-z0-9-]*$/;

export interface RecordOptions {
  binary: string;
  fixtureDir: string;
}

export function record(name: string, args: string[], { binary, fixtureDir }: RecordOptions): number {
  if (!NAME.test(name)) {
    process.stderr.write(`rec: invalid fixture name ${JSON.stringify(name)}: must match ${NAME.source}\n`);
    return 2;
  }

  const argv = args.includes("--json") ? args : [...args, "--json"];
  const startedAt = Date.now();
  const result = spawnSync(binary, argv, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  const durationMs = Date.now() - startedAt;

  const stdout = result.stdout ?? "";
  let stderr = result.stderr ?? "";
  if (result.error) stderr += `${result.error.message}\n`;
  const exit = result.status ?? 1;

  mkdirSync(fixtureDir, { recursive: true });
  const outPath = join(fixtureDir, `${name}.json`);
  if (stdout === "") rmSync(outPath, { force: true });
  else writeFileSync(outPath, stdout);
  const meta = { argv, exit, startedAt, durationMs, stderr };
  writeFileSync(join(fixtureDir, `${name}.meta.json`), `${JSON.stringify(meta, null, 2)}\n`);

  process.stdout.write(`rec ${name} exit=${exit}\n`);
  return exit;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [name = "", ...args] = process.argv.slice(2);
  process.exitCode = record(name, args, {
    binary: process.env.SUPERSET || DEFAULT_BINARY,
    fixtureDir: process.env.FIX || DEFAULT_FIXTURE_DIR,
  });
}
