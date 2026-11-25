import { assert, it } from "@effect/vitest";
import { describe } from "vitest";

import type { Approval } from "../domain/approval.ts";

import {
  APPROVAL_QUERY,
  type ApprovalIssue,
  editedSince,
  HISTORY_PAGE,
  isUtcSecond,
  judgeApproval,
  REAP_SWAP_SECONDS,
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

describe("judgeApproval: a factory:ready label the factory's own login applied", () => {
  const FACTORY = "softfac-bot";
  const T = (minute: number) => `2026-10-04T10:${String(minute).padStart(2, "0")}:00Z`;
  const unlabeledAs = (at: string, login: string, name: string): TimelineNode => ({
    __typename: "UnlabeledEvent",
    createdAt: at,
    actor: user(login),
    label: { name },
  });
  /** An instructor's ready at 10:00, the claim's swap to triage, then the reaper's swap back to ready. */
  const reaped = (extra: ReadonlyArray<TimelineNode> = []): Array<TimelineNode> => [
    labeled(T(0), "Tom"),
    unlabeledAs(T(1), FACTORY, READY),
    labeled(T(1), FACTORY, "factory:triage"),
    ...extra,
    unlabeledAs(T(20), FACTORY, "factory:triage"),
    labeled(T(20), FACTORY),
  ];

  it("carries the instructor's earlier label when every factory label change since was the factory's", () => {
    assert.deepStrictEqual(judgeApproval(issueOf(reaped()), READY, ["tom"], FACTORY), {
      kind: "approved",
      labeledAt: T(0),
      labeledBy: "Tom",
    });
  });

  it("carries it through earlier reaps and a building stint as well", () => {
    const again = [
      unlabeledAs(T(5), FACTORY, "factory:triage"),
      labeled(T(5), FACTORY),
      unlabeledAs(T(6), FACTORY, READY),
      labeled(T(6), FACTORY, "factory:triage"),
      unlabeledAs(T(7), FACTORY, "factory:triage"),
      labeled(T(7), FACTORY, "factory:building"),
      unlabeledAs(T(8), FACTORY, "factory:building"),
      labeled(T(8), FACTORY, "factory:triage"),
    ];
    assert.deepStrictEqual(judgeApproval(issueOf(reaped(again)), READY, ["tom"], FACTORY), {
      kind: "approved",
      labeledAt: T(0),
      labeledBy: "Tom",
    });
    // Other labels anyone sets in between do not matter.
    const other = [labeled(T(9), "eve", "bug")];
    assert.strictEqual(judgeApproval(issueOf(reaped(other)), READY, ["tom"], FACTORY).kind, "approved");
  });

  it("judges the text from the instructor's label, so a stranger's edit during the stall refuses it", () => {
    const edited = issueOf(reaped(), [[T(10), "eve"]]);
    assert.deepStrictEqual(judgeApproval(edited, READY, ["tom"], FACTORY), {
      kind: "refused",
      refusal: { kind: "edited-after-label", labeledAt: T(0) },
    });
  });

  it("refuses when someone else moved a factory label in between, or no instructor's label is found", () => {
    const moved = [unlabeledAs(T(9), "eve", "factory:triage"), labeled(T(9), "eve", "factory:triage")];
    const byEve = judgeApproval(issueOf(reaped(moved)), READY, ["tom"], FACTORY);
    assert.deepStrictEqual(byEve, {
      kind: "refused",
      refusal: { kind: "labeled-by-non-instructor", by: FACTORY, labeledAt: T(20) },
    });
    // The ready before the claim was a stranger's.
    const stranger = [labeled(T(0), "eve"), ...reaped().slice(1)];
    assert.strictEqual(judgeApproval(issueOf(stranger), READY, ["tom"], FACTORY).kind, "refused");
    // Nothing before the factory's label at all.
    assert.strictEqual(
      judgeApproval(issueOf([labeled(T(20), FACTORY)]), READY, ["tom"], FACTORY).kind,
      "refused",
    );
  });

  it("says a full page that holds no instructor's label before the factory's is incomplete", () => {
    const filler = Array.from({ length: HISTORY_PAGE - 2 }, () => labeled(T(9), "eve", "bug"));
    const page = [...filler, unlabeledAs(T(20), FACTORY, "factory:triage"), labeled(T(20), FACTORY)];
    assert.deepStrictEqual(
      judgeApproval(issueOf(page, [], { events: HISTORY_PAGE + 5 }), READY, ["tom"], FACTORY),
      { kind: "refused", refusal: { kind: "label-history-incomplete" } },
    );
  });

  it("walks back from a reap by a factory login that is an instructor too, so an edit during the stall still refuses", () => {
    assert.deepStrictEqual(judgeApproval(issueOf(reaped()), READY, ["tom", FACTORY], FACTORY), {
      kind: "approved",
      labeledAt: T(0),
      labeledBy: "Tom",
    });
    const edited = issueOf(reaped(), [[T(10), "eve"]]);
    assert.deepStrictEqual(judgeApproval(edited, READY, ["tom", FACTORY], FACTORY), {
      kind: "refused",
      refusal: { kind: "edited-after-label", labeledAt: T(0) },
    });
  });

  it("carries only the reap's shape: a factory ready that replaced the factory's triage in one edit", () => {
    // A factory-login ready with no triage removed beside it is no reap: judged as its own label.
    const bare = [labeled(T(0), "Tom"), unlabeledAs(T(1), FACTORY, READY), labeled(T(20), FACTORY)];
    assert.deepStrictEqual(judgeApproval(issueOf(bare), READY, ["tom"], FACTORY), {
      kind: "refused",
      refusal: { kind: "labeled-by-non-instructor", by: FACTORY, labeledAt: T(20) },
    });
    // An instructor-login factory relabelling by hand is a fresh approval, as before.
    assert.deepStrictEqual(judgeApproval(issueOf(bare), READY, ["tom", FACTORY], FACTORY), {
      kind: "approved",
      labeledAt: T(20),
      labeledBy: FACTORY,
    });
  });

  it.each(["factory:stuck", "factory:needs-info", "factory:pr-open", "factory:proposed"])(
    "refuses a factory ready after a %s stint, which needs a person's factory:ready to leave",
    (label) => {
      const stint = [
        unlabeledAs(T(9), FACTORY, "factory:triage"),
        labeled(T(9), FACTORY, label),
        unlabeledAs(T(10), FACTORY, label),
        labeled(T(10), FACTORY, "factory:triage"),
      ];
      assert.strictEqual(
        judgeApproval(issueOf(reaped(stint)), READY, ["tom"], FACTORY).kind,
        "refused",
      );
    },
  );

  it("carries an approval whose instructor also removed factory:proposed, before or after the ready", () => {
    // One edit lists the added label first; a separate removal can come a second before.
    for (const approval of [
      [labeled(T(0), "Tom"), unlabeledAs(T(0), "Tom", "factory:proposed")],
      [unlabeledAs("2026-10-04T09:59:59Z", "Tom", "factory:proposed"), labeled(T(0), "Tom")],
    ]) {
      const events = [...approval, ...reaped().slice(1)];
      assert.deepStrictEqual(judgeApproval(issueOf(events), READY, ["tom"], FACTORY), {
        kind: "approved",
        labeledAt: T(0),
        labeledBy: "Tom",
      });
    }
  });

  it("judges as before with no factory login given", () => {
    assert.strictEqual(judgeApproval(issueOf(reaped()), READY, ["tom"]).kind, "refused");
  });

  it("never lets a reap by a factory login that is an instructor approve itself when nothing is carried", () => {
    const instructors = ["tom", FACTORY];
    const notCarried: Approval = {
      kind: "refused",
      refusal: { kind: "labeled-by-non-instructor", by: FACTORY, labeledAt: T(20) },
    };
    // A stranger moved a factory label during the stall, and edited the body before the reap.
    const moved = [unlabeledAs(T(9), "eve", "factory:triage"), labeled(T(9), "eve", "factory:triage")];
    const edited = issueOf(reaped(moved), [[T(9), "eve"]]);
    assert.deepStrictEqual(judgeApproval(edited, READY, instructors, FACTORY), notCarried);
    // A stuck stint in between, which needs a person's factory:ready to leave.
    const stint = [
      unlabeledAs(T(9), FACTORY, "factory:triage"),
      labeled(T(9), FACTORY, "factory:stuck"),
      unlabeledAs(T(10), FACTORY, "factory:stuck"),
      labeled(T(10), FACTORY, "factory:triage"),
    ];
    assert.deepStrictEqual(judgeApproval(issueOf(reaped(stint)), READY, instructors, FACTORY), notCarried);
    // A whole page with no instructor's label before the reap.
    const alone = [labeled(T(1), FACTORY, "factory:triage"), ...reaped().slice(-2)];
    assert.deepStrictEqual(judgeApproval(issueOf(alone), READY, instructors, FACTORY), notCarried);
  });

  it("walks past an earlier reap's ready by a factory login that is an instructor, so an edit in the first stall refuses", () => {
    const again = [
      unlabeledAs(T(5), FACTORY, "factory:triage"),
      labeled(T(5), FACTORY),
      unlabeledAs(T(6), FACTORY, READY),
      labeled(T(6), FACTORY, "factory:triage"),
    ];
    const edited = issueOf(reaped(again), [[T(3), "eve"]]);
    assert.deepStrictEqual(judgeApproval(edited, READY, ["tom", FACTORY], FACTORY), {
      kind: "refused",
      refusal: { kind: "edited-after-label", labeledAt: T(0) },
    });
    assert.deepStrictEqual(judgeApproval(issueOf(reaped(again)), READY, ["tom", FACTORY], FACTORY), {
      kind: "approved",
      labeledAt: T(0),
      labeledBy: "Tom",
    });
  });

  it(`knows the reaper's swap when GitHub stamps its halves up to ${REAP_SWAP_SECONDS} seconds apart, in either order`, () => {
    const at = (second: number) => `2026-10-04T10:20:${String(second).padStart(2, "0")}Z`;
    const head = reaped().slice(0, -2);
    for (const swap of [
      // As live issues show it: the removal a second before or after the add.
      [unlabeledAs(at(0), FACTORY, "factory:triage"), labeled(at(1), FACTORY)],
      [labeled(at(0), FACTORY), unlabeledAs(at(1), FACTORY, "factory:triage")],
      [labeled(at(0), FACTORY), unlabeledAs(at(REAP_SWAP_SECONDS), FACTORY, "factory:triage")],
    ]) {
      assert.deepStrictEqual(judgeApproval(issueOf([...head, ...swap]), READY, ["tom"], FACTORY), {
        kind: "approved",
        labeledAt: T(0),
        labeledBy: "Tom",
      });
    }
    // Further apart, it is not one edit: the factory's ready is judged as its own label.
    const apart = [labeled(at(0), FACTORY), unlabeledAs(at(REAP_SWAP_SECONDS + 1), FACTORY, "factory:triage")];
    assert.deepStrictEqual(judgeApproval(issueOf([...head, ...apart]), READY, ["tom"], FACTORY), {
      kind: "refused",
      refusal: { kind: "labeled-by-non-instructor", by: FACTORY, labeledAt: at(0) },
    });
    // A factory state change between the two is not one edit either.
    const between = [
      unlabeledAs(at(0), FACTORY, "factory:triage"),
      labeled(at(0), FACTORY, "factory:building"),
      labeled(at(1), FACTORY),
    ];
    assert.strictEqual(judgeApproval(issueOf([...head, ...between]), READY, ["tom"], FACTORY).kind, "refused");
  });

  it("takes only the factory's own User login for the reaper: an app with that login forges no reap", () => {
    const bot = { __typename: "Bot", login: FACTORY };
    const forged = reaped().map((event) =>
      event.__typename !== "RenamedTitleEvent" && event.actor?.login === FACTORY
        ? { ...event, actor: bot }
        : event,
    );
    assert.deepStrictEqual(judgeApproval(issueOf(forged), READY, ["tom"], FACTORY), {
      kind: "refused",
      refusal: { kind: "labeled-by-non-instructor", by: FACTORY, labeledAt: T(20) },
    });
    // The swap by the app, after a claim by the factory's own login, carries nothing either.
    const swapped = [...reaped().slice(0, -2), ...forged.slice(-2)];
    assert.strictEqual(judgeApproval(issueOf(swapped), READY, ["tom"], FACTORY).kind, "refused");
  });
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
