/**
 * Desktop stub for {@link AgentEnvApi}. Agent Environments is web/MCP-only for
 * now — the Rust core has no agent-config readers yet (deliberate: ROR-60
 * defers the dual-backend port). The view renders an informative empty state.
 */
import type { AgentEnvApi } from "./agent-env-api.js";

const notAvailable = () =>
  Promise.reject(new Error("Agent Environments is not available in desktop mode yet."));

export const tauriAgentEnvApi: AgentEnvApi = {
  getAgentEnvAgents: async () => [],
  getAgentEnvConfigs: async () => [],
  getAgentEnvDoctor: async () => ({
    checks: [
      {
        label: "Desktop mode",
        status: "warn",
        message: "Agent Environments is not available in desktop mode yet.",
      },
    ],
    hasIssues: true,
  }),
  // Unreachable in practice: with no configs the view renders no action menus.
  previewAgentEnvChanges: notAvailable,
  applyAgentEnvChanges: notAvailable,
  snapshotAgentEnv: notAvailable,
  listAgentEnvProfiles: async () => [],
  getAgentEnvProfile: notAvailable,
  deleteAgentEnvProfile: notAvailable,
  snapshotAgentEnvProfile: notAvailable,
  previewAgentEnvProfileApply: notAvailable,
  applyAgentEnvProfile: notAvailable,
  exportAgentEnvProfile: notAvailable,
  importAgentEnvProfile: notAvailable,
};
