// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ActivityView } from "../src/web/client/src/features/activity/activity-view";
import type {
  ActivityMetrics,
  DashboardData,
} from "../src/web/client/src/lib/api";

const api = vi.hoisted(() => ({ getActivityMetrics: vi.fn() }));

vi.mock("@/lib/api", () => ({
  getActivityMetrics: api.getActivityMetrics,
}));

const metrics: ActivityMetrics = {
  sampleIntervalMs: 3000,
  host: {
    current: {
      t: new Date("2026-07-27T10:00:00Z").getTime(),
      cpuPercent: 42,
      memoryUsedBytes: 8 * 1024 ** 3,
      memoryTotalBytes: 16 * 1024 ** 3,
      memoryUsedPercent: 50,
      loadAverage: [2, 1.5, 1],
      uptimeSeconds: 3600,
      logicalCpuCount: 8,
      disk: {
        path: "/repo",
        totalBytes: 100 * 1024 ** 3,
        usedBytes: 60 * 1024 ** 3,
        availableBytes: 35 * 1024 ** 3,
        usedPercent: 60,
      },
    },
    samples: [],
  },
  services: {
    frontend: {
      service: "frontend",
      startedAt: "2026-07-27T09:55:00Z",
      sampledAt: new Date("2026-07-27T10:00:00Z").getTime(),
      cpuPercent: 12.5,
      rssMb: 256,
      processCount: 3,
    },
  },
};

const dashboard = {
  config: {
    services: [
      { name: "frontend", kind: "local", description: "Vite" },
      { name: "database", kind: "docker-compose" },
    ],
    bundles: [],
    gitRepositories: [],
  },
  runtime: {
    services: {
      frontend: {
        name: "frontend",
        state: "running",
        startedAt: "2026-07-27T09:55:00Z",
      },
      database: { name: "database", state: "stopped" },
    },
  },
} as unknown as DashboardData;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  api.getActivityMetrics.mockReset().mockResolvedValue(metrics);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
});

describe("Activity Monitor", () => {
  test("shows machine pressure and managed-service consumption", async () => {
    const onOpenService = vi.fn();
    await act(async () => {
      root.render(
        <ActivityView
          data={dashboard}
          onOpenService={onOpenService}
          scopeName={null}
        />,
      );
    });

    expect(container.textContent).toContain("Activity Monitor");
    expect(container.textContent).toContain("42.0%");
    expect(container.textContent).toContain("8.0 GB / 16.0 GB");
    expect(container.textContent).toContain("frontend");
    expect(container.textContent).toContain("12.5%");
    expect(container.textContent).toContain("256.0 MB");
    expect(container.textContent).toContain("database");
    expect(container.textContent).toContain("stopped");
    expect(
      container.querySelector('[title*="Docker monitoring"]'),
    ).not.toBeNull();

    const frontendButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "frontend",
    );
    act(() => frontendButton?.click());
    expect(onOpenService).toHaveBeenCalledWith("frontend");
  });

  test("ignores an older sample that resolves after a newer refresh", async () => {
    vi.useFakeTimers();
    const first = deferred<ActivityMetrics>();
    const second = deferred<ActivityMetrics>();
    api.getActivityMetrics
      .mockReset()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    await act(async () => {
      root.render(
        <ActivityView data={dashboard} onOpenService={vi.fn()} scopeName={null} />,
      );
    });
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });

    await act(async () => {
      second.resolve(withCpu(metrics, 80));
    });
    expect(container.textContent).toContain("80.0%");

    await act(async () => {
      first.resolve(withCpu(metrics, 10));
    });
    expect(container.textContent).toContain("80.0%");
    expect(container.textContent).not.toContain("10.0%");
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function withCpu(value: ActivityMetrics, cpuPercent: number): ActivityMetrics {
  const current = value.host.current;
  if (!current) return value;
  return {
    ...value,
    host: {
      ...value.host,
      current: { ...current, cpuPercent },
    },
  };
}
