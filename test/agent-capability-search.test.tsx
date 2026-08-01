// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const searchSkills = vi.hoisted(() => vi.fn());
const selectOneTimeSkill = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api", () => ({ searchSkills }));
vi.mock("@/features/agent/chat/agent-context", () => ({
  useAgentDock: () => ({ selectOneTimeSkill }),
}));

import {
  AgentCapabilityBadges,
  AgentCapabilityStrip,
} from "../src/web/client/src/features/agent/terminal/agent-capability-strip";

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  searchSkills.mockResolvedValue([
    {
      id: "vercel-labs/skills/find-skills",
      name: "find-skills",
      source: "vercel-labs/skills",
      useSource: "vercel-labs/skills@find-skills",
      installs: 1234,
      url: "https://skills.sh/vercel-labs/skills/find-skills",
    },
  ]);
});

afterEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  vi.clearAllMocks();
  document.body.replaceChildren();
});

describe("dock remote skill search", () => {
  test("uses clear text labels instead of ambiguous toolbar icons", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <AgentCapabilityBadges
          capabilities={{
            counts: { skills: 11, mcps: 6, plugins: 8, hooks: 19 },
            items: { skills: [], mcps: [], plugins: [], hooks: [] },
            auth: { checked: 6, needsAuth: 0, failed: 0 },
            mcpAuth: {},
          }}
          providerLabel="Claude Code"
        />,
      );
    });

    const capabilities = host.querySelector(
      '[aria-label="Claude Code capabilities"]',
    ) as HTMLElement;
    expect(capabilities.textContent).toBe("Skills11MCP6Plugins8Hooks19");
    expect(capabilities.querySelector("svg")).toBeNull();
    expect(capabilities.className).toContain("overflow-x-auto");

    await act(async () => root.unmount());
  });

  test("groups plugin children behind a collapsed disclosure without changing insertion", async () => {
    const onInsert = vi.fn();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <AgentCapabilityStrip
          capabilities={{
            counts: { skills: 0, mcps: 0, plugins: 1, hooks: 0 },
            items: {
              skills: [],
              mcps: [],
              plugins: [
                {
                  name: "workflow-pack",
                  detail: "user",
                  insert: 'Use the "workflow-pack" plugin: ',
                },
                {
                  name: "workflow-pack:review",
                  insert: "/workflow-pack:review ",
                  sub: true,
                  childKind: "skill",
                },
              ],
              hooks: [],
            },
            auth: null,
            mcpAuth: {},
          }}
          onInsert={onInsert}
          providerLabel="Claude Code"
        />,
      );
    });

    const plugins = Array.from(host.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Plugins"),
    ) as HTMLButtonElement;
    await act(async () => plugins.click());

    expect(document.body.textContent).not.toContain("workflow-pack:review");
    const expand = document.body.querySelector(
      '[aria-label="Expand workflow-pack contents"]',
    ) as HTMLButtonElement;
    await act(async () => expand.click());
    expect(document.body.textContent).toContain("workflow-pack:review");

    const child = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("workflow-pack:review"),
    ) as HTMLButtonElement;
    await act(async () => child.click());
    expect(onInsert).toHaveBeenCalledWith("/workflow-pack:review ");

    await act(async () => root.unmount());
  });

  test("gives Hook commands a full-width second line", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <AgentCapabilityStrip
          capabilities={{
            counts: { skills: 0, mcps: 0, plugins: 0, hooks: 1 },
            items: {
              skills: [],
              mcps: [],
              plugins: [],
              hooks: [
                {
                  name: "Notification",
                  detail: "/Users/example/.codex/hooks/notify.sh",
                },
              ],
            },
            auth: null,
            mcpAuth: {},
          }}
          providerLabel="Codex"
        />,
      );
    });

    const hooks = Array.from(host.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Hooks"),
    ) as HTMLButtonElement;
    await act(async () => hooks.click());
    const row = document.body.querySelector(
      "[data-capability-hook-row]",
    ) as HTMLElement;
    const lines = row.querySelectorAll("span > span");

    expect(row.textContent).toContain("Notification");
    expect(row.textContent).toContain("/Users/example/.codex/hooks/notify.sh");
    expect(lines[0]?.className).toContain("block");
    expect(lines[1]?.className).toContain("block");

    await act(async () => root.unmount());
  });

  test("searches skills.sh and stages a result for one-time use", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <AgentCapabilityStrip
          capabilities={{
            counts: { skills: 1, mcps: 0, plugins: 0, hooks: 0 },
            items: {
              skills: [{ name: "installed", detail: "project", insert: "/installed " }],
              mcps: [],
              plugins: [],
              hooks: [],
            },
            auth: null,
            mcpAuth: {},
          }}
          providerLabel="Claude Code"
        />,
      );
    });

    const trigger = Array.from(host.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Skills"),
    );
    await act(async () => trigger?.click());
    const input = document.body.querySelector(
      '[aria-label="Search skills.sh"]',
    ) as HTMLInputElement;
    expect(document.body.textContent).toContain("installed");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(input, "react");
      input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });

    expect(searchSkills).toHaveBeenCalledWith("react");
    expect(document.body.textContent).toContain("find-skills");
    expect(document.body.textContent).toContain("1.2K");
    expect(document.body.textContent).not.toContain("installed");
    expect(
      (document.body.querySelector("[data-capability-menu]") as HTMLElement)
        .style.maxHeight,
    ).not.toBe("");

    const useOnce = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent === "Use once",
    );
    await act(async () => useOnce?.click());
    expect(selectOneTimeSkill).toHaveBeenCalledWith({
      name: "find-skills",
      source: "vercel-labs/skills@find-skills",
    });

    await act(async () => root.unmount());
  });
});
