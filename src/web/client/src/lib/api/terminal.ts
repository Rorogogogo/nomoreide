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
  /** Tab label when the session is scoped to a service. */
  label?: string;
  error?: string;
}

export async function listTerminalSessions(): Promise<TerminalSessionInfo[]> {
  const res = await requestJson<{ ok: true; sessions: TerminalSessionInfo[] }>(
    "/api/terminal/sessions",
  );
  return res.sessions;
}

export async function createTerminalSession(
  opts?: { serviceName?: string },
): Promise<TerminalSessionInfo> {
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
  await requestJson(`/api/terminal/sessions/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}
