// @effect-diagnostics nodeBuiltinImport:off - nextAttempt lists the runs directory synchronously, like the rest of the ledger.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { InvalidRunIdError } from "./errors.ts";
import { U32_MAX } from "./limits.ts";

/** The directory under the data dir that holds the run files. */
export const RUNS_DIR = "runs";
const EXTENSION = "jsonl";

const SHAPE = "expected <owner>__<repo>__<issue>__<attempt>";
const REPO_REASON =
  "the repo must be <owner>/<name>: the owner uses letters, digits and `-` plus single `_` between them, the name uses letters, digits, `.`, `_` and `-` and is not `.` or `..`";
const ISSUE_REASON =
  "the issue must be a number without a sign or leading zero (8), or a team key, a hyphen and such a number (ENG-42)";
const ATTEMPT_REASON =
  "the attempt must be a number without a sign or leading zero, up to 4294967295";

const U64_MAX = 18446744073709551615n;

/**
 * One run: a repo, an issue in it, and which attempt at that issue this is.
 * `repo` is lowercase `owner/name`. GitHub names are case-insensitive, and so are macOS file
 * systems, so one repo must be one run id and one file. `issue` is as softfac's IssueKey stores
 * it: a canonical number (`"8"`) or a Linear identifier in capitals (`"ENG-42"`).
 */
export type RunId = {
  readonly repo: string;
  readonly issue: string;
  readonly attempt: number;
};

/** Lowercase the ASCII letters only: `toLowerCase` would fold U+212A (Kelvin) into a `k`. */
export const asciiLower = (text: string) => text.replace(/[A-Z]/g, (c) => c.toLowerCase());

/** A number the way we write it: digits, no sign, no leading zeros, no padding. */
const CANONICAL = /^(?:0|[1-9][0-9]*)$/;
const canonicalU64 = (text: string) => CANONICAL.test(text) && BigInt(text) <= U64_MAX;
const canonicalU32 = (text: string): number | null =>
  CANONICAL.test(text) && Number(text) <= U32_MAX ? Number(text) : null;

/**
 * `8`, `ENG-42` or `eng-42`. A number must be canonical and fit an unsigned 64-bit integer; an
 * identifier is a team key (letters and digits, starting with a letter), a hyphen, then such a
 * number, stored in capitals.
 */
export const parseIssueKey = (text: string): string => {
  if (canonicalU64(text)) return text;
  const hyphen = text.indexOf("-");
  if (hyphen !== -1) {
    const team = text.slice(0, hyphen);
    const number = text.slice(hyphen + 1);
    if (/^[A-Za-z][A-Za-z0-9]*$/.test(team) && canonicalU64(number)) {
      return `${asciiLower(team).toUpperCase()}-${number}`;
    }
  }
  throw new InvalidRunIdError({ input: text, reason: ISSUE_REASON });
};

/** `8` or `eng-42`: the run id field. Never holds `_`, `/` or a capital. */
export const issueRunPart = (issue: string): string => asciiLower(issue);

/**
 * Lowercase `owner/name` after checking both parts. GitHub owners use `[A-Za-z0-9-]`, and
 * Enterprise Managed User logins add a `_` (`handle_shortcode`), so an owner may hold single
 * underscores between other characters: none first, none last, never `__`. That is what lets
 * `parseRunId` end the owner at the first `__`. Repo names use `[A-Za-z0-9._-]`.
 */
const normaliseRepo = (input: string): string | null => {
  const repo = asciiLower(input);
  const slash = repo.indexOf("/");
  if (slash === -1) return null;
  const owner = repo.slice(0, slash);
  const name = repo.slice(slash + 1);
  const ownerOk =
    owner.length > 0 &&
    !owner.startsWith("_") &&
    !owner.endsWith("_") &&
    !owner.includes("__") &&
    /^[a-z0-9_-]+$/.test(owner);
  const nameOk = name !== "." && name !== ".." && /^[a-z0-9._-]+$/.test(name);
  return ownerOk && nameOk ? repo : null;
};

/** A run id for `owner/name`, lowercased. Throws for a repo that is not a legal GitHub one. */
export const newRunId = (repo: string, issue: string, attempt: number): RunId => {
  const normalised = normaliseRepo(repo);
  if (normalised === null) throw new InvalidRunIdError({ input: repo, reason: REPO_REASON });
  if (!Number.isInteger(attempt) || attempt < 0 || attempt > U32_MAX) {
    throw new InvalidRunIdError({ input: String(attempt), reason: ATTEMPT_REASON });
  }
  return { repo: normalised, issue: parseIssueKey(issue), attempt };
};

/**
 * Check the id is already in the form `newRunId` produces: lowercase `owner/name`, the owner
 * in `[a-z0-9-]` with single interior `_`, and the name in `[a-z0-9._-]` but not `.` or `..`,
 * and an issue and attempt that are canonical. That is what keeps the run id from escaping the
 * runs directory.
 */
