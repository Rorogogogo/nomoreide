/**
 * Profile registry endpoints (ROR-63): browser sign-in to the hosted registry
 * (the brainctl platform, kept as-is), plus publish / install-from-registry /
 * register-github flows for agent profiles.
 *
 * Must be registered BEFORE `agentProfileRoutes`: its `/profiles/:name`
 * pattern would otherwise swallow the exact `install-from-registry` and
 * `register-github` paths with a 405.
 *
 * `GET /api/agent-env/auth/status` is read-on-mount — it has a matching
 * handler in `website/src/mock-api.ts`.
 */
import { randomBytes } from "node:crypto";
import { z } from "zod";
import {
  createRegistryClient,
  createRegistryTokenManager,
  installProfileFromRegistry,
  publishProfileToRegistry,
  resolveRegistryApiBaseUrl,
  resolveRegistryApiTarget,
  resolveRegistryApiToken,
  resolveRegistryFrontendUrl,
} from "../../core/agent-profiles/index.js";
import { readJson, sendHtml, sendJson } from "../http-utils.js";
import { errorMessage, patternRoute, route, type Route } from "./context.js";

const publishBodySchema = z.object({
  slug: z.string().min(1),
  title: z.string().min(1),
  summary: z.string().optional(),
  version: z.string().optional(),
  changelog: z.string().optional(),
  visibility: z.enum(["public", "private"]).optional(),
});

const installBodySchema = z.object({
  slug: z.string().min(1),
  force: z.boolean().optional(),
  as: z.string().min(1).optional(),
  credentials: z.record(z.string()).optional(),
});

const registerGithubBodySchema = z.object({
  repoUrl: z.string().min(1),
  slug: z.string().min(1),
  title: z.string().min(1),
  summary: z.string().optional(),
  refName: z.string().optional(),
  profilePath: z.string().optional(),
});

const registryProfilesQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  sort: z.enum(["recent", "stars", "downloads", "alpha"]).default("recent"),
});

type AuthOutcome =
  | { status: "pending" }
  | { status: "success" }
  | { status: "error"; message: string };

interface AuthStateEntry {
  expiresAt: number;
  outcome: AuthOutcome;
}

const AUTH_STATE_TTL_MS = 10 * 60 * 1000;
const OUTCOME_RETENTION_MS = 60 * 1000;

const tokenManager = createRegistryTokenManager();
const pendingAuthStates = new Map<string, AuthStateEntry>();

function newAuthState(): string {
  const now = Date.now();
  for (const [key, entry] of pendingAuthStates) {
    if (entry.expiresAt < now) pendingAuthStates.delete(key);
  }
  const state = randomBytes(16).toString("hex");
  pendingAuthStates.set(state, {
    expiresAt: now + AUTH_STATE_TTL_MS,
    outcome: { status: "pending" },
  });
  return state;
}

function validAuthState(state: string | null): AuthStateEntry | null {
  if (!state) return null;
  const entry = pendingAuthStates.get(state);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    pendingAuthStates.delete(state);
    return null;
  }
  return entry;
}

function markAuthOutcome(state: string, outcome: AuthOutcome): void {
  const entry = pendingAuthStates.get(state);
  if (!entry) return;
  entry.outcome = outcome;
  if (outcome.status !== "pending") entry.expiresAt = Date.now() + OUTCOME_RETENTION_MS;
}

/** Upstream registry errors carry "HTTP <code>" — surface 4xx as-is, else 502. */
function upstreamStatus(message: string): number {
  const code = /HTTP (\d{3})/.exec(message)?.[1];
  return code && /^4\d\d$/.test(code) ? Number(code) : 502;
}

function installStatus(message: string): number {
  if (message.includes("already exists")) return 409;
  if (
    message.startsWith("Profile archive contains") ||
    message.startsWith("Archive has") ||
    message.startsWith("Archive is missing") ||
    message.startsWith("This is a brainctl-era profile archive") ||
    message.startsWith("Could not extract the archive")
  ) {
    return 422;
  }
  return upstreamStatus(message);
}

