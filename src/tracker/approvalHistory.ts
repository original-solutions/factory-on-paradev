import * as Schema from "effect/Schema";

import type { Approval, Refusal, TextCheck } from "../domain/approval.ts";

/**
 * The pure half of the approval rule: the shape of GitHub's answer about an issue's label
 * events and edit history, and the judgement over it. It makes no `gh` call.
 */

const OptionalText = Schema.optional(Schema.NullOr(Schema.String));

/** How many label events and body edits the approval query asks for. A history this long may be cut off. */
export const HISTORY_PAGE = 100;

/** GitHub's uniform UTC form, so ordering the text orders the times. */
export const isUtcSecond = (text: string): boolean =>
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(text);

/**
 * Who applied the issue's labels, who renamed it and who edited its body. `last: 100` of the
 * timeline items is the newest 100 (GitHub lists them oldest first), and
 * `userContentEdits(first: 100)` is the newest 100 edits (it lists newest first). Titles are
 * not asked for. `__typename` on an actor tells a person from a GitHub App.
 */
export const APPROVAL_QUERY =
  "query($owner: String!, $name: String!, $number: Int!) { " +
  "repository(owner: $owner, name: $name) { issue(number: $number) { " +
  `timelineItems(itemTypes: [LABELED_EVENT, UNLABELED_EVENT, RENAMED_TITLE_EVENT], last: ${HISTORY_PAGE}) { ` +
  "totalCount nodes { " +
  "__typename " +
  "... on LabeledEvent { createdAt actor { __typename login } label { name } } " +
  "... on UnlabeledEvent { createdAt actor { __typename login } label { name } } " +
  "... on RenamedTitleEvent { createdAt actor { __typename login } } } } " +
  "lastEditedAt editor { __typename login } " +
  `userContentEdits(first: ${HISTORY_PAGE}) { totalCount nodes { editedAt editor { __typename login } } } } } }`;

/** `typename` is only there when the query asked for it; a rule that wants a person needs a `User`. */
export const Actor = Schema.Struct({
  __typename: OptionalText,
  login: Schema.String,
});
export type Actor = typeof Actor.Type;

const LabelChange = Schema.Struct({
  createdAt: Schema.String,
  actor: Schema.optional(Schema.NullOr(Actor)),
  label: Schema.Struct({ name: Schema.String }),
});

/** One label event or title rename; a node of any other type is an answer this module cannot read. */
export const TimelineNode = Schema.Union([
  Schema.Struct({ __typename: Schema.Literal("LabeledEvent"), ...LabelChange.fields }),
  Schema.Struct({ __typename: Schema.Literal("UnlabeledEvent"), ...LabelChange.fields }),
  Schema.Struct({
    __typename: Schema.Literal("RenamedTitleEvent"),
    createdAt: Schema.String,
    actor: Schema.optional(Schema.NullOr(Actor)),
  }),
]);
export type TimelineNode = typeof TimelineNode.Type;

export const ApprovalAnswer = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.Struct({
      issue: Schema.Struct({
        timelineItems: Schema.Struct({
          totalCount: Schema.Number,
          nodes: Schema.Array(TimelineNode),
        }),
        lastEditedAt: OptionalText,
        editor: Schema.optional(Schema.NullOr(Actor)),
        userContentEdits: Schema.Struct({
          totalCount: Schema.Number,
          nodes: Schema.Array(
            Schema.Struct({
              editedAt: Schema.String,
              editor: Schema.optional(Schema.NullOr(Actor)),
            }),
          ),
        }),
      }),
    }),
  }),
});
export type ApprovalIssue = (typeof ApprovalAnswer.Type)["data"]["repository"]["issue"];

const asciiLower = (text: string): string => text.replace(/[A-Z]/g, (char) => char.toLowerCase());

/**
 * Whether the account's login is an instructor's, in any case. A deleted account (none) never is.
 * For text that only needs to be an instructor's, such as a comment's; the approval asks for
 * {@link isHumanInstructor}.
 */
export const isInstructor = (
  actor: { readonly login: string } | null | undefined,
  instructors: ReadonlyArray<string>,
): boolean =>
  actor !== null &&
  actor !== undefined &&
  instructors.some((name) => asciiLower(name) === asciiLower(actor.login));

/**
 * An instructor who is a person: GitHub says the actor is a `User`. A GitHub App's GraphQL login
 * can lack the `[bot]` suffix, so a login that matches an instructor is not enough.
 */
export const isHumanInstructor = (
  actor: Actor | null | undefined,
  instructors: ReadonlyArray<string>,
): boolean => actor?.__typename === "User" && isInstructor(actor, instructors);

/** Whether a page may leave out older entries: it is full, or GitHub counts more than it holds. */
const isCutOff = (page: { readonly totalCount: number; readonly nodes: ReadonlyArray<unknown> }) =>
  page.nodes.length >= HISTORY_PAGE || page.totalCount > page.nodes.length;

