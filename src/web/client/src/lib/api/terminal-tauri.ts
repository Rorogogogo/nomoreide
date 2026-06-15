/** Rust-core implementation of {@link TerminalApi}, over Tauri `invoke()` (desktop). */
import {
  tauri_listTerminalSessions,
  tauri_createTerminalSession,
  tauri_closeTerminalSession,
} from "./tauri-bridge.js";
import type { TerminalApi, TerminalSessionInfo } from "./terminal-api.js";

export const tauriTerminalApi: TerminalApi = {
  listTerminalSessions: () =>
    tauri_listTerminalSessions() as Promise<TerminalSessionInfo[]>,
  createTerminalSession: (opts) =>
    tauri_createTerminalSession(opts) as Promise<TerminalSessionInfo>,
  closeTerminalSession: (id) => tauri_closeTerminalSession(id),
};
