import { postFormForJson, requestJson } from "./client.js";

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

export async function getGitGraph(limit = 200): Promise<GitGraphCommit[]> {
  const response = await requestJson<{ ok: true; commits: GitGraphCommit[] }>(
    `/api/git/graph?limit=${limit}`,
  );
  return response.commits;
}

export async function getGitCommitDiff(hash: string, file?: string): Promise<string> {
  const params = new URLSearchParams({ hash });
  if (file) params.set("file", file);
  const response = await fetch(`/api/git/commit?${params.toString()}`);
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(body.error || "Unable to load commit diff");
  }
  return response.text();
}

export async function getGitCommitFiles(hash: string): Promise<GitFileStatus[]> {
  const response = await requestJson<{ ok: true; files: GitFileStatus[] }>(
    `/api/git/commit/files?hash=${encodeURIComponent(hash)}`,
  );
  return response.files;
}

export async function getGitFiles(): Promise<string[]> {
  const response = await requestJson<{ ok: true; files: string[] }>("/api/git/files");
  return response.files;
}

export interface FileSizeRank {
  path: string;
  lines: number;
  bytes: number;
  truncated: boolean;
}

export async function getFileSizeRanking(): Promise<FileSizeRank[]> {
  const response = await requestJson<{ ok: true; files: FileSizeRank[] }>(
    "/api/git/file-sizes",
  );
  return response.files;
}

export async function getGitFile(path: string): Promise<GitFileContent> {
  const response = await requestJson<{ ok: true } & GitFileContent>(
    `/api/git/file?path=${encodeURIComponent(path)}`,
  );
  return {
    content: response.content,
    truncated: response.truncated,
    binary: response.binary,
    size: response.size,
  };
}

export async function updateGitFile(path: string, content: string): Promise<void> {
  await requestJson<{ ok: true }>("/api/git/file", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, content }),
  });
}

export async function getGitDiff(path: string, repo?: string): Promise<string> {
  const params = new URLSearchParams({ file: path });
  if (repo) params.set("repo", repo);
  const response = await fetch(`/api/git/diff?${params.toString()}`);
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(body.error || "Unable to load diff");
  }
  return response.text();
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

/** Changed files across every registered repository plus the board ordering. */
export async function getGitOverview(): Promise<GitOverview> {
  const response = await requestJson<{ ok: true } & Partial<GitOverview>>(
    "/api/git/overview",
  );
  const repos = response.repos ?? [];
  // Tolerate an older server that doesn't send `board` yet: fall back to
  // showing every repo rather than crashing on an undefined board.
  const board = response.board ?? repos.map((repo) => repo.name);
  return { repos, board };
}

/** Persist the ordered set of repos pinned to the board. Returns the saved order. */
export async function setGitBoard(names: string[]): Promise<string[]> {
  const response = await requestJson<{ ok: true; board: string[] }>("/api/git/board", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ names }),
  });
  return response.board;
}

/** Stage explicit file paths. Pass `repo` to scope to a named board repository. */
export async function gitStage(paths: string[], repo?: string): Promise<void> {
  await requestJson<{ ok: true }>("/api/git/stage", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(repo ? { paths, repo } : { paths }),
  });
}

/** Unstage explicit file paths. Pass `repo` to scope to a named board repository. */
export async function gitUnstage(paths: string[], repo?: string): Promise<void> {
  await requestJson<{ ok: true }>("/api/git/unstage", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(repo ? { paths, repo } : { paths }),
  });
}

/** Commit currently staged changes. Pass `repo` to scope to a named board repository. */
export async function gitCommit(message: string, repo?: string): Promise<string> {
  const res = await postFormForJson<{ ok: true; output: string }>("/api/git/commit", {
    message,
    ...(repo ? { repo } : {}),
  });
  return res.output;
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

/** Push the current branch to its remote (sets upstream on first push). */
export async function gitPush(repo?: string): Promise<GitPushResult> {
  const res = await postFormForJson<{ ok: true } & GitPushResult>(
    "/api/git/push",
    repo ? { repo } : {},
  );
  return { output: res.output, branch: res.branch, setUpstream: res.setUpstream };
}

/** Switch back to the default branch and pull latest with fast-forward only. */
export async function gitCheckoutDefaultAndPull(): Promise<GitCheckoutDefaultAndPullResult> {
  const res = await postFormForJson<{ ok: true } & GitCheckoutDefaultAndPullResult>(
    "/api/git/default-branch/pull",
    {},
  );
  return { output: res.output, branch: res.branch };
}

/** Create and switch to a new local branch. */
export async function gitCreateBranch(name: string): Promise<string> {
  const res = await postFormForJson<{ ok: true; output: string }>("/api/git/branches", {
    name,
  });
  return res.output;
}

export async function deleteGitRepository(name: string): Promise<void> {
  await requestJson<{ ok: true }>(
    `/api/git/repositories/${encodeURIComponent(name)}`,
    { method: "DELETE" },
  );
}
