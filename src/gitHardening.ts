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

/** `-c` flags for each of `settings`. */
export const configFlags = (settings: ReadonlyArray<string>): ReadonlyArray<string> =>
  settings.flatMap((setting) => ["-c", setting]);
