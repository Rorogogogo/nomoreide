// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DockerActivityView } from "../apps/dashboard/src/features/activity/docker-activity-view";

const api = vi.hoisted(() => ({
  getDockerStatus: vi.fn(),
  getDockerContainers: vi.fn(),
  getDockerStats: vi.fn(),
}));

vi.mock("@/lib/api", () => api);

function container(id: string, name: string, state = "running") {
  return {
    id,
    name,
    image: `${name}:latest`,
    state,
    status: state === "running" ? "Up 2 hours" : "Exited (0)",
    ports: "",
  };
}

function stats(
  id: string,
  cpuPercent: number | null,
  memoryPercent: number | null,
) {
  return {
    id,
    cpuPercent,
    memoryPercent,
    memoryUsage: "184MiB / 2GiB",
    netIo: "1.2kB / 648B",
    blockIo: "0B / 4.1kB",
  };
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  api.getDockerStatus.mockResolvedValue({ available: true, canStart: false });
  api.getDockerContainers.mockResolvedValue([]);
  api.getDockerStats.mockResolvedValue([]);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.clearAllMocks();
  vi.useRealTimers();
});

async function render() {
  await act(async () => {
    root.render(<DockerActivityView />);
  });
  // The first paint fires the fetches; let their promises settle.
  await act(async () => {
    await Promise.resolve();
  });
}

describe("Docker as an activity source", () => {
  test("lists containers with their usage, busiest first", async () => {
    api.getDockerContainers.mockResolvedValue([
      container("aaa", "quiet"),
      container("bbb", "busy"),
    ]);
    api.getDockerStats.mockResolvedValue([
      stats("aaa", 1.5, 4),
      stats("bbb", 88.2, 61),
    ]);

    await render();

    const names = [...host.querySelectorAll("tbody tr td:first-child")].map(
      (cell) => cell.textContent ?? "",
    );
    expect(names[0]).toContain("busy");
    expect(names[1]).toContain("quiet");
    expect(host.textContent).toContain("88.2%");
  });

  /**
   * A stopped container has no reading, and `0.0%` would say it is running and
   * idle — the opposite of what is true.
   */
  test("shows a dash rather than zero for a container with no reading", async () => {
    api.getDockerContainers.mockResolvedValue([
      container("ccc", "stopped", "exited"),
    ]);
    api.getDockerStats.mockResolvedValue([]);

    await render();

    const row = host.querySelector("tbody tr");
    expect(row?.textContent).toContain("stopped");
    expect(row?.textContent).toContain("—");
    expect(row?.textContent).not.toContain("0.0%");
  });

  /// Unreadable containers sort last whichever way the column points, so a
  /// descending sort never leads with the least informative rows.
  test("sorts containers with no reading to the bottom", async () => {
    api.getDockerContainers.mockResolvedValue([
      container("aaa", "unknown", "exited"),
      container("bbb", "measured"),
    ]);
    api.getDockerStats.mockResolvedValue([stats("bbb", 3.3, 12)]);

    await render();

    const names = [...host.querySelectorAll("tbody tr td:first-child")].map(
      (cell) => cell.textContent ?? "",
    );
    expect(names[0]).toContain("measured");
    expect(names[1]).toContain("unknown");
  });

  /**
   * Docker being absent is a normal state, not an error: the machine simply is
   * not running it. It has to read as an explanation rather than a failure.
   */
  test("explains itself when Docker is not running", async () => {
    api.getDockerStatus.mockResolvedValue({
      available: false,
      canStart: true,
      error: "Cannot connect to the Docker daemon",
    });

    await render();

    expect(host.querySelector("table")).toBeNull();
    expect(host.textContent).toContain("Docker is not running");
  });

  /// The expensive call must not run when Docker cannot answer it.
  test("does not ask for stats when Docker is unavailable", async () => {
    api.getDockerStatus.mockResolvedValue({ available: false, canStart: true });

    await render();

    expect(api.getDockerStats).not.toHaveBeenCalled();
    expect(api.getDockerContainers).not.toHaveBeenCalled();
  });
});
