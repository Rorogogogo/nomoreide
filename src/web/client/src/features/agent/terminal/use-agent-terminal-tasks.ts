import { useCallback, useEffect, useRef, useState } from "react";
import {
  closeTerminalSession,
  createAgentTerminalSession,
  createTerminalSession,
  getAgentChatStatus,
  listAgentTranscripts,
  listTerminalSessions,
  renameTerminalSession,
  setChatModel as setChatModelApi,
  setChatProvider as setChatProviderApi,
  type AgentChatModels,
  type AgentChatProviderInfo,
  type AgentChatProviderOption,
  type AgentTranscriptInfo,
  type OneTimeSkillSelection,
  type TerminalSessionInfo,
} from "@/lib/api";

/** Session kinds the dock adopts as tabs — agent tasks and plain shells. */
const DOCK_SESSION_KINDS = new Set(["agent", "shell"]);

export interface AgentTerminalTaskSource {
  type: string;
  label: string;
}

export interface AgentTerminalTask extends TerminalSessionInfo {
  source?: AgentTerminalTaskSource;
  createdAt?: number;
}

export interface CreateAgentTerminalTaskOptions {
  prompt: string;
  /** Explicit provider for direct session creation; defaults to the saved one. */
  provider?: AgentProviderId;
  /** Explicit model for this session; defaults to the provider's saved pin. */
  model?: string;
  label?: string;
  oneTimeSkill?: OneTimeSkillSelection;
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

/** Tab label for a shell opened with a command — its first line, truncated. */
function shellTaskLabel(command: string): string {
  const firstLine = command.split(/\r?\n/)[0]?.trim() ?? command;
  return firstLine.length > 60 ? `${firstLine.slice(0, 57).trimEnd()}…` : firstLine;
}

/** Owns the independent native terminal sessions launched from the agent dock. */
export function useAgentTerminalTasks() {
  const [tasks, setTasksState] = useState<AgentTerminalTask[]>([]);
  const tasksRef = useRef<AgentTerminalTask[]>([]);
  const [tasksHydrated, setTasksHydrated] = useState(false);
  const [tasksHydrationSettled, setTasksHydrationSettled] = useState(false);
  const [activeTaskId, setActiveTaskIdState] = useState<string | null>(null);
  const activeTaskIdRef = useRef<string | null>(null);
  const [creating, setCreating] = useState(0);
  const [terminalError, setTerminalError] = useState<string | null>(null);
  const [transcripts, setTranscripts] = useState<AgentTranscriptInfo[]>([]);
  const [transcriptsLoading, setTranscriptsLoading] = useState(false);
  const [transcriptsError, setTranscriptsError] = useState<string | null>(null);
  const [pendingTaskIds, setPendingTaskIds] = useState<Set<string>>(new Set());
  const pendingTaskIdsRef = useRef(new Set<string>());
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [provider, setProvider] = useState<AgentChatProviderInfo | null>(null);
  const [providers, setProviders] = useState<AgentChatProviderOption[]>([]);
  const [models, setModels] = useState<AgentChatModels>({});
  const providerRef = useRef<AgentProviderId | undefined>(undefined);
  const modelsRef = useRef<AgentChatModels>({});
  const modelSelectionSequenceRef = useRef(0);
  const mountedRef = useRef(true);
  const createSequenceRef = useRef(0);
  const latestForegroundSequenceRef = useRef(0);
  const providerSelectionSequenceRef = useRef(0);
  const taskOrderRef = useRef(new Map<string, AgentTaskOrder>());
  const initialInputRef = useRef(new Map<string, string[]>());
  const pendingCreateCountRef = useRef(0);
  const closedIdsRef = useRef(new Set<string>());

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
          (session) =>
            DOCK_SESSION_KINDS.has(session.kind ?? "") &&
            !closedIdsRef.current.has(session.id),
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
        setTasksHydrated(true);
        setTasksHydrationSettled(true);
      })
      .catch((error) => {
        if (mountedRef.current) {
          setTerminalError(errorMessage(error));
          setTasksHydrationSettled(true);
        }
      });
  }, [activateFirstAttached, setTasks, sortTasks]);

  useEffect(() => {
    const selectionAtRequest = providerSelectionSequenceRef.current;
    const modelSelectionAtRequest = modelSelectionSequenceRef.current;
    void getAgentChatStatus()
      .then((status) => {
        if (!mountedRef.current) return;
        setProviders(status.providers);
        // A pin the user changed while this was in flight must survive it.
        if (modelSelectionSequenceRef.current === modelSelectionAtRequest) {
          modelsRef.current = status.models ?? {};
          setModels(modelsRef.current);
        }
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

  /**
   * Pin (or, with null, unpin) the model new sessions of `id` spawn with.
   * Applied optimistically so the picker closes on the current choice, then
   * reconciled with what the backend actually stored.
   */
  const selectModel = useCallback(
    async (id: AgentProviderId, model: string | null) => {
      const selection = ++modelSelectionSequenceRef.current;
      const trimmed = model?.trim();
      const optimistic = { ...modelsRef.current };
      if (trimmed) optimistic[id] = trimmed;
      else delete optimistic[id];
      modelsRef.current = optimistic;
      setModels(optimistic);
      setTerminalError(null);
      try {
        const saved = await setChatModelApi(id, trimmed || null);
        if (!mountedRef.current || modelSelectionSequenceRef.current !== selection) return;
        modelsRef.current = saved;
        setModels(saved);
      } catch (error) {
        // Keep the optimistic choice — it still applies to this session, the
        // same way an unsaved provider switch does.
        if (mountedRef.current && modelSelectionSequenceRef.current === selection) {
          setTerminalError(errorMessage(error));
        }
      }
    },
    [],
  );

  /**
   * Shared create path for every dock tab. The caller supplies the spawn — an
   * agent invocation or a plain shell — and this owns the ordering, the
   * "newest foreground wins" selection race, and the pending accounting.
   */
  const runCreate = useCallback(
    async (
      spawn: () => Promise<TerminalSessionInfo>,
      {
        background = false,
        initialInput,
        label,
        source,
      }: {
        background?: boolean;
        initialInput?: readonly string[];
        label?: string;
        source?: AgentTerminalTaskSource;
      } = {},
    ) => {
      const sequence = ++createSequenceRef.current;
      pendingCreateCountRef.current += 1;
      if (!background) latestForegroundSequenceRef.current = sequence;
      const createdAt = Date.now();
      setTerminalError(null);
      setCreating((count) => count + 1);
      try {
        const session = await spawn();
        if (!mountedRef.current) return undefined;
        if (closedIdsRef.current.has(session.id)) return undefined;
        const task: AgentTerminalTask = {
          ...session,
          label: session.label ?? label,
          source,
          createdAt,
        };
        // Recorded before the tab renders, so the viewport's first claim wins.
        if (initialInput?.length) {
          initialInputRef.current.set(task.id, [...initialInput]);
        }
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

  const createTask = useCallback(
    ({ prompt, provider: requestedProvider, model, label, oneTimeSkill, source, background }: CreateAgentTerminalTaskOptions) => {
      const selectedProvider = requestedProvider ?? providerRef.current ?? "claude";
      return runCreate(
        () =>
          createAgentTerminalSession({
            provider: selectedProvider,
            prompt,
            label,
            oneTimeSkill,
            model: model ?? modelsRef.current[selectedProvider],
          }),
        { background, label, source },
      );
    },
    [runCreate],
  );

  const loadTranscripts = useCallback(async (scope: "current" | "all" = "all") => {
    setTranscriptsLoading(true);
    setTranscriptsError(null);
    try {
      const listed = await listAgentTranscripts(scope);
      if (mountedRef.current) setTranscripts(listed);
      return listed;
    } catch (error) {
      if (mountedRef.current) setTranscriptsError(errorMessage(error));
      return [];
    } finally {
      if (mountedRef.current) setTranscriptsLoading(false);
    }
  }, []);

  /**
   * Resuming deliberately ignores the provider's model pin: the pin says what
   * *new* sessions should use, and silently moving an existing conversation to
   * a different model mid-thread is worse than leaving it where it was. The CLI
   * falls back to the model the session was recorded with.
   */
  const resumeTask = useCallback(
    (transcript: AgentTranscriptInfo, options?: { background?: boolean }) =>
      runCreate(
        () =>
          createAgentTerminalSession({
            provider: transcript.provider,
            prompt: "",
            resumeId: transcript.id,
            label: transcript.title,
          }),
        { background: options?.background, label: transcript.title },
      ),
    [runCreate],
  );

  /**
   * A plain workspace shell in the dock. An optional command is typed in as the
   * first line once the PTY is up — the session itself is an ordinary shell, so
   * nothing here can run a program the user did not type.
   */
  const createShellTask = useCallback(
    (command?: string, options?: { background?: boolean }) => {
      const trimmed = command?.trim();
      return runCreate(() => createTerminalSession(), {
        background: options?.background,
        initialInput: trimmed ? [trimmed, "\r"] : undefined,
        label: trimmed ? shellTaskLabel(trimmed) : undefined,
      });
    },
    [runCreate],
  );

  /** One-shot: the viewport claims a shell task's opening command exactly once. */
  const claimInitialInput = useCallback((id: string) => {
    const inputs = initialInputRef.current.get(id);
    if (inputs) initialInputRef.current.delete(id);
    return inputs;
  }, []);

  const closeTask = useCallback(
    async (id: string, nextActiveId?: string | null) => {
      if (pendingTaskIdsRef.current.has(id)) return false;
      pendingTaskIdsRef.current.add(id);
      setPendingTaskIds(new Set(pendingTaskIdsRef.current));
      closedIdsRef.current.add(id);
      try {
        await closeTerminalSession(id);
        if (!mountedRef.current) return false;
        const current = tasksRef.current;
        const closedIndex = current.findIndex((task) => task.id === id);
        const next = current.filter((task) => task.id !== id);
        taskOrderRef.current.delete(id);
        initialInputRef.current.delete(id);
        setTasks(next);
        if (activeTaskIdRef.current === id) {
          const adjacent =
            nextActiveId === undefined
              ? next[Math.min(Math.max(closedIndex, 0), next.length - 1)]?.id
              : nextActiveId;
          setActiveTaskId(adjacent ?? null);
        }
        return true;
      } catch (error) {
        // Stop intentionally terminates the remote PTY while retaining its
        // local tab. A later close may therefore see an already-gone session;
        // closing that exited tab is still a successful local operation.
        const current = tasksRef.current;
        const closedIndex = current.findIndex((task) => task.id === id);
        if (current[closedIndex]?.state === "exited") {
          const next = current.filter((task) => task.id !== id);
          taskOrderRef.current.delete(id);
          initialInputRef.current.delete(id);
          setTasks(next);
          if (activeTaskIdRef.current === id) {
            const adjacent =
              nextActiveId === undefined
                ? next[Math.min(Math.max(closedIndex, 0), next.length - 1)]?.id
                : nextActiveId;
            setActiveTaskId(adjacent ?? null);
          }
          return true;
        }
        closedIdsRef.current.delete(id);
        if (mountedRef.current) setTerminalError(errorMessage(error));
        return false;
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

  const renameTask = useCallback(
    async (id: string, requestedLabel: string) => {
      const label = requestedLabel.trim();
      if (!label || pendingTaskIdsRef.current.has(id)) return false;
      const previous = tasksRef.current.find((task) => task.id === id);
      if (!previous || previous.label === label) return Boolean(previous);
      pendingTaskIdsRef.current.add(id);
      setPendingTaskIds(new Set(pendingTaskIdsRef.current));
      setTerminalError(null);
      setTasks(
        tasksRef.current.map((task) =>
          task.id === id ? { ...task, label } : task,
        ),
      );
      try {
        const session = await renameTerminalSession(id, label);
        if (!mountedRef.current) return false;
        setTasks(
          tasksRef.current.map((task) =>
            task.id === id ? { ...task, ...session, id } : task,
          ),
        );
        return true;
      } catch (error) {
        if (mountedRef.current) {
          setTasks(
            tasksRef.current.map((task) =>
              task.id === id && task.label === label
                ? { ...task, label: previous.label }
                : task,
            ),
          );
          setTerminalError(errorMessage(error));
        }
        return false;
      } finally {
        pendingTaskIdsRef.current.delete(id);
        if (mountedRef.current) {
          setPendingTaskIds(new Set(pendingTaskIdsRef.current));
        }
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

  return {
    tasks,
    tasksHydrated,
    tasksHydrationSettled,
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
    models,
    selectModel,
    transcripts,
    transcriptsLoading,
    transcriptsError,
    loadTranscripts,
    resumeTask,
    createTask,
    createShellTask,
    claimInitialInput,
    closeTask,
    stopTask,
    renameTask,
    updateTaskStatus,
  };
}
