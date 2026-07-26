import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Bot, ChevronDown, ChevronUp, Container, Database, GitBranch, Inbox, Maximize2, Minimize2, Puzzle, Server, Square, SquareTerminal, Workflow } from "lucide-react";
// SquareTerminal doubles as the shell tab/rail mark — see AgentTerminalTabs.
import type { DashboardData } from "@/lib/api";
import { cn } from "@/lib/utils";
import { ClaudeLogo, CodexLogo } from "../agent-logos";
import { useAgentDock } from "../chat/agent-context";
import { GitSituationBanner } from "../../git/git-situation-banner";
import { TerminalViewport, type TerminalViewportHandle, type TerminalViewportStatus } from "../../terminal/terminal-viewport";
import { AgentCapabilityBadges } from "./agent-capability-strip";
import { useAgentCapabilities } from "./agent-capability-data";
import { AgentTerminalComposer } from "./agent-terminal-composer";
import { AgentConversationPicker } from "./agent-conversation-picker";
import { AgentNewSessionMenu } from "./agent-new-session-menu";
import { AgentTerminalTabs } from "./agent-terminal-tabs";
import { DockStatusStrip } from "./dock-status-strip";
import { COMPOSE_TAB_ID } from "./compose-tab";
import { GitHubLogo } from "../../github/github-logo";
import { isTauri } from "@/lib/tauri";
import { useOptionalSettings } from "@/features/settings/settings-context";
import { useT, type TranslationKey } from "@/lib/i18n";

export type AgentDockPage = "services" | "docker" | "git" | "github" | "workflows" | "errors" | "database" | "terminal" | "agent" | "agent-env" | "settings";

const FULLSCREEN_NAV: Array<{ page: AgentDockPage; labelKey: TranslationKey; icon: ReactNode }> = [
  { page: "services", labelKey: "nav.services", icon: <Server /> },
  { page: "docker", labelKey: "nav.docker", icon: <Container /> },
  { page: "git", labelKey: "nav.git", icon: <GitBranch /> },
  { page: "github", labelKey: "nav.github", icon: <GitHubLogo /> },
  { page: "workflows", labelKey: "nav.workflows", icon: <Workflow /> },
  { page: "errors", labelKey: "nav.errors", icon: <Inbox /> },
  { page: "database", labelKey: "nav.database", icon: <Database /> },
  { page: "terminal", labelKey: "nav.terminal", icon: <SquareTerminal /> },
  { page: "agent", labelKey: "nav.agent", icon: <Bot /> },
  { page: "agent-env", labelKey: "nav.agentEnv", icon: <Puzzle /> },
];

export function clampAgentDockHeight(height: number, viewportHeight: number) { const maximum = Math.max(0, viewportHeight - 48); const minimum = Math.min(180, maximum); return Math.max(minimum, Math.min(maximum, height)); }
function stateLabel(state: string) { return `${state.charAt(0).toUpperCase()}${state.slice(1)}`; }
type DockPane = "left" | "right";

