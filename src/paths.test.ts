import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { afterEach, beforeEach } from "vitest";

import * as Paths from "./paths.ts";

const saved = process.env.FACTORY_RUNNER_HOME;
beforeEach(() => {
  delete process.env.FACTORY_RUNNER_HOME;
});
afterEach(() => {
  if (saved === undefined) delete process.env.FACTORY_RUNNER_HOME;
  else process.env.FACTORY_RUNNER_HOME = saved;
});

const read = Effect.gen(function* () {
  return yield* Paths.FactoryPaths;
}).pipe(Effect.provide(Paths.layer), Effect.provide(NodeServices.layer));

it.effect("keeps the data and the machine config in ~/.config/factory-runner by default", () =>
  Effect.gen(function* () {
    const paths = yield* read;
    const dir = NodePath.join(NodeOS.homedir(), ".config", "factory-runner");
    assert.strictEqual(paths.baseDir, dir);
    assert.strictEqual(paths.factoryDir, dir);
    assert.strictEqual(paths.machineConfigPath, NodePath.join(dir, "config.yml"));
    assert.strictEqual(paths.worktreesDir, NodePath.join(NodeOS.homedir(), ".paradev", "worktrees"));
    assert.strictEqual(paths.claudeProjectsDir, NodePath.join(NodeOS.homedir(), ".claude", "projects"));
  }),
);

it.effect("uses FACTORY_RUNNER_HOME as the data dir when it is set", () =>
  Effect.gen(function* () {
    process.env.FACTORY_RUNNER_HOME = "/srv/runner";
    const paths = yield* read;
    assert.strictEqual(paths.baseDir, "/srv/runner");
    assert.strictEqual(paths.factoryDir, "/srv/runner");
    assert.strictEqual(paths.machineConfigPath, "/srv/runner/config.yml");
  }),
);
