import { afterEach, assert, describe, it } from "vitest";

import { runCommand } from "./runCommand.ts";

describe("runCommand", () => {
  const SECRET = "FACTORY_RUNNER_TEST_SECRET";
  afterEach(() => {
    delete process.env[SECRET];
  });

  it("with inheritEnv, the command gets only those names of the environment", () => {
    process.env[SECRET] = "do-not-pass";
    const done = runCommand("/usr/bin/env", [], 10_000, ["HOME", "PATH"]);
    assert.strictEqual(done.status, 0);
    const names = done.stdout.split("\n").filter((line) => line !== "").map((line) => line.split("=")[0]);
    assert.notInclude(names, SECRET);
    assert.include(names, "HOME");
  });

  it("without, it gets the whole environment", () => {
    process.env[SECRET] = "passed";
    const done = runCommand("/usr/bin/env", [], 10_000);
    assert.include(done.stdout, `${SECRET}=passed`);
  });

  it("a command that is not there answers a null status and says why", () => {
    const done = runCommand("/no/such/command", [], 10_000);
    assert.strictEqual(done.status, null);
    assert.include(done.stderr, "ENOENT");
  });
});
