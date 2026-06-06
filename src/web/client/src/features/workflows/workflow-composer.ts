import type {
  Workflow,
  WorkflowCapabilities,
  WorkflowStep,
} from "@/lib/api";

export interface CapabilityOptions {
  skills: string[];
  mcpServers: string[];
  plugins: string[];
  hooks: string[];
}

export function draftWorkflowFromIntent(
  intent: string,
  existing: Workflow[],
  capabilities: CapabilityOptions,
): Workflow {
  const text = intent.trim();
  const lower = text.toLowerCase();
  const steps: WorkflowStep[] = [];
  const wantsReview = /\breview|check|inspect|audit\b/.test(lower);
  const wantsTests = /\btest|verify|ci\b/.test(lower);
  const wantsCommit = /\bcommit\b/.test(lower) || /\bship|push|pr|pull request\b/.test(lower);
  const wantsPush = /\bpush|ship|pr|pull request\b/.test(lower);
  const wantsPr = /\bpr\b|pull request/.test(lower);
  const selected = matchCapabilities(lower, capabilities);

  if (wantsReview) {
    steps.push(gate("gate-review", "Approve review", "Review the current changes?"));
    steps.push(
      agentStep(
        "review",
        "Review changes",
        "Review the current git changes. Summarize risks, likely bugs, and anything that should change before committing.",
        pickCapabilities(selected, ["skills", "mcpServers"]),
      ),
    );
  }

  if (wantsTests) {
    steps.push(
      agentStep(
        "verify",
        "Run verification",
        "Run the relevant tests or checks for this repository. If something fails, stop and explain the failure.",
        pickCapabilities(selected, ["skills", "mcpServers", "plugins"]),
      ),
    );
  }

  if (wantsCommit) {
    steps.push(gate("gate-commit", "Approve commit", "Create one commit from the current changes?"));
    steps.push(
      agentStep(
        "commit",
        "Commit changes",
        "Stage the appropriate changed files, inspect the staged diff briefly, and create one conventional commit.",
        pickCapabilities(selected, ["skills"]),
        "committed",
      ),
    );
  }

  if (wantsPush) {
    steps.push(gate("gate-push", "Approve push", wantsPr ? "Push and continue toward a PR?" : "Push this branch?"));
    steps.push({ kind: "action", id: "push", title: "Push branch", op: "push" });
  }

  if (wantsPr) {
    steps.push(
      agentStep(
        "open-pr",
        "Open PR",
        "Open a pull request for the current branch. Use the latest commit subject as the title and summarize the commit list in the body.",
        pickCapabilities(selected, ["mcpServers", "plugins"]),
      ),
    );
  }

  if (!steps.length) {
    steps.push(gate("gate-start", "Approve start", "Run this workflow?"));
    steps.push(agentStep("ai-step", "AI step", text || "Complete this workflow step.", selected));
  }

  return {
    id: uniqueWorkflowId(slugify(workflowName(lower)) || "custom-workflow", existing),
    name: workflowName(lower),
    description: text || "Custom AI-authored workflow.",
    builtin: false,
    steps: dedupeStepIds(steps),
  };
}

export function buildWorkflowAiDraftPrompt(intent: string): string {
  return [
    "Create a NoMoreIDE workflow from this user intent:",
    "",
    intent.trim() || "(no intent provided)",
    "",
    "Return a workflow JSON object only. Use this shape:",
    "{",
    '  "id": "short-kebab-id",',
    '  "name": "Human name",',
    '  "description": "One sentence",',
    '  "steps": [',
    '    { kind: "gate", id: "gate-id", title: "Approve thing", message: "Question for the user?" },',
    '    { kind: "agent", id: "ai-id", title: "AI task", prompt: "Clear instruction", capabilities: { skills: [], mcpServers: [], plugins: [], hooks: [] }, verify: "committed" },',
    '    { kind: "action", id: "push", title: "Push", op: "push" }',
    "  ]",
    "}",
    "",
    "Use gates before mutating git or GitHub state. Prefer intent-level AI steps over direct MCP tool calls.",
  ].join("\n");
}

function workflowName(lower: string): string {
  const review = /\breview|check|inspect|audit\b/.test(lower);
  const commit = /\bcommit\b|\bship|push|pr|pull request\b/.test(lower);
  const pr = /\bpr\b|pull request/.test(lower);
  const test = /\btest|verify|ci\b/.test(lower);
  if (review && commit && pr) return "Review, Commit & PR";
  if (test && commit && pr) return "Verify, Commit & PR";
  if (review && commit) return "Review & Commit";
  if (commit && pr) return "Commit & PR";
  if (commit) return "Commit workflow";
  if (review) return "Review workflow";
  return "Custom workflow";
}

function gate(id: string, title: string, message: string): WorkflowStep {
  return { kind: "gate", id, title, message };
}

function agentStep(
  id: string,
  title: string,
  prompt: string,
  capabilities?: WorkflowCapabilities,
  verify?: "committed" | "pushed",
): WorkflowStep {
  return { kind: "agent", id, title, prompt, capabilities: cleanCapabilities(capabilities), verify };
}

function matchCapabilities(lower: string, capabilities: CapabilityOptions): WorkflowCapabilities {
  return cleanCapabilities({
    skills: capabilities.skills.filter((item) => lower.includes(item.toLowerCase())),
    mcpServers: capabilities.mcpServers.filter((item) => lower.includes(item.toLowerCase())),
    plugins: capabilities.plugins.filter((item) => lower.includes(item.toLowerCase())),
    hooks: capabilities.hooks.filter((item) => lower.includes(item.toLowerCase())),
  }) ?? {};
}

function pickCapabilities(
  capabilities: WorkflowCapabilities,
  keys: Array<keyof WorkflowCapabilities>,
): WorkflowCapabilities | undefined {
  const picked: WorkflowCapabilities = {};
  for (const key of keys) {
    const values = capabilities[key];
    if (values?.length) picked[key] = values;
  }
  return cleanCapabilities(picked);
}

function cleanCapabilities(capabilities?: WorkflowCapabilities): WorkflowCapabilities | undefined {
  if (!capabilities) return undefined;
  const cleaned: WorkflowCapabilities = {};
  for (const key of ["skills", "mcpServers", "plugins", "hooks"] as const) {
    const values = Array.from(new Set((capabilities[key] ?? []).filter(Boolean)));
    if (values.length) cleaned[key] = values;
  }
  return Object.keys(cleaned).length ? cleaned : undefined;
}

function dedupeStepIds(steps: WorkflowStep[]): WorkflowStep[] {
  const counts = new Map<string, number>();
  return steps.map((step) => {
    const base = slugify(step.id) || step.kind;
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    return count === 0 ? { ...step, id: base } : { ...step, id: `${base}-${count + 1}` };
  });
}

function uniqueWorkflowId(base: string, workflows: Workflow[]): string {
  const used = new Set(workflows.map((workflow) => workflow.id));
  let candidate = base || "workflow";
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${base || "workflow"}-${suffix}`;
    suffix++;
  }
  return candidate;
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
