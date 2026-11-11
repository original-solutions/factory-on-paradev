import { assert, describe, it } from "@effect/vitest";

import { parseSessionResult } from "../domain/resultLine.ts";
import { readFixture } from "./fake-superset.ts";
import { lastAssistantMessage } from "./transcript.ts";

const textOf = (fixture: string): string =>
  (JSON.parse(readFixture(fixture).stdout) as { readonly text: string }).text;

describe("lastAssistantMessage on the spike's transcripts", () => {
  it("agents-read-local: the last reply, several paragraphs, ending in the result line", () => {
    const message = lastAssistantMessage(textOf("agents-read-local"));
    assert.isNotNull(message);
    assert.isTrue(message!.startsWith("I added `multiply(a, b)`"));
    assert.isTrue(message!.includes("\n\n- **Tests:**"));
    assert.isTrue(
      message!.endsWith("FACTORY-DONE: https://github.com/original-solutions/factory-paradev-spike/pull/7"),
    );
  });

  it("agents-read-local-after-gate: the last of the two replies after the pasted gate failure", () => {
    const message = lastAssistantMessage(textOf("agents-read-local-after-gate"));
    assert.isTrue(message!.startsWith("I couldn't reproduce the gate failure"));
    assert.isTrue(message!.endsWith("pull/7"));
  });

  it("agents-read-local-resume: the reply after the restore and the resume prompt", () => {
    const message = lastAssistantMessage(textOf("agents-read-local-resume"));
    assert.isTrue(message!.startsWith("I opened draft PR #10"));
    assert.isTrue(message!.endsWith("pull/10"));
  });

  it("each spike transcript yields the result line the core reads", () => {
    for (const [fixture, pr] of [
      ["agents-read-local", 7],
      ["agents-read-local-after-gate", 7],
      ["agents-read-local-resume", 10],
    ] as const) {
      const message = lastAssistantMessage(textOf(fixture)) ?? undefined;
      const result = parseSessionResult("original-solutions/factory-paradev-spike", message);
      assert.deepInclude(result, { kind: "done", pr }, fixture);
    }
  });
});

describe("lastAssistantMessage rules", () => {
  it("is null when a User chunk follows the last Assistant chunk", () => {
    assert.isNull(lastAssistantMessage("User: go\n\nAssistant: done\n\nUser: again"));
    assert.isNull(lastAssistantMessage(textOf("agents-read-local").concat("\n\nUser: one more thing")));
  });

  it("is null with no Assistant chunk at all", () => {
    assert.isNull(lastAssistantMessage(""));
    assert.isNull(lastAssistantMessage("User: hello"));
  });

  it("reads a first chunk at the very start of the text", () => {
    assert.strictEqual(lastAssistantMessage("Assistant: only me\n"), "only me");
  });

  it("keeps User: mid-line or after a single newline inside the reply", () => {
    const text = "User: go\n\nAssistant: I told the User: no.\nUser: is not a chunk here\n\nFACTORY-DONE: x";
    assert.strictEqual(
      lastAssistantMessage(text),
      "I told the User: no.\nUser: is not a chunk here\n\nFACTORY-DONE: x",
    );
  });

  it("takes the last of several Assistant chunks", () => {
    assert.strictEqual(lastAssistantMessage("User: a\n\nAssistant: one\n\nAssistant: two"), "two");
  });
});
