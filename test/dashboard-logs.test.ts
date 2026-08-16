import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ConfigStore } from "../src/core/config-store.js";
import { LogStore } from "../src/core/log-store.js";
import { ProcessManager } from "../src/core/process-manager.js";
import { TimelineStore } from "../src/core/timeline-store.js";
import type { LogEntry } from "../src/core/types.js";
import { buildDashboardPayload, mergeServiceLogs } from "../src/web/dashboard.js";

/**
 * The Logs panel's source.
 *
 * It used to be `config.services[0]`, which is registration order — arbitrary,
 * and on a real machine (nineteen services registered, two running) it pinned
 * the panel to a service that had never started. Fixing that to "whoever spoke
 * last" then hid the *other* running service, because two of them booted 200ms
 * apart. The payload now carries every service, and the panel tabs between them.
 */

function line(service: string, timestamp: string, text = "x"): LogEntry {
  return { service, stream: "stdout", text, timestamp };
}

describe("mergeServiceLogs", () => {
  test("carries every service, not just one", () => {
    const logs = new Map([
      ["alpha", [line("alpha", "2026-08-16T10:00:00.000Z")]],
      ["beta", [line("beta", "2026-08-16T12:00:00.000Z")]],
    ]);

    expect(new Set(mergeServiceLogs(logs).map((entry) => entry.service))).toEqual(
      new Set(["alpha", "beta"]),
    );
  });

  test("interleaves chronologically so a reader can follow the sequence", () => {
    const logs = new Map([
      [
        "alpha",
        [
          line("alpha", "2026-08-16T10:00:00.000Z", "a1"),
          line("alpha", "2026-08-16T10:00:02.000Z", "a2"),
        ],
      ],
      ["beta", [line("beta", "2026-08-16T10:00:01.000Z", "b1")]],
    ]);

    expect(mergeServiceLogs(logs).map((entry) => entry.text)).toEqual(["a1", "b1", "a2"]);
  });

  test("keeps a service's own lines in order when a burst shares a millisecond", () => {
    const at = "2026-08-16T10:00:00.000Z";
    const logs = new Map([
      ["alpha", [line("alpha", at, "first"), line("alpha", at, "second"), line("alpha", at, "third")]],
    ]);

    expect(mergeServiceLogs(logs).map((entry) => entry.text)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });

  test("does not let a silent service contribute anything", () => {
    const logs = new Map([
      ["never-started", []],
      ["running", [line("running", "2026-08-16T09:00:00.000Z")]],
    ]);

    expect(mergeServiceLogs(logs).map((entry) => entry.service)).toEqual(["running"]);
  });

  test("caps each service's contribution so one chatty service cannot crowd out another", () => {
    const chatty = Array.from({ length: 200 }, (_, index) =>
      line("chatty", `2026-08-16T10:${String(index % 60).padStart(2, "0")}:00.000Z`),
    );
    const logs = new Map([
      ["chatty", chatty],
      ["quiet", [line("quiet", "2026-08-16T09:00:00.000Z")]],
    ]);

    const merged = mergeServiceLogs(logs);
    expect(merged.filter((entry) => entry.service === "chatty")).toHaveLength(40);
    expect(merged.filter((entry) => entry.service === "quiet")).toHaveLength(1);
  });

  test("is empty when nothing has logged, so the panel shows its empty state", () => {
    expect(mergeServiceLogs(new Map([["a", []], ["b", []]]))).toEqual([]);
  });

  test("is empty when no services are registered at all", () => {
    expect(mergeServiceLogs(new Map())).toEqual([]);
  });

  test("orders across a date boundary chronologically", () => {
    // Lexical string comparison is only safe because LogStore writes every
    // timestamp with toISOString() — same width, same UTC offset.
    const logs = new Map([
      ["today", [line("today", "2026-08-16T00:00:00.000Z")]],
      ["yesterday", [line("yesterday", "2026-08-15T23:59:59.000Z")]],
    ]);

    expect(mergeServiceLogs(logs).map((entry) => entry.service)).toEqual(["yesterday", "today"]);
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

  test("carries a talking service even when the first-registered one is silent", async () => {
    // Registration order is the original trap: `quiet` is services[0].
    await configStore.registerService({ name: "quiet", command: "true", cwd: tempDir });
    await configStore.registerService({ name: "chatty", command: "true", cwd: tempDir });
    await logStore.append("chatty", "stdout", "listening on :5174");

    const payload = await build();

    expect(payload.logs.map((entry) => entry.text)).toEqual(["listening on :5174"]);
  });

  test("carries both services when both are running", async () => {
    await configStore.registerService({ name: "web", command: "true", cwd: tempDir });
    await configStore.registerService({ name: "api", command: "true", cwd: tempDir });
    await logStore.append("web", "stdout", "web up");
    await logStore.append("api", "stdout", "api up");

    const payload = await build();

    expect(new Set(payload.logs.map((entry) => entry.service))).toEqual(new Set(["web", "api"]));
  });

  test("keeps a service visible after another one speaks later", async () => {
    await configStore.registerService({ name: "alpha", command: "true", cwd: tempDir });
    await configStore.registerService({ name: "beta", command: "true", cwd: tempDir });

    await logStore.append("alpha", "stdout", "alpha up");
    await logStore.append("beta", "stderr", "beta crashed");

    const payload = await build();

    // The bug this replaced: beta speaking last made alpha disappear entirely.
    expect(payload.logs.map((entry) => entry.service)).toEqual(["alpha", "beta"]);
  });

  test("is empty when no service has logged yet", async () => {
    await configStore.registerService({ name: "quiet", command: "true", cwd: tempDir });

    expect((await build()).logs).toEqual([]);
  });
});
