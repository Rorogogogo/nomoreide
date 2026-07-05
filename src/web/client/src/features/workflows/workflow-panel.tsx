import { Fragment, useEffect, useState, type ReactNode } from "react";
import {
  AlertCircle,
  AlertTriangle,
  ArrowLeft,
  Check,
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
  gitCreateBranch,
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
import { useT } from "@/lib/i18n";
import type { TranslationKey } from "@/lib/i18n/en";
import { AgentMark } from "../agent/ai-spark";
import { useAgentDock } from "../agent/chat/agent-context";
import {
  buildWorkflowAiDraftPrompt,
  draftWorkflowFromIntent,
  type CapabilityOptions,
} from "./workflow-composer";
import {
  buildPrBranchRecoveryPrompt,
  buildWorkflowStepDebugPrompt,
} from "./workflow-prompts";
import { parseRecommendedBranchName } from "./workflow-result";
import { TriggersSection } from "./triggers-section";
import { useWorkflowRun } from "./workflow-run-context";
import type { RunState, StepStatus } from "./use-workflow-runner";

/**
 * The Workflows panel: your own git/GitHub rituals as one-click, gated,
 * visualized pipelines. Picking one runs it through {@link useWorkflowRunner};
 * the agent does the work down in the dock while this view shows where the run
 * is and pauses at each gate for your approval.
 */
export function WorkflowPanel() {
  const t = useT();
  const { run, start, resume, approve, skip, stop, dismiss } = useWorkflowRun();
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [agentInfo, setAgentInfo] = useState<AgentInfo | null>(null);
  const [editing, setEditing] = useState<Workflow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [viewingRun, setViewingRun] = useState(false);
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
    setViewingRun(true);
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
    if (!window.confirm(t("workflows.deleteConfirm", { name: workflow.name }))) return;
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

  if (run && viewingRun) {
    return (
      <RunView
        run={run}
        onApprove={approve}
        onSkip={skip}
        onStop={stop}
        onBack={() => setViewingRun(false)}
        onResume={() => {
          setViewingRun(true);
          resume(autoApprove);
        }}
        onRestart={() => {
          setViewingRun(true);
          void start(run.workflow, autoApprove);
        }}
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
              <AgentMark className="size-4" /> {t("workflows.title")}
            </h2>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              {t("workflows.subtitle")}
            </p>
          </div>
          <Button
            onClick={() => setEditing(createWorkflowDraft(workflows))}
            size="sm"
            type="button"
            variant="outline"
          >
            <Plus className="size-3.5" /> {t("workflows.new")}
          </Button>
        </div>
        <label className="mt-2 flex w-fit items-center gap-1.5 text-[11px] text-muted-foreground">
          <input
            checked={autoApprove}
            className="size-3.5 accent-primary"
            onChange={(event) => setAutoApprove(event.target.checked)}
            type="checkbox"
          />
          {t("workflows.autoApprove")}
          <span className="text-muted-foreground/60">{t("workflows.autoApproveHint")}</span>
        </label>
      </div>

      {error ? (
        <Alert variant="destructive" className="m-4">
          {error}
        </Alert>
      ) : loading ? (
        <div className="flex flex-1 items-center justify-center text-[12px] text-muted-foreground">
          <Loader2 className="mr-2 size-4 animate-spin" /> {t("workflows.loading")}
        </div>
      ) : (
        <>
          {run ? (
            <WorkflowRunBanner
              onClear={dismiss}
              onView={() => setViewingRun(true)}
              run={run}
            />
          ) : null}
          <div className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-3">
            {workflows.map((workflow) => (
              <WorkflowCard
                key={workflow.id}
                lastRun={run?.workflow.id === workflow.id ? run : null}
                workflow={workflow}
                onDelete={() => void removeSavedWorkflow(workflow)}
                onDuplicate={() => duplicateWorkflow(workflow)}
                onEdit={() => setEditing(workflow)}
                onRun={() => runWorkflow(workflow)}
              />
            ))}
          </div>
          <TriggersSection workflows={workflows} />
        </>
      )}
    </div>
  );
}

function WorkflowRunBanner({
  onClear,
  onView,
  run,
}: {
  onClear: () => void;
  onView: () => void;
  run: RunState;
}) {
  const t = useT();
  const running = run.outcome === "running";
  return (
    <section className="mx-4 mt-4 rounded-md border border-border bg-background p-3 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
              {running ? t("workflows.banner.running") : t("workflows.banner.last")}
            </span>
            <OutcomeBadge outcome={run.outcome} />
          </div>
          <p className="mt-1 truncate text-[13px] font-medium">{run.workflow.name}</p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {running
              ? t("workflows.banner.startedAt", { time: formatRunTimestamp(run.startedAt) })
              : t("workflows.banner.ranAt", { time: formatRunTimestamp(run.startedAt) })}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Button onClick={onView} size="sm" type="button">
            <Terminal className="size-3.5" /> {t("workflows.viewRun")}
          </Button>
          {!running ? (
            <Button onClick={onClear} size="sm" type="button" variant="outline">
              <X className="size-3.5" /> {t("workflows.clear")}
            </Button>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function WorkflowCard({
  lastRun,
  workflow,
  onDelete,
  onDuplicate,
  onEdit,
  onRun,
}: {
  lastRun?: RunState | null;
  workflow: Workflow;
  onDelete: () => void;
  onDuplicate: () => void;
  onEdit: () => void;
  onRun: () => void;
}) {
  const t = useT();
  // Steps stay collapsed by default so a wall of cards reads as a clean list;
  // expand to peek at the pipeline without opening the editor.
  const [stepsOpen, setStepsOpen] = useState(false);
  const stepCount = workflow.steps.length;
  return (
    <div className="flex flex-col rounded-lg border border-border bg-background p-3.5 shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-[13px] font-semibold">{workflow.name}</h3>
        {workflow.builtin ? (
          <span className="rounded-full border border-border px-1.5 py-px text-[9px] uppercase tracking-wide text-muted-foreground">
            {t("workflows.template")}
          </span>
        ) : null}
      </div>
      {workflow.description ? (
        <p className="mt-1 text-[11px] leading-snug text-muted-foreground">{workflow.description}</p>
      ) : null}
      {lastRun ? (
        <p className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Terminal className="size-3" />
          {lastRun.outcome === "running"
            ? t("workflows.runningNow")
            : t("workflows.lastRun", { time: formatRunTimestamp(lastRun.startedAt) })}
        </p>
      ) : null}

      <button
        aria-expanded={stepsOpen}
        className="mt-2.5 flex w-full items-center gap-1.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
        onClick={() => setStepsOpen((open) => !open)}
        type="button"
      >
        <ChevronRight
          className={cn("size-3 shrink-0 transition-transform", stepsOpen ? "rotate-90" : "")}
          aria-hidden
        />
        <span>
          {t(stepCount === 1 ? "workflows.stepOne" : "workflows.stepMany", { count: stepCount })}
        </span>
      </button>
      {stepsOpen ? (
        <ol className="mt-1.5 space-y-1">
          {workflow.steps.map((step) => (
            <li key={step.id} className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <StepKindDot kind={step.kind} />
              <span className="truncate">{stepTitle(step)}</span>
            </li>
          ))}
        </ol>
      ) : null}

      <Button className="mt-3 w-full" onClick={onRun} size="sm" type="button">
        <Play className="size-3.5" /> {t("workflows.run")}
      </Button>
      <div className="mt-2 grid grid-cols-3 gap-1.5">
        <Button onClick={onEdit} size="sm" type="button" variant="outline">
          <Edit3 className="size-3.5" /> {t("common.edit")}
        </Button>
        <Button onClick={onDuplicate} size="sm" type="button" variant="outline">
          <Copy className="size-3.5" /> {t("common.copy")}
        </Button>
        <Button
          disabled={workflow.builtin}
          onClick={onDelete}
          size="sm"
          title={workflow.builtin ? t("workflows.deleteBuiltinHint") : t("workflows.deleteTitle")}
          type="button"
          variant="outline"
        >
          <Trash2 className="size-3.5" /> {t("common.delete")}
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
  const t = useT();
  const [draft, setDraft] = useState<Workflow>(() => structuredClone(initial));
  const [intent, setIntent] = useState(initial.description ?? "");
  // The canvas is the point — keep the AI-compose controls tucked away by
  // default so the graph owns the space.
  const [composeOpen, setComposeOpen] = useState(false);
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

  function insertStep(index: number, kind: WorkflowStep["kind"]) {
    setDraft((current) => {
      const steps = [...current.steps];
      steps.splice(index, 0, newStep(kind, current.steps));
      return { ...current, steps };
    });
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
      source: { type: "workflow", label: t("workflows.builder.composerSource") },
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
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-card/85">
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <AgentMark className="size-4 shrink-0" />
          <div className="min-w-0">
            <input
              aria-label={t("workflows.builder.nameAria")}
              className="w-full bg-transparent text-[14px] font-semibold outline-none"
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  name: event.target.value,
                  id: slugify(event.target.value) || current.id,
                }))
              }
              placeholder={t("workflows.builder.namePlaceholder")}
              value={draft.name}
            />
            <span className="font-mono text-[10px] text-muted-foreground">{draft.id}</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            onClick={() => setComposeOpen((open) => !open)}
            size="sm"
            type="button"
            variant={composeOpen ? "default" : "outline"}
          >
            <Sparkles className="size-3.5" /> {t("workflows.builder.aiCompose")}
          </Button>
          <Button onClick={onCancel} size="sm" type="button" variant="outline">
            <ArrowLeft className="size-3.5" /> {t("common.back")}
          </Button>
          <Button disabled={saveDisabled} onClick={save} size="sm" type="button">
            <Check className="size-3.5" /> {t("common.save")}
          </Button>
        </div>
      </div>

      {composeOpen ? (
        <section className="shrink-0 border-b border-border bg-muted/20 p-4">
          <div className="grid gap-3 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
            <div className="rounded-lg border border-border bg-background p-3 shadow-sm">
              <Label>{t("workflows.builder.describe")}</Label>
              <textarea
                className="min-h-16 w-full resize-none bg-transparent text-[13px] leading-relaxed outline-none placeholder:text-muted-foreground"
                onChange={(event) => setIntent(event.target.value)}
                placeholder={t("workflows.builder.describePlaceholder")}
                value={intent}
              />
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <Button onClick={() => composeDraft()} size="sm" type="button">
                  <Sparkles className="size-3.5" /> {t("workflows.builder.draftTimeline")}
                </Button>
                <Button onClick={askAiToDraft} size="sm" type="button" variant="outline">
                  <MessageSquarePlus className="size-3.5" /> {t("workflows.builder.askAi")}
                </Button>
                {/* Seed phrases stay English — the composer matches them against
                    English keyword regexes to build the timeline. */}
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
            <div className="grid gap-3">
              <AddStepComposer onAdd={addStepFromIntent} />
              <CapabilityShelf capabilities={capabilities} />
            </div>
          </div>
        </section>
      ) : null}

      <main className="min-h-0 flex-1 overflow-auto p-4">
        <div className="mx-auto max-w-3xl">
          <StepInserter onInsert={(kind) => insertStep(0, kind)} />
          {draft.steps.length ? (
            draft.steps.map((step, index) => (
              <Fragment key={`${step.kind}:${step.id}`}>
                <div className="flex gap-4">
                  <div className="relative flex w-9 shrink-0 justify-center pt-2">
                    <span
                      aria-hidden
                      className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border"
                    />
                    <NodeBadge index={index} kind={step.kind} />
                  </div>
                  <div className="min-w-0 flex-1 pb-1">
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
                  </div>
                </div>
                <StepInserter onInsert={(kind) => insertStep(index + 1, kind)} />
              </Fragment>
            ))
          ) : (
            <div className="ml-[3.25rem] flex h-24 items-center justify-center rounded-lg border border-dashed border-border text-[12px] text-muted-foreground">
              {t("workflows.builder.emptyCanvas")}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

/**
 * The "+" affordance that lives on the graph rail between nodes. Click it to pick
 * a step kind and drop a fresh node at that position — this is how a workflow is
 * built by hand on the canvas.
 */
function StepInserter({
  defaultOpen = false,
  onInsert,
}: {
  defaultOpen?: boolean;
  onInsert: (kind: WorkflowStep["kind"]) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(defaultOpen);
  const kinds: Array<WorkflowStep["kind"]> = ["gate", "agent", "action"];
  return (
    <div className="flex gap-4">
      <div className="relative flex w-9 shrink-0 justify-center">
        <span aria-hidden className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border" />
        <button
          aria-label={open ? t("workflows.builder.cancelAddStep") : t("workflows.builder.addStepHere")}
          className={cn(
            "relative z-10 my-1.5 flex size-5 items-center justify-center rounded-full border bg-card text-muted-foreground transition-colors",
            open ? "border-primary/50 text-primary" : "border-border hover:border-primary/50 hover:text-primary",
          )}
          onClick={() => setOpen((value) => !value)}
          type="button"
        >
          {open ? <X className="size-3" /> : <Plus className="size-3" />}
        </button>
      </div>
      <div className="flex-1 py-1">
        {open ? (
          <div className="flex flex-wrap items-center gap-1.5">
            {kinds.map((kind) => (
              <button
                className="flex items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
                key={kind}
                onClick={() => {
                  onInsert(kind);
                  setOpen(false);
                }}
                type="button"
              >
                <StepIcon kind={kind} /> {t(KIND_LABEL_KEY[kind])}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function NodeBadge({ index, kind }: { index: number; kind: WorkflowStep["kind"] }) {
  return (
    <div className="relative z-10 flex size-9 items-center justify-center rounded-full border border-border bg-card shadow-sm">
      <span className="absolute -right-1 -top-1 flex size-4 items-center justify-center rounded-full border border-border bg-background font-mono text-[9px] text-muted-foreground">
        {index + 1}
      </span>
      <StepIcon kind={kind} />
    </div>
  );
}

function newStep(kind: WorkflowStep["kind"], existing: WorkflowStep[]): WorkflowStep {
  const used = new Set(existing.map((step) => step.id));
  const id = (base: string) => {
    let candidate = base;
    let suffix = 2;
    while (used.has(candidate)) candidate = `${base}-${suffix++}`;
    return candidate;
  };
  if (kind === "gate") {
    return { kind: "gate", id: id("gate"), title: "Approve step", message: "Continue?" };
  }
  if (kind === "action") {
    return { kind: "action", id: id("action"), title: "Commit with approved message", op: "commit" };
  }
  return { kind: "agent", id: id("step"), title: "AI step", prompt: "" };
}

function AddStepComposer({ onAdd }: { onAdd: (intent: string) => void }) {
  const t = useT();
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
      <Label>{t("workflows.builder.addStepLabel")}</Label>
      <div className="flex gap-2">
        <input
          className="min-w-0 flex-1 bg-transparent text-[12px] outline-none placeholder:text-muted-foreground"
          onChange={(event) => setValue(event.target.value)}
          placeholder={t("workflows.builder.addStepPlaceholder")}
          value={value}
        />
        <Button size="sm" type="submit" variant="outline">
          <Plus className="size-3.5" /> {t("common.add")}
        </Button>
      </div>
    </form>
  );
}

function CapabilityShelf({ capabilities }: { capabilities: CapabilityOptions }) {
  const t = useT();
  const chips = [
    ...capabilities.skills.map((value) => `@skill:${value}`),
    ...capabilities.mcpServers.map((value) => `@mcp:${value}`),
    ...capabilities.plugins.map((value) => `@plugin:${value}`),
  ].slice(0, 18);
  if (!chips.length) return null;
  return (
    <div className="rounded-lg border border-border bg-background p-3">
      <Label>{t("workflows.builder.detectedCapabilities")}</Label>
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
  const t = useT();
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
          {step.kind === "gate" ? (
            <textarea
              className="mt-2 min-h-12 w-full resize-none bg-transparent text-[12px] leading-relaxed text-muted-foreground outline-none focus:text-foreground"
              onChange={(event) =>
                onUpdate(index, (current) =>
                  current.kind === "gate" ? { ...current, message: event.target.value } : current,
                )
              }
              placeholder={t("workflows.builder.gatePlaceholder")}
              value={step.message}
            />
          ) : step.kind === "action" ? (
            <div className="mt-2 space-y-1.5">
              <select
                className="w-full rounded-md border border-border bg-background px-2 py-1 text-[12px] outline-none"
                onChange={(event) => {
                  const op = event.target.value as Extract<WorkflowStep, { kind: "action" }>["op"];
                  onUpdate(index, (current) =>
                    current.kind === "action" ? { ...current, op } : current,
                  );
                }}
                value={step.op}
              >
                <option value="commit">{t("workflows.op.commit")}</option>
                <option value="push">{t("workflows.op.push")}</option>
                <option value="assert-pr-branch">{t("workflows.op.assertPrBranch")}</option>
                <option value="checkout-default-and-pull">{t("workflows.op.checkoutDefault")}</option>
              </select>
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                {t(ACTION_DESC_KEY[step.op])}
              </p>
            </div>
          ) : (
            <>
              <textarea
                className="mt-2 min-h-16 w-full resize-none bg-transparent text-[12px] leading-relaxed text-muted-foreground outline-none focus:text-foreground"
                onChange={(event) =>
                  onUpdate(index, (current) =>
                    current.kind === "agent" ? { ...current, prompt: event.target.value } : current,
                  )
                }
                placeholder={t("workflows.builder.agentPromptPlaceholder")}
                value={step.prompt}
              />
              <label className="mt-2 flex w-fit items-center gap-1.5 text-[11px] text-muted-foreground">
                <input
                  checked={step.isolated ?? false}
                  className="size-3.5 accent-primary"
                  onChange={(event) =>
                    onUpdate(index, (current) =>
                      current.kind === "agent"
                        ? { ...current, isolated: event.target.checked }
                        : current,
                    )
                  }
                  type="checkbox"
                />
                {t("workflows.builder.freshSession")}
                <span className="text-muted-foreground/60">
                  {t("workflows.builder.freshSessionHint")}
                </span>
              </label>
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
            </>
          )}
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

function CapabilityPicker({
  capabilities,
  onToggle,
  selected,
}: {
  capabilities: CapabilityOptions;
  onToggle: (key: CapabilityKey, value: string) => void;
  selected?: WorkflowCapabilities;
}) {
  const t = useT();
  const groups: Array<{ key: CapabilityKey; label: string; values: string[] }> = [
    { key: "skills", label: "Skills", values: capabilities.skills },
    { key: "mcpServers", label: "MCP", values: capabilities.mcpServers },
    { key: "plugins", label: "Plugins", values: capabilities.plugins },
    { key: "hooks", label: "Hooks", values: capabilities.hooks },
  ];

  return (
    <div className="space-y-2">
      <Label>{t("workflows.builder.capabilities")}</Label>
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
            <p className="text-[11px] text-muted-foreground/70">{t("workflows.builder.noneDetected")}</p>
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
  onResume,
  onRestart,
}: {
  run: RunState;
  onApprove: () => void;
  onSkip: () => void;
  onStop: () => void;
  onBack: () => void;
  onResume: () => void;
  onRestart: () => void;
}) {
  const t = useT();
  const { sendToAgent } = useAgentDock();
  const finished = run.outcome !== "running";
  const [selectedIndex, setSelectedIndex] = useState(run.index);
  useEffect(() => {
    setSelectedIndex(run.index);
  }, [run.index]);

  const selectedStep = run.workflow.steps[selectedIndex] ?? run.workflow.steps[run.index];
  const selectedStatus = run.statuses[selectedIndex] ?? "pending";
  const selectedOutput = run.outputs[selectedIndex];
  const previousOutput = run.outputs[selectedIndex - 1];
  const isCurrentGate = selectedStep?.kind === "gate" && selectedStatus === "waiting";
  const canDebugSelectedStep = selectedStatus === "failed" || selectedStatus === "blocked";
  const canRecoverPrBranch =
    selectedStatus === "blocked" &&
    selectedStep?.kind === "action" &&
    selectedStep.op === "assert-pr-branch";

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-card/85">
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-1.5 text-[13px] font-semibold">
            <AgentMark className="size-4" /> {run.workflow.name}
          </h2>
          <p className="mt-0.5 flex items-center gap-1 text-[11px] text-muted-foreground">
            <Terminal className="size-3" /> {t("workflows.run.watchDock")}
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <OutcomeBadge outcome={run.outcome} />
          <Button onClick={onBack} size="sm" type="button" variant="outline">
            <ArrowLeft className="size-3.5" /> {t("workflows.run.workflows")}
          </Button>
          {!finished ? (
            <Button onClick={onStop} size="sm" type="button" variant="outline">
              <Square className="size-3.5" /> {t("common.stop")}
            </Button>
          ) : null}
        </div>
      </div>

      <div className="grid min-h-0 flex-1 overflow-hidden lg:grid-cols-[minmax(240px,320px)_minmax(0,1fr)]">
        <aside className="min-h-0 overflow-auto border-b border-border bg-background/55 p-3 lg:border-b-0 lg:border-r">
          <ol className="space-y-1">
            {run.workflow.steps.map((step, index) => {
              const status = run.statuses[index];
              const active = status === "running" || status === "waiting";
              const selected = index === selectedIndex;
              return (
                <li key={step.id}>
                  <button
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md border px-2.5 py-2 text-left transition-colors",
                      selected
                        ? "border-primary/45 bg-primary/[0.06]"
                        : active
                          ? "border-primary/30 bg-primary/[0.03]"
                          : "border-transparent hover:border-border hover:bg-muted/40",
                    )}
                    onClick={() => setSelectedIndex(index)}
                    type="button"
                  >
                    <span
                      className={cn(
                        "flex size-7 shrink-0 items-center justify-center rounded-full border bg-card",
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
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12px] font-medium">{stepTitle(step)}</span>
                      <span className="mt-0.5 flex items-center gap-1.5">
                        <StepKindBadge kind={step.kind} />
                        <span className="text-[10px] uppercase tracking-wide text-muted-foreground/70">
                          {t(STATUS_LABEL_KEY[status])}
                        </span>
                      </span>
                    </span>
                    <ChevronRight
                      className={cn(
                        "size-3.5 shrink-0 text-muted-foreground/50 transition-transform",
                        selected ? "translate-x-0.5 text-primary" : "",
                      )}
                    />
                  </button>
                </li>
              );
            })}
          </ol>
        </aside>

        <main className="min-h-0 overflow-auto p-4">
          {selectedStep ? (
            <section
              className={cn(
                "min-h-full rounded-lg border bg-background p-4 shadow-sm",
                selectedStatus === "failed"
                  ? "border-destructive/40 bg-destructive/[0.03]"
                  : selectedStatus === "blocked"
                    ? "border-amber-500/40 bg-amber-500/[0.04]"
                    : selectedStatus === "running" || selectedStatus === "waiting"
                      ? "border-primary/40 bg-primary/[0.03]"
                      : "border-border",
              )}
            >
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <StatusIcon status={selectedStatus} kind={selectedStep.kind} />
                    <h3 className="truncate text-[13px] font-semibold">{stepTitle(selectedStep)}</h3>
                  </div>
                  <div className="mt-1 flex items-center gap-1.5">
                    <StepKindBadge kind={selectedStep.kind} />
                    <span className="text-[10px] uppercase tracking-wide text-muted-foreground/70">
                      {t(STATUS_LABEL_KEY[selectedStatus])}
                    </span>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {finished && canDebugSelectedStep && selectedIndex === run.index && !canRecoverPrBranch ? (
                    <Button
                      aria-label={t("workflows.run.resumeAria")}
                      onClick={onResume}
                      size="sm"
                      type="button"
                    >
                      <Play className="size-3.5" /> {t("workflows.run.resume")}
                    </Button>
                  ) : null}
                  {canDebugSelectedStep ? (
                    <Button
                      aria-label={t("workflows.run.debugAria")}
                      onClick={() =>
                        sendToAgent({
                          prompt: buildWorkflowStepDebugPrompt({
                            workflowName: run.workflow.name,
                            step: selectedStep,
                            status: selectedStatus,
                            error: run.error,
                            previousOutput,
                            output: selectedOutput,
                          }),
                          source: { type: "workflow-debug", label: selectedStep.title },
                          mode: "send",
                          label: t("workflows.run.debugLabel", { title: selectedStep.title }),
                          background: true,
                        })
                      }
                      size="sm"
                      type="button"
                      variant="outline"
                    >
                      <AgentMark className="size-3.5" /> {t("workflows.run.debugWithAi")}
                    </Button>
                  ) : null}
                  {!finished ? (
                    <Button
                      aria-label={t("workflows.run.stopAria")}
                      onClick={onStop}
                      size="sm"
                      type="button"
                      variant="outline"
                    >
                      <Square className="size-3.5" /> {t("workflows.run.stopAfter")}
                    </Button>
                  ) : null}
                </div>
              </div>

              <div className="py-3 text-[11px] leading-relaxed">
                <StepBody
                  output={selectedOutput}
                  previousOutput={previousOutput}
                  status={selectedStatus}
                  step={selectedStep}
                />

                {isCurrentGate ? (
                  <div className="mt-3 flex flex-wrap items-center gap-1.5">
                    <Button onClick={onApprove} size="sm" type="button">
                      <Check className="size-3.5" /> {t("workflows.run.approve")}
                    </Button>
                    <Button onClick={onSkip} size="sm" type="button" variant="outline">
                      <SkipForward className="size-3.5" /> {t("workflows.run.skip")}
                    </Button>
                    <Button onClick={onStop} size="sm" type="button" variant="outline">
                      <X className="size-3.5" /> {t("common.stop")}
                    </Button>
                  </div>
                ) : null}

                {selectedStatus === "failed" && run.error ? (
                  <p className="mt-3 text-destructive">{run.error}</p>
                ) : null}
                {canRecoverPrBranch ? (
                  <PrBranchRecovery
                    error={run.error}
                    onRestart={onRestart}
                    workflowName={run.workflow.name}
                  />
                ) : null}
                {selectedStatus === "blocked" && run.error ? (
                  <p className="mt-3 text-amber-700 dark:text-amber-400">{run.error}</p>
                ) : null}
              </div>
            </section>
          ) : null}
        </main>
      </div>
    </div>
  );
}

function PrBranchRecovery({
  error,
  onRestart,
  workflowName,
}: {
  error?: string | null;
  onRestart: () => void;
  workflowName: string;
}) {
  const t = useT();
  const { sendToAgent, setOpen, streaming, turns } = useAgentDock();
  const [handoffSent, setHandoffSent] = useState(false);
  const [handoffTurnCount, setHandoffTurnCount] = useState<number | null>(null);
  const [creatingBranch, setCreatingBranch] = useState(false);
  const [createdBranch, setCreatedBranch] = useState<string | null>(null);
  const [branchError, setBranchError] = useState<string | null>(null);
  const agentOutput = handoffTurnCount === null ? "" : latestAssistantTextAfter(turns, handoffTurnCount);
  const recommendedBranch = parseRecommendedBranchName(agentOutput);
  const branchRecoveryInProgress = handoffSent && !recommendedBranch && streaming;

  function askAgentForBranchName(extraInstruction?: string) {
    setHandoffTurnCount(turns.length);
    setBranchError(null);
    setCreatedBranch(null);
    sendToAgent({
      prompt: [
        buildPrBranchRecoveryPrompt({ workflowName, error }),
        extraInstruction?.trim() ? extraInstruction.trim() : "",
      ].filter(Boolean).join("\n\n"),
      source: { type: "workflow-branch-recovery", label: workflowName },
      mode: "send",
      label: t("workflows.recover.handoffLabel", { name: workflowName }),
      background: true,
    });
    setHandoffSent(true);
  }

  async function createRecommendedBranch() {
    if (!recommendedBranch) return;
    setCreatingBranch(true);
    setBranchError(null);
    try {
      await gitCreateBranch(recommendedBranch);
      setCreatedBranch(recommendedBranch);
    } catch (caught) {
      setBranchError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setCreatingBranch(false);
    }
  }

  return (
    <div className="mt-3 rounded-md border border-border bg-muted/35 p-3">
      <Label>{t("workflows.recover.title")}</Label>
      <p className="mb-2 text-[11px] text-muted-foreground">
        {t("workflows.recover.desc")}
      </p>
      <div className="flex flex-wrap items-center gap-1.5">
        <Button onClick={() => askAgentForBranchName()} size="sm" type="button">
          <AgentMark className="size-3.5" /> {t("workflows.recover.recommend")}
        </Button>
        {createdBranch ? (
          <Button onClick={onRestart} size="sm" type="button" variant="outline">
            <Play className="size-3.5" /> {t("workflows.recover.runAgain")}
          </Button>
        ) : null}
      </div>
      {branchRecoveryInProgress ? (
        <p className="mt-2 flex items-center gap-1 text-[11px] text-muted-foreground">
          <Loader2 className="size-3 animate-spin" /> {t("workflows.recover.choosing")}
        </p>
      ) : null}
      {recommendedBranch ? (
        <div className="mt-3 rounded-md border border-border bg-background p-2.5">
          <Label>{t("workflows.recover.recommendedBranch")}</Label>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <code className="min-w-0 rounded bg-muted px-2 py-1 font-mono text-[12px] text-foreground">
              {recommendedBranch}
            </code>
            <div className="flex flex-wrap items-center gap-1.5">
              <Button
                disabled={creatingBranch || createdBranch === recommendedBranch}
                onClick={() => void createRecommendedBranch()}
                size="sm"
                type="button"
              >
                {creatingBranch ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
                {t("workflows.recover.createBranch")}
              </Button>
              <Button
                disabled={creatingBranch}
                onClick={() =>
                  askAgentForBranchName(
                    "Recommend a different concise branch name. Keep the same output contract with `BRANCH_NAME: <branch-name>`.",
                  )
                }
                size="sm"
                type="button"
                variant="outline"
              >
                <AgentMark className="size-3.5" /> {t("workflows.recover.askAnother")}
              </Button>
            </div>
          </div>
        </div>
      ) : agentOutput && !branchRecoveryInProgress ? (
        <div className="mt-3 rounded-md border border-border bg-background p-2.5">
          <p className="text-[11px] text-muted-foreground">
            {t("workflows.recover.noBranch")}
          </p>
          <Button
            className="mt-2"
            onClick={() =>
              askAgentForBranchName(
                "Return only a concise branch suggestion using this exact line: `BRANCH_NAME: <branch-name>`.",
              )
            }
            size="sm"
            type="button"
            variant="outline"
          >
            <AgentMark className="size-3.5" /> {t("workflows.recover.askAnother")}
          </Button>
        </div>
      ) : null}
      {createdBranch ? (
        <p className="mt-2 text-[11px] text-emerald-700 dark:text-emerald-400">
          {t("workflows.recover.createdPre")}
          <code className="font-mono">{createdBranch}</code>
          {t("workflows.recover.createdPost")}
        </p>
      ) : null}
      {branchError ? (
        <p className="mt-2 text-[11px] text-destructive">{branchError}</p>
      ) : null}
      {agentOutput ? (
        <Button
          className="mt-2"
          onClick={() => setOpen(true)}
          size="sm"
          type="button"
          variant="outline"
        >
          <MessageSquarePlus className="size-3.5" /> {t("workflows.recover.openAgent")}
        </Button>
      ) : null}
    </div>
  );
}

function latestAssistantTextAfter(
  turns: ReadonlyArray<{ role: string; text: string }>,
  startIndex: number,
): string {
  for (let i = turns.length - 1; i >= startIndex; i--) {
    if (turns[i]?.role === "assistant") return turns[i].text.trim();
  }
  return "";
}

const STATUS_LABEL_KEY: Record<StepStatus, TranslationKey> = {
  running: "workflows.status.running",
  waiting: "workflows.status.waiting",
  done: "workflows.status.done",
  blocked: "workflows.status.needsYou",
  failed: "workflows.status.failed",
  skipped: "workflows.status.skipped",
  pending: "workflows.status.queued",
};

const KIND_LABEL_KEY: Record<WorkflowStep["kind"], TranslationKey> = {
  gate: "workflows.kind.gate",
  agent: "workflows.kind.agent",
  action: "workflows.kind.action",
};

const OP_LABEL_KEY: Record<Extract<WorkflowStep, { kind: "action" }>["op"], TranslationKey> = {
  commit: "workflows.op.commit",
  push: "workflows.op.push",
  "assert-pr-branch": "workflows.op.assertPrBranch",
  "checkout-default-and-pull": "workflows.op.checkoutDefault",
};

/**
 * The body of a step section. For an agent step this shows its *result* (the
 * agent's reply) once it's run — like a GitHub-Actions step log — and falls back
 * to the task description while it's still pending/running.
 */
function StepBody({
  output,
  previousOutput,
  status,
  step,
}: {
  output?: string;
  previousOutput?: string;
  status: StepStatus;
  step: WorkflowStep;
}) {
  const t = useT();
  if (step.kind === "gate") {
    const proposedCommitMessage = step.id === "gate-commit" ? previousOutput?.trim() : "";
    return (
      <div>
        <p className="text-muted-foreground">{step.message}</p>
        {proposedCommitMessage ? (
          <div className="mt-3">
            <Label>{t("workflows.step.generatedCommitMessage")}</Label>
            <div className="whitespace-pre-wrap break-words rounded-md border border-border bg-muted/50 px-2.5 py-2 font-mono text-[11px] text-foreground">
              {proposedCommitMessage}
            </div>
          </div>
        ) : null}
      </div>
    );
  }
  if (step.kind === "action") {
    return (
      <p className="text-muted-foreground">
        {t(ACTION_DESC_KEY[step.op])}
      </p>
    );
  }

  // Agent step.
  const ran = status === "done" || status === "failed" || status === "skipped";
  if (output) {
    return (
      <div>
        <Label>{t("workflows.step.result")}</Label>
        <div className="whitespace-pre-wrap break-words rounded-md bg-muted/50 px-2.5 py-2 font-mono text-[11px] text-foreground">
          {output}
        </div>
      </div>
    );
  }
  return (
    <div>
      <Label>{ran ? t("workflows.step.result") : t("workflows.step.task")}</Label>
      {ran ? (
        <p className="italic text-muted-foreground">
          {t("workflows.step.noReply")}
        </p>
      ) : (
        <>
          <p className="text-muted-foreground">{step.prompt}</p>
          {status === "running" ? (
            <p className="mt-1.5 flex items-center gap-1 text-muted-foreground/80">
              <Loader2 className="size-3 animate-spin" /> {t("workflows.step.working")}
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

const ACTION_DESC_KEY: Record<Extract<WorkflowStep, { kind: "action" }>["op"], TranslationKey> = {
  "assert-pr-branch": "workflows.opDesc.assertPrBranch",
  "checkout-default-and-pull": "workflows.opDesc.checkoutDefault",
  push: "workflows.opDesc.push",
  commit: "workflows.opDesc.commit",
};

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

function formatRunTimestamp(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function OutcomeBadge({ outcome }: { outcome: RunState["outcome"] }) {
  const t = useT();
  const map: Record<RunState["outcome"], { labelKey: TranslationKey; className: string }> = {
    running: { labelKey: "workflows.status.running", className: "border-primary/40 text-primary" },
    done: { labelKey: "workflows.status.done", className: "border-emerald-500/40 text-emerald-600 dark:text-emerald-400" },
    stopped: { labelKey: "workflows.status.stopped", className: "border-border text-muted-foreground" },
    failed: { labelKey: "workflows.status.failed", className: "border-destructive/40 text-destructive" },
    blocked: { labelKey: "workflows.status.needsYou", className: "border-amber-500/40 text-amber-700 dark:text-amber-400" },
  };
  const { labelKey, className } = map[outcome];
  return (
    <span className={cn("rounded-full border px-2 py-0.5 text-[10px] font-medium", className)}>
      {t(labelKey)}
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
  const t = useT();
  const className =
    kind === "agent"
      ? "border-primary/30 text-primary"
      : kind === "gate"
        ? "border-amber-500/40 text-amber-600 dark:text-amber-400"
        : "border-border text-muted-foreground";
  return (
    <span className={cn("shrink-0 rounded-full border px-1.5 py-px text-[9px] uppercase tracking-wide", className)}>
      {t(KIND_LABEL_KEY[kind])}
    </span>
  );
}

function stepTitle(step: WorkflowStep): string {
  return step.title;
}
