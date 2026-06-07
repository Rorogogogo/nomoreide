import { describe, expect, test } from "vitest";
import {
  buildAgentWorkflowPrompt,
  buildPrBranchRecoveryPrompt,
  buildWorkflowStepDebugPrompt,
} from "../src/web/client/src/features/workflows/workflow-prompts.js";

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

  test("builds a stuck workflow step debug prompt with run context", () => {
    const prompt = buildWorkflowStepDebugPrompt({
      workflowName: "Ship it",
      step: {
        kind: "action",
        id: "assert-pr-branch",
        title: "Check PR branch",
        op: "assert-pr-branch",
      },
      status: "failed",
      error: "Create or switch to a feature branch before opening a PR.",
      previousOutput: "feat: add workflow guard",
      output: "",
    });

    expect(prompt).toContain("Debug this stuck NoMoreIDE workflow step.");
    expect(prompt).toContain("Workflow: Ship it");
    expect(prompt).toContain("Step: Check PR branch");
    expect(prompt).toContain("Status: failed");
    expect(prompt).toContain("Action: assert-pr-branch");
    expect(prompt).toContain("Runner error:");
    expect(prompt).toContain("Create or switch to a feature branch before opening a PR.");
    expect(prompt).toContain("Previous step output:");
    expect(prompt).toContain("feat: add workflow guard");
    expect(prompt).toContain("smallest safe next action");
  });

  test("builds an AI-native PR branch recovery prompt", () => {
    const prompt = buildPrBranchRecoveryPrompt({
      workflowName: "Ship it",
      error: "Current branch is main.",
    });

    expect(prompt).toContain("Recover this NoMoreIDE PR workflow from the default branch guard.");
    expect(prompt).toContain("Workflow: Ship it");
    expect(prompt).toContain("Current branch is main.");
    expect(prompt).toContain("The user approved reading the minimum file diffs needed by clicking the workflow recovery button.");
    expect(prompt).toContain("nomoreide_git_status");
    expect(prompt).toContain("nomoreide_git_diff");
    expect(prompt).toContain("recommend a concise branch name");
    expect(prompt).toContain("BRANCH_NAME: <branch-name>");
    expect(prompt).toContain("Do not create the branch");
    expect(prompt).not.toContain("Ask me before reading file diffs.");
  });
});
