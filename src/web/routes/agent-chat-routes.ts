import type { IncomingMessage } from "node:http";
import {
  AgentRuntime,
  approvalsEnabled,
  CHAT_PROVIDERS,
  isAgentAvailable,
  providerById,
  publicProviderInfo,
  resolveChatProvider,
  type AgentStreamEvent,
} from "../../core/agent-runtime.js";
import { detectAgent } from "../agent-info.js";
import { sendJson } from "../http-utils.js";
import { errorMessage, route, type Route } from "./context.js";

/** In-dashboard AI chat: streams the active agent CLI session over SSE. */
export const agentChatRoutes: Route[] = [
  route("GET", "/api/agent/chat/status", async ({ response, configStore }) => {
    const [detected, config] = await Promise.all([detectAgent(), configStore.load()]);
    const provider = resolveChatProvider(detected.name, config.chatProvider);
    // Probe every provider so the dock can show which CLIs are installed and let
    // the user switch to an available one (e.g. when the active one is limited).
    const providers = await Promise.all(
      CHAT_PROVIDERS.map(async (candidate) => ({
        ...publicProviderInfo(candidate),
        configured: await isAgentAvailable(candidate),
      })),
    );
    sendJson(response, {
      ok: true,
      configured: await isAgentAvailable(provider),
      approvals: approvalsEnabled(provider),
      provider: publicProviderInfo(provider),
      providers,
    });
  }),

  // Persist the user's provider choice so it sticks across CLI/web/desktop.
  route("POST", "/api/agent/chat/provider", async ({ request, response, configStore }) => {
    let body: { provider?: unknown };
    try {
      body = (await readJsonBody(request)) as typeof body;
    } catch (error) {
      sendJson(response, { ok: false, error: errorMessage(error) }, 400);
      return;
    }
    const provider = providerById(typeof body.provider === "string" ? body.provider : undefined);
    if (!provider) {
      sendJson(response, { ok: false, error: "Unknown chat provider." }, 400);
      return;
    }
    await configStore.setChatProvider(provider.id);
    sendJson(response, { ok: true, provider: publicProviderInfo(provider) });
  }),

  route("POST", "/api/agent/chat", async (ctx) => {
    const { request, response, cwd, agentApprovals, configStore } = ctx;

    let payload: {
      message: string;
      resumeSessionId?: string;
      autoApprove?: boolean;
      provider?: string;
    };
    try {
      payload = parsePayload(await readJsonBody(request));
    } catch (error) {
      sendJson(response, { ok: false, error: errorMessage(error) }, 400);
      return;
    }

    // The turn's provider wins; else the saved choice; else startup detection.
    const config = await configStore.load();
    const provider = resolveChatProvider(
      (await detectAgent()).name,
      payload.provider ?? config.chatProvider,
    );

    if (!(await isAgentAvailable(provider))) {
      sendJson(
        response,
        {
          ok: false,
          error: `${provider.label} (\`${provider.commandName}\`) is not installed or not on PATH.`,
        },
        503,
      );
      return;
    }

    // Server-Sent Events: one JSON-encoded AgentStreamEvent per `data:` line.
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });
    response.write("retry: 2000\n\n");

    const controller = new AbortController();
    request.on("close", () => controller.abort());

    const send = (event: AgentStreamEvent) => {
      if (!response.writableEnded) response.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    // The hook (a child of the spawned `claude`) POSTs back to this same server.
    const host = request.headers.host ?? "127.0.0.1:4317";
    const approvalUrl = `http://${host}/api/agent/chat/approval`;

    const runtime = new AgentRuntime({ cwd, provider });
    try {
      await runtime.run(payload.message, payload.resumeSessionId, send, {
        signal: controller.signal,
        approval: { broker: agentApprovals, url: approvalUrl },
        autoApprove: payload.autoApprove,
      });
    } catch (error) {
      send({ type: "error", message: errorMessage(error) });
    } finally {
      if (!response.writableEnded) response.end();
    }
  }),

  // Called by the PreToolUse hook; held open until the user decides.
  route("POST", "/api/agent/chat/approval", async ({ request, response, agentApprovals }) => {
    let body: { sessionId?: string; requestId?: string; toolName?: string; toolInput?: unknown };
    try {
      body = (await readJsonBody(request)) as typeof body;
    } catch {
      sendJson(response, { decision: "deny", reason: "Malformed approval request." });
      return;
    }
    if (typeof body.requestId !== "string") {
      sendJson(response, { decision: "deny", reason: "Missing request id." });
      return;
    }
    const decision = await agentApprovals.requestApproval(
      body.sessionId,
      body.requestId,
      typeof body.toolName === "string" ? body.toolName : "tool",
      body.toolInput,
    );
    sendJson(response, decision);
  }),

  // Called by the dock when the user clicks Allow / Deny.
  route("POST", "/api/agent/chat/approve", async ({ request, response, agentApprovals }) => {
    let body: { sessionId?: string; requestId?: string; decision?: string; reason?: string };
    try {
      body = (await readJsonBody(request)) as typeof body;
    } catch (error) {
      sendJson(response, { ok: false, error: errorMessage(error) }, 400);
      return;
    }
    if (typeof body.sessionId !== "string" || typeof body.requestId !== "string") {
      sendJson(response, { ok: false, error: "sessionId and requestId are required." }, 400);
      return;
    }
    const decision = body.decision === "allow" ? "allow" : "deny";
    const ok = agentApprovals.resolve(body.sessionId, body.requestId, {
      decision,
      reason: typeof body.reason === "string" ? body.reason : undefined,
    });
    sendJson(response, { ok });
  }),
];

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

function parsePayload(body: unknown): {
  message: string;
  resumeSessionId?: string;
  autoApprove?: boolean;
  provider?: string;
} {
  const message = (body as { message?: unknown })?.message;
  const resumeSessionId = (body as { resumeSessionId?: unknown })?.resumeSessionId;
  const autoApprove = (body as { autoApprove?: unknown })?.autoApprove;
  const provider = (body as { provider?: unknown })?.provider;
  if (typeof message !== "string" || !message.trim()) {
    throw new Error("Request must include a non-empty `message` string.");
  }
  return {
    message,
    resumeSessionId: typeof resumeSessionId === "string" ? resumeSessionId : undefined,
    autoApprove: autoApprove === true,
    provider: typeof provider === "string" ? provider : undefined,
  };
}
