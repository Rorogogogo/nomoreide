import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ConfigStore } from "../src/core/config-store.js";
import { ErrorInbox } from "../src/core/error-inbox.js";
import { LogStore } from "../src/core/log-store.js";
import { type TestRun, TestRunner } from "../src/core/test-runner.js";

let tempDir: string;
let logs: LogStore;
let configStore: ConfigStore;
let runner: TestRunner;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "nomoreide-test-runner-"));
  logs = new LogStore({ baseDir: tempDir, maxLinesPerService: 100 });
  configStore = new ConfigStore(join(tempDir, "config.json"));
  runner = new TestRunner({ logStore: logs, configStore, cwd: tempDir });
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

/** Resolve once the run reaches a terminal status. */
function waitForFinish(service: string): Promise<TestRun> {
  return new Promise((resolve) => {
    const current = runner.current(service);
    if (current && current.status !== "running") {
      resolve(current);
      return;
    }
    const unsubscribe = runner.subscribe(service, (event) => {
      if (event.type === "status" && event.run.status !== "running") {
        unsubscribe();
        resolve(event.run);
      }
    });
  });
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

describe("TestRunner", () => {
  test("runs the service's configured test command and reports success", async () => {
    await configStore.registerService({
      name: "api",
      command: "sleep 1",
      cwd: tempDir,
      test: "echo all-good",
    });

    await runner.run("api");
    const run = await waitForFinish("api");

    expect(run.status).toBe("passed");
    expect(run.exitCode).toBe(0);
    expect(run.command).toBe("echo all-good");
  });

  test("marks a non-zero exit as failed and parses the failing count", async () => {
    await configStore.registerService({
      name: "api",
      command: "sleep 1",
      cwd: tempDir,
      test: 'echo "Tests: 2 failed, 3 passed"; exit 1',
    });

    await runner.run("api");
    const run = await waitForFinish("api");

    expect(run.status).toBe("failed");
    expect(run.failingCount).toBe(2);
  });

  test("appends a pattern argument to the command", async () => {
    await configStore.registerService({
      name: "api",
      command: "sleep 1",
      cwd: tempDir,
      test: "echo run",
    });

    const run = await runner.run("api", "config-store");
    expect(run.command).toBe("echo run config-store");
    await waitForFinish("api");
  });

  test("defaults to npm test when no test command is configured", async () => {
    await configStore.registerService({ name: "api", command: "sleep 1", cwd: tempDir });
    const run = await runner.run("api");
    expect(run.command).toBe("npm test");
    await waitForFinish("api");
  });

  test("rejects a concurrent run for the same service", async () => {
    await configStore.registerService({
      name: "api",
      command: "sleep 1",
      cwd: tempDir,
      test: "sleep 0.3",
    });

    await runner.run("api");
    await expect(runner.run("api")).rejects.toThrow(/already in progress/);
    await waitForFinish("api");
  });

  test("a failing run surfaces an Error Inbox incident on the :test channel", async () => {
    const inbox = new ErrorInbox({ logStore: logs, configStore, cwd: tempDir });
    await configStore.registerService({
      name: "api",
      command: "sleep 1",
      cwd: tempDir,
      test: 'echo "1 failed"; exit 1',
    });

    await runner.run("api");
    await waitForFinish("api");
    await settle();

    const incident = inbox.list().find((item) => item.service === "api:test");
    expect(incident).toBeDefined();
    expect(incident?.level).toBe("error");
    inbox.dispose();
  });
});
