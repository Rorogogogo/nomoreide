// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AgentColumn } from "../apps/dashboard/src/features/agent-env/agent-column";

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  document.body.replaceChildren();
});

describe("agent environment disclosures", () => {
  test("auto-collapses long sections and expands them independently", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <AgentColumn
          config={{
            agent: "codex",
            configPath: "/home/user/.codex/config.toml",
            exists: true,
            mcpServers: Object.fromEntries(
              Array.from({ length: 6 }, (_, index) => [
                `mcp-${index + 1}`,
                { command: "npx", args: [`server-${index + 1}`] },
              ]),
            ),
            remoteMcpServers: {},
            projectMcpServers: {},
            projectRemoteMcpServers: {},
            skills: [
              ...Array.from({ length: 6 }, (_, index) => ({
                kind: "skill" as const,
                name: `skill-${index + 1}`,
                scope: "user" as const,
              })),
              ...Array.from({ length: 6 }, (_, index) => ({
                kind: "plugin" as const,
                name: `plugin-${index + 1}`,
                scope: "user" as const,
              })),
            ],
          }}
        />,
      );
    });

    const sectionButton = (label: string) =>
      Array.from(host.querySelectorAll("button")).find((button) =>
        button.textContent?.includes(label),
      ) as HTMLButtonElement;
    const mcps = sectionButton("MCP Servers");
    const skills = sectionButton("Skills");
    const plugins = sectionButton("Plugins");

    expect(mcps.getAttribute("aria-expanded")).toBe("false");
    expect(skills.getAttribute("aria-expanded")).toBe("false");
    expect(plugins.getAttribute("aria-expanded")).toBe("false");
    expect(skills.textContent).toContain("6");
    expect(host.textContent).not.toContain("skill-1");

    await act(async () => skills.click());

    expect(skills.getAttribute("aria-expanded")).toBe("true");
    expect(host.textContent).toContain("skill-1");
    expect(mcps.getAttribute("aria-expanded")).toBe("false");
    expect(host.textContent).not.toContain("mcp-1");

    await act(async () => root.unmount());
  });
});
