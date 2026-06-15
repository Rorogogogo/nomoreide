/**
 * Rust-core implementation of {@link SnapshotsApi}, over Tauri `invoke()` (desktop).
 * Snapshot rename (immutable stash messages) and agent change-sets have no Rust
 * backend and degrade here.
 */
import {
  tauri_listSnapshots,
  tauri_createSnapshot,
  tauri_restoreSnapshot,
  tauri_deleteSnapshot,
  tauri_getSnapshotFiles,
  tauri_getSnapshotDiff,
} from "./tauri-bridge.js";
import type {
  RestoreResult,
  Snapshot,
  SnapshotChange,
  SnapshotsApi,
} from "./snapshots-api.js";

export const tauriSnapshotsApi: SnapshotsApi = {
  listSnapshots: () => tauri_listSnapshots() as Promise<Snapshot[]>,
  createSnapshot: (label) => tauri_createSnapshot(label) as Promise<Snapshot>,
  renameSnapshot: async () => {
    // Git stash messages are immutable; rename is not supported in desktop mode.
    throw new Error("Snapshot rename is not supported in desktop mode");
  },
  deleteSnapshot: (sha) => tauri_deleteSnapshot(sha),
  getSnapshotFiles: (sha) => tauri_getSnapshotFiles(sha) as Promise<SnapshotChange[]>,
  getSnapshotDiff: (sha, path) => tauri_getSnapshotDiff(sha, path),
  async restoreSnapshot(sha) {
    await tauri_restoreSnapshot(sha);
    // The Rust restore command returns no pre-restore snapshot payload.
    return { ok: true } as RestoreResult;
  },
  listChangeSets: async () => [],
  getChangeSet: async () => {
    throw new Error("Agent change sets are not available in desktop mode");
  },
  getChangeSetDiff: async () => "",
  restoreChangeSet: async () => {
    throw new Error("Agent change sets are not available in desktop mode");
  },
};
