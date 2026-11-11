import { describe, expect, it } from "vitest";

import { refusalReason, unapprovedComment, type Refusal } from "./approval.ts";

const AT = "2026-10-04T10:00:00Z";

const NOT_BY_INSTRUCTOR = "factory:ready was not applied by an instructor";
const EDITED_AFTER =
  "the issue text was edited after factory:ready was applied by someone who is not an instructor";
const CANNOT_READ_LABEL = "the factory could not read who applied factory:ready";
const CANNOT_READ_HISTORY = "the factory could not read the full edit history of the issue text";

const OPENING =
  "The factory did not start on this issue and has moved it back to `factory:proposed`.";
const REVIEW_AND_RELABEL =
  "Review the issue text, then apply `factory:ready` again. An instructor must apply the label, and the text must not be edited afterwards by anyone who is not an instructor.";
const FILE_A_NEW_ISSUE =
  "The issue's edit history is too long for the factory to check. File a new issue with the final text and apply `factory:ready` to it.";

const cases: ReadonlyArray<readonly [Refusal, string, string]> = [
  [{ kind: "label-not-found" }, CANNOT_READ_LABEL, REVIEW_AND_RELABEL],
  [{ kind: "label-history-incomplete" }, CANNOT_READ_LABEL, REVIEW_AND_RELABEL],
  [
    { kind: "labeled-by-non-instructor", by: "mallory", labeledAt: AT },
    NOT_BY_INSTRUCTOR,
    REVIEW_AND_RELABEL,
  ],
  [
    { kind: "labeled-by-non-instructor", by: null, labeledAt: AT },
    NOT_BY_INSTRUCTOR,
    REVIEW_AND_RELABEL,
  ],
  [{ kind: "edited-after-label", labeledAt: AT }, EDITED_AFTER, REVIEW_AND_RELABEL],
  [{ kind: "edit-history-incomplete", labeledAt: AT }, CANNOT_READ_HISTORY, FILE_A_NEW_ISSUE],
];

describe("refusalReason", () => {
  it.each(cases)("%j has softfac's fixed reason", (refusal, reason) => {
    expect(refusalReason(refusal)).toBe(reason);
  });

  it("gives the unreadable label history and the missing label one reason", () => {
    expect(refusalReason({ kind: "label-not-found" })).toBe(
      refusalReason({ kind: "label-history-incomplete" }),
    );
  });
});

describe("unapprovedComment", () => {
  it.each(cases)("%j is the factory's fixed text", (refusal, reason, whatToDo) => {
    expect(unapprovedComment(refusal)).toBe(`${OPENING}\n\nReason: ${reason}\n\n${whatToDo}`);
  });

  it("is softfac's literal comment for an edit after the label", () => {
    expect(unapprovedComment({ kind: "edited-after-label", labeledAt: AT })).toBe(
      "The factory did not start on this issue and has moved it back to `factory:proposed`.\n\nReason: the issue text was edited after factory:ready was applied by someone who is not an instructor\n\nReview the issue text, then apply `factory:ready` again. An instructor must apply the label, and the text must not be edited afterwards by anyone who is not an instructor.",
    );
  });

  it("is softfac's literal comment for a history that is too long", () => {
    expect(unapprovedComment({ kind: "edit-history-incomplete", labeledAt: AT })).toBe(
      "The factory did not start on this issue and has moved it back to `factory:proposed`.\n\nReason: the factory could not read the full edit history of the issue text\n\nThe issue's edit history is too long for the factory to check. File a new issue with the final text and apply `factory:ready` to it.",
    );
  });

  it("quotes nothing from the issue or the login", () => {
    const text = unapprovedComment({
      kind: "labeled-by-non-instructor",
      by: "mallory",
      labeledAt: AT,
    });
    expect(text).not.toContain("mallory");
    expect(text).not.toContain(AT);
  });
});
