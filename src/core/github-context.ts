import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { ConfigStore } from "./config-store.js";
import { GitManager } from "./git-manager.js";
import { publicCredential, resolveGitHubCredential } from "./github-auth.js";
import { GitHubManager } from "./github-manager.js";
import type {
  GitHubCredentialSelection,
  GitRepositoryDefinition,
  NoMoreIdeConfig,
} from "./types.js";

export interface GitHubContext {
  manager: GitHubManager;
  owner: string;
  repo: string;
  credential: GitHubCredentialSelection;
}

export async function requireGitHubContext(
  configStore: ConfigStore,
  gitCwd: string,
): Promise<GitHubContext> {
  const config = await configStore.load();
  const git = new GitManager(gitCwd);
  const [remoteUrl, topLevel] = await Promise.all([git.remoteUrl("origin"), git.root()]);
  if (!remoteUrl) throw new Error("No git remote 'origin' found.");
  const parsed = GitHubManager.parseRemoteUrl(remoteUrl);
  if (!parsed) throw new Error(`Could not parse GitHub remote URL: ${remoteUrl}`);

  const repository = await matchRegisteredRepository(config, topLevel);
  const credential = await resolveGitHubCredential(config, repository, "github.com");
  return {
    manager: new GitHubManager(credential.token, parsed.owner, parsed.repo),
    owner: parsed.owner,
    repo: parsed.repo,
    credential: publicCredential(credential),
  };
}

export async function optionalGitHubContext(
  configStore: ConfigStore,
  gitCwd: string,
): Promise<GitHubContext | null> {
  try {
    return await requireGitHubContext(configStore, gitCwd);
  } catch {
    return null;
  }
}

export function selectedGitHubCwd(config: NoMoreIdeConfig, fallbackCwd: string): string {
  const repository =
    config.gitRepositories.find((entry) => entry.name === config.selectedGitRepository)
    ?? config.gitRepositories[0];
  return repository?.activeWorktreePath ?? repository?.path ?? fallbackCwd;
}

async function matchRegisteredRepository(
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
