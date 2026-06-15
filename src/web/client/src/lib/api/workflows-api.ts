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
}
