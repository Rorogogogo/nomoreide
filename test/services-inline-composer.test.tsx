// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { OperationProvider } from "../apps/dashboard/src/components/operations/operation-context";
import { ServicesView } from "../apps/dashboard/src/features/services/services-view";
import type { DashboardData } from "../apps/dashboard/src/lib/api";

vi.mock("../apps/dashboard/src/features/agent/chat/agent-context", () => ({
  useAgentDock: () => ({
    sendToAgent: vi.fn(),
    startOnboard: vi.fn(),
  }),
}));

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

describe("Services inline composer", () => {
  test("opens the first service form in the detail pane and returns to onboarding", () => {
    act(() => {
      root.render(
        <OperationProvider>
          <ServicesView data={emptyDashboard()} onRefresh={async () => undefined} />
        </OperationProvider>,
      );
    });

    const createButton = buttonNamed("Create a service");
    act(() => createButton.click());

    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(host.textContent).toContain("Add Service");
    expect(host.querySelector('input[name="name"]')).not.toBeNull();
    expect(host.textContent).not.toContain("Ports");

    const cancelButton = buttonNamed("Cancel");
    act(() => cancelButton.click());

    expect(host.textContent).toContain("Set up your first service");
    expect(host.querySelector('input[name="name"]')).toBeNull();
  });
});

function buttonNamed(name: string): HTMLButtonElement {
  const button = Array.from(host.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.includes(name),
  );
  if (!button) throw new Error(`Missing button: ${name}`);
  return button;
}

function emptyDashboard(): DashboardData {
  return {
    ok: true,
    cwd: "/repo",
    config: { services: [], bundles: [], gitRepositories: [] },
    runtime: { services: {} },
    ports: [],
    logs: [],
    health: {},
    timeline: [],
    git: {
      cwd: "/repo",
      selectedRepository: null,
      status: null,
      branches: [],
    },
  } as unknown as DashboardData;
}
