/**
 * Terminal API entry point. Picks the backend implementation once at module load
 * (`isTauri()` → Rust core, else Node HTTP) for session lifecycle, and re-exports
 * the bridge helpers the terminal component uses for live I/O — never a
 * per-function `if (isTauri())` branch.
 */
import { isTauri } from "./tauri-bridge.js";
import type { CreateAgentTerminalOptions, TerminalApi } from "./terminal-api.js";
import { httpTerminalApi } from "./terminal-http.js";
import { tauriTerminalApi } from "./terminal-tauri.js";

export {
  tauri_writeTerminalInput,
  tauri_resizeTerminal,
  tauri_onTerminalOutput,
  tauri_startTerminalStream,
} from "./tauri-bridge.js";

function terminalApi(): TerminalApi {
  return isTauri() ? tauriTerminalApi : httpTerminalApi;
}

export function listTerminalSessions() {
  return terminalApi().listTerminalSessions();
}

export function listAgentTranscripts() {
  return terminalApi().listAgentTranscripts();
}

export function createTerminalSession(opts?: { serviceName?: string }) {
  return terminalApi().createTerminalSession(opts);
}

export function createAgentTerminalSession(opts: CreateAgentTerminalOptions) {
  return terminalApi().createAgentTerminalSession(opts);
}

export function renameTerminalSession(id: string, label: string) {
  return terminalApi().renameTerminalSession(id, label);
}

export function closeTerminalSession(id: string) {
  return terminalApi().closeTerminalSession(id);
}

export type {
  AgentTranscriptInfo,
  CreateAgentTerminalOptions,
  TerminalApi,
  TerminalState,
  TerminalSessionInfo,
} from "./terminal-api.js";
