import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ConfigStore } from "../src/core/config-store.js";
import { ErrorInbox } from "../src/core/error-inbox.js";
import { LogStore } from "../src/core/log-store.js";
import { TimelineStore } from "../src/core/timeline-store.js";
import {
  WorkflowTriggerManager,
  type CiFailureSnapshot,
  type WorkflowTrigger,
} from "../src/core/workflow-triggers.js";

let tempDir: string;
let logs: LogStore;
let configStore: ConfigStore;
let errorInbox: ErrorInbox;
let timelineStore: TimelineStore;
let manager: WorkflowTriggerManager;
let clock: number;

const baseTrigger: WorkflowTrigger = {
  id: "t1",
  workflowId: "commit-push",
  event: "error-incident",
  enabled: true,
  autoRun: false,
};

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "nomoreide-triggers-"));
  logs = new LogStore({ baseDir: tempDir, maxLinesPerService: 100 });
  configStore = new ConfigStore(join(tempDir, "config.json"));
  errorInbox = new ErrorInbox({ logStore: logs, configStore, cwd: tempDir });
  timelineStore = new TimelineStore({ baseDir: tempDir });
  clock = 1_000;
  manager = new WorkflowTriggerManager({
    configStore,
    errorInbox,
    timelineStore,
    now: () => clock,
  });
  manager.start();
});

afterEach(async () => {
  manager.stop();
  errorInbox.dispose();
  await rm(tempDir, { recursive: true, force: true });
});

describe("WorkflowTriggerManager", () => {
  test("enqueues a pending run when an error incident matches", async () => {
    await configStore.saveWorkflowTrigger(baseTrigger);

    await logs.append("api", "stderr", "Error: connection refused");
    await flush();

    const pending = manager.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      triggerId: "t1",
      workflowId: "commit-push",
      event: "error-incident",
      autoRun: false,
    });
  });

  test("respects the service/message filter", async () => {
    await configStore.saveWorkflowTrigger({ ...baseTrigger, filter: "web" });

    await logs.append("api", "stderr", "Error: boom");
    await flush();

    expect(manager.listPending()).toHaveLength(0);
  });

  test("ignores disabled triggers", async () => {
    await configStore.saveWorkflowTrigger({ ...baseTrigger, enabled: false });

    await logs.append("api", "stderr", "Error: boom");
    await flush();

    expect(manager.listPending()).toHaveLength(0);
  });

  test("fires on a service crash from the timeline", async () => {
    await configStore.saveWorkflowTrigger({
      ...baseTrigger,
      id: "crash",
      event: "service-crash",
    });

    await timelineStore.append({
      kind: "service.lifecycle",
      service: "api",
      severity: "error",
      title: "api exited",
    });
    await flush();

    expect(manager.listPending()).toHaveLength(1);
    expect(manager.listPending()[0]).toMatchObject({ event: "service-crash" });
  });

  test("does not fire on a clean (info) lifecycle event", async () => {
    await configStore.saveWorkflowTrigger({
      ...baseTrigger,
      id: "crash",
      event: "service-crash",
    });

    await timelineStore.append({
      kind: "service.lifecycle",
      service: "api",
      severity: "info",
      title: "api stopped",
    });
    await flush();

    expect(manager.listPending()).toHaveLength(0);
  });

  test("dedupes a burst within the window, then re-fires after it", async () => {
    await configStore.saveWorkflowTrigger({
      ...baseTrigger,
      id: "crash",
      event: "service-crash",
    });

    await crash();
    await crash(); // same signature, same window → collapsed
    expect(manager.listPending()).toHaveLength(1);

    clock += 60_000; // past the 30s default window
    await crash();
    expect(manager.listPending()).toHaveLength(2);
  });

  test("ackPending removes a queued run", async () => {
    await configStore.saveWorkflowTrigger(baseTrigger);
    await logs.append("api", "stderr", "Error: boom");
    await flush();

    const [run] = manager.listPending();
    expect(manager.ackPending(run.id)).toBe(true);
    expect(manager.listPending()).toHaveLength(0);
  });
});

describe("WorkflowTriggerManager — ci-failure source", () => {
  let snapshot: CiFailureSnapshot | null;
  let pollCount: number;
  let ciManager: WorkflowTriggerManager;

  beforeEach(() => {
    snapshot = null;
    pollCount = 0;
    ciManager = new WorkflowTriggerManager({
      configStore,
      errorInbox,
      timelineStore,
      now: () => clock,
      ciPollIntervalMs: 0, // no internal timer; tests drive pollCiOnce()
      ciSource: async () => {
        pollCount += 1;
        return snapshot;
      },
    });
    ciManager.start();
  });

  afterEach(() => {
    ciManager.stop();
  });

  test("skips the CI fetch entirely when no ci-failure trigger is enabled", async () => {
    await ciManager.pollCiOnce();
    expect(pollCount).toBe(0);
    expect(ciManager.listPending()).toHaveLength(0);
  });

  test("enqueues when the current branch CI is failing", async () => {
    await configStore.saveWorkflowTrigger({
      ...baseTrigger,
      id: "ci",
      event: "ci-failure",
    });
    snapshot = { sha: "abc123", branch: "main", failingChecks: ["build", "lint"] };

    await ciManager.pollCiOnce();

    const pending = ciManager.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ event: "ci-failure", triggerId: "ci" });
    expect(pending[0]!.summary).toContain("build, lint");
  });

  test("does not enqueue when CI is green (source returns null)", async () => {
    await configStore.saveWorkflowTrigger({
      ...baseTrigger,
      id: "ci",
      event: "ci-failure",
    });
    snapshot = null;

    await ciManager.pollCiOnce();
    expect(ciManager.listPending()).toHaveLength(0);
  });

  test("fires once per failing commit, even across many polls", async () => {
    await configStore.saveWorkflowTrigger({
      ...baseTrigger,
      id: "ci",
      event: "ci-failure",
    });
    snapshot = { sha: "abc123", branch: "main", failingChecks: ["build"] };

    await ciManager.pollCiOnce();
    clock += 5 * 60_000; // well past the dedupe window
    await ciManager.pollCiOnce();
    expect(ciManager.listPending()).toHaveLength(1);

    // A new failing commit is a fresh signature → fires again.
    snapshot = { sha: "def456", branch: "main", failingChecks: ["build"] };
    await ciManager.pollCiOnce();
    expect(ciManager.listPending()).toHaveLength(2);
  });
});

async function crash(): Promise<void> {
  await timelineStore.append({
    kind: "service.lifecycle",
    service: "api",
    severity: "error",
    title: "api exited",
  });
  await flush();
}

/** Let the async trigger handlers (configStore.load → readFile) settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
