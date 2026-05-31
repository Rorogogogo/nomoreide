import { useCallback, useEffect, useRef, useState } from "react";
import {
  approveAgentTool,
  type AgentChatProviderInfo,
  getAgentChatStatus,
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

export function useAgentChat() {
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [provider, setProvider] = useState<AgentChatProviderInfo | null>(null);
  const [approvals, setApprovals] = useState<ApprovalPrompt[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  // The selected CLI's own session id, returned on the first turn and resumed after.
  const sessionRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    void getAgentChatStatus()
      .then((status) => {
        setConfigured(status.configured);
        setProvider(status.provider);
      })
      .catch(() => setConfigured(false));
  }, []);

  const respond = useCallback(async (requestId: string, decision: "allow" | "deny") => {
    setApprovals((current) => current.filter((prompt) => prompt.requestId !== requestId));
    const sessionId = sessionRef.current;
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
    async (text: string, options?: { label?: string }) => {
      const trimmed = text.trim();
      if (!trimmed || streaming) return;
      setError(null);

      const userTurn: ChatTurn = {
        id: nextId(),
        role: "user",
        text: trimmed,
        label: options?.label,
        tools: [],
      };
      const assistantId = nextId();
      const assistantTurn: ChatTurn = { id: assistantId, role: "assistant", text: "", tools: [] };
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
          sessionRef.current,
          (event) => {
            switch (event.type) {
              case "session":
                sessionRef.current = event.sessionId;
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
    setTurns([]);
    setApprovals([]);
    setError(null);
  }, [stop]);

  return { turns, streaming, error, configured, provider, approvals, send, stop, clear, respond };
}
