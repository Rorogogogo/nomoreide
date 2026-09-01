/** All-projects overview API entry point shared by browser and desktop. */
import { requestJson } from "./client.js";
import type { OverviewApi, ProjectOverviewEntry } from "./overview-api.js";

const httpOverviewApi: OverviewApi = {
  async listProjectOverview(domain) {
    const res = await requestJson<{ ok: true; projects: ProjectOverviewEntry[] }>(
      `/api/overview/${domain}`,
    );
    return res.projects;
  },
};

const api: OverviewApi = httpOverviewApi;

export const { listProjectOverview } = api;

export type {
  ProjectGitHubSummary,
  ProjectGitSummary,
  OverviewApi,
  OverviewDomain,
  ProjectOverviewEntry,
  ProjectVercelSummary,
} from "./overview-api.js";
