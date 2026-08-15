import { afterEach, describe, expect, test, vi } from "vitest";
import {
  CLOUDFLARE_HOOKS,
  CLOUDFLARE_MANIFEST,
  createCloudflareDeployActions,
  createCloudflareDeployProvider,
  toProviderDeployment,
  toProviderDomain,
  toProviderEnvVar,
  toProviderProject,
  toProviderState,
} from "../src/core/cloudflare-provider.js";
import {
  cloudflareRepoUrl,
  CloudflareManager,
  type CloudflareDeployment,
  type CloudflareProject,
} from "../src/core/cloudflare-manager.js";
import { CloudflareActions } from "../src/core/cloudflare-actions.js";

/**
 * Cloudflare driven through the `DeployProvider` contract — provider #2, and
 * therefore the first real evidence about whether the contract was shaped by
 * the problem or by Vercel.
 *
 * Each block below names the neutralization it is defending. If one of them
 * silently reverts to a Vercel shape, provider #3 pays for it rather than a
 * test failing here.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Records every outgoing request so path scoping and method choices are assertable. */
function stubFetch(
  responder: (url: URL, init: RequestInit | undefined) => unknown,
): { calls: Array<{ url: URL; init: RequestInit | undefined }> } {
  const calls: Array<{ url: URL; init: RequestInit | undefined }> = [];
  vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    const body = responder(url, init);
    if (body instanceof Response) return body;
    return new Response(JSON.stringify({ success: true, errors: [], result: body ?? {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  return { calls };
}

const deployment = (overrides: Partial<CloudflareDeployment> = {}): CloudflareDeployment => ({
  id: "dep_1",
  projectName: "web",
  url: "abc123.web.pages.dev",
  environment: "production",
  stage: { name: "deploy", status: "success" },
  isSkipped: false,
  createdAt: 1_000,
  aliases: [],
  ...overrides,
});

const project = (overrides: Partial<CloudflareProject> = {}): CloudflareProject => ({
  uuid: "7b162ea7-uuid",
  name: "web",
  envVars: [],
  ...overrides,
});

describe("repo matching uses the string Cloudflare recognizes a repository by", () => {
  test("normalizes every remote form to owner/repo", () => {
    expect(cloudflareRepoUrl("git@github.com:Acme/Web.git")).toBe("acme/web");
    expect(cloudflareRepoUrl("https://github.com/acme/web.git")).toBe("acme/web");
    expect(cloudflareRepoUrl("https://gitlab.com/acme/group/web/")).toBe("group/web");
  });

  test("returns null for a remote with no owner", () => {
    expect(cloudflareRepoUrl("web.git")).toBeNull();
  });

  test("skips the link-file tier, which Wrangler does not write", () => {
    expect(CLOUDFLARE_HOOKS.linkFile).toBeUndefined();
  });
});

describe("the state enum absorbs a vendor that has no state enum", () => {
  test("a (stage, status) pair collapses to a neutral state", () => {
    expect(toProviderState(deployment())).toBe("ready");
    expect(toProviderState(deployment({ stage: { name: "queued", status: "idle" } }))).toBe(
      "queued",
    );
    expect(toProviderState(deployment({ stage: { name: "build", status: "active" } }))).toBe(
      "building",
    );
    expect(toProviderState(deployment({ stage: { name: "build", status: "failure" } }))).toBe(
      "error",
    );
    expect(toProviderState(deployment({ stage: { name: "build", status: "canceled" } }))).toBe(
      "canceled",
    );
  });

  test("a completed early stage is still building, not ready", () => {
    // Cloudflare marks every finished stage `success`; only reaching `deploy`
    // means the deployment is serving. Reading `success` alone would call a
    // half-finished build ready.
    expect(toProviderState(deployment({ stage: { name: "clone_repo", status: "success" } }))).toBe(
      "building",
    );
  });

  test("`skipped` — a state the neutral enum has no room for — survives in rawState", () => {
    // This is exactly what rawState was added for: folding a vendor outcome
    // into the nearest neutral one must not lose the vendor's own word.
    const skipped = toProviderDeployment(deployment({ isSkipped: true }));

    expect(skipped.state).toBe("canceled");
    expect(skipped.rawState).toBe("skipped");
  });

  test("rawState carries the pair, so the badge can say more than 'building'", () => {
    expect(toProviderDeployment(deployment({ stage: { name: "build", status: "active" } })).rawState)
      .toBe("build:active");
  });
});

describe("project settings become a list, reusing the neutral keys", () => {
  test("Cloudflare's own field names map onto the keys Vercel already uses", () => {
    const settings = toProviderProject(
      project({ buildCommand: "npm run build", destinationDir: "dist", rootDir: null }),
    ).settings;

    expect(settings).toEqual([
      { key: "buildCommand", label: "Build command", value: "npm run build" },
      { key: "outputDirectory", label: "Output directory", value: "dist" },
      { key: "rootDirectory", label: "Root directory", value: null },
    ]);
  });

  test("null still means 'not overridden', not 'not read'", () => {
    const settings = toProviderProject(project({ buildCommand: null })).settings;

    expect(settings).toEqual([{ key: "buildCommand", label: "Build command", value: null }]);
  });

  test("the project id is the name, because that is what Cloudflare's paths use", () => {
    // Pinning a project in config therefore stores a name. The UUID is real but
    // addresses nothing, so exposing it would produce 404s on every read.
    expect(toProviderProject(project()).id).toBe("web");
  });

  test("a git-imported project reports its link", () => {
    const linked = toProviderProject(
      project({ source: { type: "github", owner: "acme", repoName: "web", productionBranch: "main" } }),
    );

    expect(linked.link).toEqual({
      type: "github",
      org: "acme",
      repo: "web",
      productionBranch: "main",
    });
  });
});

describe("environment variables neutralize into the shared vocabulary", () => {
  test("Cloudflare's two types map onto the contract's words", () => {
    expect(
      toProviderEnvVar({ key: "API_URL", environments: ["production"], type: "plain_text" }).type,
    ).toBe("plain");
    expect(
      toProviderEnvVar({ key: "TOKEN", environments: ["production"], type: "secret_text" }).type,
    ).toBe("encrypted");
  });

  test("the key doubles as the id, because Cloudflare has no variable ids", () => {
    const variable = toProviderEnvVar({
      key: "API_URL",
      environments: ["production", "preview"],
      type: "plain_text",
    });

    expect(variable).toMatchObject({ id: "API_URL", environments: ["production", "preview"] });
  });
});

describe("CloudflareManager reads", () => {
  const manager = () => new CloudflareManager("cf-token", "acct_1");

  test("scopes every Pages path to the account and sends a bearer token", async () => {
    const { calls } = stubFetch(() => []);

    await manager().listProjects();

    expect(calls[0].url.pathname).toBe("/client/v4/accounts/acct_1/pages/projects");
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe(
      "Bearer cf-token",
    );
  });

  test("refuses to build a Pages path without an account rather than sending 'undefined'", async () => {
    stubFetch(() => []);

    await expect(new CloudflareManager("cf-token").listProjects()).rejects.toThrow(
      /Choose a Cloudflare account/,
    );
  });

  test("search and repo filters are applied here, since the endpoint has neither", async () => {
    stubFetch(() => [
      { id: "1", name: "web", source: { type: "github", config: { owner: "Acme", repo_name: "Web" } } },
      { id: "2", name: "docs" },
    ]);

    expect(await manager().listProjects({ search: "do" })).toHaveLength(1);
    expect((await manager().listProjects({ repoUrl: "acme/web" }))[0].name).toBe("web");
    expect(await manager().listProjects({ repoUrl: "acme/other" })).toEqual([]);
  });

  test("a 200 carrying `success: false` is an error, not a result", async () => {
    // Cloudflare reports some failures with a 200 status line, so the envelope
    // has to decide rather than the status.
    vi.stubGlobal("fetch", async () =>
      new Response(
        JSON.stringify({ success: false, errors: [{ code: 9109, message: "Unauthorized" }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    await expect(manager().listProjects()).rejects.toThrow("Unauthorized");
  });

  test("identity falls back to token verification when /user is refused", async () => {
    // A project-scoped API token cannot read /user. Failing the whole dashboard
    // over an identity nicety would be the wrong trade.
    const { calls } = stubFetch((url) => {
      if (url.pathname.endsWith("/user")) {
        return new Response(
          JSON.stringify({ success: false, errors: [{ code: 9109, message: "not allowed" }] }),
          { status: 403, headers: { "content-type": "application/json" } },
        );
      }
      if (url.pathname.endsWith("/tokens/verify")) return { id: "tok_1", status: "active" };
      return [{ id: "acct_1", name: "Acme Inc" }];
    });

    expect(await manager().viewer()).toMatchObject({ id: "tok_1", username: "Acme Inc" });
    expect(calls.map((call) => call.url.pathname)).toContain("/client/v4/user/tokens/verify");
  });

  test("Pages list reads never ask for more than 10 per page", async () => {
    // Pages rejects `per_page` above 10 outright (8000024), failing the whole
    // request rather than truncating. Asking for 50 broke every list call.
    const { calls } = stubFetch(() => []);

    await manager().listProjects();
    await manager().listDeployments({ projectName: "web", limit: 100 });

    for (const call of calls) {
      expect(Number(call.url.searchParams.get("per_page"))).toBeLessThanOrEqual(10);
    }
  });

  test("a list longer than one page is walked, not truncated", async () => {
    // The cap is 10, so anything that needs more than 10 — "find the project
    // for this repo" above all — is only correct if it pages.
    const project = (name: string) => ({ id: name, name, created_on: "2024-01-01T00:00:00Z" });
    const { calls } = stubFetch((url) => {
      const page = Number(url.searchParams.get("page"));
      if (page === 1) return Array.from({ length: 10 }, (_, i) => project(`p${i}`));
      if (page === 2) return [project("p10"), project("p11")];
      return [];
    });

    const projects = await manager().listProjects();

    expect(projects).toHaveLength(12);
    expect(projects.at(-1)?.name).toBe("p11");
    // Stops on the short page rather than walking to the guard.
    expect(calls.map((call) => call.url.searchParams.get("page"))).toEqual(["1", "2"]);
  });

  test("identity prefers the email over Cloudflare's opaque `username`", async () => {
    // Shape observed from a live /user: `username` is a 32-char hex id, not a
    // display name, so preferring it put a hex blob in the account menu.
    stubFetch(() => ({
      id: "ded4db6ed0e8ed03723054ce4b76ce26",
      email: "person@example.com",
      username: "1a327cd4f19abadb65e30645819ca118",
    }));

    expect(await manager().viewer()).toMatchObject({
      email: "person@example.com",
      username: "person@example.com",
    });
  });

  test("env vars flatten across environments, and a secret's value never reads back", async () => {
    stubFetch(() => ({
      id: "uuid",
      name: "web",
      deployment_configs: {
        production: {
          env_vars: {
            API_URL: { type: "plain_text", value: "https://api.example.com" },
            TOKEN: { type: "secret_text" },
          },
        },
        preview: { env_vars: { API_URL: { type: "plain_text", value: "https://staging" } } },
      },
    }));

    const env = await manager().listEnv("web");

    expect(env).toEqual([
      { key: "API_URL", environments: ["production", "preview"], type: "plain_text" },
      { key: "TOKEN", environments: ["production"], type: "secret_text" },
    ]);
    // The list endpoint drops values for every type, the same one-door rule the
    // Vercel client follows.
    expect(env.every((entry) => !("value" in entry))).toBe(true);
    await expect(manager().getEnvValue("web", "TOKEN")).rejects.toThrow(/never returns a secret/);
    expect(await manager().getEnvValue("web", "API_URL")).toBe("https://api.example.com");
  });

  test("build logs are timestamped, trimmed, and tailed to the caller's limit", async () => {
    stubFetch(() => ({
      data: [
        { ts: "2021-04-20T19:35:29.000Z", line: "Cloning repository...  " },
        { ts: "2021-04-20T19:35:30.000Z", line: "" },
        { ts: "2021-04-20T19:35:31.000Z", line: "Build failed" },
      ],
    }));

    const logs = await manager().deploymentBuildLogs("web", "dep_1", 1);

    expect(logs).toEqual([
      { id: expect.any(String), createdAt: Date.parse("2021-04-20T19:35:31.000Z"), text: "Build failed" },
    ]);
  });
});

describe("the read-safe provider", () => {
  test("deployment reads use the project the caller resolved", async () => {
    // Cloudflare has no global deployment endpoint. The contract's
    // `getDeployment(id)` survives that by closing over the resolved project
    // rather than growing a second argument.
    const { calls } = stubFetch((url) =>
      url.pathname.includes("/deployments/")
        ? { id: "dep_1", environment: "production", latest_stage: { name: "deploy", status: "success" } }
        : { id: "uuid", name: "web", canonical_deployment: { id: "dep_1" } },
    );

    const detail = await createCloudflareDeployProvider(
      new CloudflareManager("cf-token", "acct_1"),
      "web",
    ).getDeployment("dep_1");

    expect(calls[0].url.pathname).toContain("/pages/projects/web/deployments/dep_1");
    expect(detail).toMatchObject({ state: "ready", isCurrentProduction: true });
  });

  test("without a linked project, a deployment read says which knob fixes it", async () => {
    stubFetch(() => ({}));
    const provider = createCloudflareDeployProvider(new CloudflareManager("cf-token", "acct_1"));

    await expect(provider.getDeployment("dep_1")).rejects.toThrow(/Link this repository/);
  });

  test("which deployment production serves comes from the project, not from recency", async () => {
    // A rollback makes an older deployment the live one, so "the newest
    // successful production build" is the wrong answer after one.
    stubFetch((url) =>
      url.pathname.endsWith("/deployments")
        ? [
            { id: "dep_2", environment: "production", latest_stage: { name: "deploy", status: "success" } },
            { id: "dep_1", environment: "production", latest_stage: { name: "deploy", status: "success" } },
          ]
        : { id: "uuid", name: "web", canonical_deployment: { id: "dep_1" } },
    );

    const deployments = await createCloudflareDeployProvider(
      new CloudflareManager("cf-token", "acct_1"),
      "web",
    ).listDeployments({ projectId: "web" });

    expect(deployments.map((entry) => entry.isCurrentProduction)).toEqual([false, true]);
  });

  test("runtime logs are absent rather than present-and-broken", () => {
    const provider = createCloudflareDeployProvider(new CloudflareManager("t", "a"), "web");

    // Pages serves runtime output over a websocket tail, so the capability is
    // not declared and the method is not implemented — the generic view hides
    // the tab instead of rendering one that errors.
    expect(provider.runtimeLogs).toBeUndefined();
    expect(CLOUDFLARE_MANIFEST.capabilities).not.toContain("runtimeLogs");
  });

  test("a deployment URL is a bare hostname, as the contract's consumers assume", async () => {
    stubFetch(() => [
      { id: "dep_1", url: "https://abc123.web.pages.dev", latest_stage: { name: "deploy", status: "success" } },
    ]);

    const [entry] = await createCloudflareDeployProvider(
      new CloudflareManager("cf-token", "acct_1"),
      "web",
    ).listDeployments({ projectId: "web" });

    expect(entry.url).toBe("abc123.web.pages.dev");
  });
});

describe("domains", () => {
  test("an unverified domain reports the record the user must add", () => {
    expect(
      toProviderDomain({
        name: "example.com",
        status: "pending",
        validation: { method: "txt", status: "pending", txtName: "_cf.example.com", txtValue: "abc" },
      }),
    ).toMatchObject({
      verified: false,
      verification: [{ type: "TXT", domain: "_cf.example.com", value: "abc" }],
    });
  });

  test("an active domain carries no outstanding records", () => {
    expect(toProviderDomain({ name: "example.com", status: "active" })).toMatchObject({
      verified: true,
      verification: [],
    });
  });

  /**
   * A live pass found a serving project reporting no domains at all: Cloudflare
   * lists custom domains only, while Vercel's equivalent includes the assigned
   * `*.vercel.app`. Same generic view, two different answers.
   */
  test("the assigned `pages.dev` host is listed, after any custom domain", async () => {
    stubFetch((url) =>
      url.pathname.endsWith("/domains")
        ? [{ name: "example.com", status: "active" }]
        : { id: "p1", name: "web", subdomain: "web.pages.dev" },
    );

    const domains = await new CloudflareManager("cf-token", "acct_1").listDomains("web");

    expect(domains.map((domain) => domain.name)).toEqual(["example.com", "web.pages.dev"]);
    expect(domains[1].status).toBe("active");
  });

  test("a project Cloudflare will not return costs the custom domains nothing", async () => {
    stubFetch((url) => {
      if (url.pathname.endsWith("/domains")) return [{ name: "example.com", status: "active" }];
      return new Response(
        JSON.stringify({ success: false, errors: [{ code: 8000007, message: "nope" }] }),
        { status: 404, headers: { "content-type": "application/json" } },
      );
    });

    const domains = await new CloudflareManager("cf-token", "acct_1").listDomains("web");

    expect(domains.map((domain) => domain.name)).toEqual(["example.com"]);
  });

  test("a custom domain that is already the assigned host is not listed twice", async () => {
    stubFetch((url) =>
      url.pathname.endsWith("/domains")
        ? [{ name: "web.pages.dev", status: "active" }]
        : { id: "p1", name: "web", subdomain: "web.pages.dev" },
    );

    const domains = await new CloudflareManager("cf-token", "acct_1").listDomains("web");

    expect(domains.map((domain) => domain.name)).toEqual(["web.pages.dev"]);
  });
});

describe("the write-capable half", () => {
  const actions = (responder: Parameters<typeof stubFetch>[0]) => {
    const recorded = stubFetch(responder);
    return {
      calls: recorded.calls,
      run: createCloudflareDeployActions(
        new CloudflareActions({ token: "cf-token" }, "acct_1"),
      ),
    };
  };

  test("`redeploy` is Cloudflare's retry, addressed within its project", async () => {
    const { calls, run } = actions(() => ({ id: "dep_2", url: "https://new.web.pages.dev" }));

    const result = await run.run("redeploy", { deploymentId: "dep_1", projectId: "web" });

    expect(calls[0].init?.method).toBe("POST");
    expect(calls[0].url.pathname).toBe(
      "/client/v4/accounts/acct_1/pages/projects/web/deployments/dep_1/retry",
    );
    expect(result.deployment?.id).toBe("dep_2");
  });

  test("an action Cloudflare does not have is refused by name", async () => {
    const { run } = actions(() => ({}));

    // Vercel's `promote` and `cancel` have no Pages equivalent. The manifest is
    // what the route validates against; this is the backstop behind it.
    await expect(run.run("promote", { deploymentId: "dep_1", projectId: "web" })).rejects.toThrow(
      /does not support the action "promote"/,
    );
    expect(CLOUDFLARE_MANIFEST.actions).toEqual(["redeploy", "rollback"]);
    expect(CLOUDFLARE_MANIFEST.productionAffecting).toEqual(["rollback"]);
  });

  test("every action needs the project, where Vercel needed the original's name and target", async () => {
    const { run } = actions(() => ({}));

    await expect(run.run("rollback", { deploymentId: "dep_1" })).rejects.toThrow(
      /requires "projectId"/,
    );
  });

  test("adding a variable writes it into each environment as one PATCH", async () => {
    const { calls, run } = actions(() => ({
      deployment_configs: {
        production: { env_vars: { API_URL: { type: "plain_text", value: "x" } } },
        preview: { env_vars: { API_URL: { type: "plain_text", value: "x" } } },
      },
    }));

    const created = await run.createEnv?.("web", {
      key: "API_URL",
      value: "x",
      environments: ["production", "preview"],
      type: "plain",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].init?.method).toBe("PATCH");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      deployment_configs: {
        production: { env_vars: { API_URL: { type: "plain_text", value: "x" } } },
        preview: { env_vars: { API_URL: { type: "plain_text", value: "x" } } },
      },
    });
    expect(created).toMatchObject({ key: "API_URL", environments: ["production", "preview"] });
  });

  test("an environment Pages does not have is refused before the write", async () => {
    const { calls, run } = actions(() => ({}));

    // Vercel's env dialog offers `development`; naming it here would quietly
    // create a third deployment config that nothing ever reads.
    await expect(
      run.createEnv?.("web", { key: "K", value: "v", environments: ["development"] }),
    ).rejects.toThrow(/only has production and preview/);
    expect(calls).toHaveLength(0);
  });

  test("deleting nulls the key in exactly the environments it was set in", async () => {
    const { calls, run } = actions((url, init) =>
      init?.method === "PATCH"
        ? {}
        : {
            deployment_configs: {
              production: { env_vars: { TOKEN: { type: "secret_text" } } },
              preview: { env_vars: {} },
            },
          },
    );

    await run.deleteEnv?.("web", "TOKEN");

    // A null in the merged map is Cloudflare's delete, so the write never has
    // to resend the whole map and cannot clobber a concurrent addition.
    expect(JSON.parse(String(calls[1].init?.body))).toEqual({
      deployment_configs: { production: { env_vars: { TOKEN: null } } },
    });
  });

  test("moving a secret into a new environment needs a value, and says so", async () => {
    const { run } = actions(() => ({
      deployment_configs: { production: { env_vars: { TOKEN: { type: "secret_text" } } } },
    }));

    // Cloudflare stores the value per environment and never hands a secret's
    // back, so there is nothing to copy across.
    await expect(
      run.updateEnv?.("web", "TOKEN", { environments: ["production", "preview"] }),
    ).rejects.toThrow(/needs a value/);
  });
});
