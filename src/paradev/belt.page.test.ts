// @effect-diagnostics nodeBuiltinImport:off - Reads the page beside this file.
import * as NodeFS from "node:fs";

import { Window } from "happy-dom";
import { afterEach, describe, expect, it } from "vitest";

import type { BeltV1 } from "../belt.ts";
import { BELT_HTML } from "./belt.ts";
import { readFixture } from "./fake-superset.ts";

const HTML = NodeFS.readFileSync(BELT_HTML, "utf8");

/** The belt the spike wrote to a page's shared storage. */
const fixtureBelt = (): BeltV1 => {
  const argv = readFixture("pages-storage-set-belt").argv;
  return JSON.parse(argv[argv.indexOf("--set") + 1]!) as BeltV1;
};

type Listener = (...args: Array<unknown>) => void;

interface Stub {
  value: unknown;
  readonly gets: Array<{ key: string; options: unknown }>;
  readonly subscriptions: Array<{ key: string; listener: Listener; options: unknown }>;
}

let open: Array<Window> = [];

afterEach(async () => {
  for (const window of open) await window.happyDOM.close();
  open = [];
});

/** The page in a happy-dom window whose `window.superset.storage` serves `stub.value`. */
const render = async (stub: Stub) => {
  const window = new Window({
    url: "https://app.superset.sh/page/factory-belt",
    settings: { enableJavaScriptEvaluation: true, suppressInsecureJavaScriptEnvironmentWarning: true },
  });
  open.push(window);
  const requests: Array<string> = [];
  // Any outside fetch the page makes would show up here.
  (window as unknown as { fetch: (url: unknown) => never }).fetch = (url) => {
    requests.push(String(url));
    throw new Error("no fetch on a Paradev page");
  };
  (window as unknown as { superset: unknown }).superset = {
    storage: {
      get: async (key: string, options: unknown) => {
        stub.gets.push({ key, options });
        return stub.value;
      },
      subscribe: (key: string, listener: Listener, options: unknown) => {
        stub.subscriptions.push({ key, listener, options });
        return () => {};
      },
    },
  };
  window.document.write(HTML);
  await window.happyDOM.waitUntilComplete();
  return { window, requests, text: () => window.document.body.textContent ?? "" };
};

const settle = async (window: Window) => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await window.happyDOM.waitUntilComplete();
};

const newStub = (value: unknown): Stub => ({ value, gets: [], subscriptions: [] });

describe("belt.html", () => {
  it("makes no outside fetches", () => {
    expect(HTML).not.toMatch(/\bfetch\s*\(/);
    expect(HTML).not.toMatch(/XMLHttpRequest|EventSource|WebSocket|sendBeacon|@import/);
    expect(HTML).not.toMatch(/<(link|img|iframe)\b/i);
    expect(HTML).not.toMatch(/<script[^>]*\bsrc=/i);
    expect(HTML).not.toMatch(/url\(/);
  });

  it("reads the belt once from shared storage and shows each run's title", async () => {
    const belt = fixtureBelt();
    const stub = newStub(belt);
    const page = await render(stub);
    await settle(page.window);
    expect(stub.gets).toEqual([{ key: "belt", options: { scope: "shared" } }]);
    expect(stub.subscriptions.map(({ key, options }) => ({ key, options }))).toEqual([
      { key: "belt", options: { scope: "shared" } },
    ]);
    const text = page.text();
    for (const run of belt.runs) expect(text).toContain(run.title ?? "");
    expect(text).toContain(belt.runner.host);
    expect(page.requests).toEqual([]);
  });

  it("shows a new payload pushed through the subscription", async () => {
    const belt = fixtureBelt();
    const stub = newStub(belt);
    const page = await render(stub);
    await settle(page.window);
    const pushed: BeltV1 = {
      ...belt,
      runs: [{ ...belt.runs[0]!, title: "feat: a run that only the push carries" }],
    };
    stub.subscriptions[0]!.listener(pushed);
    await settle(page.window);
    expect(page.text()).toContain("feat: a run that only the push carries");
    expect(page.text()).not.toContain(belt.runs[1]!.title ?? "");
  });

  it("reads storage again when the subscription says only that the value changed", async () => {
    const belt = fixtureBelt();
    const stub = newStub(belt);
    const page = await render(stub);
    await settle(page.window);
    stub.value = { ...belt, runs: [{ ...belt.runs[0]!, title: "feat: read after the change" }] };
    stub.subscriptions[0]!.listener();
    await settle(page.window);
    expect(stub.gets.length).toBe(2);
    expect(page.text()).toContain("feat: read after the change");
  });

  it("escapes every text it shows, and links no URL but a GitHub one", async () => {
    const belt = fixtureBelt();
    const markup = (where: string) => `<img src=x data-in="${where}" onerror=alert(1)>`;
    const stub = newStub({
      ...belt,
      runner: { ...belt.runner, host: markup("host"), version: markup("version"), paradevCli: markup("cli") },
      runs: [
        {
          ...belt.runs[0]!,
          repo: markup("repo"),
          title: markup("title"),
          reason: markup("reason"),
          state: "stuck",
          step: markup("step"),
          finished: false,
          prUrl: "javascript:alert(1)",
        },
        { ...belt.runs[0]!, finished: false, prUrl: `https://github.com/a/b/pull/1"><img src=x data-in="pr">` },
      ],
      attention: [{ id: "x", kind: "attention", text: markup("attention"), since: belt.updatedAt }],
    });
    const page = await render(stub);
    await settle(page.window);
    for (const where of ["host", "version", "cli", "repo", "title", "reason", "step", "attention"]) {
      expect(page.text()).toContain(markup(where));
    }
    expect(page.window.document.querySelector("img")).toBeNull();
    expect(page.window.document.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(page.text()).toContain("javascript:alert(1)");
  });

  it("says so when no belt has been written yet", async () => {
    const page = await render(newStub(null));
    await settle(page.window);
    expect(page.text()).toContain("No belt yet");
  });
});
