/** GitHub API entry point shared by browser and desktop. */
import type { GitHubApi } from "./github-api.js";
import { httpGitHubApi } from "./github-http.js";

const api: GitHubApi = httpGitHubApi;

export const {
  getGitHubTokenInfo,
  startGitHubDeviceFlow,
  pollGitHubDeviceFlow,
  setGitHubToken,
  removeGitHubToken,
  selectGitHubCredential,
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
  GitHubCliAccount,
  GitHubCredentialSelection,
  GitHubDeviceFlowStart,
  MergePRResult,
  CreatePROptions,
  MergePROptions,
} from "./github-api.js";
