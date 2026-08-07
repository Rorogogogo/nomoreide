import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { GitRepositoryDefinition, NoMoreIdeConfig } from "./types.js";

/**
 * Which registered repository a working directory belongs to.
 *
 * Deliberately strict: an ambiguous or nested match throws rather than picking
 * one, because the answer decides which GitHub account a push or commit is
 * attributed to — guessing there would be worse than refusing.
 *
 * Lives in its own module so both the GitHub API context and the commit/push
 * identity path share one definition without importing each other.
 */
export async function matchRegisteredRepository(
  config: NoMoreIdeConfig,
  topLevel: string,
): Promise<GitRepositoryDefinition | undefined> {
  const canonicalTopLevel = await canonicalPath(topLevel);
  const candidates: Array<{ repository: GitRepositoryDefinition; root: string }> = [];
  for (const repository of config.gitRepositories) {
    for (const root of [repository.path, repository.activeWorktreePath]) {
      if (root) candidates.push({ repository, root: await canonicalPath(root) });
    }
  }
  const exact = candidates.filter((candidate) => candidate.root === canonicalTopLevel);
  const names = new Set(exact.map((candidate) => candidate.repository.name));
  if (names.size === 1) return exact[0]?.repository;
  if (names.size > 1) throw new Error("The Git repository matches multiple registered projects.");
  if (candidates.some((candidate) => pathContains(candidate.root, canonicalTopLevel))) {
    throw new Error("This nested Git repository is not registered with its own GitHub account.");
  }
  return undefined;
}

async function canonicalPath(path: string): Promise<string> {
  return realpath(path).catch(() => resolve(path));
}

function pathContains(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}
