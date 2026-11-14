import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { version } from "../src/main.ts";

/** `make release` bumps package.json with `npm version`, so the test reads the version from there. */
const packageVersion = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;

test("exports the package version", () => {
  expect(packageVersion).toMatch(/^\d+\.\d+\.\d+/);
  expect(version).toBe(packageVersion);
});
