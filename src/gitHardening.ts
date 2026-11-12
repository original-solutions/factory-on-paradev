import * as Effect from "effect/Effect";
import * as Random from "effect/Random";
import * as Result from "effect/Result";

/**
 * What every factory git call runs with in a repository a session can write to: no system or
 * global config, hooks directory, fsmonitor, eol conversion or `ext` transport. Automatic
 * maintenance is not pinned here: a caller in a repository a session can write passes
 * `--no-auto-maintenance` to the commands that start it. Config-defined hooks (`hook.<name>.*`) and filter drivers are named by the
 * repository's own config, so a caller that cannot trust it turns them off with {@link listSessionPins}.
 */
export const HARDENED_GIT_CONFIG: ReadonlyArray<string> = [
  "core.fsmonitor=false",
  "core.hooksPath=/dev/null",
  "core.autocrlf=false",
  // The default attributes and ignore files (`~/.config/git/attributes` and `ignore`, and the
  // `$XDG_CONFIG_HOME` ones) are read even with no config at all.
  "core.attributesFile=/dev/null",
  "core.excludesFile=/dev/null",
  "protocol.ext.allow=never",
  // Fetch-pack runs this to list an alternate's refs; empty turns it off.
  "core.alternateRefsCommand=",
];

/** The environment of a hardened git call; `-c` flags cannot turn the system and global config off. */
export const HARDENED_GIT_ENV: Readonly<Record<string, string>> = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_LFS_SKIP_SMUDGE: "1",
  // A partial clone fetches a missing object from its promisor remote by running `git fetch`, which
  // reads that remote's `uploadpack` from the repository's config.
  GIT_NO_LAZY_FETCH: "1",
  // Git's messages in English, whatever the locale the server started in.
  LC_ALL: "C",
};

/**
 * The environment a credentialed fetch adds to {@link HARDENED_GIT_ENV}: the token variables and
 * `gh`'s config dir, `ghConfigDir` when given, so `gh auth git-credential` answers as the
 * factory's login.
 */
export const fetchCredentialEnv = (ghConfigDir: string | undefined): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "XDG_CONFIG_HOME"]) {
    const value = globalThis.process.env[name];
    if (value !== undefined) env[name] = value;
  }
  const dir = ghConfigDir ?? globalThis.process.env.GH_CONFIG_DIR;
  if (dir !== undefined) env.GH_CONFIG_DIR = dir;
  return env;
};

/** The `-c` flags that make `gh` the only credential helper of a fetch. */
export const FETCH_CREDENTIAL_FLAGS: ReadonlyArray<string> = [
  "-c",
  "credential.helper=",
  "-c",
  "credential.helper=!gh auth git-credential",
];

/** `-c` flags for each of `settings`. */
export const configFlags = (settings: ReadonlyArray<string>): ReadonlyArray<string> =>
  settings.flatMap((setting) => ["-c", setting]);

/** Where a base is fetched from when no `remoteBase` is set. */
export const DEFAULT_REMOTE_BASE = "https://github.com";

/** `remoteBase`, or the default, with no trailing slash: repositories are at `<it>/<owner>/<name>.git`. */
export const normalizeRemoteBase = (remoteBase: string | undefined): string =>
  (remoteBase ?? DEFAULT_REMOTE_BASE).replace(/\/+$/, "");

/** `protocol.file.allow` for a fetch from `remoteBase`: only a `file://` base (tests) may use it. */
export const fileTransportFor = (remoteBase: string): "always" | "never" =>
  remoteBase.startsWith("file://") ? "always" : "never";

/** What a by-URL fetch never does: no tags, no submodules, no FETCH_HEAD. */
export const FETCH_ARGS: ReadonlyArray<string> = ["--no-tags", "--no-recurse-submodules", "--no-write-fetch-head"];

/** HTTP/1.1, because the HTTP/2 framing layer is what a flaky link breaks first. */
export const FETCH_HTTP_FLAGS: ReadonlyArray<string> = ["-c", "http.version=HTTP/1.1"];

/** How many times a by-URL fetch is tried before its failure is returned. */
export const FETCH_ATTEMPTS = 3;
/** The wait before the second and the third fetch, in milliseconds; each gets up to a second more. */
export const FETCH_RETRY_DELAYS_MS: ReadonlyArray<number> = [5_000, 15_000];
/**
 * What git's stderr says when the network dropped the fetch: HTTP/2 stream error, TLS handshake
 * timeout, unresolved name, failed or timed-out connection, or a cut-off pack or answer. Anything else
 * (missing ref, refused login) returns at once. `RPC failed` counts only with a curl code right
 * after it; `RPC failed; HTTP 403 curl 22` means the server answered and refused.
 */
export const TRANSIENT_FETCH =
  /Error in the HTTP2 framing layer|TLS handshake timeout|Could not resolve host|Failed to connect|Connection timed out|SSL_ERROR_SYSCALL|early EOF|unexpected EOF|RPC failed; curl \d+/;

