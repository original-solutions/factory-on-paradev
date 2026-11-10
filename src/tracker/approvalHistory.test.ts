import { assert, it } from "@effect/vitest";

import type { Approval } from "../domain/approval.ts";

import {
  APPROVAL_QUERY,
  type ApprovalIssue,
  editedSince,
  HISTORY_PAGE,
  isUtcSecond,
  judgeApproval,
  type TimelineNode,
} from "./approvalHistory.ts";

it("the approval query asks for label events and the edit history", () => {
  for (const part of [
    "timelineItems(itemTypes: [LABELED_EVENT, UNLABELED_EVENT, RENAMED_TITLE_EVENT], last: 100)",
    "totalCount",
    "... on LabeledEvent { createdAt actor { __typename login } label { name } }",
    "... on UnlabeledEvent { createdAt actor { __typename login } label { name } }",
    "... on RenamedTitleEvent { createdAt actor { __typename login } }",
    "lastEditedAt",
    "editor { __typename login }",
    "userContentEdits(first: 100) { totalCount nodes { editedAt editor { __typename login } } }",
    "$owner",
    "$name",
    "$number",
  ]) {
    assert.include(APPROVAL_QUERY, part);
  }
  assert.notInclude(APPROVAL_QUERY, "comments");
  // Titles are attacker-influenced text and are never asked for.
  assert.notInclude(APPROVAL_QUERY, "Title {");
  assert.notInclude(APPROVAL_QUERY, "currentTitle");
  assert.notInclude(APPROVAL_QUERY, "previousTitle");
});

it("the approval query is softfac's, byte for byte", () => {
  assert.strictEqual(
    APPROVAL_QUERY,
    "query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { issue(number: $number) { timelineItems(itemTypes: [LABELED_EVENT, UNLABELED_EVENT, RENAMED_TITLE_EVENT], last: 100) { totalCount nodes { __typename ... on LabeledEvent { createdAt actor { __typename login } label { name } } ... on UnlabeledEvent { createdAt actor { __typename login } label { name } } ... on RenamedTitleEvent { createdAt actor { __typename login } } } } lastEditedAt editor { __typename login } userContentEdits(first: 100) { totalCount nodes { editedAt editor { __typename login } } } } } }",
  );
});

it("a UTC second is exactly YYYY-MM-DDTHH:MM:SSZ", () => {
  assert.isTrue(isUtcSecond("2026-10-04T10:00:00Z"));
  for (const text of [
    "",
    "2026-10-04 10:00:00Z",
    "2026-10-04T10:00:00",
    "2026-10-04T10:00:00.5Z",
    "2026-10-04T10:00:00+10:00",
    " 2026-10-04T10:00:00Z",
    "2026-10-04T10:00:00Z\n",
    "2026-1a-04T10:00:00Z",
  ]) {
    assert.isFalse(isUtcSecond(text), JSON.stringify(text));
  }
});

const READY = "factory:ready";
const BEFORE = "2026-10-04T09:00:00Z";
const LABELED = "2026-10-04T10:00:00Z";
const AFTER = "2026-10-04T10:30:00Z";

const user = (login: string) => ({ __typename: "User", login });
const labeled = (at: string, login: string, name = READY): TimelineNode => ({
  __typename: "LabeledEvent",
  createdAt: at,
  actor: user(login),
  label: { name },
});
const unlabeled = (at: string, login: string): TimelineNode => ({
  __typename: "UnlabeledEvent",
  createdAt: at,
  actor: user(login),
  label: { name: READY },
});
const renamed = (at: string, login: string): TimelineNode => ({
  __typename: "RenamedTitleEvent",
  createdAt: at,
  actor: user(login),
});

/** An answer with these events (oldest first) and body edits (newest first), totals as given. */
const issueOf = (
  events: ReadonlyArray<TimelineNode>,
  edits: ReadonlyArray<readonly [at: string, login: string]> = [],
  totals: { readonly events?: number; readonly edits?: number } = {},
): ApprovalIssue => ({
  timelineItems: { totalCount: totals.events ?? events.length, nodes: events },
  lastEditedAt: edits[0]?.[0] ?? null,
  editor: edits[0] === undefined ? null : user(edits[0][1]),
  userContentEdits: {
    totalCount: totals.edits ?? edits.length,
    nodes: edits.map(([editedAt, login]) => ({ editedAt, editor: user(login) })),
  },
});

it("judgeApproval approves the label in force applied by an instructor", () => {
  assert.deepStrictEqual(judgeApproval(issueOf([labeled(LABELED, "Tom")]), READY, ["tom"]), {
    kind: "approved",
    labeledAt: LABELED,
    labeledBy: "Tom",
  });
});

