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

export interface GitWorktree {
  path: string;
  head: string;
  /** Filesystem creation time of the worktree directory, in epoch milliseconds. */
  createdAt?: number;
  branch?: string;
  bare: boolean;
  detached: boolean;
  locked: boolean;
  lockedReason?: string;
  prunable: boolean;
  prunableReason?: string;
  primary: boolean;
  dirty: boolean;
}

export interface GitWorktrees {
  activePath: string;
  worktrees: GitWorktree[];
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
  /** GitHub account the push was authenticated as, when one was selected. */
  pushedAs?: string;
}

export interface GitIdentity {
  host: string;
  login: string;
  name: string;
  email: string;
}

export interface GitIdentityState {
  /** Identity commits will carry, or null when the machine's git config governs. */
  selected: GitIdentity | null;
  machine: { name?: string; email?: string };
  /** True when commits here would not match the machine's configured author. */
  diverged: boolean;
  /** Why `selected` is null, so the UI can explain the fallback. */
  reason?: string;
}

export interface GitCheckoutDefaultAndPullResult {
  output: string;
  branch: string;
}

/** One tracked path matched by the file palette. */
export interface FileNameMatch {
  path: string;
  /** Higher is a better match. Ordering is the server's; do not re-sort. */
  score: number;
  /** Character offsets into `path` that the query matched, for highlighting. */
  positions: number[];
}

/** One hit inside a file. `start`/`end` are character offsets into `text`. */
export interface ContentMatch {
  /** One-based, the way an editor's gutter counts. */
  line: number;
  text: string;
  start: number;
  end: number;
}

export interface FileContentMatches {
  path: string;
  matches: ContentMatch[];
  /** The file had more hits than one file is allowed to contribute. */
  truncated: boolean;
}

export interface ContentSearchResult {
  files: FileContentMatches[];
  /** Matches actually returned, which a truncated search stops short of. */
  totalMatches: number;
  truncated: boolean;
}

/** The find panel's toggles. Every field is optional and defaults to off. */
export interface ContentSearchOptions {
  regex?: boolean;
  caseSensitive?: boolean;
  wholeWord?: boolean;
  // Glob limiting which paths are searched, e.g. `src/**` then `/*.ts` — a
  // doc comment cannot hold that pattern, since it closes the comment.
  include?: string;
  limit?: number;
}

export interface GitApi {
  getGitWorktrees(): Promise<GitWorktrees>;
  createGitWorktree(options: {
    branch: string;
    createBranch: boolean;
    baseRef?: string;
  }): Promise<GitWorktree>;
  selectGitWorktree(path: string): Promise<void>;
  removeGitWorktree(path: string): Promise<void>;
  pruneGitWorktrees(): Promise<void>;
  getGitGraph(limit?: number): Promise<GitGraphCommit[]>;
  getGitCommitDiff(hash: string, file?: string): Promise<string>;
  getGitCommitFiles(hash: string): Promise<GitFileStatus[]>;
  getGitFiles(): Promise<string[]>;
  /**
   * Rank tracked paths against a fuzzy query, best first — the editor's file
   * palette. An empty query lists the repository rather than nothing.
   */
  searchGitFiles(query: string, limit?: number): Promise<FileNameMatch[]>;
  /**
   * Search the contents of tracked files, grouped by file. A malformed regex
   * rejects with the message the engine wrote, so it can be shown to the user.
   */
  searchGitContent(query: string, options?: ContentSearchOptions): Promise<ContentSearchResult>;
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
  /**
   * Who a commit here would be authored by, and whether that differs from the
   * machine's `git config user.*`. Drives the mismatch warning above the
   * composer.
   */
  getGitIdentity(repo?: string): Promise<GitIdentityState>;
  /** Push the current branch to its remote (sets upstream on first push). */
  gitPush(repo?: string): Promise<GitPushResult>;
  /** Fast-forward the current branch from its configured upstream. */
  gitPull(repo?: string): Promise<string>;
  /** Merge a branch into the current branch, aborting automatically on conflicts. */
  gitMerge(branch: string, repo?: string): Promise<string>;
  /** Rebase the current branch onto a branch, aborting automatically on conflicts. */
  gitRebase(branch: string, repo?: string): Promise<string>;
  /** Switch back to the default branch and pull latest with fast-forward only. */
  gitCheckoutDefaultAndPull(): Promise<GitCheckoutDefaultAndPullResult>;
  /** Create and switch to a new local branch. */
  gitCreateBranch(name: string, startPoint?: string, repo?: string): Promise<string>;
  /** Delete a merged local branch. Current, unmerged, and remote branches are protected. */
  gitDeleteBranch(name: string, repo?: string): Promise<string>;
  gitBranches(repo?: string): Promise<GitBranch[]>;
  gitFetch(repo?: string): Promise<string>;
  gitSwitchBranch(name: string, repo?: string): Promise<void>;
  deleteGitRepository(name: string): Promise<void>;
  /** Switch the selected repository the git views operate on. */
  selectGitRepository(name: string): Promise<void>;
  /** Register a new local git repository by absolute path. */
  registerGitRepository(name: string, path: string): Promise<void>;
  /**
   * Clone a remote repo (HTTPS or SSH) into the managed repos dir and register
   * it as a Git project. Returns the derived name and local clone path.
   */
  cloneGitRepository(url: string): Promise<{ name: string; path: string }>;
  /**
   * Create a brand-new git-initialised project and register it. `parentPath`
   * defaults to the managed repos dir when omitted.
   */
  createGitRepository(
    name: string,
    parentPath?: string,
  ): Promise<{ name: string; path: string }>;
  /**
   * Register the Git worktree that `path` sits inside as a project — the repo
   * root, not `path` itself.
   */
  adoptGitRepository(path: string): Promise<{ name: string; path: string }>;
}
