// @effect-diagnostics nodeBuiltinImport:off - free space is a `statfs` of a real directory.
/**
 * The free space the pass checks against `min_free_gib` before it claims an issue or starts a
 * gate: a full disk fails a run's writes partway through, and its gate for reasons that are not
 * the code.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export const GIB = 1024 ** 3;

/** `min_free_gib` in bytes; null when 0 turns the check off. */
export const diskFloor = (minFreeGib: number): number | null =>
  minFreeGib === 0 ? null : minFreeGib * GIB;

/** Below the floor: the pass claims nothing and starts no gate. */
export const isLowDisk = (freeBytes: number, minFreeGib: number): boolean => {
  const floor = diskFloor(minFreeGib);
  return floor !== null && freeBytes < floor;
};

/** The free space of the volume that holds `path`, as `readFreeSpace` read it. */
export interface FreeSpace {
  /** The directory that was read: the path, or its nearest parent that exists. */
  readonly path: string;
  /** Bytes an unprivileged writer may still use (`bavail * bsize`). */
  readonly freeBytes: number;
  /** The volume's size (`blocks * bsize`). */
  readonly totalBytes: number;
}

/**
 * The free space of the volume that holds `path`. The nearest part of the path that exists stands
 * for it, so a directory that is not made yet still answers. Throws what `statfs` throws.
 */
export const readFreeSpace = (path: string): FreeSpace => {
  let dir = NodePath.resolve(path);
  while (!NodeFS.existsSync(dir) && NodePath.dirname(dir) !== dir) dir = NodePath.dirname(dir);
  const stat = NodeFS.statfsSync(dir);
  return { path: dir, freeBytes: stat.bavail * stat.bsize, totalBytes: stat.blocks * stat.bsize };
};

/** The free space of the directory, of `paths`, whose volume has the least: the one that fills first. */
export const readLowestFreeSpace = (
  paths: ReadonlyArray<string>,
  read: (path: string) => FreeSpace = readFreeSpace,
): FreeSpace =>
  paths.map(read).reduce((lowest, space) => (space.freeBytes < lowest.freeBytes ? space : lowest));
