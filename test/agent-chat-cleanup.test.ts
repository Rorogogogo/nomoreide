import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const root = resolve(__dirname, "../src/web/client/src");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("native agent terminal cleanup", () => {
  test("the provider owns terminal tasks without instantiating legacy chat state", () => {
    const source = read("features/agent/chat/agent-context.tsx");
    expect(source).not.toContain("useAgentChat");
    expect(source).not.toContain("chatError");
    expect(source).toContain("useAgentTerminalTasks");
  });

  test("the agent profile view no longer presents conversation health", () => {
    const source = read("features/agent/agent-view.tsx");
    expect(source).not.toContain("ConversationHealth");
    expect(source).not.toMatch(/\bturns\b/);
    expect(source).not.toMatch(/\bclear\b/);
  });

  test("GitHub comments use the shared markdown surface", () => {
    const source = read("features/github/issue-detail.tsx");
    expect(source).toContain("MarkdownPreview");
    expect(source).not.toContain("ChatMarkdown");
  });

  test.each([
    "features/agent/chat/agent-dock.tsx",
    "features/agent/chat/chat-markdown.tsx",
    "features/agent/chat/chat-markdown.css",
    "features/agent/chat/message-options.tsx",
    "features/agent/chat/streaming-ui.tsx",
    "features/agent/chat/use-agent-chat.ts",
    "features/agent/conversation-health.tsx",
  ])("removes obsolete chat presentation module %s", (path) => {
    expect(existsSync(resolve(root, path))).toBe(false);
  });

  test("retains the headless streaming runtime", () => {
    const source = read("features/agent/headless/run-headless-agent-task.ts");
    expect(source).toContain("streamAgentChat");
    expect(existsSync(resolve(root, "lib/api/agent-chat-api.ts"))).toBe(true);
  });

  test("database write guidance matches the raw terminal dock", () => {
    const source = readFileSync(resolve(root, "../../../mcp/tools/database.ts"), "utf8");
    expect(source).not.toContain("sql-write");
    expect(source).not.toContain("message-options");
    expect(source).not.toContain('"Open in SQL console" button');
    expect(source).toContain("exact SQL statement");
    expect(source).toContain("locked SQL console");
    expect(source).toContain("affected-rows preview");
  });

  test("workflow UI no longer offers a no-op session toggle", () => {
    const source = read("features/workflows/workflow-panel.tsx");
    expect(source).not.toContain("step.isolated");
    expect(source).not.toContain("Fresh session");
    expect(source).not.toContain("dock conversation");
  });

  test.each(["usage-guide.md", "ai-agent-guide.md"])(
    "%s documents terminal-compatible SQL review",
    (name) => {
      const source = readFileSync(resolve(root, `../../../../docs/${name}`), "utf8");
      expect(source).not.toContain("sql-write");
      expect(source).not.toContain('"Open in SQL console"');
      expect(source).toContain("```sql");
      expect(source).toContain("locked SQL console");
      expect(source).toContain("affected-rows preview");
    },
  );
});
