/** The `## Depends on` section of an issue body: pure text parsing, no `gh` call. */

/** An issue named in the `## Depends on` section of an issue body. */
export interface IssueRef {
  /** `owner/name` when the text names a repo; null means the repo of the issue it was written in. */
  readonly repo: string | null;
  readonly number: number;
}

const isRepoChar = (char: string): boolean => /^[A-Za-z0-9._-]$/.test(char);
const isDigit = (char: string): boolean => char >= "0" && char <= "9";
const isDots = (segment: string): boolean => /^\.+$/.test(segment);

/** The lines of a text as Rust's `lines()` gives them: split on `\n`, one `\r` before it dropped. */
const textLines = (text: string): Array<string> => {
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
};

/** A markdown heading: `#`s then a space, a tab or the end of the line. `#13` is a reference. */
const isHeading = (line: string): boolean => {
  const rest = line.replace(/^#+/, "");
  return rest.length < line.length && (rest === "" || rest[0] === " " || rest[0] === "\t");
};

/**
 * The lines of the issue body's `## <name>` section (`name` in lower case): after its heading, up
 * to the next heading line. Empty when the body has no such section.
 */
export const sectionLines = (body: string, name: string): Array<string> => {
  const lines: Array<string> = [];
  let inSection = false;
  for (const line of textLines(body)) {
    if (inSection) {
      if (isHeading(line)) break;
      lines.push(line);
    } else {
      inSection =
        line.startsWith("## ") || line.startsWith("##\t")
          ? line.slice(3).trim().toLowerCase() === name
          : false;
    }
  }
  return lines;
};

/**
 * The issues named in the `## Depends on` section of an issue body, in order of first
 * appearance, each once. The section runs from its heading to the next heading line. It names
 * `#<n>` and `<owner>/<repo>#<n>`; "None", an empty section and no section name nothing.
 */
export const dependsOn = (body: string): Array<IssueRef> => {
  const found: Array<IssueRef> = [];
  for (const line of sectionLines(body, "depends on")) {
    for (let at = 0; at < line.length; at++) {
      if (line[at] !== "#") continue;
      let end = at + 1;
      while (end < line.length && isDigit(line[end]!)) end++;
      const number = Number(line.slice(at + 1, end));
      if (end === at + 1 || !Number.isSafeInteger(number)) continue;
      let repoStart = at;
      while (repoStart > 0 && isRepoChar(line[repoStart - 1]!)) repoStart--;
      let repo: string | null = null;
      if (repoStart < at && repoStart > 0 && line[repoStart - 1] === "/") {
        let ownerStart = repoStart - 1;
        while (ownerStart > 0 && isRepoChar(line[ownerStart - 1]!)) ownerStart--;
        if (ownerStart === repoStart - 1) continue;
        const owner = line.slice(ownerStart, repoStart - 1);
        const name = line.slice(repoStart, at);
        // `.` and `..` would step out of `repos/<owner>/<name>` in the API path: not a repo.
        if (isDots(owner) || isDots(name)) continue;
        repo = `${owner}/${name}`;
      } else if (repoStart < at) {
        // Word characters run straight into the `#`, as in `page#12`: not an issue.
        continue;
      }
      if (!found.some((issue) => issue.repo === repo && issue.number === number)) {
        found.push({ repo, number });
      }
    }
  }
  return found;
};
