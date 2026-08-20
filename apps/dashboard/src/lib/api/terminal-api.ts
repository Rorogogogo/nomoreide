/**
 * Terminal API surface — the single contract both backends implement for session
 * lifecycle (list/create/close). Live terminal I/O (write/resize/output stream)
 * is transport-specific and handled by the component via the bridge helpers
 * re-exported from {@link ./terminal}. See {@link ../git-api} for the seam rationale.
 */

export type TerminalState = "idle" | "running" | "exited" | "error";
export type TerminalPresentation = "dock" | "terminalLaunching" | "terminal";

export interface TerminalCapabilities {
  externalTerminal: boolean;
}

import type { OneTimeSkillSelection } from "./skills-api.js";
import type { ContextAttachment } from "./context-api.js";
export type { OneTimeSkillSelection } from "./skills-api.js";

export interface CreateAgentTerminalOptions {
  provider: "claude" | "codex";
  prompt: string;
  label?: string;
  /** A remote skill resolved by the backend for this fresh session only. */
  oneTimeSkill?: OneTimeSkillSelection;
  /** Provider session id to reopen instead of starting a fresh conversation. */
  resumeId?: string;
  /** Model for this session. Omitted = the provider's saved pin, else CLI default. */
  model?: string;
  /** User-visible Context Library references resolved by the backend. */
  context?: ContextAttachment;
}

export interface AgentTranscriptInfo {
  id: string;
  provider: "claude" | "codex";
  cwd: string;
  title: string;
  startedAt: string;
  updatedAt: string;
}

export type AgentTranscriptScope = "current" | "all";

/** One terminal tab as tracked by the server's session manager. */
export interface TerminalSessionInfo {
  id: string;
  cwd: string;
  cols: number;
  rows: number;
  shell: string;
  state: TerminalState;
  kind?: "shell" | "service" | "agent";
  provider?: "claude" | "codex";
  /** Tab label when the session is scoped to a service. */
  label?: string;
  error?: string;
  /** Which surface currently owns keyboard input and terminal resizing. */
  presentation?: TerminalPresentation;
}

export interface TerminalApi {
  listTerminalSessions(): Promise<TerminalSessionInfo[]>;
  listAgentTranscripts(scope?: AgentTranscriptScope): Promise<AgentTranscriptInfo[]>;
  createTerminalSession(opts?: { serviceName?: string }): Promise<TerminalSessionInfo>;
  createAgentTerminalSession(opts: CreateAgentTerminalOptions): Promise<TerminalSessionInfo>;
  renameTerminalSession(id: string, label: string): Promise<TerminalSessionInfo>;
  getTerminalCapabilities(): Promise<TerminalCapabilities>;
  openTerminalInSystemTerminal(id: string): Promise<TerminalSessionInfo>;
  reclaimTerminalToDock(id: string): Promise<TerminalSessionInfo>;
  insertAgentPrompt(id: string, prompt: string): Promise<void>;
  onTerminalSessionChanged(handler: (session: TerminalSessionInfo) => void): Promise<() => void>;
  closeTerminalSession(id: string): Promise<void>;
}
