import { GitManager } from "../../core/git-manager.js";
import { GitHubManager } from "../../core/github-manager.js";
import type { ConfigStore } from "../../core/config-store.js";

export interface GitHubContext {
  manager: GitHubManager;
  owner: string;
  repo: string;
}

export async function requireGitHubContext(
  configStore: ConfigStore,
  gitCwd: string,
): Promise<GitHubContext> {
  const config = await configStore.load();
  const token = configStore.getGithubToken(config);
  if (!token) {
    throw new Error("No GitHub token configured. Add one via POST /api/github/token.");
  }

  const remoteUrl = await new GitManager(gitCwd).remoteUrl("origin");
  if (!remoteUrl) {
    throw new Error("No git remote 'origin' found.");
  }

  const parsed = GitHubManager.parseRemoteUrl(remoteUrl);
  if (!parsed) {
    throw new Error(`Could not parse GitHub remote URL: ${remoteUrl}`);
  }

  return {
    manager: new GitHubManager(token, parsed.owner, parsed.repo),
    owner: parsed.owner,
    repo: parsed.repo,
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
