// @effect-diagnostics nodeBuiltinImport:off - the tests lay out real run files to list.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vitest";

import { InvalidRunIdError } from "./errors.ts";
import {
  issueRunPart,
  newRunId,
  nextAttempt,
  parseIssueKey,
  parseRunId,
  runIdFileName,
  runIdFromFileName,
  runIdToString,
  validateRunId,
  type RunId,
} from "./runId.ts";
import { catchLedgerError, useTempDirs } from "./testSupport.ts";

const tempDir = useTempDirs();

const runId = (repo: string, issue: string, attempt: number): RunId => ({ repo, issue, attempt });

const expectInvalid = (run: () => unknown, input: string) => {
  const error = catchLedgerError(run, InvalidRunIdError);
  expect(error._tag).toBe("InvalidRunIdError");
  expect(error.input).toBe(input);
};

describe("run id", () => {
  it("run id converts to and from its string", () => {
    const id = runId("rawphp/softfac", "8", 1);
    expect(runIdToString(id)).toBe("rawphp__softfac__8__1");
    expect(runIdFileName(id)).toBe("rawphp__softfac__8__1.jsonl");
    expect(parseRunId("rawphp__softfac__8__1")).toEqual(id);
    expect(newRunId("rawphp/softfac", "8", 1)).toEqual(id);
  });

  it("run id round trips dots, dashes and large numbers", () => {
    const id = runId("my-org/my.repo-2", "18446744073709551615", 4294967295);
    expect(runIdToString(id)).toBe("my-org__my.repo-2__18446744073709551615__4294967295");
    expect(parseRunId(runIdToString(id))).toEqual(id);
  });

  it("run id new rejects bad repos", () => {
    for (const repo of [
      "",
      "softfac",
      "rawphp/",
      "/softfac",
      "a/b/c",
      "a\\b/c",
      "a/b c",
      "a/b\\c",
      "a/b\0",
      "a/b\u001b",
      "a/bé",
      "a/b~",
      "a/b:c",
      "a/b*",
      "../x",
      "x/..",
      "./x",
      "../../etc/passwd",
      "a b/c",
      "_tom/x",
      "tom_/x",
      "to__m/x",
      "tom_tc_/x",
      "my.org/x",
      "a/.",
      "a/b\n",
      "a\0/b",
      "raé/b",
    ]) {
      expectInvalid(() => newRunId(repo, "1", 1), repo);
    }
  });

  it("run id new rejects a bad issue or attempt", () => {
    expectInvalid(() => newRunId("a/b", "08", 1), "08");
    expectInvalid(() => newRunId("a/b", "18446744073709551616", 1), "18446744073709551616");
    expect(catchLedgerError(() => newRunId("a/b", "1", 4294967296))._tag).toBe("InvalidRunIdError");
    expect(catchLedgerError(() => newRunId("a/b", "1", -1))._tag).toBe("InvalidRunIdError");
    expect(catchLedgerError(() => newRunId("a/b", "1", 1.5))._tag).toBe("InvalidRunIdError");
    expect(newRunId("a/b", "eng-42", 0)).toEqual(runId("a/b", "ENG-42", 0));
  });

  it("run id validate rejects a hand built bad id", () => {
    expectInvalid(() => validateRunId(runId("../x", "1", 1)), "../x");
    expect(() => validateRunId(runId("a/b", "1", 1))).not.toThrow();
    // A hand-built id must already be in the lowercase form `newRunId` produces.
    expectInvalid(() => validateRunId(runId("Rawphp/softfac", "1", 1)), "Rawphp/softfac");
    // The issue and attempt end up in a file name too.
    expectInvalid(() => validateRunId(runId("a/b", "../x", 1)), "../x");
    expect(catchLedgerError(() => validateRunId(runId("a/b", "1", -1)))._tag).toBe(
      "InvalidRunIdError",
    );
  });

  it("run id round trips an owner with an interior underscore", () => {
    // GitHub Enterprise Managed User logins look like `handle_shortcode`.
    for (const [repo, file] of [
      ["tom_tc/softfac", "tom_tc__softfac__8__1.jsonl"],
      ["tom_tc/a__b", "tom_tc__a__b__8__1.jsonl"],
      ["a_b_c/_x_", "a_b_c___x___8__1.jsonl"],
    ] as const) {
      const id = newRunId(repo, "8", 1);
      expect(id.repo).toBe(repo);
      expect(runIdFileName(id)).toBe(file);
      expect(runIdFromFileName(file)).toEqual(id);
      expect(parseRunId(runIdToString(id))).toEqual(id);
    }
  });

  it("run ids for awkward owners and repos are distinct and parse back", () => {
    const combos: ReadonlyArray<readonly [string, string, string, number]> = [
      ["tom_tc", "softfac", "8", 1],
      ["tom_tc", "a__b", "8", 1],
      ["tom", "_x", "8", 1],
      ["tom", "x_", "8", 1],
      ["tom", "__", "8", 1],
      ["tom", "_", "8", 1],
      ["tom", "8__1", "8", 1],
      ["tom", "8", "1", 8],
      ["tom", "8__1", "1", 8],
      ["tom_8", "1__2", "3", 4],
      ["tom", "1__2", "3", 4],
      ["a_b_c", "d_e__f_", "12", 34],
      ["a", "b__c", "1", 1],
      ["a_b", "c", "1", 1],
      ["a-b", "c.d-e_f", "0", 0],
      ["x", "y", "18446744073709551615", 4294967295],
    ];
    const seen = new Set<string>();
    for (const [owner, name, issue, attempt] of combos) {
      const id = newRunId(`${owner}/${name}`, issue, attempt);
      const text = runIdToString(id);
      expect(parseRunId(text), text).toEqual(id);
      expect(runIdFromFileName(runIdFileName(id)), text).toEqual(id);
      expect(seen.has(text), `${text} is not distinct`).toBe(false);
      seen.add(text);
    }
    expect(seen.size).toBe(combos.length);
  });

  it("run id round trips underscores in the repo name", () => {
    for (const [repo, file] of [
      ["rawphp/my_app", "rawphp__my_app__8__1.jsonl"],
      ["rawphp/_private", "rawphp___private__8__1.jsonl"],
      ["rawphp/trailing_", "rawphp__trailing___8__1.jsonl"],
      ["rawphp/a__b", "rawphp__a__b__8__1.jsonl"],
      ["rawphp/a__8", "rawphp__a__8__8__1.jsonl"],
      ["rawphp/__", "rawphp______8__1.jsonl"],
      ["rawphp/softfac__8__1", "rawphp__softfac__8__1__8__1.jsonl"],
    ] as const) {
      const id = newRunId(repo, "8", 1);
      expect(id.repo).toBe(repo);
      expect(runIdFileName(id), repo).toBe(file);
      expect(runIdFromFileName(file), repo).toEqual(id);
      expect(parseRunId(runIdToString(id)), repo).toEqual(id);
    }
  });

  it("run id lowercases so one repo is one id and one file", () => {
    const mixed = newRunId("Rawphp/SoftFac", "8", 1);
    const lower = newRunId("rawphp/softfac", "8", 1);
    expect(mixed).toEqual(lower);
    expect(mixed.repo).toBe("rawphp/softfac");
    expect(runIdFileName(mixed)).toBe("rawphp__softfac__8__1.jsonl");
    expect(parseRunId("Rawphp__SoftFac__8__1")).toEqual(lower);
    expect(runIdFileName(newRunId("Rawphp/My__App", "8", 1))).toBe("rawphp__my__app__8__1.jsonl");
    expect(parseRunId("RAWPHP__My__App__8__1")).toEqual(newRunId("rawphp/my__app", "8", 1));
  });

  it("run id lowercases ASCII only, so a lookalike capital is not folded into a legal name", () => {
    // U+212A KELVIN SIGN lowercases to an ASCII `k` under Unicode rules.
    expectInvalid(() => newRunId("Kelvin/x", "1", 1), "Kelvin/x");
  });

  it("run id from file name ignores names that are not the canonical file name", () => {
    expect(runIdFromFileName("Rawphp__SoftFac__8__1.jsonl")).toBeNull();
    expect(runIdFromFileName("rawphp__softfac__8__1.JSONL")).toBeNull();
  });

  it("a linear run id round trips and an old numeric one still parses", () => {
    const id = newRunId("Acme/Widgets", "ENG-42", 1);
    expect(runIdToString(id)).toBe("acme__widgets__eng-42__1");
    expect(parseRunId("acme__widgets__eng-42__1")).toEqual(id);
    expect(parseRunId("rawphp__softfac__8__1").issue).toBe("8");
  });

  it("a run file with a capital in the issue part is not one of ours", () => {
    expect(runIdFromFileName("acme__widgets__ENG-42__1.jsonl")).toBeNull();
    expect(runIdFromFileName("acme__widgets__Eng-42__1.jsonl")).toBeNull();
    // The same guard when the id comes from the command line, not a file name.
    expect(() => parseRunId("acme__widgets__ENG-42__1")).toThrow();
    expect(() => parseRunId("acme__widgets__Eng-42__1")).toThrow();
    expect(() => parseRunId("acme__widgets__eng-42__1")).not.toThrow();
  });

  it("run id parse rejects anything else", () => {
    for (const input of [
      "",
      "rawphp__softfac__8",
      "_tom__x__8__1",
      "tom___x__8",
      "my.org__softfac__8__1",
      "rawphp__softfac__8__1__x",
      "rawphp__soft__fac__8",
      "rawphp__.__8__1",
      "rawphp____8",
      "rawphp__softfac__x__1",
      "rawphp__softfac__8__y",
      "rawphp__softfac__8__1x",
      "rawphp__softfac__+8__1",
      "rawphp__softfac__-8__1",
      "rawphp__softfac__08__1",
      "rawphp__softfac__8__01",
      "rawphp__softfac__8__",
      "rawphp__softfac____1",
      "__softfac__8__1",
      "rawphp____8__1",
      "..__softfac__8__1",
      "rawphp__..__8__1",
      "rawphp/softfac__8__1",
      "rawphp__softfac__8__1.jsonl",
      "rawphp__softfac__8__1 ",
      "rawphp__softfac__8__1\n",
      "rawphp__softfac__99999999999999999999__1",
      "rawphp__softfac__8__4294967296",
      "../../etc/passwd",
      "/etc/passwd",
      "..\\..\\x__y__1__1",
      "rawphp__b c__8__1",
      "rawphp__b\\c__8__1",
      "rawphp__b\0__8__1",
      "rawphp__b\u001b__8__1",
      "rawphp__bé__8__1",
      "rawphp__b~__8__1",
      "rawphp__b:c__8__1",
      "rawphp__b*__8__1",
    ]) {
      expectInvalid(() => parseRunId(input), input);
    }
  });

  it("run id from file name needs the jsonl extension", () => {
    expect(runIdFromFileName("rawphp__softfac__8__1.jsonl")).toEqual(
      runId("rawphp/softfac", "8", 1),
    );
    expect(runIdFromFileName("rawphp__softfac__8__1")).toBeNull();
    expect(runIdFromFileName("rawphp__softfac__8__1.txt")).toBeNull();
    expect(runIdFromFileName("notes.jsonl")).toBeNull();
    expect(runIdFromFileName(".jsonl")).toBeNull();
  });

  it("invalid run id error names the input and the reason", () => {
    const error = catchLedgerError(() => parseRunId("nope"));
    expect(error.message).toBe(
      "invalid run id `nope`: expected <owner>__<repo>__<issue>__<attempt>",
    );
  });
});

