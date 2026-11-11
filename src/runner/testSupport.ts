/**
 * The one richer context `advance` takes. A rig built for the building steps alone goes through
 * `interruptible` where it calls `advance`: it gains the claim's fields, and every claim call
 * the rig does not fake fails loudly, so a test that did not expect a launch or a claim sees one.
 */
import * as Effect from "effect/Effect";

import type { BuildingContext, InterruptContext } from "./building.ts";

const notExpected = (name: string) => () =>
  Effect.die(`${name} was called where the test did not expect it`);

export const interruptible = (ctx: BuildingContext): InterruptContext => ({
  ...ctx,
  repoProject: ctx.project,
  tracker: {
    approval: notExpected("tracker.approval"),
    claim: notExpected("tracker.claim"),
    // No claim comment: what an issue claimed before claim comments reads as.
    claimWinner: () => Effect.succeed(null),
    newestFactoryComment: notExpected("tracker.newestFactoryComment"),
    branchTip: notExpected("tracker.branchTip"),
    textEditedSince: notExpected("tracker.textEditedSince"),
    openPullRequestsClosing: notExpected("tracker.openPullRequestsClosing"),
    ...ctx.tracker,
  },
  sessions: {
    findProject: notExpected("sessions.findProject"),
    launch: notExpected("sessions.launch"),
    ...ctx.sessions,
  },
  repoPath: "/work/softfac",
  ghConfigDir: "/gh/rawphp",
});
