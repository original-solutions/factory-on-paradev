import { assert, it } from "@effect/vitest";

import { dependsOn, type IssueRef } from "./dependsOn.ts";

const same = (number: number): IssueRef => ({ repo: null, number });
const cross = (repo: string, number: number): IssueRef => ({ repo, number });

it("depends on reads same repo references", () => {
  const body = "Intro\n\n## Depends on\n\n- #13\n- #15 until it lands\n";
  assert.deepStrictEqual(dependsOn(body), [same(13), same(15)]);
});

it("depends on reads cross repo references", () => {
  const body = "## Depends on\nacme/widgets#7, my-org/some.repo_x#42\n";
  assert.deepStrictEqual(dependsOn(body), [
    cross("acme/widgets", 7),
    cross("my-org/some.repo_x", 42),
  ]);
});

it("depends on reads both kinds in order and once", () => {
  const body = "## Depends on\n#3 and acme/widgets#7 and #3 again, #9\n";
  assert.deepStrictEqual(dependsOn(body), [same(3), cross("acme/widgets", 7), same(9)]);
});

it("depends on does not count the number of a cross repo reference twice", () => {
  assert.deepStrictEqual(dependsOn("## Depends on\nacme/widgets#7\n"), [cross("acme/widgets", 7)]);
});

it("depends on none or empty or missing names nothing", () => {
  assert.deepStrictEqual(dependsOn("## Depends on\n\nNone\n"), []);
  assert.deepStrictEqual(dependsOn("## Depends on\nnone.\n## Next\n#4\n"), []);
  assert.deepStrictEqual(dependsOn("## Depends on\n"), []);
  assert.deepStrictEqual(dependsOn("## Depends on\n\n## Fix\n#4\n"), []);
  assert.deepStrictEqual(dependsOn("## Cause\nSee #4\n"), []);
  assert.deepStrictEqual(dependsOn(""), []);
});

it("depends on ignores text after the next heading", () => {
  const body = "## Depends on\n#13\n### Notes\n#99\n## Fix\nacme/widgets#98\n";
  assert.deepStrictEqual(dependsOn(body), [same(13)]);
});

it("depends on ignores references before the section", () => {
  assert.deepStrictEqual(dependsOn("## Cause\nSee #5\n\n## Depends on\n#13\n"), [same(13)]);
});

it("depends on heading is case insensitive and allows trailing spaces", () => {
  assert.deepStrictEqual(dependsOn("## depends ON  \r\n#13\r\n"), [same(13)]);
});

it("depends on needs digits after the hash", () => {
  assert.deepStrictEqual(dependsOn("## Depends on\n#abc # 4 #\n"), []);
});

it("depends on skips a hash that word characters run into", () => {
  assert.deepStrictEqual(dependsOn("## Depends on\nsee page#12 and /widgets#7, then #3\n"), [
    same(3),
  ]);
});

it("depends on ends at a heading line with nothing after the hashes", () => {
  assert.deepStrictEqual(dependsOn("## Depends on\n#3\n##\n#4\n"), [same(3)]);
});

it("depends on heading needs two hashes and a space", () => {
  assert.deepStrictEqual(dependsOn("##Depends on\n#3\n"), []);
  assert.deepStrictEqual(dependsOn("### Depends on\n#3\n"), []);
  assert.deepStrictEqual(dependsOn("# Depends on\n#3\n"), []);
});

it("depends on skips an owner or repo made only of dots, which would leave the API path", () => {
  assert.deepStrictEqual(
    dependsOn("## Depends on\n../..#3 ./widgets#4 acme/..#5 acme/.#6 ...//x#8\n"),
    [],
  );
  assert.deepStrictEqual(dependsOn("## Depends on\nacme/.github#7 a.b/c..d#9\n"), [
    cross("acme/.github", 7),
    cross("a.b/c..d", 9),
  ]);
});
