/**
 * Terminal API entry point. Picks the backend implementation once at module load
 * (`isTauri()` → Rust core, else Node HTTP) for session lifecycle, and re-exports
 * the bridge helpers the terminal component uses for live I/O — never a
 * per-function `if (isTauri())` branch.
 */
import { isTauri } from "./tauri-bridge.js";
import type { TerminalApi } from "./terminal-api.js";
import { httpTerminalApi } from "./terminal-http.js";
import { tauriTerminalApi } from "./terminal-tauri.js";

export {
  tauri_writeTerminalInput,
  tauri_resizeTerminal,
  tauri_onTerminalOutput,
} from "./tauri-bridge.js";

const api: TerminalApi = isTauri() ? tauriTerminalApi : httpTerminalApi;

export const { listTerminalSessions, createTerminalSession, closeTerminalSession } = api;

export type { TerminalApi, TerminalState, TerminalSessionInfo } from "./terminal-api.js";
