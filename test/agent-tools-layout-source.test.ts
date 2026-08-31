import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const root = resolve(__dirname, "..");

describe("agent tools layout source", () => {
  test("keeps all four tool cards visible as columns on wide screens", () => {
    const toolsTab = readFileSync(
      resolve(root, "apps/dashboard/src/features/agent/tools-tab.tsx"),
      "utf8",
    );
    const mcpCard = readFileSync(
      resolve(root, "apps/dashboard/src/features/agent/tools/mcp-servers-card.tsx"),
      "utf8",
    );
    const pluginsCard = readFileSync(
      resolve(root, "apps/dashboard/src/features/agent/tools/plugins-card.tsx"),
      "utf8",
    );
    const hooksCard = readFileSync(
      resolve(root, "apps/dashboard/src/features/agent/tools/hooks-card.tsx"),
      "utf8",
    );

    expect(toolsTab).toContain("grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4");
    expect(mcpCard).toContain("md:border-l");
    expect(pluginsCard).toContain("lg:border-l lg:border-t-0");
    expect(hooksCard).toContain("md:border-l lg:border-t-0");
  });

  test("registers tool rows with the AI context menu and exposes truncated names on hover", () => {
    const files = [
      {
        source: readFileSync(
          resolve(root, "apps/dashboard/src/features/agent/tools/skills-card.tsx"),
          "utf8",
        ),
        title: "title={skill.name}",
        targetLabel: "label: skill.name",
      },
      {
        source: readFileSync(
          resolve(root, "apps/dashboard/src/features/agent/tools/mcp-servers-card.tsx"),
          "utf8",
        ),
        title: "title={server.name}",
        targetLabel: "label: server.name",
      },
      {
        source: readFileSync(
          resolve(root, "apps/dashboard/src/features/agent/tools/plugins-card.tsx"),
          "utf8",
        ),
        title: "title={plugin.name}",
        targetLabel: "label: plugin.name",
      },
      {
        source: readFileSync(
          resolve(root, "apps/dashboard/src/features/agent/tools/hooks-card.tsx"),
          "utf8",
        ),
        title: "title={hook.event}",
        targetLabel: "label: hook.event",
      },
    ];

    for (const file of files) {
      expect(file.source).toContain(file.title);
      expect(file.source).not.toContain("ToolDetailDialog");
      expect(file.source).toContain("<AiContextTarget");
      expect(file.source).toContain(file.targetLabel);
      expect(file.source).not.toContain("<RowActions");
    }
  });

  test("does not keep the removed tool detail dialog shell", () => {
    const sharedTools = readFileSync(
      resolve(root, "apps/dashboard/src/features/agent/tools/tools-shared.tsx"),
      "utf8",
    );

    expect(sharedTools).not.toContain("ComposerDialog");
    expect(sharedTools).not.toContain("DetailField");
  });
});
