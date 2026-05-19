import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  createNoMoreIdeMcpServer,
  NOMOREIDE_TOOL_NAMES,
  startNoMoreIdeMcpServer,
} from "../src/mcp/server.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "nomoreide-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("NoMoreIDE MCP server", () => {
  test("creates a FastMCP server with every expected NoMoreIDE tool", () => {
    const mcp = createNoMoreIdeMcpServer({
      configPath: join(tempDir, "nomoreide.config.json"),
      logDir: join(tempDir, "logs"),
    });

    expect(mcp.toolNames).toEqual(NOMOREIDE_TOOL_NAMES);
    expect(mcp.toolNames).toContain("nomoreide_git_status");
    expect(mcp.toolNames).toContain("nomoreide_git_branches");
    expect(mcp.toolNames).toContain("nomoreide_git_switch_branch");
    expect(mcp.toolNames).toContain("nomoreide_git_create_branch");
    expect(mcp.toolNames).toContain("nomoreide_git_fetch");
    expect(mcp.toolNames).toContain("nomoreide_git_commit");
    expect(mcp.toolNames).toContain("nomoreide_git_register_repository");
    expect(mcp.toolNames).toContain("nomoreide_git_select_repository");
    expect(mcp.toolNames).toContain("nomoreide_service_health");
    expect(mcp.toolNames).toContain("nomoreide_timeline");
    expect(mcp.toolNames).toContain("nomoreide_service_context");
    expect(mcp.toolNames).toContain("nomoreide_open_ui");
    expect(mcp.toolNames).toContain("nomoreide_close_ui");
    expect(mcp.server).toBeDefined();
    expect(mcp.manager).toBeDefined();
  });

  test("starts the singleton UI before starting the MCP transport", async () => {
    const calls: string[] = [];

    await startNoMoreIdeMcpServer({
      env: {},
      createServer: () => ({
        ...createNoMoreIdeMcpServer({
          configPath: join(tempDir, "nomoreide.config.json"),
          logDir: join(tempDir, "logs"),
        }),
        server: {
          start: async () => {
            calls.push("mcp");
          },
        },
        uiLifecycle: {
          ensureStarted: async () => {
            calls.push("ui");
            return {
              status: "started",
              url: "http://127.0.0.1:4317",
              port: 4317,
              pid: process.pid,
            };
          },
          close: async () => ({ status: "stopped" }),
        },
      }),
    });

    expect(calls).toEqual(["ui", "mcp"]);
  });

  test("skips MCP auto UI startup when NOMOREIDE_AUTO_UI is disabled", async () => {
    const calls: string[] = [];

    await startNoMoreIdeMcpServer({
      env: { NOMOREIDE_AUTO_UI: "0" },
      createServer: () => ({
        ...createNoMoreIdeMcpServer({
          configPath: join(tempDir, "nomoreide.config.json"),
          logDir: join(tempDir, "logs"),
        }),
        server: {
          start: async () => {
            calls.push("mcp");
          },
        },
        uiLifecycle: {
          ensureStarted: async () => {
            calls.push("ui");
            return {
              status: "started",
              url: "http://127.0.0.1:4317",
              port: 4317,
              pid: process.pid,
            };
          },
          close: async () => ({ status: "stopped" }),
        },
      }),
    });

    expect(calls).toEqual(["mcp"]);
  });
});
