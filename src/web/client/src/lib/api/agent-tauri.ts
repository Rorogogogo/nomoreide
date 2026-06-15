/**
 * Rust-core implementation of {@link AgentApi} (desktop). Agent CLI introspection
 * has no Rust backend: the profile and usage degrade to empty, and the remaining
 * settings/status helpers are inherited from the HTTP impl (unused in desktop,
 * where the agent panels render their empty state).
 */
import { httpAgentApi } from "./agent-http.js";
import type { AgentApi, AgentProfile } from "./agent-api.js";

const emptyProfile: AgentProfile = {
  project: { cwd: "", memoryFiles: [] },
  skills: [],
  mcpServers: [],
  plugins: [],
  hooks: [],
  projects: [],
};

export const tauriAgentApi: AgentApi = {
  ...httpAgentApi,
  getAgentInfo: async () => ({
    ...emptyProfile,
    detected: { name: "unknown", label: "Desktop mode", signals: [] },
    agents: { "claude-code": emptyProfile, codex: emptyProfile },
  }),
  getAgentUsage: async () => ({}),
};
