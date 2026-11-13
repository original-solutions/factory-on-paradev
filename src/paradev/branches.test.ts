// @effect-diagnostics nodeBuiltinImport:off - hashes command ids the way branches.ts does.
import * as NodeCrypto from "node:crypto";

import { assert, describe, it } from "@effect/vitest";

import { isLaunchBranch, launchBranch, launchBranchOf, worktreesRootOf } from "./branches.ts";

const hex = (text: string): string =>
  NodeCrypto.createHash("sha256").update(text).digest("hex");

const ROOT = "/Users/me/.paradev/worktrees/factory-paradev-spike";

describe("launchBranch", () => {
  it("a run's launch id gives fac/<issue>-<attempt>", () => {
    assert.strictEqual(launchBranch("softfac:original-solutions__factory-paradev-spike__1__1:launch"), "fac/1-1");
    assert.strictEqual(launchBranch("softfac:o__r__42__3:launch"), "fac/42-3");
  });

  it("any other id of a run adds the first 8 hex of its sha256", () => {
    const id = "softfac:o__r__42__3:regate:2";
    assert.strictEqual(launchBranch(id), `fac/42-3-${hex(id).slice(0, 8)}`);
    const feedback = "softfac:o__r__42__3:feedback:1";
    assert.strictEqual(launchBranch(feedback), `fac/42-3-${hex(feedback).slice(0, 8)}`);
    assert.notStrictEqual(launchBranch(id), launchBranch(feedback));
  });

  it("an id that does not parse gives fac/x- and the first 12 hex of its sha256", () => {
    for (const id of ["", "launch", "softfac:not-a-run:launch", "softfac:o__r__eng-42__1:launch"]) {
      assert.strictEqual(launchBranch(id), `fac/x-${hex(id).slice(0, 12)}`, id);
    }
  });

  it("the same id always gives the same branch", () => {
    assert.strictEqual(launchBranch("softfac:o__r__7__1:remind:1"), launchBranch("softfac:o__r__7__1:remind:1"));
  });

  it("every branch it makes is a launch branch in its worktree", () => {
    for (const id of ["softfac:o__r__1__1:launch", "softfac:o__r__1__1:regate:1", "nonsense"]) {
      const branch = launchBranch(id);
      assert.isTrue(isLaunchBranch(branch, `${ROOT}/${branch}`), branch);
      assert.strictEqual(launchBranchOf(`${ROOT}/${branch}`), branch);
    }
  });
});

describe("isLaunchBranch", () => {
  it("needs the fac/ shape and a worktree path that ends with the branch", () => {
    assert.isTrue(isLaunchBranch("fac/1-1", `${ROOT}/fac/1-1`));
    assert.isTrue(isLaunchBranch("fac/x-0123456789ab", `${ROOT}/fac/x-0123456789ab`));
    assert.isFalse(isLaunchBranch("fac/1-1", null));
    assert.isFalse(isLaunchBranch("fac/1-1", `${ROOT}/fac/1-2`));
    assert.isFalse(isLaunchBranch("fac/1-1", `${ROOT}/xfac/1-1`));
    assert.isFalse(isLaunchBranch("feat/1-1", `${ROOT}/feat/1-1`));
    assert.isFalse(isLaunchBranch("fac/x8", `${ROOT}/fac/x8`));
    assert.isFalse(isLaunchBranch("fac/1-1z", `${ROOT}/fac/1-1z`));
    assert.isFalse(isLaunchBranch("t3/2e8db933", "/t3/worktrees/softfac/t3-2e8db933"));
  });

  it("accepts the branch Paradev Cloud picks, superset/fac-<issue>-<attempt>-<id8>, with any worktree path", () => {
    for (const branch of ["superset/fac-3-1-a2bc69cb", "superset/fac-x-0123456789ab-a2bc69cb", "superset/fac-42-3-1f2e3d4c-a2bc69cb"]) {
      for (const path of ["/workspace", null, `${ROOT}/fac/1-1`]) {
        assert.isTrue(isLaunchBranch(branch, path), `${branch} ${path}`);
      }
    }
    for (const branch of [
      "superset/fac-3-1",
      "superset/fac-3-1-a2bc69c",
      "superset/fac-3-1-A2BC69CB",
      "superset/fac-3-1-a2bc69cbx",
      "superset/divide-a2bc69cb",
      "superset/fac-3z-1-a2bc69cb",
      "other/fac-3-1-a2bc69cb",
      "xsuperset/fac-3-1-a2bc69cb",
    ]) {
      assert.isFalse(isLaunchBranch(branch, "/workspace"), branch);
    }
  });
});

describe("launchBranchOf", () => {
  it("reads the branch back from a Paradev worktree path, else null", () => {
    assert.strictEqual(launchBranchOf(`${ROOT}/fac/12-3`), "fac/12-3");
    assert.strictEqual(launchBranchOf(`${ROOT}/fac/x8`), null);
    assert.strictEqual(launchBranchOf(`${ROOT}/main`), null);
    assert.strictEqual(launchBranchOf("fac"), null);
    assert.strictEqual(launchBranchOf(null), null);
  });

  it("is null for a path that is not under a local worktree folder, such as a cloud sandbox's", () => {
    assert.strictEqual(launchBranchOf("/workspace"), null);
    assert.strictEqual(launchBranchOf("/fac/1-1"), null);
    assert.strictEqual(launchBranchOf("/project/fac/1-1"), null);
    assert.strictEqual(launchBranchOf("/w/project/fac/1-1"), "fac/1-1");
  });
});

describe("worktreesRootOf", () => {
  it("cuts /<project>/<branch> off a worktree path", () => {
    assert.strictEqual(worktreesRootOf(`${ROOT}/fac/1-1`, "fac/1-1"), "/Users/me/.paradev/worktrees");
    assert.strictEqual(worktreesRootOf("/w/p/main", "main"), "/w");
  });

  it("is null when the path does not end with the branch under a project folder", () => {
    assert.strictEqual(worktreesRootOf(`${ROOT}/fac/1-1`, "fac/1-2"), null);
    assert.strictEqual(worktreesRootOf("/fac/1-1", "fac/1-1"), null);
  });
});
