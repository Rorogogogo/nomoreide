import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { gitToplevel, type ConfigStore } from "./config-store.js";
import { resolveGitHubCredential } from "./github-auth.js";
import { GitHubManager } from "./github-manager.js";
import { matchRegisteredRepository } from "./repo-match.js";
import type {
  GitHubIdentity,
  GitRepositoryDefinition,
  NoMoreIdeConfig,
} from "./types.js";

const execFileAsync = promisify(execFile);
const GIT_CONFIG_TIMEOUT_MS = 5_000;

/** Author/committer NoMoreIDE stamps on the commits it creates. */
export type GitIdentity = GitHubIdentity;

/** What `git config user.*` resolves to in a working tree. */
export interface MachineIdentity {
  name?: string;
  email?: string;
}

export interface GitIdentityState {
  /**
   * Identity NoMoreIDE will commit as, or null when it defers to whatever the
   * machine is configured with.
   */
  selected: GitIdentity | null;
  machine: MachineIdentity;
  /** True when a commit made here would carry an author the machine doesn't use. */
  diverged: boolean;
  /** Why `selected` is null — the UI explains the fallback rather than hiding it. */
  reason?: string;
}

/**
 * Commit identity derived from the GitHub account selected for a repository.
 *
 * The account switcher has always governed the GitHub *API* (pull requests,
 * issues, CI) while `git commit` quietly used the machine's `user.email`. That
 * split let a commit be authored by one account and its pull request opened by
 * another, with nothing in the UI saying so. This module closes the gap for
 * commits and reports the mismatch when it can't.
 *
 * Deliberately scoped to the repository: the alternative — `gh auth switch` —
 * changes identity for every terminal and every other repo on the machine, and
 * NoMoreIDE does not reach outside what it owns.
 */
