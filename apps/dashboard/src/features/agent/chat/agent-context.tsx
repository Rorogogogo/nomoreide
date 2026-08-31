import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { ContextItem, OneTimeSkillSelection } from "@/lib/api";
import {
  type AgentDockLayoutPatch,
  type AgentDockLayoutPreferences,
  loadAgentDockLayoutPreferences,
  mergeAgentDockLayoutPreferences,
  saveAgentDockLayoutPreferences,
} from "../terminal/agent-dock-layout-preferences";
import { useAgentTerminalTasks } from "../terminal/use-agent-terminal-tasks";

/** The object an AI action was invoked from, shown as a chip in the dock. */
export interface AgentSource {
  /** Stable kind, e.g. "database-row" | "error" | "service". */
  type: string;
  /** Human label, e.g. "users row" or "error #123". */
  label: string;
}

export type SendMode = "send" | "draft";

export interface SendToAgentOptions {
  prompt: string;
  source?: AgentSource;
  /** "send" launches a terminal task; "draft" prefills and waits. */
  mode?: SendMode;
  /** Short terminal-tab label. The full prompt is always sent to the agent. */
  label?: string;
  /**
   * Send without popping the dock open — the turn runs in the background so it
   * doesn't pull attention away from whatever the user is looking at (e.g. the
   * workflow pipeline). Only applies to "send" mode.
   */
  background?: boolean;
}

export type ForegroundAgentDelivery = Pick<
  SendToAgentOptions,
  "label" | "prompt" | "source"
>;

export type ForegroundAgentDeliveryHandler = (
  delivery: ForegroundAgentDelivery,
) => "draft" | "handled";

type AgentContextValue = ReturnType<typeof useAgentTerminalTasks> & {
  dockLayout: AgentDockLayoutPreferences;
  updateDockLayout: (patch: AgentDockLayoutPatch) => void;
  open: boolean;
  setOpen: (open: boolean) => void;
  draft: string;
  setDraft: (value: string | ((current: string) => string)) => void;
  insertPath: (path: string) => void;
  /** Append invocation text (e.g. "/skill ") to the draft and focus the composer. */
  insertPrompt: (text: string) => void;
  /** The source object behind the current/last action, or null. */
  activeSource: AgentSource | null;
  clearSource: () => void;
  /** Remote skill attached to the next successfully submitted agent prompt only. */
  pendingOneTimeSkill: OneTimeSkillSelection | null;
  selectOneTimeSkill: (skill: OneTimeSkillSelection) => void;
  clearOneTimeSkill: () => void;
  consumeOneTimeSkill: (skill: OneTimeSkillSelection) => void;
  /** Context Library items staged for the next successfully created session. */
  pendingContextItems: ContextItem[];
  includePinnedContext: boolean;
  setIncludePinnedContext: (value: boolean) => void;
  attachContextItem: (item: ContextItem) => void;
  removeContextItem: (item: ContextItem) => void;
  clearContextItems: () => void;
  /** Bumped whenever the input should re-focus (draft prefill, path insert). */
  focusNonce: number;
  /** The one entry point every feature uses to push an action into the dock. */
  sendToAgent: (options: SendToAgentOptions) => { queued: boolean };
  /** Lets the mounted dock route foreground sends into a visible agent pane. */
  registerForegroundAgentDeliveryHandler: (
    handler: ForegroundAgentDeliveryHandler,
  ) => () => void;
  /** True while the dock is showing its "paste a repo URL" onboard field. */
  onboarding: boolean;
  setOnboarding: (value: boolean) => void;
  /** Open the dock and reveal the single repo-URL field; the agent does the rest. */
  startOnboard: () => void;
  };

const AgentContext = createContext<AgentContextValue | null>(null);

/**
 * Owns the native agent terminal dock and exposes it app-wide. Any feature can
 * call {@link useAgentDock}().sendToAgent to turn an object into an agent task;
 * the dock itself is just one more consumer of this context.
 */
