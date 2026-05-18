import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ConfigStore } from "../src/core/config-store.js";
import { LogStore } from "../src/core/log-store.js";
import { ProcessManager } from "../src/core/process-manager.js";
import { TimelineStore } from "../src/core/timeline-store.js";

let tempDir: string;
let manager: ProcessManager;
let logs: LogStore;
let config: ConfigStore;
let timeline: TimelineStore;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "nomoreide-process-"));
  config = new ConfigStore(join(tempDir, "nomoreide.config.json"));
  timeline = new TimelineStore({ baseDir: join(tempDir, "timeline") });
  logs = new LogStore({ baseDir: join(tempDir, "logs") });
  manager = new ProcessManager({
    configStore: config,
    logStore: logs,
    stopTimeoutMs: 50,
    timelineStore: timeline,
  });
});

afterEach(async () => {
  await manager.stopAll();
  await rm(tempDir, { recursive: true, force: true });
});

describe("ProcessManager", () => {
  test("starts a registered service and captures stdout", async () => {
    await config.registerService({
      name: "backend",
      command: nodeCommand("console.log('backend-ready'); setInterval(() => {}, 1000);"),
      cwd: tempDir,
    });

    const status = await manager.startService("backend");

    expect(status.state).toBe("running");
    expect(status.pid).toEqual(expect.any(Number));
    await waitFor(() =>
      logs.read("backend").some((entry) => entry.text.includes("backend-ready")),
    );
  });

  test("detects local URLs from service output", async () => {
    await config.registerService({
      name: "frontend",
      command: nodeCommand(
        "console.log('  ➜  Local:   http://localhost:5174/'); setInterval(() => {}, 1000);",
      ),
      cwd: tempDir,
    });

    await manager.startService("frontend");
    await waitFor(() => manager.status().services.frontend.url === "http://localhost:5174/");

    expect(manager.status().services.frontend.url).toBe("http://localhost:5174/");
  });

  test("records lifecycle and detected URL events in the debug timeline", async () => {
    await config.registerService({
      name: "frontend",
      command: nodeCommand(
        "console.log('Local: http://localhost:5180/'); setInterval(() => {}, 1000);",
      ),
      cwd: tempDir,
    });

    await manager.startService("frontend");
    await waitFor(() =>
      timeline
        .read()
        .some((event) => event.kind === "service.port" && event.service === "frontend"),
    );

    expect(timeline.read()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "service.lifecycle",
          service: "frontend",
          severity: "info",
          title: "frontend started",
        }),
        expect.objectContaining({
          kind: "service.port",
          service: "frontend",
          severity: "info",
          title: "frontend reported http://localhost:5180/",
        }),
      ]),
    );
  });

  test("stops a running service", async () => {
    await config.registerService({
      name: "worker",
      command: nodeCommand("setInterval(() => {}, 1000);"),
      cwd: tempDir,
    });

    await manager.startService("worker");
    const status = await manager.stopService("worker");

    expect(status.state).toBe("stopped");
    expect(manager.status().services.worker.state).toBe("stopped");
  });

  test("includes process tree resources for running services", async () => {
    await config.registerService({
      name: "worker",
      command: nodeCommand("setInterval(() => {}, 1000);"),
      cwd: tempDir,
    });

    const started = await manager.startService("worker");
    const status = await manager.statusWithResources();

    expect(status.services.worker.processTree).toMatchObject({
      rootPid: started.pid,
      processCount: expect.any(Number),
      cpuPercent: expect.any(Number),
      rssMb: expect.any(Number),
    });
    expect(status.services.worker.processTree?.processCount).toBeGreaterThan(0);
  });

  test("restarts a running service with a new process", async () => {
    await config.registerService({
      name: "api",
      command: nodeCommand("setInterval(() => {}, 1000);"),
      cwd: tempDir,
    });

    const first = await manager.startService("api");
    const second = await manager.restartService("api");

    expect(second.state).toBe("running");
    expect(second.pid).not.toBe(first.pid);
  });

  test("starts every service in a bundle", async () => {
    await config.registerService({
      name: "backend",
      command: nodeCommand("setInterval(() => {}, 1000);"),
      cwd: tempDir,
    });
    await config.registerService({
      name: "frontend",
      command: nodeCommand("setInterval(() => {}, 1000);"),
      cwd: tempDir,
    });
    await config.registerBundle({
      name: "full-stack",
      services: ["backend", "frontend"],
    });

    const statuses = await manager.startBundle("full-stack");

    expect(statuses.map((status) => status.name).sort()).toEqual([
      "backend",
      "frontend",
    ]);
    expect(manager.status().services.backend.state).toBe("running");
    expect(manager.status().services.frontend.state).toBe("running");
  });

  test("restarts every service in a bundle", async () => {
    await config.registerService({
      name: "backend",
      command: nodeCommand("setInterval(() => {}, 1000);"),
      cwd: tempDir,
    });
    await config.registerService({
      name: "frontend",
      command: nodeCommand("setInterval(() => {}, 1000);"),
      cwd: tempDir,
    });
    await config.registerBundle({
      name: "full-stack",
      services: ["backend", "frontend"],
    });

    const firstStatuses = await manager.startBundle("full-stack");
    const restartedStatuses = await manager.restartBundle("full-stack");

    expect(restartedStatuses.map((status) => status.name).sort()).toEqual([
      "backend",
      "frontend",
    ]);
    expect(restartedStatuses.map((status) => status.pid)).not.toEqual(
      firstStatuses.map((status) => status.pid),
    );
    expect(manager.status().services.backend.state).toBe("running");
    expect(manager.status().services.frontend.state).toBe("running");
  });
});

function nodeCommand(script: string): string {
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < 1000) {
    if (predicate()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error("Timed out waiting for condition");
}
