/**
 * Terminal API surface — the single contract both backends implement for session
 * lifecycle (list/create/close). Live terminal I/O (write/resize/output stream)
 * is transport-specific and handled by the component via the bridge helpers
 * re-exported from {@link ./terminal}. See {@link ../git-api} for the seam rationale.
 */

export type TerminalState = "idle" | "running" | "exited" | "error";

/** One terminal tab as tracked by the server's session manager. */
export interface TerminalSessionInfo {
  id: string;
  cwd: string;
  cols: number;
  rows: number;
  shell: string;
  state: TerminalState;
  /** Tab label when the session is scoped to a service. */
  label?: string;
  error?: string;
}

export interface TerminalApi {
  listTerminalSessions(): Promise<TerminalSessionInfo[]>;
  createTerminalSession(opts?: { serviceName?: string }): Promise<TerminalSessionInfo>;
  closeTerminalSession(id: string): Promise<void>;
}
