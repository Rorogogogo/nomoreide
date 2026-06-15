/** Node HTTP-server implementation of {@link WorkflowsApi} (the web/MCP backend). */
import { requestJson } from "./client.js";
import type { GitStatusSummary, Workflow, WorkflowsApi } from "./workflows-api.js";

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
};
