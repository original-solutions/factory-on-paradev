/**
 * What the run page shows of a run's issue and pull request, read through the factory's own `gh`.
 * Read only when a page asks, and kept a short while, so a person stepping through runs costs
 * GitHub at most two reads per run per {@link KEEP_MS}. Fresh reads share one budget across all
 * callers, as the passes spend the same `gh` login. Nothing here writes to GitHub.
 */
import * as Effect from "effect/Effect";

import { dataField } from "./ledger/read.ts";
import { parseRunId } from "./ledger/runId.ts";
import type { GitHubError, IssueDetail, PullRequestSummary } from "./tracker/github.ts";

/** How long an answer is shown again without asking GitHub. */
export const KEEP_MS = 2 * 60_000;

/** At most this many runs are read fresh from GitHub per {@link FRESH_WINDOW_MS}, across callers. */
export const FRESH_RUNS_PER_WINDOW = 10;
export const FRESH_WINDOW_MS = 60_000;

/** The longest issue or pull request text sent to the page, in characters. */
export const TEXT_LIMIT = 40_000;

/** A read of one part: what GitHub said, or why it could not be asked. */
export type Part<T> =
  | ({ readonly kind: "ok" } & T)
  | { readonly kind: "signed-out"; readonly message: string }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "gone" };

export interface IssuePart {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly body_cut: boolean;
  readonly author: string | null;
  /** Labels other than the factory's own. */
  readonly labels: ReadonlyArray<string>;
  readonly closed: boolean;
}

export interface PullRequestPart {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly body_cut: boolean;
  readonly state: PullRequestSummary["state"];
  readonly additions: number;
  readonly deletions: number;
  readonly changed_files: number;
  readonly review_decision: string | null;
  readonly files: PullRequestSummary["files"];
}

export interface RunGitHub {
  readonly id: string;
  /** Null for a run whose issue is not on GitHub (a Linear identifier). */
  readonly issue: Part<IssuePart> | null;
  /** Null while the run has opened no pull request. */
  readonly pr: Part<PullRequestPart> | null;
}

/** A run as the ledger shows it: its id and entries (`showRun`). */
export interface ShownRun {
  readonly id: string;
  readonly entries: ReadonlyArray<{ readonly event: string; readonly data: unknown }>;
}

/** The reads it makes: the tracker's, for the run's repo. */
export interface GitHubReads {
  readonly issue: (number: number) => Effect.Effect<IssueDetail, GitHubError>;
  readonly pullRequestSummary: (
    number: number,
  ) => Effect.Effect<PullRequestSummary | null, GitHubError>;
}

const SIGNED_OUT = /gh auth login|not logged in|GH_TOKEN|authentication required|HTTP 401/i;

/** The pull request the run's ledger last says it opened. */
export const ledgerPullRequest = (
  entries: ReadonlyArray<{ readonly event: string; readonly data: unknown }>,
): number | null => {
  for (let at = entries.length - 1; at >= 0; at -= 1) {
    const entry = entries[at]!;
    if (entry.event !== "pr_opened") continue;
    const pr = dataField(entry.data, "pr");
    if (typeof pr === "number" && Number.isInteger(pr) && pr > 0) return pr;
  }
  return null;
};

const cut = (text: string) =>
  text.length > TEXT_LIMIT ? { text: text.slice(0, TEXT_LIMIT), cut: true } : { text, cut: false };

/** Why a read failed, in words for the page: signed out is told apart, as it is the usual case. */
const failedPart = (error: GitHubError): Part<never> => {
  if (error._tag === "GitHubFailed" && SIGNED_OUT.test(error.stderr)) {
    return { kind: "signed-out", message: "the factory's gh is not signed in to GitHub" };
  }
  if (error._tag === "GitHubSpawnError") {
    return { kind: "failed", message: "gh could not be started on this machine" };
  }
  if (error._tag === "GitHubRateLimited") {
    return { kind: "failed", message: "GitHub's rate limit is spent; try again later" };
  }
  if (error._tag === "GitHubTimedOut") return { kind: "failed", message: "GitHub took too long" };
  const firstLine =
    error._tag === "GitHubFailed"
      ? (error.stderr.trim().split("\n")[0] ?? "")
      : error.message.split("\n")[0]!;
  return { kind: "failed", message: firstLine.slice(0, 200) || "GitHub could not be read" };
};