export function AgentTerminalDock({ currentPage = "services", git, onGitRefresh, onNavigate }: { currentPage?: AgentDockPage; git?: DashboardData["git"]; onGitRefresh?: () => void; onNavigate?: (page: AgentDockPage) => void }) {
  const t = useT();
  const settings = useOptionalSettings();
  const { activeTaskId, claimInitialInput, closeTask, createShellTask, createTask, creating, draft, focusNonce, insertPrompt, loadTranscripts, onboarding, open, pendingTaskIds, provider, providers, renameTask, resumeTask, setActiveTaskId, setOpen, stopTask, tasks, terminalError, transcripts, transcriptsError, transcriptsLoading, updateTaskStatus } = useAgentDock();
  const [height, setHeight] = useState<number | null>(null); const [resizing, setResizing] = useState(false);
  const [fullScreen, setFullScreen] = useState(false);
  const [rightTaskIds, setRightTaskIds] = useState<Set<string>>(() => new Set());
  const [activeRightTaskId, setActiveRightTaskId] = useState<string | null>(null);
  const [focusedPane, setFocusedPane] = useState<DockPane>("left");
  const [splitPercent, setSplitPercent] = useState(50);
  const [draggedTaskId, setDraggedTaskId] = useState<string | null>(null);
  const [shellMode, setShellMode] = useState(false);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const splitResizeCleanupRef = useRef<(() => void) | null>(null);
  const splitContainerRef = useRef<HTMLDivElement>(null);
  const viewportHandlesRef = useRef(new Map<string, TerminalViewportHandle>());
  const previousFocusNonceRef = useRef(focusNonce);
  const previousOnboardingRef = useRef(onboarding);
  const paneIntentSequenceRef = useRef(0);
  // Work staged before this mount (the dock mounts with the app, so a draft can
  // arrive while it is closed) still has to land on the composer; the effects
  // below only see changes that happen after mount.
  useEffect(() => {
    if (draft || onboarding) {
      setShellMode(false);
      paneIntentSequenceRef.current += 1;
      setFocusedPane("left");
      setActiveTaskId(COMPOSE_TAB_ID);
    }
  }, []);
  // A prefill (draft, path insert, capability click) or an onboard entry has to
  // bring the composer forward — which is now simply selecting its tab.
  useEffect(() => {
    if (focusNonce !== previousFocusNonceRef.current) {
      setShellMode(false);
      paneIntentSequenceRef.current += 1;
      setFocusedPane("left");
      setActiveTaskId(COMPOSE_TAB_ID);
    }
    previousFocusNonceRef.current = focusNonce;
  }, [focusNonce, setActiveTaskId]);
  useEffect(() => {
    if (onboarding && !previousOnboardingRef.current) {
      setShellMode(false);
      paneIntentSequenceRef.current += 1;
      setFocusedPane("left");
      setActiveTaskId(COMPOSE_TAB_ID);
    }
    previousOnboardingRef.current = onboarding;
  }, [onboarding, setActiveTaskId]);
  useEffect(() => () => {
    resizeCleanupRef.current?.();
    splitResizeCleanupRef.current?.();
  }, []);
  useEffect(() => {
    if (!fullScreen) return;
    const restore = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFullScreen(false);
    };
    window.addEventListener("keydown", restore);
    return () => window.removeEventListener("keydown", restore);
  }, [fullScreen]);
  useEffect(() => {
    if (!open) setFullScreen(false);
  }, [open]);
  useEffect(() => {
    const liveIds = new Set(tasks.map((task) => task.id));
    setRightTaskIds((current) => {
      const next = new Set([...current].filter((id) => liveIds.has(id)));
      if (next.size === current.size && [...next].every((id) => current.has(id))) {
        return current;
      }
      return next;
    });
  }, [tasks]);
  const collapse = () => { setFullScreen(false); setOpen(false); };
  const navigate = (page: AgentDockPage) => { onNavigate?.(page); collapse(); };
  function resizeStart(event: ReactPointerEvent<HTMLDivElement>) { event.preventDefault(); event.currentTarget.setPointerCapture?.(event.pointerId); setResizing(true); const move = (e: PointerEvent) => setHeight(clampAgentDockHeight(window.innerHeight - e.clientY, window.innerHeight)); const cleanup = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); resizeCleanupRef.current = null; }; const up = () => { setResizing(false); cleanup(); }; resizeCleanupRef.current?.(); resizeCleanupRef.current = cleanup; window.addEventListener("pointermove", move); window.addEventListener("pointerup", up); }
  function splitResizeStart(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const move = (nextEvent: PointerEvent) => {
      const bounds = splitContainerRef.current?.getBoundingClientRect();
      if (!bounds?.width) return;
      const percent = ((nextEvent.clientX - bounds.left) / bounds.width) * 100;
      setSplitPercent(Math.max(25, Math.min(75, percent)));
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      splitResizeCleanupRef.current = null;
    };
    const up = () => cleanup();
    splitResizeCleanupRef.current?.();
    splitResizeCleanupRef.current = cleanup;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }
  const composing = activeTaskId === COMPOSE_TAB_ID || tasks.length === 0;
  const rightTasks = tasks.filter((task) => rightTaskIds.has(task.id));
  const leftTasks = tasks.filter((task) => !rightTaskIds.has(task.id));
  const leftActive = leftTasks.find((task) => task.id === activeTaskId) ?? null;
  const rightActive =
    rightTasks.find((task) => task.id === activeRightTaskId) ??
    rightTasks[0] ??
    null;
  const split = rightTasks.length > 0;
  const focusedTask =
    focusedPane === "right" && rightActive ? rightActive : leftActive;
  useEffect(() => {
    if (rightActive?.id !== activeRightTaskId) {
      setActiveRightTaskId(rightActive?.id ?? null);
    }
    if (!rightActive && focusedPane === "right") setFocusedPane("left");
  }, [activeRightTaskId, focusedPane, rightActive]);

  const railProviderId = focusedTask?.provider ?? provider?.id;
  const activeShell = focusedTask?.kind === "shell";
  const Logo = activeShell ? SquareTerminal : railProviderId === "codex" ? CodexLogo : ClaudeLogo;
  const railProviderLabel = activeShell ? t("dock.shell") : focusedTask ? (focusedTask.provider === "codex" ? "Codex" : "Claude Code") : (provider?.label ?? "Agent");
  const activeTaskLabel = focusedTask?.label || (activeShell ? t("dock.shellFallback") : t("dock.newTask"));
  // Counts follow what the user is looking at: the selected provider while
  // composing, the active task's provider while a terminal is showing.
  // With no sessions the composer is the dock's start page. Once a session
  // exists, an explicit new task or staged draft brings it back.
  // Agent capabilities are meaningless against a plain shell, so the chips go
  // away whenever the thing in front of the user is one.
  const agentContext = focusedTask ? !activeShell : composing && !shellMode;
  const capabilities = useAgentCapabilities(
    ((focusedTask?.provider ?? provider?.id) ?? "claude") === "codex" ? "codex" : "claude",
    open,
  );
  // Capability clicks type straight into the focused terminal when one is
  // showing and connected; otherwise they land in the composer draft.
  const insertCapability = (text: string) => {
    if (focusedTask?.state === "running") {
      const handle = viewportHandlesRef.current.get(focusedTask.id);
      if (handle) {
        handle.input(text);
        handle.focus();
        return;
      }
    }
    insertPrompt(text);
  };
  const activateLeft = (id: string) => {
    paneIntentSequenceRef.current += 1;
    setFocusedPane("left");
    setActiveTaskId(id);
  };
  const activateRight = (id: string) => {
    paneIntentSequenceRef.current += 1;
    setFocusedPane("right");
    setActiveRightTaskId(id);
  };
  const closeLeft = async (id: string) => {
    const index = leftTasks.findIndex((task) => task.id === id);
    const remaining = leftTasks.filter((task) => task.id !== id);
    const replacement =
      remaining[Math.min(Math.max(index, 0), remaining.length - 1)]?.id ??
      (composing ? COMPOSE_TAB_ID : null);
    if (!(await closeTask(id, replacement))) return;
    if (leftTasks.length === 1 && rightTasks.length > 0) {
      setRightTaskIds(new Set());
      setActiveRightTaskId(null);
      setActiveTaskId(rightActive?.id ?? rightTasks[0]?.id ?? null);
      setFocusedPane("left");
    }
  };
  const closeRight = async (id: string) => {
    const index = rightTasks.findIndex((task) => task.id === id);
    const remaining = rightTasks.filter((task) => task.id !== id);
    const replacement =
      remaining[Math.min(Math.max(index, 0), remaining.length - 1)]?.id ?? null;
    if (!(await closeTask(id))) return;
    setRightTaskIds((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
    setActiveRightTaskId((current) => current === id ? replacement : current);
    if (!replacement) {
      setFocusedPane((current) => current === "right" ? "left" : current);
    }
  };
  const createAgentInFocusedPane = async (selectedProvider: typeof providers[number]) => {
    const targetPane = focusedPane;
    const sequence = ++paneIntentSequenceRef.current;
    const task = await createTask({
      prompt: "",
      provider: selectedProvider.id,
      label: t("dock.taskFallback", { provider: selectedProvider.label }),
      ...(targetPane === "right" ? { background: true } : {}),
    });
    if (!task || targetPane !== "right") {
      if (task) setFocusedPane("left");
      return;
    }
    setRightTaskIds((current) => new Set(current).add(task.id));
    if (paneIntentSequenceRef.current === sequence) {
      setActiveRightTaskId(task.id);
      setFocusedPane("right");
    }
  };
  const createShellInFocusedPane = async () => {
    const targetPane = focusedPane;
    const sequence = ++paneIntentSequenceRef.current;
    const task = await createShellTask(
      undefined,
      targetPane === "right" ? { background: true } : undefined,
    );
    if (!task || targetPane !== "right") {
      if (task) setFocusedPane("left");
      return;
    }
    setRightTaskIds((current) => new Set(current).add(task.id));
    if (paneIntentSequenceRef.current === sequence) {
      setActiveRightTaskId(task.id);
      setFocusedPane("right");
    }
  };
  const resumeInFocusedPane = async (transcript: Parameters<typeof resumeTask>[0]) => {
    const targetPane = focusedPane;
    const sequence = ++paneIntentSequenceRef.current;
    const task =
      targetPane === "right"
        ? await resumeTask(transcript, { background: true })
        : await resumeTask(transcript);
    if (!task || targetPane !== "right") {
      if (task) setFocusedPane("left");
      return task;
    }
    setRightTaskIds((current) => new Set(current).add(task.id));
    if (paneIntentSequenceRef.current === sequence) {
      setActiveRightTaskId(task.id);
      setFocusedPane("right");
    }
    return task;
  };
  const draggedFromRight = Boolean(draggedTaskId && rightTaskIds.has(draggedTaskId));
  const canDropRight = Boolean(
    draggedTaskId &&
      !draggedFromRight &&
      (composing || leftTasks.some((task) => task.id !== draggedTaskId)),
  );
  const dropDraggedRight = () => {
    if (!draggedTaskId || !canDropRight) return;
    paneIntentSequenceRef.current += 1;
    if (draggedTaskId === activeTaskId) {
      const replacement =
        leftTasks.find((task) => task.id !== draggedTaskId)?.id ??
        (composing ? COMPOSE_TAB_ID : null);
      if (!replacement) return;
      setActiveTaskId(replacement);
    }
    setRightTaskIds((current) => new Set(current).add(draggedTaskId));
    setActiveRightTaskId(draggedTaskId);
    setFocusedPane("right");
    setDraggedTaskId(null);
  };
  const dropDraggedLeft = () => {
    if (!draggedTaskId || !draggedFromRight) return;
    paneIntentSequenceRef.current += 1;
    const remaining = rightTasks.filter((task) => task.id !== draggedTaskId);
    setRightTaskIds((current) => {
      const next = new Set(current);
      next.delete(draggedTaskId);
      return next;
    });
    if (activeRightTaskId === draggedTaskId) {
      setActiveRightTaskId(remaining[0]?.id ?? null);
    }
    setFocusedPane("left");
    setActiveTaskId(draggedTaskId);
    setDraggedTaskId(null);
  };
  return <>{!open ? <button aria-label={t("dock.openAria")} className="fixed inset-x-0 bottom-0 z-50 flex h-9 w-full items-center gap-2 border-t border-border bg-card/95 px-3 text-left shadow-[0_-4px_18px_-14px_rgba(0,0,0,.45)] backdrop-blur" onClick={() => setOpen(true)} type="button"><Logo className="size-3.5 text-primary" /><span className="text-xs font-medium">{railProviderLabel}</span><span className="h-3 w-px bg-border" /><span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">{activeTaskLabel}</span><DockStatusStrip git={git} provider={railProviderId} variant="strip" />{focusedTask ? <span className={cn("font-mono text-[10px] text-muted-foreground", focusedTask.state === "running" && "text-emerald-600", focusedTask.state === "error" && "text-destructive")}><span className="sr-only">{t("dock.activeStatusSr")}</span>{stateLabel(focusedTask.state)}</span> : null}{tasks.length > 1 ? <span className="font-mono text-[10px] text-muted-foreground">{tasks.length}</span> : null}<ChevronUp className="size-3.5 text-muted-foreground" /></button> : null}<div aria-hidden={!open || undefined} className={cn("fixed inset-x-0 bottom-0 z-50 flex flex-col overflow-hidden border-t border-border bg-card shadow-[0_-12px_30px_-20px_rgba(0,0,0,.5)]", !fullScreen && (resizing || "transition-[height] duration-150"), !open && "invisible pointer-events-none border-transparent shadow-none")} inert={!open || undefined} style={fullScreen ? { height: "auto", top: isTauri() ? 32 : 0 } : { height: open ? (height ?? "50vh") : 0 }}>
    {fullScreen ? <nav aria-label={t("dock.fullscreenNavAria")} className="flex h-11 shrink-0 items-center gap-1 overflow-x-auto border-b border-border bg-background px-2">{FULLSCREEN_NAV.map((item) => <button aria-current={currentPage === item.page ? "page" : undefined} aria-label={t(item.labelKey)} className={cn("flex h-8 shrink-0 items-center gap-2 rounded-md px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground [&_svg]:size-4", currentPage === item.page && "bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground")} key={item.page} onClick={() => navigate(item.page)} type="button">{item.icon}<span>{t(item.labelKey)}</span></button>)}</nav> : null}
    <div aria-hidden className={cn("absolute inset-x-0 -top-1 z-20 h-2 cursor-ns-resize", fullScreen && "hidden")} data-agent-resize-grip onDoubleClick={() => setHeight(null)} onPointerDown={resizeStart} />
    <div className="flex h-9 shrink-0 items-stretch border-b border-border bg-muted/25" data-agent-dock-toolbar>
      {split ? <span className="min-w-0 flex-1" /> : <AgentTerminalTabs activeTaskId={activeTaskId} composing={composing} onActivate={activateLeft} onClose={(id) => void closeLeft(id)} onDragEnd={() => setDraggedTaskId(null)} onDragStart={setDraggedTaskId} onRename={(id, label) => void renameTask(id, label)} pendingTaskIds={pendingTaskIds} tasks={leftTasks} />}
      {agentContext ? <AgentCapabilityBadges capabilities={capabilities} onInsert={insertCapability} onNavigate={onNavigate ? navigate : undefined} providerLabel={railProviderLabel} /> : <span className="flex-1" />}
      <DockStatusStrip git={git} provider={railProviderId} variant="dock" />
      <div className="flex shrink-0 items-center border-l border-border px-1">
        <AgentConversationPicker error={transcriptsError} loading={transcriptsLoading} onLoad={loadTranscripts} onResume={resumeInFocusedPane} transcripts={transcripts} />
        <AgentNewSessionMenu
          creating={Boolean(creating)}
          onCreateAgent={(selectedProvider) => void createAgentInFocusedPane(selectedProvider)}
          onCreateShell={() => void createShellInFocusedPane()}
          providers={providers}
        />
        {focusedTask?.state === "running" ? <button aria-label={t("dock.stopTaskAria", { label: activeTaskLabel })} className="grid size-7 place-items-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-35" disabled={pendingTaskIds.has(focusedTask.id)} onClick={() => void stopTask(focusedTask.id)} type="button"><Square className="size-3" /></button> : null}
        <button aria-label={fullScreen ? t("dock.restoreDock") : t("dock.enterFullScreen")} className="grid size-7 place-items-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground" onClick={() => setFullScreen((value) => !value)} type="button">{fullScreen ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}</button>
        <button aria-label={t("dock.collapseAria")} className="grid size-7 place-items-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground" onClick={collapse} type="button"><ChevronDown className="size-3.5" /></button>
      </div>
    </div>
    {terminalError ? <div role="alert" className="border-b border-destructive/30 bg-destructive/5 px-3 py-1 font-mono text-[11px] text-destructive">{terminalError}</div> : null}
    {git && composing ? <div className="shrink-0 px-3 pt-2"><GitSituationBanner git={git} onRefresh={onGitRefresh} /></div> : null}
    <div className="relative min-h-0 flex-1 bg-background" data-agent-split-container ref={splitContainerRef}>
      {split ? <>
        <div className="absolute left-0 top-0 z-10 flex h-9 items-stretch overflow-hidden border-b border-border bg-muted/25" data-agent-pane-tabs="left" style={{ right: `${100 - splitPercent}%` }}>
          <AgentTerminalTabs activeTaskId={activeTaskId} ariaLabel={t("dock.leftTasksAria")} composing={composing} onActivate={activateLeft} onClose={(id) => void closeLeft(id)} onDragEnd={() => setDraggedTaskId(null)} onDragStart={setDraggedTaskId} onRename={(id, label) => void renameTask(id, label)} pendingTaskIds={pendingTaskIds} tasks={leftTasks} />
        </div>
        <div className="absolute right-0 top-0 z-10 flex h-9 items-stretch overflow-hidden border-b border-border bg-muted/25" data-agent-pane-tabs="right" style={{ left: `${splitPercent}%` }}>
          <AgentTerminalTabs activeTaskId={rightActive?.id ?? null} ariaLabel={t("dock.rightTasksAria")} composing={false} onActivate={activateRight} onClose={(id) => void closeRight(id)} onDragEnd={() => setDraggedTaskId(null)} onDragStart={setDraggedTaskId} onRename={(id, label) => void renameTask(id, label)} pendingTaskIds={pendingTaskIds} tasks={rightTasks} />
        </div>
      </> : null}
      {tasks.map((task) => {
        const inRightPane = rightTaskIds.has(task.id);
        const shown = open && (inRightPane ? task.id === rightActive?.id : task.id === activeTaskId);
        const focused = shown && focusedPane === (inRightPane ? "right" : "left");
        const paneStyle = split ? (inRightPane ? { left: `${splitPercent}%`, right: 0 } : { left: 0, right: `${100 - splitPercent}%` }) : undefined;
        return <div aria-labelledby={`agent-tab-${task.id}`} className={cn("absolute bottom-0", split ? "top-9" : "top-0 inset-x-0", !shown && "invisible pointer-events-none")} id={`agent-panel-${task.id}`} key={task.id} onPointerDown={() => { paneIntentSequenceRef.current += 1; setFocusedPane(inRightPane ? "right" : "left"); }} role="tabpanel" style={paneStyle}><TerminalViewport active={shown} claimInitialInput={() => claimInitialInput(task.id)} displaySettings={settings?.confirmedGlobal.terminal} focused={focused} onStatusChange={(status: TerminalViewportStatus) => updateTaskStatus(task.id, { state: status.state === "connecting" ? "idle" : status.state, cwd: status.cwd, error: status.state === "error" ? status.detail : undefined })} ref={(handle) => { if (handle) viewportHandlesRef.current.set(task.id, handle); else viewportHandlesRef.current.delete(task.id); }} sessionId={task.id} /></div>;
      })}
      {open && composing ? <div aria-labelledby={`agent-tab-${COMPOSE_TAB_ID}`} className={cn("absolute bottom-0 bg-background", split ? "top-9" : "top-0 inset-x-0")} id={`agent-panel-${COMPOSE_TAB_ID}`} onPointerDown={() => { paneIntentSequenceRef.current += 1; setFocusedPane("left"); }} role="tabpanel" style={split ? { left: 0, right: `${100 - splitPercent}%` } : undefined}><AgentTerminalComposer capabilities={shellMode ? undefined : capabilities} onNavigate={onNavigate ? navigate : undefined} onShellMode={setShellMode} shellMode={shellMode} /></div> : null}
      {split ? <hr aria-label={t("dock.splitResizeAria")} aria-orientation="vertical" aria-valuemax={75} aria-valuemin={25} aria-valuenow={Math.round(splitPercent)} className="absolute inset-y-0 z-20 h-auto w-3 -translate-x-1/2 cursor-col-resize touch-none border-0 bg-transparent after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:bg-border after:transition-colors hover:after:bg-primary focus-visible:after:bg-primary" onDoubleClick={() => setSplitPercent(50)} onKeyDown={(event) => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); setSplitPercent((value) => Math.max(25, Math.min(75, value + (event.key === "ArrowLeft" ? -5 : 5)))); } }} onPointerDown={splitResizeStart} style={{ left: `${splitPercent}%` }} tabIndex={0} /> : null}
      {canDropRight ? <section aria-label={t("dock.splitDropTarget")} className={cn("absolute bottom-2 right-2 z-30 grid place-items-center rounded-md border border-dashed border-primary/60 bg-primary/10 text-xs font-medium text-primary backdrop-blur-sm", split ? "top-11" : "top-2")} onDragOver={(event) => { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = "move"; }} onDrop={(event) => { event.preventDefault(); dropDraggedRight(); }} style={{ width: split ? `calc(${100 - splitPercent}% - 0.75rem)` : "calc(50% - 0.75rem)" }}>{t("dock.splitDropTarget")}</section> : null}
      {draggedFromRight ? <section aria-label={t("dock.leftDropTarget")} className="absolute bottom-2 left-2 top-11 z-30 grid place-items-center rounded-md border border-dashed border-primary/60 bg-primary/10 text-xs font-medium text-primary backdrop-blur-sm" onDragOver={(event) => { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = "move"; }} onDrop={(event) => { event.preventDefault(); dropDraggedLeft(); }} style={{ width: `calc(${splitPercent}% - 0.75rem)` }}>{t("dock.leftDropTarget")}</section> : null}
    </div>
  </div></>;
}
