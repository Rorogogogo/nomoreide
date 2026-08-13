import { z } from "zod";
import {
  buildInteractiveAgentInvocation,
  type InteractiveAgentInvocation,
} from "../../core/agent-terminal.js";
import { listAgentTranscripts } from "../../core/agent-transcripts.js";
import {
  composeOneTimeSkillPrompt,
  OneTimeSkillError,
  resolveOneTimeSkill,
} from "../../core/one-time-skills.js";
import { resolveServiceTerminal } from "../../core/terminal-spawn.js";
import {
  encodeAgentPromptPaste,
  MAX_AGENT_PROMPT_BYTES,
} from "../../core/terminal-manager.js";
import {
  readJson,
  RequestBodyTooLargeError,
  sendJson,
} from "../http-utils.js";
import { selectedGitCwd } from "../dashboard.js";
import { patternRoute, route, type Route } from "./context.js";

const agentSessionSchema = z.object({
  provider: z.enum(["codex", "claude"]),
  prompt: z.string().default(""),
  label: z.string().optional(),
  oneTimeSkill: z.object({
    name: z.string().trim().min(1).max(200),
    source: z.string().trim().min(3).max(400),
  }).strict().optional(),
  resumeId: z.string().regex(/^[0-9a-fA-F-]{8,64}$/).optional(),
  // Shape only; `buildInteractiveAgentInvocation` owns the argv-safety check.
  model: z.string().trim().min(1).max(64).optional(),
  context: z.object({
    refs: z.array(z.object({
      kind: z.enum(["note", "project", "service", "file", "incident", "session"]),
      id: z.string().trim().min(1).max(1_000),
    }).strict()).max(200),
    includePinned: z.boolean(),
  }).strict().optional(),
});
const renameSessionSchema = z.object({
  label: z.string().trim().min(1).max(60),
}).strict();
const insertPromptSchema = z.object({ prompt: z.string().min(1) }).strict();
const MAX_INSERT_PROMPT_BODY_BYTES = MAX_AGENT_PROMPT_BYTES * 6 + 1_024;
const TERMINAL_CONTROL_HEADER = "x-nomoreide-terminal-control";
const terminalSessionIdSchema = z.string().min(1).max(200)
  .refine((id) => !hasControlCharacters(id) && !id.includes("/") && !id.includes("\\"));
const existingTerminalSessionIdSchema = z.string().min(1).max(1_000)
  .refine((id) => !hasControlCharacters(id));

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

function terminalControlAllowed(request: import("node:http").IncomingMessage): boolean {
  return request.headers[TERMINAL_CONTROL_HEADER] === "1";
}

