import { selectedGitCwd } from "../dashboard.js";
import { readForm, readJson, requiredFormValue, sendJson, sendText } from "../http-utils.js";
import { errorMessage, patternRoute, route, type Route } from "./context.js";
import { requireGitHubContext, optionalGitHubContext } from "./github-context.js";

const GITHUB_DEVICE_CODE_URL = "https://github.com/login/device/code";
const GITHUB_ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_SCOPES = "repo workflow read:org";
const DEFAULT_GITHUB_CLIENT_ID = "Ov23litfv3LE0LevxlT2";

function getClientId(): string | undefined {
  return process.env.NOMOREIDE_GITHUB_CLIENT_ID?.trim() || DEFAULT_GITHUB_CLIENT_ID;
}

export const githubRoutes: Route[] = [
  // --- Token management ---

  route("GET", "/api/github/token", async ({ response, configStore }) => {
    const config = await configStore.load();
    const token = configStore.getGithubToken(config);
    sendJson(response, {
      ok: true,
      configured: !!token,
      deviceFlowAvailable: !!getClientId(),
    });
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

  // --- OAuth Device Flow ---

  route("POST", "/api/github/oauth/start", async ({ response }) => {
    const clientId = getClientId();
    if (!clientId) {
      sendJson(response, { ok: false, error: "NOMOREIDE_GITHUB_CLIENT_ID is not set." }, 400);
      return;
    }
    try {
      const res = await fetch(GITHUB_DEVICE_CODE_URL, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: clientId, scope: GITHUB_SCOPES }),
      });
      const data = await res.json() as {
        device_code?: string;
        user_code?: string;
        verification_uri?: string;
        verification_uri_complete?: string;
        expires_in?: number;
        interval?: number;
        error?: string;
        error_description?: string;
      };
      if (data.error) {
        sendJson(response, { ok: false, error: data.error_description ?? data.error }, 400);
        return;
      }
      sendJson(response, {
        ok: true,
        device_code: data.device_code,
        user_code: data.user_code,
        verification_uri: data.verification_uri,
        verification_uri_complete: data.verification_uri_complete ?? data.verification_uri,
        expires_in: data.expires_in ?? 900,
        interval: data.interval ?? 5,
      });
    } catch (error) {
      sendJson(response, { ok: false, error: errorMessage(error) }, 500);
    }
  }),

  route("POST", "/api/github/oauth/poll", async ({ request, response, configStore }) => {
    const clientId = getClientId();
    if (!clientId) {
      sendJson(response, { ok: false, error: "NOMOREIDE_GITHUB_CLIENT_ID is not set." }, 400);
      return;
    }
    try {
      const body = await readJson(request);
      const deviceCode = typeof body.device_code === "string" ? body.device_code : "";
      if (!deviceCode) {
        sendJson(response, { ok: false, error: "device_code is required" }, 400);
        return;
      }
      const res = await fetch(GITHUB_ACCESS_TOKEN_URL, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: clientId,
          device_code: deviceCode,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
      });
      const data = await res.json() as {
        access_token?: string;
        token_type?: string;
        scope?: string;
        error?: string;
        error_description?: string;
      };
      if (data.access_token) {
        await configStore.setGithubToken("github.com", data.access_token);
        sendJson(response, { ok: true, done: true });
        return;
      }
      // authorization_pending and slow_down are expected — not errors
      const pending = data.error === "authorization_pending" || data.error === "slow_down";
      if (pending) {
        sendJson(response, { ok: true, done: false, slowDown: data.error === "slow_down" });
        return;
      }
      sendJson(response, {
        ok: false,
        error: data.error_description ?? data.error ?? "Authorization failed",
      }, 400);
    } catch (error) {
      sendJson(response, { ok: false, error: errorMessage(error) }, 500);
    }
  }),

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
    /^\/api\/github\/prs\/(\d+)\/merge$/,
    ["number"],
    async ({ request, response, configStore, cwd, params }) => {
      if (request.method !== "POST") {
        sendJson(response, { ok: false, error: "Method not allowed" }, 405);
        return;
      }
      try {
        const gitCwd = await selectedGitCwd(configStore, cwd);
        const { manager } = await requireGitHubContext(configStore, gitCwd);
        const body = await readJson(request).catch(() => ({}) as Record<string, unknown>);
        const requested = typeof body.method === "string" ? body.method : "squash";
        const method = (["merge", "squash", "rebase"].includes(requested)
          ? requested
          : "squash") as "merge" | "squash" | "rebase";
        const result = await manager.mergePR(Number(params.number), {
          method,
          commitTitle: typeof body.commitTitle === "string" ? body.commitTitle : undefined,
          commitMessage: typeof body.commitMessage === "string" ? body.commitMessage : undefined,
        });
        sendJson(response, { ok: true, ...result });
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

  patternRoute(
    /^\/api\/github\/runs\/(\d+)\/jobs$/,
    ["runId"],
    async ({ request, response, configStore, cwd, params }) => {
      if (request.method !== "GET") {
        sendJson(response, { ok: false, error: "Method not allowed" }, 405);
        return;
      }
      try {
        const gitCwd = await selectedGitCwd(configStore, cwd);
        const { manager } = await requireGitHubContext(configStore, gitCwd);
        const jobs = await manager.listWorkflowRunJobs(Number(params.runId));
        sendJson(response, { ok: true, jobs });
      } catch (error) {
        sendJson(response, { ok: false, error: errorMessage(error) }, 400);
      }
    },
  ),
];
