/**
 * Read-safe Cloudflare Pages REST client — the agent-reachable half of the
 * integration, and the mirror of `vercel-manager.ts`.
 *
 * Like {@link ./git-manager.js GitManager}, nothing here changes what is
 * deployed: retry / rollback and the environment-variable writes live in
 * `cloudflare-actions.ts` behind the dashboard's guarded route.
 *
 * Two shapes of Cloudflare's API drive most of what looks odd below:
 *
 * 1. **Everything is account-scoped.** Vercel's `teamId` is optional; a
 *    Cloudflare account id is in the path of every Pages call, so an unscoped
 *    client can answer `viewer()` and `listAccounts()` and nothing else.
 * 2. **Projects are addressed by name, deployments only within a project.**
 *    There is no global deployment endpoint, which is why every deployment read
 *    here takes the project name.
 */

import type { ProviderFetch } from "./providers/egress.js";

/** Cloudflare wraps every response; `result` is the payload. */
interface CloudflareEnvelope<T> {
  success?: boolean;
  errors?: { code?: number; message?: string }[];
  result?: T;
}

export interface CloudflareUser {
  id: string;
  email?: string | null;
  username?: string | null;
}

export interface CloudflareAccount {
  id: string;
  name: string;
}

/** A project's Git connection, when it was imported from a repository. */
export interface CloudflareSource {
  type: string;
  owner?: string;
  repoName?: string;
  productionBranch?: string;
}

export interface CloudflareProject {
  /** Cloudflare's own UUID. Not what the API addresses the project by — see {@link name}. */
  uuid: string;
  /** The path segment every project-scoped call uses. */
  name: string;
  framework?: string | null;
  productionBranch?: string | null;
  createdAt?: number;
  updatedAt?: number;
  source?: CloudflareSource;
  /**
   * Build settings. Null means "not set", which Cloudflare renders as its own
   * default — distinct from the field being absent, though in practice the list
   * and single-project endpoints return the same shape, unlike Vercel's.
   */
  buildCommand?: string | null;
  destinationDir?: string | null;
  rootDir?: string | null;
  /** Per-environment variables, embedded in the project rather than listed separately. */
  envVars: CloudflareEnvVar[];
}

/**
 * One variable, already merged across the environments it appears in.
 *
 * Cloudflare stores these as a `{ NAME: { type, value } }` map per environment,
 * so the same key in production and preview is two entries there and one here.
 * `value` is present only for `plain_text`; a `secret_text` value never reads
 * back over the API at all.
 */
export interface CloudflareEnvVar {
  key: string;
  environments: string[];
  type: "plain_text" | "secret_text";
  value?: string;
}

export interface CloudflareDeploymentStage {
  name: string;
  status: string;
}

export interface CloudflareDeployment {
  id: string;
  shortId?: string;
  projectName: string;
  url: string | null;
  environment: string;
  stage: CloudflareDeploymentStage;
  isSkipped: boolean;
  createdAt: number;
  modifiedAt?: number;
  aliases: string[];
  branch?: string;
  commitHash?: string;
  commitMessage?: string;
}

export interface CloudflareBuildLogLine {
  id: string;
  createdAt: number;
  text: string;
}

export interface CloudflareDomain {
  name: string;
  status: string;
  createdAt?: number;
  /** Set when validation is outstanding — the DNS record the user must add. */
  validation?: { method?: string; status?: string; txtName?: string; txtValue?: string };
  errorMessage?: string;
}

export class CloudflareApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly path: string,
    /** Cloudflare's own numeric error code, when it sent one. */
    public readonly code?: number,
  ) {
    super(message);
    this.name = "CloudflareApiError";
  }
}

/**
 * Cloudflare keys an imported project by owner and repository name rather than
 * by a URL, so the "repo url" this provider matches on is `owner/repo`.
 *
 * The contract calls this a repo *URL* because that is what Vercel wants; what
 * it actually means is "the string this vendor recognizes a repository by", and
 * only {@link CloudflareManager.findProjectByRepo} ever interprets it.
 */
