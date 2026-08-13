import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ConfigStore } from "./config-store.js";
import { GitManager } from "./git-manager.js";
import { matchRegisteredRepository } from "./repo-match.js";
import {
  resolveVercelCredential,
  VERCEL_PROVIDER_ID,
  type ResolvedVercelCredential,
} from "./vercel-auth.js";
import { VercelActions } from "./vercel-actions.js";
import { VercelManager, vercelRepoUrl, type VercelProject } from "./vercel-manager.js";
import type { NoMoreIdeConfig } from "./types.js";

export interface VercelContext {
  manager: VercelManager;
  credential: ResolvedVercelCredential;
  /** Absent when connected but no project is linked to this repo yet. */
  project?: VercelProject;
}

/**
 * A connected Vercel client for the given working directory.
 *
 * Throws when Vercel isn't connected — a missing *project* is not an error,
 * because the dashboard's job in that state is to help the user pick one.
 */
export async function requireVercelContext(
  configStore: ConfigStore,
  gitCwd: string,
): Promise<VercelContext> {
  const config = await configStore.load();
  const credential = await resolveVercelCredential(config, process.env, {
    onTokensRefreshed: (tokens) =>
      configStore
        .updateConnectionTokens(VERCEL_PROVIDER_ID, {
          token: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresAt: tokens.expiresAt,
        })
        .then(() => undefined),
  });
  const identity = credential.source === "oauth" ? ("oidc" as const) : ("user" as const);
  const teamId =
    credential.scopeId ?? (await adoptDefaultTeam(configStore, credential, identity));
  const manager = new VercelManager(credential.token, teamId, undefined, { identity });
  const project = await resolveProject(config, manager, gitCwd);
  return { manager, credential: { ...credential, scopeId: teamId }, project };
}

/**
 * The team scope to use when the user has never chosen one.
 *
 * Vercel puts a personal account's projects under an implicit "<name>'s
 * projects" team, not under the account itself, so an unscoped client lists
 * nothing at all — which reads as "no projects" rather than "wrong scope". A
 * `cli` connection avoids this by inheriting the CLI's own scope; a browser
 * sign-in or a pasted token has nothing to inherit, so the sole team is adopted
 * here and persisted, making this a one-time lookup.
 *
 * With several teams there is no unambiguous answer, so none is chosen and the
 * dashboard's team switcher is left to ask. Failures are swallowed: an
 * unscoped client still works, and the caller's own request should be what
 * surfaces an auth problem.
 */
async function adoptDefaultTeam(
  configStore: ConfigStore,
  credential: ResolvedVercelCredential,
  identity: "user" | "oidc",
): Promise<string | undefined> {
  // A `cli` connection follows the CLI's own scope, so persisting one here
  // would override `vercel switch` from then on.
  if (credential.source === "cli") return undefined;
  try {
    const teams = await new VercelManager(credential.token, undefined, undefined, {
      identity,
    }).listTeams();
    if (teams.length !== 1) return undefined;
    const [team] = teams;
    await configStore.setConnectionScope(VERCEL_PROVIDER_ID, {
      scopeId: team.id,
      scopeSlug: team.slug,
    });
    return team.id;
  } catch {
    return undefined;
  }
}

export async function optionalVercelContext(
  configStore: ConfigStore,
  gitCwd: string,
): Promise<VercelContext | null> {
  try {
    return await requireVercelContext(configStore, gitCwd);
  } catch {
    return null;
  }
}

/** Write-capable counterpart, resolved the same way but returned separately. */
export async function requireVercelActions(
  configStore: ConfigStore,
): Promise<VercelActions> {
  const config = await configStore.load();
  const credential = await resolveVercelCredential(config, process.env, {
    onTokensRefreshed: (tokens) =>
      configStore
        .updateConnectionTokens(VERCEL_PROVIDER_ID, {
          token: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresAt: tokens.expiresAt,
        })
        .then(() => undefined),
  });
  return new VercelActions({ token: credential.token, teamId: credential.scopeId });
}

/**
 * Which Vercel project this repository deploys, in order of confidence:
 *
 * 1. an explicit pin the user chose in the dashboard;
 * 2. `.vercel/project.json`, written by `vercel link` — the same file the CLI
 *    trusts, so a linked repo needs no configuration here at all;
 * 3. a lookup by the repo's git remote, which is how Vercel itself keys an
 *    imported project.
 *
 * Returns undefined rather than guessing when none of those answer, since the
 * wrong project would show deployments for unrelated code.
 */
async function resolveProject(
  config: NoMoreIdeConfig,
  manager: VercelManager,
  gitCwd: string,
): Promise<VercelProject | undefined> {
  const git = new GitManager(gitCwd);
  const topLevel = await git.root().catch(() => gitCwd);

  const repository = await matchRegisteredRepository(config, topLevel).catch(() => undefined);
  const pinned = repository?.providerProjects?.[VERCEL_PROVIDER_ID];
  if (pinned) {
    const project = await manager.getProject(pinned).catch(() => undefined);
    if (project) return project;
  }

  const linkedId = await readLinkedProjectId(topLevel);
  if (linkedId) {
    const project = await manager.getProject(linkedId).catch(() => undefined);
    if (project) return project;
  }

  const remoteUrl = await git.remoteUrl("origin").catch(() => null);
  const repoUrl = remoteUrl ? vercelRepoUrl(remoteUrl) : null;
  if (repoUrl) {
    const [project] = await manager.listProjects({ repoUrl, limit: 2 }).catch(() => []);
    if (project) return project;
  }

  return undefined;
}

/** `projectId` from `.vercel/project.json`, when the repo has been `vercel link`ed. */
export async function readLinkedProjectId(repoRoot: string): Promise<string | undefined> {
  try {
    const raw = await readFile(join(repoRoot, ".vercel", "project.json"), "utf8");
    const parsed = JSON.parse(raw) as { projectId?: unknown };
    return typeof parsed.projectId === "string" && parsed.projectId.trim()
      ? parsed.projectId.trim()
      : undefined;
  } catch {
    return undefined;
  }
}

/** The working directory Vercel operations run against — mirrors the GitHub seam. */
export function selectedVercelCwd(config: NoMoreIdeConfig, fallbackCwd: string): string {
  const repository =
    config.gitRepositories.find((entry) => entry.name === config.selectedGitRepository)
    ?? config.gitRepositories[0];
  return repository?.activeWorktreePath ?? repository?.path ?? fallbackCwd;
}
