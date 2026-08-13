import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ConfigStore } from "../src/core/config-store.js";
import { resetVercelOAuthDiscoveryCache } from "../src/core/vercel-oauth.js";
import { createWebServer } from "../src/web/server.js";

const execFileAsync = promisify(execFile);

let tempDir: string;
let repoPath: string;
let configPath: string;
let server: Awaited<ReturnType<ReturnType<typeof createWebServer>["start"]>>;
/** Every Vercel API call the routes made, so scoping/paths are assertable. */
let apiCalls: Array<{ url: URL; method: string; body: string | undefined }>;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "nomoreide-vercel-routes-"));
  repoPath = join(tempDir, "repo");
  configPath = join(tempDir, "nomoreide.config.json");
  apiCalls = [];
  // Discovery is cached module-wide; a case must not inherit another's stub.
  resetVercelOAuthDiscoveryCache();

  await mkdir(repoPath, { recursive: true });
  await execFileAsync("git", ["init", "-q"], { cwd: repoPath });
  await execFileAsync("git", ["remote", "add", "origin", "git@github.com:acme/web.git"], {
    cwd: repoPath,
  });
  // Background maintenance can race the fixture teardown; disable it (see ROR-83).
  await execFileAsync("git", ["config", "maintenance.auto", "false"], { cwd: repoPath });

  const configStore = new ConfigStore(configPath);
  await configStore.registerGitRepository({ name: "web", path: repoPath });
  await configStore.setConnection("vercel", { source: "stored", token: "test-token" });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await server?.stop();
  await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

/**
 * Intercept Vercel's hosts only — the server under test also serves its own
 * routes over real HTTP, and those must keep working. `vercel.com` is included
 * because OAuth discovery lives there rather than on the API host.
 */
