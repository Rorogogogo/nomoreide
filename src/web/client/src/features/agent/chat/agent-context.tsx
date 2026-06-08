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
  /**
   * Short text to show in the user bubble instead of the full `prompt`. Use for
   * long preset prompts so the chat stays readable — the full prompt is still
   * what gets sent to the agent. Ignored in "draft" mode (the user edits it).
   */
  label?: string;
  /**
   * Scoped auto-approve for this turn — the agent runs Edit/Write and non-footgun
   * Bash without per-tool prompts. Used by the workflow runner, where a gate has
   * already captured the user's consent. Ignored in "draft" mode.
   */
  autoApprove?: boolean;
  /**
   * Send without popping the dock open — the turn runs in the background so it
   * doesn't pull attention away from whatever the user is looking at (e.g. the
   * workflow pipeline). Only applies to "send" mode.
   */
  background?: boolean;
  /**
   * Run this turn in a fresh, one-shot CLI session instead of resuming the dock
   * thread. The model isn't re-fed the whole prior transcript, so it's much
   * cheaper — at the cost of no shared memory with earlier turns. Used by
   * workflow steps that are self-contained (e.g. drafting a commit message).
   */
  isolated?: boolean;
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
  /** Bumped whenever the transcript should snap to the newest message (any send). */
  stickNonce: number;
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
  const { streaming } = chat;
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [activeSource, setActiveSource] = useState<AgentSource | null>(null);
  const [focusNonce, setFocusNonce] = useState(0);
  const [stickNonce, setStickNonce] = useState(0);
  const [onboarding, setOnboarding] = useState(false);
  // Actions fired while a turn is streaming wait here and flush in order.
  const queueRef = useRef<Array<{ prompt: string; label?: string; autoApprove?: boolean; isolated?: boolean }>>([]);

  const bumpFocus = useCallback(() => setFocusNonce((nonce) => nonce + 1), []);
  const bumpStick = useCallback(() => setStickNonce((nonce) => nonce + 1), []);

  // Every send routes through here so the transcript reliably snaps to the
  // newest message — whether it came from the dock input or any feature action.
  const send = useCallback(
    (text: string, options?: { label?: string; autoApprove?: boolean; isolated?: boolean }) => {
      bumpStick();
      return chat.send(text, options);
    },
    [chat, bumpStick],
  );
  const clearSource = useCallback(() => setActiveSource(null), []);
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

  // Drain the queue the instant the agent goes idle (one turn at a time).
  useEffect(() => {
    if (streaming) return;
    const next = queueRef.current.shift();
    if (next) {
      void send(next.prompt, { label: next.label, autoApprove: next.autoApprove, isolated: next.isolated });
    }
  }, [streaming, send]);

  const sendToAgent = useCallback(
    ({ prompt, source, mode = "send", label, autoApprove, background, isolated }: SendToAgentOptions) => {
      // Background sends (workflow steps) stay out of the way — don't pop the dock.
      if (!background) setOpen(true);
      setActiveSource(source ?? null);
      // Opening the dock should always reveal the latest turn, even in draft mode.
      bumpStick();
      if (mode === "draft") {
        setDraft(prompt);
        bumpFocus();
        return { queued: false };
      }
      if (streaming) {
        queueRef.current.push({ prompt, label, autoApprove, isolated });
        return { queued: true };
      }
      void send(prompt, { label, autoApprove, isolated });
      return { queued: false };
    },
    [streaming, send, bumpFocus, bumpStick],
  );

  // Clearing the conversation also drops queued work and the source chip.
  const clear = useCallback(() => {
    queueRef.current = [];
    setActiveSource(null);
    chat.clear();
  }, [chat]);

  const value: AgentContextValue = {
    ...chat,
    send,
    clear,
    open,
    setOpen,
    draft,
    setDraft,
    insertPath,
    activeSource,
    clearSource,
    focusNonce,
    stickNonce,
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
