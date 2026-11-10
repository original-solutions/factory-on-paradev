#!/usr/bin/env node
// Stands in for Paradev's `superset` CLI in tests.
// FAKE_STDOUT: text to print on stdout. FAKE_STDERR: text to print on stderr after the argv line.
// FAKE_EXIT: exit code. FAKE_DELAY_MS: how long to wait before answering.
// FAKE_MARKER: a file it creates when it runs.
// FAKE_SCRIPT: a JSON file that answers by command instead of the three above. Its keys are the
//   command, the first one or two words of argv ("schema", "workspaces create"). A value is one
//   answer, { stdout?, stderr?, exit? }, or a list of them used in turn, the last one repeating.
//   A list advances only with FAKE_LOG set, since the turn is counted from that log.
//   A stdout that is not a string is printed as JSON. A command with no key exits 1.
// FAKE_LOG: a file it appends its argv to, one JSON array per line.
// Always echoes its argv to stderr as JSON on the first line.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const env = process.env;
const argv = process.argv.slice(2);
if (env.FAKE_MARKER) writeFileSync(env.FAKE_MARKER, "");

const commandOf = (args) => (args[1] && !args[1].startsWith("-") ? `${args[0]} ${args[1]}` : String(args[0]));

function scripted() {
  const key = commandOf(argv);
  const answers = JSON.parse(readFileSync(env.FAKE_SCRIPT, "utf8"))[key];
  if (answers === undefined) return { stderr: `Error: fake: no answer for ${key}\n`, exit: 1 };
  const list = Array.isArray(answers) ? answers : [answers];
  const earlier =
    env.FAKE_LOG && existsSync(env.FAKE_LOG)
      ? readFileSync(env.FAKE_LOG, "utf8")
          .split("\n")
          .filter((line) => line !== "" && commandOf(JSON.parse(line)) === key).length
      : 0;
  const answer = list[Math.min(earlier, list.length - 1)];
  const stdout = answer.stdout === undefined || typeof answer.stdout === "string" ? answer.stdout : `${JSON.stringify(answer.stdout)}\n`;
  return { stdout, stderr: answer.stderr, exit: answer.exit ?? 0 };
}

setTimeout(() => {
  const answer = env.FAKE_SCRIPT
    ? scripted()
    : { stdout: env.FAKE_STDOUT, stderr: env.FAKE_STDERR, exit: Number(env.FAKE_EXIT ?? 0) };
  if (env.FAKE_LOG) appendFileSync(env.FAKE_LOG, `${JSON.stringify(argv)}\n`);
  process.stderr.write(`argv=${JSON.stringify(argv)}\n`);
  if (answer.stderr) process.stderr.write(answer.stderr);
  if (answer.stdout) process.stdout.write(answer.stdout);
  process.exitCode = answer.exit;
}, Number(env.FAKE_DELAY_MS ?? 0));
