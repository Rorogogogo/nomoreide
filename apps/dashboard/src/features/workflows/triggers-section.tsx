import { useState } from "react";
import { Play, Plus, Trash2, X, Zap } from "lucide-react";
import type { TriggerEvent, Workflow, WorkflowTrigger } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n";
import type { TranslationKey } from "@/lib/i18n/en";
import { useWorkflowTriggers } from "./workflow-trigger-context";

const EVENT_LABEL_KEY: Record<TriggerEvent, TranslationKey> = {
  "error-incident": "workflows.triggers.eventErrorIncident",
  "service-crash": "workflows.triggers.eventServiceCrash",
  "ci-failure": "workflows.triggers.eventCiFailure",
};

/**
 * Triggers (IDEAS #16): bind an app-detected event to a workflow so it fires
 * automatically. Fired triggers enqueue *pending runs* (the server can't drive
 * the client-side runner directly); auto-run ones start on their own, the rest
 * wait here for one click. Reads/writes through {@link useWorkflowTriggers}.
 */
export function TriggersSection({ workflows }: { workflows: Workflow[] }) {
  const t = useT();
  const { triggers, pending, error, saveTrigger, removeTrigger, runPending, dismissPending } =
    useWorkflowTriggers();
  const [adding, setAdding] = useState(false);

  const nameFor = (id: string) => workflows.find((w) => w.id === id)?.name ?? id;

  return (
    <section className="border-t border-border px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-1.5 text-[12px] font-semibold">
            <Zap className="size-3.5 text-amber-500" /> {t("workflows.triggers.title")}
          </h3>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {t("workflows.triggers.subtitle")}
          </p>
        </div>
        <Button onClick={() => setAdding((v) => !v)} size="sm" type="button" variant="outline">
          <Plus className="size-3.5" /> {t("workflows.triggers.add")}
        </Button>
      </div>

      {error ? <p className="mt-2 text-[11px] text-destructive">{error}</p> : null}

      {pending.length > 0 ? (
        <div className="mt-3 space-y-1.5">
          {pending.map((run) => (
            <div
              key={run.id}
              className="flex items-center justify-between gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-2.5 py-1.5"
            >
              <div className="min-w-0">
                <div className="truncate text-[11px] font-medium">
                  {nameFor(run.workflowId)}
                  <span className="ml-1.5 text-muted-foreground">
                    · {t(EVENT_LABEL_KEY[run.event])}
                  </span>
                </div>
                <div className="truncate text-[10px] text-muted-foreground">{run.summary}</div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button onClick={() => runPending(run)} size="sm" type="button" variant="outline">
                  <Play className="size-3" /> {t("workflows.run")}
                </Button>
                <Button
                  onClick={() => void dismissPending(run.id)}
                  size="icon"
                  type="button"
                  variant="ghost"
                  aria-label={t("workflows.triggers.dismiss")}
                >
                  <X className="size-3.5" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {adding ? (
        <AddTriggerForm
          workflows={workflows}
          onCancel={() => setAdding(false)}
          onSave={async (trigger) => {
            await saveTrigger(trigger);
            setAdding(false);
          }}
        />
      ) : null}

      <div className="mt-3 space-y-1.5">
        {triggers.length === 0 && !adding ? (
          <p className="text-[11px] text-muted-foreground/70">{t("workflows.triggers.empty")}</p>
        ) : null}
        {triggers.map((trigger) => (
          <div
            key={trigger.id}
            className="flex items-center justify-between gap-2 rounded-md border border-border px-2.5 py-1.5"
          >
            <label className="flex min-w-0 items-center gap-2">
              <input
                checked={trigger.enabled}
                className="size-3.5 accent-primary"
                onChange={(event) =>
                  void saveTrigger({ ...trigger, enabled: event.target.checked })
                }
                type="checkbox"
              />
              <span className="min-w-0 truncate text-[11px]">
                <span className="font-medium">{t(EVENT_LABEL_KEY[trigger.event])}</span>
                {trigger.filter ? (
                  <span className="text-muted-foreground"> · “{trigger.filter}”</span>
                ) : null}
                <span className="text-muted-foreground"> → {nameFor(trigger.workflowId)}</span>
                {trigger.autoRun ? (
                  <span className="ml-1.5 rounded bg-amber-500/15 px-1 py-px text-[9px] font-semibold uppercase text-amber-600">
                    {t("workflows.triggers.autoBadge")}
                  </span>
                ) : null}
              </span>
            </label>
            <Button
              onClick={() => void removeTrigger(trigger.id)}
              size="icon"
              type="button"
              variant="ghost"
              aria-label={t("workflows.triggers.deleteAria")}
            >
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        ))}
      </div>
    </section>
  );
}

function AddTriggerForm({
  workflows,
  onCancel,
  onSave,
}: {
  workflows: Workflow[];
  onCancel: () => void;
  onSave: (trigger: WorkflowTrigger) => Promise<void>;
}) {
  const t = useT();
  const [event, setEvent] = useState<TriggerEvent>("error-incident");
  const [workflowId, setWorkflowId] = useState(workflows[0]?.id ?? "");
  const [filter, setFilter] = useState("");
  const [autoRun, setAutoRun] = useState(false);

  const inputClass =
    "rounded border border-border bg-background px-2 py-1 text-[11px] outline-none focus:border-primary";

  return (
    <div className="mt-3 space-y-2 rounded-md border border-border bg-background p-3">
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-[10px] font-medium text-muted-foreground">
          {t("workflows.triggers.when")}
          <select
            className={inputClass}
            value={event}
            onChange={(e) => setEvent(e.target.value as TriggerEvent)}
          >
            {(Object.keys(EVENT_LABEL_KEY) as TriggerEvent[]).map((value) => (
              <option key={value} value={value}>
                {t(EVENT_LABEL_KEY[value])}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[10px] font-medium text-muted-foreground">
          {t("workflows.triggers.runWorkflow")}
          <select
            className={inputClass}
            value={workflowId}
            onChange={(e) => setWorkflowId(e.target.value)}
          >
            {workflows.map((workflow) => (
              <option key={workflow.id} value={workflow.id}>
                {workflow.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="flex flex-col gap-1 text-[10px] font-medium text-muted-foreground">
        {t("workflows.triggers.filterLabel")}
        <input
          className={inputClass}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="e.g. api"
          type="text"
        />
      </label>
      <label className="flex w-fit items-center gap-1.5 text-[11px] text-muted-foreground">
        <input
          checked={autoRun}
          className="size-3.5 accent-primary"
          onChange={(e) => setAutoRun(e.target.checked)}
          type="checkbox"
        />
        {t("workflows.triggers.autoRunLabel")}
      </label>
      <div className="flex justify-end gap-2 pt-1">
        <Button onClick={onCancel} size="sm" type="button" variant="ghost">
          {t("common.cancel")}
        </Button>
        <Button
          disabled={!workflowId}
          onClick={() =>
            void onSave({
              id: `trigger-${Date.now().toString(36)}`,
              event,
              workflowId,
              filter: filter.trim() || undefined,
              enabled: true,
              autoRun,
            })
          }
          size="sm"
          type="button"
        >
          {t("common.add")}
        </Button>
      </div>
    </div>
  );
}
