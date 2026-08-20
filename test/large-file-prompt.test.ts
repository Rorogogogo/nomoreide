import { describe, expect, test } from "vitest";
import { buildLargeFileSplitPrompt } from "../apps/dashboard/src/features/agent/prompts/large-file";

describe("large file prompts", () => {
  test("asks the agent for a structural split with both file paths", () => {
    const prompt = buildLargeFileSplitPrompt({
      absolutePath: "/repo/src/core/process-manager.ts",
      lines: 1260,
      relativePath: "src/core/process-manager.ts",
    });

    expect(prompt).toContain("structurally split");
    expect(prompt).toContain("src/core/process-manager.ts");
    expect(prompt).toContain("/repo/src/core/process-manager.ts");
    expect(prompt).toContain("1,260 lines");
    expect(prompt).toContain("preserve behavior");
  });
});
