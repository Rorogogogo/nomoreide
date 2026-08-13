import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Grip, LoaderCircle, Maximize2, Minimize2, PanelBottom, PanelLeft, PanelRight, Plus, RotateCcw, Sparkles, SquareTerminal, X } from "lucide-react";
// SquareTerminal doubles as the shell tab/rail mark — see AgentTerminalTabs.
import {
  insertAgentPrompt,
  loadOneTimeSkillPrompt,
  type DashboardData,
  type OneTimeSkillSelection,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { ClaudeLogo, CodexLogo } from "../agent-logos";
import { type ForegroundAgentDelivery, useAgentDock } from "../chat/agent-context";
import { useToasts } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { GitSituationBanner } from "../../git/git-situation-banner";
import { TerminalViewport, type TerminalViewportHandle, type TerminalViewportStatus } from "../../terminal/terminal-viewport";
import { AgentCapabilityBadges } from "./agent-capability-strip";
import { useAgentCapabilities } from "./agent-capability-data";
import { AgentTerminalComposer } from "./agent-terminal-composer";
import { AgentHistoryRail, HISTORY_RAIL_WIDTH } from "./agent-history-rail";
import { AgentTerminalTabs } from "./agent-terminal-tabs";
import { playAgentCompletionChime } from "./agent-completion-sound";
import { DockStatusStrip } from "./dock-status-strip";
import { COMPOSE_TAB_ID } from "./compose-tab";
import { requestGitHubActions } from "../../github/github-navigation";
import { isTauri } from "@/lib/tauri";
import { useOptionalSettings } from "@/features/settings/settings-context";
import { useT } from "@/lib/i18n";
import {
  APP_NAV_ITEMS,
  type AppPage,
} from "@/components/app-navigation";

export type AgentDockPage = AppPage;

export function clampAgentDockHeight(height: number, viewportHeight: number) { const maximum = Math.max(0, Math.min(viewportHeight - 48, Math.round(viewportHeight * 0.7))); const minimum = Math.min(180, maximum); return Math.max(minimum, Math.min(maximum, height)); }
export function clampAgentDockWidth(width: number, viewportWidth: number) { const maximum = Math.max(0, Math.min(viewportWidth - 320, Math.round(viewportWidth * 0.7))); const minimum = Math.min(340, maximum); return Math.max(minimum, Math.min(maximum, width)); }
function stateLabel(state: string) { return `${state.charAt(0).toUpperCase()}${state.slice(1)}`; }
type DockPane = "left" | "right";
type DockPlacement = "bottom" | "right";

export function AgentTerminalDock({ currentPage = "services", git, onGitRefresh, onInsetChange, onNavigate }: { currentPage?: AgentDockPage; git?: DashboardData["git"]; onGitRefresh?: () => void; onInsetChange?: (placement: DockPlacement, size: number, resizing: boolean) => void; onNavigate?: (page: AgentDockPage) => void }) {
  const t = useT();
  const { error: showError, success: showSuccess } = useToasts();
  const settings = useOptionalSettings();
  const { activeTaskId, bringTaskBackToDock, claimInitialInput, clearOneTimeSkill, closeTask, consumeOneTimeSkill, dockLayout, draft, focusNonce, insertPrompt, loadTranscripts, onboarding, open, openTaskInTerminal, pendingOneTimeSkill, pendingTaskIds, provider, registerForegroundAgentDeliveryHandler, renameTask, resumeTask, selectOneTimeSkill, sendToAgent, setActiveTaskId, setOpen, tasks, tasksHydrated, tasksHydrationSettled, terminalCapabilities, terminalError, transcripts, transcriptsError, transcriptsLoading, updateDockLayout, updateTaskStatus } = useAgentDock();
  const [height, setHeight] = useState<number | null>(dockLayout.bottomHeight);
  const [width, setWidth] = useState(dockLayout.rightWidth);
  const [resizing, setResizing] = useState(false);
  const [wideEnoughForSide, setWideEnoughForSide] = useState(() => typeof window.matchMedia !== "function" || window.matchMedia("(min-width: 700px)").matches);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const [positionDragging, setPositionDragging] = useState(false);
  const [snapCandidate, setSnapCandidate] = useState<DockPlacement | null>(null);
  const [fullScreen, setFullScreen] = useState(false);
  const [rightTaskIds, setRightTaskIds] = useState<Set<string>>(
    () => new Set(dockLayout.rightTaskIds),
  );
  const [activeRightTaskId, setActiveRightTaskId] = useState<string | null>(
    dockLayout.activeRightTaskId,
  );
  const [focusedPane, setFocusedPane] = useState<DockPane>(
    dockLayout.focusedPane,
  );
  const [splitPercent, setSplitPercent] = useState(dockLayout.splitPercent);
  const [layoutRestored, setLayoutRestored] = useState(false);
  const [draggedTaskId, setDraggedTaskId] = useState<string | null>(null);
  const [shellMode, setShellMode] = useState(false);
  const [skillPromptBusy, setSkillPromptBusy] = useState(false);
  const [skillPromptError, setSkillPromptError] = useState<string | null>(null);
  const [skillInjectionRetry, setSkillInjectionRetry] = useState(0);
  const [latestRailTask, setLatestRailTask] = useState<(typeof tasks)[number] | null>(null);
  const [pendingDelivery, setPendingDelivery] =
    useState<ForegroundAgentDelivery | null>(null);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const positionCleanupRef = useRef<(() => void) | null>(null);
  const suppressPositionClickRef = useRef(false);
  const splitResizeCleanupRef = useRef<(() => void) | null>(null);
  const splitContainerRef = useRef<HTMLDivElement>(null);
  const deliveryTargetButtonRef = useRef<HTMLButtonElement>(null);
  const foregroundDeliveryHandlerRef = useRef<
    (delivery: ForegroundAgentDelivery) => "draft" | "handled"
  >(() => "draft");
  const viewportHandlesRef = useRef(new Map<string, TerminalViewportHandle>());
  const previousFocusNonceRef = useRef(focusNonce);
  const previousOnboardingRef = useRef(onboarding);
  const paneIntentSequenceRef = useRef(0);
  const skillInjectionSequenceRef = useRef(0);
  const initialDockLayoutRef = useRef(dockLayout);
  const layoutMutatedBeforeRestoreRef = useRef(false);
  const heightRef = useRef(height);
  const widthRef = useRef(width);
  const splitPercentRef = useRef(splitPercent);
  const taskStateRef = useRef(new Map<string, string>());
  const preferredPlacement = settings?.ui.agentDockPlacement ?? "bottom";
  const placement: DockPlacement =
    preferredPlacement === "right" && wideEnoughForSide ? "right" : "bottom";
  const sideDocked = placement === "right" && !fullScreen;
  const effectiveHeight =
    height === null ? null : clampAgentDockHeight(height, window.innerHeight);
  const effectiveWidth = clampAgentDockWidth(width, window.innerWidth);
  const markLayoutMutation = () => {
    layoutMutatedBeforeRestoreRef.current = true;
  };
  // Work staged before this mount (the dock mounts with the app, so a draft can
  // arrive while it is closed) still has to land on the composer; the effects
  // below only see changes that happen after mount.
  useEffect(() => {
    if ((draft || onboarding) && !pendingOneTimeSkill) {
      markLayoutMutation();
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
      if (!pendingOneTimeSkill) {
        markLayoutMutation();
        setShellMode(false);
        paneIntentSequenceRef.current += 1;
        setFocusedPane("left");
        setActiveTaskId(COMPOSE_TAB_ID);
      }
    }
    previousFocusNonceRef.current = focusNonce;
  }, [focusNonce, pendingOneTimeSkill, setActiveTaskId]);
  useEffect(() => {
    if (onboarding && !previousOnboardingRef.current) {
      markLayoutMutation();
      setShellMode(false);
      paneIntentSequenceRef.current += 1;
      setFocusedPane("left");
      setActiveTaskId(COMPOSE_TAB_ID);
    }
    previousOnboardingRef.current = onboarding;
  }, [onboarding, setActiveTaskId]);
  useEffect(() => () => {
    resizeCleanupRef.current?.();
    positionCleanupRef.current?.();
    splitResizeCleanupRef.current?.();
  }, []);
  useEffect(
    () =>
      registerForegroundAgentDeliveryHandler((delivery) =>
        foregroundDeliveryHandlerRef.current(delivery),
      ),
    [registerForegroundAgentDeliveryHandler],
  );
  useEffect(() => {
    if (!pendingDelivery) return;
    deliveryTargetButtonRef.current?.focus();
    const cancel = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPendingDelivery(null);
    };
    window.addEventListener("keydown", cancel);
    return () => window.removeEventListener("keydown", cancel);
  }, [pendingDelivery]);
  useEffect(() => {
    const update = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(min-width: 700px)");
    const update = () => setWideEnoughForSide(query.matches);
    update();
    query.addEventListener?.("change", update);
    return () => query.removeEventListener?.("change", update);
  }, []);
  useEffect(() => {
    onInsetChange?.(
      placement,
      fullScreen ? 0 : placement === "right" ? (open ? effectiveWidth : 36) : 36,
      resizing,
    );
  }, [effectiveWidth, fullScreen, onInsetChange, open, placement, resizing]);
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
    if (!tasksHydrated) return;
    const liveIds = new Set(tasks.map((task) => task.id));
    for (const task of tasks) {
      if (!taskStateRef.current.has(task.id)) taskStateRef.current.set(task.id, task.state);
    }
    for (const id of taskStateRef.current.keys()) {
      if (!liveIds.has(id)) taskStateRef.current.delete(id);
    }
    setRightTaskIds((current) => {
      const next = new Set([...current].filter((id) => liveIds.has(id)));
      if (next.size === current.size && [...next].every((id) => current.has(id))) {
        return current;
      }
      return next;
    });
  }, [tasks, tasksHydrated]);
  const handleTaskStatus = (
    task: (typeof tasks)[number],
    status: TerminalViewportStatus,
  ) => {
    const nextState = status.state === "connecting" ? "idle" : status.state;
    const previousState = taskStateRef.current.get(task.id) ?? task.state;
    taskStateRef.current.set(task.id, nextState);
    if (
      settings?.ui.agentCompletionSound &&
      task.kind !== "shell" &&
      previousState === "running" &&
      nextState === "exited" &&
      !pendingTaskIds.has(task.id)
    ) {
      playAgentCompletionChime();
    }
    updateTaskStatus(task.id, {
      state: nextState,
      cwd: status.cwd,
      error: status.state === "error" ? status.detail : undefined,
    });
  };
  const historyRailOpen = dockLayout.historyRailOpen;
  // Side-docked the dock owns its own width; otherwise it spans the viewport.
  // Below this the rail would leave too little room for the terminal, so it
  // floats over the session instead of displacing it.
  const dockContentWidth =
    sideDocked && !fullScreen ? effectiveWidth : viewportWidth;
  const historyRailOverlay = dockContentWidth < HISTORY_RAIL_WIDTH + 400;
  const collapse = () => { setFullScreen(false); setOpen(false); };
  const navigate = (page: AgentDockPage) => { onNavigate?.(page); collapse(); };
  const openGitHubActions = (branch: string) => {
    requestGitHubActions(branch);
    navigate("github");
  };
  function resizeStart(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setResizing(true);
    const move = (nextEvent: PointerEvent) => {
      if (sideDocked) {
        const next = clampAgentDockWidth(
          window.innerWidth - nextEvent.clientX,
          window.innerWidth,
        );
        widthRef.current = next;
        setWidth(next);
      } else {
        const next = clampAgentDockHeight(
          window.innerHeight - nextEvent.clientY,
          window.innerHeight,
        );
        heightRef.current = next;
        setHeight(next);
      }
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      resizeCleanupRef.current = null;
    };
    const up = () => {
      setResizing(false);
      updateDockLayout(
        sideDocked
          ? { rightWidth: widthRef.current }
          : { bottomHeight: heightRef.current },
      );
      cleanup();
    };
    resizeCleanupRef.current?.();
    resizeCleanupRef.current = cleanup;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }
  function setPlacement(next: DockPlacement) {
    settings?.updateUi({ agentDockPlacement: next });
  }
  function positionDragStart(event: ReactPointerEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const origin = { x: event.clientX, y: event.clientY };
    let dragged = false;
    setPositionDragging(true);
    setSnapCandidate(placement);
    const candidateFor = (nextEvent: PointerEvent): DockPlacement =>
      wideEnoughForSide && nextEvent.clientX >= window.innerWidth * 0.72 ? "right" : "bottom";
    const move = (nextEvent: PointerEvent) => {
      if (Math.hypot(nextEvent.clientX - origin.x, nextEvent.clientY - origin.y) > 5) {
        dragged = true;
      }
      setSnapCandidate(candidateFor(nextEvent));
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      positionCleanupRef.current = null;
    };
    const up = (nextEvent: PointerEvent) => {
      if (dragged) {
        suppressPositionClickRef.current = true;
        window.setTimeout(() => {
          suppressPositionClickRef.current = false;
        }, 0);
      }
      setPlacement(candidateFor(nextEvent));
      setPositionDragging(false);
      setSnapCandidate(null);
      cleanup();
    };
    positionCleanupRef.current?.();
    positionCleanupRef.current = cleanup;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }
  function splitResizeStart(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const move = (nextEvent: PointerEvent) => {
      const bounds = splitContainerRef.current?.getBoundingClientRect();
      if (!bounds?.width) return;
      const percent = ((nextEvent.clientX - bounds.left) / bounds.width) * 100;
      const next = Math.max(25, Math.min(75, percent));
      splitPercentRef.current = next;
      setSplitPercent(next);
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      splitResizeCleanupRef.current = null;
    };
    const up = () => {
      updateDockLayout({ splitPercent: splitPercentRef.current });
      cleanup();
    };
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
  useEffect(() => {
    if (!tasksHydrationSettled || layoutRestored) return;
    if (!tasksHydrated) {
      setLayoutRestored(true);
      return;
    }
    const saved = initialDockLayoutRef.current;
    const preferLiveLayout = layoutMutatedBeforeRestoreRef.current;
    const liveIds = new Set(tasks.map((task) => task.id));
    const requestedRightIds = preferLiveLayout
      ? [...rightTaskIds]
      : saved.rightTaskIds;
    const nextRightIds = requestedRightIds.filter((id) => liveIds.has(id));
    const nextRightIdSet = new Set(nextRightIds);
    const nextLeftTasks = tasks.filter((task) => !nextRightIdSet.has(task.id));
    const savedLeftId = preferLiveLayout
      ? activeTaskId
      : saved.activeLeftTaskId;
    const nextLeftId =
      savedLeftId === COMPOSE_TAB_ID ||
      (savedLeftId !== null &&
        liveIds.has(savedLeftId) &&
        !nextRightIdSet.has(savedLeftId))
        ? savedLeftId
        : activeTaskId !== null &&
            (activeTaskId === COMPOSE_TAB_ID ||
              (liveIds.has(activeTaskId) && !nextRightIdSet.has(activeTaskId)))
          ? activeTaskId
          : nextLeftTasks[0]?.id ?? null;
    const requestedRightActiveId = preferLiveLayout
      ? activeRightTaskId
      : saved.activeRightTaskId;
    const nextRightId =
      requestedRightActiveId &&
      nextRightIdSet.has(requestedRightActiveId)
        ? requestedRightActiveId
        : nextRightIds[0] ?? null;
    const requestedFocusedPane = preferLiveLayout
      ? focusedPane
      : saved.focusedPane;
    const nextFocusedPane =
      requestedFocusedPane === "right" && nextRightId ? "right" : "left";

    setRightTaskIds(nextRightIdSet);
    setActiveRightTaskId(nextRightId);
    setFocusedPane(nextFocusedPane);
    if (nextLeftId !== activeTaskId) setActiveTaskId(nextLeftId);
    updateDockLayout({
      activeLeftTaskId: nextLeftId,
      activeRightTaskId: nextRightId,
      bottomHeight: heightRef.current,
      focusedPane: nextFocusedPane,
      rightTaskIds: nextRightIds,
      rightWidth: widthRef.current,
      splitPercent: splitPercentRef.current,
    });
    setLayoutRestored(true);
  }, [
    activeTaskId,
    activeRightTaskId,
    focusedPane,
    layoutRestored,
    rightTaskIds,
    setActiveTaskId,
    tasks,
    tasksHydrated,
    tasksHydrationSettled,
    updateDockLayout,
  ]);
  const split = rightTasks.length > 0;
  const focusedTask =
    focusedPane === "right" && rightActive ? rightActive : leftActive;
  const currentRailTask =
    focusedTask ??
    tasks.slice().reverse().find((task) => task.state === "running") ??
    tasks.at(-1) ??
    null;
  const layoutSplit = split && !sideDocked;
  // Composing is dock-wide content, but the split header stays stable so the
  // user's session layout does not visually jump. The content divider and
  // terminals return unchanged when a session is selected or created.
  const contentSplit = layoutSplit && !composing;
  const sideActiveTaskId = composing ? COMPOSE_TAB_ID : focusedTask?.id ?? activeTaskId;
  const collapsedFocusedTask =
    focusedPane === "right" && rightActive
      ? rightActive
      : leftActive ?? leftTasks[0] ?? rightActive;
  const deliveryTargets = (
    sideDocked
      ? [focusedTask ?? (!open ? collapsedFocusedTask : null)]
      : [
          open && composing ? null : leftActive ?? (!open ? leftTasks[0] : null),
          layoutSplit && (!open || !composing) ? rightActive : null,
        ]
  ).filter(
    (task): task is NonNullable<typeof focusedTask> =>
      Boolean(
        task &&
          task.kind !== "shell" &&
          task.state === "running" &&
          task.presentation !== "terminalLaunching",
      ),
  );
  useEffect(() => {
    if (currentRailTask) setLatestRailTask(currentRailTask);
  }, [currentRailTask]);
  useEffect(() => {
    if (pendingDelivery && deliveryTargets.length < 2) {
      setPendingDelivery(null);
    }
  }, [pendingDelivery, deliveryTargets.length]);
  useEffect(() => {
    if (rightActive?.id !== activeRightTaskId) {
      setActiveRightTaskId(rightActive?.id ?? null);
    }
    if (!rightActive && focusedPane === "right") setFocusedPane("left");
  }, [activeRightTaskId, focusedPane, rightActive]);
  const persistedRightTaskIdsKey = rightTasks
    .map((task) => task.id)
    .join("\0");
  const persistedLeftTaskId =
    activeTaskId === COMPOSE_TAB_ID ||
    leftTasks.some((task) => task.id === activeTaskId)
      ? activeTaskId
      : null;
  useEffect(() => {
    if (
      !layoutRestored ||
      (!tasksHydrated && !layoutMutatedBeforeRestoreRef.current)
    ) {
      return;
    }
    updateDockLayout({
      activeLeftTaskId: persistedLeftTaskId,
      activeRightTaskId: rightActive?.id ?? null,
      focusedPane:
        focusedPane === "right" && rightActive ? "right" : "left",
      rightTaskIds: persistedRightTaskIdsKey
        ? persistedRightTaskIdsKey.split("\0")
        : [],
    });
  }, [
    focusedPane,
    layoutRestored,
    persistedLeftTaskId,
    persistedRightTaskIdsKey,
    rightActive?.id,
    tasksHydrated,
    updateDockLayout,
  ]);

  const railProviderId = focusedTask?.provider ?? provider?.id;
  const activeShell = focusedTask?.kind === "shell";
  // History is a property of the new-session surface, so the rail follows the
  // composer rather than the dock: with a session in front of the user there is
  // no sidebar at all, only the toolbar "+" that starts a new one.
  const railVisible = open && composing && historyRailOpen;
  const railProviderLabel = activeShell ? t("dock.shell") : focusedTask ? (focusedTask.provider === "codex" ? "Codex" : "Claude Code") : (provider?.label ?? "Agent");
  const collapsedTask = currentRailTask ?? latestRailTask;
  const collapsedShell = collapsedTask?.kind === "shell";
  const collapsedProviderId = collapsedTask?.provider ?? provider?.id;
  const CollapsedLogo = collapsedShell
    ? SquareTerminal
    : collapsedProviderId === "codex"
      ? CodexLogo
      : ClaudeLogo;
  const collapsedProviderLabel = collapsedShell
    ? t("dock.shell")
    : collapsedTask
      ? collapsedTask.provider === "codex"
        ? "Codex"
        : "Claude Code"
      : provider?.label ?? "Agent";
  const collapsedTaskLabel =
    collapsedTask?.label ||
    (collapsedShell ? t("dock.shellFallback") : t("dock.newTask"));
  const collapsedTaskLimit = 4;
  const collapsedTaskIndex = collapsedTask
    ? tasks.findIndex((task) => task.id === collapsedTask.id)
    : 0;
  const collapsedTaskWindowStart = Math.min(
    Math.max(collapsedTaskIndex - 1, 0),
    Math.max(tasks.length - collapsedTaskLimit, 0),
  );
  const collapsedTaskTabs = tasks.slice(
    collapsedTaskWindowStart,
    collapsedTaskWindowStart + collapsedTaskLimit,
  );
  const collapsedHiddenTaskCount = tasks.length - collapsedTaskTabs.length;
  const collapsedStatusLabel = focusedTask
    ? t("dock.activeStatusSr")
    : t("dock.latestStatusSr");
  // Counts follow what the user is looking at: the selected provider while
  // composing, the active task's provider while a terminal is showing.
  // With no sessions the composer is the dock's start page. Once a session
  // exists, an explicit new task or staged draft brings it back.
  // Agent capabilities are meaningless against a plain shell, so the chips go
  // away whenever the thing in front of the user is one.
  const agentContext = focusedTask ? !activeShell : composing && !shellMode;
  // Keep both provider snapshots warm so split panes can render task-scoped
  // capability clusters instead of borrowing whichever pane was focused last.
  const claudeCapabilities = useAgentCapabilities("claude", open);
  const codexCapabilities = useAgentCapabilities("codex", open);
  const capabilitiesFor = (providerId?: string) =>
    providerId === "codex" ? codexCapabilities : claudeCapabilities;
  const capabilities = capabilitiesFor(focusedTask?.provider ?? provider?.id);
  const leftProviderId = leftActive?.provider ?? provider?.id;
  const rightProviderId = rightActive?.provider;
  const leftProviderLabel =
    leftActive?.provider === "codex"
      ? "Codex"
      : leftActive
        ? "Claude Code"
        : provider?.label ?? "Agent";
  const rightProviderLabel =
    rightActive?.provider === "codex" ? "Codex" : "Claude Code";
  const leftAgentContext = leftActive
    ? leftActive.kind !== "shell"
    : composing && !shellMode;
  const rightAgentContext = Boolean(
    rightActive && rightActive.kind !== "shell",
  );
  const injectableTask =
    focusedTask &&
    focusedTask.kind !== "shell" &&
    focusedTask.state === "running" &&
    focusedTask.presentation !== "terminal" &&
    focusedTask.presentation !== "terminalLaunching"
      ? focusedTask
      : null;
  useEffect(() => {
    const skill = pendingOneTimeSkill;
    const taskId = injectableTask?.id;
    if (!skill || !taskId) return;
    const sequence = ++skillInjectionSequenceRef.current;
    setSkillPromptBusy(true);
    setSkillPromptError(null);
    void loadOneTimeSkillPrompt(skill)
      .then((skillPrompt) => {
        if (skillInjectionSequenceRef.current !== sequence) return;
        const handle = viewportHandlesRef.current.get(taskId);
        if (!handle) throw new Error(t("dock.skillPromptUnavailable"));
        const pasted = handle.paste(
          `${skillPrompt.trimEnd()}\n\nUser's request:\n`,
          `Skill: ${skill.name} `,
        );
        if (!pasted) throw new Error(t("dock.skillPromptUnavailable"));
        handle.focus();
        consumeOneTimeSkill(skill);
      })
      .catch((error) => {
        if (skillInjectionSequenceRef.current !== sequence) return;
        setSkillPromptError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (skillInjectionSequenceRef.current === sequence) {
          setSkillPromptBusy(false);
        }
      });
    return () => {
      if (skillInjectionSequenceRef.current === sequence) {
        skillInjectionSequenceRef.current += 1;
      }
    };
  }, [
    consumeOneTimeSkill,
    injectableTask?.id,
    pendingOneTimeSkill,
    skillInjectionRetry,
    t,
  ]);
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
  const stageOneTimeSkill = (skill: OneTimeSkillSelection) => {
    markLayoutMutation();
    setSkillPromptError(null);
    selectOneTimeSkill(skill);
    if (!injectableTask) {
      setActiveTaskId(COMPOSE_TAB_ID);
    }
  };
  const focusPaneTask = (pane: DockPane) => {
    markLayoutMutation();
    paneIntentSequenceRef.current += 1;
    setFocusedPane(pane);
    if (pane === "right" && rightActive) {
      setActiveRightTaskId(rightActive.id);
    } else if (pane === "left" && leftActive) {
      setActiveTaskId(leftActive.id);
    }
  };
  const insertDeliveryIntoTask = (
    task: NonNullable<typeof focusedTask>,
    delivery: ForegroundAgentDelivery,
  ) => {
    const providerLabel = task.provider === "codex" ? "Codex" : "Claude Code";
    if (task.presentation === "terminal") {
      void insertAgentPrompt(task.id, delivery.prompt)
        .then(() => showSuccess(t("dock.insertedInto", { name: providerLabel })))
        .catch(() => {
          showError(t("dock.insertUnavailable"));
          insertPrompt(delivery.prompt);
        });
      return true;
    }
    const handle = viewportHandlesRef.current.get(task.id);
    if (!handle?.paste(delivery.prompt)) return false;
    focusPaneTask(rightTaskIds.has(task.id) ? "right" : "left");
    handle.focus();
    showSuccess(t("dock.insertedInto", { name: providerLabel }));
    return true;
  };
  foregroundDeliveryHandlerRef.current = (delivery) => {
    if (deliveryTargets.length === 0) return "draft";
    if (!open && deliveryTargets.length === 1 && deliveryTargets[0]?.presentation !== "terminal") {
      setOpen(true);
      if (composing) {
        const leftTarget = deliveryTargets.find(
          (task) => !rightTaskIds.has(task.id),
        );
        if (leftTarget) setActiveTaskId(leftTarget.id);
      }
    }
    if (deliveryTargets.length > 1) {
      setPendingDelivery(delivery);
      return "handled";
    }
    return insertDeliveryIntoTask(deliveryTargets[0], delivery)
      ? "handled"
      : "draft";
  };
  const chooseDeliveryTarget = (task: NonNullable<typeof focusedTask>) => {
    const delivery = pendingDelivery;
    if (!delivery) return;
    setPendingDelivery(null);
    if (!open && task.presentation !== "terminal") {
      setOpen(true);
    }
    if (open && task.presentation === "terminal") {
      window.setTimeout(() => document.getElementById(`agent-tab-${task.id}`)?.focus(), 0);
    }
    if (insertDeliveryIntoTask(task, delivery)) return;
    showError(t("dock.insertUnavailable"));
    sendToAgent({ ...delivery, mode: "draft" });
  };
  const insertPaneCapability = (
    pane: DockPane,
    task: typeof focusedTask,
    text: string,
  ) => {
    focusPaneTask(pane);
    if (task?.state === "running") {
      const handle = viewportHandlesRef.current.get(task.id);
      if (handle) {
        handle.input(text);
        handle.focus();
        return;
      }
    }
    setActiveTaskId(COMPOSE_TAB_ID);
    insertPrompt(text);
  };
  const stagePaneOneTimeSkill = (
    pane: DockPane,
    task: typeof focusedTask,
    skill: OneTimeSkillSelection,
  ) => {
    focusPaneTask(pane);
    setSkillPromptError(null);
    selectOneTimeSkill(skill);
    if (!task || task.kind === "shell" || task.state !== "running") {
      setActiveTaskId(COMPOSE_TAB_ID);
    }
  };
  const activateLeft = (id: string) => {
    markLayoutMutation();
    paneIntentSequenceRef.current += 1;
    setFocusedPane("left");
    setActiveTaskId(id);
  };
  const activateRight = (id: string) => {
    markLayoutMutation();
    paneIntentSequenceRef.current += 1;
    setFocusedPane("right");
    setActiveRightTaskId(id);
    if (composing) setActiveTaskId(leftTasks[0]?.id ?? null);
  };
  const closeLeft = async (id: string) => {
    markLayoutMutation();
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
    markLayoutMutation();
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
  const resumeInFocusedPane = async (transcript: Parameters<typeof resumeTask>[0]) => {
    markLayoutMutation();
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
    markLayoutMutation();
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
    markLayoutMutation();
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
  return <>
    {pendingDelivery && !open ? (
      <section
        aria-label={t("dock.chooseAgentTarget")}
        className={cn(
          "fixed z-[60] flex max-w-[calc(100vw-1.5rem)] flex-col border border-border bg-background p-1 shadow-lg",
          sideDocked ? "bottom-3 right-11 w-64" : "bottom-11 left-1/2 w-72 -translate-x-1/2",
        )}
        data-agent-delivery-chooser
      >
        <span className="px-2 py-1 text-[10px] font-medium text-muted-foreground">
          {t("dock.chooseAgentTarget")}
        </span>
        {deliveryTargets.map((task, index) => {
          const providerLabel = task.provider === "codex" ? "Codex" : "Claude Code";
          const taskLabel = task.label || t("dock.taskFallback", { provider: providerLabel });
          const TaskLogo = task.provider === "codex" ? CodexLogo : ClaudeLogo;
          return (
            <button
              aria-label={t("dock.insertInto", { name: taskLabel })}
              className="flex min-w-0 items-center gap-2 px-2 py-1.5 text-left hover:bg-muted/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              data-agent-delivery-target
              key={task.id}
              onClick={() => chooseDeliveryTarget(task)}
              ref={index === 0 ? deliveryTargetButtonRef : undefined}
              type="button"
            >
              <TaskLogo aria-hidden="true" className="size-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate text-[11px] font-medium">{taskLabel}</span>
              <span className="shrink-0 font-mono text-[9px] text-muted-foreground">
                {task.presentation === "terminal" ? t("dock.externalActive") : providerLabel}
              </span>
            </button>
          );
        })}
      </section>
    ) : null}
    {!open ? sideDocked ? (
      <button
        aria-label={t("dock.openAria")}
        className="fixed bottom-0 right-0 z-50 flex w-9 flex-col items-center gap-2 border-l border-border bg-card/95 py-3 shadow-[-4px_0_18px_-14px_rgba(0,0,0,.45)] backdrop-blur"
        onClick={() => setOpen(true)}
        style={{ top: isTauri() ? 32 : 0 }}
        title={collapsedTaskLabel}
        type="button"
      >
        <CollapsedLogo className="size-4 text-primary" />
        {collapsedTask ? <span className={cn("size-1.5 rounded-full bg-muted-foreground", collapsedTask.state === "running" && "bg-emerald-500", collapsedTask.state === "error" && "bg-destructive")}><span className="sr-only">{collapsedStatusLabel}{stateLabel(collapsedTask.state)}</span></span> : null}
        <span className="h-px w-4 bg-border" />
        <span className="min-h-0 flex-1 [writing-mode:vertical-rl] truncate font-mono text-[10px] text-muted-foreground">{collapsedTaskLabel}</span>
        {tasks.length > 1 ? <span className="grid size-5 place-items-center rounded-full bg-muted font-mono text-[10px] text-muted-foreground">{tasks.length}</span> : null}
        <ChevronLeft className="size-3.5 text-muted-foreground" />
      </button>
    ) : (
      <div className="fixed inset-x-0 bottom-0 z-50 h-9 w-full border-t border-border bg-card/95 shadow-[0_-4px_18px_-14px_rgba(0,0,0,.45)] backdrop-blur">
        <button
          aria-label={t("dock.openAria")}
          className="absolute inset-x-0 inset-y-0 h-9 w-full text-left"
          onClick={() => setOpen(true)}
          type="button"
        >
          <span className="sr-only">{t("dock.openAria")} {collapsedProviderLabel}</span>
        </button>
        <div className="pointer-events-none relative flex h-full items-center gap-2 px-3">
          <button
            aria-label={t("dock.openAgentProfile", { name: collapsedProviderLabel })}
            className="pointer-events-auto flex shrink-0 items-center gap-2 rounded-sm text-left text-xs font-medium hover:text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            onClick={() => navigate("agent")}
            title={t("dock.openAgentProfile", { name: collapsedProviderLabel })}
            type="button"
          >
            <CollapsedLogo className="size-3.5 text-primary" />
            <span>{collapsedProviderLabel}</span>
          </button>
          <span className="h-3 w-px bg-border" />
          {collapsedTaskTabs.length ? (
            <div
              aria-label={t("dock.tasksAria")}
              className="pointer-events-auto flex min-w-0 flex-1 items-center gap-1 overflow-hidden"
              data-collapsed-agent-tabs
              role="tablist"
            >
              {collapsedTaskTabs.map((task) => {
                const label = task.label || (task.kind === "shell" ? t("dock.shellFallback") : t("dock.taskFallback", { provider: task.provider === "codex" ? "Codex" : "Claude Code" }));
                const active = task.id === collapsedTask?.id;
                const TaskLogo = task.kind === "shell"
                  ? SquareTerminal
                  : task.provider === "codex"
                    ? CodexLogo
                    : ClaudeLogo;
                return (
                  <button
                    aria-label={t("dock.openTaskAria", { label })}
                    aria-selected={active}
                    className={cn(
                      "relative flex h-6 min-w-12 max-w-36 flex-1 items-center gap-1.5 overflow-hidden rounded-sm px-2 text-[11px] transition-colors before:absolute before:inset-x-0 before:top-0 before:h-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      task.provider === "codex" ? "before:bg-emerald-500" : task.provider === "claude" ? "before:bg-[#D97757]" : "before:bg-muted-foreground/40",
                      active
                        ? "bg-foreground text-background"
                        : "text-muted-foreground hover:bg-muted/45 hover:text-foreground",
                    )}
                    data-collapsed-agent-task={task.id}
                    data-presentation={task.presentation}
                    key={task.id}
                    onClick={() => {
                      if (rightTaskIds.has(task.id)) activateRight(task.id);
                      else activateLeft(task.id);
                      setOpen(true);
                    }}
                    role="tab"
                    title={label}
                    type="button"
                  >
                    <TaskLogo aria-hidden="true" className="size-3 shrink-0" />
                    <span className="min-w-0 flex-1 truncate font-mono">{label}</span>
                    {task.presentation === "terminal" ? <SquareTerminal aria-hidden="true" className="size-2.5 shrink-0 opacity-70" /> : null}
                    {active ? <span className="sr-only">{collapsedStatusLabel}{stateLabel(task.state)}</span> : null}
                    <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full bg-muted-foreground/50", task.state === "running" && "bg-emerald-500", task.state === "error" && "bg-destructive")} />
                  </button>
                );
              })}
              {collapsedHiddenTaskCount > 0 ? (
                <span
                  className="shrink-0 font-mono text-[10px] text-muted-foreground"
                  title={t("dock.moreTasks", { count: collapsedHiddenTaskCount })}
                >
                  <span aria-hidden="true">+{collapsedHiddenTaskCount}</span>
                  <span className="sr-only">{t("dock.moreTasks", { count: collapsedHiddenTaskCount })}</span>
                </span>
              ) : null}
            </div>
          ) : (
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
              {collapsedTaskLabel}
              {collapsedTask ? <span className="sr-only">{collapsedStatusLabel}{stateLabel(collapsedTask.state)}</span> : null}
            </span>
          )}
          <DockStatusStrip git={git} onOpenActions={openGitHubActions} provider={collapsedProviderId} variant="strip" />
          <ChevronUp className="size-3.5 text-muted-foreground" />
        </div>
      </div>
    ) : null}
    <div
      aria-hidden={!open || undefined}
      className={cn(
        "fixed z-50 flex flex-col overflow-hidden bg-card",
        fullScreen
          ? "inset-x-0 bottom-0 border-t border-border shadow-[0_-12px_30px_-20px_rgba(0,0,0,.5)]"
          : sideDocked
            ? "bottom-0 right-0 border-l border-border shadow-[-12px_0_30px_-20px_rgba(0,0,0,.5)]"
            : "inset-x-0 bottom-0 border-t border-border shadow-[0_-12px_30px_-20px_rgba(0,0,0,.5)]",
        !fullScreen && !resizing && (sideDocked ? "transition-[width] duration-200 ease-out" : "transition-[height] duration-200 ease-out"),
        !open && "pointer-events-none border-transparent shadow-none",
      )}
      inert={!open || undefined}
      style={
        fullScreen
          ? { height: "auto", top: isTauri() ? 32 : 0 }
          : sideDocked
            ? { top: isTauri() ? 32 : 0, width: open ? effectiveWidth : 0 }
            : { height: open ? (effectiveHeight ?? "50vh") : 0 }
      }
    >
    {fullScreen ? <nav aria-label={t("dock.fullscreenNavAria")} className="flex h-11 shrink-0 items-center gap-1 overflow-x-auto border-b border-border bg-background px-2">{APP_NAV_ITEMS.map((item) => <button aria-current={currentPage === item.page ? "page" : undefined} aria-label={t(item.labelKey)} className={cn("flex h-8 shrink-0 items-center gap-2 rounded-md px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground [&_svg]:size-4", currentPage === item.page && "bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground")} key={item.page} onClick={() => navigate(item.page)} type="button">{item.icon}<span>{t(item.labelKey)}</span></button>)}</nav> : null}
    <div
      aria-hidden
      className={cn(
        "absolute z-20 touch-none",
        sideDocked ? "inset-y-0 -left-1 w-2 cursor-ew-resize" : "inset-x-0 -top-1 h-2 cursor-ns-resize",
        fullScreen && "hidden",
      )}
      data-agent-resize-grip
      onDoubleClick={() => {
        if (sideDocked) {
          widthRef.current = 480;
          setWidth(480);
          updateDockLayout({ rightWidth: 480 });
        } else {
          heightRef.current = null;
          setHeight(null);
          updateDockLayout({ bottomHeight: null });
        }
      }}
      onPointerDown={resizeStart}
      title={sideDocked ? t("dock.resizeWidthAria") : undefined}
    />
    <div className="relative flex min-h-0 flex-1 flex-col">
    <div className="relative flex h-9 shrink-0 items-stretch border-b border-border bg-muted/25" data-agent-dock-toolbar>
      {!fullScreen ? <button
        aria-label={t("dock.positionGrip")}
        className={cn(
          "grid w-8 shrink-0 cursor-grab place-items-center border-r border-border text-muted-foreground hover:bg-muted hover:text-foreground active:cursor-grabbing",
          layoutSplit && "absolute inset-y-0 left-0 z-20 bg-muted/25",
        )}
        onClick={() => {
          if (suppressPositionClickRef.current) {
            suppressPositionClickRef.current = false;
            return;
          }
          setPlacement(placement === "right" ? "bottom" : "right");
        }}
        onPointerDown={positionDragStart}
        title={placement === "right" ? t("dock.moveToBottom") : t("dock.moveToRight")}
        type="button"
      ><Grip className="size-3.5" /></button> : null}
      {layoutSplit ? (
        <div className="absolute inset-0 flex min-w-0 items-stretch">
          <div
            className={cn(
              "absolute inset-y-0 left-0 flex min-w-0 items-stretch border-r border-border",
              !fullScreen && "pl-8",
            )}
            data-agent-pane-tabs="left"
            style={{ right: `${100 - splitPercent}%` }}
          >
            <AgentTerminalTabs activeTaskId={activeTaskId} ariaLabel={t("dock.leftTasksAria")} composing={false} onActivate={activateLeft} onBringBackToDock={terminalCapabilities?.externalTerminal ? (id) => void bringTaskBackToDock(id) : undefined} onClose={(id) => void closeLeft(id)} onDragEnd={() => setDraggedTaskId(null)} onDragStart={setDraggedTaskId} onOpenInTerminal={terminalCapabilities?.externalTerminal ? (id) => void openTaskInTerminal(id) : undefined} onRename={(id, label) => void renameTask(id, label)} pendingTaskIds={pendingTaskIds} tasks={leftTasks} />
            {leftAgentContext ? <AgentCapabilityBadges capabilities={capabilitiesFor(leftProviderId)} onInsert={(text) => insertPaneCapability("left", leftActive, text)} onNavigate={onNavigate ? navigate : undefined} onSelectOneTimeSkill={(skill) => stagePaneOneTimeSkill("left", leftActive, skill)} providerLabel={leftProviderLabel} /> : null}
            <DockStatusStrip git={git} onOpenActions={openGitHubActions} provider={leftProviderId} variant="dock" />
          </div>
          <div
            // Reserve exactly the floating button cluster's width (3 × size-7
            // + px-1 + the border = 93px) so the status strip ends flush against
            // it. This used to widen while running to clear a stop button; that
            // button is gone, so the width is now constant.
            className="absolute inset-y-0 right-0 flex min-w-0 items-stretch pr-24"
            data-agent-pane-tabs="right"
            style={{ left: `${splitPercent}%` }}
          >
            <AgentTerminalTabs activeTaskId={rightActive?.id ?? null} ariaLabel={t("dock.rightTasksAria")} composing={false} onActivate={activateRight} onBringBackToDock={terminalCapabilities?.externalTerminal ? (id) => void bringTaskBackToDock(id) : undefined} onClose={(id) => void closeRight(id)} onDragEnd={() => setDraggedTaskId(null)} onDragStart={setDraggedTaskId} onOpenInTerminal={terminalCapabilities?.externalTerminal ? (id) => void openTaskInTerminal(id) : undefined} onRename={(id, label) => void renameTask(id, label)} pendingTaskIds={pendingTaskIds} tasks={rightTasks} />
            {rightAgentContext ? <AgentCapabilityBadges capabilities={capabilitiesFor(rightProviderId)} onInsert={(text) => insertPaneCapability("right", rightActive, text)} onNavigate={onNavigate ? navigate : undefined} onSelectOneTimeSkill={(skill) => stagePaneOneTimeSkill("right", rightActive, skill)} providerLabel={rightProviderLabel} /> : null}
            <DockStatusStrip git={git} onOpenActions={openGitHubActions} provider={rightProviderId} variant="dock" />
          </div>
        </div>
      ) : (
        <>
          <AgentTerminalTabs activeTaskId={sideDocked ? sideActiveTaskId : activeTaskId} composing={composing} onActivate={(id) => sideDocked && rightTaskIds.has(id) ? activateRight(id) : activateLeft(id)} onBringBackToDock={terminalCapabilities?.externalTerminal ? (id) => void bringTaskBackToDock(id) : undefined} onClose={(id) => void (rightTaskIds.has(id) ? closeRight(id) : closeLeft(id))} onDragEnd={sideDocked ? undefined : () => setDraggedTaskId(null)} onDragStart={sideDocked ? undefined : setDraggedTaskId} onOpenInTerminal={terminalCapabilities?.externalTerminal ? (id) => void openTaskInTerminal(id) : undefined} onRename={(id, label) => void renameTask(id, label)} pendingTaskIds={pendingTaskIds} tasks={sideDocked ? tasks : leftTasks} />
          {!sideDocked && agentContext ? <AgentCapabilityBadges capabilities={capabilities} onInsert={insertCapability} onNavigate={onNavigate ? navigate : undefined} onSelectOneTimeSkill={stageOneTimeSkill} providerLabel={railProviderLabel} /> : <span className="flex-1" />}
          {!sideDocked ? <DockStatusStrip git={git} onOpenActions={openGitHubActions} provider={railProviderId} variant="dock" /> : null}
        </>
      )}
      <div className={cn(
        "flex shrink-0 items-center border-l border-border bg-muted/25 px-1",
        layoutSplit && "absolute inset-y-0 right-0 z-20",
      )}>
        {/* History belongs to the new-session surface, so this slot follows it:
            while composing it toggles the rail beside the composer, and once a
            session is open it becomes "+", which starts a new one rather than
            sliding a sidebar over a running terminal. */}
        {composing ? (
          <button
            aria-expanded={historyRailOpen}
            aria-label={t("dock.conversationsAria")}
            className={cn(
              "grid size-7 place-items-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground",
              historyRailOpen && "bg-muted text-foreground",
            )}
            onClick={() => updateDockLayout({ historyRailOpen: !historyRailOpen })}
            title={t("dock.conversations")}
            type="button"
          >
            <PanelLeft className="size-3.5" />
          </button>
        ) : (
          <button
            aria-label={t("dock.newTask")}
            className="grid size-7 place-items-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={() => {
              markLayoutMutation();
              setShellMode(false);
              paneIntentSequenceRef.current += 1;
              setFocusedPane("left");
              setActiveTaskId(COMPOSE_TAB_ID);
            }}
            title={t("dock.newTaskTab")}
            type="button"
          >
            <Plus className="size-3.5" />
          </button>
        )}
        {/* No stop button: closing the tab already ends the session, and a
            second way to halt it only adds a control to reason about. */}
        <button aria-label={fullScreen ? t("dock.restoreDock") : t("dock.enterFullScreen")} className="grid size-7 place-items-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground" onClick={() => setFullScreen((value) => !value)} type="button">{fullScreen ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}</button>
        <button aria-label={t("dock.collapseAria")} className="grid size-7 place-items-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground" onClick={collapse} type="button">{sideDocked ? <ChevronRight className="size-3.5" /> : <ChevronDown className="size-3.5" />}</button>
      </div>
    </div>
    {sideDocked ? <div className="flex min-h-9 shrink-0 items-center overflow-x-auto border-b border-border bg-muted/10" data-agent-side-utilities>
      {agentContext ? <AgentCapabilityBadges capabilities={capabilities} onInsert={insertCapability} onNavigate={onNavigate ? navigate : undefined} onSelectOneTimeSkill={stageOneTimeSkill} providerLabel={railProviderLabel} /> : null}
      <span className="min-w-2 flex-1" />
      <DockStatusStrip git={git} onOpenActions={openGitHubActions} provider={railProviderId} variant="side" />
    </div> : null}
    {terminalError ? <div role="alert" className="border-b border-destructive/30 bg-destructive/5 px-3 py-1 font-mono text-[11px] text-destructive">{terminalError}</div> : null}
    {/* Everything under the toolbar is the rail's row. The rail runs the full
        height of the surface it belongs to without riding up over the tab
        strip, and the git banner and terminal share the column beside it —
        that column carries the background so the banner reads as part of the
        content rather than a lighter strip pasted over it. */}
    <div className="relative flex min-h-0 flex-1">
    {railVisible ? <AgentHistoryRail
      error={transcriptsError}
      loading={transcriptsLoading}
      onClose={() => updateDockLayout({ historyRailOpen: false })}
      onLoad={loadTranscripts}
      onResume={(transcript) => { void resumeInFocusedPane(transcript); if (historyRailOverlay) updateDockLayout({ historyRailOpen: false }); }}
      overlay={historyRailOverlay}
      transcripts={transcripts}
    /> : null}
    <div className="flex min-w-0 flex-1 flex-col bg-background">
    {git && composing ? <div className="shrink-0 px-3 pt-2"><GitSituationBanner git={git} onRefresh={onGitRefresh} /></div> : null}
    <div className="relative min-h-0 flex-1 bg-background" data-agent-split-container ref={splitContainerRef}>
      {tasks.map((task) => {
        const inRightPane = rightTaskIds.has(task.id);
        const shown = open && !composing && (sideDocked ? task.id === sideActiveTaskId : inRightPane ? task.id === rightActive?.id : task.id === activeTaskId);
        const focused = shown && focusedPane === (inRightPane ? "right" : "left");
        const paneStyle = contentSplit ? (inRightPane ? { left: `${splitPercent}%`, right: 0 } : { left: 0, right: `${100 - splitPercent}%` }) : undefined;
        const externallyPresented =
          task.presentation === "terminal" ||
          task.presentation === "terminalLaunching";
        const showSkillStatus =
          shown &&
          focused &&
          !externallyPresented &&
          task.kind !== "shell" &&
          task.state === "running" &&
          pendingOneTimeSkill;
        const deliveryTarget = Boolean(
          pendingDelivery &&
            open &&
            deliveryTargets.some((candidate) => candidate.id === task.id),
        );
        const deliveryProviderLabel = task.provider === "codex" ? "Codex" : "Claude Code";
        return <div aria-labelledby={`agent-tab-${task.id}`} className={cn("absolute bottom-0 top-0", !contentSplit && "inset-x-0", !shown && "invisible pointer-events-none")} id={`agent-panel-${task.id}`} key={task.id} onPointerDown={() => { markLayoutMutation(); paneIntentSequenceRef.current += 1; setFocusedPane(inRightPane ? "right" : "left"); }} role="tabpanel" style={paneStyle}>{externallyPresented ? <section aria-label={t("dock.externalActive")} className="absolute inset-0 z-20 grid place-items-center bg-background"><div className="flex flex-col items-center gap-2 px-4 py-3"><SquareTerminal aria-hidden="true" className="size-5 text-muted-foreground" /><span className="text-xs font-medium">{task.presentation === "terminalLaunching" ? t("dock.openingInTerminal") : t("dock.activeInTerminal")}</span>{task.presentation === "terminal" ? <Button onClick={() => void bringTaskBackToDock(task.id)} size="sm" type="button" variant="outline">{t("dock.bringBack")}</Button> : null}</div></section> : <TerminalViewport active={shown} claimInitialInput={() => claimInitialInput(task.id)} displaySettings={settings?.confirmedGlobal.terminal} focused={focused} onStatusChange={(status: TerminalViewportStatus) => handleTaskStatus(task, status)} ref={(handle) => { if (handle) viewportHandlesRef.current.set(task.id, handle); else viewportHandlesRef.current.delete(task.id); }} sessionId={task.id} suppressColorQueries={task.provider === "codex"} />}{deliveryTarget ? <section aria-label={t("dock.chooseAgentTarget")} className="absolute inset-0 z-30 grid place-items-center bg-background/65 backdrop-blur-[1px]" data-agent-delivery-target><button aria-label={t("dock.insertInto", { name: deliveryProviderLabel })} className="flex max-w-[calc(100%-2rem)] flex-col items-center border border-border bg-background px-3 py-2 text-foreground shadow-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => chooseDeliveryTarget(task)} ref={task.id === deliveryTargets[0]?.id ? deliveryTargetButtonRef : undefined} type="button"><span className="text-[11px] font-medium">{t("dock.insertHere")}</span><span className="max-w-full truncate font-mono text-[9px] text-muted-foreground">{deliveryProviderLabel} · {task.label || t("dock.taskFallback", { provider: deliveryProviderLabel })}</span></button></section> : null}{showSkillStatus ? <div className="absolute bottom-2 left-1/2 z-20 flex max-w-[calc(100%-1rem)] -translate-x-1/2 items-center gap-1.5 border border-border bg-card px-2 py-1 text-[10px] shadow-sm" data-one-time-skill-status><Sparkles aria-hidden="true" className="size-3 text-muted-foreground" /><span className="truncate font-medium text-foreground">{pendingOneTimeSkill.name}</span>{skillPromptBusy ? <><LoaderCircle aria-hidden="true" className="size-3 animate-spin text-muted-foreground motion-reduce:animate-none" /><span className="text-muted-foreground">{t("dock.skillLoading")}</span></> : null}{skillPromptError ? <><span className="max-w-48 truncate text-destructive" role="alert" title={skillPromptError}>{skillPromptError}</span><button aria-label={t("dock.skillRetry")} className="grid size-5 place-items-center text-muted-foreground hover:text-foreground" onClick={() => setSkillInjectionRetry((value) => value + 1)} type="button"><RotateCcw aria-hidden="true" className="size-3" /></button></> : null}<button aria-label={t("dock.skillTempClear", { name: pendingOneTimeSkill.name })} className="grid size-5 place-items-center text-muted-foreground hover:text-foreground" onClick={() => { clearOneTimeSkill(); setSkillPromptError(null); }} type="button"><X aria-hidden="true" className="size-3" /></button></div> : null}</div>;
      })}
      {open && composing ? <div aria-label={layoutSplit ? t("dock.newTask") : undefined} aria-labelledby={layoutSplit ? undefined : `agent-tab-${COMPOSE_TAB_ID}`} className="absolute inset-x-0 bottom-0 top-0 bg-background" id={`agent-panel-${COMPOSE_TAB_ID}`} onPointerDown={() => { markLayoutMutation(); paneIntentSequenceRef.current += 1; setFocusedPane("left"); }} role="tabpanel"><AgentTerminalComposer capabilities={shellMode ? undefined : capabilities} onNavigate={onNavigate ? navigate : undefined} onShellMode={setShellMode} shellMode={shellMode} /></div> : null}
      {contentSplit ? <hr aria-label={t("dock.splitResizeAria")} aria-orientation="vertical" aria-valuemax={75} aria-valuemin={25} aria-valuenow={Math.round(splitPercent)} className="absolute inset-y-0 z-20 h-auto w-3 -translate-x-1/2 cursor-col-resize touch-none border-0 bg-transparent after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:bg-border after:transition-colors hover:after:bg-primary focus-visible:after:bg-primary" onDoubleClick={() => { splitPercentRef.current = 50; setSplitPercent(50); updateDockLayout({ splitPercent: 50 }); }} onKeyDown={(event) => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); const next = Math.max(25, Math.min(75, splitPercentRef.current + (event.key === "ArrowLeft" ? -5 : 5))); splitPercentRef.current = next; setSplitPercent(next); updateDockLayout({ splitPercent: next }); } }} onPointerDown={splitResizeStart} style={{ left: `${splitPercent}%` }} tabIndex={0} /> : null}
      {!sideDocked && canDropRight ? <section aria-label={t("dock.splitDropTarget")} className="absolute bottom-2 right-2 top-2 z-30 grid place-items-center rounded-md border border-dashed border-primary/60 bg-primary/10 text-xs font-medium text-primary backdrop-blur-sm" onDragOver={(event) => { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = "move"; }} onDrop={(event) => { event.preventDefault(); dropDraggedRight(); }} style={{ width: split ? `calc(${100 - splitPercent}% - 0.75rem)` : "calc(50% - 0.75rem)" }}>{t("dock.splitDropTarget")}</section> : null}
      {!sideDocked && draggedFromRight ? <section aria-label={t("dock.leftDropTarget")} className="absolute bottom-2 left-2 top-2 z-30 grid place-items-center rounded-md border border-dashed border-primary/60 bg-primary/10 text-xs font-medium text-primary backdrop-blur-sm" onDragOver={(event) => { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = "move"; }} onDrop={(event) => { event.preventDefault(); dropDraggedLeft(); }} style={{ width: `calc(${splitPercent}% - 0.75rem)` }}>{t("dock.leftDropTarget")}</section> : null}
    </div>
    </div>
    </div>
    </div>
  </div>
    {positionDragging ? <>
      <section className={cn("pointer-events-none fixed inset-x-6 bottom-6 z-[60] grid h-24 place-items-center rounded-lg border-2 border-dashed bg-card/90 text-sm font-medium shadow-xl backdrop-blur", snapCandidate === "bottom" ? "border-primary text-primary" : "border-border text-muted-foreground")}><span className="flex items-center gap-2"><PanelBottom className="size-4" />{t("dock.snapBottom")}</span></section>
      {wideEnoughForSide ? <section className={cn("pointer-events-none fixed bottom-6 right-6 top-6 z-[60] grid w-44 place-items-center rounded-lg border-2 border-dashed bg-card/90 text-sm font-medium shadow-xl backdrop-blur", snapCandidate === "right" ? "border-primary text-primary" : "border-border text-muted-foreground")}><span className="flex items-center gap-2"><PanelRight className="size-4" />{t("dock.snapRight")}</span></section> : null}
    </> : null}
  </>;
}
