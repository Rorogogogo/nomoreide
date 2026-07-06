/**
 * Agent Environments API entry point. Picks the backend implementation once at
 * module load (`isTauri()` → Rust core, else Node HTTP) and re-exports its
 * methods as named functions — never a per-function `if (isTauri())` branch.
 */
import { isTauri } from "./tauri-bridge.js";
import type { AgentEnvApi } from "./agent-env-api.js";
import { httpAgentEnvApi } from "./agent-env-http.js";
import { tauriAgentEnvApi } from "./agent-env-tauri.js";

const api: AgentEnvApi = isTauri() ? tauriAgentEnvApi : httpAgentEnvApi;

export const { getAgentEnvAgents, getAgentEnvConfigs, getAgentEnvDoctor } = api;

export type {
  AgentEnvAgentName,
  AgentEnvApi,
  AgentEnvAvailability,
  AgentEnvConfig,
  AgentEnvDoctorCheck,
  AgentEnvDoctorResult,
  AgentEnvMcpEntry,
  AgentEnvRemoteMcpEntry,
  AgentEnvSkill,
} from "./agent-env-api.js";
