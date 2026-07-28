// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { MetricsTab } from "../src/web/client/src/features/services/service-detail/metrics-tab";

const api = vi.hoisted(() => ({ getServiceMetrics: vi.fn() }));

vi.mock("@/lib/api", () => ({
  getServiceMetrics: api.getServiceMetrics,
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  api.getServiceMetrics.mockReset().mockResolvedValue({
    service: "frontend",
    startedAt: "2026-07-28T10:00:00Z",
    samples: [
      { t: 1_000, cpu: 100, rss: 512 },
      { t: 4_000, cpu: 0, rss: 256 },
    ],
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
});

describe("service metrics", () => {
  test("keeps boundary values and Y-axis labels inside the plot", async () => {
    await act(async () => {
      root.render(<MetricsTab serviceName="frontend" />);
    });

    const cpuChart = container.querySelector('svg[aria-label="CPU"]');
    expect(cpuChart).not.toBeNull();
    expect(cpuChart?.querySelector('path[fill="none"]')?.getAttribute("d")).toBe(
      "M0.0,40.0 L1000.0,960.0",
    );

    const labels = [...container.querySelectorAll("span")].filter((element) =>
      ["100%", "0%"].includes(element.textContent ?? ""),
    );
    expect(labels.map((label) => label.getAttribute("style"))).toEqual(
      expect.arrayContaining(["top: 4%;", "top: 96%;"]),
    );
  });
});
