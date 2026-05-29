import net from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
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
  await rm(tempDir, { recursive: true, force: true });
});

describe("web server", () => {
  test("serves the React web app shell from the dashboard route", async () => {
    const configPath = join(tempDir, "nomoreide.config.json");
    server = await createWebServer({
      configPath,
      logDir: join(tempDir, "logs"),
      cwd: tempDir,
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

  test("serves a NoMoreIDE health endpoint for UI discovery", async () => {
    const configPath = join(tempDir, "nomoreide.config.json");
    server = await createWebServer({
      configPath,
      logDir: join(tempDir, "logs"),
      cwd: tempDir,
      port: 0,
    }).start();

    const response = await fetch(`${server.url}/api/health`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      app: "nomoreide",
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
      port: 0,
    }).start();

    const response = await fetch(`${server.url}/api/git/fetch`, { method: "POST" });
    const dashboard = await (await fetch(`${server.url}/api/dashboard`)).json();

    expect(response.status).toBe(200);
    expect(dashboard.git.branches).toContainEqual({
      name: "origin/feature/remote",
      current: false,
      remote: true,
    });
  });
});

async function readConfig(path: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  return readFile(path, "utf8");
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
