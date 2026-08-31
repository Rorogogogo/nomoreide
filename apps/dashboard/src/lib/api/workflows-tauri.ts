/** Rust-core implementation of {@link WorkflowsApi}, over Tauri `invoke()` (desktop). */
import {
  tauri_listWorkflows,
  tauri_saveWorkflow,
  tauri_deleteWorkflow,
  tauri_gitStatus,
} from "./tauri-bridge.js";
import type { Workflow, WorkflowsApi } from "./workflows-api.js";

export const tauriWorkflowsApi: WorkflowsApi = {
  listWorkflows: () => tauri_listWorkflows() as Promise<Workflow[]>,
  saveWorkflow: (workflow) => tauri_saveWorkflow(workflow) as Promise<Workflow[]>,
  deleteWorkflow: (id) => tauri_deleteWorkflow(id) as Promise<Workflow[]>,
  async getGitStatus() {
    const s = await tauri_gitStatus();
    return {
      branch: s.branch,
      upstream: s.upstream ?? undefined,
      ahead: s.ahead,
      behind: s.behind,
      files: s.files,
    };
  },
  // Event-driven triggers are a web/MCP feature (server-side event bus + SSE
  // queue); the desktop core has no equivalent yet, so these are inert here.
  listWorkflowTriggers: async () => [],
  saveWorkflowTrigger: async () => [],
  deleteWorkflowTrigger: async () => [],
  listPendingRuns: async () => [],
  ackPendingRun: async () => {},
};
