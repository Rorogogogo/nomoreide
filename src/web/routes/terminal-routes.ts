import { z } from "zod";
import { buildInteractiveAgentInvocation } from "../../core/agent-terminal.js";
import { listAgentTranscripts } from "../../core/agent-transcripts.js";
import { resolveServiceTerminal } from "../../core/terminal-spawn.js";
import { readJson, sendJson } from "../http-utils.js";
import { selectedGitCwd } from "../dashboard.js";
import { patternRoute, route, type Route } from "./context.js";

const agentSessionSchema = z.object({
  provider: z.enum(["codex", "claude"]),
  prompt: z.string().default(""),
  label: z.string().optional(),
  resumeId: z.string().regex(/^[0-9a-fA-F-]{8,64}$/).optional(),
});
const renameSessionSchema = z.object({
  label: z.string().trim().min(1).max(60),
}).strict();

/**
 * Terminal tab session management. The PTY data stream stays on the
 * `/api/terminal/socket` WebSocket (handled in `server.ts`); these endpoints
 * only let the client list tabs on reload, open a new tab, and close one.
 */
export const terminalRoutes: Route[] = [
  route(
    "GET",
    "/api/terminal/transcripts",
    async ({ response, configStore, cwd }) => {
      const config = await configStore.load();
      const selected = config.gitRepositories.find(
        (repository) => repository.name === config.selectedGitRepository,
      ) ?? config.gitRepositories[0];
      const transcripts = await listAgentTranscripts({
        repoPath: selected?.activeWorktreePath ?? selected?.path ?? cwd,
      });
      sendJson(response, { ok: true, transcripts });
    },
  ),

  route("GET", "/api/terminal/sessions", ({ response, terminalManager }) => {
    sendJson(response, { ok: true, sessions: terminalManager.list() });
  }),

  route(
    "POST",
    "/api/terminal/sessions",
    async ({ request, response, terminalManager, configStore, cwd }) => {
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

        const { provider, prompt, resumeId } = parsed.data;
        const invocation = buildInteractiveAgentInvocation(provider, prompt, {
          resumeId,
        });
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
      const id = decodeURIComponent(params.id);
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
