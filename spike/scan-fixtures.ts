// Fails the gate when a recorded fixture holds something that looks like a
// secret or a personal email. Prints only path, line and pattern name, never
// the matched text, so the scan cannot leak what it finds into a log.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = "spike/fixtures";

const allowedEmail = /@(?:example\.com|users\.noreply\.github\.com)$/i;

const patterns: [name: string, test: (line: string) => boolean][] = [
  ["Stripe key", matches(/\bsk_(?:live|test)_[A-Za-z0-9]+/)],
  ["Anthropic key", matches(/\bsk-ant-[A-Za-z0-9_-]+/)],
  ["GitHub token", matches(/\b(?:gh[pousr]_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+)/)],
  ["Slack token", matches(/\bxox[a-z]*-[A-Za-z0-9-]+/)],
  ["Bearer token", matches(/\bBearer [A-Za-z0-9._~+/=-]{20,}/)],
  ["JWT", matches(/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/)],
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

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return files(path);
      return entry.isFile() ? [path] : [];
    });
}

let found = false;

if (existsSync(root)) {
  for (const file of files(root)) {
    readFileSync(file, "utf8")
      .split(/\r?\n/)
      .forEach((line, index) => {
        for (const [name, test] of patterns) {
          if (!test(line)) continue;
          console.log(`${file}:${index + 1}: ${name}`);
          found = true;
        }
      });
  }
}

process.exit(found ? 1 : 0);
