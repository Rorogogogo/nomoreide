import { describe, expect, it } from "vitest";
import { parseClaudeList } from "../src/core/mcp-auth.js";

describe("parseClaudeList", () => {
  it("maps connected and needs-authentication lines, including spaced names and URLs", () => {
    const stdout = [
      "Checking MCP server health…",
      "",
      "claude.ai Google Calendar: https://calendarmcp.googleapis.com/mcp/v1 - ! Needs authentication",
      "linear-server: https://mcp.linear.app/mcp (HTTP) - ✓ Connected",
      "context7: npx -y @upstash/context7-mcp - ✓ Connected",
      "brainctl: node /path/cli.js mcp - ✗ failed",
    ].join("\n");

    expect(parseClaudeList(stdout)).toEqual([
      { name: "claude.ai Google Calendar", state: "needs-auth" },
      { name: "linear-server", state: "connected" },
      { name: "context7", state: "connected" },
      { name: "brainctl", state: "failed" },
    ]);
  });

  it("skips the header and blank lines, and marks unrecognized statuses unknown", () => {
    const stdout = "foo: ./bin - ⏸ Pending approval\n";
    expect(parseClaudeList(stdout)).toEqual([{ name: "foo", state: "unknown" }]);
  });
});
