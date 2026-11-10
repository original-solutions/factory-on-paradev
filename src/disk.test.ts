// @effect-diagnostics nodeBuiltinImport:off - the tests read the free space of real directories.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vitest";

import { readFreeSpace, readLowestFreeSpace } from "./disk.ts";
import { useTempDirs } from "./ledger/testSupport.ts";

const tempDir = useTempDirs();

describe("readFreeSpace", () => {
  it("reads the free bytes an unprivileged writer has on the directory's volume", () => {
    const dir = tempDir();
    const space = readFreeSpace(dir);
    const stat = NodeFS.statfsSync(dir);
    expect(space.path).toBe(dir);
    expect(space.freeBytes).toBeGreaterThan(0);
    // Other writers on the machine move it a little between the two reads.
    expect(Math.abs(space.freeBytes - stat.bavail * stat.bsize)).toBeLessThan(1024 ** 3);
  });

  it("reads the nearest directory that exists for one that is not made yet", () => {
    const dir = tempDir();
    expect(readFreeSpace(NodePath.join(dir, "worktrees", "repo")).path).toBe(dir);
  });
});

describe("readLowestFreeSpace", () => {
  it("answers the directory with the least free space", () => {
    const space = (path: string, freeBytes: number) => ({ path, freeBytes, totalBytes: 20 });
    const read = (path: string) => space(path, path === "/b" ? 5 : 9);
    expect(readLowestFreeSpace(["/a", "/b", "/c"], read)).toEqual(space("/b", 5));
    expect(readLowestFreeSpace(["/a"], read)).toEqual(space("/a", 9));
  });
});
