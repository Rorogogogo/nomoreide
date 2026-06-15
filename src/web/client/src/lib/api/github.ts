import { requestJson } from "./client.js";
import {
  isTauri,
  tauri_getGithubTokenStatus,
  tauri_setGithubToken,
  tauri_removeGithubToken,
  tauri_getGithubRepo,
  tauri_listPullRequests,
  tauri_listIssues,
  tauri_getPullRequest,
  tauri_createPullRequest,
  tauri_getPrDiff,
  tauri_listPrFiles,
  tauri_listPrReviews,
  tauri_listPrComments,
  tauri_mergePullRequest,
  tauri_getGithubIssue,
  tauri_listIssueComments,
  tauri_addIssueComment,
  tauri_createGithubIssue,
  tauri_listGithubBranches,
  tauri_getGithubRepoInfo,
  tauri_listCommitCheckRuns,
  tauri_listWorkflowRuns,
  tauri_listWorkflowRunJobs,
  tauri_githubOAuthStart,
  tauri_githubOAuthPoll,
} from "./tauri-bridge.js";

export interface GitHubPR {
  number: number;
  title: string;
  state: "open" | "closed" | "merged";
  body: string | null;
  html_url: string;
  head: { ref: string; sha: string };
  base: { ref: string };
  user: { login: string };
  created_at: string;
  updated_at: string;
  merged_at: string | null;
  draft: boolean;
  mergeable: boolean | null;
}

export interface GitHubIssue {
  number: number;
  title: string;
  state: "open" | "closed";
  body: string | null;
  html_url: string;
  user: { login: string };
  labels: Array<{ name: string; color: string }>;
  created_at: string;
  updated_at: string;
  comments: number;
}

export interface GitHubComment {
  id: number;
  body: string;
  user: { login: string };
  created_at: string;
  html_url: string;
}

export interface GitHubPRFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
  blob_url: string;
}

export interface GitHubPRReview {
  id: number;
  state: string;
  body: string | null;
  user: { login: string };
  submitted_at: string | null;
  html_url: string;
}

export interface GitHubBranchInfo {
  name: string;
  protected: boolean;
  commit: { sha: string };
}

export interface GitHubBranchesPayload {
  repository: { full_name: string; html_url: string; default_branch?: string };
  defaultBranch: string | null;
  currentBranch: string | null;
  branches: GitHubBranchInfo[];
}

export interface GitHubCheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  html_url: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface CommitCIStatus {
  sha: string;
  state: "pending" | "success" | "failure" | "error" | "unknown";
  totalCount: number;
  runs: GitHubCheckRun[];
}

export interface GitHubPRTemplateFile {
  path: string;
  status: string;
  additions?: number;
  deletions?: number;
  changes?: number;
}

export interface GitHubPRTemplateCommit {
  sha: string;
  message: string;
}

export interface GitHubPRTemplate {
  repository: { full_name: string; html_url: string; default_branch?: string } | null;
  currentBranch: string | null;
  suggestedBase: string;
  base: string;
  head: string;
  title: string;
  body: string;
  draft: boolean;
  compare: {
    base: string;
    head: string;
    aheadBy: number;
    headSha: string | null;
    commits: GitHubPRTemplateCommit[];
    files: GitHubPRTemplateFile[];
    ciStatus?: CommitCIStatus;
  };
  warnings: string[];
}

export interface GitHubPRReviewCockpit {
  pr: GitHubPR;
  files: GitHubPRFile[];
  reviews: GitHubPRReview[];
  comments: GitHubComment[];
  checks: CommitCIStatus;
}

export interface GitHubWorkflowRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  html_url: string;
  head_sha: string;
  head_branch: string;
  created_at: string;
  updated_at: string;
  run_number: number;
  event: string;
}

export interface GitHubWorkflowJobStep {
  name: string;
  status: string;
  conclusion: string | null;
  number: number;
  started_at: string | null;
  completed_at: string | null;
}

export interface GitHubWorkflowJob {
  id: number;
  run_id: number;
  html_url: string;
  status: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
  name: string;
  steps: GitHubWorkflowJobStep[];
}

// --- Token & OAuth ---

export type GitHubConnectionStatus =
  | "checking"
  | "not_configured"
  | "connected"
  | "auth_error"
  | "connection_error";

export interface GitHubTokenInfo {
  configured: boolean;
  deviceFlowAvailable: boolean;
  status: Exclude<GitHubConnectionStatus, "checking">;
  error?: string;
  user?: { login: string };
  repository?: { full_name: string; html_url: string };
}

