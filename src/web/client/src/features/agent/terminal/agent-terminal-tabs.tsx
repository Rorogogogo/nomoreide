import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { Circle, ExternalLink, Plus, RotateCcw, SquareTerminal, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { ClaudeLogo, CodexLogo } from "../agent-logos";
import { COMPOSE_TAB_ID } from "./compose-tab";
import type { AgentTerminalTask } from "./use-agent-terminal-tasks";
import { useT } from "@/lib/i18n";

function stateTone(state: AgentTerminalTask["state"]) {
  if (state === "running") return "fill-emerald-500 text-emerald-500";
  if (state === "error") return "fill-destructive text-destructive";
  return "fill-muted-foreground/50 text-muted-foreground/50";
}

function providerTabAccent(provider: AgentTerminalTask["provider"]) {
  return provider === "codex"
    ? "before:bg-emerald-500"
    : "before:bg-[#D97757]";
}

export function AgentTerminalTabs({ tasks, activeTaskId, ariaLabel, composing, onActivate, onClose, onDragEnd, onDragStart, onRename, onOpenInTerminal, onBringBackToDock, pendingTaskIds }: {
  tasks: AgentTerminalTask[]; activeTaskId: string | null;
  ariaLabel?: string;
  /** Whether the compose tab is showing — it is the selected tab while true. */
  composing: boolean;
  onActivate: (id: string) => void; onClose: (id: string) => void;
  onDragEnd?: () => void; onDragStart?: (id: string) => void;
  onRename?: (id: string, label: string) => void;
  onOpenInTerminal?: (id: string) => void;
  onBringBackToDock?: (id: string) => void;
  pendingTaskIds?: Set<string>;
}) {
  const t = useT();
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);
  const restoreFocusTaskIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (editingTaskId) {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
      return;
    }
    const taskId = restoreFocusTaskIdRef.current;
    restoreFocusTaskIdRef.current = null;
    if (taskId) document.getElementById(`agent-tab-${taskId}`)?.focus();
  }, [editingTaskId]);
  const beginRename = (task: AgentTerminalTask, label: string) => {
    if (!onRename || pendingTaskIds?.has(task.id)) return;
    setEditingTaskId(task.id);
    setRenameDraft(label);
  };
  const cancelRename = (taskId: string) => {
    restoreFocusTaskIdRef.current = taskId;
    setEditingTaskId(null);
  };
  const commitRename = (task: AgentTerminalTask, label: string) => {
    const next = renameDraft.trim();
    restoreFocusTaskIdRef.current = task.id;
    setEditingTaskId(null);
    if (next && next !== label) onRename?.(task.id, next);
  };
  const tabIds = [
    ...tasks.map((task) => task.id),
    ...(composing ? [COMPOSE_TAB_ID] : []),
  ];
  const navigateTabs = (event: ReactKeyboardEvent, currentId: string) => {
    const currentIndex = tabIds.indexOf(currentId);
    let nextIndex = currentIndex;
    if (event.key === "ArrowLeft") nextIndex = Math.max(0, currentIndex - 1);
    else if (event.key === "ArrowRight") nextIndex = Math.min(tabIds.length - 1, currentIndex + 1);
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = tabIds.length - 1;
    else return;
    event.preventDefault();
    const nextId = tabIds[nextIndex];
    if (!nextId) return;
    onActivate(nextId);
    window.setTimeout(() => document.getElementById(`agent-tab-${nextId}`)?.focus(), 0);
  };
  return <div aria-label={ariaLabel ?? t("dock.tasksAria")} className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto px-1" role="tablist">
    {tasks.map((task) => {
      const shell = task.kind === "shell";
      const label = task.label || (shell ? t("dock.shellFallback") : t("dock.taskFallback", { provider: task.provider === "codex" ? "Codex" : "Claude" }));
      const active = task.id === activeTaskId;
      const editing = editingTaskId === task.id;
      const draggable = Boolean(onDragStart) && !editing;
      const ProviderLogo = shell ? SquareTerminal : task.provider === "codex" ? CodexLogo : ClaudeLogo;
      return <div className={cn("group/tab relative flex h-7 shrink-0 items-center overflow-hidden rounded-sm", !shell && "before:absolute before:inset-x-0 before:top-0 before:h-px before:content-['']", !shell && providerTabAccent(task.provider), active ? "bg-foreground text-background" : "text-muted-foreground hover:bg-muted/45 hover:text-foreground")} data-provider-accent={shell ? undefined : task.provider} key={task.id}>
        {editing ? <div className="flex h-full max-w-56 items-center gap-2 px-2 text-xs">
          <button aria-controls={`agent-panel-${task.id}`} aria-label={t("dock.openTaskAria", { label })} aria-selected={active} className="sr-only" id={`agent-tab-${task.id}`} role="tab" tabIndex={-1} type="button">{label}</button>
          <ProviderLogo className={cn("size-3 shrink-0", shell && "text-foreground")} />
          <Circle aria-hidden className={cn("size-2", stateTone(task.state))} />
          <input aria-label={t("dock.renameTaskAria", { label })} className="h-6 min-w-24 max-w-40 rounded-sm border border-primary/50 bg-background px-1.5 font-mono text-[11px] text-foreground outline-none ring-1 ring-primary/20" maxLength={60} onBlur={() => commitRename(task, label)} onInput={(event) => setRenameDraft(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); cancelRename(task.id); } else if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.blur(); } }} onPointerDown={(event) => event.stopPropagation()} ref={renameInputRef} value={renameDraft} />
        </div> : <button aria-controls={`agent-panel-${task.id}`} aria-keyshortcuts={onRename ? "F2" : undefined} aria-label={t("dock.openTaskAria", { label })} aria-selected={active} className={cn("flex h-full min-w-0 max-w-56 items-center gap-1.5 px-2 text-xs", draggable && "cursor-grab active:cursor-grabbing")} draggable={draggable} id={`agent-tab-${task.id}`} onClick={() => onActivate(task.id)} onDoubleClick={() => beginRename(task, label)} onDragEnd={onDragEnd} onDragStart={(event) => { if (event.dataTransfer) { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", task.id); } onDragStart?.(task.id); }} onKeyDown={(event) => { if (event.key === "F2") { event.preventDefault(); beginRename(task, label); } else navigateTabs(event, task.id); }} role="tab" tabIndex={active ? 0 : -1} title={onRename ? t("dock.renameTaskHint") : draggable ? t("dock.dragTaskToSplit") : undefined} type="button">
          {/* Only the shell's lucide glyph takes a tint — the agent marks carry
              their own brand colour and stay legible on an inactive tab. */}
          <ProviderLogo className={cn("size-3 shrink-0", shell && (active ? "text-background" : "text-muted-foreground"))} />
          <Circle aria-hidden className={cn("size-2", stateTone(task.state))} />
          <span className={cn("min-w-0 truncate font-mono text-[11px]", active ? "text-background" : "text-muted-foreground")}>{label}</span>
        </button>}
        {/* Always visible and never squeezed: the label truncates inside its own
            button, so a long task name can't push the close control out of the
            tab or hide it behind the text. */}
        {!shell && onOpenInTerminal && task.presentation !== "terminal" ? <button aria-label={t("dock.openInTerminalAria", { label })} className={cn("grid size-6 shrink-0 place-items-center rounded-sm disabled:pointer-events-none disabled:opacity-25", active ? "text-background/70 hover:bg-background/15 hover:text-background" : "text-muted-foreground hover:bg-muted hover:text-foreground")} disabled={editing || pendingTaskIds?.has(task.id) || task.presentation === "terminalLaunching" || task.state !== "running"} onClick={() => onOpenInTerminal(task.id)} title={t("dock.openInTerminal")} type="button"><ExternalLink className="size-3" /></button> : null}
        {!shell && onBringBackToDock && task.presentation === "terminal" ? <button aria-label={t("dock.bringBackAria", { label })} className={cn("grid size-6 shrink-0 place-items-center rounded-sm disabled:pointer-events-none disabled:opacity-25", active ? "text-background/70 hover:bg-background/15 hover:text-background" : "text-muted-foreground hover:bg-muted hover:text-foreground")} disabled={editing || pendingTaskIds?.has(task.id)} onClick={() => onBringBackToDock(task.id)} title={t("dock.bringBack")} type="button"><RotateCcw className="size-3" /></button> : null}
        <button aria-label={t("dock.closeTaskAria", { label })} className={cn("mr-0.5 grid size-6 shrink-0 place-items-center rounded-sm disabled:pointer-events-none disabled:opacity-25", active ? "text-background/70 hover:bg-background/15 hover:text-background" : "text-muted-foreground hover:bg-muted hover:text-foreground")} disabled={editing || pendingTaskIds?.has(task.id)} onClick={() => onClose(task.id)} type="button"><X className="size-3" /></button>
      </div>;
    })}
    {/* A draft is not a session, so the compose tab is singular and carries no
        close or split affordance — it only exists to keep selection honest. */}
    {composing ? <div className="flex h-7 shrink-0 items-center rounded-sm bg-foreground text-background">
      <button aria-controls={`agent-panel-${COMPOSE_TAB_ID}`} aria-selected className="flex h-full items-center gap-1.5 px-2 text-xs" id={`agent-tab-${COMPOSE_TAB_ID}`} onClick={() => onActivate(COMPOSE_TAB_ID)} onKeyDown={(event) => navigateTabs(event, COMPOSE_TAB_ID)} role="tab" type="button">
        <Plus aria-hidden className="size-3 shrink-0 text-background" />
        <span className="truncate font-mono text-[11px] text-background">{t("dock.newTaskTab")}</span>
      </button>
    </div> : null}
  </div>;
}
