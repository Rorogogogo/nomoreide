// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ActivityView } from "../apps/dashboard/src/features/activity/activity-view";
import type {
  ActivityMetrics,
  DashboardData,
} from "../apps/dashboard/src/lib/api";

const api = vi.hoisted(() => ({
  getActivityMetrics: vi.fn(),
  terminateSystemProcess: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  getActivityMetrics: api.getActivityMetrics,
  terminateSystemProcess: api.terminateSystemProcess,
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
      source: "local",
    },
  },
  systemProcesses: [
    {
      pid: 42,
      ppid: 1,
      uid: 501,
      user: "alice",
      cpuPercent: 75,
      rssMb: 512,
      command: "/Applications/Other.app/Contents/MacOS/Other --active",
      canTerminate: true,
    },
    {
      pid: 43,
      ppid: 1,
      uid: 501,
      user: "alice",
      cpuPercent: 35,
      rssMb: 5 * 1024,
      command: "node managed.js",
      managedService: "frontend",
      canTerminate: false,
      protection: "managed",
    },
    {
      pid: 44,
      ppid: 1,
      uid: 501,
      user: "alice",
      cpuPercent: 5,
      rssMb: 12 * 1024,
      command: "alpha-worker",
      canTerminate: true,
    },
  ],
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
let intersectionCallback: IntersectionObserverCallback | null;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  api.getActivityMetrics.mockReset().mockResolvedValue(metrics);
  api.terminateSystemProcess.mockReset().mockResolvedValue(undefined);
  intersectionCallback = null;
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      readonly root = null;
      readonly rootMargin = "300px 0px";
      readonly thresholds = [0];
      constructor(callback: IntersectionObserverCallback) {
        intersectionCallback = callback;
      }
      disconnect() {}
      observe() {}
      takeRecords(): IntersectionObserverEntry[] {
        return [];
      }
      unobserve() {}
    },
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
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
    expect(
      container.querySelector('section[aria-labelledby="activity-system-heading"]'),
    ).toBeNull();
    expect(api.getActivityMetrics).toHaveBeenLastCalledWith({
      includeProcesses: false,
    });
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
    expect(container.textContent).toContain("Energy impact");
    expect(container.textContent).toContain("Low");

    triggerProcessBoundary();
    await vi.waitFor(() => {
      expect(container.textContent).toContain("System processes");
    });
    expect(container.textContent).toContain("System processes");
    expect(container.textContent).toContain("Other");
    expect(container.textContent).toContain("Managed · frontend");
    expect(api.getActivityMetrics).toHaveBeenLastCalledWith({
      includeProcesses: true,
    });
  });

  test("confirms and terminates an external process using its current identity", async () => {
    await act(async () => {
      root.render(
        <ActivityView data={dashboard} onOpenService={vi.fn()} scopeName={null} />,
      );
    });
    triggerProcessBoundary();
    await vi.waitFor(() => {
      expect(container.textContent).toContain("System processes");
    });

    const endButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="End Other, PID 42"]',
    );
    act(() => endButton?.click());
    const confirmButton = [...document.body.querySelectorAll("button")].find(
      (button) => button.textContent === "End process" && button !== endButton,
    );
    await act(async () => confirmButton?.click());

    expect(api.terminateSystemProcess).toHaveBeenCalledWith(
      42,
      "/Applications/Other.app/Contents/MacOS/Other --active",
    );
  });

  test("shows live Docker metrics for a managed Compose service", async () => {
    api.getActivityMetrics.mockResolvedValue({
      ...metrics,
      services: {
        ...metrics.services,
        database: {
          service: "database",
          startedAt: "2026-07-27T09:58:00Z",
          sampledAt: new Date("2026-07-27T10:00:00Z").getTime(),
          cpuPercent: 4.2,
          rssMb: 256,
          memoryPercent: 12.5,
          source: "docker",
        },
      },
    });
    const dockerDashboard = {
      ...dashboard,
      runtime: {
        services: {
          ...dashboard.runtime.services,
          database: {
            name: "database",
            state: "running",
            kind: "docker-compose",
            containerId: "abc123",
            startedAt: "2026-07-27T09:58:00Z",
          },
        },
      },
    } as DashboardData;

    await act(async () => {
      root.render(
        <ActivityView
          data={dockerDashboard}
          onOpenService={vi.fn()}
          scopeName={null}
        />,
      );
    });
    const databaseRow = [...container.querySelectorAll("tbody tr")].find((row) =>
      row.textContent?.includes("database"),
    );
    expect(databaseRow?.textContent).toContain("DOCKER");
    expect(databaseRow?.textContent).toContain("4.2%");
    expect(databaseRow?.textContent).toContain("256.0 MB");
  });

  test("sorts from table headers and colors utilization by pressure", async () => {
    await act(async () => {
      root.render(
        <ActivityView data={dashboard} onOpenService={vi.fn()} scopeName={null} />,
      );
    });
    triggerProcessBoundary();
    await vi.waitFor(() => {
      expect(container.textContent).toContain("System processes");
    });

    const system = container.querySelector<HTMLElement>(
      'section[aria-labelledby="activity-system-heading"]',
    );
    expect(system?.querySelector("fieldset")).toBeNull();
    expect(system?.querySelectorAll('[data-pressure="high"]')).toHaveLength(2);
    expect(system?.querySelectorAll('[data-pressure="medium"]')).toHaveLength(2);
    expect(system?.querySelectorAll('[data-pressure="low"]')).toHaveLength(2);

    const cpuHeader = system?.querySelector<HTMLButtonElement>(
      'button[aria-label="Sort by CPU"]',
    );
    expect(cpuHeader?.closest("th")?.getAttribute("aria-sort")).toBe("descending");
    act(() => cpuHeader?.click());
    expect(cpuHeader?.closest("th")?.getAttribute("aria-sort")).toBe("ascending");
    expect(system?.querySelector("tbody tr")?.textContent).toContain("44");
  });

  test("keeps history labels and boundary values inside the plot", async () => {
    const current = metrics.host.current;
    expect(current).not.toBeNull();
    if (!current) return;
    api.getActivityMetrics.mockResolvedValue({
      ...metrics,
      host: {
        current,
        samples: [
          { ...current, t: current.t - 3000, cpuPercent: 100 },
          { ...current, cpuPercent: 0 },
        ],
      },
    });

    await act(async () => {
      root.render(
        <ActivityView data={dashboard} onOpenService={vi.fn()} scopeName={null} />,
      );
    });

    const chart = container.querySelector('svg[role="img"]');
    expect(chart).not.toBeNull();
    expect(chart?.querySelector('path[stroke="#10b981"]')?.getAttribute("d")).toBe(
      "M0.0,4.0 L1000.0,96.0",
    );

    const labels = [...container.querySelectorAll("span")].filter((element) =>
      ["100", "50", "0"].includes(element.textContent ?? ""),
    );
    expect(labels.map((label) => label.getAttribute("style"))).toEqual(
      expect.arrayContaining(["top: 4%;", "top: 50%;", "top: 96%;"]),
    );
  });

  test("reveals system processes in bounded batches", async () => {
    const manyProcesses = Array.from({ length: 120 }, (_, index) => ({
      pid: 1000 + index,
      ppid: 1,
      uid: 501,
      user: "alice",
      cpuPercent: 120 - index,
      rssMb: 10,
      command: `worker-${index}`,
      canTerminate: true,
    }));
    api.getActivityMetrics.mockResolvedValue({
      ...metrics,
      systemProcesses: manyProcesses,
    });

    await act(async () => {
      root.render(
        <ActivityView data={dashboard} onOpenService={vi.fn()} scopeName={null} />,
      );
    });
    triggerProcessBoundary();
    await vi.waitFor(() => {
      expect(container.textContent).toContain("System processes");
    });

    const system = container.querySelector<HTMLElement>(
      'section[aria-labelledby="activity-system-heading"]',
    );
    expect(system?.querySelectorAll("tbody tr")).toHaveLength(50);
    const loadMore = [...(system?.querySelectorAll("button") ?? [])].find((button) =>
      button.textContent?.includes("Load 50 more"),
    );
    act(() => loadMore?.click());
    expect(system?.querySelectorAll("tbody tr")).toHaveLength(100);
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

function triggerProcessBoundary(): void {
  if (!intersectionCallback) throw new Error("Process boundary was not observed");
  act(() => {
    intersectionCallback?.(
      [{ isIntersecting: true } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    );
  });
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
