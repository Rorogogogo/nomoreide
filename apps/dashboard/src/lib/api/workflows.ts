/** Workflows API entry point shared by browser and desktop. */
import type { WorkflowsApi } from "./workflows-api.js";
import { httpWorkflowsApi } from "./workflows-http.js";

const api: WorkflowsApi = httpWorkflowsApi;

export const {
  listWorkflows,
  saveWorkflow,
  deleteWorkflow,
  getGitStatus,
  listWorkflowTriggers,
  saveWorkflowTrigger,
  deleteWorkflowTrigger,
  listPendingRuns,
  ackPendingRun,
} = api;

export type {
  WorkflowsApi,
  WorkflowCapabilities,
  WorkflowStep,
  Workflow,
  GitStatusSummary,
  TriggerEvent,
  WorkflowTrigger,
  PendingRun,
} from "./workflows-api.js";
