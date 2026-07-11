import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  defaultRuntimeRegistryPath,
  isPidAlive,
  ServiceRegistry,
  type ServiceRegistryEntry,
} from "../src/core/service-registry.js";

let tempDir: string;
let registry: ServiceRegistry;
let registryPath: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "nomoreide-registry-"));
  registryPath = join(tempDir, "runtime.json");
  registry = new ServiceRegistry(registryPath);
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function entry(overrides: Partial<ServiceRegistryEntry> = {}): ServiceRegistryEntry {
  return {
    name: "api",
    pid: process.pid, // a live pid so liveness checks pass
    pgid: process.pid,
    kind: "local",
    startedAt: new Date().toISOString(),
    ownerPid: process.pid,
    ...overrides,
  };
}

describe("ServiceRegistry", () => {
  test("records and reads back a live entry", () => {
    registry.record(entry({ name: "api", port: 3000 }));

    const found = registry.get("api");
    expect(found).toMatchObject({ name: "api", port: 3000, pid: process.pid });
    expect(registry.list().map((item) => item.name)).toEqual(["api"]);
  });

  test("hides and prunes entries whose pid is dead", async () => {
    const deadPid = await aDeadPid();
    registry.record(entry({ name: "ghost", pid: deadPid, pgid: deadPid }));

    expect(registry.get("ghost")).toBeNull();
    expect(registry.list()).toEqual([]);

    // The next mutation drops the stale entry from disk entirely.
    registry.record(entry({ name: "api" }));
    const onDisk = JSON.parse(await readFile(registryPath, "utf8"));
    expect(Object.keys(onDisk)).toEqual(["api"]);
  });

  test("update patches an existing entry", () => {
    registry.record(entry({ name: "api" }));
    registry.update("api", { url: "http://localhost:3000/" });
    expect(registry.get("api")?.url).toBe("http://localhost:3000/");
  });

  test("remove deletes a single entry", () => {
    registry.record(entry({ name: "api" }));
    registry.record(entry({ name: "web" }));
    registry.remove("api");
    expect(registry.list().map((item) => item.name)).toEqual(["web"]);
  });

  test("removeOwnedBy clears only the given owner's entries", () => {
    registry.record(entry({ name: "api", ownerPid: process.pid }));
    registry.record(entry({ name: "web", ownerPid: 999999 }));
    registry.removeOwnedBy(process.pid);
    expect(registry.list().map((item) => item.name)).toEqual(["web"]);
  });

  test("survives a corrupt registry file", async () => {
    await writeFile(registryPath, "{ not json");
    expect(registry.list()).toEqual([]);
    registry.record(entry({ name: "api" }));
    expect(registry.get("api")).not.toBeNull();
  });

  test("defaultRuntimeRegistryPath is machine-global, not cwd-relative", () => {
    expect(defaultRuntimeRegistryPath()).toBe(
      join(homedir(), ".nomoreide", "runtime.json"),
    );
  });

  test("isPidAlive reflects the current process and rejects bogus pids", () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
  });
});

/** Spawn-and-reap a short-lived process to obtain a pid guaranteed to be dead. */
async function aDeadPid(): Promise<number> {
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = child.pid ?? 1;
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  // Give the OS a moment to reap so process.kill(pid, 0) reports ESRCH.
  for (let i = 0; i < 50 && isPidAlive(pid); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return pid;
}
