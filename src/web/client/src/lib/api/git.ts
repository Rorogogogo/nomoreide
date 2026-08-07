/**
 * Git API entry point. Picks the backend implementation once at module load
 * (`isTauri()` → Rust `invoke()`, else Node HTTP) and re-exports its methods as
 * the named functions the rest of the app already imports. Adding/altering a git
 * endpoint means editing the {@link GitApi} interface plus both implementations
 * — never a per-function `if (isTauri())` branch.
 */
import { isTauri } from "./tauri-bridge.js";
import type { GitApi } from "./git-api.js";
import { httpGitApi } from "./git-http.js";
import { tauriGitApi } from "./git-tauri.js";

const api: GitApi = isTauri() ? tauriGitApi : httpGitApi;

export const {
  getGitWorktrees,
  createGitWorktree,
  selectGitWorktree,
  removeGitWorktree,
  pruneGitWorktrees,
  getGitGraph,
  getGitCommitDiff,
  getGitCommitFiles,
  getGitFiles,
  getFileSizeRanking,
  getGitFile,
  updateGitFile,
  getGitDiff,
  getGitOverview,
  setGitBoard,
  gitStage,
  gitUnstage,
  gitCommit,
  getGitIdentity,
  gitPush,
  gitPull,
  gitMerge,
  gitRebase,
  gitCheckoutDefaultAndPull,
  gitCreateBranch,
  gitDeleteBranch,
  gitBranches,
  gitFetch,
  gitSwitchBranch,
  deleteGitRepository,
  selectGitRepository,
  registerGitRepository,
  cloneGitRepository,
  createGitRepository,
  adoptGitRepository,
} = api;

export type {
  GitApi,
  GitFileStatus,
  GitBranch,
  GitGraphRef,
  GitGraphEdge,
  GitGraphCommit,
  GitFileContent,
  FileSizeRank,
  GitRepoOverview,
  GitOverview,
  GitPushResult,
  GitIdentity,
  GitIdentityState,
  GitCheckoutDefaultAndPullResult,
  GitWorktree,
  GitWorktrees,
} from "./git-api.js";
