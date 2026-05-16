import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { LogStore } from "../src/core/log-store.js";

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
});
