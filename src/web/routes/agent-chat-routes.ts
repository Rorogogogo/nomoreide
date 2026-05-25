import type { IncomingMessage } from "node:http";
import {
  AgentRuntime,
  approvalsEnabled,
  isAgentAvailable,
  type AgentStreamEvent,
} from "../../core/agent-runtime.js";
import { sendJson } from "../http-utils.js";
import { errorMessage, route, type Route } from "./context.js";

/** In-dashboard AI chat: streams a real Claude Code session over SSE. */
export const agentChatRoutes: Route[] = [
  route("GET", "/api/agent/chat/status", async ({ response }) => {
    sendJson(response, {
      ok: true,
      configured: await isAgentAvailable(),
      approvals: approvalsEnabled(),
    });
  }),

  route("POST", "/api/agent/chat", async (ctx) => {
    const { request, response, cwd, agentApprovals } = ctx;

    if (!(await isAgentAvailable())) {
      sendJson(
        response,
        { ok: false, error: "Claude Code (`claude`) is not installed or not on PATH." },
        503,
      );
      return;
    }

    let payload: { message: string; resumeSessionId?: string };
    try {
      payload = parsePayload(await readJsonBody(request));
    } catch (error) {
      sendJson(response, { ok: false, error: errorMessage(error) }, 400);
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

    const runtime = new AgentRuntime({ cwd });
    try {
      await runtime.run(payload.message, payload.resumeSessionId, send, {
        signal: controller.signal,
        approval: { broker: agentApprovals, url: approvalUrl },
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

function parsePayload(body: unknown): { message: string; resumeSessionId?: string } {
  const message = (body as { message?: unknown })?.message;
  const resumeSessionId = (body as { resumeSessionId?: unknown })?.resumeSessionId;
  if (typeof message !== "string" || !message.trim()) {
    throw new Error("Request must include a non-empty `message` string.");
  }
  return {
    message,
    resumeSessionId: typeof resumeSessionId === "string" ? resumeSessionId : undefined,
  };
}
