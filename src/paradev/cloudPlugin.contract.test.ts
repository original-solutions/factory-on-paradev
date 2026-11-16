import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { cloudPluginReason, readCloudPlugin, type Read } from "../plugin.ts";
import { layer, SupersetCli } from "./cli.ts";
import { fakeSuperset, readFixture, type Step } from "./fake-superset.ts";

const RUNNER = "0.3.5";
const ORG = ["plugins", "organization", "list"];
const ACCOUNT = ["plugins", "list"];
const RELEASE = `in a checkout of original-solutions/factory-on-paradev run make release-finish VERSION=${RUNNER}`;
const INSTALL = "superset plugins install factory@organization";
/** What the release's step does once `main` has moved past the runner's tag (docs/specs/P3-plugin.md, "The check, per target"). */
const MOVED_ON = `when main has moved past v${RUNNER} it stops before the sync, and the fix is the next release`;

const org = (fixture: string): Step => ({ argv: ORG, fixture });
const account = (fixture: string): Step => ({ argv: ACCOUNT, fixture });

/** Runs the cloud check against the recorded answers, through the CLI layer as the runner builds its call. */
const run = (script: ReadonlyArray<Step>, minimum: Read<string | null>) => {
  const fake = fakeSuperset(script);
  return Effect.gen(function* () {
    const cli = yield* SupersetCli;
    const call = (argv: ReadonlyArray<string>) =>
      cli.run(argv).pipe(Effect.mapError((error) => error.text.split("\n")[0] ?? error.text));
    const reason = yield* readCloudPlugin(call, minimum, RUNNER);
    return { reason, fake };
  }).pipe(Effect.provide(layer().pipe(Layer.provide(fake.layer))));
};

describe("the cloud plugin check, replayed", () => {
  it("the fixtures are the argv the check asks", () => {
    for (const name of ["plugins-org-list-after", "plugins-org-list-after-bump", "plugins-org-list"]) {
      assert.deepStrictEqual(readFixture(name).argv, ORG);
    }
    assert.deepStrictEqual(readFixture("plugins-list-update-available").argv, ACCOUNT);
  });

  it.effect("the organization at the minimum and the plugin installed on the account passes", () =>
    Effect.gen(function* () {
      const { reason, fake } = yield* run(
        [org("plugins-org-list-after"), account("plugins-list-update-available")],
        { ok: "0.1.0" },
      );
      assert.isNull(reason);
      assert.deepStrictEqual(fake.unused(), []);
    }),
  );

  it.effect("the organization at 0.1.1 with a minimum of 0.1.1 passes", () =>
    Effect.gen(function* () {
      const { reason } = yield* run(
        [org("plugins-org-list-after-bump"), account("plugins-list-update-available")],
        { ok: "0.1.1" },
      );
      assert.isNull(reason);
    }),
  );

  it.effect("the organization at 0.1.0 with a minimum of 0.1.1 is old, and the fix is the release's own step", () =>
    Effect.gen(function* () {
      const { reason } = yield* run(
        [org("plugins-org-list-after"), account("plugins-list-update-available")],
        { ok: "0.1.1" },
      );
      assert.include(reason!, "0.1.0");
      assert.include(reason!, "older than the 0.1.1");
      assert.include(reason!, RELEASE);
      assert.include(reason!, MOVED_ON);
      assert.notInclude(reason!, "sources sync");
    }),
  );

  it.effect("an empty organization list is a missing plugin, with the same fix", () =>
    Effect.gen(function* () {
      const { reason, fake } = yield* run([org("plugins-org-list"), account("plugins-list-update-available")], {
        ok: "0.1.0",
      });
      assert.include(reason!, "no factory plugin");
      assert.include(reason!, RELEASE);
      assert.include(reason!, MOVED_ON);
      assert.notInclude(reason!, "sources sync");
      assert.deepStrictEqual(fake.calls, [ORG, ACCOUNT]);
      assert.deepStrictEqual(fake.unused(), []);
    }),
  );

  it.effect("an account list with no factory row is not installed", () =>
    Effect.gen(function* () {
      const { reason } = yield* run([org("plugins-org-list-after"), account("plugins-list-installed")], {
        ok: "0.1.0",
      });
      assert.include(reason!, "not installed");
      assert.include(reason!, INSTALL);
    }),
  );

  it.effect("a failed organization read names its command", () =>
    Effect.gen(function* () {
      const { reason } = yield* run([{ argv: ORG, fail: "Not logged in" }, account("plugins-list-update-available")], {
        ok: "0.1.0",
      });
      assert.strictEqual(reason, "superset plugins organization list failed: Not logged in");
    }),
  );

  it.effect("a failed account read names its command", () =>
    Effect.gen(function* () {
      const { reason } = yield* run([org("plugins-org-list-after"), { argv: ACCOUNT, fail: "Not logged in" }], {
        ok: "0.1.0",
      });
      assert.strictEqual(reason, "superset plugins list failed: Not logged in");
    }),
  );

  it.effect("a minimum that did not read is the reason, and nothing is asked", () =>
    Effect.gen(function* () {
      const { reason, fake } = yield* run([], { failed: "package.json could not be read: ENOENT" });
      assert.strictEqual(reason, "package.json could not be read: ENOENT");
      assert.deepStrictEqual(fake.calls, []);
    }),
  );
});

