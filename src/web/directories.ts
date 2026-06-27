import { access, readdir } from "node:fs/promises";
import { posix, win32 } from "node:path";

const ignoredDirectoryNames = new Set([".git", "node_modules"]);

// Evaluated per-call (not cached) so tests can exercise the Windows path.
const isWindows = () => process.platform === "win32";

// Resolve paths with the platform's own rules. On real Windows `node:path`
// already maps to `win32`; selecting it explicitly means a `win32`-stubbed
// test runs genuine Windows path semantics on any host (POSIX `dirname("C:\\")`
// is `"."`, whereas `win32.dirname("C:\\")` is `"C:\\"` — the whole bug).
const pathLib = () => (isWindows() ? win32 : posix);

/**
 * Virtual "This PC" root shown above the drive letters on Windows. `dirname`
 * treats a drive root (`C:\`) as its own parent, so without this sentinel the
 * picker dead-ends on whichever drive it started on and can never reach `D:\`
 * etc. We surface this as the parent of any drive root and, when asked to list
 * it, enumerate the available drives instead of hitting the filesystem.
 */
export const WINDOWS_DRIVES_ROOT = "This PC";

/**
 * List the contents of a directory for in-app browsing. Folders only by
 * default (the service cwd / repo pickers); pass `includeFiles` for the agent
 * dock's file picker, which needs to attach individual files too.
 */
export async function listDirectories(
  path: string,
  { includeFiles = false }: { includeFiles?: boolean } = {},
) {
  if (isWindows() && path === WINDOWS_DRIVES_ROOT) {
    return listWindowsDrives();
  }

  const resolvedPath = pathLib().resolve(path);
  const dirents = await readdir(resolvedPath, { withFileTypes: true });
  const entries = dirents
    .filter((entry) =>
      entry.isDirectory()
        ? !ignoredDirectoryNames.has(entry.name)
        : includeFiles && entry.isFile(),
    )
    .map((entry) => ({
      name: entry.name,
      path: pathLib().resolve(resolvedPath, entry.name),
      isDir: entry.isDirectory(),
    }))
    // Folders first, then files, each alphabetical.
    .sort((left, right) =>
      left.isDir === right.isDir
        ? left.name.localeCompare(right.name)
        : left.isDir
          ? -1
          : 1,
    );

  return {
    ok: true,
    path: resolvedPath,
    parent: parentOf(resolvedPath),
    entries,
  };
}

/** Parent of a path, or the drives root on Windows when at a drive root. */
export function parentOf(resolvedPath: string): string {
  const parent = pathLib().dirname(resolvedPath);
  if (isWindows() && parent === resolvedPath) return WINDOWS_DRIVES_ROOT;
  return parent;
}

/** Enumerate available Windows drive letters as a "This PC" listing. */
async function listWindowsDrives() {
  // Skip A:/B: to avoid the legacy "no floppy disk" prompt; C:–Z: covers every
  // realistic fixed/removable/network drive.
  const letters = Array.from({ length: 24 }, (_, i) => String.fromCharCode(67 + i));
  const drives = await Promise.all(
    letters.map(async (letter) => {
      const root = `${letter}:\\`;
      try {
        await access(root);
        return { name: `${letter}:`, path: root, isDir: true };
      } catch {
        return null;
      }
    }),
  );

  return {
    ok: true,
    path: WINDOWS_DRIVES_ROOT,
    parent: WINDOWS_DRIVES_ROOT,
    entries: drives.filter((drive): drive is NonNullable<typeof drive> => drive !== null),
  };
}
