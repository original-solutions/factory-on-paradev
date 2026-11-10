// @effect-diagnostics nodeBuiltinImport:off - the test writes a real file and lists its directory.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe } from "vitest";

import { useTempDirs } from "./ledger/testSupport.ts";
import { writeFileAtomically } from "./files.ts";

const tempDir = useTempDirs();

describe("writeFileAtomically", () => {
  it.effect("writes the text, creates the directory and leaves nothing else behind", () =>
    Effect.gen(function* () {
      const dir = NodePath.join(tempDir("files"), "nested");
      const file = NodePath.join(dir, "config.yml");
      yield* writeFileAtomically(file, "a: 1\n");
      yield* writeFileAtomically(file, "b: 2\n");
      assert.strictEqual(NodeFS.readFileSync(file, "utf8"), "b: 2\n");
      assert.deepStrictEqual(NodeFS.readdirSync(dir), ["config.yml"]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
