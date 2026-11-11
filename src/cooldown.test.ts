/**
 * A provider's rate limit as a session's last message says it, and the backoff the pass keeps per
 * model while one lasts.
 */
import { assert, it } from "@effect/vitest";
import { describe } from "vitest";

import {
  COOLDOWN_CAP_MS,
  COOLDOWN_QUIET_MS,
  RETRY_AFTER_CAP_MS,
  coolingDown,
  cooldownKey,
  forgetQuietCooldowns,
  launchModel,
  rateLimitOf,
  recordRateLimit,
  type Cooldown,
} from "./cooldown.ts";

const MINUTE = 60_000;
const FABLE_MODEL = { instanceId: "claudeAgent", model: "claude-fable-5-1" };
const T0 = 1_791_380_000_000;

/** What Claude Code ended the sessions of the Trilogy Mac with. */
const CLAUDE_COOLDOWN =
  "API Error: Request rejected (429) · All credentials for model claude-fable-5-1 are cooling down (last error: rate_limit_error: This request would exceed your account's rate limit. Please try again later.)";

describe("rateLimitOf", () => {
  it("reads a 429, a rate_limit_error and a credential cooldown as a rate limit", () => {
    for (const text of [
      CLAUDE_COOLDOWN,
      'API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}',
      "API Error: upstream answered HTTP 429",
      "Error: status 429 Too Many Requests",
      "API Error: rate_limit_error",
      "All credentials for model gpt-5.5 are cooling down",
      // The session wrote first; the provider's error is its last line.
      `Working on the runner.\n\n${CLAUDE_COOLDOWN}\n`,
    ]) {
      assert.deepStrictEqual(rateLimitOf(text), { retryAfterMs: null }, text);
    }
  });

  it("does not read other failures, or a 429 that is only a number, as a rate limit", () => {
    for (const text of [
      null,
      "",
      "it crashed",
      "Working on #429 now",
      "Fixed the 429 handling in the factory, pushed the branch",
      "the build cooled down after the tests",
      // The session's own words, about rate limits, are not the provider's error.
      "I added handling so the client backs off on HTTP 429 and honours Retry-After: 86400",
      "The adapter maps rate_limit_error to (429).",
      "Error handling now covers status 429.",
      "API Error: 429\n\nI carried on after it and finished the step.",
    ]) {
      assert.strictEqual(rateLimitOf(text), null, String(text));
    }
  });

  it("takes the provider's retry-after, in seconds unless it names a unit", () => {
    assert.deepStrictEqual(rateLimitOf("API Error: HTTP 429, retry-after: 120"), {
      retryAfterMs: 120_000,
    });
    assert.deepStrictEqual(rateLimitOf("API Error: rate_limit_error: retry after 3 minutes"), {
      retryAfterMs: 3 * MINUTE,
    });
    assert.deepStrictEqual(rateLimitOf("API Error: rate_limit_error: please try again in 45s"), {
      retryAfterMs: 45_000,
    });
    assert.deepStrictEqual(rateLimitOf("API Error: 429, retry after 500ms"), { retryAfterMs: 500 });
  });

  it("takes a long retry-after as given, and bounds one past a day", () => {
    assert.deepStrictEqual(rateLimitOf("API Error: 429, retry after 2h"), {
      retryAfterMs: 2 * 60 * MINUTE,
    });
    assert.deepStrictEqual(rateLimitOf(`API Error: 429, retry after ${"9".repeat(400)}`), {
      retryAfterMs: RETRY_AFTER_CAP_MS,
    });
  });

  it("reads the retry-after only from the error line", () => {
    assert.deepStrictEqual(
      rateLimitOf("Retry-After: 86400 is what upstream says.\nAPI Error: 429"),
      {
        retryAfterMs: null,
      },
    );
  });
});

describe("recordRateLimit", () => {
  it("backs off exponentially, from 5 minutes up to the cap", () => {
    const cooldowns = new Map<string, Cooldown>();
    let now = T0;
    const lengths: Array<number> = [];
    for (let i = 0; i < 7; i++) {
      // Each session that was resumed after the window ran into the limit again.
      recordRateLimit(cooldowns, "claudeAgent claude-fable-5-1", FABLE_MODEL, now, now, null);
      const cooldown = cooldowns.get("claudeAgent claude-fable-5-1")!;
      lengths.push(cooldown.untilMs - now);
      assert.strictEqual(cooldown.windows, i + 1);
      now = cooldown.untilMs + MINUTE;
    }
    assert.deepStrictEqual(
      lengths.map((ms) => ms / MINUTE),
      [5, 10, 20, 40, 60, 60, 60],
    );
    assert.strictEqual(COOLDOWN_CAP_MS, 60 * MINUTE);
  });

  it("does not move the window for a session that ended before it was over", () => {
    const cooldowns = new Map<string, Cooldown>();
    recordRateLimit(cooldowns, "k", null, T0, T0, null);
    const first = cooldowns.get("k")!;
    // Nine more sessions of the same burst, read in the same pass and the next.
    for (let i = 1; i < 10; i++) recordRateLimit(cooldowns, "k", null, T0 + i, T0 + MINUTE, null);
    assert.deepStrictEqual(cooldowns.get("k"), first);
  });

  it("opens the next window for a session that ended as the window did", () => {
    const cooldowns = new Map<string, Cooldown>();
    recordRateLimit(cooldowns, "k", null, T0, T0, null);
    const until = cooldowns.get("k")!.untilMs;
    recordRateLimit(cooldowns, "k", null, until, until, null);
    assert.strictEqual(cooldowns.get("k")!.windows, 2);
  });

  it("uses the provider's retry-after for the window when it gives one", () => {
    const cooldowns = new Map<string, Cooldown>();
    recordRateLimit(cooldowns, "k", null, T0, T0, 90 * MINUTE);
    assert.strictEqual(cooldowns.get("k")!.untilMs, T0 + 90 * MINUTE);
  });

  it("still backs off when the provider keeps asking for a short wait", () => {
    const cooldowns = new Map<string, Cooldown>();
    let now = T0;
    const lengths: Array<number> = [];
    for (let i = 0; i < 4; i++) {
      recordRateLimit(cooldowns, "k", null, now, now, 5_000);
      const cooldown = cooldowns.get("k")!;
      lengths.push(cooldown.untilMs - now);
      now = cooldown.untilMs;
    }
    assert.deepStrictEqual(
      lengths.map((ms) => ms / MINUTE),
      [5, 10, 20, 40],
    );
  });

  it("keeps each model's window apart", () => {
    const cooldowns = new Map<string, Cooldown>();
    recordRateLimit(cooldowns, "a", null, T0, T0, null);
    assert.isNotNull(coolingDown(cooldowns, "a", T0 + MINUTE));
    assert.isNull(coolingDown(cooldowns, "b", T0 + MINUTE));
  });
});

