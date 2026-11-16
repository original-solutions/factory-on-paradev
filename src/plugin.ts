// @effect-diagnostics nodeBuiltinImport:off - the check reads one file under HOME and a package.json.
/**
 * The factory plugin on this Mac (`docs/specs/P3-plugin.md`, "The check, per target" and V6).
 * Paradev copies every file of the plugin's skill folder to `~/.agents/skills/factory-build/`, so
 * its `VERSION` file says both that the skill has landed and at which version. A runner needs that
 * version at its `factory.minPluginVersion` or newer. The runner never installs the plugin: a
 * person runs {@link LOCAL_PLUGIN_FIX}, or on a host {@link HOST_PLUGIN_FIX}; `hosts check` reads a
 * host's file over ssh. Cloud reads the organization's plugin list and the account's (V7), and its
 * fixes are {@link cloudOrganizationFix} and {@link CLOUD_ACCOUNT_FIX}.
 */
import * as Effect from "effect/Effect";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { compareVersions, parseVersion } from "./version.ts";

/** A read that answered, or why it did not. */
export type Read<A> = { readonly ok: A } | { readonly failed: string };

/** This Mac's fix for a plugin that is missing or older than a runner needs. */
export const LOCAL_PLUGIN_FIX = "superset plugins install factory@organization, then restart the Paradev app";

/** A host's fix for the same, run on the host: the install, then a restart of its host service, which copies the skill. */
export const HOST_PLUGIN_FIX =
  "superset plugins install factory@organization && launchctl kickstart -k gui/$(id -u)/sh.superset.host";

/** The repo whose checkout holds the release step; `status` shows the fix where no repo is in view. */
const FACTORY_REPO = "original-solutions/factory-on-paradev";

/**
 * Cloud's fix for an organization whose plugin is missing or old, run in a checkout of {@link FACTORY_REPO}:
 * the release's own step, with the runner's `version`. A bare `sources sync` would take `main` as
 * it is, under whatever version `main` carries, so the runner never prints one. The step syncs only
 * while `main` is still at that version's release commit; once `main` has moved on it stops before
 * the sync, and the fix is the next release (`docs/specs/P3-plugin.md`, "The check, per target").
 */
export const cloudOrganizationFix = (version: string): string =>
  `in a checkout of ${FACTORY_REPO} run make release-finish VERSION=${version}; ` +
  `when main has moved past v${version} it stops before the sync, and the fix is the next release`;

/** Cloud's fix for a plugin the organization has but the runner's account has not installed. */
export const CLOUD_ACCOUNT_FIX = "superset plugins install factory@organization";

/** The `VERSION` file of the plugin's skill as it landed under `home`. */
export const landedPluginPath = (home: string): string =>
  NodePath.join(home, ".agents", "skills", "factory-build", "VERSION");

/** What a failed read says: the error's code when it has one, so no folder name gets into the text. */
const whyNot = (error: unknown): string =>
  (error as NodeJS.ErrnoException).code ?? (error instanceof Error ? error.message : String(error));

/** Whether a `landed` plugin version is older than the `minimum` a runner needs; both are read versions. */
export const olderThan = (landed: string, minimum: string): boolean =>
  compareVersions(parseVersion(landed)!, parseVersion(minimum)!) < 0;

/** The version a landed `VERSION` file holds, given its `text` as read from `path`; text that is empty or not a version fails. */
export const landedVersion = (path: string, text: string): Read<string> => {
  const trimmed = text.trim();
  if (trimmed === "") return { failed: `${path} is empty` };
  return parseVersion(trimmed) === null
    ? { failed: `${path} holds ${JSON.stringify(trimmed)}, not a version` }
    : { ok: trimmed };
};

/** The version in this Mac's landed `VERSION` file; a file that is missing, empty or not a version fails. */
export const readLandedPlugin = (home: string): Read<string> => {
  const path = landedPluginPath(home);
  let text: string;
  try {
    text = NodeFS.readFileSync(path, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { failed: `the factory plugin is not on this Mac: ${path} is missing` }
      : { failed: `${path} could not be read: ${whyNot(error)}` };
  }
  return landedVersion(path, text);
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
    return { failed: `package.json could not be read: ${whyNot(error)}` };
  }
  const minimum = json?.factory?.minPluginVersion;
  if (minimum === undefined) return { ok: null };
  return typeof minimum === "string" && parseVersion(minimum) !== null
    ? { ok: minimum }
    : { failed: `package.json has factory.minPluginVersion ${JSON.stringify(minimum)}, not a version` };
};

