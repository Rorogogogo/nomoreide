import { Circle, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AgentTerminalTask } from "./use-agent-terminal-tasks";

function stateTone(state: AgentTerminalTask["state"]) {
  if (state === "running") return "fill-emerald-500 text-emerald-500";
  if (state === "error") return "fill-destructive text-destructive";
  return "fill-muted-foreground/50 text-muted-foreground/50";
}

export function AgentTerminalTabs({ tasks, activeTaskId, onActivate, onClose, pendingTaskIds }: {
  tasks: AgentTerminalTask[]; activeTaskId: string | null;
  onActivate: (id: string) => void; onClose: (id: string) => void; pendingTaskIds?: Set<string>;
}) {
  return <div aria-label="Agent tasks" className="flex min-w-0 flex-1 items-stretch gap-px overflow-x-auto" role="tablist">
    {tasks.map((task) => {
      const label = task.label || `${task.provider === "codex" ? "Codex" : "Claude"} task`;
      const active = task.id === activeTaskId;
      return <div className={cn("group/tab flex h-9 shrink-0 items-center border-x border-transparent", active && "border-border bg-background")} key={task.id}>
        <button aria-controls={`agent-panel-${task.id}`} aria-label={`Open task ${label}`} aria-selected={active} className="flex h-full max-w-56 items-center gap-2 px-3 text-xs" id={`agent-tab-${task.id}`} onClick={() => onActivate(task.id)} role="tab" type="button">
          <Circle aria-hidden className={cn("size-2", stateTone(task.state))} />
          <span className={cn("truncate font-mono text-[11px]", active ? "text-foreground" : "text-muted-foreground")}>{label}</span>
        </button>
        <button aria-label={`Close task ${label}`} className="mr-1 grid size-6 place-items-center rounded-sm text-muted-foreground opacity-50 hover:bg-muted hover:text-foreground group-hover/tab:opacity-100 disabled:pointer-events-none disabled:opacity-25" disabled={pendingTaskIds?.has(task.id)} onClick={() => onClose(task.id)} type="button"><X className="size-3" /></button>
      </div>;
    })}
  </div>;
}
