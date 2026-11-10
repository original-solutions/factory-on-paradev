import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Result from "effect/Result";

/**
 * Writes `contents` to `filePath` whole, so a reader never sees half a file. It creates the
 * directory, follows a symlinked file to its target and leaves no temp file behind. The rest of
 * the factory writes files through here.
 */
export const writeFileAtomically = (filePath: string, contents: string) =>
  writeFileStringAtomically({ filePath, contents });

// A local copy of `writeFileStringAtomically` from t3code's `packages/shared/src/atomicWrite.ts`,
// with `resolveSymlinkTarget` from `packages/shared/src/symlink.ts` and `HostProcess.Platform`
// read as `process.platform`.

/** Windows open-file locks block renames; the same codes can mean permanent denial, so bound retries. */
const isWindowsRenameLock = (error: PlatformError.PlatformError) => {
  const code = (error.reason.cause as NodeJS.ErrnoException | undefined)?.code;
  return code === "EBUSY" || code === "EPERM" || code === "EACCES";
};

// Bound denial delays to about two seconds because settings saves hold their write lock.
const LOCKED_RENAME_RETRIES = 20;
const LOCKED_RENAME_RETRY_DELAY = "100 millis";

/** Resolves symlink targets before renaming so writes preserve the link. */
const writeFileStringAtomically = (input: {
  readonly filePath: string;
  readonly contents: string;
}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const platform = process.platform;
      const targetPath = yield* resolveSymlinkTarget(input.filePath);
      const targetDirectory = path.dirname(targetPath);

      yield* fs.makeDirectory(targetDirectory, { recursive: true });
      // Cleanup failure must not fail a write that already landed.
      const tempDirectory = yield* Effect.acquireRelease(
        fs.makeTempDirectory({
          directory: targetDirectory,
          prefix: `${path.basename(targetPath)}.`,
        }),
        (directory) => fs.remove(directory, { recursive: true }).pipe(Effect.ignore({ log: true })),
      );
      const tempPath = path.join(tempDirectory, "contents.tmp");

      yield* fs.writeFileString(tempPath, input.contents);
      if (platform !== "win32") return yield* fs.rename(tempPath, targetPath);

      // Stop retrying if another save changes the target; read-only targets also return permanent EPERM.
      const targetVersion = fs.stat(targetPath).pipe(
        Effect.map((info) => ({
          id: `${Option.getOrUndefined(info.ino)}:${info.size}:${Option.getOrUndefined(info.mtime)?.getTime()}`,
          readOnly: (info.mode & 0o200) === 0,
        })),
        Effect.catchIf(
          (error) => error.reason._tag === "NotFound",
          () => Effect.succeed({ id: "missing", readOnly: false }),
        ),
        Effect.option,
      );
      const before = yield* targetVersion;
      const firstAttempt = yield* Effect.result(fs.rename(tempPath, targetPath));
      if (Result.isSuccess(firstAttempt)) return;
      const lockError = firstAttempt.failure;
      if (!isWindowsRenameLock(lockError) || Option.isNone(before) || before.value.readOnly) {
        return yield* lockError;
      }
      for (let retry = 0; retry < LOCKED_RENAME_RETRIES; retry += 1) {
        yield* Effect.sleep(LOCKED_RENAME_RETRY_DELAY);
        const current = yield* targetVersion;
        if (Option.isNone(current) || current.value.id !== before.value.id) break;
        const attempt = yield* Effect.result(fs.rename(tempPath, targetPath));
        if (Result.isSuccess(attempt)) return;
        if (!isWindowsRenameLock(attempt.failure)) return yield* attempt.failure;
      }
      return yield* lockError;
    }),
  );

const MAX_SYMLINK_HOPS = 40;

const isNotFound = (error: PlatformError.PlatformError) => error.reason._tag === "NotFound";

const isNotASymlink = (error: PlatformError.PlatformError) =>
  isNotFound(error) ||
  (error.cause instanceof Error && "code" in error.cause && error.cause.code === "EINVAL");

/**
 * Atomic writers rename onto this path so a linked file keeps its link. Fails
 * on a cycle, an overly long chain, or an unreadable link rather than handing
 * back a link that a rename would replace.
 */
const resolveSymlinkTarget = Effect.fn("symlink.resolveSymlinkTarget")(function* (
  filePath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let current = path.resolve(filePath);
  // The terminal file needs a probe after the last permitted link is followed.
  for (let hop = 0; hop <= MAX_SYMLINK_HOPS; hop++) {
    const link = yield* fs.readLink(current).pipe(
      Effect.asSome,
      Effect.catchIf(isNotASymlink, () => Effect.succeedNone),
    );
    if (Option.isNone(link)) {
      return current;
    }
    // A relative target is relative to where the link really lives, which
    // differs from its lexical parent when that parent is itself a symlink.
    const linkDirectory = yield* fs
      .realPath(path.dirname(current))
      .pipe(Effect.catchIf(isNotFound, () => Effect.succeed(path.dirname(current))));
    current = path.resolve(linkDirectory, link.value);
  }
  return yield* PlatformError.systemError({
    _tag: "Unknown",
    module: "FileSystem",
    method: "readLink",
    description: "Too many levels of symbolic links",
    pathOrDescriptor: filePath,
  });
});