export function cloudflareRepoUrl(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim().replace(/\.git$/, "").replace(/\/$/, "");
  const ssh = /^[\w.-]+@[^:]+:(?<path>.+)$/.exec(trimmed);
  const path = ssh?.groups?.path ?? trimmed.replace(/^https?:\/\/[^/]+\//, "");
  const parts = path.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  return parts.slice(-2).join("/").toLowerCase();
}

export class CloudflareManager {
  constructor(
    private readonly token: string,
    private readonly accountId?: string,
    private readonly baseUrl = "https://api.cloudflare.com/client/v4",
    /** The provider's scoped `fetch`; global `fetch` when built outside the registry. */
    private readonly fetchImpl?: ProviderFetch,
  ) {}

  /**
   * The signed-in account.
   *
   * `/user` needs a token carrying User Details Read, which a project-scoped
   * API token typically does not have. Rather than fail the whole dashboard
   * over an identity nicety, a rejected `/user` falls back to the token's own
   * verification and the selected account's name.
   */
  async viewer(): Promise<CloudflareUser> {
    try {
      const user = await this.request<CloudflareUser & { email?: string }>("/user");
      return { id: user.id, email: user.email ?? null, username: user.username ?? user.email };
    } catch (error) {
      if (!(error instanceof CloudflareApiError) || error.status >= 500) throw error;
      return this.tokenViewer(error);
    }
  }

  /**
   * Identity for a token that cannot read `/user`. `/user/tokens/verify` is
   * answerable by every API token, so a failure there is a genuine auth error
   * and is left to propagate.
   */
  private async tokenViewer(cause: CloudflareApiError): Promise<CloudflareUser> {
    const verified = await this.request<{ id?: string; status?: string }>("/user/tokens/verify");
    if (verified.status && verified.status !== "active") {
      throw new CloudflareApiError(
        `This Cloudflare API token is ${verified.status}.`,
        401,
        "/user/tokens/verify",
        cause.code,
      );
    }
    const accounts = await this.listAccounts().catch(() => []);
    const account = accounts.find((entry) => entry.id === this.accountId) ?? accounts[0];
    return {
      id: verified.id ?? this.accountId ?? "",
      email: null,
      username: account?.name ?? "Cloudflare API token",
    };
  }

  async listAccounts(): Promise<CloudflareAccount[]> {
    const accounts = await this.request<{ id: string; name?: string }[]>("/accounts?per_page=50");
    return accounts.map((account) => ({ id: account.id, name: account.name ?? account.id }));
  }

  /**
   * Every project in the account.
   *
   * Cloudflare has no search or repository filter on this endpoint, so both are
   * applied here. That is a page of extra bytes, not a page of extra requests —
   * the list endpoint returns whole project objects either way.
   */
  async listProjects(
    opts: { search?: string; repoUrl?: string; limit?: number } = {},
  ): Promise<CloudflareProject[]> {
    const perPage = Math.min(Math.max(opts.limit ?? 50, 1), 100);
    const raw = await this.request<RawProject[]>(
      `/accounts/${this.account()}/pages/projects?per_page=${perPage}`,
    );
    let projects = raw.map(normalizeProject);
    if (opts.search) {
      const needle = opts.search.toLowerCase();
      projects = projects.filter((project) => project.name.toLowerCase().includes(needle));
    }
    if (opts.repoUrl) {
      const wanted = opts.repoUrl.toLowerCase();
      projects = projects.filter((project) => repoSlug(project) === wanted);
    }
    return projects;
  }

  /** The project a repository deploys, matched on `owner/repo`. */
  async findProjectByRepo(repoUrl: string): Promise<CloudflareProject | undefined> {
    return (await this.listProjects({ repoUrl, limit: 100 }))[0];
  }

  async getProject(name: string): Promise<CloudflareProject> {
    return normalizeProject(
      await this.request<RawProject>(
        `/accounts/${this.account()}/pages/projects/${encodeURIComponent(name)}`,
      ),
    );
  }

  async listDeployments(opts: {
    projectName: string;
    env?: "production" | "preview";
    limit?: number;
  }): Promise<CloudflareDeployment[]> {
    const params = new URLSearchParams({ per_page: String(Math.min(opts.limit ?? 20, 100)) });
    if (opts.env) params.set("env", opts.env);
    const raw = await this.request<RawDeployment[]>(
      `${this.projectPath(opts.projectName)}/deployments?${params}`,
    );
    return raw.map(normalizeDeployment);
  }

  async getDeployment(projectName: string, deploymentId: string): Promise<CloudflareDeployment> {
    return normalizeDeployment(
      await this.request<RawDeployment>(
        `${this.projectPath(projectName)}/deployments/${encodeURIComponent(deploymentId)}`,
      ),
    );
  }

  /**
   * The deployment that currently serves production, which Cloudflare records
   * on the project rather than on the deployment. A rollback moves it, so it
   * cannot be inferred from "the newest successful production build".
   */
  async canonicalDeploymentId(projectName: string): Promise<string | undefined> {
    const raw = await this.request<RawProject>(
      `/accounts/${this.account()}/pages/projects/${encodeURIComponent(projectName)}`,
    );
    return raw.canonical_deployment?.id ?? raw.latest_deployment?.id;
  }

  async deploymentBuildLogs(
    projectName: string,
    deploymentId: string,
    limit = 500,
  ): Promise<CloudflareBuildLogLine[]> {
    const data = await this.request<{ data?: { ts?: string; line?: string }[] }>(
      `${this.projectPath(projectName)}/deployments/${encodeURIComponent(deploymentId)}/history/logs`,
    );
    const lines = (data.data ?? [])
      .map((entry, index) => ({
        id: `${entry.ts ?? index}-${index}`,
        createdAt: epochMs(entry.ts) ?? 0,
        text: (entry.line ?? "").trimEnd(),
      }))
      .filter((line) => line.text.length > 0);
    // Cloudflare returns the whole build; the caller's limit is the tail of it,
    // which is where a failure's cause is.
    return lines.slice(-limit);
  }

  /** Variables for the project, keys and environments only — values are dropped. */
  async listEnv(projectName: string): Promise<CloudflareEnvVar[]> {
    const project = await this.getProject(projectName);
    return project.envVars.map(({ value: _value, ...rest }) => rest);
  }

  /**
   * One variable's value.
   *
   * Cloudflare returns `plain_text` values in the project payload but never a
   * `secret_text` one — the value is write-only. So this can answer for the
   * former and must say so plainly for the latter, rather than returning an
   * empty string the UI would render as "this secret is blank".
   */
  async getEnvValue(projectName: string, key: string): Promise<string> {
    const project = await this.getProject(projectName);
    const variable = project.envVars.find((entry) => entry.key === key);
    if (!variable) throw new Error(`No variable named "${key}" on this project.`);
    if (variable.type === "secret_text") {
      throw new Error("Cloudflare never returns a secret's value. Set a new one to change it.");
    }
    return variable.value ?? "";
  }

  async listDomains(projectName: string): Promise<CloudflareDomain[]> {
    const raw = await this.request<RawDomain[]>(`${this.projectPath(projectName)}/domains`);
    return raw.map(normalizeDomain);
  }

  /** The dashboard page for a deployment, which Cloudflare does not return. */
  inspectorUrl(projectName: string, deploymentId: string): string | undefined {
    if (!this.accountId) return undefined;
    return `https://dash.cloudflare.com/${this.accountId}/pages/view/${encodeURIComponent(projectName)}/${encodeURIComponent(deploymentId)}`;
  }

  private projectPath(projectName: string): string {
    return `/accounts/${this.account()}/pages/projects/${encodeURIComponent(projectName)}`;
  }

  /**
   * The account every Pages path needs. Throwing here rather than sending a
   * request with `undefined` in the URL is what turns "no account chosen" into
   * a sentence the scope switcher answers.
   */
  private account(): string {
    if (!this.accountId) {
      throw new Error("Choose a Cloudflare account before reading its Pages projects.");
    }
    return this.accountId;
  }

  private request<T>(path: string, opts?: { method?: string; body?: unknown }): Promise<T> {
    return cloudflareRequest<T>(
      { token: this.token, baseUrl: this.baseUrl, fetch: this.fetchImpl },
      path,
      opts,
    );
  }
}

export interface CloudflareRequestAuth {
  token: string;
  baseUrl?: string;
  /**
   * The provider's scoped `fetch` (see `providers/egress.ts`). Absent means
   * global `fetch` — the case for a manager built directly in a test. Production
   * clients come from `cloudflare-context.ts`, which always supplies one.
   */
  fetch?: ProviderFetch;
}

/**
 * The one place a Cloudflare API call is made. Shared with
 * `cloudflare-actions.ts` so auth and error shaping stay identical across the
 * read and write halves — the read/write boundary is which module exposes an
 * operation, not which one can reach the network.
 */
export async function cloudflareRequest<T>(
  auth: CloudflareRequestAuth,
  path: string,
  opts?: { method?: string; body?: unknown },
): Promise<T> {
  const url = path.startsWith("http")
    ? path
    : `${auth.baseUrl ?? "https://api.cloudflare.com/client/v4"}${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${auth.token}`,
    Accept: "application/json",
  };
  const init: RequestInit = { method: opts?.method ?? "GET", headers };
  if (opts?.body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(opts.body);
  }

  const response = await (auth.fetch ?? fetch)(url, init);
  const body = (await response.json().catch(() => ({}))) as CloudflareEnvelope<T>;
  // Cloudflare can answer 200 with `success: false`, so the envelope decides,
  // not the status line.
  if (!response.ok || body.success === false) {
    const failure = body.errors?.[0];
    throw new CloudflareApiError(
      failure?.message ?? `Cloudflare returned ${response.status} for ${path}`,
      response.status,
      path,
      failure?.code,
    );
  }
  return body.result as T;
}

