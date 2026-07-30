import { resolve, sep } from "node:path";
import { gitToplevel, type ConfigStore } from "../../core/config-store.js";
import { GitActions } from "../../core/git-actions.js";
import { GitManager } from "../../core/git-manager.js";
import { GitWorktreeManager } from "../../core/git-worktrees.js";
import { createRepository } from "../../core/repo-create.js";
import { cloneRepository } from "../../core/repo-onboard.js";
import { getSelectedGitRepository, readGitDiff, selectedGitCwd } from "../dashboard.js";
import { readForm, readJson, requiredFormValue, sendJson, sendText } from "../http-utils.js";
import { errorMessage, patternRoute, route, type Route } from "./context.js";

/**
 * How many repos the board shows before the user has curated it. Kept below the
 * UI's 5-column cap so the "Add" tile stays visible and nothing is stranded.
 */
const DEFAULT_BOARD_COLUMNS = 4;

/**
 * Resolve the working directory for a write op. When `repoName` is given — the
 * multi-repo board scopes stage/unstage/commit/push to a named column — look it
 * up by name; otherwise fall back to the currently selected repository. Returns
 * an `error` string when a named repo can't be found so callers can 404.
 */
async function resolveRepoCwd(
  configStore: ConfigStore,
  repoName: string | undefined,
  fallbackCwd: string,
): Promise<{ cwd: string } | { error: string }> {
  if (!repoName) {
    return { cwd: await selectedGitCwd(configStore, fallbackCwd) };
  }
  const config = await configStore.load();
  const target = config.gitRepositories.find((repository) => repository.name === repoName);
  if (!target) return { error: `Unknown repository: ${repoName}` };
  return { cwd: target.activeWorktreePath ?? target.path };
}