function authResultHtml(kind: "ok" | "error", message: string): string {
  const tone = kind === "ok" ? "#16a34a" : "#dc2626";
  const title = kind === "ok" ? "Signed in" : "Sign-in failed";
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title} — NoMoreIDE</title></head>
<body style="font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0">
<div style="text-align:center;max-width:28rem;padding:1rem">
<h1 style="color:${tone};font-size:1.25rem">${title}</h1>
<p style="color:#555">${message}</p>
</div></body></html>`;
}

export const agentRegistryRoutes: Route[] = [
  route("GET", "/api/agent-env/registry/profiles", async ({ response, url }) => {
    const query = registryProfilesQuerySchema.safeParse({
      q: url.searchParams.get("q") || undefined,
      sort: url.searchParams.get("sort") || undefined,
    });
    if (!query.success) {
      sendJson(response, { ok: false, error: "Invalid registry profile query." }, 400);
      return;
    }
    try {
      const client = createRegistryClient({
        baseUrl: await resolveRegistryApiBaseUrl(),
      });
      const profiles = await client.listPublicProfiles({
        query: query.data.q,
        sort: query.data.sort,
      });
      sendJson(response, {
        ok: true,
        profiles: profiles.map((profile) => {
          const manifest = profile.latest_version.manifest_json;
          return {
            id: profile.id,
            slug: profile.slug,
            title: profile.title,
            summary: profile.summary,
            version: profile.latest_version.version,
            sourceKind: profile.source.kind,
            githubRepoUrl: profile.source.github_repo_url ?? undefined,
            starsCount: profile.stars_count,
            downloadsCount: profile.downloads_count,
            author: profile.author
              ? {
                  id: profile.author.id,
                  displayName: profile.author.display_name ?? undefined,
                  avatarUrl: profile.author.avatar_url ?? undefined,
                }
              : undefined,
            publishedAt: profile.latest_version.published_at ?? undefined,
            mcpCount: Array.isArray(manifest.mcps) ? manifest.mcps.length : 0,
            skillCount: Array.isArray(manifest.skills) ? manifest.skills.length : 0,
            pluginCount: Array.isArray(manifest.plugins) ? manifest.plugins.length : 0,
          };
        }),
      });
    } catch (error) {
      const message = errorMessage(error);
      sendJson(response, { ok: false, error: message }, upstreamStatus(message));
    }
  }),

  route("GET", "/api/agent-env/auth/status", async ({ response }) => {
    const target = await resolveRegistryApiTarget();
    const apiFrontendUrl = await resolveRegistryFrontendUrl({ apiBaseUrl: target.apiBaseUrl });
    const apiInfo = {
      apiBaseUrl: target.apiBaseUrl,
      apiMode: target.mode,
      apiSource: target.source,
      apiFrontendUrl,
    };
    const resolved = await resolveRegistryApiToken();
    if (!resolved) {
      sendJson(response, { ok: true, signedIn: false, ...apiInfo });
      return;
    }
    try {
      const me = await tokenManager.authenticatedFetch("/me");
      if (!me.ok) {
        sendJson(response, {
          ok: true,
          signedIn: false,
          source: resolved.source,
          error: `HTTP ${me.status}`,
          ...apiInfo,
        });
        return;
      }
      const user = (await me.json()) as {
        email?: string;
        display_name?: string;
        avatar_url?: string | null;
      };
      sendJson(response, {
        ok: true,
        signedIn: true,
        source: resolved.source,
        user: {
          email: user.email,
          displayName: user.display_name,
          avatarUrl: user.avatar_url ?? undefined,
        },
        ...apiInfo,
      });
    } catch (error) {
      sendJson(response, {
        ok: true,
        signedIn: false,
        source: resolved.source,
        error: errorMessage(error),
        ...apiInfo,
      });
    }
  }),

  route("POST", "/api/agent-env/auth/start", async ({ request, response }) => {
    const state = newAuthState();
    const apiBaseUrl = await resolveRegistryApiBaseUrl();
    const frontendBase = await resolveRegistryFrontendUrl({ apiBaseUrl });
    const host = request.headers.host ?? "127.0.0.1:4317";
    const callback = `http://${host}/api/agent-env/auth/finish?state=${encodeURIComponent(state)}`;
    const url = `${frontendBase}/cli-login?state=${encodeURIComponent(state)}&callback=${encodeURIComponent(callback)}`;
    sendJson(response, { ok: true, url, state });
  }),

  // Browser redirect target after platform sign-in; renders HTML, not JSON.
  route("GET", "/api/agent-env/auth/finish", async ({ response, url }) => {
    const state = url.searchParams.get("state");
    const token = url.searchParams.get("token");
    const refreshToken = url.searchParams.get("refresh_token");
    const errorParam = url.searchParams.get("error");

    if (!validAuthState(state)) {
      sendHtml(response, authResultHtml("error", "Invalid or expired sign-in request."), 400);
      return;
    }
    if (errorParam) {
      markAuthOutcome(state!, { status: "error", message: errorParam });
      sendHtml(response, authResultHtml("error", errorParam), 400);
      return;
    }
    if (!token?.trim()) {
      const message = "No token returned by the registry.";
      markAuthOutcome(state!, { status: "error", message });
      sendHtml(response, authResultHtml("error", message), 400);
      return;
    }
    try {
      await tokenManager.saveTokens({
        accessToken: token.trim(),
        refreshToken: refreshToken?.trim() || undefined,
      });
      const verify = await tokenManager.authenticatedFetch("/me");
      if (!verify.ok) {
        await tokenManager.clear();
        const apiBaseUrl = await resolveRegistryApiBaseUrl();
        const message =
          verify.status === 401
            ? `Token was rejected by the registry API at ${apiBaseUrl}. The site you signed in through likely targets a different backend.`
            : `Registry API at ${apiBaseUrl} returned HTTP ${verify.status} when verifying the token.`;
        markAuthOutcome(state!, { status: "error", message });
        sendHtml(response, authResultHtml("error", message), 401);
        return;
      }
      markAuthOutcome(state!, { status: "success" });
      sendHtml(response, authResultHtml("ok", "You are signed in. You can close this tab."));
    } catch (error) {
      const message = `Failed to save token: ${errorMessage(error)}`;
      markAuthOutcome(state!, { status: "error", message });
      sendHtml(response, authResultHtml("error", message), 500);
    }
  }),

  route("GET", "/api/agent-env/auth/outcome", async ({ response, url }) => {
    const state = url.searchParams.get("state");
    const entry = validAuthState(state);
    if (!entry) {
      sendJson(response, { ok: true, status: "unknown" }, 404);
      return;
    }
    if (entry.outcome.status !== "pending" && state) pendingAuthStates.delete(state);
    sendJson(response, {
      ok: true,
      status: entry.outcome.status,
      ...(entry.outcome.status === "error" ? { message: entry.outcome.message } : {}),
    });
  }),

  route("POST", "/api/agent-env/auth/logout", async ({ response }) => {
    await tokenManager.clear();
    sendJson(response, { ok: true });
  }),

  route("POST", "/api/agent-env/profiles/install-from-registry", async ({ request, response }) => {
    const body = installBodySchema.safeParse(await readJson(request));
    if (!body.success) {
      sendJson(response, { ok: false, error: "slug is required." }, 400);
      return;
    }
    try {
      const apiBaseUrl = await resolveRegistryApiBaseUrl();
      const tokenInfo = await resolveRegistryApiToken();
      const result = await installProfileFromRegistry({
        ...body.data,
        apiBaseUrl,
        token: tokenInfo?.token,
      });
      sendJson(response, { ok: true, ...result });
    } catch (error) {
      const message = errorMessage(error);
      sendJson(response, { ok: false, error: message }, installStatus(message));
    }
  }),

  route("POST", "/api/agent-env/profiles/register-github", async ({ request, response }) => {
    const body = registerGithubBodySchema.safeParse(await readJson(request));
    if (!body.success) {
      sendJson(response, { ok: false, error: "repoUrl, slug, and title are required." }, 400);
      return;
    }
    if ((await tokenManager.getAccessToken()) === null) {
      sendJson(response, { ok: false, error: "Sign in to the registry first." }, 401);
      return;
    }
    try {
      const client = createRegistryClient({
        baseUrl: await resolveRegistryApiBaseUrl(),
        fetch: (input, init) =>
          tokenManager.authenticatedFetch(
            typeof input === "string" ? input : input.toString(),
            init,
          ),
      });
      const result = await client.registerGithubProfile({
        ...body.data,
        manifestJson: { name: body.data.slug },
      });
      sendJson(response, { ok: true, result });
    } catch (error) {
      const message = errorMessage(error);
      sendJson(response, { ok: false, error: message }, upstreamStatus(message));
    }
  }),

  patternRoute(
    /^\/api\/agent-env\/profiles\/([^/]+)\/publish$/,
    ["name"],
    async ({ request, response, params, cwd }) => {
      if (request.method !== "POST") {
        sendJson(response, { ok: false, error: "Method not allowed" }, 405);
        return;
      }
      const body = publishBodySchema.safeParse(await readJson(request));
      if (!body.success) {
        sendJson(response, { ok: false, error: "slug and title are required." }, 400);
        return;
      }
      if ((await tokenManager.getAccessToken()) === null) {
        sendJson(response, { ok: false, error: "Sign in to the registry first." }, 401);
        return;
      }
      try {
        const result = await publishProfileToRegistry({
          ...body.data,
          name: decodeURIComponent(params.name),
          cwd,
          apiBaseUrl: await resolveRegistryApiBaseUrl(),
          fetch: (input, init) =>
            tokenManager.authenticatedFetch(
              typeof input === "string" ? input : input.toString(),
              init,
            ),
        });
        sendJson(response, { ok: true, ...result });
      } catch (error) {
        const message = errorMessage(error);
        const status = message.includes("not found") ? 404 : upstreamStatus(message);
        sendJson(response, { ok: false, error: message }, status);
      }
    },
  ),
];
