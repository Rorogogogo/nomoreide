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
  pull_request?: object;
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

export interface GitHubViewer {
  login: string;
  /** Public avatar URL; cached at connect time so status calls stay free. */
  avatar_url?: string;
  /** Numeric account id — the stable half of GitHub's `noreply` commit address. */
  id?: number;
  /** Display name; null when the account has not set one. */
  name?: string | null;
  /** Public commit address; null when the account keeps its email private. */
  email?: string | null;
}

export interface GitHubRepoInfo {
  full_name: string;
  html_url: string;
  default_branch?: string;
}

export interface GitHubCompareCommit {
  sha: string;
  message: string;
}

export interface GitHubCompareFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
}

export interface GitHubCompareSummary {
  status: string;
  aheadBy: number;
  headSha: string | null;
  commits: GitHubCompareCommit[];
  files: GitHubCompareFile[];
}

export class GitHubApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly path: string,
  ) {
    super(message);
    this.name = "GitHubApiError";
  }
}

export class GitHubManager {
  constructor(
    private readonly token: string,
    private readonly owner: string,
    private readonly repo: string,
    private readonly baseUrl = "https://api.github.com",
  ) {}

  static parseRemoteUrl(remoteUrl: string): { owner: string; repo: string } | null {
    const trimmed = remoteUrl.trim();
    // https://github.com/owner/repo[.git]
    const httpsMatch = /^https?:\/\/(?:[^@]+@)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/)?$/.exec(trimmed);
    if (httpsMatch) {
      return { owner: httpsMatch[1]!, repo: httpsMatch[2]! };
    }
    // git@github.com:owner/repo[.git]
    const sshMatch = /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/.exec(trimmed);
    if (sshMatch) {
      return { owner: sshMatch[1]!, repo: sshMatch[2]! };
    }
    return null;
  }

  async viewer(): Promise<GitHubViewer> {
    return this.request<GitHubViewer>("/user");
  }

  async repoInfo(): Promise<GitHubRepoInfo> {
    return this.request<GitHubRepoInfo>(`/repos/${this.owner}/${this.repo}`);
  }

  async compareBranches(base: string, head: string): Promise<GitHubCompareSummary> {
    const data = await this.request<RawCompare>(
      `/repos/${this.owner}/${this.repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
    );
    return {
      status: data.status,
      aheadBy: data.ahead_by,
      commits: data.commits.map((commit) => ({
        sha: commit.sha,
        message: firstLine(commit.commit.message),
      })),
      files: (data.files ?? []).map((file) => ({
        path: file.filename,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes,
      })),
      headSha: data.commits.at(-1)?.sha ?? null,
    };
  }

  async listBranches(): Promise<GitHubBranchInfo[]> {
    const data = await this.request<RawBranch[]>(
      `/repos/${this.owner}/${this.repo}/branches?per_page=100`,
    );
    return data.map((branch) => ({
      name: branch.name,
      protected: branch.protected,
      commit: { sha: branch.commit.sha },
    }));
  }

  async listPRs(state: "open" | "closed" | "all" = "open", page = 1): Promise<GitHubPR[]> {
    const data = await this.request<RawPR[]>(
      `/repos/${this.owner}/${this.repo}/pulls?state=${state}&per_page=30&page=${page}`,
    );
    return data.map(normalizePR);
  }

  async getPR(number: number): Promise<GitHubPR> {
    const data = await this.request<RawPR>(
      `/repos/${this.owner}/${this.repo}/pulls/${number}`,
    );
    return normalizePR(data);
  }

  async getPRDiff(number: number): Promise<string> {
    return this.request<string>(
      `/repos/${this.owner}/${this.repo}/pulls/${number}`,
      { accept: "application/vnd.github.diff" },
    );
  }

  async listPRFiles(number: number): Promise<GitHubPRFile[]> {
    const data = await this.request<RawPRFile[]>(
      `/repos/${this.owner}/${this.repo}/pulls/${number}/files?per_page=100`,
    );
    return data.map((file) => ({
      path: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.changes,
      patch: file.patch,
      blob_url: file.blob_url,
    }));
  }

  async listPRReviews(number: number): Promise<GitHubPRReview[]> {
    return this.request<GitHubPRReview[]>(
      `/repos/${this.owner}/${this.repo}/pulls/${number}/reviews?per_page=100`,
    );
  }

  async createPR(opts: {
    title: string;
    body?: string;
    head: string;
    base: string;
    draft?: boolean;
  }): Promise<GitHubPR> {
    const data = await this.request<RawPR>(
      `/repos/${this.owner}/${this.repo}/pulls`,
      { method: "POST", body: opts },
    );
    return normalizePR(data);
  }

  /**
   * Merge a pull request via the GitHub API. Defaults to a squash merge — the
   * common "Squash & merge" button behavior. GitHub rejects the call (405) if
   * the PR isn't mergeable (conflicts, failing required checks, branch
   * protection), and that message is surfaced to the caller.
   */
  async mergePR(
    number: number,
    opts: { method?: "merge" | "squash" | "rebase"; commitTitle?: string; commitMessage?: string } = {},
  ): Promise<{ merged: boolean; sha: string; message: string }> {
    return this.request<{ merged: boolean; sha: string; message: string }>(
      `/repos/${this.owner}/${this.repo}/pulls/${number}/merge`,
      {
        method: "PUT",
        body: {
          merge_method: opts.method ?? "squash",
          ...(opts.commitTitle ? { commit_title: opts.commitTitle } : {}),
          ...(opts.commitMessage ? { commit_message: opts.commitMessage } : {}),
        },
      },
    );
  }

  async listIssues(state: "open" | "closed" | "all" = "open", page = 1): Promise<GitHubIssue[]> {
    const data = await this.request<GitHubIssue[]>(
      `/repos/${this.owner}/${this.repo}/issues?state=${state}&per_page=30&page=${page}`,
    );
    // Filter out PRs (issues endpoint includes them)
    return data.filter((issue) => !issue.pull_request);
  }

  async getIssue(number: number): Promise<GitHubIssue> {
    return this.request<GitHubIssue>(
      `/repos/${this.owner}/${this.repo}/issues/${number}`,
    );
  }

  async createIssue(opts: { title: string; body?: string }): Promise<GitHubIssue> {
    return this.request<GitHubIssue>(
      `/repos/${this.owner}/${this.repo}/issues`,
      { method: "POST", body: opts },
    );
  }

  async listIssueComments(number: number): Promise<GitHubComment[]> {
    return this.request<GitHubComment[]>(
      `/repos/${this.owner}/${this.repo}/issues/${number}/comments?per_page=100`,
    );
  }

  async addIssueComment(number: number, body: string): Promise<GitHubComment> {
    return this.request<GitHubComment>(
      `/repos/${this.owner}/${this.repo}/issues/${number}/comments`,
      { method: "POST", body: { body } },
    );
  }

  async getCommitChecks(sha: string): Promise<CommitCIStatus> {
    try {
      const data = await this.request<{ total_count: number; check_runs: GitHubCheckRun[] }>(
        `/repos/${this.owner}/${this.repo}/commits/${sha}/check-runs?per_page=100`,
      );
      return {
        sha,
        state: deriveState(data.check_runs),
        totalCount: data.total_count,
        runs: data.check_runs,
      };
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404) {
        return { sha, state: "unknown", totalCount: 0, runs: [] };
      }
      throw error;
    }
  }

  async listWorkflowRuns(branch?: string, page = 1): Promise<GitHubWorkflowRun[]> {
    const params = new URLSearchParams({ per_page: "30", page: String(page) });
    if (branch) params.set("branch", branch);
    const data = await this.request<{ workflow_runs: GitHubWorkflowRun[] }>(
      `/repos/${this.owner}/${this.repo}/actions/runs?${params}`,
    );
    return data.workflow_runs;
  }

  async listWorkflowRunJobs(runId: number): Promise<GitHubWorkflowJob[]> {
    const data = await this.request<{ total_count: number; jobs: GitHubWorkflowJob[] }>(
      `/repos/${this.owner}/${this.repo}/actions/runs/${runId}/jobs?per_page=100`,
    );
    return data.jobs;
  }

  private async request<T>(path: string, opts?: { method?: string; body?: unknown; accept?: string }): Promise<T> {
    const url = path.startsWith("http") ? path : `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: opts?.accept ?? "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };

    const init: RequestInit = {
      method: opts?.method ?? "GET",
      headers,
    };

    if (opts?.body !== undefined) {
      if (opts.accept === "application/vnd.github.diff") {
        // diff requests don't send a body
      } else {
        headers["Content-Type"] = "application/json";
        init.body = JSON.stringify(opts.body);
      }
    }

    const response = await fetch(url, init);

    if (opts?.accept === "application/vnd.github.diff") {
      if (!response.ok) {
        const text = await response.text().catch(() => response.statusText);
        throw new GitHubApiError(text, response.status, path);
      }
      return response.text() as unknown as T;
    }

    if (!response.ok) {
      let message = response.statusText;
      try {
        const body = await response.json() as { message?: string };
        if (body.message) message = body.message;
      } catch { /* ignore */ }
      throw new GitHubApiError(message, response.status, path);
    }

    return response.json() as Promise<T>;
  }
}

