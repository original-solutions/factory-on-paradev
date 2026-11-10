#!/usr/bin/env node
// Stands in for Paradev's `superset` CLI in tests.
// FAKE_STDOUT: text to print on stdout. FAKE_STDERR: text to print on stderr after the argv line.
// FAKE_EXIT: exit code. FAKE_DELAY_MS: how long to wait before answering.
// FAKE_MARKER: a file it creates when it runs.
// Always echoes its argv to stderr as JSON on the first line.
import { writeFileSync } from "node:fs";

const env = process.env;
if (env.FAKE_MARKER) writeFileSync(env.FAKE_MARKER, "");

setTimeout(() => {
  process.stderr.write(`argv=${JSON.stringify(process.argv.slice(2))}\n`);
  if (env.FAKE_STDERR) process.stderr.write(env.FAKE_STDERR);
  if (env.FAKE_STDOUT) process.stdout.write(env.FAKE_STDOUT);
  process.exitCode = Number(env.FAKE_EXIT ?? 0);
}, Number(env.FAKE_DELAY_MS ?? 0));
