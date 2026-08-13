import net from "node:net";
import { request as httpRequest } from "node:http";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ConfigStore } from "../src/core/config-store.js";
import { createWebServer } from "../src/web/server.js";

const execFileAsync = promisify(execFile);

let tempDir: string;
let server: Awaited<ReturnType<ReturnType<typeof createWebServer>["start"]>>;
let portServers: net.Server[] = [];

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "nomoreide-web-"));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await server?.stop();
  await Promise.all(
    portServers.map(
      (item) =>
        new Promise<void>((resolve) => {
          item.close(() => resolve());
        }),
    ),
  );
  portServers = [];
  // Tests here start real service processes whose log writer can land one more
  // append while `rm` is walking the tree, yielding ENOTEMPTY. `force` only
  // suppresses ENOENT, so retry the removal instead.
  await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe("web server", () => {
  test("serves and updates scoped settings without replacing untouched fields", async () => {
    const configPath = join(tempDir, "nomoreide.config.json");
    const settingsPath = join(tempDir, "settings.json");
    const projectPath = join(tempDir, "repo");
    await registerSettingsProjects(configPath, [projectPath]);
    server = await createWebServer({
      configPath,
      settingsPath,
      logDir: join(tempDir, "logs"),
      cwd: tempDir,
      registryPath: join(tempDir, "runtime.json"),
      port: 0,
    }).start();

    let response = await fetch(`${server.url}/api/settings`);
    expect(await response.json()).toEqual({
      ok: true,
      global: {
        version: 1,
        terminal: {
          fontSize: 13,
          cursorStyle: "block",
          scrollback: 5_000,
          copyOnSelect: false,
          confirmTerminate: true,
          smoothScroll: true,
          externalTerminal: "automatic",
        },
      },
      project: {
        logs: { showTimestamps: true, wrapLines: true },
        database: { confirmWrites: true, resultLimit: 100 },
      },
    });
    await expect(
      readFile(join(projectPath, "nomoreide.config.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });

    response = await fetch(`${server.url}/api/settings/global`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ terminal: { fontSize: 16 } }),
    });
    expect((await response.json()).global.terminal).toEqual({
      fontSize: 16,
      cursorStyle: "block",
      scrollback: 5_000,
      copyOnSelect: false,
      confirmTerminate: true,
      smoothScroll: true,
      externalTerminal: "automatic",
    });

    response = await fetch(
      `${server.url}/api/settings/project?projectPath=${encodeURIComponent(projectPath)}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ logs: { wrapLines: false } }),
      },
    );
    expect((await response.json()).project).toEqual({
      logs: { showTimestamps: true, wrapLines: false },
      database: { confirmWrites: true, resultLimit: 100 },
    });
    expect(
      JSON.parse(
        await readFile(join(projectPath, "nomoreide.config.json"), "utf8"),
      ),
    ).toMatchObject({
      preferences: { logs: { showTimestamps: true, wrapLines: false } },
    });
    expect(JSON.parse(await readFile(configPath, "utf8"))).not.toHaveProperty(
      "preferences",
    );
  });

  test("keeps project settings independent across registered repositories", async () => {
    const configPath = join(tempDir, "nomoreide.config.json");
    const settingsPath = join(tempDir, "settings.json");
    const repoA = join(tempDir, "repo-a");
    const repoB = join(tempDir, "repo-b");
    const unregistered = join(tempDir, "unregistered");
    await registerSettingsProjects(configPath, [repoA, repoB]);
    await mkdir(unregistered);
    await new ConfigStore(join(repoA, "nomoreide.config.json")).updatePreferences({
      database: { resultLimit: 250 },
    });
    server = await createWebServer({
      configPath,
      settingsPath,
      logDir: join(tempDir, "logs"),
      cwd: tempDir,
      registryPath: join(tempDir, "runtime.json"),
      port: 0,
    }).start();

    const repoAGet = await fetch(
      `${server.url}/api/settings?projectPath=${encodeURIComponent(repoA)}`,
    );
    expect((await repoAGet.json()).project.database.resultLimit).toBe(250);

    const repoBGet = await fetch(
      `${server.url}/api/settings?projectPath=${encodeURIComponent(repoB)}`,
    );
    expect((await repoBGet.json()).project).toEqual({
      logs: { showTimestamps: true, wrapLines: true },
      database: { confirmWrites: true, resultLimit: 100 },
    });
    await expect(
      readFile(join(repoB, "nomoreide.config.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });

    await fetch(
      `${server.url}/api/settings/project?projectPath=${encodeURIComponent(repoB)}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ logs: { showTimestamps: false } }),
      },
    );
    await fetch(
      `${server.url}/api/settings/project/reset?projectPath=${encodeURIComponent(repoA)}`,
      { method: "POST" },
    );

    expect(
      await new ConfigStore(join(repoA, "nomoreide.config.json")).getPreferences(),
    ).toEqual({
      logs: { showTimestamps: true, wrapLines: true },
      database: { confirmWrites: true, resultLimit: 100 },
    });
    expect(
      (await new ConfigStore(join(repoB, "nomoreide.config.json")).getPreferences())
        .logs.showTimestamps,
    ).toBe(false);
    expect(JSON.parse(await readFile(configPath, "utf8"))).not.toHaveProperty(
      "preferences",
    );

    const rejectedResponses = await Promise.all([
      fetch(`${server.url}/api/settings/project`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ logs: { wrapLines: false } }),
      }),
      fetch(`${server.url}/api/settings/project/reset`, { method: "POST" }),
      fetch(
        `${server.url}/api/settings/project?projectPath=${encodeURIComponent(unregistered)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ logs: { wrapLines: false } }),
        },
      ),
      fetch(
        `${server.url}/api/settings/project/reset?projectPath=${encodeURIComponent(join(repoA, ".."))}`,
        { method: "POST" },
      ),
      fetch(`${server.url}/api/settings?projectPath=%00`),
      fetch(`${server.url}/api/settings?projectPath=`),
    ]);
    expect(rejectedResponses.map((response) => response.status)).toEqual([
      400, 400, 400, 400, 400, 400,
    ]);
    await expect(
      readFile(join(unregistered, "nomoreide.config.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("rejects a delayed project patch when the validated root becomes a symlink", async () => {
    const configPath = join(tempDir, "nomoreide.config.json");
    const projectPath = join(tempDir, "repo");
    const movedProjectPath = join(tempDir, "repo-before-swap");
    const outsidePath = join(tempDir, "outside");
    await registerSettingsProjects(configPath, [projectPath]);
    await mkdir(outsidePath);
    server = await createWebServer({
      configPath,
      settingsPath: join(tempDir, "settings.json"),
      logDir: join(tempDir, "logs"),
      cwd: tempDir,
      registryPath: join(tempDir, "runtime.json"),
      port: 0,
    }).start();

    let request!: ReturnType<typeof httpRequest>;
    const responsePromise = new Promise<{ status: number; body: string }>(
      (resolveResponse, rejectResponse) => {
        request = httpRequest(
          `${server.url}/api/settings/project?projectPath=${encodeURIComponent(projectPath)}`,
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
          },
          (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
            response.on("end", () => {
              resolveResponse({
                status: response.statusCode ?? 0,
                body: Buffer.concat(chunks).toString("utf8"),
              });
            });
          },
        );
        request.on("error", rejectResponse);
        request.flushHeaders();
      },
    );
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 50));
    await rename(projectPath, movedProjectPath);
    await symlink(outsidePath, projectPath, "dir");
    request.end(JSON.stringify({ logs: { wrapLines: false } }));

    const response = await responsePromise;

    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toMatchObject({ ok: false });
    await expect(
      readFile(join(outsidePath, "nomoreide.config.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("rejects invalid scoped settings without persisting them", async () => {
    const configPath = join(tempDir, "nomoreide.config.json");
    const settingsPath = join(tempDir, "settings.json");
    const projectPath = join(tempDir, "repo");
    await registerSettingsProjects(configPath, [projectPath]);
    server = await createWebServer({
      configPath,
      settingsPath,
      logDir: join(tempDir, "logs"),
      cwd: tempDir,
      registryPath: join(tempDir, "runtime.json"),
      port: 0,
    }).start();

    const globalResponse = await fetch(`${server.url}/api/settings/global`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ terminal: { fontSize: 2 } }),
    });
    const projectResponse = await fetch(
      `${server.url}/api/settings/project?projectPath=${encodeURIComponent(projectPath)}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ database: { resultLimit: 5 } }),
      },
    );
    const unknownResponse = await fetch(`${server.url}/api/settings/global`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret: true }),
    });
    const malformedResponse = await fetch(
      `${server.url}/api/settings/project?projectPath=${encodeURIComponent(projectPath)}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: "{not-json",
      },
    );

    expect(globalResponse.status).toBe(400);
    expect(projectResponse.status).toBe(400);
    expect(unknownResponse.status).toBe(400);
    expect(malformedResponse.status).toBe(400);
    await expect(readFile(settingsPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      readFile(join(projectPath, "nomoreide.config.json"), "utf8"),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(JSON.parse(await readFile(configPath, "utf8"))).not.toHaveProperty(
      "preferences",
    );
  });

  test("resets global and project settings to defaults", async () => {
    const configPath = join(tempDir, "nomoreide.config.json");
    const settingsPath = join(tempDir, "settings.json");
    const projectPath = join(tempDir, "repo");
    await registerSettingsProjects(configPath, [projectPath]);
    server = await createWebServer({
      configPath,
      settingsPath,
      logDir: join(tempDir, "logs"),
      cwd: tempDir,
      registryPath: join(tempDir, "runtime.json"),
      port: 0,
    }).start();
    await fetch(`${server.url}/api/settings/global`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ terminal: { fontSize: 18 } }),
    });
    await fetch(
      `${server.url}/api/settings/project?projectPath=${encodeURIComponent(projectPath)}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ database: { resultLimit: 300 } }),
      },
    );

    const globalResponse = await fetch(
      `${server.url}/api/settings/global/reset`,
      { method: "POST" },
    );
    const projectResponse = await fetch(
      `${server.url}/api/settings/project/reset?projectPath=${encodeURIComponent(projectPath)}`,
      { method: "POST" },
    );

    expect((await globalResponse.json()).global.terminal.fontSize).toBe(13);
    expect((await projectResponse.json()).project.database.resultLimit).toBe(100);
    expect(
      JSON.parse(
        await readFile(join(projectPath, "nomoreide.config.json"), "utf8"),
      ),
    ).not.toHaveProperty("preferences");
  });

  test("returns 400 when stored settings fail schema validation", async () => {
    const configPath = join(tempDir, "nomoreide.config.json");
    const settingsPath = join(tempDir, "settings.json");
    await writeFile(
      settingsPath,
      JSON.stringify({
        version: 1,
        terminal: {
          fontSize: 2,
          cursorStyle: "block",
          scrollback: 5_000,
          copyOnSelect: false,
          confirmTerminate: true,
        },
      }),
    );
    server = await createWebServer({
      configPath,
      settingsPath,
      logDir: join(tempDir, "logs"),
      cwd: tempDir,
      registryPath: join(tempDir, "runtime.json"),
      port: 0,
    }).start();

    const response = await fetch(`${server.url}/api/settings`);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ ok: false });
  });

  test("returns 400 when stored project config is invalid on get and reset", async () => {
    const configPath = join(tempDir, "nomoreide.config.json");
    const settingsPath = join(tempDir, "settings.json");
    const projectPath = join(tempDir, "repo");
    await registerSettingsProjects(configPath, [projectPath]);
    await writeFile(
      join(projectPath, "nomoreide.config.json"),
      JSON.stringify({
        version: 1,
        services: [],
        bundles: [],
        gitRepositories: [],
        databases: [],
        logSources: [],
        githubTokens: [],
        workflows: [],
        githubIdentities: [],
        workflowTriggers: [],
        preferences: {
          logs: { showTimestamps: true, wrapLines: true },
          database: { confirmWrites: true, resultLimit: 5 },
        },
      }),
    );
    server = await createWebServer({
      configPath,
      settingsPath,
      logDir: join(tempDir, "logs"),
      cwd: tempDir,
      registryPath: join(tempDir, "runtime.json"),
      port: 0,
    }).start();

    const getResponse = await fetch(
      `${server.url}/api/settings?projectPath=${encodeURIComponent(projectPath)}`,
    );
    const resetResponse = await fetch(
      `${server.url}/api/settings/project/reset?projectPath=${encodeURIComponent(projectPath)}`,
      { method: "POST" },
    );

    expect(getResponse.status).toBe(400);
    expect(resetResponse.status).toBe(400);
    await expect(resetResponse.json()).resolves.toMatchObject({ ok: false });
  });

  test("serves the React web app shell from the dashboard route", async () => {
    const configPath = join(tempDir, "nomoreide.config.json");
    server = await createWebServer({
      configPath,
      logDir: join(tempDir, "logs"),
      cwd: tempDir,
      registryPath: join(tempDir, "runtime.json"),
      port: 0,
    }).start();

    const response = await fetch(`${server.url}/`);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(html).toContain('<div id="root"></div>');
    expect(html).toContain('type="module"');
    expect(html).not.toContain("<h2>Services</h2>");
  });

  test("serves the React web app shell from the GitHub route", async () => {
    const configPath = join(tempDir, "nomoreide.config.json");
    server = await createWebServer({
      configPath,
      logDir: join(tempDir, "logs"),
      cwd: tempDir,
      registryPath: join(tempDir, "runtime.json"),
      port: 0,
    }).start();

    const response = await fetch(`${server.url}/github`);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(html).toContain('<div id="root"></div>');
    expect(html).toContain('type="module"');
    expect(html).not.toBe("Not found");
  });

  test("serves a NoMoreIDE health endpoint for UI discovery", async () => {
    const configPath = join(tempDir, "nomoreide.config.json");
    server = await createWebServer({
      configPath,
      logDir: join(tempDir, "logs"),
      cwd: tempDir,
      registryPath: join(tempDir, "runtime.json"),
      port: 0,
    }).start();

    const response = await fetch(`${server.url}/api/health`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      app: "nomoreide",
      pid: process.pid,
      version: expect.stringMatching(/^\d+\.\d+\.\d+/),
    });
  });

  test("serves activity metrics and the Activity Monitor app shell", async () => {
    const configPath = join(tempDir, "nomoreide.config.json");
    server = await createWebServer({
      configPath,
      logDir: join(tempDir, "logs"),
      cwd: tempDir,
      registryPath: join(tempDir, "runtime.json"),
      port: 0,
    }).start();

    const metricsResponse = await fetch(`${server.url}/api/metrics`);
    expect(metricsResponse.status).toBe(200);
    const metricsPayload = await metricsResponse.json();
    expect(metricsPayload).toMatchObject({
      ok: true,
      metrics: {
        sampleIntervalMs: 3000,
        host: { samples: expect.any(Array) },
        services: {},
      },
    });
    expect(metricsPayload.metrics.systemProcesses).toBeUndefined();

    const processMetricsResponse = await fetch(
      `${server.url}/api/metrics?includeProcesses=1`,
    );
    await expect(processMetricsResponse.json()).resolves.toMatchObject({
      ok: true,
      metrics: { systemProcesses: expect.any(Array) },
    });

    const shellResponse = await fetch(`${server.url}/activity`);
    expect(shellResponse.status).toBe(200);
    expect(shellResponse.headers.get("content-type")).toContain("text/html");
    expect(await shellResponse.text()).toContain('<div id="root"></div>');

    const headResponse = await fetch(`${server.url}/activity`, { method: "HEAD" });
    expect(headResponse.status).toBe(200);
  });

  test("reports GitHub device flow available from bundled OAuth client ID", async () => {
    const originalClientId = process.env.NOMOREIDE_GITHUB_CLIENT_ID;
    try {
      delete process.env.NOMOREIDE_GITHUB_CLIENT_ID;
      const configPath = join(tempDir, "nomoreide.config.json");
      server = await createWebServer({
        configPath,
        logDir: join(tempDir, "logs"),
        cwd: tempDir,
        registryPath: join(tempDir, "runtime.json"),
        port: 0,
      }).start();

      const response = await fetch(`${server.url}/api/github/token`);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        ok: true,
        configured: false,
        deviceFlowAvailable: true,
        status: "not_configured",
      });
    } finally {
      if (originalClientId === undefined) {
        delete process.env.NOMOREIDE_GITHUB_CLIENT_ID;
      } else {
        process.env.NOMOREIDE_GITHUB_CLIENT_ID = originalClientId;
      }
    }
  });

  test("reports configured GitHub token as connected when validation succeeds", async () => {
    const realFetch = globalThis.fetch;
    const fetchMock = vi.fn(
      (
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ) => {
        if (String(input) === "https://api.github.com/user") {
          expect(init?.headers).toMatchObject({
            Authorization: "Bearer good-token",
          });
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ login: "octocat" }),
          } as Response);
        }
        return realFetch(input, init);
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const configPath = join(tempDir, "nomoreide.config.json");
    const config = new ConfigStore(configPath);
    await config.setGithubToken("github.com", "good-token");
    server = await createWebServer({
      configPath,
      logDir: join(tempDir, "logs"),
      cwd: tempDir,
      registryPath: join(tempDir, "runtime.json"),
      port: 0,
    }).start();

    const response = await fetch(`${server.url}/api/github/token`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      configured: true,
      status: "connected",
      user: { login: "octocat" },
    });
  });

  test("reports configured GitHub token auth failure", async () => {
    const realFetch = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (
          input: Parameters<typeof fetch>[0],
          init?: Parameters<typeof fetch>[1],
        ) => {
          if (String(input) !== "https://api.github.com/user") {
            return realFetch(input, init);
          }
          return Promise.resolve({
          ok: false,
          status: 401,
          statusText: "Unauthorized",
          json: () => Promise.resolve({ message: "Bad credentials" }),
          } as Response);
        },
      ),
    );
    const configPath = join(tempDir, "nomoreide.config.json");
    const config = new ConfigStore(configPath);
    await config.setGithubToken("github.com", "bad-token");
    server = await createWebServer({
      configPath,
      logDir: join(tempDir, "logs"),
      cwd: tempDir,
      registryPath: join(tempDir, "runtime.json"),
      port: 0,
    }).start();

    const response = await fetch(`${server.url}/api/github/token`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      configured: true,
      status: "auth_error",
      error: "Bad credentials",
    });
  });

  test("reports configured GitHub token connection failure", async () => {
    const realFetch = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (
          input: Parameters<typeof fetch>[0],
          init?: Parameters<typeof fetch>[1],
        ) => {
          if (String(input) !== "https://api.github.com/user") {
            return realFetch(input, init);
          }
          return Promise.reject(new Error("network down"));
        },
      ),
    );
    const configPath = join(tempDir, "nomoreide.config.json");
    const config = new ConfigStore(configPath);
    await config.setGithubToken("github.com", "token");
    server = await createWebServer({
      configPath,
      logDir: join(tempDir, "logs"),
      cwd: tempDir,
      registryPath: join(tempDir, "runtime.json"),
      port: 0,
    }).start();

    const response = await fetch(`${server.url}/api/github/token`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      configured: true,
      status: "connection_error",
      error: "network down",
    });
  });

  test("reports connection failure when selected repository has no GitHub remote", async () => {
    const repo = join(tempDir, "repo-without-remote");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(repo);
    await initGitRepo(repo);
    const realFetch = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (
          input: Parameters<typeof fetch>[0],
          init?: Parameters<typeof fetch>[1],
        ) => {
          if (String(input) !== "https://api.github.com/user") {
            return realFetch(input, init);
          }
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ login: "octocat" }),
          } as Response);
        },
      ),
    );
    const configPath = join(tempDir, "nomoreide.config.json");
    const config = new ConfigStore(configPath);
    await config.setGithubToken("github.com", "token");
    await config.registerGitRepository({ name: "local", path: repo });
    server = await createWebServer({
      configPath,
      logDir: join(tempDir, "logs"),
      cwd: tempDir,
      registryPath: join(tempDir, "runtime.json"),
      port: 0,
    }).start();

    const response = await fetch(`${server.url}/api/github/token`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      configured: true,
      status: "connection_error",
      error: "No git remote 'origin' found.",
    });
  });

  test("stores an explicit GitHub credential source for the selected repository", async () => {
    const repo = join(tempDir, "credential-repo");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(repo);
    await initGitRepo(repo);
    const configPath = join(tempDir, "nomoreide.config.json");
    const config = new ConfigStore(configPath);
    await config.registerGitRepository({ name: "credential-repo", path: repo });
    await config.setGithubToken("github.com", "stored-token");
    server = await createWebServer({
      configPath,
      logDir: join(tempDir, "logs"),
      cwd: tempDir,
      registryPath: join(tempDir, "runtime.json"),
      port: 0,
    }).start();

    const response = await fetch(`${server.url}/api/github/account`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repository: "credential-repo",
        credential: { source: "stored", host: "github.com" },
      }),
    });

    expect(response.status).toBe(200);
    expect(
      (await config.load()).gitRepositories.find((entry) => entry.name === "credential-repo")
        ?.githubCredential,
    ).toEqual({ source: "stored", host: "github.com" });
  });

  test("falls back to verification_uri when GitHub omits verification_uri_complete", async () => {
    const realFetch = globalThis.fetch;
    const fetchMock = vi.fn((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      if (String(input) === "https://github.com/login/device/code") {
        return Promise.resolve({
          json: () => Promise.resolve({
            device_code: "device-123",
            user_code: "ABCD-1234",
            verification_uri: "https://github.com/login/device",
            expires_in: 900,
            interval: 5,
          }),
        } as Response);
      }
      return realFetch(input, init);
    });
    vi.stubGlobal("fetch", fetchMock);
    const configPath = join(tempDir, "nomoreide.config.json");
    server = await createWebServer({
      configPath,
      logDir: join(tempDir, "logs"),
      cwd: tempDir,
      registryPath: join(tempDir, "runtime.json"),
      port: 0,
    }).start();

    const response = await fetch(`${server.url}/api/github/oauth/start`, { method: "POST" });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      verification_uri: "https://github.com/login/device",
      verification_uri_complete: "https://github.com/login/device",
    });
  });

  test("builds a GitHub PR template from the selected repository branch", async () => {
    const repo = join(tempDir, "repo-with-pr-branch");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(repo);
    await initGitRepo(repo);
    await execFileAsync("git", ["checkout", "-b", "feature/pr-assistant"], { cwd: repo });
    await createFile(join(repo, "assistant.txt"), "assistant\n");
    await execFileAsync("git", ["add", "assistant.txt"], { cwd: repo });
    await execFileAsync("git", ["commit", "-m", "Add branch to PR assistant"], { cwd: repo });
    await execFileAsync("git", ["remote", "add", "origin", "https://github.com/acme/nomoreide.git"], { cwd: repo });

    const realFetch = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const url = String(input);
        if (url === "https://api.github.com/repos/acme/nomoreide") {
          expect(init?.headers).toMatchObject({ Authorization: "Bearer token" });
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              full_name: "acme/nomoreide",
              html_url: "https://github.com/acme/nomoreide",
              default_branch: "main",
            }),
          } as Response);
        }
        if (url === "https://api.github.com/repos/acme/nomoreide/compare/main...feature%2Fpr-assistant") {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              ahead_by: 1,
              status: "ahead",
              commits: [
                { sha: "abc1234", commit: { message: "Add branch to PR assistant" } },
              ],
              files: [
                { filename: "assistant.txt", status: "added", additions: 1, deletions: 0, changes: 1 },
              ],
            }),
          } as Response);
        }
        if (url === "https://api.github.com/repos/acme/nomoreide/commits/abc1234/check-runs?per_page=100") {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              total_count: 1,
              check_runs: [
                { id: 1, name: "build", status: "completed", conclusion: "success", html_url: "", started_at: null, completed_at: null },
              ],
            }),
          } as Response);
        }
        return realFetch(input, init);
      }),
    );

    const configPath = join(tempDir, "nomoreide.config.json");
    const config = new ConfigStore(configPath);
    await config.setGithubToken("github.com", "token");
    await config.registerGitRepository({ name: "repo", path: repo });
    server = await createWebServer({
      configPath,
      logDir: join(tempDir, "logs"),
      cwd: tempDir,
      registryPath: join(tempDir, "runtime.json"),
      port: 0,
    }).start();

    const response = await fetch(`${server.url}/api/github/pr-template`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      template: {
        repository: { full_name: "acme/nomoreide" },
        base: "main",
        head: "feature/pr-assistant",
        title: "Add branch to PR assistant",
        compare: {
          aheadBy: 1,
          files: [{ path: "assistant.txt", status: "added" }],
          ciStatus: { state: "success", totalCount: 1 },
        },
      },
    });
    expect(body.template.body).toContain("Add branch to PR assistant");
    expect(body.template.body).toContain("assistant.txt");
  });

  test("returns PR review cockpit data for a selected repository pull request", async () => {
    const repo = join(tempDir, "repo-with-pr-cockpit");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(repo);
    await initGitRepo(repo);
    await execFileAsync("git", ["remote", "add", "origin", "https://github.com/acme/nomoreide.git"], { cwd: repo });

    const realFetch = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const url = String(input);
        if (url.startsWith("https://api.github.com/")) {
          expect(init?.headers).toMatchObject({ Authorization: "Bearer token" });
        }
        if (url === "https://api.github.com/repos/acme/nomoreide/pulls/42") {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              number: 42,
              title: "Review cockpit",
              state: "open",
              body: "Details",
              html_url: "https://github.com/acme/nomoreide/pull/42",
              head: { ref: "feature/review", sha: "abc1234" },
              base: { ref: "main" },
              user: { login: "dev" },
              created_at: "2026-06-11T00:00:00Z",
              updated_at: "2026-06-11T00:00:00Z",
              merged_at: null,
              draft: false,
              mergeable: true,
            }),
          } as Response);
        }
        if (url === "https://api.github.com/repos/acme/nomoreide/pulls/42/files?per_page=100") {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve([
              { filename: "src/review.ts", status: "modified", additions: 4, deletions: 1, changes: 5, patch: "@@", blob_url: "https://github.com/acme/nomoreide/blob/abc/src/review.ts" },
            ]),
          } as Response);
        }
        if (url === "https://api.github.com/repos/acme/nomoreide/pulls/42/reviews?per_page=100") {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve([
              { id: 9, state: "CHANGES_REQUESTED", body: "Needs tests", user: { login: "reviewer" }, submitted_at: "2026-06-11T01:00:00Z", html_url: "https://github.com/acme/nomoreide/pull/42#pullrequestreview-9" },
            ]),
          } as Response);
        }
        if (url === "https://api.github.com/repos/acme/nomoreide/issues/42/comments?per_page=100") {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve([
              { id: 7, body: "One note", user: { login: "commenter" }, created_at: "2026-06-11T02:00:00Z", html_url: "https://github.com/acme/nomoreide/pull/42#issuecomment-7" },
            ]),
          } as Response);
        }
        if (url === "https://api.github.com/repos/acme/nomoreide/commits/abc1234/check-runs?per_page=100") {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              total_count: 1,
              check_runs: [
                { id: 2, name: "CI", status: "completed", conclusion: "failure", html_url: "https://github.com/acme/nomoreide/actions/runs/2", started_at: null, completed_at: null },
              ],
            }),
          } as Response);
        }
        return realFetch(input, init);
      }),
    );

    const configPath = join(tempDir, "nomoreide.config.json");
    const config = new ConfigStore(configPath);
    await config.setGithubToken("github.com", "token");
    await config.registerGitRepository({ name: "repo", path: repo });
    server = await createWebServer({
      configPath,
      logDir: join(tempDir, "logs"),
      cwd: tempDir,
      registryPath: join(tempDir, "runtime.json"),
      port: 0,
    }).start();

    const response = await fetch(`${server.url}/api/github/prs/42/review`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      cockpit: {
        pr: { number: 42, mergeable: true },
        files: [{ path: "src/review.ts", status: "modified" }],
        reviews: [{ state: "CHANGES_REQUESTED", user: { login: "reviewer" } }],
        comments: [{ body: "One note" }],
        checks: {
          state: "failure",
          runs: [{ name: "CI", html_url: "https://github.com/acme/nomoreide/actions/runs/2" }],
        },
      },
    });
  });

  test("returns GitHub branches with selected repository context", async () => {
    const repo = join(tempDir, "repo-with-github-branches");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(repo);
    await initGitRepo(repo);
    await execFileAsync("git", ["checkout", "-b", "feature/work"], { cwd: repo });
    await execFileAsync("git", ["remote", "add", "origin", "https://github.com/acme/nomoreide.git"], { cwd: repo });

    const realFetch = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const url = String(input);
        if (url === "https://api.github.com/repos/acme/nomoreide") {
          expect(init?.headers).toMatchObject({ Authorization: "Bearer token" });
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              full_name: "acme/nomoreide",
              html_url: "https://github.com/acme/nomoreide",
              default_branch: "main",
            }),
          } as Response);
        }
        if (url === "https://api.github.com/repos/acme/nomoreide/branches?per_page=100") {
          expect(init?.headers).toMatchObject({ Authorization: "Bearer token" });
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve([
              { name: "main", protected: true, commit: { sha: "abc1234" } },
              { name: "feature/work", protected: false, commit: { sha: "def5678" } },
            ]),
          } as Response);
        }
        return realFetch(input, init);
      }),
    );

    const configPath = join(tempDir, "nomoreide.config.json");
    const config = new ConfigStore(configPath);
    await config.setGithubToken("github.com", "token");
    await config.registerGitRepository({ name: "repo", path: repo });
    server = await createWebServer({
      configPath,
      logDir: join(tempDir, "logs"),
      cwd: tempDir,
      registryPath: join(tempDir, "runtime.json"),
      port: 0,
    }).start();

    const response = await fetch(`${server.url}/api/github/branches`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      repository: { full_name: "acme/nomoreide" },
      defaultBranch: "main",
      currentBranch: "feature/work",
      branches: [
        { name: "main", protected: true, commit: { sha: "abc1234" } },
        { name: "feature/work", protected: false, commit: { sha: "def5678" } },
      ],
    });
  });

  test("returns dashboard data for the React web app", async () => {
    const configPath = join(tempDir, "nomoreide.config.json");
    const config = new ConfigStore(configPath);
    await config.registerService({
      name: "backend",
      command: "npm run dev",
      cwd: tempDir,
      port: 3001,
    });
    await config.registerBundle({
      name: "full-stack",
      services: ["backend"],
    });
    server = await createWebServer({
      configPath,
      logDir: join(tempDir, "logs"),
      cwd: tempDir,
      registryPath: join(tempDir, "runtime.json"),
      port: 0,
    }).start();

    const response = await fetch(`${server.url}/api/dashboard`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      cwd: tempDir,
      config: {
        services: [{ name: "backend", command: "npm run dev", port: 3001 }],
        bundles: [{ name: "full-stack", services: ["backend"] }],
      },
      runtime: {
        services: {},
      },
      health: {
        backend: {
          service: "backend",
          status: "unknown",
        },
      },
    });
    expect(body.timeline).toEqual([]);
    // A non-Git cwd is left unselected (empty state), so git.cwd is blank.
    expect(body.git).toMatchObject({
      cwd: "",
      selectedRepository: null,
    });
  });

  test("reports configured ports occupied by external processes", async () => {
    const occupiedPort = await listenOnFreePort();
    const configPath = join(tempDir, "nomoreide.config.json");
    const config = new ConfigStore(configPath);
    await config.registerService({
      name: "frontend",
      command: "npm run dev",
      cwd: tempDir,
      port: occupiedPort,
    });
    server = await createWebServer({
      configPath,
      logDir: join(tempDir, "logs"),
      cwd: tempDir,
      registryPath: join(tempDir, "runtime.json"),
      port: 0,
    }).start();

    const response = await fetch(`${server.url}/api/dashboard`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ports).toContainEqual({
      port: occupiedPort,
      available: false,
      state: "occupied",
      services: ["frontend"],
      urls: [],
      hosts: expect.arrayContaining([
        expect.objectContaining({
          host: "127.0.0.1",
          available: false,
        }),
      ]),
    });
  });

  test("includes registered services and bundles in dashboard data", async () => {
    const configPath = join(tempDir, "nomoreide.config.json");
    const config = new ConfigStore(configPath);
    await config.registerService({
      name: "backend",
      command: "npm run dev",
      cwd: tempDir,
      port: 3001,
    });
    await config.registerBundle({
      name: "full-stack",
      services: ["backend"],
    });
    server = await createWebServer({
      configPath,
      logDir: join(tempDir, "logs"),
      registryPath: join(tempDir, "runtime.json"),
      port: 0,
    }).start();

    const response = await fetch(`${server.url}/api/dashboard`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.config.services[0]).toMatchObject({
      name: "backend",
      command: "npm run dev",
      port: 3001,
    });
    expect(body.config.bundles[0]).toEqual({
      name: "full-stack",
      services: ["backend"],
    });
  });

  test("responds to HEAD requests for the dashboard", async () => {
    const configPath = join(tempDir, "nomoreide.config.json");
    server = await createWebServer({
      configPath,
      logDir: join(tempDir, "logs"),
      registryPath: join(tempDir, "runtime.json"),
      port: 0,
    }).start();

    const response = await fetch(`${server.url}/`, { method: "HEAD" });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
  });

  test("starts a registered service through the action API", async () => {
    const configPath = join(tempDir, "nomoreide.config.json");
    const config = new ConfigStore(configPath);
    await config.registerService({
      name: "oneshot",
      command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("console.log('ready')")}`,
      cwd: tempDir,
    });
    server = await createWebServer({
      configPath,
      logDir: join(tempDir, "logs"),
      registryPath: join(tempDir, "runtime.json"),
      port: 0,
    }).start();

    const response = await fetch(`${server.url}/api/services/oneshot/start`, {
      method: "POST",
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      status: {
        name: "oneshot",
      },
    });

    const dashboardResponse = await fetch(`${server.url}/api/dashboard`);
    const dashboard = await dashboardResponse.json();
    expect(dashboard.timeline).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "service.lifecycle",
          service: "oneshot",
          title: "oneshot started",
        }),
      ]),
    );
  });

  test("registers a service from a web form post", async () => {
    const configPath = join(tempDir, "nomoreide.config.json");
    server = await createWebServer({
      configPath,
      logDir: join(tempDir, "logs"),
      registryPath: join(tempDir, "runtime.json"),
      port: 0,
    }).start();

    const response = await fetch(`${server.url}/api/services`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        name: "frontend",
        command: "npm run dev",
        cwd: tempDir,
        port: "5173",
        description: "Vite app",
      }),
    });

    const body = await response.json();
    const config = await new ConfigStore(configPath).load();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: true });
    expect(config.services[0]).toMatchObject({
      name: "frontend",
      command: "npm run dev",
      cwd: tempDir,
      port: 5173,
      description: "Vite app",
    });
  });

  test("registers a docker-compose service from a web form post", async () => {
    const configPath = join(tempDir, "nomoreide.config.json");
    server = await createWebServer({
      configPath,
      logDir: join(tempDir, "logs"),
      registryPath: join(tempDir, "runtime.json"),
      port: 0,
    }).start();

    const response = await fetch(`${server.url}/api/services`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        name: "api",
        kind: "docker-compose",
        cwd: tempDir,
        composeFile: "docker-compose.yml",
        composeService: "api",
        port: "3001",
      }),
    });

    expect(response.status).toBe(200);
    const config = await new ConfigStore(configPath).load();
    expect(config.services[0]).toMatchObject({
      name: "api",
      kind: "docker-compose",
      composeService: "api",
      composeFile: "docker-compose.yml",
    });
  });

  test("registers an ssh service from a web form post", async () => {
    const configPath = join(tempDir, "nomoreide.config.json");
    server = await createWebServer({
      configPath,
      logDir: join(tempDir, "logs"),
      registryPath: join(tempDir, "runtime.json"),
      port: 0,
    }).start();

    const response = await fetch(`${server.url}/api/services`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        name: "staging-api",
        kind: "ssh",
        host: "devbox",
        cwd: "/srv/app",
        command: "npm run dev",
        port: "3001",
      }),
    });

    expect(response.status).toBe(200);
    const config = await new ConfigStore(configPath).load();
    expect(config.services[0]).toMatchObject({
      name: "staging-api",
      kind: "ssh",
      host: "devbox",
      command: "npm run dev",
    });
  });

  test("tests a service command without registering it", async () => {
    const configPath = join(tempDir, "nomoreide.config.json");
    server = await createWebServer({
      configPath,
      logDir: join(tempDir, "logs"),
      cwd: tempDir,
      registryPath: join(tempDir, "runtime.json"),
      port: 0,
    }).start();

    const response = await fetch(`${server.url}/api/services/test`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("console.log('ready')")}`,
        cwd: tempDir,
      }),
    });
    const body = await response.json();
    const config = await new ConfigStore(configPath).load();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
    });
    expect(body.message).toContain("Command completed");
    expect(config.services).toEqual([]);
  });

  test("reports service command test failures", async () => {
    const configPath = join(tempDir, "nomoreide.config.json");
    server = await createWebServer({
      configPath,
      logDir: join(tempDir, "logs"),
      cwd: tempDir,
      registryPath: join(tempDir, "runtime.json"),
      port: 0,
    }).start();

    const response = await fetch(`${server.url}/api/services/test`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("process.exit(7)")}`,
        cwd: tempDir,
      }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: false,
      exitCode: 7,
    });
  });

  test("registers a bundle from a web form post", async () => {
    const configPath = join(tempDir, "nomoreide.config.json");
    server = await createWebServer({
      configPath,
      logDir: join(tempDir, "logs"),
      registryPath: join(tempDir, "runtime.json"),
      port: 0,
    }).start();

    const response = await fetch(`${server.url}/api/bundles`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        name: "full-stack",
        services: "backend, frontend",
      }),
    });

    const body = await response.json();
    const raw = JSON.parse(await readConfig(configPath));

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: true });
    expect(raw.bundles[0]).toEqual({
      name: "full-stack",
      services: ["backend", "frontend"],
    });
  });

  test("renames a bundle from a web form post", async () => {
    const configPath = join(tempDir, "nomoreide.config.json");
    const config = new ConfigStore(configPath);
    await config.registerBundle({
      name: "old-stack",
      services: ["backend"],
    });
    server = await createWebServer({
      configPath,
      logDir: join(tempDir, "logs"),
      registryPath: join(tempDir, "runtime.json"),
      port: 0,
    }).start();

    const response = await fetch(`${server.url}/api/bundles`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        originalName: "old-stack",
        name: "full-stack",
        services: "backend, frontend",
      }),
    });

    const body = await response.json();
    const raw = JSON.parse(await readConfig(configPath));

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: true });
    expect(raw.bundles).toEqual([
      {
        name: "full-stack",
        services: ["backend", "frontend"],
      },
    ]);
  });

  test("restarts a registered bundle through the action API", async () => {
    const configPath = join(tempDir, "nomoreide.config.json");
    const config = new ConfigStore(configPath);
    await config.registerService({
      name: "backend",
      command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("setInterval(() => {}, 1000)")}`,
      cwd: tempDir,
    });
    await config.registerBundle({
      name: "full-stack",
      services: ["backend"],
    });
    server = await createWebServer({
      configPath,
      logDir: join(tempDir, "logs"),
      registryPath: join(tempDir, "runtime.json"),
      port: 0,
    }).start();

    const response = await fetch(`${server.url}/api/bundles/full-stack/restart`, {
      method: "POST",
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      statuses: [{ name: "backend", state: "running" }],
    });
  });

  test("renders git status when the web cwd is a git repository", async () => {
    await execFileAsync("git", ["init"], { cwd: tempDir });
    await execFileAsync("git", ["config", "user.email", "nomoreide@example.test"], {
      cwd: tempDir,
    });
    await execFileAsync("git", ["config", "user.name", "NoMoreIDE Test"], {
      cwd: tempDir,
    });
    await createFile(join(tempDir, "README.md"), "hello\n");
    const configPath = join(tempDir, "nomoreide.config.json");
    // Auto-adopt persists the repo to configPath, which here lives inside the
    // worktree; exclude it locally so it doesn't pollute the status assertion
    // (the real config lives in ~/.config/nomoreide, outside any repo).
    await writeFile(join(tempDir, ".git", "info", "exclude"), "nomoreide.config.json\n");
    server = await createWebServer({
      configPath,
      logDir: join(tempDir, "logs"),
      cwd: tempDir,
      registryPath: join(tempDir, "runtime.json"),
      port: 0,
    }).start();

    const response = await fetch(`${server.url}/api/dashboard`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.git.status.files).toEqual([
      { index: "?", workingTree: "?", path: "README.md" },
    ]);
  });

  test("returns an empty git state outside a git repository", async () => {
    const configPath = join(tempDir, "nomoreide.config.json");
    server = await createWebServer({
      configPath,
      logDir: join(tempDir, "logs"),
      cwd: tempDir,
      registryPath: join(tempDir, "runtime.json"),
      port: 0,
    }).start();

    const response = await fetch(`${server.url}/api/dashboard`);
    const body = await response.json();

    expect(response.status).toBe(200);
    // No repo registered and cwd isn't a worktree → unselected empty state,
    // not an error (the UI shows its "no Git project" prompt).
    expect(body.git.status).toBeNull();
    expect(body.git.cwd).toBe("");
    expect(body.git.selectedRepository).toBeNull();
    expect(body.git.error).toBeUndefined();
  });

  test("serves the React web app shell from the git route", async () => {
    const configPath = join(tempDir, "nomoreide.config.json");
    server = await createWebServer({
      configPath,
      logDir: join(tempDir, "logs"),
      cwd: tempDir,
      registryPath: join(tempDir, "runtime.json"),
      port: 0,
    }).start();

    const response = await fetch(`${server.url}/git`);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('<div id="root"></div>');
    expect(html).toContain('type="module"');
  });

  test("registers and selects git repositories from the web UI", async () => {
    const repoA = join(tempDir, "repo-a");
    const repoB = join(tempDir, "repo-b");
    const { mkdir, readFile } = await import("node:fs/promises");
    await mkdir(repoA);
    await mkdir(repoB);
    await execFileAsync("git", ["init"], { cwd: repoA });
    await execFileAsync("git", ["init"], { cwd: repoB });
    await createFile(join(repoA, "a.txt"), "a\n");
    await createFile(join(repoB, "b.txt"), "b\n");
    const configPath = join(tempDir, "nomoreide.config.json");
    server = await createWebServer({
      configPath,
      logDir: join(tempDir, "logs"),
      cwd: tempDir,
      registryPath: join(tempDir, "runtime.json"),
      port: 0,
    }).start();

    await fetch(`${server.url}/api/git/repositories`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ name: "repo-a", path: repoA }),
    });
    await fetch(`${server.url}/api/git/repositories`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ name: "repo-b", path: repoB }),
    });
    await fetch(`${server.url}/api/git/select`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ name: "repo-b" }),
    });

    const raw = JSON.parse(await readFile(configPath, "utf8"));
    const dashboard = await (await fetch(`${server.url}/api/dashboard`)).json();

    expect(raw.selectedGitRepository).toBe("repo-b");
    expect(dashboard.config.gitRepositories.map((repo: { name: string }) => repo.name)).toEqual([
      "repo-a",
      "repo-b",
    ]);
    expect(dashboard.git.selectedRepository).toMatchObject({
      name: "repo-b",
      path: repoB,
    });
    expect(dashboard.git.status.files).toEqual([
      { index: "?", workingTree: "?", path: "b.txt" },
    ]);
  });

  test("rejects non-absolute git repository paths from the web UI", async () => {
    const configPath = join(tempDir, "nomoreide.config.json");
    server = await createWebServer({
      configPath,
      logDir: join(tempDir, "logs"),
      cwd: tempDir,
      registryPath: join(tempDir, "runtime.json"),
      port: 0,
    }).start();

    const response = await fetch(`${server.url}/api/git/repositories`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ name: "app", path: "~/repo/app" }),
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toContain("Please add an absolute path");
  });

  test("rejects absolute non-git repository paths from the web UI", async () => {
    const notGitPath = join(tempDir, "not-git");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(notGitPath);
    const configPath = join(tempDir, "nomoreide.config.json");
    server = await createWebServer({
      configPath,
      logDir: join(tempDir, "logs"),
      cwd: tempDir,
      registryPath: join(tempDir, "runtime.json"),
      port: 0,
    }).start();

    const response = await fetch(`${server.url}/api/git/repositories`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ name: "app", path: notGitPath }),
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toContain("Not a Git repository");
  });

  test("removes git repositories from the web UI", async () => {
    const repoA = join(tempDir, "repo-a");
    const repoB = join(tempDir, "repo-b");
    const { mkdir, readFile } = await import("node:fs/promises");
    await mkdir(repoA);
    await mkdir(repoB);
    await execFileAsync("git", ["init"], { cwd: repoA });
    await execFileAsync("git", ["init"], { cwd: repoB });
    const configPath = join(tempDir, "nomoreide.config.json");
    server = await createWebServer({
      configPath,
      logDir: join(tempDir, "logs"),
      cwd: tempDir,
      registryPath: join(tempDir, "runtime.json"),
      port: 0,
    }).start();

    await fetch(`${server.url}/api/git/repositories`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ name: "repo-a", path: repoA }),
    });
    await fetch(`${server.url}/api/git/repositories`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ name: "repo-b", path: repoB }),
    });

    const response = await fetch(`${server.url}/api/git/repositories/repo-b`, {
      method: "DELETE",
    });
    const raw = JSON.parse(await readFile(configPath, "utf8"));

    expect(response.status).toBe(200);
    expect(raw.gitRepositories).toEqual([{ name: "repo-a", path: repoA }]);
    expect(raw.selectedGitRepository).toBeUndefined();
  });

  test("lists directories for the project explorer", async () => {
    const repoA = join(tempDir, "repo-a");
    const repoB = join(tempDir, "repo-b");
    const nested = join(repoA, "nested");
    const dependencyDir = join(tempDir, "node_modules");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(repoA);
    await mkdir(repoB);
    await mkdir(nested);
    await mkdir(dependencyDir);
    await createFile(join(tempDir, "README.md"), "not a directory\n");
    const configPath = join(tempDir, "nomoreide.config.json");
    server = await createWebServer({
      configPath,
      logDir: join(tempDir, "logs"),
      cwd: tempDir,
      registryPath: join(tempDir, "runtime.json"),
      port: 0,
    }).start();

    const response = await fetch(
      `${server.url}/api/fs/directories?path=${encodeURIComponent(tempDir)}`,
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      path: tempDir,
      entries: [
        { name: "repo-a", path: repoA },
        { name: "repo-b", path: repoB },
      ],
    });
    expect(body.entries).not.toContainEqual({
      name: "node_modules",
      path: dependencyDir,
    });
  });

  test("renders git diff rows inside a constrained horizontal scroller", async () => {
    await execFileAsync("git", ["init"], { cwd: tempDir });
    await execFileAsync("git", ["config", "user.email", "nomoreide@example.test"], {
      cwd: tempDir,
    });
    await execFileAsync("git", ["config", "user.name", "NoMoreIDE Test"], {
      cwd: tempDir,
    });
    await createFile(join(tempDir, "long.ts"), "export const value = 'short';\n");
    await execFileAsync("git", ["add", "long.ts"], { cwd: tempDir });
    await execFileAsync("git", ["commit", "-m", "initial"], { cwd: tempDir });
    await createFile(
      join(tempDir, "long.ts"),
      `export const value = '${"x".repeat(240)}';\n`,
    );
    const configPath = join(tempDir, "nomoreide.config.json");
    server = await createWebServer({
      configPath,
      logDir: join(tempDir, "logs"),
      cwd: tempDir,
      registryPath: join(tempDir, "runtime.json"),
      port: 0,
    }).start();

    const response = await fetch(`${server.url}/api/git/diff?file=long.ts`);
    const diff = await response.text();

    expect(response.status).toBe(200);
    expect(diff).toContain("-export const value = 'short';");
    expect(diff).toContain(`+export const value = '${"x".repeat(240)}';`);
  });

  test("returns a new-file diff for untracked files from the diff API", async () => {
    await initGitRepo(tempDir);
    await createFile(join(tempDir, "new-file.ts"), "export const value = 1;\n");
    const configPath = join(tempDir, "nomoreide.config.json");
    server = await createWebServer({
      configPath,
      logDir: join(tempDir, "logs"),
      cwd: tempDir,
      registryPath: join(tempDir, "runtime.json"),
      port: 0,
    }).start();

    const response = await fetch(`${server.url}/api/git/diff?file=new-file.ts`);
    const diff = await response.text();

    expect(response.status).toBe(200);
    expect(diff).toContain("new file mode");
    expect(diff).toContain("+++ b/new-file.ts");
    expect(diff).toContain("+export const value = 1;");
  });

  test("updates a tracked git file from the file API", async () => {
    await initGitRepo(tempDir);
    const configPath = join(tempDir, "nomoreide.config.json");
    server = await createWebServer({
      configPath,
      logDir: join(tempDir, "logs"),
      cwd: tempDir,
      registryPath: join(tempDir, "runtime.json"),
      port: 0,
    }).start();

    const response = await fetch(`${server.url}/api/git/file`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "README.md", content: "changed from api\n" }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true });
    await expect(readFile(join(tempDir, "README.md"), "utf8")).resolves.toBe(
      "changed from api\n",
    );
  });

  test("returns git branches in dashboard data", async () => {
    await initGitRepo(tempDir);
    await execFileAsync("git", ["checkout", "-b", "feature/api"], { cwd: tempDir });
    const configPath = join(tempDir, "nomoreide.config.json");
    server = await createWebServer({
      configPath,
      logDir: join(tempDir, "logs"),
      cwd: tempDir,
      registryPath: join(tempDir, "runtime.json"),
      port: 0,
    }).start();

    const response = await fetch(`${server.url}/api/dashboard`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.git.branches).toContainEqual({
      name: "feature/api",
      current: true,
      remote: false,
    });
  });

  test("creates and switches git branches from the web UI", async () => {
    await initGitRepo(tempDir);
    const configPath = join(tempDir, "nomoreide.config.json");
    server = await createWebServer({
      configPath,
      logDir: join(tempDir, "logs"),
      cwd: tempDir,
      registryPath: join(tempDir, "runtime.json"),
      port: 0,
    }).start();

    const createResponse = await fetch(`${server.url}/api/git/branches`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ name: "feature/web" }),
    });
    const switchResponse = await fetch(`${server.url}/api/git/branches/switch`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ name: "master" }),
    });
    const dashboard = await (await fetch(`${server.url}/api/dashboard`)).json();

    expect(createResponse.status).toBe(200);
    expect(switchResponse.status).toBe(200);
    expect(dashboard.git.status.branch).toBe("master");
    expect(dashboard.git.branches.map((branch: { name: string }) => branch.name)).toContain(
      "feature/web",
    );
  });

  test("creates, activates, lists, and removes managed git worktrees", async () => {
    await initGitRepo(tempDir);
    const managedRoot = join(tempDir, "worktrees");
    vi.stubEnv("NOMOREIDE_WORKTREES_DIR", managedRoot);
    const configPath = join(tempDir, "nomoreide.config.json");
    server = await createWebServer({
      configPath,
      logDir: join(tempDir, "logs"),
      cwd: tempDir,
      registryPath: join(tempDir, "runtime.json"),
      port: 0,
    }).start();
    await fetch(`${server.url}/api/dashboard`);

    const createResponse = await fetch(`${server.url}/api/git/worktrees`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        branch: "feature/worktree-api",
        createBranch: true,
        baseRef: "HEAD",
      }),
    });
    const created = await createResponse.json();
    const dashboard = await (await fetch(`${server.url}/api/dashboard`)).json();
    const listed = await (await fetch(`${server.url}/api/git/worktrees`)).json();

    expect(createResponse.status).toBe(201);
    expect(created.worktree).toMatchObject({
      branch: "feature/worktree-api",
      primary: false,
      dirty: false,
    });
    expect(dashboard.git.cwd).toBe(created.worktree.path);
    expect(dashboard.git.status.branch).toBe("feature/worktree-api");
    expect(listed.activePath).toBe(created.worktree.path);
    expect(listed.worktrees).toHaveLength(2);

    const activeRemoveResponse = await fetch(`${server.url}/api/git/worktrees`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: created.worktree.path }),
    });
    expect(activeRemoveResponse.status).toBe(409);
    expect((await activeRemoveResponse.json()).error).toMatch(/Switch to another/);

    const primary = listed.worktrees.find(
      (worktree: { primary: boolean }) => worktree.primary,
    );
    await fetch(`${server.url}/api/git/worktrees/active`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: primary.path }),
    });
    const removeResponse = await fetch(`${server.url}/api/git/worktrees`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: created.worktree.path }),
    });

    expect(removeResponse.status).toBe(200);
    expect(
      (await (await fetch(`${server.url}/api/git/worktrees`)).json()).worktrees,
    ).toHaveLength(1);
  });

  test("fetches git branches from the web UI", async () => {
    await initGitRepo(tempDir);
    const remoteDir = join(tempDir, "remote.git");
    await execFileAsync("git", ["init", "--bare", remoteDir], { cwd: tempDir });
    await execFileAsync("git", ["remote", "add", "origin", remoteDir], { cwd: tempDir });
    await execFileAsync("git", ["push", "-u", "origin", "master"], { cwd: tempDir });
    await execFileAsync("git", ["push", "origin", "master:feature/remote"], { cwd: tempDir });
    const configPath = join(tempDir, "nomoreide.config.json");
    server = await createWebServer({
      configPath,
      logDir: join(tempDir, "logs"),
      cwd: tempDir,
      registryPath: join(tempDir, "runtime.json"),
      port: 0,
    }).start();

    const response = await fetch(`${server.url}/api/git/fetch`, { method: "POST" });
    const dashboard = await (await fetch(`${server.url}/api/dashboard`)).json();
    const branchesResponse = await fetch(`${server.url}/api/git/branches`);
    const branches = await branchesResponse.json();

    expect(response.status).toBe(200);
    expect(dashboard.git.branches).toContainEqual({
      name: "origin/feature/remote",
      current: false,
      remote: true,
    });
    expect(branchesResponse.status).toBe(200);
    expect(branches.branches).toEqual(dashboard.git.branches);
  });

  test("reports changed files across every repository for the board", async () => {
    const repoA = join(tempDir, "repo-a");
    const repoB = join(tempDir, "repo-b");
    const missing = join(tempDir, "repo-missing");
    const { mkdir } = await import("node:fs/promises");
    await Promise.all([mkdir(repoA), mkdir(repoB), mkdir(missing)]);
    await initGitRepo(repoA);
    await initGitRepo(repoB);
    await initGitRepo(missing);
    // Dirty repo-a only; leave repo-b clean.
    await createFile(join(repoA, "changed.txt"), "changed\n");
    // Register repo-missing then delete its directory so status fails for it.
    const configPath = join(tempDir, "nomoreide.config.json");
    server = await createWebServer({
      configPath,
      logDir: join(tempDir, "logs"),
      cwd: tempDir,
      registryPath: join(tempDir, "runtime.json"),
      port: 0,
    }).start();

    for (const [name, path] of [
      ["repo-a", repoA],
      ["repo-b", repoB],
      ["repo-missing", missing],
    ] as const) {
      await fetch(`${server.url}/api/git/repositories`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ name, path }),
      });
    }
    await rm(missing, { recursive: true, force: true });

    const response = await fetch(`${server.url}/api/git/overview`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    const byName = Object.fromEntries(
      body.repos.map((repo: { name: string }) => [repo.name, repo]),
    );
    expect(byName["repo-a"].files).toEqual([
      { index: "?", workingTree: "?", path: "changed.txt" },
    ]);
    expect(byName["repo-b"].files).toEqual([]);
    // A broken repo surfaces as a per-column error, not a failed response.
    expect(byName["repo-missing"].error).toBeTruthy();
    expect(byName["repo-missing"].files).toEqual([]);
  });

  test("persists and reports the curated board order, dropping stale names", async () => {
    const repoA = join(tempDir, "repo-a");
    const repoB = join(tempDir, "repo-b");
    const { mkdir } = await import("node:fs/promises");
    await Promise.all([mkdir(repoA), mkdir(repoB)]);
    await initGitRepo(repoA);
    await initGitRepo(repoB);
    const configPath = join(tempDir, "nomoreide.config.json");
    server = await createWebServer({
      configPath,
      logDir: join(tempDir, "logs"),
      cwd: tempDir,
      registryPath: join(tempDir, "runtime.json"),
      port: 0,
    }).start();

    for (const [name, path] of [
      ["repo-a", repoA],
      ["repo-b", repoB],
    ] as const) {
      await fetch(`${server.url}/api/git/repositories`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ name, path }),
      });
    }

    // Never curated → overview defaults to the first repos (both, here).
    const initial = await (await fetch(`${server.url}/api/git/overview`)).json();
    expect(initial.board).toEqual(["repo-a", "repo-b"]);

    // Curate: reorder and include a stale name that must be filtered out.
    const put = await fetch(`${server.url}/api/git/board`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ names: ["repo-b", "ghost", "repo-a"] }),
    });
    const putBody = await put.json();
    expect(put.status).toBe(200);
    expect(putBody.board).toEqual(["repo-b", "repo-a"]);

    const after = await (await fetch(`${server.url}/api/git/overview`)).json();
    expect(after.board).toEqual(["repo-b", "repo-a"]);

    // Explicitly empty board stays empty (not re-defaulted to all repos).
    await fetch(`${server.url}/api/git/board`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ names: [] }),
    });
    const cleared = await (await fetch(`${server.url}/api/git/overview`)).json();
    expect(cleared.board).toEqual([]);
  });

  test("defaults the board to the first four repos and caps the stored list at five", async () => {
    const { mkdir } = await import("node:fs/promises");
    const names = ["r1", "r2", "r3", "r4", "r5", "r6"];
    const paths = names.map((name) => join(tempDir, name));
    // A bare `git init` is enough to register; skip commits to keep the suite light.
    for (const path of paths) {
      await mkdir(path);
      await execFileAsync("git", ["init"], { cwd: path });
    }
    const configPath = join(tempDir, "nomoreide.config.json");
    server = await createWebServer({
      configPath,
      logDir: join(tempDir, "logs"),
      cwd: tempDir,
      registryPath: join(tempDir, "runtime.json"),
      port: 0,
    }).start();

    for (let i = 0; i < names.length; i++) {
      await fetch(`${server.url}/api/git/repositories`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ name: names[i], path: paths[i] }),
      });
    }

    // Never curated: 6 repos registered, board defaults to the first 4.
    const initial = await (await fetch(`${server.url}/api/git/overview`)).json();
    expect(initial.repos).toHaveLength(6);
    expect(initial.board).toEqual(["r1", "r2", "r3", "r4"]);

    // Trying to pin all 6 is capped at 5 (extras dropped, order preserved).
    const put = await fetch(`${server.url}/api/git/board`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ names }),
    });
    const putBody = await put.json();
    expect(putBody.board).toEqual(["r1", "r2", "r3", "r4", "r5"]);

    const after = await (await fetch(`${server.url}/api/git/overview`)).json();
    expect(after.board).toEqual(["r1", "r2", "r3", "r4", "r5"]);
  });

  test("scopes the diff endpoint to a named repository", async () => {
    const repoA = join(tempDir, "repo-a");
    const repoB = join(tempDir, "repo-b");
    const { mkdir } = await import("node:fs/promises");
    await Promise.all([mkdir(repoA), mkdir(repoB)]);
    await initGitRepo(repoA);
    await initGitRepo(repoB);
    await createFile(join(repoB, "only-b.txt"), "b content\n");
    const configPath = join(tempDir, "nomoreide.config.json");
    server = await createWebServer({
      configPath,
      logDir: join(tempDir, "logs"),
      cwd: tempDir,
      registryPath: join(tempDir, "runtime.json"),
      port: 0,
    }).start();

    for (const [name, path] of [
      ["repo-a", repoA],
      ["repo-b", repoB],
    ] as const) {
      await fetch(`${server.url}/api/git/repositories`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ name, path }),
      });
    }
    // repo-a is selected (first registered); ask for repo-b's diff explicitly.
    const response = await fetch(
      `${server.url}/api/git/diff?file=only-b.txt&repo=repo-b`,
    );
    const diff = await response.text();

    expect(response.status).toBe(200);
    expect(diff).toContain("only-b.txt");
    expect(diff).toContain("b content");

    const unknown = await fetch(
      `${server.url}/api/git/diff?file=only-b.txt&repo=nope`,
    );
    expect(unknown.status).toBe(404);
  });
});

