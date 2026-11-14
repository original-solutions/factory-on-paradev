/**
 * The proxy check that comes before cloud is a placement candidate (#55): `GET <proxy>/v1/models`
 * with no key must answer 401. A 200 means the proxy's key check is off, so a cloud agent would
 * be a free client of it. The HTTP call is injected, so tests answer it.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

/** GETs `url` with no key; answers the HTTP status, or fails with why there was none. */
export type ProxyGet = (url: string) => Effect.Effect<number, string>;

/** How long the proxy has to answer. */
export const PROXY_TIMEOUT_MS = 10_000;

export type ProxyAnswer =
  /** 401: the proxy refused a call with no key, as it should. */
  | { readonly kind: "guarded" }
  /** 200: the proxy answered a call with no key; its key check is off. */
  | { readonly kind: "open" }
  /** Anything else, or no answer. */
  | { readonly kind: "down"; readonly reason: string };

/** Asks the proxy once. Never fails: every way it can go wrong is a `down` with its reason. */
export const checkProxy = (
  get: ProxyGet,
  proxy: string,
  timeoutMs: number = PROXY_TIMEOUT_MS,
): Effect.Effect<ProxyAnswer> =>
  get(`${proxy.replace(/\/+$/, "")}/v1/models`).pipe(
    Effect.timeoutOption(timeoutMs),
    Effect.map(
      (answer): ProxyAnswer =>
        Option.isNone(answer)
          ? { kind: "down", reason: `did not answer within ${timeoutMs / 1000} s` }
          : answer.value === 401
            ? { kind: "guarded" }
            : answer.value === 200
              ? { kind: "open" }
              : { kind: "down", reason: `answered HTTP ${answer.value}` },
    ),
    Effect.catch((reason) => Effect.succeed<ProxyAnswer>({ kind: "down", reason })),
  );

/** The real call: no auth header, ever, and a redirect is an answer, not something to follow. */
export const liveProxyGet: ProxyGet = (url) =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(url, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
      });
      return response.status;
    },
    catch: (error) => (error instanceof Error ? error.message : String(error)),
  });
