// @effect-diagnostics nodeBuiltinImport:off - the check reads one file under HOME and a package.json.
/**
 * The factory plugin on this Mac (`docs/specs/P3-plugin.md`, "The check, per target" and V6).
 * Paradev copies every file of the plugin's skill folder to `~/.agents/skills/factory-build/`, so
 * its `VERSION` file says both that the skill has landed and at which version. A runner needs that
 * version at its `factory.minPluginVersion` or newer. The runner never installs the plugin: a
 * person runs {@link LOCAL_PLUGIN_FIX}.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { compareVersions, parseVersion } from "./version.ts";

/** A read that answered, or why it did not. */
export type Read<A> = { readonly ok: A } | { readonly failed: string };

/** This Mac's fix for a plugin that is missing or older than a runner needs. */
export const LOCAL_PLUGIN_FIX = "superset plugins install factory@organization, then restart the Paradev app";

/** The `VERSION` file of the plugin's skill as it landed under `home`. */
export const landedPluginPath = (home: string): string =>
  NodePath.join(home, ".agents", "skills", "factory-build", "VERSION");

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The version in this Mac's landed `VERSION` file; a file that is missing, empty or not a version fails. */
export const readLandedPlugin = (home: string): Read<string> => {
  const path = landedPluginPath(home);
  let text: string;
  try {
    text = NodeFS.readFileSync(path, "utf8").trim();
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { failed: `the factory plugin is not on this Mac: ${path} is missing` }
      : { failed: `${path} could not be read: ${messageOf(error)}` };
  }
  if (text === "") return { failed: `${path} is empty` };
  return parseVersion(text) === null ? { failed: `${path} holds ${JSON.stringify(text)}, not a version` } : { ok: text };
};

/**
 * `factory.minPluginVersion` of the `package.json` in `packageRoot`: null when it has none. A file
 * that cannot be read, or a minimum that is not a version, fails; the reason names no folder, since
 * a self-update reads it in a clone of its own random name.
 */
export const readMinPluginVersion = (packageRoot: string): Read<string | null> => {
  let json: { factory?: { minPluginVersion?: unknown } };
  try {
    json = JSON.parse(NodeFS.readFileSync(NodePath.join(packageRoot, "package.json"), "utf8")) as typeof json;
  } catch (error) {
    return { failed: `package.json could not be read: ${messageOf(error)}` };
  }
  const minimum = json?.factory?.minPluginVersion;
  if (minimum === undefined) return { ok: null };
  return typeof minimum === "string" && parseVersion(minimum) !== null
    ? { ok: minimum }
    : { failed: `package.json has factory.minPluginVersion ${JSON.stringify(minimum)}, not a version` };
};

/**
 * Why this Mac's landed plugin does not do for a runner whose `factory.minPluginVersion` read as
 * `minimum`; null when it does. A runner with no minimum needs only a landed version.
 */
export const localPluginReason = (home: string, minimum: Read<string | null>): string | null => {
  if ("failed" in minimum) return minimum.failed;
  const landed = readLandedPlugin(home);
  if ("failed" in landed) return landed.failed;
  if (minimum.ok === null) return null;
  return compareVersions(parseVersion(landed.ok)!, parseVersion(minimum.ok)!) < 0
    ? `the factory plugin on this Mac is ${landed.ok}, older than the ${minimum.ok} this runner needs`
    : null;
};
