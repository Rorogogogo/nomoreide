import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createUiLifecycleManager } from "../src/web/ui-lifecycle.js";
import { createWebServer, type WebServerOptions } from "../src/web/server.js";

let tempDir: string;
let server: Awaited<ReturnType<ReturnType<typeof createWebServer>["start"]>> | undefined;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "nomoreide-ui-lifecycle-"));
});

afterEach(async () => {
  await server?.stop();
  server = undefined;
  await rm(tempDir, { recursive: true, force: true });
});

describe("UI lifecycle manager", () => {
  test("reuses a healthy recorded NoMoreIDE UI instead of starting another server", async () => {
    server = await createWebServer({
      configPath: join(tempDir, "nomoreide.config.json"),
      logDir: join(tempDir, "logs"),
      cwd: tempDir,
      port: 0,
    }).start();
    const statePath = join(tempDir, ".nomoreide", "ui-state.json");
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(
      statePath,
      JSON.stringify({
        pid: process.pid,
        url: server.url,
        port: server.port,
        startedAt: new Date().toISOString(),
      }),
      "utf8",
    );
    const startCalls: WebServerOptions[] = [];

    const manager = createUiLifecycleManager({
      cwd: tempDir,
      configPath: join(tempDir, "nomoreide.config.json"),
      logDir: join(tempDir, "logs"),
      port: 0,
      statePath,
      createServer: (options) => {
        startCalls.push(options);
        return createWebServer(options);
      },
    });

    const result = await manager.ensureStarted();

    expect(result).toMatchObject({
      status: "already_running",
      url: server.url,
      port: server.port,
    });
    expect(startCalls).toEqual([]);
  });

  test("reuses a healthy NoMoreIDE UI on the configured port when state is missing", async () => {
    server = await createWebServer({
      configPath: join(tempDir, "nomoreide.config.json"),
      logDir: join(tempDir, "logs"),
      cwd: tempDir,
      port: 0,
    }).start();
    const startCalls: WebServerOptions[] = [];

    const manager = createUiLifecycleManager({
      cwd: tempDir,
      configPath: join(tempDir, "nomoreide.config.json"),
      logDir: join(tempDir, "logs"),
      port: server.port,
      statePath: join(tempDir, ".nomoreide", "missing-ui-state.json"),
      createServer: (options) => {
        startCalls.push(options);
        return createWebServer(options);
      },
    });

    const result = await manager.ensureStarted();

    expect(result).toMatchObject({
      status: "already_running",
      url: server.url,
      port: server.port,
    });
    expect(startCalls).toEqual([]);
  });

  test("starts a UI server, writes state, and closes only the owned server", async () => {
    const statePath = join(tempDir, ".nomoreide", "ui-state.json");
    const manager = createUiLifecycleManager({
      cwd: tempDir,
      configPath: join(tempDir, "nomoreide.config.json"),
      logDir: join(tempDir, "logs"),
      port: 0,
      statePath,
    });

    const result = await manager.ensureStarted();

    expect(result.status).toBe("started");
    const health = await fetch(`${result.url}/api/health`);
    await expect(health.json()).resolves.toEqual({ ok: true, app: "nomoreide" });
    const state = JSON.parse(await readFile(statePath, "utf8")) as {
      pid: number;
      url: string;
      port: number;
    };
    expect(state).toMatchObject({
      pid: process.pid,
      url: result.url,
      port: result.port,
    });

    await expect(manager.close()).resolves.toEqual({ status: "stopped" });
    await expect(access(statePath)).rejects.toThrow();
  });
});
