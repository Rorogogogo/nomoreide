import {
  cloudflareRequest,
  type CloudflareEnvVar,
  type CloudflareRequestAuth,
} from "./cloudflare-manager.js";

/**
 * Write-capable Cloudflare Pages operations, deliberately separate from the
 * read-safe {@link ./cloudflare-manager.js CloudflareManager} — the same split
 * as `git-manager` / `git-actions` and `db-peek` / `db-write`.
 *
 * Everything here changes what the internet is serving, so none of it is
 * exposed as an MCP tool: these are reached only from the dashboard's own
 * routes, where a human clicked the button.
 *
 * Still intentionally excludes the irreversible ones — Cloudflare's
 * `DELETE .../deployments/{id}` and project deletion — which would need their
 * own guarded surface.
 */

/** The only two environments Pages has. A third would be silently created by a PATCH. */
export const CLOUDFLARE_ENVIRONMENTS = ["production", "preview"] as const;
export type CloudflareEnvironment = (typeof CLOUDFLARE_ENVIRONMENTS)[number];

export class CloudflareActions {
  constructor(
    private readonly auth: CloudflareRequestAuth,
    private readonly accountId: string,
  ) {}

  /**
   * Rebuild an existing deployment.
   *
   * Cloudflare calls this "retry" and mints a new deployment id, inheriting the
   * original's branch, commit and environment — so, unlike Vercel's redeploy,
   * nothing has to be carried through by the caller to keep a production retry
   * in production.
   */
  async retry(
    projectName: string,
    deploymentId: string,
  ): Promise<{ id: string; url: string | null }> {
    const created = await this.request<{ id?: string; url?: string | null }>(
      `${this.projectPath(projectName)}/deployments/${encodeURIComponent(deploymentId)}/retry`,
      { method: "POST" },
    );
    return { id: created.id ?? "", url: created.url ?? null };
  }

  /**
   * Point the project's production alias at an earlier deployment without
   * rebuilding it. Cloudflare records this as a rollback, and it takes effect
   * immediately.
   */
  async rollback(
    projectName: string,
    deploymentId: string,
  ): Promise<{ id: string; url: string | null }> {
    const rolled = await this.request<{ id?: string; url?: string | null }>(
      `${this.projectPath(projectName)}/deployments/${encodeURIComponent(deploymentId)}/rollback`,
      { method: "POST" },
    );
    return { id: rolled.id ?? deploymentId, url: rolled.url ?? null };
  }

  /**
   * Add a variable. `secret` (Vercel's "encrypted") is the default, and its
   * value never reads back over the API afterwards.
   */
  createEnv(
    projectName: string,
    input: { key: string; value: string; environments: string[]; secret?: boolean },
  ): Promise<CloudflareEnvVar> {
    const type = input.secret === false ? "plain_text" : "secret_text";
    const patch: EnvPatch = {};
    for (const environment of requireEnvironments(input.environments)) {
      patch[environment] = { [input.key]: { type, value: input.value } };
    }
    return this.patchEnv(projectName, input.key, patch);
  }

  /**
   * Change a variable's value and/or the environments it applies to.
   *
   * Adding an environment needs a value: Cloudflare stores the variable
   * separately per environment and never hands back a secret's value, so there
   * is nothing to copy across. Saying that is better than writing an empty
   * string into the new environment.
   */
  async updateEnv(
    projectName: string,
    key: string,
    input: { value?: string; environments?: string[] },
  ): Promise<CloudflareEnvVar> {
    const current = await this.currentEnv(projectName, key);
    const wanted = input.environments
      ? requireEnvironments(input.environments)
      : (current.environments as CloudflareEnvironment[]);

    const patch: EnvPatch = {};
    for (const environment of wanted) {
      if (input.value !== undefined) {
        patch[environment] = { [key]: { type: current.type, value: input.value } };
      } else if (!current.environments.includes(environment)) {
        throw new Error(
          `Adding "${key}" to ${environment} needs a value — Cloudflare stores it separately per environment.`,
        );
      }
    }
    for (const environment of current.environments) {
      if (!wanted.includes(environment as CloudflareEnvironment)) {
        patch[environment] = { [key]: null };
      }
    }
    return this.patchEnv(projectName, key, patch);
  }

  /** Remove a variable from every environment it is set in. */
  async deleteEnv(projectName: string, key: string): Promise<void> {
    const current = await this.currentEnv(projectName, key);
    const patch: EnvPatch = {};
    for (const environment of current.environments) patch[environment] = { [key]: null };
    await this.patchProject(projectName, patch);
  }

