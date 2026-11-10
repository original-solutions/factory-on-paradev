import { describe, expect, it } from "vitest";

import {
  MALFORMED_URL,
  NO_MESSAGE,
  NO_QUESTIONS,
  NO_RESULT_LINE,
  NOT_ON_REPO,
  SAID_STUCK,
  parseSessionResult,
  pullRequestUrl,
  splitLastLine,
  type SessionResult,
} from "./resultLine.ts";

const REPO = "rawphp/softfac";
const URL = "https://github.com/rawphp/softfac/pull/12";

const stuck = (reason: string, sessionText: string | undefined): SessionResult => ({
  kind: "stuck",
  reason,
  sessionText,
});

const done = (pr: number, prUrl: string): SessionResult => ({ kind: "done", pr, prUrl });

const parse = (message: string) => parseSessionResult(REPO, message);

describe("session result line", () => {
  it("no message or an empty one is stuck", () => {
    const reason = "the session ended without a final message";
    expect(NO_MESSAGE).toBe(reason);
    expect(parseSessionResult(REPO, undefined)).toEqual(stuck(reason, undefined));
    expect(parse("")).toEqual(stuck(reason, undefined));
    expect(parse("  \n\r\n\t\n")).toEqual(stuck(reason, undefined));
  });

  it("done with a pull request on this repo", () => {
    expect(parse(`Built it.\nFACTORY-DONE: ${URL}`)).toEqual(done(12, URL));
    expect(parse(`FACTORY-DONE: ${URL}`)).toEqual(done(12, URL));
  });

  it("done survives crlf, trailing blank lines and trailing whitespace", () => {
    const want = done(12, URL);
    expect(parse(`Built.\r\nFACTORY-DONE: ${URL}\r\n`)).toEqual(want);
    expect(parse(`Built.\nFACTORY-DONE: ${URL}\n\n\n`)).toEqual(want);
    expect(parse(`Built.\nFACTORY-DONE: ${URL}  \t\n \n`)).toEqual(want);
    expect(parse(`Built.\r\nFACTORY-DONE: ${URL}\r\n\r\n`)).toEqual(want);
  });

  it("done compares the repo case insensitively and keeps the url as given", () => {
    const url = "https://github.com/RawPHP/SoftFac/pull/7";
    expect(parse(`FACTORY-DONE: ${url}`)).toEqual(done(7, url));
    expect(parseSessionResult("RAWPHP/softfac", `FACTORY-DONE: ${URL}`)).toEqual(done(12, URL));
  });

  it("done for another repo is stuck with the message", () => {
    for (const url of [
      "https://github.com/rawphp/other/pull/12",
      "https://github.com/someone/softfac/pull/12",
      "https://github.com/rawphp/softfac2/pull/12",
      "https://github.com/rawphp/soft/pull/12",
    ]) {
      const message = `Done.\nFACTORY-DONE: ${url}`;
      expect(parse(message)).toEqual(stuck(NOT_ON_REPO, message));
    }
  });

  it("done with a malformed url is stuck with the message", () => {
    for (const url of [
      "https://github.com/rawphp/softfac/pull/12?x=1",
      "https://github.com/rawphp/softfac/pull/12#issuecomment-1",
      "https://github.com/rawphp/softfac/pull/12/files",
      "https://github.com/rawphp/softfac/pull/12/",
      "https://github.com/rawphp/softfac/pull/0",
      "https://github.com/rawphp/softfac/pull/abc",
      "https://github.com/rawphp/softfac/pull/",
      "https://github.com/rawphp/softfac/pull/-1",
      "https://github.com/rawphp/softfac/pull/+1",
      "https://github.com/rawphp/softfac/pull/99999999999999999999999",
      "https://github.com/rawphp/softfac/pull/007",
      "https://github.com/rawphp/softfac/pull/012",
      "https://github.com/rawphp/softfac/issues/12",
      "https://github.com/rawphp/softfac",
      "http://github.com/rawphp/softfac/pull/12",
      "https://gitlab.com/rawphp/softfac/pull/12",
      "https://github.com.evil.example/rawphp/softfac/pull/12",
      "https://evil.example/https://github.com/rawphp/softfac/pull/12",
      "https://user@github.com/rawphp/softfac/pull/12",
      "github.com/rawphp/softfac/pull/12",
      "#12",
    ]) {
      const message = `FACTORY-DONE: ${url}`;
      expect(parse(message), url).toEqual(stuck(MALFORMED_URL, message));
    }
  });

  it("done with text after the url or odd spacing is malformed", () => {
    let message = `FACTORY-DONE: ${URL} thanks`;
    expect(parse(message)).toEqual(stuck(MALFORMED_URL, message));
    message = `FACTORY-DONE:  ${URL}`;
    expect(parse(message)).toEqual(stuck(MALFORMED_URL, message));
    expect(parse("FACTORY-DONE:")).toEqual(stuck(NO_RESULT_LINE, "FACTORY-DONE:"));
  });

  it("a long bad url is never echoed in the reason", () => {
    const long = `https://github.com/rawphp/softfac/pull/${"9".repeat(500)}`;
    const junk = "x".repeat(500);
    for (const line of [`FACTORY-DONE: ${long}`, `FACTORY-DONE: ${junk}`]) {
      const result = parse(line);
      expect(result.kind).toBe("stuck");
      expect(result.kind === "stuck" ? result.reason : undefined).toBe(MALFORMED_URL);
    }
  });

  it("needs info carries everything before the marker", () => {
    expect(parse("1. Which database?\n2. Which user?\nFACTORY-STOP: needs-info")).toEqual({
      kind: "needs-info",
      questions: "1. Which database?\n2. Which user?",
    });
    expect(parse("\n  I have questions.\n\n1. Why?\n\nFACTORY-STOP: needs-info\n\n")).toEqual({
      kind: "needs-info",
      questions: "I have questions.\n\n1. Why?",
    });
    expect(parse("1. Why?\r\n2. Who?\r\nFACTORY-STOP: needs-info\r\n")).toEqual({
      kind: "needs-info",
      questions: "1. Why?\r\n2. Who?",
    });
  });

  it("needs info without questions is stuck", () => {
    const reason = "the session asked for information but gave no questions";
    expect(NO_QUESTIONS).toBe(reason);
    expect(parse("FACTORY-STOP: needs-info")).toEqual(stuck(reason, undefined));
    expect(parse("\n \nFACTORY-STOP: needs-info\n")).toEqual(stuck(reason, undefined));
  });

  it("stuck carries the message before the marker as session text", () => {
    const reason = "the session stopped and said it was stuck";
    expect(SAID_STUCK).toBe(reason);
    expect(parse("The tests cannot run here.\nFACTORY-STOP: stuck")).toEqual(
      stuck(reason, "The tests cannot run here."),
    );
    expect(parse("Line one.\n\nLine two.\n\nFACTORY-STOP: stuck\n\n")).toEqual(
      stuck(reason, "Line one.\n\nLine two."),
    );
  });

  it("stuck without a reason has no session text", () => {
    const reason = "the session stopped and said it was stuck";
    expect(parse("FACTORY-STOP: stuck")).toEqual(stuck(reason, undefined));
    expect(parse("  \nFACTORY-STOP: stuck\n")).toEqual(stuck(reason, undefined));
  });

  it("the marker must be the whole last non-empty line", () => {
    const doneThenText = `FACTORY-DONE: ${URL}\nthanks, bye`;
    for (const message of [
      "no marker at all",
      "FACTORY-STOP: stuck\nand then more words",
      doneThenText,
      "FACTORY-STOP: needs-info\nQ1?",
      "FACTORY-STOP: stuck now",
      "FACTORY-STOP: needs-info please",
      "FACTORY-STOP: needs-info.",
      "FACTORY-STOP: Stuck",
      "FACTORY-STOP:stuck",
      "factory-stop: stuck",
      "FACTORY-STOP: other",
      "note FACTORY-STOP: stuck",
      " FACTORY-STOP: stuck",
      "> FACTORY-STOP: stuck",
      "`FACTORY-STOP: stuck`",
      "FACTORY-STOP",
      `note FACTORY-DONE: ${URL}`,
      ` FACTORY-DONE: ${URL}`,
      `> FACTORY-DONE: ${URL}`,
    ]) {
      expect(parse(message), message).toEqual(stuck(NO_RESULT_LINE, message));
    }
  });
});

