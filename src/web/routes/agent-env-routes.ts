import { z } from "zod";
import {
  applyChanges,
  pendingChangesSchema,
  previewChanges,
  snapshotAgent,
} from "../../core/agent-env-actions.js";
import {
  getAgentAvailability,
  readAllAgentConfigs,
  runAgentDoctor,
} from "../../core/agent-env/index.js";
import { readJson, sendJson } from "../http-utils.js";
import { errorMessage, route, type Route } from "./context.js";

const changesBodySchema = z.object({ changes: pendingChangesSchema });
const snapshotBodySchema = z.object({ agent: z.enum(["claude", "codex", "antigravity"]) });

/**
 * Agent Environments: read-only views (ROR-60) plus staged writes (ROR-61).
 * The three GET endpoints are read-on-mount — each has a matching handler in
 * `apps/website/src/mock-api.ts`, as does `changes/preview` (its response is
 * rendered in the staged-changes drawer). All mutations flow through the
 * write-guarded core/agent-env-actions module and report backup paths.
 */
export const agentEnvRoutes: Route[] = [
  route("GET", "/api/agent-env/agents", async ({ response }) => {
    try {
      sendJson(response, { ok: true, agents: await getAgentAvailability() });
    } catch (error) {
      sendJson(response, { ok: false, error: errorMessage(error) }, 500);
    }
  }),

  route("GET", "/api/agent-env/live", async ({ response, cwd }) => {
    try {
      sendJson(response, { ok: true, configs: await readAllAgentConfigs({ cwd }) });
    } catch (error) {
      sendJson(response, { ok: false, error: errorMessage(error) }, 500);
    }
  }),

  route("GET", "/api/agent-env/doctor", async ({ response, cwd }) => {
    try {
      const result = await runAgentDoctor({ cwd });
      sendJson(response, { ok: true, ...result });
    } catch (error) {
      sendJson(response, { ok: false, error: errorMessage(error) }, 500);
    }
  }),

  route("POST", "/api/agent-env/changes/preview", async ({ request, response, cwd }) => {
    const body = changesBodySchema.safeParse(await readJson(request));
    if (!body.success) {
      sendJson(response, { ok: false, error: "changes must be a non-empty array of staged changes." }, 400);
      return;
    }
    try {
      const preview = await previewChanges({ cwd, changes: body.data.changes });
      sendJson(response, { ok: true, ...preview });
    } catch (error) {
      sendJson(response, { ok: false, error: errorMessage(error) }, 500);
    }
  }),

  route("POST", "/api/agent-env/changes/apply", async ({ request, response, cwd }) => {
    const body = changesBodySchema.safeParse(await readJson(request));
    if (!body.success) {
      sendJson(response, { ok: false, error: "changes must be a non-empty array of staged changes." }, 400);
      return;
    }
    try {
      // Always 200: partial/validation failures are structured data the
      // drawer renders per change, not a transport error.
      const result = await applyChanges({ cwd, changes: body.data.changes });
      sendJson(response, result);
    } catch (error) {
      sendJson(response, { ok: false, error: errorMessage(error) }, 500);
    }
  }),

  route("POST", "/api/agent-env/snapshot", async ({ request, response, cwd }) => {
    const body = snapshotBodySchema.safeParse(await readJson(request));
    if (!body.success) {
      sendJson(response, { ok: false, error: "agent must be claude, codex, or antigravity." }, 400);
      return;
    }
    try {
      const result = await snapshotAgent({ cwd, agent: body.data.agent });
      sendJson(response, { ok: true, ...result });
    } catch (error) {
      sendJson(response, { ok: false, error: errorMessage(error) }, 500);
    }
  }),
];
