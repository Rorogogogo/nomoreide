import { GitManager } from "../../core/git-manager.js";
import { getSelectedGitRepository, readGitDiff, selectedGitCwd } from "../dashboard.js";
import { readForm, requiredFormValue, sendJson, sendText } from "../http-utils.js";
import { errorMessage, patternRoute, route, type Route } from "./context.js";

/** Read-safe Git operations plus repository registration/selection. */
export const gitRoutes: Route[] = [
  route("GET", "/api/git/diff", async ({ response, url, configStore, cwd }) => {
    const config = await configStore.load();
    const selectedGitRepository = getSelectedGitRepository(config);
    const gitCwd = selectedGitRepository?.path ?? cwd;
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

  route("GET", "/api/git/files", async ({ response, configStore, cwd }) => {
    const gitCwd = await selectedGitCwd(configStore, cwd);
    try {
      const files = await new GitManager(gitCwd).listTrackedFiles();
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