interface RawPR {
  number: number;
  title: string;
  state: string;
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

interface RawCompare {
  status: string;
  ahead_by: number;
  commits: Array<{
    sha: string;
    commit: { message: string };
  }>;
  files?: Array<{
    filename: string;
    status: string;
    additions: number;
    deletions: number;
    changes: number;
  }>;
}

interface RawPRFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
  blob_url: string;
}

interface RawBranch {
  name: string;
  protected: boolean;
  commit: { sha: string };
}

function normalizePR(pr: RawPR): GitHubPR {
  return {
    number: pr.number,
    title: pr.title,
    state: pr.merged_at ? "merged" : (pr.state as "open" | "closed"),
    body: pr.body,
    html_url: pr.html_url,
    head: pr.head,
    base: pr.base,
    user: pr.user,
    created_at: pr.created_at,
    updated_at: pr.updated_at,
    merged_at: pr.merged_at,
    draft: pr.draft ?? false,
    mergeable: pr.mergeable ?? null,
  };
}

function deriveState(runs: GitHubCheckRun[]): CommitCIStatus["state"] {
  if (runs.length === 0) return "unknown";
  if (runs.some((r) => r.status === "in_progress" || r.status === "queued")) return "pending";
  if (runs.every((r) => r.conclusion === "success" || r.conclusion === "skipped" || r.conclusion === "neutral")) return "success";
  if (runs.some((r) => r.conclusion === "failure" || r.conclusion === "timed_out")) return "failure";
  return "error";
}

function firstLine(message: string): string {
  return message.split(/\r?\n/, 1)[0]?.trim() ?? "";
}