function stubVercelApi(responder: (url: URL, method: string) => unknown): void {
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const raw = input instanceof Request ? input.url : String(input);
    if (!raw.startsWith("https://api.vercel.com") && !raw.startsWith("https://vercel.com")) {
      return realFetch(input as string | URL, init);
    }
    const url = new URL(raw);
    const method = init?.method ?? "GET";
    apiCalls.push({
      url,
      method,
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    const payload = responder(url, method);
    if (payload instanceof Response) return payload;
    return new Response(JSON.stringify(payload ?? {}), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
}

async function startServer(): Promise<void> {
  server = await createWebServer({
    configPath,
    settingsPath: join(tempDir, "settings.json"),
    logDir: join(tempDir, "logs"),
    cwd: repoPath,
    registryPath: join(tempDir, "runtime.json"),
    port: 0,
  }).start();
}

const PROJECT = { id: "prj_web", name: "acme-web", framework: "nextjs" };

const DEPLOYMENT = {
  uid: "dpl_1",
  name: "acme-web",
  url: "acme-web.vercel.app",
  readyState: "READY",
  readySubstate: "PROMOTED",
  target: "production",
  createdAt: 1_700_000_000_000,
  meta: { githubCommitRef: "main", githubCommitSha: "abc1234" },
};

describe("Vercel routes", () => {
  test("reports a connected status with the resolved project", async () => {
    // No pin and no `.vercel/project.json`, so resolution falls to the remote.
    stubVercelApi((url) => {
      if (url.pathname === "/v2/user") return { user: { id: "u1", username: "octocat" } };
      if (url.pathname === "/v2/teams") return { teams: [] };
      if (url.pathname === "/v10/projects") return { projects: [PROJECT] };
      return {};
    });
    await startServer();

    const body = await (await fetch(`${server.url}/api/vercel/status`)).json();
    expect(body).toMatchObject({
      ok: true,
      status: "connected",
      user: { username: "octocat" },
      project: { id: "prj_web", name: "acme-web" },
    });
    // The token is a secret; the status route must never hand it back.
    expect(JSON.stringify(body)).not.toContain("test-token");

    const lookup = apiCalls.find((call) => call.url.pathname === "/v10/projects");
    expect(lookup?.url.searchParams.get("repoUrl")).toBe("https://github.com/acme/web");
  });

  test("reports no_project when nothing resolves, rather than guessing", async () => {
    stubVercelApi((url) => {
      if (url.pathname === "/v2/user") return { user: { id: "u1", username: "octocat" } };
      if (url.pathname === "/v10/projects") return { projects: [] };
      return {};
    });
    await startServer();

    expect(await (await fetch(`${server.url}/api/vercel/status`)).json()).toMatchObject({
      status: "no_project",
    });
  });

  test("prefers the repo's .vercel/project.json over the remote lookup", async () => {
    await mkdir(join(repoPath, ".vercel"), { recursive: true });
    await writeFile(
      join(repoPath, ".vercel", "project.json"),
      JSON.stringify({ projectId: "prj_linked", orgId: "team_acme" }),
    );
    stubVercelApi((url) => {
      if (url.pathname === "/v2/user") return { user: { id: "u1", username: "octocat" } };
      if (url.pathname === "/v9/projects/prj_linked") {
        return { id: "prj_linked", name: "linked-app" };
      }
      return {};
    });
    await startServer();

    expect(await (await fetch(`${server.url}/api/vercel/status`)).json()).toMatchObject({
      project: { id: "prj_linked", name: "linked-app" },
    });
    expect(apiCalls.some((call) => call.url.pathname === "/v10/projects")).toBe(false);
  });

  test("lists deployments for the resolved project", async () => {
    stubVercelApi((url) => {
      if (url.pathname === "/v10/projects") return { projects: [PROJECT] };
      if (url.pathname === "/v7/deployments") return { deployments: [DEPLOYMENT] };
      return {};
    });
    await startServer();

    const body = await (
      await fetch(`${server.url}/api/vercel/deployments?target=production`)
    ).json();
    expect(body.deployments).toHaveLength(1);
    expect(body.deployments[0]).toMatchObject({
      uid: "dpl_1",
      state: "READY",
      isCurrentProduction: true,
      meta: { branch: "main", sha: "abc1234" },
    });
  });

  test("a redeploy inherits the original deployment's target", async () => {
    stubVercelApi((url, method) => {
      if (url.pathname === "/v10/projects") return { projects: [PROJECT] };
      if (url.pathname === "/v13/deployments/dpl_1") return DEPLOYMENT;
      if (url.pathname === "/v13/deployments" && method === "POST") {
        return { id: "dpl_2", url: "acme-web-dpl2.vercel.app" };
      }
      return {};
    });
    await startServer();

    const response = await fetch(`${server.url}/api/vercel/deployments/dpl_1/redeploy`, {
      method: "POST",
    });
    expect(await response.json()).toMatchObject({
      ok: true,
      deployment: { uid: "dpl_2" },
    });

    const created = apiCalls.find(
      (call) => call.url.pathname === "/v13/deployments" && call.method === "POST",
    );
    expect(JSON.parse(String(created?.body))).toMatchObject({
      deploymentId: "dpl_1",
      target: "production",
    });
  });

  test("promote reaches the project promote endpoint", async () => {
    stubVercelApi((url) => {
      if (url.pathname === "/v10/projects") return { projects: [PROJECT] };
      return {};
    });
    await startServer();

    const response = await fetch(`${server.url}/api/vercel/deployments/dpl_1/promote`, {
      method: "POST",
    });
    expect(await response.json()).toEqual({ ok: true });
    expect(
      apiCalls.some((call) => call.url.pathname === "/v10/projects/prj_web/promote/dpl_1"),
    ).toBe(true);
  });

  test("state-changing actions reject non-POST instead of acting on a GET", async () => {
    stubVercelApi(() => ({}));
    await startServer();

    const response = await fetch(`${server.url}/api/vercel/deployments/dpl_1/promote`);
    expect(response.status).toBe(405);
    // The method check runs before anything else, so production is untouched.
    expect(apiCalls.some((call) => call.url.pathname.includes("/promote/"))).toBe(false);
  });

  test("an unknown action is not routed to the action handler at all", async () => {
    stubVercelApi(() => ({}));
    await startServer();

    const response = await fetch(`${server.url}/api/vercel/deployments/dpl_1/delete`, {
      method: "POST",
    });
    expect(response.status).not.toBe(200);
    expect(apiCalls).toHaveLength(0);
  });

  test("connect stores a token and disconnect removes it", async () => {
    stubVercelApi(() => ({}));
    await startServer();

    await fetch(`${server.url}/api/vercel/connect`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ source: "stored", token: "new-token" }),
    });
    expect((await new ConfigStore(configPath).load()).connections.vercel).toMatchObject({
      source: "stored",
      token: "new-token",
    });

    await fetch(`${server.url}/api/vercel/connect`, { method: "DELETE" });
    expect((await new ConfigStore(configPath).load()).connections.vercel).toBeUndefined();
  });

  describe("browser sign-in", () => {
    /** Answers discovery, registration and the token endpoint for the OAuth flow. */
    function stubOAuthEndpoints(): void {
      stubVercelApi((url) => {
        if (url.pathname === "/.well-known/openid-configuration") {
          return {
            issuer: "https://vercel.com",
            authorization_endpoint: "https://vercel.com/oauth/authorize",
            token_endpoint: "https://api.vercel.com/login/oauth/token",
            registration_endpoint: "https://api.vercel.com/login/oauth/register",
            userinfo_endpoint: "https://api.vercel.com/login/oauth/userinfo",
          };
        }
        if (url.pathname === "/login/oauth/register") return { client_id: "cl_test" };
        if (url.pathname === "/login/oauth/token") {
          return { access_token: "at_new", refresh_token: "rt_new", expires_in: 3600 };
        }
        return {};
      });
    }

    async function startSignIn(): Promise<URL> {
      const res = await fetch(`${server.url}/api/vercel/oauth/start`, { method: "POST" });
      const body = (await res.json()) as { url: string };
      return new URL(body.url);
    }

    test("points the consent screen back at this server's loopback callback", async () => {
      stubOAuthEndpoints();
      await startServer();

      const authorize = await startSignIn();

      expect(authorize.origin + authorize.pathname).toBe("https://vercel.com/oauth/authorize");
      expect(authorize.searchParams.get("redirect_uri")).toBe(
        `${server.url}/api/vercel/oauth/callback`,
      );
      expect(authorize.searchParams.get("scope")).toBe("offline_access");
      expect(await (await fetch(`${server.url}/api/vercel/oauth/status`)).json()).toMatchObject({
        phase: "pending",
      });
    });

    test("stores the tokens the callback exchanges, without leaking them", async () => {
      stubOAuthEndpoints();
      await startServer();
      const authorize = await startSignIn();

      const callback = await fetch(
        `${server.url}/api/vercel/oauth/callback?code=the-code&state=${authorize.searchParams.get("state")}`,
      );

      expect(callback.status).toBe(200);
      expect(await (await fetch(`${server.url}/api/vercel/oauth/status`)).json()).toMatchObject({
        phase: "connected",
      });
      expect((await new ConfigStore(configPath).load()).connections.vercel).toMatchObject({
        source: "oauth",
        token: "at_new",
        refreshToken: "rt_new",
        clientId: "cl_test",
      });

      // The status route reports the connection, never its secrets.
      const status = await (await fetch(`${server.url}/api/vercel/status`)).text();
      expect(status).not.toContain("at_new");
      expect(status).not.toContain("rt_new");
    });

    test("refuses a callback whose state was never issued", async () => {
      stubOAuthEndpoints();
      await startServer();
      await startSignIn();

      const callback = await fetch(
        `${server.url}/api/vercel/oauth/callback?code=the-code&state=forged`,
      );

      expect(callback.status).toBe(400);
      // Nothing was exchanged, so the pre-existing connection stands.
      expect((await new ConfigStore(configPath).load()).connections.vercel).toMatchObject({
        source: "stored",
      });
    });

    test("reports the error when the user declines on vercel.com", async () => {
      stubOAuthEndpoints();
      await startServer();
      await startSignIn();

      const callback = await fetch(
        `${server.url}/api/vercel/oauth/callback?error=access_denied&error_description=Denied`,
      );

      expect(callback.status).toBe(400);
      expect(await (await fetch(`${server.url}/api/vercel/oauth/status`)).json()).toMatchObject({
        phase: "error",
        error: "Denied",
      });
    });
  });

  /**
   * A Vercel account keeps its projects under a team, so an unscoped client
   * lists nothing — indistinguishable from an empty account. See
   * `adoptDefaultTeam` in `vercel-context.ts`.
   */
  describe("default team scope", () => {
    test("adopts the sole team so projects are not silently empty", async () => {
      stubVercelApi((url) => {
        if (url.pathname === "/v2/user") return { user: { id: "u1", username: "octocat" } };
        if (url.pathname === "/v2/teams") {
          return { teams: [{ id: "team_1", slug: "acme", name: "Acme" }] };
        }
        if (url.pathname === "/v10/projects") {
          return { projects: url.searchParams.get("teamId") === "team_1" ? [PROJECT] : [] };
        }
        return {};
      });
      await startServer();

      const body = await (await fetch(`${server.url}/api/vercel/projects`)).json();
      expect(body.projects).toHaveLength(1);

      // Persisted, so the lookup is one-time rather than per-request.
      expect((await new ConfigStore(configPath).load()).connections.vercel).toMatchObject({
        scopeId: "team_1",
        scopeSlug: "acme",
      });
    });

    test("picks no team when several exist, rather than guessing one", async () => {
      stubVercelApi((url) => {
        if (url.pathname === "/v2/user") return { user: { id: "u1", username: "octocat" } };
        if (url.pathname === "/v2/teams") {
          return {
            teams: [
              { id: "team_1", slug: "acme", name: "Acme" },
              { id: "team_2", slug: "other", name: "Other" },
            ],
          };
        }
        return { projects: [] };
      });
      await startServer();

      await fetch(`${server.url}/api/vercel/projects`);

      expect(
        (await new ConfigStore(configPath).load()).connections.vercel?.scopeId,
      ).toBeUndefined();
      const lookup = apiCalls.find((call) => call.url.pathname === "/v10/projects");
      expect(lookup?.url.searchParams.get("teamId")).toBeNull();
    });

    test("leaves an explicitly chosen scope alone", async () => {
      await new ConfigStore(configPath).setConnectionScope("vercel", { scopeId: "team_chosen" });
      stubVercelApi((url) => {
        if (url.pathname === "/v2/teams") {
          return { teams: [{ id: "team_other", slug: "other", name: "Other" }] };
        }
        return { projects: [] };
      });
      await startServer();

      await fetch(`${server.url}/api/vercel/projects`);

      const lookup = apiCalls.find((call) => call.url.pathname === "/v10/projects");
      expect(lookup?.url.searchParams.get("teamId")).toBe("team_chosen");
    });
  });
});

