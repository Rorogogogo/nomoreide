import { readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const ignoredDirectoryNames = new Set([".git", "node_modules"]);

export async function listDirectories(path: string) {
  const resolvedPath = resolve(path);
  const entries = await readdir(resolvedPath, { withFileTypes: true });
  const directories = entries
    .filter((entry) => entry.isDirectory() && !ignoredDirectoryNames.has(entry.name))
    .map((entry) => ({
      name: entry.name,
      path: resolve(resolvedPath, entry.name),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));

  return {
    ok: true,
    path: resolvedPath,
    parent: dirname(resolvedPath),
    entries: directories,
  };
}
