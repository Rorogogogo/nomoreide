import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

export async function pluginBundleDigest(root: string): Promise<string> {
  const hash = createHash("sha256");
  await hashDirectory(root, "", hash);
  return hash.digest("hex");
}

async function hashDirectory(
  root: string,
  relative: string,
  hash: ReturnType<typeof createHash>,
): Promise<void> {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === ".DS_Store") continue;
    const next = path.join(relative, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Plugin bundle contains a symbolic link: ${next}`);
    }
    const canonicalPath = next.split(path.sep).join("/");
    hash.update(`${entry.isDirectory() ? "d" : "f"}\0${canonicalPath}\0`);
    if (entry.isDirectory()) await hashDirectory(root, next, hash);
    else if (entry.isFile()) hash.update(await readFile(path.join(root, next)));
    else throw new Error(`Plugin bundle contains an unsupported file: ${next}`);
  }
}

export function pluginIdentity(plugin: {
  name: string;
  sourceAgent: string;
  source?: string;
}): string {
  return `${plugin.sourceAgent}:${plugin.name}@${plugin.source ?? "local"}`;
}