export async function resolveGitIdentityState(
  configStore: ConfigStore,
  repository: GitRepositoryDefinition | undefined,
  cwd: string,
): Promise<GitIdentityState> {
  const machine = await readMachineIdentity(cwd);
  const config = await configStore.load();

  if (!repository?.githubCredential) {
    return {
      selected: null,
      machine,
      diverged: false,
      reason: "No GitHub account is selected for this repository.",
    };
  }

  try {
    const selected = await resolveSelectedIdentity(configStore, config, repository);
    return { selected, machine, diverged: isDiverged(selected, machine) };
  } catch (error) {
    return {
      selected: null,
      machine,
      diverged: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Same as {@link resolveGitIdentityState}, for callers that only know a working
 * directory — the MCP tools and the CLI, which take a `cwd` rather than a
 * repository name. An unregistered or ambiguous directory resolves to "no
 * selection", which keeps today's machine-identity behaviour.
 */
export async function resolveGitIdentityForCwd(
  configStore: ConfigStore,
  cwd: string,
): Promise<GitIdentityState> {
  return resolveGitIdentityState(configStore, await repositoryForCwd(configStore, cwd), cwd);
}

/** The registered repository owning `cwd`, or undefined when there isn't a clear one. */
export async function repositoryForCwd(
  configStore: ConfigStore,
  cwd: string,
): Promise<GitRepositoryDefinition | undefined> {
  const config = await configStore.load();
  const topLevel = await gitToplevel(cwd);
  if (!topLevel) return undefined;
  return matchRegisteredRepository(config, topLevel).catch(() => undefined);
}

/**
 * Identity for the repository's selected account, from the config cache when
 * possible and the GitHub API otherwise. Cached because every commit would
 * otherwise spend an API call resolving an answer that changes ~never.
 */
export async function resolveSelectedIdentity(
  configStore: ConfigStore,
  config: NoMoreIdeConfig,
  repository: GitRepositoryDefinition,
): Promise<GitIdentity> {
  const selection = repository.githubCredential;
  if (!selection) throw new Error("No GitHub account is selected for this repository.");

  const host = selection.host;
  const knownLogin =
    selection.source === "gh"
      ? selection.login
      : config.githubTokens.find((entry) => entry.host === host)?.login;

  const cached = knownLogin ? configStore.getGithubIdentity(config, host, knownLogin) : undefined;
  if (cached) return cached;

  const credential = await resolveGitHubCredential(config, repository, host);
  const viewer = await new GitHubManager(credential.token, "", "").viewer();
  const login = viewer.login || knownLogin;
  if (!login) throw new Error("GitHub did not report an account login for the selected credential.");

  const identity: GitIdentity = {
    host,
    login,
    name: viewer.name?.trim() || login,
    email: commitEmail(viewer.email, viewer.id, login),
  };
  await configStore.setGithubIdentity(identity);
  return identity;
}

/**
 * Environment that pins a commit's author and committer. Passed per command
 * rather than written to `git config`, so nothing about the machine's setup
 * changes and concurrent commits in other repos are unaffected.
 */
/**
 * Token to push the repository's selected account with, or null to leave the
 * machine's credential helper in charge.
 *
 * Returns null for SSH remotes on purpose: authentication there comes from a
 * key, and no token NoMoreIDE holds can change which key `ssh` offers. Callers
 * that care about the mismatch surface it through {@link resolveGitIdentityState}
 * instead of pretending the push was re-attributed.
 */
export async function resolvePushCredential(
  configStore: ConfigStore,
  repository: GitRepositoryDefinition | undefined,
  remoteUrl: string | null,
): Promise<{ token: string; login?: string } | null> {
  if (!repository?.githubCredential) return null;
  const host = httpsRemoteHost(remoteUrl);
  if (!host || host !== repository.githubCredential.host) return null;

  const config = await configStore.load();
  const credential = await resolveGitHubCredential(config, repository, host);
  return { token: credential.token, login: credential.login };
}

/** Host of an HTTPS git remote, or null when the remote is SSH or unparseable. */
export function httpsRemoteHost(remoteUrl: string | null): string | null {
  if (!remoteUrl) return null;
  try {
    const parsed = new URL(remoteUrl.trim());
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    return parsed.hostname || null;
  } catch {
    return null;
  }
}

export function identityEnv(identity: GitIdentity): Record<string, string> {
  return {
    GIT_AUTHOR_NAME: identity.name,
    GIT_AUTHOR_EMAIL: identity.email,
    GIT_COMMITTER_NAME: identity.name,
    GIT_COMMITTER_EMAIL: identity.email,
  };
}

export async function readMachineIdentity(cwd: string): Promise<MachineIdentity> {
  const [name, email] = await Promise.all([
    gitConfigValue(cwd, "user.name"),
    gitConfigValue(cwd, "user.email"),
  ]);
  return { name, email };
}

/**
 * The address a commit should carry. GitHub's own address is preferred over a
 * guess, and the id-qualified `noreply` form is used when the account keeps its
 * email private — that form still attributes the commit to the account.
 */
export function commitEmail(
  publicEmail: string | null | undefined,
  id: number | undefined,
  login: string,
): string {
  const explicit = publicEmail?.trim();
  if (explicit) return explicit;
  return id ? `${id}+${login}@users.noreply.github.com` : `${login}@users.noreply.github.com`;
}

function isDiverged(selected: GitIdentity, machine: MachineIdentity): boolean {
  const configured = machine.email?.trim().toLowerCase();
  if (!configured) return true;
  return configured !== selected.email.trim().toLowerCase();
}

async function gitConfigValue(cwd: string, key: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["config", "--get", key], {
      cwd,
      encoding: "utf8",
      timeout: GIT_CONFIG_TIMEOUT_MS,
    });
    return stdout.trim() || undefined;
  } catch {
    // `git config --get` exits non-zero when the key is unset — an unconfigured
    // machine identity is a normal state here, not a failure.
    return undefined;
  }
}
