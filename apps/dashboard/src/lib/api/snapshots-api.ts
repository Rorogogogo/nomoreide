/**
 * Snapshots API surface — the single contract both backends implement. Agent
 * change-sets are a Node-server feature with no Rust equivalent and degrade in
 * desktop mode. See {@link ../git-api} for the shared-interface seam rationale.
 */

export interface Snapshot {
  sha: string;
  ref: string;
  label: string;
  createdAt: string;
}

export interface SnapshotChange {
  /** A (added since snapshot), M (modified), D (deleted since snapshot). */
  status: string;
  path: string;
}

export interface RestoreResult {
  preRestore: Snapshot;
  restoredFiles: number;
  deletedPaths: string[];
}

export interface AgentChangeSession {
  id: string;
  repoPath: string;
  snapshotSha?: string;
  snapshotRef?: string;
  startedAt: string;
  lastToolAt: string;
  toolCount: number;
}

export interface SnapshotsApi {
  listSnapshots(): Promise<Snapshot[]>;
  createSnapshot(label: string): Promise<Snapshot>;
  renameSnapshot(sha: string, label: string): Promise<Snapshot>;
  deleteSnapshot(sha: string): Promise<void>;
  getSnapshotFiles(sha: string): Promise<SnapshotChange[]>;
  getSnapshotDiff(sha: string, path?: string): Promise<string>;
  restoreSnapshot(sha: string): Promise<RestoreResult>;
  listChangeSets(): Promise<AgentChangeSession[]>;
  getChangeSet(
    id: string,
  ): Promise<{ session: AgentChangeSession; files: SnapshotChange[] }>;
  getChangeSetDiff(id: string, path?: string): Promise<string>;
  restoreChangeSet(id: string): Promise<RestoreResult>;
}
