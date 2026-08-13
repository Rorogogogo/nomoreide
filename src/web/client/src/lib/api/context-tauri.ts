import { tauriInvoke } from "./tauri-bridge.js";
import type { ContextApi } from "./context-api.js";

export const contextTauriApi: ContextApi = {
  list: (query = {}) => tauriInvoke("list_context", { query }),
  graph: (query = {}) => tauriInvoke("get_context_graph", { query }),
  getNote: (id) => tauriInvoke("get_context_note", { id }),
  createNote: (input) => tauriInvoke("create_context_note", { input }),
  updateNote: (id, input) => tauriInvoke("update_context_note", { id, input }),
  deleteNote: (id, revision) => tauriInvoke("delete_context_note", { id, revision }),
  setPinned: (refs) => tauriInvoke("set_context_pins", { refs }),
  preview: (attachment, projectPath) => tauriInvoke("preview_context", { attachment, projectPath }),
};
