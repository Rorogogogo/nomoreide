import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { LogStore } from "../src/core/log-store.js";
import { TimelineStore } from "../src/core/timeline-store.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "nomoreide-logs-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("LogStore", () => {
  test("keeps only the configured number of recent in-memory lines", async () => {
    const logs = new LogStore({ baseDir: tempDir, maxLinesPerService: 2 });

    await logs.append("backend", "stdout", "one");
    await logs.append("backend", "stderr", "two");
    await logs.append("backend", "stdout", "three");

    expect(logs.read("backend")).toMatchObject([
      { stream: "stderr", text: "two" },
      { stream: "stdout", text: "three" },
    ]);
  });

  test("persists appended logs to a service log file", async () => {
    const logs = new LogStore({ baseDir: tempDir, maxLinesPerService: 10 });

    await logs.append("api/server", "stdout", "ready");

    const file = await readFile(join(tempDir, "api_server.log"), "utf8");
    const [entry] = file.trim().split("\n").map((line) => JSON.parse(line));

    expect(entry).toMatchObject({
      service: "api/server",
      stream: "stdout",
      text: "ready",
    });
    expect(entry.timestamp).toEqual(expect.any(String));
  });

  test("records stderr logs in the debug timeline", async () => {
    const timeline = new TimelineStore({
      baseDir: join(tempDir, "timeline"),
    });
    const logs = new LogStore({
      baseDir: tempDir,
      maxLinesPerService: 10,
      timelineStore: timeline,
    });

    await logs.append("api", "stderr", "Error: failed to start");

    expect(timeline.read()).toContainEqual(
      expect.objectContaining({
        kind: "service.log",
        service: "api",
        severity: "error",
        title: "api stderr",
        detail: "Error: failed to start",
      }),
    );
  });

  test("does not flag benign stderr cargo build output as a timeline event", async () => {
    const timeline = new TimelineStore({
      baseDir: join(tempDir, "timeline"),
    });
    const logs = new LogStore({
      baseDir: tempDir,
      maxLinesPerService: 10,
      timelineStore: timeline,
    });

    await logs.append("api", "stderr", "Finished `dev` profile [unoptimized + debuginfo] target(s)");
    await logs.append("api", "stderr", "Running `target/debug/api`");

    expect(timeline.read()).toHaveLength(0);
  });

  test("records stdout readiness lines as info timeline events", async () => {
    const timeline = new TimelineStore({
      baseDir: join(tempDir, "timeline"),
    });
    const logs = new LogStore({
      baseDir: tempDir,
      maxLinesPerService: 10,
      timelineStore: timeline,
    });

    await logs.append("frontend", "stdout", "VITE v8.0.3 ready in 126 ms");

    expect(timeline.read()).toContainEqual(
      expect.objectContaining({
        service: "frontend",
        severity: "info",
      }),
    );
  });
});