interface RawEnvVarEntry {
  type?: string;
  value?: string;
}

interface RawDeploymentConfig {
  env_vars?: Record<string, RawEnvVarEntry | null> | null;
}

interface RawProject {
  id: string;
  name: string;
  framework?: string | null;
  production_branch?: string | null;
  created_on?: string;
  subdomain?: string;
  build_config?: {
    build_command?: string | null;
    destination_dir?: string | null;
    root_dir?: string | null;
  } | null;
  deployment_configs?: Record<string, RawDeploymentConfig | null> | null;
  source?: {
    type?: string;
    config?: { owner?: string; repo_name?: string; production_branch?: string };
  } | null;
  canonical_deployment?: { id?: string } | null;
  latest_deployment?: { id?: string; modified_on?: string } | null;
}

interface RawDeployment {
  id: string;
  short_id?: string;
  project_name?: string;
  url?: string | null;
  environment?: string;
  is_skipped?: boolean;
  created_on?: string;
  modified_on?: string;
  aliases?: string[] | null;
  latest_stage?: { name?: string; status?: string } | null;
  deployment_trigger?: {
    metadata?: { branch?: string; commit_hash?: string; commit_message?: string };
  } | null;
}

interface RawDomain {
  name: string;
  status?: string;
  created_on?: string;
  validation_data?: {
    method?: string;
    status?: string;
    txt_name?: string;
    txt_value?: string;
    error_message?: string;
  } | null;
  verification_data?: { status?: string; error_message?: string } | null;
}

