/**
 * Git API surface — the single contract both backends implement.
 *
 * The web client runs against two backends: the Node HTTP server (`/api/git/*`)
 * and, in the desktop app, the Rust core over Tauri `invoke()`. Rather than fork
 * each function with an `if (isTauri())` branch (easy to forget → silent 404 in
 * the bundled app), both backends implement this one interface and `git.ts`
 * selects the implementation once. A missing or wrong-shaped method on either
 * implementation is then a compile error, not a runtime surprise.
 */

export interface GitFileStatus {
  path: string;
  index: string;
  workingTree: string;
}

export interface GitBranch {
  name: string;
  current: boolean;
  remote: boolean;
  upstream?: string;
}

export interface GitGraphRef {
  name: string;
  kind: "head" | "branch" | "remote" | "tag";
}

export interface GitGraphEdge {
  fromLane: number;
  toLane: number;
  parentHash: string;
  kind: "straight" | "branch" | "merge";
}

export interface GitGraphCommit {
  hash: string;
  parents: string[];
  author: string;
  email: string;
  timestamp: number;
  subject: string;
  refs: GitGraphRef[];
  lane: number;
  laneCount: number;
  edges: GitGraphEdge[];
  throughLanes: number[];
}

export interface GitFileContent {
  content: string;
  truncated: boolean;
  binary: boolean;
  size: number;
}

export interface FileSizeRank {
  path: string;
  lines: number;
  bytes: number;
  truncated: boolean;
}

/** One repository's working-tree summary for the multi-repo board. */
export interface GitRepoOverview {
  name: string;
  path: string;
  branch: string;
  ahead: number;
  behind: number;
  files: GitFileStatus[];
  /** Set when this repo's status could not be read (others still return). */
  error?: string;
}

export interface GitOverview {
  /** Every registered repository with its working-tree status. */
  repos: GitRepoOverview[];
  /** Ordered names of repos pinned to the board (defaults to all repos). */
  board: string[];
}

export interface GitPushResult {
  output: string;
  branch: string;
  setUpstream: boolean;
}

export interface GitCheckoutDefaultAndPullResult {
  output: string;
  branch: string;
}

export interface GitApi {
  getGitGraph(limit?: number): Promise<GitGraphCommit[]>;
  getGitCommitDiff(hash: string, file?: string): Promise<string>;
  getGitCommitFiles(hash: string): Promise<GitFileStatus[]>;
  getGitFiles(): Promise<string[]>;
  getFileSizeRanking(): Promise<FileSizeRank[]>;
  getGitFile(path: string): Promise<GitFileContent>;
  updateGitFile(path: string, content: string): Promise<void>;
  getGitDiff(path: string, repo?: string): Promise<string>;
  getGitOverview(): Promise<GitOverview>;
  /** Persist the ordered set of repos pinned to the board. Returns the saved order. */
  setGitBoard(names: string[]): Promise<string[]>;
  /** Stage explicit file paths. Pass `repo` to scope to a named board repository. */
  gitStage(paths: string[], repo?: string): Promise<void>;
  /** Unstage explicit file paths. Pass `repo` to scope to a named board repository. */
  gitUnstage(paths: string[], repo?: string): Promise<void>;
  /** Commit currently staged changes. Pass `repo` to scope to a named board repository. */
  gitCommit(message: string, repo?: string): Promise<string>;
  /** Push the current branch to its remote (sets upstream on first push). */
  gitPush(repo?: string): Promise<GitPushResult>;
  /** Switch back to the default branch and pull latest with fast-forward only. */
  gitCheckoutDefaultAndPull(): Promise<GitCheckoutDefaultAndPullResult>;
  /** Create and switch to a new local branch. */
  gitCreateBranch(name: string): Promise<string>;
  gitBranches(repo?: string): Promise<GitBranch[]>;
  gitFetch(repo?: string): Promise<string>;
  gitSwitchBranch(name: string, repo?: string): Promise<void>;
  deleteGitRepository(name: string): Promise<void>;
  /** Switch the selected repository the git views operate on. */
  selectGitRepository(name: string): Promise<void>;
  /** Register a new local git repository by absolute path. */
  registerGitRepository(name: string, path: string): Promise<void>;
}
