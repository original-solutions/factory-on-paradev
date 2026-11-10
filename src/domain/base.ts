/** The `## Base` section of an issue body: pure text parsing, no `gh` call. */
import { sectionLines } from "./dependsOn.ts";

/**
 * The branch the issue's work lands on, as its `## Base` section names it: the section's first
 * non-blank line, trimmed. Null for no section, an empty one, or `None.` (any case), which leave
 * the run on the project's `factory.base`. The name is not checked here.
 */
export const issueBase = (body: string): string | null => {
  const first = sectionLines(body, "base")
    .map((line) => line.trim())
    .find((line) => line !== "");
  return first === undefined || first.toLowerCase() === "none." ? null : first;
};
