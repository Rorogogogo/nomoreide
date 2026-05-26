import { requestJson } from "./client.js";

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

export async function getGitDiff(path: string): Promise<string> {
  const response = await fetch(`/api/git/diff?file=${encodeURIComponent(path)}`);
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(body.error || "Unable to load diff");
  }
  return response.text();
}

export async function deleteGitRepository(name: string): Promise<void> {
  await requestJson<{ ok: true }>(
    `/api/git/repositories/${encodeURIComponent(name)}`,
    { method: "DELETE" },
  );
}
