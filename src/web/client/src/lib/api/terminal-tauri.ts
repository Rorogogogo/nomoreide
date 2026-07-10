/** Rust-core implementation of {@link TerminalApi}, over Tauri `invoke()` (desktop). */
import {
  tauri_listTerminalSessions,
  tauri_createTerminalSession,
  tauri_closeTerminalSession,
} from "./tauri-bridge.js";
import type { TerminalApi } from "./terminal-api.js";

export const tauriTerminalApi: TerminalApi = {
  listTerminalSessions: () => tauri_listTerminalSessions(),
  createTerminalSession: (opts) => tauri_createTerminalSession(opts),
  createAgentTerminalSession: (opts) => tauri_createTerminalSession({ agent: opts }),
  closeTerminalSession: (id) => tauri_closeTerminalSession(id),
};
