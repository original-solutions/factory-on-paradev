import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, test } from "vitest";
import type { BeltV1 } from "../src/belt.ts";

// Runs the page's inline script against a fake window and DOM, so the probe's
// behaviour is checked without a browser.

const html = readFileSync(new URL("../spike/belt-probe/index.html", import.meta.url), "utf8");
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
const pageScript = scripts.map((m) => m[1]).join("\n");

const belt: BeltV1 = {
  v: 1,
  updatedAt: "2026-01-02T03:04:05.000Z",
  runner: {
    host: "demo-host",
    version: "0.0.0",
    paradevCli: "2.0.7",
    claimsPaused: false,
    paradevOnline: true,
    lastPassAt: "2026-01-02T03:04:00.000Z",
  },
  counts: { triage: 1, building: 2, prOpen: 3, needsInfo: 4, stuck: 5, finished7d: 6 },
  runs: [
    {
      id: "r1",
      repo: "acme/widgets",
      issue: 42,
      title: "Add <b>bold</b> & widgets",
      state: "building",
      step: "Make",
      reason: null,
      prUrl: null,
      startedTs: null,
      finished: false,
      totalMs: null,
      workspaceId: null,
    },
  ],
  attention: [],
};

type Storage = {
  get?: (key: string, opts: unknown) => unknown;
  subscribe?: (key: string, cb: (...args: unknown[]) => void, opts: unknown) => unknown;
};

function load(superset: { storage?: Storage } | undefined) {
  const elements = new Map<string, { innerHTML: string; textContent: string }>();
  const document = {
    getElementById(id: string) {
      let el = elements.get(id);
      if (!el) {
        el = { innerHTML: "", textContent: "" };
        elements.set(id, el);
      }
      return el;
    },
  };
  const intervals: Array<{ fn: () => void; ms: number }> = [];
  const window: Record<string, unknown> = {};
  if (superset) window.superset = superset;
  runInNewContext(pageScript, {
    window,
    document,
    setInterval: (fn: () => void, ms: number) => intervals.push({ fn, ms }),
    console: { error() {}, log() {} },
  });
  const text = () => [...elements.values()].map((e) => e.innerHTML + e.textContent).join("\n");
  return { text, intervals };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("renders the shared belt header and one row per run", async () => {
  const calls: unknown[][] = [];
  const page = load({
    storage: {
      get: async (...args) => {
        calls.push(args);
        return belt;
      },
      subscribe: () => {},
    },
  });
  await settle();
  expect(calls[0]).toEqual(["belt", { scope: "shared" }]);
  const out = page.text();
  expect(out).toContain("demo-host");
  expect(out).toContain("2026-01-02T03:04:05.000Z");
  for (const n of ["1", "2", "3", "4", "5", "6"]) expect(out).toContain(n);
  expect(out).toContain("acme/widgets#42");
  expect(out).toContain("building");
  expect(out).toContain("Make");
  // Titles are data, so they are escaped, never parsed as markup.
  expect(out).toContain("Add &lt;b&gt;bold&lt;/b&gt; &amp; widgets");
  expect(out).not.toContain("<b>bold</b>");
});

test("accepts the belt as a JSON string", async () => {
  const page = load({ storage: { get: async () => JSON.stringify(belt), subscribe: () => {} } });
  await settle();
  expect(page.text()).toContain("acme/widgets#42");
});

test("subscribes to the shared belt and re-renders on each change", async () => {
  let current: BeltV1 = belt;
  let onChange: (() => void) | undefined;
  let subscribeArgs: unknown[] = [];
  const page = load({
    storage: {
      get: async () => current,
      subscribe: (key, cb, opts) => {
        subscribeArgs = [key, opts];
        onChange = cb;
      },
    },
  });
  await settle();
  expect(subscribeArgs).toEqual(["belt", { scope: "shared" }]);
  expect(page.intervals).toHaveLength(0);

  current = { ...belt, runner: { ...belt.runner, host: "second-host" } };
  onChange?.();
  await settle();
  expect(page.text()).toContain("second-host");
});

test("says window.superset is not available when it is missing", async () => {
  const page = load(undefined);
  await settle();
  expect(page.text()).toContain("window.superset is not available");
  expect(page.intervals).toHaveLength(0);
});

test("says storage.get is not available when it is missing", async () => {
  const page = load({ storage: { subscribe: () => {} } });
  await settle();
  expect(page.text()).toContain("storage.get is not available");
  expect(page.intervals).toHaveLength(0);
});

test("says storage.subscribe is not available and polls get every 30 seconds", async () => {
  let current: BeltV1 = belt;
  const page = load({ storage: { get: async () => current } });
  await settle();
  const out = page.text();
  expect(out).toContain("storage.subscribe is not available");
  expect(out).toContain("acme/widgets#42");
  expect(page.intervals).toHaveLength(1);
  expect(page.intervals[0]!.ms).toBe(30_000);

  current = { ...belt, runner: { ...belt.runner, host: "polled-host" } };
  page.intervals[0]!.fn();
  await settle();
  expect(page.text()).toContain("polled-host");
});

test("names both calls when storage itself is missing", async () => {
  const page = load({});
  await settle();
  const out = page.text();
  expect(out).toContain("storage.get is not available");
  expect(out).toContain("storage.subscribe is not available");
});

test("shows the error in plain text when get fails", async () => {
  const page = load({
    storage: {
      get: async () => {
        throw new Error("value too large");
      },
      subscribe: () => {},
    },
  });
  await settle();
  expect(page.text()).toContain("value too large");
});

test("says so when the shared belt is empty", async () => {
  const page = load({ storage: { get: async () => null, subscribe: () => {} } });
  await settle();
  expect(page.text()).toContain("No belt");
});
