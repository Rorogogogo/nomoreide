/**
 * Rust-core implementation of {@link AgentApi} (desktop).
 *
 * `getAgentInfo` is backed by the Rust `get_agent_info` command — a port of the
 * Node `agent-info.ts` introspection (skills, MCP servers, plugins, hooks,
 * project memory). The remaining helpers have no Rust backend yet and would 404
 * against the absent Node server, so they degrade to safe defaults here rather
 * than inherit the HTTP impl. See {@link ./git-api} for the seam rationale.
 */
import { tauri_getAgentInfo } from "./tauri-bridge.js";
import type { AgentApi, AgentInfo, ClaudeAgentSettings } from "./agent-api.js";

export const tauriAgentApi: AgentApi = {
  getAgentInfo: () => tauri_getAgentInfo() as Promise<AgentInfo>,
  // Live MCP auth state and the tool-call feed are Node-server features; the
  // desktop app has no equivalent, so they report empty rather than error.
  getMcpAuthStatuses: async () => [],
  getRecentToolCalls: async () => [],
  getAgentUsage: async () => ({}),
  // Settings persistence isn't wired to Rust yet; expose the default and treat
  // updates as a no-op echo so the panel renders without throwing.
  getClaudeAgentSettings: async (): Promise<ClaudeAgentSettings> => ({
    coAuthorWithClaude: true,
  }),
  updateClaudeAgentSettings: async (settings) => ({
    coAuthorWithClaude: settings.coAuthorWithClaude ?? true,
  }),
};
