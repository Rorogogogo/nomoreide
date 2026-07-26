/** Rust-core implementation of {@link TerminalApi}, over Tauri `invoke()` (desktop). */
import {
  tauri_listTerminalSessions,
  tauri_listAgentTranscripts,
  tauri_createTerminalSession,
  tauri_renameTerminalSession,
  tauri_closeTerminalSession,
} from "./tauri-bridge.js";
import type { TerminalApi } from "./terminal-api.js";

export const tauriTerminalApi: TerminalApi = {
  listTerminalSessions: () => tauri_listTerminalSessions(),
  listAgentTranscripts: () => tauri_listAgentTranscripts(),
  createTerminalSession: (opts) => tauri_createTerminalSession(opts),
  createAgentTerminalSession: (opts) => tauri_createTerminalSession({ agent: opts }),
  renameTerminalSession: (id, label) => tauri_renameTerminalSession(id, label),
  closeTerminalSession: (id) => tauri_closeTerminalSession(id),
};
