/**
 * Agent Environments API surface — the single contract both backends
 * implement. Reads coding agents' live MCP + skill configuration; strictly
 * read-only in Phase 1 (ROR-60).
 */

/** Distinct from the agent-chat domain's `AgentName` ("claude-code" | "codex"). */
export type AgentEnvAgentName = "claude" | "codex" | "antigravity";

export interface AgentEnvMcpEntry {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface AgentEnvRemoteMcpEntry {
  transport: "http" | "sse";
  url: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
}

export interface AgentEnvSkill {
  name: string;
  source?: string;
  kind?: "skill" | "plugin";
  scope: "user" | "project";
  pluginSkills?: string[];
  pluginMcps?: string[];
  pluginAgents?: string[];
  pluginCommands?: string[];
  installPath?: string;
  managed?: boolean;
}

export interface AgentEnvConfig {
  agent: AgentEnvAgentName;
  configPath: string;
  exists: boolean;
  mcpServers: Record<string, AgentEnvMcpEntry>;
  remoteMcpServers: Record<string, AgentEnvRemoteMcpEntry>;
  projectMcpServers: Record<string, AgentEnvMcpEntry>;
  projectRemoteMcpServers: Record<string, AgentEnvRemoteMcpEntry>;
  skills: AgentEnvSkill[];
}

export interface AgentEnvAvailability {
  agent: AgentEnvAgentName;
  available: boolean;
  command: string;
  resolvedPath?: string;
}

export interface AgentEnvDoctorCheck {
  label: string;
  status: "ok" | "warn";
  message: string;
}

export interface AgentEnvDoctorResult {
  checks: AgentEnvDoctorCheck[];
  hasIssues: boolean;
}

export interface AgentEnvApi {
  getAgentEnvAgents(): Promise<AgentEnvAvailability[]>;
  getAgentEnvConfigs(): Promise<AgentEnvConfig[]>;
  getAgentEnvDoctor(): Promise<AgentEnvDoctorResult>;
}