describe("issue key", () => {
  it("a github number parses and prints as itself", () => {
    expect(parseIssueKey("8")).toBe("8");
    expect(issueRunPart("8")).toBe("8");
    expect(parseIssueKey("0")).toBe("0");
    expect(parseIssueKey("18446744073709551615")).toBe("18446744073709551615");
  });

  it("a linear identifier is kept in capitals and lowercased only for the run id", () => {
    for (const input of ["ENG-42", "eng-42", "Eng-42"]) {
      expect(parseIssueKey(input), input).toBe("ENG-42");
    }
    expect(issueRunPart("ENG-42")).toBe("eng-42");
  });

  it("what is neither a number nor an identifier is refused", () => {
    for (const input of [
      "",
      "08",
      "+8",
      "-1",
      "ENG",
      "ENG-",
      "ENG-08",
      "a__b-1",
      "ENG/1",
      "ENG-1-2",
      "8 ",
      "8\n",
      // A team key starts with a letter.
      "8-1",
      "1A-2",
      // One past the largest number.
      "18446744073709551616",
      "ENG-18446744073709551616",
    ]) {
      expectInvalid(() => parseIssueKey(input), input);
    }
  });
});

describe("next attempt", () => {
  it("next attempt is one when there are no runs", () => {
    expect(nextAttempt(tempDir(), "rawphp/softfac", "8")).toBe(1);
  });

  it("next attempt is one past the highest for that repo and issue", () => {
    const dataDir = tempDir();
    const runs = NodePath.join(dataDir, "runs");
    NodeFS.mkdirSync(runs);
    for (const name of [
      "rawphp__softfac__8__1.jsonl",
      "rawphp__softfac__8__2.jsonl",
      "rawphp__softfac__8__4.jsonl",
      "rawphp__softfac__9__7.jsonl",
      "rawphp__my_app__8__3.jsonl",
      "rawphp__my__app__8__6.jsonl",
      "rawphp__other__8__9.jsonl",
      "someone__softfac__8__9.jsonl",
      "notes.txt",
      "rawphp__softfac__8__x.jsonl",
    ]) {
      NodeFS.writeFileSync(NodePath.join(runs, name), "");
    }
    expect(nextAttempt(dataDir, "rawphp/softfac", "8")).toBe(5);
    expect(nextAttempt(dataDir, "rawphp/softfac", "9")).toBe(8);
    expect(nextAttempt(dataDir, "rawphp/softfac", "10")).toBe(1);
    expect(nextAttempt(dataDir, "rawphp/other", "8")).toBe(10);
    expect(nextAttempt(dataDir, "rawphp/my_app", "8")).toBe(4);
    expect(nextAttempt(dataDir, "Rawphp/My__App", "8")).toBe(7);
    expect(nextAttempt(dataDir, "RAWPHP/SoftFac", "8")).toBe(5);
    expect(nextAttempt(dataDir, "../x", "8")).toBe(1);
  });

  it("next attempt matches a linear identifier in any case and never passes the largest attempt", () => {
    const dataDir = tempDir();
    const runs = NodePath.join(dataDir, "runs");
    NodeFS.mkdirSync(runs);
    NodeFS.writeFileSync(NodePath.join(runs, "acme__widgets__eng-42__3.jsonl"), "");
    NodeFS.writeFileSync(NodePath.join(runs, "acme__widgets__8__4294967295.jsonl"), "");
    expect(nextAttempt(dataDir, "acme/widgets", "eng-42")).toBe(4);
    expect(nextAttempt(dataDir, "acme/widgets", "ENG-42")).toBe(4);
    expect(nextAttempt(dataDir, "acme/widgets", "8")).toBe(4294967295);
  });
});
