import { requestJson } from "./client.js";
import {
  isTauri,
  tauri_listTerminalSessions,
  tauri_createTerminalSession,
  tauri_closeTerminalSession,
  tauri_writeTerminalInput,
  tauri_resizeTerminal,
  tauri_onTerminalOutput,
} from "./tauri-bridge.js";

export { tauri_writeTerminalInput, tauri_resizeTerminal, tauri_onTerminalOutput };

export type TerminalState = "idle" | "running" | "exited" | "error";

/** One terminal tab as tracked by the server's session manager. */
export interface TerminalSessionInfo {
  id: string;
  cwd: string;
  cols: number;
  rows: number;
  shell: string;
  state: TerminalState;
  /** Tab label when the session is scoped to a service. */
  label?: string;
  error?: string;
}

export async function listTerminalSessions(): Promise<TerminalSessionInfo[]> {
  if (isTauri()) return tauri_listTerminalSessions() as Promise<TerminalSessionInfo[]>;
  const res = await requestJson<{ ok: true; sessions: TerminalSessionInfo[] }>(
    "/api/terminal/sessions",
  );
  return res.sessions;
}

export async function createTerminalSession(
  opts?: { serviceName?: string },
): Promise<TerminalSessionInfo> {
  if (isTauri()) return tauri_createTerminalSession(opts) as Promise<TerminalSessionInfo>;
  const res = await requestJson<{ ok: true; session: TerminalSessionInfo }>(
    "/api/terminal/sessions",
    {
      method: "POST",
      ...(opts?.serviceName
        ? {
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ serviceName: opts.serviceName }),
          }
        : {}),
    },
  );
  return res.session;
}

export async function closeTerminalSession(id: string): Promise<void> {
  if (isTauri()) return tauri_closeTerminalSession(id);
  await requestJson(`/api/terminal/sessions/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}
