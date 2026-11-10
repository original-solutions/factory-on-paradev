/**
 * A provider's rate limit, as a session's last message says it, and the backoff the pass keeps per
 * model while one lasts. A rate limit is the provider's, not the issue's: the pass holds back the
 * claims that would run into it and resumes the session once it is over (`pass.ts`).
 */
import type { Model } from "./sessions.ts";

/** What a session that ended on a rate limit said about it. */
export interface RateLimit {
  /** How long the provider asked to wait, when it said; null for no word. */
  readonly retryAfterMs: number | null;
}

/** One model's rate limit: until when it cools down, and how many windows in a row it has hit. */
export interface Cooldown {
  /** Null for a session whose launch recorded no model: it has no fallback and holds no claim. */
  readonly model: Model | null;
  untilMs: number;
  windows: number;
  /** The streak's attention item was raised: it is raised once per streak. */
  raised: boolean;
}

/** The first window. Each window the model is hit again after the last one ended is twice as long. */
const COOLDOWN_FIRST_MS = 5 * 60_000;
/** The longest window the factory picks itself. */
export const COOLDOWN_CAP_MS = 60 * 60_000;
/** The longest retry-after taken from a provider: past it the number is not a wait anyone meant. */
export const RETRY_AFTER_CAP_MS = 24 * 60 * 60_000;
/** How long after its window a model that was not hit again starts over at the first window. */
export const COOLDOWN_QUIET_MS = 30 * 60_000;

/**
 * The provider's error is the last line of the session's message: Claude Code's `API Error: …`
 * naming a 429 or `rate_limit_error`, or the credential pool's `All credentials for model … are
 * cooling down`. Anywhere else the words are the session's own, about its work.
 */
const ERROR_LINE = /^(?:API )?Error:/i;
const RATE_LIMITED = /\b429\b|rate_limit_error/i;
const COOLING_DOWN = /credentials for model \S+ are cooling down/i;

/** `retry-after: 120`, `retry after 3 minutes`, `try again in 45s`; seconds unless a unit is named. */
const RETRY_AFTER =
  /(?:retry[- ]after:?|try again in)\s*(\d+)\s*(ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?|h|hours?)?\b/i;

const UNIT_MS: ReadonlyArray<readonly [RegExp, number]> = [
  [/^ms|^millisecond/i, 1],
  [/^h/i, 3_600_000],
  [/^m/i, 60_000],
];

/**
 * The rate limit the last line of `text` (a session's last message) reports, or null for none.
 * Its retry-after is read from that line too, and bounded by `RETRY_AFTER_CAP_MS`.
 */
export const rateLimitOf = (text: string | null): RateLimit | null => {
  const line = text
    ?.split("\n")
    .map((part) => part.trim())
    .findLast((part) => part !== "");
  if (line === undefined) return null;
  const limited = COOLING_DOWN.test(line) || (ERROR_LINE.test(line) && RATE_LIMITED.test(line));
  if (!limited) return null;
  const after = RETRY_AFTER.exec(line);
  if (after === null) return { retryAfterMs: null };
  const unit = after[2] ?? "s";
  const ms = UNIT_MS.find(([pattern]) => pattern.test(unit))?.[1] ?? 1000;
  return { retryAfterMs: Math.min(Number(after[1]) * ms, RETRY_AFTER_CAP_MS) };
};

/** How a model is named in the cooldowns, the pass's lines and its attention item. */
export const cooldownKey = (model: Model): string => `${model.instanceId} ${model.model}`;

/**
 * A session that ended (`endedMs`) inside the current window is part of its burst and changes nothing.
 * Otherwise a window opens from `nowMs`: 5 minutes doubling per window in a row up to `COOLDOWN_CAP_MS`,
 * or the retry-after when longer. One that ended after the model went quiet starts a new streak.
 */
export const recordRateLimit = (
  cooldowns: Map<string, Cooldown>,
  key: string,
  model: Model | null,
  endedMs: number,
  nowMs: number,
  retryAfterMs: number | null,
): void => {
  const known = cooldowns.get(key);
  const current =
    known !== undefined && endedMs >= known.untilMs + COOLDOWN_QUIET_MS ? undefined : known;
  if (current !== undefined && endedMs < current.untilMs) return;
  const windows = (current?.windows ?? 0) + 1;
  const backoff = Math.min(COOLDOWN_FIRST_MS * 2 ** (windows - 1), COOLDOWN_CAP_MS);
  const untilMs = nowMs + Math.max(retryAfterMs ?? 0, backoff);
  if (current === undefined) {
    cooldowns.set(key, { model, untilMs, windows, raised: false });
  } else {
    current.untilMs = untilMs;
    current.windows = windows;
  }
};

/** The model's cooldown while its window lasts; null once it is over or for none. */
export const coolingDown = (
  cooldowns: ReadonlyMap<string, Cooldown>,
  key: string,
  nowMs: number,
): Cooldown | null => {
  const cooldown = cooldowns.get(key);
  return cooldown !== undefined && nowMs < cooldown.untilMs ? cooldown : null;
};

/** Drops each model that has gone `COOLDOWN_QUIET_MS` past its window, and answers their keys. */
export const forgetQuietCooldowns = (
  cooldowns: Map<string, Cooldown>,
  nowMs: number,
): Array<string> => {
  const quiet = [...cooldowns]
    .filter(([, cooldown]) => nowMs >= cooldown.untilMs + COOLDOWN_QUIET_MS)
    .map(([key]) => key);
  for (const key of quiet) cooldowns.delete(key);
  return quiet;
};

/** `model` moved to the model id `to`, on the same provider instance with the same options. */
export const fallbackOf = (model: Model, to: string): Model => ({ ...model, model: to });

/**
 * The model a session started or resumed now runs on: `model` while it does not cool down, else its
 * `fallbacks` model on the same provider instance, with the same options, while that one does not
 * cool down. Null while `model` cools down with no fallback free.
 */
export const launchModel = (
  cooldowns: ReadonlyMap<string, Cooldown>,
  fallbacks: Readonly<Record<string, string>>,
  model: Model,
  nowMs: number,
): Model | null => {
  if (coolingDown(cooldowns, cooldownKey(model), nowMs) === null) return model;
  const to = Object.hasOwn(fallbacks, model.model) ? fallbacks[model.model] : undefined;
  if (to === undefined) return null;
  const fallback = fallbackOf(model, to);
  return coolingDown(cooldowns, cooldownKey(fallback), nowMs) === null ? fallback : null;
};
