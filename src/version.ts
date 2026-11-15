/**
 * A release version, `X.Y.Z`, compared as three numbers: as text `0.3.10` sorts below `0.3.9`
 * (`docs/specs/P3-plugin.md`, V4). The runner's tags, the plugin a target has landed and
 * `factory.minPluginVersion` are all compared with {@link compareVersions}.
 */
export type Version = readonly [number, number, number];

/** `X.Y.Z` and nothing else around it; null for any other text. */
export const parseVersion = (text: string): Version | null => {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(text);
  return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])];
};

/** Below 0 when `a` is older than `b`, 0 when they are the same, above 0 when `a` is newer. */
export const compareVersions = (a: Version, b: Version): number => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
