/**
 * The approval rule's verdicts and the words the factory says when it refuses. The rule itself
 * reads GitHub's history and lives with the tracker; this file holds what it concludes and
 * what is then written on the issue. Pure: no I/O.
 */

/**
 * Why an issue is not approved. A fixed set, so nothing from the issue can reach a comment.
 * Times are GitHub's `YYYY-MM-DDTHH:MM:SSZ`.
 */
export type Refusal =
  /** No `factory:ready` event in force among the label events read. It has no label time. */
  | { readonly kind: "label-not-found" }
  /** A full page of a longer label history without the event in force. It has no label time. */
  | { readonly kind: "label-history-incomplete" }
  /** The label in force was applied by someone who is not an instructor (`by` null: a deleted account). */
  | {
      readonly kind: "labeled-by-non-instructor";
      readonly by: string | null;
      readonly labeledAt: string;
    }
  /** Someone who is not an instructor edited the body or renamed the title after the label. */
  | { readonly kind: "edited-after-label"; readonly labeledAt: string }
  /** The body's edit history is cut off, so it cannot show every edit. */
  | { readonly kind: "edit-history-incomplete"; readonly labeledAt: string };

/**
 * Whether the factory may build the issue: an instructor applied the label in force, and
 * every edit and rename since was an instructor's.
 */
export type Approval =
  | { readonly kind: "approved"; readonly labeledAt: string; readonly labeledBy: string }
  | { readonly kind: "refused"; readonly refusal: Refusal };

/**
 * Whether the issue text is as an instructor left it: `unchanged`, `changed` by someone who is
 * not an instructor, or `unjudged` when the histories do not reach back far enough to tell.
 */
export type TextCheck = "unchanged" | "changed" | "unjudged";

/** The fixed reason for a refusal. Nothing from the issue, not even a login, is in it. */
export const refusalReason = (refusal: Refusal): string => {
  switch (refusal.kind) {
    case "labeled-by-non-instructor":
      return "factory:ready was not applied by an instructor";
    case "edited-after-label":
      return "the issue text was edited after factory:ready was applied by someone who is not an instructor";
    case "label-not-found":
    case "label-history-incomplete":
      return "the factory could not read who applied factory:ready";
    case "edit-history-incomplete":
      return "the factory could not read the full edit history of the issue text";
  }
};

/**
 * The comment on an issue the factory refused to build: its own fixed text, quoting nothing
 * from the issue.
 */
export const unapprovedComment = (refusal: Refusal): string => {
  const whatToDo =
    refusal.kind === "edit-history-incomplete"
      ? // Applying the label again cannot help: the history only grows.
        "The issue's edit history is too long for the factory to check. File a new issue with the final text and apply `factory:ready` to it."
      : "Review the issue text, then apply `factory:ready` again. An instructor must apply the label, and the text must not be edited afterwards by anyone who is not an instructor.";
  return `The factory did not start on this issue and has moved it back to \`factory:proposed\`.\n\nReason: ${refusalReason(refusal)}\n\n${whatToDo}`;
};
