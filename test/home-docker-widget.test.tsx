// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { DashboardData } from "../apps/dashboard/src/lib/api";

const api = vi.hoisted(() => ({
  getDockerContainers: vi.fn(),
  getDockerStatus: vi.fn(),
}));

vi.mock("@/lib/api", () => api);

import { dockerWidget } from "../apps/dashboard/src/features/docker/widget";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.clearAllMocks();
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
});

describe("Home Docker widget", () => {
  test("summarizes container state and prioritizes containers needing attention", async () => {
    api.getDockerStatus.mockResolvedValue({ available: true, canStart: false, version: "28.0.0" });
    api.getDockerContainers.mockResolvedValue([
      container("web", "running", "app:latest"),
      container("worker", "exited", "worker:latest"),
      container("db", "dead", "postgres:17"),
    ]);

    renderWidget();

    await flushRequests();
    expect(host.textContent).toContain("web");
    expect(host.querySelector('[title="Running"]')?.textContent).toContain("1");
    expect(host.querySelector('[title="Stopped"]')?.textContent).toContain("2");
    expect(host.querySelector('[title="Total"]')?.textContent).toContain("3");
    expect(host.textContent.indexOf("db")).toBeLessThan(host.textContent.indexOf("web"));
  });

  test("shows a stopped Docker Desktop state without loading containers", async () => {
    api.getDockerStatus.mockResolvedValue({
      available: false,
      canStart: true,
      error: "Cannot connect to the Docker daemon",
    });

    renderWidget();

    await flushRequests();
    expect(host.textContent).toContain("Docker Desktop is stopped");
    expect(api.getDockerContainers).not.toHaveBeenCalled();
  });
});

function renderWidget() {
  act(() => {
    root.render(
      <>
        {dockerWidget.render({
          data: {} as DashboardData,
          height: null,
          onRefresh: async () => {},
        })}
      </>,
    );
  });
}

async function flushRequests() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function container(name: string, state: string, image: string) {
  return {
    id: `${name}-id`,
    name,
    image,
    state,
    status: state,
    ports: "",
  };
}
