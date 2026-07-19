import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Bot, ChevronDown, ChevronUp, Database, GitBranch, Inbox, Maximize2, Minimize2, Plus, Puzzle, Server, Square, SquareTerminal, Workflow } from "lucide-react";
import type { DashboardData } from "@/lib/api";
import { cn } from "@/lib/utils";
import { ClaudeLogo, CodexLogo } from "../agent-logos";
import { useAgentDock } from "../chat/agent-context";
import { GitSituationBanner } from "../../git/git-situation-banner";
import { TerminalViewport, type TerminalViewportHandle, type TerminalViewportStatus } from "../../terminal/terminal-viewport";
import { AgentCapabilityBadges } from "./agent-capability-strip";
import { useAgentCapabilities } from "./agent-capability-data";
import { AgentTerminalComposer } from "./agent-terminal-composer";
import { AgentTerminalTabs } from "./agent-terminal-tabs";
import { GitHubLogo } from "../../github/github-logo";
import { isTauri } from "@/lib/tauri";
import { useOptionalSettings } from "@/features/settings/settings-context";
import { useT, type TranslationKey } from "@/lib/i18n";

export type AgentDockPage = "services" | "git" | "github" | "workflows" | "errors" | "database" | "terminal" | "agent" | "agent-env" | "settings";