export function AgentProvider({ children }: { children: ReactNode }) {
  const terminalTasks = useAgentTerminalTasks();
  const [dockLayout, setDockLayout] = useState(
    loadAgentDockLayoutPreferences,
  );
  const dockLayoutRef = useRef(dockLayout);
  const updateDockLayout = useCallback((patch: AgentDockLayoutPatch) => {
    const next = mergeAgentDockLayoutPreferences(dockLayoutRef.current, patch);
    if (JSON.stringify(next) === JSON.stringify(dockLayoutRef.current)) return;
    dockLayoutRef.current = next;
    setDockLayout(next);
    saveAgentDockLayoutPreferences(next);
  }, []);
  const open = dockLayout.open;
  const setOpen = useCallback(
    (next: boolean) => updateDockLayout({ open: next }),
    [updateDockLayout],
  );
  const [draft, setDraft] = useState("");
  const [activeSource, setActiveSource] = useState<AgentSource | null>(null);
  const [pendingOneTimeSkill, setPendingOneTimeSkill] =
    useState<OneTimeSkillSelection | null>(null);
  const [pendingContextItems, setPendingContextItems] = useState<ContextItem[]>([]);
  const [includePinnedContext, setIncludePinnedContext] = useState(true);
  const [focusNonce, setFocusNonce] = useState(0);
  const [onboarding, setOnboarding] = useState(false);
  const foregroundDeliveryHandlerRef =
    useRef<ForegroundAgentDeliveryHandler | null>(null);
  const bumpFocus = useCallback(() => setFocusNonce((nonce) => nonce + 1), []);
  const clearSource = useCallback(() => setActiveSource(null), []);
  const clearOneTimeSkill = useCallback(() => setPendingOneTimeSkill(null), []);
  const selectOneTimeSkill = useCallback(
    (skill: OneTimeSkillSelection) => {
      setPendingOneTimeSkill(skill);
      setOpen(true);
      bumpFocus();
    },
    [bumpFocus],
  );
  const consumeOneTimeSkill = useCallback((skill: OneTimeSkillSelection) => {
    setPendingOneTimeSkill((current) =>
      current?.source === skill.source ? null : current,
    );
  }, []);
  const attachContextItem = useCallback((item: ContextItem) => {
    setPendingContextItems((current) =>
      current.some((candidate) => candidate.ref.kind === item.ref.kind && candidate.ref.id === item.ref.id)
        ? current
        : [...current, item],
    );
    setOpen(true);
    bumpFocus();
  }, [bumpFocus]);
  const removeContextItem = useCallback((item: ContextItem) => {
    setPendingContextItems((current) => current.filter(
      (candidate) => candidate.ref.kind !== item.ref.kind || candidate.ref.id !== item.ref.id,
    ));
  }, []);
  const clearContextItems = useCallback(() => setPendingContextItems([]), []);
  const startOnboard = useCallback(() => {
    setOpen(true);
    setOnboarding(true);
  }, []);

  const insertPath = useCallback(
    (path: string) => {
      setOpen(true);
      setDraft((current) =>
        current.trim() ? `${current.replace(/\s*$/, "")}\n${path}` : path,
      );
      bumpFocus();
    },
    [bumpFocus],
  );

  const insertPrompt = useCallback(
    (text: string) => {
      setOpen(true);
      setDraft((current) => {
        const trimmed = current.replace(/\s*$/, "");
        return trimmed ? `${trimmed} ${text}` : text;
      });
      bumpFocus();
    },
    [bumpFocus],
  );

  const registerForegroundAgentDeliveryHandler = useCallback(
    (handler: ForegroundAgentDeliveryHandler) => {
      foregroundDeliveryHandlerRef.current = handler;
      return () => {
        if (foregroundDeliveryHandlerRef.current === handler) {
          foregroundDeliveryHandlerRef.current = null;
        }
      };
    },
    [],
  );

  const sendToAgent = useCallback(
    ({ prompt, source, mode = "send", label, background }: SendToAgentOptions) => {
      if (mode === "draft") {
        setOpen(true);
        setActiveSource(source ?? null);
        setDraft(prompt);
        bumpFocus();
        return { queued: false };
      }
      if (!background) {
        const deliveryResult = foregroundDeliveryHandlerRef.current?.({
          label,
          prompt,
          source,
        });
        if (deliveryResult === "handled") return { queued: false };
        if (deliveryResult === "draft") {
          setOpen(true);
          setActiveSource(source ?? null);
          setDraft(prompt);
          bumpFocus();
          return { queued: false };
        }
      }
      if (!background) {
        setOpen(true);
        setActiveSource(source ?? null);
      }
      void terminalTasks.createTask({ prompt, label, source, background });
      return { queued: false };
    },
    [terminalTasks.createTask, bumpFocus],
  );

  const value: AgentContextValue = {
    ...terminalTasks,
    dockLayout,
    updateDockLayout,
    open,
    setOpen,
    draft,
    setDraft,
    insertPath,
    insertPrompt,
    activeSource,
    clearSource,
    pendingOneTimeSkill,
    selectOneTimeSkill,
    clearOneTimeSkill,
    consumeOneTimeSkill,
    pendingContextItems,
    includePinnedContext,
    setIncludePinnedContext,
    attachContextItem,
    removeContextItem,
    clearContextItems,
    focusNonce,
    sendToAgent,
    registerForegroundAgentDeliveryHandler,
    onboarding,
    setOnboarding,
    startOnboard,
  };

  return <AgentContext.Provider value={value}>{children}</AgentContext.Provider>;
}

export function useAgentDock(): AgentContextValue {
  const ctx = useContext(AgentContext);
  if (!ctx) throw new Error("useAgentDock must be used within an AgentProvider");
  return ctx;
}

export function useOptionalAgentDock(): AgentContextValue | null {
  return useContext(AgentContext);
}
