/**
 * Snapshots API entry point. Picks the backend implementation once at module
 * load (`isTauri()` → Rust core, else Node HTTP) and re-exports its methods as
 * the named functions the rest of the app already imports — never a per-function
 * `if (isTauri())` branch.
 */
import { isTauri } from "./tauri-bridge.js";
import type { SnapshotsApi } from "./snapshots-api.js";
import { httpSnapshotsApi } from "./snapshots-http.js";
import { tauriSnapshotsApi } from "./snapshots-tauri.js";

const api: SnapshotsApi = isTauri() ? tauriSnapshotsApi : httpSnapshotsApi;

export const {
  listSnapshots,
  createSnapshot,
  renameSnapshot,
  deleteSnapshot,
  getSnapshotFiles,
  getSnapshotDiff,
  restoreSnapshot,
  listChangeSets,
  getChangeSet,
  getChangeSetDiff,
  restoreChangeSet,
} = api;

export type {
  SnapshotsApi,
  Snapshot,
  SnapshotChange,
  RestoreResult,
  AgentChangeSession,
} from "./snapshots-api.js";