describe("result line helpers", () => {
  it("splitLastLine returns the text before the last non-empty line and that line", () => {
    expect(splitLastLine("")).toBeUndefined();
    expect(splitLastLine(" \r\n\t")).toBeUndefined();
    expect(splitLastLine("only")).toEqual({ before: "", last: "only" });
    expect(splitLastLine("a\n\nb  \n\n")).toEqual({ before: "a\n", last: "b" });
    expect(splitLastLine("a\r\nb\r\n")).toEqual({ before: "a\r", last: "b" });
    // Rust's White_Space set, not JS trim: U+0085 is stripped, U+FEFF is kept.
    expect(splitLastLine("a\nb\u0085")).toEqual({ before: "a", last: "b" });
    expect(splitLastLine("\u0085")).toBeUndefined();
    expect(splitLastLine("a\nb\uFEFF")).toEqual({ before: "a", last: "b\uFEFF" });
    expect(parseSessionResult(REPO, "FACTORY-STOP: stuck\u0085")).toEqual(
      stuck(SAID_STUCK, undefined),
    );
    expect(parseSessionResult(REPO, "FACTORY-STOP: stuck\uFEFF")).toEqual(
      stuck(NO_RESULT_LINE, "FACTORY-STOP: stuck\uFEFF"),
    );
  });

  it("a long whitespace run inside the message is trimmed in linear time", () => {
    // A backtracking `[...]+$` trim ran for over a minute on this input.
    const run = " ".repeat(200_000);
    expect(parse(`${run}x\nFACTORY-STOP: stuck`)).toEqual(stuck(SAID_STUCK, "x"));
    expect(splitLastLine(`a\nb${run}c${run}`)).toEqual({ before: "a", last: `b${run}c` });
  });

  it("pullRequestUrl compares the number as GitHub writes it", () => {
    expect(pullRequestUrl(URL)).toEqual({ owner: "rawphp", name: "softfac", pr: 12 });
    expect(pullRequestUrl("https://github.com/a.b/c_d-e/pull/1")).toEqual({
      owner: "a.b",
      name: "c_d-e",
      pr: 1,
    });
    expect(pullRequestUrl("https://github.com/rawphp/softfac/pull/007")).toBeUndefined();
    expect(pullRequestUrl("https://github.com/rawphp/softfac/pull/0")).toBeUndefined();
    // Past 2^53 a JS number loses digits, so the round trip rejects it. Rust accepts anything that
    // fits a u64; the divergence is deliberate and unreachable, no GitHub number gets that large.
    expect(
      pullRequestUrl("https://github.com/rawphp/softfac/pull/9007199254740993"),
    ).toBeUndefined();
    expect(
      pullRequestUrl("https://github.com/rawphp/softfac/pull/99999999999999999999999"),
    ).toBeUndefined();
    expect(pullRequestUrl("https://github.com//softfac/pull/1")).toBeUndefined();
  });

  it("only ascii case folding is used when comparing the repo", () => {
    // U+212A (Kelvin sign) lowercases to a plain k in JS, but is not an ascii case variant of it.
    expect(
      parseSessionResult("rawphp/Kr", "FACTORY-DONE: https://github.com/rawphp/kr/pull/1"),
    ).toEqual(stuck(NOT_ON_REPO, "FACTORY-DONE: https://github.com/rawphp/kr/pull/1"));
  });
});
