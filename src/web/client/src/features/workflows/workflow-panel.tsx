import { useEffect, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  Loader2,
  Play,
  ShieldQuestion,
  SkipForward,
  Sparkles,
  Square,
  Terminal,
  X,
} from "lucide-react";
import { listWorkflows, type Workflow, type WorkflowStep } from "@/lib/api";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { AgentMark } from "../agent/ai-spark";
import { useAgentDock } from "../agent/chat/agent-context";
import { useWorkflowRunner, type RunState, type StepStatus } from "./use-workflow-runner";

/**
 * The Workflows panel: your own git/GitHub rituals as one-click, gated,
 * visualized pipelines. Picking one runs it through {@link useWorkflowRunner};
 * the agent does the work down in the dock while this view shows where the run
 * is and pauses at each gate for your approval.
 */
export function WorkflowPanel({ onRefresh }: { onRefresh?: () => void }) {
  const { setOpen } = useAgentDock();
  const { run, start, approve, skip, stop, dismiss } = useWorkflowRunner(onRefresh);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Gates are the consent, so skip the agent's per-tool prompts by default —
  // irreversible footguns still surface in the dock regardless of this.
  const [autoApprove, setAutoApprove] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);
    void listWorkflows()
      .then((next) => {
        if (active) setWorkflows(next);
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
    setOpen(true); // surface the dock so the user can watch the agent work
    void start(workflow, autoApprove);
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

  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto bg-card/85">
      <div className="border-b border-border px-4 py-3">
        <h2 className="flex items-center gap-1.5 text-[13px] font-semibold">
          <AgentMark className="size-4" /> AI Workflows
        </h2>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          One-click rituals that exceed the IDE — the agent does the work in the dock, pausing at each gate for your OK.
        </p>
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
            <WorkflowCard key={workflow.id} workflow={workflow} onRun={() => runWorkflow(workflow)} />
          ))}
        </div>
      )}
    </div>
  );
}

function WorkflowCard({ workflow, onRun }: { workflow: Workflow; onRun: () => void }) {
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
          const expanded = open.has(step.id) || status === "waiting" || status === "failed";
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
  } as const;
  const { label, className } = map[outcome];
  return (
    <span className={cn("rounded-full border px-2 py-0.5 text-[10px] font-medium", className)}>
      {label}
    </span>
  );
}

function StatusIcon({ status, kind }: { status: StepStatus; kind: WorkflowStep["kind"] }) {
  if (status === "running") return <Loader2 className="size-4 shrink-0 animate-spin text-primary" />;
  if (status === "waiting") return <ShieldQuestion className="size-4 shrink-0 text-primary" />;
  if (status === "done") return <Check className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />;
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