/** Cloudflare timestamps are RFC 3339 strings; everything downstream wants epoch ms. */
function epochMs(value: string | undefined | null): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

const repoSlug = (project: CloudflareProject): string | undefined =>
  project.source?.owner && project.source.repoName
    ? `${project.source.owner}/${project.source.repoName}`.toLowerCase()
    : undefined;

/**
 * Flattens the per-environment `{ NAME: { type, value } }` maps into one entry
 * per key, carrying every environment it appears in. A key that is plain text
 * in one environment and a secret in another is reported as a secret, because
 * the stricter of the two is the one that governs whether a value may be read.
 */
function normalizeEnvVars(
  configs: Record<string, RawDeploymentConfig | null> | null | undefined,
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
        if (existing.value === undefined) existing.value = entry.value;
        continue;
      }
      merged.set(key, { key, environments: [environment], type, value: entry.value });
    }
  }
  return [...merged.values()].sort((a, b) => a.key.localeCompare(b.key));
}

function normalizeProject(project: RawProject): CloudflareProject {
  const build = project.build_config ?? {};
  return {
    uuid: project.id,
    name: project.name,
    framework: project.framework ?? null,
    productionBranch: project.production_branch ?? null,
    createdAt: epochMs(project.created_on),
    updatedAt: epochMs(project.latest_deployment?.modified_on) ?? epochMs(project.created_on),
    source: project.source?.type
      ? {
          type: project.source.type,
          owner: project.source.config?.owner,
          repoName: project.source.config?.repo_name,
          productionBranch:
            project.source.config?.production_branch ?? project.production_branch ?? undefined,
        }
      : undefined,
    // Cloudflare always sends the whole `build_config`, so a null here really
    // does mean "not set" rather than "not read".
    buildCommand: build.build_command ?? null,
    destinationDir: build.destination_dir ?? null,
    rootDir: build.root_dir ?? null,
    envVars: normalizeEnvVars(project.deployment_configs),
  };
}

function normalizeDeployment(deployment: RawDeployment): CloudflareDeployment {
  const trigger = deployment.deployment_trigger?.metadata ?? {};
  return {
    id: deployment.id,
    shortId: deployment.short_id,
    projectName: deployment.project_name ?? "",
    // Cloudflare returns a full URL where the contract wants a bare hostname.
    url: deployment.url ? deployment.url.replace(/^https?:\/\//, "").replace(/\/$/, "") : null,
    environment: deployment.environment ?? "preview",
    stage: {
      name: deployment.latest_stage?.name ?? "queued",
      status: deployment.latest_stage?.status ?? "idle",
    },
    isSkipped: deployment.is_skipped ?? false,
    createdAt: epochMs(deployment.created_on) ?? 0,
    modifiedAt: epochMs(deployment.modified_on),
    aliases: (deployment.aliases ?? []).map((alias) =>
      alias.replace(/^https?:\/\//, "").replace(/\/$/, ""),
    ),
    branch: trigger.branch,
    commitHash: trigger.commit_hash,
    commitMessage: trigger.commit_message,
  };
}

function normalizeDomain(domain: RawDomain): CloudflareDomain {
  const validation = domain.validation_data ?? undefined;
  return {
    name: domain.name,
    status: domain.status ?? "pending",
    createdAt: epochMs(domain.created_on),
    validation: validation
      ? {
          method: validation.method,
          status: validation.status,
          txtName: validation.txt_name,
          txtValue: validation.txt_value,
        }
      : undefined,
    errorMessage: validation?.error_message ?? domain.verification_data?.error_message,
  };
}
