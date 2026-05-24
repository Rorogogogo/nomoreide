import { requestJson } from "./client.js";

export type TerminalState = "idle" | "running" | "exited" | "error";

/** One terminal tab as tracked by the server's session manager. */
export interface TerminalSessionInfo {
  id: string;
  cwd: string;
  cols: number;
  rows: number;
  shell: string;
  state: TerminalState;
  error?: string;
}

export async function listTerminalSessions(): Promise<TerminalSessionInfo[]> {
  const res = await requestJson<{ ok: true; sessions: TerminalSessionInfo[] }>(
    "/api/terminal/sessions",
  );
  return res.sessions;
}

export async function createTerminalSession(): Promise<TerminalSessionInfo> {
  const res = await requestJson<{ ok: true; session: TerminalSessionInfo }>(
    "/api/terminal/sessions",
    { method: "POST" },
  );
  return res.session;
}

export async function closeTerminalSession(id: string): Promise<void> {
  await requestJson(`/api/terminal/sessions/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}