/** Read-safe Git operations plus repository registration/selection. */
export const gitRoutes: Route[] = [
  route("GET", "/api/git/diff", async ({ response, url, configStore, cwd }) => {
    const config = await configStore.load();
    // `repo` scopes the diff to a named repository (used by the multi-repo
    // board); without it we fall back to the currently selected repository.
    const repoName = url.searchParams.get("repo")?.trim();
    const targetRepository = repoName
      ? config.gitRepositories.find((repository) => repository.name === repoName)
      : getSelectedGitRepository(config);
    if (repoName && !targetRepository) {
      sendJson(response, { ok: false, error: `Unknown repository: ${repoName}` }, 404);
      return;
    }
    const gitCwd =
      targetRepository?.activeWorktreePath ??
      targetRepository?.path ??
      cwd;
    const selectedFile = url.searchParams.get("file")?.trim();
    if (!selectedFile) {
      sendJson(response, { ok: false, error: "file is required" }, 400);
      return;
    }
    const git = new GitManager(gitCwd);
    const status = await git.status();
    const selectedStatus = status.files.find((file) => file.path === selectedFile);
    const diff = selectedStatus
      ? await git.fileDiff(selectedStatus)
      : await readGitDiff(gitCwd, selectedFile);
    if (diff === undefined) {
      sendJson(response, { ok: false, error: "No changes or file not found." }, 404);
      return;
    }
    sendText(response, diff);
  }),

  route("GET", "/api/git/status", async ({ response, configStore, cwd }) => {
    const gitCwd = await selectedGitCwd(configStore, cwd);
    try {
      const status = await new GitManager(gitCwd).status();
      sendJson(response, { ok: true, status });
    } catch (error) {
      sendJson(response, { ok: false, error: errorMessage(error) }, 400);
    }
  }),

  route("GET", "/api/git/overview", async ({ response, configStore }) => {
    // Fan out `git status` across every registered repository so the board can
    // show changed files per repo side by side. One broken repo surfaces as a
    // per-column error instead of failing the whole response.
    const config = await configStore.load();
    const repos = await Promise.all(
      config.gitRepositories.map(async (repository) => {
        try {
          const worktreePath = repository.activeWorktreePath ?? repository.path;
          const status = await new GitManager(worktreePath).status();
          return {
            name: repository.name,
            path: worktreePath,
            branch: status.branch,
            ahead: status.ahead,
            behind: status.behind,
            files: status.files,
          };
        } catch (error) {
          return {
            name: repository.name,
            path: repository.path,
            branch: "",
            ahead: 0,
            behind: 0,
            files: [],
            error: errorMessage(error),
          };
        }
      }),
    );
    // Effective board: the user's pinned order, or every repo when never
    // curated. Stale names (repo since removed) are dropped.
    const registered = new Set(config.gitRepositories.map((repo) => repo.name));
    const board = (
      config.gitBoardRepositories ??
      config.gitRepositories.map((repo) => repo.name).slice(0, DEFAULT_BOARD_COLUMNS)
    ).filter((name) => registered.has(name));
    sendJson(response, { ok: true, repos, board });
  }),

  route("PUT", "/api/git/board", async ({ request, response, configStore }) => {
    const body = await readJson(request);
    const names = Array.isArray(body.names)
      ? body.names.filter((name: unknown): name is string => typeof name === "string")
      : null;
    if (!names) {
      sendJson(response, { ok: false, error: "names array is required" }, 400);
      return;
    }
    const config = await configStore.setGitBoardRepositories(names);
    sendJson(response, { ok: true, board: config.gitBoardRepositories ?? [] });
  }),

  route("GET", "/api/git/files", async ({ response, configStore, cwd }) => {
    const gitCwd = await selectedGitCwd(configStore, cwd);
    try {
      const files = await new GitManager(gitCwd).listTrackedFiles();
      sendJson(response, { ok: true, files });
    } catch (error) {
      sendJson(response, { ok: false, error: errorMessage(error) }, 400);
    }
  }),

  route("GET", "/api/git/file-sizes", async ({ response, configStore, cwd }) => {
    const gitCwd = await selectedGitCwd(configStore, cwd);
    try {
      const files = await new GitManager(gitCwd).rankFilesBySize();
      sendJson(response, { ok: true, files });
    } catch (error) {
      sendJson(response, { ok: false, error: errorMessage(error) }, 400);
    }
  }),

  route("GET", "/api/git/file", async ({ response, url, configStore, cwd }) => {
    const gitCwd = await selectedGitCwd(configStore, cwd);
    const path = url.searchParams.get("path")?.trim();
    if (!path) {
      sendJson(response, { ok: false, error: "path is required" }, 400);
      return;
    }
    try {
      const file = await new GitManager(gitCwd).readTrackedFile(path);
      sendJson(response, { ok: true, ...file });
    } catch (error) {
      sendJson(response, { ok: false, error: errorMessage(error) }, 404);
    }
  }),

  route("PUT", "/api/git/file", async ({ request, response, configStore, cwd }) => {
    const gitCwd = await selectedGitCwd(configStore, cwd);
    const body = await readJson(request);
    const path = typeof body.path === "string" ? body.path.trim() : "";
    const content = typeof body.content === "string" ? body.content : null;
    if (!path) {
      sendJson(response, { ok: false, error: "path is required" }, 400);
      return;
    }
    if (content === null) {
      sendJson(response, { ok: false, error: "content is required" }, 400);
      return;
    }
    try {
      await new GitManager(gitCwd).writeTrackedFile(path, content);
      sendJson(response, { ok: true });
    } catch (error) {
      sendJson(response, { ok: false, error: errorMessage(error) }, 400);
    }
  }),

  route("GET", "/api/git/commit", async ({ response, url, configStore, cwd }) => {
    const gitCwd = await selectedGitCwd(configStore, cwd);
    const hash = url.searchParams.get("hash")?.trim();
    const file = url.searchParams.get("file")?.trim() || undefined;
    if (!hash) {
      sendJson(response, { ok: false, error: "hash is required" }, 400);
      return;
    }
    try {
      const diff = await new GitManager(gitCwd).commitDiff(hash, file);
      sendText(response, diff);
    } catch (error) {
      sendJson(response, { ok: false, error: errorMessage(error) }, 400);
    }
  }),

  route("GET", "/api/git/commit/files", async ({ response, url, configStore, cwd }) => {
    const gitCwd = await selectedGitCwd(configStore, cwd);
    const hash = url.searchParams.get("hash")?.trim();
    if (!hash) {
      sendJson(response, { ok: false, error: "hash is required" }, 400);
      return;
    }
    try {
      const files = await new GitManager(gitCwd).commitFiles(hash);
      sendJson(response, { ok: true, files });
    } catch (error) {
      sendJson(response, { ok: false, error: errorMessage(error) }, 400);
    }
  }),

  route("GET", "/api/git/graph", async ({ response, url, configStore, cwd }) => {
    const gitCwd = await selectedGitCwd(configStore, cwd);
    const limitParam = url.searchParams.get("limit")?.trim();
    const parsedLimit = limitParam ? Number(limitParam) : 200;
    const limit = Number.isFinite(parsedLimit) && parsedLimit > 0
      ? Math.min(Math.floor(parsedLimit), 2000)
      : 200;
    const commits = await new GitManager(gitCwd).graph(limit);
    sendJson(response, { ok: true, commits });
  }),

  route("POST", "/api/git/fetch", async ({ response, configStore, cwd }) => {
    const gitCwd = await selectedGitCwd(configStore, cwd);
    const output = await new GitManager(gitCwd).fetch();
    sendJson(response, { ok: true, output });
  }),

  route("POST", "/api/git/commit", async ({ request, response, configStore, cwd }) => {
    try {
      const form = await readForm(request);
      const resolved = await resolveRepoCwd(configStore, form.get("repo")?.trim(), cwd);
      if ("error" in resolved) {
        sendJson(response, { ok: false, error: resolved.error }, 404);
        return;
      }
      const output = await new GitManager(resolved.cwd).commit(requiredFormValue(form, "message"));
      sendJson(response, { ok: true, output });
    } catch (error) {
      sendJson(response, { ok: false, error: errorMessage(error) }, 400);
    }
  }),

  route("POST", "/api/git/stage", async ({ request, response, configStore, cwd }) => {
    try {
      const body = await readJson(request);
      const repo = typeof body.repo === "string" ? body.repo.trim() : undefined;
      const resolved = await resolveRepoCwd(configStore, repo, cwd);
      if ("error" in resolved) {
        sendJson(response, { ok: false, error: resolved.error }, 404);
        return;
      }
      const paths = Array.isArray(body.paths) ? body.paths.filter((p): p is string => typeof p === "string") : [];
      const output = await new GitManager(resolved.cwd).stage(paths);
      sendJson(response, { ok: true, output });
    } catch (error) {
      sendJson(response, { ok: false, error: errorMessage(error) }, 400);
    }
  }),

  route("POST", "/api/git/unstage", async ({ request, response, configStore, cwd }) => {
    try {
      const body = await readJson(request);
      const repo = typeof body.repo === "string" ? body.repo.trim() : undefined;
      const resolved = await resolveRepoCwd(configStore, repo, cwd);
      if ("error" in resolved) {
        sendJson(response, { ok: false, error: resolved.error }, 404);
        return;
      }
      const paths = Array.isArray(body.paths) ? body.paths.filter((p): p is string => typeof p === "string") : [];
      const output = await new GitManager(resolved.cwd).unstage(paths);
      sendJson(response, { ok: true, output });
    } catch (error) {
      sendJson(response, { ok: false, error: errorMessage(error) }, 400);
    }
  }),

  // Write op (reaches the remote) — lives in the guarded GitActions module, not
  // the read-safe GitManager. The UI confirms before calling this.
  route("POST", "/api/git/push", async ({ request, response, configStore, cwd }) => {
    try {
      const form = await readForm(request);
      const resolved = await resolveRepoCwd(configStore, form.get("repo")?.trim(), cwd);
      if ("error" in resolved) {
        sendJson(response, { ok: false, error: resolved.error }, 404);
        return;
      }
      const remote = form.get("remote")?.trim() || undefined;
      const result = await new GitActions(resolved.cwd).push({ remote });
      sendJson(response, { ok: true, ...result });
    } catch (error) {
      sendJson(response, { ok: false, error: errorMessage(error) }, 400);
    }
  }),

  route("POST", "/api/git/default-branch/pull", async ({ response, configStore, cwd }) => {
    const gitCwd = await selectedGitCwd(configStore, cwd);
    try {
      const result = await new GitActions(gitCwd).checkoutDefaultAndPull();
      sendJson(response, { ok: true, ...result });
    } catch (error) {
      sendJson(response, { ok: false, error: errorMessage(error) }, 400);
    }
  }),

  route("GET", "/api/git/worktrees", async ({ response, configStore }) => {
    const config = await configStore.load();
    const repository = getSelectedGitRepository(config);
    if (!repository) {
      sendJson(response, { ok: false, error: "No Git project is selected." }, 404);
      return;
    }
    const worktrees = await new GitWorktreeManager(repository.path).list();
    const configuredActive = repository.activeWorktreePath ?? repository.path;
    const activePath = worktrees.some(
      (worktree) => resolve(worktree.path) === resolve(configuredActive),
    )
      ? configuredActive
      : repository.path;
    sendJson(response, {
      ok: true,
      activePath,
      worktrees,
    });
  }),

  route("POST", "/api/git/worktrees", async ({ request, response, configStore }) => {
    const body = await readJson(request);
    const config = await configStore.load();
    const repository = getSelectedGitRepository(config);
    if (!repository) {
      sendJson(response, { ok: false, error: "No Git project is selected." }, 404);
      return;
    }
    try {
      const worktree = await new GitWorktreeManager(repository.path).create({
        branch: typeof body.branch === "string" ? body.branch : "",
        createBranch: body.createBranch === true,
        baseRef: typeof body.baseRef === "string" ? body.baseRef : undefined,
        projectName: repository.name,
      });
      await configStore.selectGitWorktree(repository.name, worktree.path);
      sendJson(response, { ok: true, worktree }, 201);
    } catch (error) {
      sendJson(response, { ok: false, error: errorMessage(error) }, 422);
    }
  }),

  route("PUT", "/api/git/worktrees/active", async ({ request, response, configStore }) => {
    const body = await readJson(request);
    const path = typeof body.path === "string" ? body.path : "";
    const config = await configStore.load();
    const repository = getSelectedGitRepository(config);
    if (!repository) {
      sendJson(response, { ok: false, error: "No Git project is selected." }, 404);
      return;
    }
    try {
      await configStore.selectGitWorktree(repository.name, path);
      sendJson(response, { ok: true, activePath: path });
    } catch (error) {
      sendJson(response, { ok: false, error: errorMessage(error) }, 422);
    }
  }),

  route(
    "DELETE",
    "/api/git/worktrees",
    async ({ request, response, configStore, manager, terminalManager }) => {
      const body = await readJson(request);
      const path = typeof body.path === "string" ? body.path : "";
      const config = await configStore.load();
      const repository = getSelectedGitRepository(config);
      if (!repository) {
        sendJson(response, { ok: false, error: "No Git project is selected." }, 404);
        return;
      }
      const activePath = repository.activeWorktreePath ?? repository.path;
      if (resolve(activePath) === resolve(path)) {
        sendJson(
          response,
          { ok: false, error: "Switch to another worktree before removing this one." },
          409,
        );
        return;
      }
      const activeTerminal = terminalManager
        .list()
        .find((session) => pathContains(path, session.cwd));
      if (activeTerminal) {
        sendJson(
          response,
          { ok: false, error: "Close terminals using this worktree before removing it." },
          409,
        );
        return;
      }
      const runtime = manager.status().services;
      const activeService = config.services.find(
        (service) =>
          service.cwd &&
          pathContains(path, service.cwd) &&
          runtime[service.name]?.state === "running",
      );
      if (activeService) {
        sendJson(
          response,
          {
            ok: false,
            error: `Stop service "${activeService.name}" before removing this worktree.`,
          },
          409,
        );
        return;
      }
      try {
        await new GitWorktreeManager(repository.path).remove(path);
        sendJson(response, { ok: true });
      } catch (error) {
        sendJson(response, { ok: false, error: errorMessage(error) }, 422);
      }
    },
  ),

  route("POST", "/api/git/worktrees/prune", async ({ response, configStore }) => {
    const config = await configStore.load();
    const repository = getSelectedGitRepository(config);
    if (!repository) {
      sendJson(response, { ok: false, error: "No Git project is selected." }, 404);
      return;
    }
    await new GitWorktreeManager(repository.path).prune();
    sendJson(response, { ok: true });
  }),

  route("POST", "/api/git/branches", async ({ request, response, configStore, cwd }) => {
    const form = await readForm(request);
    const gitCwd = await selectedGitCwd(configStore, cwd);
    const output = await new GitManager(gitCwd).createBranch(requiredFormValue(form, "name"));
    sendJson(response, { ok: true, output });
  }),

  route("POST", "/api/git/branches/switch", async ({ request, response, configStore, cwd }) => {
    const form = await readForm(request);
    const gitCwd = await selectedGitCwd(configStore, cwd);
    const output = await new GitManager(gitCwd).switchBranch(requiredFormValue(form, "name"));
    sendJson(response, { ok: true, output });
  }),

  route("POST", "/api/git/repositories", async ({ request, response, configStore }) => {
    const form = await readForm(request);
    const config = await configStore.registerGitRepository({
      name: requiredFormValue(form, "name"),
      path: requiredFormValue(form, "path"),
    });
    sendJson(response, { ok: true, config });
  }),

  // Clone a remote repo (HTTPS or SSH) into the managed repos dir, then register
  // it as a Git project. Cloning lives in the guarded `repo-onboard` core module
  // so GitManager stays read-safe; SSH uses the host's ssh-agent/keys/config.
  route("POST", "/api/git/clone", async ({ request, response, configStore }) => {
    const form = await readForm(request);
    const url = requiredFormValue(form, "url");
    try {
      const config = await configStore.load();
      const githubToken = configStore.getGithubToken(config);
      const { name, clonePath } = await cloneRepository(url, undefined, githubToken);
      await configStore.registerGitRepository({ name, path: clonePath });
      sendJson(response, { ok: true, name, path: clonePath });
    } catch (error) {
      sendJson(response, { ok: false, error: errorMessage(error) }, 422);
    }
  }),

  // Adopt the repo a path already sits in — used by the "this service has no
  // project" affordance. Resolves to the worktree root first so a service that
  // runs from `repo/frontend` registers `repo`, not the subdirectory.
  route("POST", "/api/git/adopt", async ({ request, response, configStore }) => {
    const form = await readForm(request);
    const from = requiredFormValue(form, "path");
    const root = await gitToplevel(from);
    if (!root) {
      sendJson(response, { ok: false, error: `Not inside a Git repository: ${from}` }, 422);
      return;
    }
    try {
      const name = root.split("/").filter(Boolean).pop() ?? root;
      await configStore.registerGitRepository({ name, path: root });
      sendJson(response, { ok: true, name, path: root });
    } catch (error) {
      sendJson(response, { ok: false, error: errorMessage(error) }, 422);
    }
  }),

  // Create a brand-new project: mkdir + `git init` + register. Lives in the
  // guarded `repo-create` core module for the same reason cloning does.
  route("POST", "/api/git/create", async ({ request, response, configStore }) => {
    const form = await readForm(request);
    try {
      const parent = form.get("parentPath")?.trim();
      const { name, path } = await createRepository(
        requiredFormValue(form, "name"),
        parent || undefined,
      );
      await configStore.registerGitRepository({ name, path });
      sendJson(response, { ok: true, name, path });
    } catch (error) {
      sendJson(response, { ok: false, error: errorMessage(error) }, 422);
    }
  }),

  patternRoute(
    /^\/api\/git\/repositories\/([^/]+)$/,
    ["name"],
    async ({ request, response, configStore, params }) => {
      if (request.method !== "DELETE") {
        sendJson(response, { ok: false, error: "Method not allowed" }, 405);
        return;
      }

      const config = await configStore.removeGitRepository(
        decodeURIComponent(params.name),
      );
      sendJson(response, { ok: true, config });
    },
  ),

  route("POST", "/api/git/select", async ({ request, response, configStore }) => {
    const form = await readForm(request);
    const config = await configStore.selectGitRepository(requiredFormValue(form, "name"));
    sendJson(response, { ok: true, config });
  }),
];

function pathContains(root: string, candidate: string): boolean {
  const normalizedRoot = resolve(root);
  const normalizedCandidate = resolve(candidate);
  return (
    normalizedCandidate === normalizedRoot ||
    normalizedCandidate.startsWith(`${normalizedRoot}${sep}`)
  );
}
