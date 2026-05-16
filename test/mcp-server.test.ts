import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  createNoMoreIdeMcpServer,
  NOMOREIDE_TOOL_NAMES,
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
    expect(mcp.toolNames).toContain("nomoreide_git_commit");
    expect(mcp.toolNames).toContain("nomoreide_git_register_repository");
    expect(mcp.toolNames).toContain("nomoreide_git_select_repository");
    expect(mcp.server).toBeDefined();
    expect(mcp.manager).toBeDefined();
  });
});
