// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AgentWorkGraph } from "../apps/dashboard/src/features/agent/agent-work-graph";

const dock = vi.hoisted(() => ({
  creating: 0,
  setActiveTaskId: vi.fn(),
  setOpen: vi.fn(),
  tasks: [
    {
      id: "term_4",
      cwd: "/work/no-more-ide",
      cols: 100,
      rows: 30,
      shell: "codex",
      state: "running" as const,
      kind: "agent" as const,
      provider: "codex" as const,
      label: "Fix service env scrolling",
      source: { type: "service", label: "api" },
    },
  ],
  tasksHydrationSettled: true,
}));

vi.mock(
  "../apps/dashboard/src/features/agent/chat/agent-context",
  () => ({ useAgentDock: () => dock }),
);

async function renderGraph() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<AgentWorkGraph />));
  return { host, root };
}

async function unmount(root: Root, host: HTMLElement) {
  await act(async () => root.unmount());
  host.remove();
}

afterEach(() => {
  vi.clearAllMocks();
  document.body.replaceChildren();
});

describe("agent work graph", () => {
  test("maps a live task to its workspace and opens it in the dock", async () => {
    const mounted = await renderGraph();

    expect(mounted.host.textContent).toContain("no-more-ide");
    expect(mounted.host.textContent).toContain("Codex");
    expect(mounted.host.textContent).toContain("Fix service env scrolling");

    const task = [...mounted.host.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Fix service env scrolling"),
    );
    await act(async () => task?.click());

    expect(dock.setActiveTaskId).toHaveBeenCalledWith("term_4");
    expect(dock.setOpen).toHaveBeenCalledWith(true);
    await unmount(mounted.root, mounted.host);
  });
});
