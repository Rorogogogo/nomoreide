import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { GitManager } from "../git-manager.js";
import { matchRegisteredRepository } from "../repo-match.js";
import type { NoMoreIdeConfig } from "../types.js";
import type { DeployProviderHooks, ProviderScope } from "./deploy-provider.js";

/**
 * Which provider project a repository deploys, and which scope to open on.
 *
 * Both algorithms below came from `vercel-context.ts` and neither is
 * vendor-specific — what varies is only the two hooks in
 * {@link DeployProviderHooks}. They are generic over the project and scope
 * types so a caller holding a vendor-shaped client can use them before the
 * `DeployProvider` adapter is wired through to the HTTP surface.
 */

export interface ResolveProjectOptions<P> {
  providerId: string;
  hooks: DeployProviderHooks;
  config: NoMoreIdeConfig;
  gitCwd: string;
  /** Reads one project by id. Rejecting means "not this one", not a failure. */
  getProject: (id: string) => Promise<P>;
  /** Looks a project up by the URL the vendor keys imports by. */
  findByRepoUrl: (repoUrl: string) => Promise<P | undefined>;
}

/**
 * The project this repository deploys, in order of confidence:
 *
 * 1. an explicit pin the user chose in the dashboard;
 * 2. the vendor CLI's own link file — the same file the CLI trusts, so a linked
 *    repo needs no configuration here at all;
 * 3. a lookup by the repo's git remote, which is how the provider itself keys
 *    an imported project.
 *
 * Returns undefined rather than guessing when none of those answer, since the
 * wrong project would show deployments for unrelated code.
 */
export async function resolveProviderProject<P>(
  options: ResolveProjectOptions<P>,
): Promise<P | undefined> {
  const { providerId, hooks, config, gitCwd, getProject, findByRepoUrl } = options;
  const git = new GitManager(gitCwd);
  const topLevel = await git.root().catch(() => gitCwd);

  const repository = await matchRegisteredRepository(config, topLevel).catch(() => undefined);
  const pinned = repository?.providerProjects?.[providerId];
  if (pinned) {
    const project = await getProject(pinned).catch(() => undefined);
    if (project) return project;
  }

  if (hooks.linkFile) {
    const linkedId = await readLinkedProjectId(topLevel, hooks.linkFile);
    if (linkedId) {
      const project = await getProject(linkedId).catch(() => undefined);
      if (project) return project;
    }
  }

  const remoteUrl = await git.remoteUrl("origin").catch(() => null);
  const repoUrl = remoteUrl ? hooks.repoUrl(remoteUrl) : null;
  if (repoUrl) {
    const project = await findByRepoUrl(repoUrl).catch(() => undefined);
    if (project) return project;
  }

  return undefined;
}

/** The project id recorded by the vendor CLI's link command, when present. */
export async function readLinkedProjectId(
  repoRoot: string,
  linkFile: { path: string; field: string },
): Promise<string | undefined> {
  try {
    const raw = await readFile(join(repoRoot, ...linkFile.path.split("/")), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const value = parsed[linkFile.field];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** The working directory provider operations run against — mirrors the GitHub seam. */
export function selectedProviderCwd(config: NoMoreIdeConfig, fallbackCwd: string): string {
  const repository =
    config.gitRepositories.find((entry) => entry.name === config.selectedGitRepository)
    ?? config.gitRepositories[0];
  return repository?.activeWorktreePath ?? repository?.path ?? fallbackCwd;
}

export interface AdoptSoleScopeOptions<S extends Pick<ProviderScope, "id" | "slug">> {
  /** A `cli` credential follows the vendor CLI's own scope; see below. */
  source: "cli" | "stored" | "oauth";
  listScopes: () => Promise<S[]>;
  persist: (scope: { scopeId: string; scopeSlug: string }) => Promise<void>;
}

/**
 * The scope to use when the user has never chosen one.
 *
 * Vercel puts a personal account's projects under an implicit "<name>'s
 * projects" team, not under the account itself, so an unscoped client lists
 * nothing at all — which reads as "no projects" rather than "wrong scope". Any
 * provider with an implicit default scope has this problem. A `cli` connection
 * avoids it by inheriting the CLI's own scope; a browser sign-in or a pasted
 * token has nothing to inherit, so the sole scope is adopted here and
 * persisted, making this a one-time lookup.
 *
 * With several scopes there is no unambiguous answer, so none is chosen and the
 * dashboard's scope switcher is left to ask. Failures are swallowed: an
 * unscoped client still works, and the caller's own request should be what
 * surfaces an auth problem.
 */
export async function adoptSoleScope<S extends Pick<ProviderScope, "id" | "slug">>(
  options: AdoptSoleScopeOptions<S>,
): Promise<string | undefined> {
  // A `cli` connection follows the CLI's own scope, so persisting one here
  // would override the vendor's own `switch` command from then on.
  if (options.source === "cli") return undefined;
  try {
    const scopes = await options.listScopes();
    if (scopes.length !== 1) return undefined;
    const [scope] = scopes;
    await options.persist({ scopeId: scope.id, scopeSlug: scope.slug });
    return scope.id;
  } catch {
    return undefined;
  }
}
