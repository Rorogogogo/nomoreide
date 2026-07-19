import { describe, expect, test } from "vitest";
import {
  capabilityCountsFor,
  capabilityItemsFor,
  countMcpServers,
  mcpInsertText,
  skillInsertText,
  summarizeMcpAuth,
} from "../src/web/client/src/features/agent/terminal/agent-capability-data";
import type { AgentEnvConfig, AgentHook, McpAuthStatus } from "../src/web/client/src/lib/api";

function config(overrides: Partial<AgentEnvConfig> = {}): AgentEnvConfig {
  return {
    agent: "claude",
    configPath: "~/.claude.json",
    exists: true,
    mcpServers: {},
    remoteMcpServers: {},
    projectMcpServers: {},
    projectRemoteMcpServers: {},
    skills: [],
    ...overrides,
  };
}

const local = { command: "npx", args: [] };
const remote = { url: "https://example.com/mcp" };

describe("countMcpServers", () => {
  test("sums user and project servers across local and remote maps", () => {
    const count = countMcpServers(
      config({
        mcpServers: { a: local, b: local },
        remoteMcpServers: { c: remote },
        projectMcpServers: { d: local },
        projectRemoteMcpServers: { e: remote },
      }),
    );
    expect(count).toBe(5);
  });

  test("returns 0 for an empty config", () => {
    expect(countMcpServers(config())).toBe(0);
  });
});

describe("capabilityCountsFor", () => {
  test("splits skills and plugins by kind, matching the Agent Env sections", () => {
    const counts = capabilityCountsFor(
      config({
        skills: [
          { name: "commit-push", scope: "user" },
          { name: "verify", scope: "project", kind: "skill" },
          { name: "brainctl-board", scope: "user", kind: "plugin" },
        ],
        mcpServers: { linear: local },
      }),
      2,
    );
    expect(counts).toEqual({ skills: 2, plugins: 1, mcps: 1, hooks: 2 });
  });

  test("handles a missing agent config", () => {
    expect(capabilityCountsFor(undefined, 0)).toEqual({
      skills: 0,
      plugins: 0,
      mcps: 0,
      hooks: 0,
    });
  });
});

describe("skillInsertText", () => {
  test("Claude skills insert as slash commands, Codex skills as prose", () => {
    expect(skillInsertText("commit-push", "claude")).toBe("/commit-push ");
    expect(skillInsertText("commit-push", "codex")).toBe('Use the "commit-push" skill: ');
  });
});

describe("capabilityItemsFor", () => {
  const hook: AgentHook = {
    id: "h1",
    event: "PostToolUse",
    scope: "user",
    settingsPath: "~/.claude/settings.json",
    matcher: "Bash",
    command: "npx lint",
    status: "enabled",
  };

  test("builds insertable skill and MCP rows with scope details", () => {
    const items = capabilityItemsFor(
      config({
        skills: [{ name: "verify", scope: "project", kind: "skill" }],
        mcpServers: { linear: local },
        projectRemoteMcpServers: { quest: remote },
      }),
      [hook],
      "claude",
    );
    expect(items.skills).toEqual([{ name: "verify", detail: "project", insert: "/verify " }]);
    expect(items.mcps).toEqual([
      { name: "linear", detail: "user", insert: mcpInsertText("linear") },
      { name: "quest", detail: "project · remote", insert: mcpInsertText("quest") },
    ]);
  });

  test("expands Claude plugins into namespaced sub-rows for bundled skills/commands", () => {
    const items = capabilityItemsFor(
      config({
        skills: [
          {
            name: "brainctl",
            scope: "user",
            kind: "plugin",
            pluginSkills: ["board"],
            pluginCommands: ["sync"],
          },
        ],
      }),
      [],
      "claude",
    );
    expect(items.plugins).toEqual([
      { name: "brainctl", detail: "user", insert: 'Use the "brainctl" plugin: ' },
      { name: "brainctl:board", insert: "/brainctl:board ", sub: true },
      { name: "brainctl:sync", insert: "/brainctl:sync ", sub: true },
    ]);
  });

  test("keeps Codex plugin rows flat and hook rows read-only", () => {
    const items = capabilityItemsFor(
      config({
        skills: [{ name: "helper", scope: "user", kind: "plugin", pluginCommands: ["run"] }],
      }),
      [hook],
      "codex",
    );
    expect(items.plugins).toEqual([
      { name: "helper", detail: "user", insert: 'Use the "helper" plugin: ' },
    ]);
    expect(items.hooks).toEqual([{ name: "PostToolUse · Bash", detail: "npx lint" }]);
    expect(items.hooks[0]).not.toHaveProperty("insert");
  });
});

describe("summarizeMcpAuth", () => {
  test("counts needs-auth and failed servers, ignoring healthy states", () => {
    const statuses: McpAuthStatus[] = [
      { name: "linear", state: "connected" },
      { name: "notion", state: "needs-auth" },
      { name: "pg", state: "no-auth" },
      { name: "broken", state: "failed" },
      { name: "pending", state: "unknown" },
    ];
    expect(summarizeMcpAuth(statuses)).toEqual({ checked: 5, needsAuth: 1, failed: 1 });
  });

  test("reports zero checked when the CLI returned nothing", () => {
    expect(summarizeMcpAuth([])).toEqual({ checked: 0, needsAuth: 0, failed: 0 });
  });
});
