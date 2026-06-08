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

export async function getGitDiff(path: string): Promise<string> {
  const response = await fetch(`/api/git/diff?file=${encodeURIComponent(path)}`);
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(body.error || "Unable to load diff");
  }
  return response.text();
}

/** Stage explicit file paths. */
export async function gitStage(paths: string[]): Promise<void> {
  await requestJson<{ ok: true }>("/api/git/stage", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ paths }),
  });
}

/** Unstage explicit file paths. */
export async function gitUnstage(paths: string[]): Promise<void> {
  await requestJson<{ ok: true }>("/api/git/unstage", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ paths }),
  });
}

/** Commit currently staged changes. */
export async function gitCommit(message: string): Promise<string> {
  const res = await postFormForJson<{ ok: true; output: string }>("/api/git/commit", {
    message,
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
export async function gitPush(): Promise<GitPushResult> {
  const res = await postFormForJson<{ ok: true } & GitPushResult>("/api/git/push", {});
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
