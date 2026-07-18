import { useCallback, useEffect, useRef, useState } from "react";
import {
  closeTerminalSession,
  createAgentTerminalSession,
  getAgentChatStatus,
  listTerminalSessions,
  setChatProvider as setChatProviderApi,
  type AgentChatProviderInfo,
  type AgentChatProviderOption,
  type TerminalSessionInfo,
} from "@/lib/api";

export interface AgentTerminalTaskSource {
  type: string;
  label: string;
}

export interface AgentTerminalTask extends TerminalSessionInfo {
  source?: AgentTerminalTaskSource;
  createdAt?: number;
  initialPrompt?: string;
}

export interface CreateAgentTerminalTaskOptions {
  prompt: string;
  label?: string;
  source?: AgentTerminalTaskSource;
  background?: boolean;
}

type AgentProviderId = AgentChatProviderInfo["id"];
type AgentTaskPatch = Partial<Omit<AgentTerminalTask, "id">>;
interface AgentTaskOrder {
  group: "attached" | "created";
  index: number;
}

function fallbackProviderInfo(id: AgentProviderId): AgentChatProviderInfo {
  return id === "codex"
    ? { id, label: "Codex", commandName: "codex", installHint: "", intro: "" }
    : {
        id,
        label: "Claude Code",
        commandName: "claude",
        installHint: "",
        intro: "",
      };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Owns the independent native terminal sessions launched from the agent dock. */
export function useAgentTerminalTasks() {
  const [tasks, setTasksState] = useState<AgentTerminalTask[]>([]);
  const tasksRef = useRef<AgentTerminalTask[]>([]);
  const [activeTaskId, setActiveTaskIdState] = useState<string | null>(null);
  const activeTaskIdRef = useRef<string | null>(null);
  const [creating, setCreating] = useState(0);
  const [terminalError, setTerminalError] = useState<string | null>(null);
  const [pendingTaskIds, setPendingTaskIds] = useState<Set<string>>(new Set());
  const pendingTaskIdsRef = useRef(new Set<string>());
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [provider, setProvider] = useState<AgentChatProviderInfo | null>(null);
  const [providers, setProviders] = useState<AgentChatProviderOption[]>([]);
  const providerRef = useRef<AgentProviderId | undefined>(undefined);
  const mountedRef = useRef(true);
  const createSequenceRef = useRef(0);
  const latestForegroundSequenceRef = useRef(0);
  const providerSelectionSequenceRef = useRef(0);
  const taskOrderRef = useRef(new Map<string, AgentTaskOrder>());
  const pendingCreateCountRef = useRef(0);
  const closedIdsRef = useRef(new Set<string>());
  const claimedInitialPromptIdsRef = useRef(new Set<string>());

  const sortTasks = useCallback((items: AgentTerminalTask[]) => {
    return [...items].sort((left, right) => {
      const leftOrder = taskOrderRef.current.get(left.id);
      const rightOrder = taskOrderRef.current.get(right.id);
      if (!leftOrder || !rightOrder) return leftOrder ? 1 : rightOrder ? -1 : 0;
      if (leftOrder.group !== rightOrder.group) {
        return leftOrder.group === "attached" ? -1 : 1;
      }
      return leftOrder.index - rightOrder.index;
    });
  }, []);

  const setTasks = useCallback((next: AgentTerminalTask[]) => {
    tasksRef.current = next;
    setTasksState(next);
  }, []);

  const setActiveTaskId = useCallback((id: string | null) => {
    activeTaskIdRef.current = id;
    setActiveTaskIdState(id);
  }, []);

  const activateFirstAttached = useCallback(() => {
    if (activeTaskIdRef.current || pendingCreateCountRef.current > 0) return;
    const firstAttached = sortTasks(tasksRef.current).find(
      (task) =>
        !closedIdsRef.current.has(task.id) &&
        taskOrderRef.current.get(task.id)?.group === "attached",
    );
    if (firstAttached) setActiveTaskId(firstAttached.id);
  }, [setActiveTaskId, sortTasks]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    void listTerminalSessions()
      .then((sessions) => {
        if (!mountedRef.current) return;
        const attached = sessions.filter(
          (session): session is TerminalSessionInfo & { kind: "agent" } =>
            session.kind === "agent" && !closedIdsRef.current.has(session.id),
        );
        attached.forEach((session, index) => {
          if (!taskOrderRef.current.has(session.id)) {
            taskOrderRef.current.set(session.id, { group: "attached", index });
          }
        });
        const existingById = new Map(
          tasksRef.current.map((task) => [task.id, task] as const),
        );
        const hydrated = attached.map((session) => {
          const existing = existingById.get(session.id);
          return existing
            ? {
                ...session,
                label: existing.label ?? session.label,
                source: existing.source,
                createdAt: existing.createdAt,
              }
            : session;
        });
        const attachedIds = new Set(hydrated.map((session) => session.id));
        const merged = [
          ...hydrated,
          ...tasksRef.current.filter((task) => !attachedIds.has(task.id)),
        ];
        setTasks(sortTasks(merged));
        activateFirstAttached();
      })
      .catch((error) => {
        if (mountedRef.current) setTerminalError(errorMessage(error));
      });
  }, [activateFirstAttached, setTasks, sortTasks]);

  useEffect(() => {
    const selectionAtRequest = providerSelectionSequenceRef.current;
    void getAgentChatStatus()
      .then((status) => {
        if (!mountedRef.current) return;
        setProviders(status.providers);
        if (providerSelectionSequenceRef.current === selectionAtRequest) {
          setConfigured(status.configured);
          setProvider(status.provider);
          providerRef.current = status.provider.id;
          return;
        }
        const selected = status.providers.find(
          (candidate) => candidate.id === providerRef.current,
        );
        if (selected) setConfigured(selected.configured);
      })
      .catch(() => {
        if (
          mountedRef.current &&
          providerSelectionSequenceRef.current === selectionAtRequest
        ) {
          setConfigured(false);
          setTerminalError("Unable to load agent provider status");
        }
      });
  }, []);

  const selectProvider = useCallback(
    async (id: AgentProviderId) => {
      const selection = ++providerSelectionSequenceRef.current;
      const option = providers.find((candidate) => candidate.id === id);
      providerRef.current = id;
      setTerminalError(null);
      setProvider(option ?? fallbackProviderInfo(id));
      if (option) setConfigured(option.configured);
      try {
        const selected = await setChatProviderApi(id);
        if (!mountedRef.current || providerSelectionSequenceRef.current !== selection) return;
        providerRef.current = selected.id;
        setProvider(selected);
        const selectedOption = providers.find((candidate) => candidate.id === selected.id);
        if (selectedOption) setConfigured(selectedOption.configured);
      } catch (error) {
        // Keep the optimistic in-memory choice, matching the legacy selector.
        if (mountedRef.current && providerSelectionSequenceRef.current === selection) {
          setTerminalError(errorMessage(error));
        }
      }
    },
    [providers],
  );

  const createTask = useCallback(
    async ({
      prompt,
      label,
      source,
      background = false,
    }: CreateAgentTerminalTaskOptions) => {
      const sequence = ++createSequenceRef.current;
      pendingCreateCountRef.current += 1;
      if (!background) latestForegroundSequenceRef.current = sequence;
      const createdAt = Date.now();
      const selectedProvider = providerRef.current ?? "claude";
      setTerminalError(null);
      setCreating((count) => count + 1);
      try {
        const session = await createAgentTerminalSession({
          provider: selectedProvider,
          prompt,
          label,
        });
        if (!mountedRef.current) return undefined;
        if (closedIdsRef.current.has(session.id)) return undefined;
        const task: AgentTerminalTask = {
          ...session,
          label: session.label ?? label,
          source,
          createdAt,
          initialPrompt: prompt,
        };
        taskOrderRef.current.set(task.id, { group: "created", index: sequence });
        const withoutDuplicate = tasksRef.current.filter(
          (candidate) => candidate.id !== task.id,
        );
        setTasks(sortTasks([...withoutDuplicate, task]));
        if (!background && latestForegroundSequenceRef.current === sequence) {
          setActiveTaskId(task.id);
        }
        return task;
      } catch (error) {
        if (mountedRef.current) setTerminalError(errorMessage(error));
        return undefined;
      } finally {
        pendingCreateCountRef.current = Math.max(0, pendingCreateCountRef.current - 1);
        if (mountedRef.current && pendingCreateCountRef.current === 0) {
          activateFirstAttached();
        }
        if (mountedRef.current) setCreating((count) => Math.max(0, count - 1));
      }
    },
    [activateFirstAttached, setActiveTaskId, setTasks, sortTasks],
  );

  const closeTask = useCallback(
    async (id: string) => {
      if (pendingTaskIdsRef.current.has(id)) return;
      pendingTaskIdsRef.current.add(id);
      setPendingTaskIds(new Set(pendingTaskIdsRef.current));
      closedIdsRef.current.add(id);
      try {
        await closeTerminalSession(id);
        if (!mountedRef.current) return;
        const current = tasksRef.current;
        const closedIndex = current.findIndex((task) => task.id === id);
        const next = current.filter((task) => task.id !== id);
        taskOrderRef.current.delete(id);
        setTasks(next);
        if (activeTaskIdRef.current === id) {
          const adjacent = next[Math.min(Math.max(closedIndex, 0), next.length - 1)];
          setActiveTaskId(adjacent?.id ?? null);
        }
      } catch (error) {
        // Stop intentionally terminates the remote PTY while retaining its
        // local tab. A later close may therefore see an already-gone session;
        // closing that exited tab is still a successful local operation.
        const current = tasksRef.current;
        const closedIndex = current.findIndex((task) => task.id === id);
        if (current[closedIndex]?.state === "exited") {
          const next = current.filter((task) => task.id !== id);
          taskOrderRef.current.delete(id);
          setTasks(next);
          if (activeTaskIdRef.current === id) {
            const adjacent = next[Math.min(Math.max(closedIndex, 0), next.length - 1)];
            setActiveTaskId(adjacent?.id ?? null);
          }
          return;
        }
        closedIdsRef.current.delete(id);
        if (mountedRef.current) setTerminalError(errorMessage(error));
      } finally {
        pendingTaskIdsRef.current.delete(id);
        if (mountedRef.current) setPendingTaskIds(new Set(pendingTaskIdsRef.current));
      }
    },
    [setActiveTaskId, setTasks],
  );

  const stopTask = useCallback(
    async (id: string) => {
      if (pendingTaskIdsRef.current.has(id)) return;
      pendingTaskIdsRef.current.add(id);
      setPendingTaskIds(new Set(pendingTaskIdsRef.current));
      setTerminalError(null);
      try {
        await closeTerminalSession(id);
        if (!mountedRef.current) return;
        const next = tasksRef.current.map((task) =>
          task.id === id ? { ...task, state: "exited" as const } : task,
        );
        setTasks(next);
      } catch (error) {
        if (mountedRef.current) setTerminalError(errorMessage(error));
      } finally {
        pendingTaskIdsRef.current.delete(id);
        if (mountedRef.current) setPendingTaskIds(new Set(pendingTaskIdsRef.current));
      }
    },
    [setTasks],
  );

  const updateTaskStatus = useCallback(
    (id: string, patch: AgentTaskPatch) => {
      const next = tasksRef.current.map((task) =>
        task.id === id ? { ...task, ...patch, id } : task,
      );
      setTasks(next);
    },
    [setTasks],
  );

  const claimInitialPrompt = useCallback((id: string) => {
    if (claimedInitialPromptIdsRef.current.has(id)) return undefined;
    const prompt = tasksRef.current.find((task) => task.id === id)?.initialPrompt;
    if (!prompt) return undefined;
    claimedInitialPromptIdsRef.current.add(id);
    return prompt;
  }, []);

  return {
    tasks,
    activeTaskId,
    setActiveTaskId,
    creating,
    terminalError,
    pendingTaskIds,
    error: terminalError,
    provider,
    configured,
    providers,
    selectProvider,
    createTask,
    closeTask,
    stopTask,
    updateTaskStatus,
    claimInitialPrompt,
  };
}
