import { requestJson } from "./client.js";
import type {
  ContextApi,
  ContextGraph,
  ContextLibrarySnapshot,
  ContextNote,
  ContextPreview,
  ContextQuery,
  ContextRef,
} from "./context-api.js";

function queryString(query: ContextQuery = {}): string {
  const params = new URLSearchParams();
  if (query.q?.trim()) params.set("q", query.q.trim());
  if (query.projectPath) params.set("projectPath", query.projectPath);
  if (query.kinds?.length) params.set("kinds", query.kinds.join(","));
  const value = params.toString();
  return value ? `?${value}` : "";
}

export const contextHttpApi: ContextApi = {
  async list(query) {
    const result = await requestJson<{ ok: true } & ContextLibrarySnapshot>(`/api/context${queryString(query)}`);
    return result;
  },
  async graph(query) {
    const result = await requestJson<{ ok: true; graph: ContextGraph }>(`/api/context/graph${queryString(query)}`);
    return result.graph;
  },
  async getNote(id) {
    const result = await requestJson<{ ok: true; note: ContextNote }>(`/api/context/notes/${encodeURIComponent(id)}`);
    return result.note;
  },
  async createNote(input) {
    const result = await requestJson<{ ok: true; note: ContextNote }>("/api/context/notes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    return result.note;
  },
  async updateNote(id, input) {
    const result = await requestJson<{ ok: true; note: ContextNote }>(`/api/context/notes/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    return result.note;
  },
  async deleteNote(id, revision) {
    await requestJson(`/api/context/notes/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision }),
    });
  },
  async setPinned(refs) {
    const result = await requestJson<{ ok: true; pinned: ContextRef[] }>("/api/context/pins", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refs }),
    });
    return result.pinned;
  },
  async preview(attachment, projectPath) {
    const result = await requestJson<{ ok: true; preview: ContextPreview }>("/api/context/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ attachment, projectPath }),
    });
    return result.preview;
  },
};
