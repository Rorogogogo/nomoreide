import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { AgentColumn } from "../apps/dashboard/src/features/agent-env/agent-column";

describe("agent environments UI", () => {
  test("renders an agent as a flat separator-based column", () => {
    const markup = renderToStaticMarkup(
      <AgentColumn
        availability={{
          agent: "codex",
          available: true,
          command: "codex",
          resolvedPath: "/usr/local/bin/codex",
        }}
        config={{
          agent: "codex",
          configPath: "/home/user/.codex/config.toml",
          exists: true,
          mcpServers: {
            github: { command: "npx", args: ["github-mcp"] },
          },
          remoteMcpServers: {},
          projectMcpServers: {},
          projectRemoteMcpServers: {},
          skills: [{ name: "review", kind: "skill", scope: "user" }],
        }}
        onStage={() => undefined}
      />,
    );

    expect(markup).toContain(
      'class="flex min-h-0 flex-col bg-background"',
    );
    expect(markup).toContain("border-b border-border px-3 py-2");
    expect(markup).toContain(
      "divide-y divide-border/60 border-y border-border/60",
    );
    expect(markup).toContain("hover:bg-muted/20");
    expect(markup).not.toContain("rounded-xl border bg-card");
  });
});
