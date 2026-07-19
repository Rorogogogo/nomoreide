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

/** One staged mutation. `name` is the MCP key, skill directory, or plugin name. */
export interface AgentEnvPendingChange {
  category: "mcp" | "skill" | "plugin";
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

export interface AgentEnvSettings {
  agent: AgentEnvAgentName;
  path: string;
  exists: boolean;
  format: "json" | "toml";
  content: string;
  model?: string;
  modelEditable: boolean;
}

export interface AgentEnvProfileSummary {
  name: string;
  description?: string;
  /** Agent the profile was snapshotted from; absent on older/imported profiles. */
  sourceAgent?: AgentEnvAgentName;
  mcpCount: number;
  skillCount: number;
  updatedAt: string;
}

export interface AgentEnvProfile {
  name: string;
  description?: string;
  sourceAgent?: AgentEnvAgentName;
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

/* ---- Registry (ROR-63): the hosted profile registry (brainctl platform) ---- */

export interface AgentEnvRegistryStatus {
  signedIn: boolean;
  user?: { email?: string; displayName?: string; avatarUrl?: string };
  /** Where the token came from — env tokens can't be signed out from the UI. */
  source?: "env" | "config";
  error?: string;
  apiBaseUrl: string;
  apiMode: "local" | "prod" | "custom";
  apiFrontendUrl: string;
}

export interface AgentEnvRegistryPublishResult {
  slug: string;
  profileId: string;
  versionId: string;
  version: string;
}

export interface AgentEnvRegistryInstallResult extends AgentEnvProfileImportResult {
  version: string;
  sourceKind: string;
}

export interface AgentEnvApi {
  getAgentEnvAgents(): Promise<AgentEnvAvailability[]>;
  getAgentEnvConfigs(): Promise<AgentEnvConfig[]>;
  getAgentEnvDoctor(): Promise<AgentEnvDoctorResult>;
  previewAgentEnvChanges(changes: AgentEnvPendingChange[]): Promise<AgentEnvChangePreview>;
  applyAgentEnvChanges(changes: AgentEnvPendingChange[]): Promise<AgentEnvApplyResult>;
  snapshotAgentEnv(agent: AgentEnvAgentName): Promise<AgentEnvSnapshotResult>;
  getAgentEnvSettings(agent: AgentEnvAgentName): Promise<AgentEnvSettings>;
  saveAgentEnvSettings(
    agent: AgentEnvAgentName,
    content: string,
  ): Promise<{ settings: AgentEnvSettings; backup: string | null }>;
  setAgentEnvModel(
    agent: AgentEnvAgentName,
    model: string,
  ): Promise<{ settings: AgentEnvSettings; backup: string | null }>;
  listAgentEnvProfiles(): Promise<AgentEnvProfileSummary[]>;
  getAgentEnvProfile(name: string): Promise<AgentEnvProfile>;
  updateAgentEnvProfile(
    name: string,
    patch: Partial<Pick<AgentEnvProfile, "description" | "mcps" | "skills">>,
  ): Promise<AgentEnvProfile>;
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
  getRegistryAuthStatus(): Promise<AgentEnvRegistryStatus>;
  startRegistryAuth(): Promise<{ url: string; state: string }>;
  getRegistryAuthOutcome(state: string): Promise<{ status: string; message?: string }>;
  registryLogout(): Promise<void>;
  publishAgentEnvProfile(input: {
    name: string;
    slug: string;
    title: string;
    summary?: string;
    version?: string;
  }): Promise<AgentEnvRegistryPublishResult>;
  installAgentEnvProfileFromRegistry(input: {
    slug: string;
    force?: boolean;
  }): Promise<AgentEnvRegistryInstallResult>;
}
