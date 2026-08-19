// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { DashboardData } from "../src/web/client/src/lib/api";

const api = vi.hoisted(() => ({
  getAgentInfo: vi.fn(),
  getMcpAuthStatuses: vi.fn(),
  getRecentToolCalls: vi.fn(),
}));

vi.mock("@/lib/api", () => api);

import { agentWidget } from "../src/web/client/src/features/agent/widget";

let host: HTMLDivElement;
let root: Root;

const profile = (skill: string) => ({
  project: { cwd: "/repo", memoryFiles: [] },
  skills: [{ name: skill, path: `/skills/${skill}`, scope: "user" }],
  mcpServers: [],
  plugins: [],
  hooks: [],
  projects: [],
});

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  api.getAgentInfo.mockResolvedValue({
    agents: {
      "claude-code": profile("claude-skill"),
      codex: profile("codex-skill"),
    },
  });
  api.getMcpAuthStatuses.mockImplementation(async (agent: string) =>
    agent === "codex"
      ? [{ name: "codex-green", state: "connected" }]
      : [
          { name: "claude-yellow", state: "needs-auth" },
          { name: "claude-green", state: "connected" },
          { name: "claude-red", state: "failed" },
        ],
  );
  api.getRecentToolCalls.mockResolvedValue([]);
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

describe("Home Agent widget", () => {
  test("loads in place, orders connected MCP servers first, and switches agents", async () => {
    act(() => {
      root.render(
        <>
          {agentWidget.render({
            data: {} as DashboardData,
            height: null,
            onRefresh: async () => {},
          })}
        </>,
      );
    });
    expect(host.querySelector('[role="status"]')).not.toBeNull();

    await vi.waitFor(() => expect(host.textContent).toContain("claude-green"));
    expect(host.textContent.indexOf("claude-green")).toBeLessThan(
      host.textContent.indexOf("claude-yellow"),
    );

    const skills = Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent === "Skills",
    );
    await act(async () => skills?.click());
    expect(host.textContent).toContain("claude-skill");

    const codex = Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent === "Codex",
    );
    await act(async () => codex?.click());
    await vi.waitFor(() => expect(host.textContent).toContain("codex-skill"));
    expect(api.getMcpAuthStatuses).toHaveBeenCalledWith("claude-code");
    expect(api.getMcpAuthStatuses).toHaveBeenCalledWith("codex");
  });
});