const row = (over: Record<string, unknown> = {}) => ({ name: "factory", version: "0.1.0", ...over });
const mine = (over: Record<string, unknown> = {}) => ({
  name: "factory",
  marketplace: "organization-abc",
  status: "installed",
  ...over,
});

describe("cloudPluginReason", () => {
  const judge = (orgList: unknown, accountList: unknown, minimum: Read<string | null> = { ok: "0.1.0" }) =>
    cloudPluginReason({ ok: orgList }, { ok: accountList }, minimum, RUNNER);

  it("passes with a factory row at the minimum and an installed organization row", () => {
    assert.isNull(judge([row()], [mine()]));
  });

  it("two factory rows in the organization pass when one is at the minimum", () => {
    assert.isNull(judge([row({ version: "0.1.0" }), row({ version: "0.1.1" })], [mine()], { ok: "0.1.1" }));
  });

  it("a null minimum needs only the organization's row, whatever its version", () => {
    assert.isNull(judge([row({ version: "not a version" })], [mine()], { ok: null }));
  });

  it("an account row older than the minimum passes: a sandbox gets the organization's synced version, not the account row's", () => {
    // docs/specs/P3-plugin.md, finding 3 and V7: the account needs the plugin installed; the version is the organization's.
    assert.isNull(judge([row({ version: "0.1.1" })], [mine({ version: "0.1.0" })], { ok: "0.1.1" }));
    assert.isNull(judge([row({ version: "0.1.1" })], [mine({ version: "not a version" })], { ok: "0.1.1" }));
  });

  it("a row from a marketplace that does not start organization- is not the organization's install", () => {
    const reason = judge([row()], [mine({ marketplace: "superset" })]);
    assert.include(reason!, INSTALL);
  });

  it("a row whose status is not installed is not installed", () => {
    assert.include(judge([row()], [mine({ status: "update available" })])!, INSTALL);
    assert.include(judge([row()], [mine({ status: "disabled" })])!, INSTALL);
  });

  it("another plugin's row is not the factory's", () => {
    assert.include(judge([row({ name: "other" })], [mine()])!, RELEASE);
    assert.include(judge([row()], [mine({ name: "other" })])!, INSTALL);
  });

  it("a factory row whose version is no version is not good enough, and says so", () => {
    const reason = judge([row({ version: "latest" })], [mine()])!;
    assert.include(reason, "not a version");
    assert.include(reason, RELEASE);
  });

  it("an answer that is not a list is a reason, not a throw", () => {
    assert.include(judge({ plugins: [] }, [mine()])!, "not a list");
    assert.include(judge([row()], "nope")!, "not a list");
  });

  it("a failed read is its command's failure, the organization's first", () => {
    assert.strictEqual(
      cloudPluginReason({ failed: "boom" }, { failed: "bang" }, { ok: "0.1.0" }, RUNNER),
      "superset plugins organization list failed: boom",
    );
    assert.strictEqual(
      cloudPluginReason({ ok: [row()] }, { failed: "bang" }, { ok: "0.1.0" }, RUNNER),
      "superset plugins list failed: bang",
    );
  });

  it("a failed minimum comes before any read", () => {
    assert.strictEqual(
      cloudPluginReason({ failed: "boom" }, { failed: "bang" }, { failed: "no minimum" }, RUNNER),
      "no minimum",
    );
  });
});
