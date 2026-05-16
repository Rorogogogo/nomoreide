import { mkdtemp, rm } from "node:fs/promises";
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

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "nomoreide-web-"));
});

afterEach(async () => {
  await server?.stop();
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
    });
    expect(body.git).toMatchObject({
      cwd: tempDir,
      selectedRepository: null,
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
    const raw = JSON.parse(await readConfig(configPath));

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: true });
    expect(raw.services[0]).toMatchObject({
      name: "frontend",
      command: "npm run dev",
      cwd: tempDir,
      port: 5173,
      description: "Vite app",
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

  test("returns a clear git unavailable state outside a git repository", async () => {
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
    expect(body.git.status).toBeNull();
    expect(body.git.error).toContain("Not a Git repository");
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
});

async function readConfig(path: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  return readFile(path, "utf8");
}

async function createFile(path: string, contents: string): Promise<void> {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path, contents);
}
