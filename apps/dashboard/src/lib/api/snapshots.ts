/** Snapshots API entry point shared by browser and desktop. */
import type { SnapshotsApi } from "./snapshots-api.js";
import { httpSnapshotsApi } from "./snapshots-http.js";

const api: SnapshotsApi = httpSnapshotsApi;

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
