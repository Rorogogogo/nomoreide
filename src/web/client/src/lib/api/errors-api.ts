/**
 * Errors API surface — the single contract both backends implement.
 *
 * Error tracking is a Node.js-server feature with no Rust-core equivalent, so
 * the desktop (Tauri) implementation degrades the incident list to empty rather
 * than forking each function with an `if (isTauri())` branch. See {@link ../git-api}
 * for the rationale behind the shared-interface seam.
 */

export type IncidentLevel = "error" | "warning";

export interface ErrorIncident {
  id: number;
  service: string;
  level: IncidentLevel;
  signature: string;
  title: string;
  file?: string;
  line?: number;
  firstSeen: string;
  lastSeen: string;
  count: number;
  logExcerpt: string[];
}

export interface ErrorIncidentPrompt {
  incident: ErrorIncident;
  file?: string;
  prompt: string;
}

export interface ErrorReproBundle {
  incidentId: number;
  markdown: string;
  savedPath?: string;
}

/** Result of preparing an Error → Fix loop run for an incident. */
export interface FixPreparation {
  /** Recorded agent session id — deep-links to Agent → Changes for review. */
  sessionId: string;
  /** The fix prompt (repro bundle + fix instruction) to run in the dock. */
  prompt: string;
  /** Repository the pre-fix snapshot was taken in. */
  repoPath: string;
  /** Snapshot sha, or undefined when the repo isn't a git working tree. */
  snapshotSha?: string;
}

export interface ErrorsApi {
  getErrorIncidents(limit?: number): Promise<ErrorIncident[]>;
  getErrorPrompt(id: number): Promise<ErrorIncidentPrompt>;
  getErrorBundle(id: number, save?: boolean): Promise<ErrorReproBundle>;
  /** Snapshot + record a session + return the fix prompt for an incident. */
  startFix(id: number): Promise<FixPreparation>;
}
