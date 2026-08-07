/**
 * All-projects overview entry point. Picks the backend implementation once at
 * module load (`isTauri()` → Rust core, else Node HTTP) and re-exports its
 * methods — never a per-function `if (isTauri())` branch.
 */
import { requestJson } from "./client.js";
import { isTauri, tauri_projectOverview } from "./tauri-bridge.js";
import type { OverviewApi, ProjectOverviewEntry } from "./overview-api.js";

const httpOverviewApi: OverviewApi = {
  async listProjectOverview(domain) {
    const res = await requestJson<{ ok: true; projects: ProjectOverviewEntry[] }>(
      `/api/overview/${domain}`,
    );
    return res.projects;
  },
};

const tauriOverviewApi: OverviewApi = {
  async listProjectOverview(domain) {
    return ((await tauri_projectOverview(domain)) ?? []) as ProjectOverviewEntry[];
  },
};

const api: OverviewApi = isTauri() ? tauriOverviewApi : httpOverviewApi;

export const { listProjectOverview } = api;

export type {
  ProjectGitHubSummary,
  ProjectGitSummary,
  OverviewApi,
  OverviewDomain,
  ProjectOverviewEntry,
  ProjectVercelSummary,
} from "./overview-api.js";
