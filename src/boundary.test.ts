// @effect-diagnostics nodeBuiltinImport:off - the test reads the source tree.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vitest";

interface SourceFile {
  /** Relative to the repo root, with `/` separators, e.g. `src/main.ts`. */
  readonly path: string;
  readonly text: string;
}

const PARADEV = "src/paradev/";
/** The one file outside `src/paradev/` that builds on the adapter: the layer graph. */
const MAIN = "src/main.ts";

/**
 * The host readings and `hosts check`: ssh to a host, its load, and the checklist. They spawn only
 * `ssh`, or take a command runner, so the pass, the CLI and install may import them.
 */
const HOST_READINGS = new Set([
  "src/paradev/ssh.ts",
  "src/paradev/hostLoad.ts",
  "src/paradev/hostsCheck.ts",
]);

const resolveRelative = (file: string, specifier: string) =>
  NodePath.posix.normalize(NodePath.posix.join(NodePath.posix.dirname(file), specifier));

const IMPORT_PATTERNS = [
  /\bfrom\s*"([^"]+)"/g,
  /\bfrom\s*'([^']+)'/g,
  /\bimport\s*"([^"]+)"/g,
  /\bimport\s*'([^']+)'/g,
  /\bimport\(\s*"([^"]+)"\s*\)/g,
  /\bimport\(\s*'([^']+)'\s*\)/g,
];

export const extractImports = (source: string): Array<string> =>
  IMPORT_PATTERNS.flatMap((pattern) => Array.from(source.matchAll(pattern), (match) => match[1]!));

/** A test, or a helper only tests import: these may use `fake-superset` from `src/paradev/`. */
const isTestCode = (path: string) =>
  /\.test\.tsx?$/.test(path) || /(^|\/)testSupport\.ts$/.test(path);

/** The file starts a child process: it imports `node:child_process`, or runs a command through `FactoryProcess`. */
const startsProcesses = (text: string) =>
  /["']node:child_process["']/.test(text) || /\.run\(\s*\{[^}]*\bcommand:/s.test(text);

/** A string literal in the file names `superset`: a binary path, a command, an argv. */
const namesSuperset = (text: string) => /["'`][^"'`\n]*superset/i.test(text);

/**
 * Only `src/paradev/**` may spawn `superset`: no other product file that starts a process names
 * it. Nothing outside `src/paradev/` imports from it except `src/main.ts` (and, for the host
 * readings, the pass, the CLI and install); tests may, for `fake-superset`.
 */
export const findBoundaryViolations = (files: ReadonlyArray<SourceFile>): Array<string> => {
  const violations: Array<string> = [];
  for (const file of files) {
    if (file.path.startsWith(PARADEV) || isTestCode(file.path)) continue;
    if (startsProcesses(file.text) && namesSuperset(file.text)) {
      violations.push(`${file.path} starts a process and names superset`);
    }
    if (file.path === MAIN) continue;
    for (const specifier of extractImports(file.text)) {
      const target = specifier.startsWith(".") ? resolveRelative(file.path, specifier) : "";
      if (target.startsWith(PARADEV) && !HOST_READINGS.has(target)) {
        violations.push(`${file.path} imports ${specifier} from src/paradev/`);
      }
    }
  }
  return violations;
};

const repoRoot = NodePath.resolve(import.meta.dirname, "..");

const listSourceFiles = (dir: string): Array<string> =>
  NodeFS.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules") return [];
    const full = NodePath.join(dir, entry.name);
    if (entry.isDirectory()) return listSourceFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });

describe("paradev boundary", () => {
  it("holds for the real tree", () => {
    const files = listSourceFiles(NodePath.join(repoRoot, "src")).map((full) => ({
      path: NodePath.relative(repoRoot, full).split(NodePath.sep).join("/"),
      text: NodeFS.readFileSync(full, "utf8"),
    }));
    expect(files.some((file) => file.path === "src/paradev/cli.ts")).toBe(true);
    expect(extractImports(files.find((file) => file.path === MAIN)!.text)).toContain(
      "./paradev/cli.ts",
    );
    expect(findBoundaryViolations(files)).toEqual([]);
  });

  it("flags a product file outside src/paradev/ that starts a process and names superset", () => {
    expect(
      findBoundaryViolations([
        {
          path: "src/runner/x.ts",
          text: `runner.run({ command: "/Applications/Superset.app/Contents/Resources/resources/bin/superset", args })`,
        },
        { path: "src/y.ts", text: `import * as CP from "node:child_process";\nCP.spawn("superset", ["status"]);` },
        { path: "src/paradev/cli.ts", text: `runner.run({ command: binary, args }) // superset` },
        { path: "src/gate.ts", text: `runner.run({ command: "git", args })` },
        { path: "src/pass.ts", text: `"run superset auth login"` },
      ]),
    ).toEqual([
      "src/runner/x.ts starts a process and names superset",
      "src/y.ts starts a process and names superset",
    ]);
  });

  it("flags an import from src/paradev/ outside it, except in main.ts and tests", () => {
    expect(
      findBoundaryViolations([
        { path: "src/pass.ts", text: `import { CliError } from "./paradev/cli.ts";` },
        { path: "src/runner/run.ts", text: `import type { X } from "../paradev/state.ts";` },
        { path: "src/main.ts", text: `import { SupersetCli } from "./paradev/cli.ts";` },
        { path: "src/e2e.test.ts", text: `import { fakeSuperset } from "./paradev/fake-superset.ts";` },
        { path: "src/paradev/sessions.ts", text: `import { call } from "./call.ts";` },
        { path: "src/sessions.ts", text: `import * as Effect from "effect/Effect";` },
      ]),
    ).toEqual([
      "src/pass.ts imports ./paradev/cli.ts from src/paradev/",
      "src/runner/run.ts imports ../paradev/state.ts from src/paradev/",
    ]);
  });

  it("extracts static, side-effect and dynamic imports", () => {
    expect(
      extractImports(
        `import a from "./a.ts";\nimport 'b';\nexport * from './c.ts';\nconst d = await import("./d.ts");`,
      ).toSorted(),
    ).toEqual(["./a.ts", "./c.ts", "./d.ts", "b"]);
  });
});
