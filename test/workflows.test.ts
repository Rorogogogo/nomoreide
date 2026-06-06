import { describe, expect, test } from "vitest";
import {
  BUILTIN_WORKFLOWS,
  listWorkflows,
  workflowSchema,
  type Workflow,
} from "../src/core/workflows.js";

describe("workflows", () => {
  test("every built-in template is a valid workflow", () => {
    for (const workflow of BUILTIN_WORKFLOWS) {
      expect(() => workflowSchema.parse(workflow)).not.toThrow();
      expect(workflow.steps.length).toBeGreaterThan(0);
    }
  });

  test("listWorkflows returns the built-ins when nothing is stored", () => {
    const ids = listWorkflows([]).map((workflow) => workflow.id);
    expect(ids).toEqual(BUILTIN_WORKFLOWS.map((workflow) => workflow.id));
  });

  test("commit-bearing built-ins generate a message before asking to commit", () => {
    for (const id of ["commit-push", "ship-it"]) {
      const workflow = BUILTIN_WORKFLOWS.find((item) => item.id === id);
      expect(workflow?.steps.slice(0, 3)).toMatchObject([
        {
          kind: "agent",
          id: "commit-message",
          title: "Generate commit message",
        },
        {
          kind: "gate",
          id: "gate-commit",
          title: "Approve commit",
        },
        {
          kind: "action",
          id: "commit",
          op: "commit",
        },
      ]);
    }
  });

  test("a stored workflow with a built-in id replaces it (a fork)", () => {
    const fork: Workflow = {
      id: "ship-it",
      name: "My ship it",
      builtin: false,
      steps: [{ kind: "action", id: "push", title: "Push", op: "push" }],
    };
    const merged = listWorkflows([fork]);
    const shipIt = merged.find((workflow) => workflow.id === "ship-it");
    expect(shipIt?.name).toBe("My ship it");
    // still the same number of entries — replaced, not appended.
    expect(merged).toHaveLength(BUILTIN_WORKFLOWS.length);
  });

  test("a stored workflow with a new id is appended after the built-ins", () => {
    const custom: Workflow = {
      id: "my-flow",
      name: "Custom",
      steps: [{ kind: "gate", id: "g", title: "Wait", message: "OK?" }],
    };
    const merged = listWorkflows([custom]);
    expect(merged).toHaveLength(BUILTIN_WORKFLOWS.length + 1);
    expect(merged[merged.length - 1]?.id).toBe("my-flow");
  });

  test("rejects an unknown step kind", () => {
    expect(() =>
      workflowSchema.parse({
        id: "bad",
        name: "Bad",
        steps: [{ kind: "nope", id: "x", title: "x" }],
      }),
    ).toThrow();
  });

  test("agent steps can persist selected capabilities", () => {
    const workflow = workflowSchema.parse({
      id: "review-with-tools",
      name: "Review with tools",
      steps: [
        {
          kind: "agent",
          id: "review",
          title: "Review",
          prompt: "Review the staged diff.",
          capabilities: {
            skills: ["code-review"],
            mcpServers: ["github"],
            plugins: ["workflow-pack"],
            hooks: ["PreToolUse: Bash"],
          },
        },
      ],
    });

    expect(workflow.steps[0]).toMatchObject({
      kind: "agent",
      capabilities: {
        skills: ["code-review"],
        mcpServers: ["github"],
        plugins: ["workflow-pack"],
        hooks: ["PreToolUse: Bash"],
      },
    });
  });
});
