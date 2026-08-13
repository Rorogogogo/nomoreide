import type { ServerResponse } from "node:http";
import type { ConfigStore } from "../../core/config-store.js";
import {
  providerCliStatus,
  publicProviderConnection,
} from "../../core/providers/credentials.js";
import {
  deployProviderManifests,
  requireDeployProvider,
  requireProviderActions,
  requireProviderContext,
  type ProviderContext,
  type RegisteredDeployProvider,
} from "../../core/providers/registry.js";
import {
  beginLogin,
  completeLogin,
  loopbackCallbackUrl,
  LoginSessions,
} from "../../core/providers/oauth.js";
import { getSelectedGitRepository, selectedGitCwd } from "../dashboard.js";
import { readForm, readJson, requiredFormValue, sendHtml, sendJson } from "../http-utils.js";
import { errorMessage, patternRoute, route, type Route } from "./context.js";

/**
 * Deploy-provider visibility and controls, for every registered provider.
 *
 * Nothing below names a provider: the id is a path segment, the client comes
 * from the registry, and which actions exist comes from the provider's
 * manifest. Adding Cloudflare adds no route.
 *
 * Reads go through the read-safe `DeployProvider`; the state-changing
 * operations are funnelled through the single
 * `POST /api/providers/:id/deployments/:deployment/:action` route below, so the
 * write boundary has exactly one door.
 *
 * `status`, `projects`, and `deployments` are read on mount — they are
 * mirrored in `website/src/mock-api.ts`.
 */

/**
 * Sign-ins awaiting their browser callback, plus the outcome of the most
 * recent one, per provider. Module state because the flow spans two unrelated
 * requests (the dashboard's `start`, then the browser's `callback`) and the UI
 * polls for the result rather than holding a connection open.
 */
const loginSessions = new LoginSessions();
type LoginPhase =
  | { phase: "idle" | "pending" | "connected" }
  | { phase: "error"; error: string };
const loginPhases = new Map<string, LoginPhase>();

/** Which provider a pending sign-in belongs to, so the callback can store its tokens. */
const pendingProviders = new Map<string, string>();

const loginPhase = (providerId: string): LoginPhase =>
  loginPhases.get(providerId) ?? { phase: "idle" };

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

/** `/api/providers/:id/<suffix>`, with the id captured. */
function providerRoute(suffix: string, handle: Route["handle"]): Route {
  return patternRoute(
    new RegExp(`^/api/providers/([^/]+)/${suffix}$`),
    ["provider", ...captureNames(suffix)],
    handle,
  );
}