/** Whether the timeline page shows every event at or after `since`: not cut off, or its oldest is before `since`. */
export const timelineReaches = (issue: ApprovalIssue, since: string): boolean => {
  const { nodes } = issue.timelineItems;
  return !isCutOff(issue.timelineItems) || (nodes[0] !== undefined && nodes[0].createdAt < since);
};

/** Whether the newest history entry is the last edit, by the last editor. */
const newestIsLastEdit = (issue: ApprovalIssue): boolean => {
  if (issue.lastEditedAt === null || issue.lastEditedAt === undefined) return true;
  const newest = issue.userContentEdits.nodes[0];
  return (
    newest !== undefined &&
    newest.editedAt === issue.lastEditedAt &&
    (newest.editor?.login ?? null) === (issue.editor?.login ?? null)
  );
};

/**
 * Whether the body's edit history can be trusted for every edit at or after `since`: the entries
 * come newest first, so when it is cut off the oldest one shown must be before `since`.
 */
const editsWholeSince = (issue: ApprovalIssue, since: string): boolean => {
  const { nodes } = issue.userContentEdits;
  const reachesBack =
    !isCutOff(issue.userContentEdits) ||
    (nodes.length > 0 && nodes[nodes.length - 1]!.editedAt < since);
  return reachesBack && newestIsLastEdit(issue);
};

/**
 * Judges every body edit and title rename with time at or after `since`. A moment in the same
 * second counts as after, because timestamps have no finer order. `reaches` says the renames on
 * the timeline page cover everything at or after `since`.
 */
export const textChangesSince = (
  issue: ApprovalIssue,
  since: string,
  instructors: ReadonlyArray<string>,
  reaches: boolean,
): TextCheck => {
  const editByStranger = issue.userContentEdits.nodes.some(
    (edit) => edit.editedAt >= since && !isHumanInstructor(edit.editor, instructors),
  );
  const renameByStranger = issue.timelineItems.nodes.some(
    (event) =>
      event.__typename === "RenamedTitleEvent" &&
      event.createdAt >= since &&
      !isHumanInstructor(event.actor, instructors),
  );
  if (editByStranger || renameByStranger) return "changed";
  return editsWholeSince(issue, since) && reaches ? "unchanged" : "unjudged";
};

/**
 * Whether the factory may build the issue: an instructor (only ever a `User`) applied the `ready`
 * label in force now, and every body edit and title rename from that second on was an instructor's.
 * Only the newest timeline page is read: it holds the label in force and all after it, and a full
 * page without it is `label-history-incomplete`. Label names match exactly; times compare as text.
 */
export const judgeApproval = (
  issue: ApprovalIssue,
  ready: string,
  instructors: ReadonlyArray<string>,
): Approval => {
  let inForce: Extract<TimelineNode, { __typename: "LabeledEvent" }> | null = null;
  for (const event of issue.timelineItems.nodes) {
    if (event.__typename === "LabeledEvent" && event.label.name === ready) inForce = event;
    else if (event.__typename === "UnlabeledEvent" && event.label.name === ready) inForce = null;
  }
  if (inForce === null) {
    const { totalCount, nodes } = issue.timelineItems;
    const cutOff = nodes.length >= HISTORY_PAGE && totalCount > HISTORY_PAGE;
    const refusal: Refusal = { kind: cutOff ? "label-history-incomplete" : "label-not-found" };
    return { kind: "refused", refusal };
  }
  const labeledAt = inForce.createdAt;
  const actor = inForce.actor;
  if (actor === null || actor === undefined || !isHumanInstructor(actor, instructors)) {
    return {
      kind: "refused",
      refusal: { kind: "labeled-by-non-instructor", by: actor?.login ?? null, labeledAt },
    };
  }
  // The label is on the page, so the renames at or after it are too.
  switch (textChangesSince(issue, labeledAt, instructors, true)) {
    case "changed":
      return { kind: "refused", refusal: { kind: "edited-after-label", labeledAt } };
    case "unjudged":
      return { kind: "refused", refusal: { kind: "edit-history-incomplete", labeledAt } };
    case "unchanged":
      return { kind: "approved", labeledAt, labeledBy: actor.login };
  }
};

/**
 * Whether anyone, an instructor included, edited the body or renamed the title at or after
 * `since`. A timeline page that may hide a rename at or after the moment counts as a change.
 */
export const editedSince = (issue: ApprovalIssue, since: string): boolean => {
  const edited =
    issue.lastEditedAt !== null && issue.lastEditedAt !== undefined
      ? issue.lastEditedAt >= since
      : false;
  const renamed = issue.timelineItems.nodes.some(
    (event) => event.__typename === "RenamedTitleEvent" && event.createdAt >= since,
  );
  return edited || renamed || !timelineReaches(issue, since);
};
