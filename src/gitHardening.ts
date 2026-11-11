/**
 * What every factory git call runs with in a repository a session can write to: no system or
 * global config, hooks, fsmonitor, eol conversion or `ext` transport, so nothing a session puts in
 * the repository's config or hooks runs as the factory.
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
];

/** The environment of a hardened git call; `-c` flags cannot turn the system and global config off. */
export const HARDENED_GIT_ENV: Readonly<Record<string, string>> = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_LFS_SKIP_SMUDGE: "1",
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
