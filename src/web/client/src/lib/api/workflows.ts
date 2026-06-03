import { requestJson } from "./client.js";
import type { GitFileStatus } from "./git.js";

/** Mirrors the server step kinds in `core/workflows.ts`. */
export type WorkflowStep =
  | { kind: "action"; id: string; title: string; op: "push" | "commit" }
  | { kind: "agent"; id: string; title: string; prompt: string; verify?: "committed" | "pushed" }
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

export async function listWorkflows(): Promise<Workflow[]> {
  const res = await requestJson<{ ok: true; workflows: Workflow[] }>("/api/workflows");
  return res.workflows;
}

export async function saveWorkflow(workflow: Workflow): Promise<Workflow[]> {
  const res = await requestJson<{ ok: true; workflows: Workflow[] }>("/api/workflows", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(workflow),
  });
  return res.workflows;
}

export async function deleteWorkflow(id: string): Promise<Workflow[]> {
  const res = await requestJson<{ ok: true; workflows: Workflow[] }>(
    `/api/workflows/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  );
  return res.workflows;
}

/** Fresh git status — used by the runner to verify an agent step's real effect. */
export async function getGitStatus(): Promise<GitStatusSummary> {
  const res = await requestJson<{ ok: true; status: GitStatusSummary }>("/api/git/status");
  return res.status;
}
