import { describe, expect, test } from "vitest";
import { buildAgentWorkflowPrompt } from "../src/web/client/src/features/workflows/workflow-prompts.js";

describe("workflow prompt capabilities", () => {
  test("adds selected capabilities as execution guidance", () => {
    const prompt = buildAgentWorkflowPrompt({
      prompt: "Review the staged diff.",
      capabilities: {
        skills: ["code-review"],
        mcpServers: ["github", "nomoreide"],
        plugins: ["workflow-pack"],
        hooks: ["PreToolUse: Bash"],
      },
    });

    expect(prompt).toContain("Review the staged diff.");
    expect(prompt).toContain("Use these selected capabilities if they are available and relevant:");
    expect(prompt).toContain("- Skills: code-review");
    expect(prompt).toContain("- MCP servers: github, nomoreide");
    expect(prompt).toContain("- Plugins: workflow-pack");
    expect(prompt).toContain("- Hooks/context: PreToolUse: Bash");
  });

  test("leaves the prompt unchanged when no capabilities are selected", () => {
    expect(buildAgentWorkflowPrompt({ prompt: "Commit this." })).toBe("Commit this.");
    expect(buildAgentWorkflowPrompt({ prompt: "Commit this.", capabilities: {} })).toBe("Commit this.");
  });
});
