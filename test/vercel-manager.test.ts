import { afterEach, describe, expect, test, vi } from "vitest";
import {
  parseBuildLogEvents,
  VercelApiError,
  VercelManager,
  vercelRepoUrl,
} from "../src/core/vercel-manager.js";
import { VercelActions } from "../src/core/vercel-actions.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Records every outgoing request so scoping and method choices are assertable. */
function stubFetch(
  responder: (url: URL, init: RequestInit | undefined) => unknown,
): { calls: Array<{ url: URL; init: RequestInit | undefined }> } {
  const calls: Array<{ url: URL; init: RequestInit | undefined }> = [];
  vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    const body = responder(url, init);
    if (body instanceof Response) return body;
    return new Response(JSON.stringify(body ?? {}), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  return { calls };
}

describe("vercelRepoUrl", () => {
  test("normalizes the remote forms Vercel keys projects by", () => {
    expect(vercelRepoUrl("git@github.com:acme/web.git")).toBe("https://github.com/acme/web");
    expect(vercelRepoUrl("https://github.com/acme/web.git")).toBe("https://github.com/acme/web");
    expect(vercelRepoUrl("https://github.com/acme/web/")).toBe("https://github.com/acme/web");
  });

  test("returns null for a remote it cannot express as an https URL", () => {
    expect(vercelRepoUrl("/srv/local/repo.git")).toBeNull();
  });
});

describe("VercelManager reads", () => {
  test("scopes every request to the selected team", async () => {
    const { calls } = stubFetch(() => ({ user: { id: "u1", username: "octocat" } }));
    await new VercelManager("token", "team_acme").viewer();

    expect(calls[0]?.url.searchParams.get("teamId")).toBe("team_acme");
    expect(
      (calls[0]?.init?.headers as Record<string, string>).Authorization,
    ).toBe("Bearer token");
  });

  test("normalizes a deployment's git metadata and production status", async () => {
    stubFetch(() => ({
      deployments: [
        {
          uid: "dpl_1",
          name: "web",
          url: "web.vercel.app",
          readyState: "READY",
          readySubstate: "PROMOTED",
          target: "production",
          createdAt: 1_700_000_000_000,
          meta: {
            githubCommitRef: "main",
            githubCommitSha: "abc123",
            githubCommitMessage: "fix: retry writes",
            githubCommitAuthorName: "octocat",
          },
        },
      ],
    }));

    const [deployment] = await new VercelManager("token").listDeployments({
      projectId: "prj_1",
    });

    expect(deployment).toMatchObject({
      uid: "dpl_1",
      state: "READY",
      target: "production",
      isCurrentProduction: true,
      meta: {
        branch: "main",
        sha: "abc123",
        commitMessage: "fix: retry writes",
        commitAuthor: "octocat",
      },
    });
  });

  test("a production build that is not yet serving is not current production", async () => {
    stubFetch(() => ({
      deployments: [
        {
          uid: "dpl_2",
          name: "web",
          url: null,
          readyState: "READY",
          readySubstate: "STAGED",
          target: "production",
          createdAt: 1,
        },
      ],
    }));

    const [deployment] = await new VercelManager("token").listDeployments({ projectId: "p" });
    expect(deployment?.isCurrentProduction).toBe(false);
  });

  test("filters previews client-side, since Vercel has no preview target filter", async () => {
    const { calls } = stubFetch(() => ({
      deployments: [
        { uid: "a", name: "web", url: null, readyState: "READY", target: "production", createdAt: 2 },
        { uid: "b", name: "web", url: null, readyState: "READY", target: null, createdAt: 1 },
      ],
    }));

    const deployments = await new VercelManager("token").listDeployments({
      projectId: "p",
      target: "preview",
    });

    expect(calls[0]?.url.searchParams.get("target")).toBeNull();
    expect(deployments.map((deployment) => deployment.uid)).toEqual(["b"]);
  });

  test("surfaces Vercel's own error message, not the bare status text", async () => {
    stubFetch(
      () =>
        new Response(JSON.stringify({ error: { message: "Not authorized" } }), {
          status: 403,
          headers: { "content-type": "application/json" },
        }),
    );

    await expect(new VercelManager("token").viewer()).rejects.toThrow("Not authorized");
    await expect(new VercelManager("token").viewer()).rejects.toBeInstanceOf(VercelApiError);
  });
});

describe("parseBuildLogEvents", () => {
  test("accepts a JSON array and orders lines oldest-first", () => {
    const logs = parseBuildLogEvents(
      JSON.stringify([
        { type: "stdout", created: 2, payload: { id: "b", date: 2, text: "second" } },
        { type: "stdout", created: 1, payload: { id: "a", date: 1, text: "first" } },
      ]),
    );

    expect(logs.map((line) => line.text)).toEqual(["first", "second"]);
  });

  test("accepts newline-delimited JSON and skips unparseable partial lines", () => {
    const logs = parseBuildLogEvents(
      [
        JSON.stringify({ type: "stdout", payload: { id: "a", date: 1, text: "ok" } }),
        '{"partial": ',
      ].join("\n"),
    );

    expect(logs.map((line) => line.text)).toEqual(["ok"]);
  });

  test("strips ANSI colour codes and drops empty lines", () => {
    const logs = parseBuildLogEvents(
      JSON.stringify([
        { type: "stdout", payload: { id: "a", date: 1, text: "\u001b[32mdone\u001b[39m" } },
        { type: "stdout", payload: { id: "b", date: 2, text: "   " } },
      ]),
    );

    expect(logs.map((line) => line.text)).toEqual(["done"]);
  });

  test("returns nothing for an empty body rather than throwing", () => {
    expect(parseBuildLogEvents("")).toEqual([]);
  });
});

describe("VercelManager environment variables", () => {
  test("never returns a value, whatever type Vercel says the variable is", async () => {
    // `plain` and `system` variables come back readable from the list endpoint,
    // so dropping only the encrypted ones would still leak the rest.
    stubFetch(() => ({
      envs: [
        { id: "e2", key: "PLAIN", type: "plain", value: "readable", target: ["preview"] },
        { id: "e1", key: "SECRET", type: "encrypted", value: "cipher", target: ["production"] },
      ],
    }));

    const env = await new VercelManager("t").listEnv("prj_1");

    expect(env.every((entry) => !("value" in entry))).toBe(true);
    // Sorted by key so the list does not reshuffle between reads.
    expect(env.map((entry) => entry.key)).toEqual(["PLAIN", "SECRET"]);
  });

  test("normalizes a string target into the array the UI renders", async () => {
    stubFetch(() => ({ envs: [{ id: "e1", key: "A", target: "production" }] }));
    const [entry] = await new VercelManager("t").listEnv("prj_1");
    expect(entry.target).toEqual(["production"]);
    expect(entry.type).toBe("encrypted");
  });

  test("a value is read one key at a time, from the single-variable endpoint", async () => {
    const { calls } = stubFetch(() => ({ id: "e1", key: "SECRET", value: "s3cret" }));

    const value = await new VercelManager("t", "team_acme").getEnvValue("prj_1", "e1");

    expect(value).toBe("s3cret");
    expect(calls[0]?.url.pathname).toBe("/v9/projects/prj_1/env/e1");
    // Notably not `?decrypt=true` on the list endpoint, which would return
    // every secret at once.
    expect(calls[0]?.url.searchParams.get("decrypt")).toBeNull();
  });
});

describe("VercelManager domains", () => {
  test("keeps only verification records that name both a host and a value", async () => {
    stubFetch(() => ({
      domains: [
        {
          name: "acme.com",
          verified: false,
          verification: [
            { type: "TXT", domain: "_vercel.acme.com", value: "vc-domain-verify=x" },
            { type: "TXT", reason: "pending" },
          ],
        },
      ],
    }));

    const [domain] = await new VercelManager("t").listDomains("prj_1");

    expect(domain.verified).toBe(false);
    expect(domain.verification).toHaveLength(1);
    expect(domain.verification[0]?.domain).toBe("_vercel.acme.com");
  });

  test("an absent `verified` flag reads as unverified rather than undefined", async () => {
    stubFetch(() => ({ domains: [{ name: "acme.com" }] }));
    const [domain] = await new VercelManager("t").listDomains("prj_1");
    expect(domain.verified).toBe(false);
    expect(domain.verification).toEqual([]);
  });
});

describe("VercelManager runtime logs", () => {
  test("parses NDJSON, drops partial lines, and orders oldest first", async () => {
    stubFetch(
      () =>
        new Response(
          [
            '{"rowId":"r2","timestampInMs":2000,"level":"error","message":"boom","statusCode":500}',
            "{ truncated",
            '{"rowId":"r1","timestampInMs":1000,"level":"info","message":"ok"}',
          ].join("\n"),
          { status: 200, headers: { "content-type": "text/plain" } },
        ),
    );

    const logs = await new VercelManager("t").deploymentRuntimeLogs("dpl_1");

    expect(logs.map((line) => line.id)).toEqual(["r1", "r2"]);
    expect(logs[1]?.statusCode).toBe(500);
  });

  test("a plan that does not include runtime logs reads as empty, not as an error", async () => {
    stubFetch(() => new Response("{}", { status: 402 }));
    await expect(new VercelManager("t").deploymentRuntimeLogs("dpl_1")).resolves.toEqual([]);
  });

  test("a rejected token still surfaces, so an auth problem is not hidden as 'no logs'", async () => {
    stubFetch(() => new Response("{}", { status: 401 }));
    await expect(new VercelManager("t").deploymentRuntimeLogs("dpl_1")).rejects.toBeInstanceOf(
      VercelApiError,
    );
  });
});

describe("VercelManager project settings", () => {
  test("keeps null build settings distinct from absent ones", async () => {
    // Null is Vercel saying "the framework's default applies", which the
    // settings panel spells out — so it must survive normalization.
    stubFetch(() => ({
      id: "prj_1",
      name: "web",
      buildCommand: null,
      installCommand: "npm ci",
      nodeVersion: "22.x",
    }));

    const project = await new VercelManager("t").getProject("prj_1");

    expect(project.buildCommand).toBeNull();
    expect(project.installCommand).toBe("npm ci");
    expect(project.nodeVersion).toBe("22.x");
  });
});

describe("VercelActions", () => {
  test("a redeploy inherits the original's target so production stays production", async () => {
    const { calls } = stubFetch(() => ({ id: "dpl_new", url: "new.vercel.app" }));

    await new VercelActions({ token: "t", teamId: "team_acme" }).redeploy({
      uid: "dpl_old",
      name: "web",
      target: "production",
    });

    const [call] = calls;
    expect(call?.init?.method).toBe("POST");
    expect(JSON.parse(String(call?.init?.body))).toEqual({
      deploymentId: "dpl_old",
      name: "web",
      target: "production",
    });
    expect(call?.url.searchParams.get("teamId")).toBe("team_acme");
  });

  test("cancel, promote, and rollback use the endpoints Vercel documents", async () => {
    const { calls } = stubFetch(() => ({}));
    const actions = new VercelActions({ token: "t" });

    await actions.cancel("dpl_1");
    await actions.promote("prj_1", "dpl_1");
    await actions.rollback("prj_1", "dpl_1", "bad deploy");

    expect(calls.map((call) => `${call.init?.method} ${call.url.pathname}`)).toEqual([
      "PATCH /v12/deployments/dpl_1/cancel",
      "POST /v10/projects/prj_1/promote/dpl_1",
      "POST /v1/projects/prj_1/rollback/dpl_1",
    ]);
    expect(calls[2]?.url.searchParams.get("description")).toBe("bad deploy");
  });

  test("createEnv defaults to encrypted and normalizes a bulk-shaped response", async () => {
    const { calls } = stubFetch(() => ({
      created: [{ id: "e1", key: "API_KEY", target: ["production"], type: "encrypted" }],
    }));

    const env = await new VercelActions({ token: "t" }).createEnv("prj_1", {
      key: "API_KEY",
      value: "s3cret",
      target: ["production"],
    });

    expect(env).toMatchObject({ id: "e1", key: "API_KEY", target: ["production"] });
    const [call] = calls;
    expect(call?.init?.method).toBe("POST");
    expect(call?.url.pathname).toBe("/v10/projects/prj_1/env");
    expect(JSON.parse(String(call?.init?.body))).toEqual({
      key: "API_KEY",
      value: "s3cret",
      target: ["production"],
      type: "encrypted",
    });
  });

  test("createEnv also accepts a single-object response, not just the bulk shape", async () => {
    const { calls } = stubFetch(() => ({ id: "e2", key: "PLAIN", target: ["preview"], type: "plain" }));

    const env = await new VercelActions({ token: "t" }).createEnv("prj_1", {
      key: "PLAIN",
      value: "visible",
      target: ["preview"],
      type: "plain",
    });

    expect(env).toMatchObject({ id: "e2", key: "PLAIN" });
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({ type: "plain" });
  });

  test("updateEnv only sends the fields given, and never the key", async () => {
    const { calls } = stubFetch(() => ({ id: "e1", key: "API_KEY", target: ["preview"] }));

    await new VercelActions({ token: "t" }).updateEnv("prj_1", "e1", {
      target: ["preview"],
    });

    expect(calls[0]?.url.pathname).toBe("/v9/projects/prj_1/env/e1");
    expect(calls[0]?.init?.method).toBe("PATCH");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ target: ["preview"] });
  });

  test("deleteEnv reaches the single-variable endpoint over DELETE", async () => {
    const { calls } = stubFetch(() => ({}));

    await new VercelActions({ token: "t" }).deleteEnv("prj_1", "e1");

    expect(calls[0]).toMatchObject({
      init: { method: "DELETE" },
      url: expect.objectContaining({ pathname: "/v9/projects/prj_1/env/e1" }),
    });
  });
});
