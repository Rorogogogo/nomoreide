import { describe, expect, test } from "vitest";
import { MetricsStore } from "../src/core/metrics-store.js";
import type { ProcessManager } from "../src/core/process-manager.js";
import type { ProcessTreeSummary } from "../src/core/process-tree.js";
import type { ServiceStatus } from "../src/core/types.js";

const hostSample = {
  t: 100,
  cpuPercent: 20,
  memoryUsedBytes: 40,
  memoryTotalBytes: 100,
  memoryUsedPercent: 40,
  loadAverage: [0.1, 0.2, 0.3] as [number, number, number],
  uptimeSeconds: 10,
  logicalCpuCount: 4,
  disk: null,
};

describe("metrics store activity snapshots", () => {
  test("combines bounded host history with current managed-service usage", async () => {
    let now = 100;
    const status = {
      name: "web",
      state: "running" as const,
      pid: 10,
      startedAt: "2026-01-01T00:00:00.000Z",
    };
    const manager = {
      status: () => ({ services: { web: status } }),
    } as unknown as ProcessManager;
    const tree: ProcessTreeSummary = {
      rootPid: 10,
      processCount: 3,
      cpuPercent: 12.5,
      rssMb: 256,
      processes: [],
    };
    const store = new MetricsStore({
      capacity: 2,
      hostCollector: {
        sample: async (t) => ({ ...hostSample, t }),
      },
      manager,
      now: () => now++,
      processTreeReader: async () => tree,
      systemProcessReader: async () => [],
      dockerStatsReader: async () => [],
    });

    await store.sampleOnce();
    await store.sampleOnce();
    await store.sampleOnce();

    expect(store.readActivity()).toMatchObject({
      sampleIntervalMs: 3000,
      host: {
        current: { t: 102 },
        samples: [{ t: 101 }, { t: 102 }],
      },
      services: {
        web: {
          service: "web",
          sampledAt: 102,
          cpuPercent: 12.5,
          rssMb: 256,
          processCount: 3,
          source: "local",
        },
      },
    });
    expect(store.read("web").samples).toHaveLength(2);
  });

  test("does not expose a previous run after a service stops or restarts", async () => {
    let current: ServiceStatus = {
      name: "web",
      state: "running",
      pid: 10,
      startedAt: "run-1",
    };
    const manager = {
      status: () => ({ services: { web: current } }),
    } as unknown as ProcessManager;
    const store = new MetricsStore({
      hostCollector: { sample: async () => hostSample },
      manager,
      processTreeReader: async (rootPid) => ({
        rootPid,
        processCount: 1,
        cpuPercent: 1,
        rssMb: 2,
        processes: [],
      }),
      systemProcessReader: async () => [],
      dockerStatsReader: async () => [],
    });

    await store.sampleOnce();
    expect(store.readActivity().services.web).toBeDefined();

    current = { ...current, state: "stopped" };
    expect(store.readActivity().services.web).toBeUndefined();

    current = {
      name: "web",
      state: "running",
      pid: 11,
      startedAt: "run-2",
    };
    expect(store.readActivity().services.web).toBeUndefined();
    await store.sampleOnce();
    expect(store.readActivity().services.web).toMatchObject({
      startedAt: "run-2",
      sampledAt: expect.any(Number),
    });
  });

  test("samples managed Docker Compose services by container ID", async () => {
    const manager = {
      status: () => ({
        services: {
          database: {
            name: "database",
            state: "running",
            kind: "docker-compose",
            containerId: "abc123def456",
            startedAt: "docker-run-1",
          },
        },
      }),
    } as unknown as ProcessManager;
    const store = new MetricsStore({
      hostCollector: { sample: async () => hostSample },
      manager,
      processTreeReader: async () => {
        throw new Error("Docker services must not use the host process reader");
      },
      systemProcessReader: async () => [],
      dockerStatsReader: async () => [
        {
          id: "abc123def456",
          cpuPercent: 4.2,
          memoryPercent: 12.5,
          memoryUsage: "256MiB / 2GiB",
          netIo: "1kB / 2kB",
          blockIo: "0B / 0B",
        },
      ],
      now: () => 200,
    });

    await store.sampleOnce();

    expect(store.readActivity().services.database).toEqual({
      service: "database",
      startedAt: "docker-run-1",
      sampledAt: 200,
      cpuPercent: 4.2,
      rssMb: 256,
      processCount: undefined,
      memoryPercent: 12.5,
      source: "docker",
    });
  });
});
