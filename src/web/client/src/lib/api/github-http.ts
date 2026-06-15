/** Node HTTP-server implementation of {@link GitHubApi} (the web/MCP backend). */
import { requestJson } from "./client.js";
import type {
  CommitCIStatus,
  GitHubApi,
  GitHubBranchesPayload,
  GitHubComment,
  GitHubDeviceFlowStart,
  GitHubIssue,
  GitHubPR,
  GitHubPRReviewCockpit,
  GitHubPRTemplate,
  GitHubTokenInfo,
  GitHubWorkflowJob,
  GitHubWorkflowRun,
  MergePRResult,
} from "./github-api.js";

export const httpGitHubApi: GitHubApi = {
  getGitHubTokenInfo() {
    return requestJson<{ ok: true } & GitHubTokenInfo>("/api/github/token");
  },

  startGitHubDeviceFlow() {
    return requestJson<{ ok: true } & GitHubDeviceFlowStart>("/api/github/oauth/start", {
      method: "POST",
    });
  },

  async pollGitHubDeviceFlow(device_code) {
    const res = await requestJson<{ ok: true; done: boolean; slowDown?: boolean }>(
      "/api/github/oauth/poll",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ device_code }),
      },
    );
    return { done: res.done, slowDown: res.slowDown };
  },

  async setGitHubToken(host, token) {
    const body = new URLSearchParams({ host, token });
    await requestJson("/api/github/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
  },

  async removeGitHubToken(host) {
    await requestJson(`/api/github/token/${encodeURIComponent(host)}`, { method: "DELETE" });
  },

  async listGitHubBranches() {
    const res = await requestJson<{ ok: true } & GitHubBranchesPayload>("/api/github/branches");
    return {
      repository: res.repository,
      defaultBranch: res.defaultBranch,
      currentBranch: res.currentBranch,
      branches: res.branches,
    };
  },

  async listGitHubPRs(state = "open", page = 1) {
    const res = await requestJson<{ ok: true; prs: GitHubPR[] }>(
      `/api/github/prs?state=${state}&page=${page}`,
    );
    return res.prs;
  },

  async getGitHubPR(number) {
    const res = await requestJson<{ ok: true; pr: GitHubPR }>(`/api/github/prs/${number}`);
    return res.pr;
  },

  async getGitHubPRDiff(number) {
    const response = await fetch(`/api/github/prs/${number}/diff`);
    if (!response.ok) {
      const body = (await response
        .json()
        .catch(() => ({ error: response.statusText }))) as { error?: string };
      throw new Error(body.error || "Unable to load PR diff");
    }
    return response.text();
  },

  async getGitHubPRReviewCockpit(number) {
    const res = await requestJson<{ ok: true; cockpit: GitHubPRReviewCockpit }>(
      `/api/github/prs/${number}/review`,
    );
    return res.cockpit;
  },

  async getGitHubPRTemplate() {
    const res = await requestJson<{ ok: true; template: GitHubPRTemplate }>(
      "/api/github/pr-template",
    );
    return res.template;
  },

  async createGitHubPR(opts) {
    const res = await requestJson<{ ok: true; pr: GitHubPR }>("/api/github/prs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(opts),
    });
    return res.pr;
  },

  async mergeGitHubPR(number, opts = {}) {
    const res = await requestJson<{ ok: true } & MergePRResult>(
      `/api/github/prs/${number}/merge`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ method: opts.method ?? "squash", ...opts }),
      },
    );
    return { merged: res.merged, sha: res.sha, message: res.message };
  },

  async listGitHubIssues(state = "open", page = 1) {
    const res = await requestJson<{ ok: true; issues: GitHubIssue[] }>(
      `/api/github/issues?state=${state}&page=${page}`,
    );
    return res.issues;
  },

  async getGitHubIssue(number) {
    const res = await requestJson<{ ok: true; issue: GitHubIssue }>(
      `/api/github/issues/${number}`,
    );
    return res.issue;
  },

  async listGitHubIssueComments(number) {
    const res = await requestJson<{ ok: true; comments: GitHubComment[] }>(
      `/api/github/issues/${number}/comments`,
    );
    return res.comments;
  },

  async addGitHubIssueComment(number, body) {
    const res = await requestJson<{ ok: true; comment: GitHubComment }>(
      `/api/github/issues/${number}/comments`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body }),
      },
    );
    return res.comment;
  },

  async createGitHubIssue(opts) {
    const res = await requestJson<{ ok: true; issue: GitHubIssue }>("/api/github/issues", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(opts),
    });
    return res.issue;
  },

  async getCommitCIStatus(sha) {
    const res = await requestJson<{ ok: true; status: CommitCIStatus }>(
      `/api/github/ci/${encodeURIComponent(sha)}`,
    );
    return res.status;
  },

  async listGitHubWorkflowRuns(branch, page = 1) {
    const params = new URLSearchParams({ page: String(page) });
    if (branch) params.set("branch", branch);
    const res = await requestJson<{ ok: true; runs: GitHubWorkflowRun[] }>(
      `/api/github/runs?${params}`,
    );
    return res.runs;
  },

  async listGitHubWorkflowRunJobs(runId) {
    const res = await requestJson<{ ok: true; jobs: GitHubWorkflowJob[] }>(
      `/api/github/runs/${runId}/jobs`,
    );
    return res.jobs;
  },
};