function decodeTerminalId(
  encoded: string,
  schema = terminalSessionIdSchema,
): string | undefined {
  try {
    const id = decodeURIComponent(encoded);
    return schema.safeParse(id).success ? id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Terminal tab session management. The PTY data stream stays on the
 * `/api/terminal/socket` WebSocket (handled in `server.ts`); these endpoints
 * only let the client list tabs on reload, open a new tab, and close one.
 */
export const terminalRoutes: Route[] = [
  route("GET", "/api/terminal/capabilities", ({ response, terminalManager }) => {
    sendJson(response, {
      externalTerminal: terminalManager.externalTerminalAvailable?.() ?? false,
    });
  }),

  route("GET", "/api/terminal/events", ({ response, terminalManager }) => {
    response.writeHead(200, {
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no",
    });
    response.write(": connected\n\n");
    const writeSession = (session: ReturnType<typeof terminalManager.list>[number]) => {
      if (!response.writableEnded) {
        response.write(`event: session\ndata: ${JSON.stringify(session)}\n\n`);
      }
    };
    const subscription = terminalManager.onSessionChanged?.(writeSession);
    for (const session of terminalManager.list()) writeSession(session);
    const heartbeat = setInterval(() => {
      if (!response.writableEnded) response.write(": keepalive\n\n");
    }, 15_000);
    heartbeat.unref?.();
    response.once("close", () => {
      clearInterval(heartbeat);
      subscription?.dispose();
    });
  }),

  route(
    "GET",
    "/api/terminal/transcripts",
    async ({ response, configStore, cwd, url }) => {
      const config = await configStore.load();
      const selected = config.gitRepositories.find(
        (repository) => repository.name === config.selectedGitRepository,
      ) ?? config.gitRepositories[0];
      const transcripts = await listAgentTranscripts({
        ...(url.searchParams.get("scope") === "all"
          ? {}
          : { repoPath: selected?.activeWorktreePath ?? selected?.path ?? cwd }),
      });
      sendJson(response, { ok: true, transcripts });
    },
  ),

  route("GET", "/api/terminal/sessions", ({ response, terminalManager }) => {
    sendJson(response, { ok: true, sessions: terminalManager.list() });
  }),

  patternRoute(
    /^\/api\/terminal\/sessions\/([^/]+)\/(open-system-terminal|reclaim-dock|insert-prompt)$/,
    ["id", "action"],
    async ({ request, response, params, terminalManager }) => {
      if (request.method !== "POST") {
        sendJson(response, { ok: false, error: "Method not allowed" }, 405);
        return;
      }
      if (!terminalControlAllowed(request)) {
        sendJson(response, { ok: false, error: "Terminal control header is required." }, 403);
        return;
      }
      const id = decodeTerminalId(params.id);
      if (!id) {
        sendJson(response, { ok: false, error: "Invalid terminal session id." }, 400);
        return;
      }
      if (params.action === "open-system-terminal") {
        if (!terminalManager.openInSystemTerminal) {
          sendJson(response, { ok: false, error: "External Terminal is unavailable." }, 501);
          return;
        }
        try {
          const session = await terminalManager.openInSystemTerminal(id);
          sendJson(response, { ok: true, session });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const status = message.startsWith("Unknown terminal session:") ? 404 : 409;
          sendJson(response, { ok: false, error: message }, status);
        }
        return;
      }
      if (params.action === "insert-prompt") {
        let body: Record<string, unknown>;
        try {
          body = await readJson(request, MAX_INSERT_PROMPT_BODY_BYTES);
        } catch (error) {
          if (error instanceof RequestBodyTooLargeError) {
            sendJson(response, { ok: false, error: "Agent prompt is too large." }, 413);
            return;
          }
          throw error;
        }
        const parsed = insertPromptSchema.safeParse(body);
        if (!parsed.success) {
          sendJson(response, { ok: false, error: "A non-empty agent prompt is required." }, 400);
          return;
        }
        if (Buffer.byteLength(parsed.data.prompt, "utf8") > MAX_AGENT_PROMPT_BYTES) {
          sendJson(response, { ok: false, error: "Agent prompt is too large." }, 413);
          return;
        }
        try {
          encodeAgentPromptPaste(parsed.data.prompt);
        } catch (error) {
          sendJson(response, {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          }, 400);
          return;
        }
        if (!terminalManager.insertAgentPrompt) {
          sendJson(response, { ok: false, error: "Agent prompt insertion is unavailable." }, 501);
          return;
        }
        try {
          const session = terminalManager.insertAgentPrompt(id, parsed.data.prompt);
          sendJson(response, { ok: true, session });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const status = message.startsWith("Unknown terminal session:") ? 404 : 409;
          sendJson(response, { ok: false, error: message }, status);
        }
        return;
      }
      const session = terminalManager.reclaimToDock?.(id);
      if (!session) {
        sendJson(response, { ok: false, error: `Unknown terminal session: ${id}` }, 404);
        return;
      }
      sendJson(response, { ok: true, session });
    },
  ),

  route(
    "POST",
    "/api/terminal/sessions",
    async ({ request, response, terminalManager, configStore, contextLibrary, cwd }) => {
      const body = await readJson(request);
      const workspaceCwd = await selectedGitCwd(configStore, cwd);

      if (Object.hasOwn(body, "agent")) {
        const parsed = agentSessionSchema.safeParse(body.agent);
        if (!parsed.success) {
          const invalidField = parsed.error.issues[0]?.path[0];
          const error =
            invalidField === "provider"
              ? "Agent provider must be codex or claude."
              : invalidField === "resumeId"
                ? "Agent resume id is invalid."
              : "Invalid agent session request.";
          sendJson(response, { ok: false, error }, 400);
          return;
        }

        const { provider, resumeId } = parsed.data;
        if (resumeId && parsed.data.oneTimeSkill) {
          sendJson(response, { ok: false, error: "A temporary skill cannot be attached to a resumed session." }, 400);
          return;
        }
        let prompt = parsed.data.prompt;
        if (parsed.data.context) {
          const assembled = await contextLibrary.assemblePrompt(
            prompt,
            parsed.data.context,
            workspaceCwd,
          );
          prompt = assembled.prompt;
        }
        if (parsed.data.oneTimeSkill) {
          try {
            const skillPrompt = await resolveOneTimeSkill(parsed.data.oneTimeSkill);
            prompt = composeOneTimeSkillPrompt(skillPrompt, prompt);
          } catch (error) {
            const message =
              error instanceof OneTimeSkillError
                ? error.message
                : "The temporary skill could not be loaded.";
            sendJson(response, { ok: false, error: message }, 422);
            return;
          }
        }
        // An explicit per-session model wins; otherwise the provider's saved
        // pin applies, and with neither the CLI picks for itself.
        const model =
          parsed.data.model ??
          (await configStore.load()).chatModels?.[provider];
        let invocation: InteractiveAgentInvocation;
        try {
          invocation = buildInteractiveAgentInvocation(provider, prompt, {
            resumeId,
            model,
          });
        } catch (error) {
          sendJson(
            response,
            { ok: false, error: error instanceof Error ? error.message : "Invalid agent invocation." },
            400,
          );
          return;
        }
        const trimmedLabel = parsed.data.label?.trim();
        const label = (trimmedLabel || `${provider === "codex" ? "Codex" : "Claude"} task`)
          .slice(0, 60);
        const session = terminalManager.create(
          {},
          {
            ...invocation,
            cwd: workspaceCwd,
            kind: "agent",
            provider,
            label,
          },
        );
        sendJson(response, { ok: true, session }, 201);
        return;
      }

      const serviceName =
        typeof body.serviceName === "string" ? body.serviceName.trim() : "";

      // No service named → a plain workspace shell (the `+` tab behavior).
      if (!serviceName) {
        const session = terminalManager.create({}, { cwd: workspaceCwd, kind: "shell" });
        sendJson(response, { ok: true, session }, 201);
        return;
      }

      // The client only names a registered service; the server derives the
      // command (shell / ssh / docker exec) so this endpoint can't be coerced
      // into running an arbitrary program.
      const config = await configStore.load();
      const service = config.services.find((item) => item.name === serviceName);
      if (!service) {
        sendJson(response, { ok: false, error: `Unknown service: ${serviceName}` }, 404);
        return;
      }

      const resolved = resolveServiceTerminal(service);
      if (!resolved.ok) {
        sendJson(response, { ok: false, error: resolved.error }, 400);
        return;
      }

      // Stable id per service so reopening the tab reattaches to the same
      // shell instead of spawning a duplicate.
      const session = terminalManager.createWithId(`svc:${service.name}`, {
        ...resolved.options,
        kind: "service",
      });
      sendJson(response, { ok: true, session }, 201);
    },
  ),

  patternRoute(
    /^\/api\/terminal\/sessions\/([^/]+)$/,
    ["id"],
    async ({ request, response, params, terminalManager }) => {
      const id = decodeTerminalId(params.id, existingTerminalSessionIdSchema);
      if (!id) {
        sendJson(response, { ok: false, error: "Invalid terminal session id." }, 400);
        return;
      }
      if (request.method === "PATCH") {
        const parsed = renameSessionSchema.safeParse(await readJson(request));
        if (!parsed.success) {
          sendJson(response, { ok: false, error: "Terminal session label must be 1–60 characters." }, 400);
          return;
        }
        const session = terminalManager.rename(id, parsed.data.label);
        if (!session) {
          sendJson(response, { ok: false, error: `Unknown terminal session: ${id}` }, 404);
          return;
        }
        sendJson(response, { ok: true, session });
        return;
      }
      if (request.method !== "DELETE") {
        sendJson(response, { ok: false, error: "Method not allowed" }, 405);
        return;
      }
      const closed = terminalManager.close(id);
      sendJson(response, { ok: closed, sessions: terminalManager.list() });
    },
  ),
];
