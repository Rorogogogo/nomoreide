import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ConfigStore } from "../src/core/config-store.js";
import { LogStore } from "../src/core/log-store.js";
import { ProcessManager } from "../src/core/process-manager.js";
import { TimelineStore } from "../src/core/timeline-store.js";
import type { LogEntry } from "../src/core/types.js";
import { buildDashboardPayload, mostRecentServiceLogs } from "../src/web/dashboard.js";

/**
 * The Output panel's source rule.
 *
 * It used to be `config.services[0]`, which is registration order — arbitrary,
 * and on a real machine (nineteen services registered, two running) it pinned
 * the panel to a service that had never started while two others were talking.
 * These cover the rule that replaced it: whoever spoke last wins.
 */

function line(service: string, timestamp: string, text = "x"): LogEntry {
  return { service, stream: "stdout", text, timestamp };
}

describe("mostRecentServiceLogs", () => {
  test("picks the service whose last line is newest, not the first registered", () => {
    const logs = new Map([
      ["registered-first", [line("registered-first", "2026-08-16T10:00:00.000Z")]],
      ["spoke-last", [line("spoke-last", "2026-08-16T12:00:00.000Z")]],
    ]);

    expect(mostRecentServiceLogs(logs).map((entry) => entry.service)).toEqual(["spoke-last"]);
  });

  test("skips services with empty buffers rather than picking one", () => {
    const logs = new Map([
      ["never-started", []],
      ["running", [line("running", "2026-08-16T09:00:00.000Z")]],
    ]);

    expect(mostRecentServiceLogs(logs).map((entry) => entry.service)).toEqual(["running"]);
  });

  test("returns the whole tail of the winner, in order", () => {
    const logs = new Map([
      ["quiet", [line("quiet", "2026-08-16T08:00:00.000Z")]],
      [
        "loud",
        [
          line("loud", "2026-08-16T11:00:00.000Z", "first"),
          line("loud", "2026-08-16T11:00:01.000Z", "second"),
        ],
      ],
    ]);

    expect(mostRecentServiceLogs(logs).map((entry) => entry.text)).toEqual(["first", "second"]);
  });

  test("is empty when nothing has logged, so the panel shows its empty state", () => {
    expect(mostRecentServiceLogs(new Map([["a", []], ["b", []]]))).toEqual([]);
  });

  test("is empty when no services are registered at all", () => {
    expect(mostRecentServiceLogs(new Map())).toEqual([]);
  });

  test("compares timestamps chronologically across a date boundary", () => {
    // Lexical string comparison is only safe because LogStore writes every
    // timestamp with toISOString() — same width, same UTC offset.
    const logs = new Map([
      ["yesterday", [line("yesterday", "2026-08-15T23:59:59.000Z")]],
      ["today", [line("today", "2026-08-16T00:00:00.000Z")]],
    ]);

    expect(mostRecentServiceLogs(logs).map((entry) => entry.service)).toEqual(["today"]);
  });
});

/**
 * The wiring, not just the rule. The bug was never in a helper — it was in which
 * service `buildDashboardPayload` handed to the panel, so the seam is worth a
 * test of its own.
 */
describe("buildDashboardPayload logs", () => {
  let tempDir: string;
  let configStore: ConfigStore;
  let logStore: LogStore;
  let manager: ProcessManager;
  let timelineStore: TimelineStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "nomoreide-dashboard-logs-"));
    configStore = new ConfigStore(join(tempDir, "nomoreide.config.json"));
    timelineStore = new TimelineStore({ baseDir: join(tempDir, "timeline") });
    logStore = new LogStore({ baseDir: join(tempDir, "logs") });
    manager = new ProcessManager({
      configStore,
      logStore,
      stopTimeoutMs: 50,
      timelineStore,
    });
  });

  afterEach(async () => {
    await manager.stopAll();
    await rm(tempDir, { recursive: true, force: true });
  });

  async function build() {
    return await buildDashboardPayload({
      configStore,
      cwd: tempDir,
      logStore,
      manager,
      timelineStore,
    });
  }

  test("carries the talking service's tail, not the silent first-registered one", async () => {
    // Registration order is the trap: `quiet` is services[0] and never speaks.
    await configStore.registerService({ name: "quiet", command: "true", cwd: tempDir });
    await configStore.registerService({ name: "chatty", command: "true", cwd: tempDir });
    await logStore.append("chatty", "stdout", "listening on :5174");

    const payload = await build();

    expect(payload.logs.map((entry) => entry.text)).toEqual(["listening on :5174"]);
    expect(payload.logs.every((entry) => entry.service === "chatty")).toBe(true);
  });

  test("follows whichever service spoke last as output arrives", async () => {
    await configStore.registerService({ name: "alpha", command: "true", cwd: tempDir });
    await configStore.registerService({ name: "beta", command: "true", cwd: tempDir });

    await logStore.append("alpha", "stdout", "alpha up");
    expect((await build()).logs.at(-1)?.service).toBe("alpha");

    await logStore.append("beta", "stderr", "beta crashed");
    expect((await build()).logs.at(-1)?.service).toBe("beta");
  });

  test("is empty when no service has logged yet", async () => {
    await configStore.registerService({ name: "quiet", command: "true", cwd: tempDir });

    expect((await build()).logs).toEqual([]);
  });
});
