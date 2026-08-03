/** Node HTTP-server implementation of {@link GitApi} (the web/MCP backend). */
import { postForm, postFormForJson, requestJson } from "./client.js";
import type {
  FileSizeRank,
  GitApi,
  GitBranch,
  GitCheckoutDefaultAndPullResult,
  GitFileContent,
  GitFileStatus,
  GitGraphCommit,
  GitOverview,
  GitPushResult,
  GitWorktree,
  GitWorktrees,
} from "./git-api.js";

export const httpGitApi: GitApi = {
  async getGitWorktrees() {
    const response = await requestJson<{ ok: true } & GitWorktrees>(
      "/api/git/worktrees",
    );
    return { activePath: response.activePath, worktrees: response.worktrees };
  },

  async createGitWorktree(options) {
    const response = await requestJson<{ ok: true; worktree: GitWorktree }>(
      "/api/git/worktrees",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(options),
      },
    );
    return response.worktree;
  },

  async selectGitWorktree(path) {
    await requestJson<{ ok: true }>("/api/git/worktrees/active", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path }),
    });
  },

  async removeGitWorktree(path) {
    await requestJson<{ ok: true }>("/api/git/worktrees", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path }),
    });
  },

  async pruneGitWorktrees() {
    await requestJson<{ ok: true }>("/api/git/worktrees/prune", {
      method: "POST",
    });
  },

  async getGitGraph(limit = 200) {
    const response = await requestJson<{ ok: true; commits: GitGraphCommit[] }>(
      `/api/git/graph?limit=${limit}`,
    );
    return response.commits;
  },

  async getGitCommitDiff(hash, file) {
    const params = new URLSearchParams({ hash });
    if (file) params.set("file", file);
    const response = await fetch(`/api/git/commit?${params.toString()}`);
    if (!response.ok) {
      const body = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error(body.error || "Unable to load commit diff");
    }
    return response.text();
  },

  async getGitCommitFiles(hash) {
    const response = await requestJson<{ ok: true; files: GitFileStatus[] }>(
      `/api/git/commit/files?hash=${encodeURIComponent(hash)}`,
    );
    return response.files;
  },

  async getGitFiles() {
    const response = await requestJson<{ ok: true; files: string[] }>("/api/git/files");
    return response.files;
  },

  async getFileSizeRanking() {
    const response = await requestJson<{ ok: true; files: FileSizeRank[] }>(
      "/api/git/file-sizes",
    );
    return response.files;
  },

  async getGitFile(path) {
    const response = await requestJson<{ ok: true } & GitFileContent>(
      `/api/git/file?path=${encodeURIComponent(path)}`,
    );
    return {
      content: response.content,
      truncated: response.truncated,
      binary: response.binary,
      size: response.size,
    };
  },

  async updateGitFile(path, content) {
    await requestJson<{ ok: true }>("/api/git/file", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, content }),
    });
  },

  async getGitDiff(path, repo) {
    const params = new URLSearchParams({ file: path });
    if (repo) params.set("repo", repo);
    const response = await fetch(`/api/git/diff?${params.toString()}`);
    if (!response.ok) {
      const body = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error(body.error || "Unable to load diff");
    }
    return response.text();
  },

  async getGitOverview() {
    const response = await requestJson<{ ok: true } & Partial<GitOverview>>(
      "/api/git/overview",
    );
    const repos = response.repos ?? [];
    const board = response.board ?? repos.map((repo) => repo.name);
    return { repos, board };
  },

  async setGitBoard(names) {
    const response = await requestJson<{ ok: true; board: string[] }>("/api/git/board", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ names }),
    });
    return response.board;
  },

  async gitStage(paths, repo) {
    await requestJson<{ ok: true }>("/api/git/stage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(repo ? { paths, repo } : { paths }),
    });
  },

  async gitUnstage(paths, repo) {
    await requestJson<{ ok: true }>("/api/git/unstage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(repo ? { paths, repo } : { paths }),
    });
  },

  async gitCommit(message, repo) {
    const res = await postFormForJson<{ ok: true; output: string }>("/api/git/commit", {
      message,
      ...(repo ? { repo } : {}),
    });
    return res.output;
  },

  async gitPush(repo) {
    const res = await postFormForJson<{ ok: true } & GitPushResult>(
      "/api/git/push",
      repo ? { repo } : {},
    );
    return { output: res.output, branch: res.branch, setUpstream: res.setUpstream };
  },

  async gitPull(repo) {
    const res = await postFormForJson<{ ok: true; output: string }>(
      "/api/git/pull",
      repo ? { repo } : {},
    );
    return res.output;
  },

  async gitMerge(branch, repo) {
    const res = await postFormForJson<{ ok: true; output: string }>("/api/git/merge", {
      branch,
      repo,
    });
    return res.output;
  },

  async gitRebase(branch, repo) {
    const res = await postFormForJson<{ ok: true; output: string }>("/api/git/rebase", {
      branch,
      repo,
    });
    return res.output;
  },

  async gitCheckoutDefaultAndPull() {
    const res = await postFormForJson<{ ok: true } & GitCheckoutDefaultAndPullResult>(
      "/api/git/default-branch/pull",
      {},
    );
    return { output: res.output, branch: res.branch };
  },

  async gitCreateBranch(name, startPoint, repo) {
    const res = await postFormForJson<{ ok: true; output: string }>("/api/git/branches", {
      name,
      startPoint,
      repo,
    });
    return res.output;
  },

  async gitDeleteBranch(name, repo) {
    const res = await postFormForJson<{ ok: true; output: string }>(
      "/api/git/branches/delete",
      { name, repo },
    );
    return res.output;
  },

  async gitBranches() {
    const res = await requestJson<{ ok: true; branches: GitBranch[] }>("/api/git/branches");
    return res.branches;
  },

  async gitFetch() {
    const res = await requestJson<{ ok: true; output: string }>("/api/git/fetch", {
      method: "POST",
    });
    return res.output;
  },

  async gitSwitchBranch(name, repo) {
    await postForm("/api/git/branches/switch", { name, repo });
  },

  async deleteGitRepository(name) {
    await requestJson<{ ok: true }>(
      `/api/git/repositories/${encodeURIComponent(name)}`,
      { method: "DELETE" },
    );
  },

  async selectGitRepository(name) {
    await postForm("/api/git/select", { name });
  },

  async registerGitRepository(name, path) {
    await postForm("/api/git/repositories", { name, path });
  },

  async cloneGitRepository(url) {
    const response = await postFormForJson<{ ok: true; name: string; path: string }>(
      "/api/git/clone",
      { url },
    );
    return { name: response.name, path: response.path };
  },

  async adoptGitRepository(path) {
    const response = await postFormForJson<{ ok: true; name: string; path: string }>(
      "/api/git/adopt",
      { path },
    );
    return { name: response.name, path: response.path };
  },

  async createGitRepository(name, parentPath) {
    const response = await postFormForJson<{ ok: true; name: string; path: string }>(
      "/api/git/create",
      parentPath ? { name, parentPath } : { name },
    );
    return { name: response.name, path: response.path };
  },
};
