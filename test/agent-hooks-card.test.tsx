import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { AgentProvider } from "../apps/dashboard/src/features/agent/chat/agent-context";
import { HooksCard } from "../apps/dashboard/src/features/agent/tools/hooks-card";
import type { AgentProfile } from "../apps/dashboard/src/lib/api";

const emptyProfile: AgentProfile = {
  project: {
    cwd: "/repo",
    memoryFiles: [],
  },
  skills: [],
  mcpServers: [],
  plugins: [],
  hooks: [],
  projects: [],
};

describe("HooksCard", () => {
  test("renders hook status and trust badges", () => {
    const profile: AgentProfile = {
      ...emptyProfile,
      hooks: [
        {
          id: "/Users/demo/.codex/hooks.json:Stop:0:0",
          event: "Stop",
          scope: "user",
          settingsPath: "/Users/demo/.codex/hooks.json",
          type: "command",
          command: "/Users/demo/.codex/notchy/play.sh complete",
          status: "enabled",
          trusted: true,
        },
      ],
    };

    const markup = renderToStaticMarkup(
      <AgentProvider>
        <HooksCard agent={profile} agentId="codex" />
      </AgentProvider>,
    );

    expect(markup).toContain("Enabled");
    expect(markup).toContain("Trusted");
  });

  test("points to another agent when the selected agent has no hooks", () => {
    const markup = renderToStaticMarkup(
      <AgentProvider>
        <HooksCard
          agent={emptyProfile}
          agentId="codex"
          alternateHooks={{ agentLabel: "Claude Code", count: 19 }}
        />
      </AgentProvider>,
    );

    expect(markup).toContain("No Codex hooks configured.");
    expect(markup).toContain("Claude Code has 19 hook(s)");
  });
});
