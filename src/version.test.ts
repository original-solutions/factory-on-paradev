import { assert, describe, it } from "@effect/vitest";

import { compareVersions, parseVersion } from "./version.ts";

describe("parseVersion", () => {
  it("reads X.Y.Z as three numbers", () => {
    assert.deepStrictEqual(parseVersion("0.3.10"), [0, 3, 10]);
  });

  it("is null for anything that is not exactly X.Y.Z", () => {
    for (const text of ["", "0.3", "0.3.4.1", "v0.3.4", "0.3.4-rc.1", " 0.3.4", "0.3.x"]) {
      assert.isNull(parseVersion(text), text);
    }
  });
});

describe("compareVersions", () => {
  it("compares as three numbers, so 0.3.10 is newer than 0.3.9", () => {
    assert.isAbove(compareVersions([0, 3, 10], [0, 3, 9]), 0);
    assert.isBelow(compareVersions([0, 3, 9], [0, 3, 10]), 0);
  });

  it("orders by major, then minor, then patch, and is 0 for the same version", () => {
    assert.isAbove(compareVersions([1, 0, 0], [0, 99, 99]), 0);
    assert.isAbove(compareVersions([0, 4, 0], [0, 3, 99]), 0);
    assert.strictEqual(compareVersions([0, 3, 4], [0, 3, 4]), 0);
  });
});
