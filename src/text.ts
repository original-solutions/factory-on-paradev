/** Text from a session, a config or a repo, made safe to store and to show. */

const isControl = (cp: number) => cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f);

/** Characters that could fake a line break or hide text, besides the control characters. */
const isInvisibleOrSeparator = (cp: number) =>
  cp === 0x2028 ||
  cp === 0x2029 ||
  (cp >= 0x200b && cp <= 0x200f) ||
  (cp >= 0x202a && cp <= 0x202e) ||
  (cp >= 0x2066 && cp <= 0x2069) ||
  cp === 0xfeff;

/**
 * Replace what could fake a line break, hide text or drive a terminal with a space. Newline and
 * tab are kept only when `keepLayout` is set.
 */
export const sanitize = (text: string, keepLayout: boolean): string => {
  let out = "";
  for (const char of text) {
    const cp = char.codePointAt(0)!;
    const layout = char === "\n" || char === "\t";
    out += (isControl(cp) && !(keepLayout && layout)) || isInvisibleOrSeparator(cp) ? " " : char;
  }
  return out;
};

/** The longest command shown in a gate message or a results table, in characters. */
const MAX_COMMAND_CHARS = 300;

/** A command as one short line: sanitised, newlines and tabs turned into spaces, cut at 300 characters. */
export const commandLine = (command: string): string => {
  const chars = Array.from(sanitize(command, false));
  return chars.length > MAX_COMMAND_CHARS
    ? `${chars.slice(0, MAX_COMMAND_CHARS).join("")}\u2026`
    : chars.join("");
};

/** The first seven hex digits of a commit id, as the words for people and the session name it. */
export const shortSha = (sha: string): string =>
  Array.from(sha)
    .filter((char) => /^[0-9a-fA-F]$/.test(char))
    .slice(0, 7)
    .join("");

/** Whether `text` is a full commit id: 40 hex digits (64 in a SHA-256 repo). */
export const isCommitId = (text: string): boolean =>
  /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/.test(text);
