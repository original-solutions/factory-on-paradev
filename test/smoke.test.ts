import { expect, test } from "vitest";
import { version } from "../src/main.ts";

test("exports the package version", () => {
  expect(version).toBe("0.0.0");
});
