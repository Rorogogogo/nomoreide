/**
 * Agent Environments core — read-only. Every function here only reads agent
 * config files; mutations belong to the (future, ROR-61) write-guarded
 * agent-env-actions module, mirroring the GitManager/GitActions split.
 */
import { readAntigravityConfig } from "./antigravity-reader.js";
import { buildDoctorResult, getAgentAvailability } from "./availability.js";
import { readClaudeConfig } from "./claude-reader.js";
import { readCodexConfig } from "./codex-reader.js";
import type {
  AgentDoctorResult,
  AgentEnvReadOptions,
  AgentLiveConfig,
} from "./types.js";

export async function readAllAgentConfigs(
  options: AgentEnvReadOptions,
): Promise<AgentLiveConfig[]> {
  return Promise.all([
    readClaudeConfig(options),
    readCodexConfig(options),
    readAntigravityConfig(options),
  ]);
}

export async function runAgentDoctor(
  options: AgentEnvReadOptions,
): Promise<AgentDoctorResult> {
  const [availability, configs] = await Promise.all([
    getAgentAvailability(),
    readAllAgentConfigs(options),
  ]);
  return buildDoctorResult(availability, configs);
}

export { readClaudeConfig } from "./claude-reader.js";
export { readCodexConfig } from "./codex-reader.js";
export { readAntigravityConfig } from "./antigravity-reader.js";
export { findExecutable, getAgentAvailability } from "./availability.js";
export type {
  AgentAvailability,
  AgentDoctorCheck,
  AgentDoctorResult,
  AgentEnvReadOptions,
  AgentLiveConfig,
  AgentMcpEntry,
  AgentName,
  AgentSkillEntry,
  RemoteMcpEntry,
} from "./types.js";
export { AGENT_NAMES } from "./types.js";
