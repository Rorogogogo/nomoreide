import type { WorkflowCapabilities } from "@/lib/api";

export function buildAgentWorkflowPrompt(step: {
  prompt: string;
  capabilities?: WorkflowCapabilities;
}): string {
  const guidance = capabilityGuidance(step.capabilities);
  return guidance ? `${step.prompt}\n\n${guidance}` : step.prompt;
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
