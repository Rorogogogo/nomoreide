import {
  normalizeEnvVar,
  vercelRequest,
  type RawEnvVar,
  type VercelDeployment,
  type VercelEnvVar,
  type VercelRequestAuth,
} from "./vercel-manager.js";

/**
 * Write-capable Vercel operations, deliberately separate from the read-safe
 * {@link VercelManager} — the same split as `git-manager` / `git-actions` and
 * `db-peek` / `db-write`.
 *
 * Everything here changes what the internet is serving, so none of it is
 * exposed as an MCP tool: these are reached only from the dashboard's own
 * routes, where a human clicked the button. Callers are expected to confirm
 * production-affecting actions (`promote`, `rollback`, `deleteEnv`) before
 * invoking them.
 *
 * Still intentionally excludes the irreversible ones — deleting deployments or
 * projects — which would need their own guarded surface.
 */
export class VercelActions {
  constructor(private readonly auth: VercelRequestAuth) {}

  /**
   * Rebuild an existing deployment. Vercel inherits the original's settings,
   * env, and git ref, minting a new deployment id — it never mutates the one
   * being retried, so this is safe to offer on a failed build.
   *
   * `target` carries the original's environment through: without it a redeploy
   * of a production deployment would come back as a preview.
   */
  async redeploy(deployment: Pick<VercelDeployment, "uid" | "name" | "target">): Promise<{
    uid: string;
    url: string | null;
  }> {
    const created = await this.request<{ id?: string; uid?: string; url: string | null }>(
      "/v13/deployments?forceNew=1",
      {
        method: "POST",
        body: {
          deploymentId: deployment.uid,
          name: deployment.name,
          ...(deployment.target ? { target: deployment.target } : {}),
        },
      },
    );
    return { uid: created.uid ?? created.id ?? "", url: created.url };
  }

  /** Stop an in-flight build. A finished deployment cannot be canceled (Vercel 400s). */
  async cancel(deploymentId: string): Promise<void> {
    await this.request(`/v12/deployments/${encodeURIComponent(deploymentId)}/cancel`, {
      method: "PATCH",
    });
  }

  /**
   * Point the project's production alias at an existing deployment without
   * rebuilding it. This is what "Promote to Production" does in the Vercel
   * dashboard, and it takes effect immediately.
   */
  async promote(projectId: string, deploymentId: string): Promise<void> {
    await this.request(
      `/v10/projects/${encodeURIComponent(projectId)}/promote/${encodeURIComponent(deploymentId)}`,
      { method: "POST" },
    );
  }

  /**
   * Roll production back *to* an earlier deployment. Distinct from `promote`
   * on the API side: it records a rollback (with its reason) rather than a
   * forward promotion, which is what the project's rollback history reads back.
   */
  async rollback(
    projectId: string,
    deploymentId: string,
    description?: string,
  ): Promise<void> {
    const path = `/v1/projects/${encodeURIComponent(projectId)}/rollback/${encodeURIComponent(deploymentId)}`;
    const params = description ? `?description=${encodeURIComponent(description)}` : "";
    await this.request(`${path}${params}`, { method: "POST" });
  }

  /**
   * Add a new variable. `type` defaults to `encrypted` (Vercel's "Sensitive"),
   * which never reads back over the API — `plain` is for values a build script
   * needs to see, not secrets.
   */
  async createEnv(
    projectId: string,
    input: { key: string; value: string; target: string[]; type?: "encrypted" | "plain" },
  ): Promise<VercelEnvVar> {
    const created = await this.request<RawEnvVar | { created?: RawEnvVar[] }>(
      `/v10/projects/${encodeURIComponent(projectId)}/env`,
      {
        method: "POST",
        body: {
          key: input.key,
          value: input.value,
          target: input.target,
          type: input.type ?? "encrypted",
        },
      },
    );
    const raw =
      "created" in created && created.created?.[0] ? created.created[0] : (created as RawEnvVar);
    return normalizeEnvVar(raw);
  }

  /**
   * Change a variable's value and/or the environments it applies to. The key
   * itself is not editable here — Vercel does not support renaming in place,
   * so a rename is a delete-and-recreate the UI does not offer as one step.
   */
  async updateEnv(
    projectId: string,
    envId: string,
    input: { value?: string; target?: string[] },
  ): Promise<VercelEnvVar> {
    const body: Record<string, unknown> = {};
    if (input.value !== undefined) body.value = input.value;
    if (input.target !== undefined) body.target = input.target;
    const raw = await this.request<RawEnvVar>(
      `/v9/projects/${encodeURIComponent(projectId)}/env/${encodeURIComponent(envId)}`,
      { method: "PATCH", body },
    );
    return normalizeEnvVar(raw);
  }

  async deleteEnv(projectId: string, envId: string): Promise<void> {
    await this.request(
      `/v9/projects/${encodeURIComponent(projectId)}/env/${encodeURIComponent(envId)}`,
      { method: "DELETE" },
    );
  }

  private request<T>(path: string, opts: { method: string; body?: unknown }): Promise<T> {
    return vercelRequest<T>(this.auth, path, opts);
  }
}

export const VERCEL_ACTIONS = ["redeploy", "cancel", "promote", "rollback"] as const;
export type VercelActionName = (typeof VERCEL_ACTIONS)[number];

/** Actions that change what production serves — the UI confirms these first. */
export const PRODUCTION_AFFECTING_ACTIONS: ReadonlySet<VercelActionName> = new Set([
  "promote",
  "rollback",
]);
