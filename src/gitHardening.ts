/**
 * What every factory git call runs with in a repository a session can write to: no system or
 * global config, hooks directory, fsmonitor, eol conversion, `ext` transport or automatic
 * maintenance. Config-defined hooks (`hook.<name>.*`) and filter drivers are named by the
 * repository's own config, so a caller that cannot trust it blanks them one by one.
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
  // Fetch, commit and others start `gc --auto` or `maintenance run --auto` on exit; both read
  // `gc.recentObjectsHook` from the config.
  "maintenance.auto=false",
  "gc.auto=0",
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
