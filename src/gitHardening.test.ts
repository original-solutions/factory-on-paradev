// @effect-diagnostics nodeBuiltinImport:off - the last case runs real git in a temp repo.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { HARDENED_GIT_ENV, listSessionPins, SESSION_PINS_LISTING, sessionPins } from "./gitHardening.ts";
import { useTempDirs } from "./ledger/testSupport.ts";

const tempDir = useTempDirs();

const listing = (tail: string, over: Partial<Parameters<typeof sessionPins>[0]> = {}) => ({
  exitCode: 0,
  timedOut: false,
  tailTruncated: false,
  tail,
  ...over,
});

describe("sessionPins", () => {
  it("turns nothing off when the repository names no filter or hook (exit 1)", () => {
    assert.deepStrictEqual(sessionPins(listing("", { exitCode: 1 })), { env: { GIT_CONFIG_COUNT: "0" } });
  });

  it("blanks each filter driver once and turns each config hook off", () => {
    const pins = sessionPins(
      listing("filter.lfs.smudge\0filter.lfs.clean\0hook.audit.event\0hook.audit.command\0"),
    );
    assert.deepStrictEqual(pins, {
      env: {
        GIT_CONFIG_KEY_0: "filter.lfs.smudge",
        GIT_CONFIG_VALUE_0: "",
        GIT_CONFIG_KEY_1: "filter.lfs.clean",
        GIT_CONFIG_VALUE_1: "",
        GIT_CONFIG_KEY_2: "filter.lfs.process",
        GIT_CONFIG_VALUE_2: "",
        GIT_CONFIG_KEY_3: "filter.lfs.required",
        GIT_CONFIG_VALUE_3: "false",
        GIT_CONFIG_KEY_4: "hook.audit.enabled",
        GIT_CONFIG_VALUE_4: "false",
        GIT_CONFIG_COUNT: "5",
      },
    });
  });

  it("refuses a listing that is not complete", () => {
    for (const over of [{ tailTruncated: true }, { timedOut: true }, { exitCode: 128 }, { exitCode: null }]) {
      assert.property(sessionPins(listing("filter.x.smudge\0", over)), "refused", JSON.stringify(over));
    }
  });

  it("refuses a name it cannot address, a newline in it included", () => {
    for (const key of ["filter.x=y.smudge", "hook.a b.command", "filter.x\ny.smudge"]) {
      assert.property(sessionPins(listing(`${key}\0`)), "refused", JSON.stringify(key));
    }
  });
});

describe("listSessionPins", () => {
  it.effect("lists the repository's config and its pins keep git from running the filter", () =>
    Effect.gen(function* () {
      const repo = tempDir("repo");
      const marks = tempDir("marks");
      const env = { ...process.env, ...HARDENED_GIT_ENV, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
      const git = (args: ReadonlyArray<string>, extra: Record<string, string> = {}) =>
        NodeChildProcess.spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", env: { ...env, ...extra } });
      git(["init", "-q"]);
      NodeFS.writeFileSync(NodePath.join(repo, "a.txt"), "a");
      git(["add", "a.txt"]);
      git(["commit", "-q", "-m", "a"]);
      git(["config", "filter.evil.smudge", `sh -c 'touch ${marks}/smudge; cat'`]);
      NodeFS.writeFileSync(NodePath.join(repo, ".git", "info", "attributes"), "* filter=evil\n");
      NodeFS.rmSync(NodePath.join(repo, "a.txt"));

      const asked: Array<ReadonlyArray<string>> = [];
      const pinned = yield* listSessionPins((args) => {
        asked.push(args);
        const result = git(args);
        return Effect.succeed({ exitCode: result.status, timedOut: false, tailTruncated: false, tail: result.stdout });
      });
      assert.deepStrictEqual(asked, [SESSION_PINS_LISTING]);
      assert.isTrue("env" in pinned);
      if (!("env" in pinned)) return;
      const checkout = git(["checkout", "--", "a.txt"], pinned.env);
      assert.strictEqual(checkout.status, 0, checkout.stderr);
      assert.strictEqual(NodeFS.readFileSync(NodePath.join(repo, "a.txt"), "utf8"), "a");
      assert.deepStrictEqual(NodeFS.readdirSync(marks), []);
      // Without the pins the same checkout runs the filter.
      NodeFS.rmSync(NodePath.join(repo, "a.txt"));
      git(["checkout", "--", "a.txt"]);
      assert.deepStrictEqual(NodeFS.readdirSync(marks), ["smudge"]);
    }),
  );
});