export async function getGitHubTokenInfo(): Promise<GitHubTokenInfo> {
  if (isTauri()) {
    const raw = await tauri_getGithubTokenStatus() as { configured: boolean; host?: string };
    return {
      configured: raw.configured,
      deviceFlowAvailable: true,
      status: raw.configured ? "connected" : "not_configured",
    };
  }
  return requestJson<{ ok: true } & GitHubTokenInfo>("/api/github/token");
}

export interface GitHubDeviceFlowStart {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export async function startGitHubDeviceFlow(): Promise<GitHubDeviceFlowStart> {
  if (isTauri()) {
    const res = await tauri_githubOAuthStart("Iv23liCxW0Mv0KJP1Svr"); // public device flow client id
    return res as GitHubDeviceFlowStart;
  }
  const res = await requestJson<{ ok: true } & GitHubDeviceFlowStart>(
    "/api/github/oauth/start",
    { method: "POST" },
  );
  return res;
}

export async function pollGitHubDeviceFlow(
  device_code: string,
): Promise<{ done: boolean; slowDown?: boolean }> {
  if (isTauri()) {
    const res = await tauri_githubOAuthPoll("Iv23liCxW0Mv0KJP1Svr", device_code) as {
      access_token?: string; token_type?: string; error?: string;
    };
    if (res.access_token) {
      // Store the token via the Rust backend
      await tauri_setGithubToken("github.com", res.access_token);
      return { done: true };
    }
    return { done: false, slowDown: res.error === "slow_down" };
  }
  const res = await requestJson<{ ok: true; done: boolean; slowDown?: boolean }>(
    "/api/github/oauth/poll",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_code }),
    },
  );
  return { done: res.done, slowDown: res.slowDown };
}

export async function setGitHubToken(host: string, token: string): Promise<void> {
  if (isTauri()) { await tauri_setGithubToken(host, token); return; }
  const body = new URLSearchParams({ host, token });
  await requestJson("/api/github/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
}

export async function removeGitHubToken(host: string): Promise<void> {
  if (isTauri()) { await tauri_removeGithubToken(host); return; }
  await requestJson(`/api/github/token/${encodeURIComponent(host)}`, { method: "DELETE" });
}

// --- Branches ---

export async function listGitHubBranches(): Promise<GitHubBranchesPayload> {
  if (isTauri()) {
    const [owner, repo] = await tauri_getGithubRepo();
    const [branches, repoInfo] = await Promise.all([
      tauri_listGithubBranches(owner, repo) as Promise<GitHubBranchInfo[]>,
      tauri_getGithubRepoInfo(owner, repo) as Promise<{ full_name?: string; html_url?: string; default_branch?: string }>,
    ]);
    return {
      repository: { full_name: repoInfo.full_name ?? `${owner}/${repo}`, html_url: repoInfo.html_url ?? "", default_branch: repoInfo.default_branch },
      defaultBranch: repoInfo.default_branch ?? null,
      currentBranch: null,
      branches: Array.isArray(branches) ? branches : [],
    };
  }
  const res = await requestJson<{ ok: true } & GitHubBranchesPayload>("/api/github/branches");
  return {
    repository: res.repository,
    defaultBranch: res.defaultBranch,
    currentBranch: res.currentBranch,
    branches: res.branches,
  };
}

// --- Pull Requests ---

export async function listGitHubPRs(state = "open", page = 1): Promise<GitHubPR[]> {
  if (isTauri()) {
    const [owner, repo] = await tauri_getGithubRepo();
    const prs = await tauri_listPullRequests(owner, repo, state);
    return (prs as GitHubPR[]).slice((page - 1) * 50, page * 50);
  }
  const res = await requestJson<{ ok: true; prs: GitHubPR[] }>(
    `/api/github/prs?state=${state}&page=${page}`,
  );
  return res.prs;
}

export async function getGitHubPR(number: number): Promise<GitHubPR> {
  if (isTauri()) {
    const [owner, repo] = await tauri_getGithubRepo();
    return tauri_getPullRequest(owner, repo, number) as Promise<GitHubPR>;
  }
  const res = await requestJson<{ ok: true; pr: GitHubPR }>(`/api/github/prs/${number}`);
  return res.pr;
}

export async function getGitHubPRDiff(number: number): Promise<string> {
  if (isTauri()) {
    const [owner, repo] = await tauri_getGithubRepo();
    return tauri_getPrDiff(owner, repo, number);
  }
  const response = await fetch(`/api/github/prs/${number}/diff`);
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText })) as { error?: string };
    throw new Error(body.error || "Unable to load PR diff");
  }
  return response.text();
}