async function readConfig(path: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  return readFile(path, "utf8");
}

async function registerSettingsProjects(
  configPath: string,
  projectPaths: string[],
): Promise<void> {
  await Promise.all(projectPaths.map((projectPath) => mkdir(projectPath)));
  await new ConfigStore(configPath).save({
    version: 1,
    services: [],
    bundles: [],
    gitRepositories: projectPaths.map((projectPath, index) => ({
      name: `repo-${index + 1}`,
      path: projectPath,
    })),
    databases: [],
    logSources: [],
    githubTokens: [],
    workflows: [],
    githubIdentities: [],
    workflowTriggers: [],
  });
}

async function createFile(path: string, contents: string): Promise<void> {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path, contents);
}

async function initGitRepo(path: string): Promise<void> {
  await execFileAsync("git", ["init"], { cwd: path });
  await execFileAsync("git", ["config", "user.email", "nomoreide@example.test"], {
    cwd: path,
  });
  await execFileAsync("git", ["config", "user.name", "NoMoreIDE Test"], {
    cwd: path,
  });
  await createFile(join(path, "README.md"), "hello\n");
  await execFileAsync("git", ["add", "README.md"], { cwd: path });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: path });
}

async function listenOnFreePort(): Promise<number> {
  const portServer = net.createServer();
  portServers.push(portServer);

  await new Promise<void>((resolve, reject) => {
    portServer.once("error", reject);
    portServer.listen(0, "127.0.0.1", () => resolve());
  });

  const address = portServer.address();
  return typeof address === "object" && address ? address.port : 0;
}
