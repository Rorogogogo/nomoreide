import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { appVersion } from "../src/core/app-version.js";
import { ensureDaemon } from "../src/core/daemon-lifecycle.js";

let tempDir: string;
let statePath: string;

// Any file that exists works as the spawn entry — spawning itself is faked.
const entryPath = fileURLToPath(import.meta.url);

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "nomoreide-daemon-lifecycle-"));
  statePath = join(tempDir, "daemon.json");
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function healthResponse(overrides: Record<string, unknown> = {}): Response {
  return Response.json({
    ok: true,
    app: "nomoreide",
    version: appVersion(),
    pid: 4242,
    ...overrides,
  });
}

async function writeState(state: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, JSON.stringify(state), "utf8");
}

describe("ensureDaemon", () => {
  test("reuses the daemon recorded in the state file when alive and healthy", async () => {
    await writeState({ pid: 1234, url: "http://127.0.0.1:9999", port: 9999 });
    const probed: string[] = [];
    const spawned: number[] = [];

    const result = await ensureDaemon({
      statePath,
      port: 4317,
      isPidAlive: () => true,
      fetch: (async (input: URL | RequestInfo) => {
        probed.push(String(input));
        return healthResponse();
      }) as typeof fetch,
      spawnDaemon: (_entry, port) => {
        spawned.push(port);
      },
      entryPath,
    });

    expect(result).toMatchObject({
      status: "already_running",
      url: "http://127.0.0.1:9999",
      port: 9999,
      pid: 4242,
    });
    expect(result.versionWarning).toBeUndefined();
    expect(spawned).toEqual([]);
    expect(probed[0]).toContain("9999");
  });

  test("adopts a healthy daemon on the configured port when state is stale", async () => {
    await writeState({ pid: 1234, url: "http://127.0.0.1:9999", port: 9999 });

    const result = await ensureDaemon({
      statePath,
      port: 4317,
      isPidAlive: () => false, // recorded daemon is dead
      fetch: (async () => healthResponse({ pid: 777 })) as typeof fetch,
      spawnDaemon: () => {
        throw new Error("should not spawn");
      },
      entryPath,
    });

    expect(result).toMatchObject({
      status: "adopted",
      url: "http://127.0.0.1:4317",
      port: 4317,
      pid: 777,
    });
    // Stale state file is cleaned up.
    await expect(readFile(statePath, "utf8")).rejects.toThrow();
  });

  test("spawns a detached daemon and polls until it answers", async () => {
    const spawned: Array<{ entry: string; port: number }> = [];
    let daemonUp = false;

    const result = await ensureDaemon({
      statePath,
      port: 4317,
      pollIntervalMs: 1,
      fetch: (async () => {
        if (!daemonUp) throw new Error("ECONNREFUSED");
        return healthResponse({ pid: 555 });
      }) as typeof fetch,
      spawnDaemon: (entry, port) => {
        spawned.push({ entry, port });
        daemonUp = true;
      },
      entryPath,
    });

    expect(result).toMatchObject({ status: "started", port: 4317, pid: 555 });
    expect(spawned).toEqual([{ entry: entryPath, port: 4317 }]);
  });

  test("adopts the winner of a spawn race via the same health poll", async () => {
    // Our spawn "loses": the spawned process does nothing, but a concurrent
    // session's daemon comes up on the port a few polls later.
    let polls = 0;

    const result = await ensureDaemon({
      statePath,
      port: 4317,
      pollIntervalMs: 1,
      fetch: (async () => {
        polls += 1;
        if (polls < 3) throw new Error("ECONNREFUSED");
        return healthResponse({ pid: 999 });
      }) as typeof fetch,
      spawnDaemon: () => {},
      entryPath,
    });

    expect(result).toMatchObject({ status: "started", pid: 999 });
  });

  test("fails clearly when a foreign process holds the daemon port", async () => {
    await expect(
      ensureDaemon({
        statePath,
        port: 4317,
        fetch: (async () => Response.json({ hello: "world" })) as typeof fetch,
        spawnDaemon: () => {
          throw new Error("should not spawn");
        },
        entryPath,
      }),
    ).rejects.toThrow(/not a NoMoreIDE daemon.*NOMOREIDE_DAEMON_PORT/s);
  });

  test("warns on version skew without killing the running daemon", async () => {
    const result = await ensureDaemon({
      statePath,
      port: 4317,
      fetch: (async () => healthResponse({ version: "0.0.1" })) as typeof fetch,
      spawnDaemon: () => {
        throw new Error("should not spawn");
      },
      entryPath,
    });

    expect(result.status).toBe("adopted");
    expect(result.versionWarning).toContain("0.0.1");
    expect(result.versionWarning).toContain("nomoreide daemon restart");
  });

  test("times out with a helpful error when the spawned daemon never answers", async () => {
    await expect(
      ensureDaemon({
        statePath,
        port: 4317,
        pollTimeoutMs: 20,
        pollIntervalMs: 1,
        fetch: (async () => {
          throw new Error("ECONNREFUSED");
        }) as typeof fetch,
        spawnDaemon: () => {},
        entryPath,
      }),
    ).rejects.toThrow(/did not become healthy/);
  });
});
