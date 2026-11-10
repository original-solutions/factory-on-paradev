// Fails the gate when a recorded fixture holds something that looks like a
// secret or a personal email. Prints only path, line and pattern name, never
// the matched text, so the scan cannot leak what it finds into a log.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = "spike/fixtures";

const allowedEmail = /@(?:example\.com|users\.noreply\.github\.com)$/i;

// No leading \b: recorded responses glue tokens to word characters (a JSON
// "\n" escape, a URL-encoded "%3D"), and a miss leaks a live token while a
// false positive costs one hand redaction. GitHub token bodies need 20
// characters so a key like "laughs_count" is not read as a ghs_ token.
const patterns: [name: string, test: (line: string) => boolean][] = [
  ["Stripe key", matches(/sk_(?:live|test)_[A-Za-z0-9]+/)],
  ["Anthropic key", matches(/sk-ant-[A-Za-z0-9_-]+/)],
  ["GitHub token", matches(/(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/)],
  ["Slack token", matches(/xox[a-z]*-[A-Za-z0-9-]+/)],
  ["Bearer token", matches(/bearer[ +][A-Za-z0-9._~+/=\\-]{20,}/i)],
  ["JWT", matches(/eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/)],
  [
    "email address",
    (line) =>
      (line.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? []).some(
        (email) => !allowedEmail.test(email),
      ),
  ],
];

function matches(pattern: RegExp): (line: string) => boolean {
  return (line) => pattern.test(line);
}

// Recorded URLs and JSON encode separators ("%40", "\u0040"), so each line is
// also tested with its %XX and \uXXXX escapes decoded.
function decode(line: string): string {
  return line
    .replace(/\\u([0-9A-Fa-f]{4})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/%([0-9A-Fa-f]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return files(path);
      return entry.isFile() ? [path] : [];
    });
}

// Files git refuses to commit (the .gitignore'd secrets* files) are skipped;
// one forced into the index is scanned. Outside a git repo, or without git,
// every file is scanned.
function ignored(paths: string[]): Set<string> {
  const run = spawnSync("git", ["check-ignore", "-z", "--stdin"], { input: paths.join("\0"), encoding: "utf8" });
  return new Set(run.status === 0 ? run.stdout.split("\0") : []);
}

let found = false;

if (existsSync(root)) {
  const all = files(root);
  const skip = ignored(all);
  for (const file of all.filter((path) => !skip.has(path))) {
    readFileSync(file, "utf8")
      .split(/\r?\n/)
      .forEach((line, index) => {
        const decoded = decode(line);
        for (const [name, test] of patterns) {
          if (!test(line) && !test(decoded)) continue;
          console.log(`${file}:${index + 1}: ${name}`);
          found = true;
        }
      });
  }
}

process.exit(found ? 1 : 0);