/**
 * `fetch`, tried again up to {@link FETCH_ATTEMPTS} times in all while the stderr of its failure
 * matches {@link TRANSIENT_FETCH}, after each of `delaysMs` plus up to a second of jitter, so
 * fetches that failed together do not retry together. `stderrOf` is undefined for a failure that
 * must not be tried again; `name` is what the log line calls the call.
 */
export const retryFetch = <A, E, R>(
  fetch: Effect.Effect<A, E, R>,
  options: {
    readonly delaysMs: ReadonlyArray<number>;
    readonly stderrOf: (error: E) => string | undefined;
    readonly name: (error: E) => string;
  },
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    for (let tried = 1; ; tried += 1) {
      const fetched = yield* Effect.result(fetch);
      if (Result.isSuccess(fetched)) return fetched.success;
      const error = fetched.failure;
      const stderr = options.stderrOf(error);
      const reason = stderr === undefined ? undefined : TRANSIENT_FETCH.exec(stderr)?.[0];
      if (reason === undefined || tried >= FETCH_ATTEMPTS) return yield* Effect.fail(error);
      const wait = options.delaysMs[tried - 1] ?? 0;
      const delayMs = wait + (yield* Random.nextIntBetween(0, Math.min(1000, wait)));
      yield* Effect.logInfo(
        `${options.name(error)} attempt ${tried} of ${FETCH_ATTEMPTS} failed (${reason}); trying again in ${(delayMs / 1000).toFixed(1)} s`,
      );
      yield* Effect.sleep(delayMs);
    }
  });

// ---- filter drivers and config hooks in a repository a session can write ---------------------

/** The git arguments that list every filter driver and config hook key, NUL-separated. */
export const SESSION_PINS_LISTING: ReadonlyArray<string> = [
  "config", "-z", "--name-only", "--get-regexp", "^(filter|hook)\\.",
];
/** The most of that listing read back; a longer one is truncated, and so refused. */
export const SESSION_PINS_LISTING_BYTES = 1024 * 1024;

/** What the listing call answered. */
export interface SessionPinsListing {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly tailTruncated: boolean;
  readonly tail: string;
}

/**
 * The environment that turns off every filter driver and config hook the listing names, or why
 * it cannot. A filter gets an empty `smudge`, `clean` and `process` and `required=false`; a hook
 * gets `enabled=false`, since an empty `command` would make git fail the call it hooks. The pins
 * go in `GIT_CONFIG_COUNT`/`KEY_n`/`VALUE_n`, not `-c`: git hands `-c` flags to every child it
 * starts as one variable, and Linux refuses to start a child with a variable over 128 KiB. The
 * listing must be complete, since a name left out of it would not be turned off: a truncated or
 * timed-out one, or a failure other than "none configured" (exit 1), is refused. So is a name
 * with anything outside `[A-Za-z0-9._-]`.
 */
export const sessionPins = (
  listed: SessionPinsListing,
): { readonly env: Readonly<Record<string, string>> } | { readonly refused: string } => {
  if (listed.timedOut || listed.tailTruncated || (listed.exitCode !== 0 && listed.exitCode !== 1)) {
    return { refused: "the filter drivers and hooks of the repository could not be listed in full" };
  }
  const names = new Set(
    listed.exitCode === 0
      ? listed.tail.split("\0").flatMap((key) => {
          const match = /^(filter|hook)\.(.+)\.[^.]+$/s.exec(key);
          return match === null ? [] : [`${match[1]}.${match[2]}`];
        })
      : [],
  );
  const env: Record<string, string> = {};
  let count = 0;
  for (const name of names) {
    if (!/^(filter|hook)\.[A-Za-z0-9._-]+$/.test(name)) {
      return { refused: `${JSON.stringify(name)} in the repository's config cannot be turned off safely` };
    }
    const settings: ReadonlyArray<readonly [string, string]> = name.startsWith("filter.")
      ? [["smudge", ""], ["clean", ""], ["process", ""], ["required", "false"]]
      : [["enabled", "false"]];
    for (const [key, value] of settings) {
      env[`GIT_CONFIG_KEY_${count}`] = `${name}.${key}`;
      env[`GIT_CONFIG_VALUE_${count}`] = value;
      count += 1;
    }
  }
  env.GIT_CONFIG_COUNT = String(count);
  return { env };
};

/**
 * {@link sessionPins} for the repository `list` runs the listing in: `list` gets the listing's
 * arguments and how many bytes to read back, and runs them as a hardened git call there.
 */
export const listSessionPins = <E, R>(
  list: (args: ReadonlyArray<string>, tailBytes: number) => Effect.Effect<SessionPinsListing, E, R>,
): Effect.Effect<ReturnType<typeof sessionPins>, E, R> =>
  Effect.map(list(SESSION_PINS_LISTING, SESSION_PINS_LISTING_BYTES), sessionPins);