describe("recordRateLimit after a quiet spell", () => {
  it("starts a new streak for a hit that comes once the model has gone quiet", () => {
    const cooldowns = new Map<string, Cooldown>();
    let now = T0;
    for (let i = 0; i < 3; i++) {
      recordRateLimit(cooldowns, "k", null, now, now, null);
      now = cooldowns.get("k")!.untilMs;
    }
    const streak = cooldowns.get("k")!;
    streak.raised = true;
    const quiet = streak.untilMs + COOLDOWN_QUIET_MS;
    // Seen before any pass forgot the model: still a first window, with no item behind it.
    recordRateLimit(cooldowns, "k", null, quiet, quiet, null);
    assert.deepStrictEqual(cooldowns.get("k"), {
      model: null,
      untilMs: quiet + 5 * MINUTE,
      windows: 1,
      raised: false,
    });
  });

  it("goes by when the session ended: one of the old burst seen late, or a hit inside the quiet time, keeps the streak", () => {
    const cooldowns = new Map<string, Cooldown>();
    recordRateLimit(cooldowns, "k", null, T0, T0, null);
    const until = cooldowns.get("k")!.untilMs;
    const late = until + COOLDOWN_QUIET_MS;
    recordRateLimit(cooldowns, "k", null, until - 1, late, null);
    assert.deepStrictEqual(cooldowns.get("k"), {
      model: null,
      untilMs: until,
      windows: 1,
      raised: false,
    });
    recordRateLimit(cooldowns, "k", null, late - 1, late, null);
    assert.strictEqual(cooldowns.get("k")!.windows, 2);
  });
});

describe("coolingDown and forgetQuietCooldowns", () => {
  it("is cooling only until the window ends", () => {
    const cooldowns = new Map<string, Cooldown>();
    recordRateLimit(cooldowns, "k", null, T0, T0, null);
    assert.isNotNull(coolingDown(cooldowns, "k", T0 + 5 * MINUTE - 1));
    assert.isNull(coolingDown(cooldowns, "k", T0 + 5 * MINUTE));
  });

  it("forgets a model once it has been quiet past its window, so the next limit starts over", () => {
    const cooldowns = new Map<string, Cooldown>();
    recordRateLimit(cooldowns, "k", null, T0, T0, null);
    const until = cooldowns.get("k")!.untilMs;
    assert.deepStrictEqual(forgetQuietCooldowns(cooldowns, until + COOLDOWN_QUIET_MS - 1), []);
    assert.deepStrictEqual(forgetQuietCooldowns(cooldowns, until + COOLDOWN_QUIET_MS), ["k"]);
    assert.strictEqual(cooldowns.size, 0);
    const later = until + COOLDOWN_QUIET_MS + MINUTE;
    recordRateLimit(cooldowns, "k", null, later, later, null);
    assert.strictEqual(cooldowns.get("k")!.windows, 1);
  });
});

describe("launchModel", () => {
  const FABLE = {
    instanceId: "claudeAgent",
    model: "claude-fable-5-1",
    options: [{ id: "effort", value: "high" }],
  };
  const FALLBACKS = { "claude-fable-5-1": "claude-opus-5-5" };
  const OPUS = { ...FABLE, model: "claude-opus-5-5" };

  it("names a model by its provider instance and id", () => {
    assert.strictEqual(cooldownKey(FABLE), "claudeAgent claude-fable-5-1");
  });

  it("is the model itself while it does not cool down", () => {
    assert.deepStrictEqual(launchModel(new Map(), FALLBACKS, FABLE, T0), FABLE);
  });

  it("is the fallback on the same instance, with the same options, while the model cools down", () => {
    const cooldowns = new Map<string, Cooldown>();
    recordRateLimit(cooldowns, cooldownKey(FABLE), FABLE, T0, T0, null);
    assert.deepStrictEqual(launchModel(cooldowns, FALLBACKS, FABLE, T0 + MINUTE), OPUS);
    // Back to the model once its window is over.
    assert.deepStrictEqual(launchModel(cooldowns, FALLBACKS, FABLE, T0 + 5 * MINUTE), FABLE);
  });

  it("is none while the model cools down with no fallback, or a fallback that cools down too", () => {
    const cooldowns = new Map<string, Cooldown>();
    recordRateLimit(cooldowns, cooldownKey(FABLE), FABLE, T0, T0, null);
    assert.isNull(launchModel(cooldowns, {}, FABLE, T0 + MINUTE));
    recordRateLimit(cooldowns, cooldownKey(OPUS), OPUS, T0, T0, null);
    assert.isNull(launchModel(cooldowns, FALLBACKS, FABLE, T0 + MINUTE));
  });
});
