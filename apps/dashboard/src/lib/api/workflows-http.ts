/** Node HTTP-server implementation of {@link WorkflowsApi} (the web/MCP backend). */
import { requestJson } from "./client.js";
import type {
  GitStatusSummary,
  PendingRun,
  Workflow,
  WorkflowsApi,
  WorkflowTrigger,
} from "./workflows-api.js";

export const httpWorkflowsApi: WorkflowsApi = {
  async listWorkflows() {
    const res = await requestJson<{ ok: true; workflows: Workflow[] }>("/api/workflows");
    return res.workflows;
  },

  async saveWorkflow(workflow) {
    const res = await requestJson<{ ok: true; workflows: Workflow[] }>("/api/workflows", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(workflow),
    });
    return res.workflows;
  },

  async deleteWorkflow(id) {
    const res = await requestJson<{ ok: true; workflows: Workflow[] }>(
      `/api/workflows/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
    return res.workflows;
  },

  async getGitStatus() {
    const res = await requestJson<{ ok: true; status: GitStatusSummary }>("/api/git/status");
    return res.status;
  },

  async listWorkflowTriggers() {
    const res = await requestJson<{ ok: true; triggers: WorkflowTrigger[] }>(
      "/api/workflow-triggers",
    );
    return res.triggers;
  },

  async saveWorkflowTrigger(trigger) {
    const res = await requestJson<{ ok: true; triggers: WorkflowTrigger[] }>(
      "/api/workflow-triggers",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(trigger),
      },
    );
    return res.triggers;
  },

  async deleteWorkflowTrigger(id) {
    const res = await requestJson<{ ok: true; triggers: WorkflowTrigger[] }>(
      `/api/workflow-triggers/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
    return res.triggers;
  },

  async listPendingRuns() {
    const res = await requestJson<{ ok: true; pending: PendingRun[] }>(
      "/api/workflow-triggers/pending",
    );
    return res.pending;
  },

  async ackPendingRun(id) {
    await requestJson(`/api/workflow-triggers/pending/${encodeURIComponent(id)}/ack`, {
      method: "POST",
    });
  },
};
