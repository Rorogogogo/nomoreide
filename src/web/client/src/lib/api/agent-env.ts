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

export const {
  getAgentEnvAgents,
  getAgentEnvConfigs,
  getAgentEnvDoctor,
  previewAgentEnvChanges,
  applyAgentEnvChanges,
  snapshotAgentEnv,
  listAgentEnvProfiles,
  getAgentEnvProfile,
  deleteAgentEnvProfile,
  snapshotAgentEnvProfile,
  previewAgentEnvProfileApply,
  applyAgentEnvProfile,
  exportAgentEnvProfile,
  importAgentEnvProfile,
} = api;

export type {
  AgentEnvAgentName,
  AgentEnvApi,
  AgentEnvApplyResult,
  AgentEnvAppliedChange,
  AgentEnvAvailability,
  AgentEnvChangePreview,
  AgentEnvConfig,
  AgentEnvDiffSummary,
  AgentEnvDoctorCheck,
  AgentEnvDoctorResult,
  AgentEnvMcpEntry,
  AgentEnvPendingChange,
  AgentEnvPreviewItem,
  AgentEnvProfile,
  AgentEnvProfileApplyItem,
  AgentEnvProfileApplyPreview,
  AgentEnvProfileApplyResult,
  AgentEnvProfileImportResult,
  AgentEnvProfileMcp,
  AgentEnvProfileSummary,
  AgentEnvRemoteMcpEntry,
  AgentEnvScope,
  AgentEnvSkill,
  AgentEnvSnapshotResult,
} from "./agent-env-api.js";
