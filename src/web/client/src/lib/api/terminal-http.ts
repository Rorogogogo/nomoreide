/** Node HTTP-server implementation of {@link TerminalApi} (the web/MCP backend). */
import { requestJson } from "./client.js";
import type { TerminalApi, TerminalSessionInfo } from "./terminal-api.js";

export const httpTerminalApi: TerminalApi = {
  async listTerminalSessions() {
    const res = await requestJson<{ ok: true; sessions: TerminalSessionInfo[] }>(
      "/api/terminal/sessions",
    );
    return res.sessions;
  },

  async createTerminalSession(opts) {
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
  },

  async createAgentTerminalSession(opts) {
    const res = await requestJson<{ ok: true; session: TerminalSessionInfo }>(
      "/api/terminal/sessions",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent: opts }),
      },
    );
    return res.session;
  },

  async closeTerminalSession(id) {
    await requestJson(`/api/terminal/sessions/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  },
};