export async function getGitHubPRReviewCockpit(number: number): Promise<GitHubPRReviewCockpit> {
  if (isTauri()) {
    const [owner, repo] = await tauri_getGithubRepo();
    const pr = await tauri_getPullRequest(owner, repo, number) as GitHubPR;
    const [files, reviews, comments, checkRuns] = await Promise.all([
      tauri_listPrFiles(owner, repo, number) as Promise<GitHubPRFile[]>,
      tauri_listPrReviews(owner, repo, number) as Promise<GitHubPRReview[]>,
      tauri_listPrComments(owner, repo, number) as Promise<GitHubComment[]>,
      tauri_listCommitCheckRuns(owner, repo, pr.head.sha) as Promise<{ total_count?: number; check_runs?: GitHubCheckRun[] }>,
    ]);
    const runs = checkRuns.check_runs ?? [];
    const allConclusions = runs.map((r) => r.conclusion);
    const state: CommitCIStatus["state"] =
      runs.length === 0 ? "unknown"
      : allConclusions.every((c) => c === "success") ? "success"
      : allConclusions.some((c) => c === "failure" || c === "cancelled") ? "failure"
      : "pending";
    return {
      pr,
      files: Array.isArray(files) ? files : [],
      reviews: Array.isArray(reviews) ? reviews : [],
      comments: Array.isArray(comments) ? comments : [],
      checks: { sha: pr.head.sha, state, totalCount: checkRuns.total_count ?? runs.length, runs },
    };
  }
  const res = await requestJson<{ ok: true; cockpit: GitHubPRReviewCockpit }>(
    `/api/github/prs/${number}/review`,
  );
  return res.cockpit;
}

export async function getGitHubPRTemplate(): Promise<GitHubPRTemplate> {
  if (isTauri()) {
    const [owner, repo] = await tauri_getGithubRepo();
    const repoInfo = await tauri_getGithubRepoInfo(owner, repo) as { full_name?: string; html_url?: string; default_branch?: string };
    const defaultBranch = repoInfo.default_branch ?? "main";
    return {
      repository: { full_name: repoInfo.full_name ?? `${owner}/${repo}`, html_url: repoInfo.html_url ?? "", default_branch: repoInfo.default_branch },
      currentBranch: null,
      suggestedBase: defaultBranch,
      base: defaultBranch,
      head: "",
      title: "",
      body: "",
      draft: false,
      compare: { base: defaultBranch, head: "", aheadBy: 0, headSha: null, commits: [], files: [] },
      warnings: [],
    };
  }
  const res = await requestJson<{ ok: true; template: GitHubPRTemplate }>("/api/github/pr-template");
  return res.template;
}

export async function createGitHubPR(opts: {
  title: string;
  body?: string;
  head: string;
  base: string;
  draft?: boolean;
}): Promise<GitHubPR> {
  if (isTauri()) {
    const [owner, repo] = await tauri_getGithubRepo();
    return tauri_createPullRequest({
      owner, repo,
      title: opts.title,
      body: opts.body ?? "",
      head: opts.head,
      base: opts.base,
      draft: opts.draft,
    }) as Promise<GitHubPR>;
  }
  const res = await requestJson<{ ok: true; pr: GitHubPR }>("/api/github/prs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(opts),
  });
  return res.pr;
}

export interface MergePRResult {
  merged: boolean;
  sha: string;
  message: string;
}

/** Merge a PR (squash by default) via the GitHub API — the "Squash & merge" button. */
export async function mergeGitHubPR(
  number: number,
  opts: { method?: "merge" | "squash" | "rebase"; commitTitle?: string; commitMessage?: string } = {},
): Promise<MergePRResult> {
  if (isTauri()) {
    const [owner, repo] = await tauri_getGithubRepo();
    const res = await tauri_mergePullRequest(owner, repo, number, opts) as MergePRResult;
    return res;
  }
  const res = await requestJson<{ ok: true } & MergePRResult>(
    `/api/github/prs/${number}/merge`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method: opts.method ?? "squash", ...opts }),
    },
  );
  return { merged: res.merged, sha: res.sha, message: res.message };
}

// --- Issues ---

