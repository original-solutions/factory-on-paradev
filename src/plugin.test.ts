// @effect-diagnostics nodeBuiltinImport:off - the tests lay out a fake HOME and a package root.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { afterAll, beforeAll } from "vitest";

import { landedPluginPath, localPluginReason, readLandedPlugin, readMinPluginVersion } from "./plugin.ts";

let tmp: string;

beforeAll(() => {
  tmp = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "factory-plugin-")));
});

afterAll(() => {
  NodeFS.rmSync(tmp, { recursive: true, force: true });
});

/** A fresh HOME; with `version` set, its plugin landed with that text in its VERSION file. */
const homeWith = (version?: string): string => {
  const home = NodeFS.mkdtempSync(NodePath.join(tmp, "home-"));
  if (version !== undefined) {
    NodeFS.mkdirSync(NodePath.dirname(landedPluginPath(home)), { recursive: true });
    NodeFS.writeFileSync(landedPluginPath(home), version);
  }
  return home;
};

/** A package root whose package.json is `json`. */
const packageWith = (json: string): string => {
  const root = NodeFS.mkdtempSync(NodePath.join(tmp, "pkg-"));
  NodeFS.writeFileSync(NodePath.join(root, "package.json"), json);
  return root;
};

describe("readLandedPlugin", () => {
  it("reads ~/.agents/skills/factory-build/VERSION", () => {
    const home = homeWith("0.3.4\n");
    assert.strictEqual(landedPluginPath(home), NodePath.join(home, ".agents", "skills", "factory-build", "VERSION"));
    assert.deepStrictEqual(readLandedPlugin(home), { ok: "0.3.4" });
  });

  it("fails on a file that is missing, empty or not a version", () => {
    const missing = homeWith();
    assert.deepStrictEqual(readLandedPlugin(missing), {
      failed: `the factory plugin is not on this Mac: ${landedPluginPath(missing)} is missing`,
    });
    const empty = homeWith("\n");
    assert.deepStrictEqual(readLandedPlugin(empty), { failed: `${landedPluginPath(empty)} is empty` });
    const garbage = homeWith("latest\n");
    assert.deepStrictEqual(readLandedPlugin(garbage), {
      failed: `${landedPluginPath(garbage)} holds "latest", not a version`,
    });
  });
});

describe("readMinPluginVersion", () => {
  it("reads factory.minPluginVersion, and null when package.json has none", () => {
    assert.deepStrictEqual(readMinPluginVersion(packageWith('{"factory":{"minPluginVersion":"0.3.10"}}')), { ok: "0.3.10" });
    assert.deepStrictEqual(readMinPluginVersion(packageWith('{"version":"0.3.4"}')), { ok: null });
    assert.deepStrictEqual(readMinPluginVersion(packageWith('{"factory":{}}')), { ok: null });
  });

  it("fails on a package.json that cannot be read, or a minimum that is not a version", () => {
    const unread = readMinPluginVersion(NodePath.join(tmp, "no-such-package"));
    assert.isTrue("failed" in unread && unread.failed.startsWith("package.json could not be read: "));
    assert.deepStrictEqual(readMinPluginVersion(packageWith('{"factory":{"minPluginVersion":"0.3"}}')), {
      failed: 'package.json has factory.minPluginVersion "0.3", not a version',
    });
    assert.deepStrictEqual(readMinPluginVersion(packageWith('{"factory":{"minPluginVersion":3}}')), {
      failed: "package.json has factory.minPluginVersion 3, not a version",
    });
    const broken = readMinPluginVersion(packageWith("{"));
    assert.isTrue("failed" in broken && broken.failed.startsWith("package.json could not be read: "));
  });
});

describe("localPluginReason", () => {
  it("passes a landed plugin at the minimum or newer, compared as three numbers", () => {
    assert.isNull(localPluginReason(homeWith("0.3.4\n"), { ok: "0.3.4" }));
    assert.isNull(localPluginReason(homeWith("0.3.10\n"), { ok: "0.3.9" }));
  });

  it("fails a landed plugin older than the minimum", () => {
    assert.strictEqual(
      localPluginReason(homeWith("0.3.9\n"), { ok: "0.3.10" }),
      "the factory plugin on this Mac is 0.3.9, older than the 0.3.10 this runner needs",
    );
  });

  it("fails a missing, empty or garbled file, whatever the minimum", () => {
    const missing = homeWith();
    assert.strictEqual(
      localPluginReason(missing, { ok: null }),
      `the factory plugin is not on this Mac: ${landedPluginPath(missing)} is missing`,
    );
    const empty = homeWith("");
    assert.strictEqual(localPluginReason(empty, { ok: "0.3.4" }), `${landedPluginPath(empty)} is empty`);
  });

  it("with no minimum, needs only a landed version", () => {
    assert.isNull(localPluginReason(homeWith("0.0.1\n"), { ok: null }));
  });

  it("fails when the runner's own minimum could not be read", () => {
    assert.strictEqual(localPluginReason(homeWith("0.3.4\n"), { failed: "package.json is broken" }), "package.json is broken");
  });
});
