import type { ConfigStore } from "./config-store.js";
import { GitManager } from "./git-manager.js";
import { publicCredential, resolveGitHubCredential } from "./github-auth.js";
import { GitHubManager } from "./github-manager.js";
import { matchRegisteredRepository } from "./repo-match.js";
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