/**
 * Why the plugin `landed` on a target (`on`: "this Mac", "the host") does not do for a runner whose
 * `factory.minPluginVersion` read as `minimum`; null when it does. A runner with no minimum needs
 * only a landed version.
 */
export const pluginReason = (on: string, landed: Read<string>, minimum: Read<string | null>): string | null => {
  if ("failed" in minimum) return minimum.failed;
  if ("failed" in landed) return landed.failed;
  if (minimum.ok === null) return null;
  return olderThan(landed.ok, minimum.ok)
    ? `the factory plugin on ${on} is ${landed.ok}, older than the ${minimum.ok} this runner needs`
    : null;
};

/** {@link pluginReason} for the plugin landed on this Mac under `home`. */
export const localPluginReason = (home: string, minimum: Read<string | null>): string | null =>
  "failed" in minimum ? minimum.failed : pluginReason("this Mac", readLandedPlugin(home), minimum);

/** The rows of a list the CLI answered with; null when the answer is not a list. */
const rowsOf = (list: unknown): ReadonlyArray<Record<string, unknown>> | null =>
  Array.isArray(list) ? list.filter((row): row is Record<string, unknown> => typeof row === "object" && row !== null) : null;

/**
 * Why the organization and the runner's account do not give cloud sandboxes the factory plugin;
 * null when they do. `orgList` is `plugins organization list`, `accountList` is `plugins list`, and
 * `minimum` is the runner's `factory.minPluginVersion`. The organization needs a `factory` row at
 * the minimum or newer (any row when there is no minimum); the account needs a `factory` row from
 * an `organization-` marketplace whose status is `installed`. The account row's own version is not
 * compared: a sandbox boots with the account's plugins at the version the organization last synced
 * (`docs/specs/P3-plugin.md`, finding 3 and V7), so the organization's row is the version cloud gets.
 */
export const cloudPluginReason = (
  orgList: Read<unknown>,
  accountList: Read<unknown>,
  minimum: Read<string | null>,
  runnerVersion: string,
): string | null => {
  if ("failed" in minimum) return minimum.failed;
  if ("failed" in orgList) return `superset plugins organization list failed: ${orgList.failed}`;
  const fix = cloudOrganizationFix(runnerVersion);
  const inOrganization = rowsOf(orgList.ok);
  if (inOrganization === null) return "superset plugins organization list answered something that is not a list";
  const factory = inOrganization.filter((row) => row["name"] === "factory");
  if (factory.length === 0) return `the organization has no factory plugin; ${fix}`;
  if (minimum.ok !== null) {
    const versions = factory.map((row) => row["version"]);
    const good = versions.some(
      (found) => typeof found === "string" && parseVersion(found) !== null && !olderThan(found, minimum.ok!),
    );
    if (!good) {
      const found = versions.find((value) => typeof value === "string" && parseVersion(value) !== null);
      const what =
        found === undefined
          ? `the organization's factory plugin has a version that is not a version, so not the ${minimum.ok} this runner needs`
          : `the organization's factory plugin is ${found as string}, older than the ${minimum.ok} this runner needs`;
      return `${what}; ${fix}`;
    }
  }
  if ("failed" in accountList) return `superset plugins list failed: ${accountList.failed}`;
  const mine = rowsOf(accountList.ok);
  if (mine === null) return "superset plugins list answered something that is not a list";
  const installed = mine.some(
    (row) =>
      row["name"] === "factory" &&
      typeof row["marketplace"] === "string" &&
      row["marketplace"].startsWith("organization-") &&
      row["status"] === "installed",
  );
  return installed
    ? null
    : `the factory plugin is not installed on this runner's Paradev account; run ${CLOUD_ACCOUNT_FIX}`;
};

/**
 * Reads the organization's plugin list and the account's through `call` (the CLI with `--json`) and
 * judges them with {@link cloudPluginReason}. A runner whose minimum did not read asks nothing.
 * Never fails: a call that fails is a failed read.
 */
export const readCloudPlugin = (
  call: (argv: ReadonlyArray<string>) => Effect.Effect<unknown, string>,
  minimum: Read<string | null>,
  runnerVersion: string,
): Effect.Effect<string | null> =>
  Effect.gen(function* () {
    if ("failed" in minimum) return minimum.failed;
    const read = (argv: ReadonlyArray<string>): Effect.Effect<Read<unknown>> =>
      call(argv).pipe(
        Effect.map((ok): Read<unknown> => ({ ok })),
        Effect.catch((failed) => Effect.succeed<Read<unknown>>({ failed })),
      );
    const orgList = yield* read(["plugins", "organization", "list"]);
    const accountList = yield* read(["plugins", "list"]);
    return cloudPluginReason(orgList, accountList, minimum, runnerVersion);
  });
