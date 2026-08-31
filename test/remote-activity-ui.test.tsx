// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { RemoteActivityView } from "../apps/dashboard/src/features/activity/activity-page";
import type { RemoteHostMetrics, SshServerSummary } from "../apps/dashboard/src/lib/api";

const api = vi.hoisted(() => ({
  getRemoteHostMetrics: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../apps/dashboard/src/lib/api")>()),
  getRemoteHostMetrics: api.getRemoteHostMetrics,
}));

const server: SshServerSummary = {
  host: "prod-web",
  name: "Production",
  discovered: false,
  saved: true,
};

const metrics: RemoteHostMetrics = {
  host: "prod-web",
  hostname: "web-01",
  platform: "Linux",
  current: {
    t: new Date("2026-08-09T10:00:00Z").getTime(),
    cpuPercent: 42,
    memoryUsedBytes: 4 * 1024 ** 3,
    memoryTotalBytes: 8 * 1024 ** 3,
    memoryUsedPercent: 50,
    loadAverage: [1.2, 1, 0.8],
    uptimeSeconds: 90_000,
    logicalCpuCount: 4,
    disk: {
      path: "/",
      totalBytes: 100 * 1024 ** 3,
      usedBytes: 60 * 1024 ** 3,
      availableBytes: 40 * 1024 ** 3,
      usedPercent: 60,
    },
  },
  processes: [
    {
      pid: 42,
      ppid: 1,
      user: "deploy",
      cpuPercent: 12.5,
      rssMb: 256,
      command: "/usr/bin/node server.js",
    },
  ],
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  api.getRemoteHostMetrics.mockReset().mockResolvedValue(metrics);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("remote activity UI", () => {
  test("uses the local activity hierarchy while keeping remote processes read-only", async () => {
    await act(async () => root.render(<RemoteActivityView server={server} />));
    await act(async () => Promise.resolve());

    expect(container.textContent).toContain("Activity Monitor");
    expect(container.textContent).toContain("Production");
    expect(container.textContent).toContain("Building a short machine history");
    expect(container.textContent).toContain("System processes");
    expect(container.textContent).toContain("Remote · read-only");
    expect(container.textContent).toContain("node");
    expect(container.querySelector('input[placeholder="Search process, user, or PID"]')).not.toBeNull();
    expect(container.querySelector('[data-pressure="low"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label^="End "]')).toBeNull();
  });
});
