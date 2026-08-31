import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ackPendingRun,
  deleteWorkflowTrigger,
  listPendingRuns,
  listWorkflows,
  listWorkflowTriggers,
  saveWorkflowTrigger,
  type PendingRun,
  type Workflow,
  type WorkflowTrigger,
} from "@/lib/api";
import { useT } from "@/lib/i18n";
import { useWorkflowRun } from "./workflow-run-context";

interface WorkflowTriggerValue {
  triggers: WorkflowTrigger[];
  pending: PendingRun[];
  workflows: Workflow[];
  error: string | null;
  saveTrigger: (trigger: WorkflowTrigger) => Promise<void>;
  removeTrigger: (id: string) => Promise<void>;
  /** Start a queued run now, then drop it from the queue. */
  runPending: (run: PendingRun) => void;
  /** Drop a queued run without running it. */
  dismissPending: (id: string) => Promise<void>;
}

const WorkflowTriggerContext = createContext<WorkflowTriggerValue | null>(null);

/**
 * Owns event-driven workflow triggers (IDEAS #16) at the app root. The server
 * detects events (error incidents, service crashes) and enqueues *pending runs*;
 * this provider streams that queue, auto-starts the runs whose trigger opted into
 * `autoRun`, and exposes the rest for one-click start in the Workflows panel.
 *
 * Mounted *inside* {@link WorkflowRunProvider} so the watcher can drive the same
 * client-side runner a manual workflow uses — there is no server-side runner.
 */
export function WorkflowTriggerProvider({ children }: { children: ReactNode }) {
  const t = useT();
  const { start, isRunning } = useWorkflowRun();
  const [triggers, setTriggers] = useState<WorkflowTrigger[]>([]);
  const [pending, setPending] = useState<PendingRun[]>([]);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Pending runs we've already handed to the runner — guards against an
  // auto-run firing twice as the queue/`isRunning` effect re-evaluates.
  const handledRef = useRef<Set<string>>(new Set());

  const upsertPending = useCallback((incoming: PendingRun) => {
    setPending((prev) => [incoming, ...prev.filter((run) => run.id !== incoming.id)]);
  }, []);

  // Seed triggers + workflows, then live-stream the pending-run queue over SSE.
  useEffect(() => {
    let active = true;
    void Promise.all([
      listWorkflowTriggers().catch(() => [] as WorkflowTrigger[]),
      listWorkflows().catch(() => [] as Workflow[]),
      listPendingRuns().catch(() => [] as PendingRun[]),
    ]).then(([nextTriggers, nextWorkflows, nextPending]) => {
      if (!active) return;
      // A backend that answers 200 with an unexpected shape (e.g. the website
      // mock) can yield `undefined` here; never let a non-array reach the
      // spread in the auto-run effect, which would white-screen the app root.
      setTriggers(Array.isArray(nextTriggers) ? nextTriggers : []);
      setWorkflows(Array.isArray(nextWorkflows) ? nextWorkflows : []);
      setPending(Array.isArray(nextPending) ? nextPending : []);
    });

    const source = new EventSource("/api/workflow-triggers/pending/stream");
    source.addEventListener("pending", (event) => {
      try {
        upsertPending(JSON.parse((event as MessageEvent).data) as PendingRun);
      } catch {
        // ignore malformed events
      }
    });

    return () => {
      active = false;
      source.close();
    };
  }, [upsertPending]);

  const dismissPending = useCallback(async (id: string) => {
    setPending((prev) => prev.filter((run) => run.id !== id));
    await ackPendingRun(id).catch(() => {});
  }, []);

  const runPending = useCallback(
    (run: PendingRun) => {
      const workflow = workflows.find((item) => item.id === run.workflowId);
      handledRef.current.add(run.id);
      void dismissPending(run.id);
      if (workflow) start(workflow, true);
      else setError(t("workflows.triggers.missingWorkflow", { id: run.workflowId }));
    },
    [workflows, start, dismissPending, t],
  );

  // Auto-run watcher: when the runner is idle, start the oldest queued run whose
  // trigger asked for autoRun. Manual (non-autoRun) runs wait for the user.
  useEffect(() => {
    if (isRunning) return;
    const next = [...pending]
      .reverse()
      .find((run) => run.autoRun && !handledRef.current.has(run.id));
    if (next) runPending(next);
  }, [pending, isRunning, runPending]);

  const saveTrigger = useCallback(async (trigger: WorkflowTrigger) => {
    try {
      setTriggers(await saveWorkflowTrigger(trigger));
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, []);

  const removeTrigger = useCallback(async (id: string) => {
    try {
      setTriggers(await deleteWorkflowTrigger(id));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, []);

  return (
    <WorkflowTriggerContext.Provider
      value={{
        triggers,
        pending,
        workflows,
        error,
        saveTrigger,
        removeTrigger,
        runPending,
        dismissPending,
      }}
    >
      {children}
    </WorkflowTriggerContext.Provider>
  );
}

export function useWorkflowTriggers(): WorkflowTriggerValue {
  const ctx = useContext(WorkflowTriggerContext);
  if (!ctx) throw new Error("useWorkflowTriggers must be used within a WorkflowTriggerProvider");
  return ctx;
}
