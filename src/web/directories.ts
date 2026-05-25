import { readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const ignoredDirectoryNames = new Set([".git", "node_modules"]);

/**
 * List the contents of a directory for in-app browsing. Folders only by
 * default (the service cwd / repo pickers); pass `includeFiles` for the agent
 * dock's file picker, which needs to attach individual files too.
 */
export async function listDirectories(
  path: string,
  { includeFiles = false }: { includeFiles?: boolean } = {},
) {
  const resolvedPath = resolve(path);
  const dirents = await readdir(resolvedPath, { withFileTypes: true });
  const entries = dirents
    .filter((entry) =>
      entry.isDirectory()
        ? !ignoredDirectoryNames.has(entry.name)
        : includeFiles && entry.isFile(),
    )
    .map((entry) => ({
      name: entry.name,
      path: resolve(resolvedPath, entry.name),
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
    parent: dirname(resolvedPath),
    entries,
  };
}