describe("Vercel project-scoped reads", () => {
  /** Resolves the linked project via the git remote, as the other cases do. */
  function stubResolvedProject(extra: (url: URL, method: string) => unknown) {
    stubVercelApi((url, method) => {
      if (url.pathname === "/v2/user") return { user: { id: "u1", username: "octocat" } };
      if (url.pathname === "/v10/projects") return { projects: [PROJECT] };
      return extra(url, method);
    });
  }

  test("lists environment variables without their values", async () => {
    stubResolvedProject((url) => {
      if (url.pathname === "/v9/projects/prj_web/env") {
        return {
          envs: [
            { id: "e1", key: "SECRET", type: "encrypted", value: "cipher", target: ["production"] },
            { id: "e2", key: "PLAIN", type: "plain", value: "readable", target: ["preview"] },
          ],
        };
      }
      return {};
    });
    await startServer();

    const body = await (await fetch(`${server.url}/api/vercel/env`)).json();

    expect(body.ok).toBe(true);
    expect(body.env.map((entry: { key: string }) => entry.key)).toEqual(["PLAIN", "SECRET"]);
    // The whole point of the split: no value crosses this route.
    expect(JSON.stringify(body)).not.toContain("readable");
    expect(JSON.stringify(body)).not.toContain("cipher");
  });

  test("reveals one value, and only over POST", async () => {
    stubResolvedProject((url) => {
      if (url.pathname === "/v9/projects/prj_web/env/e1") {
        return { id: "e1", key: "SECRET", value: "s3cret" };
      }
      return {};
    });
    await startServer();

    // A GET must not be a way in: revealing is an action, not a page read.
    const rejected = await fetch(`${server.url}/api/vercel/env/e1/reveal`);
    expect(rejected.status).toBe(405);

    const response = await fetch(`${server.url}/api/vercel/env/e1/reveal`, { method: "POST" });
    expect(await response.json()).toEqual({ ok: true, value: "s3cret" });
  });

  test("creates a variable, defaulting its type to encrypted", async () => {
    stubResolvedProject((url, method) => {
      if (url.pathname === "/v10/projects/prj_web/env" && method === "POST") {
        return { id: "e1", key: "API_KEY", target: ["production"], type: "encrypted" };
      }
      return {};
    });
    await startServer();

    const response = await fetch(`${server.url}/api/vercel/env`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "API_KEY", value: "s3cret", target: ["production"] }),
    });

    expect(await response.json()).toMatchObject({
      ok: true,
      env: { id: "e1", key: "API_KEY", target: ["production"] },
    });
    const created = apiCalls.find(
      (call) => call.url.pathname === "/v10/projects/prj_web/env" && call.method === "POST",
    );
    expect(JSON.parse(String(created?.body))).toMatchObject({ key: "API_KEY", type: "encrypted" });
  });

  test("refuses to create a variable with no key or no target", async () => {
    stubResolvedProject(() => ({}));
    await startServer();

    const noKey = await fetch(`${server.url}/api/vercel/env`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "x", target: ["production"] }),
    });
    expect(noKey.status).toBe(400);

    const noTarget = await fetch(`${server.url}/api/vercel/env`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "A", value: "x", target: [] }),
    });
    expect(noTarget.status).toBe(400);
  });

  test("updates a variable's target over PATCH and deletes it over DELETE", async () => {
    stubResolvedProject((url, method) => {
      if (url.pathname === "/v9/projects/prj_web/env/e1" && method === "PATCH") {
        return { id: "e1", key: "API_KEY", target: ["preview"] };
      }
      return {};
    });
    await startServer();

    const patched = await fetch(`${server.url}/api/vercel/env/e1`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: ["preview"] }),
    });
    expect(await patched.json()).toMatchObject({ ok: true, env: { target: ["preview"] } });

    const deleted = await fetch(`${server.url}/api/vercel/env/e1`, { method: "DELETE" });
    expect(await deleted.json()).toEqual({ ok: true });
    expect(
      apiCalls.some(
        (call) => call.url.pathname === "/v9/projects/prj_web/env/e1" && call.method === "DELETE",
      ),
    ).toBe(true);
  });

  test("rejects a GET on the update/delete route instead of acting on it", async () => {
    stubResolvedProject(() => ({}));
    await startServer();

    const response = await fetch(`${server.url}/api/vercel/env/e1`);
    expect(response.status).toBe(405);
  });

  test("lists domains with their outstanding verification records", async () => {
    stubResolvedProject((url) => {
      if (url.pathname === "/v9/projects/prj_web/domains") {
        return {
          domains: [
            {
              name: "shop.acme.com",
              verified: false,
              verification: [
                { type: "TXT", domain: "_vercel.shop.acme.com", value: "vc-domain-verify=x" },
              ],
            },
          ],
        };
      }
      return {};
    });
    await startServer();

    const body = await (await fetch(`${server.url}/api/vercel/domains`)).json();
    expect(body.domains[0]).toMatchObject({
      name: "shop.acme.com",
      verified: false,
      verification: [{ type: "TXT", domain: "_vercel.shop.acme.com" }],
    });
  });

  test("reads the project again for its build settings", async () => {
    stubResolvedProject((url) => {
      if (url.pathname === "/v9/projects/prj_web") {
        return { ...PROJECT, buildCommand: null, installCommand: "npm ci", nodeVersion: "22.x" };
      }
      return {};
    });
    await startServer();

    const body = await (await fetch(`${server.url}/api/vercel/project`)).json();
    // The list endpoint that resolved the project omits these, so the route
    // must not simply hand back what `status` already had.
    expect(body.project).toMatchObject({ installCommand: "npm ci", nodeVersion: "22.x" });
    expect(body.project.buildCommand).toBeNull();
  });

  test("serves runtime logs, and reports none rather than failing on a plan without them", async () => {
    stubResolvedProject((url) => {
      if (url.pathname === "/v1/deployments/dpl_1/runtime-logs") {
        return new Response(
          '{"rowId":"r1","timestampInMs":1000,"level":"error","message":"boom","statusCode":500}',
          { status: 200, headers: { "content-type": "text/plain" } },
        );
      }
      if (url.pathname === "/v1/deployments/dpl_2/runtime-logs") {
        return new Response("{}", { status: 402 });
      }
      return {};
    });
    await startServer();

    const served = await (
      await fetch(`${server.url}/api/vercel/deployments/dpl_1/runtime-logs`)
    ).json();
    expect(served.logs).toHaveLength(1);
    expect(served.logs[0]).toMatchObject({ level: "error", statusCode: 500 });

    const gated = await (
      await fetch(`${server.url}/api/vercel/deployments/dpl_2/runtime-logs`)
    ).json();
    expect(gated).toEqual({ ok: true, logs: [] });
  });

  test("refuses a project-scoped read when no project is linked", async () => {
    stubVercelApi((url) => {
      if (url.pathname === "/v2/user") return { user: { id: "u1", username: "octocat" } };
      if (url.pathname === "/v10/projects") return { projects: [] };
      return {};
    });
    await startServer();

    const response = await fetch(`${server.url}/api/vercel/env`);
    expect(response.status).toBe(500);
    expect((await response.json()).error).toMatch(/No Vercel project is linked/);
  });
});
