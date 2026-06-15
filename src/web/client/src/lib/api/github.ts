/**
 * GitHub API entry point. Picks the backend implementation once at module load
 * (`isTauri()` → Rust core, else Node HTTP) and re-exports its methods as the
 * named functions the rest of the app already imports — never a per-function
 * `if (isTauri())` branch.
 */
import { isTauri } from "./tauri-bridge.js";
import type { GitHubApi } from "./github-api.js";
import { httpGitHubApi } from "./github-http.js";
import { tauriGitHubApi } from "./github-tauri.js";

const api: GitHubApi = isTauri() ? tauriGitHubApi : httpGitHubApi;

export const {
  getGitHubTokenInfo,
  startGitHubDeviceFlow,
  pollGitHubDeviceFlow,
  setGitHubToken,
  removeGitHubToken,
  listGitHubBranches,
  listGitHubPRs,
  getGitHubPR,
  getGitHubPRDiff,
  getGitHubPRReviewCockpit,
  getGitHubPRTemplate,
  createGitHubPR,
  mergeGitHubPR,
  listGitHubIssues,
  getGitHubIssue,
  listGitHubIssueComments,
  addGitHubIssueComment,
  createGitHubIssue,
  getCommitCIStatus,
  listGitHubWorkflowRuns,
  listGitHubWorkflowRunJobs,
} = api;

export type {
  GitHubApi,
  GitHubPR,
  GitHubIssue,
  GitHubComment,
  GitHubPRFile,
  GitHubPRReview,
  GitHubBranchInfo,
  GitHubBranchesPayload,
  GitHubCheckRun,
  CommitCIStatus,
  GitHubPRTemplateFile,
  GitHubPRTemplateCommit,
  GitHubPRTemplate,
  GitHubPRReviewCockpit,
  GitHubWorkflowRun,
  GitHubWorkflowJobStep,
  GitHubWorkflowJob,
  GitHubConnectionStatus,
  GitHubTokenInfo,
  GitHubDeviceFlowStart,
  MergePRResult,
  CreatePROptions,
  MergePROptions,
} from "./github-api.js";
