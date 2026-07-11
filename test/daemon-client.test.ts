import { createServer, type Server } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ConfigStore } from "../src/core/config-store.js";
import {
  DaemonClient,
  DaemonPortConflictError,
  DaemonRequestError,
} from "../src/core/daemon-client.js";
import { createWebServer } from "../src/web/server.js";

let tempDir: string;
let configPath: string;
let server: Awaited<ReturnType<ReturnType<typeof createWebServer>["start"]>> | undefined;
let blocker: Server | undefined;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "nomoreide-daemon-client-"));
  configPath = join(tempDir, "nomoreide.config.json");
});

afterEach(async () => {
  await server?.stop();
  server = undefined;
  await new Promise<void>((resolveClose) =>
    blocker ? blocker.close(() => resolveClose()) : resolveClose(),
  );
  blocker = undefined;
  await rm(tempDir, { recursive: true, force: true });
});

async function startServer(
  options: { onDaemonShutdown?: () => void } = {},
): Promise<DaemonClient> {
  server = await createWebServer({
    configPath,
    logDir: join(tempDir, "logs"),
    cwd: tempDir,
    port: 0,
    onDaemonShutdown: options.onDaemonShutdown,
  }).start();
  return new DaemonClient(server.url);
}

describe("DaemonClient", () => {
  test("reads status, logs, and timeline over HTTP", async () => {
    const client = await startServer();

    await expect(client.status()).resolves.toEqual({ services: {} });
    await expect(client.logs("api", 50)).resolves.toEqual([]);
    await expect(client.timeline(10)).resolves.toEqual([]);
  });

  test("surfaces daemon errors with their message and status", async () => {
    const client = await startServer();

    const failure = client.startService("ghost");
    await expect(failure).rejects.toBeInstanceOf(DaemonRequestError);
    await expect(failure).rejects.toThrow(/ghost/);
  });

  test("maps port conflicts to DaemonPortConflictError with holder info", async () => {
    const client = await startServer();
    blocker = createServer();
    await new Promise<void>((resolveListen) =>
      blocker?.listen(0, "127.0.0.1", () => resolveListen()),
    );
    const address = blocker.address();
    const heldPort = typeof address === "object" && address ? address.port : 0;
    await new ConfigStore(configPath).registerService({
      name: "api",
      command: "node -e 'setTimeout(() => {}, 60000)'",
      cwd: tempDir,
      port: heldPort,
    });

    const failure = client.startService("api");
    await expect(failure).rejects.toBeInstanceOf(DaemonPortConflictError);
    await expect(failure).rejects.toMatchObject({
      code: "PORT_IN_USE",
      port: heldPort,
    });
  });

  test("starts and stops a registered service through the daemon", async () => {
    const client = await startServer();
    await new ConfigStore(configPath).registerService({
      name: "sleeper",
      command: "node -e 'setInterval(() => {}, 1000)'",
      cwd: tempDir,
    });

    const started = await client.startService("sleeper");
    expect(started.name).toBe("sleeper");
    expect(["starting", "running"]).toContain(started.state);
    const status = await client.status();
    expect(status.services.sleeper).toBeDefined();

    const stopped = await client.stopService("sleeper");
    expect(stopped.state).toBe("stopped");
  });

  test("shutdown stops services and invokes the daemon shutdown hook", async () => {
    let hookCalled: () => void = () => {};
    const hookFired = new Promise<void>((resolveHook) => {
      hookCalled = resolveHook;
    });
    const client = await startServer({ onDaemonShutdown: () => hookCalled() });

    await client.shutdown();

    await expect(hookFired).resolves.toBeUndefined();
  });
});
