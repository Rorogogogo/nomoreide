import type { CpuInfo } from "node:os";
import { describe, expect, test } from "vitest";
import {
  calculateCpuPercent,
  HostMetricsCollector,
  summarizeCpuTimes,
  type HostMetricsReader,
} from "../src/core/host-metrics.js";

function cpu(idle: number, busy: number): CpuInfo {
  return {
    model: "test",
    speed: 1,
    times: { user: busy, nice: 0, sys: 0, idle, irq: 0 },
  };
}

describe("host metrics", () => {
  test("calculates CPU usage from consecutive aggregate tick snapshots", () => {
    const previous = summarizeCpuTimes([cpu(80, 20), cpu(70, 30)]);
    const current = summarizeCpuTimes([cpu(150, 50), cpu(130, 70)]);

    expect(calculateCpuPercent(undefined, previous)).toBeNull();
    expect(calculateCpuPercent(previous, current)).toBe(35);
  });

  test("normalizes memory, load, uptime, CPU count, and disk usage", async () => {
    const snapshots = [[cpu(80, 20)], [cpu(150, 50)]];
    const reader: HostMetricsReader = {
      cpuInfo: () => snapshots.shift() ?? [],
      diskUsage: async (path) => ({
        path,
        totalBytes: 1_000,
        usedBytes: 750,
        availableBytes: 200,
        usedPercent: 75,
      }),
      freeMemoryBytes: () => 250,
      loadAverage: () => [0.5, 0.25, 0.1],
      totalMemoryBytes: () => 1_000,
      uptimeSeconds: () => 90,
    };
    const collector = new HostMetricsCollector("/workspace", reader);

    const first = await collector.sample(100);
    const second = await collector.sample(200);

    expect(first.cpuPercent).toBeNull();
    expect(second).toMatchObject({
      t: 200,
      cpuPercent: 30,
      memoryUsedBytes: 750,
      memoryTotalBytes: 1_000,
      memoryUsedPercent: 75,
      loadAverage: [0.5, 0.25, 0.1],
      uptimeSeconds: 90,
      logicalCpuCount: 1,
      disk: { path: "/workspace", usedPercent: 75 },
    });
  });

  test("keeps host samples available when disk statistics fail", async () => {
    const reader: HostMetricsReader = {
      cpuInfo: () => [cpu(80, 20)],
      diskUsage: async () => {
        throw new Error("unsupported");
      },
      freeMemoryBytes: () => 40,
      loadAverage: () => null,
      totalMemoryBytes: () => 100,
      uptimeSeconds: () => 5,
    };

    await expect(new HostMetricsCollector(".", reader).sample(1)).resolves.toMatchObject({
      memoryUsedPercent: 60,
      loadAverage: null,
      disk: null,
    });
  });
});
