import {
  getCoAuthorWithClaude,
  setCoAuthorWithClaude,
} from "../../core/claude-settings.js";
import { getMcpAuthStatuses, type AgentName } from "../../core/mcp-auth.js";
import { buildAgentInfo } from "../agent-info.js";
import { buildUsageInfo } from "../usage-info.js";
import { readJson, sendJson } from "../http-utils.js";
import { route, type Route } from "./context.js";

/** Only two agents carry MCP config; anything else falls back to Claude Code. */
function parseAgent(value: string | null | undefined): AgentName {
  return value === "codex" ? "codex" : "claude-code";
}

/** Agent introspection: identity, token usage, and the live tool-call feed. */
export const agentRoutes: Route[] = [
  route("GET", "/api/agent", async ({ response, cwd }) => {
    sendJson(response, { ok: true, agent: await buildAgentInfo(cwd) });
  }),

  route("GET", "/api/agent/claude-settings", async ({ response }) => {
    sendJson(response, {
      ok: true,
      settings: { coAuthorWithClaude: await getCoAuthorWithClaude() },
    });
  }),

  route("POST", "/api/agent/claude-settings", async ({ request, response }) => {
    const body = await readJson(request);
    if (typeof body.coAuthorWithClaude !== "boolean") {
      sendJson(response, { ok: false, error: "coAuthorWithClaude must be boolean" }, 400);
      return;
    }
    const coAuthorWithClaude = await setCoAuthorWithClaude(body.coAuthorWithClaude);
    sendJson(response, { ok: true, settings: { coAuthorWithClaude } });
  }),

  route("GET", "/api/agent/usage", async ({ response, cwd }) => {
    sendJson(response, { ok: true, usage: await buildUsageInfo(cwd) });
  }),

  route("GET", "/api/agent/usage/history", async ({ response, url, usageHistory }) => {
    const since = url.searchParams.get("since") ?? undefined;
    const [entries, summary] = await Promise.all([
      usageHistory.list({ since }),
      usageHistory.summary({ since }),
    ]);
    sendJson(response, { ok: true, entries, summary });
  }),

  route("GET", "/api/agent/mcp-status", async ({ response, url }) => {
    const agent = parseAgent(url.searchParams.get("agent"));
    sendJson(response, { ok: true, statuses: await getMcpAuthStatuses(agent) });
  }),

  route("GET", "/api/agent/tool-calls", ({ response, url, toolCallStore }) => {
    const limitParam = Number(url.searchParams.get("limit"));
    const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 500) : 100;
    sendJson(response, { ok: true, records: toolCallStore.recent(limit) });
  }),

  route("GET", "/api/agent/tool-calls/stream", ({ request, response, toolCallStore }) => {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });
    response.write(`retry: 2000\n\n`);
    for (const record of toolCallStore.recent(50)) {
      response.write(`event: tool-call\ndata: ${JSON.stringify(record)}\n\n`);
    }
    const heartbeat = setInterval(() => {
      response.write(`: ping\n\n`);
    }, 15000);
    const unsubscribe = toolCallStore.subscribe((record) => {
      response.write(`event: tool-call\ndata: ${JSON.stringify(record)}\n\n`);
    });
    request.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  }),
];