  /**
   * The one write to a project's variables.
   *
   * Cloudflare merges the `env_vars` map it is sent — a key set to `null` is
   * deleted, and keys the patch does not mention are untouched — so this never
   * has to read-modify-write the whole map and cannot clobber a variable added
   * between the read and the write.
   */
  private async patchEnv(
    projectName: string,
    key: string,
    patch: EnvPatch,
  ): Promise<CloudflareEnvVar> {
    const updated = await this.patchProject(projectName, patch);
    const found = updated.find((entry) => entry.key === key);
    if (!found) throw new Error(`Cloudflare did not report "${key}" after the update.`);
    return found;
  }

  private async patchProject(projectName: string, patch: EnvPatch): Promise<CloudflareEnvVar[]> {
    const deploymentConfigs: Record<string, { env_vars: EnvPatchEntry }> = {};
    for (const [environment, envVars] of Object.entries(patch)) {
      if (envVars) deploymentConfigs[environment] = { env_vars: envVars };
    }
    const project = await this.request<RawPatchedProject>(this.projectPath(projectName), {
      method: "PATCH",
      body: { deployment_configs: deploymentConfigs },
    });
    return mergeEnvVars(project.deployment_configs);
  }

  private async currentEnv(projectName: string, key: string): Promise<CloudflareEnvVar> {
    const project = await this.request<RawPatchedProject>(this.projectPath(projectName));
    const found = mergeEnvVars(project.deployment_configs).find((entry) => entry.key === key);
    if (!found) throw new Error(`No variable named "${key}" on this project.`);
    return found;
  }

  private projectPath(projectName: string): string {
    return `/accounts/${this.accountId}/pages/projects/${encodeURIComponent(projectName)}`;
  }

  private request<T>(path: string, opts?: { method?: string; body?: unknown }): Promise<T> {
    return cloudflareRequest<T>(this.auth, path, opts);
  }
}

type EnvPatchEntry = Record<string, { type: string; value: string } | null>;
type EnvPatch = Record<string, EnvPatchEntry | undefined>;

interface RawPatchedProject {
  deployment_configs?: Record<
    string,
    { env_vars?: Record<string, { type?: string; value?: string } | null> | null } | null
  > | null;
}

/**
 * Rejects anything that is not one of Pages' two environments. Vercel's env
 * dialog offers `development` as well, and a PATCH naming it would quietly
 * create a third deployment config that nothing ever reads.
 */
function requireEnvironments(environments: string[]): CloudflareEnvironment[] {
  const invalid = environments.filter(
    (entry) => !CLOUDFLARE_ENVIRONMENTS.includes(entry as CloudflareEnvironment),
  );
  if (invalid.length > 0) {
    throw new Error(
      `Cloudflare Pages only has ${CLOUDFLARE_ENVIRONMENTS.join(" and ")} environments, not ${invalid.join(", ")}.`,
    );
  }
  return environments as CloudflareEnvironment[];
}

/** The read side's flattening, applied to whatever a write handed back. */
function mergeEnvVars(
  configs: RawPatchedProject["deployment_configs"],
): CloudflareEnvVar[] {
  const merged = new Map<string, CloudflareEnvVar>();
  for (const [environment, config] of Object.entries(configs ?? {})) {
    for (const [key, entry] of Object.entries(config?.env_vars ?? {})) {
      if (!entry) continue;
      const type = entry.type === "plain_text" ? "plain_text" : "secret_text";
      const existing = merged.get(key);
      if (existing) {
        existing.environments.push(environment);
        if (type === "secret_text") existing.type = "secret_text";
        continue;
      }
      merged.set(key, { key, environments: [environment], type, value: entry.value });
    }
  }
  return [...merged.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Cloudflare's action vocabulary, mapped onto the names the shared UI already
 * knows. "retry" is Cloudflare's word for what Vercel calls a redeploy, and
 * there is no cancel endpoint for a Pages build at all — so the manifest is
 * two actions, not four, and the deployment row hides what it cannot do.
 */
export const CLOUDFLARE_ACTIONS = ["redeploy", "rollback"] as const;
export type CloudflareActionName = (typeof CLOUDFLARE_ACTIONS)[number];

/** Actions that change what production serves — the UI confirms these first. */
export const PRODUCTION_AFFECTING_ACTIONS: ReadonlySet<CloudflareActionName> = new Set([
  "rollback",
]);
