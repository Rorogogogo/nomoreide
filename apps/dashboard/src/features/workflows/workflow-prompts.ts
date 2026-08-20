import type { WorkflowCapabilities, WorkflowStep } from "@/lib/api";
import type { StepStatus } from "./use-workflow-runner";

export function buildAgentWorkflowPrompt(step: {
  prompt: string;
  capabilities?: WorkflowCapabilities;
}): string {
  const guidance = capabilityGuidance(step.capabilities);
  return guidance ? `${step.prompt}\n\n${guidance}` : step.prompt;
}

export function buildWorkflowStepDebugPrompt({
  workflowName,
  step,
  status,
  error,
  previousOutput,
  output,
}: {
  workflowName: string;
  step: WorkflowStep;
  status: StepStatus;
  error?: string | null;
  previousOutput?: string;
  output?: string;
}): string {
  const lines = [
    "Debug this stuck NoMoreIDE workflow step.",
    "",
    `Workflow: ${workflowName}`,
    `Step: ${step.title}`,
    `Step id: ${step.id}`,
    `Kind: ${step.kind}`,
    `Status: ${status}`,
    "",
    "Step instruction:",
    workflowStepInstruction(step),
  ];

  if (error?.trim()) {
    lines.push("", "Runner error:", error.trim());
  }
  if (previousOutput?.trim()) {
    lines.push("", "Previous step output:", previousOutput.trim());
  }
  if (output?.trim()) {
    lines.push("", "This step output:", output.trim());
  }

  lines.push(
    "",
    "Diagnose why the step is stuck, name the smallest safe next action, and tell me whether I should retry, edit the workflow, or stop.",
  );
  return lines.join("\n");
}

export function buildPrBranchRecoveryPrompt({
  workflowName,
  error,
}: {
  workflowName: string;
  error?: string | null;
}): string {
  return [
    "Recover this NoMoreIDE PR workflow from the default branch guard.",
    "",
    `Workflow: ${workflowName}`,
    error?.trim() ? `Runner error: ${error.trim()}` : "",
    "",
    "The user approved reading the minimum file diffs needed by clicking the workflow recovery button.",
    "First call `nomoreide_git_status` to see the changed files and current branch.",
    "Inspect only the minimum needed with `nomoreide_git_diff` to understand the change.",
    "Then recommend a concise branch name based on the changes.",
    "Do not create the branch or ask the user to create it; the workflow panel will ask the user and run the branch creation.",
    "Reply with a short rationale and this exact parseable line:",
    "BRANCH_NAME: <branch-name>",
  ].filter(Boolean).join("\n");
}

function capabilityGuidance(capabilities?: WorkflowCapabilities): string {
  if (!capabilities) return "";
  const lines = [
    capabilityLine("Skills", capabilities.skills),
    capabilityLine("MCP servers", capabilities.mcpServers),
    capabilityLine("Plugins", capabilities.plugins),
    capabilityLine("Hooks/context", capabilities.hooks),
  ].filter(Boolean);
  if (!lines.length) return "";
  return [
    "Use these selected capabilities if they are available and relevant:",
    ...lines,
    "If a selected capability is unavailable, say so briefly and continue with the best fallback.",
  ].join("\n");
}

function capabilityLine(label: string, values?: string[]): string {
  const clean = Array.from(new Set((values ?? []).map((value) => value.trim()).filter(Boolean)));
  return clean.length ? `- ${label}: ${clean.join(", ")}` : "";
}

function workflowStepInstruction(step: WorkflowStep): string {
  if (step.kind === "agent") return step.prompt;
  if (step.kind === "gate") return `Gate: ${step.message}`;
  return `Action: ${step.op}`;
}
