/**
 * Read-safe Vercel REST client — the agent-reachable half of the integration.
 *
 * Like {@link ./git-manager.js GitManager}, this module deliberately contains
 * no operation that changes what is deployed. Redeploy / cancel / promote /
 * rollback live in `vercel-actions.ts` behind an explicit human-driven route,
 * so an agent holding these tools can observe a deploy but never ship one.
 */

import { providerApiBase } from "./providers/api-base.js";
import type { ProviderFetch } from "./providers/egress.js";

export type VercelDeploymentState =
  | "BUILDING"
  | "ERROR"
  | "INITIALIZING"
  | "QUEUED"
  | "READY"
  | "CANCELED"
  | "BLOCKED"
  | "DELETED";

export interface VercelViewer {
  id: string;
  username: string;
  name?: string | null;
  email?: string | null;
  avatar?: string | null;
}

export interface VercelTeam {
  id: string;
  slug: string;
  name: string | null;
}

/** A project's Git connection, when it was imported from a repository. */
export interface VercelProjectLink {
  type: string;
  org?: string;
  repo?: string;
  productionBranch?: string;
}

export interface VercelProject {
  id: string;
  name: string;
  framework?: string | null;
  updatedAt?: number;
  link?: VercelProjectLink;
  /**
   * How the project builds. Null means "not overridden", which Vercel renders
   * as the framework's own default — a meaningful state, so it is kept
   * distinct from the field being absent.
   */
  buildCommand?: string | null;
  devCommand?: string | null;
  installCommand?: string | null;
  outputDirectory?: string | null;
  rootDirectory?: string | null;
  nodeVersion?: string | null;
  serverlessFunctionRegion?: string | null;
}

/**
 * A project environment variable, with its value deliberately absent.
 *
 * Listing answers "is this key set, and where" — the question a failed deploy
 * actually raises. The value is a separate, explicitly-requested read (see
 * {@link VercelManager.getEnvValue}), so merely opening the tab never puts a
 * secret on the wire.
 */
export interface VercelEnvVar {
  id: string;
  key: string;
  /** `production` / `preview` / `development`. */
  target: string[];
  /** `encrypted` / `plain` / `system` / `secret`. */
  type: string;
  /** Set when the variable is scoped to one preview branch. */
  gitBranch?: string | null;
  comment?: string | null;
  createdAt?: number;
  updatedAt?: number;
}

export interface VercelDomain {
  name: string;
  apexName?: string;
  verified: boolean;
  /** Set when the domain is a redirect rather than a served alias. */
  redirect?: string | null;
  gitBranch?: string | null;
  createdAt?: number;
  updatedAt?: number;
  /** Outstanding DNS records the user must add, when unverified. */
  verification: VercelDomainVerification[];
}

export interface VercelDomainVerification {
  type: string;
  domain: string;
  value: string;
  reason?: string;
}

export interface VercelRuntimeLogLine {
  id: string;
  createdAt: number;
  /** `error` / `warning` / `info`. */
  level: string;
  message: string;
  source?: string;
  statusCode?: number;
  requestMethod?: string;
  requestPath?: string;
}

export interface VercelDeployment {
  uid: string;
  name: string;
  url: string | null;
  state: VercelDeploymentState;
  /** `production` / `staging`; null is a preview deployment. */
  target: string | null;
  createdAt: number;
  readyAt?: number;
  /** True while this deployment serves the project's production alias. */
  isCurrentProduction?: boolean;
  creator?: { username?: string; email?: string };
  meta: {
    branch?: string;
    sha?: string;
    commitMessage?: string;
    commitAuthor?: string;
  };
  inspectorUrl?: string;
}

export interface VercelDeploymentDetail extends VercelDeployment {
  aliases: string[];
  buildingAt?: number;
  errorMessage?: string;
}

export interface VercelBuildLogLine {
  id: string;
  createdAt: number;
  /** `stdout` / `stderr` / `command` / `delimiter` / … */
  type: string;
  text: string;
}

export class VercelApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly path: string,
  ) {
    super(message);
    this.name = "VercelApiError";
  }
}