const FULLSCREEN_NAV: Array<{ page: AgentDockPage; labelKey: TranslationKey; icon: ReactNode }> = [
  { page: "services", labelKey: "nav.services", icon: <Server /> },
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

export function AgentTerminalDock({ currentPage = "services", git, onGitRefresh, onNavigate }: { currentPage?: AgentDockPage; git?: DashboardData["git"]; onGitRefresh?: () => void; onNavigate?: (page: AgentDockPage) => void }) {
  const t = useT();
  const settings = useOptionalSettings();
  const { activeTaskId, closeTask, draft, focusNonce, insertPrompt, onboarding, open, pendingTaskIds, provider, providers, selectProvider, setActiveTaskId, setOpen, stopTask, tasks, terminalError, updateTaskStatus } = useAgentDock();
  const [compose, setCompose] = useState(() => Boolean(draft || focusNonce || onboarding || tasks.length === 0)); const [height, setHeight] = useState<number | null>(null); const [resizing, setResizing] = useState(false);
  const [fullScreen, setFullScreen] = useState(false);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const viewportHandlesRef = useRef(new Map<string, TerminalViewportHandle>());
  const previousFocusNonceRef = useRef(focusNonce);
  const previousOnboardingRef = useRef(onboarding);
  const previousTaskCountRef = useRef(tasks.length);
  const active = tasks.find((task) => task.id === activeTaskId) ?? null;
  useEffect(() => {
    if (tasks.length === 0) setCompose(true);
    else if (previousTaskCountRef.current === 0 && !draft) setCompose(false);
    previousTaskCountRef.current = tasks.length;
  }, [draft, tasks.length]);
  useEffect(() => {
    if (focusNonce !== previousFocusNonceRef.current) setCompose(true);
    previousFocusNonceRef.current = focusNonce;
  }, [focusNonce]);
  useEffect(() => {
    if (onboarding && !previousOnboardingRef.current) setCompose(true);
    previousOnboardingRef.current = onboarding;
  }, [onboarding]);
  useEffect(() => () => resizeCleanupRef.current?.(), []);
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
  const collapse = () => { setFullScreen(false); setOpen(false); };
  const navigate = (page: AgentDockPage) => { onNavigate?.(page); collapse(); };
  function resizeStart(event: ReactPointerEvent<HTMLDivElement>) { event.preventDefault(); event.currentTarget.setPointerCapture?.(event.pointerId); setResizing(true); const move = (e: PointerEvent) => setHeight(clampAgentDockHeight(window.innerHeight - e.clientY, window.innerHeight)); const cleanup = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); resizeCleanupRef.current = null; }; const up = () => { setResizing(false); cleanup(); }; resizeCleanupRef.current?.(); resizeCleanupRef.current = cleanup; window.addEventListener("pointermove", move); window.addEventListener("pointerup", up); }
  const railProviderId = active?.provider ?? provider?.id;
  const Logo = railProviderId === "codex" ? CodexLogo : ClaudeLogo;
  const railProviderLabel = active ? (active.provider === "codex" ? "Codex" : "Claude Code") : (provider?.label ?? "Agent");
  // Counts follow what the user is looking at: the selected provider while
  // composing, the active task's provider while a terminal is showing.
  const composing = compose || tasks.length === 0;
  const capabilities = useAgentCapabilities(
    ((composing ? provider?.id : (active?.provider ?? provider?.id)) ?? "claude") === "codex" ? "codex" : "claude",
    open,
  );
  // Capability clicks type straight into the focused terminal when one is
  // showing and connected; otherwise they land in the composer draft.
  const insertCapability = (text: string) => {
    if (!composing && active?.state === "running") {
      const handle = viewportHandlesRef.current.get(active.id);
      if (handle) {
        handle.input(text);
        handle.focus();
        return;
      }
    }
    insertPrompt(text);
  };
  return <>{!open ? <button aria-label={t("dock.openAria")} className="fixed inset-x-0 bottom-0 z-50 flex h-9 w-full items-center gap-2 border-t border-border bg-card/95 px-3 text-left shadow-[0_-4px_18px_-14px_rgba(0,0,0,.45)] backdrop-blur" onClick={() => setOpen(true)} type="button"><Logo className="size-3.5 text-primary" /><span className="text-xs font-medium">{railProviderLabel}</span><span className="h-3 w-px bg-border" /><span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">{active?.label ?? t("dock.newTask")}</span>{active ? <span className={cn("font-mono text-[10px] text-muted-foreground", active.state === "running" && "text-emerald-600", active.state === "error" && "text-destructive")}><span className="sr-only">{t("dock.activeStatusSr")}</span>{stateLabel(active.state)}</span> : null}{tasks.length > 1 ? <span className="font-mono text-[10px] text-muted-foreground">{tasks.length}</span> : null}<ChevronUp className="size-3.5 text-muted-foreground" /></button> : null}<div aria-hidden={!open || undefined} className={cn("fixed inset-x-0 bottom-0 z-50 flex flex-col overflow-hidden border-t border-border bg-card shadow-[0_-12px_30px_-20px_rgba(0,0,0,.5)]", !fullScreen && (resizing || "transition-[height] duration-150"), !open && "invisible pointer-events-none border-transparent shadow-none")} inert={!open || undefined} style={fullScreen ? { height: "auto", top: isTauri() ? 32 : 0 } : { height: open ? (height ?? "50vh") : 0 }}>
    {fullScreen ? <nav aria-label={t("dock.fullscreenNavAria")} className="flex h-11 shrink-0 items-center gap-1 overflow-x-auto border-b border-border bg-background px-2">{FULLSCREEN_NAV.map((item) => <button aria-current={currentPage === item.page ? "page" : undefined} aria-label={t(item.labelKey)} className={cn("flex h-8 shrink-0 items-center gap-2 rounded-md px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground [&_svg]:size-4", currentPage === item.page && "bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground")} key={item.page} onClick={() => navigate(item.page)} type="button">{item.icon}<span>{t(item.labelKey)}</span></button>)}</nav> : null}
    <div aria-hidden className={cn("absolute inset-x-0 -top-1 z-20 h-2 cursor-ns-resize", fullScreen && "hidden")} data-agent-resize-grip onDoubleClick={() => setHeight(null)} onPointerDown={resizeStart} />
    <div className="flex h-9 shrink-0 items-stretch border-b border-border bg-muted/25">
      <fieldset aria-label={t("dock.providerAria")} className="flex shrink-0 items-center gap-0.5 border-r border-border px-1">{providers.map((p) => { const ProviderLogo = p.id === "codex" ? CodexLogo : ClaudeLogo; const selected = (provider?.id ?? "claude") === p.id; return <button aria-label={p.label} aria-pressed={selected} className={cn("flex h-7 items-center gap-1.5 rounded-sm px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40", selected && "bg-muted text-foreground")} disabled={!p.configured} key={p.id} onClick={() => void selectProvider(p.id)} title={p.configured ? p.label : `${p.label}${t("dock.notInstalledSuffix")} — ${p.installHint}`} type="button"><ProviderLogo className="size-3.5" />{selected ? <span>{p.label}</span> : null}</button>; })}</fieldset>
      <AgentTerminalTabs activeTaskId={activeTaskId} onActivate={(id) => { setActiveTaskId(id); setCompose(false); }} onClose={(id) => void closeTask(id)} pendingTaskIds={pendingTaskIds} tasks={tasks} />
      <AgentCapabilityBadges capabilities={capabilities} onInsert={insertCapability} onNavigate={onNavigate ? navigate : undefined} providerLabel={railProviderLabel} />
      <div className="flex shrink-0 items-center border-l border-border px-1">
        <button aria-label={t("dock.newTask")} className="grid size-7 place-items-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground" onClick={() => setCompose(true)} type="button"><Plus className="size-3.5" /></button>
        {active?.state === "running" ? <button aria-label={t("dock.stopTaskAria", { label: active.label ?? t("dock.newTask") })} className="grid size-7 place-items-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-35" disabled={pendingTaskIds.has(active.id)} onClick={() => void stopTask(active.id)} type="button"><Square className="size-3" /></button> : null}
        <button aria-label={fullScreen ? t("dock.restoreDock") : t("dock.enterFullScreen")} className="grid size-7 place-items-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground" onClick={() => setFullScreen((value) => !value)} type="button">{fullScreen ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}</button>
        <button aria-label={t("dock.collapseAria")} className="grid size-7 place-items-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground" onClick={collapse} type="button"><ChevronDown className="size-3.5" /></button>
      </div>
    </div>
    {terminalError ? <div role="alert" className="border-b border-destructive/30 bg-destructive/5 px-3 py-1 font-mono text-[11px] text-destructive">{terminalError}</div> : null}
    {git && (compose || tasks.length === 0) ? <div className="shrink-0 px-3 pt-2"><GitSituationBanner git={git} onRefresh={onGitRefresh} /></div> : null}
    <div className="relative min-h-0 flex-1 bg-[#101214]">
      {tasks.map((task) => <div aria-labelledby={`agent-tab-${task.id}`} className={cn("absolute inset-0", (!open || compose || task.id !== activeTaskId) && "invisible pointer-events-none")} id={`agent-panel-${task.id}`} key={task.id} role="tabpanel"><TerminalViewport active={open && !compose && task.id === activeTaskId} displaySettings={settings?.confirmedGlobal.terminal} onStatusChange={(status: TerminalViewportStatus) => updateTaskStatus(task.id, { state: status.state === "connecting" ? "idle" : status.state, cwd: status.cwd, error: status.state === "error" ? status.detail : undefined })} ref={(handle) => { if (handle) viewportHandlesRef.current.set(task.id, handle); else viewportHandlesRef.current.delete(task.id); }} sessionId={task.id} /></div>)}
      {open && (compose || tasks.length === 0) ? <div className="absolute inset-0 bg-background"><AgentTerminalComposer capabilities={capabilities} onNavigate={onNavigate ? navigate : undefined} onSubmitted={() => setCompose(false)} /></div> : null}
    </div>
  </div></>;
}
