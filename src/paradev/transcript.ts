/**
 * The last assistant message in `agents read`'s `text`. The transcript is a run of chunks, each
 * starting with `User: ` or `Assistant: ` at the start of the text or after a blank line. One
 * reply can be several `Assistant:` chunks, and the result line is in the last; a chunk may hold
 * blank lines of its own.
 */

/** A chunk's start: its prefix at the very start of the text or after a blank line. */
const CHUNK = /(?:^|\n\n)(User|Assistant): /g;

/**
 * The text of the last `Assistant:` chunk without its prefix, trailing whitespace cut. Null when
 * a `User:` chunk follows it, or there is none: the run has no assistant message.
 */
export const lastAssistantMessage = (text: string): string | null => {
  let last: { readonly role: string; readonly start: number } | null = null;
  for (const match of text.matchAll(CHUNK)) {
    last = { role: match[1]!, start: match.index + match[0].length };
  }
  if (last === null || last.role !== "Assistant") return null;
  return text.slice(last.start).trimEnd();
};
