import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useAgentChat } from "./use-agent-chat";

/** The object an AI action was invoked from, shown as a chip in the dock. */
export interface AgentSource {
  /** Stable kind, e.g. "database-row" | "error" | "service". */
  type: string;
  /** Human label, e.g. "users row" or "error #123". */
  label: string;
}

export type SendMode = "send" | "draft";

interface SendToAgentOptions {
  prompt: string;
  source?: AgentSource;
  /** "send" auto-sends (queuing if the agent is busy); "draft" prefills and waits. */
  mode?: SendMode;
}

interface AgentContextValue extends ReturnType<typeof useAgentChat> {
  open: boolean;
  setOpen: (open: boolean) => void;
  draft: string;
  setDraft: (value: string | ((current: string) => string)) => void;
  insertPath: (path: string) => void;
  /** The source object behind the current/last action, or null. */
  activeSource: AgentSource | null;
  clearSource: () => void;
  /** Bumped whenever the input should re-focus (draft prefill, path insert). */
  focusNonce: number;
  /** The one entry point every feature uses to push an action into the dock. */
  sendToAgent: (options: SendToAgentOptions) => { queued: boolean };
  /** True while the dock is showing its "paste a repo URL" onboard field. */
  onboarding: boolean;
  setOnboarding: (value: boolean) => void;
  /** Open the dock and reveal the single repo-URL field; the agent does the rest. */
  startOnboard: () => void;
}

const AgentContext = createContext<AgentContextValue | null>(null);

/**
 * Owns the single dock conversation and exposes it app-wide. Any feature can
 * call {@link useAgentDock}().sendToAgent to turn an object into an agent task;
 * the dock itself is just one more consumer of this context.
 */
export function AgentProvider({ children }: { children: ReactNode }) {
  const chat = useAgentChat();
  const { streaming, send } = chat;
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [activeSource, setActiveSource] = useState<AgentSource | null>(null);
  const [focusNonce, setFocusNonce] = useState(0);
  const [onboarding, setOnboarding] = useState(false);
  // Actions fired while a turn is streaming wait here and flush in order.
  const queueRef = useRef<string[]>([]);

  const bumpFocus = useCallback(() => setFocusNonce((nonce) => nonce + 1), []);
  const clearSource = useCallback(() => setActiveSource(null), []);
  const startOnboard = useCallback(() => {
    setOpen(true);
    setOnboarding(true);
  }, []);

  const insertPath = useCallback(
    (path: string) => {
      setOpen(true);
      setDraft((current) =>
        current.trim() ? `${current.replace(/\s*$/, "")} ${path} ` : `${path} `,
      );
      bumpFocus();
    },
    [bumpFocus],
  );

  // Drain the queue the instant the agent goes idle (one turn at a time).
  useEffect(() => {
    if (streaming) return;
    const next = queueRef.current.shift();
    if (next) void send(next);
  }, [streaming, send]);

  const sendToAgent = useCallback(
    ({ prompt, source, mode = "send" }: SendToAgentOptions) => {
      setOpen(true);
      setActiveSource(source ?? null);
      if (mode === "draft") {
        setDraft(prompt);
        bumpFocus();
        return { queued: false };
      }
      if (streaming) {
        queueRef.current.push(prompt);
        return { queued: true };
      }
      void send(prompt);
      return { queued: false };
    },
    [streaming, send, bumpFocus],
  );

  // Clearing the conversation also drops queued work and the source chip.
  const clear = useCallback(() => {
    queueRef.current = [];
    setActiveSource(null);
    chat.clear();
  }, [chat]);

  const value: AgentContextValue = {
    ...chat,
    clear,
    open,
    setOpen,
    draft,
    setDraft,
    insertPath,
    activeSource,
    clearSource,
    focusNonce,
    sendToAgent,
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
