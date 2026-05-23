import { readdir } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

export type ConfigFileFormat = "env" | "json" | "yaml";

export interface ConfigFileInfo {
  path: string;
  relativePath: string;
  format: ConfigFileFormat;
}

export function formatFromName(name: string): ConfigFileFormat | undefined {
  if (name === ".env" || name.startsWith(".env.")) return "env";
  if (/^appsettings(\..+)?\.json$/i.test(name)) return "json";
  if (/^application(-.+)?\.ya?ml$/i.test(name)) return "yaml";
  return undefined;
}

const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  "bin",
  "obj",
  ".next",
  ".nuxt",
  ".turbo",
  ".vite",
  ".cache",
  "coverage",
  "target",
  "venv",
  ".venv",
  "__pycache__",
]);

const MAX_DEPTH = 4;
const MAX_FILES = 200;

export async function detectConfigFiles(cwd: string): Promise<ConfigFileInfo[]> {
  const root = resolve(cwd);
  const results: ConfigFileInfo[] = [];
  await walk(root, root, 0, results);
  results.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return results;
}

async function walk(
  root: string,
  current: string,
  depth: number,
  results: ConfigFileInfo[],
): Promise<void> {
  if (results.length >= MAX_FILES) return;
  let entries;
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (results.length >= MAX_FILES) return;
    if (entry.name.startsWith(".") && entry.isDirectory() && IGNORED_DIRS.has(entry.name)) {
      continue;
    }
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      if (depth + 1 > MAX_DEPTH) continue;
      await walk(root, join(current, entry.name), depth + 1, results);
      continue;
    }
    if (!entry.isFile()) continue;
    const format = formatFromName(entry.name);
    if (!format) continue;
    const path = join(current, entry.name);
    results.push({ path, relativePath: relative(root, path), format });
  }
}

export interface BrowseEntry {
  name: string;
  relativePath: string;
  kind: "directory" | "file";
  format?: ConfigFileFormat;
  supported: boolean;
}

export interface BrowseResult {
  cwd: string;
  currentPath: string;
  relativePath: string;
  isRoot: boolean;
  entries: BrowseEntry[];
}

export async function browseDirectory(
  cwd: string,
  requested: string | undefined,
): Promise<BrowseResult> {
  const root = resolve(cwd);
  const current = requested
    ? assertWithinRoot(root, isAbsolute(requested) ? resolve(requested) : resolve(root, requested))
    : root;
  const rel = relative(root, current);
  const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
  const items: BrowseEntry[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") && IGNORED_DIRS.has(entry.name)) continue;
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      const fullPath = join(current, entry.name);
      items.push({
        name: entry.name,
        relativePath: relative(root, fullPath),
        kind: "directory",
        supported: true,
      });
      continue;
    }
    if (!entry.isFile()) continue;
    const format = formatFromName(entry.name);
    const fullPath = join(current, entry.name);
    items.push({
      name: entry.name,
      relativePath: relative(root, fullPath),
      kind: "file",
      format,
      supported: !!format,
    });
  }
  items.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return {
    cwd: root,
    currentPath: current,
    relativePath: rel,
    isRoot: current === root,
    entries: items,
  };
}

function assertWithinRoot(root: string, candidate: string): string {
  const rel = relative(root, candidate);
  if (rel.startsWith("..") || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new ConfigFilePathError("Path must live inside the service directory.");
  }
  return candidate;
}

export class ConfigFilePathError extends Error {}

export function resolveConfigFile(cwd: string, requested: string): ConfigFileInfo {
  if (!requested || requested.includes("\0")) {
    throw new ConfigFilePathError("Invalid config file path.");
  }
  const absolute = isAbsolute(requested) ? resolve(requested) : resolve(cwd, requested);
  const rel = relative(cwd, absolute);
  if (rel.startsWith("..") || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new ConfigFilePathError("Config file must live inside the service directory.");
  }
  const name = basename(absolute);
  const format = formatFromName(name);
  if (!format) {
    throw new ConfigFilePathError(`Unsupported config file: ${name}`);
  }
  return { path: absolute, relativePath: rel, format };
}

export function validateJson(text: string): void {
  try {
    JSON.parse(text);
  } catch (error) {
    throw new Error(
      `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
