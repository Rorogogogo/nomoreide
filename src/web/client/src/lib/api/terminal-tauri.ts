/** Rust-core implementation of {@link TerminalApi}, over Tauri `invoke()` (desktop). */
import {
  tauri_listTerminalSessions,
  tauri_listAgentTranscripts,
  tauri_createTerminalSession,
  tauri_renameTerminalSession,
  tauri_closeTerminalSession,
  tauri_getTerminalCapabilities,
  tauri_openTerminalInSystemTerminal,
  tauri_reclaimTerminalToDock,
  tauri_insertAgentPrompt,
  tauri_onTerminalSessionChanged,
} from "./tauri-bridge.js";
import type { TerminalApi } from "./terminal-api.js";

export const tauriTerminalApi: TerminalApi = {
  listTerminalSessions: () => tauri_listTerminalSessions(),
  listAgentTranscripts: (scope) => tauri_listAgentTranscripts(scope),
  createTerminalSession: (opts) => tauri_createTerminalSession(opts),
  createAgentTerminalSession: (opts) => tauri_createTerminalSession({ agent: opts }),
  renameTerminalSession: (id, label) => tauri_renameTerminalSession(id, label),
  getTerminalCapabilities: () => tauri_getTerminalCapabilities(),
  openTerminalInSystemTerminal: (id) => tauri_openTerminalInSystemTerminal(id),
  reclaimTerminalToDock: (id) => tauri_reclaimTerminalToDock(id),
  insertAgentPrompt: (id, prompt) => tauri_insertAgentPrompt(id, prompt),
  onTerminalSessionChanged: (handler) => tauri_onTerminalSessionChanged(handler),
  closeTerminalSession: (id) => tauri_closeTerminalSession(id),
};
