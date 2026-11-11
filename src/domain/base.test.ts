import { assert, it } from "@effect/vitest";

import { issueBase } from "./base.ts";

it("base is null with no section", () => {
  assert.strictEqual(issueBase(""), null);
  assert.strictEqual(issueBase("## Outcome\nShip it.\n## Depends on\nNone.\n"), null);
});

it("base is null for an empty section or None.", () => {
  assert.strictEqual(issueBase("## Base\n\n## Notes\nfeature/x\n"), null);
  assert.strictEqual(issueBase("## Base\n"), null);
  assert.strictEqual(issueBase("## Base\n\nNone.\n"), null);
  assert.strictEqual(issueBase("## Base\nnone.\n## Notes\n"), null);
  assert.strictEqual(issueBase("## Base\n  NONE.  \n"), null);
});

it("base reads the branch name", () => {
  assert.strictEqual(
    issueBase("## Outcome\nx\n\n## Base\n\nfeature/x\n\n## Notes\ny\n"),
    "feature/x",
  );
  assert.strictEqual(issueBase("## Base\r\n  feature/x  \r\n"), "feature/x");
});

it("base takes the first non-blank line and ignores the prose after it", () => {
  const body = "## Base\n\nfeature/x\nThe group of issues lands here first.\nThen main.\n";
  assert.strictEqual(issueBase(body), "feature/x");
});

it("base as the last heading runs to the end of the body", () => {
  assert.strictEqual(
    issueBase("## Outcome\nx\n## Depends on\nNone.\n## Base\nrelease/2\n"),
    "release/2",
  );
});

it("base treats a # reference inside the section as text, not a heading", () => {
  assert.strictEqual(issueBase("## Base\n#12\n"), "#12");
  assert.strictEqual(issueBase("## Base\n\nfeature/x\n#12 is the parent\n## Notes\n"), "feature/x");
});
