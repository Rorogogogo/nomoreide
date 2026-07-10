import { useCallback, useEffect, useRef, useState } from "react";
import {
  approveAgentTool,
  type AgentChatProviderInfo,
  type AgentChatProviderOption,
  getAgentChatStatus,
  setChatProvider as setChatProviderApi,
  streamAgentChat,
} from "@/lib/api";

/** A tool invocation surfaced inline under an assistant turn. */
export interface ChatToolCall {
  id: string;
  name: string;
  input: unknown;
  preview?: string;
  isError?: boolean;
  status: "running" | "done";
}

export interface ChatTurn {
  id: string;
  createdAt: number;
  role: "user" | "assistant";
  text: string;
  /**
   * Short display text for the user bubble when `text` is a long preset prompt.
   * The full `text` is still what we send to the agent; the bubble just shows
   * this so the conversation stays readable. Undefined = show `text` verbatim.
   */
  label?: string;
  tools: ChatToolCall[];
}

/** A tool call awaiting the user's Allow/Deny decision. */
export interface ApprovalPrompt {
  requestId: string;
  name: string;
  input: unknown;
}

let turnCounter = 0;
const nextId = () => {
  turnCounter += 1;
  return `t${Date.now()}-${turnCounter}`;
};

/** Minimal provider info for optimistic switching when the backend hasn't reported one. */
function fallbackProviderInfo(id: AgentChatProviderInfo["id"]): AgentChatProviderInfo {
  return id === "codex"
    ? { id, label: "Codex", commandName: "codex", installHint: "", intro: "" }
    : { id, label: "Claude Code", commandName: "claude", installHint: "", intro: "" };
}

export function useAgentChat({ loadProviderStatus = true } = {}) {
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [provider, setProvider] = useState<AgentChatProviderInfo | null>(null);
  const [providers, setProviders] = useState<AgentChatProviderOption[]>([]);
  const [approvals, setApprovals] = useState<ApprovalPrompt[]>([]);
  // Read inside `send` without re-creating the callback each time it switches.
  const providerRef = useRef<AgentChatProviderInfo["id"] | undefined>(undefined);
  const abortRef = useRef<AbortController | null>(null);
  // The selected CLI's own session id, returned on the first turn and resumed after.
  const sessionRef = useRef<string | undefined>(undefined);
  // The session id of the turn currently streaming — usually equals `sessionRef`,
  // but for an isolated (one-shot) turn it's that fresh session instead. Tool
  // approvals must target this so an isolated step's prompts go to the right CLI.
  const liveSessionRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!loadProviderStatus) return;
    void getAgentChatStatus()
      .then((status) => {
        setConfigured(status.configured);
        setProvider(status.provider);
        setProviders(status.providers);
        providerRef.current = status.provider?.id;
      })
      .catch(() => setConfigured(false));
  }, [loadProviderStatus]);

  // Switch the active provider and persist it. Optimistic: reflect the choice
  // immediately so the UI toggles even against an older backend that doesn't
  // report `providers` or accept the persist call — then reconcile from it.
  const selectProvider = useCallback(
    async (id: AgentChatProviderInfo["id"]) => {
      const option = providers.find((candidate) => candidate.id === id);
      setProvider(option ?? fallbackProviderInfo(id));
      providerRef.current = id;
      if (option) setConfigured(option.configured);
      try {
        const selected = await setChatProviderApi(id);
        setProvider(selected);
        providerRef.current = selected.id;
      } catch {
        // Persisting failed — the in-memory choice still drives this session.
      }
    },
    [providers],
  );

  const respond = useCallback(async (requestId: string, decision: "allow" | "deny") => {
    setApprovals((current) => current.filter((prompt) => prompt.requestId !== requestId));
    const sessionId = liveSessionRef.current ?? sessionRef.current;
    if (!sessionId) return;
    try {
      await approveAgentTool(sessionId, requestId, decision);
    } catch {
      // The hook auto-denies on timeout; nothing actionable here.
    }
  }, []);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStreaming(false);
  }, []);

  const send = useCallback(
    async (text: string, options?: { label?: string; autoApprove?: boolean; isolated?: boolean }) => {
      const trimmed = text.trim();
      if (!trimmed || streaming) return;
      setError(null);

      const userTurn: ChatTurn = {
        id: nextId(),
        createdAt: Date.now(),
        role: "user",
        text: trimmed,
        label: options?.label,
        tools: [],
      };
      const assistantId = nextId();
      const assistantTurn: ChatTurn = {
        id: assistantId,
        createdAt: Date.now(),
        role: "assistant",
        text: "",
        tools: [],
      };
      setTurns((current) => [...current, userTurn, assistantTurn]);

      const patch = (update: (turn: ChatTurn) => ChatTurn) =>
        setTurns((current) =>
          current.map((turn) => (turn.id === assistantId ? update(turn) : turn)),
        );

      const controller = new AbortController();
      abortRef.current = controller;
      setStreaming(true);
      try {
        await streamAgentChat(
          trimmed,
          // Isolated turns start a fresh CLI session instead of resuming the
          // dock thread, so the model isn't re-fed the whole prior transcript.
          options?.isolated ? undefined : sessionRef.current,
          (event) => {
            switch (event.type) {
              case "session":
                liveSessionRef.current = event.sessionId;
                // One-shot isolated turns must not become the dock's continuing
                // thread — keep the main session so later steps still resume it.
                if (!options?.isolated) sessionRef.current = event.sessionId;
                break;
              case "text":
                patch((turn) => ({ ...turn, text: turn.text + event.text }));
                break;
              case "tool_use":
                patch((turn) => ({
                  ...turn,
                  tools: [
                    ...turn.tools,
                    { id: event.id, name: event.name, input: event.input, status: "running" },
                  ],
                }));
                break;
              case "tool_result":
                patch((turn) => ({
                  ...turn,
                  tools: turn.tools.map((tool) =>
                    tool.id === event.id
                      ? { ...tool, preview: event.preview, isError: event.isError, status: "done" }
                      : tool,
                  ),
                }));
                break;
              case "approval_request":
                setApprovals((current) => [
                  ...current,
                  { requestId: event.requestId, name: event.name, input: event.input },
                ]);
                break;
              case "error":
                setError(event.message);
                break;
              case "done":
                break;
            }
          },
          controller.signal,
          options?.autoApprove,
          providerRef.current,
        );
      } catch (caught) {
        if (!controller.signal.aborted) {
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      } finally {
        abortRef.current = null;
        setStreaming(false);
      }
    },
    [streaming],
  );

  const clear = useCallback(() => {
    stop();
    sessionRef.current = undefined;
    liveSessionRef.current = undefined;
    setTurns([]);
    setApprovals([]);
    setError(null);
  }, [stop]);

  return {
    turns,
    streaming,
    error,
    configured,
    provider,
    providers,
    selectProvider,
    approvals,
    send,
    stop,
    clear,
    respond,
  };
}
