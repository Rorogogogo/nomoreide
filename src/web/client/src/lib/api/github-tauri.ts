/**
 * Rust-core implementation of {@link GitHubApi}, over Tauri `invoke()` (desktop).
 * Each call resolves owner/repo from the selected repository's origin remote,
 * then hits the Rust GitHub client. The Node server's resolved-repo proxy is not
 * available, so token/repo context is derived here instead.
 */
import {
  tauri_getGithubTokenStatus,
  tauri_setGithubToken,
  tauri_removeGithubToken,
  tauri_setGithubAccount,
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
import type {
  CommitCIStatus,
  GitHubApi,
  GitHubBranchInfo,
  GitHubCheckRun,
  GitHubComment,
  GitHubDeviceFlowStart,
  GitHubIssue,
  GitHubTokenInfo,
  GitHubPR,
  GitHubPRFile,
  GitHubPRReview,
  GitHubWorkflowJob,
  GitHubWorkflowRun,
  MergePRResult,
} from "./github-api.js";

// Public device-flow client id (GitHub App), used when no Node server proxies OAuth.
const DEVICE_FLOW_CLIENT_ID = "Iv23liCxW0Mv0KJP1Svr";

/** Roll up a set of check-run conclusions into a single CI state. */
function ciStateFromRuns(runs: GitHubCheckRun[]): CommitCIStatus["state"] {
  if (runs.length === 0) return "unknown";
  const conclusions = runs.map((r) => r.conclusion);
  if (conclusions.every((c) => c === "success")) return "success";
  if (conclusions.some((c) => c === "failure" || c === "cancelled")) return "failure";
  return "pending";
}

export const tauriGitHubApi: GitHubApi = {
  async getGitHubTokenInfo() {
    return tauri_getGithubTokenStatus() as Promise<GitHubTokenInfo>;
  },

  async startGitHubDeviceFlow() {
    const res = await tauri_githubOAuthStart(DEVICE_FLOW_CLIENT_ID);
    return res as GitHubDeviceFlowStart;
  },

  async pollGitHubDeviceFlow(device_code) {
    const res = (await tauri_githubOAuthPoll(DEVICE_FLOW_CLIENT_ID, device_code)) as {
      access_token?: string;
      token_type?: string;
      error?: string;
    };
    if (res.access_token) {
      await tauri_setGithubToken("github.com", res.access_token);
      return { done: true };
    }
    return { done: false, slowDown: res.error === "slow_down" };
  },

  async setGitHubToken(host, token) {
    await tauri_setGithubToken(host, token);
  },

  async removeGitHubToken(host) {
    await tauri_removeGithubToken(host);
  },

  async selectGitHubCredential(repository, credential) {
    await tauri_setGithubAccount(repository, credential);
  },

  async listGitHubBranches() {
    const [repository, owner, repo] = await tauri_getGithubRepo();
    const [branches, repoInfo] = await Promise.all([
      tauri_listGithubBranches(repository, owner, repo) as Promise<GitHubBranchInfo[]>,
      tauri_getGithubRepoInfo(repository, owner, repo) as Promise<{
        full_name?: string;
        html_url?: string;
        default_branch?: string;
      }>,
    ]);
    return {
      repository: {
        full_name: repoInfo.full_name ?? `${owner}/${repo}`,
        html_url: repoInfo.html_url ?? "",
        default_branch: repoInfo.default_branch,
      },
      defaultBranch: repoInfo.default_branch ?? null,
      currentBranch: null,
      branches: Array.isArray(branches) ? branches : [],
    };
  },

  async listGitHubPRs(state = "open", page = 1) {
    const [repository, owner, repo] = await tauri_getGithubRepo();
    const prs = await tauri_listPullRequests(repository, owner, repo, state);
    return (prs as GitHubPR[]).slice((page - 1) * 50, page * 50);
  },

  async getGitHubPR(number) {
    const [repository, owner, repo] = await tauri_getGithubRepo();
    return tauri_getPullRequest(repository, owner, repo, number) as Promise<GitHubPR>;
  },

  async getGitHubPRDiff(number) {
    const [repository, owner, repo] = await tauri_getGithubRepo();
    return tauri_getPrDiff(repository, owner, repo, number);
  },

  async getGitHubPRReviewCockpit(number) {
    const [repository, owner, repo] = await tauri_getGithubRepo();
    const pr = (await tauri_getPullRequest(repository, owner, repo, number)) as GitHubPR;
    const [files, reviews, comments, checkRuns] = await Promise.all([
      tauri_listPrFiles(repository, owner, repo, number) as Promise<GitHubPRFile[]>,
      tauri_listPrReviews(repository, owner, repo, number) as Promise<GitHubPRReview[]>,
      tauri_listPrComments(repository, owner, repo, number) as Promise<GitHubComment[]>,
      tauri_listCommitCheckRuns(repository, owner, repo, pr.head.sha) as Promise<{
        total_count?: number;
        check_runs?: GitHubCheckRun[];
      }>,
    ]);
    const runs = checkRuns.check_runs ?? [];
    return {
      pr,
      files: Array.isArray(files) ? files : [],
      reviews: Array.isArray(reviews) ? reviews : [],
      comments: Array.isArray(comments) ? comments : [],
      checks: {
        sha: pr.head.sha,
        state: ciStateFromRuns(runs),
        totalCount: checkRuns.total_count ?? runs.length,
        runs,
      },
    };
  },

  async getGitHubPRTemplate() {
    const [repository, owner, repo] = await tauri_getGithubRepo();
    const repoInfo = (await tauri_getGithubRepoInfo(repository, owner, repo)) as {
      full_name?: string;
      html_url?: string;
      default_branch?: string;
    };
    const defaultBranch = repoInfo.default_branch ?? "main";
    return {
      repository: {
        full_name: repoInfo.full_name ?? `${owner}/${repo}`,
        html_url: repoInfo.html_url ?? "",
        default_branch: repoInfo.default_branch,
      },
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
  },

  async createGitHubPR(opts) {
    const [repository, owner, repo] = await tauri_getGithubRepo();
    return tauri_createPullRequest({
      repository,
      owner,
      repo,
      title: opts.title,
      body: opts.body ?? "",
      head: opts.head,
      base: opts.base,
      draft: opts.draft,
    }) as Promise<GitHubPR>;
  },

  async mergeGitHubPR(number, opts = {}) {
    const [repository, owner, repo] = await tauri_getGithubRepo();
    return (await tauri_mergePullRequest(repository, owner, repo, number, opts)) as MergePRResult;
  },

  async listGitHubIssues(state = "open", page = 1) {
    const [repository, owner, repo] = await tauri_getGithubRepo();
    const issues = await tauri_listIssues(repository, owner, repo, state);
    return (issues as GitHubIssue[]).slice((page - 1) * 50, page * 50);
  },

  async getGitHubIssue(number) {
    const [repository, owner, repo] = await tauri_getGithubRepo();
    return tauri_getGithubIssue(repository, owner, repo, number) as Promise<GitHubIssue>;
  },

  async listGitHubIssueComments(number) {
    const [repository, owner, repo] = await tauri_getGithubRepo();
    return tauri_listIssueComments(repository, owner, repo, number) as Promise<GitHubComment[]>;
  },

  async addGitHubIssueComment(number, body) {
    const [repository, owner, repo] = await tauri_getGithubRepo();
    return tauri_addIssueComment(repository, owner, repo, number, body) as Promise<GitHubComment>;
  },

  async createGitHubIssue(opts) {
    const [repository, owner, repo] = await tauri_getGithubRepo();
    return tauri_createGithubIssue(repository, owner, repo, opts.title, opts.body) as Promise<GitHubIssue>;
  },

  async getCommitCIStatus(sha) {
    const [repository, owner, repo] = await tauri_getGithubRepo();
    const raw = (await tauri_listCommitCheckRuns(repository, owner, repo, sha)) as {
      total_count?: number;
      check_runs?: GitHubCheckRun[];
    };
    const runs = raw.check_runs ?? [];
    return { sha, state: ciStateFromRuns(runs), totalCount: raw.total_count ?? runs.length, runs };
  },

  async listGitHubWorkflowRuns(branch, page = 1) {
    const [repository, owner, repo] = await tauri_getGithubRepo();
    const raw = (await tauri_listWorkflowRuns(repository, owner, repo, branch, page)) as {
      workflow_runs?: GitHubWorkflowRun[];
    };
    return raw.workflow_runs ?? [];
  },

  async listGitHubWorkflowRunJobs(runId) {
    const [repository, owner, repo] = await tauri_getGithubRepo();
    const raw = (await tauri_listWorkflowRunJobs(repository, owner, repo, runId)) as {
      jobs?: GitHubWorkflowJob[];
    };
    return raw.jobs ?? [];
  },
};
