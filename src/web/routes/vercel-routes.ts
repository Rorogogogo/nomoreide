import type { ConfigStore } from "../../core/config-store.js";
import { getSelectedGitRepository, selectedGitCwd } from "../dashboard.js";
import {
  publicVercelConnection,
  readVercelCliSession,
  vercelCliStatus,
} from "../../core/vercel-auth.js";
import { VercelApiError } from "../../core/vercel-manager.js";
import {
  requireVercelActions,
  requireVercelContext,
} from "../../core/vercel-context.js";
import {
  beginVercelLogin,
  completeVercelLogin,
  vercelCallbackUrl,
  VercelLoginSessions,
} from "../../core/vercel-oauth.js";
import { readForm, readJson, requiredFormValue, sendHtml, sendJson } from "../http-utils.js";
import { errorMessage, patternRoute, route, type Route } from "./context.js";

/**
 * Vercel deployment visibility and controls.
 *
 * Reads go through the read-safe `VercelManager`; the four state-changing
 * operations are funnelled through the single `POST /api/vercel/deployments/
 * :id/:action` route below so the write boundary has exactly one door.
 *
 * `status`, `projects`, and `deployments` are read on mount — they are
 * mirrored in `website/src/mock-api.ts`.
 */
/**
 * Sign-ins awaiting their browser callback, plus the outcome of the most
 * recent one. Module state because the flow spans two unrelated requests (the
 * dashboard's `start`, then the browser's `callback`) and the UI polls for the
 * result rather than holding a connection open.
 */
const loginSessions = new VercelLoginSessions();
type LoginPhase =
  | { phase: "idle" | "pending" | "connected" }
  | { phase: "error"; error: string };
let loginPhase: LoginPhase = { phase: "idle" };

/** Error text reaches this page from the network, so it is escaped, not interpolated raw. */
function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char,
  );
}

function loginResultPage(heading: string, rawDetail: string): string {
  const detail = escapeHtml(rawDetail);
  return `<!doctype html><html><head><meta charset="utf-8"><title>${heading}</title>
<style>body{font:15px/1.5 ui-sans-serif,system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;color:#111}
@media(prefers-color-scheme:dark){body{background:#0a0a0a;color:#fafafa}}
div{text-align:center;max-width:32rem;padding:2rem}p{opacity:.7}</style></head>
<body><div><h2>${heading}</h2><p>${detail}</p></div></body></html>`;
}

