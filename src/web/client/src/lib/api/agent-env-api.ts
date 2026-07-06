/**
 * Agent Environments API surface — the single contract both backends
 * implement. Reads coding agents' live MCP + skill configuration (ROR-60) and
 * stages copy/move/remove changes behind a preview → apply gate (ROR-61).
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

export type AgentEnvScope = "user" | "project";

/** One staged mutation. `name` is the MCP key or the skill directory name. */
export interface AgentEnvPendingChange {
  category: "mcp" | "skill";
  action: "copy" | "move" | "remove";
  name: string;
  sourceAgent: AgentEnvAgentName;
  sourceScope: AgentEnvScope;
  targetAgent?: AgentEnvAgentName;
  targetScope?: AgentEnvScope;
}

export interface AgentEnvPreviewItem {
  change: AgentEnvPendingChange;
  ok: boolean;
  summary: string;
  warnings: string[];
  error?: string;
}

export interface AgentEnvDiffSummary {
  agent: AgentEnvAgentName;
  add: string[];
  remove: string[];
}

export interface AgentEnvChangePreview {
  valid: boolean;
  items: AgentEnvPreviewItem[];
  agents: AgentEnvDiffSummary[];
}

export interface AgentEnvAppliedChange {
  change: AgentEnvPendingChange;
  ok: boolean;
  summary: string;
  backups: string[];
  error?: string;
}

export interface AgentEnvApplyResult {
  ok: boolean;
  applied: number;
  failed: number;
  results: AgentEnvAppliedChange[];
  backups: string[];
}

export interface AgentEnvSnapshotResult {
  agent: AgentEnvAgentName;
  backups: string[];
}

/* ---- Profiles (ROR-62): named MCP+skill bundles ---- */

export type AgentEnvProfileMcp =
  | { kind: "local"; command: string; args?: string[]; env?: Record<string, string> }
  | {
      kind: "remote";
      transport: "http" | "sse";
      url: string;
      headers?: Record<string, string>;
      env?: Record<string, string>;
    };

export interface AgentEnvProfileSummary {
  name: string;
  description?: string;
  mcpCount: number;
  skillCount: number;
  updatedAt: string;
}

export interface AgentEnvProfile {
  name: string;
  description?: string;
  mcps: Record<string, AgentEnvProfileMcp>;
  skills: Array<{ name: string }>;
}

export interface AgentEnvProfileApplyItem {
  category: "mcp" | "skill";
  name: string;
  status: "add" | "identical" | "conflict";
  warnings: string[];
}

export interface AgentEnvProfileApplyPreview {
  profile: string;
  agent: AgentEnvAgentName;
  items: AgentEnvProfileApplyItem[];
  unresolvedCredentials: string[];
}

export interface AgentEnvProfileApplyResult {
  profile: string;
  agent: AgentEnvAgentName;
  mcpsApplied: string[];
  skillsApplied: string[];
  skipped: string[];
  backups: string[];
}

export interface AgentEnvProfileImportResult {
  name: string;
  mcpCount: number;
  skillCount: number;
  missingCredentials: Array<{ key: string; required: boolean; description?: string }>;
}

export interface AgentEnvApi {
  getAgentEnvAgents(): Promise<AgentEnvAvailability[]>;
  getAgentEnvConfigs(): Promise<AgentEnvConfig[]>;
  getAgentEnvDoctor(): Promise<AgentEnvDoctorResult>;
  previewAgentEnvChanges(changes: AgentEnvPendingChange[]): Promise<AgentEnvChangePreview>;
  applyAgentEnvChanges(changes: AgentEnvPendingChange[]): Promise<AgentEnvApplyResult>;
  snapshotAgentEnv(agent: AgentEnvAgentName): Promise<AgentEnvSnapshotResult>;
  listAgentEnvProfiles(): Promise<AgentEnvProfileSummary[]>;
  getAgentEnvProfile(name: string): Promise<AgentEnvProfile>;
  deleteAgentEnvProfile(name: string): Promise<void>;
  snapshotAgentEnvProfile(input: {
    agent: AgentEnvAgentName;
    name: string;
    description?: string;
  }): Promise<AgentEnvProfile>;
  previewAgentEnvProfileApply(
    name: string,
    agent: AgentEnvAgentName,
  ): Promise<AgentEnvProfileApplyPreview>;
  applyAgentEnvProfile(input: {
    name: string;
    agent: AgentEnvAgentName;
    skip?: { mcps?: string[]; skills?: string[] };
  }): Promise<AgentEnvProfileApplyResult>;
  exportAgentEnvProfile(name: string): Promise<{ archivePath: string }>;
  importAgentEnvProfile(file: Blob, options?: { force?: boolean }): Promise<AgentEnvProfileImportResult>;
}
