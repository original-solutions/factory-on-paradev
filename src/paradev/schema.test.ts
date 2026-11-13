// @effect-diagnostics nodeBuiltinImport:off - Reads the recorded schema.
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeFS from "node:fs";

import { layer } from "./cli.ts";
import { FIXTURES_DIR, fakeSuperset } from "./fake-superset.ts";
import { check, checkSchema, describeFailure, REQUIRED } from "./schema.ts";

const recorded = (): any =>
  JSON.parse(NodeFS.readFileSync(`${FIXTURES_DIR}/schema.json`, "utf8"));

/** The recorded schema with `edit` applied to the command at `path`, found anywhere in the tree. */
const editing = (path: string, edit: (siblings: Array<any>, at: number) => void): unknown => {
  const schema = recorded();
  const walk = (list: Array<any>): boolean => {
    const at = list.findIndex((command) => command.path.join(" ") === path);
    if (at !== -1) {
      edit(list, at);
      return true;
    }
    return list.some((command) => walk(command.commands ?? []));
  };
  assert.isTrue(walk(schema.commands), `no ${path} in the recorded schema`);
  return schema;
};

it.effect("the recorded 2.0.8 schema passes, read through the CLI", () =>
  Effect.gen(function* () {
    const fake = fakeSuperset([{ argv: ["schema"], fixture: "schema" }]);
    const result = yield* check.pipe(Effect.provide(layer().pipe(Layer.provide(fake.layer))));
    assert.deepStrictEqual(result, { version: "2.0.8", missing: [] });
    assert.isNull(describeFailure(result));
  }),
);

it("a schema without agents explain fails, naming it and the version found", () => {
  const result = checkSchema(editing("agents explain", (list, at) => list.splice(at, 1)));
  assert.deepStrictEqual(result, { version: "2.0.8", missing: ["agents explain"] });
  const text = describeFailure(result)!;
  assert.include(text, "agents explain");
  assert.include(text, "2.0.8");
});

it("a missing option is named with its command", () => {
  const schema = editing("pages publish", (list, at) => {
    list[at].options = list[at].options.filter((option: any) => option.name !== "workspace");
  });
  assert.deepStrictEqual(checkSchema(schema).missing, ["pages publish --workspace"]);
});

it("a missing global --json is named", () => {
  const schema = recorded();
  schema.globalOptions = schema.globalOptions.filter((option: any) => option.name !== "json");
  assert.deepStrictEqual(checkSchema(schema).missing, ["--json"]);
});

it("an answer that is not a schema misses everything, at version unknown", () => {
  const result = checkSchema("2.0.9");
  assert.strictEqual(result.version, "unknown");
  assert.strictEqual(result.missing.length, REQUIRED.length);
});

it("the list is the spec's table", () => {
  const listed = REQUIRED.map(
    ({ command, options }) => `${command.join(" ")}: ${options.join(" ")}`,
  );
  assert.deepStrictEqual(listed, [
    "projects list: local",
    "workspaces create: local project name branch base-branch skip-branch-prefix tag",
    "workspaces get: local",
    "workspaces archive: local",
    "agents create: local workspace agent model effort prompt resume-session",
    "agents explain: local workspace terminal",
    "agents read: local workspace terminal",
    "terminals send: local workspace terminal text keys",
    "terminals close: local workspace terminal",
    "terminals create: local workspace command",
    "snapshot: workspace",
    "auth whoami: ",
    "pages publish: page title visibility label no-watch workspace",
    "pages storage: key scope set",
    ": json",
  ]);
});