it("judgeApproval finds no label when a later removal cancelled it or the name differs", () => {
  const notFound: Approval = { kind: "refused", refusal: { kind: "label-not-found" } };
  const removed = issueOf([labeled(LABELED, "tom"), unlabeled(AFTER, "tom")]);
  assert.deepStrictEqual(judgeApproval(removed, READY, ["tom"]), notFound);
  const other = issueOf([labeled(LABELED, "tom", "Factory:Ready")]);
  assert.deepStrictEqual(judgeApproval(other, READY, ["tom"]), notFound);
});

it("judgeApproval says a full page of a longer history without the label is incomplete", () => {
  const page = Array.from({ length: HISTORY_PAGE }, () => renamed(BEFORE, "tom"));
  assert.deepStrictEqual(
    judgeApproval(issueOf(page, [], { events: HISTORY_PAGE + 1 }), READY, ["tom"]),
    { kind: "refused", refusal: { kind: "label-history-incomplete" } },
  );
  assert.deepStrictEqual(judgeApproval(issueOf(page), READY, ["tom"]), {
    kind: "refused",
    refusal: { kind: "label-not-found" },
  });
});

it("judgeApproval refuses a label applied by someone who is not an instructor", () => {
  assert.deepStrictEqual(judgeApproval(issueOf([labeled(LABELED, "eve")]), READY, ["tom"]), {
    kind: "refused",
    refusal: { kind: "labeled-by-non-instructor", by: "eve", labeledAt: LABELED },
  });
  const bot: TimelineNode = {
    __typename: "LabeledEvent",
    createdAt: LABELED,
    actor: { __typename: "Bot", login: "tom" },
    label: { name: READY },
  };
  assert.deepStrictEqual(judgeApproval(issueOf([bot]), READY, ["tom"]), {
    kind: "refused",
    refusal: { kind: "labeled-by-non-instructor", by: "tom", labeledAt: LABELED },
  });
  const deleted: TimelineNode = { ...bot, actor: null };
  assert.deepStrictEqual(judgeApproval(issueOf([deleted]), READY, ["tom"]), {
    kind: "refused",
    refusal: { kind: "labeled-by-non-instructor", by: null, labeledAt: LABELED },
  });
});

it("judgeApproval refuses a stranger's edit or rename at or after the label, not before", () => {
  const edited: Approval = {
    kind: "refused",
    refusal: { kind: "edited-after-label", labeledAt: LABELED },
  };
  const editAfter = issueOf([labeled(LABELED, "tom")], [[LABELED, "eve"]]);
  assert.deepStrictEqual(judgeApproval(editAfter, READY, ["tom"]), edited);
  const renameAfter = issueOf([labeled(LABELED, "tom"), renamed(AFTER, "eve")]);
  assert.deepStrictEqual(judgeApproval(renameAfter, READY, ["tom"]), edited);
  const before = issueOf([renamed(BEFORE, "eve"), labeled(LABELED, "tom")], [[BEFORE, "eve"]]);
  assert.equal(judgeApproval(before, READY, ["tom"]).kind, "approved");
  const instructor = issueOf([labeled(LABELED, "tom"), renamed(AFTER, "tom")], [[AFTER, "tom"]]);
  assert.equal(judgeApproval(instructor, READY, ["tom"]).kind, "approved");
});

it("judgeApproval refuses an edit history cut off after the label", () => {
  const edits = Array.from({ length: HISTORY_PAGE }, () => [AFTER, "tom"] as const);
  assert.deepStrictEqual(judgeApproval(issueOf([labeled(LABELED, "tom")], edits), READY, ["tom"]), {
    kind: "refused",
    refusal: { kind: "edit-history-incomplete", labeledAt: LABELED },
  });
});

it("editedSince counts anyone's edit or rename at or after the moment", () => {
  assert.isFalse(editedSince(issueOf([renamed(BEFORE, "tom")], [[BEFORE, "tom"]]), LABELED));
  assert.isTrue(editedSince(issueOf([], [[LABELED, "tom"]]), LABELED));
  assert.isTrue(editedSince(issueOf([renamed(AFTER, "tom")]), LABELED));
});

it("editedSince counts a timeline page that may hide a rename as a change", () => {
  const page = Array.from({ length: HISTORY_PAGE }, () => labeled(AFTER, "tom", "other"));
  assert.isTrue(editedSince(issueOf(page), LABELED));
  const reachesBack = [labeled(BEFORE, "tom", "other"), ...page.slice(1)];
  assert.isFalse(editedSince(issueOf(reachesBack), LABELED));
});
