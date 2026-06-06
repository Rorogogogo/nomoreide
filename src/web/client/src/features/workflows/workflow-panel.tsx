import { useEffect, useState, type ReactNode } from "react";
import {
  AlertCircle,
  AlertTriangle,
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  Copy,
  Edit3,
  Loader2,
  MessageSquarePlus,
  Plus,
  Play,
  ShieldQuestion,
  SkipForward,
  Sparkles,
  Square,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import {
  deleteWorkflow,
  getAgentInfo,
  listWorkflows,
  saveWorkflow,
  type AgentInfo,
  type AgentProfile,
  type Workflow,
  type WorkflowCapabilities,
  type WorkflowStep,
} from "@/lib/api";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { AgentMark } from "../agent/ai-spark";
import { useAgentDock } from "../agent/chat/agent-context";
import {
  buildWorkflowAiDraftPrompt,
  draftWorkflowFromIntent,
  type CapabilityOptions,
} from "./workflow-composer";
import { useWorkflowRun } from "./workflow-run-context";
import type { RunState, StepStatus } from "./use-workflow-runner";

/**
 * The Workflows panel: your own git/GitHub rituals as one-click, gated,
 * visualized pipelines. Picking one runs it through {@link useWorkflowRunner};
 * the agent does the work down in the dock while this view shows where the run
 * is and pauses at each gate for your approval.
 */
export function WorkflowPanel() {
  const { run, start, approve, skip, stop, dismiss } = useWorkflowRun();
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [agentInfo, setAgentInfo] = useState<AgentInfo | null>(null);
  const [editing, setEditing] = useState<Workflow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Gates are the consent, so skip the agent's per-tool prompts by default —
  // irreversible footguns still surface in the dock regardless of this.
  const [autoApprove, setAutoApprove] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);
    void Promise.all([listWorkflows(), getAgentInfo().catch(() => null)])
      .then(([next, info]) => {
        if (!active) return;
        setWorkflows(next);
        setAgentInfo(info);
      })
      .catch((caught) => {
        if (active) setError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  function runWorkflow(workflow: Workflow) {
    // Runs in the background — the pipeline below is where you watch progress,
    // so we don't pop the dock open and pull attention away.
    void start(workflow, autoApprove);
  }

  async function saveEditedWorkflow(workflow: Workflow) {
    setError(null);
    try {
      const next = await saveWorkflow(workflow);
      setWorkflows(next);
      setEditing(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function removeSavedWorkflow(workflow: Workflow) {
    if (workflow.builtin) return;
    if (!window.confirm(`Delete workflow "${workflow.name}"?`)) return;
    setError(null);
    try {
      setWorkflows(await deleteWorkflow(workflow.id));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  function duplicateWorkflow(workflow: Workflow) {
    setEditing({
      ...workflow,
      id: uniqueWorkflowId(`${workflow.id}-copy`, workflows),
      name: `${workflow.name} copy`,
      builtin: false,
      steps: workflow.steps.map((step, index) => ({ ...step, id: `${step.id}-${index + 1}` })),
    });
  }

  if (run) {
    return (
      <RunView
        run={run}
        onApprove={approve}
        onSkip={skip}
        onStop={stop}
        onBack={dismiss}
      />
    );
  }

  if (editing) {
    return (
      <WorkflowBuilder
        agent={agentInfo ? activeAgentProfile(agentInfo) : null}
        existing={workflows}
        initial={editing}
        onCancel={() => setEditing(null)}
        onSave={(workflow) => void saveEditedWorkflow(workflow)}
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto bg-card/85">
      <div className="border-b border-border px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-1.5 text-[13px] font-semibold">
              <AgentMark className="size-4" /> AI Workflows
            </h2>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              One-click rituals that exceed the IDE — the agent does the work in the dock, pausing at each gate for your OK.
            </p>
          </div>
          <Button
            onClick={() => setEditing(createWorkflowDraft(workflows))}
            size="sm"
            type="button"
            variant="outline"
          >
            <Plus className="size-3.5" /> New
          </Button>
        </div>
        <label className="mt-2 flex w-fit items-center gap-1.5 text-[11px] text-muted-foreground">
          <input
            checked={autoApprove}
            className="size-3.5 accent-primary"
            onChange={(event) => setAutoApprove(event.target.checked)}
            type="checkbox"
          />
          Run without step-by-step prompts
          <span className="text-muted-foreground/60">— gates still pause; risky shell still asks.</span>
        </label>
      </div>

      {error ? (
        <Alert variant="destructive" className="m-4">
          {error}
        </Alert>
      ) : loading ? (
        <div className="flex flex-1 items-center justify-center text-[12px] text-muted-foreground">
          <Loader2 className="mr-2 size-4 animate-spin" /> Loading workflows…
        </div>
      ) : (
        <div className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-3">
          {workflows.map((workflow) => (
            <WorkflowCard
              key={workflow.id}
              workflow={workflow}
              onDelete={() => void removeSavedWorkflow(workflow)}
              onDuplicate={() => duplicateWorkflow(workflow)}
              onEdit={() => setEditing(workflow)}
              onRun={() => runWorkflow(workflow)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function WorkflowCard({
  workflow,
  onDelete,
  onDuplicate,
  onEdit,
  onRun,
}: {
  workflow: Workflow;
  onDelete: () => void;
  onDuplicate: () => void;
  onEdit: () => void;
  onRun: () => void;
}) {
  return (
    <div className="flex flex-col rounded-lg border border-border bg-background p-3.5 shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-[13px] font-semibold">{workflow.name}</h3>
        {workflow.builtin ? (
          <span className="rounded-full border border-border px-1.5 py-px text-[9px] uppercase tracking-wide text-muted-foreground">
            Template
          </span>
        ) : null}
      </div>
      {workflow.description ? (
        <p className="mt-1 text-[11px] leading-snug text-muted-foreground">{workflow.description}</p>
      ) : null}

      <ol className="mt-2.5 space-y-1">
        {workflow.steps.map((step) => (
          <li key={step.id} className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <StepKindDot kind={step.kind} />
            <span className="truncate">{stepTitle(step)}</span>
          </li>
        ))}
      </ol>

      <Button className="mt-3 w-full" onClick={onRun} size="sm" type="button">
        <Play className="size-3.5" /> Run
      </Button>
      <div className="mt-2 grid grid-cols-3 gap-1.5">
        <Button onClick={onEdit} size="sm" type="button" variant="outline">
          <Edit3 className="size-3.5" /> Edit
        </Button>
        <Button onClick={onDuplicate} size="sm" type="button" variant="outline">
          <Copy className="size-3.5" /> Copy
        </Button>
        <Button
          disabled={workflow.builtin}
          onClick={onDelete}
          size="sm"
          title={workflow.builtin ? "Duplicate or edit to create your own version first" : "Delete workflow"}
          type="button"
          variant="outline"
        >
          <Trash2 className="size-3.5" /> Delete
        </Button>
      </div>
    </div>
  );
}

function WorkflowBuilder({
  agent,
  existing,
  initial,
  onCancel,
  onSave,
}: {
  agent: AgentProfile | null;
  existing: Workflow[];
  initial: Workflow;
  onCancel: () => void;
  onSave: (workflow: Workflow) => void;
}) {
  const [draft, setDraft] = useState<Workflow>(() => structuredClone(initial));
  const [intent, setIntent] = useState(initial.description ?? "");
  const capabilities = capabilityOptions(agent);
  const { sendToAgent } = useAgentDock();
  const saveDisabled = !draft.id.trim() || !draft.name.trim() || draft.steps.length === 0;

  function updateStep(index: number, updater: (step: WorkflowStep) => WorkflowStep) {
    setDraft((current) => ({
      ...current,
      steps: current.steps.map((step, i) => (i === index ? updater(step) : step)),
    }));
  }

  function moveStep(index: number, direction: -1 | 1) {
    setDraft((current) => {
      const nextIndex = index + direction;
      if (nextIndex < 0 || nextIndex >= current.steps.length) return current;
      const steps = [...current.steps];
      const [step] = steps.splice(index, 1);
      steps.splice(nextIndex, 0, step);
      return { ...current, steps };
    });
  }

  function removeStep(index: number) {
    setDraft((current) => ({
      ...current,
      steps: current.steps.filter((_, i) => i !== index),
    }));
  }

  function composeDraft(nextIntent = intent) {
    const next = draftWorkflowFromIntent(nextIntent, existing, capabilities);
    setDraft(next);
  }

  function addStepFromIntent(input: string) {
    const generated = draftWorkflowFromIntent(input, [], capabilities);
    setDraft((current) => ({
      ...current,
      steps: [...current.steps, ...generated.steps],
    }));
  }

  function askAiToDraft() {
    sendToAgent({
      prompt: buildWorkflowAiDraftPrompt(intent || draft.description || draft.name),
      source: { type: "workflow", label: "Workflow composer" },
      mode: "draft",
    });
  }

  function save() {
    const id = slugify(draft.id) || uniqueWorkflowId(slugify(draft.name) || "workflow", existing);
    onSave({
      ...draft,
      id,
      name: draft.name.trim(),
      description: (intent || draft.description)?.trim() || undefined,
      builtin: false,
      steps: draft.steps.map(normalizeStep),
    });
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto bg-card/85">
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-1.5 text-[13px] font-semibold">
            <AgentMark className="size-4" /> Workflow Composer
          </h2>
          <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
            Describe the ritual. NoMoreIDE turns it into a gated timeline you can tune.
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <Button onClick={onCancel} size="sm" type="button" variant="outline">
            <ArrowLeft className="size-3.5" /> Back
          </Button>
          <Button disabled={saveDisabled} onClick={save} size="sm" type="button">
            <Check className="size-3.5" /> Save
          </Button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        <section className="shrink-0 border-b border-border p-4">
          <div className="grid gap-3 xl:grid-cols-[minmax(280px,0.9fr)_minmax(0,1.1fr)]">
            <div className="rounded-lg border border-border bg-background p-3 shadow-sm">
              <div className="flex items-center justify-between gap-2">
                <Label>Workflow identity</Label>
                <span className="font-mono text-[10px] text-muted-foreground">{draft.id}</span>
              </div>
              <input
                className="w-full bg-transparent text-lg font-semibold outline-none"
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    name: event.target.value,
                    id: slugify(event.target.value) || current.id,
                  }))
                }
                value={draft.name}
              />
            </div>

            <div className="rounded-lg border border-border bg-background p-3 shadow-sm">
              <Label>Describe workflow</Label>
              <textarea
                className="min-h-16 w-full resize-none bg-transparent text-[13px] leading-relaxed outline-none placeholder:text-muted-foreground"
                onChange={(event) => setIntent(event.target.value)}
                placeholder="Review my changes with code-review, ask before commit, push, then open a PR with GitHub..."
                value={intent}
              />
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <Button onClick={() => composeDraft()} size="sm" type="button">
                  <Sparkles className="size-3.5" /> Draft timeline
                </Button>
                <Button onClick={askAiToDraft} size="sm" type="button" variant="outline">
                  <MessageSquarePlus className="size-3.5" /> Ask AI
                </Button>
                {["Commit safely", "Review then push", "Fix CI then PR", "File issue from changes"].map((example) => (
                  <button
                    className="rounded-md border border-border bg-muted/30 px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    key={example}
                    onClick={() => {
                      setIntent(example);
                      composeDraft(example);
                    }}
                    type="button"
                  >
                    {example}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="mt-3 grid gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(280px,0.45fr)]">
            <CapabilityShelf capabilities={capabilities} />
            <AddStepComposer onAdd={addStepFromIntent} />
          </div>
        </section>

        <main className="min-h-0 flex-1 overflow-auto p-4">
          {draft.steps.length ? (
            <ol className="mx-auto max-w-6xl space-y-0">
              {draft.steps.map((step, index) => (
                <li className="relative pb-5 pl-14 last:pb-0" key={`${step.kind}:${step.id}`}>
                  <FlowNode index={index} kind={step.kind} />
                  {index === draft.steps.length - 1 ? null : <FlowConnector />}
                  <TimelineStepEditor
                    capabilities={capabilities}
                    index={index}
                    isFirst={index === 0}
                    isLast={index === draft.steps.length - 1}
                    onMove={moveStep}
                    onRemove={removeStep}
                    onUpdate={updateStep}
                    step={step}
                  />
                </li>
              ))}
            </ol>
          ) : (
            <div className="flex h-52 items-center justify-center rounded-lg border border-dashed border-border text-[12px] text-muted-foreground">
              Add a step to start.
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

function AddStepComposer({ onAdd }: { onAdd: (intent: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <form
      className="rounded-lg border border-dashed border-border bg-background/70 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        const trimmed = value.trim();
        if (!trimmed) return;
        onAdd(trimmed);
        setValue("");
      }}
    >
      <Label>Add a step</Label>
      <div className="flex gap-2">
        <input
          className="min-w-0 flex-1 bg-transparent text-[12px] outline-none placeholder:text-muted-foreground"
          onChange={(event) => setValue(event.target.value)}
          placeholder="ask before merge, run tests, open an issue..."
          value={value}
        />
        <Button size="sm" type="submit" variant="outline">
          <Plus className="size-3.5" /> Add
        </Button>
      </div>
    </form>
  );
}

function CapabilityShelf({ capabilities }: { capabilities: CapabilityOptions }) {
  const chips = [
    ...capabilities.skills.map((value) => `@skill:${value}`),
    ...capabilities.mcpServers.map((value) => `@mcp:${value}`),
    ...capabilities.plugins.map((value) => `@plugin:${value}`),
  ].slice(0, 18);
  if (!chips.length) return null;
  return (
    <div className="rounded-lg border border-border bg-background p-3">
      <Label>Detected capabilities</Label>
      <div className="flex max-h-20 flex-wrap gap-1.5 overflow-hidden">
        {chips.map((chip) => (
          <span
            className="rounded-md border border-border bg-muted/30 px-2 py-1 font-mono text-[11px] text-muted-foreground"
            key={chip}
          >
            {chip}
          </span>
        ))}
      </div>
    </div>
  );
}

function TimelineStepEditor({
  capabilities,
  index,
  isFirst,
  isLast,
  onMove,
  onRemove,
  onUpdate,
  step,
}: {
  capabilities: CapabilityOptions;
  index: number;
  isFirst: boolean;
  isLast: boolean;
  onMove: (index: number, direction: -1 | 1) => void;
  onRemove: (index: number) => void;
  onUpdate: (index: number, updater: (step: WorkflowStep) => WorkflowStep) => void;
  step: WorkflowStep;
}) {
  const body = stepBodyText(step);
  return (
    <section className="group rounded-lg border border-border bg-background p-3 shadow-sm">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <StepKindBadge kind={step.kind} />
            <input
              className="min-w-0 flex-1 bg-transparent text-[13px] font-semibold outline-none"
              onChange={(event) =>
                onUpdate(index, (current) => ({ ...current, title: event.target.value }))
              }
              value={step.title}
            />
          </div>
          <textarea
            className="mt-2 min-h-16 w-full resize-none bg-transparent text-[12px] leading-relaxed text-muted-foreground outline-none focus:text-foreground"
            onChange={(event) => {
              const value = event.target.value;
              onUpdate(index, (current) => updateStepBody(current, value));
            }}
            value={body}
          />
          {step.kind === "agent" ? (
            <CapabilityPicker
              capabilities={capabilities}
              selected={step.capabilities}
              onToggle={(key, value) =>
                onUpdate(index, (current) =>
                  current.kind === "agent"
                    ? { ...current, capabilities: toggleCapability(current.capabilities, key, value) }
                    : current,
                )
              }
            />
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1 opacity-70 transition-opacity group-hover:opacity-100">
          <Button
            disabled={isFirst}
            onClick={() => onMove(index, -1)}
            size="sm"
            type="button"
            variant="ghost"
          >
            ↑
          </Button>
          <Button
            disabled={isLast}
            onClick={() => onMove(index, 1)}
            size="sm"
            type="button"
            variant="ghost"
          >
            ↓
          </Button>
          <Button onClick={() => onRemove(index)} size="sm" type="button" variant="ghost">
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      </div>
    </section>
  );
}

function FlowNode({
  index,
  kind,
}: {
  index: number;
  kind: WorkflowStep["kind"];
}) {
  return (
    <div className="absolute left-0 top-2 z-10 flex size-9 items-center justify-center rounded-full border border-border bg-card shadow-sm">
      <span className="absolute -right-1 -top-1 flex size-4 items-center justify-center rounded-full border border-border bg-background font-mono text-[9px] text-muted-foreground">
        {index + 1}
      </span>
      <StepIcon kind={kind} />
    </div>
  );
}

function FlowConnector() {
  return (
    <svg
      aria-hidden
      className="absolute bottom-1 left-[18px] top-12 w-6 overflow-visible text-border"
      preserveAspectRatio="none"
      viewBox="0 0 24 100"
    >
      <title>Next step connector</title>
      <line
        stroke="currentColor"
        strokeDasharray="4 5"
        strokeLinecap="round"
        strokeWidth="2"
        x1="12"
        x2="12"
        y1="0"
        y2="82"
      />
      <path
        d="M6 78 L12 88 L18 78"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
    </svg>
  );
}

function CapabilityPicker({
  capabilities,
  onToggle,
  selected,
}: {
  capabilities: CapabilityOptions;
  onToggle: (key: CapabilityKey, value: string) => void;
  selected?: WorkflowCapabilities;
}) {
  const groups: Array<{ key: CapabilityKey; label: string; values: string[] }> = [
    { key: "skills", label: "Skills", values: capabilities.skills },
    { key: "mcpServers", label: "MCP", values: capabilities.mcpServers },
    { key: "plugins", label: "Plugins", values: capabilities.plugins },
    { key: "hooks", label: "Hooks", values: capabilities.hooks },
  ];

  return (
    <div className="space-y-2">
      <Label>Capabilities</Label>
      {groups.map((group) => (
        <div key={group.key}>
          <div className="mb-1 text-[10px] text-muted-foreground">{group.label}</div>
          {group.values.length ? (
            <div className="flex flex-wrap gap-1.5">
              {group.values.map((value) => {
                const active = selected?.[group.key]?.includes(value) ?? false;
                return (
                  <button
                    className={cn(
                      "rounded-md border px-2 py-1 text-[11px] transition-colors",
                      active
                        ? "border-primary/50 bg-primary/10 text-primary"
                        : "border-border bg-muted/30 text-muted-foreground hover:bg-muted",
                    )}
                    key={value}
                    onClick={() => onToggle(group.key, value)}
                    type="button"
                  >
                    {value}
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="text-[11px] text-muted-foreground/70">None detected.</p>
          )}
        </div>
      ))}
    </div>
  );
}

function RunView({
  run,
  onApprove,
  onSkip,
  onStop,
  onBack,
}: {
  run: RunState;
  onApprove: () => void;
  onSkip: () => void;
  onStop: () => void;
  onBack: () => void;
}) {
  const finished = run.outcome !== "running";
  // Which sections are expanded. The active step auto-expands (GitHub-Actions
  // style); gates and failures force open so their controls/errors always show.
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    const step = run.workflow.steps[run.index];
    const status = run.statuses[run.index];
    if (step && (status === "running" || status === "waiting")) {
      setOpen((current) => (current.has(step.id) ? current : new Set(current).add(step.id)));
    }
  }, [run.index, run.statuses, run.workflow.steps]);
  const toggle = (id: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto bg-card/85">
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-1.5 text-[13px] font-semibold">
            <AgentMark className="size-4" /> {run.workflow.name}
          </h2>
          <p className="mt-0.5 flex items-center gap-1 text-[11px] text-muted-foreground">
            <Terminal className="size-3" /> Watch the agent work in the dock below.
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <OutcomeBadge outcome={run.outcome} />
          {finished ? (
            <Button onClick={onBack} size="sm" type="button" variant="outline">
              <ArrowLeft className="size-3.5" /> Workflows
            </Button>
          ) : (
            <Button onClick={onStop} size="sm" type="button" variant="outline">
              <Square className="size-3.5" /> Stop
            </Button>
          )}
        </div>
      </div>

      <ol className="px-4 py-4">
        {run.workflow.steps.map((step, index) => {
          const status = run.statuses[index];
          const last = index === run.workflow.steps.length - 1;
          const isCurrentGate = step.kind === "gate" && status === "waiting";
          const expanded =
            open.has(step.id) || status === "waiting" || status === "failed" || status === "blocked";
          const active = status === "running" || status === "waiting";
          return (
            <li key={step.id} className="relative pb-3 pl-10 last:pb-0">
              {/* Rail connector to the next section. */}
              {last ? null : (
                <span
                  aria-hidden
                  className="absolute bottom-0 left-[19px] top-9 w-px bg-border"
                />
              )}
              {/* Status node sitting on the rail. */}
              <span
                className={cn(
                  "absolute left-1 top-1 flex size-8 items-center justify-center rounded-full border bg-card",
                  status === "failed"
                    ? "border-destructive/50"
                    : status === "blocked"
                      ? "border-amber-500/50"
                      : active
                        ? "border-primary/50"
                        : status === "done"
                          ? "border-emerald-500/50"
                          : "border-border",
                )}
              >
                <StatusIcon status={status} kind={step.kind} />
              </span>

              <section
                className={cn(
                  "overflow-hidden rounded-lg border transition-colors",
                  status === "failed"
                    ? "border-destructive/40 bg-destructive/[0.03]"
                    : status === "blocked"
                      ? "border-amber-500/40 bg-amber-500/[0.04]"
                      : active
                        ? "border-primary/40 bg-primary/[0.03]"
                        : "border-border bg-background",
                )}
              >
                <button
                  className="flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-muted/40"
                  onClick={() => toggle(step.id)}
                  type="button"
                >
                  <span className="min-w-0 flex-1 truncate text-[12px] font-medium">
                    {stepTitle(step)}
                  </span>
                  <StepKindBadge kind={step.kind} />
                  <span className="text-[10px] uppercase tracking-wide text-muted-foreground/70">
                    {statusLabel(status)}
                  </span>
                  {expanded ? (
                    <ChevronDown className="size-3.5 shrink-0 text-muted-foreground/60" />
                  ) : (
                    <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/60" />
                  )}
                </button>

                {expanded ? (
                  <div className="border-t border-border px-3 py-2.5 text-[11px] leading-relaxed">
                    <StepBody step={step} status={status} output={run.outputs[index]} />

                    {isCurrentGate ? (
                      <div className="mt-2.5 flex items-center gap-1.5">
                        <Button onClick={onApprove} size="sm" type="button">
                          <Check className="size-3.5" /> Approve
                        </Button>
                        <Button onClick={onSkip} size="sm" type="button" variant="outline">
                          <SkipForward className="size-3.5" /> Skip
                        </Button>
                        <Button onClick={onStop} size="sm" type="button" variant="outline">
                          <X className="size-3.5" /> Stop
                        </Button>
                      </div>
                    ) : null}

                    {status === "failed" && run.error ? (
                      <p className="mt-2 text-destructive">{run.error}</p>
                    ) : null}
                    {status === "blocked" && run.error ? (
                      <p className="mt-2 text-amber-700 dark:text-amber-400">{run.error}</p>
                    ) : null}
                  </div>
                ) : null}
              </section>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function statusLabel(status: StepStatus): string {
  if (status === "running") return "Running";
  if (status === "waiting") return "Waiting";
  if (status === "done") return "Done";
  if (status === "blocked") return "Needs you";
  if (status === "failed") return "Failed";
  if (status === "skipped") return "Skipped";
  return "Queued";
}

/**
 * The body of a step section. For an agent step this shows its *result* (the
 * agent's reply) once it's run — like a GitHub-Actions step log — and falls back
 * to the task description while it's still pending/running.
 */
function StepBody({
  step,
  status,
  output,
}: {
  step: WorkflowStep;
  status: StepStatus;
  output?: string;
}) {
  if (step.kind === "gate") {
    return <p className="text-muted-foreground">{step.message}</p>;
  }
  if (step.kind === "action") {
    return (
      <p className="text-muted-foreground">
        {step.op === "push"
          ? "Pushes the current branch to its remote."
          : "Stages and commits all changes."}
      </p>
    );
  }

  // Agent step.
  const ran = status === "done" || status === "failed" || status === "skipped";
  if (output) {
    return (
      <div>
        <Label>Result</Label>
        <div className="whitespace-pre-wrap break-words rounded-md bg-muted/50 px-2.5 py-2 font-mono text-[11px] text-foreground">
          {output}
        </div>
      </div>
    );
  }
  return (
    <div>
      <Label>{ran ? "Result" : "Task"}</Label>
      {ran ? (
        <p className="italic text-muted-foreground">
          No text reply — see the dock for what the agent did.
        </p>
      ) : (
        <>
          <p className="text-muted-foreground">{step.prompt}</p>
          {status === "running" ? (
            <p className="mt-1.5 flex items-center gap-1 text-muted-foreground/80">
              <Loader2 className="size-3 animate-spin" /> Working in the dock…
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

type CapabilityKey = keyof WorkflowCapabilities;

function activeAgentProfile(info: AgentInfo): AgentProfile {
  if (info.detected.name === "codex") return info.agents.codex;
  return info.agents["claude-code"] ?? info;
}

function capabilityOptions(agent: AgentProfile | null): CapabilityOptions {
  if (!agent) return { skills: [], mcpServers: [], plugins: [], hooks: [] };
  return {
    skills: unique(agent.skills.map((skill) => skill.name)),
    mcpServers: unique(agent.mcpServers.map((server) => server.name)),
    plugins: unique(agent.plugins.map((plugin) => plugin.name)),
    hooks: unique(
      agent.hooks.map((hook) =>
        hook.matcher ? `${hook.event}: ${hook.matcher}` : hook.event,
      ),
    ),
  };
}

function createWorkflowDraft(existing: Workflow[]): Workflow {
  const id = uniqueWorkflowId("custom-workflow", existing);
  return {
    id,
    name: "Custom workflow",
    description: "A user-built workflow.",
    builtin: false,
    steps: [
      {
        kind: "gate",
        id: "gate-start",
        title: "Approve start",
        message: "Run this workflow?",
      },
    ],
  };
}

function normalizeStep(step: WorkflowStep): WorkflowStep {
  const id = slugify(step.id) || step.kind;
  const title = step.title.trim() || stepTitle(step);
  if (step.kind === "gate") {
    return { ...step, id, title, message: step.message.trim() || "Continue?" };
  }
  if (step.kind === "action") {
    return { ...step, id, title };
  }
  const capabilities = normalizeCapabilities(step.capabilities);
  return {
    ...step,
    id,
    title,
    prompt: step.prompt.trim() || "Complete this workflow step.",
    capabilities,
  };
}

function stepBodyText(step: WorkflowStep): string {
  if (step.kind === "gate") return step.message;
  if (step.kind === "agent") return step.prompt;
  return step.op === "push" ? "Push the current branch to its remote." : "Stage and commit changed files.";
}

function updateStepBody(step: WorkflowStep, value: string): WorkflowStep {
  if (step.kind === "gate") return { ...step, message: value };
  if (step.kind === "agent") return { ...step, prompt: value };
  return {
    ...step,
    op: /\bpush\b/i.test(value) ? "push" : /\bcommit\b/i.test(value) ? "commit" : step.op,
    title: value.trim() || step.title,
  };
}

function normalizeCapabilities(capabilities?: WorkflowCapabilities): WorkflowCapabilities | undefined {
  if (!capabilities) return undefined;
  const normalized: WorkflowCapabilities = {};
  for (const key of ["skills", "mcpServers", "plugins", "hooks"] as const) {
    const values = unique((capabilities[key] ?? []).map((value) => value.trim()).filter(Boolean));
    if (values.length) normalized[key] = values;
  }
  return Object.keys(normalized).length ? normalized : undefined;
}

function toggleCapability(
  capabilities: WorkflowCapabilities | undefined,
  key: CapabilityKey,
  value: string,
): WorkflowCapabilities | undefined {
  const current = capabilities?.[key] ?? [];
  const next = current.includes(value)
    ? current.filter((item) => item !== value)
    : [...current, value];
  return normalizeCapabilities({ ...(capabilities ?? {}), [key]: next });
}

function uniqueWorkflowId(base: string, workflows: Workflow[]): string {
  const used = new Set(workflows.map((workflow) => workflow.id));
  let candidate = slugify(base) || "workflow";
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${slugify(base) || "workflow"}-${suffix}`;
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

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function Label({ children }: { children: ReactNode }) {
  return (
    <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
      {children}
    </div>
  );
}

function OutcomeBadge({ outcome }: { outcome: RunState["outcome"] }) {
  const map = {
    running: { label: "Running", className: "border-primary/40 text-primary" },
    done: { label: "Done", className: "border-emerald-500/40 text-emerald-600 dark:text-emerald-400" },
    stopped: { label: "Stopped", className: "border-border text-muted-foreground" },
    failed: { label: "Failed", className: "border-destructive/40 text-destructive" },
    blocked: { label: "Needs you", className: "border-amber-500/40 text-amber-700 dark:text-amber-400" },
  } as const;
  const { label, className } = map[outcome];
  return (
    <span className={cn("rounded-full border px-2 py-0.5 text-[10px] font-medium", className)}>
      {label}
    </span>
  );
}

function StepIcon({ kind }: { kind: WorkflowStep["kind"] }) {
  if (kind === "gate") return <ShieldQuestion className="size-4 text-amber-600 dark:text-amber-400" />;
  if (kind === "agent") return <Sparkles className="size-4 text-primary" />;
  return <Play className="size-4 text-muted-foreground" />;
}

function StatusIcon({ status, kind }: { status: StepStatus; kind: WorkflowStep["kind"] }) {
  if (status === "running") return <Loader2 className="size-4 shrink-0 animate-spin text-primary" />;
  if (status === "waiting") return <ShieldQuestion className="size-4 shrink-0 text-primary" />;
  if (status === "done") return <Check className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />;
  if (status === "blocked")
    return <AlertCircle className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />;
  if (status === "failed") return <AlertTriangle className="size-4 shrink-0 text-destructive" />;
  if (status === "skipped") return <SkipForward className="size-4 shrink-0 text-muted-foreground/60" />;
  // pending
  return kind === "agent" ? (
    <Sparkles className="size-4 shrink-0 text-muted-foreground/50" />
  ) : (
    <CircleDashed className="size-4 shrink-0 text-muted-foreground/50" />
  );
}

function StepKindDot(_props: { kind: WorkflowStep["kind"] }) {
  return <ChevronRight className="size-3 shrink-0 text-muted-foreground/40" aria-hidden />;
}

function StepKindBadge({ kind }: { kind: WorkflowStep["kind"] }) {
  const label = kind === "agent" ? "AI" : kind === "gate" ? "Gate" : "Auto";
  const className =
    kind === "agent"
      ? "border-primary/30 text-primary"
      : kind === "gate"
        ? "border-amber-500/40 text-amber-600 dark:text-amber-400"
        : "border-border text-muted-foreground";
  return (
    <span className={cn("shrink-0 rounded-full border px-1.5 py-px text-[9px] uppercase tracking-wide", className)}>
      {label}
    </span>
  );
}

function stepTitle(step: WorkflowStep): string {
  return step.title;
}
