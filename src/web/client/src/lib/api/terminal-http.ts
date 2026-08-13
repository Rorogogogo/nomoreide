/** Node HTTP-server implementation of {@link TerminalApi} (the web/MCP backend). */
import { requestJson } from "./client.js";
import type {
  AgentTranscriptInfo,
  AgentTranscriptScope,
  TerminalApi,
  TerminalSessionInfo,
} from "./terminal-api.js";

export const httpTerminalApi: TerminalApi = {
  async listTerminalSessions() {
    const res = await requestJson<{ ok: true; sessions: TerminalSessionInfo[] }>(
      "/api/terminal/sessions",
    );
    return res.sessions;
  },

  async listAgentTranscripts(scope: AgentTranscriptScope = "current") {
    const res = await requestJson<{
      ok: true;
      transcripts: AgentTranscriptInfo[];
    }>(
      scope === "all"
        ? "/api/terminal/transcripts?scope=all"
        : "/api/terminal/transcripts",
    );
    return res.transcripts;
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

  async renameTerminalSession(id, label) {
    const res = await requestJson<{ ok: true; session: TerminalSessionInfo }>(
      `/api/terminal/sessions/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label }),
      },
    );
    return res.session;
  },

  async getTerminalCapabilities() {
    return await requestJson<{ externalTerminal: boolean }>(
      "/api/terminal/capabilities",
    );
  },

  async openTerminalInSystemTerminal(id) {
    const res = await requestJson<{ ok: true; session: TerminalSessionInfo }>(
      `/api/terminal/sessions/${encodeURIComponent(id)}/open-system-terminal`,
      {
        method: "POST",
        headers: { "x-nomoreide-terminal-control": "1" },
      },
    );
    return res.session;
  },

  async reclaimTerminalToDock(id) {
    const res = await requestJson<{ ok: true; session: TerminalSessionInfo }>(
      `/api/terminal/sessions/${encodeURIComponent(id)}/reclaim-dock`,
      {
        method: "POST",
        headers: { "x-nomoreide-terminal-control": "1" },
      },
    );
    return res.session;
  },

  async insertAgentPrompt(id, prompt) {
    await requestJson(
      `/api/terminal/sessions/${encodeURIComponent(id)}/insert-prompt`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-nomoreide-terminal-control": "1",
        },
        body: JSON.stringify({ prompt }),
      },
    );
  },

  async onTerminalSessionChanged(handler) {
    const events = new EventSource("/api/terminal/events");
    const onSession = (event: MessageEvent<string>) => {
      try {
        handler(JSON.parse(event.data) as TerminalSessionInfo);
      } catch {}
    };
    events.addEventListener("session", onSession as EventListener);
    return () => events.close();
  },

  async closeTerminalSession(id) {
    await requestJson(`/api/terminal/sessions/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  },
};