export async function listGitHubIssues(state = "open", page = 1): Promise<GitHubIssue[]> {
  if (isTauri()) {
    const [owner, repo] = await tauri_getGithubRepo();
    const issues = await tauri_listIssues(owner, repo, state);
    return (issues as GitHubIssue[]).slice((page - 1) * 50, page * 50);
  }
  const res = await requestJson<{ ok: true; issues: GitHubIssue[] }>(
    `/api/github/issues?state=${state}&page=${page}`,
  );
  return res.issues;
}

export async function getGitHubIssue(number: number): Promise<GitHubIssue> {
  if (isTauri()) {
    const [owner, repo] = await tauri_getGithubRepo();
    return tauri_getGithubIssue(owner, repo, number) as Promise<GitHubIssue>;
  }
  const res = await requestJson<{ ok: true; issue: GitHubIssue }>(`/api/github/issues/${number}`);
  return res.issue;
}

export async function listGitHubIssueComments(number: number): Promise<GitHubComment[]> {
  if (isTauri()) {
    const [owner, repo] = await tauri_getGithubRepo();
    return tauri_listIssueComments(owner, repo, number) as Promise<GitHubComment[]>;
  }
  const res = await requestJson<{ ok: true; comments: GitHubComment[] }>(
    `/api/github/issues/${number}/comments`,
  );
  return res.comments;
}

export async function addGitHubIssueComment(number: number, body: string): Promise<GitHubComment> {
  if (isTauri()) {
    const [owner, repo] = await tauri_getGithubRepo();
    return tauri_addIssueComment(owner, repo, number, body) as Promise<GitHubComment>;
  }
  const res = await requestJson<{ ok: true; comment: GitHubComment }>(
    `/api/github/issues/${number}/comments`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body }),
    },
  );
  return res.comment;
}

export async function createGitHubIssue(opts: { title: string; body?: string }): Promise<GitHubIssue> {
  if (isTauri()) {
    const [owner, repo] = await tauri_getGithubRepo();
    return tauri_createGithubIssue(owner, repo, opts.title, opts.body) as Promise<GitHubIssue>;
  }
  const res = await requestJson<{ ok: true; issue: GitHubIssue }>("/api/github/issues", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(opts),
  });
  return res.issue;
}

// --- CI / Actions ---

export async function getCommitCIStatus(sha: string): Promise<CommitCIStatus> {
  if (isTauri()) {
    const [owner, repo] = await tauri_getGithubRepo();
    const raw = await tauri_listCommitCheckRuns(owner, repo, sha) as { total_count?: number; check_runs?: GitHubCheckRun[] };
    const runs = raw.check_runs ?? [];
    const allConclusions = runs.map((r) => r.conclusion);
    const state: CommitCIStatus["state"] =
      runs.length === 0 ? "unknown"
      : allConclusions.every((c) => c === "success") ? "success"
      : allConclusions.some((c) => c === "failure" || c === "cancelled") ? "failure"
      : "pending";
    return { sha, state, totalCount: raw.total_count ?? runs.length, runs };
  }
  const res = await requestJson<{ ok: true; status: CommitCIStatus }>(
    `/api/github/ci/${encodeURIComponent(sha)}`,
  );
  return res.status;
}

export async function listGitHubWorkflowRuns(branch?: string, page = 1): Promise<GitHubWorkflowRun[]> {
  if (isTauri()) {
    const [owner, repo] = await tauri_getGithubRepo();
    const raw = await tauri_listWorkflowRuns(owner, repo, branch, page) as { workflow_runs?: GitHubWorkflowRun[] };
    return raw.workflow_runs ?? [];
  }
  const params = new URLSearchParams({ page: String(page) });
  if (branch) params.set("branch", branch);
  const res = await requestJson<{ ok: true; runs: GitHubWorkflowRun[] }>(
    `/api/github/runs?${params}`,
  );
  return res.runs;
}

export async function listGitHubWorkflowRunJobs(runId: number): Promise<GitHubWorkflowJob[]> {
  if (isTauri()) {
    const [owner, repo] = await tauri_getGithubRepo();
    const raw = await tauri_listWorkflowRunJobs(owner, repo, runId) as { jobs?: GitHubWorkflowJob[] };
    return raw.jobs ?? [];
  }
  const res = await requestJson<{ ok: true; jobs: GitHubWorkflowJob[] }>(
    `/api/github/runs/${runId}/jobs`,
  );
  return res.jobs;
}