export const validateRunId = (id: RunId): void => {
  if (normaliseRepo(id.repo) !== id.repo)
    throw new InvalidRunIdError({ input: id.repo, reason: REPO_REASON });
  let issue: string | null = null;
  try {
    issue = parseIssueKey(id.issue);
  } catch {
    // Reported below.
  }
  if (issue !== id.issue) throw new InvalidRunIdError({ input: id.issue, reason: ISSUE_REASON });
  if (!Number.isInteger(id.attempt) || id.attempt < 0 || id.attempt > U32_MAX) {
    throw new InvalidRunIdError({ input: String(id.attempt), reason: ATTEMPT_REASON });
  }
};

/**
 * Parse `<owner>__<repo>__<issue>__<attempt>`, lowercasing the owner and repo.
 *
 * The owner never holds `__`, so it ends at the first `__`. The last two fields are canonical
 * numbers, so they are taken from the right. Whatever is left in the middle is the repo name,
 * which may itself contain `__`. That makes the split unambiguous.
 */
export const parseRunId = (text: string): RunId => {
  const bad = (reason: string) => new InvalidRunIdError({ input: text, reason });
  const first = text.indexOf("__");
  if (first === -1) throw bad(SHAPE);
  const owner = text.slice(0, first);
  const afterOwner = text.slice(first + 2);
  const lastA = afterOwner.lastIndexOf("__");
  if (lastA === -1) throw bad(SHAPE);
  const beforeAttempt = afterOwner.slice(0, lastA);
  const attempt = canonicalU32(afterOwner.slice(lastA + 2));
  const lastB = beforeAttempt.lastIndexOf("__");
  if (lastB === -1) throw bad(SHAPE);
  const name = beforeAttempt.slice(0, lastB);
  const issueText = beforeAttempt.slice(lastB + 2);
  if (attempt === null) throw bad(SHAPE);
  if (issueText !== asciiLower(issueText)) throw bad(SHAPE);
  let issue: string;
  try {
    issue = parseIssueKey(issueText);
  } catch {
    throw bad(SHAPE);
  }
  const repo = normaliseRepo(`${owner}/${name}`);
  if (repo === null) throw bad(REPO_REASON);
  return { repo, issue, attempt };
};

/** `<run id>`: `owner__name__issue__attempt`. */
export const runIdToString = (id: RunId): string => {
  const slash = id.repo.indexOf("/");
  const owner = slash === -1 ? id.repo : id.repo.slice(0, slash);
  const name = slash === -1 ? "" : id.repo.slice(slash + 1);
  return `${owner}__${name}__${issueRunPart(id.issue)}__${id.attempt}`;
};

/** `<run id>.jsonl`. */
export const runIdFileName = (id: RunId): string => `${runIdToString(id)}.${EXTENSION}`;

/**
 * The run id for a file name, or `null` if the name is not exactly `<run id>.jsonl` in the
 * form this code writes (so a file with capitals in its name is not one of ours).
 */
export const runIdFromFileName = (name: string): RunId | null => {
  const suffix = `.${EXTENSION}`;
  if (!name.endsWith(suffix)) return null;
  let id: RunId;
  try {
    id = parseRunId(name.slice(0, -suffix.length));
  } catch {
    return null;
  }
  return runIdFileName(id) === name ? id : null;
};

/**
 * `<data dir>/runs/<run id>.jsonl`, after checking the run id is safe to use as a file name.
 */
export const runPath = (dataDir: string, id: RunId): string => {
  validateRunId(id);
  return NodePath.join(dataDir, RUNS_DIR, runIdFileName(id));
};

/**
 * `<data dir>/feedback/<run id>.read`: two lines of epoch milliseconds as decimal text. The first
 * is when the run's feedback was last read (tried, even if it failed). The second, which may be
 * missing, is when the last read that succeeded and found nothing new started. The ledger
 * removes the file when the run's `finished` line is written.
 */
export const feedbackReadFile = (dataDir: string, id: RunId): string =>
  NodePath.join(dataDir, "feedback", `${runIdToString(id)}.read`);

/**
 * The attempt number for a new run of this issue: one past the highest existing attempt, or 1.
 * The repo is matched case-insensitively. A runs directory that cannot be read counts as
 * empty; `Ledger.create` refuses to overwrite.
 */
export const nextAttempt = (dataDir: string, repo: string, issue: string): number => {
  const wanted = asciiLower(repo);
  const wantedIssue = parseIssueKey(issue);
  let names: Array<string>;
  try {
    names = NodeFS.readdirSync(NodePath.join(dataDir, RUNS_DIR));
  } catch {
    return 1;
  }
  let highest: number | null = null;
  for (const name of names) {
    const id = runIdFromFileName(name);
    if (id === null || id.repo !== wanted || id.issue !== wantedIssue) continue;
    if (highest === null || id.attempt > highest) highest = id.attempt;
  }
  return highest === null ? 1 : Math.min(highest + 1, U32_MAX);
};
