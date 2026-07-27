import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const workflowPanelSource = readFileSync(
  resolve(__dirname, "../src/web/client/src/features/workflows/workflow-panel.tsx"),
  "utf8",
);
// UI copy now lives in the i18n catalog (t("...")), so rendered text is asserted
// against en.ts rather than the component source.
const catalog = readFileSync(
  resolve(__dirname, "../src/web/client/src/lib/i18n/en.ts"),
  "utf8",
);

describe("workflow run AI actions", () => {
  test("keeps one active or recent workflow reachable from the main workflows page", () => {
    expect(workflowPanelSource).toContain("viewingRun");
    expect(workflowPanelSource).toContain("WorkflowRunBanner");
    expect(catalog).toContain("View run");
    expect(catalog).toContain("Last workflow");
    expect(workflowPanelSource).toContain("formatRunTimestamp");
    expect(workflowPanelSource).toContain("lastRun={run?.workflow.id === workflow.id ? run : null}");
    expect(workflowPanelSource).toMatch(/onBack=\{\(\) => setViewingRun\(false\)\}/);
  });

  test("offers AI debug for blocked or failed workflow steps", () => {
    expect(catalog).toContain("Debug this workflow step with AI");
    expect(workflowPanelSource).toContain("buildWorkflowStepDebugPrompt");
    expect(workflowPanelSource).toContain('id: "debug-workflow-step"');
    expect(workflowPanelSource).toContain('source: { type: "workflow-debug"');
    expect(workflowPanelSource).not.toContain("background: true");
    expect(workflowPanelSource).toContain('selectedStatus === "failed" || selectedStatus === "blocked"');
  });

  test("keeps a stop control in the active step detail", () => {
    expect(workflowPanelSource).toContain('aria-label={t("workflows.run.stopAria")}');
    expect(catalog).toContain("Stop workflow run from step detail");
    expect(catalog).toContain("Stop after this step");
  });

  test("lets a blocked PR branch guard recover through an AI-native branch flow", () => {
    expect(workflowPanelSource).toContain("PrBranchRecovery");
    expect(catalog).toContain("Recommend branch with AI");
    expect(catalog).toContain("Recommended branch");
    expect(catalog).toContain("Create this branch");
    expect(catalog).toContain("Ask for another");
    expect(workflowPanelSource).toContain("runHeadlessAgentTask");
    expect(workflowPanelSource).toContain("gitCreateBranch");
    expect(workflowPanelSource).toContain("parseRecommendedBranchName");
    expect(workflowPanelSource).toContain("branchRecoveryInProgress");
    expect(workflowPanelSource).toContain("!branchRecoveryInProgress");
    expect(workflowPanelSource).toContain("buildPrBranchRecoveryPrompt");
    expect(workflowPanelSource).not.toContain("latestAssistantTextAfter");
    expect(workflowPanelSource).not.toContain("Open agent");
    expect(workflowPanelSource).toMatch(
      /canRecoverPrBranch[\s\S]*?selectedStatus === "blocked"[\s\S]*?selectedStep\.op === "assert-pr-branch"/,
    );
    expect(workflowPanelSource).toContain('selectedStep.op === "assert-pr-branch"');
    expect(workflowPanelSource).toContain("onRestart");
    expect(workflowPanelSource).not.toContain("feature/my-change");
    expect(workflowPanelSource).not.toContain("Create & run again");
    expect(workflowPanelSource).not.toContain("Agent response");
    expect(workflowPanelSource).not.toContain("<details");
    expect(workflowPanelSource).not.toContain("AI details");
  });
});
