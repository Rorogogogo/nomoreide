/**
 * All-projects overview — the contract both backends implement. See
 * {@link ./git-api} for the shared-interface seam rationale.
 *
 * Read-only by construction: this is a lens over projects the user already
 * registered, so there is nothing here that changes anything.
 */

import type { ProviderDeploymentState } from "./provider-api.js";

export type OverviewDomain = "git" | "github" | "vercel";

export interface ProjectGitSummary {
  branch: string;
  dirty: number;
  ahead: number;
  behind: number;
  upstream?: string;
}

export interface ProjectGitHubSummary {
  owner: string;
  repo: string;
  openPullRequests: number;
  checks?: "success" | "failure" | "pending";
}

export interface ProjectVercelSummary {
  projectId: string;
  projectName: string;
  state?: ProviderDeploymentState;
  url?: string;
  createdAt?: number;
}

export interface ProjectOverviewEntry {
  name: string;
  path: string;
  cwd: string;
  git?: ProjectGitSummary;
  github?: ProjectGitHubSummary;
  vercel?: ProjectVercelSummary;
  /** Why this one project has no summary; the others still do. */
  error?: string;
}

export interface OverviewApi {
  listProjectOverview(domain: OverviewDomain): Promise<ProjectOverviewEntry[]>;
}
