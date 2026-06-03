import { createContext, useContext, type ReactNode } from "react";
import { useWorkflowRunner } from "./use-workflow-runner";

type WorkflowRunValue = ReturnType<typeof useWorkflowRunner>;

const WorkflowRunContext = createContext<WorkflowRunValue | null>(null);

/**
 * Holds the active workflow run at the app root so it survives page/tab
 * navigation — switch away from the Workflows tab and back without losing the
 * pipeline, and the run keeps going (and pausing at gates) in the background.
 * Mounted inside the AgentProvider so the runner can drive the dock conversation.
 */
export function WorkflowRunProvider({
  onRefresh,
  children,
}: {
  onRefresh?: () => void;
  children: ReactNode;
}) {
  const value = useWorkflowRunner(onRefresh);
  return <WorkflowRunContext.Provider value={value}>{children}</WorkflowRunContext.Provider>;
}

export function useWorkflowRun(): WorkflowRunValue {
  const ctx = useContext(WorkflowRunContext);
  if (!ctx) throw new Error("useWorkflowRun must be used within a WorkflowRunProvider");
  return ctx;
}
