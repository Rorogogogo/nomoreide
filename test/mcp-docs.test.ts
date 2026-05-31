import { describe, expect, test } from "vitest";
import {
  buildNoMoreIdeDocs,
  type NoMoreIdeDocsTopic,
} from "../src/mcp/tools/docs.js";
import {
  createNoMoreIdeMcpServer,
  NOMOREIDE_TOOL_NAMES,
} from "../src/mcp/server.js";

describe("NoMoreIDE docs MCP tool", () => {
  test("is exposed by the MCP server", () => {
    const mcp = createNoMoreIdeMcpServer();

    expect(NOMOREIDE_TOOL_NAMES).toContain("nomoreide_docs");
    expect(mcp.toolNames).toContain("nomoreide_docs");
  });

  test("returns a documentation index when no topic is requested", () => {
    const docs = buildNoMoreIdeDocs({});

    expect(docs.topic).toBe("index");
    expect(docs.title).toBe("NoMoreIDE documentation index");
    expect(docs.body).toContain("NoMoreIDE is an AI-native local development workbench");
    expect(docs.topics.map((topic) => topic.id)).toContain("mcp");
    expect(docs.links.fullAiDocs).toBe("https://www.nomoreide.com/llms-full.txt");
  });

  test.each<NoMoreIdeDocsTopic>([
    "setup",
    "mcp",
    "cli",
    "dashboard",
    "tools",
    "safety",
    "troubleshooting",
    "architecture",
    "ai-agent",
  ])("returns topic docs for %s", (topic) => {
    const docs = buildNoMoreIdeDocs({ topic });

    expect(docs.topic).toBe(topic);
    expect(docs.body).toContain("NoMoreIDE");
    expect(docs.links.humanDocs).toBe("https://www.nomoreide.com/docs");
  });
});
