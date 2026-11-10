/**
 * How a factory session ended, read from the last line of its last assistant message.
 *
 * The message is agent output shaped by issue text, so it is untrusted: only the exact markers
 * count, and a pull request URL is accepted only when it is a pull request on the repo.
 */

/** The last line of a finished session: `FACTORY-DONE: <PR URL>`. */
const DONE_MARKER = "FACTORY-DONE: ";
/** The last line of a session that needs answers, after its numbered questions. */
const NEEDS_INFO_LINE = "FACTORY-STOP: needs-info";
/** The last line of a session that gave up. */
const STUCK_LINE = "FACTORY-STOP: stuck";

/** The public reason when the session's run ended with no assistant message at all. */
export const NO_MESSAGE = "the session ended without a final message";
/** The public reason when the session's last message has no result line. */
export const NO_RESULT_LINE = "the session ended without a FACTORY-DONE or FACTORY-STOP line";
/** The public reason when the session stopped and said it was stuck. */
export const SAID_STUCK = "the session stopped and said it was stuck";
/** The public reason when the reported pull request is on another repo. */
export const NOT_ON_REPO = "the session reported a pull request that is not on this repo";
/** The public reason when the reported pull request URL is not exactly a GitHub pull request URL. */
export const MALFORMED_URL = "the session reported a malformed pull request URL";
/** The public reason when the session asked for information without writing any questions. */
export const NO_QUESTIONS = "the session asked for information but gave no questions";

/**
 * How a session ended. `done` carries the pull request number and the URL as the session wrote
 * it. `stuck.reason` is the factory's own fixed words; `sessionText` is what the session said,
 * raw, when there is anything to show.
 */
export type SessionResult =
  | { readonly kind: "done"; readonly pr: number; readonly prUrl: string }
  | { readonly kind: "needs-info"; readonly questions: string }
  | {
      readonly kind: "stuck";
      readonly reason: string;
      readonly sessionText: string | undefined;
    };

// Rust's `trim`/`trim_end` strip Unicode White_Space. JS `trim` differs on U+0085 (not stripped)
// and U+FEFF (stripped), so spell the Rust set out. Every member is one UTF-16 code unit.
const WHITE_SPACE = /[\t-\r \u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]/;

// Index loops, not `[...]+$`: that regex backtracks quadratically on a long whitespace run
// that is followed by other text, and the message is untrusted.
const trimEnd = (text: string) => {
  let end = text.length;
  while (end > 0 && WHITE_SPACE.test(text.charAt(end - 1))) end--;
  return text.slice(0, end);
};
const trim = (text: string) => {
  const trimmed = trimEnd(text);
  let start = 0;
  while (start < trimmed.length && WHITE_SPACE.test(trimmed.charAt(start))) start++;
  return trimmed.slice(start);
};

/** Lowercases ASCII letters only, so a non-ASCII character never folds into an ASCII one. */
const asciiLower = (text: string) => text.replace(/[A-Z]/g, (c) => c.toLowerCase());

/**
 * The last non-empty line, with trailing whitespace (and the `\r` of a CRLF) removed, and the
 * raw text before it. Undefined when the message is blank.
 */
export const splitLastLine = (
  message: string,
): { readonly before: string; readonly last: string } | undefined => {
  const trimmed = trimEnd(message);
  if (trimmed === "") return undefined;
  const index = trimmed.lastIndexOf("\n");
  if (index === -1) return { before: "", last: trimmed };
  return { before: trimmed.slice(0, index), last: trimEnd(trimmed.slice(index + 1)) };
};

const NAME_PATTERN = /^[A-Za-z0-9._-]+$/;
const DIGITS_PATTERN = /^[0-9]+$/;
const PULL_URL_PREFIX = "https://github.com/";

/**
 * The owner, name and pull request number if `url` is exactly
 * `https://github.com/<owner>/<name>/pull/<n>`. The number is written the way GitHub writes it:
 * positive, no leading zeros, and small enough to be exact.
 */
export const pullRequestUrl = (
  url: string,
): { readonly owner: string; readonly name: string; readonly pr: number } | undefined => {
  if (!url.startsWith(PULL_URL_PREFIX)) return undefined;
  const parts = url.slice(PULL_URL_PREFIX.length).split("/");
  if (parts.length !== 4 || parts[2] !== "pull") return undefined;
  const [owner, name, , number] = parts as [string, string, string, string];
  if (!NAME_PATTERN.test(owner) || !NAME_PATTERN.test(name) || !DIGITS_PATTERN.test(number)) {
    return undefined;
  }
  const pr = Number(number);
  // `007` is not the number 7 as GitHub writes it, and a number past 2^53 does not round-trip.
  if (!Number.isSafeInteger(pr) || pr <= 0 || String(pr) !== number) return undefined;
  return { owner, name, pr };
};

/**
 * Reads the session's last assistant message. The marker must be the whole last non-empty line.
 * The text is agent output shaped by issue text, so it is untrusted: only the exact markers
 * count, and a pull request URL is accepted only when it is a pull request on `repo`
 * (`owner/name`, compared ASCII case-insensitively).
 */
export const parseSessionResult = (
  repo: string,
  lastAssistantMessage: string | undefined,
): SessionResult => {
  const stuck = (reason: string, sessionText: string | undefined): SessionResult => ({
    kind: "stuck",
    reason,
    sessionText,
  });
  const split =
    lastAssistantMessage === undefined ? undefined : splitLastLine(lastAssistantMessage);
  if (lastAssistantMessage === undefined || split === undefined) {
    return stuck(NO_MESSAGE, undefined);
  }
  const whole = lastAssistantMessage;
  const { last } = split;
  if (last.startsWith(DONE_MARKER)) {
    const url = last.slice(DONE_MARKER.length);
    const parsed = pullRequestUrl(url);
    if (parsed === undefined) return stuck(MALFORMED_URL, whole);
    if (asciiLower(`${parsed.owner}/${parsed.name}`) !== asciiLower(repo)) {
      return stuck(NOT_ON_REPO, whole);
    }
    return { kind: "done", pr: parsed.pr, prUrl: url };
  }
  const before = trim(split.before);
  if (last === NEEDS_INFO_LINE) {
    return before === ""
      ? stuck(NO_QUESTIONS, undefined)
      : { kind: "needs-info", questions: before };
  }
  if (last === STUCK_LINE) return stuck(SAID_STUCK, before === "" ? undefined : before);
  return stuck(NO_RESULT_LINE, whole);
};