/** Names for the capture groups a suffix declares, in order. */
function captureNames(suffix: string): string[] {
  return [...suffix.matchAll(/\(\?<(\w+)>/g)].map((match) => match[1]);
}

function methodNotAllowed(response: ServerResponse): void {
  sendJson(response, { ok: false, error: "Method not allowed" }, 405);
}

export const providerRoutes: Route[] = [
  /** The registry itself — what the dashboard renders a tab for. */
  route("GET", "/api/providers", async ({ response }) => {
    sendJson(response, { ok: true, providers: deployProviderManifests() });
  }),

  // --- Browser sign-in (OAuth authorization code + PKCE, loopback redirect) ---

  providerRoute("oauth/start", async ({ request, response, params }) => {
    try {
      const provider = requireDeployProvider(params.provider);
      const oauth = provider.auth.oauth;
      if (!oauth) throw new Error(`${provider.manifest.name} has no browser sign-in.`);
      if (request.method !== "POST") {
        methodNotAllowed(response);
        return;
      }
      const pending = await beginLogin(oauth, loopbackCallbackUrl(oauth, request.headers.host));
      loginSessions.remember(pending);
      pendingProviders.set(pending.state, provider.manifest.id);
      loginPhases.set(provider.manifest.id, { phase: "pending" });
      sendJson(response, { ok: true, url: pending.authorizeUrl });
    } catch (error) {
      loginPhases.set(params.provider, { phase: "error", error: errorMessage(error) });
      sendJson(response, { ok: false, error: errorMessage(error) }, 500);
    }
  }),

  /**
   * Where the provider returns the user. Renders a page for the browser tab
   * rather than JSON — the dashboard learns the outcome by polling
   * `oauth/status`.
   *
   * The provider is read from the pending sign-in rather than the path, so a
   * callback can only ever store tokens for the sign-in that was actually
   * started.
   */
  providerRoute("oauth/callback", async ({ response, url, params, configStore }) => {
    const fail = (message: string) => {
      loginPhases.set(params.provider, { phase: "error", error: message });
      sendHtml(response, loginResultPage("Sign-in failed", message), 400);
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
    if (!code || !pending || !state) {
      fail("This sign-in link has expired. Start the sign-in again from NoMoreIDE.");
      return;
    }

    const providerId = pendingProviders.get(state) ?? params.provider;
    pendingProviders.delete(state);

    try {
      const provider = requireDeployProvider(providerId);
      const oauth = provider.auth.oauth;
      if (!oauth) throw new Error(`${provider.manifest.name} has no browser sign-in.`);
      const tokens = await completeLogin(oauth, pending, code);
      await configStore.setConnection(providerId, {
        source: "oauth",
        token: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
        clientId: pending.clientId,
      });
      loginPhases.set(providerId, { phase: "connected" });
      sendHtml(
        response,
        loginResultPage(
          `Connected to ${provider.manifest.name}`,
          "You can close this tab and return to NoMoreIDE.",
        ),
      );
    } catch (error) {
      fail(errorMessage(error));
    }
  }),

  providerRoute("oauth/status", async ({ response, params }) => {
    sendJson(response, { ok: true, ...loginPhase(params.provider) });
  }),

  // --- Connection ---

  providerRoute("status", async ({ response, params, configStore, cwd }) => {
    try {
      const provider = requireDeployProvider(params.provider);
      const config = await configStore.load();
      const cli = await providerCliStatus(provider.auth);
      const selectedRepository = getSelectedGitRepository(config);
      const connection = config.connections[provider.manifest.id];
      const base = {
        ok: true,
        provider: provider.manifest,
        connection: publicProviderConnection(connection),
        cliAvailable: cli.available,
        cliError: cli.error,
        repositoryName: selectedRepository?.name,
      };

      if (!connection && !cli.available) {
        sendJson(response, { ...base, status: "not_configured" });
        return;
      }

      try {
        const context = await contextFor(provider, configStore, cwd);
        const [account, scopes] = await Promise.all([
          context.provider.account(),
          context.provider.listScopes().catch(() => []),
        ]);
        sendJson(response, {
          ...base,
          // The CLI being logged in is enough to work: a user who never opened
          // this tab still gets a connected dashboard rather than a setup screen.
          connection: base.connection ?? { source: "cli" as const },
          status: context.project ? "connected" : "no_project",
          user: { username: account.username, avatar: account.avatar ?? undefined },
          scopes,
          project: context.project,
          scopeId: context.credential.scopeId,
        });
      } catch (error) {
        sendJson(response, {
          ...base,
          status: isAuthError(error) ? "auth_error" : "connection_error",
          error: errorMessage(error),
        });
      }
    } catch (error) {
      sendJson(response, { ok: false, error: errorMessage(error) }, 404);
    }
  }),

  providerRoute("connect", async ({ request, response, params, configStore }) => {
    try {
      const provider = requireDeployProvider(params.provider);

      if (request.method === "DELETE") {
        await configStore.removeConnection(provider.manifest.id);
        loginPhases.set(provider.manifest.id, { phase: "idle" });
        sendJson(response, { ok: true });
        return;
      }
      if (request.method !== "POST") {
        methodNotAllowed(response);
        return;
      }

      const form = await readForm(request);
      if (form.get("source")?.trim() === "cli") {
        const session = await provider.auth.cliSession?.(process.env);
        if (!session) throw new Error(provider.auth.messages.cliMissing);
        await configStore.setConnection(provider.manifest.id, {
          source: "cli",
          scopeId: session.currentScope,
        });
      } else {
        await configStore.setConnection(provider.manifest.id, {
          source: "stored",
          token: requiredFormValue(form, "token"),
        });
      }
      sendJson(response, { ok: true });
    } catch (error) {
      sendJson(response, { ok: false, error: errorMessage(error) }, 400);
    }
  }),

  providerRoute("scope", async ({ request, response, params, configStore }) => {
    if (request.method !== "PUT") {
      methodNotAllowed(response);
      return;
    }
    try {
      const provider = requireDeployProvider(params.provider);
      const body = await readJson(request);
      await configStore.setConnectionScope(provider.manifest.id, {
        scopeId: typeof body.scopeId === "string" ? body.scopeId : undefined,
        scopeSlug: typeof body.scopeSlug === "string" ? body.scopeSlug : undefined,
      });
      sendJson(response, { ok: true });
    } catch (error) {
      sendJson(response, { ok: false, error: errorMessage(error) }, 400);
    }
  }),

  // --- Projects ---

  providerRoute("projects", async ({ response, url, params, configStore, cwd }) => {
    try {
      const context = await contextFor(requireDeployProvider(params.provider), configStore, cwd);
      const search = url.searchParams.get("search")?.trim() || undefined;
      sendJson(response, {
        ok: true,
        projects: await context.provider.listProjects({ search }),
        linkedProjectId: context.project?.id,
      });
    } catch (error) {
      sendJson(response, { ok: false, error: errorMessage(error) }, 500);
    }
  }),

  /**
   * GET: the linked project read in full. `status` already carries a project,
   * but it may have come from the list endpoint, which omits build settings —
   * this always reads the single-project endpoint so the settings panel gets
   * them. PUT: pin (or clear, with an empty projectId) the repo's project.
   */
  providerRoute("project", async ({ request, response, params, configStore, cwd }) => {
    try {
      const provider = requireDeployProvider(params.provider);

      if (request.method === "PUT") {
        const body = await readJson(request);
        const config = await configStore.load();
        const repository = getSelectedGitRepository(config);
        if (!repository) throw new Error("No Git repository is selected.");
        await configStore.setProviderProject(
          provider.manifest.id,
          repository.name,
          typeof body.projectId === "string" ? body.projectId : undefined,
        );
        sendJson(response, { ok: true });
        return;
      }
      if (request.method !== "GET") {
        methodNotAllowed(response);
        return;
      }

      const context = await contextFor(provider, configStore, cwd);
      sendJson(response, {
        ok: true,
        project: await context.provider.getProject(requireProjectId(context)),
      });
    } catch (error) {
      sendJson(response, { ok: false, error: errorMessage(error) }, request.method === "PUT" ? 400 : 500);
    }
  }),

  // --- Environment variables ---

  /** Keys only — values are never in a list response. Read on mount, so mirrored in the website mock. */
  providerRoute("env", async ({ request, response, params, configStore, cwd }) => {
    try {
      const provider = requireDeployProvider(params.provider);
      const context = await contextFor(provider, configStore, cwd);

      if (request.method === "GET") {
        sendJson(response, {
          ok: true,
          env: await requireCapability(context, "listEnv")(requireProjectId(context)),
        });
        return;
      }
      if (request.method !== "POST") {
        methodNotAllowed(response);
        return;
      }

      // Add a variable. Guarded like the deployment actions below: dashboard-only, no MCP tool.
      const body = await readJson(request);
      const actions = await requireProviderActions(provider.manifest.id, configStore);
      if (!actions.createEnv) throw new Error("This provider cannot add environment variables.");
      const key = typeof body.key === "string" ? body.key.trim() : "";
      const environments = Array.isArray(body.environments)
        ? body.environments.filter((entry): entry is string => typeof entry === "string")
        : [];
      if (!key) throw new Error("A key is required.");
      if (environments.length === 0) throw new Error("Choose at least one environment.");
      sendJson(response, {
        ok: true,
        env: await actions.createEnv(requireProjectId(context), {
          key,
          value: typeof body.value === "string" ? body.value : "",
          environments,
          type: body.type === "plain" ? "plain" : "encrypted",
        }),
      });
    } catch (error) {
      // A failed read is a server-side problem; a rejected write is the
      // caller's. The split routes this replaced drew that line too.
      sendJson(response, { ok: false, error: errorMessage(error) }, request.method === "GET" ? 500 : 400);
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
  providerRoute("env/(?<env>[^/]+)/reveal", async ({ request, response, params, configStore, cwd }) => {
    if (request.method !== "POST") {
      methodNotAllowed(response);
      return;
    }
    try {
      const context = await contextFor(requireDeployProvider(params.provider), configStore, cwd);
      sendJson(response, {
        ok: true,
        value: await requireCapability(context, "getEnvValue")(
          requireProjectId(context),
          decodeURIComponent(params.env),
        ),
      });
    } catch (error) {
      sendJson(response, { ok: false, error: errorMessage(error) }, 400);
    }
  }),

  /** Update or delete one variable. Same write boundary as `createEnv` above. */
  providerRoute("env/(?<env>[^/]+)", async ({ request, response, params, configStore, cwd }) => {
    if (request.method !== "PATCH" && request.method !== "DELETE") {
      methodNotAllowed(response);
      return;
    }
    try {
      const provider = requireDeployProvider(params.provider);
      const context = await contextFor(provider, configStore, cwd);
      const actions = await requireProviderActions(provider.manifest.id, configStore);
      const projectId = requireProjectId(context);
      const envId = decodeURIComponent(params.env);

      if (request.method === "DELETE") {
        if (!actions.deleteEnv) throw new Error("This provider cannot delete environment variables.");
        await actions.deleteEnv(projectId, envId);
        sendJson(response, { ok: true });
        return;
      }

      if (!actions.updateEnv) throw new Error("This provider cannot change environment variables.");
      const body = await readJson(request);
      const environments = Array.isArray(body.environments)
        ? body.environments.filter((entry): entry is string => typeof entry === "string")
        : undefined;
      sendJson(response, {
        ok: true,
        env: await actions.updateEnv(projectId, envId, {
          value: typeof body.value === "string" && body.value !== "" ? body.value : undefined,
          environments,
        }),
      });
    } catch (error) {
      sendJson(response, { ok: false, error: errorMessage(error) }, 400);
    }
  }),

  // --- Domains ---

  providerRoute("domains", async ({ response, params, configStore, cwd }) => {
    try {
      const context = await contextFor(requireDeployProvider(params.provider), configStore, cwd);
      sendJson(response, {
        ok: true,
        domains: await requireCapability(context, "listDomains")(requireProjectId(context)),
      });
    } catch (error) {
      sendJson(response, { ok: false, error: errorMessage(error) }, 500);
    }
  }),

  // --- Deployments ---

  providerRoute("deployments", async ({ response, url, params, configStore, cwd }) => {
    try {
      const context = await contextFor(requireDeployProvider(params.provider), configStore, cwd);
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
        deployments: await context.provider.listDeployments({
          projectId: context.project.id,
          target,
          limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, 100) : undefined,
        }),
      });
    } catch (error) {
      sendJson(response, { ok: false, error: errorMessage(error) }, 500);
    }
  }),

  providerRoute(
    "deployments/(?<deployment>[^/]+)/logs",
    async ({ request, response, url, params, configStore, cwd }) => {
      if (request.method !== "GET") {
        methodNotAllowed(response);
        return;
      }
      try {
        const context = await contextFor(requireDeployProvider(params.provider), configStore, cwd);
        const limit = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
        sendJson(response, {
          ok: true,
          logs: await context.provider.buildLogs(
            decodeURIComponent(params.deployment),
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
   * when the provider or the account's plan does not serve them.
   */
  providerRoute(
    "deployments/(?<deployment>[^/]+)/runtime-logs",
    async ({ request, response, url, params, configStore, cwd }) => {
      if (request.method !== "GET") {
        methodNotAllowed(response);
        return;
      }
      try {
        const context = await contextFor(requireDeployProvider(params.provider), configStore, cwd);
        const limit = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
        sendJson(response, {
          ok: true,
          logs:
            (await context.provider.runtimeLogs?.(
              decodeURIComponent(params.deployment),
              Number.isFinite(limit) && limit > 0 ? Math.min(limit, 1_000) : undefined,
            )) ?? [],
        });
      } catch (error) {
        sendJson(response, { ok: false, error: errorMessage(error) }, 500);
      }
    },
  ),

  /**
   * The write boundary's single door. Every deploy-changing operation arrives
   * here, POST-only and named in the path, so there is one place to audit what
   * a provider can change and one place a guard would go. Which names are
   * legal comes from the manifest, not from this file.
   */
  providerRoute(
    "deployments/(?<deployment>[^/]+)/(?<action>[^/]+)",
    async ({ request, response, params, configStore, cwd }) => {
      if (request.method !== "POST") {
        methodNotAllowed(response);
        return;
      }
      try {
        const provider = requireDeployProvider(params.provider);
        if (!provider.manifest.actions.includes(params.action)) {
          sendJson(
            response,
            { ok: false, error: `${provider.manifest.name} has no action "${params.action}".` },
            404,
          );
          return;
        }
        const context = await contextFor(provider, configStore, cwd);
        const actions = await requireProviderActions(provider.manifest.id, configStore);
        const deploymentId = decodeURIComponent(params.deployment);

        // Actions that recreate a deployment need the original's name and
        // target, or a production retry silently comes back as a preview.
        const original = await context.provider.getDeployment(deploymentId).catch(() => undefined);
        const result = await actions.run(params.action, {
          deploymentId,
          projectId: context.project?.id,
          name: original?.name,
          target: original?.target,
          description: `${params.action} from NoMoreIDE`,
        });
        sendJson(response, { ok: true, ...result });
      } catch (error) {
        sendJson(response, { ok: false, error: errorMessage(error) }, 400);
      }
    },
  ),

  providerRoute(
    "deployments/(?<deployment>[^/]+)",
    async ({ request, response, params, configStore, cwd }) => {
      if (request.method !== "GET") {
        methodNotAllowed(response);
        return;
      }
      try {
        const context = await contextFor(requireDeployProvider(params.provider), configStore, cwd);
        sendJson(response, {
          ok: true,
          deployment: await context.provider.getDeployment(decodeURIComponent(params.deployment)),
        });
      } catch (error) {
        sendJson(response, { ok: false, error: errorMessage(error) }, 500);
      }
    },
  ),
];

/**
 * The provider client for whichever repository is selected. Every
 * project-scoped read above opens with this same two-step, so it lives here
 * rather than being repeated per route.
 */
async function contextFor(
  provider: RegisteredDeployProvider,
  configStore: ConfigStore,
  cwd: string,
): Promise<ProviderContext> {
  return requireProviderContext(
    provider.manifest.id,
    configStore,
    await selectedGitCwd(configStore, cwd),
  );
}

function requireProjectId(context: ProviderContext): string {
  if (!context.project) {
    throw new Error("No project is linked to this repository.");
  }
  return context.project.id;
}

/**
 * A capability-gated read, or a throw naming what is missing. The generic view
 * hides these tabs using the manifest, so reaching one means either a stale
 * client or a hand-written request.
 */
function requireCapability<K extends "listEnv" | "getEnvValue" | "listDomains">(
  context: ProviderContext,
  capability: K,
): NonNullable<ProviderContext["provider"][K]> {
  const method = context.provider[capability];
  if (!method) throw new Error(`This provider does not support ${capability}.`);
  return method.bind(context.provider) as NonNullable<ProviderContext["provider"][K]>;
}

/**
 * Auth failures get their own status so the UI offers reconnect rather than
 * retry. Duck-typed on `status` because the error class belongs to whichever
 * provider raised it, and this file must not know their names.
 */
function isAuthError(error: unknown): boolean {
  const status = (error as { status?: unknown })?.status;
  return status === 401 || status === 403;
}
