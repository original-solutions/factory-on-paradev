/**
 * The CLI check at start: `superset schema` must list every command and option the runner uses.
 * No exact version is pinned, so any release that keeps them passes.
 */
import * as Effect from "effect/Effect";

import { type CliError, SupersetCli } from "./cli.ts";

/** Each command the runner runs, and the options it passes to it. `[]` is the global options. */
export const REQUIRED: ReadonlyArray<{
  readonly command: ReadonlyArray<string>;
  readonly options: ReadonlyArray<string>;
}> = [
  { command: ["projects", "list"], options: ["local"] },
  {
    command: ["workspaces", "create"],
    options: ["local", "project", "name", "branch", "base-branch", "skip-branch-prefix", "tag"],
  },
  { command: ["workspaces", "get"], options: ["local"] },
  { command: ["workspaces", "archive"], options: ["local"] },
  {
    command: ["agents", "create"],
    options: ["local", "workspace", "agent", "model", "effort", "prompt", "resume-session"],
  },
  { command: ["agents", "explain"], options: ["local", "workspace", "terminal"] },
  { command: ["agents", "read"], options: ["local", "workspace", "terminal"] },
  {
    command: ["terminals", "send"],
    options: ["local", "workspace", "terminal", "text", "keys"],
  },
  { command: ["terminals", "close"], options: ["local", "workspace", "terminal"] },
  { command: ["snapshot"], options: ["workspace"] },
  { command: ["auth", "whoami"], options: [] },
  {
    command: ["pages", "publish"],
    options: ["page", "title", "visibility", "label", "no-watch", "workspace"],
  },
  { command: ["pages", "storage"], options: ["key", "scope", "set"] },
  { command: [], options: ["json"] },
];

export interface SchemaCheck {
  /** The CLI's version as `schema` reports it; `unknown` when it does not. */
  readonly version: string;
  /** What is missing, e.g. `agents explain` or `terminals send --keys`; empty when it passes. */
  readonly missing: ReadonlyArray<string>;
}

interface Node {
  readonly path: ReadonlyArray<string>;
  readonly options: ReadonlyArray<string>;
}

const optionNames = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value)
    ? value.flatMap((option) =>
        typeof option === "object" && option !== null && typeof option.name === "string"
          ? [option.name as string]
          : [],
      )
    : [];

/** Every command in the tree, keyed by its path joined with spaces; the root is "". */
const commandsOf = (schema: Record<string, unknown>): Map<string, Node> => {
  const found = new Map<string, Node>([
    ["", { path: [], options: optionNames(schema.globalOptions) }],
  ]);
  const walk = (list: unknown): void => {
    if (!Array.isArray(list)) return;
    for (const command of list) {
      if (typeof command !== "object" || command === null) continue;
      const path = command.path;
      if (Array.isArray(path) && path.every((part) => typeof part === "string")) {
        found.set(path.join(" "), { path, options: optionNames(command.options) });
      }
      walk(command.commands);
    }
  };
  walk(schema.commands);
  return found;
};

/** Checks a parsed `superset schema --json` answer against {@link REQUIRED}. */
export const checkSchema = (schema: unknown): SchemaCheck => {
  const root =
    typeof schema === "object" && schema !== null ? (schema as Record<string, unknown>) : {};
  const version = typeof root.version === "string" ? root.version : "unknown";
  const commands = commandsOf(root);
  const missing: Array<string> = [];
  for (const { command, options } of REQUIRED) {
    const name = command.join(" ");
    const node = commands.get(name);
    if (node === undefined) {
      missing.push(name);
      continue;
    }
    for (const option of options) {
      if (!node.options.includes(option)) {
        missing.push(name === "" ? `--${option}` : `${name} --${option}`);
      }
    }
  }
  return { version, missing };
};

/** What the attention item says when the check fails; null when it passes. */
export const describeFailure = (check: SchemaCheck): string | null =>
  check.missing.length === 0
    ? null
    : `superset ${check.version} lacks what the runner uses: ${check.missing.join(", ")}`;

/** Runs `superset schema --json` and checks it. */
export const check: Effect.Effect<SchemaCheck, CliError, SupersetCli> = Effect.gen(function* () {
  const cli = yield* SupersetCli;
  return checkSchema(yield* cli.run(["schema"]));
});
