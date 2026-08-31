/** Node HTTP-server implementation of {@link SnapshotsApi} (the web/MCP backend). */
import { requestJson } from "./client.js";
import type {
  AgentChangeSession,
  RestoreResult,
  Snapshot,
  SnapshotChange,
  SnapshotsApi,
} from "./snapshots-api.js";

async function requestText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(body.error || "Request failed");
  }
  return response.text();
}

export const httpSnapshotsApi: SnapshotsApi = {
  async listSnapshots() {
    const response = await requestJson<{ ok: true; snapshots: Snapshot[] }>("/api/snapshots");
    return response.snapshots;
  },

  async createSnapshot(label) {
    const response = await requestJson<{ ok: true; snapshot: Snapshot }>("/api/snapshots", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label }),
    });
    return response.snapshot;
  },

  async renameSnapshot(sha, label) {
    const response = await requestJson<{ ok: true; snapshot: Snapshot }>(
      `/api/snapshots/${encodeURIComponent(sha)}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label }),
      },
    );
    return response.snapshot;
  },

  async deleteSnapshot(sha) {
    await requestJson<{ ok: true }>(`/api/snapshots/${encodeURIComponent(sha)}`, {
      method: "DELETE",
    });
  },

  async getSnapshotFiles(sha) {
    const response = await requestJson<{ ok: true; files: SnapshotChange[] }>(
      `/api/snapshots/${encodeURIComponent(sha)}/files`,
    );
    return response.files;
  },

  getSnapshotDiff(sha, path) {
    const params = path ? `?path=${encodeURIComponent(path)}` : "";
    return requestText(`/api/snapshots/${encodeURIComponent(sha)}/diff${params}`);
  },

  restoreSnapshot(sha) {
    return requestJson<RestoreResult & { ok: true }>(
      `/api/snapshots/${encodeURIComponent(sha)}/restore`,
      { method: "POST" },
    );
  },

  async listChangeSets() {
    const response = await requestJson<{ ok: true; sessions: AgentChangeSession[] }>(
      "/api/agent/change-sets",
    );
    return response.sessions;
  },

  getChangeSet(id) {
    return requestJson<{
      ok: true;
      session: AgentChangeSession;
      files: SnapshotChange[];
    }>(`/api/agent/change-sets/${encodeURIComponent(id)}`);
  },

  getChangeSetDiff(id, path) {
    const params = path ? `?path=${encodeURIComponent(path)}` : "";
    return requestText(`/api/agent/change-sets/${encodeURIComponent(id)}/diff${params}`);
  },

  restoreChangeSet(id) {
    return requestJson<RestoreResult & { ok: true }>(
      `/api/agent/change-sets/${encodeURIComponent(id)}/restore`,
      { method: "POST" },
    );
  },
};