const issuePart = (issue: IssueDetail): Part<IssuePart> => {
  const body = cut(issue.body);
  return {
    kind: "ok",
    number: issue.number,
    title: issue.title,
    body: body.text,
    body_cut: body.cut,
    author: issue.author,
    labels: issue.labels.filter((label) => !label.startsWith("factory:")),
    closed: issue.closed,
  };
};

const pullRequestPart = (pr: PullRequestSummary | null): Part<PullRequestPart> => {
  if (pr === null) return { kind: "gone" };
  const body = cut(pr.body);
  return {
    kind: "ok",
    number: pr.number,
    title: pr.title,
    body: body.text,
    body_cut: body.cut,
    state: pr.state,
    additions: pr.additions,
    deletions: pr.deletions,
    changed_files: pr.changedFiles,
    review_decision: pr.reviewDecision,
    files: pr.files,
  };
};

const settle = <A>(read: Effect.Effect<Part<A>, GitHubError>) =>
  read.pipe(Effect.catch((error: GitHubError) => Effect.succeed(failedPart(error))));

/**
 * The reader the run route calls with a run it found in the ledger, so a run id nobody made is
 * never read from GitHub. `readsFor` gives the tracker reads of a repo, or null when the factory
 * has no config to read with; `nowMs` is the clock. Answers GitHub gave are kept per run for
 * {@link KEEP_MS}; failures are not, so Try again asks again.
 */
export const makeRunGitHubReader = (options: {
  readonly readsFor: (repo: string) => GitHubReads | null;
  readonly nowMs: () => number;
}) => {
  const kept = new Map<string, { readonly atMs: number; readonly answer: RunGitHub }>();
  let freshAt: Array<number> = [];
  return Effect.fn("FactoryRunGitHub.read")(function* (shown: ShownRun) {
    const now = options.nowMs();
    const hit = kept.get(shown.id);
    if (hit !== undefined && now - hit.atMs < KEEP_MS) return hit.answer;
    const run = parseRunId(shown.id);
    const issueNumber = /^\d+$/.test(run.issue) ? Number(run.issue) : null;
    const prNumber = ledgerPullRequest(shown.entries);
    freshAt = freshAt.filter((atMs) => now - atMs < FRESH_WINDOW_MS);
    if (freshAt.length >= FRESH_RUNS_PER_WINDOW && (issueNumber !== null || prNumber !== null)) {
      const busy: Part<never> = {
        kind: "failed",
        message: "the factory is reading GitHub for many runs at once; try again in a minute",
      };
      return {
        id: shown.id,
        issue: issueNumber === null ? null : busy,
        pr: prNumber === null ? null : busy,
      } satisfies RunGitHub;
    }
    const reads = options.readsFor(run.repo);
    if (reads !== null && (issueNumber !== null || prNumber !== null)) freshAt.push(now);
    const unread: Part<never> = { kind: "failed", message: "the factory has no config loaded" };
    const [issue, pr] = yield* Effect.all(
      [
        issueNumber === null
          ? Effect.succeed(null)
          : reads === null
            ? Effect.succeed(unread)
            : settle(reads.issue(issueNumber).pipe(Effect.map(issuePart))),
        prNumber === null
          ? Effect.succeed(null)
          : reads === null
            ? Effect.succeed(unread)
            : settle(reads.pullRequestSummary(prNumber).pipe(Effect.map(pullRequestPart))),
      ],
      { concurrency: 2 },
    );
    const answer: RunGitHub = { id: shown.id, issue, pr };
    for (const [key, entry] of kept) if (now - entry.atMs >= KEEP_MS) kept.delete(key);
    const settled = (part: Part<unknown> | null) =>
      part === null || part.kind === "ok" || part.kind === "gone";
    if (settled(issue) && settled(pr)) kept.set(shown.id, { atMs: now, answer });
    return answer;
  });
};
