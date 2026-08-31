// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { OperationProvider } from "../apps/dashboard/src/components/operations/operation-context";
import { servicesWidget } from "../apps/dashboard/src/features/services/widgets";
import type { DashboardData } from "../apps/dashboard/src/lib/api";

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
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
});

describe("Home Services widget", () => {
  test("shows registered stopped services with contextual lifecycle actions", () => {
    const data = dashboard();

    act(() => {
      root.render(
        <OperationProvider>
          {servicesWidget.render({ data, height: null, onRefresh: async () => {} })}
        </OperationProvider>,
      );
    });

    expect(host.textContent).toContain("web");
    expect(host.textContent).toContain("worker");
    expect(host.textContent).toContain("failed");
    expect(host.querySelector('[title="Stopped"]')?.textContent).toContain("1");

    expect(actionLabels("worker")).toEqual(["Start"]);
    expect(actionLabels("failed")).toEqual(["Start"]);
    expect(actionLabels("web")).toEqual([
      "Open http://127.0.0.1:3000",
      "Restart",
      "Stop",
    ]);
  });
});

function actionLabels(serviceName: string): string[] {
  const name = Array.from(host.querySelectorAll("span")).find(
    (candidate) => candidate.textContent === serviceName,
  );
  const row = name?.parentElement;
  if (!row) throw new Error(`Missing row for ${serviceName}`);
  return Array.from(row.querySelectorAll("button")).map(
    (button) => button.getAttribute("aria-label") ?? "",
  );
}

function dashboard(): DashboardData {
  return {
    ok: true,
    cwd: "/repo",
    config: {
      services: [
        { name: "web", port: 3000 },
        { name: "worker" },
        { name: "failed" },
      ],
      bundles: [],
      gitRepositories: [],
    },
    runtime: {
      services: {
        web: { name: "web", state: "running", startedAt: new Date().toISOString() },
        failed: { name: "failed", state: "exited", exitCode: 1 },
      },
    },
    ports: [],
    health: {},
    timeline: [],
    logs: [],
    git: {
      cwd: "/repo",
      selectedRepository: null,
      status: null,
      branches: [],
    },
  };
}
