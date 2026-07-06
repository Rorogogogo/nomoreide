/**
 * Agent Environments — read-only view of coding agents' live configuration
 * (MCP servers + skills) across Claude Code, Codex CLI, and Antigravity.
 * Ported from brainctl's sync/agent-reader layer (see ROR-59/ROR-60).
 */

export type AgentName = "claude" | "codex" | "antigravity";

export const AGENT_NAMES: AgentName[] = ["claude", "codex", "antigravity"];

export interface AgentMcpEntry {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface RemoteMcpEntry {
  transport: "http" | "sse";
  url: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
}

export interface AgentSkillEntry {
  name: string;
  /** e.g. "claude-plugins-official", "local", "linked", or a marketplace id. */
  source?: string;
  kind?: "skill" | "plugin";
  /**
   * Where this skill lives:
   *   - "user"    — `~/.<agent>/skills/` or a user-installed plugin
   *   - "project" — `<repo>/.claude/skills/` (Claude only)
   */
  scope: "user" | "project";
  pluginSkills?: string[];
  pluginMcps?: string[];
  pluginAgents?: string[];
  pluginCommands?: string[];
  installPath?: string;
  managed?: boolean;
}

export interface AgentLiveConfig {
  agent: AgentName;
  configPath: string;
  exists: boolean;
  mcpServers: Record<string, AgentMcpEntry>;
  remoteMcpServers: Record<string, RemoteMcpEntry>;
  projectMcpServers: Record<string, AgentMcpEntry>;
  projectRemoteMcpServers: Record<string, RemoteMcpEntry>;
  skills: AgentSkillEntry[];
}

export interface AgentAvailability {
  agent: AgentName;
  available: boolean;
  command: string;
  resolvedPath?: string;
}

export interface AgentDoctorCheck {
  label: string;
  status: "ok" | "warn";
  message: string;
}

export interface AgentDoctorResult {
  checks: AgentDoctorCheck[];
  hasIssues: boolean;
}

/** Options shared by every reader; `homeDir` is injectable for tests. */
export interface AgentEnvReadOptions {
  cwd: string;
  homeDir?: string;
}
