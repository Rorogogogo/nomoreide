import { requestJson } from "./client.js";
import {
  isTauri,
  tauri_listSnapshots,
  tauri_createSnapshot,
  tauri_restoreSnapshot,
  tauri_deleteSnapshot,
  tauri_getSnapshotFiles,
  tauri_getSnapshotDiff,
} from "./tauri-bridge.js";

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

async function requestText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(body.error || "Request failed");
  }
  return response.text();
}

export async function listSnapshots(): Promise<Snapshot[]> {
  if (isTauri()) return tauri_listSnapshots() as Promise<Snapshot[]>;
  const response = await requestJson<{ ok: true; snapshots: Snapshot[] }>(
    "/api/snapshots",
  );
  return response.snapshots;
}

export async function createSnapshot(label: string): Promise<Snapshot> {
  if (isTauri()) return tauri_createSnapshot(label) as Promise<Snapshot>;
  const response = await requestJson<{ ok: true; snapshot: Snapshot }>(
    "/api/snapshots",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label }),
    },
  );
  return response.snapshot;
}

export async function renameSnapshot(sha: string, label: string): Promise<Snapshot> {
  if (isTauri()) {
    // Git stash messages are immutable; rename is not supported in desktop mode.
    throw new Error("Snapshot rename is not supported in desktop mode");
  }
  const response = await requestJson<{ ok: true; snapshot: Snapshot }>(
    `/api/snapshots/${encodeURIComponent(sha)}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label }),
    },
  );
  return response.snapshot;
}

export async function deleteSnapshot(sha: string): Promise<void> {
  if (isTauri()) return tauri_deleteSnapshot(sha);
  await requestJson<{ ok: true }>(`/api/snapshots/${encodeURIComponent(sha)}`, {
    method: "DELETE",
  });
}

export async function getSnapshotFiles(sha: string): Promise<SnapshotChange[]> {
  if (isTauri()) return tauri_getSnapshotFiles(sha) as Promise<SnapshotChange[]>;
  const response = await requestJson<{ ok: true; files: SnapshotChange[] }>(
    `/api/snapshots/${encodeURIComponent(sha)}/files`,
  );
  return response.files;
}

export async function getSnapshotDiff(sha: string, path?: string): Promise<string> {
  if (isTauri()) return tauri_getSnapshotDiff(sha, path);
  const params = path ? `?path=${encodeURIComponent(path)}` : "";
  return requestText(`/api/snapshots/${encodeURIComponent(sha)}/diff${params}`);
}

export async function restoreSnapshot(sha: string): Promise<RestoreResult> {
  if (isTauri()) { await tauri_restoreSnapshot(sha); return { ok: true } as RestoreResult; }
  return requestJson<RestoreResult & { ok: true }>(
    `/api/snapshots/${encodeURIComponent(sha)}/restore`,
    { method: "POST" },
  );
}

export async function listChangeSets(): Promise<AgentChangeSession[]> {
  if (isTauri()) return [];
  const response = await requestJson<{ ok: true; sessions: AgentChangeSession[] }>(
    "/api/agent/change-sets",
  );
  return response.sessions;
}

export async function getChangeSet(
  id: string,
): Promise<{ session: AgentChangeSession; files: SnapshotChange[] }> {
  if (isTauri()) throw new Error("Agent change sets are not available in desktop mode");
  return requestJson<{
    ok: true;
    session: AgentChangeSession;
    files: SnapshotChange[];
  }>(`/api/agent/change-sets/${encodeURIComponent(id)}`);
}

export async function getChangeSetDiff(id: string, path?: string): Promise<string> {
  if (isTauri()) return "";
  const params = path ? `?path=${encodeURIComponent(path)}` : "";
  return requestText(`/api/agent/change-sets/${encodeURIComponent(id)}/diff${params}`);
}

export async function restoreChangeSet(id: string): Promise<RestoreResult> {
  if (isTauri()) throw new Error("Agent change sets are not available in desktop mode");
  return requestJson<RestoreResult & { ok: true }>(
    `/api/agent/change-sets/${encodeURIComponent(id)}/restore`,
    { method: "POST" },
  );
}
