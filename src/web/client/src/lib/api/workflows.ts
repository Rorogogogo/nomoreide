/**
 * Workflows API entry point. Picks the backend implementation once at module
 * load (`isTauri()` → Rust core, else Node HTTP) and re-exports its methods as
 * the named functions the rest of the app already imports — never a per-function
 * `if (isTauri())` branch.
 */
import { isTauri } from "./tauri-bridge.js";
import type { WorkflowsApi } from "./workflows-api.js";
import { httpWorkflowsApi } from "./workflows-http.js";
import { tauriWorkflowsApi } from "./workflows-tauri.js";

const api: WorkflowsApi = isTauri() ? tauriWorkflowsApi : httpWorkflowsApi;

export const { listWorkflows, saveWorkflow, deleteWorkflow, getGitStatus } = api;

export type {
  WorkflowsApi,
  WorkflowCapabilities,
  WorkflowStep,
  Workflow,
  GitStatusSummary,
} from "./workflows-api.js";
