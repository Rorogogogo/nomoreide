import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Grip, LoaderCircle, Maximize2, Minimize2, PanelBottom, PanelRight, RotateCcw, Sparkles, Square, SquareTerminal, X } from "lucide-react";
// SquareTerminal doubles as the shell tab/rail mark — see AgentTerminalTabs.
import {
  loadOneTimeSkillPrompt,
  type DashboardData,
  type OneTimeSkillSelection,
} from "@/lib/api";
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
  const settings = useOptionalSettings();
  const { activeTaskId, claimInitialInput, clearOneTimeSkill, closeTask, consumeOneTimeSkill, createShellTask, createTask, creating, dockLayout, draft, focusNonce, insertPrompt, loadTranscripts, onboarding, open, pendingOneTimeSkill, pendingTaskIds, provider, providers, renameTask, resumeTask, selectOneTimeSkill, setActiveTaskId, setOpen, stopTask, tasks, tasksHydrated, tasksHydrationSettled, terminalError, transcripts, transcriptsError, transcriptsLoading, updateDockLayout, updateTaskStatus } = useAgentDock();
  const [height, setHeight] = useState<number | null>(dockLayout.bottomHeight);
  const [width, setWidth] = useState(dockLayout.rightWidth);
  const [resizing, setResizing] = useState(false);
  const [wideEnoughForSide, setWideEnoughForSide] = useState(() => typeof window.matchMedia !== "function" || window.matchMedia("(min-width: 700px)").matches);
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
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const positionCleanupRef = useRef<(() => void) | null>(null);
  const suppressPositionClickRef = useRef(false);
  const splitResizeCleanupRef = useRef<(() => void) | null>(null);
  const splitContainerRef = useRef<HTMLDivElement>(null);
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
    setRightTaskIds((current) => {
      const next = new Set([...current].filter((id) => liveIds.has(id)));
      if (next.size === current.size && [...next].every((id) => current.has(id))) {
        return current;
      }
      return next;
    });
  }, [tasks, tasksHydrated]);
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
  const sideActiveTaskId = composing ? COMPOSE_TAB_ID : focusedTask?.id ?? activeTaskId;
  useEffect(() => {
    if (currentRailTask) setLatestRailTask(currentRailTask);
  }, [currentRailTask]);
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
  const railProviderLabel = activeShell ? t("dock.shell") : focusedTask ? (focusedTask.provider === "codex" ? "Codex" : "Claude Code") : (provider?.label ?? "Agent");
  const activeTaskLabel = focusedTask?.label || (activeShell ? t("dock.shellFallback") : t("dock.newTask"));
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
    focusedTask.state === "running"
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
  const createAgentInFocusedPane = async (selectedProvider: typeof providers[number]) => {
    markLayoutMutation();
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
    markLayoutMutation();
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
          <span className="sr-only">{collapsedProviderLabel}</span>
        </button>
        <div className="pointer-events-none relative flex h-full items-center gap-2 px-3">
          <CollapsedLogo className="size-3.5 text-primary" />
          <span className="text-xs font-medium">{collapsedProviderLabel}</span>
          <span className="h-3 w-px bg-border" />
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">{collapsedTaskLabel}</span>
          <DockStatusStrip git={git} onOpenActions={openGitHubActions} provider={collapsedProviderId} variant="strip" />
          {collapsedTask ? <span className={cn("font-mono text-[10px] text-muted-foreground", collapsedTask.state === "running" && "text-emerald-600", collapsedTask.state === "error" && "text-destructive")}><span className="sr-only">{collapsedStatusLabel}</span>{stateLabel(collapsedTask.state)}</span> : null}
          {tasks.length > 1 ? <span className="font-mono text-[10px] text-muted-foreground">{tasks.length}</span> : null}
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
        !fullScreen && !resizing && (sideDocked ? "transition-[width] duration-150" : "transition-[height] duration-150"),
        !open && "invisible pointer-events-none border-transparent shadow-none",
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
            <AgentTerminalTabs activeTaskId={activeTaskId} ariaLabel={t("dock.leftTasksAria")} composing={composing} onActivate={activateLeft} onClose={(id) => void closeLeft(id)} onDragEnd={() => setDraggedTaskId(null)} onDragStart={setDraggedTaskId} onRename={(id, label) => void renameTask(id, label)} pendingTaskIds={pendingTaskIds} tasks={leftTasks} />
            {leftAgentContext ? <AgentCapabilityBadges capabilities={capabilitiesFor(leftProviderId)} onInsert={(text) => insertPaneCapability("left", leftActive, text)} onNavigate={onNavigate ? navigate : undefined} onSelectOneTimeSkill={(skill) => stagePaneOneTimeSkill("left", leftActive, skill)} providerLabel={leftProviderLabel} /> : null}
            <DockStatusStrip git={git} onOpenActions={openGitHubActions} provider={leftProviderId} variant="dock" />
          </div>
          <div
            className={cn(
              "absolute inset-y-0 right-0 flex min-w-0 items-stretch",
              focusedTask?.state === "running" ? "pr-[9.25rem]" : "pr-[7.5rem]",
            )}
            data-agent-pane-tabs="right"
            style={{ left: `${splitPercent}%` }}
          >
            <AgentTerminalTabs activeTaskId={rightActive?.id ?? null} ariaLabel={t("dock.rightTasksAria")} composing={false} onActivate={activateRight} onClose={(id) => void closeRight(id)} onDragEnd={() => setDraggedTaskId(null)} onDragStart={setDraggedTaskId} onRename={(id, label) => void renameTask(id, label)} pendingTaskIds={pendingTaskIds} tasks={rightTasks} />
            {rightAgentContext ? <AgentCapabilityBadges capabilities={capabilitiesFor(rightProviderId)} onInsert={(text) => insertPaneCapability("right", rightActive, text)} onNavigate={onNavigate ? navigate : undefined} onSelectOneTimeSkill={(skill) => stagePaneOneTimeSkill("right", rightActive, skill)} providerLabel={rightProviderLabel} /> : null}
            <DockStatusStrip git={git} onOpenActions={openGitHubActions} provider={rightProviderId} variant="dock" />
          </div>
        </div>
      ) : (
        <>
          <AgentTerminalTabs activeTaskId={sideDocked ? sideActiveTaskId : activeTaskId} composing={composing} onActivate={(id) => sideDocked && rightTaskIds.has(id) ? activateRight(id) : activateLeft(id)} onClose={(id) => void (rightTaskIds.has(id) ? closeRight(id) : closeLeft(id))} onDragEnd={sideDocked ? undefined : () => setDraggedTaskId(null)} onDragStart={sideDocked ? undefined : setDraggedTaskId} onRename={(id, label) => void renameTask(id, label)} pendingTaskIds={pendingTaskIds} tasks={sideDocked ? tasks : leftTasks} />
          {!sideDocked && agentContext ? <AgentCapabilityBadges capabilities={capabilities} onInsert={insertCapability} onNavigate={onNavigate ? navigate : undefined} onSelectOneTimeSkill={stageOneTimeSkill} providerLabel={railProviderLabel} /> : <span className="flex-1" />}
          {!sideDocked ? <DockStatusStrip git={git} onOpenActions={openGitHubActions} provider={railProviderId} variant="dock" /> : null}
        </>
      )}
      <div className={cn(
        "flex shrink-0 items-center border-l border-border bg-muted/25 px-1",
        layoutSplit && "absolute inset-y-0 right-0 z-20",
      )}>
        <AgentConversationPicker error={transcriptsError} loading={transcriptsLoading} onLoad={loadTranscripts} onResume={resumeInFocusedPane} provider={activeShell ? undefined : railProviderId === "codex" ? "codex" : "claude"} transcripts={transcripts} />
        <AgentNewSessionMenu
          creating={Boolean(creating)}
          onCreateAgent={(selectedProvider) => void createAgentInFocusedPane(selectedProvider)}
          onCreateShell={() => void createShellInFocusedPane()}
          providers={providers}
        />
        {focusedTask?.state === "running" ? <button aria-label={t("dock.stopTaskAria", { label: activeTaskLabel })} className="grid size-7 place-items-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-35" disabled={pendingTaskIds.has(focusedTask.id)} onClick={() => void stopTask(focusedTask.id)} type="button"><Square className="size-3" /></button> : null}
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
    {git && composing ? <div className="shrink-0 px-3 pt-2"><GitSituationBanner git={git} onRefresh={onGitRefresh} /></div> : null}
    <div className="relative min-h-0 flex-1 bg-background" data-agent-split-container ref={splitContainerRef}>
      {tasks.map((task) => {
        const inRightPane = rightTaskIds.has(task.id);
        const shown = open && (sideDocked ? task.id === sideActiveTaskId : inRightPane ? task.id === rightActive?.id : task.id === activeTaskId);
        const focused = shown && focusedPane === (inRightPane ? "right" : "left");
        const paneStyle = layoutSplit ? (inRightPane ? { left: `${splitPercent}%`, right: 0 } : { left: 0, right: `${100 - splitPercent}%` }) : undefined;
        const showSkillStatus =
          shown &&
          focused &&
          task.kind !== "shell" &&
          task.state === "running" &&
          pendingOneTimeSkill;
        return <div aria-labelledby={`agent-tab-${task.id}`} className={cn("absolute bottom-0 top-0", !layoutSplit && "inset-x-0", !shown && "invisible pointer-events-none")} id={`agent-panel-${task.id}`} key={task.id} onPointerDown={() => { markLayoutMutation(); paneIntentSequenceRef.current += 1; setFocusedPane(inRightPane ? "right" : "left"); }} role="tabpanel" style={paneStyle}><TerminalViewport active={shown} claimInitialInput={() => claimInitialInput(task.id)} displaySettings={settings?.confirmedGlobal.terminal} focused={focused} onStatusChange={(status: TerminalViewportStatus) => updateTaskStatus(task.id, { state: status.state === "connecting" ? "idle" : status.state, cwd: status.cwd, error: status.state === "error" ? status.detail : undefined })} ref={(handle) => { if (handle) viewportHandlesRef.current.set(task.id, handle); else viewportHandlesRef.current.delete(task.id); }} sessionId={task.id} />{showSkillStatus ? <div className="absolute bottom-2 left-1/2 z-20 flex max-w-[calc(100%-1rem)] -translate-x-1/2 items-center gap-1.5 border border-border bg-card px-2 py-1 text-[10px] shadow-sm" data-one-time-skill-status><Sparkles aria-hidden="true" className="size-3 text-muted-foreground" /><span className="truncate font-medium text-foreground">{pendingOneTimeSkill.name}</span>{skillPromptBusy ? <><LoaderCircle aria-hidden="true" className="size-3 animate-spin text-muted-foreground motion-reduce:animate-none" /><span className="text-muted-foreground">{t("dock.skillLoading")}</span></> : null}{skillPromptError ? <><span className="max-w-48 truncate text-destructive" role="alert" title={skillPromptError}>{skillPromptError}</span><button aria-label={t("dock.skillRetry")} className="grid size-5 place-items-center text-muted-foreground hover:text-foreground" onClick={() => setSkillInjectionRetry((value) => value + 1)} type="button"><RotateCcw aria-hidden="true" className="size-3" /></button></> : null}<button aria-label={t("dock.skillTempClear", { name: pendingOneTimeSkill.name })} className="grid size-5 place-items-center text-muted-foreground hover:text-foreground" onClick={() => { clearOneTimeSkill(); setSkillPromptError(null); }} type="button"><X aria-hidden="true" className="size-3" /></button></div> : null}</div>;
      })}
      {open && composing ? <div aria-labelledby={`agent-tab-${COMPOSE_TAB_ID}`} className={cn("absolute bottom-0 top-0 bg-background", !layoutSplit && "inset-x-0")} id={`agent-panel-${COMPOSE_TAB_ID}`} onPointerDown={() => { markLayoutMutation(); paneIntentSequenceRef.current += 1; setFocusedPane("left"); }} role="tabpanel" style={layoutSplit ? { left: 0, right: `${100 - splitPercent}%` } : undefined}><AgentTerminalComposer capabilities={shellMode ? undefined : capabilities} onNavigate={onNavigate ? navigate : undefined} onShellMode={setShellMode} shellMode={shellMode} /></div> : null}
      {layoutSplit ? <hr aria-label={t("dock.splitResizeAria")} aria-orientation="vertical" aria-valuemax={75} aria-valuemin={25} aria-valuenow={Math.round(splitPercent)} className="absolute inset-y-0 z-20 h-auto w-3 -translate-x-1/2 cursor-col-resize touch-none border-0 bg-transparent after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:bg-border after:transition-colors hover:after:bg-primary focus-visible:after:bg-primary" onDoubleClick={() => { splitPercentRef.current = 50; setSplitPercent(50); updateDockLayout({ splitPercent: 50 }); }} onKeyDown={(event) => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); const next = Math.max(25, Math.min(75, splitPercentRef.current + (event.key === "ArrowLeft" ? -5 : 5))); splitPercentRef.current = next; setSplitPercent(next); updateDockLayout({ splitPercent: next }); } }} onPointerDown={splitResizeStart} style={{ left: `${splitPercent}%` }} tabIndex={0} /> : null}
      {!sideDocked && canDropRight ? <section aria-label={t("dock.splitDropTarget")} className="absolute bottom-2 right-2 top-2 z-30 grid place-items-center rounded-md border border-dashed border-primary/60 bg-primary/10 text-xs font-medium text-primary backdrop-blur-sm" onDragOver={(event) => { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = "move"; }} onDrop={(event) => { event.preventDefault(); dropDraggedRight(); }} style={{ width: split ? `calc(${100 - splitPercent}% - 0.75rem)` : "calc(50% - 0.75rem)" }}>{t("dock.splitDropTarget")}</section> : null}
      {!sideDocked && draggedFromRight ? <section aria-label={t("dock.leftDropTarget")} className="absolute bottom-2 left-2 top-2 z-30 grid place-items-center rounded-md border border-dashed border-primary/60 bg-primary/10 text-xs font-medium text-primary backdrop-blur-sm" onDragOver={(event) => { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = "move"; }} onDrop={(event) => { event.preventDefault(); dropDraggedLeft(); }} style={{ width: `calc(${splitPercent}% - 0.75rem)` }}>{t("dock.leftDropTarget")}</section> : null}
    </div>
  </div>
    {positionDragging ? <>
      <section className={cn("pointer-events-none fixed inset-x-6 bottom-6 z-[60] grid h-24 place-items-center rounded-lg border-2 border-dashed bg-card/90 text-sm font-medium shadow-xl backdrop-blur", snapCandidate === "bottom" ? "border-primary text-primary" : "border-border text-muted-foreground")}><span className="flex items-center gap-2"><PanelBottom className="size-4" />{t("dock.snapBottom")}</span></section>
      {wideEnoughForSide ? <section className={cn("pointer-events-none fixed bottom-6 right-6 top-6 z-[60] grid w-44 place-items-center rounded-lg border-2 border-dashed bg-card/90 text-sm font-medium shadow-xl backdrop-blur", snapCandidate === "right" ? "border-primary text-primary" : "border-border text-muted-foreground")}><span className="flex items-center gap-2"><PanelRight className="size-4" />{t("dock.snapRight")}</span></section> : null}
    </> : null}
  </>;
}
