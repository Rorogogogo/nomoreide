import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { computeRuntimeEnvStatus } from "../src/core/env-runtime.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "nomoreide-env-runtime-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

/** Write `.env` and stamp its mtime to a fixed instant. */
async function writeEnvAt(content: string, atMs: number): Promise<void> {
  const path = join(tempDir, ".env");
  await writeFile(path, content);
  await utimes(path, new Date(atMs), new Date(atMs));
}

describe("computeRuntimeEnvStatus", () => {
  test("not stale when the service is not running", async () => {
    await writeEnvAt("A=1\n", Date.now());
    const status = await computeRuntimeEnvStatus({
      cwd: tempDir,
      running: false,
      startedAt: new Date().toISOString(),
    });
    expect(status.stale).toBe(false);
    expect(status.staleFiles).toHaveLength(0);
  });

  test("not stale without a startedAt timestamp", async () => {
    await writeEnvAt("A=1\n", Date.now());
    const status = await computeRuntimeEnvStatus({ cwd: tempDir, running: true });
    expect(status.stale).toBe(false);
  });

  test("flags a config file edited after the service started", async () => {
    const started = Date.now() - 60_000;
    await writeEnvAt("A=2\n", started + 30_000); // edited 30s after start
    const status = await computeRuntimeEnvStatus({
      cwd: tempDir,
      running: true,
      startedAt: new Date(started).toISOString(),
    });
    expect(status.stale).toBe(true);
    expect(status.staleFiles).toHaveLength(1);
    expect(status.staleFiles[0].relativePath).toBe(".env");
    expect(status.staleFiles[0].format).toBe("env");
  });

  test("does not flag a config file last edited before the service started", async () => {
    const started = Date.now();
    await writeEnvAt("A=1\n", started - 60_000); // edited a minute before start
    const status = await computeRuntimeEnvStatus({
      cwd: tempDir,
      running: true,
      startedAt: new Date(started).toISOString(),
    });
    expect(status.stale).toBe(false);
    expect(status.staleFiles).toHaveLength(0);
  });
});
