/** Terminal API entry point shared by browser and embedded desktop runtimes. */
import type { AgentTranscriptScope, CreateAgentTerminalOptions, TerminalApi } from "./terminal-api.js";
import { httpTerminalApi } from "./terminal-http.js";

export function listTerminalSessions() {
  return httpTerminalApi.listTerminalSessions();
}

export function listAgentTranscripts(scope?: AgentTranscriptScope) {
  return httpTerminalApi.listAgentTranscripts(scope);
}

export function createTerminalSession(opts?: { serviceName?: string }) {
  return httpTerminalApi.createTerminalSession(opts);
}

export function createAgentTerminalSession(opts: CreateAgentTerminalOptions) {
  return httpTerminalApi.createAgentTerminalSession(opts);
}

export function renameTerminalSession(id: string, label: string) {
  return httpTerminalApi.renameTerminalSession(id, label);
}

export function getTerminalCapabilities() {
  return httpTerminalApi.getTerminalCapabilities();
}

export function openTerminalInSystemTerminal(id: string) {
  return httpTerminalApi.openTerminalInSystemTerminal(id);
}

export function reclaimTerminalToDock(id: string) {
  return httpTerminalApi.reclaimTerminalToDock(id);
}

export function insertAgentPrompt(id: string, prompt: string) {
  return httpTerminalApi.insertAgentPrompt(id, prompt);
}

export function onTerminalSessionChanged(
  handler: Parameters<TerminalApi["onTerminalSessionChanged"]>[0],
) {
  return httpTerminalApi.onTerminalSessionChanged(handler);
}

export function closeTerminalSession(id: string) {
  return httpTerminalApi.closeTerminalSession(id);
}

export type {
  AgentTranscriptInfo,
  AgentTranscriptScope,
  CreateAgentTerminalOptions,
  TerminalApi,
  TerminalCapabilities,
  TerminalPresentation,
  TerminalState,
  TerminalSessionInfo,
} from "./terminal-api.js";