/** Vercel exposes a repo's project via the exact remote URL it was imported with. */
export function vercelRepoUrl(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim().replace(/\.git$/, "").replace(/\/$/, "");
  const ssh = /^git@([^:]+):(.+)$/.exec(trimmed);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
  if (/^https?:\/\//.test(trimmed)) return trimmed.replace(/^http:/, "https:");
  return null;
}

export interface VercelManagerOptions {
  /**
   * Where account identity comes from. `user` (the default) is Vercel's
   * `/v2/user`; `oidc` is the issuer's userinfo endpoint, which is what an
   * OAuth browser sign-in answers on.
   */
  identity?: "user" | "oidc";
  /**
   * The provider's scoped `fetch` (see `providers/egress.ts`). Absent means
   * global `fetch` — the case for a manager built directly in a test. Production
   * clients come from `vercel-context.ts`, which always supplies one.
   */
  fetch?: ProviderFetch;
}

/** Vercel's API, or the loopback stand-in an environment override names. */
export function vercelApiBase(): string {
  return providerApiBase("NOMOREIDE_VERCEL_API_BASE", "https://api.vercel.com");
}

export class VercelManager {
  constructor(
    private readonly token: string,
    private readonly teamId?: string,
    private readonly baseUrl = vercelApiBase(),
    private readonly options: VercelManagerOptions = {},
  ) {}

  /**
   * The signed-in account.
   *
   * `/v2/user` is the account endpoint for CLI and personal-access tokens, but
   * a browser sign-in has no legacy user record behind it and gets a 404 there.
   * Those tokens answer at the issuer's OIDC userinfo endpoint instead. The
   * caller states which it holds rather than having this infer it from a failed
   * request, so a genuine authorization error still surfaces as one.
   */
  async viewer(): Promise<VercelViewer> {
    if (this.options.identity === "oidc") return this.oidcViewer();
    const data = await this.request<{ user: VercelViewer }>("/v2/user");
    return data.user;
  }

  private async oidcViewer(): Promise<VercelViewer> {
    const response = await (this.options.fetch ?? fetch)(
      `${this.baseUrl}/login/oauth/userinfo`,
      { headers: { Authorization: `Bearer ${this.token}`, Accept: "application/json" } },
    );
    if (!response.ok) {
      throw new VercelApiError(
        `Vercel rejected the sign-in (HTTP ${response.status}).`,
        response.status,
        "/login/oauth/userinfo",
      );
    }
    const claims = (await response.json()) as {
      sub?: string;
      preferred_username?: string;
      email?: string;
      picture?: string;
    };
    return {
      id: claims.sub ?? "",
      username: claims.preferred_username ?? claims.email ?? "vercel",
      email: claims.email ?? null,
      avatar: claims.picture ?? null,
    };
  }

  async listTeams(): Promise<VercelTeam[]> {
    const data = await this.request<{ teams?: RawTeam[] }>("/v2/teams?limit=100");
    return (data.teams ?? []).map((team) => ({
      id: team.id,
      slug: team.slug,
      name: team.name ?? null,
    }));
  }

  async listProjects(opts: { search?: string; repoUrl?: string; limit?: number } = {}): Promise<VercelProject[]> {
    const params = new URLSearchParams({ limit: String(opts.limit ?? 50) });
    if (opts.search) params.set("search", opts.search);
    if (opts.repoUrl) params.set("repoUrl", opts.repoUrl);
    const data = await this.request<{ projects?: RawProject[] } | RawProject[]>(
      `/v10/projects?${params}`,
    );
    const projects = Array.isArray(data) ? data : data.projects ?? [];
    return projects.map(normalizeProject);
  }

  async getProject(idOrName: string): Promise<VercelProject> {
    return normalizeProject(
      await this.request<RawProject>(`/v9/projects/${encodeURIComponent(idOrName)}`),
    );
  }

  async listDeployments(opts: {
    projectId: string;
    target?: "production" | "preview";
    limit?: number;
  }): Promise<VercelDeployment[]> {
    const params = new URLSearchParams({
      projectId: opts.projectId,
      limit: String(opts.limit ?? 20),
    });
    // Vercel has no `preview` target filter — preview deployments are the ones
    // with a null target, so they're filtered client-side below.
    if (opts.target === "production") params.set("target", "production");
    const data = await this.request<{ deployments?: RawDeployment[] }>(
      `/v7/deployments?${params}`,
    );
    const deployments = (data.deployments ?? []).map(normalizeDeployment);
    return opts.target === "preview"
      ? deployments.filter((deployment) => deployment.target !== "production")
      : deployments;
  }

  async getDeployment(idOrUrl: string): Promise<VercelDeploymentDetail> {
    const data = await this.request<RawDeployment>(
      `/v13/deployments/${encodeURIComponent(idOrUrl)}?withGitRepoInfo=true`,
    );
    return {
      ...normalizeDeployment(data),
      aliases: data.alias ?? [],
      buildingAt: data.buildingAt,
      errorMessage: data.errorMessage ?? undefined,
    };
  }

  /**
   * Build logs for a deployment. Requested without `follow`, so the endpoint
   * answers as a one-shot JSON document instead of an open event stream — the
   * dashboard polls while a build is running rather than holding a socket.
   */
  async deploymentBuildLogs(idOrUrl: string, limit = 500): Promise<VercelBuildLogLine[]> {
    const params = new URLSearchParams({
      builds: "1",
      direction: "backward",
      limit: String(limit),
    });
    const raw = await this.request<string>(
      `/v3/deployments/${encodeURIComponent(idOrUrl)}/events?${params}`,
      { accept: "text/plain" },
    );
    return parseBuildLogEvents(raw);
  }

  /**
   * The project's environment variables, without their values.
   *
   * `decrypt` is left off, so Vercel returns encrypted variables as ciphertext
   * — but plain and system ones would still come back readable, so the value is
   * dropped here for every type rather than for some of them. One door for
   * reading a value keeps that door easy to audit.
   */
  async listEnv(projectId: string): Promise<VercelEnvVar[]> {
    const data = await this.request<{ envs?: RawEnvVar[] } | RawEnvVar[]>(
      `/v9/projects/${encodeURIComponent(projectId)}/env?limit=200`,
    );
    const envs = Array.isArray(data) ? data : data.envs ?? [];
    return envs.map(normalizeEnvVar).sort((a, b) => a.key.localeCompare(b.key));
  }

  /**
   * One variable's decrypted value.
   *
   * Deliberately a single-key read rather than a `decrypt=true` list: the
   * dashboard reveals one row at a time on an explicit click, and nothing else
   * in the app has a reason to hold every secret at once.
   */
  async getEnvValue(projectId: string, envId: string): Promise<string> {
    const data = await this.request<RawEnvVar>(
      `/v9/projects/${encodeURIComponent(projectId)}/env/${encodeURIComponent(envId)}`,
    );
    return data.value ?? "";
  }

  async listDomains(projectId: string): Promise<VercelDomain[]> {
    const data = await this.request<{ domains?: RawDomain[] }>(
      `/v9/projects/${encodeURIComponent(projectId)}/domains?limit=100`,
    );
    return (data.domains ?? []).map(normalizeDomain);
  }

  /**
   * Runtime (function) logs, as opposed to build logs: why a deployed request
   * failed, rather than why the build did.
   *
   * This endpoint is not available on every plan and answers NDJSON rather than
   * JSON, so the caller gets an empty list for a 402/403/404 instead of an
   * error — an absent capability is not a broken dashboard. Genuine auth
   * failures still throw.
   */
  async deploymentRuntimeLogs(idOrUrl: string, limit = 200): Promise<VercelRuntimeLogLine[]> {
    const params = new URLSearchParams({ limit: String(limit) });
    try {
      const raw = await this.request<string>(
        `/v1/deployments/${encodeURIComponent(idOrUrl)}/runtime-logs?${params}`,
        { accept: "text/plain" },
      );
      return parseRuntimeLogEvents(raw);
    } catch (error) {
      if (error instanceof VercelApiError && RUNTIME_LOGS_UNAVAILABLE.has(error.status)) {
        return [];
      }
      throw error;
    }
  }

  private request<T>(
    path: string,
    opts?: { method?: string; body?: unknown; accept?: string },
  ): Promise<T> {
    return vercelRequest<T>(
      { token: this.token, teamId: this.teamId, baseUrl: this.baseUrl, fetch: this.options.fetch },
      path,
      opts,
    );
  }
}

export interface VercelRequestAuth {
  token: string;
  teamId?: string;
  baseUrl?: string;
  /**
   * The provider's scoped `fetch` (see `providers/egress.ts`). Absent means
   * global `fetch` — the case for a manager built directly in a test. Production
   * clients come from `vercel-context.ts`, which always supplies one.
   */
  fetch?: ProviderFetch;
}

/**
 * The one place a Vercel API call is made. Shared with `vercel-actions.ts` so
 * auth, team scoping, and error shaping stay identical across the read and
 * write halves — the read/write boundary is which module exposes an operation,
 * not which one can reach the network.
 */
export async function vercelRequest<T>(
  auth: VercelRequestAuth,
  path: string,
  opts?: { method?: string; body?: unknown; accept?: string },
): Promise<T> {
  const url = new URL(
    path.startsWith("http") ? path : `${auth.baseUrl ?? vercelApiBase()}${path}`,
  );
  if (auth.teamId) url.searchParams.set("teamId", auth.teamId);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${auth.token}`,
    Accept: opts?.accept ?? "application/json",
  };
  const init: RequestInit = { method: opts?.method ?? "GET", headers };
  if (opts?.body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(opts.body);
  }

  const response = await (auth.fetch ?? fetch)(url, init);
  if (!response.ok) {
    throw new VercelApiError(await readApiError(response, path), response.status, path);
  }
  if (opts?.accept === "text/plain") {
    return (await response.text()) as unknown as T;
  }
  return response.json() as Promise<T>;
}

/**
 * Vercel wraps its failures in `{ error: { code, message } }`. When it sends
 * no message the bare status text ("Not Found") says nothing about what was
 * being asked, so name the request instead — that string is what the dashboard
 * shows the user, and it is the only clue they get.
 */
async function readApiError(response: Response, path: string): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    if (body.error?.message) return body.error.message;
  } catch {
    /* fall through to a description of the request */
  }
  const status = [response.status, response.statusText].filter(Boolean).join(" ");
  return `Vercel returned ${status} for ${path}`;
}

/**
 * The events endpoint answers either a JSON array or newline-delimited JSON
 * depending on how it decides to stream, so both shapes are accepted and
 * anything unparseable is dropped rather than failing the whole log read.
 */
export function parseBuildLogEvents(raw: string): VercelBuildLogLine[] {
  const events: RawEvent[] = [];
  const trimmed = raw.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed) as RawEvent[] | RawEvent;
    events.push(...(Array.isArray(parsed) ? parsed : [parsed]));
  } catch {
    for (const line of trimmed.split("\n")) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line) as RawEvent);
      } catch {
        /* skip partial lines */
      }
    }
  }

  return events
    .map((event, index) => ({
      id: event.payload?.id ?? `${event.created ?? index}-${index}`,
      createdAt: event.payload?.date ?? event.created ?? 0,
      type: event.type ?? "stdout",
      // Build output is ANSI-colored; strip the SGR codes so the log renders
      // as plain text rather than as escape soup. The ESC is the point here.
      //
      // The `typeof` guard is not belt-and-braces: `?? ""` passes a number
      // through, and a build event whose `text` is not a string used to throw
      // `.replace is not a function` out of a log read — an unreadable failure
      // in place of the one line it could not use.
      text:
        typeof event.payload?.text === "string"
          ? // biome-ignore lint/suspicious/noControlCharactersInRegex: matching an ANSI escape sequence requires the ESC character.
            event.payload.text.replace(/\u001b\[[0-9;]*m/g, "").trimEnd()
          : "",
    }))
    .filter((line) => line.text.length > 0)
    .sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Statuses that mean "this account cannot use runtime logs" rather than "the
 * request was wrong": plan-gated (402), not entitled (403), or the endpoint not
 * being served for this deployment (404).
 */
const RUNTIME_LOGS_UNAVAILABLE = new Set([402, 403, 404]);

/**
 * Runtime logs arrive as newline-delimited JSON. Unparseable lines are dropped
 * rather than failing the read — a truncated final line is normal for a stream
 * that was cut off at the limit.
 */
export function parseRuntimeLogEvents(raw: string): VercelRuntimeLogLine[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  const rows: RawRuntimeLog[] = [];
  for (const line of trimmed.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as RawRuntimeLog | RawRuntimeLog[];
      rows.push(...(Array.isArray(parsed) ? parsed : [parsed]));
    } catch {
      /* skip partial lines */
    }
  }

  return rows
    .map((row, index) => ({
      id: row.rowId ?? row.requestId ?? `${row.timestampInMs ?? index}-${index}`,
      createdAt: row.timestampInMs ?? row.timestamp ?? 0,
      level: row.level ?? "info",
      message: (row.message ?? "").trimEnd(),
      source: row.source,
      statusCode: row.statusCode,
      requestMethod: row.requestMethod,
      requestPath: row.requestPath,
    }))
    .filter((line) => line.message.length > 0)
    .sort((a, b) => a.createdAt - b.createdAt);
}

interface RawTeam {
  id: string;
  slug: string;
  name?: string | null;
}

export interface RawEnvVar {
  id?: string;
  key: string;
  value?: string;
  type?: string;
  target?: string[] | string;
  gitBranch?: string | null;
  comment?: string | null;
  createdAt?: number;
  updatedAt?: number;
}

interface RawDomain {
  name: string;
  apexName?: string;
  verified?: boolean;
  redirect?: string | null;
  gitBranch?: string | null;
  createdAt?: number;
  updatedAt?: number;
  verification?: { type?: string; domain?: string; value?: string; reason?: string }[];
}

interface RawRuntimeLog {
  rowId?: string;
  requestId?: string;
  timestampInMs?: number;
  timestamp?: number;
  level?: string;
  message?: string;
  source?: string;
  statusCode?: number;
  requestMethod?: string;
  requestPath?: string;
}

interface RawProject {
  id: string;
  name: string;
  framework?: string | null;
  updatedAt?: number;
  link?: { type?: string; org?: string; repo?: string; productionBranch?: string };
  buildCommand?: string | null;
  devCommand?: string | null;
  installCommand?: string | null;
  outputDirectory?: string | null;
  rootDirectory?: string | null;
  nodeVersion?: string | null;
  serverlessFunctionRegion?: string | null;
}

interface RawDeployment {
  uid?: string;
  id?: string;
  name: string;
  url: string | null;
  readyState?: VercelDeploymentState;
  state?: VercelDeploymentState;
  readySubstate?: string;
  target?: string | null;
  createdAt?: number;
  created?: number;
  ready?: number;
  readyAt?: number;
  buildingAt?: number;
  alias?: string[];
  errorMessage?: string | null;
  inspectorUrl?: string;
  creator?: { username?: string; email?: string };
  meta?: Record<string, string>;
}

interface RawEvent {
  type?: string;
  created?: number;
  payload?: { id?: string; date?: number; text?: string };
}

function normalizeProject(project: RawProject): VercelProject {
  return {
    id: project.id,
    name: project.name,
    framework: project.framework ?? null,
    updatedAt: project.updatedAt,
    link: project.link?.type
      ? {
          type: project.link.type,
          org: project.link.org,
          repo: project.link.repo,
          productionBranch: project.link.productionBranch,
        }
      : undefined,
    // The list endpoint returns these too, but only the single-project read
    // fills them all in; undefined therefore means "not read", while null
    // means Vercel is using the framework default.
    buildCommand: project.buildCommand,
    devCommand: project.devCommand,
    installCommand: project.installCommand,
    outputDirectory: project.outputDirectory,
    rootDirectory: project.rootDirectory,
    nodeVersion: project.nodeVersion,
    serverlessFunctionRegion: project.serverlessFunctionRegion,
  };
}

export function normalizeEnvVar(env: RawEnvVar): VercelEnvVar {
  return {
    id: env.id ?? env.key,
    key: env.key,
    target: Array.isArray(env.target) ? env.target : env.target ? [env.target] : [],
    type: env.type ?? "encrypted",
    gitBranch: env.gitBranch ?? null,
    comment: env.comment ?? null,
    createdAt: env.createdAt,
    updatedAt: env.updatedAt,
  };
}

function normalizeDomain(domain: RawDomain): VercelDomain {
  return {
    name: domain.name,
    apexName: domain.apexName,
    verified: domain.verified ?? false,
    redirect: domain.redirect ?? null,
    gitBranch: domain.gitBranch ?? null,
    createdAt: domain.createdAt,
    updatedAt: domain.updatedAt,
    verification: (domain.verification ?? [])
      .filter((entry) => entry.domain && entry.value)
      .map((entry) => ({
        type: entry.type ?? "TXT",
        domain: entry.domain ?? "",
        value: entry.value ?? "",
        reason: entry.reason,
      })),
  };
}

function normalizeDeployment(deployment: RawDeployment): VercelDeployment {
  const meta = deployment.meta ?? {};
  return {
    uid: deployment.uid ?? deployment.id ?? "",
    name: deployment.name,
    url: deployment.url,
    state: deployment.readyState ?? deployment.state ?? "QUEUED",
    target: deployment.target ?? null,
    createdAt: deployment.createdAt ?? deployment.created ?? 0,
    readyAt: deployment.readyAt ?? deployment.ready,
    // `PROMOTED`/`ROLLING` mark the deployment currently aliased to production;
    // `STAGED` means built for production but not serving it yet.
    isCurrentProduction:
      deployment.target === "production" && deployment.readySubstate !== "STAGED",
    creator: deployment.creator,
    meta: {
      branch: meta.githubCommitRef ?? meta.gitlabCommitRef ?? meta.bitbucketCommitRef,
      sha: meta.githubCommitSha ?? meta.gitlabCommitSha ?? meta.bitbucketCommitSha,
      commitMessage:
        meta.githubCommitMessage ?? meta.gitlabCommitMessage ?? meta.bitbucketCommitMessage,
      commitAuthor:
        meta.githubCommitAuthorName ??
        meta.gitlabCommitAuthorName ??
        meta.bitbucketCommitAuthorName,
    },
    inspectorUrl: deployment.inspectorUrl,
  };
}
