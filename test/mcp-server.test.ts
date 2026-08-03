import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  DaemonClient,
  type DaemonConnection,
} from "../src/core/daemon-client.js";
import {
  createNoMoreIdeMcpServer,
  defaultMcpLogDir,
  NOMOREIDE_MCP_INSTRUCTIONS,
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

function fakeDaemon(calls: string[]): DaemonConnection {
  return {
    ensure: async () => {
      calls.push("daemon");
      return {
        status: "started",
        url: "http://127.0.0.1:4317",
        port: 4317,
        pid: process.pid,
      };
    },
    client: async () => new DaemonClient("http://127.0.0.1:1"),
    existing: async () => null,
  };
}

describe("NoMoreIDE MCP server", () => {
  test("keeps default runtime state outside the working repository", () => {
    expect(defaultMcpLogDir()).toBe(join(homedir(), ".nomoreide", "logs"));
    expect(defaultMcpLogDir()).not.toContain(process.cwd());
  });

  test("creates a FastMCP server with every expected NoMoreIDE tool", () => {
    const mcp = createNoMoreIdeMcpServer({
      configPath: join(tempDir, "nomoreide.config.json"),
      logDir: join(tempDir, "logs"),
      daemon: fakeDaemon([]),
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
    expect(mcp.toolNames).toContain("nomoreide_git_worktrees");
    expect(mcp.toolNames).toContain("nomoreide_git_create_worktree");
    expect(mcp.toolNames).toContain("nomoreide_git_select_worktree");
    expect(mcp.toolNames).toContain("nomoreide_git_prune_worktrees");
    expect(mcp.toolNames).toContain("nomoreide_service_health");
    expect(mcp.toolNames).toContain("nomoreide_timeline");
    expect(mcp.toolNames).toContain("nomoreide_service_context");
    expect(mcp.toolNames).toContain("nomoreide_open_ui");
    expect(mcp.toolNames).toContain("nomoreide_close_ui");
    expect(mcp.toolNames).toContain("nomoreide_register_database");
    expect(mcp.toolNames).toContain("nomoreide_check_database");
    expect(mcp.toolNames).toContain("nomoreide_db_schemas");
    expect(mcp.toolNames).toContain("nomoreide_db_objects");
    expect(mcp.toolNames).toContain("nomoreide_db_object_details");
    expect(mcp.server).toBeDefined();
    expect(mcp.daemon).toBeDefined();
  });

  test("advertises automatic run and debugging guidance to MCP clients", () => {
    const mcp = createNoMoreIdeMcpServer({
      configPath: join(tempDir, "nomoreide.config.json"),
      logDir: join(tempDir, "logs"),
      daemon: fakeDaemon([]),
    });

    expect(mcp.server.options.instructions).toBe(NOMOREIDE_MCP_INSTRUCTIONS);
    expect(NOMOREIDE_MCP_INSTRUCTIONS).toContain("debug");
    expect(NOMOREIDE_MCP_INSTRUCTIONS).toContain("nomoreide_list_services");
    expect(NOMOREIDE_MCP_INSTRUCTIONS).toContain("shared daemon");
    expect(NOMOREIDE_MCP_INSTRUCTIONS).toContain("do not launch duplicate");
  });

  test("ensures the shared daemon before starting the MCP transport", async () => {
    const calls: string[] = [];

    await startNoMoreIdeMcpServer({
      env: {},
      createServer: () => ({
        ...createNoMoreIdeMcpServer({
          configPath: join(tempDir, "nomoreide.config.json"),
          logDir: join(tempDir, "logs"),
          daemon: fakeDaemon(calls),
        }),
        server: {
          start: async () => {
            calls.push("mcp");
          },
        },
        daemon: fakeDaemon(calls),
      }),
    });

    expect(calls).toEqual(["daemon", "mcp"]);
  });

  test("skips daemon auto-start when NOMOREIDE_AUTO_UI is disabled", async () => {
    const calls: string[] = [];

    await startNoMoreIdeMcpServer({
      env: { NOMOREIDE_AUTO_UI: "0" },
      createServer: () => ({
        ...createNoMoreIdeMcpServer({
          configPath: join(tempDir, "nomoreide.config.json"),
          logDir: join(tempDir, "logs"),
          daemon: fakeDaemon(calls),
        }),
        server: {
          start: async () => {
            calls.push("mcp");
          },
        },
        daemon: fakeDaemon(calls),
      }),
    });

    expect(calls).toEqual(["mcp"]);
  });
});
