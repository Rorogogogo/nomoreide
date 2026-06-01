import { requestJson } from "./client.js";

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

// --- Token & OAuth ---

export interface GitHubTokenInfo {
  configured: boolean;
  deviceFlowAvailable: boolean;
}

export async function getGitHubTokenInfo(): Promise<GitHubTokenInfo> {
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
  const res = await requestJson<{ ok: true } & GitHubDeviceFlowStart>(
    "/api/github/oauth/start",
    { method: "POST" },
  );
  return res;
}

export async function pollGitHubDeviceFlow(
  device_code: string,
): Promise<{ done: boolean; slowDown?: boolean }> {
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
  const body = new URLSearchParams({ host, token });
  await requestJson("/api/github/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
}

export async function removeGitHubToken(host: string): Promise<void> {
  await requestJson(`/api/github/token/${encodeURIComponent(host)}`, { method: "DELETE" });
}

// --- Pull Requests ---

export async function listGitHubPRs(state = "open", page = 1): Promise<GitHubPR[]> {
  const res = await requestJson<{ ok: true; prs: GitHubPR[] }>(
    `/api/github/prs?state=${state}&page=${page}`,
  );
  return res.prs;
}

export async function getGitHubPR(number: number): Promise<GitHubPR> {
  const res = await requestJson<{ ok: true; pr: GitHubPR }>(`/api/github/prs/${number}`);
  return res.pr;
}

export async function getGitHubPRDiff(number: number): Promise<string> {
  const response = await fetch(`/api/github/prs/${number}/diff`);
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText })) as { error?: string };
    throw new Error(body.error || "Unable to load PR diff");
  }
  return response.text();
}

export async function createGitHubPR(opts: {
  title: string;
  body?: string;
  head: string;
  base: string;
  draft?: boolean;
}): Promise<GitHubPR> {
  const res = await requestJson<{ ok: true; pr: GitHubPR }>("/api/github/prs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(opts),
  });
  return res.pr;
}

// --- Issues ---

export async function listGitHubIssues(state = "open", page = 1): Promise<GitHubIssue[]> {
  const res = await requestJson<{ ok: true; issues: GitHubIssue[] }>(
    `/api/github/issues?state=${state}&page=${page}`,
  );
  return res.issues;
}

export async function getGitHubIssue(number: number): Promise<GitHubIssue> {
  const res = await requestJson<{ ok: true; issue: GitHubIssue }>(`/api/github/issues/${number}`);
  return res.issue;
}

export async function listGitHubIssueComments(number: number): Promise<GitHubComment[]> {
  const res = await requestJson<{ ok: true; comments: GitHubComment[] }>(
    `/api/github/issues/${number}/comments`,
  );
  return res.comments;
}

export async function addGitHubIssueComment(number: number, body: string): Promise<GitHubComment> {
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
  const res = await requestJson<{ ok: true; issue: GitHubIssue }>("/api/github/issues", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(opts),
  });
  return res.issue;
}

// --- CI / Actions ---

export async function getCommitCIStatus(sha: string): Promise<CommitCIStatus> {
  const res = await requestJson<{ ok: true; status: CommitCIStatus }>(
    `/api/github/ci/${encodeURIComponent(sha)}`,
  );
  return res.status;
}

export async function listGitHubWorkflowRuns(branch?: string, page = 1): Promise<GitHubWorkflowRun[]> {
  const params = new URLSearchParams({ page: String(page) });
  if (branch) params.set("branch", branch);
  const res = await requestJson<{ ok: true; runs: GitHubWorkflowRun[] }>(
    `/api/github/runs?${params}`,
  );
  return res.runs;
}
