import { describe, expect, test } from "vitest";
import {
  buildWorkflowAiDraftPrompt,
  draftWorkflowFromIntent,
} from "../src/web/client/src/features/workflows/workflow-composer.js";

describe("workflow composer", () => {
  test("drafts a gated review commit push pr workflow from intent", () => {
    const workflow = draftWorkflowFromIntent(
      "Review my changes with code-review skill, ask before commit, push, then open PR with github",
      [],
      {
        skills: ["code-review"],
        mcpServers: ["github"],
        plugins: [],
        hooks: [],
      },
    );

    expect(workflow.name).toBe("Review, Commit & PR");
    expect(workflow.steps.map((step) => step.kind)).toEqual([
      "gate",
      "agent",
      "gate",
      "agent",
      "gate",
      "action",
      "agent",
    ]);
    expect(workflow.steps[1]).toMatchObject({
      kind: "agent",
      capabilities: { skills: ["code-review"] },
    });
    expect(workflow.steps[6]).toMatchObject({
      kind: "agent",
      capabilities: { mcpServers: ["github"] },
    });
  });

  test("builds an AI handoff prompt with schema and user intent", () => {
    const prompt = buildWorkflowAiDraftPrompt("Ship safely after tests pass");

    expect(prompt).toContain("Ship safely after tests pass");
    expect(prompt).toContain("Return a workflow JSON object");
    expect(prompt).toContain("kind: \"gate\"");
    expect(prompt).toContain("kind: \"agent\"");
    expect(prompt).toContain("kind: \"action\"");
  });
});