export const vercelRoutes: Route[] = [
  // --- Browser sign-in (OAuth authorization code + PKCE, loopback redirect) ---

  route("POST", "/api/vercel/oauth/start", async ({ request, response }) => {
    try {
      const pending = await beginVercelLogin(vercelCallbackUrl(request.headers.host));
      loginSessions.remember(pending);
      loginPhase = { phase: "pending" };
      sendJson(response, { ok: true, url: pending.authorizeUrl });
    } catch (error) {
      loginPhase = { phase: "error", error: errorMessage(error) };
      sendJson(response, { ok: false, error: errorMessage(error) }, 500);
    }
  }),

  /**
   * Where Vercel returns the user. Renders a page for the browser tab rather
   * than JSON — the dashboard learns the outcome by polling `oauth/status`.
   */
  route("GET", "/api/vercel/oauth/callback", async ({ response, url, configStore }) => {
    const fail = (message: string) => {
      loginPhase = { phase: "error", error: message };
      sendHtml(response, loginResultPage("Vercel sign-in failed", message), 400);
    };

    const denied = url.searchParams.get("error_description") ?? url.searchParams.get("error");
    if (denied) {
      fail(denied);
      return;
    }

    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    // An unknown `state` means this callback does not match a sign-in we
    // started — a stale tab, or a forged request. Either way, no exchange.
    const pending = state ? loginSessions.take(state) : undefined;
    if (!code || !pending) {
      fail("This sign-in link has expired. Start the sign-in again from NoMoreIDE.");
      return;
    }

    try {
      const tokens = await completeVercelLogin(pending, code);
      await configStore.setVercelConnection({
        source: "oauth",
        token: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
        clientId: pending.clientId,
      });
      loginPhase = { phase: "connected" };
      sendHtml(
        response,
        loginResultPage("Connected to Vercel", "You can close this tab and return to NoMoreIDE."),
      );
    } catch (error) {
      fail(errorMessage(error));
    }
  }),

  route("GET", "/api/vercel/oauth/status", async ({ response }) => {
    sendJson(response, { ok: true, ...loginPhase });
  }),

  // --- Connection ---

  route("GET", "/api/vercel/status", async ({ response, configStore, cwd }) => {
    const config = await configStore.load();
    const cli = await vercelCliStatus();
    const selectedRepository = getSelectedGitRepository(config);
    const base = {
      ok: true,
      connection: publicVercelConnection(config.vercel),
      cliAvailable: cli.available,
      cliError: cli.error,
      repositoryName: selectedRepository?.name,
    };

    if (!config.vercel && !cli.available) {
      sendJson(response, { ...base, status: "not_configured" });
      return;
    }

    try {
      const context = await vercelContextFor(configStore, cwd);
      const [viewer, teams] = await Promise.all([
        context.manager.viewer(),
        context.manager.listTeams().catch(() => []),
      ]);
      sendJson(response, {
        ...base,
        // The CLI being logged in is enough to work: a user who never opened
        // this tab still gets a connected dashboard rather than a setup screen.
        connection: base.connection ?? { source: "cli" as const },
        status: context.project ? "connected" : "no_project",
        user: { username: viewer.username, avatar: viewer.avatar ?? undefined },
        teams,
        project: context.project,
        teamId: context.credential.teamId,
      });
    } catch (error) {
      sendJson(response, {
        ...base,
        status:
          error instanceof VercelApiError && (error.status === 401 || error.status === 403)
            ? "auth_error"
            : "connection_error",
        error: errorMessage(error),
      });
    }
  }),

  route("POST", "/api/vercel/connect", async ({ request, response, configStore }) => {
    try {
      const form = await readForm(request);
      const source = form.get("source")?.trim() === "cli" ? "cli" : "stored";
      if (source === "cli") {
        const session = await readVercelCliSession();
        if (!session) throw new Error("No Vercel CLI login found. Run `vercel login` first.");
        await configStore.setVercelConnection({
          source: "cli",
          teamId: session.currentTeam,
        });
      } else {
        await configStore.setVercelConnection({
          source: "stored",
          token: requiredFormValue(form, "token"),
        });
      }
      sendJson(response, { ok: true });
    } catch (error) {
      sendJson(response, { ok: false, error: errorMessage(error) }, 400);
    }
  }),

  route("DELETE", "/api/vercel/connect", async ({ response, configStore }) => {
    await configStore.removeVercelConnection();
    loginPhase = { phase: "idle" };
    sendJson(response, { ok: true });
  }),

  route("PUT", "/api/vercel/scope", async ({ request, response, configStore }) => {
    try {
      const body = await readJson(request);
      await configStore.setVercelScope({
        teamId: typeof body.teamId === "string" ? body.teamId : undefined,
        teamSlug: typeof body.teamSlug === "string" ? body.teamSlug : undefined,
      });
      sendJson(response, { ok: true });
    } catch (error) {
      sendJson(response, { ok: false, error: errorMessage(error) }, 400);
    }
  }),

  // --- Projects ---

  route("GET", "/api/vercel/projects", async ({ response, url, configStore, cwd }) => {
    try {
      const context = await vercelContextFor(configStore, cwd);
      const search = url.searchParams.get("search")?.trim() || undefined;
      sendJson(response, {
        ok: true,
        projects: await context.manager.listProjects({ search }),
        linkedProjectId: context.project?.id,
      });
    } catch (error) {
      sendJson(response, { ok: false, error: errorMessage(error) }, 500);
    }
  }),

  /**
   * The linked project read in full. `status` already carries a project, but it
   * may have come from the list endpoint, which omits the build settings — this
   * always reads the single-project endpoint so the settings panel gets them.
   */
  route("GET", "/api/vercel/project", async ({ response, configStore, cwd }) => {
    try {
      const context = await vercelContextFor(configStore, cwd);
      sendJson(response, {
        ok: true,
        project: await context.manager.getProject(requireProjectId(context.project?.id)),
      });
    } catch (error) {
      sendJson(response, { ok: false, error: errorMessage(error) }, 500);
    }
  }),

  /** Pin (or clear, with an empty projectId) the selected repo's project. */
  route("PUT", "/api/vercel/project", async ({ request, response, configStore }) => {
    try {
      const body = await readJson(request);
      const config = await configStore.load();
      const repository = getSelectedGitRepository(config);
      if (!repository) throw new Error("No Git repository is selected.");
      const projectId = typeof body.projectId === "string" ? body.projectId : undefined;
      await configStore.setVercelProject(repository.name, projectId);
      sendJson(response, { ok: true });
    } catch (error) {
      sendJson(response, { ok: false, error: errorMessage(error) }, 400);
    }
  }),

  // --- Environment variables ---

  /**
   * Keys only — see `VercelManager.listEnv`. Read on mount, so mirrored in
   * `website/src/mock-api.ts`.
   */
  route("GET", "/api/vercel/env", async ({ response, configStore, cwd }) => {
    try {
      const context = await vercelContextFor(configStore, cwd);
      sendJson(response, {
        ok: true,
        env: await context.manager.listEnv(requireProjectId(context.project?.id)),
      });
    } catch (error) {
      sendJson(response, { ok: false, error: errorMessage(error) }, 500);
    }
  }),

  /**
   * Reveal one variable's value.
   *
   * POST rather than GET, and one key at a time, so putting a secret on the
   * wire is always a deliberate act that leaves a request behind — the same
   * reasoning that keeps `db-write.ts` off the agent surface. This route has no
   * MCP tool for that reason.
   */
  patternRoute(
    /^\/api\/vercel\/env\/([^/]+)\/reveal$/,
    ["id"],
    async ({ request, response, configStore, cwd, params }) => {
      if (request.method !== "POST") {
        sendJson(response, { ok: false, error: "Method not allowed" }, 405);
        return;
      }
      try {
        const context = await vercelContextFor(configStore, cwd);
        sendJson(response, {
          ok: true,
          value: await context.manager.getEnvValue(
            requireProjectId(context.project?.id),
            decodeURIComponent(params.id),
          ),
        });
      } catch (error) {
        sendJson(response, { ok: false, error: errorMessage(error) }, 400);
      }
    },
  ),

  /** Add a variable. Guarded like the deployment actions below: dashboard-only, no MCP tool. */
  route("POST", "/api/vercel/env", async ({ request, response, configStore, cwd }) => {
    try {
      const body = await readJson(request);
      const context = await vercelContextFor(configStore, cwd);
      const actions = await requireVercelActions(configStore);
      const key = typeof body.key === "string" ? body.key.trim() : "";
      const target = Array.isArray(body.target)
        ? body.target.filter((entry): entry is string => typeof entry === "string")
        : [];
      if (!key) throw new Error("A key is required.");
      if (target.length === 0) throw new Error("Choose at least one environment.");
      sendJson(response, {
        ok: true,
        env: await actions.createEnv(requireProjectId(context.project?.id), {
          key,
          value: typeof body.value === "string" ? body.value : "",
          target,
          type: body.type === "plain" ? "plain" : "encrypted",
        }),
      });
    } catch (error) {
      sendJson(response, { ok: false, error: errorMessage(error) }, 400);
    }
  }),

  /** Update or delete one variable. Same write boundary as `createEnv` above. */
  patternRoute(
    /^\/api\/vercel\/env\/([^/]+)$/,
    ["id"],
    async ({ request, response, configStore, cwd, params }) => {
      if (request.method !== "PATCH" && request.method !== "DELETE") {
        sendJson(response, { ok: false, error: "Method not allowed" }, 405);
        return;
      }
      try {
        const context = await vercelContextFor(configStore, cwd);
        const actions = await requireVercelActions(configStore);
        const projectId = requireProjectId(context.project?.id);
        const envId = decodeURIComponent(params.id);

        if (request.method === "DELETE") {
          await actions.deleteEnv(projectId, envId);
          sendJson(response, { ok: true });
          return;
        }

        const body = await readJson(request);
        const target = Array.isArray(body.target)
          ? body.target.filter((entry): entry is string => typeof entry === "string")
          : undefined;
        sendJson(response, {
          ok: true,
          env: await actions.updateEnv(projectId, envId, {
            value: typeof body.value === "string" && body.value !== "" ? body.value : undefined,
            target,
          }),
        });
      } catch (error) {
        sendJson(response, { ok: false, error: errorMessage(error) }, 400);
      }
    },
  ),

  // --- Domains ---

  route("GET", "/api/vercel/domains", async ({ response, configStore, cwd }) => {
    try {
      const context = await vercelContextFor(configStore, cwd);
      sendJson(response, {
        ok: true,
        domains: await context.manager.listDomains(requireProjectId(context.project?.id)),
      });
    } catch (error) {
      sendJson(response, { ok: false, error: errorMessage(error) }, 500);
    }
  }),

  // --- Deployments ---

  route("GET", "/api/vercel/deployments", async ({ response, url, configStore, cwd }) => {
    try {
      const context = await vercelContextFor(configStore, cwd);
      if (!context.project) {
        sendJson(response, { ok: true, deployments: [], project: null });
        return;
      }
      const targetParam = url.searchParams.get("target");
      const target =
        targetParam === "production" || targetParam === "preview" ? targetParam : undefined;
      const limit = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
      sendJson(response, {
        ok: true,
        project: context.project,
        deployments: await context.manager.listDeployments({
          projectId: context.project.id,
          target,
          limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, 100) : undefined,
        }),
      });
    } catch (error) {
      sendJson(response, { ok: false, error: errorMessage(error) }, 500);
    }
  }),

  patternRoute(
    /^\/api\/vercel\/deployments\/([^/]+)$/,
    ["id"],
    async ({ request, response, configStore, cwd, params }) => {
      if (request.method !== "GET") {
        sendJson(response, { ok: false, error: "Method not allowed" }, 405);
        return;
      }
      try {
        const context = await vercelContextFor(configStore, cwd);
        sendJson(response, {
          ok: true,
          deployment: await context.manager.getDeployment(decodeURIComponent(params.id)),
        });
      } catch (error) {
        sendJson(response, { ok: false, error: errorMessage(error) }, 500);
      }
    },
  ),

  patternRoute(
    /^\/api\/vercel\/deployments\/([^/]+)\/logs$/,
    ["id"],
    async ({ request, response, url, configStore, cwd, params }) => {
      if (request.method !== "GET") {
        sendJson(response, { ok: false, error: "Method not allowed" }, 405);
        return;
      }
      try {
        const context = await vercelContextFor(configStore, cwd);
        const limit = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
        sendJson(response, {
          ok: true,
          logs: await context.manager.deploymentBuildLogs(
            decodeURIComponent(params.id),
            Number.isFinite(limit) && limit > 0 ? Math.min(limit, 2_000) : undefined,
          ),
        });
      } catch (error) {
        sendJson(response, { ok: false, error: errorMessage(error) }, 500);
      }
    },
  ),

  /**
   * Runtime logs, which answer a different question from the build logs above:
   * why a *deployed* request failed. Returns an empty list rather than an error
   * when the account's plan does not serve them.
   */
  patternRoute(
    /^\/api\/vercel\/deployments\/([^/]+)\/runtime-logs$/,
    ["id"],
    async ({ request, response, url, configStore, cwd, params }) => {
      if (request.method !== "GET") {
        sendJson(response, { ok: false, error: "Method not allowed" }, 405);
        return;
      }
      try {
        const context = await vercelContextFor(configStore, cwd);
        const limit = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
        sendJson(response, {
          ok: true,
          logs: await context.manager.deploymentRuntimeLogs(
            decodeURIComponent(params.id),
            Number.isFinite(limit) && limit > 0 ? Math.min(limit, 1_000) : undefined,
          ),
        });
      } catch (error) {
        sendJson(response, { ok: false, error: errorMessage(error) }, 500);
      }
    },
  ),

  /**
   * The write boundary's single door. Every deploy-changing operation arrives
   * here, POST-only and named in the path, so there is one place to audit what
   * this integration can change and one place a guard would go.
   */
  patternRoute(
    /^\/api\/vercel\/deployments\/([^/]+)\/(redeploy|cancel|promote|rollback)$/,
    ["id", "action"],
    async ({ request, response, configStore, cwd, params }) => {
      if (request.method !== "POST") {
        sendJson(response, { ok: false, error: "Method not allowed" }, 405);
        return;
      }
      try {
        const context = await vercelContextFor(configStore, cwd);
        const actions = await requireVercelActions(configStore);
        const deploymentId = decodeURIComponent(params.id);

        switch (params.action) {
          case "redeploy": {
            // Read the original first: a redeploy has to inherit its name and
            // target, or a production retry silently comes back as a preview.
            const deployment = await context.manager.getDeployment(deploymentId);
            sendJson(response, { ok: true, deployment: await actions.redeploy(deployment) });
            return;
          }
          case "cancel":
            await actions.cancel(deploymentId);
            break;
          case "promote":
            await actions.promote(requireProjectId(context.project?.id), deploymentId);
            break;
          case "rollback":
            await actions.rollback(
              requireProjectId(context.project?.id),
              deploymentId,
              "Rolled back from NoMoreIDE",
            );
            break;
        }
        sendJson(response, { ok: true });
      } catch (error) {
        sendJson(response, { ok: false, error: errorMessage(error) }, 400);
      }
    },
  ),
];

/**
 * The Vercel client for whichever repository is selected. Every project-scoped
 * read below opens with this same two-step, so it lives here rather than being
 * repeated per route.
 */
async function vercelContextFor(configStore: ConfigStore, cwd: string) {
  return requireVercelContext(configStore, await selectedGitCwd(configStore, cwd));
}

function requireProjectId(projectId: string | undefined): string {
  if (!projectId) {
    throw new Error("No Vercel project is linked to this repository.");
  }
  return projectId;
}
