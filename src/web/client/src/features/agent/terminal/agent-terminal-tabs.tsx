import { Circle, Columns2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { ClaudeLogo, CodexLogo } from "../agent-logos";
import type { AgentTerminalTask } from "./use-agent-terminal-tasks";
import { useT } from "@/lib/i18n";

function stateTone(state: AgentTerminalTask["state"]) {
  if (state === "running") return "fill-emerald-500 text-emerald-500";
  if (state === "error") return "fill-destructive text-destructive";
  return "fill-muted-foreground/50 text-muted-foreground/50";
}

export function AgentTerminalTabs({ tasks, activeTaskId, onActivate, onClose, onSplit, pendingTaskIds, splitTaskId }: {
  tasks: AgentTerminalTask[]; activeTaskId: string | null;
  onActivate: (id: string) => void; onClose: (id: string) => void; onSplit?: (id: string) => void;
  pendingTaskIds?: Set<string>; splitTaskId?: string | null;
}) {
  const t = useT();
  return <div aria-label={t("dock.tasksAria")} className="flex min-w-0 flex-1 items-stretch gap-px overflow-x-auto" role="tablist">
    {tasks.map((task) => {
      const label = task.label || t("dock.taskFallback", { provider: task.provider === "codex" ? "Codex" : "Claude" });
      const active = task.id === activeTaskId;
      const split = task.id === splitTaskId;
      const ProviderLogo = task.provider === "codex" ? CodexLogo : ClaudeLogo;
      return <div className={cn("group/tab flex h-9 shrink-0 items-center border-x border-transparent", (active || split) && "border-border bg-background")} data-split={split || undefined} key={task.id}>
        <button aria-controls={`agent-panel-${task.id}`} aria-label={t("dock.openTaskAria", { label })} aria-selected={active} className="flex h-full max-w-56 items-center gap-2 px-3 text-xs" id={`agent-tab-${task.id}`} onClick={() => onActivate(task.id)} role="tab" type="button">
          <ProviderLogo className={cn("size-3 shrink-0", active || split ? "text-foreground" : "text-muted-foreground")} />
          <Circle aria-hidden className={cn("size-2", stateTone(task.state))} />
          <span className={cn("truncate font-mono text-[11px]", active || split ? "text-foreground" : "text-muted-foreground")}>{label}</span>
        </button>
        {onSplit && !active ? <button aria-label={t(split ? "dock.unsplitTaskAria" : "dock.splitTaskAria", { label })} aria-pressed={split} className={cn("grid size-6 place-items-center rounded-sm text-muted-foreground opacity-50 hover:bg-muted hover:text-foreground group-hover/tab:opacity-100", split && "text-foreground opacity-100")} onClick={() => onSplit(task.id)} type="button"><Columns2 className="size-3" /></button> : null}
        <button aria-label={t("dock.closeTaskAria", { label })} className="mr-1 grid size-6 place-items-center rounded-sm text-muted-foreground opacity-50 hover:bg-muted hover:text-foreground group-hover/tab:opacity-100 disabled:pointer-events-none disabled:opacity-25" disabled={pendingTaskIds?.has(task.id)} onClick={() => onClose(task.id)} type="button"><X className="size-3" /></button>
      </div>;
    })}
  </div>;
}
