/**
 * GitHub API contract shared by the browser and embedded desktop daemon clients.
 */

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

export type GitHubConnectionStatus =
  | "checking"
  | "not_configured"
  | "connected"
  /** Credential works, but the signed-in account can't see this repository. */
  | "repo_access"
  | "auth_error"
  | "connection_error";

export interface GitHubCliAccount {
  host: string;
  login: string;
  active: boolean;
  state: string;
}

export type GitHubCredentialSelection =
  | { source: "gh"; host: string; login: string }
  | { source: "stored"; host: string };

export interface GitHubTokenInfo {
  configured: boolean;
  storedConfigured: boolean;
  deviceFlowAvailable: boolean;
  status: Exclude<GitHubConnectionStatus, "checking">;
  error?: string;
  /** Connected account; `avatarUrl` is cached at connect time. */
  user?: { login: string; avatarUrl?: string };
  repository?: { full_name: string; html_url: string };
  repositoryName?: string;
  /** `owner/repo` from the git remote — known even when the API won't show it. */
  repositorySlug?: string;
  accounts: GitHubCliAccount[];
  cliAvailable: boolean;
  cliError?: string;
  selected?: GitHubCredentialSelection;
  credential?: GitHubCredentialSelection;
}

export interface GitHubDeviceFlowStart {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export interface MergePRResult {
  merged: boolean;
  sha: string;
  message: string;
}

export interface CreatePROptions {
  title: string;
  body?: string;
  head: string;
  base: string;
  draft?: boolean;
}

export interface MergePROptions {
  method?: "merge" | "squash" | "rebase";
  commitTitle?: string;
  commitMessage?: string;
}

export interface GitHubApi {
  getGitHubTokenInfo(): Promise<GitHubTokenInfo>;
  startGitHubDeviceFlow(): Promise<GitHubDeviceFlowStart>;
  pollGitHubDeviceFlow(device_code: string): Promise<{ done: boolean; slowDown?: boolean }>;
  setGitHubToken(host: string, token: string): Promise<void>;
  removeGitHubToken(host: string): Promise<void>;
  selectGitHubCredential(
    repository: string,
    credential: GitHubCredentialSelection,
  ): Promise<void>;
  listGitHubBranches(): Promise<GitHubBranchesPayload>;
  listGitHubPRs(state?: string, page?: number): Promise<GitHubPR[]>;
  getGitHubPR(number: number): Promise<GitHubPR>;
  getGitHubPRDiff(number: number): Promise<string>;
  getGitHubPRReviewCockpit(number: number): Promise<GitHubPRReviewCockpit>;
  getGitHubPRTemplate(): Promise<GitHubPRTemplate>;
  createGitHubPR(opts: CreatePROptions): Promise<GitHubPR>;
  /** Merge a PR (squash by default) via the GitHub API — the "Squash & merge" button. */
  mergeGitHubPR(number: number, opts?: MergePROptions): Promise<MergePRResult>;
  listGitHubIssues(state?: string, page?: number): Promise<GitHubIssue[]>;
  getGitHubIssue(number: number): Promise<GitHubIssue>;
  listGitHubIssueComments(number: number): Promise<GitHubComment[]>;
  addGitHubIssueComment(number: number, body: string): Promise<GitHubComment>;
  createGitHubIssue(opts: { title: string; body?: string }): Promise<GitHubIssue>;
  getCommitCIStatus(sha: string): Promise<CommitCIStatus>;
  listGitHubWorkflowRuns(branch?: string, page?: number): Promise<GitHubWorkflowRun[]>;
  listGitHubWorkflowRunJobs(runId: number): Promise<GitHubWorkflowJob[]>;
}
