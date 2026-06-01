import { selectedGitCwd } from "../dashboard.js";
import { readForm, readJson, requiredFormValue, sendJson, sendText } from "../http-utils.js";
import { errorMessage, patternRoute, route, type Route } from "./context.js";
import { requireGitHubContext, optionalGitHubContext } from "./github-context.js";

export const githubRoutes: Route[] = [
  // --- Token management ---

  route("GET", "/api/github/token", async ({ response, configStore }) => {
    const config = await configStore.load();
    const token = configStore.getGithubToken(config);
    sendJson(response, { ok: true, configured: !!token });
  }),

  route("POST", "/api/github/token", async ({ request, response, configStore }) => {
    try {
      const form = await readForm(request);
      const host = form.get("host")?.trim() || "github.com";
      const token = requiredFormValue(form, "token");
      await configStore.setGithubToken(host, token);
      sendJson(response, { ok: true });
    } catch (error) {
      sendJson(response, { ok: false, error: errorMessage(error) }, 400);
    }
  }),

  patternRoute(
    /^\/api\/github\/token\/([^/]+)$/,
    ["host"],
    async ({ request, response, configStore, params }) => {
      if (request.method !== "DELETE") {
        sendJson(response, { ok: false, error: "Method not allowed" }, 405);
        return;
      }
      await configStore.removeGithubToken(decodeURIComponent(params.host));
      sendJson(response, { ok: true });
    },
  ),

  // --- Pull Requests ---

  route("GET", "/api/github/prs", async ({ response, url, configStore, cwd }) => {
    try {
      const gitCwd = await selectedGitCwd(configStore, cwd);
      const { manager } = await requireGitHubContext(configStore, gitCwd);
      const state = (url.searchParams.get("state") || "open") as "open" | "closed" | "all";
      const page = Number(url.searchParams.get("page")) || 1;
      const prs = await manager.listPRs(state, page);
      sendJson(response, { ok: true, prs });
    } catch (error) {
      sendJson(response, { ok: false, error: errorMessage(error) }, 400);
    }
  }),

  route("POST", "/api/github/prs", async ({ request, response, configStore, cwd }) => {
    try {
      const gitCwd = await selectedGitCwd(configStore, cwd);
      const { manager } = await requireGitHubContext(configStore, gitCwd);
      const body = await readJson(request);
      const title = typeof body.title === "string" ? body.title.trim() : "";
      const head = typeof body.head === "string" ? body.head.trim() : "";
      const base = typeof body.base === "string" ? body.base.trim() : "";
      if (!title || !head || !base) {
        sendJson(response, { ok: false, error: "title, head, and base are required" }, 400);
        return;
      }
      const pr = await manager.createPR({
        title,
        body: typeof body.body === "string" ? body.body : undefined,
        head,
        base,
        draft: body.draft === true,
      });
      sendJson(response, { ok: true, pr });
    } catch (error) {
      sendJson(response, { ok: false, error: errorMessage(error) }, 400);
    }
  }),

  patternRoute(
    /^\/api\/github\/prs\/(\d+)$/,
    ["number"],
    async ({ request, response, configStore, cwd, params }) => {
      if (request.method !== "GET") {
        sendJson(response, { ok: false, error: "Method not allowed" }, 405);
        return;
      }
      try {
        const gitCwd = await selectedGitCwd(configStore, cwd);
        const { manager } = await requireGitHubContext(configStore, gitCwd);
        const pr = await manager.getPR(Number(params.number));
        sendJson(response, { ok: true, pr });
      } catch (error) {
        sendJson(response, { ok: false, error: errorMessage(error) }, 400);
      }
    },
  ),

  patternRoute(
    /^\/api\/github\/prs\/(\d+)\/diff$/,
    ["number"],
    async ({ request, response, configStore, cwd, params }) => {
      if (request.method !== "GET") {
        sendJson(response, { ok: false, error: "Method not allowed" }, 405);
        return;
      }
      try {
        const gitCwd = await selectedGitCwd(configStore, cwd);
        const { manager } = await requireGitHubContext(configStore, gitCwd);
        const diff = await manager.getPRDiff(Number(params.number));
        sendText(response, diff);
      } catch (error) {
        sendJson(response, { ok: false, error: errorMessage(error) }, 400);
      }
    },
  ),

  // --- Issues ---

  route("GET", "/api/github/issues", async ({ response, url, configStore, cwd }) => {
    try {
      const gitCwd = await selectedGitCwd(configStore, cwd);
      const { manager } = await requireGitHubContext(configStore, gitCwd);
      const state = (url.searchParams.get("state") || "open") as "open" | "closed" | "all";
      const page = Number(url.searchParams.get("page")) || 1;
      const issues = await manager.listIssues(state, page);
      sendJson(response, { ok: true, issues });
    } catch (error) {
      sendJson(response, { ok: false, error: errorMessage(error) }, 400);
    }
  }),

  route("POST", "/api/github/issues", async ({ request, response, configStore, cwd }) => {
    try {
      const gitCwd = await selectedGitCwd(configStore, cwd);
      const { manager } = await requireGitHubContext(configStore, gitCwd);
      const body = await readJson(request);
      const title = typeof body.title === "string" ? body.title.trim() : "";
      if (!title) {
        sendJson(response, { ok: false, error: "title is required" }, 400);
        return;
      }
      const issue = await manager.createIssue({
        title,
        body: typeof body.body === "string" ? body.body : undefined,
      });
      sendJson(response, { ok: true, issue });
    } catch (error) {
      sendJson(response, { ok: false, error: errorMessage(error) }, 400);
    }
  }),

  patternRoute(
    /^\/api\/github\/issues\/(\d+)$/,
    ["number"],
    async ({ request, response, configStore, cwd, params }) => {
      if (request.method !== "GET") {
        sendJson(response, { ok: false, error: "Method not allowed" }, 405);
        return;
      }
      try {
        const gitCwd = await selectedGitCwd(configStore, cwd);
        const { manager } = await requireGitHubContext(configStore, gitCwd);
        const issue = await manager.getIssue(Number(params.number));
        sendJson(response, { ok: true, issue });
      } catch (error) {
        sendJson(response, { ok: false, error: errorMessage(error) }, 400);
      }
    },
  ),

  patternRoute(
    /^\/api\/github\/issues\/(\d+)\/comments$/,
    ["number"],
    async ({ request, response, configStore, cwd, params }) => {
      const gitCwd = await selectedGitCwd(configStore, cwd);
      const number = Number(params.number);

      if (request.method === "GET") {
        try {
          const { manager } = await requireGitHubContext(configStore, gitCwd);
          const comments = await manager.listIssueComments(number);
          sendJson(response, { ok: true, comments });
        } catch (error) {
          sendJson(response, { ok: false, error: errorMessage(error) }, 400);
        }
        return;
      }

      if (request.method === "POST") {
        try {
          const { manager } = await requireGitHubContext(configStore, gitCwd);
          const body = await readJson(request);
          const text = typeof body.body === "string" ? body.body.trim() : "";
          if (!text) {
            sendJson(response, { ok: false, error: "body is required" }, 400);
            return;
          }
          const comment = await manager.addIssueComment(number, text);
          sendJson(response, { ok: true, comment });
        } catch (error) {
          sendJson(response, { ok: false, error: errorMessage(error) }, 400);
        }
        return;
      }

      sendJson(response, { ok: false, error: "Method not allowed" }, 405);
    },
  ),

  // --- CI / Actions ---

  patternRoute(
    /^\/api\/github\/ci\/([0-9a-f]{4,64})$/,
    ["sha"],
    async ({ request, response, configStore, cwd, params }) => {
      if (request.method !== "GET") {
        sendJson(response, { ok: false, error: "Method not allowed" }, 405);
        return;
      }
      try {
        const gitCwd = await selectedGitCwd(configStore, cwd);
        const ctx = await optionalGitHubContext(configStore, gitCwd);
        if (!ctx) {
          sendJson(response, { ok: true, status: { sha: params.sha, state: "unknown", totalCount: 0, runs: [] } });
          return;
        }
        const status = await ctx.manager.getCommitChecks(params.sha);
        sendJson(response, { ok: true, status });
      } catch (error) {
        sendJson(response, { ok: false, error: errorMessage(error) }, 400);
      }
    },
  ),

  route("GET", "/api/github/runs", async ({ response, url, configStore, cwd }) => {
    try {
      const gitCwd = await selectedGitCwd(configStore, cwd);
      const { manager } = await requireGitHubContext(configStore, gitCwd);
      const branch = url.searchParams.get("branch") || undefined;
      const page = Number(url.searchParams.get("page")) || 1;
      const runs = await manager.listWorkflowRuns(branch, page);
      sendJson(response, { ok: true, runs });
    } catch (error) {
      sendJson(response, { ok: false, error: errorMessage(error) }, 400);
    }
  }),
];
