/**
 * Workflows API surface — the single contract both backends implement. See
 * {@link ../git-api} for the shared-interface seam rationale.
 */
import type { GitFileStatus } from "./git.js";

/** Mirrors the server step kinds in `core/workflows.ts`. */
export interface WorkflowCapabilities {
  skills?: string[];
  mcpServers?: string[];
  plugins?: string[];
  hooks?: string[];
}

export type WorkflowStep =
  | {
      kind: "action";
      id: string;
      title: string;
      op: "push" | "commit" | "assert-pr-branch" | "checkout-default-and-pull";
    }
  | {
      kind: "agent";
      id: string;
      title: string;
      prompt: string;
      capabilities?: WorkflowCapabilities;
      verify?: "committed" | "pushed";
      /** Run in a fresh one-shot session (cheaper; no memory of earlier steps). */
      isolated?: boolean;
    }
  | { kind: "gate"; id: string; title: string; message: string };

export interface Workflow {
  id: string;
  name: string;
  description?: string;
  builtin?: boolean;
  steps: WorkflowStep[];
}

/** Mirrors `core/workflow-triggers.ts`. */
export type TriggerEvent = "error-incident" | "service-crash";

export interface WorkflowTrigger {
  id: string;
  workflowId: string;
  event: TriggerEvent;
  enabled: boolean;
  filter?: string;
  autoRun: boolean;
}

/** A fired trigger waiting for the client runner to pick it up. */
export interface PendingRun {
  id: string;
  triggerId: string;
  workflowId: string;
  event: TriggerEvent;
  summary: string;
  signature: string;
  autoRun: boolean;
  createdAt: string;
}

export interface GitStatusSummary {
  branch: string;
  upstream?: string;
  ahead: number;
  behind: number;
  files: GitFileStatus[];
}

export interface WorkflowsApi {
  listWorkflows(): Promise<Workflow[]>;
  saveWorkflow(workflow: Workflow): Promise<Workflow[]>;
  deleteWorkflow(id: string): Promise<Workflow[]>;
  /** Fresh git status — used by the runner to verify an agent step's real effect. */
  getGitStatus(): Promise<GitStatusSummary>;
  listWorkflowTriggers(): Promise<WorkflowTrigger[]>;
  saveWorkflowTrigger(trigger: WorkflowTrigger): Promise<WorkflowTrigger[]>;
  deleteWorkflowTrigger(id: string): Promise<WorkflowTrigger[]>;
  listPendingRuns(): Promise<PendingRun[]>;
  ackPendingRun(id: string): Promise<void>;
}
